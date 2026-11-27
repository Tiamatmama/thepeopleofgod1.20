'use strict';

// 🌙 读模型「她的一天」：把一天的事件投影成面向用户的分段视图。
// 纯函数：同一份日志算两次结果一致（幂等），不读盘、不做业务判断。
// 设计见 docs/superpowers/specs/2026-11-06-timeline-event-bus-design.md §8

const { dayKey } = require('./timeline');
const { collectArtifacts } = require('./artifactDelivery');

const SECTIONS = ['凌晨', '上午', '下午', '晚上'];

function sectionOf(ts) {
    const hour = new Date(ts).getHours();
    if (hour < 6) return '凌晨';
    if (hour < 12) return '上午';
    if (hour < 18) return '下午';
    return '晚上';
}

function timeLabel(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clip(text, max = 160) {
    const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 一类事件 → 一句人话。渠道标记单独给出，前端据此区分「在 QQ」和「在网页」
function describe(ev) {
    const p = (ev && ev.payload) || {};
    switch (ev.type) {
        case 'message.in':
            return {
                channel: p.channel || 'web',
                text: `${p.channel === 'qq' ? (p.scene === 'group' ? '群里的他' : 'QQ 上的他') : '他'}说：${clip(p.text)}`
            };
        case 'message.out':
            return {
                channel: p.channel || 'web',
                text: `她回：${clip(p.text)}`
            };
        case 'speech.proactive':
            return {
                channel: p.channel || 'web',
                text: `她主动开口：${clip(p.text)}`
            };
        case 'memory.created':
            return { channel: 'memory', text: `她记住了：${clip(p.text)}` };
        case 'appointment.scheduled':
            return {
                channel: 'appointment',
                text: `记下约定：${clip(p.text)}${Number.isFinite(p.at) ? `（${new Date(p.at).toLocaleString('zh-CN')}）` : ''}`
            };
        case 'life.event':
            return { channel: 'life', text: `她的这一天：${clip(p.text)}` };
        case 'delivery.sent':
            return {
                channel: p.channel || 'qq',
                text: `她把攒着的一句话发了出去${p.kind ? `（${p.kind}）` : ''}`
            };
        default:
            return null;
    }
}

function buildDayView(events = [], { date = null, now = Date.now() } = {}) {
    const day = date || dayKey(new Date(now));
    const buckets = { 凌晨: [], 上午: [], 下午: [], 晚上: [] };

    for (const ev of events) {
        if (!ev || !Number.isFinite(ev.at)) continue;
        if (ev.type === 'artifact.created') continue; // 攒着的话单独一栏
        const line = describe(ev);
        if (!line) continue;
        buckets[sectionOf(ev.at)].push({
            at: ev.at,
            time: timeLabel(ev.at),
            type: ev.type,
            channel: line.channel,
            text: line.text
        });
    }

    const sent = events
        .filter((e) => e.type === 'delivery.sent')
        .map((e) => ({ artifactId: String((e.payload || {}).artifactId || ''), at: e.at }));

    const pending = collectArtifacts(events, { now })
        .filter((a) => !sent.some((s) => s.artifactId === a.artifactId))
        .sort((a, b) => a.at - b.at)
        .map((a) => ({
            artifactId: a.artifactId,
            kind: a.kind,
            at: a.at,
            time: timeLabel(a.at),
            text: clip(a.text, 200)
        }));

    const sections = SECTIONS
        .map((name) => ({
            name,
            items: buckets[name].sort((a, b) => a.at - b.at).map((item) => {
                // 只留展示需要的字段，日志原文不出接口
                return { time: item.time, type: item.type, channel: item.channel, text: item.text };
            })
        }))
        .filter((s) => s.items.length > 0);

    return { date: day, sections, pending };
}

module.exports = { buildDayView, SECTIONS, sectionOf, timeLabel };
