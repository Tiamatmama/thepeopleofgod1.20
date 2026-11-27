'use strict';

/**
 * 自主能力轨迹：把一轮 run 的迭代记录拍平成 (轮次, 阶段 id, 是否通过) 序列。
 *
 * 用途是「同一刺激序列」下的回归比对：只要输入、判据与模型行为一致，
 * 轨迹就应逐项相同；不同则定位到第一个分歧的轮次与阶段 id。
 */

// 容差写死：轮次必须精确相等（0 = 不允许轮次漂移）。
// 后续若要放宽，只能改这里，避免不同调用点各带一套容差导致比对结果不可比。
const ROUND_TOLERANCE = 0;

function buildTrajectory(run) {
  const trajectory = [];
  const iterations = Array.isArray(run && run.iterations) ? run.iterations : [];
  iterations.forEach((step, index) => {
    const round = Number.isInteger(step && step.iteration) ? step.iteration : index + 1;
    const stages = Array.isArray(step && step.stages) ? step.stages : [];
    stages.forEach((stage) => {
      trajectory.push({
        round,
        stageId: String((stage && stage.stageId) || ''),
        ok: Boolean(stage && stage.ok)
      });
    });
  });
  return trajectory;
}

function compareTrajectories(baseline, actual) {
  const expected = Array.isArray(baseline) ? baseline : [];
  const got = Array.isArray(actual) ? actual : [];
  const total = Math.max(expected.length, got.length);

  for (let index = 0; index < total; index++) {
    const want = expected[index] || null;
    const have = got[index] || null;

    if (!want || !have) {
      return {
        match: false,
        divergence: {
          index,
          round: (have || want).round,
          stageId: String((have || want).stageId || ''),
          field: want ? 'missing' : 'unexpected',
          expected: want,
          actual: have
        }
      };
    }

    let field = '';
    if (Math.abs(Number(want.round) - Number(have.round)) > ROUND_TOLERANCE) field = 'round';
    else if (String(want.stageId) !== String(have.stageId)) field = 'stageId';
    else if (Boolean(want.ok) !== Boolean(have.ok)) field = 'ok';

    if (field) {
      return {
        match: false,
        divergence: {
          index,
          round: have.round,
          stageId: have.stageId,
          field,
          expected: want,
          actual: have
        }
      };
    }
  }

  return { match: true, divergence: null };
}

module.exports = { ROUND_TOLERANCE, buildTrajectory, compareTrajectories };
