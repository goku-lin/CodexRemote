@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0src\maintenance-password.mjs"
pause
