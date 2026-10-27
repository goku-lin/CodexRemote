import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopStatusReader, statusFromLog } from '../src/desktop-status.mjs';
import { runtimeNotice, composerModelLabel } from '../public/runtime-status.js';
import { effectiveSettings } from '../public/composer-settings.js';
import { validateOptions, threadOptions, turnOptions } from '../src/relay-options.mjs';

const threadId='00000000-0000-0000-0000-000000000001';
const turnId='00000000-0000-0000-0000-000000000002';
const log=(id,attempt=1)=>({id,ts:100+id,ts_nanos:0,thread_id:threadId,target:'codex_core::responses_retry',
  feedback_log_body:`session_loop{thread_id=${threadId}}:run_sampling_request{turn_id=${turnId}}: stream disconnected - retrying sampling request (${attempt}/5 in 433ms)... turn_id=${turnId} retries=${attempt} max_retries=5 sampling_error=request timed out`});

test('runtime notices accept real notifications, including unnumbered network waits, and ignore command text',()=>{
  const retry=runtimeNotice('error',{willRetry:true,error:{message:'Reconnecting... 2/5'}},1000);
  assert.equal(retry.text,'正在重新连接 2/5');
  assert.equal(runtimeNotice('reconnect',{message:'Reconnecting... waiting for network'}).text,'正在重新连接 · 等待网络');
  assert.equal(runtimeNotice('item/started',{item:{type:'commandExecution',command:'echo contextCompaction'}}),null);
  assert.equal(runtimeNotice('error',{error:{message:'Selected model is at capacity.'}}),null);
  assert.equal(statusFromLog({...log(1),thread_id:null}),null);
  assert.equal(statusFromLog({...log(1),target:'codex_core::tool',feedback_log_body:'rg reconnect'}),null);
});

test('Desktop retry diagnostics are read-only, incremental, scoped, and stop overriding activity after recovery',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-status-'));
  const db=new DatabaseSync(path.join(directory,'logs_2.sqlite'));
  db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,target TEXT,feedback_log_body TEXT)');
  const insert=row=>db.prepare('INSERT INTO logs VALUES(?,?,?,?,?,?)').run(row.id,row.ts,row.ts_nanos,row.thread_id,row.target,row.feedback_log_body);
  const reader=new DesktopStatusReader(directory);
  t.after(async()=>{reader.close();db.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  insert(log(1));insert({...log(2),thread_id:'another-thread'});
  const turns=[{id:turnId,status:'inProgress',startedAt:100000,lastUpdateAt:100000}];
  let result=await reader.read(threadId,turns);
  assert.equal(result[0].activity.text,'正在重新连接 1/5');
  assert.equal(result[0].notices.length,1);
  assert.deepEqual(await reader.read(threadId,turns),result);
  assert.throws(()=>reader.db.prepare('DELETE FROM logs').run(),/readonly|read.only/i);
  insert(log(3,2)); result=await reader.read(threadId,turns);
  assert.equal(result[0].activity.text,'正在重新连接 2/5');
  assert.equal(result[0].notices.length,2);
  result=await reader.read(threadId,[{...turns[0],lastUpdateAt:104000,activity:{kind:'commandExecution',at:104000}}]);
  assert.equal(result[0].activity.kind,'commandExecution');
  result=await reader.read(threadId,[{...turns[0],status:'completed',activity:null}]);
  assert.equal(result[0].activity,null);
  assert.equal(result[0].notices.length,2);
  reader.forget(threadId);assert.equal(reader.notices.has(threadId),false);
});

test('Fast is independent of effort, forwards the catalog tier, and explicitly returns to standard speed',()=>{
  const catalog={fastModeEnabled:true,defaultModel:'fixture',models:[{model:'fixture',displayName:'GPT-6.1-Sol',defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max'}],serviceTiers:[{id:'priority',name:'Fast',description:'2x speed, increased usage'}]}]};
  const selected=validateOptions({model:'fixture',effort:'max',serviceTier:'priority'},catalog);
  assert.deepEqual(turnOptions(selected),{model:'fixture',effort:'max',serviceTier:'priority'});
  assert.equal(threadOptions(selected).serviceTier,'priority');
  assert.equal(turnOptions(validateOptions({...selected,serviceTier:'default'},catalog)).serviceTier,null);
  assert.throws(()=>validateOptions({...selected,serviceTier:'invented'},catalog),/不支持/);
  assert.throws(()=>validateOptions(selected,{...catalog,fastModeEnabled:false}),/不支持/);
  const own=effectiveSettings(catalog,{},selected);
  assert.equal(own.fast,true);assert.equal(own.effort,'max');
  assert.equal(composerModelLabel(own),'GPT-6.1 Sol Max');
  const desktop=effectiveSettings(catalog,{executionOwner:'desktop',nativeServiceTier:'default'},selected);
  assert.equal(desktop.fastReadOnly,true);assert.equal(desktop.fast,false);
});
