import test from 'node:test';
import assert from 'node:assert/strict';
import {GoalStrip,goalElapsed} from '../public/goal-strip.js';

function fixture(t,api){
  const saved=globalThis.document,nodes=new Map();
  const node=id=>{if(!nodes.has(id)){const classes=new Set(['hidden']);nodes.set(id,{textContent:'',open:false,classList:{contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}});}return nodes.get(id);};
  globalThis.document={hidden:false,getElementById:node,addEventListener(){}};
  let current={id:'one',threadId:'native-one'},enabled=true,opened=0;const received=[];
  const strip=new GoalStrip({api,session:()=>current,enabled:()=>enabled,open:()=>opened++,onData:(id,data)=>received.push({id,data})});
  t.after(()=>{clearTimeout(strip.timer);globalThis.document=saved;});
  return {strip,node,received,opened:()=>opened,switchSession:id=>current={id,threadId:'native-'+id},enabled:value=>enabled=value};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('goal strip shows native elapsed time, full objective on disclosure and no writes',async t=>{
  const calls=[],goal={objective:'Goal <safe>\nContinue migration',status:'active',tokensUsed:1234,timeUsedSeconds:47909};
  const {strip,node,opened}=fixture(t,async(url,options)=>{calls.push({url,options});return {goal,canControl:true};});
  strip.render();await settle();
  assert.equal(node('goalStrip').classList.contains('hidden'),false);assert.equal(node('goalStrip').open,false);
  assert.equal(node('goalStripTime').textContent,'13 小时 18 分 29 秒');
  assert.equal(node('goalStripDetail').textContent,goal.objective);
  for(let i=0;i<20;i++)strip.render();assert.equal(calls.length,1,'ordinary UI renders cannot poll repeatedly');
  assert.ok(calls.every(call=>!call.options));node('goalStripManage').onclick();assert.equal(opened(),1);
});

test('long goals show a short single-line preview while keeping the complete objective in disclosure',async t=>{
  const objective='完成核心模块迁移。\n'+ '继续核对调用方与测试覆盖，保留当前行为。'.repeat(10);
  const {strip,node}=fixture(t,async()=>({goal:{objective,status:'active',timeUsedSeconds:1}}));
  strip.render();await settle();
  assert.equal(Array.from(node('goalStripObjective').textContent).length,33);
  assert.ok(node('goalStripObjective').textContent.endsWith('…'));
  assert.doesNotMatch(node('goalStripObjective').textContent,/\n/);
  assert.equal(node('goalStripDetail').textContent,objective);
});

test('switching conversations immediately hides old goal and rejects its delayed response',async t=>{
  const pending=new Map();const {strip,node,switchSession,received}=fixture(t,url=>new Promise(resolve=>pending.set(url,resolve)));
  strip.render();node('goalStrip').open=true;switchSession('two');strip.render();
  assert.equal(node('goalStrip').open,false);assert.equal(node('goalStrip').classList.contains('hidden'),true);
  pending.get('/api/sessions/one/goal')({goal:{objective:'Wrong conversation',status:'active'}});await settle();
  assert.equal(received.length,0);assert.equal(node('goalStripObjective').textContent,'');
  pending.get('/api/sessions/two/goal')({goal:{objective:'Current conversation',status:'paused',timeUsedSeconds:3}});await settle();
  assert.equal(node('goalStripObjective').textContent,'Current conversation');assert.match(node('goalStripStatus').textContent,/已暂停/);
});

test('hidden pages and an open goal editor suppress polling; a removed goal clears the strip',async t=>{
  let calls=0,goal={objective:'Existing',status:'active',timeUsedSeconds:1};
  const {strip,node,enabled}=fixture(t,async()=>{calls++;return {goal,canControl:false};});
  document.hidden=true;strip.render();await settle();assert.equal(calls,0);
  document.hidden=false;enabled(false);strip.render();await settle();assert.equal(calls,0);
  enabled(true);strip.render();await settle();assert.equal(calls,1);
  goal=null;strip.nextRead=0;strip.render();await settle();
  assert.equal(calls,2);assert.equal(node('goalStrip').classList.contains('hidden'),true);assert.equal(node('goalStripTime').textContent,'');
});

test('missing or invalid goal durations stay unknown rather than borrowing chat time',()=>{
  for(const value of [undefined,null,'120',NaN,-1,Infinity])assert.equal(goalElapsed(value),'用时未知');
  assert.equal(goalElapsed(0),'0 秒');assert.equal(goalElapsed(62),'1 分 2 秒');
});

test('an old background read cannot overwrite a newer goal editor result',async t=>{
  let release;const {strip,node}=fixture(t,()=>new Promise(resolve=>release=resolve));
  strip.render();strip.accept('one',{goal:{objective:'Edited objective',status:'paused',timeUsedSeconds:12}});
  release({goal:{objective:'Before edit',status:'active',timeUsedSeconds:10}});await settle();
  assert.equal(node('goalStripObjective').textContent,'Edited objective');assert.equal(node('goalStripTime').textContent,'12 秒');
});
