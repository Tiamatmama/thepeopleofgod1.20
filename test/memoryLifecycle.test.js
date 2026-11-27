'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULTS,
    isProtected, isPinned, isDurable, clamp01, initialSalience, stabilityDays, computeRetention,
    applyForgetting, evictOverflow, reinforce, lifecycleStats, listTombstones
} = require('../src/core/memoryLifecycle');

const DAY = 86400000;

// 造一条普通记忆，ageDays 为「距今多少天」
function mem(ageDays, extra = {}) {
    const now = Date.now();
    return {
        id: Math.random(),
        data: 'user text',
        value: 0,
        salience: 0.3,
        recallCount: 0,
        tier: 'episodic',
        timestamp: now - ageDays * DAY,
        ...extra
    };
}

test('isProtected：正文以【开头的系统条目受保护，其余不受保护', () => {
    assert.equal(isProtected({ data: '【早期对话摘要·滚动】…' }), true);
    assert.equal(isProtected({ data: '普通用户原话' }), false);
    assert.equal(isProtected({}), false);
    assert.equal(isProtected(null), false);
});

test('clamp01：越界与非法值都被夹到 [0,1]', () => {
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(0.42), 0.42);
    assert.equal(clamp01('abc'), 0);
    assert.equal(clamp01(NaN), 0);
});

test('initialSalience：情感越强越显著，落在 [0.3,1]', () => {
    assert.equal(initialSalience(0), 0.3);
    assert.equal(initialSalience(1), 0.8);
    assert.equal(initialSalience(-1), 0.8);
    assert.ok(Math.abs(initialSalience(0.5) - 0.55) < 1e-9);
    assert.equal(initialSalience(undefined), 0.3);
    // 极端值封顶在 1
    assert.equal(initialSalience(2), 1);
});

test('computeRetention：刚发生为 1，越久越淡（单调递减）', () => {
    const now = Date.now();
    const fresh = computeRetention(mem(0), now);
    const old = computeRetention(mem(7), now);
    const older = computeRetention(mem(30), now);
    assert.ok(Math.abs(fresh - 1) < 1e-9);
    assert.ok(old < fresh);
    assert.ok(older < old);
    assert.ok(older > 0);
});

test('computeRetention：salience 越高衰减越慢（同龄下保留度更高）', () => {
    const now = Date.now();
    const low = computeRetention(mem(7, { salience: 0.3 }), now);
    const high = computeRetention(mem(7, { salience: 0.8 }), now);
    assert.ok(high > low);
});

test('computeRetention：recallCount 提升保留度，但封顶后不再增益', () => {
    const now = Date.now();
    const none = computeRetention(mem(7, { recallCount: 0 }), now);
    const some = computeRetention(mem(7, { recallCount: 5 }), now);
    const cap = computeRetention(mem(7, { recallCount: 10 }), now);
    const beyond = computeRetention(mem(7, { recallCount: 100 }), now);
    assert.ok(some > none);
    assert.ok(cap > some);
    // 封顶（默认 recallDurabilityCap=10）后，更多次数不再改变结果
    assert.ok(Math.abs(beyond - cap) < 1e-9);
});

test('computeRetention：lastRecallAt 覆盖 timestamp 作为衰减基准', () => {
    const now = Date.now();
    const m = mem(60, { lastRecallAt: now });
    assert.ok(Math.abs(computeRetention(m, now) - 1) < 1e-9);
});

