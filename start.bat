@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ====================================
echo   thepeopleofgod1.20 - 一键启动
echo ====================================
echo.

rem 1) 找 node：系统已装 node 就直接用，没装才用包内 runtime\node.exe，不联网安装
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

if not defined NODE_EXE (
    echo [错误] 没找到 Node.js，也没有包内 runtime\node.exe。
    echo        请安装 Node.js 18 以上版本：https://nodejs.org/zh-cn/download
    echo        装好后重新双击本脚本即可，脚本不会自动安装 Node。
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"%NODE_EXE%" -v 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER (
    echo [错误] 检测到 node 但运行失败：%NODE_EXE%
    echo        请重装 Node.js 或删除本目录 runtime 后重试。
    echo.
    pause
    exit /b 1
)
echo [1/3] Node 已就绪：%NODE_VER%  ^(%NODE_EXE%^)

rem 2) 依赖：包内已带 node_modules 就跳过，缺了才装（需要 npm）
if exist "%~dp0node_modules\express" (
    echo [2/3] 依赖已就绪（node_modules）
) else (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo [错误] 缺少依赖且找不到 npm，请先安装 Node.js 18 以上版本再重试。
        echo.
        pause
        exit /b 1
    )
    echo [2/3] 首次运行，安装依赖（npm install）...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        echo.
        pause
        exit /b 1
    )
)

rem 3) 启动服务，就绪后自动打开浏览器（http://127.0.0.1:41888/boot.html）
echo [3/3] 启动服务...
"%NODE_EXE%" "%~dp0scripts\launch.js"
if errorlevel 1 (
    echo.
    echo [错误] 服务启动失败，请看上方报错。
    pause
)
endlocal
