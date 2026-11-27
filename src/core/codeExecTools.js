const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const securityGuard = require('./securityGuard');

// 这里的命令是用字符串拼给 shell 的，参数里只要出现能闭合引号的字符（" 或换行），
// 就能把后面的内容解释成新命令。入口处统一拦住，而不是等到 shell 层再补救。
function assertShellSafe(value, label) {
  const text = String(value);
  if (/["\r\n]/.test(text)) {
    throw new Error(`${label} 不能包含引号或换行`);
  }
  return text;
}

// 代码执行类工具：run_command / run_python / run_node / open_in_vscode。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；项目根、命令沙箱等
// 公共能力仍留在 host 上，这里只做编排。
class CodeExecTools {
  constructor(host, options = {}) {
    this.host = host;
    // 允许测试注入独立账本，避免把单测事件写进真实 data/security
    this.security = options.securityGuard || securityGuard;
  }

  runCommand(command, cwd, timeoutMs, opts = {}) {
    if (!command) return Promise.resolve({ success: false, error: '缺少 command 参数' });
    // 危险命令闸门：不可逆/硬件级的直接拒；破坏性但可恢复的照跑但记一笔（审批在上层）
    const verdict = this.security.guardCommand(String(command));
    if (verdict.level !== 'ok') {
      this.security.ledger.record({
        action: 'exec',
        source: 'model',
        command: String(command),
        level: verdict.level,
        blocked: !verdict.allowed,
        reason: verdict.reason,
        actor: { channel: opts.channel || 'tool' }
      });
    }
    if (!verdict.allowed) {
      return Promise.resolve({
        success: false,
        blocked: true,
        command: String(command),
        error: `已拦截：${verdict.reason}`
      });
    }
    const projectRoot = this.host.projectRoot;
    const workDir = cwd ? path.resolve(projectRoot, String(cwd)) : projectRoot;
    // timeout 同时传给沙箱作为单次墙钟上限；再叠加「连续无活动」判定（见 SANDBOX_IDLE_MS）
    const timeout = Math.max(1000, Math.min(1800000, parseInt(timeoutMs, 10) || 30000));
    // opts.full=true 时额外带回未截断的原文，仅供本地落盘，绝不能直接进 prompt
    const keepFull = !!(opts && opts.full);

    // 宿主操作（拉起 VS Code / 打开页面 / 查本机进程）必须留在当前用户会话，否则会开进沙箱账户里或看不到宿主进程
    if (opts && opts.hostOnly) {
      return new Promise((resolve) => {
        exec(String(command), { cwd: workDir, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          resolve({
            success: !error,
            command: String(command),
            cwd: workDir,
            exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            stdout: (stdout || '').slice(0, 4000),
            stderr: (stderr || '').slice(0, 4000),
            ...(keepFull ? { rawStdout: stdout || '', rawStderr: stderr || '' } : {}),
            error: error ? error.message : undefined
          });
        });
      });
    }

    // 其余命令统一进沙箱：低权限账户隔离文件，Job Object 限制内存/进程数并负责杀整棵进程树
    return this.host.sandbox.run(String(command), {
      cwd: workDir,
      full: keepFull,
      write: !!(opts && opts.write),
      lockKey: opts && opts.lockKey,
      timeoutMs: timeout,
      allowedRoots: opts && opts.allowedRoots
    });
  }

  // Python / Node 脚本执行：可执行已有文件，也可把代码写入临时文件后执行
  runScript(kind, args = {}) {
    const projectRoot = this.host.projectRoot;
    const runtime = kind === 'python'
      ? (process.env.PYTHON_BIN || 'python')
      : (process.env.NODE_BIN || 'node');
    const file = args.file || args.path;
    const code = args.code || args.source;
    if (!file && !code) {
      return Promise.resolve({ success: false, runtime, error: '需要提供 file（脚本路径）或 code（要运行的代码）' });
    }
    let scriptPath;
    let tempScript = false;
    try {
      if (file) {
        scriptPath = path.resolve(projectRoot, assertShellSafe(file, 'file'));
        if (!fs.existsSync(scriptPath)) {
          return Promise.resolve({ success: false, runtime, error: `脚本文件不存在: ${scriptPath}` });
        }
      } else {
        const tempDir = path.join(projectRoot, '.tool-tmp');
        fs.mkdirSync(tempDir, { recursive: true });
        const ext = kind === 'python' ? 'py' : 'js';
        scriptPath = path.join(tempDir, `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
        fs.writeFileSync(scriptPath, String(code), 'utf8');
        tempScript = true;
      }
    } catch (error) {
      return Promise.resolve({ success: false, runtime, error: `准备脚本失败: ${error.message}` });
    }
    const argList = Array.isArray(args.args) ? args.args : [];
    let extraArgs;
    try {
      extraArgs = argList.map(item => `"${assertShellSafe(item, 'args')}"`).join(' ');
    } catch (error) {
      return Promise.resolve({ success: false, runtime, error: `参数不合法: ${error.message}` });
    }
    // 父本账本：记下这次执行的脚本是谁生成的、落在哪、哈希多少
    this.security.ledger.record({
      action: 'write',
      source: file ? 'import' : 'model',
      path: scriptPath,
      detail: file ? `执行已有脚本 (${runtime})` : `模型生成脚本 (${runtime})`,
      actor: { channel: 'tool' }
    });
    // 仅当是带路径的完整可执行文件时才加引号：Windows 下把裸命令名括起来会让 .cmd 包装器找不到自身目录
    const runtimeArg = /[\\/ ]/.test(runtime) ? `"${runtime}"` : runtime;
    // Python 在 Windows 管道下默认按本地代码页（GBK）编码 stdout/stderr，Node 侧按 utf-8 解会成乱码，
    // 这里固定 PYTHONIOENCODING，脚本里的中文才能原样回来
    const envPrefix = kind === 'python' ? 'set "PYTHONIOENCODING=utf-8" && ' : '';
    const command = `${envPrefix}${runtimeArg} "${scriptPath}"${extraArgs ? ` ${extraArgs}` : ''}`;
    const timeoutMs = args.timeoutMs || 60000;
    return this.runCommand(command, args.cwd, timeoutMs, { write: true }).then((result) => {
      if (tempScript) {
        try {
          fs.unlinkSync(scriptPath);
        } catch (error) {
          console.warn(`[ToolRegistry] 清理临时脚本失败: ${error.message}`);
        }
      }
      return Object.assign({}, result, { runtime, script: scriptPath, temporaryScript: tempScript });
    });
  }

  openInVscode(target, line) {
    if (!target) return Promise.resolve({ success: false, error: '缺少 path 参数' });
    const bin = process.env.VSCODE_BIN || 'code';
    // 这条命令走 hostOnly（不经沙箱），路径里的引号会直接改变宿主命令结构，先挡住
    let targetPath;
    try {
      targetPath = path.resolve(this.host.projectRoot, assertShellSafe(target, 'path'));
    } catch (error) {
      return Promise.resolve({ success: false, error: `路径不合法: ${error.message}` });
    }
    const lineNumber = parseInt(line, 10);
    // 仅当是带路径的完整可执行文件时才加引号：Windows 下把裸命令名括起来会让 code.cmd 找不到自身目录
    const binArg = /[\\/ ]/.test(bin) ? `"${bin}"` : bin;
    const command = lineNumber > 0
      ? `${binArg} --goto "${targetPath}:${lineNumber}"`
      : `${binArg} "${targetPath}"`;
    return this.runCommand(command, undefined, 15000, { hostOnly: true }).then(result => Object.assign({}, result, {
      opened: targetPath,
      line: lineNumber > 0 ? lineNumber : undefined,
      hint: result.success ? '已调用 VS Code 打开' : '调用 VS Code 失败，请确认已安装 VS Code 且 code 命令在 PATH 中（或配置 VSCODE_BIN）'
    }));
  }

  handlers() {
    return {
      run_command: (args) => this.runCommand(args.command, args.cwd, args.timeoutMs),
      run_python: (args) => this.runScript('python', args),
      run_node: (args) => this.runScript('node', args),
      open_in_vscode: (args) => this.openInVscode(args.path, args.line)
    };
  }
}

module.exports = { CodeExecTools };
