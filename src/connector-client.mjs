import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {extractArchive} from './connector-archive.mjs';
import {supervise} from './supervisor.mjs';
import {independentPort} from './independent-node.mjs';
import {updateSource,availableRelease,downloadRelease} from './connector-updates.mjs';
import {reuseRuntime,recordManagedRelease,cleanupManagedReleases} from './installation-storage.mjs';

const exec=promisify(execFile),root=path.dirname(fileURLToPath(import.meta.url));
const versionPattern=/^[a-f0-9]{20}$/;
export function serverUrl(value){
  const url=new URL(value);
  const privateHttp=/^(?:localhost|127\.0\.0\.1|10\.(?:\d+\.){2}\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/.test(url.hostname);
  if(url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.protocol==='https:' || url.protocol==='http:' && privateHttp))throw new Error('请输入完整 HTTPS 网址，或同一网络中的 HTTP 地址');
  return url.origin;
}
async function jsonFile(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function save(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});await fs.rename(file+'.tmp',file);}
export async function installation(home){
  const current=await jsonFile(path.join(home,'current.json'));
  if(!versionPattern.test(current.version))throw new Error('安装版本记录无效');
  const directory=path.join(home,'versions',current.version);
  return {current,directory,node:path.join(directory,'runtime','node.exe'),app:path.join(directory,'app'),config:await jsonFile(path.join(home,'state','connector.json'))};
}
export async function ensureStableRuntime(home,versionDirectory){
  const source=path.join(versionDirectory,'runtime','node.exe'),stable=path.join(home,'runtime','node.exe');
  await fs.access(source);await fs.mkdir(path.dirname(stable),{recursive:true});
  const temporary=stable+'.'+process.pid+'.tmp';
  try{await fs.copyFile(source,temporary);await fs.rename(temporary,stable);}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return stable;
}
async function request(server,endpoint,{token,body,timeout=30_000}={}){
  const response=await fetch(serverUrl(server)+endpoint,{redirect:'error',signal:AbortSignal.timeout(timeout),method:body ? 'POST' : 'GET',headers:{...(token ? {'x-codex-relay-token':token} : {}),...(body ? {'content-type':'application/json'} : {})},body:body && JSON.stringify(body)});
  if(!response.ok){let message;try{message=(await response.json()).error;}catch{}throw new Error(message || '连接失败（HTTP '+response.status+'）');}return response;
}
async function prepare(directory,home,version){
  await exec(path.join(directory,'runtime','node.exe'),[path.join(directory,'app','native-desktop-setup.mjs'),'prepare'],{windowsHide:true,timeout:60_000,env:{...process.env,CODEX_RELAY_DATA_DIR:path.join(home,'state'),CODEX_RELAY_CONNECTOR_HOME:home,CODEX_RELAY_RELEASE_ID:version}});
}
const controlPipe=config=>'\\\\.\\pipe\\codex-relay-connector-'+config.id;
async function control(config,action){
  return new Promise(resolve=>{
    const socket=net.createConnection(controlPipe(config));let text='',finished=false;
    const done=value=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(value);};
    const timer=setTimeout(()=>done(null),3000);
    socket.on('error',()=>done(null));socket.on('connect',()=>socket.write(JSON.stringify({token:config.token,action})+'\n'));
    socket.on('data',chunk=>{text+=chunk;if(text.includes('\n')){try{done(JSON.parse(text));}catch{done(null);}}});
  });
}
export async function entries(home,{managerVersion,noShortcut=process.env.CODEX_RELAY_NO_DESKTOP_SHORTCUT==='1'}={}){
  if(managerVersion && !versionPattern.test(managerVersion))throw new Error('管理应用版本无效。');
  const entry=[
    "param([ValidateSet('start','run','update','archive','desktop','stop','web','external','independent','launch','password')][string]$Action = 'start')",
    "$ErrorActionPreference = 'Stop'",
    "$install = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json",
    "if ($install.version -notmatch '^[a-f0-9]{20}$') { throw '安装版本记录无效。' }",
    "$versionRoot = Join-Path $PSScriptRoot ('versions\\' + $install.version)",
    "$clientNode = Join-Path $versionRoot 'runtime\\node.exe'",
    "$clientScript = Join-Path $versionRoot 'app\\connector-client.mjs'",
    "$connectorConfig = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'state\\connector.json') | ConvertFrom-Json",
    "if ($Action -eq 'password') { & $clientNode (Join-Path $versionRoot 'app\\maintenance-password.mjs') --data-dir (Join-Path $PSScriptRoot 'state'); exit $LASTEXITCODE }",
    "if ($Action -eq 'desktop') { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $versionRoot 'app\\打开原生桌面连接.ps1'); exit $LASTEXITCODE }",
    "if ($Action -eq 'start') {",
    "  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $PSScriptRoot 'connector-entry.ps1') + '\" run'",
    "  $started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=$PSScriptRoot}",
    "  if ($started.ReturnValue -ne 0) { throw '连接器后台启动失败。' }; exit 0",
    "}",
    "if ($Action -eq 'archive' -or ($Action -eq 'update' -and $connectorConfig.mode -eq 'independent' -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'state\\update-source.json')))) {",
    "  $archivePath = (Read-Host '新版连接器 ZIP 安装包的完整路径').Trim().Trim([char]34)",
    "  & $clientNode $clientScript update --home $PSScriptRoot --archive $archivePath; exit $LASTEXITCODE",
    "}",
    "if ($connectorConfig.mode -eq 'independent' -and $Action -in @('launch','update') -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'state\\update-source.json'))) {",
    "  & $clientNode $clientScript auto-update --home $PSScriptRoot",
    "  if ($Action -eq 'update') { exit $LASTEXITCODE }",
    "  if ($LASTEXITCODE -ne 0) { Write-Host '更新检查未完成，继续启动已安装的版本。' }",
    "  $install = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json",
    "  if ($install.version -notmatch '^[a-f0-9]{20}$') { throw '安装版本记录无效。' }",
    "  $versionRoot = Join-Path $PSScriptRoot ('versions\\' + $install.version)",
    "  $clientNode = Join-Path $versionRoot 'runtime\\node.exe'",
    "  $clientScript = Join-Path $versionRoot 'app\\connector-client.mjs'",
    "}",
    "if ($Action -in @('launch','web','external')) {",
    "  if ($Action -ne 'launch' -and $connectorConfig.mode -ne 'independent') { throw '请先运行「切换独立连接.cmd」，再使用本机入口。' }",
    "  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'connector-entry.ps1') start",
    "  if ($LASTEXITCODE -ne 0) { throw '连接器启动失败。' }",
    "  if ($connectorConfig.mode -eq 'independent') {",
    "    $connectionPort = if ($connectorConfig.port) { [int]$connectorConfig.port } else { 4317 }",
    "    $localUrl = 'http://127.0.0.1:' + $connectionPort",
    "    $ready = $false; $deadline = [DateTime]::UtcNow.AddSeconds(20)",
    "    do {",
    "      try { $devices = Invoke-RestMethod -TimeoutSec 2 ($localUrl + '/api/devices'); $ready = [bool]($devices.devices | Where-Object { $_.id -eq $connectorConfig.id }) } catch {}",
    "      if (-not $ready) { Start-Sleep -Milliseconds 300 }",
    "    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)",
    "    if (-not $ready) { throw '本机独立服务尚未就绪，请查看 state\\connector.log，并检查端口是否被占用。' }",
    "  } else {",
    "    $relayUri = [Uri]$connectorConfig.server",
    "    if (-not $relayUri.IsAbsoluteUri -or $relayUri.Scheme -notin @('http','https')) { throw '原中转网页地址无效。' }",
    "    $localUrl = $relayUri.AbsoluteUri.TrimEnd('/')",
    "  }",
    "  $desktopStartupIncomplete = $false",
    "  if ($Action -eq 'launch') {",
    "    $desktopCandidates = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)",
    "    $desktopProcess = $desktopCandidates | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' }",
    "    if (-not $desktopProcess -and @($desktopCandidates | Where-Object { -not $_.Path }).Count) { throw '无法核对 Codex 桌面进程，请使用打开 Codex 的同一 Windows 用户。' }",
    "    $desktopOpened = $false",
    "    if (-not $desktopProcess) {",
    "      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $versionRoot 'app\\打开原生桌面连接.ps1')",
    "      if ($LASTEXITCODE -ne 0) { throw 'Codex 桌面启动未完成，请查看上面的提示。' }",
    "      $desktopOpened = $true",
    "    }",
    "    if ($connectorConfig.mode -eq 'independent') {",
    "      $desktopReady = $false; $desktopDeadline = [DateTime]::UtcNow.AddSeconds(20)",
    "      do {",
    "        try { $startupHealth = Invoke-RestMethod -TimeoutSec 2 ($localUrl + '/api/health'); $desktopReady = $startupHealth.desktop.state -eq 'ready' } catch {}",
    "        if ($desktopOpened -and -not $desktopReady) { Start-Sleep -Milliseconds 300 }",
    "      } while ($desktopOpened -and -not $desktopReady -and [DateTime]::UtcNow -lt $desktopDeadline)",
    "      if (-not $desktopReady) { $desktopStartupIncomplete = $true; Write-Host 'Codex 已打开，但桌面连接尚未就绪。如果桌面弹出错误，请保留错误提示反馈；如已有任务运行，请等任务结束后再正常退出并重开。' }",
    "      else { Write-Host '连接服务与 Codex 已就绪。以后双击「启动.cmd」即可。' }",
    "    }",
    "  }",
    "  if ($Action -in @('launch','web')) { Start-Process ($localUrl + $(if ($Action -eq 'launch') { '/?health=1' } else { '/' })); if ($desktopStartupIncomplete) { exit 1 }; exit 0 }",
    "  $env:PORT = [string]$connectionPort; $env:CODEX_RELAY_DATA_DIR = Join-Path $PSScriptRoot 'state'",
    "  & $clientNode (Join-Path $versionRoot 'app\\private-access.mjs') --hybrid; exit $LASTEXITCODE",
    "}",
    "& $clientNode $clientScript $Action --home $PSScriptRoot",
    'exit $LASTEXITCODE',''
  ].join('\r\n');
  await fs.writeFile(path.join(home,'connector-entry.ps1'),'\ufeff'+entry);
  const managerEntry=[
    "param([switch]$Install, [switch]$ValidateOnly, [switch]$NoShortcut, [switch]$VerifyStatusOnly)",
    "$ErrorActionPreference='Stop'",
    "try {",
    "  $managerInstallState=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json",
    "  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'manager.json')) { $managerInstallState=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'manager.json') | ConvertFrom-Json }",
    "  if ($managerInstallState.version -notmatch '^[a-f0-9]{20}$') { throw '安装版本记录无效。' }",
    "  $versionRoot=Join-Path $PSScriptRoot ('versions\\'+$managerInstallState.version)",
    "  if ($Install) { & (Join-Path $versionRoot 'app\\install-manager.ps1') -HomeDirectory $PSScriptRoot -SourceDirectory (Join-Path $versionRoot 'app') -NoShortcut:$NoShortcut }",
    "  else { & (Join-Path $versionRoot 'app\\manager-ui.ps1') -ProjectRoot $versionRoot -ConnectorHome $PSScriptRoot -ValidateOnly:$ValidateOnly -VerifyStatusOnly:$VerifyStatusOnly }",
    "} catch {",
    "  $managerFailure=$_",
    "  $managerLog=Join-Path $PSScriptRoot 'state\\manager-startup.log'",
    "  $managerErrorText=$managerFailure.Exception.Message",
    "  try {",
    "    [IO.Directory]::CreateDirectory((Split-Path -Parent $managerLog)) | Out-Null",
    "    $managerDetails=(Get-Date -Format o)+\"`r`n\"+$managerFailure.ToString()+\"`r`n\"+$managerFailure.ScriptStackTrace+\"`r`n\"",
    "    [IO.File]::AppendAllText($managerLog,$managerDetails,[Text.UTF8Encoding]::new($true))",
    "    $managerErrorText+=\"`n`n日志：\"+$managerLog",
    "  } catch { $managerErrorText+=\"`n无法保存启动日志：\"+$_.Exception.Message }",
    "  if (-not $Install -and -not $ValidateOnly -and -not $VerifyStatusOnly) {",
    "    try { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($managerErrorText,'Codex Remote 启动失败','OK','Error') | Out-Null } catch {}",
    "  }",
    "  Write-Error -Message $managerErrorText -ErrorAction Continue",
    "  exit 1",
    "}",''
  ].join('\r\n');
  await fs.writeFile(path.join(home,'管理应用入口.ps1'),'\ufeff'+managerEntry);
  await fs.writeFile(path.join(home,'manager-bootstrap.ps1'),'\ufeff'+managerEntry);
  await fs.writeFile(path.join(home,'打开管理应用.cmd'),'@echo off\r\nchcp 65001 >nul\r\nif exist "%~dp0CodexRemote.exe" (\r\n  start "" "%~dp0CodexRemote.exe"\r\n) else (\r\n  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0manager-bootstrap.ps1"\r\n)\r\n');
  await fs.writeFile(path.join(home,'安装管理应用.cmd'),'@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0管理应用入口.ps1" -Install\r\nif errorlevel 1 pause\r\n');
  for(const [name,action] of [['启动','launch'],['启动连接器','start'],['更新连接器','update'],['从安装包更新','archive'],['打开Codex远程连接','launch'],['停止连接器','stop'],['打开控制网页','web'],['配置外网入口','external'],['切换独立连接','independent'],['设置重启密码','password']]){
    await fs.writeFile(path.join(home,name+'.cmd'),'@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0connector-entry.ps1" '+action+'\r\nif errorlevel 1 pause\r\n'+(['update','password'].includes(action) ? 'pause\r\n' : ''));
  }
  const current=await jsonFile(path.join(home,'current.json')).catch(()=>null),selected=managerVersion || current?.version;
  if(versionPattern.test(selected || '')){
    const app=path.join(home,'versions',selected,'app');
    if(await fs.access(path.join(app,'manager-host.exe')).then(()=>true,()=>false)){
      await save(path.join(home,'manager.json'),{version:selected});
      await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(app,'install-manager.ps1'),'-HomeDirectory',home,'-SourceDirectory',app,...(noShortcut?['-NoShortcut']:[])],{windowsHide:true,timeout:20000});
    }
  }
}
async function launch(home){await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(home,'connector-entry.ps1'),'start'],{windowsHide:true});}
export async function install({home,server,code,name,workspace,port=4317,mode=server ? 'relay' : 'independent',packageRoot=path.dirname(root)},{prepareVersion=prepare,launchConnector=launch,managerOptions}={}){
  if(process.platform!=='win32')throw new Error('连接器当前用于 Windows');
  home=path.resolve(home);if(home===path.parse(home).root)throw new Error('安装目录不能是磁盘根目录');
  if(!['relay','independent'].includes(mode))throw new Error('连接模式无效');
  if(mode==='relay')server=serverUrl(server);else port=independentPort(port);
  if(typeof name!=='string' || !name.trim() || name.length>80)throw new Error('电脑名称需要 1–80 个字符');
  const previous=await fs.readdir(home).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  let enrollment;
  if(previous.length){
    enrollment=await jsonFile(path.join(home,'connector-install.json')).catch(()=>null);
    const installed=await fs.access(path.join(home,'current.json')).then(()=>true,()=>false);
    if(installed || enrollment?.kind!=='CodexRelayConnector' || enrollment.server!==server || enrollment.mode && enrollment.mode!==mode)throw new Error('安装目录不是空目录。已安装的电脑请使用「更新连接器」或「切换独立连接」，或选择新的空目录');
  }
  const metadata=await jsonFile(path.join(packageRoot,'release.json'));
  if(!versionPattern.test(metadata.version))throw new Error('安装包版本无效');
  await fs.access(workspace);await fs.mkdir(home,{recursive:true});
  enrollment ||= {kind:'CodexRelayConnector',mode,...(mode==='relay' ? {server} : {}),nonce:crypto.randomUUID(),name:name.trim()};
  await save(path.join(home,'connector-install.json'),enrollment);
  const directory=path.join(home,'versions',metadata.version);await fs.mkdir(directory,{recursive:true});
  for(const part of ['app','runtime','release.json'])await fs.cp(path.join(packageRoot,part),path.join(directory,part),{recursive:true});
  await prepareVersion(directory,home,metadata.version);
  // Persist the enrollment nonce before the request, so a lost response can be recovered.
  const enrolled=mode==='independent'
    ? {id:'pc-'+enrollment.nonce,token:crypto.randomBytes(32).toString('hex'),name:enrollment.name}
    : await (await request(server,'/api/connector/enroll',{body:{code,nonce:enrollment.nonce,name:enrollment.name}})).json();
  if(!/^pc-[a-f0-9-]{36}$/.test(enrolled.id) || !/^[a-f0-9]{64}$/.test(enrolled.token))throw new Error('电脑授权响应无效');
  await save(path.join(home,'state','connector.json'),{mode,...(mode==='relay' ? {server} : {port}),id:enrolled.id,token:enrolled.token,name:enrolled.name,cwd:path.resolve(workspace)});
  if(metadata.updates)await save(path.join(home,'state','update-source.json'),updateSource(metadata.updates));
  await save(path.join(home,'current.json'),{version:metadata.version});await entries(home,managerOptions);await recordManagedRelease(directory);await launchConnector(home);
  console.log('安装完成：'+home);
  if(mode==='independent')console.log('此电脑独立运行。日常双击「启动.cmd」；本机网页「连接手机」可按需开启局域网并查看配对码。');
}
export async function applyUpdate(home,manifest,bytes,{prepareVersion=prepare}={}){
  if(!versionPattern.test(manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || bytes.length!==manifest.size || crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('下载的安装包校验失败，原版本保持不变');
  const directory=path.join(home,'versions',manifest.version);
  const staging=path.join(home,'versions','.stage-'+crypto.randomUUID());
  let created=false;
  try{
    await extractArchive(bytes,staging);const release=await jsonFile(path.join(staging,'release.json'));
    if(release.version!==manifest.version)throw new Error('安装包版本与发布信息不符');
    await fs.access(path.join(staging,'runtime','node.exe'));await fs.access(path.join(staging,'app','connector-client.mjs'));
    // A failed/partial earlier download cannot occupy the final version directory.
    try{await fs.rename(staging,directory);created=true;}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;const old=await jsonFile(path.join(directory,'release.json'));if(old.version!==manifest.version)throw error;}
    await reuseRuntime(home,directory);
    await prepareVersion(directory,home,manifest.version);
    if(created)await recordManagedRelease(directory);
    await save(path.join(home,'current.json'),{version:manifest.version});return directory;
  }finally{
    if(path.dirname(path.resolve(staging))!==path.resolve(home,'versions'))throw new Error('清理目录越界');
    await fs.rm(staging,{recursive:true,force:true});
  }
}
export async function applyArchiveUpdate(home,filename,options={}){
  const stat=await fs.stat(filename);if(!stat.isFile() || stat.size>180_000_000)throw new Error('安装包文件无效或过大');
  const bytes=await fs.readFile(filename),inspection=path.join(home,'versions','.inspect-'+crypto.randomUUID());
  try{
    await extractArchive(bytes,inspection);
    const {version}=await jsonFile(path.join(inspection,'release.json'));
    return await applyUpdate(home,{version,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},bytes,options);
  }finally{
    if(path.dirname(path.resolve(inspection))!==path.resolve(home,'versions'))throw new Error('清理目录越界');
    await fs.rm(inspection,{recursive:true,force:true});
  }
}
async function stopConnector(config){
  const stopped=await control(config,'stop');
  if(stopped){
    for(let i=0;i<20;i++){if(!await control(config,'status'))return;await new Promise(resolve=>setTimeout(resolve,150));}
    throw new Error('旧连接器尚未停止，未启动第二个连接器。请稍后重试');
  }
}
async function refreshEntries(home){
  const installed=await installation(home);
  await exec(installed.node,[path.join(installed.app,'connector-client.mjs'),'entries','--home',home],{windowsHide:true,timeout:15000});
}
async function verifyRunning(home,version){
  const {config}=await installation(home),base='http://127.0.0.1:'+independentPort(config.port);
  const deadline=Date.now()+20000;
  do{
    try{
      const result=await fetch(base+'/api/runtime',{signal:AbortSignal.timeout(1500)});
      if(result.ok && (await result.json()).connectorReleaseId===version)return;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }while(Date.now()<deadline);
  throw new Error('新版控制服务未能启动，恢复原版本');
}
async function activeWork(config){
  if(!await control(config,'status'))return false;
  const response=await fetch('http://127.0.0.1:'+independentPort(config.port)+'/api/bootstrap',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('当前控制服务尚未就绪，暂缓更新');
  const value=await response.json();
  if(!value.devices?.some(device=>device.id===config.id))throw new Error('当前端口不是此电脑的控制服务，暂缓更新');
  return value.sessions?.some(session=>session.deviceId===config.id && (session.activeTurnId || ['starting','running','waiting_input','waiting_approval','interrupting'].includes(session.status))) || false;
}
export async function withUpdateLock(home,operation){
  const filename=path.join(home,'state','connector-update.lock');
  let handle;
  for(let attempt=0;attempt<2;attempt++){
    try{handle=await fs.open(filename,'wx');break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const owner=await jsonFile(filename).catch(()=>null);
      if(!owner?.pid)throw new Error('另一个更新检查正在进行');
      try{process.kill(owner.pid,0);throw new Error('另一个更新检查正在进行');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      await fs.unlink(filename);
    }
  }
  if(!handle)throw new Error('另一个更新检查正在进行');
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));return await operation();}
  finally{await handle.close();await fs.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function activateUpdate(home,before,apply,{refresh=refreshEntries,stopRunning=stopConnector,launchConnector=launch,verify=verifyRunning,activeWork:busy}={}){
  try{
    await apply();
    if(busy && await busy(before.config)){await save(path.join(home,'current.json'),before.current);return false;}
    await refresh(home);await stopRunning(before.config);await launchConnector(home);
    if(before.config.mode==='independent')await verify(home,(await installation(home)).current.version);
    await cleanupManagedReleases(home,{keep:[before.current.version]}).catch(()=>{});
    return true;
  }catch(error){
    const current=await jsonFile(path.join(home,'current.json'));
    if(current.version!==before.current.version){
      await save(path.join(home,'current.json'),before.current);
      try{await stopRunning(before.config);try{await refresh(home);}catch{await entries(home);}await launchConnector(home);}
      catch(rollbackError){throw new Error(error.message+'；原版本已选回，但后台需重新启动：'+rollbackError.message);}
    }
    throw error;
  }
}
async function initializeUpdateSource(home){
  if(await fs.access(path.join(home,'state','update-source.json')).then(()=>true,()=>false))return;
  const installed=await installation(home),metadata=await jsonFile(path.join(installed.directory,'release.json'));
  if(metadata.updates)await save(path.join(home,'state','update-source.json'),updateSource(metadata.updates));
}
export async function autoUpdate(home,options={}){
  try{
    const settings=await jsonFile(path.join(home,'state','update-source.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!settings)return {status:'disabled'};
    return await withUpdateLock(home,async()=>{
      const before=await installation(home);
      if(before.config.mode!=='independent')return {status:'disabled'};
      const source=updateSource(await jsonFile(path.join(home,'state','update-source.json')));
      const {url,manifest}=await availableRelease(source,options);
      // Remember the highest signed publication even if its download fails.
      await save(path.join(home,'state','update-source.json'),{...source,sequence:manifest.sequence});
      if(manifest.version===before.current.version)return {status:'current',version:manifest.version};
      const busy=options.activeWork || activeWork;
      if(await busy(before.config))return {status:'deferred',version:manifest.version};
      options.onProgress?.('发现新版，正在下载并校验…');
      const bytes=await downloadRelease(url,manifest,options);
      options.onProgress?.('安装包校验通过，正在更新控制服务…');
      const activated=await activateUpdate(home,before,()=>applyUpdate(home,manifest,bytes,options),{...options,activeWork:busy});
      if(!activated)return {status:'deferred',version:manifest.version};
      return {status:'updated',version:manifest.version};
    });
  }catch(error){return {status:'unavailable',message:error.message};}
}
export async function switchIndependent(home,{port=4317,stopRunning=stopConnector,launchConnector=launch}={}){
  port=independentPort(port);
  const {config}=await installation(home);
  if(config.mode==='independent' && independentPort(config.port)===port){await entries(home);await launchConnector(home);return;}
  // Stop using the old hub's credential before replacing the local runner key.
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',()=>reject(new Error('端口 '+port+' 已被占用，未更改连接方式')));probe.listen(port,'0.0.0.0',resolve);});
  await new Promise(resolve=>probe.close(resolve));
  await stopRunning(config);
  const {server,...local}=config;
  await save(path.join(home,'state','connector.json'),{...local,mode:'independent',port,token:crypto.randomBytes(32).toString('hex')});
  await entries(home);await launchConnector(home);
  console.log('已切换独立连接。任务、浏览器授权和图片保留；不再连接原主电脑。双击「打开控制网页」查看本机入口。');
}
async function update(home,archive){
  return withUpdateLock(home,async()=>{
  const before=await installation(home),{config}=before;
  if(archive){
    await activateUpdate(home,before,()=>applyArchiveUpdate(home,archive));await initializeUpdateSource(home);
    console.log('已从本地安装包更新。此电脑的任务和浏览器授权保留，无需连接主电脑。');return;
  }
  if(config.mode==='independent')throw new Error('请通过「更新连接器.cmd」选择下载好的新版 ZIP 安装包');
  const endpoint='/api/runner/'+encodeURIComponent(config.id)+'/release';
  const manifest=await (await request(config.server,endpoint,{token:config.token})).json();
  if(manifest.version===before.current.version){console.log('连接器已经是最新版本。');return;}
  const response=await request(config.server,endpoint+'/'+manifest.version,{token:config.token,timeout:120_000});
  if(Number(response.headers.get('content-length'))>180_000_000)throw new Error('安装包过大');
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>180_000_000)throw new Error('安装包过大');chunks.push(chunk);}
  await activateUpdate(home,before,()=>applyUpdate(home,manifest,Buffer.concat(chunks)));await initializeUpdateSource(home);
  console.log('连接器已更新。现有桌面任务继续运行；桌面代理在下次正常启动时更新。');
  });
}
async function run(home){
  const installed=await installation(home),{config,current,app,node}=installed;
  // Also bootstraps an existing installation updated by an older ZIP updater.
  await initializeUpdateSource(home);await entries(home);
  if(await control(config,'status'))return;
  const log=await fs.open(path.join(home,'state','connector.log'),'a');
  let service;
  const server=net.createServer(socket=>{
    let frame='';socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});
    socket.on('data',bytes=>{frame+=bytes;if(frame.length>4096)return socket.destroy();if(!frame.includes('\n'))return;
      try{const value=JSON.parse(frame);if(value.token!==config.token)return socket.destroy();
        socket.end(JSON.stringify({version:current.version})+'\n');if(value.action==='stop')setTimeout(shutdown,100);
      }catch{socket.destroy();}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(controlPipe(config),resolve);});
  const runtime=path.join(app,'connector-runtime.cjs');
  // Keep the inbound firewall identity stable across versioned OTA folders.
  // The versioned runtime remains available for rollback and maintenance;
  // only the long-lived Relay service uses this fixed path.
  const serviceNode=await ensureStableRuntime(home,installed.directory);
  service=supervise(serviceNode,[runtime],{cwd:config.cwd,windowsHide:true,stdio:['pipe',log.fd,log.fd],env:{...process.env,CODEX_RELAY_PARENT_PIPE:'1',CODEX_RELAY_DATA_DIR:path.join(home,'state'),CODEX_RELAY_RELEASE_ID:current.version}},{onState:state=>log.write(JSON.stringify({at:Date.now(),...state})+'\n').catch(()=>{})});
  let closing=false;
  function shutdown(){if(closing)return;closing=true;service?.stop();server.close();setTimeout(()=>process.exit(0),700);}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const action=process.argv[2],home=process.argv[process.argv.indexOf('--home')+1];
    if(action==='install')await install({home:process.env.CONNECTOR_HOME,mode:process.env.CONNECTOR_MODE || undefined,port:process.env.CONNECTOR_PORT || 4317,server:process.env.CONNECTOR_SERVER,code:process.env.CONNECTOR_CODE,name:process.env.CONNECTOR_NAME,workspace:process.env.CONNECTOR_WORKSPACE});
    else if(action==='update')await update(home,process.argv.includes('--archive') ? process.argv[process.argv.indexOf('--archive')+1] : null);
    else if(action==='entries')await entries(home);
    else if(action==='auto-update'){
      console.log('正在检查局域网更新…');
      const result=await autoUpdate(home,{onProgress:message=>console.log(message)});
      console.log(result.status==='updated' ? '已自动更新到 '+result.version+'。当前 Codex 任务保留，桌面代理在下次正常启动时更新。' : result.status==='deferred' ? '发现新版，当前仍有任务运行或等待处理。继续使用当前版本，下次空闲时启动会再检查更新。' : result.status==='current' ? '连接器已经是最新发布版本。' : result.status==='disabled' ? '尚未配置自动更新来源，可使用「从安装包更新.cmd」。' : '自动更新暂不可用，继续使用已安装版本：'+result.message);
    }
    else if(action==='independent')await switchIndependent(home,{port:process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port')+1] : 4317});
    else if(action==='run')await run(home);
    else if(action==='stop'){await control((await installation(home)).config,'stop');console.log('连接器已停止，Codex 桌面继续运行。');}
    else throw new Error('连接器操作无效');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
