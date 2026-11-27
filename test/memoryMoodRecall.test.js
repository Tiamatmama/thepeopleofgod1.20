'use strict';

// 🫀 自发回忆（memory.recallByMood）护栏：
// 与「按查询召回」是两条通道——线索是当前情绪，不是用户那句话。
// 这里全部用内存对象 + 注入时钟，零落盘、零网络。

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function m(id, data, extra = {}) {
    return {
        id,
        data,
        value: 0.4,
        salience: 0.6,
        recallCount: 0,
        tier: 'episodic',
        timestamp: NOW - 20 * DAY,
        topicId: id,
        emotion: { type: 'sad', intensity: 0.8 },
        ...extra
    };
}

function makeMemory(memories) {
    const mem = Object.create(MemoryModule.prototype);
    mem.userMemories = { 'u__role': { memories } };
    // 强化只改内存对象，不安排节流落盘（测试进程不写盘）
    mem.markDirty = () => {};
    mem._dirtyKeys = new Set();
    return mem;
}

test('M1：情绪够强且有同情绪的旧事时，会自己浮出来', () => {
    const mem = makeMemory([m('a1', '那天在海边她说起小时候的事，眼睛有点红')]);
    const out = mem.recallByMood('u', { now: NOW, emotion: 'sad', intensity: 0.9 });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '那天在海边她说起小时候的事，眼睛有点红');
    // 返回的是召回记录形状，注入层可直接复用
    assert.ok(out[0].id && out[0].ts && out[0].tier === 'episodic');
});

test('M2：情绪强度不够时不触发', () => {
    const mem = makeMemory([m('a1', '那天在海边她说起小时候的事')]);
    assert.deepEqual(mem.recallByMood('u', { now: NOW, emotion: 'sad', intensity: 0.3 }), []);
});

test('M3：刚发生过的事不算「想起来」', () => {
    const mem = makeMemory([m('a1', '刚吵完架她一个人坐在楼梯口', { timestamp: NOW - 60 * 60 * 1000 })]);
    assert.deepEqual(mem.recallByMood('u', { now: NOW, emotion: 'sad', intensity: 0.9 }), []);
});

test('M4：情绪对不上时不触发（happy 勾不出 sad 的旧事）', () => {
    const mem = makeMemory([m('a1', '那天在海边她说起小时候的事')]);
    assert.deepEqual(mem.recallByMood('u', { now: NOW, emotion: 'happy', intensity: 0.9 }), []);
});

test('M5：同一会话同一情绪有冷却，不会每轮都想起来', () => {
    const mem = makeMemory([
        m('a1', '那天在海边她说起小时候的事'),
        m('a2', '雨夜里她把伞让给了流浪猫，自己淋着回来')
    ]);
    const first = mem.recallByMood('u', { now: NOW, sessionKey: 's1', emotion: 'sad', intensity: 0.9 });
    assert.equal(first.length, 1);
    const second = mem.recallByMood('u', { now: NOW + 60 * 1000, sessionKey: 's1', emotion: 'sad', intensity: 0.9 });
    assert.deepEqual(second, []);
});

test('M6：冷却过后，刚浮过的那条进不应期，宁可不想起也不重复', () => {
    const mem = makeMemory([m('a1', '那天在海边她说起小时候的事')]);
    assert.equal(mem.recallByMood('u', { now: NOW, sessionKey: 's1', emotion: 'sad', intensity: 0.9 }).length, 1);
    const later = mem.recallByMood('u', { now: NOW + 60 * 60 * 1000, sessionKey: 's1', emotion: 'sad', intensity: 0.9 });
    assert.deepEqual(later, []);
});

test('M7：快层没劲时，慢层底色也能把旧事勾上来', () => {
    const mem = makeMemory([m('a1', '那天在海边她说起小时候的事')]);
    const out = mem.recallByMood('u', {
        now: NOW,
        emotion: 'calm',
        intensity: 0.2,
        slowMood: { type: 'sad', intensity: 0.7 }
    });
    assert.equal(out.length, 1);
});

test('M8：calm 只当背景，不做出引子的情绪', () => {
    const mem = makeMemory([
        m('c1', '下午一起把阳台的花浇了，没什么特别的', { emotion: { type: 'calm', intensity: 0.6 } })
    ]);
    assert.deepEqual(mem.recallByMood('u', { now: NOW, emotion: 'calm', intensity: 0.9 }), []);
    assert.deepEqual(mem.recallByMood('u', {
        now: NOW,
        sessionKey: 's2',
        emotion: 'calm',
        intensity: 0.3,
        slowMood: { type: 'calm', intensity: 0.8 }
    }), []);
});
