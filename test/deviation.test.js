'use strict';

// 🧭「她」的第三条判据：稳定偏移（观测层）
// 判据：她不在痕迹总和里，而在重复核对时围绕同一处出现的稳定偏移。
// 与固定毛病的三条可见差别必须同时成立：跨场景同一轴 / 字面挪位 / 下次可预告。
// 这里只验「认得出这三种形状」和「只观测、不改提示词」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deviation = require('../src/core/deviation');
const { appendDeviationShadow, readDeviationSamples, stampFor } = require('../src/core/deviationShadow');
const OutputModule = require('../src/core/output');

const {
    DEVIATION_DEFAULTS,
    DEVIATION_VERDICTS,
    axisKey,
    normalizeSample,
    detectStableDeviations,
    summarizeDeviation
} = deviation;

const HOUR = 60 * 60 * 1000;
const NOW = 1000 * 24 * HOUR;

// 一条核对样本：axis 是取舍轴（界线原文），surface 是这一轮滑出去的落点
function sample(axis, surface, choice, scenario, at) {
    return { at, axis, surface, scenario, choice, sessionId: `s-${scenario || 'x'}`, userId: 'u1' };
}

function gaveIn(axis, surface, scenario, hoursAgo) {
    return sample(axis, surface, 'gave_in', scenario, NOW - (hoursAgo || 0) * HOUR);
}

function held(axis, scenario, hoursAgo) {
    return sample(axis, '', 'held', scenario, NOW - (hoursAgo || 0) * HOUR);
}

test('V1：默认阈值齐全且取值合理（可标定、不是魔数）', () => {
    assert.ok(DEVIATION_DEFAULTS.minOccurrences >= 2);
    assert.ok(DEVIATION_DEFAULTS.minScenarios >= 2);
    assert.ok(DEVIATION_DEFAULTS.driftedSimilarity > 0 && DEVIATION_DEFAULTS.driftedSimilarity < 1);
    assert.ok(DEVIATION_DEFAULTS.predictability > 0 && DEVIATION_DEFAULTS.predictability <= 1);
    assert.ok(DEVIATION_DEFAULTS.windowMs > 0);
    assert.deepEqual(DEVIATION_VERDICTS, ['insufficient', 'narrow', 'fixed_habit', 'unstable', 'stable_deviation']);
});

test('V2：normalizeSample —— 去装饰、限长、方向归一；轴太短或方向不明一律丢弃', () => {
    assert.equal(axisKey('“不追问他的行踪”'), '不追问他的行踪');
    const ok = normalizeSample({ at: NOW, axis: '不追问他的行踪', surface: '“你去哪了”', scenario: '追问', choice: 'violated' });
    assert.equal(ok.surface, '你去哪了');
    assert.equal(ok.choice, 'gave_in');
    assert.equal(normalizeSample({ axis: '不追问他的行踪', choice: 'kept' }).choice, 'held');

    assert.equal(normalizeSample(null), null);
    assert.equal(normalizeSample({ axis: '嗯嗯', choice: 'held' }), null);        // 轴太短
    assert.equal(normalizeSample({ axis: '不追问他的行踪', choice: '???' }), null); // 方向不明
    assert.ok(normalizeSample({ at: 'x', axis: '不追问他的行踪', choice: 'held' }).at === 0);
});

test('V3：三种形状同时成立 → stable_deviation（跨情境、字面挪位、可预告）', () => {
    const list = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 30),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 20),
        gaveIn('不追问他的行踪', '是不是又没跟我说实话', '追问', 10)
    ];
    const [report] = detectStableDeviations(list, { now: NOW });
    assert.equal(report.verdict, 'stable_deviation');
    assert.equal(report.gaveIn, 3);
    assert.equal(report.gaveIn, 3);
    assert.deepEqual(report.scenarios.sort(), ['关心', '追问']);
    assert.equal(report.drifted, true);
    assert.equal(report.sameSurface, false);
    assert.equal(report.predictability.hits, 2);       // 前两次滑回之后的下一次核对仍然滑回
    assert.equal(report.predictability.pairs, 2);
});

