const fs = require('fs');
const path = require('path');
const readline = require('readline');
const CodeIndex = require('./codeIndex');

// 只读代码工作区工具：read_range / outline / search。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；路径解析、忽略表、
// 读取追踪等公共能力仍留在 host 上，这里只做编排。
class CodeWorkspaceTools {
  constructor(host) {
    this.host = host;
  }

  codeReadRange(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const resolved = host.coding.resolveInWorkspace(userId, args.taskId, args.path);
    if (!resolved.success) return resolved;
    let content;
    try {
      const stat = fs.statSync(resolved.path);
      if (stat.isDirectory()) return { success: false, error: '这是目录；读内容请给具体文件路径' };
      if (stat.size > 2 * 1024 * 1024) {
        return { success: false, error: `文件过大(${stat.size}字节)，请用 code_search 定位后再分段读` };
      }
      content = fs.readFileSync(resolved.path, 'utf8');
    } catch (error) {
      return { success: false, error: `读取失败: ${error.message}` };
    }
    host.noteFileRead(resolved.taskId, resolved.rel, resolved.path);
    const lines = content.split(/\r?\n/);
    const total = lines.length;
    const start = Math.max(1, parseInt(args.startLine, 10) || 1);
    const rawEnd = parseInt(args.endLine, 10) || (start + 200 - 1);
    const end = Math.min(total, Math.max(start, rawEnd));
    const slice = start > total ? [] : lines.slice(start - 1, end);
    const numbered = slice.map((line, i) => `${String(start + i).padStart(5, ' ')}\t${line}`).join('\n');
    const nextStart = end < total ? end + 1 : 0;
    const result = {
      success: true,
      taskId: resolved.taskId,
      path: resolved.rel,
      totalLines: total,
      startLine: start,
      endLine: start > total ? 0 : end,
      truncated: end < total,
      // 给模型一个「接着读」的行号，避免它自己算偏移时反复重叠上一段。
      nextStart,
      content: numbered
    };
    const runId = String((host.activeContext && host.activeContext.runId) || args.runId || '').trim();
    if (!runId) return result;
    // 同一 run 内重复读同一区间：直接拒绝并指出从哪继续。
    // 实测一次失控轮次里 138 次读取有 71 次与已读区间重叠，全部是重复上下文。
    const key = `${resolved.taskId}|${resolved.rel}`;
    const tracker = host.readTrackerFor(runId);
    const ranges = tracker.get(key) || [];
    const coveredTo = ranges.reduce((max, [s, e]) => (s <= start && e >= end ? Math.max(max, e) : max), 0);
    if (coveredTo >= end) {
      return {
        success: false,
        repeated: true,
        taskId: resolved.taskId,
        path: resolved.rel,
        totalLines: total,
        error: `该区间 ${start}-${end} 本次运行已读过，未重复返回。请从第 ${coveredTo + 1} 行继续，或改读其他文件。`,
        nextStart: coveredTo + 1
      };
    }
    const overlapped = ranges.reduce(
      (n, [s, e]) => n + Math.max(0, Math.min(e, end) - Math.max(s, start) + 1),
      0
    );
    ranges.push([start, end]);
    tracker.set(key, ranges);
    if (overlapped > 0) {
      result.alreadyReadLines = overlapped;
      result.note = `其中 ${overlapped} 行本次运行已读过；继续读请用 nextStart=${nextStart}，不要重读。`;
    }
    return result;
  }

