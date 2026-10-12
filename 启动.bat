@echo off
REM ===================================================================
REM  Smart Scheduler one-click launcher (ASCII only on purpose!)
REM  cmd.exe parses .bat bytes with the OEM code page, so non-ASCII
REM  text inside a batch file gets mangled. All Chinese messages live
REM  in launcher.py instead, which controls its own encoding.
REM  Double-click this file to launch the app.
REM ===================================================================

chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title Smart Scheduler
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
    where py >nul 2>nul && set "PY=py -3"
)

if not defined PY (
    echo.
    echo [ERROR] Python not found.
    echo         Please install Python 3.10+ from https://www.python.org/downloads/
    echo         and remember to check "Add Python to PATH" during setup.
    echo.
    pause
    exit /b 1
)

%PY% launcher.py %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [ERROR] Startup failed with exit code %RC%. See the messages above.
    echo.
    pause
)

exit /b %RC%
