const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { exec, spawn } = require('child_process');

// 会造成不可逆系统损伤的命令：在进沙箱前直接拦下（沙箱账户也挡不住关机/格式化）
const DANGEROUS_PATTERNS = [
  { re: /\b(shutdown|logoff)\b/i, label: '关机 / 注销' },
  { re: /\b(Restart-Computer|Stop-Computer)\b/i, label: '重启 / 关机' },
  { re: /\bformat(\.com)?\s+[a-z]:/i, label: '格式化磁盘' },
  { re: /\bdiskpart\b/i, label: 'diskpart 分区操作' },
  { re: /\bbcdedit\b/i, label: '修改启动配置' },
  { re: /\bvssadmin\s+delete\b/i, label: '删除卷影副本' },
  { re: /\bwbadmin\s+delete\b/i, label: '删除系统备份' },
  { re: /\bnet\s+user\s+\S+[\s\S]*\/add\b/i, label: '新增系统账户' },
  { re: /\bnet\s+localgroup\b[\s\S]*\/add\b/i, label: '修改用户组' },
  { re: /\bsc(\.exe)?\s+delete\b/i, label: '删除系统服务' },
  { re: /\breg(\.exe)?\s+delete\s+["']?hklm/i, label: '删除系统注册表' },
  { re: /\bcipher(\.exe)?\s+\/w/i, label: '擦除磁盘空闲空间' },
  { re: /\bwmic\b[\s\S]*\bdelete\b/i, label: 'wmic 删除操作' },
  { re: /\bschtasks\b[\s\S]*\/delete\b/i, label: '删除计划任务' },
  { re: /\bRemove-Item\b[^\r\n]*-Recurse[^\r\n]*[A-Za-z]:\\(Windows|Program Files)/i, label: '递归删除系统目录' },
  { re: /\bdel\b[^\r\n]*\/[fsq][^\r\n]*[A-Za-z]:\\Windows/i, label: '删除系统目录' },
  { re: /\b(rd|rmdir)\s+\/s[^\r\n]*\s[a-z]:\\?\s*$/i, label: '删除盘符根目录' }
];

// 写类命令：同工作区串行，避免两个进程同时改同一批文件把项目写坏
const WRITE_PATTERNS = [
  /\b(del|erase|rmdir|rd|move|copy|xcopy|robocopy|mkdir|md|ren|rename|attrib|icacls|takeown)\b/i,
  /\bgit\s+(checkout|restore|reset|clean|apply|merge|rebase|commit|pull|clone|stash|am|cherry-pick)\b/i,
  /\b(npm|pnpm|yarn)\s+(i|install|ci|add|remove|uninstall|update|upgrade|publish|link)\b/i,
  /\bpip3?\s+(install|uninstall)\b/i,
  /\b(uv|poetry|conda)\s+(add|install|remove|sync)\b/i,
  /\b(node|python|python3|py)\s+\S+\.(js|mjs|cjs|py)\b/i,
  /\b(rm|mv|cp|touch|chmod|sed\s+-i)\b/i,
  /[>|]{1,2}\s*[^&|]/
];

// 结果文件由沙箱侧写入，只接受这些原因值；其余视为未知
const RESULT_MAX_BYTES = 64 * 1024;
const RESULT_REASONS = new Set([
  'exited', 'ok', 'idle_timeout', 'max_runtime', 'cpu_limit', 'parent_exit',
  'memory_limit', 'process_limit', 'start_failed', 'supervisor_crashed',
  'spawn_failed', 'unknown'
]);

// 纯函数形态，便于不构造实例直接单测
function dangerousReason(command) {
  for (const item of DANGEROUS_PATTERNS) {
    if (item.re.test(command)) return item.label;
  }
  return null;
}

// cmd 的重定向失败不会改 ERRORLEVEL（实测 `echo x > 受限路径` 仍 exit 0），
// 唯一可靠信号是 stderr 里那条错误；宁可把成功误判成失败，也不放过「静默未执行」
const REDIRECT_FAILURE_RE = /(Access is denied|拒绝访问|cannot find the path specified|找不到指定的路径|volume label syntax is incorrect|语法不正确)/i;

function redirectionFailure(stderr) {
  const text = String(stderr || '');
  if (!text) return null;
  const match = text.match(REDIRECT_FAILURE_RE);
  return match ? match[0] : null;
}

// 长驻进程（Claude Code）只允许带进白名单里的配置：中转站地址与模型名必须有，
// 宿主其余环境（API Key、代理、覆盖式 PATH）一律不带进去
const AGENT_ENV_KEY = /^(ANTHROPIC_|CLAUDE_CODE_)/;
const AGENT_ENV_VALUE_MAX = 500;

function sanitizeAgentEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const [key, value] of Object.entries(env)) {
    if (!AGENT_ENV_KEY.test(key)) continue;
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.length > AGENT_ENV_VALUE_MAX || /[\r\n]/.test(text)) continue;
    out[key] = text;
  }
  return out;
}

