import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,rm,unlink,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeDesktopHost} from '../src/native-desktop-channel.mjs';
import {normalizeQuestions,questionReplies} from '../public/questions.js';
import {readFixture} from './desktop-read-fixture.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,condition){for(let i=0;i<400;i++){const value=await read();if(condition(value))return value;await pause(20);}throw new Error('Desktop synchronization timed out');}

test('async answers resolve Desktop cards and native edits replace web history despite stale rollouts and late snapshots',{timeout:25000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-desktop-sync-')),children=[];
  let host;
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null && child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}
    await host?.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});
  });
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`,endpointFile=path.join(directory,'native-desktop.json'),dbFile=path.join(directory,'history.json'),cliFile=path.join(directory,'codex.mjs'),rolloutFile=path.join(directory,'stale-rollout.jsonl');
  await writeFile(rolloutFile,[{type:'event_msg',timestamp:new Date(1000).toISOString(),payload:{type:'task_started',turn_id:'old'}},{type:'event_msg',timestamp:new Date(1100).toISOString(),payload:{type:'item_completed',turn_id:'old',item:{id:'u-old',type:'UserMessage',text:'Original request'}}},{type:'event_msg',timestamp:new Date(1200).toISOString(),payload:{type:'item_completed',turn_id:'old',item:{id:'stale-reply',type:'AgentMessage',text:'Removed reply'}}}].map(JSON.stringify).join('\n')+'\n');
  const questions=normalizeQuestions([{title:'Choose?',options:['Yes']}],'ask');
  let coreStatus='active';
  let turns=[{id:'old',status:'interrupted',startedAt:1,itemsView:'full',items:[{id:'u-old',type:'userMessage',content:[{type:'text',text:'Original request'}]},{id:'ask',type:'agentMessage',delivery:'async',questions:[{title:'Choose?',options:['Yes']}],text:''}]}];
  const save=()=>writeFile(dbFile,JSON.stringify(turns));await save();
  const readState=readFixture(['original']),globalFile=path.join(directory,'.codex-global-state.json'),toolFile=path.join(directory,'app-tools.mjs'),toolCalls=path.join(directory,'tool-calls.jsonl');
  await writeFile(toolCalls,'');
  await writeFile(path.join(directory,'auth.json'),JSON.stringify(readState.auth));await writeFile(globalFile,JSON.stringify(readState.global));
  await writeFile(toolFile,`import readline from 'node:readline';import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};
      if(m.method==='tools/list')result={tools:[{name:'send_message_to_thread'},{name:'get_usage_limits'},{name:'set_thread_read_state'}]};
      if(m.method==='tools/call'){
        if(m.params.name==='set_thread_read_state'){appendFileSync(process.env.FIXTURE_TOOL_CALLS,JSON.stringify(m.params)+'\\n');const state=JSON.parse(readFileSync(process.env.FIXTURE_GLOBAL,'utf8'));for(const hosts of Object.values(state['electron-thread-read-state-v1'].unreadByIdentity))if(hosts['local:fixture'])hosts['local:fixture']=hosts['local:fixture'].filter(id=>id!==m.params.arguments.threadId);writeFileSync(process.env.FIXTURE_GLOBAL,JSON.stringify(state));}
        result={content:[{type:'text',text:JSON.stringify({threadId:'original',read:true})}]};
      }process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const core=[],desktop=[],pendingDesktopQuestions=new Set([questions[0].id]);
  host=new NativeDesktopHost({endpointFile,writeDesktop:message=>{
    desktop.push(message);
    if(message.params?.item?.type==='userMessage')for(const reply of questionReplies(message.params.item.content?.[0]?.text))pendingDesktopQuestions.delete(reply.questionItemId);
  },writeCore:message=>{
    core.push(message);
    if(message.method==='thread/read')host.fromCore({id:message.id,result:{thread:{id:'original',historyMode:'paginated',status:{type:coreStatus},turns:[]}}});
    if(message.method==='turn/steer'){
      const item={id:'native-answer',type:'userMessage',content:message.params.input};turns.at(-1).items.push(item);
      save().then(()=>{host.fromCore({method:'item/completed',params:{threadId:'original',turnId:'old',item}});host.fromCore({id:message.id,result:{turnId:'old'}});});
    }
  }});
  await host.listen();host.fromDesktop({method:'initialized'});host.fromCore({method:'turn/started',params:{threadId:'original',turn:{id:'old',status:'inProgress'}}});
  await writeFile(cliFile,`import readline from 'node:readline';import {readFileSync} from 'node:fs';
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
      const turns=JSON.parse(readFileSync(process.env.FIXTURE_HISTORY,'utf8')),thread={id:'original',name:'Desktop sync',path:process.env.FIXTURE_ROLLOUT,historyMode:'paginated',cwd:process.env.CODEX_RELAY_CWD,createdAt:1,updatedAt:2,status:{type:'notLoaded'},turns:[]};
      let result={};if(m.method==='thread/list')result={data:[thread]};if(m.method==='thread/read')result={thread};
      if(m.method==='thread/turns/list'){const start=Number(m.params.cursor||0),data=turns.slice().reverse().slice(start,start+m.params.limit).map(t=>({...t,itemsView:m.params.itemsView,items:m.params.itemsView==='full'?t.items:[]}));result={data,nextCursor:start+data.length<turns.length?String(start+data.length):null};}
      process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const env={...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_TOKEN:'sync-fixture',CODEX_RELAY_DATA_DIR:directory,CODEX_HOME:directory,CODEX_RELAY_PARENT_PIPE:'0',CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',CODEX_RELAY_NATIVE_ENDPOINT:endpointFile,CODEX_BIN:process.execPath,CODEX_ARGS_JSON:JSON.stringify([cliFile]),CODEX_SESSIONS_DIR:path.join(directory,'sessions'),CODEX_RELAY_CWD:directory,CODEX_RELAY_SERVER:base,FIXTURE_HISTORY:dbFile,FIXTURE_ROLLOUT:rolloutFile};
  Object.assign(env,{CODEX_APP_TOOLS_PIPE_PATH:'fixture',CODEX_THREAD_ID:'fixture-caller',CODEX_DESKTOP_BRIDGE_SERVER:toolFile,FIXTURE_GLOBAL:globalFile,FIXTURE_TOOL_CALLS:toolCalls});
  let server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env,windowsHide:true});children.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  let runner=spawn(process.execPath,['runner.mjs'],{cwd:new URL('..',import.meta.url),env,windowsHide:true});children.push(runner);
  runner.stderr.on('data',chunk=>t.diagnostic(String(chunk)));
  const get=async p=>(await fetch(base+p)).json(),post=(p,body)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json','x-codex-relay-token':'sync-fixture'},body:JSON.stringify(body)});
  const session=await until(async()=>(await get('/api/sessions')).sessions[0],s=>s?.historyLoaded && s.controls?.steer);
  assert.equal(session.status,'running');assert.equal(session.activeTurnId,'old');
  const historyUrl=`/api/sessions/${session.id}/history`;
  let history=await until(()=>get(historyUrl),h=>h.events.some(e=>e.message?.params.item?.id==='ask'));
  assert.equal(history.turns.at(-1).id,'old');
  assert.equal(history.turns.at(-1).status,'inProgress','a live Desktop writer must override its interrupted persisted turn');
  await until(async()=>[...host.peers].some(peer=>peer.authenticated && peer.threads.has('original')),Boolean);
  host.fromCore({method:'item/completed',params:{threadId:'original',turnId:'old',item:{...turns[0].items[1],text:'Live question'}}});
  await until(()=>get(historyUrl),h=>h.events.some(e=>e.message?.params.item?.id==='ask' && e.message.params.item.text==='Live question'));
  const pendingSummary=(await get('/api/sessions')).sessions.find(s=>s.id===session.id);
  assert.ok(pendingSummary.pendingAttention.some(item=>item.id==='ask' && item.kind==='question'),'an async question remains visible in sidebar metadata while Desktop is running');
  assert.equal(pendingSummary.status,'running');
  // Reload our backend while the Desktop host and its unanswered card stay alive.
  for(const child of [runner,server]){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}
  server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env,windowsHide:true});children.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  runner=spawn(process.execPath,['runner.mjs'],{cwd:new URL('..',import.meta.url),env,windowsHide:true});children.push(runner);
  const recovered=await until(async()=>(await get('/api/sessions')).sessions.find(s=>s.id===session.id),s=>s?.controls?.steer && s.pendingAttention.some(item=>item.id==='ask'));
  assert.equal(recovered.status,'running');assert.equal(pendingDesktopQuestions.size,1,'backend reload preserves the unanswered Desktop card');
  await until(async()=>[...host.peers].some(peer=>peer.authenticated && peer.threads.has('original')),Boolean);
  assert.equal((await post(`/api/sessions/${session.id}/questions/ask/answers`,{answers:{[questions[0].id]:'Yes'}})).status,202);
  await until(()=>get(historyUrl),h=>h.events.some(e=>e.message?.params.item?.id==='ask' && e.message.params.item.answerState==='answered'));
  assert.equal(pendingDesktopQuestions.size,0,'Desktop matches the reply to the native question ID');
  assert.deepEqual((await get('/api/sessions')).sessions.find(s=>s.id===session.id).pendingAttention,[],'answered questions leave the global pending list');
  const reply=core.find(m=>m.method==='turn/steer');assert.deepEqual(questionReplies(reply.params.input[0].text),[{questionItemId:questions[0].id,question:'Choose?',answer:'Yes'}]);
  assert.ok(!(await get(historyUrl)).events.some(e=>e.type==='user_message' && e.text.includes('send_user_message_question_reply')));
  await post('/api/runner/local/events',{sessionId:session.id,message:{method:'runner/questionAnswered',params:{itemId:'ask',answers:{[questions[0].id]:'Yes'},delivery:'question'}}});
  assert.ok((await get(historyUrl)).events.filter(e=>e.message?.params.item?.id==='ask').every(e=>e.message.params.item.answerState==='answered'));
  await post('/api/runner/local/events',{type:'thread_history',sessionId:session.id,threadId:'original',authoritative:true,visibleTurnIds:['old'],historyRevision:0,turns:[{id:'old',status:'inProgress',startedAt:1000}],items:[{id:'ask',turnId:'old',role:'assistant',text:'',delivery:'async',questions}]});
  assert.equal((await get(historyUrl)).events.find(e=>e.message?.params.item?.id==='ask').message.params.item.answerState,'answered','a stale snapshot and live overlay must retain accepted answers');

  // The Desktop reverts the original thread, then starts its replacement turn.
  coreStatus='idle';host.fromCore({method:'turn/completed',params:{threadId:'original',turn:{id:'old',status:'completed'}}});
  turns[0].status='completed';await save();
  const completed=await until(async()=>(await get('/api/sessions')).sessions[0],s=>s.status==='done' && s.unread && s.completionToken && s.readSource==='relay');
  const readUrl=`/api/sessions/${session.id}/read`,firstToken=completed.completionToken;
  assert.deepEqual((await Promise.all([post(readUrl,{completionToken:firstToken}),post(readUrl,{completionToken:firstToken})])).map(r=>r.status),[200,200]);
  assert.equal((await get('/api/sessions')).sessions[0].unread,false);
  assert.equal(await readFile(toolCalls,'utf8'),'','remote receipts never call the Desktop read tool');
  const stale={type:'thread_history',sessionId:session.id,threadId:'original',historyRevision:0,turns:[{id:'old',status:'completed'}],items:[{id:'a-old',turnId:'old',role:'assistant',text:'Removed reply'}]};
  await post('/api/runner/local/events',stale);
  turns=[];await save();host.fromCore({method:'thread/reverted',params:{threadId:'original'}});
  await until(async()=>(await get('/api/sessions')).sessions.find(s=>s.id===session.id),s=>s.status==='synced' && !s.activeTurnId);
  await until(()=>get(historyUrl),h=>h.historyLoaded && h.turns.length===0);
  await post('/api/runner/local/events',stale);assert.equal((await get(historyUrl)).turns.length,0,'a late pre-edit snapshot cannot restore removed turns');
  await unlink(rolloutFile); // The authoritative database remains readable if an old rollout disappears.
  turns=[{id:'edited',status:'completed',startedAt:3,completedAt:4,itemsView:'full',items:[{id:'u-edited',type:'userMessage',content:[{type:'text',text:'Edited request'}]},{id:'a-edited',type:'agentMessage',text:'New reply',phase:'final_answer'}]}];await save();
  coreStatus='active';host.fromCore({method:'turn/started',params:{threadId:'original',turn:{id:'edited',status:'inProgress'}}});coreStatus='idle';host.fromCore({method:'turn/completed',params:{threadId:'original',turn:{id:'edited',status:'completed'}}});
  history=await until(()=>get(historyUrl),h=>h.events.some(e=>e.type==='user_message' && e.text==='Edited request') && h.events.some(e=>e.message?.params.item?.text==='New reply'));
  assert.deepEqual(history.turns.map(t=>t.id),['edited']);assert.equal(history.turnCount,1);
  assert.ok(!history.events.some(e=>e.turnId==='old'||e.message?.params.turnId==='old'));
  assert.ok(!core.some(m=>m.method==='thread/fork'));
  readState.global['electron-thread-read-state-v1'].unreadByIdentity[readState.identity]['local:fixture']=['original'];
  await writeFile(globalFile,JSON.stringify(readState.global));
  const unread=await until(async()=>(await get('/api/sessions')).sessions[0],s=>s.status==='done' && s.unread);
  assert.notEqual(unread.completionToken,firstToken);
  assert.equal((await post(readUrl,{completionToken:firstToken})).status,409);
  assert.equal(await readFile(toolCalls,'utf8'),'');
  assert.equal((await post(readUrl,{completionToken:unread.completionToken})).status,200);
  assert.equal((await get('/api/sessions')).sessions[0].unread,false);
  assert.equal(await readFile(toolCalls,'utf8'),'');
  const desktopSaved=JSON.parse(await readFile(globalFile,'utf8'));assert.deepEqual(desktopSaved['electron-thread-read-state-v1'].unreadByIdentity[readState.identity]['local:fixture'],['original'],'remote read receipts leave Desktop flags alone');
});
