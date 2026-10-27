import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, sourceDir, scriptsDir } from './layout.mjs';
import {desktopRuntimePath,installedDesktopRoot} from './native-desktop-runtime.mjs';
import {preparePackageLauncher} from './native-package-launch.mjs';

const exec = promisify(execFile);
const root = projectRoot;
const folder = process.env.CODEX_RELAY_DATA_DIR || path.join(root, '.relay-data');
const connectorHome = process.env.CODEX_RELAY_CONNECTOR_HOME;
const revision = connectorHome ? '-' + process.env.CODEX_RELAY_RELEASE_ID : '';
if(connectorHome && !/^-[a-f0-9]{20}$/.test(revision))throw new Error('连接器版本无效。');
const configurationFile = path.join(folder, 'native-desktop-launch'+revision+'.json');
const shimPath = path.join(folder, 'codex-native-proxy'+revision+'.exe');
const launchPath = path.join(scriptsDir, '打开原生桌面连接.ps1');
const shortcutPath = path.join(scriptsDir, '启动原生连接.cmd');
const serviceLaunchPath = path.join(scriptsDir, '启动Relay后台.ps1');
const mode = process.argv[2] || 'prepare';
if (process.platform !== 'win32') throw new Error('此桌面启动入口当前仅用于 Windows。');
if (!['prepare', 'launch'].includes(mode)) throw new Error('使用 prepare 或 launch。');

await mkdir(folder, { recursive: true });
await preparePackageLauncher(folder);
const desktopRoot=await installedDesktopRoot();
const configuration = { cliPath: await desktopRuntimePath(desktopRoot), desktopRoot, endpointFile: path.join(folder, 'native-desktop.json') };
const csharpString = value => '@"' + value.replaceAll('"', '""') + '"';
const source = (await readFile(path.join(sourceDir, 'native-cli-shim.cs'), 'utf8'))
  .replace('__NODE_PATH__', csharpString(process.execPath))
  .replace('__PROXY_PATH__', csharpString(path.join(sourceDir, 'native-cli-proxy.mjs')))
  .replace('__CONFIG_PATH__', csharpString(configurationFile));
