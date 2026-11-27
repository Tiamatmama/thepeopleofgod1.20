# 注意：本文件保存为单个 UTF-8 BOM；重复 BOM 会让 PowerShell 5.1 的 param 块解析失败
# 一次性初始化沙箱账户（需要管理员权限）：
#   1. 建本地账户 pog_sandbox（随机密码，密码永不过期）
#   2. 给它在项目目录的修改权限，但对信任根（scripts/src/security/node_modules）、
#      签名文件、package.json 与认证数据显式拒绝写入/删除；.env 与凭据文件连读都拒绝
#   3. 用 DPAPI（当前用户）加密密码，落盘 data/sandbox-credential.json
# 用法：右键「以管理员身份运行 PowerShell」，执行
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\sandbox-setup.ps1
# 只想看当前 ACL 实际效果（不需要管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\sandbox-setup.ps1 -SelfCheck
param(
  [string]$UserName = 'pog_sandbox',
  [switch]$SelfCheck,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $SelfCheck -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限：请以管理员身份打开 PowerShell 后重新运行。' -ForegroundColor Red
  exit 1
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$credentialPath = Join-Path $projectRoot 'data\sandbox-credential.json'
$tmpDir = Join-Path $projectRoot 'data\sandbox-tmp'
$computer = 'WinNT://' + $env:COMPUTERNAME + ',computer'
$account = $env:COMPUTERNAME + '\' + $UserName

# ---- 自检：以沙箱账户身份做行为探测（读/写都实测，不看 icacls 文本）----
function Invoke-SandboxProbe {
  param([string]$CommandLine, [int]$TimeoutMs = 20000)
  $comspec = $env:ComSpec
  if (-not $comspec) { $comspec = Join-Path $env:SystemRoot 'System32\cmd.exe' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $comspec
  $psi.Arguments = '/d /s /c "' + $CommandLine + '"'
  $psi.WorkingDirectory = $projectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UserName = $script:probeUser
  $psi.Password = $script:probePassword
  $psi.Domain = $env:COMPUTERNAME
  try { $psi.EnvironmentVariables.Clear() } catch { }
  foreach ($name in @('SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $psi.EnvironmentVariables[$name] = $value }
  }
  $psi.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
  try {
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    if (-not $proc.WaitForExit($TimeoutMs)) {
      try { $proc.Kill() } catch { }
      return @{ exitCode = -1; stdout = $stdout; stderr = 'probe timeout' }
    }
    return @{ exitCode = $proc.ExitCode; stdout = $stdout; stderr = $stderr }
  } catch {
    return @{ exitCode = -1; stdout = ''; stderr = $_.Exception.Message }
  }
}

function Invoke-SelfCheck {
  if (-not (Test-Path -LiteralPath $credentialPath)) {
    [ordered]@{
      generatedAt = (Get-Date).ToString('o')
      account     = $account
      error       = '凭据文件不存在，先以管理员身份运行本脚本（不带 -SelfCheck）'
    } | ConvertTo-Json -Depth 5
    exit 2
  }

  $cred = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
  # ProcessStartInfo.Password 要的是 SecureString，不能传明文
  $script:probePassword = ConvertTo-SecureString -String ([string]$cred.password)
  $script:probeUser = [string]$cred.user
  if (-not $script:probeUser) { $script:probeUser = $UserName }

  # 身份校验：探针没跑在沙箱账户下，下面的写/读结论全部作废
  $who = Invoke-SandboxProbe 'whoami'
  $identityOk = ($who.stdout.Trim() -eq $account)

  $checks = @()
  foreach ($rel in @('', 'src', 'scripts', 'security', 'node_modules', 'data', 'data\sandbox-tmp')) {
    $dir = if ($rel) { Join-Path $projectRoot $rel } else { $projectRoot }
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $probe = Join-Path $dir '.selfcheck.tmp'
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
    $run = Invoke-SandboxProbe ('echo.>"' + $probe + '"')
    $writable = Test-Path -LiteralPath $probe
    if ($writable) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
    $checks += [ordered]@{ path = $rel; kind = 'dir'; writable = $writable; exitCode = $run.exitCode }
  }

  foreach ($rel in @('.code-signature', 'package.json', 'package-lock.json', 'data\users.json', 'data\login_sessions.json', '.env', 'data\sandbox-credential.json')) {
    $file = Join-Path $projectRoot $rel
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $lengthBefore = (Get-Item -LiteralPath $file).Length
    $read = Invoke-SandboxProbe ('type "' + $file + '" >nul')
    $write = Invoke-SandboxProbe ('type nul >> "' + $file + '"')
    $lengthAfter = (Get-Item -LiteralPath $file).Length
    $checks += [ordered]@{
      path      = $rel
      kind      = 'file'
      readable  = ($read.exitCode -eq 0)
      writable  = ($write.exitCode -eq 0 -and $lengthBefore -eq $lengthAfter)
      exitCode  = $write.exitCode
    }
  }

  $payload = [ordered]@{
    generatedAt  = (Get-Date).ToString('o')
    account      = $account
    identityOk   = $identityOk
    probeUser    = $who.stdout.Trim()
    projectRoot  = $projectRoot
    checks       = $checks
  } | ConvertTo-Json -Depth 6

  if ($OutFile) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutFile, $payload, $utf8)
  }
  $payload
  exit 0
}

if ($SelfCheck) { Invoke-SelfCheck }

Write-Host "项目目录: $projectRoot"
Write-Host "沙箱账户: $UserName"

# ---- 1. 建账户（已存在则重置密码，保证凭据文件与账户一致）----
$bytes = New-Object byte[] 24
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$password = ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x') + 'aA1!'

$host_ = [ADSI]$computer
$existing = $null
try { $existing = $host_.Children.Find($UserName, 'user') } catch { $existing = $null }

if ($existing) {
  Write-Host '账户已存在，重置密码…'
  $existing.SetPassword($password)
  $existing.SetInfo()
} else {
  Write-Host '创建账户…'
  $created = $host_.Create('User', $UserName)
  $created.SetPassword($password)
  $created.SetInfo()
  $created.Put('Description', 'POG command sandbox account (managed by scripts/windows/sandbox-setup.ps1)')
  $created.SetInfo()
}

$accountEntry = $host_.Children.Find($UserName, 'user')
# UF_DONT_EXPIRE_PASSWD = 0x10000
$flags = [int]$accountEntry.UserFlags.Value -bor 0x10000
$accountEntry.Put('UserFlags', $flags)
$accountEntry.SetInfo()

# 确保只在 Users 组里（有本地登录/批处理登录权限，没有管理员权限）
$usersGroup = [ADSI]($computer.Replace(',computer', '/Users,group'))
try {
  $usersGroup.Add('WinNT://' + $env:COMPUTERNAME + '/' + $UserName)
} catch {
  # 已在组里时会报错，忽略
}

# ---- 2. ACL：项目目录可改，但信任根/签名/认证数据禁止写入，.env 与凭据文件拒绝访问 ----
Write-Host '设置目录权限…'
if (-not (Test-Path -LiteralPath $tmpDir)) {
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
}

# 先清掉旧版本留下的显式 ACE，保证脚本可重复执行（旧版给的是整根 M）
& icacls.exe $projectRoot /remove $account 2>&1 | Out-Null

& icacls.exe $projectRoot /grant "${account}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "授予项目目录权限失败（icacls exit=$LASTEXITCODE）" }

# 沙箱只需要读，不需要改：改了这些就等于给自己提权，或者给下次的管理员进程留后门
$writeDeny = '(OI)(CI)(WD,AD,WEA,WA,DE,DC)'
foreach ($rel in @('src', 'scripts', 'security', 'node_modules')) {
  $dir = Join-Path $projectRoot $rel
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  & icacls.exe $dir /remove:d $account 2>&1 | Out-Null
  & icacls.exe $dir /deny "${account}:$writeDeny" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "拒绝写入失败：$rel（icacls exit=$LASTEXITCODE）" }
}

