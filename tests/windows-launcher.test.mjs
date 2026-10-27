import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';

const exec=promisify(execFile),windows=process.platform==='win32';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
async function fixture(t,{existing=false,recoveryFails=false,nativeReady=!existing,readyAfterHealthReads=Infinity,backgroundOnly=false,pending=false,appToolsAvailable=true}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay launcher 含空格 '));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  for(const name of ['scripts','src','.relay-data','installed/app'])await mkdir(path.join(directory,name),{recursive:true});
  const receipt=path.join(directory,'launch-receipt.json'),requests=[];
  const runtime={nativeControlsRevision:3,connectorRevision:2,connectorUpdateRevision:1,chatgptRevision:2,remoteBrowserRevision:3,chatgptAppToolsAvailable:appToolsAvailable,threadSyncRevision:1,historySyncRevision:3,mediaRevision:1,readStateRevision:3,historicalUsageRevision:2};
  const health={checking:false,relay:{state:'ready',message:'fixture relay ready'},runner:{state:'ready',message:'fixture runner ready'},desktop:{state:'offline',message:'fixture desktop offline'},tailscale:{state:'disabled'},external:{state:'disabled'}};
  let healthReads=0;
  const server=createServer((req,res)=>{
    requests.push(req.url);res.setHeader('Content-Type','application/json');
    if(recoveryFails && req.url==='/api/health/recover'){res.statusCode=500;res.end('{}');return;}
    if(req.url==='/api/health' && ++healthReads>readyAfterHealthReads)health.desktop={state:'ready',message:'fixture native desktop ready'};
    res.end(JSON.stringify(req.url==='/api/runtime' ? runtime : req.url==='/api/sessions' ? {sessions:pending ? [{status:'waiting_input',executionOwner:'desktop'}] : []} : health));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  const forbiddenQueries="function Get-NetTCPConnection { throw 'Unexpected blocking TCP query' }\r\nfunction Get-CimInstance { throw 'Unexpected blocking CIM query' }\r\n";
  const service=(await readFile(new URL('../scripts/启动远程服务.ps1',import.meta.url),'utf8')).replace(/^\ufeff/,'').replaceAll('http://127.0.0.1:4317',base);
  const paramEnd=service.indexOf('\n')+1;
  await writeFile(path.join(directory,'scripts','启动远程服务.ps1'),'\ufeff'+service.slice(0,paramEnd)+forbiddenQueries+service.slice(paramEnd));
  for(const name of ['启动项目.ps1','打开原生桌面连接.ps1','更新Relay后台.ps1']){
    const source=(await readFile(new URL('../scripts/'+name,import.meta.url),'utf8')).replaceAll('http://127.0.0.1:4317',base).replace('$syncDeadline = [DateTime]::UtcNow.AddSeconds(20)','$syncDeadline = [DateTime]::UtcNow.AddMilliseconds(300)');
    await writeFile(path.join(directory,'scripts',name),source);
  }
  await writeFile(path.join(directory,'.relay-data','codex-native-proxy.exe'),'not executed: launch is intercepted by the fixture');
  await writeFile(path.join(directory,'src','native-desktop-status.mjs'),`process.exit(${nativeReady ? 0 : 1});`);
  await writeFile(path.join(directory,'src','native-desktop-runtime.mjs'),`if(process.argv[process.argv.indexOf('--app-root')+1]!==${JSON.stringify(path.join(directory,'installed'))})throw new Error('runtime check did not use the selected app package');`);
  await writeFile(path.join(directory,'src','native-package-launch.mjs'),`import fs from 'node:fs';const value=flag=>process.argv[process.argv.indexOf(flag)+1];if(value('--app-root')!==${JSON.stringify(path.join(directory,'installed'))})throw new Error('package launch did not use the selected app');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({path:value('--app-root')+'/app/ChatGPT.exe',proxy:value('--proxy'),launchMethod:'windows-package',parentCli:process.env.CODEX_CLI_PATH}));`);
  const wrapper=path.join(directory,'fixture.ps1');
  const mocks=[
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `function Get-Process { ${existing ? "[pscustomobject]@{Path='C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture\\app\\ChatGPT.exe'}" : ''} }`,
    `function Get-AppxPackage { [pscustomobject]@{InstallLocation=${quote(path.join(directory,'installed'))}} }`,
    forbiddenQueries,
    `function Start-Process { param($FilePath,$WindowStyle) if ($FilePath -ne ${quote(path.join(directory,'installed','app','ChatGPT.exe'))}) { throw 'Unexpected app launch' }; [pscustomobject]@{path=$FilePath;windowStyle=$WindowStyle;proxy=$env:CODEX_CLI_PATH} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(receipt)} -Encoding UTF8 }`,
    "$env:CODEX_CLI_PATH = 'original-fixture-cli'",
    `& ${quote(path.join(directory,'scripts',backgroundOnly ? '更新Relay后台.ps1' : existing ? '启动项目.ps1' : '打开原生桌面连接.ps1'))}${existing && !backgroundOnly ? ' -NoBrowser' : ''}`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    "if ($env:CODEX_CLI_PATH -ne 'original-fixture-cli') { throw 'CLI override was not restored' }",
    ''
  ].join('\r\n');
  await writeFile(wrapper,'\ufeff'+mocks);
  return {directory,receipt,requests,run:()=>exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper],{windowsHide:true,timeout:10000,maxBuffer:100000})};
}

