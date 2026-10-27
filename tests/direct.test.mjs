import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {RTCPeerConnection} from 'werift';
import {DeviceGateway,executionPath} from '../src/device-gateway.mjs';
import {ConnectorPeers} from '../src/connector-node.mjs';
import {PeerWire} from '../public/peer-wire.js';
import {DirectConnections,requestDevice} from '../public/direct-connection.js';

test('execution channels deny administrative APIs, absolute URLs and encoded traversal',()=>{
  for(const value of ['/api/connectors/code','/api/access/devices','/api/runner/local/events','/api/health/recover','https://evil.test/api/sessions','//evil.test/api/sessions','/api/sessions/%2e%2e/turns','/api/devices/a/catalog/../../connectors/code'])assert.equal(executionPath(value,'POST'),false,value);
  assert.equal(executionPath('/api/sessions/abc/turns','POST'),true);
  assert.equal(executionPath('/api/sessions/abc/queued/def/send','POST'),true);
  assert.equal(executionPath('/api/devices/pc-x/uploads/'+crypto.randomUUID()),true);
});
test('gateway replies are device-bound, timed out requests are never retried',async()=>{
  const sent=[],gateway=new DeviceGateway({send:(id,command)=>sent.push({id,command}),timeout:30});
  const result=gateway.call('one','http',{request:{path:'/api/projects'}});
  assert.equal(gateway.reply('two',{requestId:sent[0].command.requestId,result:{bad:true}}),false);
  gateway.reply('one',{requestId:sent[0].command.requestId,result:{ok:true}});assert.deepEqual(await result,{ok:true});
  await assert.rejects(gateway.call('one','http'),/超时/);assert.equal(sent.length,2);gateway.close();
});
test('fragmentation preserves large Unicode payloads and bounds malformed/unfinished messages',async()=>{
  const frames=[],value={text:'手机🌍\n'.repeat(20_000)},received=[];
  const sender=new PeerWire({send:text=>frames.push(text)}),receiver=new PeerWire({send:()=>{},onMessage:item=>received.push(item)});
  await sender.write(value);for(const frame of frames.reverse())receiver.read(frame);assert.deepEqual(received,[value]);
  receiver.read(JSON.stringify({id:'bad',i:0,count:9,text:'pending'}));receiver.read('invalid');assert.equal(receiver.buffered,0);
});
test('routing selects the session owner and original receipt owner, not the current computer',()=>{
  const context={sessions:[{id:'old',deviceId:'laptop'}],selectedDeviceId:'desktop',receiptDevices:new Map([['request1234567890','laptop']])};
  assert.equal(requestDevice('/api/sessions/old/turns',{},context),'laptop');
  assert.equal(requestDevice('/api/deliveries/request1234567890',{},context),'laptop');
  assert.equal(requestDevice('/api/devices/laptop/direct',{},context),null);
  assert.equal(requestDevice('/api/projects',{},context),null);
});
test('a closed direct channel rejects dispatched writes without a relay replay',async()=>{
  const changes=[],calls=[];const manager=new DirectConnections({signal:async(...args)=>calls.push(args),onChange:(...args)=>changes.push(args)});
  const channel={readyState:'open',send:()=>{},bufferedAmount:0},peer={channel,pc:{close(){}},pending:new Map()};
  peer.wire=new PeerWire({send:text=>channel.send(text)});manager.peers.set('laptop',peer);
  const request=manager.request('laptop','/api/sessions/old/turns',{method:'POST',body:'{}'});
  manager.drop('laptop');await assert.rejects(request,/发送结果待核对/);assert.equal(calls.length,0);assert.equal(manager.ready('laptop'),false);
});
test('real encrypted RTC carries execution reads, large responses and denies admin calls; lease closes it',async t=>{
  const deviceId='pc-'+crypto.randomUUID(),payload={devices:[{id:deviceId}],sessions:[],projects:[],text:'直连🌍'.repeat(20_000)};
  const local=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));});
  await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
  const peers=new ConnectorPeers({base:'http://127.0.0.1:'+local.address().port,deviceId});
  const browser=new RTCPeerConnection({iceServers:[],iceUseIpv6:false}),channel=browser.createDataChannel('codex-relay'),messages=[];
  const wire=new PeerWire({send:text=>channel.send(text),onMessage:message=>messages.push(message)});
  channel.onMessage.subscribe(data=>wire.read(String(data)));
  t.after(async()=>{peers.stop();await browser.close();await new Promise(resolve=>local.close(resolve));});
  await browser.setLocalDescription(await browser.createOffer());
  const peerId=crypto.randomUUID(),answer=await peers.offer({peerId,offer:browser.localDescription});
  await browser.setRemoteDescription(answer.answer);
  await channel.stateChanged.watch(state=>state==='open',12_000);
  peers.lease(peerId);
  const id=crypto.randomUUID();await wire.write({kind:'request',id,path:'/api/projects',method:'GET'});
  for(let i=0;i<200 && !messages.some(value=>value.id===id);i++)await new Promise(resolve=>setTimeout(resolve,20));
  const reply=messages.find(value=>value.id===id);assert.ok(reply,'real RTC response');assert.deepEqual(JSON.parse(Buffer.from(reply.result.body,'base64')),payload);
  const denied=crypto.randomUUID();await wire.write({kind:'request',id:denied,path:'/api/connectors/code',method:'POST'});
  for(let i=0;i<50 && !messages.some(value=>value.id===denied);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.match(messages.find(value=>value.id===denied)?.error,/不允许/);
  peers.peers.get(peerId).expiresAt=0;
  await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(peers.peers.size,0);
});
