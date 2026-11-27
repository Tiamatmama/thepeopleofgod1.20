'use strict';

// 自我认知租约（定稿 §5 第 3-6 步）接线回归：
//   第 3 步 buildSelfSection 注入后回写（recordSelfTraitsUsed：off/live/shadow 三分支）
//   第 4 步 TTL 过滤按 live 生效（getSelfTraits 透传 lifecycle）
//   第 5 步 maybeRefreshSelfModel 回源重算 + 冷却（仅 live）
//   第 6 步 SELF_TRAIT_LIFECYCLE 三级开关接线
// 一律用原型对象造输出模块，避开构造期的 API 装配；断言「行为」而非 spy 实现细节。

const test = require('node:test');
const assert = require('node:assert/strict');

const OutputModule = require('../src/core/output');

const DAY = 24 * 60 * 60 * 1000;

// 吞掉用例里预期的 console.log / console.error，避免刷屏
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

// 造一个只带契约方法的记忆模块桩（baseUserKey 剥掉 __role 后缀）
function makeMemory(overrides = {}) {
  return {
    baseUserKey: (userId) => String(userId == null ? '' : userId).split('__')[0],
    ...overrides
  };
}

// 造输出模块：只补本组用例用到的字段，构造函数不入（Object.create 走原型）
function makeOutput({ memoryModule = makeMemory(), lifecycle = 'off', threshold = 2, cooldown = 6 * 60 * 60 * 1000 } = {}) {
  const om = Object.create(OutputModule.prototype);
  om.memoryModule = memoryModule;
  om.selfTraitLifecycle = lifecycle;
  om.selfModelRefreshThreshold = threshold;
  om.selfModelRefreshCooldownMs = cooldown;
  om._lastSelfModelRefreshAt = new Map();
  return om;
}

// ---- 第 3 步：recordSelfTraitsUsed 三分支 ----

test('C1：recordSelfTraitsUsed —— off 完全不触碰记忆模块', () => {
  let markCalls = 0;
  let loadCalls = 0;
  const mem = makeMemory({
    markSelfTraitsUsed: () => { markCalls++; },
    loadSelfModel: () => { loadCalls++; return { traits: [] }; }
  });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'off' });

  om.recordSelfTraitsUsed('u1', ['我很在意他有没有回消息']);

  assert.equal(markCalls, 0);
  assert.equal(loadCalls, 0);
});

test('C2：recordSelfTraitsUsed —— live 调 markSelfTraitsUsed 续租（透传 userId 与列表）', () => {
  const seen = [];
  const mem = makeMemory({ markSelfTraitsUsed: (userId, list) => { seen.push([userId, list]); return 1; } });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live' });

  om.recordSelfTraitsUsed('u1', ['甲', '乙']);

  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'u1');
  assert.deepEqual(seen[0][1], ['甲', '乙']);
});

test('C3：recordSelfTraitsUsed —— shadow 只读档打日志，绝不自写', () => {
  let markCalls = 0;
  let loadCalls = 0;
  const now = Date.now();
  const mem = makeMemory({
    markSelfTraitsUsed: () => { markCalls++; },
    loadSelfModel: () => {
      loadCalls++;
      return { traits: [{ text: '我最近很在意他有没有回消息', confidence: 0.6, useCount: 10, lastUsedAt: now, updatedAt: now }] };
    }
  });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'shadow' });

  let logged = '';
  const orig = console.log;
  console.log = (line) => { logged += String(line); };
  try {
    om.recordSelfTraitsUsed('u1', ['我最近很在意他有没有回消息']);
  } finally {
    console.log = orig;
  }

  assert.equal(markCalls, 0);   // shadow 不回写
  assert.equal(loadCalls, 1);   // 取证读了档
  assert.match(logged, /shadow/);
});

test('C4：recordSelfTraitsUsed —— live 但记忆模块无 markSelfTraitsUsed 不抛错', () => {
  const mem = makeMemory(); // 没有 markSelfTraitsUsed
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live' });

  silence(() => om.recordSelfTraitsUsed('u1', ['甲']));
  assert.ok(true);
});