// cmd 参数只做一层引号包裹；进来的参数（开关 / 模型名 / 路径）都不含内层引号
function quoteBatchArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// POSIX 单引号转义：把 ' 变成 '\''，其余原样
function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// prompt 走 stdin 文件：多行中文塞进命令行会撞上引号与换行转义，走重定向最稳
function buildStreamBatch(exePath, args, promptPath) {
  const redirect = promptPath ? ` < ${quoteBatchArg(promptPath)}` : '';
  const line = `${quoteBatchArg(exePath)} ${args.map(quoteBatchArg).join(' ')}${redirect}`.trim();
  return ['@echo off', 'chcp 65001 >nul', line, 'exit /b %ERRORLEVEL%'].join('\r\n') + '\r\n';
}

// Linux/macOS 版：命令文件统一用 LF，避免 CRLF 被 /bin/sh 当成参数的一部分
function buildShellScript(command) {
  const lines = [
    '#!/bin/sh',
    'export PYTHONIOENCODING=utf-8',
    'export PYTHONUTF8=1',
    String(command),
    'exit $?'
  ];
  return lines.join('\n') + '\n';
}

function buildStreamShell(exePath, args, promptPath) {
  const redirect = promptPath ? ` < ${quoteShellArg(promptPath)}` : '';
  const line = `exec ${quoteShellArg(exePath)} ${args.map(quoteShellArg).join(' ')}${redirect}`.trim();
  return buildShellScript(line);
}

// Linux 沙箱子进程的环境：只给执行必需的最小集合，不把宿主密钥带进去。
// extra 只来自 sanitizeAgentEnv（ANTHROPIC_* / CLAUDE_CODE_*）
function posixSandboxEnv(extra = {}) {
  const base = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };
  if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR;
  return Object.assign(base, extra);
}

