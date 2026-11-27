'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ARTIFACT_DEFAULTS,
  resolveOptions,
  isNightSilent,
  dailyMaxFor,
  collectArtifacts,
  countUnanswered,
  selectDeliverable
} = require('../src/core/artifactDelivery');
const { attachShadowScheduler, shadowCandidate } = require('../src/core/proactiveScheduler');

const DAY = new Date(2026, 10, 6, 10, 0, 0).getTime();      // 11-06 10:00
const NIGHT = new Date(2026, 10, 6, 23, 30, 0).getTime();    // 11-06 23:30
const EARLY = new Date(2026, 10, 6, 3, 0, 0).getTime();      // 11-06 03:00

function ev(type, at, payload = {}) {
  return { v: 1, seq: 1, at, type, payload };
}

test('P1：夜间静默 23:00–07:00，白天放行', () => {
  assert.equal(isNightSilent(NIGHT), true);
  assert.equal(isNightSilent(EARLY), true);
  assert.equal(isNightSilent(DAY), false);
  assert.equal(selectDeliverable({ artifacts: [{ artifactId: 'a', kind: 'note', text: 'x', at: DAY }], now: NIGHT }), null);
});

test('P2：每日上限与「连续无回应减半」', () => {
  const opts = { ...ARTIFACT_DEFAULTS, dailyMax: 4 };
  assert.equal(dailyMaxFor(0, opts), 4);
  assert.equal(dailyMaxFor(1, opts), 4);
  assert.equal(dailyMaxFor(2, opts), 2);
  const sent = [1, 2, 3].map((i) => ({ artifactId: `s${i}`, kind: 'note', at: DAY - i * 1000 }));
  assert.equal(selectDeliverable({ artifacts: [{ artifactId: 'new', kind: 'note', text: 'x', at: DAY }], sent, now: DAY }), null);
});

test('P3：同类冷却 30 分钟，异类不受影响', () => {
  const sent = [{ artifactId: 'old', kind: 'note', at: DAY - 10 * 60 * 1000 }];
  const notes = [{ artifactId: 'n2', kind: 'note', text: '便条', at: DAY }];
  const drafts = [{ artifactId: 'd2', kind: 'draft', text: '半句', at: DAY }];
  assert.equal(selectDeliverable({ artifacts: notes, sent, now: DAY }), null);
  assert.equal(selectDeliverable({ artifacts: drafts, sent, now: DAY }).artifactId, 'd2');
});

test('P4：已投递的 artifactId 不重复投；超过 24 小时的旧话不捞', () => {
  const sent = [{ artifactId: 'a1', kind: 'draft', at: DAY - 3600_000 }];
  const arts = [
    { artifactId: 'a1', kind: 'note', text: '已发', at: DAY - 1000 },
    { artifactId: 'a2', kind: 'note', text: '太旧', at: DAY - ARTIFACT_DEFAULTS.maxAgeMs - 1000 },
    { artifactId: 'a3', kind: 'note', text: '新', at: DAY - 1000 }
  ];
  assert.equal(selectDeliverable({ artifacts: arts, sent, now: DAY }).artifactId, 'a3');
});

test('P5：collectArtifacts：生活动态同一天取最新；未到点的约定不算；影子候选忽略', () => {
  const arts = collectArtifacts([
    ev('life.event', DAY - 60000, { day: '2026-11-06', postId: 'p1', text: '预览' }),
    ev('life.event', DAY, { day: '2026-11-06', postId: 'p2', text: '完整版' }),
    ev('appointment.scheduled', DAY - 2000, { id: 'ap1', at: DAY + 3600_000, text: '未来约定' }),
    ev('appointment.scheduled', DAY - 1000, { id: 'ap2', at: DAY - 1000, text: '到点了' }),
    ev('artifact.created', DAY, { artifactId: 'shadow-1', kind: 'note', text: '影子', shadow: true }),
    ev('artifact.created', DAY, { artifactId: 'draft-1', kind: 'draft', text: '攒着的话' })
  ], { now: DAY });
  const ids = arts.map((a) => a.artifactId).sort();
  assert.deepEqual(ids, ['appt:ap2', 'draft-1', 'life:2026-11-06']);
  assert.equal(arts.find((a) => a.artifactId === 'life:2026-11-06').text, '完整版');
  assert.ok(arts.find((a) => a.artifactId === 'appt:ap2').text.includes('到点了'));
});

test('P6：连续无回应计数在「用户回话」处中断', () => {
  const sent = [{ artifactId: 'd1', kind: 'note', at: DAY - 3000 }, { artifactId: 'd2', kind: 'note', at: DAY - 2000 }];
  assert.equal(countUnanswered({ sent, events: [] }), 2);
  assert.equal(countUnanswered({ sent, events: [ev('message.in', DAY - 2500)] }), 1);
  assert.equal(countUnanswered({ sent, events: [ev('message.in', DAY - 1000)] }), 0);
});

test('P7：QQ_ARTIFACT_DAILY_MAX 覆盖默认上限，非法值回退', () => {
  assert.equal(resolveOptions({ QQ_ARTIFACT_DAILY_MAX: '6' }).dailyMax, 6);
  assert.equal(resolveOptions({ QQ_ARTIFACT_DAILY_MAX: 'abc' }).dailyMax, ARTIFACT_DEFAULTS.dailyMax);
  assert.equal(resolveOptions({}).dailyMax, 4);
});

test('P8：影子候选只认自带文本的产物，且带 shadow 标记', () => {
  assert.equal(shadowCandidate(ev('memory.created', DAY, { text: '记忆' })), null);
  const c = shadowCandidate(ev('life.event', DAY, { text: '散步' }));
  assert.equal(c.kind, 'note');
  assert.equal(c.shadow, true);
  assert.ok(c.artifactId.startsWith('shadow:life.event:'));
});

test('P9：影子订阅每 scope 冷却期内只记一次；影子物件不会被投递', () => {
  const store = {
    appended: [],
    subscribe(fn) { this.fn = fn; },
    append(scope, type, payload) { this.appended.push({ scope, type, payload }); }
  };
  attachShadowScheduler(store, { cooldownMs: 60_000, now: () => DAY });
  store.fn(ev('life.event', DAY, { text: '第一条' }), 'u1__role');
  store.fn(ev('life.event', DAY, { text: '第二条' }), 'u1__role');
  assert.equal(store.appended.length, 1);
  assert.equal(store.appended[0].payload.shadow, true);

  const sent = [];
  const pick = selectDeliverable({ artifacts: collectArtifacts([ev('artifact.created', DAY, store.appended[0].payload)], { now: DAY }), sent, now: DAY });
  assert.equal(pick, null);
});
