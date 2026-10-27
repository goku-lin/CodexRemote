import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryPreloader,recentHistorySessions} from '../public/history-preload.js';

const session=(id,projectId,updatedAt)=>({id,projectId,deviceId:'local',updatedAt,source:'imported',historyLoaded:true,historyVersion:'v1',unread:true});

test('preload count and project scope are configurable; disabling during a download prevents subsequent requests',async()=>{
  const sessions=Array.from({length:25},(_,i)=>session(String(i),'project-'+i%3,i));
  const state={sessions,activeId:'0',deviceId:'local',paused:false,scope:'project',limit:4,historyTurns:2};
  assert.deepEqual(recentHistorySessions(sessions,state).map(item=>item.id),['0','24','21','18']);
  state.scope='all';state.limit=20;assert.equal(recentHistorySessions(sessions,state).length,20);
  state.limit=1;assert.deepEqual(recentHistorySessions(sessions,state).map(item=>item.id),['0']);
  state.limit=4;const calls=[];
  const preloader=new HistoryPreloader({getState:()=>state,isCached:()=>false,load:async item=>{calls.push(item.id);state.enabled=false;}});
  await preloader.run();assert.deepEqual(calls,['24']);
  await preloader.run();assert.deepEqual(calls,['24']);
  assert.deepEqual(preloader.candidates().map(item=>item.id),['0']);
  state.enabled=true;state.limit=2;state.historyTurns=3;
  await preloader.run();assert.deepEqual(calls,['24','24'],'changed depth bypasses the retry throttle');
});

test('eight recent histories span projects, include the active conversation and remembered switches, and exclude hidden or other computers',()=>{
  const sessions=Array.from({length:15},(_,i)=>session(String(i),'project-'+i%3,i));
  sessions.push({...session('hidden','secret',100),hidden:true},{...session('archived','old',200),archived:true},{...session('other','elsewhere',300),deviceId:'other'});
  const candidates=recentHistorySessions(sessions,{activeId:'0',deviceId:'local',visited:['deleted','1','3']});
  assert.deepEqual(candidates.map(item=>item.id),['0','1','3','14','13','12','11','10']);
  assert.equal(new Set(candidates.map(item=>item.projectId)).size,3);
});

test('background histories load one at a time, skip cached text and pause for foreground work; they never mark unread',async()=>{
  const sessions=Array.from({length:12},(_,i)=>session(String(i),'project-'+i%3,12-i));
  const state={sessions,activeId:'0',deviceId:'local',paused:false},cached=new Set(['1']),calls=[];
  let release,started;const first=new Promise(resolve=>started=resolve);
  const preloader=new HistoryPreloader({getState:()=>state,isCached:item=>cached.has(item.id),load:async item=>{
    calls.push(item.id);if(item.id==='2'){started();await new Promise(resolve=>release=resolve);}cached.add(item.id);
  }});
  const run=preloader.run();await first;assert.deepEqual(calls,['2']);
  state.paused=true;release();await run;assert.deepEqual(calls,['2']);
  state.paused=false;await preloader.run();assert.deepEqual(calls,['2','3','4','5','6','7']);
  await preloader.run();assert.equal(calls.length,6);assert.ok(sessions.every(item=>item.unread));
});

test('remembered visits survive refresh and failed requests are throttled until metadata changes or a later retry',async()=>{
  let value='["old"]',clock=0;
  const storage={getItem:()=>value,setItem:(_,next)=>value=next};
  const state={sessions:[session('active','p',2),session('old','q',1)],activeId:'active',deviceId:'local',paused:false};
  let calls=0;
  const preloader=new HistoryPreloader({storage,getState:()=>state,isCached:()=>false,now:()=>clock,load:async()=>{calls++;throw new Error('offline');}});
  preloader.visit('active');clearTimeout(preloader.timer);preloader.timer=null;
  assert.deepEqual(JSON.parse(value),['active','old']);
  await preloader.run();await preloader.run();assert.equal(calls,1);
  state.sessions[1].historyVersion='v2';await preloader.run();assert.equal(calls,2);
  clock=16000;await preloader.run();assert.equal(calls,3);
  const restored=new HistoryPreloader({storage,getState:()=>state});assert.deepEqual(restored.visited,['active','old']);
});
