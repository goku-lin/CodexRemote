@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0打开原生桌面连接.ps1"
if errorlevel 1 pause
