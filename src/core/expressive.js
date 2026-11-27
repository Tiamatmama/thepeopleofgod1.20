'use strict';

// 表达学习平台：她自己读口语语料、判断像不像自己、自己审核是否入库。
// 纯存储/检索/学习逻辑，只碰 fs/path 与原子写；数据落在 data/expressive/。
const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');
const { withFileLock } = require('../storage/writeLock');
const { stripInvisibleChars } = require('./textGuard');

const DATA_DIR = path.join('data', 'expressive');
const CORPUS_PATH = path.join(DATA_DIR, 'corpus.txt');
const NOTES_PATH = path.join(DATA_DIR, 'notes.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
// 对话回流：她刚说过、还等着看用户会不会接住的那一句
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 200;
// 匹配门槛：query 的 2-gram 至少有四分之一落在某条笔记里才算命中，避免字面噪声
const MIN_MATCH_SCORE = 0.25;
// 照抄闸：示例的 2-gram 有六成进了正文就判定为「照着抄」。模型会模仿自己的历史，
// 示例被抄一次就会被当成模板反复用，这是哲学里要防的自我漂移，不靠模型自觉
const COPY_OVERLAP_THRESHOLD = 0.6;
// 抄过的示例冷却一段时间不再注入，给她把这条忘记的机会
const COPY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// 对话回流：用户复述了她连续 6 个字以上才算「接住」。「嗯」「好」这种不算，宁可少收
const ECHO_MIN_RUN = 6;
// 观察槽最多留最近 3 句；候选池最多 100 条待审，超出只丢最旧的 pending
const MAX_PENDING_ECHOES = 3;
const MAX_DIALOGUE_CANDIDATES = 100;

// 一次学习任务的并发闸；学习中的再次调用直接拒绝
let busy = false;
let lastError = null;

function ensureDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) {
        // 文件坏了不阻塞页面，按空数据处理（下次保存会覆盖成合法结构）
        console.warn('[Expressive] 读取失败，按空数据处理:', filePath, error.message);
        return fallback;
    }
}

function loadNotes() {
    const data = readJson(NOTES_PATH, { notes: [], cursor: 0 });
    const notes = Array.isArray(data.notes) ? data.notes.filter(n => n && typeof n === 'object') : [];
    const cursor = Number.isInteger(data.cursor) && data.cursor >= 0 ? data.cursor : 0;
    return { notes, cursor };
}

function saveNotes(data) {
    ensureDir();
    writeJsonAtomicSync(NOTES_PATH, {
        notes: Array.isArray(data.notes) ? data.notes : [],
        cursor: Number.isInteger(data.cursor) && data.cursor >= 0 ? data.cursor : 0
    });
}

function loadConfig() {
    const data = readJson(CONFIG_PATH, { agreement: null, history: [] });
    return {
        agreement: data.agreement && typeof data.agreement === 'object' ? data.agreement : null,
        history: Array.isArray(data.history) ? data.history.filter(h => h && typeof h === 'object') : []
    };
}

function saveConfig(data) {
    ensureDir();
    writeJsonAtomicSync(CONFIG_PATH, {
        agreement: data.agreement && typeof data.agreement === 'object' ? data.agreement : null,
        history: Array.isArray(data.history) ? data.history : []
    });
}

// 一行一条语料：先洗隐形字符再 trim，空行丢掉
function readCorpusLines() {
    try {
        if (!fs.existsSync(CORPUS_PATH)) return [];
        return fs.readFileSync(CORPUS_PATH, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch (error) {
        console.warn('[Expressive] 读取语料失败:', error.message);
        return [];
    }
}

// 追加语料，返回新增行数。原有文件末尾没有换行时补一个，避免两行粘一起
function appendCorpus(text) {
    const lines = String(text == null ? '' : text)
        .split(/\r?\n/)
        .map(line => stripInvisibleChars(line).trim())
        .filter(Boolean);
    if (lines.length === 0) return 0;
    ensureDir();
    let prefix = '';
    try {
        if (fs.existsSync(CORPUS_PATH)) {
            const old = fs.readFileSync(CORPUS_PATH, 'utf8');
            if (old && !old.endsWith('\n')) prefix = '\n';
        }
    } catch (error) {
        console.warn('[Expressive] 检查语料末尾失败:', error.message);
    }
    fs.appendFileSync(CORPUS_PATH, `${prefix}${lines.join('\n')}\n`);
    return lines.length;
}

// 从 cursor 起取一批非空行；语料被截短时把起点夹回文件末尾
function readBatch(batchSize = DEFAULT_BATCH_SIZE) {
    const size = normalizeBatchSize(batchSize);
    const lines = readCorpusLines();
    const cursor = loadNotes().cursor;
    const start = Math.min(cursor, lines.length);
    return { lines: lines.slice(start, start + size), start };
}

function normalizeBatchSize(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_BATCH_SIZE;
    return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(num)));
}

