@echo off
chcp 65001 >nul
if exist "%~dp0CodexRemote.exe" (
  start "" "%~dp0CodexRemote.exe"
) else (
  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\manager-ui.ps1"
)