const sourcePath = path.join(folder, 'native-cli-shim'+revision+'.cs');
const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const unchanged = await readFile(sourcePath, 'utf8').then(previous => previous === source, () => false);
const compiled = await access(shimPath).then(() => true, () => false);
if (!unchanged || !compiled) {
  const temporarySource=sourcePath+'.'+process.pid+'.cs',temporaryExe=shimPath+'.'+process.pid+'.exe';
  try{
    await writeFile(temporarySource,source,'utf8');
    await exec(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/optimize+', '/out:' + temporaryExe, temporarySource], { windowsHide: true });
    await rename(temporaryExe,shimPath);
    await writeFile(sourcePath,source,'utf8');
  }finally{
    for(const file of [temporarySource,temporaryExe])await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}
// Check the actual compiled executable and stdio inheritance before enabling it.
await writeFile(configurationFile, JSON.stringify(configuration, null, 2), { mode: 0o600 });
const checked = await exec(shimPath, ['--version'], { windowsHide: true });
if (!/^codex(?:-cli)? /m.test(checked.stdout)) throw new Error('原生 CLI 启动器验证失败。');

const psString = value => "'" + value.replaceAll("'", "''") + "'";
if(connectorHome){
  const launcher=[
    "$ErrorActionPreference = 'Stop'",
    "$appPackage = Get-AppxPackage 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1",
    "if (-not $appPackage) { throw '请先安装并登录 Codex 桌面应用。' }",
    "$desktopCandidates = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)",
    "$existing = $desktopCandidates | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' }",
    "if (-not $existing -and @($desktopCandidates | Where-Object { -not $_.Path }).Count) { throw '无法核对 Codex 桌面进程，请在打开 Codex 的同一 Windows 用户下运行此入口。' }",
    "if ($existing) { Write-Host '请等待当前任务结束并正常退出 Codex，再运行此入口。'; Read-Host '按回车退出'; exit 1 }",
    '& '+psString(process.execPath)+' '+psString(path.join(sourceDir,'native-desktop-runtime.mjs'))+' --config '+psString(configurationFile)+' --app-root $appPackage.InstallLocation',
    "if ($LASTEXITCODE -ne 0) { throw '未能匹配当前 Codex 桌面的运行程序，请查看上面的提示。' }",
    '$proxyExe = '+psString(shimPath),
    '$env:CODEX_RELAY_DATA_DIR = '+psString(folder),
    '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '+psString(path.join(connectorHome,'connector-entry.ps1'))+' start',
    "if ($LASTEXITCODE -ne 0) { throw '连接器启动失败。' }",
    '& '+psString(process.execPath)+' '+psString(path.join(sourceDir,'native-package-launch.mjs'))+' --app-root $appPackage.InstallLocation --proxy $proxyExe --data-dir '+psString(folder),
    "if ($LASTEXITCODE -ne 0) { throw '未能保留官方 Windows 应用身份打开桌面；未改用普通 EXE 启动。' }",
    "Write-Host 'Codex 已打开。日常请双击安装目录中的「启动.cmd」，同时打开连接服务和控制网页。'",''
  ].join('\r\n');
  await writeFile(launchPath,'\ufeff'+launcher,'utf8');
  console.log('连接器桌面启动器已验证；当前桌面任务未重启。');
  if(mode==='launch')await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',launchPath],{windowsHide:true});
  process.exit(0);
}
const serviceLauncher = [
  "$projectRoot = Split-Path -Parent $PSScriptRoot",
  "$ErrorActionPreference = 'Stop'",
  "if (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) { exit 0 }",
  '$env:CODEX_CLI_PATH = ' + psString(configuration.cliPath),
  '$serviceNode = ' + psString(process.execPath),
  "$outLog = Join-Path $projectRoot '.relay-data\\service-background-out.log'",
  "$errorLog = Join-Path $projectRoot '.relay-data\\service-background-error.log'",
  "$serviceArgument = '\"' + (Join-Path $projectRoot 'start.mjs') + '\"'",
  // File redirection avoids PowerShell treating Node's stderr warnings as
  // terminating NativeCommandError records under ErrorActionPreference=Stop.
  '$serviceProcess = Start-Process -FilePath $serviceNode -ArgumentList $serviceArgument -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errorLog -PassThru',
  '$serviceProcess.WaitForExit()',
  'exit $serviceProcess.ExitCode',
  ''
].join('\r\n');
await writeFile(serviceLaunchPath, '\ufeff' + serviceLauncher, 'utf8');

const launcher = [
  "$projectRoot = Split-Path -Parent $PSScriptRoot",
  '$ErrorActionPreference = \'Stop\'',
  "$appPackage = Get-AppxPackage 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1",
  "if (-not $appPackage) { throw '未找到 Codex 桌面应用。' }",
  "$desktopCandidates = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)",
  "$existing = $desktopCandidates | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' }",
  "if (-not $existing -and @($desktopCandidates | Where-Object { -not $_.Path }).Count) { throw '无法核对 Codex 桌面进程，请在打开 Codex 的同一 Windows 用户下运行此入口。' }",
  "if ($existing) { Write-Host '请先等待当前任务结束并关闭 Codex 桌面，再运行此入口。此脚本不会结束正在运行的任务。'; Read-Host '按回车退出'; exit 1 }",
  "$proxyExe = Join-Path $projectRoot '.relay-data\\codex-native-proxy.exe'",
  "if (-not (Test-Path -LiteralPath $proxyExe)) { throw '请先在项目目录运行 npm run connect:desktop 准备启动器。' }",
  '$statusNode = ' + psString(process.execPath),
  "& $statusNode (Join-Path $projectRoot 'src\\native-desktop-runtime.mjs') --config (Join-Path $projectRoot '.relay-data\\native-desktop-launch.json') --app-root $appPackage.InstallLocation",
  "if ($LASTEXITCODE -ne 0) { throw '未能匹配当前 Codex 桌面的运行程序，请查看上面的提示。' }",
  "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动远程服务.ps1') -NoBrowser -Quiet",
  "if ($LASTEXITCODE -ne 0) { throw 'Relay 后台启动失败，请查看上面的提示。' }",
  "Write-Host '正在通过原生代理打开 Codex 桌面…'",
  '& $statusNode '+psString(path.join(sourceDir,'native-package-launch.mjs'))+' --app-root $appPackage.InstallLocation --proxy $proxyExe --data-dir '+psString(folder),
  "if ($LASTEXITCODE -ne 0) { throw '未能保留官方 Windows 应用身份打开桌面；未改用普通 EXE 启动。' }",
  '$connected = $false',
  '$deadline = [DateTime]::UtcNow.AddSeconds(20)',
  "while ([DateTime]::UtcNow -lt $deadline) {",
  "  & $statusNode (Join-Path $projectRoot 'src\\native-desktop-status.mjs') --quiet --require-controls | Out-Null",
  "  if ($LASTEXITCODE -eq 0) { $connected = $true; break }",
  '  Start-Sleep -Milliseconds 500',
  '}',
  "if (-not $connected) { throw 'Codex 已打开，但原生连接尚未就绪。请回到对话反馈此提示。' }",
  "Write-Host 'Codex 桌面原生连接已接通。Relay 后台会在桌面退出后继续运行。'",
  ''
].join('\r\n');
await writeFile(launchPath, '\ufeff' + launcher, 'utf8');
await writeFile(shortcutPath, '@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0打开原生桌面连接.ps1"\r\nif errorlevel 1 pause\r\n', 'utf8');
console.log('原生连接入口已准备：' + launchPath);
console.log('可双击启动：' + shortcutPath);
console.log('CLI 启动器已验证：' + checked.stdout.trim());
console.log('当前桌面尚未切换。请等待当前任务结束，关闭 Codex，再运行上述入口。');
if (mode === 'launch') await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchPath], { windowsHide: true });
