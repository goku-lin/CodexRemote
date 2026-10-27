@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\启动项目.ps1" %*
set "startupExitCode=%errorlevel%"
if not "%startupExitCode%"=="0" pause
exit /b %startupExitCode%
