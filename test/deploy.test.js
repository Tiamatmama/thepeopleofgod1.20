'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeDeploy, runDeploy, redactSecrets } = require('../src/core/deploy');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- normalizeDeploy：非法声明 fail-closed ----

test('normalizeDeploy：null/undefined → null（未声明不改旧行为）', () => {
  assert.equal(normalizeDeploy(null), null);
  assert.equal(normalizeDeploy(undefined), null);
});

test('normalizeDeploy：非对象 → throw', () => {
  for (const bad of ['x', 1, [], true]) {
    assert.throws(() => normalizeDeploy(bad), /deploy 必须是对象/);
  }
});

test('normalizeDeploy：command 缺失/空白/超长/含 shell 元字符 → throw', () => {
  assert.throws(() => normalizeDeploy({}), /command 不能为空/);
  assert.throws(() => normalizeDeploy({ command: '   ' }), /command 不能为空/);
  assert.throws(() => normalizeDeploy({ command: 'x'.repeat(513) }), /超过 512 字符/);
  for (const bad of ['npm && rm -rf /', 'node a; b', 'node | cat', 'node > out', 'node `id`', 'node $HOME', 'node\na']) {
    assert.throws(() => normalizeDeploy({ command: bad }), /shell 元字符/);
  }
});

test('normalizeDeploy：args 必须是数组、数量/类型/长度/NUL 受控', () => {
  assert.throws(() => normalizeDeploy({ command: 'node', args: 'server.js' }), /args 必须是数组/);
  assert.throws(
    () => normalizeDeploy({ command: 'node', args: Array.from({ length: 65 }, () => 'a') }),
    /最多 64 个参数/
  );
  assert.throws(() => normalizeDeploy({ command: 'node', args: [{}] }), /必须是字符串或数字/);
  assert.throws(() => normalizeDeploy({ command: 'node', args: ['x'.repeat(4097)] }), /超过 4096 字符/);
  assert.throws(() => normalizeDeploy({ command: 'node', args: ['a\0b'] }), /不允许包含 NUL/);
  assert.deepEqual(normalizeDeploy({ command: 'node', args: ['server.js', 3000] }).args, ['server.js', '3000']);
});

test('normalizeDeploy：env 键名白名单与取值校验', () => {
  assert.throws(() => normalizeDeploy({ command: 'node', env: [] }), /env 必须是对象/);
  assert.throws(() => normalizeDeploy({ command: 'node', env: { '1BAD': 'x' } }), /键名非法/);
  assert.throws(() => normalizeDeploy({ command: 'node', env: { OK: null } }), /必须是字符串\/数字\/布尔值/);
  assert.throws(() => normalizeDeploy({ command: 'node', env: { OK: {} } }), /必须是字符串\/数字\/布尔值/);
  assert.throws(() => normalizeDeploy({ command: 'node', env: { OK: 'a\0b' } }), /不允许包含 NUL/);
  assert.throws(
    () => normalizeDeploy({ command: 'node', env: { OK: 'x'.repeat(4097) } }),
    /超过 4096 字符/
  );
  const spec = normalizeDeploy({ command: 'node', env: { PORT: 3000, DEBUG: true } });
  assert.deepEqual(spec.env, { PORT: '3000', DEBUG: 'true' });
});

test('normalizeDeploy：timeoutMs 夹到 [1000, 600000]，expectExitCode 必须 0-255 整数', () => {
  assert.equal(normalizeDeploy({ command: 'node', timeoutMs: 1 }).timeoutMs, 1000);
  assert.equal(normalizeDeploy({ command: 'node', timeoutMs: 999999999 }).timeoutMs, 600000);
  assert.equal(normalizeDeploy({ command: 'node', timeoutMs: 'abc' }).timeoutMs, 120000);
  assert.equal(normalizeDeploy({ command: 'node' }).expectExitCode, 0);
  assert.equal(normalizeDeploy({ command: 'node', expectExitCode: 3 }).expectExitCode, 3);
  for (const bad of [-1, 256, 1.5, '0', NaN]) {
    assert.throws(() => normalizeDeploy({ command: 'node', expectExitCode: bad }), /expectExitCode/);
  }
});

// ---- runDeploy：真实子进程 ----

