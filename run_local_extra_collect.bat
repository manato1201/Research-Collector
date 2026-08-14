@echo off
title Local Extra Collect
echo.
echo ======================================
echo   Local Extra Collect (Phase 5/6/7)
echo ======================================
echo.
echo Starting Python script...
echo.
cd /d "%~dp0"
python local_collect_extra.py
echo.
echo Closing in 5 seconds...
timeout /t 5
