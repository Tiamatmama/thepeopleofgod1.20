'use strict';

// 🌱 事件驱动调度的影子模式：只记录「事件驱动会在这里评估」，不投递、不改现有 tick。
// 与线上 tick 并行跑一段时间做对照；即使判断很差，线上体验也不受影响。

const { dayKey } = require('./timeline');

// 会让「她」值得抬眼的事件：生活有新内容、约定到点、用户开口、新记忆
const RELEVANT_TYPES = new Set([
    'life.event',
    'appointment.scheduled',
    'message.in',
    'memory.created'
]);

function isRelevant(type) {
    return RELEVANT_TYPES.has(type);
}

// 影子候选：只对自带文本的产物记账（生活动态 / 约定），不凭空造句。
// artifactId 带 shadow 前缀，投递策略会明确忽略它（payload.shadow === true）
function shadowCandidate(record) {
    if (!record || record.payload?.shadow) return null;
    const p = record.payload || {};
    let kind = null;
    let text = '';
    if (record.type === 'life.event') {
        kind = 'note';
        text = p.text;
    } else if (record.type === 'appointment.scheduled') {
        kind = 'note';
        text = typeof p.text === 'string' ? `还记得吗——${p.text}` : '';
    }
    if (!kind || typeof text !== 'string' || !text.trim()) return null;
    return {
        artifactId: `shadow:${record.type}:${record.at}`,
        kind,
        text: text.slice(0, 500),
        shadow: true,
        sourceEvent: record.type
    };
}

// 把影子评估挂到时间线上：同一 scope 10 分钟内只记一次，避免事件多时刷屏
function attachShadowScheduler(store, { cooldownMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    const lastAt = new Map();
    return store.subscribe((record, scopeKey) => {
        if (!isRelevant(record.type)) return;
        const at = now();
        const last = lastAt.get(scopeKey) || 0;
        if (at - last < cooldownMs) return;

        const candidate = shadowCandidate(record);
        if (!candidate) return;
        lastAt.set(scopeKey, at);
        store.append(scopeKey, 'artifact.created', {
            ...candidate,
            reason: 'event-driven-shadow',
            day: dayKey(new Date(record.at))
        });
    });
}

module.exports = { RELEVANT_TYPES, isRelevant, shadowCandidate, attachShadowScheduler };
