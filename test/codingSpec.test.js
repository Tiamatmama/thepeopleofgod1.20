const test = require('node:test');
const assert = require('node:assert');

const { buildSpecMessages, parseSpec, specIsUsable, renderSpec, missingCapabilities } = require('../src/core/codingSpec');

test('parseSpec 能从 ```json 包裹里解析出能力与里程碑', () => {
  const raw = '前置说明\n```json\n' + JSON.stringify({
    goal: '实现和 X 一样的功能',
    capabilities: [
      { id: 'C1', name: '扫码登录', acceptance: 'cli login 输出二维码并登录成功' },
      { id: 'C2', name: '私聊收发', acceptance: 'A 发给 B，B 能收到并回复' }
    ],
    nonGoals: ['不改适配层'],
    milestones: [{ id: 'M1', title: '登录', capabilities: ['C1'], acceptance: '登录成功' }]
  }) + '\n```\n尾巴';
  const spec = parseSpec(raw);
  assert.ok(spec);
  assert.strictEqual(spec.capabilities.length, 2);
  assert.strictEqual(spec.milestones[0].capabilities[0], 'C1');
  assert.deepStrictEqual(spec.nonGoals, ['不改适配层']);
});

test('parseSpec 对空能力返回 null，不误判为可用', () => {
  assert.strictEqual(parseSpec('{"goal":"x","capabilities":[]}'), null);
  assert.strictEqual(parseSpec('not json'), null);
  assert.strictEqual(specIsUsable(null), false);
});

test('parseSpec 会丢弃不存在的里程碑能力引用', () => {
  const spec = parseSpec(JSON.stringify({
    goal: 'g',
    capabilities: [{ id: 'C1', name: 'a', acceptance: 'b' }],
    milestones: [{ id: 'M1', title: 't', capabilities: ['C1', 'C9'], acceptance: 'ok' }]
  }));
  assert.deepStrictEqual(spec.milestones[0].capabilities, ['C1']);
});

test('renderSpec 输出能力、非目标与里程碑', () => {
  const spec = parseSpec(JSON.stringify({
    goal: 'g',
    capabilities: [{ id: 'C1', name: '扫码登录', acceptance: '登录成功' }],
    nonGoals: ['不改适配层'],
    milestones: [{ id: 'M1', title: '登录', capabilities: ['C1'], acceptance: '登录成功' }]
  }));
  const md = renderSpec(spec);
  assert.match(md, /C1 扫码登录/);
  assert.match(md, /不改适配层/);
  assert.match(md, /M1 登录/);
});

test('missingCapabilities 只返回未覆盖且非已有的能力', () => {
  const spec = parseSpec(JSON.stringify({
    goal: 'g',
    capabilities: [
      { id: 'C1', name: 'a', acceptance: 'x' },
      { id: 'C2', name: 'b', acceptance: 'y', existing: true },
      { id: 'C3', name: 'c', acceptance: 'z' }
    ],
    milestones: [{ id: 'M1', title: 't', capabilities: ['C1'], acceptance: 'ok' }]
  }));
  assert.deepStrictEqual(missingCapabilities(spec, ['C1']), ['C3']);
});

test('buildSpecMessages 明确禁止只改适配层', () => {
  const messages = buildSpecMessages({ goal: '实现和 SnowLuma 一样的功能' });
  assert.strictEqual(messages.length, 2);
  assert.match(messages[0].content, /适配层/);
  assert.match(messages[1].content, /SnowLuma/);
});
