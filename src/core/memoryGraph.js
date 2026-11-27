'use strict';

// ✨ 记忆星图：把记忆档的原始条目折成「节点 + 边 + 元信息」，只做纯计算。
// 读取与鉴权在 server/routes/memory.js，布局与动画在前端 public/memory-galaxy.html；
// 这里不碰 fs、不碰网络，方便单测（test/memoryGraph.test.js）。
//
// 约定：
//  - 强度 strength ∈ [0,1]：由显著度、唤起次数、置顶、分档、时间衰减合成
//  - faded=true 的节点代表「淡忘」，前端让它变暗下沉，但仍然可点（不删记忆）
//  - warmth ∈ [-1,1]：情绪色温，暖色正、冷色负，前端据此做渐变

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const DEFAULT_MAX_NODES = 420;
const MAX_TEXT_CHARS = 120;
// 强度低于这个值算「淡忘」：沉下去、暗下来，但还留在图上
const FADED_STRENGTH = 0.18;
// 时间衰减半衰期：14 天前的记忆只剩约一半的鲜活度
const DECAY_DAYS = 14;

// 情绪 → 色温（-1 冷 / +1 暖）。未知情绪按中性 0 处理
const EMOTION_WARMTH = {
    happy: 1,
    shy: 0.65,
    dependent: 0.55,
    calm: 0.15,
    sad: -0.6,
    anxious: -0.5,
    jealous: -0.55,
    angry: -0.9
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function emotionWarmth(type) {
    const value = EMOTION_WARMTH[String(type || '')];
    return Number.isFinite(value) ? value : 0;
}

// 本地时区的日期键（YYYY-MM-DD）。同一天的记忆在前端聚成一个星团
function dayKey(ts) {
    const d = new Date(Number(ts) || 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 记忆键 → 展示信息：qq_<号>_<角色>__role / user_<…>__role
function parseScopeLabel(key) {
    const raw = String(key || '').trim();
    const base = raw.replace(/__(?:role|ai)$/, '');
    if (base.startsWith('qq_')) {
        const rest = base.slice(3);
        const cut = rest.indexOf('_');
        const uin = cut === -1 ? rest : rest.slice(0, cut);
        const role = cut === -1 ? '' : rest.slice(cut + 1);
        return { kind: 'qq', uin, role, label: role ? `QQ ${uin} · ${role}` : `QQ ${uin}` };
    }
    return { kind: 'web', uin: '', role: '', label: base ? `网页 · ${base}` : '网页' };
}

// 记忆强度：显著度打底，随时间指数衰减；唤起过的、置顶的、语义化的更亮
function memoryStrength(memory, now) {
    const ts = Number(memory && memory.timestamp) || 0;
    const ageDays = Math.max(0, (now - ts) / DAY_MS);
    const recency = Math.exp(-ageDays / DECAY_DAYS);
    const salience = clamp(Number(memory && memory.salience) || 0.3, 0, 1);
    const recallCount = Math.max(0, Number(memory && memory.recallCount) || 0);

    let strength = salience * (0.35 + 0.65 * recency);
    strength += Math.min(0.2, recallCount * 0.04);
    if (memory && memory.tier === 'archived') strength *= 0.7;
    if (memory && memory.tier === 'semantic') strength = Math.max(strength, 0.55);
    if (memory && memory.pinned) strength = Math.max(strength, 0.95);
    return clamp(strength, 0, 1);
}

function normalizeEmotion(raw) {
    if (!raw || typeof raw !== 'object') return { type: '', intensity: 0 };
    const type = typeof raw.type === 'string' ? raw.type : '';
    const intensity = clamp(Number(raw.intensity) || 0, 0, 1);
    return { type, intensity };
}

// 主入口：memories 为原始记忆数组；opts.days 回溯天数，opts.maxNodes 节点上限
function buildMemoryGraph(input = {}, opts = {}) {
    const now = Number(opts.now) || Date.now();
    const days = clamp(Number(opts.days) || DEFAULT_DAYS, 1, 365);
    const maxNodes = clamp(Number(opts.maxNodes) || DEFAULT_MAX_NODES, 20, 2000);
    const since = now - days * DAY_MS;

    const rawMemories = Array.isArray(input.memories) ? input.memories : [];

    // 只留窗口内、有正文的条目；置顶记忆即便超出窗口也保留（用户明确要求记住的）
    const inWindow = rawMemories.filter((m) => {
        if (!m || typeof m.data !== 'string' || !m.data.trim()) return false;
        const ts = Number(m.timestamp) || 0;
        return ts >= since || m.pinned === true;
    });
    const total = inWindow.length;

    // 超上限时留最近的，置顶的优先保留
    let picked = inWindow;
    if (inWindow.length > maxNodes) {
        const pinned = inWindow.filter((m) => m.pinned === true);
        const rest = inWindow
            .filter((m) => m.pinned !== true)
            .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
        picked = pinned.concat(rest.slice(0, Math.max(0, maxNodes - pinned.length)));
    }

    const nodes = picked
        .map((m) => {
            const ts = Number(m.timestamp) || 0;
            const emotion = normalizeEmotion(m.emotion);
            const strength = memoryStrength(m, now);
            return {
                id: String(m.id),
                text: m.data.trim().slice(0, MAX_TEXT_CHARS),
                ts,
                day: dayKey(ts),
                tier: m.tier || 'episodic',
                salience: clamp(Number(m.salience) || 0.3, 0, 1),
                strength,
                faded: strength < FADED_STRENGTH,
                emotion: emotion.type,
                intensity: emotion.intensity,
                warmth: emotionWarmth(emotion.type),
                speaker: m.speaker || '',
                source: m.source || '',
                pinned: m.pinned === true,
                topicId: m.topicId ? String(m.topicId) : '',
                recallCount: Math.max(0, Number(m.recallCount) || 0)
            };
        })
        .sort((a, b) => a.ts - b.ts);

    const edges = [];
    const seenEdge = new Set();
    const addEdge = (a, b, kind, weight) => {
        if (!a || !b || a.id === b.id) return;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seenEdge.has(key)) return;
        seenEdge.add(key);
        edges.push({ source: a.id, target: b.id, kind, weight });
    };

    // 话题链：同一 topicId 的相邻两条连起来——一条记忆线，而不是一堆散点
    const topicGroups = new Map();
    nodes.forEach((node) => {
        if (!node.topicId) return;
        if (!topicGroups.has(node.topicId)) topicGroups.set(node.topicId, []);
        topicGroups.get(node.topicId).push(node);
    });
    topicGroups.forEach((group) => {
        for (let i = 1; i < group.length; i += 1) {
            addEdge(group[i - 1], group[i], 'topic', 1);
        }
    });

    // 日期链：同一天里按时间相邻的连起来，承担「同一星团」的视觉骨架
    const dayGroups = new Map();
    nodes.forEach((node) => {
        if (!dayGroups.has(node.day)) dayGroups.set(node.day, []);
        dayGroups.get(node.day).push(node);
    });
    dayGroups.forEach((group) => {
        for (let i = 1; i < group.length; i += 1) {
            addEdge(group[i - 1], group[i], 'day', 0.45);
        }
    });

    // 每日概览：时间轴回放用；warmth 按条目数加权，intensity 取当天均值
    const daily = [];
    dayGroups.forEach((group, day) => {
        let warmthSum = 0;
        let intensitySum = 0;
        let emotional = 0;
        group.forEach((node) => {
            if (!node.emotion) return;
            emotional += 1;
            warmthSum += node.warmth;
            intensitySum += node.intensity;
        });
        daily.push({
            day,
            count: group.length,
            start: group[0].ts,
            end: group[group.length - 1].ts,
            warmth: emotional ? Number((warmthSum / emotional).toFixed(3)) : 0,
            intensity: emotional ? Number((intensitySum / emotional).toFixed(3)) : 0
        });
    });
    daily.sort((a, b) => (a.start || 0) - (b.start || 0));

    const emotionCounts = {};
    let warmthTotal = 0;
    nodes.forEach((node) => {
        if (!node.emotion) return;
        emotionCounts[node.emotion] = (emotionCounts[node.emotion] || 0) + 1;
        warmthTotal += node.warmth;
    });
    const emotionalCount = Object.values(emotionCounts).reduce((sum, n) => sum + n, 0);
    const dominantEmotion = Object.keys(emotionCounts)
        .sort((a, b) => emotionCounts[b] - emotionCounts[a])[0] || '';

    const tierCounts = {};
    nodes.forEach((node) => {
        tierCounts[node.tier] = (tierCounts[node.tier] || 0) + 1;
    });

    // 没有实时情绪快照时（例如看的是 QQ 档），用最近一条带情绪的记忆代指「此刻」
    let currentEmotion = typeof input.currentEmotion === 'string' ? input.currentEmotion : '';
    if (!currentEmotion) {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
            if (nodes[i].emotion) { currentEmotion = nodes[i].emotion; break; }
        }
    }

    return {
        nodes,
        edges,
        meta: {
            generatedAt: now,
            days,
            since,
            total,
            kept: nodes.length,
            truncated: total > nodes.length,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            fadedCount: nodes.filter((n) => n.faded).length,
            pinnedCount: nodes.filter((n) => n.pinned).length,
            range: nodes.length ? { from: nodes[0].ts, to: nodes[nodes.length - 1].ts } : null,
            daily,
            tierCounts,
            emotionCounts,
            dominantEmotion,
            averageWarmth: emotionalCount ? Number((warmthTotal / emotionalCount).toFixed(3)) : 0,
            stage: typeof input.stage === 'string' ? input.stage : '',
            stageName: typeof input.stageName === 'string' ? input.stageName : '',
            relationshipScore: Number(input.relationshipScore) || 0,
            currentEmotion
        }
    };
}

module.exports = {
    buildMemoryGraph,
    memoryStrength,
    emotionWarmth,
    dayKey,
    parseScopeLabel,
    EMOTION_WARMTH,
    FADED_STRENGTH,
    DEFAULT_DAYS,
    DEFAULT_MAX_NODES
};
