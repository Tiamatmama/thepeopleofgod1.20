'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEDUP_DEFAULTS,
    normalizeForDedup,
    polarityOf,
    isEligibleForMaintenance,
    planDedupMerge
} = require('../src/core/memoryConsolidation');
const MemoryModule = require('../src/core/memory');
const memoryLifecycle = require('../src/core/memoryLifecycle');

// 造一条情景记忆（默认已带话题号、显著性 0.6）
let seq = 0;
function m(id, data, extra = {}) {
    return {
        id,
        data,
        value: 0.4,
        salience: 0.6,
        recallCount: 0,
        tier: 'episodic',
        timestamp: 1000 + (++seq),
        topicId: 't1',
        ...extra
    };
}

// 写路径用例：用原型对象造一个只带被测方法所需字段的记忆模块，避开真实构造（会动盘）。
// saveUserMemories 打桩并计数——既不打盘，又能断言「有变化才落盘」。
function makeMemory(stores = {}) {
    const mem = Object.create(MemoryModule.prototype);
    mem.userMemories = stores;
    mem.saveCalls = 0;
    mem.saveUserMemories = () => { mem.saveCalls += 1; };
    return mem;
}

function storeOf(memories) {
    return { memories };
}

test('DEDUP_DEFAULTS：起步形态是 contentHash + exact + 极性硬门槛', () => {
    assert.equal(DEDUP_DEFAULTS.groupBy, 'contentHash');
    assert.equal(DEDUP_DEFAULTS.similarity, 'exact');
    assert.equal(DEDUP_DEFAULTS.polarityGuard, true);
});

test('normalizeForDedup / polarityOf：归一化口径与极性判定', () => {
    assert.equal(normalizeForDedup('Hello, World！'), normalizeForDedup('hello world'));
    assert.equal(normalizeForDedup('今天和张三去了杭州西湖玩。'), normalizeForDedup('今天和张三去了杭州西湖玩'));
    assert.equal(polarityOf({ value: 0.5 }), 'pos');
    assert.equal(polarityOf({ value: -0.5 }), 'neg');
    assert.equal(polarityOf({ value: 0 }), 'neu');
    assert.equal(polarityOf({}), 'neu');
});

test('isEligibleForMaintenance：排除 pinned / 非情景 / 系统条目 / 已巩固', () => {
    assert.equal(isEligibleForMaintenance(m('a', '今天和张三去了杭州西湖玩')), true);
    assert.equal(isEligibleForMaintenance(m('b', '今天和张三去了杭州西湖玩', { pinned: true })), false);
    assert.equal(isEligibleForMaintenance(m('c', '今天和张三去了杭州西湖玩', { tier: 'semantic' })), false);
    assert.equal(isEligibleForMaintenance(m('d', '【早期对话摘要·滚动】一些系统内容')), false);
    assert.equal(isEligibleForMaintenance(m('e', '今天和张三去了杭州西湖玩', { consolidatedInto: 'x' })), false);
    assert.equal(isEligibleForMaintenance(null), false);
});

test('planDedupMerge：归一化后完全相同成组，保留显著性最高的一条', () => {
    const a = m('a', '今天和张三去了杭州西湖玩。', { salience: 0.5 }); // 多一个句号
    const b = m('b', '今天和张三去了杭州西湖玩', { salience: 0.8 });
    const groups = planDedupMerge([a, b]);

    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.equal(g.size, 2);
    assert.equal(g.keepId, 'b');                 // 0.8 > 0.5
    assert.deepEqual(g.mergeIds, ['a']);
    assert.deepEqual(g.sourceMemoryIds.sort(), ['a', 'b']); // 可反查/回滚
    assert.equal(g.avgSimilarity, 1);            // exact → 恒为 1
    assert.equal(g.samples.length, 2);
});

test('planDedupMerge：仅标点/空白/大小写不同也算重复（归一化口径）', () => {
    const a = m('a', 'Hello World');
    const b = m('b', 'hello, world!');
    assert.equal(planDedupMerge([a, b]).length, 1);
});

test('planDedupMerge：正文不同则不成组（exact 保守，零误合）', () => {
    const a = m('a', '今天和张三去了杭州西湖玩');
    const b = m('b', '昨天在家里看了一部电影');
    assert.deepEqual(planDedupMerge([a, b]), []);
});

test('planDedupMerge：极性相反不合（情绪硬门槛）；同极性才合', () => {
    const pos = m('a', '这家餐厅的菜真的很好吃', { value: 0.8 });
    const neg = m('b', '这家餐厅的菜真的很好吃', { value: -0.8 });
    assert.deepEqual(planDedupMerge([pos, neg]), []);

    const pos2 = m('c', '这家餐厅的菜真的很好吃', { value: 0.5 });
    assert.equal(planDedupMerge([pos, pos2]).length, 1);
});

test('planDedupMerge：跨归属不合（userId / storeKey 不同即分桶）', () => {
    const a = m('a', '同一条正文内容', { userId: 'u1' });
    const b = m('b', '同一条正文内容', { userId: 'u2' });
    assert.deepEqual(planDedupMerge([a, b]), []);

    // 单档内调用：显式 storeKey 相同才成组
    const c = m('c', '同一句话反复出现');
    const d = m('d', '同一句话反复出现');
    assert.equal(planDedupMerge([c, d], null, { storeKey: 's1' }).length, 1);
});

