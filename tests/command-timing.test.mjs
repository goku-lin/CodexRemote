import test from 'node:test';
import assert from 'node:assert/strict';
import {itemTiming,commandTiming} from '../public/command-timing.js';
import {normalizeNativeItem} from '../src/rollout.mjs';
import {restoreCommandTiming} from '../src/thread-history.mjs';
import {rememberDesktopEvent,mergeDesktopHistory} from '../src/live-desktop-events.mjs';

test('running command time survives output, stops at completion and marks long execution without declaring a hang',()=>{
  const first=itemTiming({status:'inProgress'},{},{at:1000,phase:'started'});
  const next=itemTiming({status:'inProgress'},first,{at:5000,phase:'started'});assert.equal(next.startedAt,1000);
  assert.equal(commandTiming({...next,status:'inProgress'},7201000).label,'已运行 2 小时 0 分 0 秒 · 运行较久');
  const done=itemTiming({status:'completed'},next,{at:8000,phase:'completed'});
  assert.equal(commandTiming({...done,status:'completed'},7201000).label,'用时 7 秒');assert.equal(commandTiming({...done,status:'completed'},7201000).longRunning,false);
  assert.equal(commandTiming({status:'inProgress'}).label,'起始时间未知');
  assert.equal(commandTiming({status:'completed',durationMs:0}).label,'用时 0 秒');
});

test('native command timing uses recorded timestamps or duration, never synthetic turn positions',()=>{
  const raw={id:'cmd',type:'commandExecution',command:'check',status:'completed'};
  const recorded=normalizeNativeItem(raw,{started_at_ms:1000,completed_at_ms:8000},{timestamp:new Date(8000).toISOString()});
  assert.equal(recorded.startedAt,1000);assert.equal(recorded.durationMs,7000);
  const paged=normalizeNativeItem({...raw,durationMs:2500},{started_at_ms:123456,syntheticTiming:true},{timestamp:new Date(123456).toISOString()});
  assert.equal(paged.startedAt,0);assert.equal(paged.durationMs,2500);assert.equal(commandTiming(paged).label,'用时 2 秒');
  const missing=normalizeNativeItem({...raw,status:'inProgress'},{started_at_ms:123456,syntheticTiming:true},{timestamp:new Date(123456).toISOString()});
  assert.equal(commandTiming(missing,7200000).label,'起始时间未知');
});

test('a refreshed native history restores only matching command IDs and turns from actual rollout timing',()=>{
  const item={id:'cmd',turnId:'t',role:'process',kind:'commandExecution',status:'inProgress',startedAt:0,completedAt:0,durationMs:null};
  const history={items:[item],turns:[{id:'t',status:'inProgress',startedAt:1}]};
  const activity={id:'cmd',kind:'commandExecution',status:'inProgress',startedAt:1000,at:1000};
  const result=restoreCommandTiming(history,{turns:[{id:'t',activity}]});
  assert.equal(result.items[0].startedAt,1000);assert.equal(result.turns[0].activity.startedAt,1000);
  assert.equal(restoreCommandTiming(history,{turns:[{id:'other',activity}]}).items[0].startedAt,0);
  assert.equal(restoreCommandTiming(history,{turns:[{id:'t',activity:{...activity,id:'reverted'}}]}).turns[0].activity,undefined);
});

test('server overlays preserve command start across output and browser refresh without timing a partial delta as a new start',()=>{
  const session={events:[]},event=(method,params,at)=>({at,message:{method,params:{threadId:'thread',turnId:'t',...params}}});
  rememberDesktopEvent(session,event('item/started',{item:{id:'cmd',type:'commandExecution',command:'check'}},1000));
  rememberDesktopEvent(session,event('item/commandExecution/outputDelta',{itemId:'cmd',delta:'working'},5000));
  const incoming=[];mergeDesktopHistory(session,incoming,[{id:'t',status:'inProgress'}]);assert.equal(incoming[0].message.params.item.startedAt,1000);
  rememberDesktopEvent(session,event('item/completed',{item:{id:'cmd',type:'commandExecution'}},8000));
  assert.equal(session.liveItems.get('cmd').message.params.item.durationMs,7000);
  rememberDesktopEvent(session,event('item/commandExecution/outputDelta',{itemId:'unknown',delta:'partial'},9000));
  assert.equal(session.liveItems.get('unknown').message.params.item.timingSource,'unknown');
});
