@echo off
REM Double-click launcher for the static file server.
REM Runs serve.ps1 in PowerShell, bypassing the execution policy for this run.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
pause
