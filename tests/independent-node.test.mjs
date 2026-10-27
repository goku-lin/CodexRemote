import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createArchive} from '../src/connector-archive.mjs';
import {applyArchiveUpdate,entries,install,switchIndependent} from '../src/connector-client.mjs';
import {independentPort,independentService} from '../src/independent-node.mjs';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('an independent service uses its own stable port and has no upstream registration or lease',()=>{
  const service=independentService({app:'fixture-app',state:'fixture-state',version:'a'.repeat(20),config:{id:'fixture-device',name:'个人笔记本',cwd:'fixture-work',token:'fixture',server:'https://offline.fixture'}});
  assert.equal(service.env.PORT,'4317');assert.equal(service.env.HOST,'127.0.0.1');
  assert.equal(service.env.CODEX_RELAY_EXECUTION_NODE,'1');assert.equal(service.env.CODEX_RELAY_CONNECTION_MODE,'independent');
  assert.equal(service.env.CODEX_RELAY_LOCAL_DEVICE_ID,'fixture-device');
  assert.equal(service.env.CODEX_RELAY_SERVER,undefined);
  for(const port of [0,-1,65536,1.5,'wrong'])assert.throws(()=>independentPort(port));
});
test('offline ZIP updates preserve local authorization and queued work, and failed preparation retains the old version',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-independent-update-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  const old='1'.repeat(20),version='2'.repeat(20),state=path.join(directory,'state');await fs.mkdir(state);
  await fs.writeFile(path.join(directory,'current.json'),JSON.stringify({version:old}));
  const files={'connector.json':{mode:'independent',id:'fixture',token:'local-key',port:4317},'browser-devices.json':{devices:[{id:'phone'}]},'deliveries.json':{requests:{queued:{state:'queued'}}}};
  for(const [name,value] of Object.entries(files))await fs.writeFile(path.join(state,name),JSON.stringify(value));
  const archive=path.join(directory,'update.zip');await fs.writeFile(archive,createArchive([
    {name:'release.json',bytes:Buffer.from(JSON.stringify({version}))},
    {name:'runtime/node.exe',bytes:Buffer.from('MZfixture')},
    {name:'app/connector-client.mjs',bytes:Buffer.from('//fixture')}
  ]));
  await assert.rejects(()=>applyArchiveUpdate(directory,archive,{prepareVersion:async()=>{throw new Error('fixture preparation failure');}}),/failure/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'current.json'))).version,old);
  await applyArchiveUpdate(directory,archive,{prepareVersion:async()=>{}});
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'current.json'))).version,version);
  for(const [name,value] of Object.entries(files))assert.deepEqual(JSON.parse(await fs.readFile(path.join(state,name))),value);
  assert.ok(!(await fs.readdir(path.join(directory,'versions'))).some(name=>name.startsWith('.inspect-')));
  await entries(directory);
  const launcher=await fs.readFile(path.join(directory,'connector-entry.ps1'),'utf8');
  assert.ok(launcher.includes('--archive $archivePath'));assert.ok(launcher.includes('private-access.mjs'));assert.ok(launcher.includes('-WindowStyle Hidden'));
  for(const name of ['启动.cmd','打开控制网页.cmd','配置外网入口.cmd','切换独立连接.cmd'])await fs.access(path.join(directory,name));
  if(process.platform==='win32'){
    const parser=path.join(directory,'parse-entry.ps1');
    await fs.writeFile(parser,String.raw`param([string]$ScriptPath)
$scriptTokens = $null; $scriptErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$scriptTokens, [ref]$scriptErrors)
if ($scriptErrors.Count) { $scriptErrors | ForEach-Object { Write-Output $_.Message }; exit 1 }
`);
    for(const script of [path.join(directory,'connector-entry.ps1'),fileURLToPath(new URL('../scripts/connector-bootstrap.ps1',import.meta.url))])await promisify(execFile)('powershell.exe',['-NoProfile','-File',parser,script],{windowsHide:true,timeout:10000});
  }
});

