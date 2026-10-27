import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HistoricalUsage} from '../src/historical-usage.mjs';

const record=(type,payload,ms=0)=>JSON.stringify({timestamp:new Date(ms).toISOString(),type,payload})+'\n';
const context=(model,turn)=>record('turn_context',{model,turn_id:turn});
const usage=(total,last,at,output=last/5)=>record('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:last,input_tokens:last-output-10,cached_input_tokens:10,output_tokens:output,reasoning_output_tokens:2},total_token_usage:{total_tokens:total}}},at);
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-historical-usage-')),sessions=path.join(directory,'sessions'),archived=path.join(directory,'archived_sessions');
  await mkdir(sessions);await mkdir(archived);const readers=[];
  const create=()=>{const reader=new HistoricalUsage({roots:[sessions,archived],cacheFile:path.join(directory,'index.sqlite')});readers.push(reader);return reader;};
  t.after(async()=>{for(const reader of readers)await reader.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  return {directory,sessions,archived,create};
}

test('history totals group actual calls by model, deduplicate copied forks and ignore inherited cumulative counters',async t=>{
  const f=await fixture(t),prefix=context('gpt-6.1-sol','a')+usage(100,100,2000)+usage(200,100,4000);
  await writeFile(path.join(f.sessions,'parent.jsonl'),prefix+context('gpt-6-astra','b')+usage(250,50,5000));
  await writeFile(path.join(f.sessions,'copied-fork.jsonl'),prefix);
  await writeFile(path.join(f.archived,'new-fork.jsonl'),context('gpt-6-astra','c')+usage(10000,50,6000));
  await writeFile(path.join(f.sessions,'unknown.jsonl'),usage(25,25,7000,5));
  const reader=f.create(),result=await reader.read();
  assert.equal(result.status,'ready');assert.equal(result.totalTokens,325);assert.equal(result.calls,5);assert.equal(result.models.length,3);
  const sol=result.models.find(model=>model.model==='gpt-6.1-sol');assert.equal(sol.totalTokens,200);assert.equal(sol.inputTokens,160);assert.equal(sol.cachedInputTokens,20);assert.equal(sol.outputTokens,40);assert.equal(sol.averageTokensPerSecond,10);
  assert.equal(result.models.find(model=>model.model==='gpt-6-astra').totalTokens,100);
  assert.equal(result.models.find(model=>model.model==='unknown').totalTokens,25);
  const cached=await reader.read();assert.equal(cached.totalTokens,325);assert.equal(cached.bytesRead,0);assert.equal(cached.cachedFiles,4);
});

test('index survives restart, reads only appended bytes and keeps totals stable when a file is archived',async t=>{
  const f=await fixture(t),file=path.join(f.sessions,'one.jsonl');
  await writeFile(file,context('gpt-6.1-sol','a')+usage(100,100,2000));
  const first=f.create();assert.equal((await first.read()).totalTokens,100);await first.close();
  const next=f.create();assert.equal((await next.read()).bytesRead,0);
  const extra=usage(150,50,4000);await appendFile(file,extra);
  const result=await next.read();assert.equal(result.totalTokens,150);assert.equal(result.bytesRead,Buffer.byteLength(extra));
  await rename(file,path.join(f.archived,'one.jsonl'));assert.equal((await next.read()).totalTokens,150);
});

test('large non-usage records stay bounded and unfinished accounting lines are counted once after completion',async t=>{
  const f=await fixture(t),file=path.join(f.sessions,'large.jsonl'),last=usage(100,100,2000),split=Math.floor(last.length/2);
  await writeFile(file,context('gpt-6.1-sol','a')+record('event_msg',{type:'user_message',message:'x'.repeat(3*1024*1024)})+last.slice(0,split));
  const reader=f.create();assert.equal((await reader.read()).totalTokens,0);
  await appendFile(file,last.slice(split));const result=await reader.read();assert.equal(result.totalTokens,100);assert.ok(result.bytesRead<1000);
  await appendFile(file,usage(100,100,3000));assert.equal((await reader.read()).totalTokens,100,'repeated unchanged cumulative usage is not another model call');
});

test('model switches replaying an unchanged accounting snapshot add no calls; a new per-call usage after a reset still counts',async t=>{
  const f=await fixture(t),file=path.join(f.sessions,'reset.jsonl');
  await writeFile(file,context('gpt-6.1-sol','first')+usage(100,100,2000)+context('gpt-6-astra','second')+usage(100,100,4000)+usage(100,50,5000)+usage(50,50,6000));
  const result=await f.create().read();assert.equal(result.totalTokens,150);assert.equal(result.models.length,2);assert.equal(result.calls,2);
});

test('date queries include the start, exclude the next midnight and never rescan or mix concurrent ranges',async t=>{
  const f=await fixture(t),start=Date.parse('2026-10-14T16:00:00Z'),end=Date.parse('2026-10-15T16:00:00Z');
  const prefix=context('gpt-6.1-sol','first')+usage(100,100,start-1)+usage(200,100,start);
  await writeFile(path.join(f.sessions,'parent.jsonl'),prefix+context('gpt-6-astra','next')+usage(250,50,end-1)+usage(300,50,end));
  await writeFile(path.join(f.archived,'fork.jsonl'),prefix);
  const reader=f.create();
  const [all,today,tomorrow]=await Promise.all([reader.read(),reader.query({from:start,to:end}),reader.query({from:end,to:end+86400000})]);
  assert.equal(all.totalTokens,300);assert.equal(today.totalTokens,150);assert.equal(today.calls,2);assert.equal(today.firstAt,start);assert.equal(today.lastAt,end-1);
  assert.equal(today.models.find(model=>model.model==='gpt-6.1-sol').totalTokens,100);
  assert.equal(today.models.find(model=>model.model==='gpt-6-astra').totalTokens,50);
  assert.equal(today.models.reduce((sum,model)=>sum+model.totalTokens,0),today.totalTokens);
  assert.equal(tomorrow.totalTokens,50);assert.equal(tomorrow.models.length,1);assert.equal(tomorrow.models[0].model,'gpt-6-astra');
  const none=await reader.query({from:end+1,to:end+86400000});assert.equal(none.totalTokens,0);assert.deepEqual(none.models,[]);assert.equal(none.calls,0);
  await appendFile(path.join(f.sessions,'parent.jsonl'),usage(350,50,end+2000));
  assert.equal((await reader.query({from:end,to:end+86400000})).totalTokens,50,'filtering reads only the existing index');
  await reader.read();assert.equal((await reader.query({from:end,to:end+86400000})).totalTokens,100);
  await assert.rejects(reader.query({from:end,to:start}),/范围无效/);
});
