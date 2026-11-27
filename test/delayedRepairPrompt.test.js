'use strict';

// 修复迟疑 → 提示词接线（「阻尼不能是暗账」这一条判据的落点）：
//   1. 没有迟疑时该段严格空串，拼接结果与旧提示词逐字节相同
//   2. 有迟疑时该段真的进 buildSystemPrompt（不是只算不用）
//   3. 文案只写行为轮廓：迟半拍 / 可以含糊 / 两天后自然过去 / 不追加旧账
// 用 Object.create 走原型，避开构造期的 API 装配，断言行为而不碰实现细节。

const test = require('node:test');
const assert = require('node:assert/strict');

const OutputModule = require('../src/core/output');

const MARK = '【还有一句没接住】';

// 吞掉用例里预期的 console 输出
function silence(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// 造一个「除情绪/迟疑外全是空段」的输出模块：只留要断言的那段可见
function makeOutput() {
  const om = Object.create(OutputModule.prototype);
  om.buildIdentityPrompt = () => '';
  om.buildMemoryPrompt = () => '';
  om.maybeRefreshSelfModel = () => {};
  om.buildStylePrompt = () => '';
  om.buildRelationPrompt = () => '';
  om.buildRecentSelfPromptFromHistory = () => '';
  om.buildAddressPrompt = () => '';
  om.appendAffectionInstruction = (prompt) => prompt;
  om.logPrefixDiff = () => {};
  om.sessionManager = { buildCharacterPrompt: () => 'x'.repeat(60) };
  om.appointmentBook = null;
  om.privateLife = null;
  om.memoryModule = {};
  return om;
}

test('P1：没有迟疑（null / undefined / 非对象）时严格返回空串', () => {
  const om = makeOutput();
  assert.equal(om.buildDelayedRepairSection(null), '');
  assert.equal(om.buildDelayedRepairSection(undefined), '');
  assert.equal(om.buildDelayedRepairSection('x'), '');
  assert.equal(om.buildDelayedRepairSection(0), '');
});

test('P2：有迟疑时给出行为轮廓——迟半拍、可以含糊、两天后过去、不追加旧账', () => {
  const om = makeOutput();
  const at = Date.now() - 5 * 60 * 60 * 1000;
  const text = om.buildDelayedRepairSection({ at, gap: 3, expireAt: Date.now() + 1000, fromScore: -10 });

  assert.ok(text.includes(MARK));
  assert.ok(text.includes('迟了半拍'));
  assert.ok(text.includes('不必把原因全说清'));      // 明账留白：不逼出全部原因
  assert.ok(text.includes('两天之内'));
  assert.ok(text.includes('别再翻这笔旧账'));        // 恢复后不追加旧账
  assert.ok(text.includes('5 小时'), '挂了多久要说得出，才像自己的账');
  // 不该把内部数值直接漏进她的语气里
  assert.ok(!text.includes('-10'), '不应把分数写进提示词');
  assert.ok(!text.includes('gap'), '不应把内部字段名写进提示词');
});

test('P3：at 缺失时仍成立，只是不报具体小时数', () => {
  const om = makeOutput();
  const text = om.buildDelayedRepairSection({ gap: 3 });
  assert.ok(text.includes(MARK));
  assert.ok(text.includes('还挂在那里'));
  assert.ok(!text.includes('挂了 1 小时'));
});

test('P4：迟疑段真的进了 buildSystemPrompt 输出（通电）', () => {
  const om = makeOutput();
  const prompt = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'happy', null, 'u1', '', null, 'role', null, 'u1', { at: Date.now(), gap: 3 }));
  assert.ok(prompt.includes(MARK));
});

test('P5：不传 / 传 null 拼出的提示词逐字节相同（没有迟疑就不改旧行为）', () => {
  const om = makeOutput();
  const a = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'happy', null, 'u1', '', null, 'role', null, 'u1'));
  const b = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'happy', null, 'u1', '', null, 'role', null, 'u1', null));
  assert.equal(a, b);
  assert.ok(!a.includes(MARK));
});
