import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('only local admin manages grants; selective revocation ends live SSE and denies further requests',{timeout:15_000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-browser-devices-'));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const origin='https://relay.test-tail.ts.net';
  fs.writeFileSync(path.join(directory,'network.json'),JSON.stringify({externalOrigin:origin,privateOrigin:origin+':8443',accessMode:'hybrid'}));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_TOKEN:'test-token',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_DATA_DIR:directory}});
  t.after(async()=>{const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  const base=`http://127.0.0.1:${port}`;
  const proxy=privateRoute=>({host:new URL(origin+(privateRoute ? ':8443' : '')).host,origin:origin+(privateRoute ? ':8443' : ''),'x-forwarded-proto':'https'});
  const send=(endpoint,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const req=request(base+endpoint,{method,headers:{'content-type':'application/json',...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:JSON.parse(text)}));
    });req.on('error',reject);req.end(body===undefined ? undefined : JSON.stringify(body));
  });
  const grant=async(name,privateRoute)=>{
    const info=(await send('/api/phone')).json;
    const result=await send('/api/access/pair',{method:'POST',headers:proxy(privateRoute),body:{code:info.code,deviceName:name}});
    assert.equal(result.status,200);return {...proxy(privateRoute),cookie:result.headers['set-cookie'][0].split(';')[0]};
  };
  const phone=await grant('鸿蒙手机',false),laptop=await grant('笔记本',true);
  for(const headers of [phone,laptop]) {
    const initial=await send('/api/bootstrap',{headers});
    assert.deepEqual(initial.json.access,{required:false,local:false});
    assert.ok(Array.isArray(initial.json.sessions));assert.equal(initial.headers['cache-control'],'no-store');
  }
  const devices=(await send('/api/access/devices')).json.devices;
  const phoneId=devices.find(device=>device.name==='鸿蒙手机').id;
  for(const headers of [proxy(false),phone,laptop]){
    assert.equal((await send('/api/access/devices',{headers})).status,403);
    assert.equal((await send('/api/access/devices/'+phoneId,{method:'DELETE',headers})).status,403);
    assert.equal((await send('/api/access/code',{method:'POST',headers,body:{}})).status,403);
  }
  assert.equal((await send('/api/access/devices/'+phoneId,{method:'PATCH',body:{name:'常用手机'}})).status,200);
  let streamText='';
  const stream=await new Promise((resolve,reject)=>{
    const req=request(base+'/api/events',{headers:phone},res=>{res.setEncoding('utf8');res.on('data',chunk=>streamText+=chunk);resolve(res);});
    req.on('error',reject);req.end();t.after(()=>req.destroy());
  });
  assert.equal(stream.statusCode,200);
  const ended=new Promise(resolve=>stream.once('end',resolve));
  assert.equal((await send('/api/access/devices/'+phoneId,{method:'DELETE'})).status,200);
  await ended;assert.match(streamText,/event: access_revoked/);const finalText=streamText;
  for(const endpoint of ['/api/sessions','/api/events','/api/uploads/missing'])assert.equal((await send(endpoint,{headers:phone})).status,401);
  assert.equal((await send('/api/access',{headers:phone})).json.required,true);
  assert.deepEqual((await send('/api/bootstrap',{headers:phone})).json,{access:{required:true,local:false}});
  assert.equal((await send('/api/sessions',{headers:laptop})).status,200);
  await send('/api/runner/local/events',{method:'POST',headers:{'x-codex-relay-token':'test-token'},body:{type:'thread_list',threads:[{id:'fixture',cwd:directory,status:{type:'idle'}}]}});
  assert.equal(streamText,finalText);
  assert.equal((await send('/api/access/devices',{method:'DELETE'})).status,200);
  assert.equal((await send('/api/sessions',{headers:laptop})).status,401);
  assert.equal((await send('/api/sessions')).status,200);
});
