[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$ClaudeArgs
)

$ErrorActionPreference = 'Stop'
$env:ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
$env:ANTHROPIC_MODEL = 'deepseek-flash[1m]'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-flash[1m]'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-flash[1m]'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-flash'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-flash'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:CLAUDE_CODE_EFFORT_LEVEL = 'max'
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '786432'

$credentialPath = Join-Path $env:USERPROFILE '.claude\deepseek-auth.dpapi'
if (Test-Path -LiteralPath $credentialPath) {
  $secure = (Get-Content -LiteralPath $credentialPath -Raw).Trim() | ConvertTo-SecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:ANTHROPIC_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
elseif ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_AUTH_TOKEN)) {
  if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
    $secure = Read-Host 'DeepSeek API key (hidden input)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $env:ANTHROPIC_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
  }
  else {
    $env:ANTHROPIC_AUTH_TOKEN = $env:DEEPSEEK_API_KEY
  }
}

& claude @ClaudeArgs
exit $LASTEXITCODE
