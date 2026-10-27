$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Codex远程.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath)) { exit 0 }
$package = Get-AppxPackage 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
if (-not $package) { exit 0 }
$iconPath = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $iconPath)) { exit 0 }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ([IO.Path]::GetFileName($shortcut.TargetPath) -eq 'CodexRemote.exe') { exit 0 }
$desired = "$iconPath,0"
if ($shortcut.IconLocation -ne $desired) {
  $shortcut.IconLocation = $desired
  $shortcut.Save()
}
