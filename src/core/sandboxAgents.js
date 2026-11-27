'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 沙箱内的 Claude Code 执行器（多 Agent 联动）
// 与 codingLoop 的区别：codingLoop 用内置工具循环 + api.js 底模；
// 这里把「真正改代码」交给本机的 Claude Code CLI，工作目录锁在
// data/coding/workspaces/<用户>/<taskId>/，模型请求统一走本地中转站。
// 同一 taskId 互斥、不同 taskId 可并行，并发数有上限。

const AGENT_DIR = path.join('data', 'coding', 'agents');
const DEFAULT_CONCURRENCY = 2;
const MAX_PROMPT_CHARS = 20000;
const RESULT_MAX_CHARS = 4000;
const KEEP_RUNS = 50;

function defaultClaudeBin() {
  // 沙箱账户读不到宿主用户目录下的安装：设了 SANDBOX_CLAUDE_BIN 就用它（例如只读副本或公共安装）
  const override = String(process.env.SANDBOX_CLAUDE_BIN || '').trim();
  if (override) return path.resolve(override);
  const appData = process.env.APPDATA || '';
  return path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
}

// 沙箱账户读不到安装目录时监督进程只会回一句 Access is denied，
// 这里翻译成能照着做的修复步骤，避免被当成「Claude Code 自己坏了」
function describeLaunchFailure(result, bin) {
  const raw = `${result.error || ''} ${result.stderr || ''}`;
  if (/access is denied|拒绝访问/i.test(raw)) {
    return `沙箱账户读不到 Claude Code（${bin}）：请以管理员运行 scripts\\windows\\sandbox-setup.ps1 授予只读权限，或设置 SANDBOX_CLAUDE_BIN 指向沙箱可读的副本`;
  }
  return result.error || '沙箱执行失败';
}

