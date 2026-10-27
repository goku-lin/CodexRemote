import test from 'node:test';
import assert from 'node:assert/strict';
import {accountLimits,contextUsage,projectCounts,quotaWindowName,compactTokens,TokenRateTracker} from '../public/usage.js';
import {LiveConnection} from '../public/reliability.js';

test('quota windows use durations rather than primary/secondary position and preserve unavailable values',()=>{
  const result=accountLimits({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{
    primary:{usedPercent:79,windowDurationMins:10080,resetsAt:1792295913},secondary:null,
    credits:{balance:'58497.7',unlimited:false}}}});
  assert.equal(result.length,1);assert.deepEqual(result[0].windows,[{minutes:10080,remainingPercent:21,resetsAt:1792295913}]);
  assert.equal(result[0].credits.balance,'58497.7');
  assert.equal(accountLimits({rateLimits:{secondary:{usedPercent:0,windowDurationMins:300}}})[0].windows[0].remainingPercent,100);
  assert.equal(accountLimits({rateLimits:{primary:{usedPercent:null}}})[0].windows[0].remainingPercent,null);
  assert.equal(accountLimits({rateLimits:{primary:{usedPercent:110}}})[0].windows[0].remainingPercent,0);
  assert.equal(quotaWindowName(300),'5 小时额度');assert.equal(quotaWindowName(10080),'周额度');
});
test('context uses the latest call including cached tokens once, never cumulative conversation usage',()=>{
  const value=contextUsage({last_token_usage:{total_tokens:150304,cached_input_tokens:147584},total_token_usage:{total_tokens:274527731},model_context_window:258400},1000);
  assert.equal(value.usedTokens,150304);assert.equal(value.totalTokens,274527731);
  assert.ok(value.usedPercent>58 && value.usedPercent<59);assert.equal(value.updatedAt,1000);
  assert.equal(contextUsage({last:{totalTokens:10},modelContextWindow:null}).usedPercent,null);
  assert.equal(contextUsage({total:{totalTokens:999}}),null);
  assert.equal(contextUsage({last:{totalTokens:0},modelContextWindow:100}).usedPercent,0);
});
test('project completion excludes failures and running states and reports unread separately',()=>{
  assert.deepEqual(projectCounts([{status:'done',unread:true},{status:'done'},{status:'waiting_input',unread:true},{status:'failed',unread:true}]),{completed:2,running:1,unread:2});
});
test('account events stream independently from conversation history',()=>{
  const callbacks=new Map();const events=[];const stream={close(){},addEventListener:(name,cb)=>callbacks.set(name,cb)};
  const connection=new LiveConnection({createStream:()=>stream,onStatus:()=>{},onEvent:(type,data)=>events.push({type,data})});connection.connect();
  callbacks.get('account_usage')({data:JSON.stringify({deviceId:'local',buckets:[]})});
  assert.deepEqual(events,[{type:'account_usage',data:{deviceId:'local',buckets:[]}}]);
});

test('token rate uses reported output counters, stays scoped to the call turn/model and rejects missing or reset counters',()=>{
  const rates=new TokenRateTracker(),session={id:'one',tokenUsage:{turnId:'turn',model:'gpt-6.1-sol',updatedAt:1000,totalOutputTokens:100}};
  assert.equal(rates.observe(session),null);
  Object.assign(session.tokenUsage,{updatedAt:3000,totalOutputTokens:140});assert.equal(rates.observe(session),20);
  assert.equal(rates.observe(session),20,'rendering again cannot count tokens twice');
  Object.assign(session.tokenUsage,{model:'gpt-6-astra',updatedAt:4000,totalOutputTokens:180});assert.equal(rates.observe(session),null);
  Object.assign(session.tokenUsage,{updatedAt:6000,totalOutputTokens:10});assert.equal(rates.observe(session),null);
  assert.equal(rates.observe({id:'missing',tokenUsage:{usedTokens:500}}),null);
  const normalized=contextUsage({last:{totalTokens:30,outputTokens:10},total:{totalTokens:100,outputTokens:40}},5000,{turnId:'turn',model:'gpt-6-astra'});
  assert.equal(normalized.totalOutputTokens,40);assert.equal(normalized.model,'gpt-6-astra');
  assert.equal(compactTokens(100000000),'1亿');assert.equal(compactTokens(null),'—');
});