# data 目录本身禁止改名/删除（不带 OI/CI，避免连带把 data\sandbox-tmp 一起锁死）
$dataDir = Join-Path $projectRoot 'data'
if (Test-Path -LiteralPath $dataDir) {
  & icacls.exe $dataDir /deny "${account}:(DE)" | Out-Null
}

# 认证数据与工程清单：允许读，禁止写/删（伪造 users.json 就能给自己开管理员账号）
$fileDeny = '(WD,AD,WEA,WA,DE,DC)'
foreach ($rel in @('.code-signature', 'package.json', 'package-lock.json', 'data\users.json', 'data\login_sessions.json')) {
  $file = Join-Path $projectRoot $rel
  if (-not (Test-Path -LiteralPath $file)) { continue }
  & icacls.exe $file /remove:d $account 2>&1 | Out-Null
  & icacls.exe $file /deny "${account}:$fileDeny" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "拒绝写入失败：$rel（icacls exit=$LASTEXITCODE）" }
}

$envFile = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envFile) {
  & icacls.exe $envFile /remove:d $account 2>&1 | Out-Null
  & icacls.exe $envFile /deny "${account}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "拒绝访问 .env 失败（icacls exit=$LASTEXITCODE）" }
}

# Claude Code 默认装在当前用户的 APPDATA 下，默认只有本账户可读；沙箱账户要执行它必须有只读+执行权限。
# 只授予 RX（不带写/删），装在哪由 SANDBOX_CLAUDE_DIR 指定，默认取 npm 全局包目录
$claudeDir = ''
if ($env:SANDBOX_CLAUDE_DIR) { $claudeDir = $env:SANDBOX_CLAUDE_DIR }
elseif ($env:APPDATA) { $claudeDir = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code' }
if ($claudeDir -and (Test-Path -LiteralPath $claudeDir)) {
  & icacls.exe $claudeDir /grant "${account}:(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "警告：授予 Claude Code 只读权限失败（$claudeDir），Claude Code 执行器将无法启动" -ForegroundColor Yellow
  }
}