test('native startup reaches the proxy launch with an existing healthy Relay even when Windows network queries fail',{skip:!windows},async t=>{
  const f=await fixture(t),result=await f.run();
  const receipt=JSON.parse((await readFile(f.receipt,'utf8')).replace(/^\ufeff/,''));
  assert.equal(await realpath(receipt.proxy),await realpath(path.join(f.directory,'.relay-data','codex-native-proxy.exe')));
  assert.equal(receipt.launchMethod,'windows-package');
  assert.equal(receipt.parentCli,'original-fixture-cli');
  assert.match(result.stdout,/桌面原生连接已接通/);
  assert.ok(f.requests.includes('/api/runtime') && f.requests.includes('/api/health/recover'));
});

test('missing optional desktop app-tools cannot reject or replace a running Relay during startup',{skip:!windows},async t=>{
  const f=await fixture(t,{appToolsAvailable:false}),result=await f.run();
  assert.match(result.stdout,/桌面原生连接已接通/);
  assert.ok(f.requests.includes('/api/runtime'));
});

test('background-only update never launches Desktop and refuses to interrupt a pending request',{skip:!windows},async t=>{
  const ready=await fixture(t,{backgroundOnly:true}),result=await ready.run();
  assert.match(result.stdout,/Relay 后台已更新/);assert.ok(ready.requests.includes('/api/health/recover'));await assert.rejects(access(ready.receipt),{code:'ENOENT'});
  const waiting=await fixture(t,{backgroundOnly:true,pending:true});
  await assert.rejects(waiting.run(),error=>error.code===1 && /待回答或待审批/.test(error.stdout));
  assert.equal(waiting.requests.includes('/api/health/recover'),false);await assert.rejects(access(waiting.receipt),{code:'ENOENT'});
});

test('ordinary Desktop already running without the proxy is reported as an incomplete startup and is never relaunched',{skip:!windows},async t=>{
  const f=await fixture(t,{existing:true});
  await assert.rejects(f.run(),error=>error.code===1 && /当前 Codex 桌面未接通远程控制/.test(error.stdout));
  await assert.rejects(access(f.receipt),{code:'ENOENT'});
});

test('native Desktop is not launched if the Relay readiness step fails',{skip:!windows},async t=>{
  const f=await fixture(t,{recoveryFails:true});
  await assert.rejects(f.run(),error=>/Relay 后台启动失败/.test(error.stderr));
  await assert.rejects(access(f.receipt),{code:'ENOENT'});
});

test('a connected native Desktop waits for delayed Runner health without restarting Desktop',{skip:!windows},async t=>{
  const f=await fixture(t,{existing:true,nativeReady:true,readyAfterHealthReads:3}),result=await f.run();
  assert.match(result.stdout,/正在等待后台同步/);
  assert.match(result.stdout,/服务与 Codex 桌面已就绪/);
  assert.doesNotMatch(result.stdout,/启动失败|退出 Codex/);
  await assert.rejects(access(f.receipt),{code:'ENOENT'});
});

test('delayed backend health cannot turn a verified native connection into a failure or restart instruction',{skip:!windows},async t=>{
  const f=await fixture(t,{existing:true,nativeReady:true}),result=await f.run();
  assert.match(result.stdout,/后台状态仍在同步/);
  assert.doesNotMatch(result.stdout,/启动失败|退出 Codex/);
  await assert.rejects(access(f.receipt),{code:'ENOENT'});
});

