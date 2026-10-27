import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createNetworkCheck} from '../src/network-check.mjs';
import {measureNetwork,setupNetworkCheck,downloadBytes,uploadBytes} from '../public/network-check.js';

const send=(base,route,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=request(base+route,{method,headers},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks);let json;try{json=JSON.parse(bytes);}catch{}resolve({status:res.statusCode,headers:res.headers,bytes,json});});res.on('error',reject);
  });req.on('error',reject);req.end(body);
});

test('a single measurement uses bounded bytes, median latency, uncached requests and elapsed transfer time',async()=>{
  let time=0,randomBytes=0;const calls=[],durations=[30,10,20,1000,500];
  const result=await measureNetwork({now:()=>time,random:bytes=>{randomBytes+=bytes.length;bytes.fill(137);},fetcher:async(url,options)=>{
    calls.push({url,options});time+=durations.shift();
    return {ok:true,json:async()=>url.includes('/upload') ? {bytes:uploadBytes} : {networkCheck:1},arrayBuffer:async()=>new ArrayBuffer(downloadBytes)};
  }});
  assert.equal(calls.length,5);assert.equal(result.latencyMs,20);
  assert.equal(result.downloadMbps,downloadBytes*8/1000000);assert.equal(result.uploadMbps,uploadBytes*8/500000);
  assert.equal(result.transferred,512*1024);assert.equal(randomBytes,uploadBytes);
  assert.ok(calls.every(({options})=>options.cache==='no-store' && options.credentials==='same-origin'));
  assert.equal(calls.at(-1).options.body.length,uploadBytes);
  assert.ok(calls.at(-1).options.body.every(byte=>byte===137));
});

test('cancellation aborts the active request without starting download or upload',async()=>{
  const controller=new AbortController();let count=0;
  const pending=measureNetwork({signal:controller.signal,fetcher:async(_url,{signal})=>{count++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
  controller.abort();await assert.rejects(pending,/aborted/);assert.equal(count,1);
});

test('failed or incomplete measurements never produce a successful speed result',async()=>{
  await assert.rejects(measureNetwork({fetcher:async()=>({ok:false,status:401,json:async()=>({error:'请先配对'})})}),/配对/);
  await assert.rejects(measureNetwork({fetcher:async url=>({ok:true,json:async()=>({networkCheck:1}),arrayBuffer:async()=>new ArrayBuffer(1)})}),/下载测试数据不完整/);
});

test('setting up the UI stays idle until clicked',()=>{
  const nodes=new Map(),listeners=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{addEventListener:(event,handler)=>listeners.push({event,handler})});return nodes.get(id);};
  const previous=globalThis.document;
  globalThis.document={getElementById:node,addEventListener:(event,handler)=>listeners.push({event,handler})};
  try{setupNetworkCheck();assert.equal(typeof node('networkCheckBtn').onclick,'function');assert.equal(node('networkCheckResult').textContent,undefined);assert.equal(listeners.length,2);}finally{globalThis.document=previous;}
});

test('HTTP testing rejects excessive uploads, rate limits repeated traffic and releases timed out uploads',async t=>{
  let time=10000;const handler=createNetworkCheck({now:()=>time,uploadTimeoutMs:50});
  const server=createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const download=await send(base,'/api/network-check/download',{headers:{'accept-encoding':'br, gzip'}});
  assert.equal(download.bytes.length,downloadBytes);assert.equal(download.headers['content-encoding'],undefined);assert.match(download.headers['cache-control'],/no-store.*no-transform/);
  assert.ok(new Set(download.bytes).size>200,'incompressible test payload');
  assert.equal((await send(base,'/api/network-check/download')).status,429);
  time+=5000;assert.equal((await send(base,'/api/network-check/upload',{method:'POST',body:Buffer.alloc(uploadBytes+1),headers:{'content-length':uploadBytes+1}})).status,413);
  time+=5000;assert.equal((await send(base,'/api/network-check/upload',{method:'POST',body:Buffer.alloc(uploadBytes+1),headers:{'transfer-encoding':'chunked'}})).status,413);
  time+=5000;assert.equal((await send(base,'/api/network-check/upload',{method:'POST',body:Buffer.alloc(1),headers:{'transfer-encoding':'chunked'}})).status,400);
  time+=5000;
  const timedOut=await new Promise((resolve,reject)=>{
    const req=request(base+'/api/network-check/upload',{method:'POST',headers:{'content-length':uploadBytes}},res=>{res.resume();res.on('end',()=>{req.destroy();resolve(res.statusCode);});});req.on('error',reject);req.write(Buffer.alloc(1));
  });assert.equal(timedOut,408);
  time+=5000;assert.equal((await send(base,'/api/network-check/upload',{method:'POST',body:Buffer.alloc(uploadBytes),headers:{'content-length':uploadBytes}})).json.bytes,uploadBytes);
});

test('real Relay network tests require pairing and same origin, and allow paired browsers to measure',{timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-network-check-'));
  await writeFile(path.join(directory,'network.json'),JSON.stringify({externalOrigin:'https://network.test-tail.ts.net'}));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_DATA_DIR:directory,CODEX_RELAY_TOKEN:'network-fixture',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'0'}});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error('Relay exited '+code)));child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  const base='http://127.0.0.1:'+port,remote={host:'network.test-tail.ts.net','x-forwarded-proto':'https'};
  for(const route of ['ping','download','upload'])assert.equal((await send(base,'/api/network-check/'+route,{headers:remote,method:route==='upload' ? 'POST' : 'GET'})).status,401);
  const info=(await send(base,'/api/phone')).json,pair=await send(base,'/api/access/pair',{method:'POST',headers:{...remote,'content-type':'application/json'},body:JSON.stringify({code:info.code})});
  const paired={...remote,cookie:pair.headers['set-cookie'][0].split(';')[0]};
  assert.equal((await send(base,'/api/network-check/ping',{headers:{...paired,origin:'https://other.test'}})).status,403);
  assert.equal((await send(base,'/api/network-check/ping',{headers:paired})).json.networkCheck,1);
  assert.equal((await send(base,'/api/network-check/download',{headers:paired})).bytes.length,downloadBytes);
  assert.equal((await send(base,'/api/network-check/upload',{method:'POST',headers:{...paired,'content-length':uploadBytes},body:Buffer.alloc(uploadBytes)})).json.bytes,uploadBytes);
});
