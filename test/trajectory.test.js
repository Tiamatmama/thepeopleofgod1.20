'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ROUND_TOLERANCE, buildTrajectory, compareTrajectories } = require('../src/core/trajectory');

function runOf(iterations) {
  return { iterations };
}

test('buildTrajectory：按轮次拍平阶段结果，跳过没有阶段的轮次', () => {
  const run = runOf([
    { iteration: 1, stages: [{ stageId: 'build', ok: true }, { stageId: 'health', ok: false }] },
    { iteration: 2, stages: [] },
    { iteration: 3, stages: [{ stageId: 'health', ok: true }] }
  ]);
  assert.deepEqual(buildTrajectory(run), [
    { round: 1, stageId: 'build', ok: true },
    { round: 1, stageId: 'health', ok: false },
    { round: 3, stageId: 'health', ok: true }
  ]);
});

test('buildTrajectory：空 run / 非法输入返回空轨迹', () => {
  assert.deepEqual(buildTrajectory(null), []);
  assert.deepEqual(buildTrajectory({}), []);
  assert.deepEqual(buildTrajectory({ iterations: [{ stages: null }] }), []);
});

test('compareTrajectories：完全一致 → match', () => {
  const trajectory = [{ round: 1, stageId: 'health', ok: true }];
  assert.deepEqual(compareTrajectories(trajectory, trajectory), { match: true, divergence: null });
});

test('compareTrajectories：首个分歧定位到轮次与阶段 id（ok 不同）', () => {
  const baseline = [
    { round: 1, stageId: 'health', ok: true },
    { round: 2, stageId: 'health', ok: true }
  ];
  const actual = [
    { round: 1, stageId: 'health', ok: false },
    { round: 2, stageId: 'health', ok: true }
  ];
  const result = compareTrajectories(baseline, actual);
  assert.equal(result.match, false);
  assert.equal(result.divergence.index, 0);
  assert.equal(result.divergence.round, 1);
  assert.equal(result.divergence.stageId, 'health');
  assert.equal(result.divergence.field, 'ok');
});

test('compareTrajectories：阶段顺序变化定位到 stageId', () => {
  const result = compareTrajectories(
    [{ round: 1, stageId: 'build', ok: true }],
    [{ round: 1, stageId: 'health', ok: true }]
  );
  assert.equal(result.divergence.field, 'stageId');
  assert.equal(result.divergence.stageId, 'health');
});

test('compareTrajectories：轮次漂移在容差 0 下即分歧', () => {
  assert.equal(ROUND_TOLERANCE, 0);
  const result = compareTrajectories(
    [{ round: 1, stageId: 'health', ok: true }],
    [{ round: 2, stageId: 'health', ok: true }]
  );
  assert.equal(result.divergence.field, 'round');
  assert.equal(result.divergence.round, 2);
});

test('compareTrajectories：缺项/多项分别标记 missing / unexpected', () => {
  const missing = compareTrajectories(
    [{ round: 1, stageId: 'health', ok: true }],
    []
  );
  assert.equal(missing.divergence.field, 'missing');
  assert.equal(missing.divergence.round, 1);
  assert.equal(missing.divergence.stageId, 'health');

  const unexpected = compareTrajectories(
    [],
    [{ round: 1, stageId: 'health', ok: true }]
  );
  assert.equal(unexpected.divergence.field, 'unexpected');
  assert.equal(unexpected.divergence.round, 1);
  assert.equal(unexpected.divergence.stageId, 'health');
});
