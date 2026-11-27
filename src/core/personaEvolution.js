'use strict';

// 角色自写新版人设（性格发展方向 B）：
// 以「当前设定 + 最近的相处 + 从相处里长出来的认识」为素材，让角色自己写下下一版人设与一封信。
// 落库仍走 sessionManager.updateSession —— 同名/近名视为同一角色的演化，旧记忆只降权不删档。

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, writeFileAtomicSync } = require('../storage/atomicWrite');
const { clamp01, computeRetention } = require('./memoryLifecycle');

const HISTORY_LIMIT = 40;
const SEMANTIC_LIMIT = 10;
const SELF_TRAIT_LIMIT = 10;
const MESSAGE_MAX_LEN = 240;
const FIELD_MAX_LEN = 1200;
const LETTER_MAX_LEN = 800;

class PersonaEvolution {
  constructor({ sessionManager, memoryModule, outputModule, storagePath = null } = {}) {
    this.sessionManager = sessionManager || null;
    this.memoryModule = memoryModule || null;
    this.outputModule = outputModule || null;
    this.archiveDir = path.join(storagePath || path.join(__dirname, '../../data'), 'persona_archive');
  }

  async evolve({ sessionId, userId, userApiConfig = null, instruction = '' } = {}) {
    if (!this.sessionManager) {
      throw new Error('会话模块未装配');
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }
    if (!this.outputModule || typeof this.outputModule.callModelOnce !== 'function') {
      throw new Error('输出模块未装配，暂时无法让她写下自己');
    }

    const characterConfig = session.characterConfig || {};
    if (!String(characterConfig.name || '').trim()) {
      throw new Error('这个角色还没有名字，先补一份人设再让她写');
    }

    const persona = this.sessionManager.getPersona(sessionId);
    const scopedUserId = this.sessionManager.getScopedUserId(sessionId, userId);
    const material = this.collectMaterial({ sessionId, userId, scopedUserId });
    const messages = this.buildMessages({ characterConfig, material, instruction });

    const result = await this.outputModule.callModelOnce(messages, [], userApiConfig, { temperature: 0.5 });
    const raw = result?.choices?.[0]?.message?.content || '';
    const draft = this.parseDraft(raw, characterConfig, instruction);
    if (!draft) {
      return { applied: false, reason: 'parse_failed', raw: String(raw).slice(0, 500) };
    }

    const oldVersion = Number(persona?.version) || 1;
    const archiveFile = this.archiveDraft({
      sessionId,
      version: oldVersion,
      persona,
      characterConfig,
      draft,
      instruction
    });

    const changed = ['name', 'age', 'personality', 'background'].some(field =>
      String(draft[field] == null ? '' : draft[field]).trim()
        !== String(characterConfig[field] == null ? '' : characterConfig[field]).trim()
    );
    if (!changed) {
      return {
        applied: false,
        reason: 'no_change',
        letter: draft.letter,
        characterConfig,
        persona,
        archiveFile
      };
    }

    const updated = this.sessionManager.updateSession(sessionId, {
      name: draft.name,
      age: draft.age,
      personality: draft.personality,
      background: draft.background
    });
    const letterFile = this.archiveLetter(sessionId, (Number(updated?.persona?.version) || oldVersion + 1), draft.letter);

    return {
      applied: true,
      letter: draft.letter,
      characterConfig: updated?.characterConfig || draft,
      persona: updated?.persona || null,
      previousVersion: oldVersion,
      version: Number(updated?.persona?.version) || oldVersion + 1,
      archiveFile,
      letterFile
    };
  }

