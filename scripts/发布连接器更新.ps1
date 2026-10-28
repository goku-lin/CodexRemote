$projectRoot = Split-Path -Parent $PSScriptRoot
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '未找到 Node.js。请先安装 Node.js 22 或更新版本。' }
& $nodeCommand.Source (Join-Path $projectRoot 'src\connector-release.mjs')
if ($LASTEXITCODE -ne 0) { throw '连接器发布失败，旧版本仍可使用。' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动远程服务.ps1') -NoBrowser -Quiet
if ($LASTEXITCODE -ne 0) { Write-Warning '安装包已发布，更新来源尚未就绪。请在应用中启动服务后，再让其他电脑检查更新。' }
Write-Host '安装包已发布。其他电脑可在应用的「版本与更新」中检查并安装更新。'