# 凭据文件本身不能让沙箱账户读到，否则它就能反过来调用其它身份（写入后再单独收紧权限）
if (-not (Test-Path -LiteralPath (Split-Path -Parent $credentialPath))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $credentialPath) -Force | Out-Null
}

# ---- 3. DPAPI 加密密码（只有当前用户能解开）----
$secure = ConvertTo-SecureString -String $password -AsPlainText -Force
$cipher = ConvertFrom-SecureString -SecureString $secure

$payload = [ordered]@{
  user      = $UserName
  password  = $cipher
  createdAt = (Get-Date).ToString('o')
  note      = 'DPAPI CurrentUser 加密，只能由运行本项目的 Windows 账户解开'
} | ConvertTo-Json -Depth 3

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($credentialPath, $payload, $utf8)

# 收紧凭据文件权限：只留当前账户，显式拒绝沙箱账户
# （权限串单独拼变量，避免 PowerShell 把 "$env:USERNAME:(F)" 拆错）
$ownerAce = $env:USERNAME + ':(F)'
$accountAce = $account + ':(F)'
& icacls.exe $credentialPath /inheritance:r /grant $ownerAce /deny $accountAce | Out-Null
if ($LASTEXITCODE -ne 0) { throw "收紧凭据文件权限失败（icacls exit=$LASTEXITCODE）" }

Write-Host ''
Write-Host '完成：' -ForegroundColor Green
Write-Host "  账户        $account"
Write-Host "  凭据文件    $credentialPath"
Write-Host "  临时目录    $tmpDir"
Write-Host ''
Write-Host '现在重启项目即可生效；SANDBOX_MODE 在 .env 里配置（account / local / off）。'
Write-Host "验证隔离效果：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\sandbox-setup.ps1 -SelfCheck"
