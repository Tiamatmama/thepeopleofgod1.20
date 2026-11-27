'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMemoryGraph,
  emotionWarmth,
  memoryStrength,
  dayKey,
  parseScopeLabel,
  FADED_STRENGTH
} = require('../src/core/memoryGraph');

const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function mem(patch = {}) {
  return Object.assign({
    id: String(Math.random()),
    data: '一条记忆',
    timestamp: NOW - 1000,
    salience: 0.5,
    tier: 'episodic',
    emotion: null,
    speaker: 'user',
    recallCount: 0,
    pinned: false,
    topicId: ''
  }, patch);
}

test('情绪色温：暖色为正、冷色为负、未知为中性', () => {
  assert.equal(emotionWarmth('happy'), 1);
  assert.ok(emotionWarmth('shy') > 0);
  assert.ok(emotionWarmth('sad') < 0);
  assert.ok(emotionWarmth('angry') < 0);
  assert.equal(emotionWarmth('unknown'), 0);
  assert.equal(emotionWarmth(null), 0);
});

test('记忆强度：新且显著的高，旧的归档的低，置顶最高', () => {
  const fresh = memoryStrength(mem({ salience: 0.9, timestamp: NOW - 1000 }), NOW);
  const old = memoryStrength(mem({ salience: 0.9, timestamp: NOW - 28 * DAY }), NOW);
  const archived = memoryStrength(mem({ salience: 0.9, timestamp: NOW - 28 * DAY, tier: 'archived' }), NOW);
  const pinned = memoryStrength(mem({ salience: 0.1, timestamp: NOW - 28 * DAY, pinned: true }), NOW);

  assert.ok(fresh > old, '新记忆应比 28 天前的同显著度记忆更强');
  assert.ok(old > archived, '归档应进一步压暗');
  assert.ok(pinned >= 0.95, '置顶记忆保持高亮');
  assert.ok(fresh <= 1 && archived >= 0);
});

test('节点字段：日期键、情绪、淡忘标记齐全', () => {
  const graph = buildMemoryGraph({
    memories: [
      mem({ id: 'a', timestamp: new Date(2026, 10, 20, 9, 30).getTime(), emotion: { type: 'happy', intensity: 0.8 } }),
      mem({ id: 'b', timestamp: new Date(2026, 10, 20, 21, 0).getTime(), tier: 'archived', salience: 0.02 })
    ]
  }, { now: NOW });

  assert.equal(graph.nodes.length, 2);
  const a = graph.nodes.find((n) => n.id === 'a');
  assert.equal(a.day, '2026-11-20');
  assert.equal(a.emotion, 'happy');
  assert.equal(a.intensity, 0.8);
  assert.equal(a.warmth, 1);
  assert.equal(a.faded, false);

  const b = graph.nodes.find((n) => n.id === 'b');
  assert.ok(b.strength < FADED_STRENGTH);
  assert.equal(b.faded, true, '低强度记忆要被标成淡忘');
  assert.equal(b.emotion, '');
});

test('白天窗口过滤：窗口外的普通记忆剔除，置顶记忆保留', () => {
  const graph = buildMemoryGraph({
    memories: [
      mem({ id: 'recent', timestamp: NOW - DAY }),
      mem({ id: 'old', timestamp: NOW - 90 * DAY }),
      mem({ id: 'pinned-old', timestamp: NOW - 90 * DAY, pinned: true })
    ]
  }, { now: NOW, days: 30 });

  const ids = graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['pinned-old', 'recent']);
  assert.equal(graph.meta.total, 2);
});

test('节点上限：超出时保留最近的，置顶优先', () => {
  const memories = [];
  for (let i = 0; i < 50; i += 1) {
    memories.push(mem({ id: `n${i}`, timestamp: NOW - i * 60000 }));
  }
  memories.push(mem({ id: 'pin', timestamp: NOW - 40 * DAY, pinned: true }));

  const graph = buildMemoryGraph({ memories }, { now: NOW, maxNodes: 20 });
  assert.equal(graph.nodes.length, 20);
  assert.ok(graph.nodes.some((n) => n.id === 'pin'));
  assert.ok(graph.nodes.some((n) => n.id === 'n0'));
  assert.equal(graph.meta.truncated, true);
});