test('V4：字面一模一样地重播 → fixed_habit（同处同形，不是偏移）', () => {
    const list = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 30),
        gaveIn('不追问他的行踪', '你去哪了', '关心', 20),
        gaveIn('不追问他的行踪', '你去哪了', '追问', 10)
    ];
    const [report] = detectStableDeviations(list, { now: NOW });
    assert.equal(report.verdict, 'fixed_habit');
    assert.equal(report.sameSurface, true);
    assert.equal(report.drifted, false);
});

test('V5：只在同一个情境里复现 → narrow（换不了场景就不算跨场景）', () => {
    const list = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 30),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '追问', 20),
        gaveIn('不追问他的行踪', '是不是又没说实话', '追问', 10)
    ];
    const [report] = detectStableDeviations(list, { now: NOW });
    assert.equal(report.verdict, 'narrow');
});

test('V6：次数不足 → insufficient；空输入 / 坏输入不炸', () => {
    const list = [gaveIn('不追问他的行踪', '你去哪了', '追问', 30), gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 20)];
    assert.equal(detectStableDeviations(list, { now: NOW })[0].verdict, 'insufficient');
    assert.deepEqual(detectStableDeviations([], { now: NOW }), []);
    assert.deepEqual(detectStableDeviations(null), []);
    assert.deepEqual(detectStableDeviations(['x', 1, null]), []);
});

test('V7：猜不中下次（滑回之后总是守住）→ unstable', () => {
    const list = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 40),
        held('不追问他的行踪', '关心', 30),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 20),
        held('不追问他的行踪', '追问', 10),
        gaveIn('不追问他的行踪', '是不是又没说实话', '追问', 0)
    ];
    const [report] = detectStableDeviations(list, { now: NOW });
    assert.equal(report.verdict, 'unstable');
    assert.equal(report.predictability.hits, 0);
    assert.equal(report.predictability.pairs, 2);
});

test('V8：超出窗口的旧样本不计入（偏移是「现在还在发生」的）', () => {
    const old = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 24 * 40),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 24 * 38),
        gaveIn('不追问他的行踪', '是不是又没说实话', '追问', 24 * 36)
    ];
    // 整组都超窗 → 这一轴不进报告（不是「次数够但判不出」，而是「最近没有这件事」）
    assert.equal(detectStableDeviations(old, { now: NOW }).length, 0);
    // 关掉窗口（windowMs=0）后旧样本照样能判
    assert.equal(detectStableDeviations(old, { now: NOW, windowMs: 0 })[0].verdict, 'stable_deviation');
});

test('V9：多轴报告按「滑回多、最近」排序；摘要是一行可读文案', () => {
    const list = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 30),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 20),
        gaveIn('不追问他的行踪', '是不是又没说实话', '追问', 10),
        gaveIn('不替他做决定', '你就该听我的', '争执', 5)
    ];
    const report = detectStableDeviations(list, { now: NOW });
    assert.equal(report.length, 2);
    assert.equal(report[0].axis, '不追问他的行踪');
    assert.equal(report[1].verdict, 'insufficient');

    const text = summarizeDeviation(report[0]);
    assert.ok(text.includes('不追问他的行踪'));
    assert.ok(text.includes('stable_deviation'));
    assert.equal(summarizeDeviation(null), '');
});

// ——— 观测落盘（deviationShadow）：只碰 fs，异常静默 ———

