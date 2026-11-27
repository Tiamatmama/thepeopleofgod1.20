const test = require('node:test');
const assert = require('node:assert');

const scene = require('../src/core/scene');

test('没有任何位置线索时返回 unknown，并给出“不假设”的硬规则', () => {
  const result = scene.deriveScene({
    history: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的' }
    ]
  });
  assert.strictEqual(result.place, null);
  assert.strictEqual(result.together, null);

  const hint = scene.formatSceneHint(result);
  assert.ok(hint.includes('不确定'));
  assert.ok(hint.includes('开门'));
  assert.ok(hint.includes('不要假设地点'));
});

test('用户说“到家了”能推出地点，且只认白名单里的地点', () => {
  const result = scene.deriveScene({
    history: [{ role: 'user', content: '我到家了，刚换完鞋' }]
  });
  assert.strictEqual(result.place, '家');
  assert.ok(result.confidence > 0);

  const hint = scene.formatSceneHint(result);
  assert.ok(hint.includes('家'));
  assert.ok(hint.includes('没写到的不要自行补全'));
});

test('后出现的“在门外”覆盖更早的“在客厅”，并判为不在一起', () => {
  const result = scene.deriveScene({
    history: [
      { role: 'user', content: '我在客厅等你' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '我到门外了，在门口' }
    ]
  });
  assert.strictEqual(result.place, '门外');
  assert.strictEqual(result.together, false);
  assert.ok(scene.formatSceneHint(result).includes('不在一起'));
});

test('“在你旁边”判为在一起', () => {
  const result = scene.deriveScene({
    history: [
      { role: 'user', content: '我在你旁边躺着呢' },
      { role: 'assistant', content: '嗯' }
    ]
  });
  assert.strictEqual(result.together, true);
  assert.ok(scene.formatSceneHint(result).includes('同一个空间'));
});

test('历史没有时用长期记忆补位，过旧的记忆不再算数', () => {
  const now = Date.parse('2026-11-18T12:00:00+08:00');
  const fresh = scene.deriveScene({
    history: [],
    memories: [{ text: '我们住在家里，养了一只猫', timestamp: now - 86400000 }],
    now
  });
  assert.strictEqual(fresh.place, '家');

  const stale = scene.deriveScene({
    history: [],
    memories: [{ text: '我们住在家里，养了一只猫', timestamp: now - 60 * 86400000 }],
    now
  });
  assert.strictEqual(stale.place, null);
  assert.strictEqual(stale.together, null);
});

test('extract 只取白名单地点，不把整句原文带进提示词', () => {
  const found = scene.extract('我在公司楼下的咖啡店，等会儿去会议室');
  assert.ok(found.places.includes('公司'));
  assert.ok(!JSON.stringify(found).includes('咖啡店'));
});

test('位置归属分得清“他”和“你”：用户说的“到门外”写成“他在门外”', () => {
  const userOutside = scene.deriveScene({
    history: [{ role: 'user', content: '我到门外了' }]
  });
  assert.strictEqual(userOutside.place, '门外');
  assert.strictEqual(userOutside.placeOwner, 'user');
  assert.ok(scene.formatSceneHint(userOutside).includes('他在门外'));

  const herInside = scene.deriveScene({
    history: [{ role: 'assistant', content: '我在卧室' }]
  });
  assert.strictEqual(herInside.place, '卧室');
  assert.strictEqual(herInside.placeOwner, 'assistant');
  assert.ok(scene.formatSceneHint(herInside).includes('你此刻在卧室'));
});

test('两个人各自的位置都说过时，提示词两句都写出来', () => {
  const result = scene.deriveScene({
    history: [
      { role: 'user', content: '我在客厅' },
      { role: 'assistant', content: '我在卧室' }
    ]
  });
  const hint = scene.formatSceneHint(result);
  assert.ok(hint.includes('他此刻在客厅'));
  assert.ok(hint.includes('你此刻在卧室'));
});

test('渠道声明“面对面”时作为弱证据，不覆盖对话里的反证', () => {
  const web = scene.deriveScene({ history: [], channelTogether: true });
  assert.strictEqual(web.together, true);
  assert.ok(scene.formatSceneHint(web).includes('同一个空间'));

  const conflict = scene.deriveScene({
    history: [{ role: 'user', content: '我到门外了' }],
    channelTogether: true
  });
  assert.strictEqual(conflict.together, false, '对话里的明确位置优先于渠道默认');
});

test('活动描述去掉重复的“我正在”，不会拼出“你正在正在”', () => {
  const result = scene.deriveScene({
    history: [{ role: 'assistant', content: '我正在看电视' }]
  });
  const hint = scene.formatSceneHint(result);
  assert.ok(hint.includes('你正在看电视'));
  assert.ok(!hint.includes('正在正在'));
});