for(const scenario of ['closed','running','unconnected','legacy','auto'])test('daily Windows startup: '+scenario,{skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-daily-start-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  const version='a'.repeat(20),state=path.join(directory,'state');await fs.mkdir(state);
  await fs.writeFile(path.join(directory,'current.json'),JSON.stringify({version}));
  await fs.writeFile(path.join(state,'connector.json'),JSON.stringify({mode:scenario==='legacy' ? 'relay' : 'independent',id:'pc-startup-fixture',port:4321,server:'https://old-hub.fixture',name:'fixture'}));
  await entries(directory);
  if(scenario==='auto'){
    await fs.mkdir(path.join(directory,'versions',version,'runtime'),{recursive:true});await fs.mkdir(path.join(directory,'versions',version,'app'));
    await fs.copyFile(process.execPath,path.join(directory,'versions',version,'runtime','node.exe'));
    await fs.writeFile(path.join(directory,'state','update-source.json'),'{}');
    await fs.writeFile(path.join(directory,'versions',version,'app','connector-client.mjs'),`import fs from 'node:fs';import path from 'node:path';if(process.argv[2]!=='auto-update')throw new Error('unexpected action');const home=process.argv[process.argv.indexOf('--home')+1];fs.appendFileSync(path.join(home,'calls.txt'),'auto-update\\n');fs.writeFileSync(path.join(home,'current.json'),JSON.stringify({version:'${'b'.repeat(20)}'}));`);
  }
  const start=await fs.readFile(path.join(directory,'启动.cmd'),'utf8');assert.ok(start.includes('connector-entry.ps1" launch'));
  const compatible=await fs.readFile(path.join(directory,'打开Codex远程连接.cmd'),'utf8');assert.equal(compatible,start);
  const script=path.join(directory,'verify-start.ps1');
  await fs.writeFile(script,'\ufeff'+String.raw`param([string]$FixtureScenario)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$global:fixtureCalls = Join-Path $PSScriptRoot 'calls.txt'
function Record-Fixture([string]$Message) { Add-Content -LiteralPath $global:fixtureCalls -Value $Message -Encoding UTF8 }
function global:powershell.exe {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ToolArguments)
  $fileIndex = [Array]::IndexOf($ToolArguments, '-File')
  if ($fileIndex -lt 0) { throw 'unexpected tool call' }
  $calledScript = $ToolArguments[$fileIndex + 1]
  if ($calledScript -like '*connector-entry.ps1' -and $ToolArguments[-1] -eq 'start') { Record-Fixture 'service-start' }
  elseif ($calledScript -like '*打开原生桌面连接.ps1') {
    if ($FixtureScenario -eq 'auto' -and $calledScript -notlike '*bbbbbbbbbbbbbbbbbbbb*') { throw 'startup used the old version after update' }
    Record-Fixture 'desktop-start'
  }
  else { throw 'unexpected subprocess' }
  $global:LASTEXITCODE = 0
}
function global:Get-Process {
  param([string]$Name,[string]$ErrorAction)
  if ($FixtureScenario -in @('running','unconnected')) { [pscustomobject]@{Path='C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'} }
}
function global:Invoke-RestMethod {
  param([string]$Uri,[int]$TimeoutSec)
  if ($Uri.EndsWith('/api/devices')) { Record-Fixture 'service-ready'; return @{devices=@(@{id='pc-startup-fixture'})} }
  if ($Uri.EndsWith('/api/health')) { Record-Fixture 'desktop-health'; return @{desktop=@{state=$(if ($FixtureScenario -eq 'unconnected') { 'offline' } else { 'ready' })}} }
  throw 'unexpected network request'
}
function global:Start-Process { param([string]$FilePath) Record-Fixture ('browser:' + $FilePath) }
& (Join-Path $PSScriptRoot 'connector-entry.ps1') launch
exit $LASTEXITCODE
`);
  let result;
  try{result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,scenario],{windowsHide:true,timeout:10000});}
  catch(error){if(scenario!=='unconnected')throw error;assert.equal(error.code,1);result=error;}
  const calls=(await fs.readFile(path.join(directory,'calls.txt'),'utf8')).replace(/^\ufeff/,'').trim().split(/\r?\n/);
  assert.equal(calls[0],scenario==='auto' ? 'auto-update' : 'service-start');
  assert.equal(calls.filter(call=>call==='desktop-start').length,['closed','legacy','auto'].includes(scenario) ? 1 : 0);
  assert.equal(calls.at(-1),scenario==='legacy' ? 'browser:https://old-hub.fixture/?health=1' : 'browser:http://127.0.0.1:4321/?health=1');
  if(scenario==='unconnected'){assert.equal(result.code,1);assert.ok(result.stdout.includes('请保留错误提示反馈'));}
  if(scenario!=='legacy')assert.ok(calls.indexOf('service-ready')<calls.indexOf('desktop-health'));
});

