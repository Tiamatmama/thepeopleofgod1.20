'use strict';

// L1 工作记忆（短时记忆）契约测试。
// 依据：Cowan (2001) 容量约 4 个 chunk；Peterson & Peterson (1959) 无复述 ~18s 遗忘；
// Brown-Peterson 的遗忘主因是干扰而非单纯衰退；Craik & Lockhart (1972) 加工越深越耐久。
//
// 边界：本模块是纯逻辑，当前**未接入运行时**（表达层不持状态，状态归器官层），
// 只保留「入门排序」给 output.js 使用；类本身留给未来 CIDE GlobalWorkspace 复用。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    WorkingMemory,
    arrangePrimacyRecency,
    DEFAULT_CAPACITY,
    DEFAULT_TTL_TURNS
} = require('../src/core/workingMemory');
const OutputModule = require('../src/core/output');
const { orderMemoriesForPrompt } = OutputModule;

test('默认容量是 4 个块，默认存活 3 轮', () => {
    assert.equal(DEFAULT_CAPACITY, 4);
    assert.equal(DEFAULT_TTL_TURNS, 3);
});

test('提及即入槽，按权重降序排列', () => {
    const wm = new WorkingMemory();
    wm.mention('person:林', { kind: 'person', weight: 0.4 });
    wm.mention('topic:搬家', { kind: 'topic', weight: 0.8 });
    wm.mention('task:改代码', { kind: 'task', weight: 0.6 });

    assert.deepEqual(wm.slots().map(s => s.key), ['topic:搬家', 'task:改代码', 'person:林']);
    assert.equal(wm.slots()[0].mentions, 1);
});

test('同一 key 重复提及只续命，不新增块', () => {
    const wm = new WorkingMemory();
    wm.mention('person:林', { weight: 0.5 });
    wm.tick();
    wm.mention('person:林', { weight: 0.5 });

    const slots = wm.slots();
    assert.equal(slots.length, 1);
    assert.equal(slots[0].mentions, 2);
    assert.equal(slots[0].lastTurn, 1);
});

test('超过容量时淘汰最弱、最久未提及的块', () => {
    const wm = new WorkingMemory({ capacity: 2 });
    wm.mention('a', { weight: 0.9 });
    wm.tick();
    wm.mention('b', { weight: 0.1 });
    wm.tick();
    wm.mention('c', { weight: 0.5 });

    const keys = wm.slots().map(s => s.key);
    assert.deepEqual(keys.sort(), ['a', 'c']);
});

test('同权时淘汰更久未提及的块（LRU 兜底）', () => {
    const wm = new WorkingMemory({ capacity: 2 });
    wm.mention('old', { weight: 0.5 });
    wm.tick();
    wm.tick();
    wm.mention('new', { weight: 0.5 });
    wm.tick();
    wm.mention('newest', { weight: 0.5 });

    assert.deepEqual(wm.slots().map(s => s.key).sort(), ['new', 'newest']);
});

test('超过 TTL 轮未提及才淘汰，恰好 TTL 轮仍保留', () => {
    const wm = new WorkingMemory({ capacity: 8, ttlTurns: 3 });
    wm.mention('x', { weight: 0.5 });
    wm.tick();
    wm.tick();
    wm.tick();
    assert.equal(wm.slots().length, 1, '恰好 3 轮未提及应保留');

    wm.tick();
    assert.equal(wm.slots().length, 0, '第 4 轮应淘汰');
});

test('提及新话题会压低同类旧话题的权重（干扰而非纯衰减）', () => {
    const wm = new WorkingMemory({ capacity: 8, interferenceFactor: 0.5 });
    wm.mention('topic:工作', { kind: 'topic', tags: ['职场'], weight: 1 });
    wm.mention('topic:失业', { kind: 'topic', tags: ['职场'], weight: 1 });

    const byKey = new Map(wm.slots().map(s => [s.key, s]));
    assert.equal(byKey.get('topic:失业').weight, 1, '刚提及的不降权');
    assert.equal(byKey.get('topic:工作').weight, 0.5, '共享 tag 的旧话题降权');
});

