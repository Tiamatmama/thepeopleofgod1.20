'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RelayHub } = require('../src/core/relayHub');

// 中转站对没令牌的请求一律 403：令牌留空 = 谁都连不上，Claude Code 只会在日志里
// 留一句「认证失败」。本地中转站必须在启动时自己补齐一枚令牌，否则「联通」永远是坏的。
test('中转站令牌为空：启动时自动生成并落盘', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-token-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const relayDir = path.join(dataDir, 'relay');
  fs.mkdirSync(relayDir, { recursive: true });
  const configPath = path.join(relayDir, 'config.json');
  const seed = {
    enabled: true,
    authToken: '',
    channels: [{ id: 'main', label: 'main', endpoint: 'https://example.test/v1', apiKey: 'k', model: 'deepseek' }],
    aliases: { main: ['deepseek'] }
  };
  fs.writeFileSync(configPath, JSON.stringify(seed));

  const hub = new RelayHub({ dataDir });

  assert.ok(hub.config.authToken.length >= 24, '令牌必须被补上，且够长');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.authToken, hub.config.authToken, '生成后要立刻落盘，重启后仍然是同一枚');
});

test('中转站令牌非空：不覆盖用户已配置的值', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-token-keep-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const relayDir = path.join(dataDir, 'relay');
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({
    enabled: true,
    authToken: 'user-token-1234567890',
    channels: [{ id: 'main', label: 'main', endpoint: 'https://example.test/v1', apiKey: 'k', model: 'deepseek' }],
    aliases: { main: ['deepseek'] }
  }));

  const hub = new RelayHub({ dataDir });

  assert.equal(hub.config.authToken, 'user-token-1234567890');
});
