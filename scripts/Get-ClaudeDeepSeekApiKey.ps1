[CmdletBinding()]
param(
  [string]$CredentialPath = (Join-Path $env:USERPROFILE '.claude\deepseek-auth.dpapi')
)

# Claude Code calls this apiKeyHelper over a private stdout pipe. Never invoke
# the helper for diagnostics: its stdout is the credential, not a status log.
$ErrorActionPreference = 'Stop'
# A parent PowerShell 7 can pass its module paths to Windows PowerShell 5.1.
# Load the credential cmdlets from this process's own runtime explicitly.
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -Force
$secure = $null
$ptr = [IntPtr]::Zero
try {
  if (-not (Test-Path -LiteralPath $CredentialPath)) {
    throw 'DeepSeek credential is not configured. Run Setup-ClaudeDeepSeekCredential.ps1.'
  }
  $secure = (Get-Content -LiteralPath $CredentialPath -Raw).Trim() | ConvertTo-SecureString
  if ($secure.Length -eq 0) { throw 'DeepSeek credential is empty.' }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  [Console]::Out.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($null -ne $secure) { $secure.Dispose() }
}
