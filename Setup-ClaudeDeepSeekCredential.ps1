[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:USERPROFILE '.claude\deepseek-auth.dpapi'),
  [switch]$ImportFromDsh
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $Path
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if ($ImportFromDsh) {
  $sourcePath = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
  $sourceText = Get-Content -LiteralPath $sourcePath -Raw
  $match = [regex]::Match($sourceText, '(?m)^\s+DEEPSEEK_API_KEY:\s*(.+)$')
  if (-not $match.Success) { throw 'DSH has no saved DeepSeek API key.' }
  $key = $match.Groups[1].Value.Trim().Trim('"').Trim("'")
  if ($key -notmatch '^sk-[A-Za-z0-9_-]+$') { throw 'The saved DSH value is not a DeepSeek API key.' }
  $secure = ConvertTo-SecureString $key -AsPlainText -Force
  $key = $null
  $sourceText = $null
} else {
  $secure = Read-Host 'DeepSeek API key (hidden input)' -AsSecureString
}
if ($secure.Length -eq 0) { throw 'API key cannot be empty.' }
try {
  $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $Path -Encoding ascii -NoNewline
} finally {
  $secure.Dispose()
}
Write-Host "Encrypted credential saved to $Path"
