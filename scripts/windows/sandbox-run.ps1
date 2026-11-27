# 沙箱监督进程：把一条命令放进 Job Object 里跑，按「是否有活动」判超时，超时连整棵进程树一起杀。
# 由 src/core/sandboxExec.js 调用，不要手工执行。
param(
  [Parameter(Mandatory = $true)][string]$BatPath,
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$ErrPath,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [string]$WorkBase = '',
  [int]$IdleMs = 600000,
  [int]$MaxRuntimeMs = 0,
  [int]$MaxMemoryMB = 4096,
  [int]$MaxProcesses = 64,
  [long]$CpuLimitMs = 0,
  # 白名单外的显式环境注入（ANTHROPIC_* / CLAUDE_CODE_* 这类必需配置）。
  # 由调用方先过滤，这里再校验变量名形状，避免通过名字写进换行或非法字符
  [string]$EnvJson = '',
  [string]$RunAsUser = '',
  [string]$CredentialFile = '',
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Continue'

$jobCode = @'
using System;
using System.Runtime.InteropServices;

public static class PogJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength, IntPtr returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr Create(ulong memoryBytes, uint maxProcesses, bool killOnClose)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        uint flags = 0;
        if (memoryBytes > 0)
        {
            info.ProcessMemoryLimit = new UIntPtr(memoryBytes);
            info.JobMemoryLimit = new UIntPtr(memoryBytes);
            flags |= 0x100 | 0x200;
        }
        if (maxProcesses > 0)
        {
            info.BasicLimitInformation.ActiveProcessLimit = maxProcesses;
            flags |= 0x8;
        }
        if (killOnClose) flags |= 0x2000;
        info.BasicLimitInformation.LimitFlags = flags;

        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    public static bool Assign(IntPtr job, IntPtr process)
    {
        return AssignProcessToJobObject(job, process);
    }

    public static long CpuMs(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero)) return -1;
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return (info.TotalUserTime + info.TotalKernelTime) / 10000;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static int ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero)) return -1;
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return (int)info.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@

function Write-Result {
  param(
    [int]$Code,
    [string]$Reason,
    [string]$AccountMode,
    [string]$StartError,
    [long]$DurationMs,
    [long]$CpuMs,
    [bool]$JobReady
  )
  $payload = [ordered]@{
    exitCode    = $Code
    reason      = $Reason
    accountMode = $AccountMode
    startError  = $StartError
    durationMs  = $DurationMs
    cpuMs       = $CpuMs
    # Job Object 是否真的挂上了（内存/进程数/杀树都靠它）。false 表示约束已失效，调用方必须当降级看
    jobReady    = $JobReady
  }
  $json = $payload | ConvertTo-Json -Compress
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  try {
    [System.IO.File]::WriteAllText($ResultPath, $json, $utf8)
  } catch {
    # 结果文件写不出去时只能靠退出码传话
  }
}

function Get-FileSize {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    try { return (Get-Item -LiteralPath $Path).Length } catch { return 0 }
  }
  return 0
}

$exitCode = 1
$reason = 'exited'
$startError = ''
$accountMode = 'local'
$job = [IntPtr]::Zero
$jobReady = $false
$proc = $null
$started = $false
$cpuMs = 0
$startAt = Get-Date

$stamp = [guid]::NewGuid().ToString('N')
$tmpWork = Join-Path $WorkBase ("tmp-$stamp")
if ($WorkBase) {
  try { [void](New-Item -ItemType Directory -Path $tmpWork -Force) } catch { $tmpWork = $WorkBase }
} else {
  $tmpWork = $env:TEMP
}

