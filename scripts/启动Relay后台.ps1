$projectRoot = Split-Path -Parent $PSScriptRoot
$ErrorActionPreference = 'Stop'
$nodePath = if ($env:CODEX_NODE_PATH) { $env:CODEX_NODE_PATH } else { (Get-Command node.exe -ErrorAction Stop).Source }
if (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
if (-not $env:CODEX_CLI_PATH) {
  $codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  $codex = Get-ChildItem -LiteralPath $codexBin -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($codex) { $env:CODEX_CLI_PATH = $codex.FullName }
}
$serviceNode = $nodePath
$outLog = Join-Path $projectRoot '.relay-data\service-background-out.log'
$errorLog = Join-Path $projectRoot '.relay-data\service-background-error.log'
$serviceArgument = '"' + (Join-Path $projectRoot 'start.mjs') + '"'
$serviceProcess = Start-Process -FilePath $serviceNode -ArgumentList $serviceArgument -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errorLog -PassThru
$serviceProcess.WaitForExit()
exit $serviceProcess.ExitCode
