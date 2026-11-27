param(
    [switch]$Open
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 桌面伴侣托盘：常驻通知区，负责起服务、看健康、开页面。
# 单实例：第二次启动（例如按了快捷键）只把页面叫到前台，不再开一个托盘。

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$port = 41888
$url = "http://127.0.0.1:$port/boot.html"
$logDir = Join-Path $root 'data\logs'
$outLog = Join-Path $logDir 'desktop.out.log'
$errLog = Join-Path $logDir 'desktop.err.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\PogDesktopTray', [ref]$created)

function Resolve-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bundled = Join-Path $root 'runtime\node.exe'
    if (Test-Path $bundled) { return $bundled }
    return $null
}

$script:node = Resolve-Node
$script:proc = $null

function Test-Health {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
        return ($response.StatusCode -ge 200)
    } catch {
        return $false
    }
}

function Start-ServerProcess {
    if (-not $script:node) { return $false }
    if (Test-Health) { return $true }
    $entry = Join-Path $root 'src\server\index.js'
    try {
        $script:proc = Start-Process -FilePath $script:node `
            -ArgumentList ('"' + $entry + '"') `
            -WorkingDirectory $root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $outLog `
            -RedirectStandardError $errLog `
            -PassThru
        return $true
    } catch {
        return $false
    }
}

function Stop-ServerProcess {
    if ($script:proc -and -not $script:proc.HasExited) {
        & taskkill /PID $script:proc.Id /T /F | Out-Null
    } else {
        # 托盘不是服务的启动者（例如服务是手动开的）：按端口找监听进程再收掉
        try {
            $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($ownerPid in $owners) {
                & taskkill /PID $ownerPid /T /F | Out-Null
            }
        } catch {
            # 端口没在监听就已经是停好了
        }
    }
    $script:proc = $null
}

if (-not $created) {
    # 已经有托盘在跑：等服务就绪再开页面，避免先看到一个连接失败页；最多等 15 秒
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Health) { break }
        Start-Sleep -Milliseconds 500
    }
    Start-Process $url
    $mutex.Dispose()
    exit 0
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add('打开酒馆')
$openItem.Add_Click({ Start-Process $url })

$restartItem = $menu.Items.Add('重启服务')
$restartItem.Add_Click({
    Stop-ServerProcess
    # 等端口真正松开，别让新进程撞上旧监听
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-Health)) { break }
        Start-Sleep -Milliseconds 250
    }
    Start-ServerProcess | Out-Null
})

$logItem = $menu.Items.Add('查看日志')
$logItem.Add_Click({
    if (Test-Path $outLog) { Start-Process notepad.exe $outLog }
})

$menu.Items.Add('-') | Out-Null

$exitItem = $menu.Items.Add('退出托盘（保留服务）')
$exitItem.Add_Click({
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$stopExitItem = $menu.Items.Add('停止服务并退出')
$stopExitItem.Add_Click({
    Stop-ServerProcess
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# 托盘图标现画：深底 + 暖黄灯，不额外带图片资源
$bitmap = New-Object System.Drawing.Bitmap 32, 32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(20, 23, 28))
$glow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(233, 194, 91))
$roof = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(164, 74, 63))
$graphics.FillEllipse($glow, 7, 7, 18, 18)
$graphics.FillRectangle($roof, 9, 15, 14, 3)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())

$tray.Icon = $icon
$tray.Text = '情感中枢 · 启动中'
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
$tray.Add_DoubleClick({ Start-Process $url })

$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 5000
$healthTimer.Add_Tick({
    if (Test-Health) {
        $tray.Text = '情感中枢 · 运行中'
        return
    }
    $tray.Text = '情感中枢 · 未就绪'
    if (-not $script:proc -or $script:proc.HasExited) {
        Start-ServerProcess | Out-Null
    }
})
$healthTimer.Start()

try {
    if (-not $script:node) {
        [System.Windows.Forms.MessageBox]::Show('没有找到 Node.js，请先安装 Node 18+ 或放入 runtime\node.exe。', '情感中枢') | Out-Null
        $tray.Visible = $false
        exit 1
    }

    Start-ServerProcess | Out-Null

    if ($Open) {
        # 快捷键唤起的场景：等服务起来再打开，最多等 15 秒
        for ($i = 0; $i -lt 30; $i++) {
            if (Test-Health) { break }
            Start-Sleep -Milliseconds 500
        }
        Start-Process $url
    }

    [System.Windows.Forms.Application]::Run()
} finally {
    $healthTimer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
