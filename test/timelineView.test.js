'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDayView } = require('../src/core/timelineView');

function ev(type, at, payload = {}) {
  return { v: 1, seq: 1, at, type, payload };
}

const AT = (h, m = 0) => new Date(2026, 10, 6, h, m, 0).getTime();

test('V1：按凌晨/上午/下午/晚上分段，时序升序', () => {
  const view = buildDayView([
    ev('message.in', AT(20), { channel: 'web', text: '晚上好' }),
    ev('message.out', AT(9), { channel: 'web', text: '早' }),
    ev('speech.proactive', AT(3), { channel: 'qq', text: '睡不着' })
  ], { now: AT(20) });
  assert.equal(view.date, '2026-11-06');
  assert.deepEqual(view.sections.map((s) => s.name), ['凌晨', '上午', '晚上']);
  assert.equal(view.sections[1].items[0].text, '她回：早');
});

test('V2：QQ 与网页混排，但每条带 channel 可区分', () => {
  const view = buildDayView([
    ev('message.in', AT(9), { channel: 'qq', scene: 'private', text: '在吗' }),
    ev('message.in', AT(10), { channel: 'web', text: '在吗' }),
    ev('message.in', AT(11), { channel: 'qq', scene: 'group', groupId: 'g1', text: '大家好' })
  ]);
  const items = view.sections.find((s) => s.name === '上午').items;
  assert.deepEqual(items.map((i) => i.channel), ['qq', 'web', 'qq']);
  assert.ok(items[2].text.includes('群里的他'));
});

test('V3：未投递的物件进「她攒着的话」，已投递的排除', () => {
  const view = buildDayView([
    ev('artifact.created', AT(9), { artifactId: 'a1', kind: 'draft', text: '攒着的话' }),
    ev('artifact.created', AT(10), { artifactId: 'a2', kind: 'note', text: '已经发了' }),
    ev('delivery.sent', AT(10, 30), { artifactId: 'a2', channel: 'qq', kind: 'note' }),
    ev('artifact.created', AT(11), { artifactId: 's1', kind: 'note', text: '影子', shadow: true })
  ]);
  assert.deepEqual(view.pending.map((p) => p.artifactId), ['a1']);
});

test('V4：同一份日志算两次结果一致（投影幂等）', () => {
  const events = [
    ev('message.in', AT(9), { channel: 'web', text: '你好' }),
    ev('life.event', AT(15), { day: '2026-11-06', postId: 'p', text: '今天去了公园' })
  ];
  assert.deepEqual(buildDayView(events), buildDayView(events));
});

test('V5：未知事件与坏时间戳不进入视图', () => {
  const view = buildDayView([ev('unknown.event', AT(9), {}), { type: 'message.in', payload: { text: '无时间' } }]);
  assert.deepEqual(view.sections, []);
  assert.deepEqual(view.pending, []);
});