class SandboxExec {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
    this.platform = options.platform || process.platform;
    this.scriptPath = options.scriptPath || path.join(this.projectRoot, 'scripts', 'windows', 'sandbox-run.ps1');
    this.linuxScriptPath = options.linuxScriptPath || path.join(this.projectRoot, 'scripts', 'linux', 'sandbox-run.sh');
    this.tmpDir = options.tmpDir || path.join(this.projectRoot, 'data', 'sandbox-tmp');
    // 环境变量与可用性支持构造时注入，便于在任意平台做确定性测试
    this.env = options.env || process.env;
    this.lockTails = new Map();
    // 平台可注入：测试在 Windows 上也能跑 Linux 分支的纯逻辑
    this.available = typeof options.available === 'boolean'
      ? options.available
      : (this.platform === 'win32'
        ? fs.existsSync(this.scriptPath)
        : (this.platform === 'linux' && fs.existsSync(this.linuxScriptPath)));
  }

  getConfig() {
    const env = this.env;
    const num = (name, fallback) => {
      const value = parseInt(env[name], 10);
      return Number.isFinite(value) ? value : fallback;
    };
    const credentialFile = env.SANDBOX_CREDENTIAL_FILE
      ? path.resolve(this.projectRoot, env.SANDBOX_CREDENTIAL_FILE)
      : path.join(this.projectRoot, 'data', 'sandbox-credential.json');
    // 账户模式需要先跑 scripts/windows/sandbox-setup.ps1（Windows）或 scripts/linux/sandbox-setup.sh（Linux）。
    // 凭据文件只在 Windows 上是强制的：Linux 用 sudo/setpriv 切用户，没有密码可存
    const mode = String(env.SANDBOX_MODE || 'account').toLowerCase();
    const credentialMissing = this.platform === 'win32'
      && mode === 'account'
      && !fs.existsSync(credentialFile);
    return {
      enabled: env.SANDBOX_ENABLED !== 'false',
      mode,
      user: env.SANDBOX_USER || 'pog_sandbox',
      credentialFile,
      credentialMissing,
      allowHost: env.SANDBOX_ALLOW_HOST === 'true',
      idleMs: Math.max(30000, num('SANDBOX_IDLE_MS', 600000)),
      maxRuntimeMs: Math.max(0, num('SANDBOX_MAX_RUNTIME_MS', 0)),
      maxMemoryMB: Math.max(256, num('SANDBOX_MAX_MEMORY_MB', 4096)),
      maxProcesses: Math.max(1, num('SANDBOX_MAX_PROCESSES', 64)),
      cpuLimitMs: Math.max(0, num('SANDBOX_CPU_LIMIT_MS', 0)),
      serializeWrites: env.SANDBOX_SERIALIZE_WRITES !== 'false',
      maxOutputChars: Math.max(200, num('SANDBOX_MAX_OUTPUT_CHARS', 4000)),
      maxCaptureBytes: Math.max(64 * 1024, num('SANDBOX_MAX_CAPTURE_BYTES', 8 * 1024 * 1024))
    };
  }

  describe() {
    const config = this.getConfig();
    return {
      enabled: config.enabled && this.available,
      available: this.available,
      mode: config.mode,
      credentialFile: config.credentialFile,
      idleMs: config.idleMs,
      maxRuntimeMs: config.maxRuntimeMs,
      maxMemoryMB: config.maxMemoryMB,
      maxProcesses: config.maxProcesses,
      cpuLimitMs: config.cpuLimitMs,
      serializeWrites: config.serializeWrites
    };
  }

  // 允许执行的目录 = 项目根 + 调用方显式声明的额外根（导入的工作区是 junction，
  // realpath 会落到用户自己的目录，按项目根判定必然被拒，所以由调用方把该工作区传进来）
  resolveCwd(raw, allowedRoots = []) {
    const base = raw ? path.resolve(this.projectRoot, String(raw)) : this.projectRoot;
    let real = null;
    try {
      real = fs.realpathSync(base);
    } catch (error) {
      return null;
    }
    const normalized = real.toLowerCase();
    const roots = [this.projectRoot].concat(Array.isArray(allowedRoots) ? allowedRoots : []);
    for (const item of roots) {
      if (!item) continue;
      let root;
      try {
        root = fs.realpathSync(String(item));
      } catch (error) {
        root = path.resolve(String(item));
      }
      const rootLower = root.toLowerCase();
      if (normalized === rootLower || normalized.startsWith(rootLower + path.sep)) return real;
    }
    return null;
  }

  withLock(key, fn) {
    const previous = this.lockTails.get(key) || Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.lockTails.set(key, tail);
    tail.then(() => {
      if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
    });
    return run;
  }

  /**
   * 统一执行入口，返回结构与 ToolRegistry.runCommand 一致。
   * options: { cwd, full, write, lockKey, timeoutMs, allowedRoots }
   * allowedRoots：额外的允许根（导入工作区的真实目录），不传则只认项目内路径。
   * 两道闸：IdleMs 判「没活动」（默认 10 分钟），timeoutMs 判「跑太久」（与 SANDBOX_MAX_RUNTIME_MS 取小）
   */
  async run(command, options = {}) {
    if (!command) return { success: false, error: '缺少 command 参数' };
    const text = String(command);
    const config = this.getConfig();
    const workDir = this.resolveCwd(options.cwd, options.allowedRoots);
    if (!workDir) {
      return {
        success: false,
        command: text,
        cwd: String(options.cwd || ''),
        exitCode: null,
        stdout: '',
        stderr: '',
        error: `工作目录不可用（只允许项目内或已导入的工作区路径）: ${options.cwd || this.projectRoot}`
      };
    }
    // 策略先于通道：任何通道（沙箱 / 宿主）都必须先过黑名单，不能因为沙箱缺席就放行
    const danger = this.dangerousReason(text);
    if (danger) return this.blocked(text, workDir, danger);

    const channel = this.resolveChannel(config);
    if (channel !== 'ok') {
      if (config.allowHost) return this.execOnHost(text, workDir, options, config, channel);
      return this.denied(text, workDir, channel, config);
    }
    const write = !!(options.write || this.looksLikeWrite(text));
    const key = write && config.serializeWrites
      ? (options.lockKey || path.resolve(workDir).toLowerCase())
      : null;
    const execute = () => this.execOnce(text, workDir, config, options);
    try {
      return key ? await this.withLock(key, execute) : await execute();
    } catch (error) {
      return this.failure(text, workDir, `沙箱执行异常: ${error.message}`);
    }
  }

  // 通道判定只回答「走哪条路」，不做策略判断：ok=沙箱，其余值=通道不可用及原因
  resolveChannel(config) {
    if (!config.enabled) return 'disabled';
    if (!this.available) return 'unavailable';
    if (config.credentialMissing) return 'credential_missing';
    return 'ok';
  }

  blocked(command, workDir, danger) {
    return {
      success: false,
      command,
      cwd: workDir,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: `已拦截：该命令涉及${danger}，不允许在沙箱中执行`,
      sandbox: { mode: 'blocked', degraded: false, policyBlocked: true, durationMs: 0, reason: 'policy_blocked' }
    };
  }

  // 沙箱不可用且没有显式授权宿主执行：拒绝，并给出可操作的修复命令
  denied(command, workDir, reason, config) {
    return {
      success: false,
      command,
      cwd: workDir,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: `已拒绝执行：${this.channelHint(reason)}。确需在本机直接执行，请显式设置 SANDBOX_ALLOW_HOST=true（默认关闭）`,
      sandbox: { mode: config.mode, degraded: true, policyBlocked: false, durationMs: 0, reason }
    };
  }

  channelHint(reason) {
    if (reason === 'credential_missing') {
      return this.platform === 'win32'
        ? '凭据文件缺失，请以管理员身份重新运行 powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\windows\\sandbox-setup.ps1'
        : '沙箱凭据缺失，请先运行 sudo bash scripts/linux/sandbox-setup.sh';
    }
    return this.platform === 'win32'
      ? '沙箱不可用（脚本缺失或被关闭）'
      : '沙箱不可用（sandbox-run.sh 缺失或未完成配置），请先运行 sudo bash scripts/linux/sandbox-setup.sh';
  }

  dangerousReason(command) {
    return module.exports.dangerousReason(command);
  }

  looksLikeWrite(command) {
    return WRITE_PATTERNS.some(re => re.test(command));
  }

  // 沙箱不可用（非 Windows / 脚本缺失 / 显式关闭）时退回原有 exec，行为与改造前一致
  execOnHost(command, workDir, options, config, hostReason) {
    const timeout = Math.max(1000, Math.min(1800000, parseInt(options.timeoutMs, 10) || 30000));
    return new Promise((resolve) => {
      exec(command, { cwd: workDir, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const redirect = error ? null : redirectionFailure(stderr);
        resolve({
          success: !error && !redirect,
          command,
          cwd: workDir,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: (stdout || '').slice(0, config.maxOutputChars),
          stderr: (stderr || '').slice(0, config.maxOutputChars),
          ...(options.full ? { rawStdout: stdout || '', rawStderr: stderr || '' } : {}),
          error: error ? error.message : (redirect ? `指定路径写入被拒绝，命令未真正执行：${redirect}` : undefined),
          sandbox: {
            mode: 'host',
            degraded: true,
            policyBlocked: false,
            durationMs: 0,
            reason: hostReason || (this.available ? 'disabled' : 'unavailable')
          }
        });
      });
    });
  }

  // 命令落成 .cmd，避免 cmd.exe 的多层引号转义问题。
  // PATH 不在这里注入：sandbox-run.ps1 会合并注册表里的机器级/用户级 PATH，
  // 这里再 set 一次会把父进程继承来的旧 PATH 覆盖回去（服务在装 node 之前启动时就会漏掉）
  buildBatch(command) {
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'set "PYTHONIOENCODING=utf-8"',
      'set "PYTHONUTF8=1"',
      String(command),
      'exit /b %ERRORLEVEL%'
    ];
    return lines.join('\r\n') + '\r\n';
  }

  // 调用方的 timeoutMs 是「这次最多跑多久」，SANDBOX_MAX_RUNTIME_MS 是「最长能跑多久」，
  // 两者都为正时取小值；只要有一个为正就封顶，都为 0 才表示不限
  effectiveMaxRuntimeMs(config, timeoutMs) {
    const requested = Math.max(0, parseInt(timeoutMs, 10) || 0);
    const global = Math.max(0, config.maxRuntimeMs || 0);
    if (requested > 0 && global > 0) return Math.min(requested, global);
    return requested || global;
  }

  execOnce(command, workDir, config, options) {
    const token = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    } catch (error) {
      return Promise.resolve(this.failure(command, workDir, `无法创建沙箱临时目录: ${error.message}`));
    }
    const posix = this.platform !== 'win32';
    const scriptPath = path.join(this.tmpDir, `${token}${posix ? '.sh' : '.cmd'}`);
    const outPath = path.join(this.tmpDir, `${token}.out`);
    const errPath = path.join(this.tmpDir, `${token}.err`);
    const resultPath = path.join(this.tmpDir, `${token}.json`);
    try {
      fs.writeFileSync(scriptPath, posix ? buildShellScript(command) : this.buildBatch(command), { encoding: 'utf8' });
    } catch (error) {
      return Promise.resolve(this.failure(command, workDir, `无法写入沙箱${posix ? '脚本' : '批处理'}: ${error.message}`));
    }

    const paths = { scriptPath, batPath: scriptPath, workDir, outPath, errPath, resultPath };
    const args = posix ? this.linuxSupervisorArgs(config, paths, options) : this.supervisorArgs(config, paths, options);
    const bin = posix ? 'bash' : 'powershell.exe';
    const spawnOptions = posix
      ? { stdio: 'ignore', env: posixSandboxEnv() }
      : { windowsHide: true, stdio: 'ignore' };

    const startedAt = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, spawnOptions);
      } catch (error) {
        this.cleanup([scriptPath, outPath, errPath, resultPath]);
        resolve(this.failure(command, workDir, `无法启动沙箱监督进程: ${error.message}`));
        return;
      }

      let settled = false;
      const finish = (meta) => {
        if (settled) return;
        settled = true;
        const durationMs = Date.now() - startedAt;
        const stdout = this.readCapped(outPath, config.maxCaptureBytes);
        const stderr = this.readCapped(errPath, config.maxCaptureBytes);
        const exitCode = Number.isInteger(meta.exitCode) ? meta.exitCode : null;
        const redirect = exitCode === 0 ? redirectionFailure(stderr) : null;
        const ok = exitCode === 0 && !meta.error && !redirect;
        resolve({
          success: ok,
          command,
          cwd: workDir,
          exitCode,
          stdout: stdout.slice(0, config.maxOutputChars),
          stderr: stderr.slice(0, config.maxOutputChars),
          ...(options.full ? { rawStdout: stdout, rawStderr: stderr } : {}),
          error: ok ? undefined : (meta.error || (redirect ? `指定路径写入被拒绝，命令未真正执行：${redirect}` : this.reasonText(meta.reason, config))),
          sandbox: {
            mode: meta.accountMode || config.mode,
            // Job 没挂上时内存/进程数/杀树全部失效：执行结果照实报，但必须让调用方看见「约束没生效」
            degraded: meta.jobReady !== true,
            policyBlocked: false,
            durationMs,
            reason: meta.reason || 'unknown'
          }
        });
        this.cleanup([scriptPath, outPath, errPath, resultPath]);
      };

      child.on('error', (error) => finish({ exitCode: null, error: `沙箱监督进程启动失败: ${error.message}`, reason: 'spawn_failed' }));
      child.on('close', (code) => {
        const meta = this.readResult(resultPath);
        if (!meta) {
          finish({
            exitCode: code === 0 ? null : code,
            error: `沙箱监督进程异常退出（code=${code}），未产生结果文件`,
            reason: 'supervisor_crashed'
          });
          return;
        }
        if (meta.startError) {
          finish({
            exitCode: null,
            error: `沙箱内进程启动失败: ${meta.startError}`,
            reason: 'start_failed',
            accountMode: meta.accountMode
          });
          return;
        }
        finish(meta);
      });
    });
  }

  supervisorArgs(config, paths, options = {}, env = null) {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath,
      '-BatPath', paths.batPath,
      '-Cwd', paths.workDir,
      '-OutPath', paths.outPath,
      '-ErrPath', paths.errPath,
      '-ResultPath', paths.resultPath,
      '-WorkBase', this.tmpDir,
      '-IdleMs', String(config.idleMs),
      '-MaxRuntimeMs', String(this.effectiveMaxRuntimeMs(config, options.timeoutMs)),
      '-MaxMemoryMB', String(config.maxMemoryMB),
      '-MaxProcesses', String(config.maxProcesses),
      '-CpuLimitMs', String(config.cpuLimitMs),
      '-ParentPid', String(process.pid)
    ];
    if (env && Object.keys(env).length) args.push('-EnvJson', JSON.stringify(env));
    if (config.mode === 'account') args.push('-RunAsUser', config.user, '-CredentialFile', config.credentialFile);
    return args;
  }

  // Linux 监督脚本的参数：与 Windows 版一一对应，另加「用 sudo 还是 setpriv」
  linuxSupervisorArgs(config, paths, options = {}) {
    const privileged = typeof process.getuid === 'function' && process.getuid() === 0;
    const args = [
      this.linuxScriptPath,
      '--script', paths.scriptPath,
      '--cwd', paths.workDir,
      '--out', paths.outPath,
      '--err', paths.errPath,
      '--result', paths.resultPath,
      '--work-base', this.tmpDir,
      '--idle-ms', String(config.idleMs),
      '--max-runtime-ms', String(this.effectiveMaxRuntimeMs(config, options.timeoutMs)),
      '--max-memory-mb', String(config.maxMemoryMB),
      '--max-processes', String(config.maxProcesses),
      '--cpu-limit-ms', String(config.cpuLimitMs),
      '--user', String(config.user),
      '--parent-pid', String(process.pid),
      privileged ? '--privileged' : '--sudo'
    ];
    // sudo 默认清空环境；带 -E 保住 caller 传进来的最小环境（不含宿主密钥）
    if (!privileged) args.push('--preserve-env');
    return args;
  }

  /**
   * 流式执行一个可执行文件（Claude Code 这类需要逐行解析输出的长驻进程）。
   * 与 run() 的区别：不阻塞到结束，立刻返回 { success, pid, promise, stop }；
   * onLine 随输出增长被逐行调用，promise 在进程结束时兑现完整元数据。
   * 通道不可用时默认拒绝，只有 SANDBOX_ALLOW_HOST=true 才退回宿主直跑。
   */
  startStreamed(exePath, args, options = {}) {
    const bin = String(exePath || '');
    if (!bin) return { success: false, error: '缺少可执行文件路径' };
    const config = this.getConfig();
    const workDir = this.resolveCwd(options.cwd, options.allowedRoots);
    if (!workDir) {
      return {
        success: false,
        error: `工作目录不可用（只允许项目内或已导入的工作区路径）: ${options.cwd || this.projectRoot}`
      };
    }
    const channel = this.resolveChannel(config);
    if (channel !== 'ok') {
      if (!config.allowHost) {
        return {
          success: false,
          error: `已拒绝启动：${this.channelHint(channel)}`,
          sandbox: { mode: config.mode, degraded: true, reason: channel }
        };
      }
      return this.startOnHost(bin, args, { ...options, workDir }, config, channel);
    }
    return this.startInSandbox(bin, args, { ...options, workDir }, config);
  }

  startInSandbox(bin, args, options, config) {
    const token = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    } catch (error) {
      return { success: false, error: `无法创建沙箱临时目录: ${error.message}` };
    }
    const posix = this.platform !== 'win32';
    const scriptPath = path.join(this.tmpDir, `${token}${posix ? '.sh' : '.cmd'}`);
    const outPath = path.join(this.tmpDir, `${token}.out`);
    const errPath = path.join(this.tmpDir, `${token}.err`);
    const resultPath = path.join(this.tmpDir, `${token}.json`);
    const promptPath = options.promptText === undefined ? '' : path.join(this.tmpDir, `${token}.prompt`);
    const files = [scriptPath, outPath, errPath, resultPath].concat(promptPath ? [promptPath] : []);
    try {
      if (promptPath) fs.writeFileSync(promptPath, String(options.promptText), { encoding: 'utf8' });
      fs.writeFileSync(
        scriptPath,
        posix ? buildStreamShell(bin, args, promptPath) : buildStreamBatch(bin, args, promptPath),
        { encoding: 'utf8' }
      );
    } catch (error) {
      this.cleanup(files);
      return { success: false, error: `无法写入沙箱启动文件: ${error.message}` };
    }

    const paths = { scriptPath, batPath: scriptPath, workDir: options.workDir, outPath, errPath, resultPath };
    const agentEnv = sanitizeAgentEnv(options.env);
    const spawnArgs = posix
      ? this.linuxSupervisorArgs(config, paths, options)
      : this.supervisorArgs(config, paths, options, agentEnv);
    const spawnOptions = posix
      ? { stdio: 'ignore', env: posixSandboxEnv(agentEnv) }
      : { windowsHide: true, stdio: 'ignore' };
    let child;
    try {
      child = spawn(posix ? 'bash' : 'powershell.exe', spawnArgs, spawnOptions);
    } catch (error) {
      this.cleanup(files);
      return { success: false, error: `无法启动沙箱监督进程: ${error.message}` };
    }

    const startedAt = Date.now();
    const decoder = new StringDecoder('utf8');
    const handle = { success: true, pid: child.pid || null, promise: null, stop: null };
    let offset = 0;
    let pending = '';
    let stopped = false;

    // 输出由监督脚本写进 .out，这里只增量读新增字节；行内 UTF-8 由 decoder 续接
    const readNew = () => {
      try {
        const stat = fs.statSync(outPath);
        if (stat.size <= offset) return '';
        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(outPath, 'r');
        fs.readSync(fd, buffer, 0, length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        return decoder.write(buffer);
      } catch (error) {
        return '';
      }
    };
    const drain = () => {
      const text = readNew();
      if (!text) return;
      pending += text;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        if (line.trim()) this.safeLine(options.onLine, line);
        index = pending.indexOf('\n');
      }
    };
    const timer = setInterval(drain, 300);
    if (typeof timer.unref === 'function') timer.unref();

    handle.promise = new Promise((resolve) => {
      let settled = false;
      const finish = (meta) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        drain();
        if (pending.trim()) this.safeLine(options.onLine, pending.trim());
        pending = '';
        const exitCode = Number.isInteger(meta.exitCode) ? meta.exitCode : null;
        const stderr = this.readCapped(errPath, config.maxCaptureBytes);
        let error = meta.error;
        if (!error && meta.startError) error = `沙箱内进程启动失败: ${meta.startError}`;
        else if (!error && stopped) error = '已停止';
        else if (!error && exitCode !== 0) error = meta.reason === 'exited' ? '进程非零退出' : this.reasonText(meta.reason, config);
        resolve({
          success: exitCode === 0 && !error,
          exitCode,
          stdout: this.readCapped(outPath, config.maxCaptureBytes).slice(0, config.maxOutputChars),
          stderr: stderr.slice(0, config.maxOutputChars),
          error,
          stopped,
          sandbox: {
            mode: meta.accountMode || config.mode,
            degraded: meta.jobReady !== true,
            durationMs: Date.now() - startedAt,
            reason: meta.reason || 'unknown'
          }
        });
        this.cleanup(files);
      };

      child.on('error', (error) => finish({ exitCode: null, error: `沙箱监督进程启动失败: ${error.message}`, reason: 'spawn_failed' }));
      child.on('close', (code) => {
        const meta = this.readResult(resultPath);
        if (!meta) {
          finish({
            exitCode: code === 0 ? null : code,
            error: `沙箱监督进程异常退出（code=${code}），未产生结果文件`,
            reason: 'supervisor_crashed'
          });
          return;
        }
        if (meta.startError) {
          finish({ exitCode: null, startError: meta.startError, reason: 'start_failed', accountMode: meta.accountMode });
          return;
        }
        finish(meta);
      });
    });

    // 杀监督进程即可：Windows 退出时它会关掉带 KILL_ON_JOB_CLOSE 的 Job，
    // Linux 的监督脚本收到 TERM 后会杀掉自己进程组里的整棵树
    handle.stop = () => {
      stopped = true;
      try {
        if (child.pid) {
          if (posix) child.kill('SIGTERM');
          else spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      } catch (error) {
        // 停不下来时仍有 ParentPid 兜底
      }
    };
    return handle;
  }

  safeLine(onLine, line) {
    if (typeof onLine !== 'function') return;
    try {
      onLine(line);
    } catch (error) {
      // 解析回调出错不能打断监督进程
    }
  }

  // 显式授权宿主通道时的退化路径：仍然逐行回调，但没有任何账户/Job 约束
  startOnHost(bin, args, options, config, hostReason) {
    const env = { ...process.env, ...sanitizeAgentEnv(options.env) };
    let child;
    try {
      child = spawn(bin, args, { cwd: options.workDir, env, windowsHide: true, stdio: 'pipe' });
    } catch (error) {
      return { success: false, error: `无法启动进程: ${error.message}` };
    }
    const handle = { success: true, pid: child.pid || null, promise: null, stop: null };
    // prompt 统一走 stdin：与沙箱通道保持同一种传参方式，命令行里只留开关和模型名
    try {
      child.stdin.end(options.promptText === undefined ? '' : String(options.promptText));
    } catch (error) {
      // stdin 写不进去时由子进程自己报错
    }
    let stopped = false;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const startedAt = Date.now();
    child.stdout.on('data', (chunk) => {
      pending += decoder.write(chunk);
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        if (line.trim()) this.safeLine(options.onLine, line);
        index = pending.indexOf('\n');
      }
    });
    handle.promise = new Promise((resolve) => {
      child.on('error', (error) => {
        resolve({
          success: false,
          exitCode: null,
          error: String(error && error.message || error),
          stopped,
          sandbox: { mode: 'host', degraded: true, durationMs: Date.now() - startedAt, reason: hostReason || 'allow_host' }
        });
      });
      child.on('close', (code) => {
        if (pending.trim()) this.safeLine(options.onLine, pending.trim());
        const error = stopped ? '已停止' : (code === 0 ? undefined : '进程非零退出');
        resolve({
          success: code === 0 && !stopped,
          exitCode: code,
          error,
          stopped,
          sandbox: { mode: 'host', degraded: true, durationMs: Date.now() - startedAt, reason: hostReason || 'allow_host' }
        });
      });
    });
    handle.stop = () => {
      stopped = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch (error) {
        // 停止失败交给上层的超时兜底
      }
    };
    return handle;
  }

  // 结果文件由沙箱侧写入（同账户可写），只接受白名单字段并限制大小，其余一律丢弃
  readResult(resultPath) {
    try {
      if (fs.statSync(resultPath).size > RESULT_MAX_BYTES) return null;
      const raw = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const meta = {};
      if (Number.isInteger(parsed.exitCode)) meta.exitCode = parsed.exitCode;
      if (typeof parsed.error === 'string') meta.error = parsed.error.slice(0, 500);
      if (typeof parsed.startError === 'string') meta.startError = parsed.startError.slice(0, 500);
      if (parsed.accountMode === 'account' || parsed.accountMode === 'local') meta.accountMode = parsed.accountMode;
      if (typeof parsed.reason === 'string' && RESULT_REASONS.has(parsed.reason)) meta.reason = parsed.reason;
      // 只有沙箱明确承认 Job 挂上了才算「未降级」；字段缺失（老版本监督脚本）一律按降级处理
      meta.jobReady = parsed.jobReady === true;
      return meta;
    } catch (error) {
      return null;
    }
  }

  readCapped(filePath, maxBytes) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
      const fd = fs.openSync(filePath, 'r');
      const start = stat.size - maxBytes;
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, start);
      fs.closeSync(fd);
      return `[输出过长，仅保留末尾 ${maxBytes} 字节]\n${buffer.toString('utf8')}`.replace(/\uFFFD/g, '');
    } catch (error) {
      return '';
    }
  }

  cleanup(files) {
    for (const file of files) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        // 清理失败不影响结果
      }
    }
  }

  failure(command, workDir, message) {
    return {
      success: false,
      command,
      cwd: workDir,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: message,
      sandbox: { mode: 'error', durationMs: 0, reason: 'internal_error' }
    };
  }

  reasonText(reason, config) {
    if (reason === 'idle_timeout') {
      return `任务已连续 ${Math.round(config.idleMs / 60000)} 分钟没有任何输出/CPU 活动，判定为卡死并终止`;
    }
    if (reason === 'max_runtime') return '任务超过配置的最大运行时长，已终止';
    if (reason === 'cpu_limit') return '任务 CPU 时间超过配置上限，已终止';
    if (reason === 'parent_exit') return '上层进程已退出，任务被一并终止';
    if (reason === 'memory_limit') return '任务占用内存超过配置上限，已终止';
    if (reason === 'process_limit') return '任务创建的子进程数超过配置上限，已终止';
    return '命令执行失败';
  }
}

module.exports = SandboxExec;
module.exports.DANGEROUS_PATTERNS = DANGEROUS_PATTERNS;
module.exports.dangerousReason = dangerousReason;
module.exports.redirectionFailure = redirectionFailure;
module.exports.sanitizeAgentEnv = sanitizeAgentEnv;
module.exports.buildStreamBatch = buildStreamBatch;
module.exports.buildShellScript = buildShellScript;
module.exports.buildStreamShell = buildStreamShell;
