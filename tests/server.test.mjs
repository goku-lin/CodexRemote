import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('unchanged histories do not publish; changed outputs and split UTF-8 arrive intact', async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = randomBytes(24).toString('hex');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-server-test-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOST:'127.0.0.1',PORT: String(port), CODEX_RELAY_TOKEN: token, CODEX_RELAY_NO_EMBEDDED: '1',CODEX_RELAY_DATA_DIR:directory }, windowsHide: true });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.on('error', reject);
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base+'/api/sessions',{headers:{origin:'https://attacker.test'}})).status,403);
  fs.writeFileSync(path.join(directory,'network.json'),JSON.stringify({externalOrigin:'https://relay.test-tail.ts.net'}));
  const proxyHeaders={host:'relay.test-tail.ts.net',origin:'https://relay.test-tail.ts.net','x-forwarded-proto':'https','x-forwarded-for':'100.64.0.2'};
  const proxyRequest=(endpoint,headers=proxyHeaders,body)=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+endpoint,{headers,method:body ? 'POST' : 'GET'},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:()=>JSON.parse(text)}));
    });req.on('error',reject);req.end(body);
  });
  assert.deepEqual((await proxyRequest('/api/access')).json(),{required:true,local:false});
  for(const endpoint of ['/api/sessions','/api/events','/api/uploads/missing'])assert.equal((await proxyRequest(endpoint)).status,401);
  assert.equal((await proxyRequest('/api/phone')).status,403);
  const phoneInfo=await (await fetch(base+'/api/phone')).json();
  assert.equal(phoneInfo.externalUrl,'https://relay.test-tail.ts.net/');
  const pairing=await proxyRequest('/api/access/pair',{...proxyHeaders,'content-type':'application/json'},JSON.stringify({code:phoneInfo.code}));
  assert.equal(pairing.status,200);assert.match(pairing.headers['set-cookie'][0],/; Secure$/);
  const pairedHeaders={...proxyHeaders,cookie:pairing.headers['set-cookie'][0].split(';')[0]};
  assert.equal((await proxyRequest('/api/sessions',pairedHeaders)).status,200);
  assert.equal((await proxyRequest('/api/phone',pairedHeaders)).status,403);
  const runner = '/api/runner/local/events';
  const post = (url, data) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-relay-token': token }, body: JSON.stringify(data) });
  const get = async url => (await fetch(base + url)).json();
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(base + '/api/events', { signal: abort.signal });
  const notifications = [];
  const reading = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream:true });
      const frames = buffer.split('\n\n'); buffer = frames.pop();
      for (const frame of frames) if (frame.startsWith('event:')) notifications.push(frame);
    }
  })().catch(() => {});
  t.after(() => reading);
  await post(runner, { type: 'thread_list', threads: [{ id: 'test-thread', name: 'Fixture', cwd: 'C:/fixture', createdAt: 10, updatedAt: 20, status: { type: 'idle' } }] });
  const session = (await get('/api/sessions')).sessions[0];
  const historyUrl = `/api/sessions/${session.id}/history`;
  const payload = { type: 'thread_history', sessionId: session.id, threadId: 'test-thread', turnCount: 1, messageCount: 3,
    turns: [{ id: 'turn', status: 'completed', itemCount: 3, startedAt: 10000, completedAt: 20000 }],
    items: [{ id: 'user', turnId: 'turn', role: 'user', text: 'Request', at: 10000 },
      { id: 'command', turnId: 'turn', role: 'process', kind: 'commandExecution', command: 'node --check app.js', output: 'first', at: 12000 },
      { id: 'final', turnId: 'turn', role: 'assistant', phase: 'final_answer', text: 'Done', at: 20000 }] };
  await post(runner, payload);
  const first = await get(historyUrl);
  assert.ok(first.historyVersion);
  assert.equal(first.events.at(-1).message.params.item.phase, 'final_answer');
  await post('/api/runner/local/heartbeat', {});
  await delay(50);
  const baseline = notifications.length;
  await post(runner, payload);
  await post(runner, payload);
  await post('/api/runner/local/heartbeat', {});
  await delay(100);
  assert.equal(notifications.length, baseline);
  assert.equal((await get(historyUrl)).historyVersion, first.historyVersion);
  payload.items[1].output = 'changed';
  await post(runner, payload);
  const changed = await get(historyUrl);
  assert.notEqual(changed.historyVersion, first.historyVersion);
  assert.equal(changed.events.length, first.events.length);
  assert.equal(changed.events[2].message.params.item.output, 'changed');

  // Split both three-byte Chinese and four-byte emoji across HTTP data chunks.
  const reply='优先做手机实测，它最能暴露真实使用中还缺什么。😀';
  payload.items.at(-1).text=reply;
  const body=Buffer.from(JSON.stringify(payload));
  const chinese=body.indexOf(Buffer.from('手机'));
  const emoji=body.indexOf(Buffer.from('😀'));
  const boundaries=[0,chinese+1,chinese+2,emoji+1,emoji+2,emoji+3,body.length];
  const status=await new Promise((resolve,reject)=>{
    const req=httpRequest(base+runner,{method:'POST',headers:{'content-type':'application/json','x-codex-relay-token':token}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });
    req.on('error',reject);
    (async()=>{for(let i=1;i<boundaries.length;i++){req.write(body.subarray(boundaries[i-1],boundaries[i]));await delay(10);}req.end();})().catch(reject);
  });
  assert.equal(status,202);
  assert.equal((await get(historyUrl)).events.at(-1).message.params.item.text,reply);

  // Async questions must be answerable while their original turn is still running.
  const commandsAbort = new AbortController();t.after(()=>commandsAbort.abort());
  const commands = await fetch(base + '/api/runner/local/commands', { headers: { 'x-codex-relay-token': token }, signal: commandsAbort.signal });
  let commandText='';const commandReading=(async()=>{for await(const chunk of commands.body)commandText+=new TextDecoder().decode(chunk);})().catch(()=>{});
  const questions=[{id:'["request_user_input_async","ask",0]',title:'选择连接方式',options:['Wi-Fi','外网']}];
  payload.turns[0].status='inProgress';payload.turns[0].completedAt=0;
  payload.items.push({id:'ask',turnId:'turn',role:'assistant',phase:'final_answer',delivery:'async',questions,at:21000});
  await post(runner,payload);
  const answerUrl=`/api/sessions/${session.id}/questions/ask/answers`;
  assert.equal((await post(answerUrl,{answers:{}})).status,400);
  const answers={[questions[0].id]:'Wi-Fi'};
  assert.equal((await post(answerUrl,{answers})).status,202);
  assert.equal((await post(answerUrl,{answers})).status,409);
  await post(runner,{sessionId:session.id,message:{method:'runner/questionAnswerError',params:{itemId:'ask',message:'连接暂时断开'}}});
  assert.equal((await get(historyUrl)).events.find(event=>event.message?.params?.item.id === 'ask').message.params.item.questionError,'连接暂时断开');
  assert.equal((await post(answerUrl,{answers})).status,202);
  await post(runner,{sessionId:session.id,message:{method:'runner/questionAnswered',params:{itemId:'ask',answers,delivery:'message'}}});
  await post(runner,payload);
  const restored=(await get(historyUrl)).events.find(event=>event.message?.params?.item.id === 'ask').message.params.item;
  assert.equal(restored.answerState,'forwarded');assert.deepEqual(restored.questionAnswers,answers);

  // Runner input requests use their native answer shape, never approval decisions.
  await post(runner,{sessionId:session.id,message:{id:77,method:'item/tool/requestUserInput',params:{threadId:'test-thread',turnId:'turn',itemId:'rpc-ask',isBlocking:true,questions:[{id:'connection',header:'连接',question:'如何连接？',options:[{label:'Wi-Fi',description:'同一网络'}]}]}}});
  assert.equal((await get('/api/sessions')).sessions[0].status,'waiting_input');
  await post(runner,payload);
  assert.equal((await get('/api/sessions')).sessions[0].status,'waiting_input');
  assert.ok((await get(historyUrl)).events.some(event=>event.message?.params?.item.id === 'rpc-ask'));
  assert.ok(!(await get(historyUrl)).events.some(event=>event.type === 'approval_request'));
  assert.equal((await post(`/api/sessions/${session.id}/questions/rpc-ask/answers`,{answers:{connection:'Wi-Fi'}})).status,202);
  await post(runner,payload);
  assert.equal((await get(historyUrl)).events.find(event=>event.message?.params?.item.id === 'rpc-ask').message.params.item.answerState,'sending');
  await post(runner,{sessionId:session.id,message:{method:'runner/responseSubmitted',params:{requestId:77,itemId:'rpc-ask'}}});
  assert.equal((await get(historyUrl)).events.find(event=>event.message?.params?.item.id === 'rpc-ask').message.params.item.answerState,'answered');
  // A queued phone answer must not be displayed as accepted when Desktop wins.
  await post(runner,{type:'native_status',connected:true,capabilities:{steer:true,interrupt:true,events:true,serverRequests:true},activeTurns:{'test-thread':'turn'},pendingRequests:[]});
  await post(runner,{origin:'desktop',sessionId:session.id,message:{id:'race',method:'item/tool/requestUserInput',params:{threadId:'test-thread',turnId:'turn',itemId:'race-ask',isBlocking:true,questions:[{id:'q',question:'选择？'}]}}});
  assert.equal((await post(`/api/sessions/${session.id}/questions/race-ask/answers`,{answers:{q:'手机回答'}})).status,202);
  await post(runner,{origin:'desktop',sessionId:session.id,message:{method:'relay/requestClaimed',params:{threadId:'test-thread',requestId:'race',winner:'desktop'}}});
  await post(runner,{origin:'desktop',sessionId:session.id,message:{method:'serverRequest/resolved',params:{threadId:'test-thread',requestId:'race'}}});
  const raced=(await get(historyUrl)).events.find(event=>event.message?.params?.item.id==='race-ask').message.params.item;
  assert.equal(raced.answerState,'resolved');assert.equal(raced.questionAnswers,undefined);
  await post(historyUrl, { maxTurns: 'all' });
  await delay(30);const text=commandText;
  commandsAbort.abort();
  await commandReading;
  assert.match(text, /"maxTurns":"all"/);
  assert.match(text,/"type":"answerQuestion"/);
  assert.match(text,/"requestId":77,"result":\{"answers":\{"connection":\{"answers":\["Wi-Fi"\]\}\}\}/);
});
