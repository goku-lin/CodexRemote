import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeliveryStore,persistentToken} from '../src/reliability.mjs';
import {Drafts,LiveConnection} from '../public/reliability.js';
import {supervise} from '../src/supervisor.mjs';

function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-reliability-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});return dir;}

test('draft text, images and the original send ID survive reload and conversation switching',()=>{
  const data=new Map();const storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const drafts=new Drafts(storage);
  drafts.set('first',{text:'手机消息😀',attachments:[{id:'image',url:'/api/uploads/image'}],pending:{id:'original-id',state:'unknown'}});
  drafts.set('second',{text:'another',attachments:[]});
  const reloaded=new Drafts(storage);
  assert.equal(reloaded.get('first').text,'手机消息😀');assert.equal(reloaded.get('first').attachments[0].id,'image');assert.equal(reloaded.get('first').pending.id,'original-id');
  reloaded.clearPending('first');assert.equal(new Drafts(storage).get('first').text,'手机消息😀');assert.equal(reloaded.get('second').text,'another');
});

test('heartbeat does not redraw, stale streams recover, offline closes, old streams cannot update',()=>{
  let time=1;const streams=[],events=[],statuses=[];
  const connection=new LiveConnection({now:()=>time,onStatus:value=>statuses.push(value),onEvent:(...value)=>events.push(value),createStream:()=>{const handlers={};const stream={handlers,addEventListener:(key,fn)=>handlers[key]=fn,close(){this.closed=true;}};streams.push(stream);return stream;}});
  connection.connect();streams[0].onopen();time=20_000;streams[0].handlers.heartbeat();connection.check();assert.equal(streams.length,1);assert.equal(events.length,0);
  time=60_000;connection.check();assert.equal(streams.length,2);assert.ok(streams[0].closed);
  streams[0].handlers.session({data:'{}'});assert.equal(events.length,0);
  streams[1].handlers.snapshot({data:'{"sessions":[]}'});assert.equal(events.length,1);
  connection.offline();assert.ok(streams[1].closed);assert.equal(statuses.at(-1),'offline');connection.connect();assert.equal(streams.length,3);
});

test('revoked access closes the stream and prevents foreground or stale reconnect loops',()=>{
  const streams=[],events=[],statuses=[];
  const connection=new LiveConnection({onStatus:value=>statuses.push(value),onEvent:(...value)=>events.push(value),createStream:()=>{
    const handlers={};const stream={handlers,addEventListener:(key,fn)=>handlers[key]=fn,close(){this.closed=true;}};streams.push(stream);return stream;
  }});
  connection.connect();streams[0].handlers.access_revoked({data:'{"message":"revoked"}'});
  assert.ok(streams[0].closed);assert.equal(statuses.at(-1),'unauthorized');
  connection.connect();connection.check();assert.equal(streams.length,1);
  streams[0].handlers.session({data:'{}'});assert.deepEqual(events,[['access_revoked',{message:'revoked'}]]);
  connection.blocked=false;connection.connect();assert.equal(streams.length,2);
});

