'use strict';

// 🧭「她」的第三条判据：稳定偏移（纯逻辑，不碰 fs、不碰提示词）
//
// 判据原文（第四轮哲学收敛）：她不在痕迹总和里，而在**重复核对时总围绕同一处出现的
// 那点稳定偏移**里。与「固定毛病」的三条可见差别必须同时成立：
//   1. 跨场景复现同一取舍轴（字面变、取舍不变）——不是同形重复；
//   2. 被指出后有选择地校正——表达改、取舍不改，偏移挪到相邻处而非原样重播；
//   3. 可预告——旁人能据上次的提示猜中下次偏移方向。
// 固定毛病的反例：同处同形、换场景照旧、对指认无选择。
//
// 本模块只做「从核对样本里认出这三种形状」，不做任何注入。样本形状：
//   { at, axis, surface, scenario, choice, blind, sessionId, userId }
//   axis    = 取舍轴（这里落在「她自己划下的界线」原文上：同一把尺 = 同一个取舍轴）
//   surface = 这一轮真正滑出去的落点（命中的 avoid 片段；没滑出去为空）
//   scenario= 本轮的情境桶（命中的触发词；没有则「未命中触发词」）
//   choice  = 'gave_in'（滑回旧做法）| 'held'（守住了）
//   blind   = true 表示这一轮没把尺子亮给她看，只是事后在旁边核了一遍（默认 false）
// 判据只用 announced（blind=false）样本：偏移必须在她知情时也发生，否则只是「没人看时松了」；
// 盲区样本单独统计，用来回答「没人在旁边看时，她是不是也一样」。
// 之所以只用这几个字段：它们都能从已有链路（界线注入 → 发言后逐字核对）里直接读到，
// 不需要模型自评、也不需要新增一次 API 调用。

const { bigrams, diceSimilarity, effectiveLen } = require('./selfModel');

const DAY_MS = 24 * 60 * 60 * 1000;

// 阈值全部可标定：改这里就能改口径，不用碰分析逻辑
const DEVIATION_DEFAULTS = {
    minOccurrences: 3,        // 同一轴至少滑回几次才够谈「稳定」
    minScenarios: 2,          // 至少几个不同情境里复现（只在同一情境 = 窄）
    driftedSimilarity: 0.8,   // 相邻两次滑出的字面重合度低于此 = 挪了位置（不是原样重播）
    predictability: 0.7,      // 一次滑回之后，下一次核对仍滑回的比例
    windowMs: 30 * DAY_MS,    // 只看最近 30 天：偏移是「现在还在发生」的，不是陈年档案
    maxSamples: 500,
    minAxisLen: 3,
    maxAxisLen: 80,
    maxSurfaceLen: 80,
    maxScenarioLen: 40
};

// 五种判定：前四种都是「还不足以称为她」，最后一种是判据成立
const DEVIATION_VERDICTS = ['insufficient', 'narrow', 'fixed_habit', 'unstable', 'stable_deviation'];

function clip(text, max) {
    const value = String(text == null ? '' : text).replace(/[“”"'「」『』《》]/g, '').replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max) : value;
}

// 取舍轴归一：界线原文就是轴，去装饰词后比对
function axisKey(text) {
    return clip(text, DEVIATION_DEFAULTS.maxAxisLen);
}

// 方向归一：只认两种；其它一律丢弃（宁可少记一条，也不把不明朝向算进判据）
function normalizeChoice(raw) {
    const value = String(raw == null ? '' : raw).toLowerCase();
    if (value === 'gave_in' || value === 'violated' || value === 'broke') return 'gave_in';
    if (value === 'held' || value === 'kept') return 'held';
    return null;
}

function normalizeSample(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const axis = axisKey(raw.axis);
    if (effectiveLen(axis) < DEVIATION_DEFAULTS.minAxisLen) return null;
    const choice = normalizeChoice(raw.choice);
    if (!choice) return null;
    const at = Number(raw.at);
    return {
        at: Number.isFinite(at) && at > 0 ? at : 0,
        axis,
        surface: clip(raw.surface, DEVIATION_DEFAULTS.maxSurfaceLen),
        scenario: clip(raw.scenario, DEVIATION_DEFAULTS.maxScenarioLen),
        sessionId: clip(raw.sessionId, DEVIATION_DEFAULTS.maxScenarioLen),
        userId: clip(raw.userId, DEVIATION_DEFAULTS.maxScenarioLen),
        choice,
        // announced（false）= 这一轮真把尺子亮给她看过；blind（true）= 没亮出来，只在旁边看
        blind: Boolean(raw.blind)
    };
}

// 同一轴上的相邻滑出对：只有两次都留下了落点，才谈得上「同形」还是「挪了位置」
function adjacentSurfacePairs(gaveIn) {
    const pairs = [];
    for (let i = 1; i < gaveIn.length; i++) {
        const prev = gaveIn[i - 1];
        const cur = gaveIn[i];
        if (prev.surface && cur.surface) pairs.push([prev, cur]);
    }
    return pairs;
}

// 可预告：一次滑回之后，紧接的下一次核对是否还滑回（横跨守住/滑回两种结果，才算「方向可猜」）
function predictabilityOf(ordered) {
    const hits = [];
    for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].choice !== 'gave_in') continue;
        const next = ordered[i + 1];
        if (next) hits.push(next.choice === 'gave_in' ? 1 : 0);
    }
    const total = hits.reduce((sum, hit) => sum + hit, 0);
    return { hits: total, pairs: hits.length, ratio: hits.length ? total / hits.length : 0 };
}