test('runDeploy：退出码 0 → ok，返回 stdout 并脱敏命令展示串', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: { command: process.execPath, args: ['-e', "console.log('ok')", '--', '--token', 'supersecret'] },
      workspace: dir
    });
    assert.equal(result.success, true);
    assert.equal(result.ok, true);
    assert.equal(result.errorKind, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'ok');
    assert.equal(result.timedOut, false);
    assert.match(result.command, /--token \*\*\*/);
    assert.ok(!result.command.includes('supersecret'));
    assert.equal(result.cwd, path.resolve(dir));
  } finally {
    cleanup(dir);
  }
});

test('runDeploy：退出码不符 → exitCodeMismatch', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
      workspace: dir
    });
    assert.equal(result.success, false);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'exitCodeMismatch');
    assert.equal(result.exitCode, 3);
    assert.equal(result.expectExitCode, 0);
  } finally {
    cleanup(dir);
  }
});

test('runDeploy：声明了非零 expectExitCode 时按声明判定通过', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: { command: process.execPath, args: ['-e', 'process.exit(3)'], expectExitCode: 3 },
      workspace: dir
    });
    assert.equal(result.success, true);
    assert.equal(result.ok, true);
    assert.equal(result.errorKind, null);
    assert.equal(result.exitCode, 3);
  } finally {
    cleanup(dir);
  }
});

test('runDeploy：超时 → timedOut / timeout', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 1000 },
      workspace: dir
    });
    assert.equal(result.success, false);
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.errorKind, 'timeout');
  } finally {
    cleanup(dir);
  }
});

test('runDeploy：命令不存在 → spawnError', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: { command: 'definitely-not-a-real-command-xyz', args: [] },
      workspace: dir
    });
    assert.equal(result.success, false);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'spawnError');
    assert.equal(result.exitCode, null);
  } finally {
    cleanup(dir);
  }
});

test('runDeploy：cwd 越界 → invalid，且不执行命令', () => {
  const dir = makeWorkspace();
  const probe = path.join(path.dirname(dir), `deploy-probe-${Date.now()}.txt`);
  try {
    const result = runDeploy({
      spec: {
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(probe)}, 'x')`],
        cwd: '..'
      },
      workspace: dir
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'invalid');
    assert.match(result.reason, /超出工作区范围/);
    assert.equal(fs.existsSync(probe), false);
  } finally {
    cleanup(dir);
    if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
  }
});

test('runDeploy：工作区不存在 → invalid', () => {
  const result = runDeploy({
    spec: { command: process.execPath, args: ['-e', 'console.log(1)'] },
    workspace: path.join(os.tmpdir(), 'deploy-workspace-does-not-exist-xyz')
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'invalid');
});

test('runDeploy：env 生效，日志尾部截断到 4000 字符', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: {
        command: process.execPath,
        args: ['-e', "process.stdout.write(process.env.DEPLOY_TEST_VALUE + 'x'.repeat(10000))"],
        env: { DEPLOY_TEST_VALUE: 'y' }
      },
      workspace: dir
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.envKeys, ['DEPLOY_TEST_VALUE']);
    assert.equal(result.stdout.length, 4000);
    assert.ok(result.stdout.endsWith('x'.repeat(100)));
  } finally {
    cleanup(dir);
  }
});

// ---- redactSecrets ----

test('redactSecrets：password / api key / Authorization Bearer / --token 均不泄露明文', () => {
  assert.equal(redactSecrets('password=hunter2'), 'password=***');
  assert.equal(redactSecrets('api_key: "abcd1234"'), 'api_key: "***"');
  assert.ok(!redactSecrets('Authorization: Bearer sk-live-abc.def').includes('sk-live-abc'));
  assert.equal(redactSecrets('--token abc123'), '--token ***');
  assert.equal(redactSecrets('/secret topvalue'), '/secret ***');
  assert.equal(redactSecrets('普通日志没有密钥'), '普通日志没有密钥');
});

test('runDeploy：stderr 中的密钥被脱敏', () => {
  const dir = makeWorkspace();
  try {
    const result = runDeploy({
      spec: {
        command: process.execPath,
        args: ['-e', "console.error('password=letmein'); process.exit(1)"]
      },
      workspace: dir
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'exitCodeMismatch');
    assert.ok(!result.stderr.includes('letmein'));
    assert.match(result.stderr, /password=\*\*\*/);
  } finally {
    cleanup(dir);
  }
});
