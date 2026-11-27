param(
    [switch]$StartNow,
    [switch]$Uninstall
)

# 安装 / 卸载桌面伴侣：
#   - 开机自启：启动文件夹里放一个指向 start_desktop.vbs 的快捷方式（无黑框）
#   - 快捷键：桌面快捷方式，Ctrl+Alt+T 唤起页面（已开则只开页面，不会多开托盘）
# 只写快捷方式，不碰注册表、不装服务。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vbs = Join-Path $PSScriptRoot 'start_desktop.vbs'
$startupDir = [Environment]::GetFolderPath('Startup')
$desktopDir = [Environment]::GetFolderPath('Desktop')
$startupLnk = Join-Path $startupDir '情感中枢托盘.lnk'
$desktopLnk = Join-Path $desktopDir '情感中枢.lnk'

if ($Uninstall) {
    foreach ($file in @($startupLnk, $desktopLnk)) {
        if (Test-Path $file) { Remove-Item $file -Force }
    }
    Write-Host '已移除开机自启与桌面快捷键。'
    exit 0
}

$shell = New-Object -ComObject WScript.Shell

$startup = $shell.CreateShortcut($startupLnk)
$startup.TargetPath = 'wscript.exe'
$startup.Arguments = '"' + $vbs + '"'
$startup.WorkingDirectory = $root
$startup.WindowStyle = 7
$startup.Description = '情感中枢 · 开机托盘'
$startup.Save()

$desktop = $shell.CreateShortcut($desktopLnk)
$desktop.TargetPath = 'wscript.exe'
$desktop.Arguments = '"' + $vbs + '" -Open'
$desktop.WorkingDirectory = $root
$desktop.WindowStyle = 7
$desktop.Description = '情感中枢 · Ctrl+Alt+T 唤起'
$desktop.Hotkey = 'CTRL+ALT+T'
$desktop.Save()

Write-Host '已安装：'
Write-Host ('  开机自启 -> ' + $startupLnk)
Write-Host ('  桌面快捷键 -> ' + $desktopLnk + '（Ctrl+Alt+T）')

if ($StartNow) {
    Start-Process 'wscript.exe' -ArgumentList ('"' + $vbs + '"')
    Write-Host '托盘已启动。'
}
