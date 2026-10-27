$projectRoot = Split-Path -Parent $PSScriptRoot
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '未找到 Node.js。请先安装 Node.js 22 或更新版本。' }
& $nodeCommand.Source (Join-Path $projectRoot 'src\connector-release.mjs')
if ($LASTEXITCODE -ne 0) { throw '连接器发布失败，旧版本仍可使用。' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动远程服务.ps1') -NoBrowser -Quiet
if ($LASTEXITCODE -ne 0) { Write-Warning '安装包已发布，更新来源尚未就绪。请在本机运行「启动.cmd」后再让笔记本检查更新。' }
Write-Host '安装包已发布。那边双击「启动.cmd」会自动检查更新，或双击「更新连接器.cmd」立即检查；不需要再复制 ZIP。'
