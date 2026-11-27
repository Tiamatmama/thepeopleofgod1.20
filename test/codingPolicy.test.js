'use strict';

// run.policy：给「一次运行」加可选的写/读次数上限。缺省 null（行为与旧版完全一致）；
// 只收紧不放宽；0 必须表示「一次都不许」——不能被 parseInt(x) || 默认值 吞成默认。

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const CodingLoop = require('../src/core/codingLoop');

function makeLoop() {
    return new CodingLoop({
        coding: {
            dir: os.tmpdir(),
            safeTaskId: (id) => String(id || '').trim() || 't1',
            createWorkspace: () => ({ success: true })
        },
        outputModule: {},
        toolRegistry: {}
    });
}

function makeRun(policy) {
    return { policy, policyUsed: { writes: 0, reads: 0 } };
}

test('prepare：未声明 policy → null，默认行为不变', () => {
    assert.equal(makeLoop().prepare({ userId: 'u', taskId: 't', goal: 'g' }).policy, null);
    assert.equal(makeLoop().prepare({ userId: 'u', taskId: 't', goal: 'g', policy: null }).policy, null);
});

test('prepare：maxWrites=0 原样保留，不被默认值吞掉', () => {
    const p = makeLoop().prepare({ userId: 'u', taskId: 't', goal: 'g', policy: { maxWrites: 0 } }).policy;
    assert.deepEqual(p, { maxWrites: 0, maxReads: null });
});

test('prepare：非法 policy 直接拒（负数 / 小数 / 非数字 / 非对象）', () => {
    const loop = makeLoop();
    for (const bad of [{ maxWrites: -1 }, { maxWrites: 1.5 }, { maxReads: 'abc' }, 'x']) {
        assert.throws(() => loop.prepare({ userId: 'u', taskId: 't', goal: 'g', policy: bad }), /policy/);
    }
});

test('checkPolicy：maxWrites 用满后再写被拒，读工具不占写配额', () => {
    const loop = makeLoop();
    const run = makeRun({ maxWrites: 1, maxReads: null });

    assert.equal(loop.checkPolicy(run, 'code_read_range'), null);
    assert.equal(loop.checkPolicy(run, 'code_apply_patch'), null);
    assert.match(loop.checkPolicy(run, 'code_write_file'), /最多写 1 次/);
    assert.equal(run.policyUsed.writes, 1, '被拒的那次不该计数');
});

test('checkPolicy：maxWrites=0 → 第一次写就被拒', () => {
    const loop = makeLoop();
    const run = makeRun({ maxWrites: 0, maxReads: null });
    assert.match(loop.checkPolicy(run, 'code_write_file'), /最多写 0 次/);
    assert.equal(run.policyUsed.writes, 0);
});

test('checkPolicy：maxReads 只算读工具，写工具不占读配额', () => {
    const loop = makeLoop();
    const run = makeRun({ maxWrites: null, maxReads: 1 });

    assert.equal(loop.checkPolicy(run, 'code_write_file'), null);
    assert.equal(loop.checkPolicy(run, 'code_read'), null);
    assert.match(loop.checkPolicy(run, 'code_list_dir'), /最多读 1 次/);
});

test('checkPolicy：没声明 policy 时一律放行，也不建计数', () => {
    const loop = makeLoop();
    const run = { policy: null };
    assert.equal(loop.checkPolicy(run, 'code_apply_patch'), null);
    assert.equal(run.policyUsed, undefined);
});
