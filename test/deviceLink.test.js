'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeviceLinkClient, normalizeBodyState } = require('../src/core/deviceLinkClient');
const TOOL_DEFINITIONS = require('../src/core/toolDefinitions');

const originalFetch = global.fetch;

function stubFetch(handler) {
  global.fetch = async (url, init) => handler(String(url), init || {});
}

function jsonResponse(payload, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => payload };
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('D1：状态白名单收敛：只留能读懂的字段，非法值丢弃', () => {
  const state = normalizeBodyState({
    mode: 'executing',
    battery: 87.4,
    joints: { head_yaw: 1.234, r_shoulder: '60', broken: 'x' },
    source: 'ros2',
    lastSkill: { id: 3, action: 'wave' },
    online: true,
    port: '/dev/ttyUSB0'
  });
  assert.deepEqual(state.joints, { head_yaw: 1.23, r_shoulder: 60 });
  assert.equal(state.mode, 'executing');
  assert.equal(state.battery, 87.4);
  assert.equal(state.online, true);
  assert.equal('port' in state, false);

  assert.equal(normalizeBodyState(null), null);
  assert.equal(normalizeBodyState({}), null);
});

test('D2：bodyState 用最近一次快照，不额外发请求', () => {
  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  client.ready = true;
  client.serialStatus = { mode: 'idle', battery: 90, joints: { head_yaw: 0 } };
  const state = client.bodyState();
  assert.equal(state.mode, 'idle');
  assert.equal(state.online, true);
  assert.equal(client.bodyState.call({ serialStatus: null, ready: true }), null);
});

test('D3：动作成功后回读状态，结果里带 state 与一句话摘要', () => {
  const calls = [];
  stubFetch((url, init) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/v1/actions')) {
      return jsonResponse({ ok: true, result: { success: true, id: 7, action: 'wave' } });
    }
    return jsonResponse({
      ok: true,
      actions: ['wave', 'nod'],
      serial: { mode: 'executing', battery: 76, joints: { r_shoulder: 60, r_elbow: 0 }, online: true }
    });
  });

  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  client.enabled = true;
  return client.enqueue('wave', { source: 'tool' }).then((result) => {
    assert.equal(result.success, true);
    assert.equal(result.state.mode, 'executing');
    assert.equal(result.summary.includes('模式 executing'), true);
    assert.equal(result.summary.includes('电量 76%'), true);
    // 先下发动作，再读状态
    assert.equal(calls[0].url.endsWith('/v1/actions'), true);
    assert.equal(calls[1].url.endsWith('/v1/capabilities'), true);
    // 回读顺带刷新动作表，平台恢复后 robot_action 也能重新上架
    assert.deepEqual(client.listActionNames(), ['wave', 'nod']);
  });
});

test('D4：回读失败不影响动作结果，只是少一条状态', () => {
  stubFetch((url) => {
    if (url.endsWith('/v1/actions')) {
      return jsonResponse({ ok: true, result: { success: true, id: 8, action: 'nod' } });
    }
    return jsonResponse({ ok: false, error: 'body offline' }, false);
  });

  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  return client.enqueue('nod').then((result) => {
    assert.equal(result.success, true);
    assert.equal('state' in result, false);
    assert.equal('summary' in result, false);
    assert.equal(client.lastError, 'body offline');
  });
});

test('D5：动作本身失败时不回读状态', async () => {
  let stateReads = 0;
  stubFetch((url) => {
    if (url.endsWith('/v1/actions')) {
      return jsonResponse({ ok: true, result: { success: false, error: '被拒绝' } });
    }
    stateReads += 1;
    return jsonResponse({ ok: true, serial: { mode: 'idle' } });
  });

  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  const result = await client.enqueue('wave');
  assert.equal(result.success, false);
  assert.equal(stateReads, 0);
});

test('D6：check_body 已进入工具表，且不依赖动作参数', () => {
  const def = TOOL_DEFINITIONS.find(item => item.function.name === 'check_body');
  assert.ok(def);
  assert.deepEqual(def.function.parameters.properties, {});
  assert.deepEqual(def.function.parameters.required, []);
});

test('D7：平台拒绝这条动作（4xx）不算链路掉线，工具不摘', async () => {
  stubFetch(() => jsonResponse({ ok: false, error: '没有这个动作：nope' }, false));
  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  client.ready = true;
  const result = await client.enqueue('nope');
  assert.equal(result.success, false);
  assert.equal(result.error.includes('设备平台拒绝'), true);
  assert.equal(client.ready, true);
});

test('D8：动作前后关节变化 → motion=moved，并给出变化量', async () => {
  stubFetch((url) => {
    if (url.endsWith('/v1/actions')) {
      return jsonResponse({ ok: true, result: { success: true, id: 1, action: 'wave' } });
    }
    return jsonResponse({ ok: true, serial: { mode: 'idle', joints: { r_shoulder: 60, head_yaw: 0 } } });
  });
  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  client.ready = true;
  client.serialStatus = { mode: 'idle', joints: { r_shoulder: 0, head_yaw: 0 } };
  const result = await client.enqueue('wave');
  assert.equal(result.motion.verdict, 'moved');
  assert.equal(result.motion.maxDelta, 60);
  assert.deepEqual(result.motion.joints, { r_shoulder: 60 });
});

test('D9：动作后完全没动 → 复核一次后判 still，摘要里说清楚', async () => {
  let stateReads = 0;
  stubFetch((url) => {
    if (url.endsWith('/v1/actions')) {
      return jsonResponse({ ok: true, result: { success: true, id: 2, action: 'wave' } });
    }
    stateReads += 1;
    return jsonResponse({ ok: true, serial: { mode: 'idle', joints: { r_shoulder: 0 } } });
  });
  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  client.ready = true;
  client.serialStatus = { mode: 'idle', joints: { r_shoulder: 0 } };
  const result = await client.enqueue('wave');
  assert.equal(result.motion.verdict, 'still');
  assert.equal(result.summary.includes('可能没动或被卡住'), true);
  assert.equal(stateReads, 2);
});

test('D10：还在执行中或没有关节数据时不判「没动」', async () => {
  const client = new DeviceLinkClient({ baseUrl: 'http://stub', token: 't' });
  assert.equal(client.describeMotion(
    { joints: { r_shoulder: 0 } },
    { mode: 'executing', joints: { r_shoulder: 0 } }
  ).verdict, 'unknown');
  assert.equal(client.describeMotion({ mode: 'idle' }, { mode: 'idle' }).verdict, 'unknown');
  assert.equal(client.describeMotion(null, { joints: { r_shoulder: 1 } }).verdict, 'unknown');
});
