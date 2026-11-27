'use strict';

// 编程竞赛（竞技场）：给任务板工人注入有限的 token 预算，让多个候选在「完全相同的初始工作区」上各写一版，
// 再按硬指标排名——先看是否过判据，再看有没有偏离主题，再看评委分，最后看谁更省 token。
//
// 三条边界：
// 1) 只编排、不执行：真正改代码仍然走 codingLoop，本模块不 require 任何工具/模型写入口；
// 2) 初始状态必须一致：每个候选从 base 工作区整目录复制（跳过 node_modules / data / .trae 等体积目录），
//    baseSha 记进竞赛档案，diff 一律以它为基线，避免「谁先建仓谁占便宜」；
// 3) 不偏离主题：开跑前把边界约束写进 goal，跑完用目标词覆盖率做一次淘汰判定。
//
// 评分器可注入（judge），默认不调用任何模型，只用硬指标排序；注入后由外部提供 { taskId: { onTopic, quality, minimality, reason } }。

const fs = require('fs');
const path = require('path');

const DEFAULT_TOKEN_BUDGET = 120000;
const MIN_TOKEN_BUDGET = 2000;
const MAX_TOKEN_BUDGET = 2000000;
const DEFAULT_MAX_ITERATIONS = 8;
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 5;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_POLL_MS = 3000;
const ON_TOPIC_THRESHOLD = 0.2;
const KEEP_RECORDS = 60;

// 整目录复制逻辑与 16-Agent 集群共用，跳过列表只维护一份
const { copyTaskWorkspace } = require('./workspaceCopy');

// 终态：这几个状态出现即认为该候选跑完了，可以进评审
const TERMINAL_STATUS = new Set(['passed', 'stopped', 'timeout', 'paused', 'stalled', 'failed', 'error', 'budget_exhausted']);

