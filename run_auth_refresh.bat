@echo off
title NotebookLM Auth Refresh
echo.
echo ======================================
echo   NotebookLM Auth Refresh
echo ======================================
echo.
echo Starting PowerShell script...
echo.
powershell.exe -ExecutionPolicy Bypass -File "%~dp0refresh_auth.ps1"
echo.
echo Closing in 5 seconds...
timeout /t 5