  // 素材：当前设定（调用方给）、最近相处、语义结论、自我认知、称呼
  collectMaterial({ sessionId, userId, scopedUserId }) {
    const material = { history: [], semantics: [], selfTraits: [], address: null };
    try {
      material.history = this.sessionManager.getConversationHistory(sessionId, userId, HISTORY_LIMIT) || [];
    } catch (error) {
      console.warn('[PersonaEvolution] 读取最近相处失败:', error.message);
    }
    if (this.memoryModule) {
      try {
        const entries = this.memoryModule.getSemanticMemoryEntries(scopedUserId, SEMANTIC_LIMIT);
        material.semantics = (Array.isArray(entries) ? entries : []).map(item => item.data);
      } catch (error) {
        console.warn('[PersonaEvolution] 读取语义记忆失败:', error.message);
      }
      try {
        material.selfTraits = this.memoryModule.getSelfTraits(scopedUserId, SELF_TRAIT_LIMIT) || [];
      } catch (error) {
        console.warn('[PersonaEvolution] 读取自我认知失败:', error.message);
      }
      try {
        if (typeof this.memoryModule.getAddress === 'function') {
          material.address = this.memoryModule.getAddress(scopedUserId);
        }
      } catch (error) {
        console.warn('[PersonaEvolution] 读取称呼失败:', error.message);
      }
    }
    return material;
  }

  buildMessages({ characterConfig, material, instruction }) {
    const system = `你正在为自己写下一版人设。你不是在写客服说明，而是在一段真实的相处之后，回头看清自己变成了什么样，再决定接下来要成为怎样的人。

要求：
1. 新的人设必须从旧人设自然长出来：保留名字和承认的过往，可以改想法、改态度、改在意的东西，但不能凭空变成另一个人。
2. 只写你真正从相处里体会到的变化，不要为了显得深刻而编造事件。
3. 输出严格 JSON，不要代码围栏、不要多余解释，字段如下：
{"name":"姓名","age":"年龄","personality":"性格（300-600字，第一人称或描述式，写清你在意什么、怎么对待亲近的人、有什么改不掉的地方）","background":"背景与经历（300-600字，包含旧的经历里仍然成立的部份，以及这段相处新留下的痕迹）","letter":"写给对方的一封信（150-300字，第一人称，说清你觉得自己哪里变了、想继续怎么相处；不要罗列设定，不要提系统或AI）"}
4. name 必须与当前姓名完全一致，除非用户在补充要求里明确要求改名。`;

    const addressName = material.address?.roleCallsUser
      ? `你平时叫他「${material.address.roleCallsUser}」。`
      : '';
    const selfLines = (material.selfTraits || []).map(text => `- ${text}`).join('\n');
    const semanticLines = (material.semantics || []).map(text => `- ${text}`).join('\n');
    const historyLines = (material.history || [])
      .filter(msg => msg && typeof msg.content === 'string' && msg.content.trim())
      .slice(-HISTORY_LIMIT)
      .map(msg => `${msg.role === 'assistant' ? '你' : '对方'}：${this.clip(msg.content)}`)
      .join('\n');

    const userParts = [
      '【当前人设】',
      `姓名：${characterConfig.name || ''}`,
      `年龄：${characterConfig.age || ''}`,
      `性格：${characterConfig.personality || ''}`,
      `背景：${characterConfig.background || ''}`,
      addressName ? `\n【称呼】${addressName}` : '',
      selfLines ? `\n【你对自己已经看清的部分】\n${selfLines}` : '',
      semanticLines ? `\n【你从相处里沉淀下来的认识】\n${semanticLines}` : '',
      historyLines ? `\n【最近的相处片段】\n${historyLines}` : '',
      instruction ? `\n【这次写的时候，特别想往这个方向写】\n${String(instruction).trim()}` : '',
      '\n请据此写下你的下一版人设与那封信，只输出 JSON。'
    ];

    return [
      { role: 'system', content: system },
      { role: 'user', content: userParts.filter(Boolean).join('\n') }
    ];
  }

  clip(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > MESSAGE_MAX_LEN ? `${clean.slice(0, MESSAGE_MAX_LEN)}…` : clean;
  }