test('stabilityDays：显著性/回想抬高稳定性，且 computeRetention 与 exp(-dt/S) 一致', () => {
    const now = Date.now();
    const plain = stabilityDays(mem(0, { salience: 0.3, recallCount: 0 }));
    const salient = stabilityDays(mem(0, { salience: 0.8, recallCount: 0 }));
    const recalled = stabilityDays(mem(0, { salience: 0.3, recallCount: 5 }));
    assert.ok(salient > plain);
    assert.ok(recalled > plain);
    // S = S0*(1+K*salience)：默认参数下 salience=0.3 → S0*(1+K*0.3)
    const expectPlain = DEFAULTS.s0Days * (1 + DEFAULTS.kSalience * 0.3);
    assert.ok(Math.abs(plain - expectPlain) < 1e-9);
    // 保留度可由 S 反推：retention(dt) = exp(-dt/S)
    const m = mem(10, { salience: 0.8, recallCount: 2 });
    const dt = 10;
    const s = stabilityDays(m);
    assert.ok(Math.abs(computeRetention(m, now) - Math.exp(-dt / s)) < 1e-9);
    // 参数可覆盖：s0Days 放大，稳定性线性跟随
    const expectS0x2 = 14 * (1 + DEFAULTS.kSalience * 0.3);
    assert.ok(Math.abs(stabilityDays(mem(0, { salience: 0.3 }), { s0Days: 14 }) - expectS0x2) < 1e-9);
});

test('applyForgetting：淡出转归档、彻底忘且从未召回才删除、系统条目不动', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(50),                                   // 淡出但没到删除线 → archived（s0Days=14 时归档窗口约 32~80 天）
            mem(100),                                  // 忘透且从未召回 → 删除（>80 天已过删除线）
            mem(0),                                    // 新鲜 → episodic 保留
            { data: '【早期对话摘要·滚动】摘要', timestamp: now - 400 * DAY, value: 0 } // 受保护
        ]
    };
    const r = applyForgetting(store, now);
    assert.equal(r.scanned, 3);          // 受保护条目不计入扫描
    assert.equal(r.archived, 1);
    assert.equal(r.pruned, 1);
    assert.equal(store.memories.length, 3);
    assert.equal(store.memories[0].tier, 'archived');
    assert.equal(store.memories.filter((m) => m.data.startsWith('【')).length, 1);
});

test('applyForgetting：曾被召回的旧记忆即使很淡也不删除（保留率回升会唤醒归档）', () => {
    const now = Date.now();
    const recalled = mem(40, { recallCount: 3, tier: 'archived' });
    const store = { memories: [recalled] };
    const r = applyForgetting(store, now);
    assert.equal(r.pruned, 0);
    assert.equal(store.memories.length, 1);
});

test('applyForgetting：保留度回升时把归档条目唤醒回情景记忆', () => {
    const now = Date.now();
    const store = { memories: [mem(0, { tier: 'archived' })] };
    const r = applyForgetting(store, now);
    assert.equal(r.recovered, 1);
    assert.equal(store.memories[0].tier, 'episodic');
});

test('evictOverflow：超容量按保留度从低到高淘汰，受保护条目不被挤掉', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(40),
            mem(30),
            mem(20),
            mem(10),
            { data: '【摘要】', timestamp: now - 400 * DAY, value: 0 }
        ]
    };
    const removed = evictOverflow(store, now, { evictLimit: 3 });
    assert.equal(removed, 2);
    assert.equal(store.memories.length, 3);
    // 受保护条目一定还在
    assert.equal(store.memories.filter((m) => m.data.startsWith('【')).length, 1);
    // 被淘汰的是最久远（保留度最低）的两条
    const ages = store.memories
        .filter((m) => !m.data.startsWith('【'))
        .map((m) => Math.round((now - m.timestamp) / DAY))
        .sort((a, b) => a - b);
    assert.deepEqual(ages, [10, 20]);
});

test('evictOverflow：未超容量时不动任何条目', () => {
    const now = Date.now();
    const store = { memories: [mem(0), mem(1)] };
    assert.equal(evictOverflow(store, now, { evictLimit: 1000 }), 0);
    assert.equal(store.memories.length, 2);
});