// ---- 第 4 步：buildSelfSection 透传 lifecycle ----

test('C5：buildSelfSection —— 把 lifecycle 透传给 getSelfTraits，并原样拼段', () => {
  const seenOpts = [];
  const mem = makeMemory({
    getSelfTraits: (userId, limit, opts) => { seenOpts.push(opts); return ['甲', '乙']; },
    markSelfTraitsUsed: () => {}
  });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live' });

  const section = om.buildSelfSection('u1');

  assert.equal(seenOpts.length, 1);
  assert.equal(seenOpts[0].lifecycle, 'live');
  assert.match(section, /甲/);
  assert.match(section, /乙/);
});

test('C6：buildSelfSection —— 缺省 off 时 lifecycle=off 且注入不回写', () => {
  const seenOpts = [];
  let markCalls = 0;
  const mem = makeMemory({
    getSelfTraits: (userId, limit, opts) => { seenOpts.push(opts); return ['甲']; },
    markSelfTraitsUsed: () => { markCalls++; }
  });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'off' });

  om.buildSelfSection('u1');

  assert.equal(seenOpts[0].lifecycle, 'off');
  assert.equal(markCalls, 0);
  assert.equal(seenOpts.length, 1);
});

test('C7：buildSelfSection —— 无 memoryUserId 或空列表返回空串', () => {
  const mem = makeMemory({ getSelfTraits: () => [], markSelfTraitsUsed: () => {} });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live' });

  assert.equal(om.buildSelfSection(''), '');
  assert.equal(om.buildSelfSection('u1'), '');
});

// ---- 第 5 步：maybeRefreshSelfModel 回源重算 + 冷却 ----

test('C8：maybeRefreshSelfModel —— off / shadow 不触发（不花 token）', () => {
  let refreshCalls = 0;
  const mem = makeMemory({ loadSelfModel: () => ({ traits: [] }) });

  for (const lc of ['off', 'shadow']) {
    const om = makeOutput({ memoryModule: mem, lifecycle: lc });
    om.refreshSelfModel = () => { refreshCalls++; return 'R'; };
    assert.equal(om.maybeRefreshSelfModel({ userId: 'u1' }), null);
  }

  assert.equal(refreshCalls, 0);
});

test('C9：maybeRefreshSelfModel —— live 有效条目跌破阈值且过冷却 → 触发并落冷却', () => {
  const now = Date.now();
  const mem = makeMemory({
    loadSelfModel: () => ({ traits: [{ text: '我很在意他有没有回消息', confidence: 0.6, useCount: 20, lastUsedAt: now, updatedAt: now }] })
  });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live', threshold: 2 });
  let refreshArg = null;
  om.refreshSelfModel = (payload) => { refreshArg = payload; return 'R'; };

  const res = om.maybeRefreshSelfModel({ userId: 'u1__role', sessionId: 's1' });

  assert.equal(res, 'R');
  assert.deepEqual(refreshArg, { userId: 'u1__role', sessionId: 's1' });
  assert.equal(om._lastSelfModelRefreshAt.has('u1'), true); // 按 baseKey 落冷却
});

test('C10：maybeRefreshSelfModel —— 有效条目达标（≥ 阈值）不触发', () => {
  const now = Date.now();
  const alive = (text) => ({ text, confidence: 0.6, useCount: 20, lastUsedAt: now, updatedAt: now });
  const mem = makeMemory({ loadSelfModel: () => ({ traits: [alive('我很在意他有没有回消息'), alive('他回消息的时候我会安心')] }) });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live', threshold: 2 });
  let refreshCalls = 0;
  om.refreshSelfModel = () => { refreshCalls++; return 'R'; };

  assert.equal(om.maybeRefreshSelfModel({ userId: 'u1' }), null);
  assert.equal(refreshCalls, 0);
  assert.equal(om._lastSelfModelRefreshAt.size, 0);
});

