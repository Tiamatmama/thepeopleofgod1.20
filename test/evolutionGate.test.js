'use strict';

// 沙箱进化闸回归：提案校验 / 基线 / 评估 / 不劣化判定 / 分档生效 / 回滚。
// 用假 runner + 临时目录驱动，绝不真跑 benchmark、不碰真 data/。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvolutionGate } = require('../src/core/evolutionGate');
const { EvolutionParams } = require('../src/core/evolutionParams');

function makeGate(runner) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-gate-'));
    const params = new EvolutionParams({ root });
    const gate = new EvolutionGate({ root, params, runner });
    return { gate, params, root };
}

// 造一份跟 emotion 模块指标规格对得上的评估报告
function report({ fast = 0.3, slow = 0.1, happy = '5/5', sad = '5/5', calm = '5/5' } = {}) {
    return {
        aggregate: {
            快层最大偏离_mean: fast,
            慢层最大偏离_mean: slow,
            方向一致性: { happy正: happy, sad正: sad, calm负: calm }
        }
    };
}

test('propose：拒绝非登记模块 / 非法 kind / 不属于该模块的参数', () => {
    const { gate } = makeGate();
    assert.equal(gate.propose({ kind: 'param', module: 'nope', changes: [{ name: 'internalFilterGain', to: 0.1 }] }).success, false);
    assert.equal(gate.propose({ kind: 'whatever', module: 'emotion', changes: [] }).success, false);
    assert.equal(gate.propose({ kind: 'param', module: 'emotion', changes: [] }).success, false);
    assert.equal(gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalIntensityCap', to: 0.5 }] }).success, true);
});

test('evaluate：没基线直接拒', async () => {
    const { gate } = makeGate();
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.1 }] });
    const res = await gate.evaluate(proposal.id);
    assert.equal(res.success, false);
    assert.match(res.error, /基线/);
});

test('evaluate：不劣化 → pass', async () => {
    const runner = async () => ({ ok: true, report: report() });
    const { gate } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.1 }] });
    const res = await gate.evaluate(proposal.id);
    assert.equal(res.success, true);
    assert.equal(res.verdict, 'pass');
    assert.equal(gate.getProposal(proposal.id).verdict, 'pass');
});

test('evaluate：某指标明显变差 → fail', async () => {
    const runner = async () => ({ ok: true, report: report({ fast: 0.9 }) });
    const { gate } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.3 }] });
    const res = await gate.evaluate(proposal.id);
    assert.equal(res.verdict, 'fail');
    assert.ok(res.failures.length >= 1);
});

test('evaluate：指标读不到 → inconclusive（不放行）', async () => {
    const bad = { aggregate: { 快层最大偏离_mean: 0.3 } };
    const runner = async () => ({ ok: true, report: bad });
    const { gate } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.1 }] });
    const res = await gate.evaluate(proposal.id);
    assert.equal(res.verdict, 'inconclusive');
    assert.ok(res.missing.length >= 1);
});

test('evaluate：runner 抛错 → 记 error，不生效', async () => {
    const runner = async () => { throw new Error('炸了'); };
    const { gate } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.1 }] });
    const res = await gate.evaluate(proposal.id);
    assert.equal(res.success, false);
    assert.equal(gate.getProposal(proposal.id).status, 'error');
});

test('judge：容差内的轻微波动算过', () => {
    const { gate } = makeGate();
    const spec = [{ key: 'x', direction: 'up', tolerance: 0.1 }];
    assert.equal(gate.judge({ x: 0.9 }, { x: 1 }, spec).verdict, 'pass');
    assert.equal(gate.judge({ x: 0.89 }, { x: 1 }, spec).verdict, 'fail');
});

test('promote：参数档过闸自动生效，rollback 能退回', async () => {
    const runner = async () => ({ ok: true, report: report() });
    const { gate, params } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.2 }] });
    await gate.evaluate(proposal.id);

    assert.equal(params.get('internalFilterGain'), 0.08, '评估阶段不动参数');
    const promoted = gate.promote(proposal.id);
    assert.equal(promoted.success, true);
    assert.equal(params.get('internalFilterGain'), 0.2);

    gate.rollback(proposal.id);
    assert.equal(params.get('internalFilterGain'), 0.08, '回滚回到改之前');
});

test('promote：没过闸的提案不予生效', async () => {
    const runner = async () => ({ ok: true, report: report({ fast: 0.9 }) });
    const { gate, params } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'param', module: 'emotion', changes: [{ name: 'internalFilterGain', to: 0.2 }] });
    await gate.evaluate(proposal.id);
    const res = gate.promote(proposal.id);
    assert.equal(res.success, false);
    assert.equal(params.get('internalFilterGain'), 0.08);
});

test('promote：工具档即便过闸也只落待审，不动代码', async () => {
    const runner = async () => ({ ok: true, report: report() });
    const { gate, params } = makeGate(runner);
    gate.setBaseline('emotion', report());
    const { proposal } = gate.propose({ kind: 'tool', module: 'emotion', title: '改一下工具', changes: [{ file: 'x.js' }] });
    await gate.evaluate(proposal.id);
    const res = gate.promote(proposal.id);
    assert.equal(res.success, true);
    assert.equal(res.pending, true);
    assert.ok(fs.existsSync(res.file));
    assert.equal(gate.getProposal(proposal.id).status, 'pending-human');
    assert.equal(params.get('internalFilterGain'), 0.08, '工具档不碰参数');
});

test('setEnabled：默认关，开关可翻', () => {
    const { gate } = makeGate();
    assert.equal(gate.isEnabled(), false);
    assert.equal(gate.setEnabled(true), true);
    assert.equal(gate.isEnabled(), true);
    assert.equal(gate.status().enabled, true);
});