try {
  # 编译一次缓存成 dll，后续每次执行直接加载，省掉每次 2~3 秒的 C# 编译。
  # 缓存必须放在沙箱账户写不到的地方，否则被替换后本进程会以当前用户身份加载它。
  $loaded = $false
  $dllDir = ''
  if ($env:LOCALAPPDATA) { $dllDir = Join-Path $env:LOCALAPPDATA 'pog-sandbox' }
  if (-not $dllDir) { $dllDir = $WorkBase }
  $dllPath = ''
  if ($dllDir) {
    try {
      if (-not (Test-Path -LiteralPath $dllDir)) { New-Item -ItemType Directory -Path $dllDir -Force | Out-Null }
      $dllPath = Join-Path $dllDir 'sandboxjob-v2.dll'
    } catch { $dllPath = '' }
  }
  if ($dllPath -and (Test-Path -LiteralPath $dllPath)) {
    try {
      Add-Type -Path $dllPath -ErrorAction Stop
      $loaded = $true
    } catch {
      $loaded = $false
    }
  }
  if (-not $loaded -and $dllPath) {
    try {
      Add-Type -TypeDefinition $jobCode -Language CSharp -OutputAssembly $dllPath -ErrorAction Stop
      Add-Type -Path $dllPath -ErrorAction Stop
      $loaded = $true
    } catch {
      $loaded = $false
    }
  }
  if (-not $loaded) {
    Add-Type -TypeDefinition $jobCode -Language CSharp -ErrorAction Stop
  }
  $job = [PogJob]::Create([uint64]$MaxMemoryMB * 1MB, [uint32]$MaxProcesses, $true)
} catch {
  # 无法建立 Job Object 时仍允许执行，只是失去内存/进程数/进程树约束
  $job = [IntPtr]::Zero
}

