import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopRuntimeReader,rememberDesktopRuntime,applyDesktopRuntime} from '../src/desktop-runtime.mjs';
import {mergeDesktopHistory} from '../src/live-desktop-events.mjs';

test('the actual Desktop runtime overrides an interrupted persisted turn and preserves live output',()=>{
  const runtime={status:{type:'active',activeFlags:[]},turnId:'current',observedAt:500};
  const event={at:400,message:{params:{turnId:'current',item:{id:'output',status:'inProgress',text:'Latest stream'}}}};
  const session={status:'interrupted',desktopRuntime:runtime,events:[],turns:[{id:'current',status:'interrupted',startedAt:100,completedAt:0}],liveItems:new Map([['output',event]])};
  applyDesktopRuntime(session);mergeDesktopHistory(session,[],session.turns);
  assert.equal(session.status,'running');assert.equal(session.activeTurnId,'current');assert.equal(session.executionOwner,'desktop');assert.equal(session.turns[0].status,'inProgress');assert.equal(session.liveItems.size,1);
  session.desktopRuntime={status:{type:'idle'},observedAt:600};applyDesktopRuntime(session);mergeDesktopHistory(session,[],session.turns);
  assert.equal(session.status,'synced');assert.equal(session.activeTurnId,null);assert.equal(session.turns[0].status,'stopped');
});
test('ended history still defeats an old cached turn ID until Desktop explicitly confirms activity',()=>{
  const session={status:'interrupted',events:[],turns:[{id:'old',status:'interrupted',completedAt:200}],liveTurn:{id:'old',status:'inProgress',at:300}};
  mergeDesktopHistory(session,[],session.turns);assert.equal(session.turns[0].status,'interrupted');assert.equal(session.liveTurn,null);
  session.desktopRuntime={status:{type:'active'},turnId:'old',observedAt:100,source:'event'};applyDesktopRuntime(session);mergeDesktopHistory(session,[],session.turns);
  assert.equal(session.turns[0].status,'interrupted','a delayed start event cannot defeat a later end in history');
  session.desktopRuntime={status:{type:'active',activeFlags:['waitingOnUserInput']},turnId:'old',observedAt:400};applyDesktopRuntime(session);
  assert.equal(session.status,'waiting_input');assert.equal(session.turns[0].status,'inProgress');
  const runner={executionOwner:'runner',status:'running',activeTurnId:'owned',desktopRuntime:{status:{type:'notLoaded'},observedAt:500}};
  applyDesktopRuntime(runner);assert.equal(runner.status,'running');assert.equal(runner.activeTurnId,'owned');
});
test('older runtime snapshots cannot undo newer lifecycle events even in the same millisecond',()=>{
  const session={};const active={status:{type:'active'},turnId:'turn',observedAt:100,epoch:'a',revision:1};
  assert.equal(rememberDesktopRuntime(session,active),true);
  const idle={status:{type:'idle'},observedAt:100,epoch:'a',revision:2};assert.equal(rememberDesktopRuntime(session,idle),true);
  assert.equal(rememberDesktopRuntime(session,active),false);assert.equal(session.desktopRuntime.status.type,'idle');
  assert.equal(rememberDesktopRuntime(session,{...active,observedAt:99,epoch:'b'}),false);
});
test('runtime verification uses metadata-only reads, expires active and idle states at different rates, and clears stale cached IDs',async()=>{
  let now=1000,status='active';const calls=[],native={connected:true,activeTurns:new Map([['thread','turn']]),request:async(method,params)=>{calls.push({method,params});return {thread:{id:'thread',status:{type:status}}};}};
  const reader=new DesktopRuntimeReader(native,{now:()=>now,epoch:'fixture'});
  await reader.refresh(['thread','thread']);assert.equal(reader.get('thread').turnId,'turn');assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{method:'thread/read',params:{threadId:'thread',includeTurns:false}});
  now+=9000;await reader.refresh(['thread']);assert.equal(calls.length,1);
  now+=1000;status='idle';await reader.refresh(['thread']);assert.equal(calls.length,2);assert.equal(native.activeTurns.size,0);
  now+=59_000;await reader.refresh(['thread']);assert.equal(calls.length,2);
  now+=1000;await reader.refresh(['thread']);assert.equal(calls.length,3);
  native.request=async()=>{throw new Error('Disconnected');};now+=60_000;await reader.refresh(['thread']);assert.equal(reader.get('thread').status.type,'idle');
  reader.retain([]);assert.equal(reader.states.size,0);
});
test('a lifecycle change during an outstanding metadata read wins, and reads of the same thread coalesce',async()=>{
  let finish,now=100;const native={connected:true,activeTurns:new Map([['thread','current']]),request:()=>new Promise(r=>{finish=r;})};
  const reader=new DesktopRuntimeReader(native,{now:()=>now,epoch:'fixture'});
  const first=reader.read('thread'),second=reader.read('thread');now=200;
  reader.observe({method:'turn/completed',params:{threadId:'thread',turn:{id:'current'}}});
  finish({thread:{id:'thread',status:{type:'active'}}});await Promise.all([first,second]);
  assert.equal(reader.get('thread').status.type,'idle');
  native.activeTurns.set('thread','new');now=300;reader.observe({method:'turn/started',params:{threadId:'thread',turn:{id:'new'}}});
  reader.observe({method:'turn/completed',params:{threadId:'thread',turn:{id:'current'}}});
  assert.equal(reader.get('thread').status.type,'active');assert.equal(reader.get('thread').turnId,'new');
});

test('checking many visible threads runs at most four metadata reads at once',async()=>{
  let active=0,peak=0,calls=0;
  const native={connected:true,activeTurns:new Map(),request:async(method,{threadId})=>{
    calls++;peak=Math.max(peak,++active);await new Promise(resolve=>setImmediate(resolve));active--;
    return {thread:{id:threadId,status:{type:'notLoaded'}}};
  }};
  const reader=new DesktopRuntimeReader(native);
  await reader.refresh(Array.from({length:25},(_,i)=>'thread'+i));
  assert.equal(calls,25);assert.equal(peak,4);assert.equal(reader.states.size,25);
});