test('不共享 tag 或不同类型不互相干扰', () => {
    const wm = new WorkingMemory({ capacity: 8, interferenceFactor: 0.5 });
    wm.mention('person:林', { kind: 'person', tags: ['职场'], weight: 1 });
    wm.mention('topic:工作', { kind: 'topic', tags: ['职场'], weight: 1 });

    const byKey = new Map(wm.slots().map(s => [s.key, s]));
    assert.equal(byKey.get('person:林').weight, 1, '人不是话题，不参与话题间干扰');
});

test('ordered() 按首因/近因排：最强在首、次强在尾', () => {
    const wm = new WorkingMemory({ capacity: 4 });
    wm.mention('a', { weight: 0.9 });
    wm.mention('b', { weight: 0.2 });
    wm.mention('c', { weight: 0.1 });
    wm.mention('d', { weight: 0.7 });

    assert.deepEqual(wm.ordered().map(s => s.key), ['a', 'c', 'b', 'd']);
});

test('容量与 TTL 可配置，边界值不抛错', () => {
    assert.doesNotThrow(() => new WorkingMemory({ capacity: 0 }).mention('x'));
    assert.doesNotThrow(() => new WorkingMemory({ capacity: -1 }).mention('x'));
    assert.doesNotThrow(() => new WorkingMemory({ ttlTurns: 0 }).tick());
    assert.doesNotThrow(() => new WorkingMemory().mention(''));
    assert.doesNotThrow(() => new WorkingMemory().mention(null));

    const wm = new WorkingMemory({ capacity: 1 });
    wm.mention('');
    assert.equal(wm.slots().length, 0, '空 key 不入槽');
});

test('clear() 清空所有块', () => {
    const wm = new WorkingMemory();
    wm.mention('a');
    wm.clear();
    assert.equal(wm.slots().length, 0);
});

// ---- 注入顺序（首因/近因）：只重排、不截断；条数由 memory 层的 limit + 配额决定 ----

const mem = (id) => ({ id, text: `记忆${id}` });

test('arrangePrimacyRecency：≤2 条原样返回，>2 条首强尾次强', () => {
    assert.deepEqual(arrangePrimacyRecency([1]), [1]);
    assert.deepEqual(arrangePrimacyRecency([1, 2]), [1, 2]);
    assert.deepEqual(arrangePrimacyRecency([1, 2, 3, 4]), [1, 4, 3, 2]);
    assert.deepEqual(arrangePrimacyRecency(null), []);
});

test('orderMemoriesForPrompt：数组只重排、不截断（5 进 5 出）', () => {
    const list = [mem('a'), mem('b'), mem('c'), mem('d'), mem('e')];
    const out = orderMemoriesForPrompt(list);
    assert.deepEqual(out.map(m => m.id), ['a', 'e', 'd', 'c', 'b']);
    assert.equal(out.length, 5);
});

test('orderMemoriesForPrompt：AI 态 role/ai 各自重排，其他字段原样保留', () => {
    const preloaded = {
        role: [mem('r1'), mem('r2'), mem('r3')],
        ai: [mem('a1'), mem('a2')],
        extra: '保留'
    };
    const out = orderMemoriesForPrompt(preloaded);
    assert.deepEqual(out.role.map(m => m.id), ['r1', 'r3', 'r2']);
    assert.deepEqual(out.ai.map(m => m.id), ['a1', 'a2']);
    assert.equal(out.extra, '保留');
    assert.equal(preloaded.role.length, 3, '不改动入参');
    assert.deepEqual(preloaded.role.map(m => m.id), ['r1', 'r2', 'r3']);
});

test('orderMemoriesForPrompt：null / 空对象原样返回', () => {
    assert.equal(orderMemoriesForPrompt(null), null);
    assert.equal(orderMemoriesForPrompt(undefined), undefined);
    const empty = {};
    assert.equal(orderMemoriesForPrompt(empty), empty);
});

