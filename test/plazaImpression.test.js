'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ImpressionStore, MAX_NOTES_PER_SUBJECT } = require('../src/core/plazaImpression');

// 群聊印象影子层：验证三件事——
//   1. 印象确实按「观察者 → 对象」分开存，不会串味
//   2. 有上限、有去重，闲聊不会把磁盘撑爆
//   3. 边界干净：不 require 任何记忆模块、不出现 user_memories，影子层物理上进不了正式记忆

function freshStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaza-impr-'));
    return { dir, store: new ImpressionStore({ dir }) };
}

const A = 'session_a';
const B = 'session_b';
const C = 'session_c';

test('observe / recall：A 对 B 的印象能被 A 取回', () => {
    const { store } = freshStore();
    store.observe({ observer: A, subject: B, subjectName: '小雨', text: '我今天好累啊' });
    const notes = store.recall(A, B);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, '我今天好累啊');
    // B 那边不该有这条
    assert.deepEqual(store.recall(B, A), []);
});

test('observe：自己说自己不记，空文本不记', () => {
    const { store } = freshStore();
    assert.equal(store.observe({ observer: A, subject: A, text: '自言自语' }), null);
    assert.equal(store.observe({ observer: A, subject: B, text: '   ' }), null);
});

test('observe：复述/重复不产生新印象', () => {
    const { store } = freshStore();
    store.observe({ observer: A, subject: B, text: '今天天气真好' });
    store.observe({ observer: A, subject: B, text: '今天天气真好。' });
    assert.equal(store.recall(A, B, 10).length, 1);
});

test('observe：单对象印象条数封顶', () => {
    const { store } = freshStore();
    for (let i = 0; i < MAX_NOTES_PER_SUBJECT + 8; i++) {
        store.observe({ observer: A, subject: B, text: `第${i}句不同的话` });
    }
    const notes = store.recall(A, B, 999);
    assert.equal(notes.length, MAX_NOTES_PER_SUBJECT);
    // 保留的是最近的
    assert.ok(notes[notes.length - 1].text.includes(String(MAX_NOTES_PER_SUBJECT + 7)));
});

test('renderForPrompt：只渲染在场其他人，且排除自己', () => {
    const { store } = freshStore();
    store.observe({ observer: A, subject: B, subjectName: '小雨', text: '我昨天去看海了' });
    store.observe({ observer: A, subject: C, subjectName: '阿岚', text: '帮我拿一下伞' });
    const text = store.renderForPrompt(A, [
        { sessionId: A, name: '我' },
        { sessionId: B, name: '小雨' },
        { sessionId: C, name: '阿岚' }
    ]);
    assert.ok(text.includes('小雨'));
    assert.ok(text.includes('阿岚'));
    assert.ok(!text.includes('我：'));
    // 不在场的人不出现
    const only = store.renderForPrompt(A, [{ sessionId: B, name: '小雨' }]);
    assert.ok(only.includes('小雨'));
    assert.ok(!only.includes('阿岚'));
});

test('renderForPrompt：没有印象时返回空串，不制造空段', () => {
    const { store } = freshStore();
    assert.equal(store.renderForPrompt(A, [{ sessionId: B, name: '小雨' }]), '');
});

test('clearRoom：清空后所有人印象归零', () => {
    const { store, dir } = freshStore();
    store.observe({ observer: A, subject: B, text: '一句话' });
    store.observe({ observer: B, subject: A, text: '另一句话' });
    store.clearRoom();
    assert.deepEqual(store.recall(A, B), []);
    assert.deepEqual(store.recall(B, A), []);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), []);
});

test('哲学回归：影子层不依赖记忆中枢，也不写正式记忆', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/core/plazaImpression.js'), 'utf8');
    // 注释里可以解释边界，只对真实代码断言
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/require\(['"]\.\/memory/.test(code), '不得 require 记忆模块');
    assert.ok(!/require\(['"]\.\/emotion/.test(code), '不得 require 情绪模块');
    assert.ok(!/user_memories/.test(code), '不得触碰 user_memories');
    assert.ok(!/memoryModule|addMemory|saveMemory/.test(code), '不得调用记忆写入接口');
});
