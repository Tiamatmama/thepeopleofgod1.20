'use strict';

// 编程人格进化：落盘层（只碰 fs，不做业务判断；回放评分复用 personaEvolution 的纯函数）。
//
// 目录结构（默认 data/persona-evolution，data/ 已 gitignore）：
//   lessons.jsonl        一行一条教训；撤销用 tombstone（type=revoke），不删历史
//   signals.jsonl        失败信号（测试红了 / 用户否了 / 补丁被回滚）；不调模型，只留证据
//   candidates.jsonl     模型写出的候选教训（verified=false），人点头后才转成 lesson
//   proposals/<id>.json  待审/已生效补丁（含最近一次回放记录 replay）
//   state.json           { version, active: { personaId: {...} }, history: [] }
//   audit.jsonl          谁在什么时候记录/提案/回放/放行/回滚
//
// 生效原则：补丁一律先落 pending-human；approve 是「人已经看过」的显式动作，
// 且必须先有一次 verdict=pass 的回放（evaluate → promote → rollback 的 evaluate 环）。
// 读取侧（activeBlock）吞掉所有异常：进化数据坏了绝不能拖垮讨论主链。

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');
const {
  PERSONA_IDS,
  normalizeLesson,
  normalizeSignalKind,
  normalizeCandidate,
  SIGNAL_MAX_CHARS,
  buildProposal,
  scoreReplay,
  judgeReplay,
  RECALL_LIMIT,
  selectLessons,
  buildRecallLine
} = require('./personaEvolution');
const { clamp01 } = require('./memoryLifecycle');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'persona-evolution');
const PROPOSAL_ID_RE = /^pev-[a-z0-9-]+$/i;
const RECALL_COOLDOWN_MS = 10 * 60 * 1000; // 同一场讨论里重复命中只算一次强化，避免写盘风暴

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class PersonaEvolutionStore {
  constructor(options = {}) {
    const opts = options || {};
    this.dir = opts.dir || (opts.root ? path.join(opts.root, 'data', 'persona-evolution') : DEFAULT_DIR);
  }

  lessonsFile() { return path.join(this.dir, 'lessons.jsonl'); }
  signalsFile() { return path.join(this.dir, 'signals.jsonl'); }
  candidatesFile() { return path.join(this.dir, 'candidates.jsonl'); }
  proposalsDir() { return path.join(this.dir, 'proposals'); }
  stateFile() { return path.join(this.dir, 'state.json'); }
  auditFile() { return path.join(this.dir, 'audit.jsonl'); }

  ensureDir() {
    fs.mkdirSync(this.proposalsDir(), { recursive: true });
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  readState() {
    const raw = this.readJson(this.stateFile(), null);
    const state = (raw && typeof raw === 'object') ? raw : {};
    return {
      version: 1,
      active: (state.active && typeof state.active === 'object') ? state.active : {},
      history: Array.isArray(state.history) ? state.history : []
    };
  }

  writeState(state) {
    this.ensureDir();
    writeJsonAtomicSync(this.stateFile(), state);
  }

  audit(event, detail = {}) {
    try {
      this.ensureDir();
      fs.appendFileSync(this.auditFile(), `${JSON.stringify({ at: Date.now(), event, ...detail })}\n`, 'utf8');
    } catch {
      // 审计写失败不阻断主操作
    }
  }

  // 追加一条已确认失误；校验失败直接抛错（CLI 退出码 2）。
  appendLesson(input, { persona, now } = {}) {
    const lesson = normalizeLesson(input, persona, { now });
    lesson.id = lesson.id || makeId('les');
    this.ensureDir();
    if (this.listLessons(lesson.personaId).some((item) => item.id === lesson.id)) {
      throw new Error(`教训 id 已存在：${lesson.id}`);
    }
    fs.appendFileSync(this.lessonsFile(), `${JSON.stringify({ type: 'lesson', ...lesson })}\n`, 'utf8');
    this.audit('lesson-recorded', {
      id: lesson.id,
      personaId: lesson.personaId,
      focusIndex: lesson.focusIndex,
      source: lesson.source
    });
    return lesson;
  }

  // 撤销一条教训（追加 tombstone，不重写文件）
  revokeLesson(id, { by = '', now = Date.now() } = {}) {
    const target = String(id || '').trim();
    if (!target) throw new Error('revoke 需要 lesson id');
    this.ensureDir();
    fs.appendFileSync(this.lessonsFile(), `${JSON.stringify({ type: 'revoke', id: target, at: now, by: String(by || '') })}\n`, 'utf8');
    this.audit('lesson-revoked', { id: target, by: String(by || '') });
    return { success: true, id: target };
  }

  // 读全量教训：单行损坏只跳过该行，不影响其余数据
  listLessons(personaId = '') {
    let text;
    try {
      text = fs.readFileSync(this.lessonsFile(), 'utf8');
    } catch {
      return [];
    }
    const revoked = new Set();
    const byId = new Map();
    const recalls = new Map(); // id -> { count, at }：提取强化留痕
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object') continue;
      if (row.type === 'revoke') {
        revoked.add(String(row.id || ''));
        continue;
      }
      if (row.type === 'recall') {
        const key = String(row.id || '');
        const prev = recalls.get(key) || { count: 0, at: 0 };
        recalls.set(key, { count: prev.count + 1, at: Math.max(prev.at, Number(row.at) || 0) });
        continue;
      }
      if (row.type !== 'lesson' || !row.id) continue;
      byId.set(String(row.id), row);
    }
    const wanted = String(personaId || '').trim().toLowerCase();
    return Array.from(byId.values())
      .filter((row) => !wanted || row.personaId === wanted)
      .map((row) => {
        const hit = recalls.get(String(row.id));
        const lastRecallAt = Number(row.lastRecallAt) || Number(row.at) || 0;
        if (!hit) {
          // 老数据没有 lastRecallAt：退回记录时间，别让几条旧教训看起来「刚刚想起过」
          return { ...row, lastRecallAt, revoked: revoked.has(String(row.id)) };
        }
        // 每次命中：记得更牢一点（salience 步进与记忆系统一致），并刷新最近一次想起的时间
        const baseSalience = clamp01(row.salience == null ? 0.6 : row.salience);
        return {
          ...row,
          salience: Math.min(1, baseSalience + 0.05 * hit.count),
          recallCount: Math.max(0, Number(row.recallCount) || 0) + hit.count,
          lastRecallAt: Math.max(lastRecallAt, hit.at),
          revoked: revoked.has(String(row.id))
        };
      })
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  }

  // 逐行读 JSONL：坏行只丢这一行，不影响其余记录
  readRows(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') rows.push(row);
      } catch {
        // 单行损坏跳过
      }
    }
    return rows;
  }

  // 记一条失败信号：只落证据，不调模型。回滚自动记；测试红了、用户否了由人显式记。
  recordSignal(input = {}) {
    const src = input || {};
    const personaId = String(src.personaId || '').trim().toLowerCase();
    if (!PERSONA_IDS.includes(personaId)) throw new Error(`不认识的编程人格：${personaId || '(空)'}`);
    const kind = normalizeSignalKind(src.kind);
    const material = String(src.material || '').replace(/\s+/g, ' ').trim().slice(0, SIGNAL_MAX_CHARS);
    if (!material) throw new Error('signal 需要 material：写清这次失败发生了什么');
    const signal = {
      type: 'signal',
      id: makeId('sig'),
      personaId,
      kind,
      material,
      sessionId: String(src.sessionId || ''),
      at: Number(src.at) || Date.now()
    };
    this.ensureDir();
    fs.appendFileSync(this.signalsFile(), `${JSON.stringify(signal)}\n`, 'utf8');
    this.audit('signal-recorded', { id: signal.id, personaId, kind });
    return signal;
  }

  listSignals(personaId = '', { pendingOnly = false } = {}) {
    const consumed = new Set();
    const rows = [];
    for (const row of this.readRows(this.signalsFile())) {
      if (row.type === 'signal-consumed') consumed.add(String(row.id || ''));
      else if (row.type === 'signal' && row.id) rows.push(row);
    }
    const wanted = String(personaId || '').trim().toLowerCase();
    return rows
      .filter((row) => !wanted || row.personaId === wanted)
      .filter((row) => !pendingOnly || !consumed.has(String(row.id)))
      .map((row) => ({ ...row, consumed: consumed.has(String(row.id)) }))
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  }

  consumeSignals(ids = []) {
    const list = (Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!list.length) return 0;
    const at = Date.now();
    this.ensureDir();
    fs.appendFileSync(
      this.signalsFile(),
      `${list.map((id) => JSON.stringify({ type: 'signal-consumed', id, at })).join('\n')}\n`,
      'utf8'
    );
    return list.length;
  }

  // 候选教训：模型写出的草稿。只做结构校验，不写进 lessons。
  appendCandidate(input, { persona = null, signalIds = [], now } = {}) {
    const candidate = normalizeCandidate(input, persona, { now });
    candidate.id = makeId('cand');
    this.ensureDir();
    fs.appendFileSync(this.candidatesFile(), `${JSON.stringify({
      type: 'candidate',
      ...candidate,
      signalIds: (Array.isArray(signalIds) ? signalIds : []).map(String)
    })}\n`, 'utf8');
    this.audit('candidate-suggested', {
      id: candidate.id,
      personaId: candidate.personaId,
      attribution: candidate.attribution
    });
    return candidate;
  }

  listCandidates(personaId = '') {
    const verified = new Set();
    const rejected = new Set();
    const rows = [];
    for (const row of this.readRows(this.candidatesFile())) {
      if (row.type === 'candidate-verified') verified.add(String(row.id || ''));
      else if (row.type === 'candidate-rejected') rejected.add(String(row.id || ''));
      else if (row.type === 'candidate' && row.id) rows.push(row);
    }
    const wanted = String(personaId || '').trim().toLowerCase();
    return rows
      .filter((row) => !wanted || row.personaId === wanted)
      .map((row) => ({
        ...row,
        status: rejected.has(String(row.id)) ? 'rejected' : (verified.has(String(row.id)) ? 'verified' : 'pending')
      }))
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  }

  // 人点头：候选转正式教训（verified=true）。之后自动合并会带上它，不用再走一遍 propose/replay。
  verifyCandidate(id, { by = '', persona = null, focusIndex = null, now = Date.now() } = {}) {
    const owner = String(by || '').trim();
    if (!owner) throw new Error('verify 必须记录 by（谁点的头）');
    const target = String(id || '').trim();
    const candidate = this.listCandidates().find((item) => item.id === target && item.status === 'pending');
    if (!candidate) throw new Error(`没有待确认的候选：${target || '(空)'}`);

    const lesson = normalizeLesson({
      personaId: candidate.personaId,
      claim: candidate.claim,
      truth: candidate.truth,
      lesson: candidate.lesson,
      source: `candidate:${candidate.id}`,
      verified: true,
      focusIndex: focusIndex == null ? candidate.focusIndex : focusIndex,
      at: now
    }, persona, { now });
    lesson.id = makeId('les');

    this.ensureDir();
    fs.appendFileSync(this.lessonsFile(), `${JSON.stringify({ type: 'lesson', ...lesson })}\n`, 'utf8');
    fs.appendFileSync(this.candidatesFile(), `${JSON.stringify({
      type: 'candidate-verified',
      id: target,
      lessonId: lesson.id,
      by: owner,
      at: now
    })}\n`, 'utf8');
    this.audit('candidate-verified', { id: target, lessonId: lesson.id, by: owner });
    return { candidate: { ...candidate, status: 'verified' }, lesson };
  }

  rejectCandidate(id, { by = '', reason = '', now = Date.now() } = {}) {
    const owner = String(by || '').trim();
    if (!owner) throw new Error('reject 必须记录 by（谁否的）');
    const target = String(id || '').trim();
    const candidate = this.listCandidates().find((item) => item.id === target && item.status === 'pending');
    if (!candidate) throw new Error(`没有待确认的候选：${target || '(空)'}`);
    this.ensureDir();
    fs.appendFileSync(this.candidatesFile(), `${JSON.stringify({
      type: 'candidate-rejected',
      id: target,
      by: owner,
      reason: String(reason || '').slice(0, 200),
      at: now
    })}\n`, 'utf8');
    this.audit('candidate-rejected', { id: target, by: owner });
    return { success: true, id: target };
  }

  createProposal(personaId, { persona, now = Date.now() } = {}) {
    const pid = String(personaId || '').trim().toLowerCase();
    if (!PERSONA_IDS.includes(pid)) throw new Error(`不认识的编程人格：${pid || '(空)'}`);
    if (!persona || persona.id !== pid) throw new Error(`人格定义与 personaId 不一致：${pid}`);
    const proposal = buildProposal({
      id: makeId('pev'),
      persona,
      lessons: this.listLessons(pid),
      now
    });
    this.ensureDir();
    writeJsonAtomicSync(path.join(this.proposalsDir(), `${proposal.id}.json`), proposal);
    this.audit('proposal-created', {
      id: proposal.id,
      personaId: pid,
      verdict: proposal.verdict,
      status: proposal.status,
      lessons: proposal.lessonIds.length
    });
    return proposal;
  }

  readProposal(id) {
    const key = String(id || '').trim();
    if (!PROPOSAL_ID_RE.test(key) || path.basename(key) !== key) {
      throw new Error(`非法 proposal id：${id}`);
    }
    const proposal = this.readJson(path.join(this.proposalsDir(), `${key}.json`), null);
    if (!proposal || proposal.id !== key) throw new Error(`找不到 proposal：${key}`);
    return proposal;
  }

  // 回放评估（evaluate 环）：拿一批历史失误 + 正常样本，分别在「旧提示」和
  // 「注入本补丁后的提示」下跑同一个 judge，只有不劣化才允许进入 approve。
  // judge(promptText, item) 由调用方注入（CLI 走模型，测试走确定性桩），store 自己不发请求。
  async replay(proposalId, {
    cases, baselinePrompt, candidatePrompt, judge, by = '', now = Date.now()
  } = {}) {
    const owner = String(by || '').trim();
    if (!owner) throw new Error('replay 必须记录 by（谁跑的回放）');
    const proposal = this.readProposal(proposalId);
    if (proposal.verdict !== 'pass') throw new Error(`补丁未通过结构闸（verdict=${proposal.verdict}），不能回放`);
    if (proposal.status !== 'pending-human') throw new Error(`补丁状态是 ${proposal.status}，不是待审`);

    const list = Array.isArray(cases) ? cases : [];
    if (!list.length) throw new Error('replay 至少需要 1 个用例');
    const malformed = list.filter((item) => !item || typeof item.shouldFlag !== 'boolean');
    if (malformed.length) throw new Error(`有 ${malformed.length} 个用例缺 shouldFlag（布尔），正负样本分不开`);
    if (typeof judge !== 'function') throw new Error('replay 需要 judge(prompt, item) 函数');

    const base = String(baselinePrompt || '');
    const cand = String(candidatePrompt || '');
    if (!base || !cand) throw new Error('replay 需要 baselinePrompt 与 candidatePrompt');
    const block = String((proposal.patch && proposal.patch.block) || '');
    if (!block) throw new Error('补丁没有可注入的块，无法回放');
    // 防止把「候选提示其实没带补丁」或「顺手夹带了别的改动」当成证据。
    // 比较时压平空白：补丁插在中间时，两侧会各多一个换行，不压平会误判。
    const flatten = (text) => String(text).replace(/\s+/g, ' ').trim();
    if (!cand.includes(block)) throw new Error('candidatePrompt 未包含本补丁的块，拒绝记录假证据');
    if (flatten(cand.replace(block, '')) !== flatten(base)) {
      throw new Error('candidatePrompt 必须只比 baselinePrompt 多出本补丁的块，拒绝夹带其他改动');
    }

    const run = async (prompt) => {
      const hits = new Map();
      for (const item of list) {
        let flagged;
        try {
          flagged = Boolean(await judge(prompt, item));
        } catch {
          // 单个用例判不出来按「未命中」计，不让一次抖动把整轮回放废掉
          flagged = false;
        }
        hits.set(item, flagged);
      }
      return scoreReplay(list, (item) => hits.get(item), { promptChars: prompt.length });
    };

    const baseline = await run(base);
    const candidate = await run(cand);
    // 「提示膨胀」查的是补丁本身有没有超出预期，而不是拿几百字的身份提示去卡几十字的教训：
    // 基线位放预算（补丁块长度），候选位放实际增量。
    const judged = judgeReplay(
      { ...baseline, promptChars: block.length },
      { ...candidate, promptChars: candidate.promptChars - baseline.promptChars }
    );
    const replay = {
      verdict: judged.verdict,
      reasons: judged.reasons,
      baseline,
      candidate,
      sampleSize: list.length,
      at: new Date(now).toISOString(),
      by: owner
    };

    proposal.replay = replay;
    this.ensureDir();
    writeJsonAtomicSync(path.join(this.proposalsDir(), `${proposal.id}.json`), proposal);
    this.audit('proposal-evaluated', {
      id: proposal.id,
      personaId: proposal.personaId,
      verdict: judged.verdict,
      by: owner,
      sampleSize: list.length
    });
    return replay;
  }

  // 人审放行：只有 verdict=pass、有通过的回放、且 status=pending-human 的补丁能生效。
  approve(proposalId, { approvedBy = '', now = Date.now() } = {}) {
    const owner = String(approvedBy || '').trim();
    if (!owner) throw new Error('approve 必须记录 approvedBy（谁拍的板）');
    const proposal = this.readProposal(proposalId);
    if (proposal.verdict !== 'pass') throw new Error(`补丁未通过结构闸（verdict=${proposal.verdict}），不能生效`);
    const replay = proposal.replay;
    if (!replay || replay.verdict !== 'pass') {
      const replayState = replay ? replay.verdict : '缺失';
      throw new Error(`补丁没有通过的回放（replay=${replayState}），先跑 replay 再放行`);
    }
    if (proposal.status !== 'pending-human') throw new Error(`补丁状态是 ${proposal.status}，不是待审`);

    const state = this.readState();
    const previous = state.active[proposal.personaId] || null;
    if (previous) {
      state.history.push({ ...previous, supersededAt: new Date(now).toISOString() });
    }
    state.active[proposal.personaId] = {
      proposalId: proposal.id,
      block: proposal.patch.block,
      lessonIds: proposal.lessonIds.slice(),
      focusOrder: proposal.focusOrder.slice(),
      appliedAt: new Date(now).toISOString(),
      approvedBy: owner
    };
    proposal.status = 'active';
    proposal.appliedAt = state.active[proposal.personaId].appliedAt;
    proposal.approvedBy = owner;

    this.ensureDir();
    writeJsonAtomicSync(path.join(this.proposalsDir(), `${proposal.id}.json`), proposal);
    this.writeState(state);
    this.audit('proposal-approved', { id: proposal.id, personaId: proposal.personaId, approvedBy: owner });
    return proposal;
  }

  rollback(personaId, { by = '', now = Date.now() } = {}) {
    const pid = String(personaId || '').trim().toLowerCase();
    const state = this.readState();
    const active = state.active[pid];
    if (!active) return { success: false, error: `人格 ${pid} 没有生效中的补丁` };
    state.history.push({ ...active, rolledBackAt: new Date(now).toISOString(), rolledBackBy: String(by || '') });
    delete state.active[pid];
    this.writeState(state);
    // 提案文件同步标记，避免「已回滚」的补丁在档案里仍显示 active。
    try {
      const proposal = this.readProposal(active.proposalId);
      proposal.status = 'rolled-back';
      proposal.rolledBackAt = new Date(now).toISOString();
      proposal.rolledBackBy = String(by || '');
      writeJsonAtomicSync(path.join(this.proposalsDir(), `${proposal.id}.json`), proposal);
    } catch {
      // 档案更新失败不影响回滚本身
    }
    this.audit('proposal-rolled-back', { personaId: pid, proposalId: active.proposalId, by: String(by || '') });
    // 回滚本身就是最强的一条证据：放行过的补丁把人格带偏了，留作下一次提炼的素材
    try {
      this.recordSignal({
        personaId: pid,
        kind: 'rollback',
        material: `补丁 ${active.proposalId} 被回滚（放行人 ${active.approvedBy || '未知'}，回滚人 ${String(by || '未知')}）`,
        at: now
      });
    } catch {
      // 信号落盘失败不影响回滚本身
    }
    return { success: true, personaId: pid, proposalId: active.proposalId };
  }

  activePatch(personaId) {
    const pid = String(personaId || '').trim().toLowerCase();
    return this.readState().active[pid] || null;
  }

  // 当轮召回：按任务文本挑最多 2 条用得上的教训，命中的记一次「提取强化」。
  // 返回的 line 由调用方拼进当轮 user 内容 —— 不进系统提示，提示长度因此保持恒定。
  // 任何异常都退回空串：召回失败最多是这一轮没想起经验，绝不拖垮讨论。
  recall(personaId, taskText, { limit = RECALL_LIMIT, now = Date.now(), cooldownMs = RECALL_COOLDOWN_MS } = {}) {
    try {
      const pid = String(personaId || '').trim().toLowerCase();
      const picked = selectLessons(this.listLessons(pid), taskText, { now, limit });
      if (!picked.length) return { line: '', lessons: [] };
      const cooled = Math.max(0, Number(cooldownMs) || 0);
      const fresh = picked.filter((item) => {
        // 从没被想起过的，第一次命中总要算数；之后同一场讨论内的重复命中不再计数
        const count = Math.max(0, Number(item.lesson.recallCount) || 0);
        return count === 0 || now - (Number(item.lesson.lastRecallAt) || 0) > cooled;
      });
      if (fresh.length) {
        this.ensureDir();
        fs.appendFileSync(
          this.lessonsFile(),
          `${fresh.map((item) => JSON.stringify({ type: 'recall', id: item.lesson.id, at: now })).join('\n')}\n`,
          'utf8'
        );
      }
      return { line: buildRecallLine(picked), lessons: picked.map((item) => item.lesson) };
    } catch {
      return { line: '', lessons: [] };
    }
  }

  // 提案预览入口：任何异常都退回空串，保证讨论主链不受影响。
  // 传 persona 时自动合并「放行之后新记/撤回的教训」：整组教训仍过结构闸才换新块，
  // 否则退回已放行的快照。读路径只计算、不写盘，保证回放证据与状态文件不被暗改。
  activeBlock(personaId, persona = null) {
    try {
      const active = this.activePatch(personaId);
      const block = active && typeof active.block === 'string' ? active.block : '';
      if (!block || !persona || !persona.id) return block;

      const pid = String(personaId || '').trim().toLowerCase();
      const live = this.listLessons(pid).filter((item) => !item.revoked);
      if (!live.length) return '';
      const known = new Set((Array.isArray(active.lessonIds) ? active.lessonIds : []).map(String));
      const liveIds = new Set(live.map((item) => String(item.id)));
      const same = liveIds.size === known.size && [...liveIds].every((id) => known.has(id));
      if (same) return block;

      const merged = buildProposal({ persona, lessons: live, now: Date.now() });
      return merged.verdict === 'pass' && merged.patch.block ? merged.patch.block : block;
    } catch {
      return '';
    }
  }

  status() {
    const state = this.readState();
    return {
      dir: this.dir,
      personas: PERSONA_IDS.map((personaId) => {
        const lessons = this.listLessons(personaId);
        const active = state.active[personaId] || null;
        return {
          personaId,
          lessons: lessons.length,
          revoked: lessons.filter((lesson) => lesson.revoked).length,
          active: active ? { proposalId: active.proposalId, appliedAt: active.appliedAt, approvedBy: active.approvedBy } : null
        };
      }),
      history: state.history.length
    };
  }
}

module.exports = { PersonaEvolutionStore, DEFAULT_DIR };