test('a new independent installation works with no enrollment server or connection code',{skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-independent-install-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  const packageRoot=path.join(directory,'package'),home=path.join(directory,'home'),version='a'.repeat(20);
  await fs.mkdir(path.join(packageRoot,'app'),{recursive:true});await fs.mkdir(path.join(packageRoot,'runtime'));
  await fs.writeFile(path.join(packageRoot,'release.json'),JSON.stringify({version}));await fs.writeFile(path.join(packageRoot,'runtime','node.exe'),'MZfixture');
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('independent installation must not contact a server');};t.after(()=>globalThis.fetch=originalFetch);
  let prepared=false,launched=false;
  await install({home,name:'个人笔记本',workspace:directory,packageRoot},{prepareVersion:async()=>{prepared=true;},launchConnector:async()=>{launched=true;}});
  assert.ok(prepared && launched);
  const config=JSON.parse(await fs.readFile(path.join(home,'state','connector.json')));
  assert.equal(config.mode,'independent');assert.equal(config.port,4317);assert.equal(config.server,undefined);
  assert.match(config.id,/^pc-[a-f0-9-]{36}$/);assert.match(config.token,/^[a-f0-9]{64}$/);
});

test('migration preserves task and browser data, rotates the upstream-issued credential, and refuses an occupied port',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-independent-migrate-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  const version='a'.repeat(20),state=path.join(directory,'state');await fs.mkdir(state);
  const config={id:'pc-fixture',name:'笔记本',cwd:directory,token:'b'.repeat(64),server:'https://old-hub.fixture'};
  await fs.writeFile(path.join(directory,'current.json'),JSON.stringify({version}));await fs.writeFile(path.join(state,'connector.json'),JSON.stringify(config));
  await fs.writeFile(path.join(state,'browser-devices.json'),'browser-grants-fixture');await fs.writeFile(path.join(state,'deliveries.json'),'queued-task-fixture');
  const blocker=createServer();await new Promise(resolve=>blocker.listen(0,'0.0.0.0',resolve));const port=blocker.address().port;
  let stopped=false,launched=false;
  const options={port,stopRunning:async old=>{assert.deepEqual(old,config);stopped=true;},launchConnector:async()=>{launched=true;}};
  await assert.rejects(()=>switchIndependent(directory,options),/占用/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state,'connector.json'))),config);assert.equal(stopped,false);
  await new Promise(resolve=>blocker.close(resolve));
  await switchIndependent(directory,options);assert.ok(stopped && launched);
  const migrated=JSON.parse(await fs.readFile(path.join(state,'connector.json')));
  assert.equal(migrated.id,config.id);assert.equal(migrated.mode,'independent');assert.equal(migrated.server,undefined);assert.notEqual(migrated.token,config.token);
  assert.equal(await fs.readFile(path.join(state,'browser-devices.json'),'utf8'),'browser-grants-fixture');assert.equal(await fs.readFile(path.join(state,'deliveries.json'),'utf8'),'queued-task-fixture');
});
