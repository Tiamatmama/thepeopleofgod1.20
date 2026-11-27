@echo off
title thepeopleofgod1.20 - Server (HTTPS only)
chcp 65001 >nul
cls

echo.
echo ====================================
echo   thepeopleofgod1.20 - HTTPS only
echo ====================================
echo.

cd /d "%~dp0..\.."

rem 优先用系统 node；没装则回落包内 runtime\node.exe
set "NODE_PATH="
where node >nul 2>nul
if not errorlevel 1 set "NODE_PATH=node"
if not defined NODE_PATH if exist "runtime\node.exe" set "NODE_PATH=runtime\node.exe"

REM HTTPS only: listen on 41443, do NOT start HTTP 41888
set SERVER_MODE=https

echo [1/3] Check Node.js...
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
echo [2/3] Check certs...
if not exist "certs\server.key" goto nocert
if not exist "certs\server.crt" goto nocert
echo OK: Certificates found
goto start

:nocert
echo ERROR: HTTPS certificate not found!
echo.
echo Need both files under certs\ :
echo   server.key
echo   server.crt
echo.
echo Generate them first (see README), or use start_http.bat instead.
echo.
pause
exit /b 1

:start
echo.
echo [3/3] Starting server (HTTPS only)...
echo.
echo Address: https://localhost:41443
echo Note: HTTP port is NOT started by this script
echo Self-signed cert: click "continue" when the browser warns.
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
