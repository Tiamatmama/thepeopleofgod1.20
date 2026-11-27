'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForReady } = require('../../scripts/launch.js');

test('waitForReady：首次探测即成功', async () => {
    let calls = 0;
    const result = await waitForReady({
        url: 'http://127.0.0.1:1/',
        intervalMs: 5,
        timeoutMs: 1000,
        probe: async () => { calls += 1; return true; }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
});

test('waitForReady：第 N 次探测成功', async () => {
    let calls = 0;
    const result = await waitForReady({
        intervalMs: 5,
        timeoutMs: 1000,
        probe: async () => { calls += 1; return calls >= 3; }
    });
    assert.equal(result.ok, true);
    assert.ok(calls >= 3, '应至少轮询到第 3 次');
});

test('waitForReady：始终未就绪 → 超时失败', async () => {
    const result = await waitForReady({
        intervalMs: 5,
        timeoutMs: 60,
        probe: async () => false
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
});

test('waitForReady：探测抛异常按未就绪处理，最终超时失败', async () => {
    const result = await waitForReady({
        intervalMs: 5,
        timeoutMs: 60,
        probe: async () => { throw new Error('boom'); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
});

test('waitForReady：取消（abort）→ 立即失败且原因正确', async () => {
    const controller = new AbortController();
    const pending = waitForReady({
        intervalMs: 100000,
        timeoutMs: 100000,
        probe: async () => false,
        signal: controller.signal
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'aborted');
});

test('waitForReady：已取消的 signal 直接失败', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForReady({
        intervalMs: 5,
        timeoutMs: 1000,
        probe: async () => true,
        signal: controller.signal
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'aborted');
});

test('waitForReady：成功 / 超时 / 取消三条路径都会清理定时器', async () => {
    const origClearInterval = global.clearInterval;
    const origClearTimeout = global.clearTimeout;
    let clearedInterval = 0;
    let clearedTimeout = 0;
    global.clearInterval = (...args) => { clearedInterval += 1; return origClearInterval(...args); };
    global.clearTimeout = (...args) => { clearedTimeout += 1; return origClearTimeout(...args); };

    try {
        // 成功路径
        await waitForReady({ intervalMs: 5, timeoutMs: 1000, probe: async () => true });
        assert.ok(clearedInterval >= 1, '成功路径应清理轮询 interval');
        assert.ok(clearedTimeout >= 1, '成功路径应清理超时 timeout');

        // 超时路径
        const before = clearedInterval;
        await waitForReady({ intervalMs: 5, timeoutMs: 30, probe: async () => false });
        assert.ok(clearedInterval > before, '超时路径应清理轮询 interval');
    } finally {
        global.clearInterval = origClearInterval;
        global.clearTimeout = origClearTimeout;
    }
});