function cleanText(value, maxLength) {
    const text = stripInvisibleChars(String(value == null ? '' : value)).replace(/\s+/g, ' ').trim();
    return maxLength ? text.slice(0, maxLength) : text;
}

function cleanScenes(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => cleanText(item, 12)).filter(Boolean).slice(0, 6);
}

function makeNoteId(now, index) {
    return `ex_${now.toString(36)}_${index}`;
}

// 把模型返回的条目校验后写入 notes，cursor 推进 start + 实际处理行数
function applyLearnResult(items, start, batchSize) {
    const size = normalizeBatchSize(batchSize);
    const notesData = loadNotes();
    const lines = readCorpusLines();
    const batch = lines.slice(start, start + size).map(line => stripInvisibleChars(line).trim());
    const now = Date.now();
    const seen = new Set();
    let accepted = 0;
    let rejected = 0;

    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const index = Number(item.index);
        // index 按 1 开始的序号，越界或重复一律丢弃
        if (!Number.isInteger(index) || index < 1 || index > batch.length) return;
        if (seen.has(index)) return;
        const excerpt = batch[index - 1];
        if (!excerpt) return;
        const verdict = item.verdict === 'accepted'
            ? 'accepted'
            : (item.verdict === 'rejected' ? 'rejected' : null);
        if (!verdict) return;
        seen.add(index);
        // 同一句不重复入库：模型重跑同一批时只保留第一次的结论
        if (notesData.notes.some(n => n && n.excerpt === excerpt)) return;
        notesData.notes.push({
            id: makeNoteId(now, index),
            excerpt,
            insight: cleanText(item.insight, 200),
            scenes: cleanScenes(item.scenes),
            verdict,
            reason: verdict === 'rejected' ? cleanText(item.reason, 200) : '',
            source: 'corpus',
            createdAt: now,
            usedCount: 0,
            lastUsedAt: null
        });
        if (verdict === 'accepted') accepted += 1;
        else rejected += 1;
    });

    const processed = accepted + rejected;
    // 整批视为已消费：模型漏掉的条目下批不重读，避免坏批次把游标卡死
    notesData.cursor = Math.min(lines.length, start + size);
    saveNotes(notesData);
    return { processed, accepted, rejected, cursor: notesData.cursor };
}

