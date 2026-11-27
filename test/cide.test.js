'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CIDEEngine,
  GlobalWorkspace,
  MetaCognition,
  ArousalSystem,
  DriveSources,
  computePhi
} = require('../src/core/cide');

// 假的统一 API：按顺序吐出预置的判决 JSON，用来驱动多轮思考而不联网
function fakeAPI(responses) {
  let index = 0;
  return {
    callAPI: async () => {
      const content = responses[Math.min(index, responses.length - 1)];
      index++;
      return { choices: [{ message: { content } }] };
    }
  };
}

// —— Φ 整合度 ——

test('computePhi：空数组为 0，单条为中性值 0.5', () => {
  assert.equal(computePhi([]), 0);
  assert.equal(computePhi(['只有一条想法']), 0.5);
});

test('computePhi：相似内容的整合度高于互不相关的内容，且落在 [0,1]', () => {
  const similar = computePhi(['今天天气很不错想出去走走', '今天天气很不错想出去散步']);
  const unrelated = computePhi(['今天天气很不错想出去走走', '量子纠缠实验的最新进展']);
  assert.ok(similar > unrelated, `similar(${similar}) 应大于 unrelated(${unrelated})`);
  assert.ok(similar <= 1 && similar >= 0);
  assert.ok(unrelated >= 0);
});

// —— 觉醒调节系统 ——

test('ArousalSystem：置信度低触发困惑信号并提升觉醒档位', () => {
  const arousal = new ArousalSystem({ initialLevel: 5 });
  const snap = arousal.observe({ confidence: 0.2, phi: 0.1, progress: null });
  assert.equal(snap.signal, 'confusion');
  assert.ok(snap.level > 5);
});

test('ArousalSystem：顺畅时降低觉醒档位', () => {
  const arousal = new ArousalSystem({ initialLevel: 6 });
  const snap = arousal.observe({ confidence: 0.95, phi: 0.9, progress: 0.5 });
  assert.equal(snap.signal, 'flow');
  assert.ok(snap.level < 6);
});

test('ArousalSystem：连续多轮无进展判定为卡壳', () => {
  const arousal = new ArousalSystem({ initialLevel: 5, stuckRounds: 2 });
  arousal.observe({ confidence: 0.6, phi: 0.4, progress: 0.001 });
  const snap = arousal.observe({ confidence: 0.6, phi: 0.4, progress: 0.001 });
  assert.equal(snap.signal, 'stuck');
  assert.equal(snap.stuck, true);
});

test('ArousalSystem：档位映射到轮次与注意力宽度，并夹在边界内', () => {
  const arousal = new ArousalSystem({ initialLevel: 5, minLevel: 3, maxLevel: 10, lowRounds: 2, highRounds: 5 });
  arousal.level = arousal.maxLevel;
  assert.equal(arousal.maxRounds(), 5);
  arousal.level = arousal.minLevel;
  assert.equal(arousal.maxRounds(), 2);
  assert.equal(arousal.attentionWidth('task'), 4);
  assert.equal(arousal.attentionWidth('reply'), 6);
  assert.equal(arousal.attentionWidth('explore'), 9);
});

// —— 三驱力 ——

test('DriveSources：张力落在 [0,1]，缺口大时一致性占主导', () => {
  const drives = new DriveSources({ targetPhi: 0.8 });
  const state = drives.compute({ phi: 0.1, goal: 0.1, taskType: 'task' });
  assert.ok(state.tension >= 0 && state.tension <= 1);
  assert.equal(state.dominant, 'consistency');
});

test('DriveSources：整合度高且目标明确时好奇心占主导', () => {
  const drives = new DriveSources({ targetPhi: 0.8 });
  const state = drives.compute({ phi: 0.8, goal: 0.9, taskType: 'reply' });
  assert.equal(state.dominant, 'curiosity');
  assert.ok(state.tension >= 0 && state.tension <= 1);
});

// —— γ 特征绑定与注意力宽度 ——

test('GlobalWorkspace.rebind：高相似碎片被合并成超级块', () => {
  const ws = new GlobalWorkspace(20);
  ws.add('今天天气很不错我想出去走走', { importance: 0.4 });
  ws.add('今天天气很不错我想出去散步', { importance: 0.6 });
  ws.add('完全无关的话题关于量子物理', { importance: 0.5 });

  const result = ws.rebind({ threshold: 0.5 });
  assert.ok(result.merged >= 1);
  assert.ok(result.released >= 1);
  assert.equal(ws.items.length, 2);
  const bound = ws.items.find((item) => item.binding);
  assert.ok(bound, '应存在一个被绑定的超级块');
  assert.equal(bound.source, 'binding');
  assert.ok(bound.importance >= 0.6);
});

test('GlobalWorkspace.context：limit 控制纳入条数', () => {
  const ws = new GlobalWorkspace(20);
  ws.add('低重要性', { importance: 0.2 });
  ws.add('高重要性', { importance: 0.9 });
  ws.add('中重要性', { importance: 0.5 });

  const lines = ws.context(2).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /高重要性/);
});

