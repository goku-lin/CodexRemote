import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {releaseSigningKey,signRelease} from '../src/connector-updates.mjs';
import {installManagerPackage} from '../src/install-manager-package.mjs';
import {writeApplicationFixture} from './application-fixture.mjs';
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value));
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'application-installer-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));return fs.rm(root,{recursive:true,force:true});});
  const home=path.join(root,'installed'),packageRoot=path.join(root,'package'),version='a'.repeat(20),key=await releaseSigningKey(path.join(root,'publisher'));
  await writeApplicationFixture(packageRoot,{version});
  const manifest={...signRelease({version,filename:'CodexRemote-Portable-v0.2.0-win-x64.zip',sha256:'a'.repeat(64),size:100,sequence:200},key),installerPublicKey:key.publicKey};
  await save(path.join(packageRoot,'.setup-manifest.json'),manifest);
  return {root,home,packageRoot,key,manifest,version};
}
async function existing(f){
  await writeApplicationFixture(f.home,{version:'b'.repeat(20)});await fs.mkdir(path.join(f.home,'state'));
  await save(path.join(f.home,'state/connector.json'),{mode:'independent',id:'fixture',token:'private-fixture-token',cwd:f.root});
  await fs.writeFile(path.join(f.home,'state/browser-devices.json'),'private-browser-grant');
}
const dependencies={busy:async()=>false,writeEntries:async home=>save(path.join(home,'manager.json'),JSON.parse(await fs.readFile(path.join(home,'current.json'),'utf8'))),
  activate:async(home,before,apply,options)=>{await apply();await options.refresh();return true;}};
test('one setup action installs a missing application without a fresh/repair mode or starting services',async t=>{
  const f=await fixture(t);let called=false;
  const result=await installManagerPackage(f,{installFresh:async(args,options)=>{called=true;assert.equal(args.home,f.home);assert.equal(args.mode,undefined);await options.launchConnector();}});
  assert.equal(called,true);assert.equal(result.installed,true);assert.equal(result.executable,path.join(f.home,'CodexRemote.exe'));
});
test('one setup action upgrades both application and service selections while preserving credentials and pairing',async t=>{
  const f=await fixture(t);await existing(f);
  const before=await fs.readFile(path.join(f.home,'state/connector.json'));
  const result=await installManagerPackage(f,dependencies);
  assert.equal(result.upgraded,true);
  for(const name of ['current.json','manager.json'])assert.equal(JSON.parse(await fs.readFile(path.join(f.home,name),'utf8')).version,f.version);
  assert.deepEqual(await fs.readFile(path.join(f.home,'state/connector.json')),before);
  assert.equal(await fs.readFile(path.join(f.home,'state/browser-devices.json'),'utf8'),'private-browser-grant');
  assert.doesNotMatch(JSON.stringify(result),/private-fixture-token|private-browser-grant|repair/);
});
test('running or unanswered tasks stop installation before changing application files',async t=>{
  const f=await fixture(t);await existing(f);
  await assert.rejects(installManagerPackage(f,{...dependencies,busy:async()=>true}),/任务结束后更新/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.home,'current.json'),'utf8')).version,'b'.repeat(20));
  assert.equal(await fs.access(path.join(f.home,'versions',f.version)).then(()=>true,()=>false),false);
});
test('foreign publishers and replayed installers cannot change an existing application',async t=>{
  const f=await fixture(t);await existing(f);const foreign=await releaseSigningKey(path.join(f.root,'foreign'));
  await save(path.join(f.home,'state/update-source.json'),{publicKey:foreign.publicKey,sequence:0});
  await assert.rejects(installManagerPackage(f,dependencies),/签名/);
  await save(path.join(f.home,'state/update-source.json'),{publicKey:f.key.publicKey,sequence:201});
  await assert.rejects(installManagerPackage(f,dependencies),/较旧/);
});
test('upgrading remembers the signed public update source',async t=>{
  const f=await fixture(t);await existing(f);
  const updates={schema:1,kind:'github',repository:'example/remote',channel:'preview',publicKey:f.key.publicKey,sequence:200};
  await save(path.join(f.packageRoot,'release.json'),{version:f.version,updates});
  await installManagerPackage(f,dependencies);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home,'state/update-source.json'),'utf8')),updates);
});
test('setup does not turn an unrelated nonempty directory into an application',async t=>{
  const f=await fixture(t);await fs.mkdir(f.home);await fs.writeFile(path.join(f.home,'personal.txt'),'keep');
  await assert.rejects(installManagerPackage(f),/不是空目录/);
  assert.equal(await fs.readFile(path.join(f.home,'personal.txt'),'utf8'),'keep');
});
