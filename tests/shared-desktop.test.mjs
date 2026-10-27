import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {NativeDesktopHost} from '../src/native-desktop-channel.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(read){for(let i=0;i<250;i++){try{const result=await read();if(result)return result;}catch{}await pause(25);}throw new Error('Shared Desktop fixture timed out');}

test('new browser chats share Desktop; explicit standalone chats can be safely handed back without restarting Desktop or Relay',{timeout:30000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-shared-desktop-')),children=[];
  const endpoint=path.join(directory,'native.json'),log=path.join(directory,'rpc.jsonl'),core=[],desktop=[],threads=new Map();let next=0,host;
  t.after(async()=>{for(const child of children.reverse())if(child.exitCode===null){const end=new Promise(resolve=>child.once('exit',resolve));child.stdin?.end();const timer=setTimeout(()=>child.kill(),2000);await end;clearTimeout(timer);}await host?.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  host=new NativeDesktopHost({endpointFile:endpoint,writeDesktop:message=>desktop.push(message),writeCore:message=>{
    core.push(message);let result={};
    if(message.method==='thread/start'){
      const thread={id:'shared-'+(++next),cwd:directory,name:'Shared chat',status:{type:'idle'}};threads.set(thread.id,thread);result={thread};
      host.fromCore({method:'thread/started',params:{thread}});
    }else if(message.method==='thread/read')result={thread:threads.get(message.params.threadId)||{id:message.params.threadId,status:{type:'notLoaded'}}};
    else if(message.method==='thread/resume'){const thread={id:message.params.threadId,status:{type:'idle'}};threads.set(thread.id,thread);result={thread};}
    else if(message.method==='turn/start'){threads.get(message.params.threadId).status={type:'active'};result={turn:{id:'shared-turn-'+next,status:'inProgress'}};}
    host.fromCore({id:message.id,result});
    if(message.method==='turn/start')host.fromCore({method:'turn/started',params:{threadId:message.params.threadId,turn:result.turn}});
  }});await host.listen();host.fromDesktop({method:'initialized'});
  const fake=path.join(directory,'cli.mjs');
  await fs.writeFile(fake,`import readline from 'node:readline';import fs from 'node:fs';const owned=new Set();fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({pid:process.pid,event:'boot'})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({pid:process.pid,method:m.method})+'\\n');let result={};if(m.method==='thread/list')result={data:[]};if(m.method==='model/list')result={data:[]};if(m.method==='thread/start'){owned.add('standalone');result={thread:{id:'standalone',status:{type:'idle'}}};}if(m.method==='thread/loaded/list')result={data:[...owned]};if(m.method==='thread/read')result={thread:{id:m.params.threadId,status:{type:owned.has(m.params.threadId)?'idle':'notLoaded'}}};if(m.method==='thread/goal/get')result={goal:null};if(m.method==='turn/start'){result={turn:{id:'standalone-turn',status:'inProgress'}};setTimeout(()=>process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'standalone-turn',status:'completed'}}})+'\\n'),100);}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base='http://127.0.0.1:'+port;
  const env={...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_TOKEN:'shared-fixture',CODEX_RELAY_DATA_DIR:directory,CODEX_RELAY_PARENT_PIPE:'1',CODEX_BIN:process.execPath,CODEX_ARGS_JSON:JSON.stringify([fake]),CODEX_SESSIONS_DIR:path.join(directory,'sessions'),CODEX_RELAY_NATIVE_ENDPOINT:endpoint,CODEX_RELAY_SERVER:base,CODEX_RELAY_CWD:directory,CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',FIXTURE_LOG:log};
  await fs.mkdir(env.CODEX_SESSIONS_DIR);
  const appRoot=process.env.CODEX_RELAY_SHARED_PACKAGE_ROOT || path.resolve('.');
  const launch=file=>{const child=spawn(process.execPath,[path.join(appRoot,file)],{cwd:appRoot,env,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);child.stdout.resume();child.stderr.resume();return child;};
  const server=launch('server.mjs');await poll(async()=>(await fetch(base+'/api/runtime')).ok);const runner=launch('runner.mjs');
  const get=async url=>(await fetch(base+url)).json();
  const post=async(url,body)=>{const response=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const events=async body=>{const response=await fetch(base+'/api/runner/local/events',{method:'POST',headers:{'content-type':'application/json','x-codex-relay-token':'shared-fixture'},body:JSON.stringify(body)});assert.equal(response.status,202);};
  await poll(async()=>{const device=(await get('/api/devices')).devices[0];return device?.nativeDesktop?.capabilities?.createThreads && device.desktopThreadCreateRevision===1;});
  const created=await post('/api/sessions',{cwd:directory,prompt:'Shared first message',requestId:'shared-desktop-create-0001'});assert.equal(created.status,201);
  const shared=await poll(async()=>{const s=(await get('/api/sessions')).sessions.find(s=>s.id===created.body.session.id);return s?.executionOwner==='desktop' && s.threadId && core.some(m=>m.method==='turn/start' && m.params.threadId===s.threadId) && s;});
  assert.equal(core.filter(m=>m.method==='thread/start').length,1);
  assert.ok(desktop.some(m=>m.method==='thread/started' && m.params.thread.id===shared.threadId));
  let rpc=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!rpc.some(m=>['thread/start','thread/resume','turn/start'].includes(m.method)));
  await poll(async()=>(await get('/api/sessions')).sessions.find(s=>s.id===shared.id)?.activeTurnId==='shared-turn-1');
  const guided=await post('/api/sessions/'+shared.id+'/turns',{text:'Guide original',mode:'steer',expectedTurnId:'shared-turn-1',requestId:'shared-desktop-steer-0001'});assert.equal(guided.status,202,JSON.stringify(guided.body));
  await poll(()=>core.some(m=>m.method==='turn/steer' && m.params.threadId===shared.threadId));
  const independent=await post('/api/sessions',{cwd:directory,prompt:'Explicit independent',executionMode:'runner',requestId:'standalone-create-0001'});assert.equal(independent.status,201);
  const single=await poll(async()=>{const s=(await get('/api/sessions')).sessions.find(s=>s.id===independent.body.session.id);return s?.status==='done' && s;});
  const report=await get('/api/sessions/'+single.id+'/ownership');assert.equal(report.owner,'runner');assert.equal(report.canRelease,true);
  const oldPid=report.pid,serverPid=server.pid,runnerPid=runner.pid;
  const released=await post('/api/sessions/'+single.id+'/ownership',{confirm:true,expected:{pid:report.pid,generation:report.generation}});
  assert.equal(released.status,200);assert.equal(released.body.released,true);
  assert.equal(server.pid,serverPid);assert.equal(server.exitCode,null);assert.equal(runner.pid,runnerPid);assert.equal(runner.exitCode,null);assert.equal(host.initialized,true);
  assert.equal((await get('/api/sessions/'+single.id+'/ownership')).runnerLoaded,false);
  rpc=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  const newPid=rpc.findLast(m=>m.event==='boot').pid;assert.notEqual(newPid,oldPid);
  assert.equal((await get('/api/sessions')).sessions.find(s=>s.id===single.id).executionMode,'desktop');
  const continued=await post('/api/sessions/'+single.id+'/turns',{text:'Continue in Desktop',requestId:'handoff-continue-0001'});assert.equal(continued.status,202);
  await poll(()=>core.some(m=>m.method==='turn/start' && m.params.threadId==='standalone'));
  rpc=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!rpc.some(m=>m.pid===newPid && ['thread/start','thread/resume','turn/start'].includes(m.method)));
  assert.ok(!core.some(m=>m.method==='turn/interrupt' || m.method==='thread/fork'));
  await events({type:'native_status',connected:false,threadIds:[shared.threadId],capabilities:{}});
  assert.equal((await post('/api/sessions',{cwd:directory,prompt:'Must not fallback'})).status,400);
});
