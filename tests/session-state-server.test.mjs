import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('confirmed settings publish without downloading unchanged history; read receipts are shared, streamed, scoped and reject stale replies', { timeout:15_000 }, async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-read-server-'));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_TOKEN:'test-read',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_DATA_DIR:directory}});
  t.after(async()=>{const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  const base=`http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(directory,'network.json'),JSON.stringify({externalOrigin:'https://relay.test-tail.ts.net'}));
  const remote={host:'relay.test-tail.ts.net','x-forwarded-proto':'https'};
  const send=(endpoint,{headers={},body,method=body===undefined ? 'GET' : 'POST'}={})=>new Promise((resolve,reject)=>{
    const req=request(base+endpoint,{method,headers:{'content-type':'application/json',...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:JSON.parse(text)}));
    });req.on('error',reject);req.end(body===undefined ? undefined : JSON.stringify(body));
  });
  const info=(await send('/api/phone')).json;
  const pair=await send('/api/access/pair',{headers:remote,body:{code:info.code,deviceName:'Linux test'}});
  const paired={...remote,cookie:pair.headers['set-cookie'][0].split(';')[0]};
  assert.equal((await send('/api/devices/local/history-usage',{headers:remote})).status,401);
  assert.equal((await send('/api/devices/local/history-usage?from=100&to=200',{headers:remote})).status,401);
  assert.equal((await send('/api/devices/local/history-usage',{headers:paired})).status,200);
  const runner=body=>send('/api/runner/local/events',{headers:{'x-codex-relay-token':'test-read'},body});
  await runner({type:'historical_usage',usage:{status:'ready',totalTokens:1200,models:[{model:'gpt-6.1-sol',totalTokens:1200}]}});
  assert.equal((await send('/api/devices/local/history-usage',{headers:paired})).json.usage.totalTokens,1200);
  assert.equal((await send('/api/bootstrap',{headers:paired})).json.historicalUsages[0].models[0].model,'gpt-6.1-sol');
  await runner({type:'thread_list',threads:[{id:'actual',name:'Actual settings',cwd:directory,status:{type:'active'},model:'draft-choice',createdAt:1,updatedAt:2}]});
  const id=(await send('/api/sessions')).json.sessions[0].id;
  const payload={type:'thread_history',sessionId:id,threadId:'actual',messageCount:2,turnCount:1,
    settings:{model:'gpt-6.1-sol',effort:'max',at:1000},turns:[{id:'turn1',status:'inProgress',startedAt:1000,completedAt:0}],
    items:[{id:'u',role:'user',turnId:'turn1',text:'Check',at:1000}]};
  await runner(payload);
  let metadata=(await send('/api/sessions',{headers:paired})).json.sessions[0];
  assert.equal(metadata.nativeModel,'gpt-6.1-sol');assert.equal(metadata.nativeEffort,'max');
  assert.equal(metadata.model,'draft-choice');assert.equal(metadata.status,'running');assert.equal(metadata.unread,false);
  const version=metadata.historyVersion;
  payload.tokenUsage={usedTokens:120,windowTokens:1000,usedPercent:12,totalTokens:99999,updatedAt:1000};await runner(payload);
  metadata=(await send('/api/sessions',{headers:paired})).json.sessions[0];
  assert.equal(metadata.tokenUsage.usedPercent,12);assert.equal(metadata.historyVersion,version);assert.equal(metadata.unread,false);
  await runner({sessionId:id,message:{method:'thread/tokenUsage/updated',params:{threadId:'actual',turnId:'turn1',tokenUsage:{last:{totalTokens:20},modelContextWindow:1000,total:{totalTokens:100020}}}}});
  metadata=(await send('/api/sessions',{headers:paired})).json.sessions[0];assert.equal(metadata.tokenUsage.usedPercent,2);assert.equal(metadata.historyVersion,version);
  const usage={buckets:[{id:'codex',windows:[{minutes:10080,remainingPercent:21,resetsAt:1792295913}]}],updatedAt:2000,error:null};
  await runner({type:'account_usage',usage});
  assert.equal((await send('/api/devices/local/usage',{headers:remote})).status,401);
  assert.equal((await send('/api/devices/local/usage',{headers:paired})).json.usage.buckets[0].windows[0].remainingPercent,21);
  assert.equal((await send('/api/bootstrap',{headers:paired})).json.usages.length,1);
  await runner({type:'account_usage',usage:{buckets:[],error:'network',updatedAt:3000}});
  assert.equal((await send('/api/devices/local/usage')).json.usage.updatedAt,2000);
  assert.equal((await send('/api/devices/local/usage')).json.usage.buckets.length,1);
  await runner({type:'account_usage',usage:{buckets:[],error:null,refreshing:true,reset:true,updatedAt:0}});
  assert.equal((await send('/api/devices/local/usage')).json.usage.buckets.length,0);
  await runner({type:'account_usage',usage:{buckets:[],error:'new login unavailable',reset:true,updatedAt:3100}});
  assert.equal((await send('/api/devices/local/usage')).json.usage.buckets.length,0);
  await runner({type:'account_usage',usage:{buckets:[{id:'codex',windows:[{minutes:10080,remainingPercent:96}]}],reset:true,updatedAt:3200}});
  assert.equal((await send('/api/devices/local/usage')).json.usage.buckets[0].windows[0].remainingPercent,96);
  payload.settings={model:'gpt-6-astra',effort:'high',at:1500};await runner(payload);
  metadata=(await send('/api/sessions',{headers:paired})).json.sessions[0];
  assert.equal(metadata.nativeModel,'gpt-6-astra');assert.equal(metadata.nativeEffort,'high');assert.equal(metadata.historyVersion,version);
  payload.turns[0]={...payload.turns[0],status:'completed',completedAt:2000};
  payload.items.push({id:'a',role:'assistant',phase:'final_answer',turnId:'turn1',text:'Done',at:2000});await runner(payload);
  metadata=(await send('/api/sessions',{headers:paired})).json.sessions[0];
  assert.equal(metadata.unread,true);const firstToken=metadata.completionToken;
  const desktopSnapshot=unreadThreadIds=>runner({type:'desktop_read_state',contextKey:'a'.repeat(64),observedAt:Date.now(),scopeThreadIds:['actual'],unreadThreadIds});
  await desktopSnapshot([]);
  assert.equal((await send('/api/sessions')).json.sessions[0].unread,true,'Desktop read state cannot clear a remote unread reply');
  assert.equal((await send('/api/sessions')).json.sessions[0].readSource,'relay');
  let receivedRead;const readEvent=new Promise(resolve=>receivedRead=resolve);
  const stream=await new Promise((resolve,reject)=>{
    let buffer='';const req=request(base+'/api/events',{headers:paired},res=>{
      res.setEncoding('utf8');res.on('data',chunk=>{
        buffer+=chunk;const frames=buffer.split('\n\n');buffer=frames.pop();
        for(const frame of frames)if(frame.startsWith('event: session\n')){
          const data=JSON.parse(frame.split('\n').find(line=>line.startsWith('data:')).slice(5));
          if(data.id===id && !data.unread)receivedRead(data);
        }
      });resolve(res);
    });req.on('error',reject);req.end();t.after(()=>req.destroy());
  });
  assert.equal(stream.statusCode,200);
  assert.equal((await send(`/api/sessions/${id}/read`,{headers:remote,body:{completionToken:firstToken}})).status,401);
  const read=await send(`/api/sessions/${id}/read`,{body:{completionToken:firstToken}});
  assert.equal(read.status,200);assert.equal(read.json.session.unread,false);
  assert.equal((await readEvent).unread,false);
  assert.equal((await send('/api/bootstrap',{headers:paired})).json.sessions[0].unread,false);
  await desktopSnapshot(['actual']);
  await runner({sessionId:id,message:{method:'runner/readStateSubmitted',params:{requestId:'legacy',error:'Desktop unavailable'}}});
  assert.equal((await send('/api/bootstrap',{headers:paired})).json.sessions[0].unread,false,'late Desktop flags cannot restore a remote unread marker');
  payload.turns.push({id:'turn2',status:'inProgress',startedAt:3000});payload.turnCount=2;await runner(payload);
  payload.turns[1]={...payload.turns[1],status:'completed',completedAt:4000};
  payload.items.push({id:'a2',role:'assistant',phase:'final_answer',turnId:'turn2',text:'New reply',at:4000});await runner(payload);
  assert.equal((await send(`/api/sessions/${id}/read`,{headers:paired,body:{completionToken:firstToken}})).status,409);
  metadata=(await send('/api/sessions')).json.sessions[0];assert.equal(metadata.unread,true);
  assert.equal((await send(`/api/sessions/${id}/read`,{headers:paired,body:{completionToken:metadata.completionToken}})).status,200);
  assert.equal((await send('/api/sessions')).json.sessions[0].unread,false);
});