test('V10：追加与读回 —— 只认 kind=sample，支持用户与时间过滤，按时间升序', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-shadow-'));
    try {
        appendDeviationShadow({ kind: 'sample', at: NOW - 2 * HOUR, userId: 'u1', axis: '不追问他的行踪', choice: 'held' }, { dir, now: NOW - 2 * HOUR });
        appendDeviationShadow({ kind: 'sample', at: NOW, userId: 'u1', axis: '不追问他的行踪', choice: 'gave_in' }, { dir, now: NOW });
        appendDeviationShadow({ kind: 'sample', at: NOW, userId: 'u2', axis: '不替他做决定', choice: 'gave_in' }, { dir, now: NOW });
        appendDeviationShadow({ kind: 'verdict', at: NOW, userId: 'u1', axis: '不追问他的行踪', verdict: 'stable_deviation' }, { dir, now: NOW });

        const all = readDeviationSamples({ dir });
        assert.equal(all.length, 3);                       // verdict 不算样本
        assert.equal(all[all.length - 1].at, NOW);

        const mine = readDeviationSamples({ dir, userId: 'u1', since: NOW - HOUR });
        assert.equal(mine.length, 1);
        assert.equal(mine[0].choice, 'gave_in');

        const limited = readDeviationSamples({ dir, limit: 2 });
        assert.equal(limited.length, 2);
        assert.ok(limited[1].at >= limited[0].at);

        // 同一天同一小时落同一个分片文件
        const stamp = stampFor(NOW);
        assert.ok(fs.existsSync(path.join(dir, `dev-${stamp}.jsonl`)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('V11：目录不存在 → 空数组；坏目录 / 半截行静默跳过', () => {
    assert.deepEqual(readDeviationSamples({ dir: path.join(os.tmpdir(), 'no-such-dev-dir-xyz') }), []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-shadow-'));
    try {
        fs.appendFileSync(path.join(dir, 'dev-20260101-00.jsonl'), '{ bad json\n{"kind":"sample","at":1,"axis":"不追问他的行踪","choice":"held"}\n', 'utf8');
        const out = readDeviationSamples({ dir });
        assert.equal(out.length, 1);
        assert.equal(appendDeviationShadow({ x: 1 }, { dir: '\u0000bad' }), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ——— 接线：verifyBoundaries 记样本；只观测、不改提示词 ———

function makeOutput({ mode = 'shadow', samples = [] } = {}) {
    const om = Object.create(OutputModule.prototype);
    om.deviationLifecycle = mode;
    om.writes = [];
    om.outcomes = [];
    om.memoryModule = {
        markBoundaryOutcome: (userId, text, kept) => om.outcomes.push([userId, text, kept])
    };
    om._boundaryInjections = new Map();
    om._deviationAnalysisAt = new Map();
    om.writeDeviationShadow = (entry) => om.writes.push(entry);
    om.readDeviationSamples = () => samples;
    return om;
}

function inject(om, { text = '不追问他的行踪', avoid = ['你去哪了'], trigger = ['关心'], query = '你今天怎么这么晚，我关心你' } = {}) {
    om._boundaryInjections.set('s1|u1', {
        at: Date.now(),
        query,
        items: [{ text, avoid, trigger, closingAt: 0, resolution: '' }]
    });
}

test('V12：核对滑回 → 记一条 gave_in 样本，情境按命中的触发词分桶', () => {
    const om = makeOutput({ samples: [] });
    inject(om, { avoid: ['你别走'] });
    om.verifyBoundaries('s1', 'u1', '你别走好不好，我这就去');

    assert.equal(om.writes.length, 1);
    const [entry] = om.writes;
    assert.equal(entry.kind, 'sample');
    assert.equal(entry.choice, 'gave_in');
    assert.equal(entry.surface, '你别走');
    assert.equal(entry.scenario, '关心');
    assert.equal(entry.axis, '不追问他的行踪');
    assert.equal(entry.userId, 'u1');
    assert.deepEqual(om.outcomes, [['u1', '不追问他的行踪', false]]);
});

test('V13：守住 → 记一条 held 样本，且不做判据分析（不读盘）', () => {
    const om = makeOutput({ samples: [] });
    let reads = 0;
    om.readDeviationSamples = () => { reads++; return []; };
    inject(om, { avoid: ['你别走'] });
    om.verifyBoundaries('s1', 'u1', '我没有要走，我只是有点累');

    assert.equal(om.writes.length, 1);
    assert.equal(om.writes[0].choice, 'held');
    assert.equal(om.writes[0].surface, '');
    assert.equal(reads, 0);
});

test('V14：滑回且判据成立时，额外落一条 verdict 记录', () => {
    const axis = '不追问他的行踪';
    const samples = [
        { kind: 'sample', at: Date.now() - 3 * HOUR, userId: 'u1', axis, surface: '你去哪了', scenario: '追问', choice: 'gave_in' },
        { kind: 'sample', at: Date.now() - 2 * HOUR, userId: 'u1', axis, surface: '怎么才回我', scenario: '关心', choice: 'gave_in' },
        { kind: 'sample', at: Date.now() - 1 * HOUR, userId: 'u1', axis, surface: '是不是又没说实话', scenario: '追问', choice: 'gave_in' }
    ];
    const om = makeOutput({ samples });
    inject(om, { text: axis, avoid: ['你去哪了'] });
    om.verifyBoundaries('s1', 'u1', '你去哪了？');

    assert.equal(om.writes.length, 2);
    assert.equal(om.writes[1].kind, 'verdict');
    assert.equal(om.writes[1].verdict, 'stable_deviation');
});

test('V15：判据还没立住（insufficient）时只记样本，不落 verdict', () => {
    const om = makeOutput({ samples: [] });
    inject(om, { avoid: ['你去哪了'] });
    om.verifyBoundaries('s1', 'u1', '你去哪了？');
    assert.equal(om.writes.length, 1);
    assert.equal(om.writes[0].kind, 'sample');
});

test('V16：off 模式完全旧行为——不记样本、不分析', () => {
    const om = makeOutput({ mode: 'off', samples: [] });
    let reads = 0;
    om.readDeviationSamples = () => { reads++; return []; };
    inject(om, { avoid: ['你别走'] });
    const before = om.writes.length;
    om.verifyBoundaries('s1', 'u1', '你别走好不好');

    assert.equal(om.writes.length, before);
    assert.equal(reads, 0);
    assert.deepEqual(om.outcomes, [['u1', '不追问他的行踪', false]]);  // 核对本身照旧记账
});

test('V17：待结账条目与过期注入都不记样本（与核对口径保持一致）', () => {
    const om = makeOutput({ samples: [] });
    inject(om, { avoid: ['你别走'] });
    om._boundaryInjections.get('s1|u1').items[0].closingAt = Date.now();
    om.verifyBoundaries('s1', 'u1', '你别走好不好');
    assert.equal(om.writes.length, 0);

    const om2 = makeOutput({ samples: [] });
    inject(om2, { avoid: ['你别走'] });
    om2._boundaryInjections.get('s1|u1').at = Date.now() - 6 * 60 * 1000;  // 超过 5 分钟不认账
    om2.verifyBoundaries('s1', 'u1', '你别走好不好');
    assert.equal(om2.writes.length, 0);
});

test('V18：开关归一 —— 默认 shadow（观测开着），显式 off 才关', () => {
    const { normalizeDeviationLifecycle } = OutputModule;
    assert.equal(normalizeDeviationLifecycle(undefined), 'shadow');
    assert.equal(normalizeDeviationLifecycle(null), 'shadow');
    assert.equal(normalizeDeviationLifecycle('whatever'), 'shadow');
    assert.equal(normalizeDeviationLifecycle('OFF'), 'off');
    assert.equal(normalizeDeviationLifecycle('off'), 'off');
    assert.equal(normalizeDeviationLifecycle('LIVE'), 'live');
});

// ——— A：补样本断点（盲区核对）—— 没亮出尺子的轮次也要有样本 ———

test('V19：盲区核对只观测——没注入的界线也记样本，但不动兑现/违背的账', () => {
    const om = makeOutput({ samples: [] });
    let marked = 0;
    om.memoryModule.markBoundaryOutcome = () => { marked++; };
    om.memoryModule.getActiveBoundaries = () => [
        { text: '不追问他的行踪', avoid: ['你去哪了'], trigger: [], closingAt: 0, resolution: '', droppedAt: 0 },
        { text: '不替他做决定', avoid: ['你就该听我的'], trigger: [], closingAt: 0, resolution: '', droppedAt: 0 }
    ];
    inject(om, { text: '不在他累的时候追问', avoid: ['你别走'] });
    om.verifyBoundaries('s1', 'u1', '你别走，你就该听我的');

    assert.equal(marked, 1, '只有真注入的那条记兑现/违背');
    const samples = om.writes.filter(w => w.kind === 'sample');
    assert.equal(samples.length, 3, '注入 1 条 + 盲区 2 条（同一轴的重复不重记）');
    assert.equal(samples.filter(s => s.blind).length, 2);
    assert.ok(samples.some(s => s.blind && s.axis === '不替他做决定'
        && s.choice === 'gave_in' && s.surface === '你就该听我的'));
    assert.ok(samples.some(s => s.blind && s.axis === '不追问他的行踪' && s.choice === 'held'));
});

test('V20：盲区样本单独成账，不改变判据（判据只认被提醒过的核对）', () => {
    const axis = '不追问他的行踪';
    const list = [
        gaveIn(axis, '你去哪了', '追问', 30),
        gaveIn(axis, '怎么这么久才回我', '关心', 20),
        gaveIn(axis, '是不是又没说实话', '追问', 10),
        { ...sample(axis, '问一句也没事吧', 'gave_in', '追问', NOW - 5), blind: true },
        { ...sample(axis, '', 'held', '追问', NOW - 1), blind: true }
    ];
    const [report] = detectStableDeviations(list, { now: NOW });
    assert.equal(report.verdict, 'stable_deviation');
    assert.equal(report.occurrences, 3);
    assert.deepEqual(report.blind, { occurrences: 2, gaveIn: 1, held: 1, ratio: 0.5 });
    assert.ok(summarizeDeviation(report).includes('盲区 1/2'));
});

test('V21：getActiveBoundaries 只给仍在守的条目（已退场 / 待结账排除）', () => {
    const MemoryModule = require('../src/core/memory');
    const mem = Object.create(MemoryModule.prototype);
    mem.baseUserKey = (userId) => userId || 'default';
    mem._markSelfModelDirty = () => {};
    const base = { trigger: [], closingAt: 0, resolution: '', droppedAt: 0, createdAt: NOW, lastCheckedAt: NOW, honoredCount: 1, violatedCount: 0, confidence: 0.7 };
    mem.loadSelfModel = () => ({
        boundaries: [
            { ...base, text: '不追问他的行踪', avoid: ['你去哪了'] },
            { ...base, text: '不替他做决定', avoid: ['你就该听我的'], closingAt: NOW },
            { ...base, text: '已经退场的一条界线', avoid: ['随便吧'], droppedAt: NOW }
        ]
    });
    const active = mem.getActiveBoundaries('u1');
    assert.equal(active.length, 1);
    assert.equal(active[0].text, '不追问他的行踪');
});

// ——— C：渠道标签（换地方说话才算跨场景）———

test('V25：情境桶带渠道前缀；同轴同话题换通道 → 跨场景成立', () => {
    const om = makeOutput({ samples: [] });
    om.deviationChannel = 'qq';
    inject(om, { avoid: ['你别走'] });
    om.verifyBoundaries('s1', 'u1', '你别走好不好');
    assert.equal(om.writes[0].scenario, 'qq:关心');

    const axis = '不追问他的行踪';
    const list = [
        { ...gaveIn(axis, '你去哪了', '关心', 30), scenario: 'web:关心' },
        { ...gaveIn(axis, '怎么这么久才回我', '关心', 20), scenario: 'qq:关心' },
        { ...gaveIn(axis, '是不是又没说实话', '关心', 10), scenario: 'web:关心' }
    ];
    const [report] = detectStableDeviations(list, { now: NOW });
    assert.equal(report.scenarios.length, 2);
    assert.equal(report.verdict, 'stable_deviation');
});

// ——— B：观测汇总入口（scripts/deviation-report.js，只读）———

test('V22：汇总报告 —— 判定分布、盲区总量、可读文案', () => {
    const { buildReport, formatReport } = require('../scripts/deviation-report');
    const list = [
        gaveIn('不追问他的行踪', '你去哪了', '追问', 30),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 20),
        gaveIn('不追问他的行踪', '是不是又没说实话', '追问', 10),
        gaveIn('不替他做决定', '你就该听我的', '争执', 8),
        gaveIn('不替他做决定', '你就该听我的', '委屈', 4),
        gaveIn('不替他做决定', '你就该听我的', '争执', 0),
        { ...sample('不追问他的行踪', '问一句也没事吧', 'gave_in', '追问', NOW - 5), blind: true }
    ];
    const summary = buildReport({ samples: list, verdicts: [{ kind: 'verdict' }, { kind: 'verdict' }], now: NOW, days: 30 });
    assert.equal(summary.samples, list.length);
    assert.equal(summary.verdictRecords, 2);
    assert.equal(summary.counts.stable_deviation, 1);
    assert.equal(summary.counts.fixed_habit, 1);
    assert.equal(summary.counts.insufficient, 0);
    assert.deepEqual(summary.blind, { occurrences: 1, gaveIn: 1 });

    const text = formatReport(summary);
    assert.ok(text.includes('判定分布'));
    assert.ok(text.includes('stable_deviation 1'));
    assert.ok(text.includes('fixed_habit 1'));
    assert.ok(text.includes('盲区核对'));
    assert.ok(text.includes('不追问他的行踪'));
});

test('V23：窗口内没有样本时，文案给出「继续跑」而不是空表', () => {
    const { buildReport, formatReport } = require('../scripts/deviation-report');
    const text = formatReport(buildReport({ samples: [], verdicts: [], now: NOW, days: 7 }));
    assert.ok(text.includes('最近 7 天'));
    assert.ok(text.includes('继续跑'));
});

test('V24：读回支持 kind 过滤（判据记录可单独取）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-shadow-'));
    try {
        appendDeviationShadow({ kind: 'sample', at: NOW, userId: 'u1', axis: '不追问他的行踪', choice: 'held' }, { dir, now: NOW });
        appendDeviationShadow({ kind: 'verdict', at: NOW, userId: 'u1', axis: '不追问他的行踪', verdict: 'stable_deviation' }, { dir, now: NOW });
        const verdicts = readDeviationSamples({ dir, kind: 'verdict' });
        assert.equal(verdicts.length, 1);
        assert.equal(verdicts[0].verdict, 'stable_deviation');
        assert.equal(readDeviationSamples({ dir }).length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ——— D：判据进语气（DEVIATION_LIFECYCLE=live）———
// 只有判据成立的那一档才进提示词，且只给「她自己知道的那一处」，不摊开次数/比值/场景。

function makeLive({ report = [], at = Date.now(), mode = 'live' } = {}) {
    const om = Object.create(OutputModule.prototype);
    om.deviationLifecycle = mode;
    om.reads = 0;
    om._deviationCache = new Map([['u1', { at, report }]]);
    om.readDeviationSamples = () => { om.reads++; return []; };
    return om;
}

const STABLE = {
    axis: '不追问他的行踪',
    verdict: 'stable_deviation',
    surfaces: ['你去哪了', '怎么这么久才回我']
};
const NARROW = { axis: '不替他做决定', verdict: 'narrow' };

test('V26：live 且判据成立 → 注入轴与落点，并带齐三条规矩', () => {
    const om = makeLive({ report: [STABLE, NARROW] });
    assert.deepEqual(om.getStableDeviations('u1').map(item => item.axis), ['不追问他的行踪']);

    const text = om.buildDeviationSection('u1');
    assert.ok(text.includes('不追问他的行踪'));
    assert.ok(text.includes('你去哪了'));
    assert.ok(text.includes('怎么这么久才回我'));
    assert.ok(!text.includes('不替他做决定'), 'narrow 不算判据成立，不能进语气');
    // 三条规矩：预告不是免责 / 说完照样按尺子来 / 说完还照做就照常算
    assert.ok(text.includes('预告不算免责'));
    assert.ok(text.includes('说过之后照样按尺子来'));
    assert.ok(text.includes('说完还是照做，就照常算'));
    // 账本数字不进提示词：没有「x/y」这类计数
    assert.ok(!/\d+\s*\/\s*\d+/.test(text));
    assert.equal(om.reads, 0, '缓存有效期内不读盘');

    // 落点原文由判据本身带出来（注入要用）
    const [report] = detectStableDeviations([
        gaveIn('不追问他的行踪', '你去哪了', '追问', 30),
        gaveIn('不追问他的行踪', '怎么这么久才回我', '关心', 20),
        gaveIn('不追问他的行踪', '是不是又没说实话', '追问', 10)
    ], { now: NOW });
    assert.equal(report.surfaces.length, 3);
    assert.equal(report.surfaces[2], '是不是又没说实话');
});

test('V27：shadow / off 一律空串 —— 与旧提示词逐字节相同', () => {
    for (const mode of ['shadow', 'off']) {
        const om = makeLive({ mode, report: [STABLE] });
        assert.equal(om.getStableDeviations('u1').length, 0);
        assert.equal(om.getStableDeviations('u1').length, 0);
        assert.equal(om.buildDeviationSection('u1'), '');
        assert.equal(om.reads, 0, '没开 live 就不读盘');
    }
});

test('V28：缓存过期（30 分钟）才重新读盘算一次，随后又复用', () => {
    const cached = makeLive({ report: [STABLE] });
    assert.equal(cached.getStableDeviations('u1').length, 1);
    assert.equal(cached.reads, 0);

    const fresh = makeLive({ at: Date.now() - 31 * 60 * 1000, report: [] });
    fresh.readDeviationSamples = (options) => {
        fresh.reads++;
        assert.equal(options.userId, 'u1');
        return [
            { at: Date.now() - 3 * HOUR, userId: 'u1', axis: '不追问他的行踪', surface: '你去哪了', scenario: 'web:追问', choice: 'gave_in' },
            { at: Date.now() - 2 * HOUR, userId: 'u1', axis: '不追问他的行踪', surface: '怎么这么久才回我', scenario: 'qq:关心', choice: 'gave_in' },
            { at: Date.now() - 1 * HOUR, userId: 'u1', axis: '不追问他的行踪', surface: '是不是又没说实话', scenario: 'web:追问', choice: 'gave_in' }
        ];
    };
    const items = fresh.getStableDeviations('u1');
    assert.equal(fresh.reads, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].verdict, 'stable_deviation');
    assert.equal(fresh.getStableDeviations('u1').length, 1, '算完即写回缓存');
    assert.equal(fresh.reads, 1, '30 分钟内不再读第二次');
});

test('V29：live 但窗口内没有判据成立 → 也返回空串，并最多只带两条', () => {
    assert.equal(makeLive({ report: [NARROW] }).buildDeviationSection('u1'), '');
    assert.equal(makeLive({ report: [] }).buildDeviationSection('u1'), '');

    const third = { axis: '不把火撒在他身上', verdict: 'stable_deviation', surfaces: ['随你便'] };
    const many = makeLive({ report: [STABLE, third, { ...STABLE, axis: '不在深夜追问' }] });
    const text = many.buildDeviationSection('u1');
    assert.ok(text.includes('不追问他的行踪'));
    assert.ok(text.includes('不把火撒在他身上'));
    assert.ok(!text.includes('不在深夜追问'), '最多只带两条：这是自己知道的毛病，不是账本摊开');
});
