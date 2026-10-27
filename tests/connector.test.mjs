import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ConnectorAccess} from '../src/connector-access.mjs';
import {createArchive,extractArchive} from '../src/connector-archive.mjs';
import {serverUrl,applyUpdate} from '../src/connector-client.mjs';
import {deviceSession} from '../public/device-selection.js';
import {nativeEndpointFile} from '../src/native-desktop-channel.mjs';
async function folder(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-connector-test-'));t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});return directory;}

test('one computer code creates a device-bound credential, survives restart and recovers a lost response',async t=>{
  const directory=await folder(t),access=new ConnectorAccess(directory,'host-fixture'),code=access.code(),nonce=crypto.randomUUID();
  const first=access.enroll({code:code.code,nonce,name:'第二台'},'fixture-peer');
  assert.ok(access.authorized(first.id,first.token));assert.equal(access.authorized('local',first.token),false);
  assert.equal(access.authorized(first.id,first.token+'x'),false);
  assert.throws(()=>access.enroll({code:code.code,nonce:crypto.randomUUID(),name:'第三台'},'fixture-peer'),/已经/);
  const recovered=new ConnectorAccess(directory,'host-fixture');assert.deepEqual(recovered.enroll({code:code.code,nonce,name:'第二台'},'fixture-peer'),first);
  const second=recovered.enroll({code:recovered.code().code,nonce:crypto.randomUUID(),name:'第三台'},'fixture-peer');
  assert.equal(recovered.authorized(second.id,first.token),false);assert.ok(recovered.authorized(second.id,second.token));
  assert.ok(recovered.revoke(first.id));assert.equal(recovered.authorized(first.id,first.token),false);
  assert.ok(recovered.authorized(second.id,second.token));
  const saved=await fs.readFile(path.join(directory,'connector-devices.json'),'utf8');assert.ok(!saved.includes(first.token));assert.ok(!saved.includes(code.code));
});
test('expired codes and brute-force attempts cannot enroll computers',async t=>{
  const directory=await folder(t);let now=1;const access=new ConnectorAccess(directory,'fixture',{now:()=>now}),expired=access.code();now+=600001;
  assert.throws(()=>access.enroll({code:expired.code,nonce:crypto.randomUUID(),name:'PC'},'peer'),/过期/);
  const fresh=access.code();for(let i=0;i<7;i++)assert.throws(()=>access.enroll({code:'wrong',nonce:crypto.randomUUID(),name:'PC'},'peer'));
  assert.throws(()=>access.enroll({code:fresh.code,nonce:crypto.randomUUID(),name:'PC'},'peer'),/过多/);
  now+=60001;assert.ok(access.enroll({code:fresh.code,nonce:crypto.randomUUID(),name:'PC'},'peer').id);
});
test('archives preserve binary files and reject traversal or corrupt contents',async t=>{
  const directory=await folder(t),bytes=Buffer.from([0,1,2,255,80]);
  await extractArchive(createArchive([{name:'runtime/node.exe',bytes},{name:'app/public/app.js',bytes:Buffer.from('你好')}]),directory);
  assert.deepEqual(await fs.readFile(path.join(directory,'runtime','node.exe')),bytes);
  await assert.rejects(()=>extractArchive(createArchive([{name:'app/../escape',bytes}]),directory),/路径/);
  await assert.rejects(()=>extractArchive(createArchive([{name:'app/.relay-data/token',bytes}]),directory),/路径/);
  const archive=createArchive([{name:'runtime/node.exe',bytes}]);archive.writeUInt32LE(123,14);
  await assert.rejects(()=>extractArchive(archive,directory),/校验/);
});
test('failed update leaves old selection and credentials; verified update changes version only after preparation',async t=>{
  const home=await folder(t),old='1'.repeat(20),version='2'.repeat(20),config={token:'fixture-credential'};
  await fs.mkdir(path.join(home,'state'));await fs.writeFile(path.join(home,'state','connector.json'),JSON.stringify(config));await fs.writeFile(path.join(home,'current.json'),JSON.stringify({version:old}));
  const bytes=createArchive([{name:'release.json',bytes:Buffer.from(JSON.stringify({version}))},{name:'runtime/node.exe',bytes:Buffer.from('MZfixture')},{name:'app/connector-client.mjs',bytes:Buffer.from('//fixture')}]);
  const manifest={version,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
  await assert.rejects(()=>applyUpdate(home,{...manifest,sha256:'f'.repeat(64)},bytes),/校验/);
  await assert.rejects(()=>applyUpdate(home,manifest,bytes,{prepareVersion:async()=>{throw new Error('fixture compiler failed');}}),/compiler/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'current.json'))),{version:old});
  await applyUpdate(home,manifest,bytes,{prepareVersion:async()=>{assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'current.json'))),{version:old});}});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'current.json'))),{version});assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'state','connector.json'))),config);
});
test('device selection never falls through to another computer, and state directory remains stable across versions',()=>{
  const sessions=[{id:'a',deviceId:'one',updatedAt:2},{id:'b',deviceId:'two',updatedAt:9},{id:'c',deviceId:'one',updatedAt:4}];
  assert.equal(deviceSession(sessions,'one','b').id,'c');assert.equal(deviceSession(sessions,'one','a').id,'a');assert.equal(deviceSession(sessions,'empty','b'),null);
  assert.equal(nativeEndpointFile({CODEX_RELAY_DATA_DIR:'D:/connector/state'}),path.join('D:/connector/state','native-desktop.json'));
  assert.equal(serverUrl('https://relay.example/'),'https://relay.example');assert.equal(serverUrl('http://192.168.0.213:4317/'),'http://192.168.0.213:4317');assert.throws(()=>serverUrl('http://public.example/'));assert.throws(()=>serverUrl('https://user:password@relay.example/'));
});