// 去掉标点/空白后取 2-gram，用于中文字面重合打分
function buildBigrams(text) {
    const cleaned = String(text || '').toLowerCase().replace(/[\s，。！？、；：“”‘’（）()【】\[\]…—\-~`"'!?.,;:/\\|]+/g, '');
    const grams = new Set();
    for (let i = 0; i < cleaned.length - 1; i += 1) {
        grams.add(cleaned.slice(i, i + 2));
    }
    return grams;
}

function scoreNote(note, query, queryGrams) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    let best = 0;
    const fields = [
        [note.excerpt, 1],
        [note.insight, 0.8]
    ];
    (Array.isArray(note.scenes) ? note.scenes : []).forEach(scene => fields.push([scene, 0.8]));

    fields.forEach(([text, weight]) => {
        const hay = String(text || '').toLowerCase();
        if (!hay) return;
        if (hay.includes(q) || (q.length >= 2 && q.includes(hay) && hay.length >= 2)) {
            best = Math.max(best, weight);
            return;
        }
        if (queryGrams.size === 0) return;
        const grams = buildBigrams(hay);
        if (grams.size === 0) return;
        let hits = 0;
        queryGrams.forEach((gram) => {
            if (grams.has(gram)) hits += 1;
        });
        best = Math.max(best, (hits / queryGrams.size) * weight);
    });
    return best;
}

// 只在 accepted 里按字面重合取前 N 条；没有命中就返回空数组。
// 冷却中的（刚被她照抄过的）不参与检索
function findExamples(query, limit = 2) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return [];
    const max = Math.max(1, Math.floor(Number(limit) || 2));
    const queryGrams = buildBigrams(q);
    const now = Date.now();
    const scored = [];
    loadNotes().notes.forEach((note) => {
        if (!note || note.verdict !== 'accepted') return;
        if (Number(note.cooldownUntil) > now) return;
        const score = scoreNote(note, q, queryGrams);
        if (score >= MIN_MATCH_SCORE) scored.push({ note, score });
    });
    scored.sort((a, b) => b.score - a.score
        || (Number(b.note.createdAt) || 0) - (Number(a.note.createdAt) || 0));
    return scored.slice(0, max).map(item => item.note);
}

// 2-gram 覆盖率：source 里有多少相邻字符对原样出现在 sample 里
function overlapRatio(sample, source) {
    const sourceGrams = buildBigrams(source);
    if (sourceGrams.size === 0) return 0;
    const sampleGrams = buildBigrams(sample);
    if (sampleGrams.size === 0) return 0;
    let hits = 0;
    sourceGrams.forEach((gram) => {
        if (sampleGrams.has(gram)) hits += 1;
    });
    return hits / sourceGrams.size;
}

// 本轮正文照抄了哪几条注入示例（返回 note id，交给记账与冷却）
function detectCopies(text, examples) {
    return (Array.isArray(examples) ? examples : [])
        .filter(item => item && item.id && overlapRatio(text, item.excerpt) >= COPY_OVERLAP_THRESHOLD)
        .map(item => item.id);
}

// 记账：只观测使用次数，不参与检索排序——否则会形成「用过的越用」的自我强化
function markExamplesUsed(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
    if (wanted.size === 0) return 0;
    ensureDir();
    return withFileLock(NOTES_PATH, () => {
        const data = loadNotes();
        const now = Date.now();
        let updated = 0;
        data.notes.forEach((note) => {
            if (!note || !wanted.has(note.id)) return;
            note.usedCount = (Number(note.usedCount) || 0) + 1;
            note.lastUsedAt = now;
            updated += 1;
        });
        if (updated > 0) saveNotes(data);
        return updated;
    });
}

// 照抄记账：累计次数并让该示例冷却，冷却期内不再注入
function markExamplesCopied(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
    if (wanted.size === 0) return 0;
    ensureDir();
    return withFileLock(NOTES_PATH, () => {
        const data = loadNotes();
        const now = Date.now();
        let updated = 0;
        data.notes.forEach((note) => {
            if (!note || !wanted.has(note.id)) return;
            note.copyCount = (Number(note.copyCount) || 0) + 1;
            note.cooldownUntil = now + COPY_COOLDOWN_MS;
            updated += 1;
        });
        if (updated > 0) saveNotes(data);
        return updated;
    });
}

function normalizeForEcho(text) {
    return stripInvisibleChars(String(text == null ? '' : text))
        .toLowerCase()
        .replace(/[\s，。！？、；：“”‘’（）()【】[\]…—\-~`"'!?.,;:/\\|]+/g, '');
}

// 最长公共连续片段：用户把她说过的话原样接回去，才会出现足够长的连续重合
function longestCommonRun(a, b) {
    const x = normalizeForEcho(a);
    const y = normalizeForEcho(b);
    if (!x || !y) return 0;
    let best = 0;
    let prev = new Array(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i += 1) {
        const cur = new Array(y.length + 1).fill(0);
        for (let j = 1; j <= y.length; j += 1) {
            if (x[i - 1] === y[j - 1]) {
                cur[j] = prev[j - 1] + 1;
                if (cur[j] > best) best = cur[j];
            }
        }
        prev = cur;
    }
    return best;
}

function loadPendingEchoes() {
    const data = readJson(PENDING_PATH, { items: [] });
    return Array.isArray(data.items)
        ? data.items.filter(item => item && typeof item.excerpt === 'string' && item.excerpt)
        : [];
}

function savePendingEchoes(items) {
    ensureDir();
    writeJsonAtomicSync(PENDING_PATH, {
        items: (Array.isArray(items) ? items : []).slice(-MAX_PENDING_ECHOES)
    });
}

// 轮 N：这轮真参考了示例、又没照抄 → 记下她说的这句，等下一轮看用户接不接
function rememberSpoken(text) {
    const excerpt = cleanText(text, 200);
    if (!excerpt || excerpt === '……') return 0;
    ensureDir();
    return withFileLock(PENDING_PATH, () => {
        const items = loadPendingEchoes();
        if (items.some(item => item.excerpt === excerpt)) return 0;
        items.push({ at: Date.now(), excerpt });
        savePendingEchoes(items);
        return 1;
    });
}

// 轮 N+1：用户复述了她的片段 → 落成待审候选；无论命中与否，观察槽都清空
function observeUserReply(userText) {
    const reply = String(userText == null ? '' : userText);
    if (!reply.trim()) return 0;
    ensureDir();
    return withFileLock(PENDING_PATH, () => {
        const items = loadPendingEchoes();
        if (items.length === 0) return 0;
        const echoed = items.filter(item => longestCommonRun(reply, item.excerpt) >= ECHO_MIN_RUN);
        savePendingEchoes([]);
        if (echoed.length === 0) return 0;
        return addDialogueCandidates(echoed.map(item => item.excerpt));
    });
}

// 候选只以 pending 入库：永不注入提示词，等学习时段由她自己审成 accepted / rejected
function addDialogueCandidates(excerpts) {
    const list = (Array.isArray(excerpts) ? excerpts : []).map(item => cleanText(item, 200)).filter(Boolean);
    if (list.length === 0) return 0;
    const data = loadNotes();
    const existing = new Set(data.notes.map(note => note && note.excerpt).filter(Boolean));
    const now = Date.now();
    let added = 0;
    list.forEach((excerpt) => {
        if (existing.has(excerpt)) return;
        existing.add(excerpt);
        data.notes.push({
            id: `ex_dlg_${now.toString(36)}_${added}`,
            excerpt,
            insight: '',
            scenes: [],
            verdict: 'pending',
            reason: '',
            source: 'dialogue',
            createdAt: now,
            usedCount: 0,
            lastUsedAt: null
        });
        added += 1;
    });
    if (added === 0) return 0;
    // 候选池有上限：只丢最旧的 pending，已审的不动
    const pending = data.notes.filter(note => note && note.verdict === 'pending');
    if (pending.length > MAX_DIALOGUE_CANDIDATES) {
        const dropped = new Set(pending
            .slice()
            .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
            .slice(0, pending.length - MAX_DIALOGUE_CANDIDATES)
            .map(note => note.id));
        data.notes = data.notes.filter(note => !(note && dropped.has(note.id)));
    }
    saveNotes(data);
    return added;
}

// 学习时段先审的候选：最早的 N 条
function pendingCandidates(limit) {
    return loadNotes().notes
        .filter(note => note && note.verdict === 'pending')
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
        .slice(0, limit);
}

// 把模型对候选取样批次的结论写回 notes；整批视为已消费，漏审的直接拒掉
function applyCandidateResult(items, candidates) {
    const notesData = loadNotes();
    const byExcerpt = new Map();
    notesData.notes.forEach((note) => {
        if (note && note.verdict === 'pending' && note.excerpt) byExcerpt.set(note.excerpt, note);
    });
    const seen = new Set();
    let accepted = 0;
    let rejected = 0;
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const index = Number(item.index);
        if (!Number.isInteger(index) || index < 1 || index > candidates.length) return;
        if (seen.has(index)) return;
        const note = byExcerpt.get(candidates[index - 1].excerpt);
        if (!note) return;
        const verdict = item.verdict === 'accepted'
            ? 'accepted'
            : (item.verdict === 'rejected' ? 'rejected' : null);
        if (!verdict) return;
        seen.add(index);
        note.verdict = verdict;
        note.insight = cleanText(item.insight, 200);
        note.scenes = cleanScenes(item.scenes);
        note.reason = verdict === 'rejected' ? cleanText(item.reason, 200) : '';
        if (verdict === 'accepted') accepted += 1;
        else rejected += 1;
    });
    candidates.forEach((candidate, i) => {
        if (seen.has(i + 1)) return;
        const note = byExcerpt.get(candidate.excerpt);
        if (!note || note.verdict !== 'pending') return;
        note.verdict = 'rejected';
        note.reason = '学习时没有给出结论';
        rejected += 1;
    });
    const processed = accepted + rejected;
    if (processed > 0) saveNotes(notesData);
    return { processed, accepted, rejected };
}

