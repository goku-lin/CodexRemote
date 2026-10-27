param([ValidateRange(1,65535)][int]$Port,[Parameter(Mandatory=$true)][string]$Program,[switch]$Configure,[switch]$Elevated)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if ($Configure -and -not $Elevated) {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
        if ($Program.Contains('"') -or $PSCommandPath.Contains('"')) { throw 'Invalid program path' }
        $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Port '+$Port+' -Program "'+$Program+'" -Configure -Elevated'
        $child=Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($child.ExitCode -ne 0) { throw 'Firewall configuration failed' }
        $Configure=$false
    }
}
$Program=(Resolve-Path -LiteralPath $Program).Path
$hash=[Security.Cryptography.SHA256]::Create()
try { $key=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Program.ToLowerInvariant())))).Replace('-','').Substring(0,16) } finally { $hash.Dispose() }
$allow='CodexRemote-LAN-'+$key+'-'+$Port
$block=$allow+'-NonPrivate'
if ($Configure) {
    # Explicit blocks take precedence over unrelated broad Node allow rules.
    Get-NetFirewallRule -Name $allow,$block -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $block -DisplayName 'Codex Remote - block non-private LAN' -Direction Inbound -Action Block -Profile Public,Domain -Program $Program -Protocol TCP -LocalPort $Port | Out-Null
    New-NetFirewallRule -Name $allow -DisplayName 'Codex Remote - private LAN' -Direction Inbound -Action Allow -Profile Private -Program $Program -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
}
if (@(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count) { throw 'Windows Firewall must be enabled' }
$allowRule=Get-NetFirewallRule -Name $allow
$blockRule=Get-NetFirewallRule -Name $block
if ($allowRule.Enabled -ne 'True' -or $allowRule.Action -ne 'Allow' -or [string]$allowRule.Profile -ne 'Private' -or $blockRule.Enabled -ne 'True' -or $blockRule.Action -ne 'Block' -or [string]$blockRule.Profile -notmatch 'Public' -or [string]$blockRule.Profile -notmatch 'Domain') { throw 'Private LAN firewall rules are not active' }
$addresses=@(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Private' } | ForEach-Object { Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue } | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object -ExpandProperty IPAddress -Unique)
if (-not $addresses.Count) { throw 'No private LAN interface' }
if (-not $Elevated) { @{addresses=$addresses} | ConvertTo-Json -Compress }
