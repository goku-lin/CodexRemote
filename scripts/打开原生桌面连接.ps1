$projectRoot = Split-Path -Parent $PSScriptRoot
$ErrorActionPreference = 'Stop'
$appPackage = Get-AppxPackage 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
if (-not $appPackage) { throw '未找到 Codex 桌面应用。' }
$desktopCandidates = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
$existing = $desktopCandidates | Where-Object { $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' }
if (-not $existing -and @($desktopCandidates | Where-Object { -not $_.Path }).Count) { throw '无法核对 Codex 桌面进程，请在打开 Codex 的同一 Windows 用户下运行此入口。' }
if ($existing) { Write-Host '请先等待当前任务结束并关闭 Codex 桌面，再运行此入口。此脚本不会结束正在运行的任务。'; Read-Host '按回车退出'; exit 1 }
$proxyExe = Join-Path $projectRoot '.relay-data\codex-native-proxy.exe'
if (-not (Test-Path -LiteralPath $proxyExe)) { throw '请先在项目目录运行 npm run connect:desktop 准备启动器。' }
$statusNode = if ($env:CODEX_NODE_PATH) { $env:CODEX_NODE_PATH } else { (Get-Command node.exe -ErrorAction Stop).Source }
& $statusNode (Join-Path $projectRoot 'src\native-desktop-runtime.mjs') --config (Join-Path $projectRoot '.relay-data\native-desktop-launch.json') --app-root $appPackage.InstallLocation
if ($LASTEXITCODE -ne 0) { throw '未能匹配当前 Codex 桌面的运行程序，请查看上面的提示。' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动远程服务.ps1') -NoBrowser -Quiet
if ($LASTEXITCODE -ne 0) { throw 'Relay 后台启动失败，请查看上面的提示。' }
Write-Host '正在通过原生代理打开 Codex 桌面…'
& $statusNode (Join-Path $projectRoot 'src\native-package-launch.mjs') --app-root $appPackage.InstallLocation --proxy $proxyExe --data-dir (Join-Path $projectRoot '.relay-data')
if ($LASTEXITCODE -ne 0) { throw '未能保留官方 Windows 应用身份打开桌面；未改用普通 EXE 启动。' }
$connected = $false
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  & $statusNode (Join-Path $projectRoot 'src\native-desktop-status.mjs') --quiet --require-controls | Out-Null
  if ($LASTEXITCODE -eq 0) { $connected = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $connected) { throw 'Codex 已打开，但原生连接尚未就绪。请回到对话反馈此提示。' }
Write-Host 'Codex 桌面原生连接已接通。Relay 后台会在桌面退出后继续运行。'
