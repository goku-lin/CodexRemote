param([string]$HomeDirectory = (Split-Path -Parent $PSScriptRoot), [string]$SourceDirectory, [switch]$NoShortcut)
$ErrorActionPreference='Stop'
$HomeDirectory=[IO.Path]::GetFullPath($HomeDirectory)
if (-not $SourceDirectory) { $SourceDirectory=Join-Path $HomeDirectory 'src' }
$prebuilt=Join-Path $SourceDirectory 'manager-launcher.exe'
$shortcutArguments=''
if (Test-Path -LiteralPath $prebuilt) {
  $target=Join-Path $HomeDirectory 'CodexRemote.exe'
  $temporary=Join-Path $HomeDirectory ('CodexRemote.'+$PID+'.exe')
  try { Copy-Item -LiteralPath $prebuilt -Destination $temporary; Move-Item -LiteralPath $temporary -Destination $target -Force }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
} else {
  if ((Split-Path -Leaf $SourceDirectory) -eq 'app') { throw '应用文件不完整，请重新下载完整安装包。' }
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
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath=$target; $shortcut.Arguments=$shortcutArguments; $shortcut.WorkingDirectory=$HomeDirectory
  $shortcut.Description='Codex Remote 启动、更新、恢复和本机执行器管理'
  $shortcut.IconLocation=$target+',0'
  $shortcut.Save()
}
Write-Output ('管理应用已安装：'+$target)