function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(num, max));
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function newId() {
  return `comp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 候选清单：支持 3（数字=人数，同名同模型）或 [{name, model}]
function normalizeCandidates(input, defaultModel) {
  let list = [];
  if (Number.isFinite(Number(input)) && !Array.isArray(input)) {
    const count = parseInt(input, 10);
    if (!Number.isFinite(count) || count < MIN_CANDIDATES) {
      return { success: false, error: `候选人数必须是 ${MIN_CANDIDATES}~${MAX_CANDIDATES}` };
    }
    for (let i = 1; i <= Math.min(count, MAX_CANDIDATES); i++) {
      list.push({ name: `工人${String.fromCharCode(64 + i)}`, model: '' });
    }
  } else if (Array.isArray(input)) {
    list = input.slice(0, MAX_CANDIDATES).map((item, index) => {
      const spec = (item && typeof item === 'object') ? item : { name: String(item || '') };
      return {
        name: String(spec.name || `工人${String.fromCharCode(65 + index)}`).slice(0, 24),
        model: String(spec.model || '').trim().toLowerCase()
      };
    });
  }
  if (list.length < MIN_CANDIDATES) {
    return { success: false, error: `竞赛至少需要 ${MIN_CANDIDATES} 个候选，最多 ${MAX_CANDIDATES} 个` };
  }
  return { success: true, list: list.map(item => ({ ...item, model: item.model || defaultModel || '' })) };
}

// 比目标本身多出来的边界约束：不改无关文件、最小改动、讲清为什么
function buildCompetitionGoal(goal) {
  return [
    String(goal || '').trim(),
    '',
    '【竞赛约束】',
    '1. 只围绕上面这个目标改动，不得顺手重构，不得改动与本目标无关的文件；',
    '2. 优先最小改动：能改一处解决就不要改三处；',
    '3. 完成后简述「改了什么、为什么这么改」，不要复述目标。'
  ].join('\n');
}

// 目标词覆盖率：英文/数字按词，中文按 2-gram。只做「有没有跑题」的存在性检查，不评估质量。
function goalTerms(text) {
  const source = String(text || '').toLowerCase();
  const terms = new Set();
  for (const word of source.match(/[a-z0-9_]{2,}/g) || []) terms.add(word);
  for (const run of source.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

function topicScore(goal, corpus) {
  const wanted = goalTerms(goal);
  if (!wanted.size) return 1;
  const have = goalTerms(corpus);
  let hit = 0;
  for (const term of wanted) if (have.has(term)) hit++;
  return hit / wanted.size;
}

// 缓存命中率：只作成本 tie-break；缺失当「未知」，排在已知之后而不是当 0 占便宜
function cacheRate(cand) {
  const rate = cand && cand.cache ? Number(cand.cache.hitRate) : NaN;
  return Number.isFinite(rate) ? rate : -1;
}

function compareCandidates(a, b) {
  // 偏离主题的一律排最后，不管测试过没过
  if (!!a.offTopic !== !!b.offTopic) return a.offTopic ? 1 : -1;
  if (!!a.passed !== !!b.passed) return a.passed ? -1 : 1;
  const qa = a.quality == null ? 0 : a.quality;
  const qb = b.quality == null ? 0 : b.quality;
  if (qb !== qa) return qb - qa;
  if (a.onTopic !== b.onTopic) return b.onTopic - a.onTopic;
  // token 缺失按「最贵」处理，别让没上报 usage 的候选靠 0 白捡便宜
  const ta = a.tokens > 0 ? a.tokens : Number.MAX_SAFE_INTEGER;
  const tb = b.tokens > 0 ? b.tokens : Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  // 花销相同再看输入侧缓存命中：命中越高，实付成本越低
  const ca = cacheRate(a);
  const cb = cacheRate(b);
  if (ca !== cb) return cb - ca;
  return (a.iterations || 0) - (b.iterations || 0);
}

// 评委提示词：一次调用看完所有候选，只输出 JSON。三个维度分开打，避免「一好百好」。
const JUDGE_SYSTEM_PROMPT = [
  '你是编程竞赛的评委。裁判已给出每个候选的硬指标（是否过判据、token 花销），你不要重算它们。',
  '只评三件事，每项 0~1：',
  '- onTopic：改动是否紧紧围绕目标；做了无关重构、改了不相关的文件就给低分，完全跑题给 0。',
  '- quality：改动本身是否清晰、正确、可维护（不是看它说了什么，是看 diff）。',
  '- minimality：是否最小改动；同等效果下改得越少分越高。',
  '硬指标已经通过的候选，不要因为「说得少」扣分。',
  '候选信息里的「缓存命中率」是输入侧复用率，仅作成本参考，不要当成质量分，也不要因为它扣分。',
  '只输出 JSON，不要任何其它文字，格式：',
  '{"scores":{"<taskId>":{"onTopic":0.9,"quality":0.8,"minimality":0.7,"reason":"一句话"}}}'
].join('\n');

// 用正式的一次性模型调用通道做评委。outputModule 由外部注入，本模块不 require 模型入口。
function createModelJudge({ outputModule, model = '' } = {}) {
  if (!outputModule || typeof outputModule.callModelOnce !== 'function') return null;
  return async ({ goal, candidates }) => {
    const blocks = (Array.isArray(candidates) ? candidates : []).map(cand => [
      `【候选 ${cand.taskId}｜${cand.name}】`,
      `状态：${cand.status}｜过判据：${cand.passed ? '是' : '否'}｜token：${cand.tokens}｜缓存命中率：${Number.isFinite(Number(cand.cacheHitRate)) ? `${(Number(cand.cacheHitRate) * 100).toFixed(1)}%` : '未知'}`,
      `自述：${String(cand.summary || '').slice(0, 400) || '（空）'}`,
      `diff：${String(cand.diffPreview || '').slice(0, 1800) || '（无改动）'}`
    ].join('\n'));
    const messages = [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: `【目标】${String(goal || '').slice(0, 1200)}\n\n${blocks.join('\n\n')}` }
    ];
    const result = await outputModule.callModelOnce(messages, [], null, {
      apiChannel: (model && model !== 'custom') ? model : undefined,
      forceThinking: 'disabled', // 只做打分，不需要思维链
      temperature: 0.1
    });
    const raw = String((result && result.choices && result.choices[0] && result.choices[0].message
      ? result.choices[0].message.content
      : '') || '');
    return parseJudgeScores(raw);
  };
}

// 容错解析：模型偶尔带 ```json 包裹或前后废话，取第一个 { 到最后一个 } 再解
function parseJudgeScores(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch (error) { return null; }
  if (!data || typeof data !== 'object') return null;
  const scores = (data.scores && typeof data.scores === 'object') ? data.scores : data;
  return (scores && typeof scores === 'object') ? scores : null;
}

class CodingCompetition {
  // coding: CodingCenter（工作区/git）；codingLoop: 执行入口；judge: 可选评委（异步函数）
  constructor({ coding, codingLoop, judge = null, dir = '', pollMs = DEFAULT_POLL_MS }) {
    this.coding = coding;
    this.codingLoop = codingLoop;
    this.judge = typeof judge === 'function' ? judge : null;
    this.dir = dir || path.join(coding.dir, 'competitions');
    this.pollMs = Math.max(1, parseInt(pollMs, 10) || DEFAULT_POLL_MS);
    this.active = new Map(); // id → record（在跑或刚跑完）
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ---- 对外接口 ----

  start(params = {}) {
    const userId = String(params.userId || '').trim();
    if (!userId) return { success: false, error: '缺少 userId：竞赛必须绑定到具体登录用户' };
    const goal = String(params.goal || '').trim();
    if (!goal) return { success: false, error: '缺少 goal：竞赛必须有一个明确目标' };

    const defaultModel = String(params.model || '').trim().toLowerCase();
    const specs = normalizeCandidates(params.candidates, defaultModel);
    if (!specs.success) return { success: false, error: specs.error };

    const id = newId();
    const tokenBudget = clampInt(params.tokenBudget, MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET);
    const baseTaskId = this.coding.safeTaskId(params.baseTaskId) || `comp_${id}_base`;

    // 1) 基座工作区：不存在就建空仓；存在就原样当初始状态
    const base = this.coding.createWorkspace(userId, baseTaskId);
    if (!base.success) return { success: false, error: base.error };
    const baseSha = this.headSha(userId, baseTaskId);

    // 2) 每个候选一份一模一样的副本；任何一份复制失败就整场作废，避免不公平的起跑线
    const candidates = [];
    for (let i = 0; i < specs.list.length; i++) {
      const spec = specs.list[i];
      const taskId = `comp_${id}_c${i + 1}`;
      const copy = this.copyWorkspace(userId, baseTaskId, taskId);
      if (!copy.success) {
        this.cleanup(userId, candidates);
        return { success: false, error: `候选 ${spec.name} 初始化失败：${copy.error}` };
      }
      candidates.push({
        name: spec.name,
        taskId,
        model: spec.model || defaultModel || '',
        status: 'queued',
        runId: '',
        error: '',
        passed: false,
        offTopic: false,
        onTopic: null,
        quality: null,
        minimality: null,
        iterations: 0,
        tokens: 0,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        // 输入侧缓存命中汇总（hit / miss / hitRate）：只作成本参考，不进质量分
        cache: null,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        reason: '',
        summary: '',
        diffPreview: ''
      });
    }

    const record = {
      id,
      owner: userId,
      goal,
      status: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: '',
      error: '',
      baseTaskId,
      baseSha,
      tokenBudget,
      maxIterations: clampInt(params.maxIterations, 1, 40, DEFAULT_MAX_ITERATIONS),
      concurrency: clampInt(params.concurrency, 1, MAX_CANDIDATES, DEFAULT_CONCURRENCY),
      judge: this.judge ? 'pending' : 'heuristic',
      candidates,
      ranking: [],
      winner: '',
      note: ''
    };
    this.active.set(id, record);
    // 开赛即落盘：进程中途被杀（断网、重启）也能查到这场，而不是整场蒸发
    this.persist(record);

    // 后台跑：接口立刻返回，进度用 status 轮询
    setImmediate(() => {
      this.launch(record).catch(error => {
        record.status = 'failed';
        record.error = error.message;
        this.persist(record);
      });
    });
    return { success: true, competition: this.snapshot(record) };
  }

  status(id, owner = '') {
    const key = String(id || '');
    if (!key) return { success: false, error: '缺少竞赛 id' };
    const record = this.active.get(key) || this.load(key);
    if (!record) return { success: false, error: '竞赛不存在' };
    if (owner && record.owner && record.owner !== owner) {
      return { success: false, error: '无权查看他人的竞赛' };
    }
    this.syncLive(record);
    return { success: true, competition: this.snapshot(record) };
  }

  list(owner = '') {
    const seen = new Map();
    for (const record of this.active.values()) seen.set(record.id, record);
    for (const record of this.loadAll()) {
      if (!seen.has(record.id)) seen.set(record.id, record);
    }
    const items = Array.from(seen.values())
      .filter(record => !owner || record.owner === owner)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 30)
      .map(record => this.snapshot(record, { light: true }));
    return { success: true, competitions: items };
  }

  // 手动叫停：把所有还在跑的候选停掉，已跑完的保留结果
  stop(id, owner = '') {
    const key = String(id || '');
    const record = this.active.get(key) || this.load(key);
    if (!record) return { success: false, error: '竞赛不存在' };
    if (owner && record.owner && record.owner !== owner) {
      return { success: false, error: '无权停止他人的竞赛' };
    }
    let stopped = 0;
    for (const cand of record.candidates) {
      if (cand.status === 'queued' || cand.status === 'running') {
        const res = this.codingLoop.stop(cand.taskId);
        cand.status = 'stopped';
        cand.error = cand.error || '用户叫停';
        if (res && res.success) stopped++;
      }
    }
    record.status = 'stopped';
    // 叫停后不再重算排名，但 diff 统计要刷新：模型可能已经把文件写进工作区，
    // 不刷新就会一直显示 filesChanged=0，看起来像「什么都没写」
    for (const cand of record.candidates) {
      const diff = this.diffStat(record.owner, record.baseSha, cand.taskId);
      cand.filesChanged = diff.filesChanged;
      cand.insertions = diff.insertions;
      cand.deletions = diff.deletions;
      cand.diffPreview = diff.preview;
    }
    record.note = record.note || `用户叫停，已停止 ${stopped} 个候选`;
    record.finishedAt = new Date().toISOString();
    this.persist(record);
    return { success: true, competition: this.snapshot(record) };
  }

  // ---- 编排 ----

  async launch(record) {
    const pending = record.candidates.slice();
    const running = new Set();
    while (pending.length || running.size) {
      // 被用户叫停或外部终结后，编排循环必须退出，否则轮询定时器会一直挂着
      if (record.status === 'stopped' || record.status === 'finished' || record.status === 'failed') break;
      while (pending.length && running.size < record.concurrency) {
        const cand = pending.shift();
        // 启动是 async 的，必须等它落地再判断状态，否则并发闸形同虚设
        await this.startCandidate(record, cand);
        if (cand.status === 'running') running.add(cand.taskId);
      }
      if (!running.size) break;
      await this.sleep(this.pollMs);
      for (const taskId of Array.from(running)) {
        if (this.isFinished(taskId)) running.delete(taskId);
      }
    }
    // 叫停的竞赛不再重算排名，保留用户叫停时的现场
    if (record.status === 'stopped') return;
    await this.evaluate(record);
  }

  // codingLoop.start 是 async：必须 await，否则拿到的是 Promise，
  // result.success 恒为 undefined，候选会被误判成"启动失败"（0 轮 0 token）。
  async startCandidate(record, cand) {
    // 竞技场是无人值守的：默认 ask 档会让每个写文件动作都停下等审批，
    // 候选会永远卡在第 1 轮（0 轮 0 token）。开跑前强制把该工作区设为 auto。
    try {
      if (this.coding && typeof this.coding.setTrustLevel === 'function') {
        this.coding.setTrustLevel(record.owner, cand.taskId, 'auto');
      }
    } catch (error) {
      // 信任档设不上不算致命：从 snapshot 的 error 里能看到卡住的原因
    }
    // 同一个 goal 加同样的边界约束：候选之间只比「怎么写」，不比「写什么」
    let result;
    try {
      result = await this.codingLoop.start({
        userId: record.owner,
        taskId: cand.taskId,
        goal: buildCompetitionGoal(record.goal),
        model: cand.model || undefined,
        tokenBudget: record.tokenBudget,
        maxIterations: record.maxIterations,
        clarify: false,
        // 候选不写 PLAN.md：闭环自产物不算候选的「实现」，还会被评委判成违规新建文件
        writePlan: false,
        // 没有实际文件改动不算通过：否则只读一遍 TASK 就能「静态诊断通过」交卷
        requireChange: true
      });
    } catch (error) {
      result = { success: false, error: error.message };
    }
    if (!result || !result.success) {
      cand.status = 'failed';
      cand.error = String((result && result.error) || '编码闭环启动失败');
      return;
    }
    cand.status = 'running';
    cand.runId = (result.run && result.run.id) || '';
  }

  isFinished(taskId) {
    const snap = this.codingLoop.latestRun(taskId);
    if (!snap) return false;
    if (snap.finishedAt) return true;
    return TERMINAL_STATUS.has(String(snap.status || ''));
  }

  // 实时进度：竞赛还在跑时，把候选的轮次/token 从闭环里同步过来。
  // 不这么做的话面板要等到 evaluate 才跳变，中途一直显示 0 轮 0 token，没人能判断它是卡住还是在干活。
  syncLive(record) {
    if (!this.codingLoop || typeof this.codingLoop.latestRun !== 'function') return;
    if (record.status !== 'running' && record.status !== 'judging') return;
    for (const cand of record.candidates) {
      if (cand.status !== 'running' && cand.status !== 'queued') continue;
      const snap = this.codingLoop.latestRun(cand.taskId);
      if (!snap) continue;
      if (snap.status) cand.status = snap.status;
      cand.iterations = Number(snap.iteration) || cand.iterations || 0;
      if (snap.tokenUsage) {
        cand.tokenUsage = snap.tokenUsage;
        cand.tokens = Number(snap.tokenUsage.total) || 0;
      }
      if (snap.usage) cand.cache = snap.usage;
    }
  }

  async evaluate(record) {
    record.status = 'judging';
    for (const cand of record.candidates) this.collect(record, cand);
    await this.judgeAll(record);
    this.rank(record);
    record.status = 'finished';
    record.finishedAt = new Date().toISOString();
    this.persist(record);
  }

  // 收集单个候选的实测证据：状态、token、diff、跑题度
  collect(record, cand) {
    const snap = this.codingLoop.latestRun(cand.taskId) || {};
    cand.status = snap.status || cand.status;
    cand.iterations = Number(snap.iteration) || 0;
    cand.tokenUsage = snap.tokenUsage || { prompt: 0, completion: 0, total: 0 };
    cand.tokens = Number(cand.tokenUsage.total) || 0;
    cand.cache = snap.usage || cand.cache || null;
    cand.error = String(snap.error || cand.error || '');
    cand.summary = String(snap.result || '').slice(0, 600);

    const diff = this.diffStat(record.owner, record.baseSha, cand.taskId);
    cand.filesChanged = diff.filesChanged;
    cand.insertions = diff.insertions;
    cand.deletions = diff.deletions;
    cand.diffPreview = diff.preview;

    // 空转不算通过：0 token 且 0 改动，说明闭环只是把自己跑绿了，并没有真的写代码。
    // 放它进排名等于把「什么都没做」当成合格作品。
    const didNothing = cand.tokens === 0 && diff.filesChanged === 0;
    cand.passed = snap.status === 'passed' && !didNothing;
    if (didNothing) cand.error = cand.error || '闭环空转：没有消耗 token，也没有改动任何文件';

    // 跑题判定语料：自己的中文陈述 + 改到的文件路径与 diff 正文（英文代码也能匹配英文目标词）
    const corpus = [cand.summary, diff.text, cand.error].join('\n');
    cand.onTopic = clamp01(topicScore(record.goal, corpus));
  }

  async judgeAll(record) {
    if (!this.judge) {
      record.judge = 'heuristic';
      return;
    }
    try {
      const scores = await this.judge({
        goal: record.goal,
        candidates: record.candidates.map(cand => ({
          taskId: cand.taskId,
          name: cand.name,
          passed: cand.passed,
          status: cand.status,
          onTopic: cand.onTopic,
          tokens: cand.tokens,
          cacheHitRate: cand.cache ? cand.cache.hitRate : null,
          summary: cand.summary,
          diffPreview: cand.diffPreview
        }))
      });
      for (const cand of record.candidates) {
        const score = scores && scores[cand.taskId];
        if (!score) continue;
        if (Number.isFinite(Number(score.onTopic))) cand.onTopic = clamp01(score.onTopic);
        if (Number.isFinite(Number(score.quality))) cand.quality = clamp01(score.quality);
        if (Number.isFinite(Number(score.minimality))) cand.minimality = clamp01(score.minimality);
        if (score.reason) cand.reason = String(score.reason).slice(0, 300);
      }
      record.judge = 'model';
    } catch (error) {
      // 评委挂了不影响比赛结果：退回纯硬指标排序
      record.judge = 'heuristic';
      record.error = `评委调用失败，已退回硬指标排名：${error.message}`;
    }
  }

  rank(record) {
    // 只有「有人达标」时才把低于阈值的判为跑题，避免全员低分导致没有冠军
    const maxScore = record.candidates.reduce((max, cand) => Math.max(max, cand.onTopic == null ? 0 : cand.onTopic), 0);
    for (const cand of record.candidates) {
      cand.offTopic = maxScore >= ON_TOPIC_THRESHOLD && (cand.onTopic == null || cand.onTopic < ON_TOPIC_THRESHOLD);
    }
    const sorted = record.candidates.slice().sort(compareCandidates);
    record.ranking = sorted.map(cand => cand.taskId);
    const top = sorted[0];
    record.winner = (top && !top.offTopic) ? top.taskId : '';
    if (!record.winner) record.note = '全部候选都被判定偏离主题，未产生冠军';
  }

  // ---- 工作区 ----

  headSha(userId, taskId) {
    const res = this.coding.git(userId, taskId, ['rev-parse', 'HEAD']);
    return res && res.success ? String(res.output || '').trim() : '';
  }

  // 整目录复制：先落到 .tmp 再原子替换，复制失败不留下半份工作区
  copyWorkspace(userId, fromTaskId, toTaskId) {
    return copyTaskWorkspace(this.coding, userId, fromTaskId, toTaskId);
  }

  // 相对基线的 diff：git diff <baseSha> 同时覆盖「已提交的检查点」和「还没提交的改动」
  diffStat(userId, baseSha, taskId) {
    const empty = { filesChanged: 0, insertions: 0, deletions: 0, text: '', preview: '' };
    if (!baseSha) return empty;
    // 候选大多是「新建文件」：先 -N 打意图添加，否则 git diff 完全看不到未跟踪的 src/*.js
    this.coding.git(userId, taskId, ['add', '-A', '-N']);
    // 双保险：闭环/项目记忆的自产物（历史遗留或其它路径写入）不计入候选 diff
    const exclude = ['--', '.', ':(exclude).trae', ':(exclude)PLAN.md', ':(exclude)SUMMARY.md', ':(exclude)INDEX.md', ':(exclude)AGENTS.md', ':(exclude)project.json'];
    const numstat = this.coding.git(userId, taskId, ['diff', '--numstat', baseSha, ...exclude]);
    if (!numstat || !numstat.success) return empty;
    const lines = String(numstat.output || '').split('\n').map(line => line.trim()).filter(Boolean);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    const paths = [];
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      filesChanged++;
      const add = parseInt(parts[0], 10);
      const del = parseInt(parts[1], 10);
      if (Number.isFinite(add)) insertions += add;
      if (Number.isFinite(del)) deletions += del;
      paths.push(parts.slice(2).join('\t'));
    }
    const full = this.coding.git(userId, taskId, ['diff', '--unified=2', baseSha, ...exclude]);
    const text = String((full && full.success ? full.output : '') || '').slice(0, 12000);
    return {
      filesChanged,
      insertions,
      deletions,
      text: [paths.join(' '), text].join('\n'),
      preview: text.slice(0, 3000)
    };
  }

  cleanup(userId, candidates) {
    for (const cand of candidates) {
      const dir = this.coding.taskDir(userId, cand.taskId);
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (ignored) { /* best-effort */ }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---- 快照与落盘 ----

  snapshot(record, options = {}) {
    const light = !!options.light;
    return {
      id: record.id,
      owner: record.owner,
      goal: record.goal,
      status: record.status,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt || '',
      error: record.error || '',
      baseTaskId: record.baseTaskId,
      baseSha: record.baseSha || '',
      tokenBudget: record.tokenBudget,
      maxIterations: record.maxIterations,
      concurrency: record.concurrency,
      judge: record.judge,
      note: record.note || '',
      winner: record.winner,
      ranking: Array.isArray(record.ranking) ? record.ranking : [],
      candidates: (record.candidates || []).map(cand => ({
        name: cand.name,
        taskId: cand.taskId,
        model: cand.model,
        status: cand.status,
        passed: !!cand.passed,
        offTopic: !!cand.offTopic,
        onTopic: cand.onTopic,
        quality: cand.quality,
        minimality: cand.minimality,
        iterations: cand.iterations,
        tokens: cand.tokens,
        tokenUsage: cand.tokenUsage,
        cache: cand.cache || null,
        filesChanged: cand.filesChanged,
        insertions: cand.insertions,
        deletions: cand.deletions,
        reason: cand.reason,
        summary: cand.summary,
        error: cand.error,
        diffPreview: light ? '' : cand.diffPreview
      }))
    };
  }

  persist(record) {
    try {
      const file = path.join(this.dir, `${record.id}.json`);
      const compact = this.snapshot(record, { light: false });
      fs.writeFileSync(file, JSON.stringify(compact, null, 2), 'utf8');
      this.prune();
    } catch (error) {
      console.error('[CodingCompetition] 竞赛档案写入失败:', error.message);
    }
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter(name => name.endsWith('.json'));
      if (files.length <= KEEP_RECORDS) return;
      files
        .map(name => ({ name, at: fs.statSync(path.join(this.dir, name)).mtimeMs }))
        .sort((a, b) => a.at - b.at)
        .slice(0, files.length - KEEP_RECORDS)
        .forEach(item => fs.rmSync(path.join(this.dir, item.name), { force: true }));
    } catch (ignored) { /* 清理失败不影响主流程 */ }
  }

  load(id) {
    try {
      const file = path.join(this.dir, `${String(id || '').replace(/[^A-Za-z0-9_-]/g, '')}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return null;
    }
  }

  loadAll() {
    try {
      return fs.readdirSync(this.dir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (error) { return null; }
        })
        .filter(Boolean)
        .map(record => {
          // 档案说还在跑、内存里却没有对应记录 = 上次进程中断遗留。
          // 不改写文件，只在读出来的副本上标成中断，避免页面一直等一个不会结束的比赛。
          if (!this.active.has(record.id) && (record.status === 'running' || record.status === 'judging')) {
            record.status = 'stopped';
            record.note = record.note || '服务中断，这场比赛没有跑完';
            record.finishedAt = record.finishedAt || record.createdAt || '';
          }
          return record;
        });
    } catch (error) {
      return [];
    }
  }
}

module.exports = CodingCompetition;
module.exports.buildCompetitionGoal = buildCompetitionGoal;
module.exports.normalizeCandidates = normalizeCandidates;
module.exports.topicScore = topicScore;
module.exports.compareCandidates = compareCandidates;
module.exports.createModelJudge = createModelJudge;
module.exports.parseJudgeScores = parseJudgeScores;