test('reinforce：召回命中累加 recallCount、刷新时间、抬升 salience 并唤醒归档', () => {
    const now = Date.now();
    const m = mem(30, { salience: 0.3, recallCount: 0, tier: 'archived' });
    const changed = reinforce([m], now);
    assert.equal(changed, 1);
    assert.equal(m.recallCount, 1);
    assert.equal(m.lastRecallAt, now);
    assert.ok(Math.abs(m.salience - 0.35) < 1e-9);
    assert.equal(m.tier, 'episodic');
});

test('reinforce：salience 封顶在 1，且系统条目不被强化', () => {
    const now = Date.now();
    const capped = mem(0, { salience: 1, recallCount: 0 });
    reinforce([capped], now);
    assert.equal(capped.salience, 1);

    const sys = { data: '【摘要】', value: 0, recallCount: 0, salience: 0.3 };
    assert.equal(reinforce([sys], now), 0);
    assert.equal(sys.recallCount, 0);
});

test('lifecycleStats：给出分档计数、风险数与平均保留度（受保护条目不计入保留度）', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(0),
            { data: '【摘要】', timestamp: now, value: 0 },
            mem(60, { tier: 'archived' })   // s0Days=14 时 retention≈0.10，落在风险区
        ]
    };
    const stats = lifecycleStats(store, now);
    assert.equal(stats.total, 3);
    assert.equal(stats.episodic, 2);   // 新鲜的 + 受保护（无 tier 默认情景）
    assert.equal(stats.archived, 1);
    assert.equal(stats.atRisk, 1);     // 只有那条 60 天的还在非保护池里且已淡化
    assert.ok(stats.avgRetention > 0.4 && stats.avgRetention < 0.6);
});

test('isDurable：系统条目与语义记忆都耐久，普通情景记忆不耐久', () => {
    assert.equal(isDurable({ data: '【早期对话摘要·滚动】…' }), true);   // 受保护
    assert.equal(isDurable({ data: '普通语义结论', tier: 'semantic' }), true);
    assert.equal(isDurable({ data: '普通用户原话', tier: 'episodic' }), false);
    assert.equal(isDurable({ data: '普通用户原话' }), false);            // 无 tier 默认情景
    assert.equal(isDurable(null), false);
});

test('applyForgetting：语义记忆不受遗忘影响（不降级、不删除）', () => {
    const now = Date.now();
    const semantic = mem(400, { tier: 'semantic', salience: 0.3, recallCount: 0 });
    const store = { memories: [semantic, mem(0)] };
    const r = applyForgetting(store, now);
    assert.equal(r.scanned, 1);                 // 语义记忆不计入扫描
    assert.equal(r.pruned, 0);
    assert.equal(r.archived, 0);
    assert.equal(semantic.tier, 'semantic');     // 依然保持语义层
    assert.equal(store.memories.length, 2);
});

test('evictOverflow：语义记忆不会被溢出淘汰挤掉', () => {
    const now = Date.now();
    const semantic = mem(400, { tier: 'semantic', salience: 0.3 });
    const store = { memories: [semantic, mem(40), mem(30), mem(20), mem(10)] };
    const removed = evictOverflow(store, now, { evictLimit: 3 });
    assert.equal(removed, 2);
    assert.equal(store.memories.length, 3);
    assert.ok(store.memories.includes(semantic)); // 语义记忆一定还在
});

test('reinforce：语义记忆不被提取强化改写', () => {
    const now = Date.now();
    const semantic = mem(0, { tier: 'semantic', salience: 0.7, recallCount: 0 });
    assert.equal(reinforce([semantic], now), 0);
    assert.equal(semantic.recallCount, 0);
    assert.equal(semantic.salience, 0.7);
    assert.equal(semantic.lastRecallAt, undefined);
});

