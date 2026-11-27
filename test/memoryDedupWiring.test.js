'use strict';

// G2 回归护栏（方向一② 主链接线）：确认「开关关 → 逐字节零 diff；开关开 → 仅目标分区允许 diff」。
// 用原型对象造记忆模块 / 输出模块，避开真实落盘；断言行为（结果集/落盘次数），非 spy。

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');
const OutputModule = require('../src/core/output');

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

// 造输出模块：只注入 runDedupMerge 所需字段（memoryModule + sessionManager.getPersonaScope）
function makeOutput(memoryModule, personaScope = 'role') {
    const om = Object.create(OutputModule.prototype);
    om.memoryModule = memoryModule;
    om.sessionManager = { getPersonaScope: () => personaScope };
    return om;
}

// 临时改 MEMORY_DEDUP_ENABLED 并在用例结束后还原，避免污染其它用例
function withDedupEnv(value, fn) {
    const prev = process.env.MEMORY_DEDUP_ENABLED;
    if (value === undefined) delete process.env.MEMORY_DEDUP_ENABLED;
    else process.env.MEMORY_DEDUP_ENABLED = value;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            if (prev === undefined) delete process.env.MEMORY_DEDUP_ENABLED;
            else process.env.MEMORY_DEDUP_ENABLED = prev;
        });
}

test('runDedupMerge：开关关 → 返回 null 且分区逐字节零 diff（G2 硬护栏）', async () => {
    const a = m('a', '一模一样的一句话内容', { salience: 0.9 });
    const b = m('b', '一模一样的一句话内容', { salience: 0.5 });
    const mem = makeMemory({ 'u1__role': storeOf([a, b]) });
    const om = makeOutput(mem);
    const baseline = JSON.stringify(mem.userMemories['u1__role'].memories);

    await withDedupEnv(undefined, async () => {
        const res = await om.runDedupMerge({ userId: 'u1' });
        assert.equal(res, null);
        assert.equal(mem.saveCalls, 0);
        assert.equal(JSON.stringify(mem.userMemories['u1__role'].memories), baseline);
    });
});

test('runDedupMerge：开关开 → 计划内合并，权重聚合、被并入条转 archived', async () => {
    const keep = m('keep', '一模一样的一句话内容', { salience: 0.9, recallCount: 3 });
    const gone = m('gone', '一模一样的一句话内容', { salience: 0.5, recallCount: 2 });
    const mem = makeMemory({ 'u1__role': storeOf([keep, gone]) });
    const om = makeOutput(mem);

    await withDedupEnv('enabled', async () => {
        const res = await om.runDedupMerge({ userId: 'u1' });
        assert.equal(res.planned, 1);
        assert.equal(res.applied, 1);
        assert.equal(res.skipped, 0);
        assert.equal(res.partition, 'u1__role');

        assert.equal(mem.saveCalls, 1);            // 一轮一次全量落盘
        assert.equal(keep.recallCount, 5);         // 求和
        assert.equal(keep.salience, 0.9);          // 取最大不降
        assert.deepEqual(keep.mergedIds, ['gone']);
        assert.equal(gone.tier, 'archived');
        assert.equal(gone.mergedInto, 'keep');
    });
});

test('runDedupMerge：开关开 → 仅目标分区 diff，非目标分区逐字节不变', async () => {
    const a1 = m('a1', '两个分区都出现的同一句话', { salience: 0.9 });
    const a2 = m('a2', '两个分区都出现的同一句话', { salience: 0.5 });
    const b1 = m('b1', '两个分区都出现的同一句话', { salience: 0.9 });
    const b2 = m('b2', '两个分区都出现的同一句话', { salience: 0.5 });
    const mem = makeMemory({
        'u1__role': storeOf([a1, a2]),
        'u2__role': storeOf([b1, b2])
    });
    const om = makeOutput(mem);
    const otherBaseline = JSON.stringify(mem.userMemories['u2__role'].memories);

    await withDedupEnv('enabled', async () => {
        await om.runDedupMerge({ userId: 'u1' });
        assert.equal(a2.tier, 'archived');
        assert.equal(a2.mergedInto, 'a1');
        assert.equal(JSON.stringify(mem.userMemories['u2__role'].memories), otherBaseline);
        assert.equal(b2.tier, 'episodic');
        assert.equal(b2.mergedInto, undefined);
    });
});

