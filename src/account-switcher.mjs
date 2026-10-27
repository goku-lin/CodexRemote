import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {installedDesktopRoot,refreshDesktopRuntime} from './native-desktop-runtime.mjs';
import {launchPackagedDesktop} from './native-package-launch.mjs';
import {NativeDesktopClient} from './native-desktop-channel.mjs';
import {projectRoot} from './layout.mjs';

const execute=promisify(execFile),quote=value=>"'"+value.replaceAll("'","''")+"'";
const json=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\ufeff/,''));
const exists=file=>fs.access(file).then(()=>true,()=>false);
const marker='# Codex Remote account compatibility v1';
export async function accountSwitcherStatus(context,{desktop=path.join(os.homedir(),'Desktop')}={}){
  const settings=await json(path.join(context.dataDir,'account-switcher.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const script=settings?.script || path.join(desktop,'Codex','codex-switch.ps1');
  if(!await exists(script))return {available:false,script,integrated:false};
  const source=await fs.readFile(script,'utf8');
  const config=await json(path.join(path.dirname(script),'codex-remote-launch.json')).catch(()=>null);
  return {available:true,script,integrated:source.includes(marker) && config?.launcher===path.join(context.home || context.root,'account-desktop-entry.ps1')};
}

export function compatibleSwitcher(source){
  if(source.includes(marker))return source;
  const stop=/function Stop-Codex \{[\s\S]*?\r?\n\}/,start=/function Start-Codex \{[\s\S]*?\r?\n\}/;
  if(!stop.test(source) || !start.test(source) || !source.includes('$Script:ProcNames') || !source.includes('shell:AppsFolder') || !source.includes('$btnSwitch.Add_Click({'))throw new Error('账号工具版本不匹配，未修改。');
  const stopping=`function Stop-Codex {
    # Only the official GUI is closed. Runner and unrelated CLI tasks are preserved.
    $desktop = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
    if (@($desktop | Where-Object { -not $_.Path }).Count) { throw '无法核对 Codex 桌面进程，未关闭其他程序。' }
    $desktop = @($desktop | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' })
    foreach ($item in $desktop) { Stop-Process -InputObject $item -Force -ErrorAction SilentlyContinue }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $alive = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' })
        if (-not $alive.Count) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Codex 尚未退出，未替换登录状态。'
}`;
  const starting=`${marker}
function Invoke-RemoteAccountLaunch([switch]$CheckOnly) {
    $config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'codex-remote-launch.json') -Encoding UTF8 | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $config.launcher)) { throw '远程原生入口不存在，请在管理应用中重新连接账号工具。' }
    if ($CheckOnly) { & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $config.launcher -CheckOnly }
    else { & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $config.launcher }
    if ($LASTEXITCODE -ne 0) { throw '账号切换的远程入口未完成。未改用普通入口；请查看远程管理应用。' }
}
function Start-Codex { Invoke-RemoteAccountLaunch }`;
  return source.replace(stop,()=>stopping).replace(start,()=>starting).replace(/\$Script:ProcNames\s*=\s*@\([^\r\n]+\)/,"$Script:ProcNames = @('ChatGPT')")
    .replace(/    Stop-Codex\r?\n    Copy-Item \$p.Path \$Script:LiveAuth -Force\r?\n    Start-Codex/,()=>`    try {
        Stop-Codex
        Copy-Item -LiteralPath $p.Path -Destination $Script:LiveAuth -Force -ErrorAction Stop
        Start-Codex
    } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message, '账号切换未完成'); return }`)
    .replace('$btnSwitch.Add_Click({',()=>`$btnSwitch.Add_Click({
    if ($lv.SelectedItems.Count -eq 0) { [Windows.Forms.MessageBox]::Show('请先选中一个账号。'); return }
    try { Invoke-RemoteAccountLaunch -CheckOnly } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message); return }
    if ([Windows.Forms.MessageBox]::Show('切换账号会重启 Codex 并中断此电脑全部桌面任务。Relay 保持运行，桌面启动后自动恢复接管。是否继续？', '切换账号', 'YesNo', 'Warning', 'Button2') -ne 'Yes') { return }
`);
}

export async function installAccountCompatibility(context,options={}){
  const status=await accountSwitcherStatus(context,options);
  if(!status.available)throw new Error('未找到桌面 Codex 文件夹中的 codex-switch.ps1。');
  const bytes=await fs.readFile(status.script),source=bytes.toString('utf8').replace(/^\ufeff/,''),patched=compatibleSwitcher(source);
  const backup=status.script+'.before-codex-remote.bak';
  if(!source.includes(marker))await fs.writeFile(backup,bytes,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const entry=path.join(context.home || context.root,'account-desktop-entry.ps1');
  const lines=["param([switch]$CheckOnly)","$ErrorActionPreference='Stop'"];
  if(context.home){
    lines.push("$install=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json","if ($install.version -notmatch '^[a-f0-9]{20}$') { throw '安装版本记录无效。' }","$versionRoot=Join-Path $PSScriptRoot ('versions\\'+$install.version)","$node=Join-Path $versionRoot 'runtime\\node.exe'","$arguments=@((Join-Path $versionRoot 'app\\account-switcher.mjs'),'launch','--root',$versionRoot,'--home',$PSScriptRoot)");
  }else lines.push('$node='+quote(process.execPath),'$arguments=@('+quote(path.join(context.app,'account-switcher.mjs'))+",'launch','--root',"+quote(context.root)+')');
  lines.push("if ($CheckOnly) { $arguments+='--check-only' }",'& $node @arguments','exit $LASTEXITCODE','');
  await fs.writeFile(entry,'\ufeff'+lines.join('\r\n'));
  await fs.writeFile(path.join(path.dirname(status.script),'codex-remote-launch.json'),JSON.stringify({version:1,launcher:entry},null,2));
  if(!(await fs.readFile(status.script)).equals(bytes))throw new Error('账号脚本已被其他程序修改，请重新连接。');
  await fs.writeFile(status.script,'\ufeff'+patched.replace(/\r?\n/g,'\r\n'));
  await fs.mkdir(context.dataDir,{recursive:true});
  await fs.writeFile(path.join(context.dataDir,'account-switcher.json'),JSON.stringify({script:status.script}));
  return {message:'账号工具已接入原生启动入口；账号快照未读取或修改。请重新打开账号切换窗口。',script:status.script,backup};
}

export async function openAccountSwitcher(context,options={}){
  const installed=await installAccountCompatibility(context,options);
  const args='-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+installed.script+'"';
  await (options.run || execute)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList "+quote(args)],{windowsHide:true,timeout:8000});
  return {message:'账号切换窗口已打开。选择账号后由你确认切换；尚未关闭 Codex 或切换账号。'};
}

async function nativeReady(endpointFile,previousPid){
  const record=await json(endpointFile);if(record.pid===previousPid)return false;
  const client=new NativeDesktopClient({CODEX_RELAY_NATIVE_ENDPOINT:endpointFile},2000);
  try{await client.connect();return Boolean(client.capabilities.events && client.capabilities.serverRequests);}finally{client.close();}
}
export async function launchAccountDesktop(context,options={}){
  let suffix='';
  if(context.home){const version=path.basename(context.root);if(!/^[a-f0-9]{20}$/.test(version))throw new Error('安装版本无效。');suffix='-'+version;}
  const config=path.join(context.dataDir,'native-desktop-launch'+suffix+'.json'),proxy=path.join(context.dataDir,'codex-native-proxy'+suffix+'.exe');
  if(!await exists(config) || !await exists(proxy))throw new Error('请先通过 Codex远程准备本机原生启动入口。');
  const configuration=await json(config),endpointFile=configuration.endpointFile;
  if(typeof endpointFile!=='string' || !path.isAbsolute(endpointFile))throw new Error('原生连接配置无效。');
  if(options.checkOnly)return {message:'账号切换的原生启动入口已准备。'};
  const run=options.run || execute;
  const alive=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' }).Count"],{windowsHide:true,timeout:8000});
  if(!/^0$/.test(alive.stdout.trim()))throw new Error('Codex 仍在运行，未重复启动或关闭它。');
  const previous=await json(endpointFile).catch(()=>null);
  const appRoot=await (options.getAppRoot || installedDesktopRoot)();
  await (options.refresh || refreshDesktopRuntime)(config,appRoot);
  await (options.launch || launchPackagedDesktop)({appRoot,proxy,dataDir:context.dataDir});
  const now=options.now || Date.now,deadline=now()+30000,sleep=options.sleep || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  while(now()<deadline){
    try{if(await (options.probe || nativeReady)(endpointFile,previous?.pid))return {message:'账号切换后的 Codex 原生连接已恢复。Relay 服务保持运行。'};}catch{}
    await sleep(500);
  }
  throw new Error('Codex 已打开，但尚未确认原生接管恢复；未重启 Relay 或切换到普通入口。');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const flag=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
    const root=path.resolve(flag('--root') || projectRoot),home=flag('--home');
    const context={root,home:home && path.resolve(home),dataDir:path.join(home || root,home?'state':'.relay-data'),app:path.join(root,home?'app':'src')};
    if(process.argv[2]!=='launch')throw new Error('请从账号切换工具打开。');
    console.log((await launchAccountDesktop(context,{checkOnly:process.argv.includes('--check-only')})).message);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
