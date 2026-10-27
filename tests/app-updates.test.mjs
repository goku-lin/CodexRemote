import test from 'node:test';
import assert from 'node:assert/strict';
import {AppUpdates} from '../public/app-updates.js';

function fixture(options={}){
  const worker=new EventTarget(),registration=new EventTarget(),states=[],actions=[];
  Object.assign(registration,{active:{},waiting:null,installing:null,update:async()=>{actions.push('check');}});
  Object.assign(worker,{controller:{},register:async(url,settings)=>{actions.push('register');assert.equal(url,'/notification-worker.js');assert.equal(settings.updateViaCache,'none');return registration;}});
  const updates=new AppUpdates({worker,saveDraft:()=>actions.push('save'),reload:()=>actions.push('reload'),onState:s=>states.push(s),...options});
  return {worker,registration,updates,states,actions};
}

test('a waiting app update is advertised without refreshing or activating until requested, and saves draft first',async()=>{
  const f=fixture();f.registration.waiting={postMessage:message=>{assert.deepEqual(message,{type:'activate_app_update'});f.actions.push('activate');f.worker.dispatchEvent(new Event('controllerchange'));}};
  await f.updates.start();assert.equal(f.updates.state,'available');assert.deepEqual(f.actions,['register']);
  f.updates.apply();assert.deepEqual(f.actions,['register','save','activate','reload']);
  f.worker.dispatchEvent(new Event('controllerchange'));assert.equal(f.actions.filter(a=>a==='reload').length,1);
});

test('explicit checks wait for shell download before advertising the new page and never auto-refresh',async()=>{
  const f=fixture();f.registration.update=async()=>{
    f.actions.push('check');const installing=new EventTarget();installing.state='installing';f.registration.installing=installing;
    f.registration.dispatchEvent(new Event('updatefound'));
    setImmediate(()=>{f.registration.waiting={postMessage(){}};installing.state='installed';installing.dispatchEvent(new Event('statechange'));});
  };
  await f.updates.check();assert.equal(f.updates.state,'available');assert.deepEqual(f.actions,['register','check']);assert.ok(f.states.some(s=>s.state==='checking'));
});

test('failed checks and failed installs never claim the app is current',async()=>{
  for(const failing of [async()=>{throw new Error('offline');},async function(){this.installing={state:'redundant'};}]){
    const f=fixture();f.registration.update=failing;await f.updates.check();assert.equal(f.updates.state,'error');assert.ok(!f.states.some(s=>s.state==='current'));assert.ok(!f.actions.includes('reload'));
  }
});

test('concurrent checks share one update request and automatic resume checks are throttled',async()=>{
  const f=fixture();let finish;f.registration.update=()=>{f.actions.push('check');return new Promise(r=>finish=r);};
  const first=f.updates.check(),second=f.updates.check();await new Promise(setImmediate);finish();await Promise.all([first,second]);
  assert.equal(f.updates.state,'current');assert.equal(f.actions.filter(a=>a==='check').length,1);
  await f.updates.check({automatic:true});assert.equal(f.actions.filter(a=>a==='check').length,1);
});

test('offline checks preserve the current app and a draft save failure prevents activation',async()=>{
  const offline=fixture({online:()=>false});await offline.updates.check();assert.equal(offline.updates.state,'offline');assert.deepEqual(offline.actions,[]);
  const f=fixture({saveDraft:()=>{throw new Error('storage failed');}});f.registration.waiting={postMessage:()=>f.actions.push('activate')};await f.updates.start();f.updates.apply();assert.equal(f.updates.state,'error');assert.deepEqual(f.actions,['register']);
});

test('browsers without an application worker get an explicit save-and-refresh action',async()=>{
  const f=fixture({worker:null});await f.updates.start();assert.equal(f.updates.state,'unsupported');f.updates.apply();assert.deepEqual(f.actions,['save','reload']);
});

test('an update activated by another window offers a refresh instead of claiming this old page is current',async()=>{
  const f=fixture();await f.updates.start();f.worker.dispatchEvent(new Event('controllerchange'));
  assert.equal(f.updates.state,'available');assert.ok(!f.actions.includes('reload'));
  await f.updates.check();assert.equal(f.updates.state,'available');f.updates.apply();assert.deepEqual(f.actions.slice(-2),['save','reload']);
});

test('an unresponsive update check times out and leaves the current app available',async()=>{
  const f=fixture({timeout:10});f.registration.update=()=>new Promise(()=>{});
  await f.updates.check();assert.equal(f.updates.state,'error');assert.ok(!f.actions.includes('reload'));assert.equal(f.updates.checking,null);
});
