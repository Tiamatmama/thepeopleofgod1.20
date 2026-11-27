const fs = require('fs');
const path = require('path');
const { runWebCheck } = require('./webCheck');
const { runHealthCheck } = require('./healthCheck');
const { runDeploy } = require('./deploy');

// 从测试进程输出里解析结构化计数。
// 闭环判据「假绿」修复依赖 ran：空套件 / 全部 skip 时进程退出码同样是 0，
// 只看退出码会把「一个用例都没跑」误判为「通过」，所以必须知道「真的跑了几个」。
// 只认常见 runner 的汇总行；认不出就 known=false，由调用方回落退出码（不误伤构建类命令）。
// 返回：{ known, source, total, passed, failed, skipped, ran, failedNames }
//   ran = 真正执行过的用例数（passed + failed，不含 skip/todo）：ran==0 即「没跑」。
function parseTestOutput(output) {
  const text = String(output || '');
  const num = (re) => {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : null;
  };

  // 1) node:test 汇总。TAP 形态是 "# tests 5"；spec reporter（非 TTY 下 node24 实际输出）是 "ℹ tests 5"，
  //    两者标签一致，统一用 (?:#|ℹ) 前缀匹配，否则真实环境下解析不出计数、假绿修复失效。
  const pfx = '(?:#|\\u2139\\uFE0F?)';
  let total = num(new RegExp(`^${pfx}\\s*tests\\s+(\\d+)`, 'm'));
  let passed = num(new RegExp(`^${pfx}\\s*pass(?:ed)?\\s+(\\d+)`, 'm'));
  let failed = num(new RegExp(`^${pfx}\\s*fail(?:ed)?\\s+(\\d+)`, 'm'));
  let skipped = num(new RegExp(`^${pfx}\\s*skipped\\s+(\\d+)`, 'm'));
  let source = 'node-test';

  if (total === null && passed === null && failed === null) {
    // 2) pytest："5 passed, 1 failed, 2 skipped"
    passed = num(/(\d+)\s+passed/);
    failed = num(/(\d+)\s+failed/);
    skipped = num(/(\d+)\s+skipped/);
    source = 'pytest';
    if (passed === null && failed === null) {
      // 3) mocha / jest 汇总："5 passing" "1 failing" / "Tests: 1 failed, 4 passed, 5 total"
      const mochaPass = num(/(\d+)\s+passing/);
      const mochaFail = num(/(\d+)\s+failing/);
      const jestPass = num(/(\d+)\s+passed/);
      const jestFail = num(/(\d+)\s+failed/);
      if (mochaPass !== null || mochaFail !== null) {
        passed = mochaPass; failed = mochaFail; source = 'mocha';
      } else if (jestPass !== null || jestFail !== null) {
        passed = jestPass; failed = jestFail; total = num(/(\d+)\s+total/); source = 'jest';
      } else {
        return { known: false, source: null, total: null, passed: null, failed: null, skipped: null, ran: null, failedNames: [] };
      }
    }
  }

  const p = passed || 0;
  const f = failed || 0;
  const s = skipped || 0;
  const failedNames = [];
  const collectNames = (re) => {
    let mm;
    while ((mm = re.exec(text)) !== null) {
      failedNames.push(mm[1].replace(/\s*\(\d+(?:\.\d+)?\s*ms\)\s*$/, '').trim());
    }
  };
  collectNames(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/gm);   // TAP
  collectNames(/^\s*\u2716\uFE0F?\s+(.+?)\s*$/gm);      // spec reporter
  return {
    known: true,
    source,
    total: total !== null ? total : (p + f + s),
    passed: p,
    failed: f,
    skipped: s,
    ran: p + f,
    failedNames
  };
}

// 编码运维工具：读工作台脚本 / 运行脚本 / 建工作区 / 目录树 / 符号检索 / 仓库地图 /
// 跑测试 / 语法诊断 / git / 页面验收 / 健康检查 / 部署。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；工作区解析、读取追踪、
// 测试日志落盘、索引入口等公共能力仍留在 host 上，这里只做编排。
class CodeOpsTools {
  constructor(host) {
    this.host = host;
  }