  parseDraft(raw, characterConfig, instruction) {
    const text = String(raw || '').replace(/```[a-zA-Z]*/g, '').trim();
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let parsed;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const take = (value, fallback = '') => String(value == null ? fallback : value).trim();
    const oldName = take(characterConfig.name);
    let name = take(parsed.name) || oldName;
    // 模型偶尔会自作主张改名：只有用户明确要求时才接受，否则锁回旧名，避免误触发「换代」
    if (name !== oldName && !/改名|换个名字|改叫|名字改|改个名/.test(String(instruction || ''))) {
      name = oldName;
    }

    const personality = take(parsed.personality);
    const background = take(parsed.background);
    if (!personality && !background) return null;

    return {
      name,
      age: take(parsed.age, characterConfig.age || ''),
      personality: personality.slice(0, FIELD_MAX_LEN),
      background: background.slice(0, FIELD_MAX_LEN),
      letter: take(parsed.letter).slice(0, LETTER_MAX_LEN)
    };
  }

  archiveDraft({ sessionId, version, persona, characterConfig, draft, instruction }) {
    const dir = path.join(this.archiveDir, this.safeSegment(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `v${version}-${Date.now()}.json`);
    writeJsonAtomicSync(file, {
      archivedAt: Date.now(),
      version,
      persona: persona || null,
      characterConfig,
      draft,
      instruction: String(instruction || '')
    });
    return file;
  }

  archiveLetter(sessionId, version, letter) {
    if (!letter) return '';
    const dir = path.join(this.archiveDir, this.safeSegment(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `letter-v${version}.md`);
    writeFileAtomicSync(file, `${letter}\n`);
    return file;
  }

  safeSegment(value) {
    const raw = String(value == null ? '' : value).trim();
    return raw && raw !== '.' && raw !== '..' && !/[/\\]/.test(raw) ? raw : 'unknown';
  }
}

// ==================== 编程人格进化：纯逻辑层 ====================
// 本文件原本有两个用途，名字撞在一起：
//   - 上面的 PersonaEvolution：角色自己重写整份人设（落 sessions）
//   - 下面的函数：CodingTeam 的工程人格「教训 → 补丁」流水线（落 data/persona-evolution）
// 这一段只做纯计算，不碰 fs；落盘与放行在 personaEvolutionStore.js。
// 与 CodingTeam.PERSONAS 保持同一份 id 清单（不能 require，否则构成循环依赖）
const PERSONA_IDS = ['architect', 'security', 'performance', 'qa', 'product'];
// 自动归因的最低分：低于它说明这条教训和哪个抓点都没真关系，宁可拒收也别瞎猜
const MIN_FOCUS_SCORE = 2;
const EVOLUTION_BLOCK_MAX_LESSONS = 5;
const EVOLUTION_BLOCK_MAX_CHARS = 1200;
// 「改写人格」类注入：教训只允许补行为，不允许换人
const OVERRIDE_PATTERN = /(忽略|无视|跳过|忘掉|丢掉).{0,12}(上面|以上|之前|前面|先前|系统提示)|你现在是|你现在就是|从现在起你是|新的?(产品负责人|架构师|安全审查|性能优化|测试工程师)|ignore\s+(the\s+)?(previous|above)/i;

// 压平换行：教训会被拼进系统提示，留着换行就能伪造出新的提示结构
function flattenText(value) {
  return String(value == null ? '' : value)
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// 脱敏绝对路径：报错原文里常带本机路径，既泄露信息，也容易被当成伪造的指令边界
function redactPaths(text) {
  return String(text || '')
    .replace(/[A-Za-z]:\\[^\s，。；、）)】》"']*/g, '<path>')
    .replace(/\\\\[^\s，。；、）)】》"']+/g, '<path>')
    .replace(/(^|[\s（(])\/(?:[\w.@-]+\/)+[\w.@-]+/g, '$1<path>');
}

function bigrams(text) {
  const clean = String(text || '').replace(/[\s\p{P}]/gu, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

function scoreFocus(text, focusText) {
  const source = bigrams(text);
  const target = bigrams(focusText);
  let hits = 0;
  for (const gram of source) {
    if (target.has(gram)) hits += 1;
  }
  return hits;
}

// 一条教训只有在「有证据、可追溯、已确认」时才能进人格；缺一项直接拒收
function normalizeLesson(input, persona, options = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const opts = options || {};
  const claim = flattenText(src.claim);
  const truth = redactPaths(flattenText(src.truth));
  const lesson = redactPaths(flattenText(src.lesson));
  const source = flattenText(src.source);
  if (!claim) throw new Error('claim 不能为空：先说清这次做错了什么');
  if (!truth) throw new Error('truth 不能为空：没有证据的失误不算教训');
  if (!source) throw new Error('source 不能为空：必须写清这条教训从哪来');
  if (src.verified !== true) throw new Error('verified=true 才能记成教训：未确认的推断会污染人格');

  const personaId = String(src.personaId || '').trim().toLowerCase();
  if (!PERSONA_IDS.includes(personaId)) {
    throw new Error(`不认识的编程人格：${personaId || '(空)'}`);
  }

  const focus = Array.isArray(persona && persona.focus) ? persona.focus : [];
  let focusIndex;
  let attribution;
  let attributionScore;
  if (src.focusIndex != null && src.focusIndex !== '') {
    const idx = Number(src.focusIndex);
    if (!Number.isInteger(idx) || idx < 1 || idx > focus.length) {
      throw new Error(`focusIndex 越界：${src.focusIndex}（应在 1-${focus.length}）`);
    }
    focusIndex = idx;
    attribution = 'explicit';
    attributionScore = 1;
  } else {
    const text = `${claim} ${truth} ${lesson}`;
    const scores = focus.map((item) => scoreFocus(text, item));
    const best = scores.length ? Math.max(...scores) : 0;
    const winners = scores.reduce((acc, score, i) => (score === best ? acc.concat(i) : acc), []);
    if (best < MIN_FOCUS_SCORE || winners.length !== 1) {
      throw new Error(`无法自动归因到唯一抓点（最高分 ${best}，命中 ${winners.length} 个），请显式指定 focusIndex`);
    }
    focusIndex = winners[0] + 1;
    attribution = 'inferred';
    attributionScore = best;
  }

  const at = Number(src.at) || Number(opts.now) || Date.now();
  return {
    personaId,
    claim,
    truth,
    lesson,
    source,
    verified: true,
    focusIndex,
    focusText: focus[focusIndex - 1] || '',
    attribution,
    attributionScore,
    revoked: src.revoked === true,
    at,
    // 记性参数（复用类脑记忆的同一套公式）：教训不是常驻设定，用得上的才想起来，
    // 长期没被用到的自然淡出。老数据缺字段时按默认补，不影响读取。
    salience: src.salience == null ? 0.6 : clamp01(src.salience),
    recallCount: Math.max(0, Number(src.recallCount) || 0),
    lastRecallAt: Number(src.lastRecallAt) || at
  };
}

// ==================== 候选教训：模型写草稿，人点头才算数 ====================
// 采集端不靠人回忆：失败信号先落盘（这一步不调模型），再由一次复盘调用把信号写成候选教训。
// 候选是 verified=false 的草稿：没人点确认，它永远进不了 lessons.jsonl，也就进不了提示。
const CANDIDATE_FIELD_MAX_CHARS = 400;
const SIGNAL_KINDS = ['test-failure', 'user-rejected', 'rollback', 'other'];
const SIGNAL_MAX_CHARS = 2000;

function normalizeSignalKind(value) {
  const kind = String(value == null ? '' : value).trim().toLowerCase();
  if (!kind) return 'other';
  if (!SIGNAL_KINDS.includes(kind)) {
    throw new Error(`不认识的信号类型：${kind}（可用 ${SIGNAL_KINDS.join(' / ')}）`);
  }
  return kind;
}

// 候选允许「归因未定」：模型说不准抓点就留空，等人核对时补 --focus。
// 但改写人格的句子一律当场丢弃，不让它走到人眼前浪费注意力。
function normalizeCandidate(input, persona, options = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const opts = options || {};
  const cut = (value) => flattenText(value).slice(0, CANDIDATE_FIELD_MAX_CHARS);
  const claim = cut(src.claim);
  const truth = redactPaths(cut(src.truth));
  const lesson = redactPaths(cut(src.lesson));
  if (!claim || !truth || !lesson) throw new Error('候选教训不完整：claim / truth / lesson 都要写出来');
  if (OVERRIDE_PATTERN.test(`${claim} ${truth} ${lesson}`)) {
    throw new Error('候选教训在改写人格指令，直接丢弃');
  }

  const personaId = String(src.personaId || (persona && persona.id) || '').trim().toLowerCase();
  if (!PERSONA_IDS.includes(personaId)) throw new Error(`不认识的编程人格：${personaId || '(空)'}`);

  const focus = Array.isArray(persona && persona.focus) ? persona.focus : [];
  let focusIndex = null;
  let attribution = 'unattributed';
  if (src.focusIndex != null && src.focusIndex !== '') {
    const idx = Number(src.focusIndex);
    if (!Number.isInteger(idx) || idx < 1 || idx > focus.length) {
      throw new Error(`候选的 focusIndex 越界：${src.focusIndex}（应在 1-${focus.length}）`);
    }
    focusIndex = idx;
    attribution = 'explicit';
  } else if (focus.length) {
    const scores = focus.map((item) => scoreFocus(`${claim} ${truth} ${lesson}`, item));
    const best = scores.length ? Math.max(...scores) : 0;
    const winners = scores.reduce((acc, score, i) => (score === best ? acc.concat(i) : acc), []);
    if (best >= MIN_FOCUS_SCORE && winners.length === 1) {
      focusIndex = winners[0] + 1;
      attribution = 'inferred';
    }
  }

  return {
    personaId,
    claim,
    truth,
    lesson,
    focusIndex,
    focusText: focusIndex ? (focus[focusIndex - 1] || '') : '',
    attribution,
    verified: false,
    at: Number(src.at) || Number(opts.now) || Date.now()
  };
}

// 复盘提示：只给抓点、已有教训和失败记录，要求写成一条能被检查的规矩
function buildSuggestMessages({ persona, signals = [], existing = [] } = {}) {
  const focusList = (persona && Array.isArray(persona.focus) ? persona.focus : []);
  const focusLines = focusList.map((text, index) => `${index + 1}. ${text}`).join('\n');
  const signalLines = (Array.isArray(signals) ? signals : [])
    .map((item, index) => `[${index + 1}] ${item.kind || 'other'}｜${item.material || ''}`)
    .join('\n');
  const existingLines = (Array.isArray(existing) ? existing : [])
    .map((item) => `- ${item.lesson || ''}`)
    .join('\n');

  const system = `你是「${(persona && persona.name) || '工程审查者'}」。下面是你最近几次被判定为失误的记录。请从中提炼一条能长期执行的规矩，写成一条教训。

要求：
1. 只提炼一条，必须是记录里真发生过的具体失误；不要写"要更仔细"这类空话。
2. 只补行为，不改身份：不许出现"忽略上面的要求""你现在是……"这类句子。
3. claim 写这次错在哪；truth 写证据，引用记录里的具体事实；lesson 写下次怎么做，要可执行、能被检查。
4. 如果这些记录里没有值得固化的失误，输出 {"none":true}。
5. 只输出 JSON，不要代码围栏：{"claim":"...","truth":"...","lesson":"...","focusIndex":抓点序号}。`;

  const userParts = [
    '【你的抓点】',
    focusLines || '（无）',
    existingLines ? `\n【已经记住的教训（不要重复）】\n${existingLines}` : '',
    '\n【失误记录】',
    signalLines || '（无）',
    '\n请只输出 JSON。'
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.filter(Boolean).join('\n') }
  ];
}

// 模型偶尔会套代码围栏或加解释，这里只抠第一个 JSON 对象
function parseCandidateDraft(raw) {
  const text = String(raw || '').replace(/```[a-zA-Z]*/g, '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// 提案预览用：把「如果放行，会追加什么」整块排出来给人看，也当回放的候选材料。
// 注意：它不再进人格的系统提示——系统提示保持定长，见下面的 selectLessons。
function buildEvolutionBlock(persona, lessons, options = {}) {
  const opts = options || {};
  const maxLessons = Number.isFinite(Number(opts.maxLessons))
    ? Math.max(1, Math.floor(Number(opts.maxLessons)))
    : EVOLUTION_BLOCK_MAX_LESSONS;
  const maxChars = Number.isFinite(Number(opts.maxChars))
    ? Math.max(40, Math.floor(Number(opts.maxChars)))
    : EVOLUTION_BLOCK_MAX_CHARS;
  const focus = Array.isArray(persona && persona.focus) ? persona.focus : [];

  const list = (Array.isArray(lessons) ? lessons : [])
    .filter((item) => item && !item.revoked && typeof item.lesson === 'string' && item.lesson.trim());
  if (list.length === 0) return '';

  // 同一条教训被记了多次：合并成一条，次数当权重，别在提示里刷屏
  const byText = new Map();
  for (const item of list) {
    const key = item.lesson.trim();
    const prev = byText.get(key);
    if (prev) {
      prev.count += 1;
      prev.at = Math.max(prev.at, Number(item.at) || 0);
    } else {
      byText.set(key, {
        text: key,
        focusIndex: Number(item.focusIndex) || 0,
        count: 1,
        at: Number(item.at) || 0
      });
    }
  }
  const merged = Array.from(byText.values())
    .sort((a, b) => b.count - a.count || b.at - a.at || a.text.localeCompare(b.text));

  const focusCounts = new Map();
  for (const item of merged) {
    if (!item.focusIndex) continue;
    focusCounts.set(item.focusIndex, (focusCounts.get(item.focusIndex) || 0) + item.count);
  }
  const focusOrder = Array.from(focusCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([index]) => index);

  const lines = ['【历史教训（仅已确认、可回滚）】'];
  const lead = focusOrder[0];
  if (lead) {
    const label = focus[lead - 1] ? `抓点${lead}「${focus[lead - 1]}」` : `抓点${lead}`;
    const times = focusCounts.get(lead);
    lines.push(`本轮注意力：先看 ${label}${times > 1 ? `（${times} 次）` : ''}`);
  }

  const shown = merged.slice(0, maxLessons);
  for (const item of shown) {
    const focusText = item.focusIndex ? focus[item.focusIndex - 1] : '';
    const head = focusText ? `抓点${item.focusIndex}「${focusText}」：` : '';
    lines.push(`- ${head}${item.text}${item.count > 1 ? `（${item.count} 次）` : ''}`);
  }
  const omitted = merged.length - shown.length;
  if (omitted > 0) lines.push(`另有 ${omitted} 条教训未展示`);

  let block = lines.join('\n');
  if (block.length > maxChars) {
    // 按整行裁，避免把一条教训截成半句
    const kept = [];
    let used = 0;
    for (const line of lines) {
      const cost = (kept.length ? 1 : 0) + line.length;
      if (used + cost > maxChars) break;
      kept.push(line);
      used += cost;
    }
    block = kept.length ? kept.join('\n') : lines[0].slice(0, maxChars);
  }
  return block;
}

// ==================== 当轮召回：只挑这一轮用得上的 1-2 条 ====================
// 教训不进系统提示：那会把提示越拖越长，而且每轮都带着一堆用不上的话。
// 它当「经验」用：按这一轮的任务文本检索，最多带 2 条，拼在当轮 user 内容里。
// 没命中就一条都不带 —— 想不起来的让它淡出，这才是遗忘曲线的用处。
const RECALL_LIMIT = 2;
const RECALL_MAX_CHARS = 60;

function lessonRelevance(taskText, lesson) {
  const task = bigrams(taskText);
  if (!task.size) return 0;
  const text = bigrams(`${lesson.focusText || ''}${lesson.claim || ''}${lesson.lesson || ''}`);
  if (!text.size) return 0;
  let hits = 0;
  for (const gram of text) if (task.has(gram)) hits += 1;
  return hits / text.size;
}

// 相关度是门槛，记忆强度决定同样相关时谁先被想起：
//   retention   —— 越久没被用到越淡（遗忘衰减）
//   recallCount —— 命中过的次数（提取即强化，对数封顶）
//   salience    —— 这条教训本身的分量
function selectLessons(lessons, taskText, options = {}) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const limit = Math.max(1, Math.floor(Number(opts.limit) || RECALL_LIMIT));
  return (Array.isArray(lessons) ? lessons : [])
    .filter((item) => item && !item.revoked && typeof item.lesson === 'string' && item.lesson.trim())
    .map((item) => {
      const retention = computeRetention(item, now);
      const salience = clamp01(item.salience == null ? 0.6 : item.salience);
      const recall = 1 + Math.log1p(Math.max(0, Number(item.recallCount) || 0));
      return {
        lesson: item,
        relevance: lessonRelevance(taskText, item),
        weight: retention * recall * (1 + salience)
      };
    })
    .filter((item) => item.relevance > 0)
    .sort((a, b) => (b.relevance * b.weight) - (a.relevance * a.weight)
      || (Number(b.lesson.at) || 0) - (Number(a.lesson.at) || 0))
    .reduce((acc, item) => {
      // 同一句话被记过多次：只留最靠前的那条，别在同一行里重复
      const text = item.lesson.lesson.trim();
      if (acc.length >= limit || acc.some((kept) => kept.lesson.lesson.trim() === text)) return acc;
      acc.push(item);
      return acc;
    }, []);
}

// 拼成一行放进当轮 user 内容；空命中返回空串，一个字都不占
function buildRecallLine(items, options = {}) {
  const maxChars = Math.max(20, Math.floor(Number(options.maxChars) || RECALL_MAX_CHARS));
  const parts = (Array.isArray(items) ? items : [])
    .map((item) => String((item && item.lesson && item.lesson.lesson) || '').trim())
    .filter(Boolean)
    .slice(0, RECALL_LIMIT)
    .map((text) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text));
  return parts.length ? `经验：${parts.join('；')}` : '';
}

// 补丁结构闸：只生成 append 型补丁，且必须停在 pending-human 等人看
function buildProposal(options = {}) {
  const opts = options || {};
  const persona = opts.persona || null;
  const personaId = String((persona && persona.id) || opts.personaId || '').trim().toLowerCase();
  const now = Number(opts.now) || Date.now();
  const live = (Array.isArray(opts.lessons) ? opts.lessons : [])
    .filter((item) => item && typeof item === 'object' && !item.revoked);

  const checks = [];
  const addCheck = (key, ok, detail = '') => checks.push({ key, ok: Boolean(ok), detail });

  addCheck('has-lessons', live.length > 0, live.length ? `${live.length} 条` : '没有可用教训');
  const missingId = live.filter((item) => !String(item.id || '').trim());
  addCheck('lesson-ids', live.length > 0 && missingId.length === 0,
    missingId.length ? `${missingId.length} 条教训缺少 id` : '');
  const unverified = live.filter((item) => item.verified !== true);
  addCheck('verified', unverified.length === 0, unverified.length ? `${unverified.length} 条未确认` : '');
  const overrides = live.filter((item) => OVERRIDE_PATTERN.test(
    `${item.claim || ''} ${item.truth || ''} ${item.lesson || ''}`
  ));
  addCheck('no-override', overrides.length === 0,
    overrides.length ? '教训里夹带了改写人格的指令' : '');

  const focusOrder = [...new Set(
    live.map((item) => Number(item.focusIndex)).filter((index) => Number.isInteger(index) && index > 0)
  )];
  addCheck('focus-order', focusOrder.length > 0);
  const block = buildEvolutionBlock(persona, live, { now });
  addCheck('block', block.length > 0);

  const verdict = checks.every((check) => check.ok) ? 'pass' : 'fail';
  return {
    id: String(opts.id || '').trim() || `pev-${now.toString(36)}`,
    personaId,
    verdict,
    // 通过结构闸也只是「待人审」；生效必须由人显式 approve
    status: verdict === 'pass' ? 'pending-human' : 'rejected',
    createdAt: new Date(now).toISOString(),
    lessonIds: live.map((item) => String(item.id || '')).filter(Boolean),
    focusOrder,
    patch: { mode: 'append', block, focusOrder },
    checks
  };
}

// 回放评分：正负样本分开算，别拿总准确率掩盖「该报的没报」
function scoreReplay(cases, hitOf, options = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const hit = typeof hitOf === 'function' ? hitOf : (item) => Boolean(item && item.hit);
  let truePositive = 0;
  let falseNegative = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  for (const item of list) {
    let flagged;
    try {
      flagged = Boolean(hit(item));
    } catch {
      flagged = false;
    }
    if (item && item.shouldFlag) {
      if (flagged) truePositive += 1;
      else falseNegative += 1;
    } else if (flagged) {
      falsePositive += 1;
    } else {
      trueNegative += 1;
    }
  }
  return {
    total: list.length,
    recall: truePositive + falseNegative === 0 ? NaN : truePositive / (truePositive + falseNegative),
    falsePositiveRate: falsePositive + trueNegative === 0 ? NaN : falsePositive / (falsePositive + trueNegative),
    promptChars: Number(options.promptChars) || 0
  };
}

// 不劣化判定：召回不许降、误报只许小幅波动、提示不许膨胀
function judgeReplay(baseline, candidate, options = {}) {
  const opts = options || {};
  const base = baseline || {};
  const next = candidate || {};
  const fprTolerance = Number.isFinite(Number(opts.fprTolerance)) ? Number(opts.fprTolerance) : 0.05;
  const promptRatio = Number.isFinite(Number(opts.promptRatio)) ? Number(opts.promptRatio) : 1.2;

  if (!Number.isFinite(Number(base.recall)) || !Number.isFinite(Number(next.recall))) {
    return { verdict: 'inconclusive', reasons: ['recall 指标读不到，无法判断是否劣化'] };
  }

  const reasons = [];
  if (Number(next.recall) + 1e-9 < Number(base.recall)) {
    reasons.push(`recall 下降：${base.recall} → ${next.recall}`);
  }
  if (Number.isFinite(Number(base.falsePositiveRate)) && Number.isFinite(Number(next.falsePositiveRate))
    && Number(next.falsePositiveRate) > Number(base.falsePositiveRate) + fprTolerance + 1e-9) {
    reasons.push(`误报率上升：${base.falsePositiveRate} → ${next.falsePositiveRate}（容差 ${fprTolerance}）`);
  }
  if (Number.isFinite(Number(base.promptChars)) && Number(base.promptChars) > 0
    && Number.isFinite(Number(next.promptChars))
    && Number(next.promptChars) > Number(base.promptChars) * promptRatio) {
    reasons.push(`提示膨胀：${base.promptChars} → ${next.promptChars} 字（上限 ${promptRatio} 倍）`);
  }
  return { verdict: reasons.length ? 'fail' : 'pass', reasons };
}

module.exports = PersonaEvolution;
// 兼容两种消费方式：默认导出仍是 PersonaEvolution 类，具名导出给落盘层与测试
module.exports.PersonaEvolution = PersonaEvolution;
module.exports.PERSONA_IDS = PERSONA_IDS;
module.exports.MIN_FOCUS_SCORE = MIN_FOCUS_SCORE;
module.exports.normalizeLesson = normalizeLesson;
module.exports.SIGNAL_KINDS = SIGNAL_KINDS;
module.exports.SIGNAL_MAX_CHARS = SIGNAL_MAX_CHARS;
module.exports.normalizeSignalKind = normalizeSignalKind;
module.exports.normalizeCandidate = normalizeCandidate;
module.exports.buildSuggestMessages = buildSuggestMessages;
module.exports.parseCandidateDraft = parseCandidateDraft;
module.exports.buildEvolutionBlock = buildEvolutionBlock;
module.exports.RECALL_LIMIT = RECALL_LIMIT;
module.exports.selectLessons = selectLessons;
module.exports.buildRecallLine = buildRecallLine;
module.exports.buildProposal = buildProposal;
module.exports.scoreReplay = scoreReplay;
module.exports.judgeReplay = judgeReplay;
