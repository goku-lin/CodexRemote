$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $packageRoot 'runtime\node.exe'
Write-Host '安装 Codex Relay。此电脑需安装并登录 Codex 桌面；手机和公司笔记本只使用浏览器。'
$connectionMode = (Read-Host '连接方式：回车使用独立连接；输入 2 保留原主电脑中转').Trim()
if ($connectionMode -eq '2') {
  $env:CONNECTOR_MODE = 'relay'
  $env:CONNECTOR_SERVER = (Read-Host '原主电脑 Relay 地址').Trim()
  $env:CONNECTOR_CODE = (Read-Host '原主电脑「添加电脑」里生成的 8 位连接码').Trim()
} elseif (-not $connectionMode) {
  $env:CONNECTOR_MODE = 'independent'
  $env:CONNECTOR_PORT = '4317'
} else { throw '请输入 2，或直接按回车选择独立连接。' }
$computerLabel = Read-Host "电脑名称（回车使用 $env:COMPUTERNAME）"
if (-not $computerLabel) { $computerLabel = $env:COMPUTERNAME }
$env:CONNECTOR_NAME = $computerLabel
$defaultInstall = Join-Path $env:LOCALAPPDATA 'CodexRelayConnector'
if (Test-Path -LiteralPath 'D:\') { $defaultInstall = 'D:\CodexRelayConnector' }
$installRoot = Read-Host "安装目录（回车使用 $defaultInstall）"
if (-not $installRoot) { $installRoot = $defaultInstall }
$env:CONNECTOR_HOME = [IO.Path]::GetFullPath($installRoot)
$workspace = Read-Host '默认项目目录（回车使用用户目录，之后新建任务时可选择项目）'
if (-not $workspace) { $workspace = $env:USERPROFILE }
$env:CONNECTOR_WORKSPACE = [IO.Path]::GetFullPath($workspace)
try {
  & $portableNode (Join-Path $PSScriptRoot 'connector-client.mjs') install
  if ($LASTEXITCODE -ne 0) { throw '安装未完成，请查看上面的错误。' }
  Write-Host "已安装到 $env:CONNECTOR_HOME"
  Write-Host '日常双击安装目录中的「启动.cmd」，会准备连接服务、按需打开 Codex 并打开控制网页。'
  Write-Host '已打开的 Codex 若未接通远程控制，等待当前任务结束后正常退出，再双击「启动.cmd」。'
  if ($env:CONNECTOR_MODE -eq 'independent') {
    Write-Host '日常启动会检查安装包内的局域网更新来源；有新版自动更新，来源离线仍可照常启动。'
    Write-Host '本机网页左下角「连接手机」可按需开启局域网并查看配对码。此电脑不依赖原主电脑在线。'
    Write-Host '外网需要独立入口。允许安装并登录 Tailscale 后，可运行「配置外网入口.cmd」；访问设备只需浏览器。'
  } else { Write-Host '原主电脑网页的「连接设备」会出现此电脑；更新后可通过「切换独立连接.cmd」改为独立运行。' }
} finally { Remove-Item Env:CONNECTOR_CODE -ErrorAction SilentlyContinue }
Read-Host '按回车退出'