  codeRead(args = {}) {
    const host = this.host;
    const base = path.basename(String(args.name || '').trim());
    if (!base) return { success: false, error: '缺少 name 参数：脚本文件名' };
    const target = path.join(host.coding.workspace, base);
    if (!host.isPathInside(target, host.coding.workspace)) {
      return { success: false, error: '脚本只能读代码工作台（data/coding/workspace/）里的文件' };
    }
    try {
      return { success: true, name: base, content: fs.readFileSync(target, 'utf8') };
    } catch (error) {
      return { success: false, error: `读取失败: ${error.message}` };
    }
  }

  async codeRun(args = {}) {
    const host = this.host;
    const resolved = host.coding.resolveWorkspaceScript(args.name, args.language, args.code);
    if (!resolved.success) {
      return resolved;
    }
    // 免授权的代价是边界收紧：单次最长 10 分钟，跑完记账
    const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 600000);
    const result = await host.runScript(resolved.kind, {
      file: resolved.file,
      cwd: resolved.cwd,
      args: args.args,
      timeoutMs
    });
    host.coding.logRun({
      time: new Date().toISOString(),
      script: path.basename(resolved.file),
      language: resolved.kind,
      exitCode: result.exitCode,
      success: !!result.success
    });
    return Object.assign({}, result, { workspace: resolved.cwd });
  }

  // 建 git 工作区：mkdir + .gitignore + git init（+ 首次提交）。已存在则复用，不弹授权。
  // 研究平台与主界面 AI 态都靠它开出一块可写、可 diff、可回滚的编码沙箱。
  codeWorkspaceCreate(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const taskId = String(args.taskId || '').trim();
    if (!userId) return { success: false, error: '缺少用户身份，无法创建私有工作区' };
    if (!taskId) return { success: false, error: '缺少 taskId：请给你的工作区起个名字（只含字母/数字/下划线/连字符）' };
    return host.coding.createWorkspace(userId, taskId);
  }

  codeListDir(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const resolved = host.coding.resolveInWorkspace(userId, args.taskId, args.path || '.');
    if (!resolved.success) return resolved;
    let stat;
    try {
      stat = fs.statSync(resolved.path);
    } catch (error) {
      return { success: false, error: `路径不存在: ${resolved.rel}` };
    }
    if (!stat.isDirectory()) {
      return { success: true, taskId: resolved.taskId, type: 'file', path: resolved.rel, size: stat.size };
    }
    const depth = Math.max(1, Math.min(parseInt(args.depth, 10) || 3, 8));
    const ignore = new Set(['node_modules', '.git']);
    const tree = [];
    const walk = (dir, level) => {
      if (level > depth) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        tree.push({ path: host.toWorkspaceRel(resolved.base, dir), error: error.message });
        return;
      }
      for (const entry of entries) {
        if (ignore.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = host.toWorkspaceRel(resolved.base, full);
        if (entry.isDirectory()) {
          tree.push({ path: rel, type: 'dir' });
          walk(full, level + 1);
        } else {
          let size = 0;
          try { size = fs.statSync(full).size; } catch (error) { size = 0; }
          tree.push({ path: rel, type: 'file', size });
        }
      }
    };
    walk(resolved.path, 1);
    return { success: true, taskId: resolved.taskId, root: resolved.rel, count: tree.length, entries: tree };
  }

  async codeFindSymbol(args = {}) {
    const host = this.host;
    const ctx = host.codeIndexRoot(args, 'name');
    if (ctx.error) return ctx.error;
    const limit = Math.max(1, Math.min(parseInt(args.maxResults, 10) || 30, 100));
    try {
      const result = await host.codeIndex.findSymbols({
        root: ctx.root, base: ctx.base, query: ctx.want, limit,
        maxFiles: host.clampMaxFiles(args.maxFiles)
      });
      return Object.assign({ success: true, taskId: ctx.taskId }, result);
    } catch (error) {
      return { success: false, error: `符号索引失败: ${error.message}` };
    }
  }

  async codeFindRefs(args = {}) {
    const host = this.host;
    const ctx = host.codeIndexRoot(args, 'name');
    if (ctx.error) return ctx.error;
    const limit = Math.max(1, Math.min(parseInt(args.maxResults, 10) || 50, 200));
    try {
      const result = await host.codeIndex.findRefs({
        root: ctx.root, base: ctx.base, name: ctx.want, limit,
        maxFiles: host.clampMaxFiles(args.maxFiles)
      });
      return Object.assign({ success: true, taskId: ctx.taskId }, result);
    } catch (error) {
      return { success: false, error: `引用索引失败: ${error.message}` };
    }
  }

  async codeRepoMap(args = {}) {
    const host = this.host;
    // 没有查询词，仍然走同一个入口拿工作区根；label 用 taskId 只是复用已有校验
    const ctx = host.codeIndexRoot(args, 'taskId');
    if (ctx.error) return ctx.error;
    const maxTokens = Math.max(200, Math.min(parseInt(args.maxTokens, 10) || 700, 900));
    try {
      const result = await host.codeIndex.repoMap({
        root: ctx.root, base: ctx.base, maxTokens,
        maxFiles: host.clampMaxFiles(args.maxFiles)
      });
      return Object.assign({ success: true, taskId: ctx.taskId }, result);
    } catch (error) {
      return { success: false, error: `仓库地图失败: ${error.message}` };
    }
  }

  async codeRunTests(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const base = host.coding.taskDir(userId, args.taskId);
    if (!base || !fs.existsSync(base)) return { success: false, error: `工作区不存在: ${args.taskId}` };
    const command = String(args.command || '').trim();
    if (!command) return { success: false, error: '缺少 command 参数' };
    const timeoutMs = Math.max(1000, Math.min(parseInt(args.timeoutMs, 10) || 300000, 1800000));
    // allowedRoots 把这个工作区的真实目录一起放行：导入的工作区是 junction，
    // 真实路径落在项目外，只按 projectRoot 判定会被沙箱直接拒成「工作目录不可用」
    host.coding.ensureSandboxAccess(base);
    const result = await host.runCommand(command, base, timeoutMs, { full: true, write: true, allowedRoots: [base] });
    // 原始输出（未截断）落本地日志；计数按原文解析——汇总行在输出末尾，截断后会丢
    const rawText = `${result.rawStdout || ''}\n${result.rawStderr || ''}`;
    const logPath = host.writeTestLog(args, command, result, rawText);
    const counts = parseTestOutput(rawText);
    const failures = host.buildFailureDetails(rawText, counts, logPath);
    try {
      host.coding.logRun({
        time: new Date().toISOString(),
        workspace: String(args.taskId),
        command,
        language: 'test',
        exitCode: result.exitCode,
        success: !!result.success
      });
    } catch (error) {
      console.warn(`[ToolRegistry] 测试运行记账失败: ${error.message}`);
    }
    return {
      success: !!result.success,
      taskId: String(args.taskId),
      command,
      exitCode: result.exitCode,
      passed: !!result.success,
      counts,
      failures,
      logPath,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error
    };
  }

  async codeDiagnose(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const taskId = args.taskId;
    const base = host.coding.taskDir(userId, taskId);
    if (!base || !fs.existsSync(base)) return { success: false, error: `工作区不存在: ${taskId}` };
    let targets = [];
    if (args.path) {
      const resolved = host.coding.resolveInWorkspace(userId, taskId, args.path);
      if (!resolved.success) return resolved;
      targets = [resolved.path];
    } else {
      const ignore = new Set(['node_modules', '.git']);
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { return; }
        for (const entry of entries) {
          if (ignore.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(js|mjs|cjs|py)$/i.test(entry.name)) targets.push(full);
        }
      };
      walk(base);
      targets = targets.slice(0, 200);
    }
    if (!targets.length) {
      return { success: true, taskId: String(taskId), checked: 0, errors: [], hint: '没有可诊断的 .js/.py 源码文件' };
    }
    const errors = [];
    let checked = 0;
    for (const file of targets) {
      const ext = path.extname(file).toLowerCase();
      const command = ext === '.py' ? `python -m py_compile "${file}"` : `node --check "${file}"`;
      const result = await host.runCommand(command, base, 30000, { hostOnly: true });
      checked += 1;
      if (!result.success) {
        errors.push({
          path: host.toWorkspaceRel(base, file),
          message: String(result.stderr || result.error || '语法错误').trim().slice(0, 500)
        });
      }
    }
    return { success: errors.length === 0, taskId: String(taskId), checked, errorCount: errors.length, errors };
  }

  codeGit(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const taskId = args.taskId;
    const action = String(args.action || '').toLowerCase();
    const base = host.coding.taskDir(userId, taskId);
    if (!base || !fs.existsSync(base)) return { success: false, error: `工作区不存在: ${taskId}` };
    switch (action) {
      case 'status':
        return host.coding.workspaceStatus(userId, taskId);
      case 'diff': {
        const argv = ['diff'];
        if (args.ref) argv.push(String(args.ref));
        return host.coding.git(userId, taskId, argv);
      }
      case 'log':
        return host.coding.git(userId, taskId, ['log', '--oneline', '-n', '20']);
      case 'show':
        return host.coding.git(userId, taskId, ['show', String(args.ref || 'HEAD'), '--stat']);
      case 'commit': {
        host.coding.git(userId, taskId, ['add', '-A']);
        const result = host.coding.gitCommit(userId, taskId, String(args.message || 'checkpoint'));
        return { success: result.success, output: result.output, error: result.error };
      }
      case 'checkout':
        return args.ref
          ? host.coding.git(userId, taskId, ['checkout', String(args.ref)])
          : host.coding.git(userId, taskId, ['checkout', '--', '.']);
      case 'revert':
        return host.coding.git(userId, taskId, ['reset', '--hard', String(args.ref || 'HEAD~1')]);
      default:
        return { success: false, error: `未知 action: ${action}（可选 status/diff/log/show/commit/checkout/revert）` };
    }
  }

  // 页面级验收：判据来自 activeContext.webCheck（runner 声明），模型无法修改
  async codeWebCheck(args = {}) {
    const host = this.host;
    const ctx = host.activeContext || {};
    const taskId = String(args.taskId || ctx.taskId || '').trim();
    if (!taskId) {
      return { success: false, verdict: 'unverified', error: '缺少 taskId，且当前上下文没有绑定编码任务' };
    }
    if (!ctx.webCheck) {
      return { success: false, verdict: 'unverified', taskId, error: '本任务没有声明 webCheck 判据，无法做页面级验收' };
    }
    return runWebCheck({
      coding: host.coding,
      userId: host.codingUserId(args),
      taskId,
      runId: ctx.runId || '',
      spec: ctx.webCheck
    });
  }

  // 部署执行：命令来自 activeContext.deploy（runner 声明），模型无法修改
  codeDeploy(args = {}) {
    const host = this.host;
    const ctx = host.activeContext || {};
    const taskId = String(args.taskId || ctx.taskId || '').trim();
    if (!taskId) {
      return { success: false, error: '缺少 taskId，且当前上下文没有绑定编码任务' };
    }
    if (!ctx.deploy) {
      return { success: false, error: '本任务没有声明 deploy 脚本，无法部署' };
    }
    const workspace = host.coding.taskDir(host.codingUserId(args), taskId);
    if (!workspace) {
      return { success: false, error: `任务 ${taskId} 的工作区不存在或 taskId 非法` };
    }
    return { taskId, ...runDeploy({ spec: ctx.deploy, workspace }) };
  }

  // 部署后健康检查：判据来自 activeContext.healthCheck（runner 声明），模型无法修改
  async codeHealthCheck(args = {}) {
    const host = this.host;
    const ctx = host.activeContext || {};
    const taskId = String(args.taskId || ctx.taskId || '').trim();
    if (!taskId) {
      return { success: false, verdict: 'unverified', error: '缺少 taskId，且当前上下文没有绑定编码任务' };
    }
    if (!ctx.healthCheck) {
      return { success: false, verdict: 'unverified', taskId, error: '本任务没有声明 healthCheck 判据，无法做部署健康检查' };
    }
    return { taskId, ...(await runHealthCheck({ spec: ctx.healthCheck })) };
  }

  handlers() {
    return {
      code_read: (args) => this.codeRead(args),
      code_run: (args) => this.codeRun(args),
      code_list_dir: (args) => this.codeListDir(args),
      code_find_symbol: (args) => this.codeFindSymbol(args),
      code_find_refs: (args) => this.codeFindRefs(args),
      code_repo_map: (args) => this.codeRepoMap(args),
      code_run_tests: (args) => this.codeRunTests(args),
      code_diagnose: (args) => this.codeDiagnose(args),
      code_git: (args) => this.codeGit(args),
      code_web_check: (args) => this.codeWebCheck(args),
      code_health_check: (args) => this.codeHealthCheck(args),
      code_deploy: (args) => this.codeDeploy(args),
      code_workspace_create: (args) => this.codeWorkspaceCreate(args)
    };
  }
}

module.exports = { CodeOpsTools, parseTestOutput };
