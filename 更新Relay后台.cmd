@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\更新Relay后台.ps1"
set "relayUpdateExitCode=%errorlevel%"
pause
exit /b %relayUpdateExitCode%
