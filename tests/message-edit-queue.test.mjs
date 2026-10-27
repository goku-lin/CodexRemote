import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareMessageEdit} from '../src/message-edit.mjs';
import {DeliveryStore} from '../src/reliability.mjs';
import {NativeDesktopHost,NativeDesktopClient} from '../src/native-desktop-channel.mjs';

const sample=()=>({id:'original',status:{type:'idle'},turns:[
  {id:'first',status:'completed',items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'原请求'},{type:'localImage',path:'C:/image.png'}]},{id:'extra',type:'userMessage',text:'追加要求'}]},
  {id:'second',status:'completed',items:[{id:'u2',type:'userMessage',text:'后续请求'}]}
]});
const command={threadId:'original',messageId:'extra',editTurnId:'first',originalText:'追加要求',text:'改后的追加要求',expectedLastTurnId:'second'};

test('history editing preserves earlier inputs and images in the same turn and truncates the edited suffix',()=>{
  const plan=prepareMessageEdit(sample(),command);
  assert.equal(plan.numTurns,2);assert.equal(plan.prefixLength,2);
  assert.deepEqual(plan.input,[{type:'text',text:'原请求'},{type:'localImage',path:'C:/image.png'},{type:'text',text:'改后的追加要求'}]);
  assert.deepEqual(prepareMessageEdit(sample(),{...command,messageId:'u1',originalText:'原请求',text:'新请求'}).input,[{type:'text',text:'新请求'},{type:'localImage',path:'C:/image.png'}]);
});
test('editing refuses stale history, active turns, ambiguous messages and missing image data before rollback',()=>{
  assert.throws(()=>prepareMessageEdit(sample(),{...command,expectedLastTurnId:'old'}),/新消息/);
  assert.throws(()=>prepareMessageEdit({...sample(),status:{type:'active'}},command),/仍在运行/);
  assert.throws(()=>prepareMessageEdit(sample(),{...command,originalText:'changed'}),/内容已改变/);
  const thread=sample();thread.turns[0].items[0].images=[{ref:'unresolved'}];thread.turns[0].items[0].content=[{type:'text',text:'原请求'}];
  assert.throws(()=>prepareMessageEdit(thread,command),/图片尚未完整/);
});
async function nativeFixture(t,{rejectStart=false}={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-edit-native-')),endpointFile=path.join(directory,'endpoint.json'),thread=sample(),core=[];
  let host;
  host=new NativeDesktopHost({endpointFile,writeDesktop:()=>{},writeCore:message=>{
    core.push(message);
    if(message.method==='thread/read')host.fromCore({id:message.id,result:{thread}});
    else if(message.method==='thread/rollback') {thread.turns.splice(-message.params.numTurns);host.fromCore({id:message.id,result:{thread}});}
    else if(message.method==='turn/start')host.fromCore(rejectStart ? {id:message.id,error:{message:'Selected model is at capacity.'}} : {id:message.id,result:{turn:{id:'edited'}}});
  }});
  await host.listen();host.fromDesktop({method:'initialized'});
  core.length=0;
  const client=new NativeDesktopClient({CODEX_RELAY_NATIVE_ENDPOINT:endpointFile},1000);
  t.after(async()=>{client.close();await host.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  return {client,core,host,thread};
}
test('native history edit rolls back once on the original writer, preserves images and starts ordinary input without touching Goal',async t=>{
  const f=await nativeFixture(t),saved=[];
  await f.client.edit(command,{beforeRollback:async plan=>saved.push(plan),onRollback:async thread=>assert.equal(thread.turns.length,0)});
  assert.deepEqual(f.core.map(message=>message.method),['thread/read','thread/rollback','turn/start']);
  assert.equal(f.core[1].params.threadId,'original');assert.equal(f.core[1].params.numTurns,2);assert.equal(saved.length,1);
  assert.deepEqual(f.core[2].params.input,saved[0].input);
  assert.ok(!f.core.some(message=>/goal|fork/.test(message.method)));
});
test('native editing refuses an old proxy or a Desktop turn that starts during validation',async t=>{
  const f=await nativeFixture(t);await f.client.connect();f.client.capabilities.edit=false;
  await assert.rejects(f.client.edit(command),/尚未加载消息编辑/);assert.equal(f.core.length,0);
  f.client.capabilities.edit=true;
  await assert.rejects(f.client.edit(command,{beforeRollback:async()=>{f.host.fromCore({method:'turn/started',params:{threadId:'original',turn:{id:'raced'}}});}}),/原回合仍在运行/);
  assert.equal(f.core.some(message=>message.method==='thread/rollback'),false);assert.equal(f.thread.turns.length,2);
});
test('a failed model start after rollback preserves a recovery input and recovery does not roll back twice',async t=>{
  const f=await nativeFixture(t,{rejectStart:true});let saved;
  await assert.rejects(f.client.edit(command,{beforeRollback:async plan=>{saved=plan;}}),error=>error.rolledBack && /capacity/.test(error.message));
  await assert.rejects(f.client.edit({...command,expectedLastTurnId:null,recoveryInput:saved.input}),/capacity/);
  assert.equal(f.core.filter(message=>message.method==='thread/rollback').length,1);
  assert.deepEqual(f.core.filter(message=>message.method==='turn/start')[1].params.input,saved.input);
});
test('waiting inputs survive a Relay restart and never become replayable model commands until explicitly dispatched',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-waiting-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new DeliveryStore(directory),id='queue0123456789abcdef',session={id:'s',deviceId:'d',queuedInputs:[{id,text:'排队'}]};
  store.add(store.check(id,'turn:s',{text:'排队',mode:'queue'}),session,{waiting:true},null);store.update(id,'waiting');
  const recovered=new DeliveryStore(directory);assert.equal(recovered.queued().length,0);assert.equal(recovered.data.sessions.s.queuedInputs[0].text,'排队');
  recovered.dispatch(id,{type:'startTurn'});assert.equal(new DeliveryStore(directory).queued().length,1);
  recovered.update(id,'dispatched');assert.equal(new DeliveryStore(directory).get(id).state,'uncertain');assert.equal(new DeliveryStore(directory).queued().length,0);
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(read,predicate) {for(let i=0;i<150;i++){const result=await read();if(predicate(result))return result;await pause(15);}throw new Error('Expected state did not arrive');}
async function serverFixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-message-ui-'));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`,commands=[],abort=new AbortController();
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_TOKEN:'fixture-token',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'0',CODEX_RELAY_DATA_DIR:directory}});
  t.after(async()=>{abort.abort();if(child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-codex-relay-token':'fixture-token'},body:JSON.stringify(body)});
  const get=async url=>(await fetch(base+url)).json();
  const stream=await fetch(base+'/api/runner/local/commands',{headers:{'x-codex-relay-token':'fixture-token'},signal:abort.signal});
  const reader=stream.body.getReader();void (async()=>{let buffered='';try {while(true){const {done,value}=await reader.read();if(done)break;buffered+=new TextDecoder().decode(value);const frames=buffered.split('\n\n');buffered=frames.pop();for(const frame of frames){const data=frame.split('\n').find(line=>line.startsWith('data:'));if(data)commands.push(JSON.parse(data.slice(5)));}}}catch{/* fixture closes stream */}})();
  await post('/api/runner/local/events',{type:'native_status',connected:true,capabilities:{steer:true,interrupt:true,edit:true},activeTurns:{}});
  await post('/api/runner/local/events',{type:'thread_list',threads:[{id:'original',cwd:directory,status:{type:'idle'},createdAt:1,updatedAt:2}]});
  const session=(await get('/api/sessions')).sessions[0],id=session.id;
  const event=message=>post('/api/runner/local/events',{sessionId:id,origin:'desktop',message});
  const history=()=>post('/api/runner/local/events',{sessionId:id,rpcMethod:'thread/read',message:{id:1,result:{thread:{...sample(),cwd:directory,createdAt:1,updatedAt:2}}}});
  await history();commands.length=0;
  return {directory,commands,id,post,get,event,history,session:async()=>(await get('/api/sessions')).sessions.find(session=>session.id===id)};
}

test('queue operations are idempotent, retain images on withdrawal, refuse stale edits and steer only on explicit action',{timeout:15000},async t=>{
  const f=await serverFixture(t),url=`/api/sessions/${f.id}/turns`;
  await f.event({method:'turn/started',params:{threadId:'original',turn:{id:'running'}}});
  const body={text:'手机排队',mode:'queue',requestId:'queue0123456789abcdef'};
  assert.deepEqual((await Promise.all([f.post(url,body),f.post(url,body)])).map(response=>response.status),[202,202]);
  let session=await f.session();assert.equal(session.queuedInputs.length,1);assert.equal(session.status,'running');assert.equal(f.commands.filter(c=>c.type==='startTurn').length,0);
  assert.ok(!(await f.get(`/api/sessions/${f.id}/history`)).events.some(event=>event.text===body.text));
  const withdraw=`/api/sessions/${f.id}/queued/${body.requestId}/withdraw`,operation={revision:1,requestId:'withdraw0123456789abcd'};
  assert.equal((await f.post(withdraw,{...operation,revision:0})).status,409);
  const replies=await Promise.all([f.post(withdraw,operation),f.post(withdraw,operation)]);assert.deepEqual(replies.map(reply=>reply.status),[200,200]);
  assert.equal((await replies[1].json()).item.text,body.text);assert.equal((await f.session()).queuedInputs.length,0);
  assert.equal((await f.get('/api/deliveries/'+operation.requestId)).response.item.text,body.text);
  const next={...body,text:'引导原回合',requestId:'queue2223456789abcdef'};await f.post(url,next);
  const guide=`/api/sessions/${f.id}/queued/${next.requestId}/steer`,guideBody={revision:1,expectedTurnId:'running',requestId:'guide0123456789abcdef'};
  assert.equal((await f.post(guide,{...guideBody,expectedTurnId:'stale'})).status,409);
  assert.deepEqual((await Promise.all([f.post(guide,guideBody),f.post(guide,guideBody)])).map(reply=>reply.status),[202,202]);
  const started=await waitFor(()=>f.commands.filter(c=>c.type==='startTurn'),items=>items.length===1);
  assert.equal(started[0].mode,'steer');assert.equal(started[0].expectedTurnId,'running');assert.equal(started[0].model,undefined);
  await f.event({method:'runner/steerAccepted',params:{threadId:'original',turnId:'running'}});
  assert.equal((await f.session()).queuedInputs.length,0);
  assert.equal((await f.get(`/api/sessions/${f.id}/history`)).events.filter(event=>event.text===next.text).length,1);
});

test('successful completion releases exactly one waiting input; failure and restart keep it waiting',{timeout:15000},async t=>{
  const f=await serverFixture(t),url=`/api/sessions/${f.id}/turns`;
  await f.event({method:'turn/started',params:{threadId:'original',turn:{id:'running'}}});
  await f.post(url,{text:'下一条',mode:'queue',requestId:'auto0123456789abcdef'});
  await f.event({method:'turn/completed',params:{threadId:'original',turn:{id:'running',status:'failed'}}});
  assert.equal(f.commands.filter(c=>c.type==='startTurn').length,0);
  const persisted=JSON.parse(await readFile(path.join(f.directory,'deliveries.json'),'utf8'));assert.equal(persisted.sessions[f.id].queuedInputs[0].text,'下一条');
  await f.event({method:'turn/started',params:{threadId:'original',turn:{id:'again'}}});
  await f.event({method:'turn/completed',params:{threadId:'original',turn:{id:'again',status:'completed'}}});
  const commands=await waitFor(()=>f.commands.filter(c=>c.type==='startTurn'),items=>items.length===1);
  assert.equal(commands[0].queuedStart,true);assert.equal(commands[0].threadId,'original');
  await f.event({method:'turn/completed',params:{threadId:'original',turn:{id:'again',status:'completed'}}});
  assert.equal(f.commands.filter(c=>c.type==='startTurn').length,1);
});

test('inline edit checks native capability and source token; duplicate submissions perform one edit and rollback removes old live replies',{timeout:15000},async t=>{
  const f=await serverFixture(t),session=await f.session(),source=session.editableMessages.find(item=>item.id==='u1');
  const url=`/api/sessions/${f.id}/messages/u1/edit`,body={text:'修改原消息',expectedToken:source.token,expectedLastTurnId:source.lastTurnId,requestId:'edit0123456789abcdef'};
  assert.equal((await f.post(url,{...body,expectedToken:'stale'})).status,409);
  await f.post('/api/runner/local/events',{type:'native_status',connected:true,capabilities:{steer:true},activeTurns:{}});
  assert.equal((await f.post(url,body)).status,409);
  await f.post('/api/runner/local/events',{type:'native_status',connected:true,capabilities:{edit:true},activeTurns:{}});
  assert.deepEqual((await Promise.all([f.post(url,body),f.post(url,body)])).map(reply=>reply.status),[202,202]);
  const commands=await waitFor(()=>f.commands.filter(c=>c.type==='editMessage'),items=>items.length===1);assert.equal(commands[0].originalText,'原请求');assert.equal(commands[0].editTurnId,'first');
  await f.event({method:'runner/editRolledBack',params:{deliveryId:body.requestId,thread:{id:'original',status:{type:'idle'},turns:[]}}});
  const history=await f.get(`/api/sessions/${f.id}/history`);assert.ok(!history.events.some(event=>event.id==='u1' || event.id==='u2'));
  assert.equal((await f.session()).editRecovery.sourceDeliveryId,body.requestId);
  await f.event({method:'turn/started',params:{threadId:'original',turn:{id:'edited'}}});
  assert.equal((await f.get('/api/deliveries/'+body.requestId)).state,'accepted');assert.equal((await f.session()).editRecovery,null);
});
