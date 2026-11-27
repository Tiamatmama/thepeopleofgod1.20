'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const CodingLoop = require('../src/core/codingLoop');
const { normalizeWebCheck } = require('../src/core/webCheck');

// 合法基线：后续用例只改一处，保证失败原因可定位
function validSpec(overrides = {}) {
  return {
    start: { command: 'node', args: ['server.js'], readyPath: '/' },
    steps: [
      { type: 'open', path: '/' },
      { type: 'assert', selector: '#login', text: '登录' }
    ],
    ...overrides
  };
}

function prepareLoop() {
  return new CodingLoop({
    coding: {
      dir: os.tmpdir(),
      safeTaskId: (id) => String(id || '').trim() || 't1',
      createWorkspace: () => ({ success: true })
    },
    outputModule: {},
    toolRegistry: {}
  });
}

// ---- normalizeWebCheck：非法声明一律抛错（fail-closed）----

test('normalizeWebCheck：null/undefined → null（未声明不改旧行为）', () => {
  assert.equal(normalizeWebCheck(null), null);
  assert.equal(normalizeWebCheck(undefined), null);
});

test('normalizeWebCheck：非对象 → throw', () => {
  for (const bad of ['x', 1, [], true]) {
    assert.throws(() => normalizeWebCheck(bad), /webCheck 必须是对象/);
  }
});

test('normalizeWebCheck：既无 start 也无 baseUrl → throw', () => {
  assert.throws(() => normalizeWebCheck({ steps: [{ type: 'open', path: '/' }] }), /需要 start/);
});

test('normalizeWebCheck：空 steps / 非数组 / 超过 50 条 → throw', () => {
  assert.throws(() => normalizeWebCheck(validSpec({ steps: [] })), /非空数组/);
  assert.throws(() => normalizeWebCheck(validSpec({ steps: 'x' })), /非空数组/);
  const many = Array.from({ length: 51 }, () => ({ type: 'open', path: '/' }));
  assert.throws(() => normalizeWebCheck(validSpec({ steps: many })), /最多 50 条/);
});

test('normalizeWebCheck：非法 type → throw', () => {
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'scroll', path: '/' }] })),
    /type 不支持/
  );
});

test('normalizeWebCheck：open 缺 path/url 或 path 不以 / 开头 → throw', () => {
  assert.throws(() => normalizeWebCheck(validSpec({ steps: [{ type: 'open' }] })), /需要 url/);
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'open', path: 'index.html' }] })),
    /需要 url/
  );
});

test('normalizeWebCheck：assert selector 必填且判据不足 → throw', () => {
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'assert', text: '登录' }] })),
    /selector 不能为空/
  );
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'assert', selector: '   ' }] })),
    /selector 不能为空/
  );
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'assert', selector: '#a' }] })),
    /至少需要 text\/visible\/urlContains/
  );
});

test('normalizeWebCheck：click 缺 expect / expect 判据不足 → throw', () => {
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'click', selector: '#submit' }] })),
    /expect 必填/
  );
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'click', selector: '#submit', expect: { visible: true } }] })),
    /至少需要 selector\/text\/urlContains/
  );
});

test('normalizeWebCheck：type 缺 text / wait 缺 ms 与 selector → throw', () => {
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'type', selector: '#user' }] })),
    /text 必须是字符串/
  );
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'wait' }] })),
    /需要 ms 或 selector/
  );
});

test('normalizeWebCheck：start.command 白名单校验（取 basename、忽略 .exe）', () => {
  assert.throws(
    () => normalizeWebCheck(validSpec({ start: { command: 'powershell' } })),
    /不在白名单/
  );
  assert.throws(
    () => normalizeWebCheck(validSpec({ start: { command: 'C:/Windows/System32/cmd.exe' } })),
    /不在白名单/
  );
  // 白名单内的绝对路径仍放行
  const ok = normalizeWebCheck(validSpec({ start: { command: 'C:/Program Files/nodejs/node.exe', args: ['server.js'] } }));
  assert.equal(ok.start.command, 'C:/Program Files/nodejs/node.exe');
});

test('normalizeWebCheck：超长文本 / 非法 baseUrl → throw', () => {
  assert.throws(
    () => normalizeWebCheck(validSpec({ steps: [{ type: 'assert', selector: '#a', text: 'x'.repeat(2001) }] })),
    /超过 2000 字符/
  );
  assert.throws(() => normalizeWebCheck(validSpec({ baseUrl: 'ftp://example.com' })), /必须是 http/);
  assert.throws(() => normalizeWebCheck(validSpec({ baseUrl: 'not a url' })), /不是合法 URL/);
});

// ---- normalizeWebCheck：合法声明归一化 ----

test('normalizeWebCheck：start 缺省字段补齐（args/readyPath/readyTimeoutMs/env）', () => {
  const out = normalizeWebCheck({ start: { command: 'npm' }, steps: [{ type: 'wait', ms: 100 }] });
  assert.deepEqual(out.start.args, []);
  assert.equal(out.start.readyPath, '/');
  assert.equal(out.start.readyTimeoutMs, 120000);
  assert.deepEqual(out.start.env, {});
});

test('normalizeWebCheck：readyPath 自动补 /，baseUrl 去掉尾斜杠', () => {
  const out = normalizeWebCheck({
    start: { command: 'node', readyPath: 'health' },
    baseUrl: 'http://127.0.0.1:3000/',
    steps: [{ type: 'open', path: '/' }]
  });
  assert.equal(out.start.readyPath, '/health');
  assert.equal(out.baseUrl, 'http://127.0.0.1:3000');
});

