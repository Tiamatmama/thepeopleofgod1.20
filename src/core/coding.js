const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');
const { execSync, execFile, execFileSync } = require('child_process');

// 拼进 cmd 命令行前先挡住能闭合引号的字符；路径都来自用户挑的目录，不能假定干净
function assertCmdPath(value, label) {
  const text = String(value);
  if (/["\r\n]/.test(text)) {
    throw new Error(`${label} 不能包含引号或换行`);
  }
  return text;
}

// 编程沙箱（她的代码自留地）😀
// 跟研究平台并列的另一块地：任务板、代码工作台、运行日志、多人格讨论记录，
// 数据全落在 data/coding/ 下，跟主会话的情绪/好感度/记忆完全隔开。
// 这里只管存取，真正跑码的边界（只认工作台文件名）跟研究平台同一套做法。

const CODING_DIR = path.join('data', 'coding');
const WORKSPACE_DIR = path.join(CODING_DIR, 'workspace');
// git 工作区：把「扁平脚本沙箱」升级为「可嵌套、可回滚、可 diff 的仓库沙箱」，
// 与上面扁平的 workspace/ 并存；新编码工具全部走这里，旧接口保留兼容。
const WORKSPACES_DIR = path.join(CODING_DIR, 'workspaces');
const DISCUSSIONS_DIR = path.join(CODING_DIR, 'discussions');
// 每个用户的 UI 状态（打开了哪些文件、当前激活文件、各任务的信任档），
// 按登录用户名隔离，换台电脑/换个用户都能找回自己上次看到的那份代码。
const UI_STATE_DIR = path.join(CODING_DIR, 'ui-state');
// 运行转录：每次闭环的事件流按 runId 落一份 JSONL（对话追溯/回放的唯一事实源）。
// emitEvent 原本只转发不给前端留底，刷新页面就断片；这里补一份 append-only 的本地账本。
const TRANSCRIPTS_DIR = path.join(CODING_DIR, 'transcripts');
// 单份转录封顶 4MB：超出后不再追加（保头不保尾），避免长跑把磁盘撑爆
const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
// 文件改动账本：自己记账，不依赖 git；只记路径/时间/动作/字节数，不存文件内容
const FILE_HISTORY_FILE = path.join(CODING_DIR, 'file_history.log');

// 任务状态白名单，别让脏字符串混进面板
const TASK_STATUS = new Set(['todo', 'doing', 'done']);
// 点子状态机：new=刚生出 / shortlisted=入选待验证 / spike=正在低成本验证 / validated=已验证成立 / dropped=淘汰（留痕不删）
const IDEA_STATUS = new Set(['new', 'shortlisted', 'spike', 'validated', 'dropped']);
// ideas.json 写侧上限（动作 9）：条目数与单条字段长度，防模型长文本把文件无界撑大
const IDEA_MAX_ITEMS = 500;
const IDEA_FIELD_MAX = 500;
// 信任三档：readonly=只读（写操作直接拒）/ ask=每次写操作都问（默认）/ auto=放手干
const TRUST_LEVELS = new Set(['readonly', 'ask', 'auto']);
const TRUST_DEFAULT = 'ask';

class CodingCenter {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.dir = path.join(projectRoot, CODING_DIR);
    this.workspace = path.join(projectRoot, WORKSPACE_DIR);
    this.workspaces = path.join(projectRoot, WORKSPACES_DIR);
    this.discussionsDir = path.join(projectRoot, DISCUSSIONS_DIR);
    this.uiStateDir = path.join(projectRoot, UI_STATE_DIR);
    this.transcriptDir = path.join(projectRoot, TRANSCRIPTS_DIR);
    this.fileHistoryFile = path.join(projectRoot, FILE_HISTORY_FILE);
    this.tasksFile = path.join(this.dir, 'tasks.json');
    this.ideasFile = path.join(this.dir, 'ideas.json');
    this.runsFile = path.join(this.dir, 'runs.log');
    this.alertsFile = path.join(this.dir, 'alerts.log');
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.workspaces, { recursive: true });
    fs.mkdirSync(this.discussionsDir, { recursive: true });
    fs.mkdirSync(this.uiStateDir, { recursive: true });
    fs.mkdirSync(this.transcriptDir, { recursive: true });
    if (!fs.existsSync(this.tasksFile)) {
      writeJsonAtomicSync(this.tasksFile, { seq: 0, tasks: [] });
    }
    if (!fs.existsSync(this.ideasFile)) {
      writeJsonAtomicSync(this.ideasFile, { seq: 0, ideas: [] });
    }
  }

  // ---- 任务板 ----

  // 任务结构升级（破坏性）：新增 parent（父任务 id，空串=顶层）与 order（同级排序号）。
  // 旧扁构任务没有这两个字段，读入时非破坏性补齐（parent=''、order 缺省沿用数组下标），
  // 因此旧数据无需先迁移即可读。
  normalizeTask(task, index) {
    const t = (task && typeof task === 'object') ? task : {};
    return {
      ...t,
      id: String(t.id || ''),
      title: String(t.title || ''),
      desc: String(t.desc || ''),
      params: (t.params && typeof t.params === 'object') ? t.params : {},
      status: TASK_STATUS.has(t.status) ? t.status : 'todo',
      result: String(t.result || ''),
      createdBy: String(t.createdBy || ''),
      parent: typeof t.parent === 'string' ? t.parent : '',
      order: Number.isFinite(t.order) ? t.order : index,
      createdAt: t.createdAt || '',
      updatedAt: t.updatedAt || ''
    };
  }

  loadTasks() {
    try {
      const data = JSON.parse(fs.readFileSync(this.tasksFile, 'utf8'));
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      return { seq: Number(data.seq) || 0, tasks: tasks.map((t, i) => this.normalizeTask(t, i)) };
    } catch (error) {
      return { seq: 0, tasks: [] };
    }
  }

  saveTasks(store) {
    writeJsonAtomicSync(this.tasksFile, store);
  }

  listTasks(status) {
    const tasks = this.loadTasks().tasks;
    if (status && TASK_STATUS.has(String(status))) {
      return tasks.filter(t => t.status === status);
    }
    return tasks;
  }

  addTask(input = {}) {
    const title = String(input.title || '').trim();
    if (!title) return { success: false, error: '任务得有个标题（title）' };
    const store = this.loadTasks();
    store.seq += 1;
    const now = new Date().toISOString();
    // parent 只接受已存在的任务 id（防悬空父子）；order 缺省用自增序号，保证同级稳定可排
    const parent = (typeof input.parent === 'string' && input.parent && store.tasks.some(t => t.id === input.parent))
      ? input.parent
      : '';
    const task = {
      id: `c_${store.seq}`,
      title,
      desc: String(input.desc || '').trim(),
      params: (input.params && typeof input.params === 'object') ? input.params : {},
      status: 'todo',
      result: '',
      createdBy: String(input.createdBy || ''),
      parent,
      order: Number.isFinite(input.order) ? input.order : store.seq,
      createdAt: now,
      updatedAt: now
    };
    store.tasks.unshift(task);
    this.saveTasks(store);
    return { success: true, task };
  }

  updateTask(id, patch = {}) {
    if (!id) return { success: false, error: '缺少任务 id' };
    const store = this.loadTasks();
    const task = store.tasks.find(t => t.id === id);
    if (!task) return { success: false, error: `找不到任务: ${id}` };
    if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim();
    if (typeof patch.desc === 'string') task.desc = patch.desc.trim();
    if (patch.params && typeof patch.params === 'object') task.params = patch.params;
    if (typeof patch.status === 'string' && TASK_STATUS.has(patch.status)) task.status = patch.status;
    if (typeof patch.result === 'string') task.result = patch.result;
    // parent 允许清空（''）或指向已存在任务；order 只认有限数值
    if (typeof patch.parent === 'string') {
      if (patch.parent === '' || store.tasks.some(t => t.id === patch.parent)) task.parent = patch.parent;
    }
    if (Number.isFinite(patch.order)) task.order = patch.order;
    task.updatedAt = new Date().toISOString();
    this.saveTasks(store);
    return { success: true, task };
  }

  deleteTask(id) {
    const store = this.loadTasks();
    const before = store.tasks.length;
    store.tasks = store.tasks.filter(t => t.id !== id);
    if (store.tasks.length === before) return { success: false, error: `找不到任务: ${id}` };
    this.saveTasks(store);
    return { success: true, deleted: id };
  }

  // ---- 点子板（灵感小组产出：方向三）----
  // 结构 { seq, ideas:[] }，与 tasks.json 同构；单写者 + 原子替换；有界读取防无界增长。
  // 点子是「不可信内容」（模型生成），这里是纯存取，不做语义判断。

  // 归一化标题：去首尾空白、压内部空白、转小写——用作去重键
  ideaKey(title) {
    return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // 非破坏性补齐字段；状态非法一律归一为 new（不抛错、不炸，脏数据也能读）
  normalizeIdea(idea) {
    const t = (idea && typeof idea === 'object') ? idea : {};
    return {
      id: String(t.id || ''),
      title: String(t.title || '').trim().slice(0, IDEA_FIELD_MAX),
      oneLiner: String(t.oneLiner || '').trim().slice(0, IDEA_FIELD_MAX),
      // why = 这个点子治的是哪个毛病（灵感小组发散时必须交代），与 reason 分开：
      // why 是「为什么提它」，reason 是「收敛/判定的理由」
      why: String(t.why || '').trim().slice(0, IDEA_FIELD_MAX),
      source: String(t.source || '').trim(),
      persona: String(t.persona || '').trim(),
      tags: Array.isArray(t.tags) ? t.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 8) : [],
      votes: Number.isFinite(t.votes) ? t.votes : 0,
      status: IDEA_STATUS.has(t.status) ? t.status : 'new',
      reason: String(t.reason || '').slice(0, IDEA_FIELD_MAX),
      verdict: String(t.verdict || ''),
      spikeTaskId: String(t.spikeTaskId || ''),
      ts: t.ts || '',
      updatedAt: t.updatedAt || ''
    };
  }

  loadIdeas() {
    try {
      const data = JSON.parse(fs.readFileSync(this.ideasFile, 'utf8'));
      const ideas = Array.isArray(data.ideas) ? data.ideas : [];
      return { seq: Number(data.seq) || 0, ideas: ideas.map(i => this.normalizeIdea(i)) };
    } catch (error) {
      return { seq: 0, ideas: [] };
    }
  }

  saveIdeas(store) {
    writeJsonAtomicSync(this.ideasFile, store);
  }

  // 有界读取：默认最多 200 条，硬上限 500；可按状态过滤（防无界增长）
  // sortBy='votes' 时按票数降序（tie-break 保持插入序，纯读不改底层）；不传则与旧行为逐字节一致
  listIdeas({ status, limit, sortBy } = {}) {
    const ideas = this.loadIdeas().ideas;
    const filtered = (status && IDEA_STATUS.has(String(status)))
      ? ideas.filter(i => i.status === status)
      : ideas;
    const ordered = (String(sortBy) === 'votes')
      ? [...filtered].sort((a, b) => (Number.isFinite(b.votes) ? b.votes : -Infinity)
                                  - (Number.isFinite(a.votes) ? a.votes : -Infinity))
      : filtered;
    const max = Math.max(1, Math.min(parseInt(limit, 10) || 200, 500));
    return ordered.slice(0, max);
  }

  getIdea(id) {
    const target = String(id || '');
    if (!target) return { success: false, error: '缺少点子 id' };
    const idea = this.loadIdeas().ideas.find(i => i.id === target);
    if (!idea) return { success: false, error: `找不到点子: ${target}` };
    return { success: true, idea };
  }

  // 新增点子：按归一化 title 去重（幂等：命中则返回既有条目，不新增）；默认 status=new，id 取自 seq
  addIdea(input = {}) {
    const title = String(input.title || '').trim();
    if (!title) return { success: false, error: '点子得有个标题（title）' };
    const key = this.ideaKey(title);
    const store = this.loadIdeas();
    const existing = store.ideas.find(i => this.ideaKey(i.title) === key);
    if (existing) return { success: true, idea: existing, deduped: true };
    // 写侧上限（动作 9）：到顶直接拒新增，旧数据一律不动（不自动淘汰）
    if (store.ideas.length >= IDEA_MAX_ITEMS) {
      return { success: false, error: `点子已达上限（${IDEA_MAX_ITEMS}），不再新增`, capped: true };
    }
    store.seq += 1;
    const now = new Date().toISOString();
    const idea = this.normalizeIdea({
      id: `i_${store.seq}`,
      title,
      oneLiner: input.oneLiner,
      why: input.why,
      source: input.source,
      persona: input.persona,
      tags: input.tags,
      votes: input.votes,
      status: input.status, // 非法值由 normalizeIdea 归一为 new
      ts: now,
      updatedAt: now
    });
    store.ideas.unshift(idea);
    this.saveIdeas(store);
    return { success: true, idea, deduped: false };
  }

  // 唯一状态迁移入口：非法 status 直接拒（不静默改），其余字段宽松更新；reason/verdict 用于留痕
  updateIdea(id, patch = {}) {
    if (!id) return { success: false, error: '缺少点子 id' };
    const store = this.loadIdeas();
    const idea = store.ideas.find(i => i.id === id);
    if (!idea) return { success: false, error: `找不到点子: ${id}` };
    if (patch.status !== undefined) {
      if (!IDEA_STATUS.has(String(patch.status))) return { success: false, error: `非法状态: ${patch.status}` };
      idea.status = String(patch.status);
    }
    if (typeof patch.reason === 'string') idea.reason = patch.reason.trim().slice(0, IDEA_FIELD_MAX);
    if (typeof patch.verdict === 'string') idea.verdict = patch.verdict.trim().slice(0, IDEA_FIELD_MAX);
    if (typeof patch.oneLiner === 'string') idea.oneLiner = patch.oneLiner.trim().slice(0, IDEA_FIELD_MAX);
    if (typeof patch.why === 'string') idea.why = patch.why.trim().slice(0, IDEA_FIELD_MAX);
    if (typeof patch.spikeTaskId === 'string') idea.spikeTaskId = patch.spikeTaskId.trim();
    // votes 写侧只认非负安全整数（拒 NaN/Infinity/小数）；读侧 normalizeIdea 仍归一为 0，读不炸
    if (Number.isSafeInteger(patch.votes) && patch.votes >= 0) idea.votes = patch.votes;
    if (Array.isArray(patch.tags)) idea.tags = patch.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 8);
    idea.updatedAt = new Date().toISOString();
    this.saveIdeas(store);
    return { success: true, idea };
  }

  // ---- 代码工作台：只认 data/coding/workspace/ 里、且只按文件名给 ----

  resolveWorkspaceScript(name, language, code) {
    const kind = String(language) === 'node' ? 'node' : 'python';
    const ext = kind === 'node' ? '.js' : '.py';
    let base = String(name || '').trim();
    if (!base) {
      base = `script_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    }
    base = path.basename(base); // 只留文件名，..\ 这类一律剪掉 🚫
    if (!/\.(py|js)$/i.test(base)) base += ext;
    const target = path.join(this.workspace, base);
    if (!target.startsWith(path.resolve(this.workspace))) {
      return { success: false, error: '脚本只能放在代码工作台（data/coding/workspace/）里' };
    }
    if (typeof code === 'string' && code.length > 0) {
      fs.writeFileSync(target, code, 'utf8');
    } else if (!fs.existsSync(target)) {
      return { success: false, error: `工作台里没有这个脚本，也没给 code: ${base}` };
    }
    return { success: true, kind, file: target, cwd: this.workspace };
  }

  // 列出工作台里的脚本（供面板展示）
  listScripts() {
    try {
      return fs.readdirSync(this.workspace)
        .filter(name => /\.(py|js)$/i.test(name))
        .map(name => {
          const stat = fs.statSync(path.join(this.workspace, name));
          return { name, bytes: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch (error) {
      return [];
    }
  }

  logRun(entry) {
    try {
      fs.appendFileSync(this.runsFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
      // 记日志失败不影响跑码本身
    }
  }

  // 最近的运行日志（倒序），供面板与「运行日志抓点」用
  recentRuns(limit = 50) {
    try {
      const lines = fs.readFileSync(this.runsFile, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 500))).reverse().map(line => {
        try { return JSON.parse(line); } catch (error) { return { raw: line }; }
      });
    } catch (error) {
      return [];
    }
  }

  // ---- 运行转录（对话追溯）：按 runId 一行一事件 ----

  // 追加一条事件。runId 走 safeTaskId 白名单（run_<ts>_<rand> 天然合法），非法直接丢，
  // 保证文件名不会被 .. / 斜杠利用。写失败只吞掉，绝不打断闭环。
  appendTranscript(runId, event) {
    const id = this.safeTaskId(runId);
    if (!id || !event || typeof event !== 'object') return;
    const file = path.join(this.transcriptDir, `${id}.jsonl`);
    try {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { size = 0; }
      if (size > TRANSCRIPT_MAX_BYTES) return;
      const line = JSON.stringify(Object.assign({}, event, { at: event.at || new Date().toISOString() }));
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (error) {
      // 转录失败不影响闭环本身
    }
  }

  // 回放：按时间顺序返回该 run 的全部事件（默认最多 3000 条，防一次性回吐过大）
  readTranscript(runId, limit = 3000) {
    const id = this.safeTaskId(runId);
    if (!id) return { success: false, error: 'runId 非法' };
    const file = path.join(this.transcriptDir, `${id}.jsonl`);
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const max = Math.max(1, Math.min(parseInt(limit, 10) || 3000, 5000));
      const events = lines.slice(0, max).map((line) => {
        try { return JSON.parse(line); } catch (error) { return { kind: 'raw', text: line }; }
      });
      return { success: true, runId: id, total: lines.length, events };
    } catch (error) {
      return { success: false, error: `找不到运行转录: ${runId}` };
    }
  }

  // ---- 文件改动账本：自己记账，不依赖 git ----
  // 记的是「谁在哪个 run 里动了哪个文件」，不含文件内容；内容回看仍走工作区读取。
  recordFileChange(entry = {}) {
    const userKey = this.userKey(entry.userId);
    const taskId = this.safeTaskId(entry.taskId);
    const filePath = String(entry.path || '').trim();
    if (!userKey || !filePath) return;
    const record = {
      at: new Date().toISOString(),
      user: userKey,
      taskId,
      runId: this.safeTaskId(entry.runId) || '',
      path: filePath,
      action: String(entry.action || 'write').slice(0, 16),
      beforeBytes: Number.isFinite(entry.beforeBytes) ? entry.beforeBytes : null,
      afterBytes: Number.isFinite(entry.afterBytes) ? entry.afterBytes : null
    };
    try {
      fs.appendFileSync(this.fileHistoryFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
      // 记账失败不影响写入本身
    }
  }

  // 读账本：按当前用户过滤（admin 视角可不传 userId 看全部），可按 taskId 收窄
  readFileChanges({ userId, taskId, limit } = {}) {
    const userKey = userId ? this.userKey(userId) : '';
    const wantTask = String(taskId || '').trim();
    let lines;
    try {
      lines = fs.readFileSync(this.fileHistoryFile, 'utf8').split('\n').filter(Boolean);
    } catch (error) {
      return [];
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      let item;
      try { item = JSON.parse(lines[i]); } catch (error) { continue; }
      if (userKey && item.user !== userKey) continue;
      if (wantTask && item.taskId !== wantTask) continue;
      out.push(item);
      if (out.length >= Math.max(1, Math.min(parseInt(limit, 10) || 100, 500))) break;
    }
    return out;
  }

  // ---- 身份与用户状态：每个登录用户一份独立工作区与 UI 记忆 ----
  // 隔离键统一用登录用户名（authModule 的 username），它跨会话稳定；
  // sessionManager 那种每会话生成的 id 不能当隔离键。
  // 用户名可能是中文（如「管理员」），直接当目录名不牢靠，故做 sha1 取短哈希。

  userKey(userId) {
    const raw = String(userId || '').trim();
    if (!raw) return '';
    return 'u_' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }

  uiStateFile(userId) {
    const key = this.userKey(userId);
    return key ? path.join(this.uiStateDir, `${key}.json`) : '';
  }

  // 读取某用户的 UI 状态：打开了哪些文件、当前激活文件、各任务的信任档
  getUiState(userId) {
    const empty = { openFiles: [], activeFile: '', trust: {} };
    const key = this.userKey(userId);
    if (!key) return empty;
    const file = this.uiStateFile(userId);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        openFiles: Array.isArray(data.openFiles) ? data.openFiles.map(String) : [],
        activeFile: typeof data.activeFile === 'string' ? data.activeFile : '',
        trust: (data.trust && typeof data.trust === 'object') ? data.trust : {}
      };
    } catch (error) {
      return empty;
    }
  }

  // 保存 UI 状态（浅合并 patch），供前端「记住这个人上次打开的文件」用
  saveUiState(userId, patch = {}) {
    const key = this.userKey(userId);
    if (!key) return { success: false, error: '缺少用户身份' };
    const current = this.getUiState(userId);
    const next = {
      openFiles: Array.isArray(patch.openFiles)
        ? patch.openFiles.map(String).slice(0, 50)
        : current.openFiles,
      activeFile: typeof patch.activeFile === 'string' ? patch.activeFile : current.activeFile,
      trust: (patch.trust && typeof patch.trust === 'object')
        ? { ...current.trust, ...patch.trust }
        : current.trust
    };
    try {
      writeJsonAtomicSync(this.uiStateFile(userId), next);
      return { success: true, state: next };
    } catch (error) {
      return { success: false, error: `保存 UI 状态失败: ${error.message}` };
    }
  }

  // 取某用户在某任务上的信任档，默认 ask
  getTrustLevel(userId, taskId) {
    const state = this.getUiState(userId);
    const level = state.trust[String(taskId || '')];
    return TRUST_LEVELS.has(level) ? level : TRUST_DEFAULT;
  }

  // 设置信任档（只认三档白名单）
  setTrustLevel(userId, taskId, level) {
    const id = String(taskId || '').trim();
    const lv = String(level || '').trim();
    if (!id) return { success: false, error: '缺少 taskId' };
    if (!TRUST_LEVELS.has(lv)) return { success: false, error: '信任档只能是 readonly / ask / auto' };
    const key = this.userKey(userId);
    if (!key) return { success: false, error: '缺少用户身份' };
    const current = this.getUiState(userId);
    const trust = { ...current.trust, [id]: lv };
    try {
      writeJsonAtomicSync(this.uiStateFile(userId), { ...current, trust });
      return { success: true, taskId: id, level: lv };
    } catch (error) {
      return { success: false, error: `保存信任档失败: ${error.message}` };
    }
  }

  // ---- git 工作区：可嵌套、可回滚、可 diff 的仓库沙箱 ----
  // 旧接口（resolveWorkspaceScript + 扁平 workspace/）保留不动；新编码工具全部走这里。
  // 注意：research.js 里也有一份 resolveWorkspaceScript，改造时只新建、不改旧，避免继续分叉。

  // 目录名只允许 [A-Za-z0-9_-]，把 ..、斜杠这类直接挡在门外
  safeTaskId(taskId) {
    const id = String(taskId || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
  }

  // 工作区目录：<workspaces>/<userKey>/<taskId>，按用户分桶，互不串门
  taskDir(userId, taskId) {
    const id = this.safeTaskId(taskId);
    const key = this.userKey(userId);
    return (id && key) ? path.join(this.workspaces, key, id) : '';
  }

  // 用户的工作区根目录（不存在则建），给文件树用
  userWorkspaceRoot(userId) {
    const key = this.userKey(userId);
    if (!key) return '';
    const root = path.join(this.workspaces, key);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  // 建工作区：mkdir + 写 .gitignore + git init（+ 首次提交）。已存在则复用。
  createWorkspace(userId, taskId) {
    const id = this.safeTaskId(taskId);
    const key = this.userKey(userId);
    if (!key) return { success: false, error: '缺少用户身份，无法创建私有工作区' };
    if (!id) return { success: false, error: 'taskId 只能包含字母、数字、下划线和连字符' };
    const dir = path.join(this.workspaces, key, id);
    const existed = fs.existsSync(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const gitignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, 'node_modules/\n.git/\ndata/\n', 'utf8');
      }
    } catch (error) {
      return { success: false, error: `创建工作区失败: ${error.message}` };
    }
    let gitReady = fs.existsSync(path.join(dir, '.git'));
    if (!gitReady) {
      const init = this.git(userId, id, ['init']);
      gitReady = init.success;
      if (gitReady) {
        this.git(userId, id, ['add', '-A']);
        this.gitCommit(userId, id, 'workspace init');
      }
    }
    return { success: true, taskId: id, dir, existed, gitReady };
  }

  // 工作区内路径解析：base 固定为 <workspaces>/<userKey>/<taskId>，目标必须落在 base 之内。
  // startsWith(base + path.sep) 是替换旧 basename 剪路径的穿越防护，这一行不能省。
  // 但词法校验挡不住符号链接/junction：路径长得像在工作区内，实际可能指向 C:\Windows。
  // 所以再比一次 realpath——真实位置也必须落在工作区的真实位置之内。
  resolveInWorkspace(userId, taskId, relPath) {
    const base = this.taskDir(userId, taskId);
    if (!base) return { success: false, error: 'taskId 或用户身份非法' };
    if (!fs.existsSync(base)) return { success: false, error: `工作区不存在: ${taskId}，先调 workspace/create` };
    const rel = String(relPath || '').trim();
    if (!rel) return { success: false, error: '缺少 path 参数' };
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) {
      return { success: false, error: '只允许访问工作区内的路径（越界被拒）' };
    }
    const baseReal = this.realPathOf(base);
    const targetReal = this.realPathOf(target);
    const isWin = process.platform === 'win32';
    const a = isWin ? targetReal.toLowerCase() : targetReal;
    const b = isWin ? baseReal.toLowerCase() : baseReal;
    if (a !== b && !a.startsWith(b + path.sep)) {
      return { success: false, error: '路径的真实位置在工作区之外（符号链接/junction 越界被拒）' };
    }
    return { success: true, taskId: String(taskId), base, path: target, rel: path.relative(base, target) };
  }

  // realpath 的容错版：目标还不存在（新建文件）时，取最近的已存在祖先解析，再把剩下的路径段拼回去。
  realPathOf(p) {
    let cur = path.resolve(p);
    const rest = [];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
    let real = cur;
    try { real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur); } catch (e) { real = cur; }
    return rest.length ? path.join(real, ...rest) : real;
  }

  // 导入源黑名单：系统目录、用户主目录根、磁盘根、本项目自己。
  // 这些位置一旦被 junction 进工作区，等于把整块系统/项目交给编码 Agent 直接改。
  blockedImportReason(realSrc) {
    const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
    const src = norm(realSrc);
    if (path.parse(realSrc).root === realSrc) return '不允许导入磁盘根目录';
    const systemRoots = [
      process.env.SystemRoot, process.env.windir,
      process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData
    ].filter(Boolean);
    for (const root of systemRoots) {
      let real = root;
      try { real = fs.realpathSync(root); } catch (e) { /* 保留原值 */ }
      if (src === norm(real)) return `不允许导入系统目录: ${root}`;
    }
    let home = os.homedir();
    try { home = fs.realpathSync(home); } catch (e) { /* 保留原值 */ }
    if (src === norm(home)) return '不允许导入用户主目录';
    let project = path.resolve(this.projectRoot);
    try { project = fs.realpathSync(project); } catch (e) { /* 保留原值 */ }
    const projectNorm = norm(project);
    if (src === projectNorm || src.startsWith(projectNorm + path.sep)) return '不允许导入本项目目录';
    return '';
  }

  // M2 留痕：把 spike 结论写进该 spike 工作区根 VERDICT.md（best-effort，写失败返回 success:false，由调用方忽略）。
  // 落在工作区根而非 .trae/，避开 loadSessionMemory 对 .trae/session_*.md 的受限读路径，不会被当「会话记忆」读走。
  saveVerdict(userId, taskId, content) {
    const dir = this.taskDir(userId, taskId);
    if (!dir) return { success: false, error: 'taskId 或用户身份非法' };
    const text = String(content == null ? '' : content);
    if (!text.trim()) return { success: false, error: '结论内容为空' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'VERDICT.md');
      fs.writeFileSync(file, text, 'utf8');
      return { success: true, file };
    } catch (error) {
      return { success: false, error: `写入 VERDICT.md 失败: ${error.message}` };
    }
  }

  // 跑一条 git 子命令（在工作区内）。参数走 execFileSync，不经 shell：
  // 含空格/引号/&|; 的 ref、message 会被当成完整参数原样传给 git，既不会破串也不会有注入面。
  git(userId, taskId, args = [], options = {}) {
    const dir = this.taskDir(userId, taskId);
    if (!dir || !fs.existsSync(dir)) {
      return { success: false, error: `工作区不存在: ${taskId}` };
    }
    const argv = Array.isArray(args) ? args.map(String) : [];
    // command 仅作人类可读展示/日志用，不参与执行
    const command = ['git', ...argv].join(' ');
    try {
      const stdout = execFileSync('git', argv, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs || 30000
      });
      return { success: true, command, output: String(stdout || '') };
    } catch (error) {
      return {
        success: false,
        command,
        output: String(error.stdout || ''),
        error: String(error.stderr || error.message || 'git 执行失败')
      };
    }
  }

  gitCommit(userId, taskId, message) {
    // 本地提交身份写死在命令里，不依赖全局 git config
    return this.git(userId, taskId, [
      '-c', 'user.name=Saint',
      '-c', 'user.email=saint@local',
      'commit', '-m', String(message || 'checkpoint')
    ]);
  }

  // 工作区状态：分支 + 是否工作区干净（供 pass 判据与面板）
  workspaceStatus(userId, taskId) {
    const dir = this.taskDir(userId, taskId);
    if (!dir || !fs.existsSync(dir)) {
      return { success: false, error: `工作区不存在: ${taskId}` };
    }
    const inRepo = fs.existsSync(path.join(dir, '.git'));
    if (!inRepo) {
      return { success: true, taskId: String(taskId), dir, gitReady: false };
    }
    const status = this.git(userId, taskId, ['status', '--porcelain']);
    const branch = this.git(userId, taskId, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      success: true,
      taskId: String(taskId),
      dir,
      gitReady: true,
      branch: branch.success ? branch.output.trim() : '',
      clean: status.success ? status.output.trim() === '' : null,
      status: status.success ? status.output.trim() : ''
    };
  }

  // 删除工作区。两条路径必须分开处理：
  //   1) 导入目录是 junction/symlink —— 只删链接本身，绝不递归进去（否则会把源目录整个删掉）；
  //   2) 真实目录 —— 直接递归删。
  // 删除后顺手清掉该 taskId 的信任档，避免同名重建时继承旧档。
  deleteWorkspace(userId, taskId) {
    const key = this.userKey(userId);
    const id = this.safeTaskId(taskId);
    if (!key) return { success: false, error: '缺少用户身份' };
    if (!id) return { success: false, error: 'taskId 只能包含字母、数字、下划线和连字符' };
    const root = path.join(this.workspaces, key);
    const dir = path.join(root, id);
    if (path.dirname(path.resolve(dir)) !== path.resolve(root)) {
      return { success: false, error: '路径越界，拒绝删除' };
    }
    let linked;
    try {
      linked = fs.lstatSync(dir).isSymbolicLink();
    } catch (error) {
      return { success: false, error: `工作区不存在: ${id}` };
    }
    try {
      if (linked) {
        // Windows 的 junction 用 rmdir 摘链接；POSIX 的目录符号链接用 unlink
        if (process.platform === 'win32') fs.rmdirSync(dir);
        else fs.unlinkSync(dir);
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      return { success: false, error: `删除失败: ${error.message}` };
    }
    try {
      const current = this.getUiState(userId);
      if (current.trust && current.trust[id]) {
        const trust = { ...current.trust };
        delete trust[id];
        writeJsonAtomicSync(this.uiStateFile(userId), { ...current, trust });
      }
    } catch (error) {
      // 清信任档失败不影响删除结果
    }
    return { success: true, taskId: id, linked };
  }

  // 列出某用户的工作区；不传 userId 则列全部用户的（管理视角）
  listWorkspaces(userId) {
    try {
      if (userId) {
        const root = path.join(this.workspaces, this.userKey(userId));
        return this._listWorkspacesIn(root);
      }
      const out = [];
      for (const entry of fs.readdirSync(this.workspaces, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        out.push(...this._listWorkspacesIn(path.join(this.workspaces, entry.name)));
      }
      return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch (error) {
      return [];
    }
  }

  _listWorkspacesIn(root) {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        // 导入的工作区是 junction/symlink：Dirent 会判成 isSymbolicLink 而非 isDirectory，
        // 只按 isDirectory 过滤会把它们全漏掉（侧栏看不到，用户切到的根本不是导入目录）；
        // 因此这里放行两类，再用 statSync（会跟随链接）复核确实是目录
        .filter(entry => {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
          try {
            return fs.statSync(path.join(root, entry.name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map(entry => {
          const dir = path.join(root, entry.name);
          const stat = fs.statSync(dir);
          return {
            taskId: entry.name,
            dir,
            gitReady: fs.existsSync(path.join(dir, '.git')),
            mtime: stat.mtime.toISOString()
          };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch (error) {
      return [];
    }
  }

  // ---- 多人格讨论记录 ----

  saveDiscussion(id, payload) {
    const file = path.join(this.discussionsDir, `${id}.json`);
    writeJsonAtomicSync(file, payload);
    return file;
  }

  listDiscussions(limit = 30) {
    try {
      return fs.readdirSync(this.discussionsDir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          const stat = fs.statSync(path.join(this.discussionsDir, name));
          return { id: name.replace(/\.json$/, ''), mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, limit);
    } catch (error) {
      return [];
    }
  }

  getDiscussion(id) {
    const safe = path.basename(String(id || '')); // 防路径穿越
    const file = path.join(this.discussionsDir, `${safe}.json`);
    try {
      return { success: true, discussion: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      return { success: false, error: `找不到讨论记录: ${id}` };
    }
  }

  // ---- 巡检告警：自动巡检发现异常才记一条 ----

  logAlert(alert) {
    try {
      fs.appendFileSync(this.alertsFile, JSON.stringify(alert) + '\n', 'utf8');
    } catch (error) {
      // 记告警失败不影响巡检本身
    }
  }

  // 最近的巡检告警（倒序）
  recentAlerts(limit = 30) {
    try {
      const lines = fs.readFileSync(this.alertsFile, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 200))).reverse().map(line => {
        try { return JSON.parse(line); } catch (error) { return { raw: line }; }
      });
    } catch (error) {
      return [];
    }
  }

  // 在文件管理器里打开工作区目录（Windows explorer.exe，非 Windows 用 xdg-open）
  revealInExplorer(userId, taskId) {
    const dir = this.taskDir(userId, taskId);
    if (!dir || !fs.existsSync(dir)) return { success: false, error: `工作区不存在: ${taskId}` };
    try {
      // 不走 shell：目录名里带引号、& 也不会被解释成命令
      if (process.platform === 'win32') {
        execFile('explorer.exe', [dir]);
      } else {
        execFile('xdg-open', [dir]);
      }
      return { success: true, dir };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // 浏览本地目录：列出一层子目录（安全限制：拒系统目录、只列目录不列文件）
  browseDirs(targetPath) {
    const root = String(targetPath || '').trim();
    // 安全黑名单：Windows 系统目录不让翻，防误伤
    const blocked = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\$Recycle.Bin', 'C:\\System Volume Information'];
    for (const b of blocked) {
      if (root && (root.toLowerCase() === b.toLowerCase() || root.toLowerCase().startsWith(b.toLowerCase() + '\\'))) {
        return { success: false, error: '该目录被系统保护，不允许浏览' };
      }
    }
    const base = root || (process.platform === 'win32' ? '' : '/');
    if (!base) {
      // Windows 没传路径：列盘符
      const drives = [];
      for (let c = 67; c <= 90; c++) {
        const letter = String.fromCharCode(c);
        const d = `${letter}:\\`;
        if (fs.existsSync(d)) drives.push({ name: `${letter}:`, path: d, type: 'dir' });
      }
      return { success: true, path: '', entries: drives };
    }
    try {
      if (!fs.existsSync(base)) return { success: false, error: '路径不存在' };
      const stat = fs.statSync(base);
      if (!stat.isDirectory()) return { success: false, error: '不是目录' };
      const items = fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => ({ name: d.name, path: path.join(base, d.name), type: 'dir' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, path: base, entries: items };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // 从源目录名派生一个合法的工作区名（导入时用户可以不给名字，直接拿目录名当默认）
  defaultTaskIdFromPath(sourcePath) {
    const base = path.basename(path.resolve(String(sourcePath || '').trim()));
    const id = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    // 目录名全是非法字符（比如纯中文）时派生出空串，退回时间戳兜底
    return id || `ws-${Date.now().toString(36)}`;
  }

  // 沙箱账户的权限是在 sandbox-setup.ps1 里只授给项目目录的，而 icacls 不跟随 junction，
  // 导入目录的权限不会自动继承过来：命令能启动，但一写文件就是 Access is denied。
  // 这里只对「用户明确导入的那个目录」补一次授权；不是账户模式或凭据没生成就跳过。
  grantSandboxAccess(dir) {
    if (process.platform !== 'win32') return { ok: true, skipped: true };
    const mode = String(process.env.SANDBOX_MODE || 'account').toLowerCase();
    if (mode !== 'account') return { ok: true, skipped: true };
    if (!fs.existsSync(path.join(this.projectRoot, 'data', 'sandbox-credential.json'))) {
      return { ok: true, skipped: true };
    }
    const account = process.env.SANDBOX_USER || 'pog_sandbox';
    let real = path.resolve(dir);
    try { real = fs.realpathSync(dir); } catch (e) { /* 用 resolve 结果兜底 */ }
    try {
      execFileSync('icacls', [real, '/grant', `${account}:(OI)(CI)M`], { stdio: 'ignore' });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `沙箱账户授权失败: ${String(error.message || error).trim()}` };
    }
  }

  // 本次进程内已授权过的目录：老工作区第一次跑命令时补授权，成功后不再重复调 icacls
  ensureSandboxAccess(dir) {
    if (!dir) return { ok: true, skipped: true };
    if (!this.sandboxAclDone) this.sandboxAclDone = new Set();
    let key = path.resolve(dir);
    try { key = fs.realpathSync(dir); } catch (e) { /* 用 resolve 结果兜底 */ }
    key = key.toLowerCase();
    if (this.sandboxAclDone.has(key)) return { ok: true };
    const result = this.grantSandboxAccess(dir);
    if (result.ok) this.sandboxAclDone.add(key);
    return result;
  }

  // 导入本地目录为工作区：在工作区建目录，再用 Windows junction（mklink /J，免管理员）链接进去
  importDir(userId, taskId, sourcePath) {
    const key = this.userKey(userId);
    if (!key) return { success: false, error: '缺少用户身份' };
    const src = String(sourcePath || '').trim();
    if (!src || !fs.existsSync(src)) return { success: false, error: '源目录不存在' };
    const srcStat = fs.statSync(src);
    if (!srcStat.isDirectory()) return { success: false, error: '源路径不是目录' };
    // junction 建好之后，工作区在物理上就是源目录本身，写进去等于直接改外部文件。
    // 所以在入口就把系统目录、用户主目录根、磁盘根和本项目自身挡掉。
    let realSrc = path.resolve(src);
    try { realSrc = fs.realpathSync(src); } catch (e) { /* 保留 resolve 结果 */ }
    const blocked = this.blockedImportReason(realSrc);
    if (blocked) return { success: false, error: blocked };
    // 工作区名可留空：留空就按源目录名自动派生；显式传入但非法才报错
    const rawTaskId = String(taskId || '').trim();
    let id;
    if (rawTaskId) {
      id = this.safeTaskId(rawTaskId);
      if (!id) return { success: false, error: 'taskId 只能包含字母、数字、下划线和连字符' };
    } else {
      id = this.safeTaskId(this.defaultTaskIdFromPath(src));
    }
    const rootDir = path.join(this.workspaces, key);
    // 目标不存在才建；显式命名撞车就报错（别覆盖已有工作区），自动命名撞车则加 -2/-3 后缀
    if (rawTaskId) {
      if (fs.existsSync(path.join(rootDir, id))) return { success: false, error: `工作区 ${id} 已存在，请换个名字或先删除` };
    } else {
      const base = id;
      let n = 2;
      while (fs.existsSync(path.join(rootDir, id))) { id = `${base}-${n}`; n += 1; }
    }
    const target = path.join(rootDir, id);
    fs.mkdirSync(rootDir, { recursive: true });
    try {
      if (process.platform === 'win32') {
        // mklink 是 cmd 内建命令，只能走命令行；两侧路径先过引号校验再拼
        // security-scan-ignore shell-dynamic
        execSync(`mklink /J "${assertCmdPath(target, 'target')}" "${assertCmdPath(src, 'src')}"`, { shell: 'cmd.exe' });
      } else {
        fs.symlinkSync(src, target, 'dir');
      }
      // 命令要真在用户自己的目录里跑，先补沙箱账户的写权限（失败不阻断导入，只回告警）
      const acl = this.grantSandboxAccess(realSrc);
      // git init（junction 指向的目录可能已有 .git，不强行初始化）
      let gitReady = fs.existsSync(path.join(target, '.git'));
      if (!gitReady) {
        this.git(userId, id, ['init']);
        this.git(userId, id, ['add', '-A']);
        this.gitCommit(userId, id, 'workspace init (imported)');
        gitReady = true;
      }
      return { success: true, taskId: id, dir: target, gitReady, ...(acl.ok ? {} : { warning: acl.error }) };
    } catch (error) {
      // 链接失败就清理掉空壳
      try { fs.unlinkSync(target); } catch (e) { /* 忽略 */ }
      return { success: false, error: `导入失败: ${error.message}` };
    }
  }
}

module.exports = CodingCenter;
