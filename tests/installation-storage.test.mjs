import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {reuseRuntime,recordManagedRelease,cleanupManagedReleases,runningInstallationReferences} from '../src/installation-storage.mjs';
async function fixture(t){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'codex-storage-'));
  t.after(async()=>{assert.equal(path.dirname(home),path.resolve(os.tmpdir()));await fs.rm(home,{recursive:true,force:true});});
  await fs.mkdir(path.join(home,'versions'));
  const add=async(letter,{managed=true}={})=>{
    const version=letter.repeat(20),directory=path.join(home,'versions',version);
    await fs.mkdir(path.join(directory,'app'),{recursive:true});await fs.mkdir(path.join(directory,'runtime'));
    await fs.writeFile(path.join(directory,'release.json'),JSON.stringify({version}));await fs.writeFile(path.join(directory,'app/entry.mjs'),'fixture');await fs.writeFile(path.join(directory,'runtime/node.exe'),'MZfixture-runtime');
    if(managed)await recordManagedRelease(directory);
    return {version,directory};
  };
  const select=async(current,manager=current)=>{await fs.writeFile(path.join(home,'current.json'),JSON.stringify({version:current.version}));await fs.writeFile(path.join(home,'manager.json'),JSON.stringify({version:manager.version}));};
  return {home,add,select};
}
const idle=async()=>({versions:[],hosts:[]});
test('identical immutable runtimes share the same file while different runtime bytes remain intact',async t=>{
  const f=await fixture(t),a=await f.add('a'),b=await f.add('b');
  const result=await reuseRuntime(f.home,b.directory);assert.ok(result.sharedRuntimeBytes>0);
  const first=await fs.stat(path.join(a.directory,'runtime/node.exe')),second=await fs.stat(path.join(b.directory,'runtime/node.exe'));
  assert.equal(first.ino,second.ino);assert.ok(first.nlink>=2);
  const c=await f.add('c');await fs.writeFile(path.join(c.directory,'runtime/node.exe'),'MZdifferent');
  assert.equal((await reuseRuntime(f.home,c.directory)).sharedRuntimeBytes,0);
  assert.equal(await fs.readFile(path.join(c.directory,'runtime/node.exe'),'utf8'),'MZdifferent');
});
test('cleanup preserves current service, manager, explicit rollback, active processes and unrecognized legacy folders',async t=>{
  const f=await fixture(t),a=await f.add('a'),b=await f.add('b'),c=await f.add('c'),d=await f.add('d'),e=await f.add('e'),legacy=await f.add('f',{managed:false});await f.select(a,b);
  const result=await cleanupManagedReleases(f.home,{keep:[c.version],references:async()=>({versions:[d.version],hosts:[]})});
  assert.deepEqual(result.removed,[e.version]);
  for(const item of [a,b,c,d,legacy])await fs.access(item.directory);
});
test('cleanup retains one rollback, leaves modified files and never touches state or unrelated directories',async t=>{
  const f=await fixture(t),a=await f.add('a'),b=await f.add('b'),c=await f.add('c'),d=await f.add('d');await f.select(a);
  await fs.utimes(path.join(b.directory,'release.json'),new Date(2000000000000),new Date(2000000000000));
  await fs.writeFile(path.join(c.directory,'app/user-data.txt'),'must keep');
  await fs.mkdir(path.join(f.home,'state'));await fs.writeFile(path.join(f.home,'state/password.json'),'keep credentials');
  await fs.mkdir(path.join(f.home,'versions/unrecognized'));await fs.writeFile(path.join(f.home,'versions/unrecognized/data'),'keep');
  const result=await cleanupManagedReleases(f.home,{references:idle});assert.deepEqual(result.removed,[d.version]);
  await fs.access(b.directory);await fs.access(c.directory);assert.equal(await fs.readFile(path.join(f.home,'state/password.json'),'utf8'),'keep credentials');await fs.access(path.join(f.home,'versions/unrecognized/data'));
});
test('missing process inventory and newly active processes prevent deletion',async t=>{
  const f=await fixture(t),a=await f.add('a'),b=await f.add('b');await f.select(a);
  assert.equal((await cleanupManagedReleases(f.home,{keep:[a.version],references:async()=>{throw new Error('unavailable');}})).removed.length,0);await fs.access(b.directory);
  let calls=0;
  assert.equal((await cleanupManagedReleases(f.home,{keep:[a.version],references:async()=>({versions:++calls>1?[b.version]:[],hosts:[]})})).removed.length,0);await fs.access(b.directory);
});
test('cleanup refuses directory junctions outside the installation',async t=>{
  const f=await fixture(t),other=await fs.mkdtemp(path.join(os.tmpdir(),'codex-storage-outside-'));
  t.after(async()=>{assert.equal(path.dirname(other),path.resolve(os.tmpdir()));await fs.rm(other,{recursive:true,force:true});});
  const a=await f.add('a');await f.select(a);await fs.writeFile(path.join(other,'untouched'),'data');
  await fs.symlink(other,path.join(f.home,'versions','b'.repeat(20)),process.platform==='win32'?'junction':'dir');
  await cleanupManagedReleases(f.home,{keep:[a.version],references:idle});assert.equal(await fs.readFile(path.join(other,'untouched'),'utf8'),'data');
});
test('Windows process inventory recognizes a real running version without returning command arguments',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),a=await f.add('a');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',path.join(a.directory,'app/entry.mjs')],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  t.after(async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;});
  let result;
  try{result=await runningInstallationReferences(f.home);}catch(error){
    if(/Process inventory incomplete/.test(error.stderr||'')){t.skip('Windows hides process details; production cleanup correctly refuses to delete');return;}
    throw error;
  }
  assert.ok(result.versions.includes(a.version));assert.deepEqual(Object.keys(result),['versions']);
});
