'use strict';

// 进化参数外置层回归：默认值 / 覆盖 / 边界夹取 / 未登记忽略 / 落盘 / 快照回滚。
// 全程用临时目录，绝不碰真 data/。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvolutionParams, PARAM_SPECS } = require('../src/core/evolutionParams');

function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-params-'));
}

test('没覆盖层时取代码默认值', () => {
    const p = new EvolutionParams({ root: makeTmp() });
    assert.equal(p.get('internalFilterGain'), PARAM_SPECS.internalFilterGain.default);
    assert.equal(p.get('internalIntensityCap'), 0.35);
});

test('未登记的名字一律不认', () => {
    const p = new EvolutionParams({ root: makeTmp() });
    assert.equal(p.get('不存在的参数'), null);
    assert.equal(p.has('internalFilterGain'), true);
    assert.equal(p.has('nope'), false);
    assert.equal(p.set('nope', 1), null);
});

test('set 生效并落盘，重新实例化仍读得到', () => {
    const root = makeTmp();
    const p = new EvolutionParams({ root });
    assert.equal(p.set('internalFilterGain', 0.2), 0.2);
    assert.equal(p.get('internalFilterGain'), 0.2);

    const again = new EvolutionParams({ root });
    assert.equal(again.get('internalFilterGain'), 0.2);
    assert.equal(again.get('internalIntensityCap'), 0.35, '没覆盖的参数仍回默认');
});

test('越界值夹到边界，非法值不写', () => {
    const p = new EvolutionParams({ root: makeTmp() });
    assert.equal(p.set('internalFilterGain', 99), PARAM_SPECS.internalFilterGain.max);
    assert.equal(p.set('internalFilterGain', -5), PARAM_SPECS.internalFilterGain.min);
    assert.equal(p.set('internalFilterGain', 'abc'), null);
    assert.equal(p.set('internalFilterGain', NaN), null);
});

test('reset 抹掉覆盖回到默认', () => {
    const p = new EvolutionParams({ root: makeTmp() });
    p.set('internalFilterGain', 0.2);
    p.reset('internalFilterGain');
    assert.equal(p.get('internalFilterGain'), PARAM_SPECS.internalFilterGain.default);

    p.set('internalFilterGain', 0.2);
    p.set('internalIntensityCap', 0.5);
    p.reset();
    assert.equal(p.get('internalFilterGain'), PARAM_SPECS.internalFilterGain.default);
    assert.equal(p.get('internalIntensityCap'), 0.35);
});

test('snapshot / restore 能回滚到改之前', () => {
    const p = new EvolutionParams({ root: makeTmp() });
    p.set('internalFilterGain', 0.2);
    const snap = p.snapshot();
    p.set('internalFilterGain', 0.3);
    assert.equal(p.get('internalFilterGain'), 0.3);
    p.restore(snap);
    assert.equal(p.get('internalFilterGain'), 0.2);
});

test('list 给出当前值 / 默认值 / 是否被覆盖', () => {
    const p = new EvolutionParams({ root: makeTmp() });
    p.set('internalIntensityCap', 0.5);
    const rows = p.list();
    const cap = rows.find((r) => r.name === 'internalIntensityCap');
    const gain = rows.find((r) => r.name === 'internalFilterGain');
    assert.equal(cap.value, 0.5);
    assert.equal(cap.overridden, true);
    assert.equal(gain.value, gain.default);
    assert.equal(gain.overridden, false);
});
