@echo off
title thepeopleofgod1.20 - Server (HTTP+HTTPS)
chcp 65001 >nul
cls

echo.
echo ====================================
echo   thepeopleofgod1.20 - Server
echo ====================================
echo.

cd /d "%~dp0..\.."

rem 优先用系统 node；没装则回落包内 runtime\node.exe
set "NODE_PATH="
where node >nul 2>nul
if not errorlevel 1 set "NODE_PATH=node"
if not defined NODE_PATH if exist "runtime\node.exe" set "NODE_PATH=runtime\node.exe"

echo [1/4] Check Node.js...
if not defined NODE_PATH (
    echo ERROR: Node.js not found!
    echo.
    echo Please install Node.js 18+ from https://nodejs.org
    echo or keep the bundled runtime\node.exe in this folder.
    echo.
    pause
    exit /b 1
)
echo OK: Node.js found (%NODE_PATH%)

echo.
echo [2/4] Check project files...
if not exist "src\server\index.js" (
    echo ERROR: Server file not found!
    echo.
    pause
    exit /b 1
)
echo OK: Project files found

echo.
echo [3/4] Start hardware model channel...
netstat -ano | findstr /C:":41900" | findstr /C:"LISTENING" >nul
if errorlevel 1 (
    start "Hardware Model Channel" "%~dp0start_hardware.bat"
    echo OK: hardware channel starting on http://127.0.0.1:41900
) else (
    echo OK: hardware channel already listening on 41900
)

echo.
echo [4/4] Starting server...
echo.
echo Address: http://localhost:41888
echo Control: %~dp0..\..\public\continue.html
echo.
echo Press Ctrl+C to stop
echo.
echo ====================================
echo.

"%NODE_PATH%" "src\server\index.js"

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Server exited with code %errorlevel%
    echo.
    pause
)

if %errorlevel% equ 0 (
    echo.
    echo Server stopped
    pause
)