  // 文件骨架：Markdown 列标题，代码列定义。抄的是 Cody/Cline 的「先 outline 再读」，
  // 专门治长文档（8000 行 md）只能 200 行一段段硬啃的问题。
  async codeOutline(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const resolved = host.coding.resolveInWorkspace(userId, args.taskId, args.path);
    if (!resolved.success) return resolved;
    const max = Math.max(1, Math.min(parseInt(args.maxResults, 10) || 200, 500));
    let text;
    try {
      const stat = fs.statSync(resolved.path);
      if (stat.isDirectory()) return { success: false, error: '这是目录；outline 需要具体文件路径' };
      if (stat.size > 2 * 1024 * 1024) {
        return { success: false, error: `文件过大(${stat.size}字节)，请用 code_search 定位后再读` };
      }
      text = fs.readFileSync(resolved.path, 'utf8');
    } catch (error) {
      return { success: false, error: `读取失败: ${error.message}` };
    }
    const lines = text.split(/\r?\n/);
    const ext = path.extname(resolved.rel).toLowerCase();
    let kind = 'code';
    let items = [];
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
      kind = 'markdown';
      let inFence = false;
      for (let i = 0; i < lines.length && items.length < max; i++) {
        const line = lines[i];
        // 代码块里的 # 是注释/标题样例，不是文档结构
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) items.push({ line: i + 1, level: m[1].length, title: m[2].slice(0, 120) });
      }
    } else {
      const langName = CodeIndex.EXT_TO_LANG[ext] || '';
      if (!langName) {
        return { success: false, error: `不支持的文件类型：${ext || '(无扩展名)'}；建议改用 code_search` };
      }
      try {
        await host.codeIndex.ensureReady();
        const lang = await host.codeIndex.languageOf(langName);
        if (!lang) return { success: false, error: `没有可用的 ${langName} 语法解析器；建议改用 code_search` };
        const info = host.codeIndex.parseFileInfo(text, langName);
        items = info.symbols
          .map(s => ({ line: s.line, kind: s.kind, name: s.name, container: s.container || '' }))
          .sort((a, b) => a.line - b.line)
          .slice(0, max);
      } catch (error) {
        return { success: false, error: `解析失败: ${error.message}` };
      }
    }
    return {
      success: true,
      taskId: resolved.taskId,
      path: resolved.rel,
      kind,
      totalLines: lines.length,
      itemCount: items.length,
      truncated: items.length >= max,
      items,
      hint: '先按 outline 定位，再用 code_read_range 读对应区间（用 nextStart 接着读，别重读）。'
    };
  }

  // 工作区检索：流式逐行，不把整文件读进内存；参数只保留大小写/glob/上下文三项
  async codeSearch(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const taskId = args.taskId;
    const base = host.coding.taskDir(userId, taskId);
    if (!base || !fs.existsSync(base)) return { success: false, error: `工作区不存在: ${taskId}` };
    const pattern = String(args.pattern || '');
    if (!pattern) return { success: false, error: '缺少 pattern 参数' };
    if (pattern.length > 500) return { success: false, error: 'pattern 过长（上限 500 字符）' };
    const flags = args.caseSensitive ? '' : 'i';
    let re;
    try {
      re = new RegExp(pattern, flags);
    } catch (error) {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    const origin = args.path
      ? host.coding.resolveInWorkspace(userId, taskId, args.path)
      : { success: true, path: base };
    if (!origin.success) return origin;
    const max = Math.max(1, Math.min(parseInt(args.maxResults, 10) || 50, 200));
    // Claude Code 的 Grep 三件套：output_mode（content/files/count）+ offset 分页。
    // files 只回路径（先定位再读），count 回每文件命中数（判断热区），都省 token。
    const mode = ['content', 'files', 'count'].includes(String(args.output_mode || args.outputMode || 'content').toLowerCase())
      ? String(args.output_mode || args.outputMode || 'content').toLowerCase()
      : 'content';
    const offset = Math.max(0, parseInt(args.offset, 10) || 0);
    const context = Math.max(0, Math.min(parseInt(args.context, 10) || 0, 3));
    const globs = String(args.glob || '').split(',').map(s => s.trim()).filter(Boolean).map(g => host.globToRegExp(g));
    const ignores = host.loadIgnoreMatchers(base);
    const deadline = Date.now() + 5000;
    const MAX_SIZE = 8 * 1024 * 1024;
    const MAX_LINE = 4000;
    const files = [];
    // 先收集候选文件：忽略 node_modules/.git 与 .gitignore 命中的路径，符号链接一律不跟随
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const rel = host.toWorkspaceRel(base, full);
        if (host.isIgnoredPath(rel, entry.isDirectory(), ignores)) continue;
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        if (globs.length && !globs.some(g => g.test(rel))) continue;
        files.push(full);
      }
    };
    let stat;
    try { stat = fs.statSync(origin.path); } catch (error) { return { success: false, error: '搜索起点不存在' }; }
    if (stat.isDirectory()) walk(origin.path); else files.push(origin.path);
    const results = [];
    let timedOut = false;
    let scanned = 0;
    const scanFile = async (full) => {
      let info;
      try { info = await fs.promises.stat(full); } catch (error) { return; }
      if (!info.isFile() || info.size > MAX_SIZE) return;
      // 二进制探测：首块含 NUL 就跳过，避免把图片/可执行文件当文本扫
      let fd;
      try {
        fd = await fs.promises.open(full, 'r');
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        if (buf.subarray(0, bytesRead).includes(0)) return;
      } catch (error) {
        return;
      } finally {
        if (fd) await fd.close().catch(() => {});
      }
      scanned++;
      const rel = host.toWorkspaceRel(base, full);
      const prev = [];
      const pending = [];
      let lineNo = 0;
      const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
      for await (const line of rl) {
        lineNo++;
        if ((lineNo & 255) === 0 && Date.now() > deadline) { timedOut = true; rl.close(); break; }
        // 已命中条目的后置上下文
        for (let i = pending.length - 1; i >= 0; i--) {
          const item = pending[i];
          if (item.remaining > 0) {
            item.result.contextAfter.push({ line: lineNo, text: line.trim().slice(0, 300) });
            item.remaining--;
          }
          if (item.remaining <= 0) pending.splice(i, 1);
        }
        const probe = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
        if (re.test(probe)) {
          const item = { path: rel, line: lineNo, text: line.trim().slice(0, 300) };
          if (context > 0) {
            item.contextBefore = prev.map(x => ({ line: x.line, text: x.text }));
            item.contextAfter = [];
          }
          results.push(item);
          if (context > 0) pending.push({ result: item, remaining: context });
          if (results.length >= (max + offset) * 3) { rl.close(); break; }
        }
        if (context > 0) {
          prev.push({ line: lineNo, text: line.trim().slice(0, 300) });
          if (prev.length > context) prev.shift();
        }
      }
    };
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(8, files.length));
    const worker = async () => {
      while (cursor < files.length) {
        if (Date.now() > deadline) { timedOut = true; return; }
        const full = files[cursor++];
        await scanFile(full);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    // 并发读取会打乱顺序，按文件+行号稳定排序后再截断
    results.sort((a, b) => (a.path === b.path ? a.line - b.line : (a.path < b.path ? -1 : 1)));
    // 超时/没扫完时必须明说「结果不完整」，否则模型会把「没搜到」直接当成「不存在」，
    // 然后转去整文件瞎读（实测就是这么烧掉 1900 万 token 的）。
    const incomplete = timedOut || scanned < files.length;
    const shared = {
      success: true,
      taskId: String(taskId),
      pattern,
      outputMode: mode,
      offset,
      timedOut,
      filesScanned: scanned,
      filesTotal: files.length,
      complete: !incomplete,
      warning: incomplete
        ? `检索未覆盖全部文件（${scanned}/${files.length}），结果不完整，不要据此判定「没有」；请缩小 path / glob 再搜。`
        : undefined
    };
    if (mode === 'files') {
      const paths = [...new Set(results.map(r => r.path))].sort();
      const filesHit = paths.slice(offset, offset + max);
      return { ...shared, matchCount: filesHit.length, truncated: offset + max < paths.length, files: filesHit };
    }
    if (mode === 'count') {
      const counts = new Map();
      for (const r of results) counts.set(r.path, (counts.get(r.path) || 0) + 1);
      const rows = [...counts.entries()]
        .map(([p, c]) => ({ path: p, count: c }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      const page = rows.slice(offset, offset + max);
      return { ...shared, matchCount: page.length, totalMatches: results.length, truncated: offset + max < rows.length, counts: page };
    }
    const final = results.slice(offset, offset + max);
    return { ...shared, matchCount: final.length, truncated: offset + max < results.length, results: final };
  }

  handlers() {
    return {
      code_read_range: (args) => this.codeReadRange(args),
      code_outline: (args) => this.codeOutline(args),
      code_search: (args) => this.codeSearch(args)
    };
  }
}

module.exports = { CodeWorkspaceTools };
