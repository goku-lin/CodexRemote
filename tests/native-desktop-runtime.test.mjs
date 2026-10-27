import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {desktopRuntimePath,refreshDesktopRuntime} from '../src/native-desktop-runtime.mjs';

async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay desktop runtime 含空格 '));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return rm(directory,{recursive:true,force:true});});
  const app=async(version,bytes='MZfixture')=>{
    const root=path.join(directory,version),file=path.join(root,'app','resources','codex.exe');
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);return {root,file};
  };
  const config=path.join(directory,'native-desktop-launch.json'),endpoint=path.join(directory,'native-desktop.json');
  await writeFile(endpoint,'existing live connection record');
  await writeFile(config,JSON.stringify({cliPath:path.join(directory,'old-cache','codex.exe'),endpointFile:endpoint,custom:'keep'}));
  return {directory,app,config,endpoint};
}

test('bridge uses the CLI in the selected desktop package rather than the saved relocated cache',async t=>{
  const f=await fixture(t),current=await f.app('current desktop');
  const value=await refreshDesktopRuntime(f.config,current.root,{run:async(file,args,options)=>{
    assert.equal(file,current.file);assert.deepEqual(args,['--version']);assert.equal(options.windowsHide,true);
    return {stdout:'codex-cli 0.162.0-new\n'};
  }});
  assert.equal(value.cliPath,current.file);assert.equal(value.cliVersion,'codex-cli 0.162.0-new');
  assert.equal(value.custom,'keep');assert.equal(value.endpointFile,f.endpoint);
  assert.equal(await readFile(f.endpoint,'utf8'),'existing live connection record');
  assert.deepEqual(JSON.parse(await readFile(f.config,'utf8')),value);
});

test('the next launch follows a desktop app update without requiring a new connector release',async t=>{
  const f=await fixture(t),old=await f.app('old desktop'),current=await f.app('updated desktop');
  const run=async()=>({stdout:'codex-cli fixture\n'});
  await refreshDesktopRuntime(f.config,old.root,{run});
  await refreshDesktopRuntime(f.config,current.root,{run});
  assert.equal(JSON.parse(await readFile(f.config,'utf8')).cliPath,current.file);
  assert.equal(await readFile(f.endpoint,'utf8'),'existing live connection record');
});

test('an unavailable or broken current desktop runtime leaves the previous configuration intact',async t=>{
  const f=await fixture(t),invalid=await f.app('broken desktop','not a Windows executable');
  const before=await readFile(f.config,'utf8');
  await assert.rejects(desktopRuntimePath(invalid.root),/运行程序缺失或无效/);
  const current=await f.app('current desktop');
  await assert.rejects(refreshDesktopRuntime(f.config,current.root,{run:async()=>{throw new Error('fixture runtime failed');}}),/fixture runtime failed/);
  await assert.rejects(refreshDesktopRuntime(f.config,current.root,{run:async()=>({stdout:'unexpected output'})}),/运行程序验证失败/);
  assert.equal(await readFile(f.config,'utf8'),before);
});

test('older desktop layouts can use their own unpacked CLI without consulting unrelated caches',async t=>{
  const f=await fixture(t),root=path.join(f.directory,'unpacked desktop'),file=path.join(root,'app','resources','app.asar.unpacked','codex.exe');
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'MZfixture');
  assert.equal(await desktopRuntimePath(root),file);
});
