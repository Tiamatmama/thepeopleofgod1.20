'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');
const { ToolRegistry, TOOL_DEFINITIONS } = require('../src/core/toolRegistry');

// 用原型对象造一个「只带被测定方法所需字段」的记忆模块，避免构造 MemoryModule 时
// 读写真实 data/ 目录（migrateScopeFiles 会动盘）。saveUserMemories 打桩，测试不打盘。
function makeMemory(stores = {}) {
    const mem = Object.create(MemoryModule.prototype);
    mem.userMemories = stores;
    mem.saveUserMemories = () => true;
    return mem;
}

function storeOf(memories) {
    return { memories };
}

// 同上：造一个只够 pinMemory 跑的 ToolRegistry（不触发重构造）
function makeRegistry(memory, context = { userId: 'u1', scope: 'role', sessionId: 's1' }) {
    const reg = Object.create(ToolRegistry.prototype);
    reg.memory = memory;
    reg.activeContext = context;
    return reg;
}

test('findMemoriesByKeyword：字面匹配按时间倒序，排除系统摘要（【开头）', () => {
    const mem = makeMemory({
        'u1__role': storeOf([
            { id: 'a', data: '用户喜欢喝黑咖啡', timestamp: 100 },
            { id: 'b', data: '用户说咖啡要少糖', timestamp: 200 },
            { id: 'c', data: '【早期对话摘要·滚动】也提到咖啡', timestamp: 300 },
            { id: 'd', data: '用户养了只猫叫团子', timestamp: 400, pinned: true }
        ])
    });
    const hits = mem.findMemoriesByKeyword('u1', '咖啡');
    assert.deepEqual(hits.map((h) => h.id), ['b', 'a']);   // 摘要 c 被排除，按时间倒序
    assert.equal(mem.findMemoriesByKeyword('u1', '咖啡', 1).length, 1);
    assert.deepEqual(mem.findMemoriesByKeyword('u1', ''), []);
    assert.deepEqual(mem.findMemoriesByKeyword('u1', '不存在'), []);
});

test('findMemoriesByKeyword：只读当前分区（role / ai 互不串味）', () => {
    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'r1', data: '角色态记忆里提到咖啡', timestamp: 1 }]),
        'u1__ai': storeOf([{ id: 'a1', data: 'AI 态记忆里提到咖啡', timestamp: 2 }])
    });
    assert.deepEqual(mem.findMemoriesByKeyword('u1', '咖啡').map((h) => h.id), ['r1']);
    assert.deepEqual(mem.findMemoriesByKeyword('u1__ai', '咖啡').map((h) => h.id), ['a1']);
});

test('getMemoryById / setMemoryPinned：按 id 读取与钉住，越界返回 null / false', () => {
    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '原话', timestamp: 1, pinned: false }])
    });
    assert.equal(mem.getMemoryById('u1', 'zzz'), null);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, false);
    assert.equal(mem.setMemoryPinned('u1', 'zzz', true), false);
    assert.equal(mem.setMemoryPinned('u1', 'a', true), true);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, true);
});

test('pinMemory：关键词唯一命中就当场钉住并回可转述确认语', () => {
    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '用户喜欢喝黑咖啡', timestamp: 100, pinned: false }])
    });
    const res = makeRegistry(mem).pinMemory({ query: '黑咖啡' });
    assert.equal(res.success, true);
    assert.equal(res.pinned, true);
    assert.equal(res.memoryId, 'a');
    assert.match(res.message, /黑咖啡/);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, true);   // 真的落了动作
});

test('pinMemory：多条命中不擅自钉，只回候选让模型再挑', () => {
    const mem = makeMemory({
        'u1__role': storeOf([
            { id: 'a', data: '用户喜欢喝黑咖啡', timestamp: 100, pinned: false },
            { id: 'b', data: '用户说咖啡要少糖', timestamp: 200, pinned: false }
        ])
    });
    const res = makeRegistry(mem).pinMemory({ query: '咖啡' });
    assert.equal(res.success, true);
    assert.equal(res.pinned, false);
    assert.equal(res.needChoice, true);
    assert.equal(res.candidates.length, 2);
    // 没有任何一条被真正钉住
    assert.equal(mem.getMemoryById('u1', 'a').pinned, false);
    assert.equal(mem.getMemoryById('u1', 'b').pinned, false);
});

test('pinMemory：带 memoryId 直接钉指定那条；越界编号被拒', () => {
    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '原话A', timestamp: 1, pinned: false }]),
        'u2__role': storeOf([{ id: 'x', data: '别人的记忆', timestamp: 1, pinned: false }])
    });
    const reg = makeRegistry(mem);   // 当前用户 u1
    const ok = reg.pinMemory({ query: '原话', memoryId: 'a' });
    assert.equal(ok.pinned, true);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, true);
    // 拿别人分区里的 id 来钉 → 只认当前用户/分区，找不到即拒绝
    const bad = reg.pinMemory({ query: '记忆', memoryId: 'x' });
    assert.equal(bad.success, false);
    assert.equal(mem.getMemoryById('u2', 'x').pinned, false);
});

