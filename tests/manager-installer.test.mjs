import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {releaseSigningKey,signRelease} from '../src/connector-updates.mjs';
import {installManagerPackage} from '../src/install-manager-package.mjs';
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value));
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-exe-install-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const home=path.join(root,'installed'),packageRoot=path.join(root,'package'),version='a'.repeat(20),key=await releaseSigningKey(path.join(root,'publisher'));
  await fs.mkdir(path.join(packageRoot,'app'),{recursive:true});await fs.mkdir(path.join(packageRoot,'runtime'));await fs.writeFile(path.join(packageRoot,'app/manager-host.exe'),'MZfixture');await fs.writeFile(path.join(packageRoot,'runtime/node.exe'),'MZnode');
  await save(path.join(packageRoot,'release.json'),{version});
  const manifest={...signRelease({version,filename:'connector-'+version+'.zip',sha256:'a'.repeat(64),size:100,sequence:200},key),installerPublicKey:key.publicKey};
  await save(path.join(packageRoot,'.setup-manifest.json'),manifest);
  return {root,home,packageRoot,key,manifest,version};
}
test('the EXE repairs only the manager selection, preserving service version, credentials and existing files',async t=>{
  const f=await fixture(t),oldVersion='b'.repeat(20);await fs.mkdir(path.join(f.home,'state'),{recursive:true});
  const config='{"token":"private-fixture-token","name":"笔记本"}',authorization='fixture-paired-browsers';
  await save(path.join(f.home,'current.json'),{version:oldVersion});await fs.writeFile(path.join(f.home,'state/connector.json'),config);await fs.writeFile(path.join(f.home,'state/browser-devices.json'),authorization);
  const calls=[];
  const result=await installManagerPackage({...f,noShortcut:true},{installFresh:async()=>assert.fail('Must not reinstall existing computer'),writeEntries:async(home,options)=>{calls.push(options);await save(path.join(home,'manager.json'),{version:options.managerVersion});}});
  assert.equal(result.repaired,true);assert.equal(result.serviceVersion,oldVersion);assert.deepEqual(calls,[{managerVersion:f.version,noShortcut:true}]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.home,'current.json'),'utf8')).version,oldVersion);
  assert.equal(await fs.readFile(path.join(f.home,'state/connector.json'),'utf8'),config);assert.equal(await fs.readFile(path.join(f.home,'state/browser-devices.json'),'utf8'),authorization);
  assert.equal(await fs.readFile(path.join(f.home,'versions',f.version,'app/manager-host.exe'),'utf8'),'MZfixture');
  assert.doesNotMatch(JSON.stringify(result),/private-fixture-token|fixture-paired-browsers/);
});
test('foreign publishers and replayed installers cannot change an existing install',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.home,'state'),{recursive:true});await save(path.join(f.home,'current.json'),{version:'b'.repeat(20)});
  const foreign=await releaseSigningKey(path.join(f.root,'foreign'));
  await save(path.join(f.home,'state/update-source.json'),{publicKey:foreign.publicKey,sequence:0});
  await assert.rejects(installManagerPackage(f),/签名/);
  await save(path.join(f.home,'state/update-source.json'),{publicKey:f.key.publicKey,sequence:201});
  await assert.rejects(installManagerPackage(f),/较旧/);
  assert.equal(await fs.access(path.join(f.home,'manager.json')).then(()=>true,()=>false),false);
});
test('repair bootstraps GitHub updates for an old install without stopping its service or copying accounts',async t=>{
  const f=await fixture(t),old='b'.repeat(20);await fs.mkdir(path.join(f.home,'state'),{recursive:true});
  await save(path.join(f.home,'current.json'),{version:old});await save(path.join(f.home,'state/connector.json'),{mode:'independent',token:'private-fixture-token'});
  const updates={schema:1,kind:'github',repository:'example/remote',channel:'preview',publicKey:f.key.publicKey,sequence:f.manifest.sequence};
  await save(path.join(f.packageRoot,'release.json'),{version:f.version,updates});
  const written=[];
  await installManagerPackage(f,{writeEntries:async(_home,options)=>written.push(options),cleanup:async()=>({removed:[],skipped:[]})});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home,'state/update-source.json'),'utf8')),updates);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.home,'current.json'),'utf8')).version,old);assert.equal(written.length,1);
  await save(path.join(f.packageRoot,'release.json'),{version:f.version,updates:{...updates,sequence:f.manifest.sequence+1}});
  await assert.rejects(installManagerPackage(f,{writeEntries:async()=>assert.fail('Invalid source must fail before changes')}),/来源与发布签名不一致/);
});
test('a fresh EXE install uses the full independent installation without starting Codex or services',async t=>{
  const f=await fixture(t);let called=false;
  const result=await installManagerPackage({...f,noShortcut:true,mode:'fresh'},{installFresh:async(args,options)=>{called=true;assert.equal(args.mode,'independent');assert.equal(args.packageRoot,f.packageRoot);assert.equal(options.managerOptions.noShortcut,true);await options.launchConnector();}});
  assert.equal(called,true);assert.equal(result.installed,true);assert.match(result.executable,/CodexRemote\.exe$/);
});
test('default repair refuses missing installations without creating directories or enrolling a second computer',async t=>{
  const f=await fixture(t);
  await assert.rejects(installManagerPackage(f,{installFresh:async()=>assert.fail('Unexpected fresh install')}),/未找到已有安装/);
  assert.equal(await fs.access(f.home).then(()=>true,()=>false),false);
});
test('explicit first install refuses an already installed directory',async t=>{
  const f=await fixture(t);await fs.mkdir(f.home,{recursive:true});await save(path.join(f.home,'current.json'),{version:'b'.repeat(20)});
  await assert.rejects(installManagerPackage({...f,mode:'fresh'}),/此目录已有安装/);
});