test('planDedupMerge：显著性 > 时间 > id 的 tie-break 写死可复现', () => {
    const older = m('old', '完全相同的一句话内容', { salience: 0.6, timestamp: 100 });
    const newer = m('new', '完全相同的一句话内容', { salience: 0.6, timestamp: 200 });
    assert.equal(planDedupMerge([older, newer])[0].keepId, 'new'); // 时间新者留

    const lowId = m('a1', '另外一段完全相同的话', { salience: 0.6, timestamp: 500 });
    const highId = m('b2', '另外一段完全相同的话', { salience: 0.6, timestamp: 500 });
    assert.equal(planDedupMerge([highId, lowId])[0].keepId, 'a1'); // id 升序留小
});

test('planDedupMerge：合并权重——recallCount 求和、salience 取最大不降', () => {
    const a = m('a', '一模一样的一段话啊', { salience: 0.5, recallCount: 2 });
    const b = m('b', '一模一样的一段话啊', { salience: 0.9, recallCount: 3 });
    const g = planDedupMerge([a, b])[0];
    assert.equal(g.mergedWeight.recallCount, 5);
    assert.equal(g.mergedWeight.salience, 0.9);
});

test('planDedupMerge：pinned 记忆不参与合并（含它只剩单条则不成组）', () => {
    const a = m('a', '和上面一样的正文内容', { pinned: true });
    const b = m('b', '和上面一样的正文内容');
    assert.deepEqual(planDedupMerge([a, b]), []);

    // 取消 pinned 后又能成组
    a.pinned = false;
    assert.equal(planDedupMerge([a, b]).length, 1);
});

test('planDedupMerge：输入不被改动（dry-run 只读）', () => {
    const a = m('a', '今天和张三去了杭州西湖玩');
    const b = m('b', '今天和张三去了杭州西湖玩');
    const snapshot = JSON.stringify([a, b]);
    planDedupMerge([a, b]);
    assert.equal(JSON.stringify([a, b]), snapshot);
});

test('planDedupMerge：maxGroups 截断，且按组大小降序', () => {
    // 3 组互不相同的正文，每组各 2 条完全相同
    const memories = [];
    for (const tag of ['第一组', '第二组', '第三组']) {
        memories.push(m(`${tag}-1`, `${tag}的完全相同正文内容`, { salience: 0.5 }));
        memories.push(m(`${tag}-2`, `${tag}的完全相同正文内容`, { salience: 0.9 }));
    }
    const capped = planDedupMerge(memories, null, { maxGroups: 2 });
    assert.equal(capped.length, 2);
    assert.ok(capped[0].size >= capped[1].size);
});

test('planDedupMerge：fuzzy 形态（groupBy=topicId）按相似度成组', () => {
    const a = m('a', '今天和张三去了杭州西湖玩', { topicId: 't1', salience: 0.5 });
    const b = m('b', '今天和张三去杭州西湖玩了', { topicId: 't1', salience: 0.8 });
    const groups = planDedupMerge([a, b], null, { groupBy: 'topicId', similarity: 'fuzzy' });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].keepId, 'b');
    assert.ok(groups[0].avgSimilarity > 0);
});

test('planDedupMerge：fuzzy 形态下无话题号的不参与、跨话题不合', () => {
    const c = m('c', '今天和张三去了杭州西湖玩', { topicId: undefined });
    const d = m('d', '今天和张三去杭州西湖玩了', { topicId: undefined });
    assert.deepEqual(planDedupMerge([c, d], null, { groupBy: 'topicId', similarity: 'fuzzy' }), []);

    const e = m('e', '今天和张三去了杭州西湖玩', { topicId: 't1' });
    const f = m('f', '今天和张三去杭州西湖玩了', { topicId: 't2' });
    assert.deepEqual(planDedupMerge([e, f], null, { groupBy: 'topicId', similarity: 'fuzzy' }), []);
});

// —— 以下为写路径（applyDedupMerge / rollbackDedupMerge）用例 ——

test('applyDedupMerge：保留条聚合权重，被并入条转 archived 并留溯源', () => {
    const keep = m('keep', '一模一样的一段话啊', { salience: 0.9, recallCount: 3, lastRecallAt: 200 });
    const gone = m('gone', '一模一样的一段话啊', { salience: 0.5, recallCount: 2, lastRecallAt: 900 });
    const mem = makeMemory({ 'u1__role': storeOf([keep, gone]) });

    const groups = planDedupMerge([keep, gone], null, { storeKey: 'u1__role' });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].keepId, 'keep');

    const res = mem.applyDedupMerge('u1__role', groups);
    assert.deepEqual(res, { groups: 1, merged: 1 });
    assert.equal(mem.saveCalls, 1); // 有变化才落盘一次

    // 保留条：recallCount 求和、salience 取最大不降、lastRecallAt 取最新
    assert.equal(keep.recallCount, 5);
    assert.equal(keep.salience, 0.9);
    assert.equal(keep.lastRecallAt, 900);
    assert.deepEqual(keep.mergedIds, ['gone']);
    assert.equal(keep.mergedRecallCount, 2);        // 回滚快照：记录被聚合进来的量
    assert.equal(keep.mergedSalienceBefore, 0.9);   // 回滚快照：合并前的自身显著性

    // 被并入条：转归档、留溯源、salience 减半（退出召回池但可回滚）
    assert.equal(gone.tier, 'archived');
    assert.equal(gone.mergedInto, 'keep');
    assert.equal(gone.salience, memoryLifecycle.clamp01(0.5 * 0.5));
});