test('pinMemory：找不到 / 缺参 / 未注入 / 无上下文 一律失败', () => {
    const mem = makeMemory({ 'u1__role': storeOf([]) });
    const reg = makeRegistry(mem);
    assert.equal(reg.pinMemory({ query: '不存在' }).success, false);
    assert.equal(reg.pinMemory({}).success, false);

    const noMem = makeRegistry(null);
    assert.equal(noMem.pinMemory({ query: 'x' }).success, false);

    const noCtx = Object.create(ToolRegistry.prototype);
    noCtx.memory = mem;
    noCtx.activeContext = null;
    assert.equal(noCtx.pinMemory({ query: 'x' }).success, false);
});

test('pin_memory：已注册进工具清单且 query 必填；execute 能分发到 pinMemory', async () => {
    const def = TOOL_DEFINITIONS.find((item) => item.function.name === 'pin_memory');
    assert.ok(def);
    assert.deepEqual(def.function.parameters.required, ['query']);

    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '唯一的黑咖啡记忆', timestamp: 1, pinned: false }])
    });
    const reg = makeRegistry(mem);
    reg.enabled = true;
    const out = await reg.execute('pin_memory', { query: '黑咖啡' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.pinned, true);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, true);
});

test('unpinMemory：关键词唯一命中就当场解钉并回可转述确认语', () => {
    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '用户喜欢喝黑咖啡', timestamp: 100, pinned: true }])
    });
    const res = makeRegistry(mem).unpinMemory({ query: '黑咖啡' });
    assert.equal(res.success, true);
    assert.equal(res.pinned, false);
    assert.equal(res.memoryId, 'a');
    assert.match(res.message, /黑咖啡/);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, false);   // 真的落了动作
});

test('unpinMemory：本来就没钉住 → 明确告知，不误报成功解钉', () => {
    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '用户喜欢喝黑咖啡', timestamp: 100, pinned: false }])
    });
    const res = makeRegistry(mem).unpinMemory({ query: '黑咖啡' });
    assert.equal(res.success, true);
    assert.equal(res.pinned, false);
    assert.match(res.message, /本来就没有被钉住/);
});

test('unpinMemory：多条命中不擅自解，只回候选；带 memoryId 直接解指定那条；越界被拒', () => {
    const mem = makeMemory({
        'u1__role': storeOf([
            { id: 'a', data: '用户喜欢喝黑咖啡', timestamp: 100, pinned: true },
            { id: 'b', data: '用户说咖啡要少糖', timestamp: 200, pinned: true }
        ]),
        'u2__role': storeOf([{ id: 'x', data: '别人的记忆', timestamp: 1, pinned: true }])
    });
    const reg = makeRegistry(mem);   // 当前用户 u1
    const multi = reg.unpinMemory({ query: '咖啡' });
    assert.equal(multi.needChoice, true);
    assert.equal(multi.candidates.length, 2);
    // 没有任何一条被真正解钉
    assert.equal(mem.getMemoryById('u1', 'a').pinned, true);
    assert.equal(mem.getMemoryById('u1', 'b').pinned, true);

    const ok = reg.unpinMemory({ query: '黑咖啡', memoryId: 'a' });
    assert.equal(ok.pinned, false);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, false);
    // 拿别人分区里的 id 来解 → 只认当前用户/分区，找不到即拒绝
    const bad = reg.unpinMemory({ query: '记忆', memoryId: 'x' });
    assert.equal(bad.success, false);
    assert.equal(mem.getMemoryById('u2', 'x').pinned, true);
});

test('unpinMemory：找不到 / 缺参 / 未注入 / 无上下文 一律失败', () => {
    const mem = makeMemory({ 'u1__role': storeOf([]) });
    const reg = makeRegistry(mem);
    assert.equal(reg.unpinMemory({ query: '不存在' }).success, false);
    assert.equal(reg.unpinMemory({}).success, false);

    const noMem = makeRegistry(null);
    assert.equal(noMem.unpinMemory({ query: 'x' }).success, false);

    const noCtx = Object.create(ToolRegistry.prototype);
    noCtx.memory = mem;
    noCtx.activeContext = null;
    assert.equal(noCtx.unpinMemory({ query: 'x' }).success, false);
});

test('unpin_memory：已注册进工具清单且 query 必填；execute 能分发到 unpinMemory', async () => {
    const def = TOOL_DEFINITIONS.find((item) => item.function.name === 'unpin_memory');
    assert.ok(def);
    assert.deepEqual(def.function.parameters.required, ['query']);

    const mem = makeMemory({
        'u1__role': storeOf([{ id: 'a', data: '唯一的黑咖啡记忆', timestamp: 1, pinned: true }])
    });
    const reg = makeRegistry(mem);
    reg.enabled = true;
    const out = await reg.execute('unpin_memory', { query: '黑咖啡' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.pinned, false);
    assert.equal(mem.getMemoryById('u1', 'a').pinned, false);
});
