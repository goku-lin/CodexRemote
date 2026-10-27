param([string]$HomeDirectory = (Split-Path -Parent $PSScriptRoot), [string]$SourceDirectory, [switch]$NoShortcut)
$ErrorActionPreference='Stop'
$HomeDirectory=[IO.Path]::GetFullPath($HomeDirectory)
if (-not $SourceDirectory) { $SourceDirectory=Join-Path $HomeDirectory 'src' }
$prebuilt=Join-Path $SourceDirectory 'manager-host.exe'
$shortcutArguments=''
function Manager-Digest([string]$File) {
  $hash=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($File)
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose();$hash.Dispose() }
}
if (Test-Path -LiteralPath $prebuilt) {
  $digest=(Manager-Digest $prebuilt).Substring(0,20)
  $hostDirectory=Join-Path $HomeDirectory ('manager-hosts\'+$digest)
  New-Item -ItemType Directory -Force -Path $hostDirectory | Out-Null
  $target=Join-Path $hostDirectory 'CodexRemote.exe'
  if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $prebuilt -Destination $target }
  elseif ((Manager-Digest $target) -ne (Manager-Digest $prebuilt)) { throw 'EXE 文件校验失败，未修改快捷方式。' }
  $shortcutArguments='--home "'+$HomeDirectory.TrimEnd('\')+'"'
  $compatibility=Join-Path $HomeDirectory 'CodexRemote.exe'
  if (-not (Test-Path -LiteralPath $compatibility)) { Copy-Item -LiteralPath $prebuilt -Destination $compatibility }
} else {
  # Developer checkout only. Portable installs always ship the built EXE.
  $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $target=Join-Path $HomeDirectory 'CodexRemote.exe'
  if (@(Get-Process -Name CodexRemote -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target }).Count) { throw '请先关闭管理窗口再安装；无需关闭 Codex 桌面或服务。' }
  $temporary=Join-Path $HomeDirectory ('CodexRemote.'+$PID+'.exe')
  try {
    & $compiler /nologo /target:winexe /optimize+ /codepage:65001 /r:System.Windows.Forms.dll ("/r:"+[Management.Automation.PSObject].Assembly.Location) ("/out:"+$temporary) (Join-Path $SourceDirectory 'manager-shell.cs')
    if ($LASTEXITCODE -ne 0) { throw '管理应用编译失败，原快捷方式未改动。' }
    Move-Item -LiteralPath $temporary -Destination $target -Force
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}
if (-not $NoShortcut) {
  $shortcutPath=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex远程.lnk'
  $backupDirectory=Join-Path $HomeDirectory '.manager-backups'
  New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
  if ((Test-Path -LiteralPath $shortcutPath) -and -not (Test-Path -LiteralPath (Join-Path $backupDirectory 'Codex远程-original.lnk'))) { Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $backupDirectory 'Codex远程-original.lnk') }
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath=$target; $shortcut.Arguments=$shortcutArguments; $shortcut.WorkingDirectory=$HomeDirectory
  $shortcut.Description='Codex Remote 启动、更新、恢复和本机执行器管理'
  $shortcut.IconLocation=$target+',0'
  $shortcut.Save()
}
Write-Output ('管理应用已安装：'+$target)