test('applyDedupMerge：重复执行幂等——已归档的条不再进组、无变化不落盘', () => {
    const keep = m('keep', '另一句完全相同的话', { salience: 0.9 });
    const gone = m('gone', '另一句完全相同的话', { salience: 0.4 });
    const mem = makeMemory({ 'u1__role': storeOf([keep, gone]) });

    mem.applyDedupMerge('u1__role', planDedupMerge([keep, gone], null, { storeKey: 'u1__role' }));
    assert.equal(gone.tier, 'archived');

    // 再跑计划：已归档条不再是维护候选 → 无组；再 apply 无变化 → 不落盘
    const again = planDedupMerge([keep, gone], null, { storeKey: 'u1__role' });
    assert.deepEqual(again, []);
    mem.saveCalls = 0;
    assert.deepEqual(mem.applyDedupMerge('u1__role', again), { groups: 0, merged: 0 });
    assert.equal(mem.saveCalls, 0);
});

test('applyDedupMerge：pinned 与系统条目不在计划内，绝不被触碰', () => {
    const pinned = m('pinned', '同一句话反复出现', { pinned: true, salience: 0.9 });
    const normal = m('normal', '同一句话反复出现', { salience: 0.6 });
    const sys = m('sys', '【早期对话摘要·滚动】同一句话反复出现', { salience: 0.6 });
    const mem = makeMemory({ 'u1__role': storeOf([pinned, normal, sys]) });

    // pinned 不参与、系统条被排除 → 只剩 1 条可维护候选，凑不成组
    const groups = planDedupMerge([pinned, normal, sys], null, { storeKey: 'u1__role' });
    assert.deepEqual(groups, []);

    mem.applyDedupMerge('u1__role', groups);
    assert.equal(pinned.tier, 'episodic');
    assert.equal(pinned.mergedInto, undefined);
    assert.equal(sys.tier, 'episodic');
    assert.equal(sys.mergedInto, undefined);
});

test('rollbackDedupMerge：精确还原——被并入条回 episodic，保留条权重扣回', () => {
    const keep = m('keep', '需要可回滚的一句话', { salience: 0.9, recallCount: 3 });
    const gone = m('gone', '需要可回滚的一句话', { salience: 0.5, recallCount: 2 });
    const mem = makeMemory({ 'u1__role': storeOf([keep, gone]) });

    mem.applyDedupMerge('u1__role', planDedupMerge([keep, gone], null, { storeKey: 'u1__role' }));
    assert.equal(keep.recallCount, 5);

    const res = mem.rollbackDedupMerge('u1__role', 'keep');
    assert.deepEqual(res, { restored: 1, kept: true });

    // 被并入条复原：清溯源、回 episodic、salience 还原
    assert.equal(gone.mergedInto, null);
    assert.equal(gone.tier, 'episodic');
    assert.equal(gone.salience, 0.5);

    // 保留条扣回：recallCount 减掉汇总量、salience 还原、快照清空
    assert.equal(keep.recallCount, 3);
    assert.equal(keep.salience, 0.9);
    assert.deepEqual(keep.mergedIds, []);
    assert.equal(keep.mergedRecallCount, null);
    assert.equal(keep.mergedSalienceBefore, null);

    // 非目标再回滚：无副作用、也不再落盘
    mem.saveCalls = 0;
    assert.deepEqual(mem.rollbackDedupMerge('u1__role', 'keep'), { restored: 0, kept: true });
    assert.equal(mem.saveCalls, 0);
});

test('applyDedupMerge：只改目标分区，不串其它分区', () => {
    const a1 = m('a1', '两个分区都出现的同一句话', { salience: 0.9 });
    const a2 = m('a2', '两个分区都出现的同一句话', { salience: 0.5 });
    const b1 = m('b1', '两个分区都出现的同一句话', { salience: 0.9 });
    const b2 = m('b2', '两个分区都出现的同一句话', { salience: 0.5 });
    const mem = makeMemory({
        'u1__role': storeOf([a1, a2]),
        'u2__role': storeOf([b1, b2])
    });

    mem.applyDedupMerge('u1__role', planDedupMerge([a1, a2], null, { storeKey: 'u1__role' }));

    assert.equal(a2.tier, 'archived');
    assert.equal(a2.mergedInto, 'a1'); // a1 显著性更高，为保留条
    // u2 分区完全没动
    assert.equal(b1.tier, 'episodic');
    assert.equal(b2.tier, 'episodic');
    assert.equal(b2.mergedInto, undefined);
});
