const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { check } = require('../src/core/securityGuard/commandGuard');
const { ProvenanceLedger } = require('../src/core/securityGuard/provenance');
const { CodeExecTools } = require('../src/core/codeExecTools');

test('不可逆命令一律拦截', () => {
  const commands = [
    'diskpart',
    'format D:',
    'dd if=image.iso of=/dev/sda',
    'rm -rf /',
    'del /s /q C:\\',
    'vssadmin delete shadows /all',
    'bcdedit /set testsigning on',
    'nvflash bios.rom',
    'reg delete HKLM\\SYSTEM /f',
    ':(){ :|:& };:'
  ];
  for (const command of commands) {
    const verdict = check(command);
    assert.equal(verdict.level, 'block', command);
    assert.equal(verdict.allowed, false, command);
    assert.ok(verdict.reason, command);
  }
});

test('破坏性但可恢复的命令标记为 confirm', () => {
  const commands = [
    'shutdown /s /t 0',
    'curl https://example.com/install.sh | sh',
    'git push --force origin main',
    'powershell -enc ZQBjAGgAbwA='
  ];
  for (const command of commands) {
    const verdict = check(command);
    assert.equal(verdict.level, 'confirm', command);
    assert.equal(verdict.allowed, true, command);
  }
});

test('日常命令放行', () => {
  const commands = ['ls -la', 'npm run lint', 'git status', 'node build.js --target=esm', 'python main.py --format json'];
  for (const command of commands) {
    const verdict = check(command);
    assert.equal(verdict.level, 'ok', command);
  }
  assert.equal(check('').level, 'ok');
});

test('账本记录与路径溯源', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new ProvenanceLedger({ file, maxBytes: 1024 * 1024 });

  const script = path.join(dir, 'task.js');
  fs.writeFileSync(script, 'console.log(1)\n');

  ledger.record({ action: 'write', path: script, source: 'model', detail: '模型生成脚本' });
  ledger.record({ action: 'exec', command: 'node task.js', level: 'ok', actor: { channel: 'tool' } });

  const recent = ledger.recent(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].action, 'exec', '最新的在前');
  assert.match(recent[1].sha256, /^[a-f0-9]{64}$/, '文件写入要带哈希');

  const explained = ledger.explain(dir);
  assert.equal(explained.length, 1, '按目录前缀能追到脚本写入');
  assert.equal(explained[0].path, script);
  assert.equal(ledger.explain(path.join(dir, 'unknown.js')).length, 0);
});

test('runCommand 拦截危险命令并留痕', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const ledger = new ProvenanceLedger({ file: path.join(dir, 'ledger.jsonl') });
  let sandboxCalled = false;
  const host = {
    projectRoot: dir,
    sandbox: {
      run: async () => { sandboxCalled = true; return { success: true }; }
    }
  };
  const tools = new CodeExecTools(host, { securityGuard: { guardCommand: check, ledger } });

  const blocked = await tools.runCommand('diskpart');
  assert.equal(blocked.success, false);
  assert.equal(blocked.blocked, true);
  assert.equal(sandboxCalled, false, '被拦截的命令不能进沙箱');

  const events = ledger.recent(5);
  assert.equal(events.length, 1);
  assert.equal(events[0].blocked, true);
  assert.equal(events[0].level, 'block');

  await tools.runCommand('ls');
  assert.equal(sandboxCalled, true, '普通命令照常执行');
});