// ---- 真实链路：orderMemoriesForPrompt → buildMemoryPrompt 的最终提示词行 ----

const fakeMemoryModule = {
    getSemanticMemories: () => [],
    getSelfTraits: () => [],
    getArchiveSummary: () => ''
};

test('buildMemoryPrompt：行序首强/尾次强，且带相对时间', () => {
    const om = Object.create(OutputModule.prototype);
    om.memoryModule = fakeMemoryModule;
    const now = Date.now();
    const records = [
        { id: 'a', text: '她喜欢下雨天', tier: 'episodic', ts: now - 86400000 },
        { id: 'b', text: '她在准备面试', tier: 'episodic', ts: now - 2 * 86400000 },
        { id: 'c', text: '她养了只猫', tier: 'episodic', ts: now - 5 * 86400000 }
    ];
    const prompt = om.buildMemoryPrompt('u', '下雨', orderMemoriesForPrompt(records));
    assert.match(prompt, /强相关的记忆/);
    const lines = prompt.split('\n').filter(line => line.startsWith('- '));
    assert.deepEqual(lines, [
        '- [1 天前] 她喜欢下雨天',
        '- [5 天前] 她养了只猫',
        '- [2 天前] 她在准备面试'
    ]);
});

test('buildMemoryPrompt：5 条召回全部注入（不写死上限）', () => {
    const om = Object.create(OutputModule.prototype);
    om.memoryModule = fakeMemoryModule;
    const records = [mem('a'), mem('b'), mem('c'), mem('d'), mem('e')]
        .map((item, index) => ({ ...item, ts: Date.now() - index * 86400000 }));
    const prompt = om.buildMemoryPrompt('u', '测试', orderMemoriesForPrompt(records));
    const lines = prompt.split('\n').filter(line => line.startsWith('- '));
    assert.equal(lines.length, 5);
});

test('buildMemoryPrompt：最近 32 条与强相关 5 条分区注入，5 条不占 32', () => {
    const recent = Array.from({ length: 32 }, (_, i) => ({
        id: `r${i}`,
        text: `最近的事 ${i}`,
        speaker: i % 2 === 0 ? 'user' : 'self',
        ts: Date.now() - i * 60000
    }));
    const strong = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        text: `强相关的事 ${i}`,
        speaker: 'user',
        ts: Date.now() - (i + 1) * 86400000
    }));
    const om = Object.create(OutputModule.prototype);
    om.memoryModule = {
        ...fakeMemoryModule,
        getRecentMemoryRecords: () => recent,
        getStrongMatchRecords: () => strong
    };

    const prompt = om.buildMemoryPrompt('u', '薄荷', strong);
    assert.match(prompt, /最近记得的事（最多 32 条）/);
    assert.match(prompt, /强相关的记忆（最多 5 条）/);
    assert.match(prompt, /（你说）/);
    const lines = prompt.split('\n').filter(line => line.startsWith('- '));
    assert.equal(lines.length, 37);
});

test('buildMemoryPrompt：AI 态把两档当同一个她，保留说话人标签', () => {
    const record = { id: 'a1', text: '她说过要一起去看海', speaker: 'self', ts: Date.now() };
    const other = { id: 'a2', text: '他说过周末要加班', speaker: 'user', ts: Date.now() - 1000 };
    const om = Object.create(OutputModule.prototype);
    om.memoryModule = {
        normalizeScopeKey: (id, scope) => `${id}__${scope}`,
        getStrongMatchRecords: () => [record, other],
        getRecentMemoryRecords: () => [record, other],
        getSemanticMemories: () => [],
        getSelfTraits: () => [],
        getArchiveSummary: () => ''
    };

    const prompt = om.buildMemoryPrompt('u', '看海', null, 'ai');
    assert.match(prompt, /角色态 \/ AI 态/);
    assert.match(prompt, /（你说）/);
    assert.match(prompt, /（他说）/);
    assert.doesNotMatch(prompt, /角色态记忆/);
});
