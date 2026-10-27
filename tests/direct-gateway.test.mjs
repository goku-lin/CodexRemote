import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {availablePort,consumeSse,localRequest} from '../src/connector-node.mjs';

async function server(t,env={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-direct-')),port=await availablePort();
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_TOKEN:'test-host',CODEX_RELAY_DATA_DIR:directory,...env}});
  t.after(async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout')),5000);child.on('error',reject);child.stdout.on('data',bytes=>{if(String(bytes).includes('listening')){clearTimeout(timer);resolve();}});});
  return {base:'http://127.0.0.1:'+port,directory};
}

test('hub forwarding and device-local writes share receipts; scoped images, mirror isolation and direct authorization',async t=>{
  const hub=await server(t),post=async(base,route,body,token,extra={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(token ? {'x-codex-relay-token':token} : {}),...extra},body:JSON.stringify(body)});
  const code=await (await post(hub.base,'/api/connectors/code',{})).json();
  const config=await (await post(hub.base,'/api/connector/enroll',{code:code.code,nonce:crypto.randomUUID(),name:'笔记本'})).json();
  const local=await server(t,{CODEX_RELAY_EXECUTION_NODE:'1',CODEX_RELAY_LOCAL_DEVICE_ID:config.id});
  const abort=new AbortController();t.after(()=>abort.abort());
  const localStream=consumeSse(local.base+'/api/runner/'+config.id+'/commands',{'x-codex-relay-token':'test-host'},()=>{},abort.signal).catch(()=>{});
  const commands=[];
  const bridge=consumeSse(hub.base+'/api/runner/'+config.id+'/commands?executionRelay=1',{'x-codex-relay-token':config.token},async(type,command)=>{
    if(command.type!=='deviceGateway')return;commands.push(command);
    let result,error;try{result=command.action==='http' ? await localRequest(local.base,command.request) : {peerId:command.peerId,answer:{type:'answer',sdp:'fixture'}};}catch(value){error=value.message;}
    await post(hub.base,'/api/runner/'+config.id+'/events',{type:'gateway_reply',requestId:command.requestId,result,error},config.token);
  },abort.signal).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,120));
  await post(local.base,'/api/runner/'+config.id+'/events',{type:'thread_list',threads:[{id:'original',name:'原对话',cwd:'D:/Project',status:{type:'idle'},createdAt:1,updatedAt:2}]},'test-host');
  const snapshot=await (await fetch(local.base+'/api/bootstrap')).json();
  assert.equal(snapshot.devices.length,1);assert.equal(snapshot.devices[0].id,config.id);
  assert.equal((await post(hub.base,'/api/runner/'+config.id+'/events',{type:'device_snapshot',snapshot},config.token)).status,202);
  const bad=structuredClone(snapshot);bad.sessions[0].deviceId='local';assert.equal((await post(hub.base,'/api/runner/'+config.id+'/events',{type:'device_snapshot',snapshot:bad},config.token)).status,400);
  const requestId=crypto.randomUUID(),body={deviceId:config.id,cwd:'D:/Project',title:'只验证路由',prompt:'fixture',executionMode:'runner',requestId};
  const direct=await (await post(local.base,'/api/sessions',body)).json();
  const forwarded=await (await post(hub.base,'/api/sessions',body)).json();
  assert.equal(direct.session.id,forwarded.session.id);assert.equal(direct.delivery.id,forwarded.delivery.id);
  const receipt=await (await fetch(hub.base+'/api/deliveries/'+requestId,{headers:{'x-codex-device':config.id}})).json();assert.equal(receipt.sessionId,direct.session.id);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=';
  const image=await (await post(hub.base,'/api/uploads',{requestId:crypto.randomUUID(),name:'图',dataUrl:png},null,{'x-codex-device':config.id})).json();
  assert.match(image.url,new RegExp('/api/devices/'+config.id+'/uploads/'));
  const bytes=await (await fetch(hub.base+image.url)).arrayBuffer();assert.ok(bytes.byteLength>40);
  const offer=await (await post(hub.base,'/api/devices/'+config.id+'/direct',{offer:{type:'offer',sdp:'fixture'}})).json();assert.equal(offer.answer.type,'answer');
  // Remote requests must pass browser pairing before they can signal a peer.
  const remote=await new Promise((resolve,reject)=>{const req=httpRequest(hub.base+'/api/devices/'+config.id+'/direct',{method:'POST',headers:{host:'192.168.0.200','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({offer:{type:'offer',sdp:'fixture'}}));});assert.equal(remote,403);
  await fs.writeFile(path.join(hub.directory,'network.json'),JSON.stringify({externalOrigin:'https://relay.fixture.ts.net'}));
  const phone=async(route,body,cookie)=>new Promise((resolve,reject)=>{
    const req=httpRequest(hub.base+route,{method:'POST',headers:{host:'relay.fixture.ts.net','x-forwarded-proto':'https','x-forwarded-for':'100.64.0.5','content-type':'application/json',...(cookie ? {cookie} : {})}},res=>{let text='';res.on('data',bytes=>text+=bytes);res.on('end',()=>resolve({status:res.statusCode,cookie:res.headers['set-cookie']?.[0].split(';')[0],data:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));
  });
  const target='/api/devices/'+config.id+'/direct';
  assert.equal((await phone(target,{offer:{type:'offer',sdp:'fixture'}})).status,401);
  const phoneCode=await (await fetch(hub.base+'/api/phone')).json();
  const paired=await phone('/api/access/pair',{code:phoneCode.code,deviceName:'测试手机'});assert.equal(paired.status,200);
  assert.equal((await phone(target+'/'+offer.peerId+'/lease',{},paired.cookie)).status,403,'cannot renew another browser peer');
  const own=await phone(target,{offer:{type:'offer',sdp:'fixture'}},paired.cookie);assert.equal(own.status,200);
  assert.equal((await phone(target+'/'+own.data.peerId+'/lease',{},paired.cookie)).status,200);
  const browserDevices=await (await fetch(hub.base+'/api/access/devices')).json(),grant=browserDevices.devices.find(item=>item.name==='测试手机');
  assert.equal((await fetch(hub.base+'/api/access/devices/'+grant.id,{method:'DELETE'})).status,200);
  assert.equal((await phone(target+'/'+own.data.peerId+'/lease',{},paired.cookie)).status,401,'revoked browser cannot extend a direct connection');
  assert.ok(commands.some(item=>item.action==='http'));abort.abort();await Promise.all([bridge,localStream]);
});
