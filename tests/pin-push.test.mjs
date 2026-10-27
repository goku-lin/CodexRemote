import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {setSessionPinned,sessionPin} from '../src/session-pins.mjs';
import {searchSessions} from '../public/session-search.js';
import {BackgroundNotifications,pushSubscription} from '../src/background-notifications.mjs';
import {backgroundSupport} from '../public/background-notices.js';
import {createMediaFixture} from './media-fixture.mjs';

const subscription=(id='fixture')=>{const key=crypto.createECDH('prime256v1');key.generateKeys();return {endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};};
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-pin-push-'));t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));return fs.rm(dir,{recursive:true,force:true});});return dir;}
async function idle(push){for(let i=0;i<20&&(push.queue.length||push.running);i++)await new Promise(setImmediate);assert.equal(push.running,0);}

test('pins keep first-pin order despite activity and unpinning restores normal recency order',()=>{
  const preferences={},sessions=[{id:'old',updatedAt:1},{id:'new',updatedAt:30},{id:'middle',updatedAt:20}];
  setSessionPinned(preferences,'old',true);setSessionPinned(preferences,'middle',true);setSessionPinned(preferences,'old',true);
  const ordered=()=>searchSessions(sessions.map(s=>({...s,...sessionPin(preferences,s.id)}))).map(s=>s.id);
  assert.deepEqual(ordered(),['old','middle','new']);sessions[2].updatedAt=100;assert.deepEqual(ordered(),['old','middle','new']);
  setSessionPinned(preferences,'old',false);assert.deepEqual(ordered(),['middle','new','old']);assert.throws(()=>setSessionPinned(preferences,'old','true'));
});

test('pin API shares persisted positions and push APIs reject unpaired callers and hide private keys',{timeout:15000},async t=>{
  const dir=await directory(t);
  const fixture=await createMediaFixture({directory:dir,files:[]});t.after(()=>fixture.close());
  const id=fixture.session.id,remote={host:'other-host.test','x-forwarded-proto':'https','content-type':'application/json'};
  assert.notEqual((await fetch(fixture.base+'/api/notifications/push',{headers:remote})).status,200);
  const pin=await fetch(fixture.base+'/api/sessions/'+id+'/pin',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({pinned:true})}).then(r=>r.json());assert.equal(pin.session.pinned,true);
  assert.equal((await fetch(fixture.base+'/api/sessions').then(r=>r.json())).sessions[0].pinned,true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'data','preferences.json'),'utf8')).pinnedSessions,[id]);
  const config=await fetch(fixture.base+'/api/notifications/push').then(r=>r.json());assert.equal(config.revision,1);assert.equal(config.privateKey,undefined);
  const sub=subscription(),request=(endpoint,method,body)=>fetch(fixture.base+endpoint,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  assert.equal((await request('/api/notifications/push','POST',{subscription:sub})).enabled,true);
  assert.equal((await request('/api/notifications/push/status','POST',{endpoint:sub.endpoint})).enabled,true);
  assert.equal((await request('/api/notifications/push','DELETE',{endpoint:sub.endpoint})).enabled,false);
});

test('push subscriptions validate provider and encryption keys instead of accepting arbitrary request destinations',()=>{
  const good=subscription();assert.equal(pushSubscription(good).endpoint,good.endpoint);
  for(const endpoint of ['https://127.0.0.1/admin','https://intranet.local/','http://fcm.googleapis.com/test','https://fcm.googleapis.com.evil.test/a','https://user:password@fcm.googleapis.com/a'])assert.throws(()=>pushSubscription({...good,endpoint}));
  assert.throws(()=>pushSubscription({...good,keys:{auth:'bad',p256dh:'bad'}}));
});

