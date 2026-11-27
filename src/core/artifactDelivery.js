'use strict';

// 📮 物件投递策略（纯函数，不碰网络、不碰磁盘）
//
// 「生成」与「投递」拆开之后，这里只回答一个问题：现在这一件，能不能发？
// 约束全部是硬的：夜间静默、每日上限、同类冷却、没人理就降频。
// 宁可物件留在时间线里没人看，也不为了送达而突破频次——QQ 号被封是不可逆损失。
// 设计见 docs/superpowers/specs/2026-11-06-timeline-event-bus-design.md §6.3

const { dayKey } = require('./timeline');

const ARTIFACT_DEFAULTS = Object.freeze({
    dailyMax: 4,                  // 每日投递硬上限
    nightStartHour: 23,           // 23:00–07:00 静默（与夜间禁食同一套作息）
    nightEndHour: 7,
    kindCooldownMs: 30 * 60 * 1000, // 同一类物件至少隔 30 分钟
    noReplyHalvingAfter: 2,       // 连续 2 件无回应，当日上限减半
    maxAgeMs: 24 * 60 * 60 * 1000 // 超过 24 小时的旧话不再捞
});

// 环境变量只覆盖每日上限，其余参数保持代码里的默认值
function resolveOptions(env = process.env) {
    const raw = Number(env && env.QQ_ARTIFACT_DAILY_MAX);
    const dailyMax = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : ARTIFACT_DEFAULTS.dailyMax;
    return { ...ARTIFACT_DEFAULTS, dailyMax };
}

function isNightSilent(now, opts = ARTIFACT_DEFAULTS) {
    const hour = new Date(now).getHours();
    return hour >= opts.nightStartHour || hour < opts.nightEndHour;
}

function dailyMaxFor(unansweredStreak, opts = ARTIFACT_DEFAULTS) {
    if (Number.isFinite(unansweredStreak) && unansweredStreak >= opts.noReplyHalvingAfter) {
        return Math.max(1, Math.ceil(opts.dailyMax / 2));
    }
    return opts.dailyMax;
}

function countSentToday(sent, now) {
    const today = dayKey(new Date(now));
    return (sent || []).filter((s) => Number.isFinite(s.at) && dayKey(new Date(s.at)) === today).length;
}

// 从时间线事件里捞出「可以投递的物件」。
// 物件不新增生成调用：私生活动态、到点的约定、被闸门拦下的话头，都是已有产物。
// 同一 artifactId 只保留最新一条（预览版与当晚完整版会覆盖同一天）。
function collectArtifacts(events, { now = Date.now() } = {}) {
    const byId = new Map();
    for (const ev of events || []) {
        let artifact = null;
        const payload = (ev && ev.payload) || {};

        if (ev.type === 'life.event') {
            const day = typeof payload.day === 'string' ? payload.day : dayKey(new Date(ev.at));
            artifact = { artifactId: `life:${day}`, kind: 'note', text: payload.text, at: ev.at };
        } else if (ev.type === 'appointment.scheduled') {
            const dueAt = Number(payload.at);
            // 只捞「已经到点」的约定，没到点的不算提醒
            if (Number.isFinite(dueAt) && dueAt <= now) {
                artifact = {
                    artifactId: `appt:${payload.id}`,
                    kind: 'note',
                    text: typeof payload.text === 'string' ? `还记得吗——${payload.text}` : '',
                    at: dueAt
                };
            }
        } else if (ev.type === 'artifact.created') {
            // 影子模式的候选只做对照，永远不投递
            if (payload.shadow) continue;
            artifact = {
                artifactId: String(payload.artifactId || ''),
                kind: payload.kind || 'note',
                text: payload.text,
                at: ev.at
            };
        }

        if (!artifact) continue;
        if (!artifact.artifactId || typeof artifact.text !== 'string' || !artifact.text.trim()) continue;
        const prev = byId.get(artifact.artifactId);
        if (!prev || artifact.at >= prev.at) byId.set(artifact.artifactId, artifact);
    }
    return Array.from(byId.values());
}

// 连续无回应计数：从最近一次投递往前数，遇到「投递之后用户有说话」就停
function countUnanswered({ sent = [], events = [] } = {}) {
    const deliveries = sent.filter((s) => Number.isFinite(s.at)).sort((a, b) => b.at - a.at);
    const userMessages = events.filter((e) => e.type === 'message.in' && Number.isFinite(e.at));
    let streak = 0;
    for (const delivery of deliveries) {
        const answered = userMessages.some((m) => m.at > delivery.at);
        if (answered) break;
        streak += 1;
    }
    return streak;
}

// 选出这一轮该发的那一件；没有合适的就返回 null（憋着）
function selectDeliverable({
    artifacts = [],
    sent = [],
    now = Date.now(),
    opts = ARTIFACT_DEFAULTS,
    unansweredStreak = 0
} = {}) {
    if (isNightSilent(now, opts)) return null;
    if (countSentToday(sent, now) >= dailyMaxFor(unansweredStreak, opts)) return null;

    const sentIds = new Set(sent.map((s) => s.artifactId));
    const lastKindAt = new Map();
    for (const s of sent) {
        if (!s || !s.kind || !Number.isFinite(s.at)) continue;
        lastKindAt.set(s.kind, Math.max(lastKindAt.get(s.kind) || 0, s.at));
    }

    const fresh = artifacts
        .filter((a) => !sentIds.has(a.artifactId))
        .filter((a) => Number.isFinite(a.at) && now - a.at <= opts.maxAgeMs)
        .sort((a, b) => a.at - b.at);

    for (const a of fresh) {
        const last = lastKindAt.get(a.kind);
        if (last && now - last < opts.kindCooldownMs) continue;
        return a;
    }
    return null;
}

module.exports = {
    ARTIFACT_DEFAULTS,
    resolveOptions,
    isNightSilent,
    dailyMaxFor,
    countSentToday,
    collectArtifacts,
    countUnanswered,
    selectDeliverable
};