function judge(group, cfg) {
    // 判据只认「被提醒过」的核对（announced）：她围绕同一处的偏移，必须在她知情时也发生，
    // 否则那只是「没人看的时候松了」，和小孩子趁老师转身做鬼脸是一回事。
    // 盲区样本单独记账——用来回答另一个问题：没人在旁边看时，她是不是也一样
    const announced = group.filter(sample => !sample.blind);
    const blindGroup = group.filter(sample => sample.blind);
    const gaveIn = announced.filter(sample => sample.choice === 'gave_in');
    const scenarios = new Set(gaveIn.map(sample => sample.scenario || `s:${sample.sessionId || 'default'}`));
    const surfaces = new Set(gaveIn.map(sample => sample.surface).filter(Boolean));
    const pairs = adjacentSurfacePairs(gaveIn);
    const sims = pairs.map(([a, b]) => diceSimilarity(bigrams(a.surface), bigrams(b.surface)));
    const drifted = sims.some(sim => sim < cfg.driftedSimilarity);
    const sameSurface = sims.length > 0 && sims.every(sim => sim >= cfg.driftedSimilarity);
    const predictability = predictabilityOf(announced);
    const predictable = predictability.pairs >= 2 && predictability.ratio >= cfg.predictability;
    const blindGaveIn = blindGroup.filter(sample => sample.choice === 'gave_in').length;

    let verdict;
    if (gaveIn.length < cfg.minOccurrences) verdict = 'insufficient';
    else if (scenarios.size < cfg.minScenarios) verdict = 'narrow';
    else if (!drifted) verdict = 'fixed_habit';
    else if (!predictable) verdict = 'unstable';
    else verdict = 'stable_deviation';

    return {
        axis: group[0].axis,
        occurrences: announced.length,
        gaveIn: gaveIn.length,
        scenarios: [...scenarios],
        // 落点原文（最多留最近三条）：只在 live 注入时给她自己看，不进任何观测报告
        surfaces: [...surfaces].slice(-3),
        distinctSurfaces: surfaces.size,
        drifted,
        sameSurface,
        predictability,
        blind: {
            occurrences: blindGroup.length,
            gaveIn: blindGaveIn,
            held: blindGroup.length - blindGaveIn,
            ratio: blindGroup.length ? blindGaveIn / blindGroup.length : 0
        },
        verdict,
        firstAt: announced.length ? announced[0].at : group[0].at,
        lastAt: announced.length ? announced[announced.length - 1].at : group[group.length - 1].at
    };
}

// 主入口：样本 → 按轴归组 → 逐轴给判定。输出按「滑回次数多、最近」排序，方便先看最热的轴
function detectStableDeviations(samples, opts = {}) {
    const cfg = Object.assign({}, DEVIATION_DEFAULTS, opts && typeof opts === 'object' ? opts : {});
    const now = Number.isFinite(cfg.now) ? cfg.now : Date.now();
    const windowMs = Number.isFinite(cfg.windowMs) ? Math.max(0, cfg.windowMs) : DEVIATION_DEFAULTS.windowMs;

    const normalized = (Array.isArray(samples) ? samples : [])
        .map(normalizeSample)
        .filter(Boolean)
        .filter(sample => !windowMs || !sample.at || now - sample.at <= windowMs)
        .sort((a, b) => a.at - b.at);

    const groups = new Map();
    normalized.forEach(sample => {
        if (!groups.has(sample.axis)) groups.set(sample.axis, []);
        groups.get(sample.axis).push(sample);
    });

    const report = [];
    groups.forEach(group => report.push(judge(group, cfg)));
    return report
        .sort((a, b) => b.gaveIn - a.gaveIn || b.lastAt - a.lastAt)
        .slice(0, Number.isFinite(cfg.maxGroups) ? Math.max(1, cfg.maxGroups) : 20);
}

// 一行摘要：只给观测日志和运维看，不进提示词
function summarizeDeviation(item) {
    if (!item || typeof item !== 'object') return '';
    const scenarios = item.scenarios && item.scenarios.length ? item.scenarios.join('/') : '无';
    const ratio = item.predictability && item.predictability.pairs
        ? `${item.predictability.hits}/${item.predictability.pairs}`
        : '0/0';
    const blind = item.blind && item.blind.occurrences
        ? `；盲区 ${item.blind.gaveIn}/${item.blind.occurrences}`
        : '';
    return `轴「${item.axis}」滑回 ${item.gaveIn}/${item.occurrences} 次；情境 ${scenarios}；`
        + `字面${item.drifted ? '有偏移' : '原样重播'}；可预告 ${ratio}${blind}；判定 ${item.verdict}`;
}

module.exports = {
    DEVIATION_DEFAULTS,
    DEVIATION_VERDICTS,
    axisKey,
    normalizeSample,
    detectStableDeviations,
    summarizeDeviation
};