class SandboxAgents {
  constructor({
    coding,
    codingLoop = null,
    projectRoot,
    onEvent = null,
    relayBaseUrl = 'http://127.0.0.1:41888/relay',
    // 中转站访问令牌（字符串，或返回字符串的函数）：中转站一律要求令牌，
    // 写死一个假值会被 403 挡回来，CLI 只能在日志里留一句「认证失败」，用户什么都看不到
    relayToken = '',
    defaultModel = 'deepseek',
    smallModel = 'qwen',
    concurrency = DEFAULT_CONCURRENCY,
    claudeBin = '',
    sandbox = null
  } = {}) {
    this.coding = coding;
    this.codingLoop = codingLoop;
    this.projectRoot = projectRoot;
    this.onEvent = onEvent;
    // 命令通道：Claude Code 与 run_command 共用同一套低权账户 + Job Object 监督层。
    // 不传时退回旧的宿主直跑（只为兼容离线测试，生产装配必须传）
    this.sandbox = sandbox;
    this.relayBaseUrl = relayBaseUrl;
    this.relayToken = relayToken;
    this.defaultModel = defaultModel;
    this.smallModel = smallModel;
    this.concurrency = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
    this.claudeBin = claudeBin || defaultClaudeBin();
    this.dir = path.join(projectRoot, AGENT_DIR);
    this.runs = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  setEventNotifier(fn) {
    this.onEvent = fn;
  }

  // 令牌来源可能是配置文件（启动之后才读得到），所以允许传函数，真正启动时再取值
  resolveRelayToken() {
    const raw = typeof this.relayToken === 'function' ? this.relayToken() : this.relayToken;
    return String(raw || '').trim();
  }

  emit(event) {
    if (typeof this.onEvent !== 'function') return;
    try { this.onEvent(event); } catch { /* 广播失败不影响执行 */ }
  }

  runningRuns() {
    return Array.from(this.runs.values()).filter((run) => run.status === 'running');
  }

  summarize(run) {
    return {
      runId: run.runId,
      owner: run.owner,
      taskId: run.taskId,
      title: run.title,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      dir: run.dir,
      logFile: run.logFile,
      result: run.result,
      error: run.error,
      verification: run.verification || null,
      sandbox: run.sandbox || null
    };
  }

  list(owner) {
    return Array.from(this.runs.values())
      .filter((run) => !owner || run.owner === owner)
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .slice(0, KEEP_RUNS)
      .map((run) => this.summarize(run));
  }

  get(runId, owner) {
    const run = this.runs.get(String(runId || ''));
    if (!run) return { success: false, error: '找不到这次运行' };
    if (owner && run.owner !== owner) return { success: false, error: '无权查看别人的运行' };
    return { success: true, run: this.summarize(run) };
  }

  start({ userId, taskId, prompt, model = '', title = '', updateTask = true } = {}) {
    const owner = String(userId || '').trim();
    if (!owner) return { success: false, error: '缺少用户身份' };
    const text = String(prompt || '').trim();
    if (!text) return { success: false, error: 'prompt 不能为空' };
    if (text.length > MAX_PROMPT_CHARS) {
      return { success: false, error: `prompt 过长（上限 ${MAX_PROMPT_CHARS} 字符）` };
    }
    if (!fs.existsSync(this.claudeBin)) {
      return { success: false, error: `找不到 Claude Code：${this.claudeBin}` };
    }
    // 没有令牌就别启动了：中转站会把请求 403 掉，CLI 只在流里吐一句认证失败，
    // 任务板看不出真正原因。这里提前拦下来，直接给可照着做的修复步骤
    const relayToken = this.resolveRelayToken();
    if (!relayToken) {
      return {
        success: false,
        code: 'relay_token_missing',
        error: '中转站未配置访问令牌：先在「中转站」面板填好访问令牌（它会作为 ANTHROPIC_AUTH_TOKEN 交给 Claude Code），再执行'
      };
    }

    // 工作区由 CodingCenter 统一创建/复用，路径与编码闭环完全一致
    const workspace = this.coding.createWorkspace(owner, taskId);
    if (!workspace.success) return workspace;

    // 反向互斥：同一工作区已有编码闭环在跑时，不让 Claude Code 再进去改同一批文件
    if (this.codingLoop && typeof this.codingLoop.latestRun === 'function') {
      const loopRun = this.codingLoop.latestRun(workspace.taskId);
      if (loopRun && String(loopRun.status || '') === 'running') {
        return { success: false, code: 'conflict', error: `工作区 ${workspace.taskId} 已有编码闭环在跑（${loopRun.id}）` };
      }
    }

    const key = `${owner}:${workspace.taskId}`;
    const busy = this.runningRuns().find((run) => run.key === key);
    if (busy) {
      return { success: false, code: 'conflict', error: `工作区 ${workspace.taskId} 已有 Claude Code 在跑（${busy.runId}）` };
    }
    if (this.runningRuns().length >= this.concurrency) {
      return { success: false, code: 'busy', error: `并发已满（${this.concurrency} 个），等一个跑完再启动` };
    }

    const runId = `cc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const logDir = path.join(this.dir, this.coding.userKey(owner), workspace.taskId);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${runId}.log`);

    const modelId = String(model || this.defaultModel).trim() || this.defaultModel;
    // prompt 走 stdin（-p 不接位置参数），命令行里只留开关与模型名：
    // 多行中文进 cmd 命令行会撞上引号/换行转义，经重定向才能原样送达
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--model', modelId
    ];
    const env = {
      ANTHROPIC_BASE_URL: this.relayBaseUrl,
      ANTHROPIC_AUTH_TOKEN: relayToken,
      ANTHROPIC_MODEL: modelId,
      ANTHROPIC_SMALL_FAST_MODEL: this.smallModel,
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1'
    };

    const run = {
      runId,
      key,
      owner,
      taskId: workspace.taskId,
      title: String(title || '').slice(0, 120),
      model: modelId,
      status: 'running',
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      endedAt: '',
      exitCode: null,
      dir: workspace.dir,
      logFile,
      result: '',
      error: '',
      stopRequested: false,
      updateTask: updateTask !== false,
      child: null,
      stopHandle: null,
      sandbox: null,
      lastText: ''
    };
    this.runs.set(runId, run);
    this.prune();

