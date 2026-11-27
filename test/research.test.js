'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { keywordScore } = require('../src/core/research');

test('keywordScore：空关键词不过滤，返回 1', () => {
    assert.equal(keywordScore('任意标题', ''), 1);
    assert.equal(keywordScore('任意标题', '   '), 1);
});

test('keywordScore：整串命中返回 1', () => {
    assert.equal(keywordScore('DeepSeek 发布新模型', 'deepseek'), 1);
});

test('keywordScore：多词按空格拆开，任一 token 命中即可', () => {
    // 标题里没有「AI」，但有「芯片」；整串「AI 芯片」在旧逻辑里会直接搜不到
    assert.ok(keywordScore('英伟达发布新一代芯片', 'AI 芯片') >= 0.5);
    assert.ok(keywordScore('新能源汽车销量创新高', '芯片 汽车') >= 0.5);
});

test('keywordScore：完全不相干的词得 0', () => {
    assert.equal(keywordScore('今天天气不错', '量子计算'), 0);
});

test('keywordScore：单字关键词命中给 1，未命中给 0', () => {
    assert.equal(keywordScore('战报来了', '战'), 1);
    // 多 token 里的单字走子串判定，命中给 0.5
    assert.equal(keywordScore('战报来了', '战 报'), 0.5);
    assert.equal(keywordScore('无关内容', '战'), 0);
});

test('keywordScore：中文短语按 2-gram 比例给分（部分命中低于整串）', () => {
    const full = keywordScore('这是关于人工智能芯片的报道', '芯片');
    const partial = keywordScore('这是关于人工智能的报道', '人工智能芯片');
    assert.equal(full, 1);
    assert.ok(partial > 0 && partial < 1);
});