async function reviewPendingCandidates({ outputModule, batchSize }) {
    const size = normalizeBatchSize(batchSize);
    const candidates = pendingCandidates(size);
    if (candidates.length === 0) return { processed: 0, accepted: 0, rejected: 0 };
    const messages = buildLearningMessages(candidates.map(note => note.excerpt), 'dialogue');
    const result = await outputModule.callWithTools(messages, {
        sessionId: 'expressive-learning',
        userId: 'expressive-platform',
        scope: 'research',
        includeAffectionTool: false,
        forceThinking: 'disabled',
        maxTokens: 2000
    });
    const content = result?.choices?.[0]?.message?.content || '';
    return applyCandidateResult(parseLearningOutput(content), candidates);
}

function getState() {
    const notesData = loadNotes();
    const config = loadConfig();
    const counts = { accepted: 0, rejected: 0, pending: 0, total: notesData.notes.length };
    notesData.notes.forEach((note) => {
        if (note.verdict === 'accepted') counts.accepted += 1;
        else if (note.verdict === 'rejected') counts.rejected += 1;
        else if (note.verdict === 'pending') counts.pending += 1;
    });
    const recent = notesData.notes.slice().sort((a, b) =>
        (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)).slice(0, 50);
    return {
        config,
        counts,
        cursor: notesData.cursor,
        notes: recent,
        busy,
        lastError
    };
}