test('returning to the foreground reuses a live connection and coalesces overlapping resume events',()=>{
  let time=1,reconciles=0;const streams=[],statuses=[],events=[];
  const connection=new LiveConnection({now:()=>time,onStatus:value=>statuses.push(value),onEvent:(...value)=>events.push(value),onReconnect:()=>reconciles++,createStream:()=>{
    const handlers={};const stream={handlers,readyState:0,addEventListener:(key,fn)=>handlers[key]=fn,close(){this.closed=true;this.readyState=2;}};streams.push(stream);return stream;
  }});
  assert.equal(connection.resume(),true);
  assert.equal(connection.resume(),false,'pageshow reuses the visibilitychange handshake');
  streams[0].readyState=1;streams[0].onopen();
  streams[0].handlers.snapshot({data:'{"sessions":[]}'});
  time=10_000;
  for(let i=0;i<6;i++)assert.equal(connection.resume(),false);
  assert.equal(streams.length,1);assert.equal(streams[0].closed,undefined);
  assert.deepEqual(statuses,['connecting','connected']);assert.equal(reconciles,1);
  streams[0].handlers.session({data:'{"id":"continued"}'});
  assert.equal(events.at(-1)[1].id,'continued','the existing stream still delivers updates');
  time=30_000;streams[0].handlers.heartbeat();time=40_000;
  assert.equal(connection.resume(),false,'background duration alone does not replace a stream receiving heartbeats');
  time=66_000;assert.equal(connection.resume(),true,'a silent connection is recovered');
  assert.equal(streams[0].closed,true);assert.equal(streams.length,2);
  assert.equal(connection.resume(),false,'the replacement is not restarted by a second foreground event');
  streams[1].onerror();assert.equal(connection.resume(),true,'a known failed connection reconnects immediately');
  assert.equal(streams.length,3);
  streams[2].readyState=2;assert.equal(connection.resume(),true,'a browser-closed stream is recreated');
  connection.offline();assert.equal(connection.resume(),true,'an online event restores the offline connection');
  connection.block();const count=streams.length;assert.equal(connection.resume(),false);assert.equal(streams.length,count);
});

test('accepted delivery IDs survive restart; interrupted dispatch is not replayed',t=>{
  const dir=directory(t);const store=new DeliveryStore(dir);const session={id:'session',deviceId:'local',threadId:'thread',status:'running',events:[],liveItems:new Map([['item',{text:'partial'}]]),liveNotices:new Map(),liveTurn:{id:'live'}};
  const body={text:'hello'};const check=store.check('0123456789abcdef','turn:session',body);
  store.add(check,session,{queued:true},{type:'startTurn',deliveryId:check.id});
  assert.equal(Object.hasOwn(store.data.sessions.session,'liveItems'),false);
  assert.equal(Object.hasOwn(store.data.sessions.session,'liveTurn'),false);
  store.update(check.id,'dispatched');
  const restarted=new DeliveryStore(dir);assert.equal(restarted.get(check.id).state,'uncertain');assert.equal(restarted.queued().length,0);
  assert.ok(restarted.check(check.id,'turn:session',body).old);assert.throws(()=>restarted.check(check.id,'turn:other',body));assert.throws(()=>restarted.check(check.id,'turn:session',{text:'different'}));
  restarted.update(check.id,'accepted');assert.equal(new DeliveryStore(dir).get(check.id).state,'accepted');
});

test('undispatched work survives restart and Runner authentication remains stable',t=>{
  const dir=directory(t);const store=new DeliveryStore(dir);const session={id:'session',deviceId:'local',events:[]};
  const check=store.check('fedcba9876543210','create',{prompt:'hello'});store.add(check,session,{session},{type:'startThread'});
  assert.equal(new DeliveryStore(dir).queued().length,1);assert.equal(persistentToken(dir),persistentToken(dir));
});

test('supervisor recovers from an actual child exit and stops without relaunching',{timeout:5000},async t=>{
  const dir=directory(t);const marker=path.join(dir,'starts');const script=path.join(dir,'child.mjs');
  fs.writeFileSync(script,"import fs from 'node:fs';const file=process.argv[2];const count=Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1;fs.writeFileSync(file,String(count));if(count===1)process.exit(1);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
  let ready;const restarted=new Promise(resolve=>ready=resolve);let starts=0;
  const service=supervise(process.execPath,[script,marker],{stdio:['pipe','ignore','ignore'],windowsHide:true},{minDelay:20,onState:value=>{if(value.state==='starting' && ++starts===2)ready();}});
  t.after(()=>service.stop());await restarted;const child=service.child;const exited=new Promise(resolve=>child.once('exit',resolve));service.stop();await exited;assert.equal(starts,2);
});
