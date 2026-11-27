'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');
const OutputModule = require('../src/core/output');

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

test('upsertSemanticMemory：默认落「巩固结论」，kind/confidence 为 null', () => {
    const mem = makeMemory({ 'u1__role': storeOf([]) });
    const saved = mem.upsertSemanticMemory('u1__role', '他最近在临摹那张画', { sourceIds: ['a', 'b'] });

    assert.ok(saved);
    assert.equal(saved.tier, 'semantic');
    assert.equal(saved.kind, null);
    assert.equal(saved.confidence, null);
    assert.deepEqual(saved.sourceMemoryIds, ['a', 'b']);
    assert.equal(mem.saveCalls, 1);
});

test('upsertSemanticMemory：kind=association 落联想条并带 confidence（非数字归一为 null）', () => {
    const mem = makeMemory({ 'u1__role': storeOf([]) });
    const saved = mem.upsertSemanticMemory('u1__role', '他发呆和看海好像是一回事', {
        sourceIds: ['a', 'b'],
        kind: 'association',
        confidence: 0.62
    });
    assert.equal(saved.kind, 'association');
    assert.equal(saved.confidence, 0.62);

    const bad = mem.upsertSemanticMemory('u1__role', '另一条联想', { kind: 'association', confidence: 'x' });
    assert.equal(bad.confidence, null);
});

test('非污染：语义注入池 / 自我模型素材都不含联想条', () => {
    const mem = makeMemory({ 'u1__role': storeOf([]) });
    mem.upsertSemanticMemory('u1__role', '他喜欢傍晚散步', { sourceIds: ['a'] });                       // 结论
    mem.upsertSemanticMemory('u1__role', '他发呆和看海好像是一回事', {
        sourceIds: ['a', 'b'], kind: 'association', confidence: 0.7
    });                                                                                                  // 联想

    // 联想条不进正式注入池，也不做自我模型素材
    assert.deepEqual(mem.getSemanticMemories('u1__role'), ['他喜欢傍晚散步']);
    assert.deepEqual(mem.getSemanticMemoryEntries('u1__role').map(entry => entry.data), ['他喜欢傍晚散步']);
});

test('getAssociationMemories：只取联想条，按 confidence 降序带溯源', () => {
    const mem = makeMemory({ 'u1__role': storeOf([]) });
    mem.upsertSemanticMemory('u1__role', '结论不该出现在联想池里', { sourceIds: ['x'] });
    const low = mem.upsertSemanticMemory('u1__role', '弱联想', {
        sourceIds: ['a'], kind: 'association', confidence: 0.4
    });
    const high = mem.upsertSemanticMemory('u1__role', '强联想', {
        sourceIds: ['b', 'c'], kind: 'association', confidence: 0.8
    });

    const list = mem.getAssociationMemories('u1__role');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, high.id);
    assert.equal(list[0].data, '强联想');
    assert.equal(list[0].confidence, 0.8);
    assert.deepEqual(list[0].sourceMemoryIds, ['b', 'c']);
    assert.equal(list[1].id, low.id);
});

test('rollbackConsolidation：可按 id 移除联想条，且不动源记忆', () => {
    const src = { id: 'a', data: '他今天很安静', salience: 0.6, tier: 'episodic' };
    const mem = makeMemory({ 'u1__role': storeOf([src]) });
    const assoc = mem.upsertSemanticMemory('u1__role', '安静和等待好像是一回事', {
        sourceIds: ['a'], kind: 'association', confidence: 0.5
    });

    const res = mem.rollbackConsolidation('u1__role', assoc.id);
    assert.deepEqual(res, { restored: 0, removed: true }); // 联想未占用源记忆 → restored=0
    assert.equal(mem.getAssociationMemories('u1__role').length, 0);
    // 源记忆完全未被触碰：未调 linkConsolidated，故未转 archived、无溯源
    assert.equal(src.tier, 'episodic');
    assert.equal(src.consolidatedInto, undefined);
});

// —— output.js：REM 提示词（纯方法，用原型对象即可调用） ——

const out = Object.create(OutputModule.prototype);

