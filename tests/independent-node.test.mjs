import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {entries,install} from '../src/connector-client.mjs';
import {initializeApplication} from '../src/portable-start.mjs';
import {independentPort,independentService} from '../src/independent-node.mjs';
import {writeApplicationFixture} from './application-fixture.mjs';

async function folder(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-application-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  return directory;
}
test('an independent service uses its own stable port and has no upstream registration or lease',()=>{
  const service=independentService({app:'fixture-app',state:'fixture-state',version:'a'.repeat(20),config:{id:'fixture-device',name:'个人笔记本',cwd:'fixture-work',token:'fixture'}});
  assert.equal(service.env.PORT,'4317');assert.equal(service.env.HOST,'127.0.0.1');
  assert.equal(service.env.CODEX_RELAY_EXECUTION_NODE,'1');assert.equal(service.env.CODEX_RELAY_SERVER,undefined);
  for(const port of [0,-1,65536,1.5,'wrong'])assert.throws(()=>independentPort(port));
});
test('portable first launch creates local identity once and preserves it and browser pairing on subsequent launches',async t=>{
  const root=await folder(t);await writeApplicationFixture(root);
  const first=await initializeApplication(root,{name:'便携电脑',workspace:root});assert.equal(first.initialized,true);
  const filename=path.join(root,'state/connector.json'),before=await fs.readFile(filename),config=JSON.parse(before);
  assert.equal(config.mode,'independent');assert.match(config.id,/^pc-[a-f0-9-]{36}$/);assert.equal(config.name,'便携电脑');
  await fs.writeFile(path.join(root,'state/browser-devices.json'),'private-browser-grant');
  assert.equal((await initializeApplication(root)).initialized,false);assert.deepEqual(await fs.readFile(filename),before);
  assert.equal(await fs.readFile(path.join(root,'state/browser-devices.json'),'utf8'),'private-browser-grant');
});
test('the application has internal service and manager entries and no console entry points',async t=>{
  const root=await folder(t);await writeApplicationFixture(root);await entries(root);
  assert.equal((await fs.readdir(root)).some(name=>/\.(cmd|bat|ps1)$/i.test(name)),false);
  const manager=await fs.readFile(path.join(root,'runtime/manager.ps1'),'utf8'),service=await fs.readFile(path.join(root,'runtime/service.ps1'),'utf8');
  assert.match(manager,/manager\.json/);assert.match(manager,/manager-ui\.ps1/);assert.match(service,/-WindowStyle Hidden/);
  assert.doesNotMatch(service,/Read-Host|archive|independent|repair|legacy/);
});
test('installation uses the same application layout without contacting an enrollment server',async t=>{
  const root=await folder(t),packageRoot=path.join(root,'package'),home=path.join(root,'application');await writeApplicationFixture(packageRoot);
  let launched=false;
  await install({home,name:'本机应用',workspace:root,packageRoot},{launchConnector:async()=>{launched=true;},managerOptions:{noShortcut:true}});
  assert.equal(launched,true);await fs.access(path.join(home,'CodexRemote.exe'));
  const config=JSON.parse(await fs.readFile(path.join(home,'state/connector.json'),'utf8'));assert.equal(config.name,'本机应用');assert.equal(config.server,undefined);
  assert.equal(await fs.access(path.join(home,'portable.json')).then(()=>true,()=>false),false);
  assert.equal((await fs.readdir(home)).some(name=>/\.cmd$/i.test(name)),false);
});
