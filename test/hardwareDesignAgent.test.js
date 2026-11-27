'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseJsonObject,
    evaluateReceipt,
    sanitizeName,
    buildPrompt
} = require('../hardware/design-agent/agent');

test('设计代理：解析裸 JSON 与代码块 JSON', () => {
    assert.deepEqual(parseJsonObject('{"type":"hydrant"}'), { type: 'hydrant' });
    assert.deepEqual(parseJsonObject('说明\n```json\n{"a":1}\n```\n结束'), { a: 1 });
    assert.throws(() => parseJsonObject('没有 JSON'), /没有返回 JSON/);
});

test('设计代理：回执验收按可观测指标判断', () => {
    const ok = {
        ok: true,
        bbox: [48, 44, 78],
        volumeCm3: 23.86,
        triangles: 32988
    };
    assert.equal(evaluateReceipt(ok), null);
    assert.match(evaluateReceipt({ ...ok, volumeCm3: 2 }), /体积/);
    assert.match(evaluateReceipt({ ...ok, bbox: [48, 44, 120] }), /高度/);
    assert.match(evaluateReceipt({ ...ok, triangles: 90000 }), /面数/);

    const impeller = { ok: true, bbox: [90, 90, 31], volumeCm3: 59.21, triangles: 72028 };
    assert.equal(evaluateReceipt(impeller, 'impeller'), null);
    assert.match(evaluateReceipt(impeller, 'hydrant'), /高度|底座/);
});

test('设计代理：名称统一加 agent- 前缀，避免覆盖人工模型', () => {
    assert.equal(sanitizeName('hollow hydrant'), 'agent-hollow-hydrant');
    assert.equal(sanitizeName('agent-hydrant'), 'agent-hydrant');
});

test('设计代理：提示词包含硬约束与上一轮回执', () => {
    const messages = buildPrompt('镂空消防栓', 2, {
        spec: { type: 'hydrant', innerRadius: 10 },
        error: '体积过小'
    });
    assert.match(messages[0].content, /innerRadius/);
    assert.match(messages[1].content, /第 2 轮/);
    assert.match(messages[1].content, /体积过小/);

    const impeller = buildPrompt('镂空叶轮', 1, null, 'impeller');
    assert.match(impeller[0].content, /bladeCount/);
    assert.match(impeller[1].content, /第 1 轮/);
});