test('buildRemPrompt：带话题号与样本，空样本/空输入返回空串', () => {
    const prompt = out.buildRemPrompt({
        topicIds: ['T1', 'T2'],
        samples: [
            { id: 'a', topicId: 'T1', text: '他傍晚总在楼下站着' },
            { id: 'b', topicId: 'T2', text: '他说他不怕一个人' }
        ]
    });
    assert.match(prompt, /T1/);
    assert.match(prompt, /T2/);
    assert.match(prompt, /他傍晚总在楼下站着/);
    assert.match(prompt, /他说他不怕一个人/);
    assert.match(prompt, /不要编造事实/);

    assert.equal(out.buildRemPrompt({ topicIds: ['T1', 'T2'], samples: [] }), '');
    assert.equal(out.buildRemPrompt({ topicIds: ['T1', 'T2'], samples: [{ id: 'a', text: '   ' }] }), '');
    assert.equal(out.buildRemPrompt(null), '');
});

// —— A5：系统生成的摘要不计入滚动摘要计数 / 好感度 ——

// 造一个能跑 storeMemory 的裸实例，userMemories 里预置一个完整 store
function makeStoreMemoryModule() {
    const store = {
        memories: [],
        relationshipScore: 50,
        emotionHistory: [],
        summaryMemory: [],
        tombstones: [],
        lastSummaryTime: Date.now(),
        eventsSinceLastSummary: 0,
        address: {}
    };
    const mem = Object.create(MemoryModule.prototype);
    mem.userMemories = { 'u1__role': store };
    mem._dirtyKeys = new Set();
    mem._lastSweepAtByKey = new Map();
    mem.SWEEP_INTERVAL_MS = 10 * 60 * 1000;
    mem.SUMMARY_EVENT_THRESHOLD = 20;
    mem.SUMMARY_TIME_THRESHOLD = 3600000;
    mem.saveUserMemories = () => true;
    mem.assignTopicId = () => null;
    mem.maintainStore = () => ({ sweep: null, evicted: 0 });
    mem.queueVectorUpsert = () => {};
    mem.emotionIntensityOf = () => 0;
    return { mem, store };
}

test('A5：普通用户文本照常计入摘要计数与好感度', () => {
    const { mem, store } = makeStoreMemoryModule();
    mem.storeMemory({ value: 5, scene: '今天很开心' }, 'u1', '今天很开心');

    assert.equal(store.eventsSinceLastSummary, 1);
    assert.ok(store.relationshipScore > 50);
    assert.equal(store.memories.length, 1);
});

test('A5：系统生成的摘要（正文以【开头）仍入库，但不计计数/好感度、不参与聚类', () => {
    const { mem, store } = makeStoreMemoryModule();
    const before = store.relationshipScore;
    const text = '【早期对话摘要·滚动】这是系统生成的摘要正文';

    mem.storeMemory({ value: 0, scene: text }, 'u1', text);

    assert.equal(store.memories.length, 1);              // 照常入库（进衰减/遗忘链路）
    assert.equal(store.memories[0].topicId, undefined);  // 不参与话题聚类
    assert.equal(store.eventsSinceLastSummary, 0);       // 不抬高摘要触发计数
    assert.equal(store.relationshipScore, before);       // 不动好感度
});

test('A5：她自己的话（speaker=self）入库，但不计摘要计数/好感度', () => {
    const { mem, store } = makeStoreMemoryModule();
    const before = store.relationshipScore;

    mem.storeMemory({ value: 5, scene: '主动说' }, 'u1', '（你在 QQ 私聊里主动说）今天有点想你', {
        speaker: 'self',
        source: 'qq_proactive'
    });

    assert.equal(store.memories.length, 1);
    assert.equal(store.memories[0].speaker, 'self');
    assert.equal(store.memories[0].source, 'qq_proactive');
    assert.equal(store.eventsSinceLastSummary, 0); // 不算他发起的一轮互动
    assert.equal(store.relationshipScore, before);
});

test('A5：计数已过阈值时，系统摘要也不会触发再摘要', () => {
    const { mem, store } = makeStoreMemoryModule();
    store.eventsSinceLastSummary = 20; // 已达 SUMMARY_EVENT_THRESHOLD
    let generated = false;
    mem.generateSummaryMemory = () => { generated = true; };

    const text = '【早期对话摘要·滚动】又一份系统摘要';
    mem.storeMemory({ value: 0, scene: text }, 'u1', text);

    assert.equal(generated, false); // 系统摘要不该把自己喂成「够格再摘要」
});