test('C11：maybeRefreshSelfModel —— 冷却期内不再触发', () => {
  const now = Date.now();
  const mem = makeMemory({ loadSelfModel: () => ({ traits: [] }) });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live', threshold: 2, cooldown: 6 * 60 * 60 * 1000 });
  om._lastSelfModelRefreshAt.set('u1', now); // 刚回源过
  let refreshCalls = 0;
  om.refreshSelfModel = () => { refreshCalls++; return 'R'; };

  assert.equal(om.maybeRefreshSelfModel({ userId: 'u1' }), null);
  assert.equal(refreshCalls, 0);
});

test('C12：maybeRefreshSelfModel —— 过期 / 萎掉的条目不计入有效，仍触发', () => {
  const now = Date.now();
  const mem = makeMemory({
    loadSelfModel: () => ({
      traits: [
        // 租约过期：闲置 40 天 > TTL 30 天
        { text: '我很在意他有没有回消息', confidence: 0.6, useCount: 20, lastUsedAt: now - 40 * DAY, updatedAt: now - 40 * DAY },
        // 萎掉：置信度低 × 从没用过 → 成熟度 < 0.2
        { text: '我偶尔会想得比较多', confidence: 0.1, useCount: 0, lastUsedAt: now, updatedAt: now }
      ]
    })
  });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live', threshold: 1 });
  let refreshCalls = 0;
  om.refreshSelfModel = () => { refreshCalls++; return 'R'; };

  assert.equal(om.maybeRefreshSelfModel({ userId: 'u1' }), 'R');
  assert.equal(refreshCalls, 1);
});

test('C13：maybeRefreshSelfModel —— userId 缺失直接返回 null', () => {
  const mem = makeMemory({ loadSelfModel: () => ({ traits: [] }) });
  const om = makeOutput({ memoryModule: mem, lifecycle: 'live' });
  om.refreshSelfModel = () => { throw new Error('不该被调用'); };

  assert.equal(om.maybeRefreshSelfModel({ userId: null }), null);
  assert.equal(om.maybeRefreshSelfModel({}), null);
});

// ---- 第 6 步：SELF_TRAIT_LIFECYCLE 三级开关接线 ----