test('lifecycleStats：语义记忆单独计档且不计入平均保留度', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(0),
            mem(400, { tier: 'semantic', salience: 0.7 }) // 已淡到近 0，但属耐久条目
        ]
    };
    const stats = lifecycleStats(store, now);
    assert.equal(stats.total, 2);
    assert.equal(stats.semantic, 1);
    assert.equal(stats.episodic, 1);
    assert.equal(stats.archived, 0);
    // 语义记忆被跳过，只剩新鲜情景记忆参与统计 → 平均保留度为 1
    assert.ok(Math.abs(stats.avgRetention - 1) < 1e-9);
});

test('initialSalience：情感强度与新颖度作为可得信号抬高初值，不传时向后兼容', () => {
    // 旧调用（不传 extra）结果不变
    assert.equal(initialSalience(0), 0.3);
    assert.equal(initialSalience(0.5), 0.55);
    assert.equal(initialSalience(2), 1);
    // 情绪强度 0.15 权重、新颖度 0.05 权重
    assert.ok(Math.abs(initialSalience(0, { intensity: 1 }) - 0.45) < 1e-9);
    assert.ok(Math.abs(initialSalience(0, { intensity: 1, novelty: 1 }) - 0.5) < 1e-9);
    // 仍受上限 1 约束
    assert.equal(initialSalience(2, { intensity: 1, novelty: 1 }), 1);
    // 单调：加信号只会更显著
    assert.ok(initialSalience(0, { intensity: 1 }) > initialSalience(0));
});

test('isPinned / isDurable：钉住的记忆视为耐久', () => {
    assert.equal(isPinned({ pinned: true }), true);
    assert.equal(isPinned({ pinned: false }), false);
    assert.equal(isPinned({}), false);
    assert.equal(isPinned(null), false);
    assert.equal(isDurable({ data: '普通原话', pinned: true }), true);
});

test('applyForgetting：钉住的记忆不参与归档/删除', () => {
    const now = Date.now();
    const pinned = mem(400, { pinned: true, salience: 0.3, recallCount: 0 });
    const store = { memories: [pinned, mem(400)] };
    const r = applyForgetting(store, now);
    assert.equal(r.scanned, 1);          // 钉住的不计入扫描
    assert.equal(r.pruned, 1);           // 只有没钉住的那条被删
    assert.equal(store.memories.length, 1);
    assert.equal(store.memories[0], pinned);
    assert.equal(pinned.tier, 'episodic'); // 钉住条目 tier 不变
});

test('evictOverflow：钉住的记忆不会被溢出淘汰挤掉', () => {
    const now = Date.now();
    const pinned = mem(400, { pinned: true });
    const store = { memories: [pinned, mem(40), mem(30), mem(20), mem(10)] };
    const removed = evictOverflow(store, now, { evictLimit: 3 });
    assert.equal(removed, 2);
    assert.equal(store.memories.length, 3);
    assert.ok(store.memories.includes(pinned));
});

test('reinforce：钉住的记忆不被提取强化改写', () => {
    const now = Date.now();
    const pinned = mem(0, { pinned: true, salience: 0.5, recallCount: 0 });
    assert.equal(reinforce([pinned], now), 0);
    assert.equal(pinned.recallCount, 0);
    assert.equal(pinned.salience, 0.5);
    assert.equal(pinned.lastRecallAt, undefined);
});

test('applyForgetting：删除时留下遗忘痕迹（tombstone）', () => {
    const now = Date.now();
    // 同话题放两条：碎片配额保底留 1 条，另一条被删并留痕
    const store = {
        memories: [
            mem(400, { topicId: 'T1', salience: 0.35 }),
            mem(400, { topicId: 'T1', salience: 0.7 })
        ]
    };
    const r = applyForgetting(store, now);
    assert.equal(r.pruned, 1);
    assert.equal(store.memories.length, 1);
    assert.equal(store.tombstones.length, 1);
    assert.equal(store.tombstones[0].topicId, 'T1');
    assert.equal(store.tombstones[0].prunedAt, now);
    assert.ok(store.tombstones[0].lastSalience > 0);
});

