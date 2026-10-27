import test from 'node:test';
import assert from 'node:assert/strict';
import {readThreadList, applyThreadStatus} from '../src/thread-sync.mjs';
import {mergeDesktopHistory} from '../src/live-desktop-events.mjs';
import {RolloutReader} from '../src/rollout.mjs';

test('thread discovery exhausts pagination and rejects partial, failed and cyclic responses', async () => {
  const cursors = [];
  const threads = await readThreadList(async cursor => {
    cursors.push(cursor);
    return cursor ? {data:[{id:'older'}],nextCursor:null} : {data:[{id:'recent'}],nextCursor:'next'};
  });
  assert.deepEqual(cursors, [undefined, 'next']);
  assert.deepEqual(threads.map(thread=>thread.id), ['recent','older']);
  await assert.rejects(readThreadList(async cursor=>{if(cursor)throw new Error('offline');return {data:[{id:'recent'}],nextCursor:'next'};}), /offline/);
  await assert.rejects(readThreadList(async()=>({error:'offline'})), /不完整/);
  await assert.rejects(readThreadList(async()=>({data:[],nextCursor:'same'})), /重复/);
});

test('cancelled turns stay interrupted when delayed tool results arrive, and a fresh task can run again', async () => {
  const reader = new RolloutReader();
  const event=(type,seconds,fields={})=>({type:'event_msg',timestamp:new Date(seconds*1000).toISOString(),payload:{type,turn_id:'turn',...fields}});
  reader.consume(event('task_started',1));
  reader.consume(event('item_completed',2,{item:{id:'user',type:'UserMessage',text:'Check'}}));
  reader.consume(event('turn_aborted',3,{reason:'interrupted'}));
  reader.consume(event('item_completed',4,{item:{id:'late',type:'FunctionCallOutput',name:'tool',output:'Finished after cancellation'}}));
  let history=await reader.read([]);
  assert.equal(history.turns.at(-1).status, 'interrupted');
  assert.equal(history.turns.at(-1).completedAt, 3000);
  reader.consume(event('task_started',5));
  history=await reader.read([]);
  assert.equal(history.turns.at(-1).status, 'inProgress');
});

test('ended history defeats a late start overlay without losing a genuinely newer turn', () => {
  const session={events:[],liveTurn:{id:'old',status:'inProgress',startedAt:100,at:400}};
  const turns=[{id:'old',status:'interrupted',startedAt:100,completedAt:300}];
  mergeDesktopHistory(session,[],turns);
  assert.equal(turns[0].status, 'interrupted');
  assert.equal(session.liveTurn, null);
  session.liveTurn={id:'new',status:'inProgress',startedAt:500,at:500};
  mergeDesktopHistory(session,[],turns);
  assert.equal(turns.at(-1).id, 'new');
  assert.equal(turns.at(-1).status, 'inProgress');
});

test('desktop idle clears stale execution without inventing success or overriding a pending send', () => {
  const session={status:'running',activeTurnId:'turn',turns:[{id:'turn',status:'inProgress',startedAt:100}]};
  applyThreadStatus(session,{type:'idle'},200);
  assert.equal(session.status,'synced');
  assert.equal(session.activeTurnId,null);
  const turns=[{id:'turn',status:'inProgress',startedAt:100}];
  mergeDesktopHistory(session,[],turns);
  assert.equal(turns[0].status,'stopped');
  mergeDesktopHistory(session,[],[{id:'turn',status:'completed',completedAt:150}]);
  assert.equal(session.liveTurn,null);
  const pending={status:'running',activeTurnId:'new',pendingSend:{at:300}};
  applyThreadStatus(pending,{type:'idle'},400);
  assert.equal(pending.status,'running');
  assert.equal(pending.activeTurnId,'new');
  const newEvent={status:'running',liveTurn:{id:'new',status:'inProgress',at:500}};
  applyThreadStatus(newEvent,{type:'idle'},400);
  assert.equal(newEvent.status,'running');
});
