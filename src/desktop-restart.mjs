import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installedDesktopRoot,refreshDesktopRuntime} from './native-desktop-runtime.mjs';

const execute=promisify(execFile);
const script=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class RelayMaintenanceProcess {
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p,int c,IntPtr d,int s,out int r);
 public static int Parent(int id) {
  using(var p=Process.GetProcessById(id)) { var d=Marshal.AllocHGlobal(IntPtr.Size*6);
   try {int r;if(NtQueryInformationProcess(p.Handle,0,d,IntPtr.Size*6,out r)!=0)throw new Exception("Cannot verify process parent");return Marshal.ReadIntPtr(d,IntPtr.Size*5).ToInt32();}
   finally{Marshal.FreeHGlobal(d);}
  }
 }
}
'@
function Record($p){return @{pid=$p.Id;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();path=$p.Path}}
function Match($expected){
 $p=Get-Process -Id $expected.pid -ErrorAction SilentlyContinue
 if(-not $p){throw '目标进程已改变，请刷新状态后重新操作。'}
 $null=$p.Handle # Keep the process identity alive until the requested stop finishes.
 if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $expected.startTicks -or $p.Path -ne $expected.path){throw '目标进程身份已改变，未停止其他程序。'}
 return $p
}
function DesktopRoots {
 $all=@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
 if(@($all|Where-Object {-not $_.Path}).Count){throw '无法核对桌面进程，请在运行 Codex 的同一 Windows 用户下启动服务。'}
 $prefix=Join-Path $env:ProgramFiles 'WindowsApps\OpenAI.Codex_'
 $all=@($all|Where-Object {$_.Path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and $_.Path -match '\\app\\ChatGPT\.exe$'})
 $ids=@{};foreach($p in $all){$ids[$p.Id]=$true}
 return @($all|Where-Object {-not $ids.ContainsKey([RelayMaintenanceProcess]::Parent($_.Id))})
}
if($payload.action -eq 'inspect'){
 $p=Get-Process -Id $payload.servicePid -ErrorAction Stop
 if($p.Path -ne $payload.nodePath -or [RelayMaintenanceProcess]::Parent($p.Id) -ne $payload.parentPid){throw '无法核对远程服务身份。'}
 $result=@{service=(Record $p)}
 if($payload.scope -eq 'desktop'){
  $roots=@(DesktopRoots)
  if($roots.Count -gt 1){throw '检测到多个 Codex 桌面实例，无法安全确定重启对象。'}
  $result.desktop=$null
  if($roots.Count -eq 1){
   $desktop=$roots[0];$ancestor=$payload.servicePid
   for($i=0;$i -lt 64 -and $ancestor -gt 0;$i++){
    if($ancestor -eq $desktop.Id){throw '远程服务仍依附桌面进程，请先通过本机启动入口独立启动服务。'}
    try{$ancestor=[RelayMaintenanceProcess]::Parent($ancestor)}catch{break}
   }
   $result.desktop=Record $desktop
  }
 }
 $result|ConvertTo-Json -Compress -Depth 5
}elseif($payload.action -eq 'desktop'){
 $roots=@(DesktopRoots)
 if($payload.plan.desktop){
  if($roots.Count -ne 1 -or $roots[0].Id -ne $payload.plan.desktop.pid){throw '桌面实例已改变，未执行重启。'}
  $desktop=Match $payload.plan.desktop
 }elseif($roots.Count){throw '桌面已由其他入口打开，未执行重复启动。'}
 if(-not (Test-Path -LiteralPath $payload.desktopExe) -or -not (Test-Path -LiteralPath $payload.proxyExe)){throw '桌面原生启动文件缺失。'}
 if($desktop){
  & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $desktop.Id /T /F | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Codex 桌面无法关闭，未重复启动。'}
  if(-not $desktop.WaitForExit(10000)){throw 'Codex 桌面仍未退出。'}
 }
 $env:CODEX_CLI_PATH=$payload.proxyExe
 Remove-Item Env:CODEX_RELAY_PARENT_PIPE -ErrorAction SilentlyContinue
 Remove-Item Env:CODEX_RELAY_TOKEN -ErrorAction SilentlyContinue
 $started=Start-Process -FilePath $payload.desktopExe -WorkingDirectory (Split-Path -Parent $payload.desktopExe) -WindowStyle Normal -PassThru
 @{pid=$started.Id}|ConvertTo-Json -Compress
}elseif($payload.action -eq 'service'){
 $p=Match $payload.plan.service
 $p.Kill()
 @{stopped=$true}|ConvertTo-Json -Compress
}else{throw '不支持的维护操作。'}
`;

export async function runMaintenanceProcess(action,options,{run=execute}={}){
  const data=Buffer.from(JSON.stringify({action,...options})).toString('base64');
  const command="$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json\ntry {\n"+script+"\n} catch { @{error=$_.Exception.Message}|ConvertTo-Json -Compress }";
  let result;
  try{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:30_000,maxBuffer:131072});
    result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
  }catch{throw new Error(action==='service' ? '无法核对或停止原远程服务；未操作其他进程。' : '无法核对或重启 Codex 桌面，请检查本机启动文件、Windows 用户和进程状态。');}
  if(result.error)throw new Error(result.error);return result;
}
export function maintenanceLaunchFiles(dataDir){
  const release=fs.existsSync(path.join(dataDir,'connector.json')) ? '-'+process.env.CODEX_RELAY_RELEASE_ID : '';
  if(release && !/^-[a-f0-9]{20}$/.test(release))return null;
  const config=path.join(dataDir,'native-desktop-launch'+release+'.json'),proxy=path.join(dataDir,'codex-native-proxy'+release+'.exe');
  return fs.existsSync(config)&&fs.existsSync(proxy)?{config,proxy}:null;
}
export async function prepareMaintenance({scope,dataDir,servicePid=process.pid,parentPid=process.ppid,nodePath=process.execPath}){
  if(process.platform!=='win32')throw new Error('当前重启入口仅支持 Windows。');
  const plan=await runMaintenanceProcess('inspect',{scope,servicePid,parentPid,nodePath});
  if(scope==='desktop'){
    const files=maintenanceLaunchFiles(dataDir);if(!files)throw new Error('请先在本机准备 Codex 原生启动入口。');
    const appRoot=await installedDesktopRoot();await refreshDesktopRuntime(files.config,appRoot);
    plan.desktopExe=path.join(appRoot,'app','ChatGPT.exe');plan.proxyExe=files.proxy;
    plan.endpointFile=JSON.parse(fs.readFileSync(files.config,'utf8')).endpointFile;
    try{plan.oldNativePid=JSON.parse(fs.readFileSync(plan.endpointFile,'utf8')).pid;}catch{plan.oldNativePid=null;}
  }
  return plan;
}
