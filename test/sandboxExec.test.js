'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SandboxExec = require('../src/core/sandboxExec');
const CodeIntegrity = require('../src/tools/codeIntegrity');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-exec-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'windows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'windows', 'sandbox-run.ps1'), '# stub\n');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// 沙箱不可用时，策略必须先于通道生效：不能因为没沙箱就把关机命令直接丢给宿主
test('沙箱不可用 + 关机命令：policyBlocked=true，且不走宿主通道', async () => {
  const root = makeRoot();
  try {
    const sandbox = new SandboxExec({
      projectRoot: root,
      available: false,
      tmpDir: path.join(root, 'data', 'tmp'),
      env: { SANDBOX_ENABLED: 'true', SANDBOX_MODE: 'account' }
    });
    let hostCalled = false;
    sandbox.execOnHost = () => {
      hostCalled = true;
      return Promise.resolve({ success: true });
    };

    const result = await sandbox.run('shutdown /s /t 0');

    assert.equal(hostCalled, false, '不允许落到宿主通道');
    assert.equal(result.success, false);
    assert.equal(result.sandbox.policyBlocked, true);
  } finally {
    cleanup(root);
  }
});

// 凭据文件缺失时不能静默降级成本机执行，必须可判定
test('账户模式但凭据缺失：degraded=true 且拒绝执行', async () => {
  const root = makeRoot();
  try {
    const sandbox = new SandboxExec({
      projectRoot: root,
      // 凭据文件只对 Windows account 模式强制；Linux 走 sudo/setpriv，没有凭据可缺
      platform: 'win32',
      available: true,
      tmpDir: path.join(root, 'data', 'tmp'),
      env: {
        SANDBOX_ENABLED: 'true',
        SANDBOX_MODE: 'account',
        SANDBOX_CREDENTIAL_FILE: path.join(root, 'data', 'missing-credential.json')
      }
    });
    let hostCalled = false;
    sandbox.execOnHost = () => {
      hostCalled = true;
      return Promise.resolve({ success: true });
    };

    const result = await sandbox.run('echo hi');

    assert.equal(hostCalled, false);
    assert.equal(result.success, false);
    assert.equal(result.sandbox.degraded, true);
    assert.equal(result.sandbox.policyBlocked, false);
  } finally {
    cleanup(root);
  }
});

// 空签名 {"files":{}} 不能算「校验通过」
test('codeIntegrity：空签名文件必须判定为不通过', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, '.code-signature'), JSON.stringify({ files: {} }), 'utf8');
    const integrity = new CodeIntegrity(root);
    const result = integrity.verifyIntegrity();
    assert.equal(result.valid, false);
  } finally {
    cleanup(root);
  }
});

// cmd 的重定向失败不改 ERRORLEVEL：只能靠 stderr 判出来，否则「没写成」会被报成成功
test('redirectionFailure：只认重定向类错误，普通 stderr 不误判', () => {
  assert.equal(SandboxExec.redirectionFailure('Access is denied.'), 'Access is denied');
  assert.equal(SandboxExec.redirectionFailure('拒绝访问。'), '拒绝访问');
  assert.equal(SandboxExec.redirectionFailure('系统找不到指定的路径。'), '找不到指定的路径');
  assert.equal(SandboxExec.redirectionFailure(''), null);
  assert.equal(SandboxExec.redirectionFailure(undefined), null);
  assert.equal(SandboxExec.redirectionFailure('warning: deprecated api'), null);
});

// 长驻进程只允许带白名单配置进沙箱：宿主环境里的密钥/代理不能跟着进去
test('sanitizeAgentEnv：只保留 ANTHROPIC_/CLAUDE_CODE_ 前缀，其余丢弃', () => {
  const env = SandboxExec.sanitizeAgentEnv({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:41888/relay',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    OPENAI_API_KEY: 'sk-secret',
    PATH: 'C:\\Windows',
    ANTHROPIC_BAD: 'line1\nline2',
    ANTHROPIC_LONG: 'x'.repeat(600)
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT']);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:41888/relay');
});

// 多行 prompt 不能进命令行：必须落成 stdin 重定向，命令行里只留开关
test('buildStreamBatch：可执行文件与 prompt 都走带引号路径 + stdin 重定向', () => {
  const batch = SandboxExec.buildStreamBatch(
    'C:\\Program Files\\claude\\claude.exe',
    ['-p', '--output-format', 'stream-json'],
    'C:\\tmp dir\\run.prompt'
  );
  assert.match(batch, /^@echo off/);
  assert.match(batch, /"C:\\Program Files\\claude\\claude\.exe" "-p" "--output-format" "stream-json" < "C:\\tmp dir\\run\.prompt"/);
  assert.match(batch, /exit \/b %ERRORLEVEL%/);
});

// 通道不可用时不能靠「宿主直跑」蒙混过关：默认拒绝启动
test('startStreamed：凭据缺失且未显式放行宿主时拒绝启动', async () => {
  const root = makeRoot();
  try {
    const sandbox = new SandboxExec({
      projectRoot: root,
      // 凭据文件只对 Windows account 模式强制；Linux 走 sudo/setpriv，没有凭据可缺
      platform: 'win32',
      available: true,
      tmpDir: path.join(root, 'data', 'tmp'),
      env: {
        SANDBOX_ENABLED: 'true',
        SANDBOX_MODE: 'account',
        SANDBOX_CREDENTIAL_FILE: path.join(root, 'data', 'missing-credential.json')
      }
    });

    const handle = sandbox.startStreamed('C:\\Windows\\System32\\whoami.exe', ['/all'], { cwd: root });

    assert.equal(handle.success, false);
    assert.match(handle.error, /已拒绝启动/);
    assert.equal(handle.sandbox.degraded, true);
  } finally {
    cleanup(root);
  }
});