test('边：同话题相邻相连，同一天相邻相连，且不重复', () => {
  const base = new Date(2026, 10, 21, 10, 0).getTime();
  const graph = buildMemoryGraph({
    memories: [
      mem({ id: 't1', timestamp: base, topicId: 'topic-x' }),
      mem({ id: 't2', timestamp: base + 60000, topicId: 'topic-x' }),
      mem({ id: 't3', timestamp: base + 120000, topicId: 'topic-x' }),
      mem({ id: 'd1', timestamp: base + 180000 })
    ]
  }, { now: NOW });

  const topicEdges = graph.edges.filter((e) => e.kind === 'topic');
  const dayEdges = graph.edges.filter((e) => e.kind === 'day');
  assert.equal(topicEdges.length, 2, '三条同话题记忆应只有两条相邻连线');
  // 同一天的四条按时间连成链；前两段已被话题链占用，去重后只剩 t3 → d1 这一段
  assert.equal(dayEdges.length, 1);
  assert.equal(graph.edges.length, 3);

  const keys = graph.edges.map((e) => [e.source, e.target].sort().join('|'));
  assert.equal(new Set(keys).size, keys.length, '不允许重复边');
});

test('每日概览：按天聚合，暖度按有情绪的条目加权', () => {
  const day1 = new Date(2026, 10, 22, 10, 0).getTime();
  const graph = buildMemoryGraph({
    memories: [
      mem({ id: 'h1', timestamp: day1, emotion: { type: 'happy', intensity: 1 } }),
      mem({ id: 'h2', timestamp: day1 + 1000, emotion: { type: 'happy', intensity: 0.5 } }),
      mem({ id: 's1', timestamp: day1 + 2000, emotion: { type: 'sad', intensity: 0.5 } })
    ]
  }, { now: NOW });

  assert.equal(graph.meta.daily.length, 1);
  const day = graph.meta.daily[0];
  assert.equal(day.day, '2026-11-22');
  assert.equal(day.count, 3);
  assert.ok(day.warmth > 0 && day.warmth < 1, '两暖一冷应落在中间偏暖');
  assert.equal(graph.meta.dominantEmotion, 'happy');
});

test('关系阶段与当前情绪原样带出，空输入也能安全返回', () => {
  const graph = buildMemoryGraph({
    memories: [],
    relationshipScore: 88.5,
    stage: 'LOVER',
    stageName: '专属',
    currentEmotion: 'happy'
  }, { now: NOW });

  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.meta.nodeCount, 0);
  assert.equal(graph.meta.stage, 'LOVER');
  assert.equal(graph.meta.stageName, '专属');
  assert.equal(graph.meta.relationshipScore, 88.5);
  assert.equal(graph.meta.currentEmotion, 'happy');
  assert.equal(graph.meta.range, null);

  const blank = buildMemoryGraph();
  assert.equal(blank.nodes.length, 0);
  assert.equal(blank.meta.daily.length, 0);
});

test('日期键使用本地时区，同一天聚为一簇', () => {
  const morning = new Date(2026, 0, 2, 1, 0).getTime();
  const night = new Date(2026, 0, 2, 23, 0).getTime();
  assert.equal(dayKey(morning), '2026-01-02');
  assert.equal(dayKey(night), '2026-01-02');
  assert.notEqual(dayKey(morning), dayKey(night + 2 * 60 * 60 * 1000));
});

test('记忆键解析：QQ 档带号与角色，网页档只带名字', () => {
  const qq = parseScopeLabel('qq_123456789_测试角色__role');
  assert.equal(qq.kind, 'qq');
  assert.equal(qq.uin, '123456789');
  assert.equal(qq.role, '测试角色');
  assert.equal(qq.label, 'QQ 123456789 · 测试角色');

  const bare = parseScopeLabel('qq_123456');
  assert.equal(bare.kind, 'qq');
  assert.equal(bare.label, 'QQ 123456');

  const web = parseScopeLabel('管理员__role');
  assert.equal(web.kind, 'web');
  assert.equal(web.label, '网页 · 管理员');

  assert.equal(parseScopeLabel('').label, '网页');
});

test('没有实时情绪快照时，用最近一条带情绪的记忆代指此刻', () => {
  const graph = buildMemoryGraph({
    memories: [
      mem({ id: 'x', timestamp: new Date(2026, 10, 20, 10, 0).getTime(), emotion: { type: 'sad', intensity: 0.7 } }),
      mem({ id: 'y', timestamp: new Date(2026, 10, 24, 10, 0).getTime(), emotion: { type: 'happy', intensity: 0.6 } })
    ]
  }, { now: NOW });

  assert.equal(graph.meta.currentEmotion, 'happy');
});