test('applyForgetting：老数据没有 tombstones 字段也能正常工作', () => {
    const now = Date.now();
    const store = { memories: [mem(400)] };   // 无 tombstones 字段
    assert.doesNotThrow(() => applyForgetting(store, now));
    assert.equal(store.tombstones.length, 1);
});

test('applyForgetting：遗忘痕迹容量封顶，超出按 FIFO 丢弃最早的', () => {
    const now = Date.now();
    const store = {
        memories: [mem(400)],
        tombstones: [
            { topicId: 'old', prunedAt: 1, lastSalience: 0.1 },
            { topicId: 'newer', prunedAt: 2, lastSalience: 0.1 }
        ]
    };
    applyForgetting(store, now, { tombstoneLimit: 2 });
    assert.equal(store.tombstones.length, 2);
    assert.equal(store.tombstones[0].topicId, 'newer'); // 最早的 'old' 被挤掉
    assert.equal(store.tombstones[1].topicId, null);    // 新留痕 topicId 缺失回 null
});

test('listTombstones：只读返回最近 limit 条，非法输入安全兜底', () => {
    const store = { tombstones: [{ prunedAt: 1 }, { prunedAt: 2 }, { prunedAt: 3 }] };
    assert.equal(listTombstones(store, 2).length, 2);
    assert.equal(listTombstones(store, 2)[1].prunedAt, 3); // 取最近的两条
    assert.equal(listTombstones(null).length, 0);
    assert.equal(listTombstones(store, 0).length, 0);
});

test('initialSalience：负面保底 —— value<0 时显著度不低于下限', () => {
    // 弱负面被抬到下限 0.5（不因「不好」被更快遗忘）
    assert.equal(initialSalience(-0.1), 0.5);
    assert.equal(initialSalience(-0.01), 0.5);
    // 强负面本身已高于下限，不受影响
    assert.equal(initialSalience(-1), 0.8);
    assert.ok(Math.abs(initialSalience(-0.5) - 0.55) < 1e-9);
    // 非负条目不受保底影响
    assert.equal(initialSalience(0), 0.3);
});

test('applyForgetting：碎片配额 —— 同话题多条被删时至少保留 1 条最低的碎片', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(400, { topicId: 'T1', salience: 0.3 }),
            mem(400, { topicId: 'T1', salience: 0.5 }),
            mem(400, { topicId: 'T1', salience: 0.7 })
        ]
    };
    const r = applyForgetting(store, now);
    assert.equal(r.pruned, 2);
    assert.equal(store.memories.length, 1);
    assert.equal(store.memories[0].salience, 0.3); // 保留最低 retention 的那条碎片
});

test('applyForgetting：碎片配额设为 0 时该话题可被清空', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(400, { topicId: 'T1', salience: 0.3 }),
            mem(400, { topicId: 'T1', salience: 0.7 })
        ]
    };
    const r = applyForgetting(store, now, { fragmentQuota: 0 });
    assert.equal(r.pruned, 2);
    assert.equal(store.memories.length, 0);
});

test('applyForgetting：不同话题各自保底；无话题条目不享受配额', () => {
    const now = Date.now();
    const store = {
        memories: [
            mem(400, { topicId: 'T1', salience: 0.3 }),
            mem(400, { topicId: 'T1', salience: 0.7 }),
            mem(400, { topicId: 'T2', salience: 0.3 }),
            mem(400, { topicId: 'T2', salience: 0.7 }),
            mem(400) // 无话题：不受配额保护
        ]
    };
    const r = applyForgetting(store, now);
    assert.equal(r.pruned, 3);               // T1 删 1 + T2 删 1 + 无话题删 1
    assert.equal(store.memories.length, 2);  // 两个话题各留 1 条碎片
    assert.equal(store.memories.filter((m) => m.topicId === 'T1').length, 1);
    assert.equal(store.memories.filter((m) => m.topicId === 'T2').length, 1);
});