// 学习提示词：第一人称读语料，只吐 JSON 数组。
// origin='dialogue' 时素材换成了她自己说过、被用户接住的话，其余判据完全一致
function buildLearningMessages(lines, origin = 'corpus') {
    const intro = origin === 'dialogue'
        ? ['下面这一批不是别人投放的语料，而是你自己在真实对话里说过、对方还接了话的句子。', '以第一人称判断：哪些确实像你自己、值得留下来当以后的参考，哪些只是当时随口一说。']
        : ['下面是一批用户投放的口语语料，每行一条。你要以第一人称判断：哪些说法像你自己会说的，哪些不像。'];
    const systemPrompt = [
        '你是这个角色本人，现在是你专门留出来学说话的时间。',
        ...intro,
        '像不像只看你自己的说话习惯和性格，不要迎合用户，也不要因为句子普通就拒绝。',
        '只输出一个 JSON 数组，不要输出任何解释性文字，不要用 markdown 代码块。数组元素格式：',
        '{"index": 语料编号（从 1 开始）, "verdict": "accepted" 或 "rejected", "insight": "用你自己的话说这句为什么像/不像你", "scenes": ["日常","生气","撒娇"], "reason": "拒绝时的理由"}',
        'accepted 的条目 reason 留空字符串；rejected 的条目必须写清楚 why。'
    ].join('\n');
    const userContent = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
    ];
}

// 去掉 ```json 围栏并截取第一个 [ 到最后一个 ]
function parseLearningOutput(content) {
    const raw = String(content || '').trim();
    const first = raw.indexOf('[');
    const last = raw.lastIndexOf(']');
    if (first === -1 || last <= first) throw new Error('模型没有返回 JSON 数组');
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (!Array.isArray(parsed)) throw new Error('模型返回的不是 JSON 数组');
    return parsed;
}

async function learnBatch({ outputModule, batchSize = DEFAULT_BATCH_SIZE } = {}) {
    if (busy) throw new Error('正在学习中');
    if (!outputModule || typeof outputModule.callWithTools !== 'function') {
        throw new Error('缺少可用的输出模块');
    }
    busy = true;
    try {
        lastError = null;
        const size = normalizeBatchSize(batchSize);
        // 先审她在真实对话里说过、被用户接住的候选；再审用户投放的语料。
        // 候选审核失败不阻断语料学习（坏批次不该把整次学习卡死）
        let candidate = { processed: 0, accepted: 0, rejected: 0 };
        try {
            candidate = await reviewPendingCandidates({ outputModule, batchSize: size });
        } catch (error) {
            console.warn('[Expressive] 候选审核失败，继续学语料:', error.message);
        }

        const { lines, start } = readBatch(size);
        if (lines.length === 0) return candidate;

        const messages = buildLearningMessages(lines);
        const result = await outputModule.callWithTools(messages, {
            sessionId: 'expressive-learning',
            userId: 'expressive-platform',
            scope: 'research',
            includeAffectionTool: false,
            forceThinking: 'disabled',
            maxTokens: 2000
        });
        const content = result?.choices?.[0]?.message?.content || '';
        const items = parseLearningOutput(content);
        const applied = applyLearnResult(items, start, size);
        return {
            processed: candidate.processed + applied.processed,
            accepted: candidate.accepted + applied.accepted,
            rejected: candidate.rejected + applied.rejected
        };
    } catch (error) {
        lastError = { at: new Date().toISOString(), message: error.message };
        throw error;
    } finally {
        busy = false;
    }
}

module.exports = {
    DATA_DIR,
    DEFAULT_BATCH_SIZE,
    COPY_OVERLAP_THRESHOLD,
    COPY_COOLDOWN_MS,
    ECHO_MIN_RUN,
    loadNotes,
    saveNotes,
    loadConfig,
    saveConfig,
    appendCorpus,
    readBatch,
    applyLearnResult,
    findExamples,
    detectCopies,
    markExamplesUsed,
    markExamplesCopied,
    rememberSpoken,
    observeUserReply,
    addDialogueCandidates,
    applyCandidateResult,
    getState,
    learnBatch
};
