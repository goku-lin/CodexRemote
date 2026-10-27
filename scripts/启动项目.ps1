param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '刷新桌面图标.ps1')
  Write-Host '正在检查后台与远程入口…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动远程服务.ps1') -NoBrowser -Quiet
  if ($LASTEXITCODE -ne 0) { throw '远程服务启动失败。' }

  $startupHealth = Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 5
  if ($startupHealth.desktop.state -ne 'ready') {
    $desktopCandidates = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
    $desktopProcess = $desktopCandidates | Where-Object { $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' }
    if (-not $desktopProcess -and @($desktopCandidates | Where-Object { -not $_.Path }).Count) { throw '无法核对 Codex 桌面进程，请在打开 Codex 的同一 Windows 用户下运行此入口。' }
    if (-not $desktopProcess) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '打开原生桌面连接.ps1')
      if ($LASTEXITCODE -ne 0) { throw 'Codex 桌面连接未完成，请按上面的提示处理。' }
    }
  }

  $startupHealth = Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 5
  if ($startupHealth.desktop.state -ne 'ready') {
    $statusNode = (Get-Command node.exe -ErrorAction Stop).Source
    & $statusNode (Join-Path $projectRoot 'src\native-desktop-status.mjs') --quiet --require-controls | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '后台已就绪，但当前 Codex 桌面未接通远程控制。请保持当前开发任务，先查看网页的连接检查，不要反复重启。' }
    Write-Host '桌面原生连接已接通，正在等待后台同步…'
    $syncDeadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
      try { $startupHealth = Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 2 } catch {}
      if ($startupHealth.desktop.state -eq 'ready') { break }
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $syncDeadline)
    if ($startupHealth.desktop.state -ne 'ready') {
      & $statusNode (Join-Path $projectRoot 'src\native-desktop-status.mjs') --quiet --require-controls | Out-Null
      if ($LASTEXITCODE -ne 0) { throw '桌面连接暂时不可用，请保持当前桌面打开，查看连接检查中的具体状态。' }
      Write-Warning '桌面已接通，后台状态仍在同步。请稍后刷新远程网页，保持当前 Codex 打开。'
    }
  }
  if ($startupHealth.desktop.state -eq 'ready') {
    foreach ($name in @('relay','runner','desktop','tailscale','external')) { Write-Host $startupHealth.$name.message }
    if ($startupHealth.external.url) { Write-Host ('远程地址：' + $startupHealth.external.url) }
    Write-Host '服务与 Codex 桌面已就绪。以后双击「启动」即可。'
  }
  if (-not $NoBrowser) { Start-Process -FilePath 'http://127.0.0.1:4317/?health=1' }
} catch {
  Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