// —— 元认知：张力参与停止判断 ——

test('MetaCognition：置信度达标且张力低时收手，张力高时继续', () => {
  const meta = new MetaCognition({ confidenceThreshold: 0.75, maxRounds: 5 });
  assert.equal(
    meta.shouldContinue({ round: 2, confidence: 0.9, previousConfidence: 0.5, modelContinue: true, tension: 0.2 }),
    false
  );
  assert.equal(
    meta.shouldContinue({ round: 2, confidence: 0.9, previousConfidence: 0.5, modelContinue: true, tension: 0.6 }),
    true
  );
});

// —— 引擎整体：多轮思考产出 Φ 轨迹与觉醒 / 驱力状态 ——

test('CIDEEngine.deliberate：多轮思考返回 Φ 轨迹、啊哈时刻与觉醒 / 驱力状态', async () => {
  const api = fakeAPI([
    JSON.stringify({ thought: '第一层想法', confidence: 0.4, continue: true }),
    JSON.stringify({ thought: '第二层想法', confidence: 0.9, continue: false })
  ]);
  const engine = new CIDEEngine({ unifiedAPI: api });

  const result = await engine.deliberate({ sessionId: 's1', userInput: '你好', mode: 'reply' });

  assert.equal(result.rounds, 2);
  assert.equal(result.trace.length, 2);
  assert.equal(result.phiTrace.length, 2);
  assert.ok(result.phi >= 0 && result.phi <= 1);
  assert.equal(result.aha, true);
  assert.ok(result.drive && typeof result.drive.tension === 'number');
  assert.ok(result.arousal && result.arousal.level >= 3 && result.arousal.level <= 10);
});

test('CIDEEngine.workspaceValue：整合度更高的内容价值更高', () => {
  const engine = new CIDEEngine({ unifiedAPI: fakeAPI(['{}']) });
  engine.recordContext('a', '今天天气很不错想出去走走', 0.6);
  engine.recordContext('a', '今天天气很不错想出去散步', 0.6);

  engine.recordContext('b', '今天天气很不错想出去走走', 0.6);
  engine.recordContext('b', '量子纠缠实验的最新进展', 0.6);

  assert.ok(engine.workspaceValue('a') > engine.workspaceValue('b'));
});

// —— 内感受快照（只读汇总，不落盘、不回写）——

test('CIDEEngine.readInteroception：未注入读源时返回基础快照，drive 仍可用', () => {
  const engine = new CIDEEngine({ unifiedAPI: fakeAPI(['{}']) });
  const snap = engine.readInteroception('s1', 'u1');

  assert.equal(snap.sessionId, 's1');
  assert.equal(snap.userId, 'u1');
  assert.equal(typeof snap.at, 'number');
  assert.equal(snap.emotion, null);
  assert.equal(snap.relation, null);
  assert.equal(snap.memory, null);
  assert.equal(snap.daypart, null);
  // 驱动力是引擎自带器官，即使没人给它注读源也应有初值
  assert.ok(snap.drive && typeof snap.drive.expression === 'number');
  assert.equal(snap.drive.ignoredStreak, 0);
});

test('CIDEEngine.readInteroception：注入读源后按会话/用户汇总各器官状态', () => {
  const engine = new CIDEEngine({ unifiedAPI: fakeAPI(['{}']) });
  engine.setInteroceptionSources({
    emotion: (sessionId, userId) => ({ type: 'happy', intensity: 0.7, key: `${sessionId}|${userId}` }),
    relation: () => ({ stage: 'FRIEND', score: 42 }),
    memory: () => ({ total: 3 }),
    daypart: () => ({ hour: 9, part: '早晨' })
  });

  const snap = engine.readInteroception('s1', 'u1');
  assert.equal(snap.emotion.type, 'happy');
  assert.equal(snap.emotion.key, 's1|u1');
  assert.equal(snap.relation.stage, 'FRIEND');
  assert.equal(snap.memory.total, 3);
  assert.equal(snap.daypart.part, '早晨');
});

test('CIDEEngine.readInteroception：单个读源抛错只置空该源，其余不受影响', () => {
  const engine = new CIDEEngine({ unifiedAPI: fakeAPI(['{}']) });
  engine.setInteroceptionSources({
    emotion: () => { throw new Error('情绪读源炸了'); },
    relation: () => ({ stage: 'FRIEND' })
  });

  const snap = engine.readInteroception('s1', 'u1');
  assert.equal(snap.emotion, null);
  assert.equal(snap.relation.stage, 'FRIEND');
});

test('CIDEEngine.setInteroceptionSources：传非对象即撤销注入', () => {
  const engine = new CIDEEngine({ unifiedAPI: fakeAPI(['{}']) });
  engine.setInteroceptionSources({ emotion: () => ({ type: 'happy' }) });
  assert.equal(engine.readInteroception('s1', 'u1').emotion.type, 'happy');

  engine.setInteroceptionSources(null);
  assert.equal(engine.readInteroception('s1', 'u1').emotion, null);
});

