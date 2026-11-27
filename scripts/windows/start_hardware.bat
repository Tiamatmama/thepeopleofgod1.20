@echo off
title thepeopleofgod1.20 - Hardware Model Channel
chcp 65001 >nul
cls

echo.
echo ====================================
echo   Hardware Model Channel (41900)
echo ====================================
echo.

cd /d "%~dp0..\.."

set "NODE_PATH="
where node >nul 2>nul
if not errorlevel 1 set "NODE_PATH=node"
if not defined NODE_PATH if exist "runtime\node.exe" set "NODE_PATH=runtime\node.exe"

if not defined NODE_PATH (
    echo ERROR: Node.js not found!
    echo.
    pause
    exit /b 1
)

if not exist "hardware\model\cli.js" (
    echo ERROR: hardware\model\cli.js not found!
    echo.
    pause
    exit /b 1
)

echo Address:  http://127.0.0.1:41900
echo UI:       http://localhost:41888/hardware.html
echo Boundary: character / QQ / Bilibili / coding sandbox are NOT connected.
echo.
echo Press Ctrl+C to stop
echo.

"%NODE_PATH%" "hardware\model\cli.js" serve

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Hardware channel exited with code %errorlevel%
    pause
)
