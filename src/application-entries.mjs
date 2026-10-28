// Both distribution formats use these internal entry points. Nothing here is a
// user-facing command file; the application owns service and window startup.
export function applicationEntries(){
  const header=["$ErrorActionPreference='Stop'","$applicationHome=Split-Path -Parent $PSScriptRoot"];
  return {
    'runtime/service.ps1':'\ufeff'+[
      "param([ValidateSet('start','run')][string]$Action='start')",...header,
      "$selected=Get-Content -Raw -LiteralPath (Join-Path $applicationHome 'current.json') | ConvertFrom-Json",
      "if ($selected.version -notmatch '^[a-f0-9]{20}$') { throw '应用版本记录无效。' }",
      "$versionRoot=Join-Path $applicationHome ('versions\\'+$selected.version)",
      "$node=Join-Path $versionRoot 'runtime\\node.exe'",
      "if ($Action -eq 'start') {",
      "  $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"'+$PSCommandPath+'\" run'",
      "  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $applicationHome -WindowStyle Hidden | Out-Null",
      "} else { & $node (Join-Path $versionRoot 'app\\connector-client.mjs') run --home $applicationHome; exit $LASTEXITCODE }",''
    ].join('\r\n'),
    'runtime/manager.ps1':'\ufeff'+[
      'param([switch]$ValidateOnly,[switch]$VerifyStatusOnly)',...header,
      "$selected=Get-Content -Raw -LiteralPath (Join-Path $applicationHome 'manager.json') | ConvertFrom-Json",
      "if ($selected.version -notmatch '^[a-f0-9]{20}$') { throw '应用版本记录无效。' }",
      "$versionRoot=Join-Path $applicationHome ('versions\\'+$selected.version)",
      "& (Join-Path $versionRoot 'app\\manager-ui.ps1') -ProjectRoot $versionRoot -ConnectorHome $applicationHome -ValidateOnly:$ValidateOnly -VerifyStatusOnly:$VerifyStatusOnly",''
    ].join('\r\n')
  };
}