test('C14：SELF_TRAIT_LIFECYCLE 归一化 —— live/shadow 保留，其余一切非法规整为 off', () => {
  const prev = process.env.SELF_TRAIT_LIFECYCLE;
  try {
    const cases = [
      ['live', 'live'],
      ['LIVE', 'live'],
      ['shadow', 'shadow'],
      ['Shadow', 'shadow'],
      ['off', 'off'],
      ['', 'off'],
      ['true', 'off'],
      ['1', 'off'],
      ['garbage', 'off']
    ];
    for (const [raw, expected] of cases) {
      if (raw === undefined) delete process.env.SELF_TRAIT_LIFECYCLE;
      else process.env.SELF_TRAIT_LIFECYCLE = raw;
      const om = new OutputModule(makeMemory());
      assert.equal(om.selfTraitLifecycle, expected, `raw=${JSON.stringify(raw)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.SELF_TRAIT_LIFECYCLE;
    else process.env.SELF_TRAIT_LIFECYCLE = prev;
  }
});

test('C15：SELF_TRAIT_LIFECYCLE 未设置时默认 off（自主能力默认关）', () => {
  const prev = process.env.SELF_TRAIT_LIFECYCLE;
  delete process.env.SELF_TRAIT_LIFECYCLE;
  try {
    const om = new OutputModule(makeMemory());
    assert.equal(om.selfTraitLifecycle, 'off');
    assert.equal(om.selfModelRefreshThreshold, 2);
    assert.equal(om.selfModelRefreshCooldownMs, 6 * 60 * 60 * 1000);
    assert.equal(om._lastSelfModelRefreshAt instanceof Map, true);
  } finally {
    if (prev === undefined) delete process.env.SELF_TRAIT_LIFECYCLE;
    else process.env.SELF_TRAIT_LIFECYCLE = prev;
  }
});

// ---- 界线（事前自限）：注入 + 发言后字面核对 ----
// 判据只有一条：痕迹必须能被观察到地约束下一次行为，所以这里断言「注入了什么」和「核对了什么」

function boundaryItem(text, avoid = ['我什么都做不好']) {
  return { text, trigger: ['道歉'], avoid, honoredCount: 0, violatedCount: 0, createdAt: Date.now(), droppedAt: 0 };
}

test('B1：buildBoundarySection —— 注入成功时把正文与禁止片段都写进提示词，并记下本轮注入条目', () => {
  const item = boundaryItem('被道歉时别急着认错');
  const om = makeOutput({ memoryModule: makeMemory({ getBoundariesForInjection: () => [item] }) });
  om._boundaryInjections = new Map();

  const section = silence(() => om.buildBoundarySection('s1', 'u1', '对不起', 2));

  assert.match(section, /【你自己划下的界线】/);
  assert.match(section, /被道歉时别急着认错/);
  assert.match(section, /不要说：我什么都做不好/);
  assert.equal(om._boundaryInjections.get('s1|u1').items.length, 1);
});

test('B2：buildBoundarySection —— 无界线 / 无用户键 / 记忆模块不支持时返回空串', () => {
  const empty = makeOutput({ memoryModule: makeMemory({ getBoundariesForInjection: () => [] }) });
  empty._boundaryInjections = new Map();
  assert.equal(silence(() => empty.buildBoundarySection('s1', 'u1', '对不起')), '');
  assert.equal(silence(() => empty.buildBoundarySection('s1', '', '对不起')), '');
  const noApi = makeOutput({ memoryModule: makeMemory() });
  noApi._boundaryInjections = new Map();
  assert.equal(silence(() => noApi.buildBoundarySection('s1', 'u1', '对不起')), '');
});

test('B3：verifyBoundaries —— 正文没出现禁止片段记兑现，出现了记违背', () => {
  const seen = [];
  const om = makeOutput({
    memoryModule: makeMemory({ markBoundaryOutcome: (userId, text, honored) => { seen.push([text, honored]); return true; } })
  });
  om._boundaryInjections = new Map([
    ['s1|u1', { at: Date.now(), items: [boundaryItem('被道歉时别急着认错')] }]
  ]);

  silence(() => om.verifyBoundaries('s1', 'u1', '嗯，我知道了，你别放在心上'));
  assert.deepEqual(seen, [['被道歉时别急着认错', true]]);
  // 核对完即清，不跨轮重复记账
  assert.equal(om._boundaryInjections.has('s1|u1'), false);

  const violated = [];
  const om2 = makeOutput({
    memoryModule: makeMemory({ markBoundaryOutcome: (userId, text, honored) => { violated.push([text, honored]); return true; } })
  });
  om2._boundaryInjections = new Map([
    ['s1|u1', { at: Date.now(), items: [boundaryItem('被道歉时别急着认错')] }]
  ]);
  silence(() => om2.verifyBoundaries('s1', 'u1', '不用道歉，反正我什么都做不好'));
  assert.deepEqual(violated, [['被道歉时别急着认错', false]]);
});

test('B4：verifyBoundaries —— 本轮没注入过 / 距注入过久 都不记账', () => {
  let calls = 0;
  const om = makeOutput({ memoryModule: makeMemory({ markBoundaryOutcome: () => { calls++; } }) });
  om._boundaryInjections = new Map();
  silence(() => om.verifyBoundaries('s1', 'u1', '随便说点什么'));
  assert.equal(calls, 0);

  om._boundaryInjections.set('s1|u1', { at: Date.now() - 6 * 60 * 1000, items: [boundaryItem('被道歉时别急着认错')] });
  silence(() => om.verifyBoundaries('s1', 'u1', '嗯'));
  assert.equal(calls, 0);
});