test('runDedupMerge：幂等——连续两次，第二次 planned=0 且不落盘', async () => {
    const keep = m('keep', '需要幂等的一句话', { salience: 0.9 });
    const gone = m('gone', '需要幂等的一句话', { salience: 0.4 });
    const mem = makeMemory({ 'u1__role': storeOf([keep, gone]) });
    const om = makeOutput(mem);

    await withDedupEnv('enabled', async () => {
        await om.runDedupMerge({ userId: 'u1' });
        assert.equal(mem.saveCalls, 1);

        const baseline = JSON.stringify(mem.userMemories['u1__role'].memories);
        const second = await om.runDedupMerge({ userId: 'u1' });
        assert.equal(second.planned, 0);
        assert.equal(mem.saveCalls, 1);            // 无变化不再落盘
        assert.equal(JSON.stringify(mem.userMemories['u1__role'].memories), baseline);
    });
});

test('runDedupMerge：①×② 交叉——pinned 豁免，unpin 后可合并', async () => {
    const pinned = m('pinned', '同一句话反复出现', { pinned: true, salience: 0.9 });
    const normal = m('normal', '同一句话反复出现', { salience: 0.6 });
    const mem = makeMemory({ 'u1__role': storeOf([pinned, normal]) });
    const om = makeOutput(mem);

    await withDedupEnv('enabled', async () => {
        // pinned 不参与，只剩 1 条候选 → 凑不成组，两边都不动
        const first = await om.runDedupMerge({ userId: 'u1' });
        assert.equal(first.planned, 0);
        assert.equal(pinned.tier, 'episodic');
        assert.equal(normal.tier, 'episodic');
        assert.equal(mem.saveCalls, 0);

        // 取消 pinned 后可成组，保留显著性更高者
        pinned.pinned = false;
        const second = await om.runDedupMerge({ userId: 'u1' });
        assert.equal(second.planned, 1);
        assert.equal(second.applied, 1);
        assert.equal(normal.tier, 'archived');
        assert.equal(normal.mergedInto, 'pinned');
        assert.equal(pinned.tier, 'episodic');
    });
});

test('runDedupMerge：返回形状含观测字段、不含 rollbackToken', async () => {
    const keep = m('keep', '看返回形状的一句话', { salience: 0.9 });
    const gone = m('gone', '看返回形状的一句话', { salience: 0.5 });
    const mem = makeMemory({ 'u1__role': storeOf([keep, gone]) });
    const om = makeOutput(mem);

    await withDedupEnv('enabled', async () => {
        const res = await om.runDedupMerge({ userId: 'u1' });
        for (const key of ['planned', 'applied', 'skipped', 'scanMs', 'applyMs', 'partition']) {
            assert.ok(Object.prototype.hasOwnProperty.call(res, key), `缺字段 ${key}`);
        }
        assert.equal(res.rollbackToken, undefined);
    });
});

test('runDedupMerge：无可合并条 → planned=0 且不落盘', async () => {
    const a = m('a', '今天和张三去了杭州西湖玩');
    const b = m('b', '昨天在家里看了一部电影');
    const mem = makeMemory({ 'u1__role': storeOf([a, b]) });
    const om = makeOutput(mem);
    const baseline = JSON.stringify(mem.userMemories['u1__role'].memories);

    await withDedupEnv('enabled', async () => {
        const res = await om.runDedupMerge({ userId: 'u1' });
        assert.equal(res.planned, 0);
        assert.equal(res.applied, 0);
        assert.equal(mem.saveCalls, 0);
        assert.equal(JSON.stringify(mem.userMemories['u1__role'].memories), baseline);
    });
});
