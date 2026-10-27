import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserAccess, isLocalBrowser, privateOrigin } from '../src/browser-access.mjs';

const remote=(cookie='')=>({headers:{host:'192.168.0.213:4317',cookie},socket:{remoteAddress:'192.168.0.20'}});
const local=()=>({headers:{host:'127.0.0.1:4317'},socket:{remoteAddress:'127.0.0.1'}});
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-access-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));return rm(directory,{recursive:true,force:true});});
  let now=1000000;
  const options={now:()=>now,addresses:()=>['192.168.0.213']};
  return {access:new BrowserAccess(directory,options),restart:()=>new BrowserAccess(directory,options),advance:ms=>now+=ms};
}

test('LAN browsers require pairing; cookies survive restart but cannot be forged or reused as pairing codes',async t=>{
  const {access,restart}=await fixture(t);
  assert.equal(access.authorized(local()),true);
  assert.equal(access.authorized(remote()),false);
  const info=access.pairingInfo(4317,true);
  assert.deepEqual(info.urls,['http://192.168.0.213:4317/']);
  assert.match(info.code,/^\d{8}$/);
  const result=access.pair(remote(),info.code.slice(0,4)+' '+info.code.slice(4));
  assert.equal(result.status,200);
  assert.match(result.cookie,/HttpOnly; SameSite=Strict/);
  const cookie=result.cookie.split(';')[0];
  assert.equal(access.authorized(remote(cookie)),true);
  assert.equal(restart().authorized(remote(cookie)),true);
  assert.equal(access.pair(remote(),info.code).status,401);
  assert.equal(access.authorized(remote(cookie+'forged')),false);
});

test('expired pairing codes and browser sessions require a fresh connection',async t=>{
  const {access,advance}=await fixture(t);
  const info=access.pairingInfo(4317,true);
  advance(10*60*1000);
  assert.equal(access.pair(remote(),info.code).status,401);
  const fresh=access.pairingInfo(4317,true);
  assert.ok(fresh.expiresAt>info.expiresAt);
  const cookie=access.pair(remote(),fresh.code).cookie.split(';')[0];
  advance(14*24*60*60*1000);
  assert.equal(access.authorized(remote(cookie)),false);
});

test('repeated wrong codes are throttled even when a valid code is supplied next',async t=>{
  const {access,advance}=await fixture(t);
  const info=access.pairingInfo(4317,true);
  for(let i=0;i<5;i++)assert.equal(access.pair(remote(),'wrong').status,401);
  assert.equal(access.pair(remote(),info.code).status,429);
  advance(60001);
  assert.equal(access.pair(remote(),info.code).status,200);
});

test('host spoofing, cross-site origins and forwarded localhost headers cannot bypass pairing',async t=>{
  const {access}=await fixture(t);
  assert.equal(access.sameOrigin(local()),true);
  assert.equal(access.sameOrigin(remote()),true);
  assert.equal(access.sameOrigin({...local(),headers:{host:'127.attacker.test:4317'}}),false);
  assert.equal(access.sameOrigin({...local(),headers:{host:'127.0.0.1:4317',origin:'https://attacker.test'}}),false);
  assert.equal(access.sameOrigin({...remote(),headers:{host:'192.168.0.213:4317','sec-fetch-site':'cross-site'}}),false);
  assert.equal(isLocalBrowser({...remote(),headers:{'x-forwarded-for':'127.0.0.1'}}),false);
  assert.equal(isLocalBrowser({...local(),socket:{remoteAddress:'::ffff:127.0.0.1'}}),true);
});

test('private HTTPS proxy still requires pairing, denies local privileges, and uses secure cookies',async t=>{
  const {access}=await fixture(t);
  const origin='https://relay.example-tail.ts.net';
  await writeFile(path.join(access.dataDir,'network.json'),JSON.stringify({externalOrigin:origin}));
  const proxy={headers:{host:'relay.example-tail.ts.net','x-forwarded-host':'relay.example-tail.ts.net',
    'x-forwarded-proto':'https','x-forwarded-for':'100.64.0.2',origin},socket:{remoteAddress:'127.0.0.1'}};
  assert.equal(access.sameOrigin(proxy),true);
  assert.equal(isLocalBrowser(proxy),false);
  assert.equal(access.authorized(proxy),false);
  assert.equal(isLocalBrowser({...proxy,headers:{...proxy.headers,host:'127.0.0.1:4317'}}),false);
  assert.equal(access.sameOrigin({...proxy,headers:{...proxy.headers,origin:'http://relay.example-tail.ts.net'}}),false);
  assert.equal(access.sameOrigin({...proxy,headers:{...proxy.headers,'x-forwarded-proto':'http'}}),false);
  assert.equal(access.sameOrigin({...proxy,socket:{remoteAddress:'192.168.0.20'}}),false);
  assert.equal(access.sameOrigin({...proxy,headers:{...proxy.headers,host:'other.example-tail.ts.net'}}),false);
  const info=access.pairingInfo(4317,false);
  assert.equal(info.enabled,true);assert.equal(info.externalUrl,origin+'/');
  assert.deepEqual(info.urls,[],'closed LAN must not advertise unreachable local addresses');
  const result=access.pair(proxy,info.code);
  assert.equal(result.status,200);assert.match(result.cookie,/; Secure$/);
  assert.equal(access.authorized({...proxy,headers:{...proxy.headers,cookie:result.cookie.split(';')[0]}}),true);
  assert.equal(access.authorized(local()),true);
});

