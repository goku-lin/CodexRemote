param([switch]$NoBrowser, [switch]$Quiet)
$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $PSScriptRoot
$baseUrl = 'http://127.0.0.1:4317'
$runtime = $null
try { $runtime = Invoke-RestMethod ($baseUrl + '/api/runtime') -TimeoutSec 3 } catch {}
$runtimeReady = $runtime -and $runtime.nativeControlsRevision -ge 3 -and $runtime.connectorRevision -ge 2 -and $runtime.connectorUpdateRevision -ge 1 -and $runtime.chatgptRevision -ge 2 -and $runtime.remoteBrowserRevision -ge 3 -and $runtime.threadSyncRevision -ge 1 -and $runtime.historySyncRevision -ge 3 -and $runtime.mediaRevision -ge 1 -and $runtime.readStateRevision -ge 3 -and $runtime.historicalUsageRevision -ge 2
$listener = $null
if (-not $runtimeReady) { $listener = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($listener -and (-not $runtime -or $runtime.nativeControlsRevision -lt 3 -or $runtime.connectorRevision -lt 2 -or $runtime.connectorUpdateRevision -lt 1 -or $runtime.chatgptRevision -lt 2 -or $runtime.remoteBrowserRevision -lt 3 -or $runtime.threadSyncRevision -lt 1 -or $runtime.historySyncRevision -lt 3 -or $runtime.mediaRevision -lt 1 -or $runtime.readStateRevision -lt 3 -or $runtime.historicalUsageRevision -lt 2)) {
  $serviceProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
  $supervisorProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $serviceProcess.ParentProcessId)
  if ($serviceProcess.Name -ne 'node.exe' -or -not $serviceProcess.CommandLine.Contains((Join-Path $rootPath 'server.mjs')) -or -not $supervisorProcess.CommandLine.Contains((Join-Path $rootPath 'start.mjs'))) { throw '端口 4317 被其他程序使用，未停止或覆盖它。' }
  # Replace the supervisor as well as its child. This is required when the
  # supervisor was started outside the current Codex task and lacks app-tools.
  Stop-Process -Id $supervisorProcess.ProcessId -Force
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $listener = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { Start-Sleep -Milliseconds 200 }
  } while ($listener -and [DateTime]::UtcNow -lt $stopDeadline)
  if ($listener) { throw '旧远程服务未及时退出，未启动第二个服务。' }
}
if (-not $runtimeReady -and -not $listener) {
  $serviceCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot '启动Relay后台.ps1') + '"'
  $started = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $PSScriptRoot '启动Relay后台.ps1')) -WorkingDirectory $rootPath -WindowStyle Hidden -PassThru
  if (-not $started) { throw '后台启动失败，请查看 .relay-data 下的服务日志。' }
}
$deadline = [DateTime]::UtcNow.AddSeconds(40)
do {
  try { $runtime = Invoke-RestMethod ($baseUrl + '/api/runtime') -TimeoutSec 2 } catch { $runtime = $null }
  if (-not $runtime -or $runtime.nativeControlsRevision -lt 3 -or $runtime.connectorRevision -lt 2 -or $runtime.connectorUpdateRevision -lt 1 -or $runtime.chatgptRevision -lt 2 -or $runtime.remoteBrowserRevision -lt 3 -or $runtime.threadSyncRevision -lt 1 -or $runtime.historySyncRevision -lt 3 -or $runtime.mediaRevision -lt 1 -or $runtime.readStateRevision -lt 3 -or $runtime.historicalUsageRevision -lt 2) { Start-Sleep -Milliseconds 500 }
} while ((-not $runtime -or $runtime.nativeControlsRevision -lt 3 -or $runtime.connectorRevision -lt 2 -or $runtime.connectorUpdateRevision -lt 1 -or $runtime.chatgptRevision -lt 2 -or $runtime.remoteBrowserRevision -lt 3 -or $runtime.threadSyncRevision -lt 1 -or $runtime.historySyncRevision -lt 3 -or $runtime.mediaRevision -lt 1 -or $runtime.readStateRevision -lt 3 -or $runtime.historicalUsageRevision -lt 2) -and [DateTime]::UtcNow -lt $deadline)
if (-not $runtime -or $runtime.nativeControlsRevision -lt 3 -or $runtime.connectorRevision -lt 2 -or $runtime.connectorUpdateRevision -lt 1 -or $runtime.chatgptRevision -lt 2 -or $runtime.remoteBrowserRevision -lt 3 -or $runtime.threadSyncRevision -lt 1 -or $runtime.historySyncRevision -lt 3 -or $runtime.mediaRevision -lt 1 -or $runtime.readStateRevision -lt 3 -or $runtime.historicalUsageRevision -lt 2) { throw '后台没有完成启动，请查看服务日志。' }
Invoke-RestMethod ($baseUrl + '/api/health/recover') -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
do {
  $health = Invoke-RestMethod ($baseUrl + '/api/health') -TimeoutSec 3
  if ($health.checking -or $health.runner.state -eq 'offline') { Start-Sleep -Milliseconds 500 }
} while (($health.checking -or $health.runner.state -eq 'offline') -and [DateTime]::UtcNow -lt $deadline)
if (-not $Quiet) {
  foreach ($name in @('relay','runner','desktop','tailscale','external')) { Write-Host $health.$name.message }
  if ($health.external.url) { Write-Host ('远程地址：' + $health.external.url) }
}
if (-not $NoBrowser) { Start-Process -FilePath ($baseUrl + '/?health=1') }