try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $comspec = $env:ComSpec
  if (-not $comspec) { $comspec = Join-Path $env:SystemRoot 'System32\cmd.exe' }
  $psi.FileName = $comspec
  $psi.Arguments = '/d /s /c ""' + $BatPath + '" 1> "' + $OutPath + '" 2> "' + $ErrPath + '""'
  $psi.WorkingDirectory = $Cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false

  # 不继承父进程环境：API Key 之类的秘密不能跟着进沙箱
  try { $psi.EnvironmentVariables.Clear() } catch { }
  foreach ($name in @('SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $psi.EnvironmentVariables[$name] = $value }
  }
  # PATH 不能只信父进程：服务若是安装 node 之前启动的，继承来的 PATH 里没有
  # C:\Program Files\nodejs，低权限账户就会 exit 9009。这里补上注册表里的
  # 机器级 + 用户级 PATH，去重后保留原顺序。
  $pathParts = @()
  foreach ($candidate in @([string]$env:PATH, [Environment]::GetEnvironmentVariable('PATH', 'Machine'), [Environment]::GetEnvironmentVariable('PATH', 'User'))) {
    foreach ($part in ([string]$candidate -split ';')) {
      $trimmed = $part.Trim()
      if ($trimmed -and ($pathParts -notcontains $trimmed)) { $pathParts += $trimmed }
    }
  }
  $psi.EnvironmentVariables['PATH'] = ($pathParts -join ';')
  $psi.EnvironmentVariables['TEMP'] = $tmpWork
  $psi.EnvironmentVariables['TMP'] = $tmpWork

  # 必要配置按显式注入补回（中转站地址/模型名），仍然不继承父进程的其余环境。
  # 放在账户变量之前，让 USERPROFILE 等身份相关变量不会被注入覆盖
  if ($EnvJson) {
    try {
      $extra = ConvertFrom-Json $EnvJson
      foreach ($prop in $extra.PSObject.Properties) {
        $name = [string]$prop.Name
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
        $value = [string]$prop.Value
        if ($value.Length -gt 500 -or $value -match "[`r`n]") { continue }
        $psi.EnvironmentVariables[$name] = $value
      }
    } catch {
      $startError = '沙箱环境注入失败: ' + $_.Exception.Message
      $reason = 'start_failed'
    }
  }

  if ($RunAsUser -and $CredentialFile -and (Test-Path -LiteralPath $CredentialFile)) {
    try {
      $cred = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
      $secure = ConvertTo-SecureString -String ([string]$cred.password) -ErrorAction Stop
      $psi.UserName = $RunAsUser
      $psi.Password = $secure
      $psi.Domain = $env:COMPUTERNAME
      $psi.LoadUserProfile = $true
      $accountMode = 'account'

      $profileDir = Join-Path $env:SystemDrive ("Users\" + $RunAsUser)
      $psi.EnvironmentVariables['USERPROFILE'] = $profileDir
      $psi.EnvironmentVariables['APPDATA'] = Join-Path $profileDir 'AppData\Roaming'
      $psi.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $profileDir 'AppData\Local'
      $psi.EnvironmentVariables['USERNAME'] = $RunAsUser
      $psi.EnvironmentVariables['HOMEDRIVE'] = $env:SystemDrive
      $psi.EnvironmentVariables['HOMEPATH'] = "\Users\" + $RunAsUser
    } catch {
      # 凭据解不开就直接判失败：静默退回当前用户会绕过整套低权隔离
      $startError = '低权限账户凭据不可用: ' + $_.Exception.Message
      $reason = 'start_failed'
    }
  }

  if (-not $startError) {
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
      $started = $proc.Start()
    } catch {
      # 低权限账户起不来（凭据失效 / seclogon 被禁用）时直接判失败，禁止退回当前用户执行
      $startError = '沙箱账户启动失败: ' + $_.Exception.Message
      $reason = 'start_failed'
      $started = $false
    }
  }

  if ($started) {
    if ($job -ne [IntPtr]::Zero) {
      # 挂不上就等于没有约束：这里是唯一能证明「限制真的生效」的地方，失败不能只吞掉
      try { $jobReady = [bool][PogJob]::Assign($job, $proc.Handle) } catch { $jobReady = $false }
    }

    $lastActivity = Get-Date
    $lastSize = -1
    $lastCpu = -1
    while (-not $proc.HasExited) {
      Start-Sleep -Milliseconds 400
      $size = (Get-FileSize $OutPath) + (Get-FileSize $ErrPath)
      if ($job -ne [IntPtr]::Zero) { $cpuMs = [PogJob]::CpuMs($job) } else { $cpuMs = 0 }
      if ($size -ne $lastSize -or $cpuMs -ne $lastCpu) {
        $lastActivity = Get-Date
        $lastSize = $size
        $lastCpu = $cpuMs
      }
      $now = Get-Date
      $elapsed = ($now - $startAt).TotalMilliseconds
      $idle = ($now - $lastActivity).TotalMilliseconds

      if ($ParentPid -gt 0) {
        $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        if (-not $parent) { $reason = 'parent_exit'; break }
      }
      if ($CpuLimitMs -gt 0 -and $cpuMs -ge $CpuLimitMs) { $reason = 'cpu_limit'; break }
      if ($MaxRuntimeMs -gt 0 -and $elapsed -ge $MaxRuntimeMs) { $reason = 'max_runtime'; break }
      if ($IdleMs -gt 0 -and $idle -ge $IdleMs) { $reason = 'idle_timeout'; break }
    }

    if (-not $proc.HasExited) {
      if ($jobReady) {
        [void][PogJob]::TerminateJobObject($job, 124)
      } else {
        # Job 没建成或没挂上时，TerminateJobObject 杀不到任何成员，必须退化为 taskkill 杀整棵树
        try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { }
      }
      try { $proc.Kill() } catch { }
    }
    [void]$proc.WaitForExit(5000)
    try { $exitCode = $proc.ExitCode } catch { $exitCode = 1 }

    if ($job -ne [IntPtr]::Zero) { $cpuMs = [PogJob]::CpuMs($job) }
    if ($cpuMs -lt 0) { $cpuMs = 0 }

    if ($reason -eq 'idle_timeout' -or $reason -eq 'max_runtime') { $exitCode = 124 }
    elseif ($reason -eq 'cpu_limit') { $exitCode = 137 }
    elseif ($reason -eq 'parent_exit') { $exitCode = 125 }
  } else {
    $exitCode = 126
  }
} catch {
  $startError = $_.Exception.Message
  $reason = 'supervisor_error'
  $exitCode = 1
} finally {
  if ($job -ne [IntPtr]::Zero) {
    try { [void][PogJob]::CloseHandle($job) } catch { }
  }
  if ($tmpWork -and $tmpWork -ne $env:TEMP -and (Test-Path -LiteralPath $tmpWork)) {
    try { Remove-Item -LiteralPath $tmpWork -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}

$duration = ((Get-Date) - $startAt).TotalMilliseconds
Write-Result -Code $exitCode -Reason $reason -AccountMode $accountMode -StartError $startError -DurationMs $duration -CpuMs $cpuMs -JobReady $jobReady
exit $exitCode
