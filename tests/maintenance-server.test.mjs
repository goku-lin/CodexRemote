import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {setMaintenancePassword} from '../src/maintenance-auth.mjs';

test('only local password files enable restart; paired browsers have no password management API',{timeout:15000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-maintenance-api-'));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  await fs.writeFile(path.join(dir,'network.json'),JSON.stringify({externalOrigin:'https://maintenance.test-tail.ts.net'}));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_DATA_DIR:dir,CODEX_RELAY_TOKEN:'maintenance-fixture',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'0'}});
  t.after(async()=>{const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});
  const base='http://127.0.0.1:'+port,remote={host:'maintenance.test-tail.ts.net','x-forwarded-proto':'https'};
  const send=(url,{headers={},body,method=body===undefined?'GET':'POST'}={})=>new Promise((resolve,reject)=>{const req=request(base+url,{method,headers:{'content-type':'application/json',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,json,text});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
  assert.equal((await send('/api/maintenance',{headers:remote})).status,401);
  const info=(await send('/api/phone')).json,pair=await send('/api/access/pair',{headers:remote,body:{code:info.code}}),paired={...remote,cookie:pair.headers['set-cookie'][0].split(';')[0]};
  assert.equal((await send('/api/maintenance',{headers:paired})).json.passwordConfigured,false);
  assert.equal((await send('/api/maintenance',{headers:paired})).json.passwordSetupPath,undefined);
  assert.equal((await send('/api/maintenance')).json.passwordSetupPath,path.resolve('设置重启密码.cmd'));
  for(const headers of [paired,{}]){
    assert.equal((await send('/api/maintenance/password',{headers,body:{password:'remote-set-password'}})).status,404);
    assert.equal((await send('/api/maintenance/password',{headers,method:'DELETE'})).status,404);
  }
  await assert.rejects(fs.access(path.join(dir,'maintenance-password.json')));
  const body={requestId:'test-api-maintenance-request',scope:'desktop',password:'local-password-123',confirmDesktop:true};
  assert.equal((await send('/api/maintenance/restart',{headers:paired,body})).status,400);
  await setMaintenancePassword(dir,body.password);assert.equal((await send('/api/maintenance',{headers:paired})).json.passwordConfigured,true);
  assert.equal((await send('/api/maintenance/restart',{headers:remote,body})).status,401);
  assert.equal((await send('/api/maintenance/restart',{headers:{...paired,origin:'https://other.test'},body})).status,403);
  assert.equal((await send('/api/maintenance/restart',{headers:paired,body:{...body,password:'wrong-password'}})).status,403);
  assert.equal((await send('/api/maintenance/restart',{headers:paired,body:{...body,confirmDesktop:false}})).status,400);
  assert.equal((await send('/api/maintenance/restart',{headers:paired,body})).status,400,'unsupervised fixture cannot stop itself');
  assert.ok(!(await fs.readdir(dir)).some(name=>name.startsWith('maintenance-job-')));
});