test('normalizeWebCheck：viewport / timeoutMs 越界收敛到边界', () => {
  const out = normalizeWebCheck(validSpec({ viewport: { width: 1, height: 99999 }, timeoutMs: 1 }));
  assert.deepEqual(out.viewport, { width: 320, height: 2160 });
  assert.equal(out.timeoutMs, 5000);

  const big = normalizeWebCheck(validSpec({ timeoutMs: 999999999 }));
  assert.equal(big.timeoutMs, 300000);
});

test('normalizeWebCheck：steps 字段归一化（visible 默认 true / text 转数组 / expect 超时收敛）', () => {
  const out = normalizeWebCheck(validSpec({
    steps: [
      { type: 'open', path: '/login' },
      { type: 'assert', selector: '#login', text: '登录' },
      { type: 'type', selector: '#user', text: 'admin', submit: true },
      { type: 'click', selector: '#submit', expect: { selector: '#welcome', text: '欢迎', timeoutMs: 1 } },
      { type: 'wait', ms: 50, selector: '#welcome' }
    ]
  }));
  assert.deepEqual(out.steps[0], { type: 'open', path: '/login' });
  assert.deepEqual(out.steps[1].text, ['登录']);
  assert.equal(out.steps[1].visible, true);
  assert.equal(out.steps[2].submit, true);
  assert.deepEqual(out.steps[3].expect.text, ['欢迎']);
  assert.equal(out.steps[3].expect.timeoutMs, 500); // 下限 500ms
  assert.equal(out.steps[4].ms, 50);
  assert.equal(out.steps[4].selector, '#welcome');
});

test('normalizeWebCheck：合法声明返回完整结构', () => {
  const out = normalizeWebCheck(validSpec());
  assert.deepEqual(Object.keys(out).sort(), ['baseUrl', 'start', 'steps', 'timeoutMs', 'viewport']);
  assert.equal(out.baseUrl, null);
  assert.deepEqual(out.viewport, { width: 1280, height: 800 });
  assert.equal(out.steps.length, 2);
});

// ---- CodingLoop：未声明 webCheck 时行为不变 ----

test('CodingLoop.prepare：未声明 webCheck → null；合法声明 → 归一化结果', () => {
  const loop = prepareLoop();
  const bare = loop.prepare({ userId: 'u1', taskId: 't1', goal: 'g' });
  assert.equal(bare.webCheck, null);

  const withSpec = loop.prepare({ userId: 'u1', taskId: 't1', goal: 'g', webCheck: validSpec() });
  assert.equal(withSpec.webCheck.steps.length, 2);
});

test('CodingLoop.prepare：非法 webCheck → 抛错并指明是声明问题', () => {
  const loop = prepareLoop();
  assert.throws(
    () => loop.prepare({ userId: 'u1', taskId: 't1', goal: 'g', webCheck: { steps: [] } }),
    /webCheck 声明非法/
  );
});

function evaluateLoop(runTestsResult) {
  return new CodingLoop({
    coding: { dir: os.tmpdir() },
    outputModule: {},
    toolRegistry: {
      codeDiagnose: async () => ({ success: true, checked: 1, errorCount: 0, errors: [] }),
      codeRunTests: async () => runTestsResult
    }
  });
}

const PASS_RESULT = {
  success: true,
  exitCode: 0,
  counts: { known: true, ran: 1, passed: 1, failed: 0, skipped: 0, failedNames: [] },
  failures: []
};

test('CodingLoop.evaluate：未声明 webCheck → ok=true 且 verdict=unverified', async () => {
  const loop = evaluateLoop(PASS_RESULT);
  const check = await loop.evaluate({ userId: 'u1', taskId: 't1', passCommand: 'node --test' });
  assert.equal(check.ok, true);
  assert.equal(check.verdict, 'unverified');
  assert.equal(check.webCheck, null);
});

test('CodingLoop.evaluate：前序判据未过时不进入页面验收（verdict 保持 unverified）', async () => {
  const loop = new CodingLoop({
    coding: { dir: os.tmpdir() },
    outputModule: {},
    toolRegistry: {
      codeDiagnose: async () => ({ success: true, errorCount: 1, errors: [{ message: '语法错误' }] }),
      codeRunTests: async () => PASS_RESULT
    }
  });
  const check = await loop.evaluate({
    userId: 'u1',
    taskId: 't1',
    passCommand: 'node --test',
    webCheck: validSpec()
  });
  assert.equal(check.ok, false);
  assert.equal(check.errorKind, 'diagnoseError');
  assert.equal(check.verdict, 'unverified');
  assert.equal(check.webCheck, null);
});

test('CodingLoop.stallSignature：不同页面失败步骤产生不同签名', () => {
  const loop = evaluateLoop(PASS_RESULT);
  const a = loop.stallSignature({ errorKind: 'webCheck', failed: 1, failedNames: ['webCheck:2:assert'] });
  const b = loop.stallSignature({ errorKind: 'webCheck', failed: 1, failedNames: ['webCheck:3:click'] });
  assert.notEqual(a, b);
  assert.equal(a, loop.stallSignature({ errorKind: 'webCheck', failed: 1, failedNames: ['webCheck:2:assert'] }));
});
