import test from 'node:test';
import assert from 'node:assert/strict';
import {ThreadOwnership,creationMode,usesDesktop} from '../src/thread-ownership.mjs';
import {setupThreadOwnership} from '../public/thread-ownership.js';

test('new threads default to the shared Desktop and never silently fall back when disconnected or on an older proxy',()=>{
  assert.throws(()=>creationMode({},{}),/尚未创建/);
  assert.throws(()=>creationMode({},{nativeDesktop:{connected:true,capabilities:{}}}),/双端新建/);
  assert.throws(()=>creationMode({},{nativeDesktop:{connected:true,capabilities:{createThreads:true}}}),/尚未加载/);
  assert.equal(creationMode({},{desktopThreadCreateRevision:1,nativeDesktop:{connected:true,capabilities:{createThreads:true}}}),'desktop');
  assert.equal(creationMode({executionMode:'runner'},{}),'runner');
  assert.throws(()=>creationMode({executionMode:'auto'},{}),/未知/);
  assert.equal(usesDesktop({source:'imported'}),true);
  assert.equal(usesDesktop({source:'imported',executionOwner:'runner'}),false);
  assert.equal(usesDesktop({executionMode:'desktop',executionOwner:'external'}),true);
});

function fixture(){
  const calls=[],state={pid:10,generation:'first',ids:['target','other'],active:false,pending:false,status:'idle',goal:null,resets:0};
  const ownership=new ThreadOwnership({
    identity:()=>({pid:state.pid,generation:state.generation}),active:()=>state.active,pendingMutation:()=>state.pending,
    native:{refreshConnection:async()=>{},request:async()=>({thread:{id:'target',status:{type:'notLoaded'}}})},
    rpc:async(method,params)=>{calls.push({method,params});return method==='thread/loaded/list'?{data:state.ids}:method==='thread/goal/get'?{goal:state.goal}:{thread:{id:params.threadId,status:{type:params.threadId==='other'?state.status:'idle'}}};},
    reset:async()=>{state.resets++;state.pid++;state.generation='next';}
  });
  return {state,calls,ownership};
}
test('ownership diagnostics are read only and cannot claim to own another Desktop or CLI thread',async()=>{
  const {state,calls,ownership}=fixture();
  assert.equal((await ownership.read('target')).owner,'runner');
  state.ids=[];assert.equal((await ownership.read('target')).owner,'unknown');
  assert.ok(calls.every(call=>['thread/loaded/list','thread/read'].includes(call.method)));
  assert.equal(state.resets,0);
});
test('release verifies every loaded thread, goals, pending mutations and process identity before touching its own idle worker',async()=>{
  const {state,ownership}=fixture(),expected={pid:10,generation:'first'};
  state.status='active';await assert.rejects(ownership.release('target',expected),/仍有任务/);
  state.status='unknown';await assert.rejects(ownership.release('target',expected),/状态未确认/);
  state.status='idle';state.goal={status:'active'};await assert.rejects(ownership.release('target',expected),/进行中的目标/);
  state.goal=null;state.pending=true;await assert.rejects(ownership.release('target',expected),/刚收到任务/);
  state.pending=false;state.active=true;await assert.rejects(ownership.release('target',expected),/刚收到任务/);
  state.active=false;assert.equal(state.resets,0);
  const result=await ownership.release('target',expected);assert.equal(result.released,true);assert.equal(state.resets,1);
  await assert.rejects(ownership.release('target',expected),/执行器已变化/);assert.equal(state.resets,1);
});
test('release refuses foreign ownership and malformed occupancy responses',async()=>{
  const {state,ownership}=fixture();state.ids=['other'];
  await assert.rejects(ownership.release('target',{pid:10,generation:'first'}),/未持有/);assert.equal(state.resets,0);
  ownership.rpc=async()=>({});await assert.rejects(ownership.read('target'),/可靠的占用列表/);
});

test('ownership UI requires a fresh diagnosis, explicit confirmation and the same conversation before releasing',async t=>{
  const previous=globalThis.document,nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,textContent:'',addEventListener(name,handler){this[name]=handler;}});return nodes.get(id);};
  globalThis.document={getElementById:get};t.after(()=>globalThis.document=previous);
  let current={id:'first',threadId:'thread'},allow=false;const calls=[];
  setupThreadOwnership({session:()=>current,confirm:()=>allow,api:async(url,options)=>{calls.push({url,options});return options ? {message:'已释放'} : {pid:10,generation:'one',owner:'runner',canRelease:true};}});
  await get('ownershipReleaseBtn').onclick();assert.equal(calls.length,0);
  await get('ownershipCheckBtn').onclick();assert.equal(get('ownershipReleaseBtn').hidden,false);
  await get('ownershipReleaseBtn').onclick();assert.equal(calls.length,1);
  allow=true;current={id:'other',threadId:'different'};
  await get('ownershipReleaseBtn').onclick();assert.equal(calls.length,1);assert.equal(get('ownershipReleaseBtn').hidden,true);
  await get('ownershipCheckBtn').onclick();await get('ownershipReleaseBtn').onclick();
  assert.equal(calls.at(-1).url,'/api/sessions/other/ownership');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{confirm:true,expected:{pid:10,generation:'one'}});
  assert.equal(get('ownershipResult').textContent,'已释放');assert.equal(get('ownershipReleaseBtn').hidden,true);
});