test('private access accepts only an exact Tailscale HTTPS origin',()=>{
  assert.equal(privateOrigin('https://relay.my-tail.ts.net/'),'https://relay.my-tail.ts.net');
  for (const value of ['http://relay.my-tail.ts.net','https://evil.test','https://relay.my-tail.ts.net.evil.test',
    'https://relay.my-tail.ts.net:4317','https://relay.my-tail.ts.net/path','https://user@relay.my-tail.ts.net']) {
    assert.throws(()=>privateOrigin(value));
  }
});

test('device grants can be named and selectively revoked, including after restart',async t=>{
  const {access,restart,advance}=await fixture(t);
  const first=access.pair(remote(),access.pairingInfo(4317,true).code,'我的鸿蒙手机').cookie.split(';')[0];
  const second=access.pair(remote(),access.pairingInfo(4317,true).code,'笔记本').cookie.split(';')[0];
  const phone=access.listDevices().find(device=>device.name==='我的鸿蒙手机');
  assert.ok(phone);assert.ok(!JSON.stringify(access.listDevices()).includes('tokenHash'));
  const code=access.pairingInfo(4317,true).code;
  access.pairingInfo(4317,true,{rotate:true});assert.equal(access.pair(remote(),code).status,401);
  assert.equal(access.authorized(remote(first)),true);
  assert.equal(access.renameDevice(phone.id,'常用手机'),true);
  assert.throws(()=>access.renameDevice(phone.id,'   '));
  advance(61_000);access.authorized(remote(second));
  assert.equal(access.listDevices().find(device=>device.name==='笔记本').lastSeen,1061000);
  access.revokeDevice(phone.id);
  assert.equal(access.authorized(remote(first)),false);
  assert.equal(access.authorized(remote(second)),true);
  const restored=restart();assert.equal(restored.authorized(remote(first)),false);assert.equal(restored.authorized(remote(second)),true);
  assert.equal(restored.listDevices().find(device=>device.id===phone.id).name,'常用手机');
  assert.equal(restored.listDevices().find(device=>device.id===phone.id).status,'revoked');
});

test('old LAN grants migrate; revoke-all also denies old grants that never reconnected',async t=>{
  const {access,restart}=await fixture(t);
  const legacy=()=>{
    const payload=`2000000.${crypto.randomBytes(16).toString('base64url')}`;
    return 'codex_relay_browser='+payload+'.'+crypto.createHmac('sha256',access.signingKey()).update(payload).digest('base64url');
  };
  const existing=legacy(),unseen=legacy();
  assert.equal(access.authorized(remote(existing)),true);assert.equal(access.listDevices().length,1);
  assert.equal(access.authorized(remote(existing)),true);assert.equal(access.listDevices().length,1);
  const oldCode=access.pairingInfo(4317,true).code;access.revokeAll();
  assert.equal(restart().authorized(remote(existing)),false);assert.equal(restart().authorized(remote(unseen)),false);
  assert.equal(access.pair(remote(),oldCode).status,401);
  const fresh=access.pair(remote(),access.pairingInfo(4317,true).code).cookie.split(';')[0];
  assert.equal(restart().authorized(remote(fresh)),true);
});

test('hybrid public and private HTTPS ports share grants without trusting other ports',async t=>{
  const {access}=await fixture(t);
  const origin='https://relay.my-tail.ts.net',privateUrl=origin+':8443';
  await writeFile(path.join(access.dataDir,'network.json'),JSON.stringify({externalOrigin:origin,privateOrigin:privateUrl,accessMode:'hybrid'}));
  const proxy=entry=>({headers:{host:new URL(entry).host,origin:entry,'x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}});
  assert.equal(access.sameOrigin(proxy(origin)),true);assert.equal(access.sameOrigin(proxy(privateUrl)),true);
  assert.equal(access.sameOrigin(proxy(origin+':10000')),false);
  const info=access.pairingInfo(4317,false);assert.equal(info.publicUrl,origin+'/');assert.equal(info.privateUrl,privateUrl+'/');
  const cookie=access.pair(proxy(origin),info.code).cookie.split(';')[0];
  assert.equal(access.authorized({...proxy(privateUrl),headers:{...proxy(privateUrl).headers,cookie}}),true);
});
