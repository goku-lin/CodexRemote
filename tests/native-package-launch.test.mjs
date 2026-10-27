import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsArgument,launchInPackage,desktopPackageInfo} from '../src/native-package-launch.mjs';
const execute=promisify(execFile),packageInfo={familyName:'Fixture.App_test',fullName:'Fixture.App_1.0_x64_test',appId:'App'};
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'relay packaged launch 含空格 '));t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return rm(directory,{recursive:true,force:true});});return directory;}
async function requestIn(directory){const name=(await readdir(directory)).find(name=>/^package-launch-[a-f0-9-]+\.json$/.test(name));return JSON.parse(await readFile(path.join(directory,name),'utf8'));}

test('Windows argument quoting preserves spaces, quotes and trailing backslashes',()=>{
  assert.equal(windowsArgument('a b'),'"a b"');assert.equal(windowsArgument('a"b'),'"a\\"b"');assert.equal(windowsArgument('D:\\path\\'),'"D:\\path\\\\"');assert.equal(windowsArgument('中文'),'"中文"');
});

test('CLI path normalization accepts connector-relative paths before package activation',()=>{
  const source=readFileSync('src/native-package-launch.mjs','utf8');
  assert.match(source,/const appRoot=path\.resolve\(rawAppRoot\)/);
  assert.match(source,/proxy=path\.resolve\(rawProxy\)/);
  assert.match(source,/dataDir=path\.resolve\(rawDataDir\)/);
});
test('packaged activation passes explicit per-process environment and never forces tool descendants into package context',async t=>{
  const dataDir=await fixture(t),before=process.env.CODEX_CLI_PATH;let request;
  const result=await launchInPackage({packageInfo,dataDir,executable:'fixture.exe',environment:{CODEX_CLI_PATH:'fixture-proxy',CODEX_RELAY_DATA_DIR:dataDir}},{helper:'helper.exe',run:async(file,args,options)=>{
    assert.equal(file,'powershell.exe');assert.equal(options.windowsHide,true);
    const command=args.at(-1);assert.match(command,/Invoke-CommandInDesktopPackage/);assert.doesNotMatch(command,/-PreventBreakaway|Start-Process|Stop-Process/);
    request=await requestIn(dataDir);await writeFile(request.receiptFile,JSON.stringify({version:1,ok:true,processId:123,packageFullName:packageInfo.fullName}));return {stdout:''};
  }});
  assert.equal(result.processId,123);assert.equal(request.environment.CODEX_CLI_PATH,'fixture-proxy');assert.equal(request.environment.CODEX_RELAY_DATA_DIR,dataDir);assert.deepEqual(await readdir(dataDir),[]);assert.equal(process.env.CODEX_CLI_PATH,before);
});
test('wrong identity and rejected activation fail without falling back to an ordinary executable launch',async t=>{
  const dataDir=await fixture(t);let calls=0;
  await assert.rejects(launchInPackage({packageInfo,dataDir,executable:'fixture.exe'},{helper:'helper.exe',run:async()=>{calls++;const request=await requestIn(dataDir);await writeFile(request.receiptFile,JSON.stringify({version:1,ok:true,processId:123,packageFullName:'other'}));}}),/Windows 应用身份/);
  assert.equal(calls,1);assert.deepEqual(await readdir(dataDir),[]);
  await assert.rejects(launchInPackage({packageInfo,dataDir,executable:'fixture.exe'},{helper:'helper.exe',run:async()=>{calls++;throw new Error('activation denied');}}),/activation denied/);assert.equal(calls,2);
  await assert.rejects(launchInPackage({packageInfo:{...packageInfo,appId:"App'; bad"},dataDir,executable:'fixture.exe'},{run:async()=>{throw new Error('must not run');}}),/身份无效/);
});
test('the app ID is selected from the installed manifest instead of assuming an entry name',async t=>{
  const directory=await fixture(t);await writeFile(path.join(directory,'AppxManifest.xml'),'<Package><Applications><Application Id="Other" Executable="other.exe" /><Application Id="ActualApp" Executable="app/ChatGPT.exe" /></Applications></Package>');
  const info=await desktopPackageInfo(directory,{run:async(_file,args)=>{assert.ok(args.at(-1).includes(directory));return {stdout:JSON.stringify({PackageFamilyName:packageInfo.familyName,PackageFullName:packageInfo.fullName})};}});
  assert.deepEqual(info,{...packageInfo,appId:'ActualApp'});
});
test('actual Windows package activation retains GUI identity and proxy env while grandchildren use normal Windows behavior',{skip:process.platform!=='win32',timeout:25000},async t=>{
  let installed;try{installed=JSON.parse((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-AppxPackage 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1 -ExpandProperty InstallLocation | ConvertTo-Json -Compress"],{windowsHide:true,timeout:8000})).stdout.trim()||'null');}catch{return t.skip('Installed desktop package unavailable');}
  if(!installed)return t.skip('Installed desktop package unavailable');
  const dataDir=await fixture(t),probe=path.join(dataDir,'package probe.exe'),receipt=path.join(dataDir,'probe-result.json');
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  await execute(compiler,['/nologo','/target:winexe','/r:System.Web.Extensions.dll','/out:'+probe,path.resolve('tests/package-context-probe.cs')],{windowsHide:true,timeout:15000});
  const info=await desktopPackageInfo(installed),result=await launchInPackage({packageInfo:info,dataDir,executable:probe,arguments:[receipt,'child'],environment:{CODEX_CLI_PATH:'fixture proxy 中文.exe',CODEX_RELAY_DATA_DIR:'fixture-data'}});
  assert.equal(result.packageFullName,info.fullName);
  for(let i=0;i<60;i++){
    try{const value=JSON.parse(await readFile(receipt,'utf8'));assert.equal(value.packageCode,0);assert.equal(value.packageFullName,info.fullName);assert.equal(value.proxy,'fixture proxy 中文.exe');assert.equal(value.data,'fixture-data');assert.equal(value.grandchild.packageCode,15700,'tool grandchildren must not be forced into the app package');assert.equal(value.grandchild.proxy,'fixture proxy 中文.exe');return;}
    catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,100));}
  }
  assert.fail('Probe did not finish');
});