    // 抢先占住任务板：置 doing 后工人池不会再把它当 todo 领走
    this.claimTask(run);

    const log = fs.createWriteStream(logFile, { flags: 'a' });
    run.logStream = log;
    log.write(`# ${run.startedAt} task=${run.taskId} model=${modelId} cwd=${workspace.dir}\n`);

    const launch = this.sandbox
      ? this.startViaSandbox(run, workspace, args, env, text)
      : this.startOnHost(run, workspace, args, env, text);

    if (!launch.success) {
      run.status = 'failed';
      run.error = launch.error;
      run.endedAt = new Date().toISOString();
      run.child = null;
      log.write(`\n# 启动被拒绝: ${launch.error}\n`);
      log.end();
      run.logStream = null;
      if (run.updateTask) this.writeBackTask(run);
      this.emit({ kind: 'agent_end', ...this.summarize(run) });
      return { success: false, error: launch.error };
    }

    this.emit({ kind: 'agent_start', ...this.summarize(run) });
    return { success: true, run: this.summarize(run) };
  }

  // 监督通道：低权限账户 + Job Object + 空闲/时长上限，输出按行回流
  startViaSandbox(run, workspace, args, env, prompt) {
    // 老工作区（尤其是刚导入、还没跑过任何命令的）可能一个 ACE 都没有：
    // 沙箱账户进去改文件会直接被拒。启动前幂等补一次授权，失败只记日志，不阻断启动
    if (workspace.dir && this.coding && typeof this.coding.ensureSandboxAccess === 'function') {
      try {
        const grant = this.coding.ensureSandboxAccess(workspace.dir);
        if (grant && grant.ok === false) {
          console.error('[SandboxAgents] 补工作区授权失败:', grant.error || '未知原因');
        }
      } catch (error) {
        console.error('[SandboxAgents] 补工作区授权异常:', error.message);
      }
    }
    // 导入的工作区是 junction，realpath 之后落在项目外：只把当前工作区这一条真实路径放行，
    // 与 code_run_tests 的做法一致，不放开整棵上级目录
    const allowedRoots = workspace.dir ? [workspace.dir] : [];
    // cwd 钉到真实路径：Claude Code 的 Write/Read 在权限检查之后还会再解析一次符号链接，
    // cwd 是 junction 时会被判成「symlink resolution changed after permission was checked」，
    // 结果模型只能退回 bash 写文件（已实测踩到）。真实路径下工具链就不会被链接骗到
    let cwd = workspace.dir;
    try { cwd = fs.realpathSync(workspace.dir); } catch { /* 解析失败就用原路径 */ }
    if (cwd !== workspace.dir && run.logStream) {
      run.logStream.write(`# cwd 是 junction，改用真实路径: ${cwd}\n`);
    }
    const handle = this.sandbox.startStreamed(this.claudeBin, args, {
      cwd,
      allowedRoots,
      env,
      promptText: prompt,
      timeoutMs: 0,
      onLine: (line) => this.consumeLine(run, line)
    });
    if (!handle.success) return handle;

    run.child = { pid: handle.pid };
    run.stopHandle = handle.stop;
    handle.promise
      .then((result) => {
        run.sandbox = result.sandbox || null;
        if (!result.success && !run.error) run.error = describeLaunchFailure(result, this.claudeBin);
        const code = Number.isInteger(result.exitCode) ? result.exitCode : 1;
        return this.finishRun(run, code);
      })
      .catch((error) => {
        console.error('[SandboxAgents] 监督通道收尾失败:', error.message);
      });
    return { success: true };
  }

  // 无监督层时（离线测试/非 Windows）的旧路径：宿主直跑，但 prompt 同样走 stdin
  startOnHost(run, workspace, args, env, prompt) {
    let child;
    try {
      child = spawn(this.claudeBin, args, {
        cwd: workspace.dir,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      return { success: false, error: `启动 Claude Code 失败: ${error.message}` };
    }
    run.child = child;
    try {
      child.stdin.end(prompt);
    } catch (error) {
      // stdin 写不进去时由子进程自己报错
    }
    child.stdout.on('data', (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).forEach((line) => {
        if (line.trim()) this.consumeLine(run, line);
      });
    });
    child.on('error', (error) => {
      run.error = String(error && error.message || error);
    });
    child.on('close', (code) => {
      this.finishRun(run, code).catch((error) => {
        console.error('[SandboxAgents] 运行收尾失败:', error.message);
      });
    });
    return { success: true };
  }

  // 日志与解析共用一条入口：沙箱/宿主两条通道的输出都从这里过
  consumeLine(run, line) {
    this.logLine(run, line);
    this.handleLine(run, line);
  }

  logLine(run, line) {
    if (run.logStream) {
      run.logStream.write(`${line}\n`);
      return;
    }
    run.pendingLog = (run.pendingLog || []).concat(line);
  }

  // 收尾：日志流在启动后创建，输出可能早于它到达，这里把缓冲的几行补写回去
  async finishRun(run, code) {
    const log = run.logStream || fs.createWriteStream(run.logFile, { flags: 'a' });
    run.logStream = log;
    (run.pendingLog || []).forEach((line) => log.write(`${line}\n`));
    run.pendingLog = null;
    return this.finalizeRun(run, code, log);
  }

  // CLI 退出不等于任务完成：正常退出后必须过与内置闭环相同的验收判据。
  // 验收期间 status 仍为 running，继续占住工作区互斥与并发名额。
  async finalizeRun(run, code, log) {
    run.exitCode = code;
    if (!run.result) run.result = run.lastText;
    run.result = String(run.result || '').slice(0, RESULT_MAX_CHARS);
    if (run.stopRequested) {
      run.status = 'stopped';
    } else if (code !== 0 || run.error) {
      run.status = 'failed';
    } else {
      run.verification = await this.verifyRun(run);
      if (run.verification.ok) {
        run.status = 'done';
      } else {
        run.status = 'failed';
        run.error = run.verification.reason || '验收未通过';
      }
    }
    run.endedAt = new Date().toISOString();
    const verification = run.verification
      ? ` verification=${run.verification.ok ? 'passed' : 'failed'} reason=${run.verification.reason}`
      : '';
    log.write(`\n# exit=${code} status=${run.status}${verification}\n`);
    log.end();
    run.logStream = null;
    run.child = null;
    run.stopHandle = null;
    if (run.updateTask) this.writeBackTask(run);
    this.emit({ kind: 'agent_end', ...this.summarize(run) });
    return run;
  }

  async verifyRun(run) {
    if (!this.codingLoop || typeof this.codingLoop.evaluate !== 'function') {
      return { ok: false, errorKind: 'verifierUnavailable', reason: '验收器不可用：无法确认改动是否通过判据', commitSha: '', stages: [] };
    }
    try {
      const task = this.coding.listTasks().find(item => item.id === run.taskId);
      const params = (task && task.params) || {};
      const criteria = {
        passCommand: String(params.passCommand || '').trim(),
        webCheck: params.webCheck || null,
        stages: Array.isArray(params.stages) ? params.stages : [],
        requireChange: params.requireChange === true
      };
      const ctx = {
        userId: run.owner,
        taskId: run.taskId,
        goal: run.title,
        ...criteria
      };
      const auditRun = {
        id: run.runId,
        taskId: run.taskId,
        iterations: [],
        stageCommits: [],
        lastGreen: ''
      };
      const check = await this.codingLoop.evaluate(ctx, auditRun, criteria);
      if (!check || check.ok !== true) {
        return {
          ok: false,
          errorKind: (check && check.errorKind) || 'verificationFailed',
          reason: (check && check.reason) || '验收器未返回通过结果',
          commitSha: '',
          stages: [],
          failures: Array.isArray(check && check.failures) ? check.failures.slice(0, 5) : []
        };
      }

      if (criteria.stages.length) {
        if (typeof this.codingLoop.runStages !== 'function') {
          return { ok: false, errorKind: 'verifierUnavailable', reason: '阶段验收器不可用：无法确认阶段判据', commitSha: '', stages: [] };
        }
        const stageRun = await this.codingLoop.runStages(ctx, auditRun, null, criteria);
        const results = Array.isArray(stageRun && stageRun.results) ? stageRun.results : [];
        if (!stageRun || stageRun.ok !== true) {
          const failed = results.filter(item => item && !item.ok);
          const detail = failed.map(item => `${item.stageId}（${item.reason || '未通过'}）`).join('；');
          return {
            ok: false,
            errorKind: 'stageFailed',
            reason: `阶段验收未通过${detail ? `：${detail}` : ''}`,
            commitSha: '',
            stages: results
          };
        }
        return {
          ok: true,
          errorKind: null,
          reason: `${check.reason || '基础验收通过'}；阶段验收通过`,
          commitSha: auditRun.lastGreen || '',
          stages: results
        };
      }

      const commitSha = typeof this.codingLoop.commitCheckpoint === 'function'
        ? this.codingLoop.commitCheckpoint(run.owner, run.taskId, `Claude Code ${run.runId} passed`, { ok: true })
        : '';
      return { ok: true, errorKind: null, reason: check.reason || '验收通过', commitSha: commitSha || '', stages: [] };
    } catch (error) {
      return { ok: false, errorKind: 'verificationError', reason: `验收执行失败: ${error.message}`, commitSha: '', stages: [] };
    }
  }

  // 解析 Claude Code 的 stream-json 行：只取正文与最终结果，其余原样留在日志里
  handleLine(run, line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      const text = event.message.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text) {
        run.lastText = text;
        this.emit({ kind: 'agent_output', ...this.summarize(run), text: text.slice(0, 2000) });
      }
    } else if (event.type === 'result') {
      if (typeof event.result === 'string' && event.result) run.result = event.result;
      if (typeof event.error === 'string' && event.error) run.error = event.error;
    }
  }

  claimTask(run) {
    if (!run.updateTask) return;
    try {
      this.coding.updateTask(run.taskId, {
        status: 'doing',
        result: `[Claude Code 已接管] ${run.runId} · model=${run.model}`
      });
    } catch { /* 任务板里没有这张卡就跳过 */ }
  }

  writeBackTask(run) {
    const detail = run.status === 'done' ? run.result : (run.error || run.result);
    const summary = detail
      ? `[Claude Code ${run.status}] ${detail}`
      : `[Claude Code ${run.status}] 日志：${run.logFile}`;
    try {
      this.coding.updateTask(run.taskId, {
        status: run.status === 'done' ? 'done' : 'todo',
        result: summary.slice(0, RESULT_MAX_CHARS)
      });
    } catch { /* 任务板里没有这张卡就跳过 */ }
  }

  stop(runId) {
    const run = this.runs.get(String(runId || ''));
    if (!run) return { success: false, error: '找不到这次运行' };
    if (run.status !== 'running' || (!run.child && !run.stopHandle)) return { success: false, error: '这次运行已经结束' };
    run.stopRequested = true;
    // 监督通道：杀掉监督进程，Job 的 KILL_ON_JOB_CLOSE 会带走整棵进程树
    if (typeof run.stopHandle === 'function') {
      try {
        run.stopHandle();
      } catch (error) {
        return { success: false, error: `停止失败: ${error.message}` };
      }
      return { success: true, run: this.summarize(run) };
    }
    const pid = run.child && run.child.pid;
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        run.child.kill('SIGTERM');
      }
    } catch (error) {
      return { success: false, error: `停止失败: ${error.message}` };
    }
    return { success: true, run: this.summarize(run) };
  }

  prune() {
    const finished = Array.from(this.runs.values())
      .filter((run) => run.status !== 'running')
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    finished.slice(KEEP_RUNS).forEach((run) => this.runs.delete(run.runId));
  }
}

module.exports = { SandboxAgents };
