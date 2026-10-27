import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('an active desktop writer continues the original thread through Desktop, including later sends', {timeout:15000}, async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'codex-relay-writer-'));
  const rpcLog=path.join(directory,'rpc.jsonl');const desktopLog=path.join(directory,'desktop.jsonl');
  const codexScript=path.join(directory,'codex-fixture.mjs');const mcpScript=path.join(directory,'mcp-fixture.mjs');
  await writeFile(codexScript,`import readline from 'node:readline';import {appendFileSync} from 'node:fs';
    readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.id==null)return;
      appendFileSync(process.env.RELAY_RPC_LOG,JSON.stringify(msg)+'\\n');
      const response=msg.method==='thread/resume' ? {error:{code:-32000,message:'thread original-thread already has an active writer'}} : {result:msg.method==='thread/list'?{data:[]}: {}};
      process.stdout.write(JSON.stringify({id:msg.id,...response})+'\\n');});`);
  await writeFile(mcpScript,`import readline from 'node:readline';import {appendFileSync} from 'node:fs';
    readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.id==null)return;let result={};
      if(msg.method==='tools/list')result={tools:[{name:'send_message_to_thread'},{name:'get_usage_limits'}]};
      if(msg.method==='tools/call'){appendFileSync(process.env.RELAY_DESKTOP_LOG,JSON.stringify(msg.params)+'\\n');result={content:[{type:'text',text:JSON.stringify(msg.params.name==='get_usage_limits' ? {rateLimits:{primary:{usedPercent:79,windowDurationMins:10080}}} : {threadId:msg.params.arguments.threadId,status:'sent'})}]};}
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');});`);
  const command={type:'startTurn',sessionId:'relay-session',threadId:'original-thread',cwd:directory,text:'Continue',model:'fixture',effort:'max'};
  let stream, child, output='', accepted=0, completionTimer;
  let resolveComplete,rejectComplete;
  const completed=new Promise((resolve,reject)=>{resolveComplete=resolve;rejectComplete=reject;completionTimer=setTimeout(()=>reject(new Error('Desktop continuation timed out: '+output)),9000);});
  const server=createServer(async(req,res)=>{
    if(req.headers['x-codex-relay-token']!=='fixture-token'){res.writeHead(401);res.end();return;}
    if(req.url.startsWith('/api/runner/fixture-device/commands')){
      stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(command)+'\n\n');return;
    }
    let body='';for await(const chunk of req)body+=chunk;
    const event=JSON.parse(body||'{}');res.writeHead(200,{'content-type':'application/json'});res.end('{}');
    if(event.message?.method==='runner/error')rejectComplete(new Error(event.message.params.message));
    if(event.message?.method==='runner/desktopAccepted'){
      try {assert.equal(event.sessionId,'relay-session');assert.equal(event.message.params.threadId,'original-thread');}
      catch(error){rejectComplete(error);return;}
      if(++accepted===1)stream.write('data: '+JSON.stringify({...command,text:'Continue again',effort:'low'})+'\n\n');
      else resolveComplete();
    }
  });
  t.after(async()=>{
    clearTimeout(completionTimer);
    if(child && child.exitCode===null){
      const stopped=new Promise(resolve=>child.once('exit',resolve));
      child.stdin.end();
      const fallback=setTimeout(()=>child.kill(),2000);
      await stopped;clearTimeout(fallback);
    }
    stream?.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  child=spawn(process.execPath,['runner.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,
    CODEX_RELAY_PARENT_PIPE:'1',CODEX_BIN:process.execPath,CODEX_ARGS_JSON:JSON.stringify([codexScript]),CODEX_RELAY_SERVER:`http://127.0.0.1:${server.address().port}`,
    CODEX_RELAY_DEVICE_ID:'fixture-device',CODEX_RELAY_TOKEN:'fixture-token',CODEX_RELAY_CWD:directory,CODEX_SESSIONS_DIR:directory,
    CODEX_APP_TOOLS_PIPE_PATH:'fixture-pipe',CODEX_THREAD_ID:'fixture-caller',CODEX_DESKTOP_BRIDGE_SERVER:mcpScript,
    CODEX_RELAY_NATIVE_ENDPOINT:path.join(directory,'native-desktop.json'),
    RELAY_RPC_LOG:rpcLog,RELAY_DESKTOP_LOG:desktopLog}});
  child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));child.once('error',rejectComplete);
  await completed;
  const rpc=(await readFile(rpcLog,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rpc.filter(call=>call.method==='thread/resume').length,1);
  assert.ok(!rpc.some(call=>['thread/start','thread/fork','turn/start'].includes(call.method)));
  const calls=(await readFile(desktopLog,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call=>call.name==='get_usage_limits').length,1);
  const sent=calls.filter(call=>call.name!=='get_usage_limits');
  assert.equal(sent.length,2);assert.ok(sent.every(call=>call.name==='send_message_to_thread'&&call.arguments.threadId==='original-thread'));
  assert.deepEqual(sent.map(call=>[call.arguments.prompt,call.arguments.model,call.arguments.thinking]),[['Continue','fixture','max'],['Continue again','fixture','low']]);
});
