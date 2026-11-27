'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULTS, BAND_BASE, BAND_URGENT, computeMortalityPressure
} = require('../src/core/mortality');

test('档位 code 是稳定 ASCII（中文只在渲染层）', () => {
    assert.equal(BAND_BASE, 'base');
    assert.equal(BAND_URGENT, 'urgent');
});

test('底色恒在：无遗忘留痕时 pressure = baseline，档位为 base', () => {
    const r = computeMortalityPressure({ tombstones: 0 });
    assert.equal(r.value, DEFAULTS.baseline);
    assert.equal(r.band, BAND_BASE);
    // 完全不传也落在底色
    assert.deepEqual(computeMortalityPressure(), { value: DEFAULTS.baseline, band: BAND_BASE });
});

test('遗忘抬升：留痕越多压力越大（单调不减）', () => {
    const a = computeMortalityPressure({ tombstones: 3 }).value;
    const b = computeMortalityPressure({ tombstones: 6 }).value;
    const c = computeMortalityPressure({ tombstones: 9 }).value;
    assert.ok(a >= DEFAULTS.baseline && a < b && b < c);
});

test('档位门：value 达到跨档线（含等号）升为 urgent', () => {
    const below = computeMortalityPressure({ value: undefined, baseline: 0.5, tombstoneGain: 0.05, bandThreshold: 0.6, tombstones: 1 });
    assert.equal(below.band, BAND_BASE);        // 0.55 < 0.6
    const atLine = computeMortalityPressure({ baseline: 0.5, tombstoneGain: 0.05, bandThreshold: 0.6, tombstones: 2 });
    assert.equal(atLine.value, 0.6);
    assert.equal(atLine.band, BAND_URGENT);     // 0.6 >= 0.6，边界含等号
});

test('护栏①：tombstoneCap 低于 baseline 时，压力仍不低于 baseline（底色不被压没）', () => {
    const r = computeMortalityPressure({ baseline: 0.4, tombstoneCap: 0.1, bandThreshold: 0.2, tombstones: 0 });
    assert.equal(r.value, 0.4);   // 未被 cap=0.1 压低
});

test('分歧5：tombstoneCap 低于跨档线时被抬到跨档线，保证紧迫档可触发', () => {
    const r = computeMortalityPressure({ baseline: 0.35, tombstoneGain: 0.02, tombstoneCap: 0.5, bandThreshold: 0.6, tombstones: 1000 });
    assert.equal(r.value, 0.6);
    assert.equal(r.band, BAND_URGENT);
});

test('入口守卫：非法标量回落默认值', () => {
    const r = computeMortalityPressure({ baseline: NaN, tombstoneGain: 'x', bandThreshold: null, tombstoneCap: Infinity });
    assert.equal(r.value, DEFAULTS.baseline);
    assert.equal(r.band, BAND_BASE);
});

test('入口守卫：tombstones 非法/负数一律按 0 处理', () => {
    assert.equal(computeMortalityPressure({ tombstones: -5 }).value, DEFAULTS.baseline);
    assert.equal(computeMortalityPressure({ tombstones: 'abc' }).value, DEFAULTS.baseline);
    assert.equal(computeMortalityPressure({ tombstones: NaN }).value, DEFAULTS.baseline);
});

test('入口守卫：输入非对象时降级为底色', () => {
    assert.deepEqual(computeMortalityPressure(null), { value: DEFAULTS.baseline, band: BAND_BASE });
    assert.deepEqual(computeMortalityPressure('nope'), { value: DEFAULTS.baseline, band: BAND_BASE });
});

test('压力在上限处封顶', () => {
    const r = computeMortalityPressure({ baseline: 0.35, tombstoneGain: 0.02, tombstoneCap: 0.7, tombstones: 1000 });
    assert.equal(r.value, 0.7);
    assert.equal(r.band, BAND_URGENT);
});