test('completion, questions and interruptions notify once, never on user sends or replayed history',async t=>{
  const sent=[],push=new BackgroundNotifications({directory:await directory(t),send:async(s,payload)=>sent.push(JSON.parse(payload))});
  const sub=subscription();push.subscribe('owner',Date.now()+60000,sub);
  const session={id:'one',status:'running',activeTurnId:'t1',pendingAttention:[]};push.observe([session]);push.observe([{...session,events:[{type:'user_message',text:'secret input'}]}]);assert.equal(sent.length,0);
  push.observe([{...session,status:'done',completionToken:'t1',title:'private title',events:[{text:'private answer'}]}]);await idle(push);assert.equal(sent.length,1);assert.equal(sent[0].kind,'done');assert.doesNotMatch(JSON.stringify(sent),/private|secret/);
  push.observe([{...session,status:'done',completionToken:'t1'}]);await idle(push);assert.equal(sent.length,1);
  const resumed=new BackgroundNotifications({directory:path.dirname(push.file),send:async(s,p)=>sent.push(JSON.parse(p))});resumed.observe([{...session,status:'done',completionToken:'t1'}]);assert.equal(sent.length,1);
  resumed.observe([{...session,status:'waiting_input',activeTurnId:'t2',pendingAttention:[{id:'question',kind:'question',turnId:'t2'}]}]);await idle(resumed);assert.equal(sent.at(-1).kind,'question');
  resumed.observe([{...session,activeTurnId:'t3'}]);resumed.observe([{...session,status:'interrupted',activeTurnId:'t3',updatedAt:3}]);await idle(resumed);assert.equal(sent.at(-1).kind,'interrupted');
});

test('expired authorizations, unsubscribe and provider-gone responses stop delivery',async t=>{
  const dir=await directory(t),sent=[];let active=true;
  const push=new BackgroundNotifications({directory:dir,ownerActive:()=>active,send:async()=>{sent.push('send');throw Object.assign(new Error('gone'),{statusCode:410});}}),sub=subscription();
  push.subscribe('owner',Date.now()+60000,sub);const row=push.row('owner',sub.endpoint);push.enqueue(row,{kind:'test'});await idle(push);assert.equal(push.data.subscriptions.length,0);
  push.subscribe('owner',Date.now()+60000,sub);active=false;push.enqueue(push.data.subscriptions[0],{kind:'test'});await idle(push);assert.equal(sent.length,1);push.prune();assert.equal(push.data.subscriptions.length,0);
  active=true;push.subscribe('owner',Date.now()+60000,sub);push.unsubscribe('other',sub.endpoint);assert.equal(push.data.subscriptions.length,1);push.unsubscribe('owner',sub.endpoint);assert.equal(push.data.subscriptions.length,0);
});

test('a test is delayed for locking the phone, rate limited and reported as scheduled rather than delivered',async t=>{
  const sent=[],push=new BackgroundNotifications({directory:await directory(t),testDelay:1,send:async()=>sent.push('accepted')}),sub=subscription();push.subscribe('owner',Date.now()+60000,sub);
  const result=push.test('owner',sub.endpoint);assert.equal(result.scheduled,true);assert.equal(result.delivered,undefined);assert.equal(sent.length,0);assert.throws(()=>push.test('owner',sub.endpoint));
  await new Promise(resolve=>setTimeout(resolve,15));await idle(push);assert.deepEqual(sent,['accepted']);
});

test('background capability detection does not treat installing a PWA as proof of push support',()=>{
  assert.match(backgroundSupport({isSecureContext:true,navigator:{serviceWorker:{}}}),/未提供/);
  assert.match(backgroundSupport({isSecureContext:false}),/HTTPS/);
  assert.equal(backgroundSupport({isSecureContext:true,navigator:{serviceWorker:{}},Notification:{},PushManager:{}}),'');
});

test('transient push errors retry within a fixed budget without another user event',async t=>{
  let calls=0;const push=new BackgroundNotifications({directory:await directory(t),retryDelays:[1,2],send:async()=>{calls++;if(calls===1)throw Object.assign(new Error('unavailable'),{statusCode:503});}}),sub=subscription();
  push.subscribe('owner',Date.now()+60000,sub);push.enqueue(push.row('owner',sub.endpoint),{kind:'done'});
  await new Promise(resolve=>setTimeout(resolve,20));await idle(push);assert.equal(calls,2);assert.equal(push.data.subscriptions[0].error,null);
});

test('background worker displays a visible notification with a safe conversation target and no page requirement',async()=>{
  const handlers={},notifications=[];const source=await fs.readFile(new URL('../public/notification-worker.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{self:{addEventListener:(event,handler)=>handlers[event]=handler,registration:{showNotification:async(title,options)=>notifications.push({title,options})}}});
  let done;handlers.push({data:{json:()=>({title:'Codex · 任务完成',sessionId:'one',body:'点击查看'})},waitUntil:promise=>done=promise});await done;
  assert.equal(notifications.length,1);assert.equal(notifications[0].options.data.sessionId,'one');
});
