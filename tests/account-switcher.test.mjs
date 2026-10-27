import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {accountSwitcherStatus,compatibleSwitcher,installAccountCompatibility,openAccountSwitcher,launchAccountDesktop} from '../src/account-switcher.mjs';
import {managerContext} from '../src/launcher-manager.mjs';

const original=`$Script:ProcNames = @('ChatGPT','codex','codex-code-mode-host')
function Stop-Codex {
    foreach ($n in $Script:ProcNames) { Get-Process -Name $n | Stop-Process -Force }
}
function Start-Codex {
    Start-Process 'explorer.exe' 'shell:AppsFolder\\official'
}
$btnSwitch.Add_Click({
    if ($lv.SelectedItems.Count -eq 0) { return }
    Stop-Codex
    Copy-Item $p.Path $Script:LiveAuth -Force
    Start-Codex
})
`;
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'account-compat-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  const context=managerContext({root:directory}),desktop=path.join(directory,'Desktop'),folder=path.join(desktop,'Codex');
  await fs.mkdir(folder,{recursive:true});const script=path.join(folder,'codex-switch.ps1');await fs.writeFile(script,'\ufeff'+original);
  return {context,desktop,folder,script};
}
test('compatibility backs up only launcher code and leaves existing account snapshots untouched',async t=>{
  const {context,desktop,folder,script}=await fixture(t);
  const accounts=path.join(folder,'accounts','saved');await fs.mkdir(accounts,{recursive:true});
  const credential=path.join(accounts,'auth.json');await fs.writeFile(credential,'private fixture account');
  const result=await installAccountCompatibility(context,{desktop});
  assert.equal(await fs.readFile(result.backup,'utf8'),'\ufeff'+original);
  assert.equal(await fs.readFile(credential,'utf8'),'private fixture account');
  const changed=await fs.readFile(script,'utf8');assert.match(changed,/Invoke-RemoteAccountLaunch -CheckOnly/);
  assert.match(changed,/WindowsApps\\OpenAI.Codex_/);assert.doesNotMatch(changed,/Get-Process -Name \$n|shell:AppsFolder/);
  assert.match(changed,/中断此电脑全部桌面任务/);assert.match(changed,/Button2/);
  assert.equal(compatibleSwitcher(changed),changed);
  assert.equal((await accountSwitcherStatus(context,{desktop})).integrated,true);
  assert.doesNotMatch(JSON.stringify(await accountSwitcherStatus(context,{desktop})),/private fixture account/);
  await installAccountCompatibility(context,{desktop});assert.equal(await fs.readFile(result.backup,'utf8'),'\ufeff'+original);
});
test('an unknown account tool is not overwritten, and opening a known one only opens its window',async t=>{
  const {context,desktop,script}=await fixture(t),calls=[];
  await openAccountSwitcher(context,{desktop,run:async(...args)=>{calls.push(args);return {stdout:''};}});
  assert.equal(calls.length,1);assert.match(calls[0][1].at(-1),/Start-Process/);
  assert.doesNotMatch(calls[0][1].at(-1),/Stop-Process|auth\.json/);
  await fs.writeFile(script,'custom tool');await assert.rejects(installAccountCompatibility(context,{desktop}),/版本不匹配/);
  assert.equal(await fs.readFile(script,'utf8'),'custom tool');
});
test('installed compatibility entry resolves the current OTA version instead of retaining a removed version',async t=>{
  const {context,desktop}=await fixture(t),home=path.join(context.root,'installed'),root=path.join(home,'versions','a'.repeat(20));
  const installed=managerContext({root,home});await fs.mkdir(home,{recursive:true});
  await installAccountCompatibility(installed,{desktop});
  const entry=await fs.readFile(path.join(home,'account-desktop-entry.ps1'),'utf8');
  assert.match(entry,/current\.json/);assert.match(entry,/\$PSScriptRoot/);assert.doesNotMatch(entry,new RegExp('a'.repeat(20)));
});
test('account desktop launch preserves service processes and uses package identity plus a new native connection',async t=>{
  const {context}=await fixture(t),endpoint=path.join(context.dataDir,'native-desktop.json');await fs.mkdir(context.dataDir,{recursive:true});
  await fs.writeFile(path.join(context.dataDir,'native-desktop-launch.json'),JSON.stringify({endpointFile:endpoint}));
  await fs.writeFile(path.join(context.dataDir,'codex-native-proxy.exe'),'fixture');await fs.writeFile(endpoint,JSON.stringify({pid:123}));
  const calls=[],options={run:async(...args)=>{calls.push(['inspect',...args]);return {stdout:'0'};},getAppRoot:async()=>path.join(context.root,'official'),refresh:async(...args)=>calls.push(['refresh',...args]),launch:async(...args)=>calls.push(['launch',...args]),probe:async(file,oldPid)=>{assert.equal(file,endpoint);assert.equal(oldPid,123);return true;}};
  await launchAccountDesktop(context,{...options,checkOnly:true});assert.equal(calls.length,0);
  const result=await launchAccountDesktop(context,options);assert.match(result.message,/已恢复/);
  assert.deepEqual(calls.map(call=>call[0]),['inspect','refresh','launch']);
  assert.doesNotMatch(calls[0][2].at(-1),/Stop-Process|taskkill/);
  assert.equal(calls[2][1].dataDir,context.dataDir);
  await assert.rejects(launchAccountDesktop(context,{...options,run:async()=>({stdout:'1'})}),/仍在运行/);
});
