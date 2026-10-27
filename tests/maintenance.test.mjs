import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setMaintenancePassword,MaintenanceAuth} from '../src/maintenance-auth.mjs';
import {Maintenance,readMaintenanceJob,jobPath} from '../src/maintenance.mjs';
import {runMaintenanceJob} from '../src/maintenance-worker.mjs';
import {runMaintenanceProcess} from '../src/desktop-restart.mjs';

async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-maintenance-'));t.after(async()=>{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});});return dir;}
const password='fixture-password-123',id='maintenance-request-one',plan={service:{pid:123,startTicks:'1234',path:'fixture-node'},desktop:{pid:456},desktopExe:'fixture-desktop',proxyExe:'fixture-proxy',endpointFile:'fixture-endpoint',oldNativePid:7};

test('six-character restart passwords work, preserve leading zeros and reject shorter or oversized values',async t=>{
  const dir=await directory(t),auth=new MaintenanceAuth(dir),six='012345';
  for(const value of ['12345','x'.repeat(129),123456,null])await assert.rejects(setMaintenancePassword(dir,value),/6–128/);
  await setMaintenancePassword(dir,six);await auth.verify(six);
  await assert.rejects(auth.verify('12345'),error=>error.status===403);
  await assert.rejects(auth.verify('012346'),error=>error.status===403);
  await auth.verify(six);
  await setMaintenancePassword(dir,'x'.repeat(128));await auth.verify('x'.repeat(128));
});

test('password is a salted hash configured locally; rotation is immediate and corrupt credentials fail closed',async t=>{
  const dir=await directory(t),auth=new MaintenanceAuth(dir);assert.equal(auth.configured(),false);await assert.rejects(auth.verify(password),/本机/);
  await setMaintenancePassword(dir,password);const first=await fs.readFile(path.join(dir,'maintenance-password.json'),'utf8');assert.ok(!first.includes(password));await auth.verify(password);
  await assert.rejects(auth.verify('incorrect-pass'),/不正确/);await setMaintenancePassword(dir,'changed-password-456');await assert.rejects(auth.verify(password),/不正确/);await auth.verify('changed-password-456');
  assert.notEqual(await fs.readFile(path.join(dir,'maintenance-password.json'),'utf8'),first);
  await fs.writeFile(path.join(dir,'maintenance-password.json'),'{}');assert.throws(()=>auth.configured(),/配置无效/);await assert.rejects(auth.verify(password),/配置无效/);
});

test('repeated wrong passwords are throttled without ever preparing a restart',async t=>{
  const dir=await directory(t);await setMaintenancePassword(dir,password);let clock=0;
  const auth=new MaintenanceAuth(dir,{now:()=>clock});for(let i=0;i<5;i++)await assert.rejects(auth.verify('wrong-password'),/不正确/);
  await assert.rejects(auth.verify(password),error=>error.status===429);clock=60001;await auth.verify(password);
  for(let i=0;i<5;i++)await assert.rejects(auth.verify('wrong-password'),/不正确/);
  await setMaintenancePassword(dir,'new-local-password');await auth.verify('new-local-password');
});

test('restart requires password and explicit desktop confirmation, persists no password and deduplicates lost responses',async t=>{
  const dir=await directory(t);await setMaintenancePassword(dir,password);let prepared=0,launched=0;
  const manager=new Maintenance({dataDir:dir,port:4317,supervised:true,platform:'win32',prepare:async()=>{prepared++;return plan;},launch:async()=>launched++});
  const body={requestId:id,scope:'desktop',password,confirmDesktop:true};
  await assert.rejects(manager.request({...body,confirmDesktop:false}),/中断/);await assert.rejects(manager.request({...body,password:'bad-password'}),/不正确/);assert.equal(prepared,0);
  const accepted=await manager.request(body);assert.equal(prepared,1);assert.equal(launched,0);assert.equal(accepted.job.state,'queued');await accepted.start();assert.equal(launched,1);
  const duplicate=await manager.request(body);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.start,undefined);assert.equal(prepared,1);
  await assert.rejects(manager.request({...body,requestId:'maintenance-request-two'}),/尚未结束/);
  const disk=await fs.readFile(jobPath(dir,id),'utf8');assert.ok(!disk.includes(password));assert.equal(manager.status(id).job.plan,undefined);
  assert.equal(manager.status(id).job.password,undefined);
});

test('independent worker restarts the desktop before its service, waits for a fresh native connection, and cannot run twice',async t=>{
  const dir=await directory(t);await setMaintenancePassword(dir,password);
  const manager=new Maintenance({dataDir:dir,port:1234,supervised:true,platform:'win32',prepare:async()=>plan,launch:async()=>{}});
  await manager.request({requestId:id,scope:'desktop',password,confirmDesktop:true});
  const calls=[];let clock=0,checks=0;
  const deps={run:async action=>calls.push(action),sleep:async ms=>clock+=ms,now:()=>clock,health:async()=>{checks++;return {relay:{state:'ready'},runner:{state:'ready'},desktop:{state:'ready'}};},nativePid:()=>checks>1?8:7};
  await runMaintenanceJob(dir,id,deps);assert.deepEqual(calls,['desktop','service']);assert.equal(checks,2);assert.equal(readMaintenanceJob(dir,id).state,'complete');
  await runMaintenanceJob(dir,id,deps);assert.equal(calls.length,2);
});

test('a failed desktop restart never proceeds to stop the service or reports success',async t=>{
  const dir=await directory(t);await setMaintenancePassword(dir,password);
  const manager=new Maintenance({dataDir:dir,port:1234,supervised:true,platform:'win32',prepare:async()=>plan,launch:async()=>{}});
  await manager.request({requestId:id,scope:'desktop',password,confirmDesktop:true});const calls=[];
  await runMaintenanceJob(dir,id,{sleep:async()=>{},run:async action=>{calls.push(action);throw new Error('desktop identity changed');}});
  assert.deepEqual(calls,['desktop']);assert.equal(readMaintenanceJob(dir,id).state,'failed');assert.match(readMaintenanceJob(dir,id).error,/identity changed/);
});

test('Windows process inspection is read-only and a stale process identity cannot stop even the test process',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const inspected=await runMaintenanceProcess('inspect',{scope:'service',servicePid:process.pid,parentPid:process.ppid,nodePath:process.execPath});
  assert.equal(inspected.service.pid,process.pid);assert.equal(inspected.service.path.toLowerCase(),process.execPath.toLowerCase());
  await assert.rejects(runMaintenanceProcess('service',{plan:{service:{...inspected.service,startTicks:'0'}}}),/身份已改变/);
  assert.doesNotThrow(()=>process.kill(process.pid,0));
});
