import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {EventBuffer} from '../src/event-buffer.mjs';
import {SseWriter} from '../src/sse-writer.mjs';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const event=(sequence,method='item/agentMessage/delta',params={})=>({sequence,at:sequence,message:{method,params:{threadId:'t',itemId:'a',delta:String(sequence)+',',...params}}});

test('coalesced output stays within the server delta budget without losing text',()=>{
  const buffer=new EventBuffer();
  for(let n=1;n<=100;n++)buffer.push(event(n,'item/agentMessage/delta',{delta:'x'.repeat(1000)}));
  const batch=buffer.take();
  assert.equal(batch.reduce((sum,value)=>sum+value.message.params.delta.length,0),100000);
  assert.ok(batch.every(value=>value.message.params.delta.length<=12000));
});

test('a rejected runner write keeps all unsent commands, and recovery never repeats an accepted command',async()=>{
  const source=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
  const stream={id:'old'},runnerStreams=new Map([['local',stream]]),runnerQueues=new Map([['local',[{id:1,deliveryId:'one'},{id:2,deliveryId:'two'},{id:3,deliveryId:'three'}]]]);
  const received=[],dispatched=[];
  const context=vm.createContext({runnerStreams,runnerQueues,deliveries:{update:id=>dispatched.push(id)},writeSse:(res,event,command)=>{
    if(res===stream && command.id===2){res.destroyed=true;return false;}
    received.push(command.id);return true;
  }});
  vm.runInContext(source.slice(source.indexOf('function queueCommand('),source.indexOf('function findSession(')),context);
  context.flushQueue('local',stream);
  assert.deepEqual(received,[1]);assert.deepEqual(Array.from(runnerQueues.get('local'),value=>value.id),[2,3]);assert.deepEqual(dispatched,['one']);
  runnerStreams.set('local',{});context.flushQueue('local',runnerStreams.get('local'));
  assert.deepEqual(received,[1,2,3]);assert.equal(runnerQueues.get('local').length,0);assert.deepEqual(dispatched,['one','two','three']);
});
test('adjacent unsent deltas merge, but item and lifecycle boundaries preserve order',()=>{
  const buffer=new EventBuffer();buffer.push(event(1));buffer.push(event(2));buffer.push(event(3,'turn/completed'));buffer.push(event(4));
  const batch=buffer.take();assert.equal(batch.length,3);assert.equal(batch[0].message.params.delta,'1,2,');assert.deepEqual(batch.map(value=>value.sequence),[2,3,4]);
});
test('an uncertain HTTP batch is immutable and an acknowledgement cannot consume newer events',()=>{
  const buffer=new EventBuffer();buffer.push(event(1));const sent=buffer.take(),original=JSON.stringify(sent);buffer.push(event(2));
  assert.equal(JSON.stringify(buffer.take(1)),original);buffer.ack(sent);assert.equal(buffer.take()[0].message.params.delta,'2,');
});
test('a sustained outage remains bounded and keeps pending requests before reconstructible output',()=>{
  const buffer=new EventBuffer({maxEvents:30,maxBytes:20000,maxDeltaBytes:200});
  buffer.push(event(1,'item/tool/requestUserInput',{itemId:'question',questions:[{id:'q',question:'选择'}]}));
  for(let n=2;n<20000;n++)buffer.push(event(n,'item/agentMessage/delta',{itemId:'output-'+n,delta:'中'.repeat(100)}));
  assert.ok(buffer.length<=30);assert.ok(buffer.bytes<=20000);assert.equal(buffer.take()[0].message.method,'item/tool/requestUserInput');
  const gap=buffer.takeGap();assert.ok(gap.dropped>19000);assert.deepEqual(gap.threadIds,['t']);assert.ok(gap.items.length<=2000);assert.equal(buffer.takeGap(),null);
});
test('oversized events cannot bypass byte limits and an in-flight batch is not evicted',()=>{
  const buffer=new EventBuffer({maxEvents:2,maxBytes:1500});buffer.push(event(1));const batch=buffer.take();
  buffer.push(event(2,'item/started',{itemId:'b'}));buffer.push(event(3,'item/started',{itemId:'c'}));buffer.push(event(4,'item/completed',{text:'x'.repeat(10000)}));
  assert.ok(buffer.bytes<=1500);assert.ok(buffer.take().some(value=>value.sequence===1));buffer.ack(batch);assert.ok(!buffer.take().some(value=>value.sequence===1));assert.ok(buffer.dropped>=2);
});
class Peer extends EventEmitter{
  constructor(slow=false){super();this.slow=slow;this.writableLength=0;this.frames=[];}
  write(frame){this.frames.push(frame);if(this.slow)this.writableLength+=Buffer.byteLength(frame);return !this.slow;}
  destroy(){this.destroyed=true;this.emit('close');}
}
test('a slow browser is disconnected before unbounded growth; fast browsers continue in order',()=>{
  const writer=new SseWriter({maxBytes:4000}),slow=new Peer(true),fast=new Peer();
  for(let n=0;n<500;n++){writer.send(slow,'relay',{n,text:'x'.repeat(300)});writer.send(fast,'relay',{n});}
  assert.equal(slow.destroyed,true);assert.ok(slow.writableLength<=4000);assert.equal(fast.frames.length,500);assert.match(fast.frames.at(-1),/499/);
});
test('false writes are accepted exactly once and drain clears the disconnect deadline',async()=>{
  const writer=new SseWriter({drainMs:10}),peer=new Peer(true);assert.equal(writer.send(peer,'command',{id:'once'}),true);assert.equal(peer.frames.length,1);
  peer.writableLength=0;peer.emit('drain');await new Promise(resolve=>setTimeout(resolve,25));assert.ok(!peer.destroyed);
  const stalled=new Peer(true);writer.send(stalled,'relay',{});await new Promise(resolve=>setTimeout(resolve,25));assert.equal(stalled.destroyed,true);
});
