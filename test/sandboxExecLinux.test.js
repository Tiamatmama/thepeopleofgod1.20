const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SandboxExec = require('../src/core/sandboxExec');

// Linux 分支的纯逻辑与脚本约定：这些用例不依赖真的 Linux，Windows 上也能跑
function linuxSandbox(overrides = {}) {
  return new SandboxExec({
    platform: 'linux',
    projectRoot: path.join(__dirname, '..'),
    available: true,
    env: {},
    ...overrides
  });
}

test('buildShellScript 用 LF、无 chcp，并保留命令原文', () => {
  const text = SandboxExec.buildShellScript('echo 你好 && ls');
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.ok(!text.includes('\r'), '命令脚本不能带 CRLF');
  assert.ok(!text.includes('chcp'));
  assert.ok(text.includes('echo 你好 && ls'));
});

test('buildStreamShell 用单引号转义并重定向 prompt', () => {
  const text = SandboxExec.buildStreamShell("/opt/it's/bin", ['-p', "a'b"], '/tmp/prompt.txt');
  assert.ok(text.includes(`'/opt/it'\\''s/bin'`), '可执行路径里的单引号要转义');
  assert.ok(text.includes(`'a'\\''b'`), '参数里的单引号要转义');
  assert.ok(text.includes('< \'/tmp/prompt.txt\''));
  assert.ok(!text.includes('\r'));
});

test('Linux 平台默认可用性取决于 sandbox-run.sh 是否存在', () => {
  const exists = linuxSandbox().available;
  assert.strictEqual(exists, fs.existsSync(path.join(__dirname, '..', 'scripts', 'linux', 'sandbox-run.sh')));
});

test('Linux：凭据文件不是必需，通道直接可用', () => {
  const sandbox = linuxSandbox();
  assert.strictEqual(sandbox.getConfig().credentialMissing, false);
  assert.strictEqual(sandbox.resolveChannel(sandbox.getConfig()), 'ok');
  assert.strictEqual(sandbox.describe().available, true);
});

test('Linux：不可用时的提示指向 sandbox-setup.sh', () => {
  const sandbox = linuxSandbox({ available: false });
  const hint = sandbox.channelHint('unavailable');
  assert.ok(hint.includes('sandbox-setup.sh'));
});

test('linuxSupervisorArgs 传齐参数，并按权限选择 sudo / setpriv', () => {
  const sandbox = linuxSandbox();
  const config = sandbox.getConfig();
  const args = sandbox.linuxSupervisorArgs(config, {
    scriptPath: '/tmp/x.sh',
    workDir: '/tmp',
    outPath: '/tmp/x.out',
    errPath: '/tmp/x.err',
    resultPath: '/tmp/x.json'
  }, { timeoutMs: 5000 });

  const get = (flag) => args[args.indexOf(flag) + 1];
  assert.strictEqual(args[0], sandbox.linuxScriptPath);
  assert.strictEqual(get('--script'), '/tmp/x.sh');
  assert.strictEqual(get('--idle-ms'), String(config.idleMs));
  assert.strictEqual(get('--max-runtime-ms'), '5000');
  assert.strictEqual(get('--user'), config.user);
  assert.ok(args.includes('--sudo') || args.includes('--privileged'));
  // 非 root 走 sudo 时必须带 --preserve-env，否则最小环境（PATH/模型配置）会被 sudo 清掉
  if (args.includes('--sudo')) assert.ok(args.includes('--preserve-env'));
});

test('readResult 接受 Linux 监督脚本的 jobReady', () => {
  const sandbox = linuxSandbox();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pog-sbx-')), 'r.json');
  fs.writeFileSync(file, JSON.stringify({ exitCode: 0, reason: 'exited', accountMode: 'account', jobReady: true }));
  const meta = sandbox.readResult(file);
  assert.strictEqual(meta.exitCode, 0);
  assert.strictEqual(meta.reason, 'exited');
  assert.strictEqual(meta.jobReady, true);
});

test('三个 Linux 脚本存在且全部是 LF（防止 CRLF 让 bash 报错）', () => {
  for (const name of ['start.sh', 'sandbox-setup.sh', 'sandbox-run.sh']) {
    const file = path.join(__dirname, '..', 'scripts', 'linux', name);
    assert.ok(fs.existsSync(file), `${name} 应该存在`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env bash'), `${name} 需要 shebang`);
    assert.ok(!text.includes('\r'), `${name} 不能有 CRLF`);
  }
});
