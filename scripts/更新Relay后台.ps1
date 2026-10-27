$ErrorActionPreference = 'Stop'
try {
  $updateSessions = (Invoke-RestMethod 'http://127.0.0.1:4317/api/sessions' -TimeoutSec 5).sessions
  if (@($updateSessions | Where-Object { $_.executionOwner -eq 'runner' -and $_.status -in @('starting','running','waiting_input','waiting_approval','interrupting') }).Count) {
    throw 'Relay 正在执行任务，请等待该任务结束后再更新后台。Codex 桌面可以继续使用。'
  }
  if (@($updateSessions | Where-Object { $_.status -in @('waiting_input','waiting_approval') }).Count) {
    throw '还有待回答或待审批的请求，请处理后再更新后台。无需退出 Codex。'
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动远程服务.ps1') -NoBrowser
  if ($LASTEXITCODE -ne 0) { throw '后台更新未完成，请查看上面的具体错误。' }
  Write-Host 'Relay 后台已更新。请刷新远程网页；Codex 桌面保持打开即可。' -ForegroundColor Green
} catch {
  Write-Host ('后台未更新：' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
