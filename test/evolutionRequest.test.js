const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvolutionRequestStore } = require('../src/core/evolutionRequest');
const { ToolRegistry } = require('../src/core/toolRegistry');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pog-evo-'));
}

function makeStore(env = {}) {
  const events = [];
  const store = new EvolutionRequestStore({
    dataDir: tempDir(),
    env,
    now: () => Date.parse('2026-11-18T10:00:00+08:00'),
    timeline: { append: (scope, type, payload) => events.push({ scope, type, payload }) }
  });
  return { store, events };
}

const validPayload = {
  title: '记住语音里的约定',
  need: '能把她听到的语音内容转成文字并记进长期记忆',
  why: '最近几次语音里说的事后来都丢了，她只能假装记得',
  expected: '语音说完后能在后续对话里被召回',
  scope: 'memory',
  evidence: ['语音里约好周末去看展', '第二天问起却完全不记得'],
  source: 'role'
};

test('shadow 模式：只记录，不排期', () => {
  const { store, events } = makeStore({ EVOLUTION_MODE: 'shadow' });
  const result = store.submit(validPayload);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'proposed');
  assert.strictEqual(result.queued, false);
  assert.strictEqual(result.requiresApproval, true);

  const file = path.join(store.requestsDir, `${result.id}.json`);
  assert.ok(fs.existsSync(file));
  assert.ok(events.some((e) => e.type === 'evolution.requested'));
});

test('shadow 下批准也只留记录，不进外部队列', () => {
  const { store } = makeStore({ EVOLUTION_MODE: 'shadow' });
  const { id } = store.submit(validPayload);
  const approved = store.approve(id, { by: 'owner' });
  assert.strictEqual(approved.status, 'approved');
  assert.strictEqual(approved.queued, false);
  assert.strictEqual(store.queue().length, 0);
});

test('live 下批准才排期，领取与落地状态能走完', () => {
  const { store, events } = makeStore({ EVOLUTION_MODE: 'live' });
  const { id } = store.submit(validPayload);
  assert.strictEqual(store.approve(id).queued, true);
  assert.strictEqual(store.queue().length, 1);

  assert.strictEqual(store.claim(id, { agent: 'claude-code' }).success, true);
  const applied = store.applied(id, { note: '已加语音转写并接入记忆' });
  assert.strictEqual(applied.success, true);
  assert.strictEqual(store.get(id).status, 'applied');
  assert.ok(events.some((e) => e.type === 'evolution.applied'));
});

test('同一条诉求 30 天内不重复记录；驳回后可以重提', () => {
  const { store } = makeStore({ EVOLUTION_MODE: 'shadow' });
  const first = store.submit(validPayload);
  const second = store.submit(validPayload);
  assert.strictEqual(second.success, false);
  assert.ok(second.error.includes(first.id));

  store.reject(first.id, { reason: '暂时不做' });
  const third = store.submit(validPayload);
  assert.strictEqual(third.success, true);
});

test('每日配额默认 1 条', () => {
  const { store } = makeStore({ EVOLUTION_MODE: 'shadow' });
  assert.strictEqual(store.submit(validPayload).success, true);
  const blocked = store.submit({ ...validPayload, need: '能在你难过的时候主动换一个更轻的话题', why: '每次都不知道该不该继续问下去' });
  assert.strictEqual(blocked.success, false);
  assert.ok(blocked.error.includes('今天'));
});

test('关闭时拒绝；缺字段或过短时给出明确错误', () => {
  const { store: offStore } = makeStore({ EVOLUTION_MODE: 'off' });
  assert.strictEqual(offStore.submit(validPayload).success, false);
  assert.ok(offStore.submit(validPayload).error.includes('关闭'));

  const { store } = makeStore({ EVOLUTION_MODE: 'shadow' });
  assert.strictEqual(store.submit({ need: '短' }).success, false);
  assert.strictEqual(store.submit({ need: '需要一个新的能力' }).success, false);
});

test('字段按上限截断，证据最多 5 条，不落任何额外字段', () => {
  const { store } = makeStore({ EVOLUTION_MODE: 'shadow' });
  const { id } = store.submit({
    ...validPayload,
    need: '需'.repeat(300),
    evidence: ['一', '二', '三', '四', '五', '六', '七'],
    code: 'rm -rf /',
    filePath: '../../.env'
  });
  const record = store.get(id);
  assert.strictEqual(record.need.length, 200);
  assert.strictEqual(record.evidence.length, 5);
  assert.strictEqual(record.code, undefined);
  assert.strictEqual(record.filePath, undefined);
});

test('损坏的请求文件被跳过，不影响其它记录', () => {
  const { store } = makeStore({ EVOLUTION_MODE: 'shadow' });
  const { id } = store.submit(validPayload);
  fs.writeFileSync(path.join(store.requestsDir, 'evo_broken.json'), '{ not json');
  const all = store.list();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, id);
});

test('没接存储时工具列表里不出现 request_evolution', () => {
  const fakeThis = (evolution) => ({
    enabled: true,
    activeContext: { scope: 'role' },
    autoToolStore: { listActive: () => [] },
    deviceLink: null,
    evolution,
    applyDeviceActionDefs: ToolRegistry.prototype.applyDeviceActionDefs
  });

  const hidden = ToolRegistry.prototype.getToolDefinitions.call(fakeThis(null))
    .map((item) => item.function.name);
  assert.ok(!hidden.includes('request_evolution'));

  const shown = ToolRegistry.prototype.getToolDefinitions.call(fakeThis({ listActive: () => [] }))
    .map((item) => item.function.name);
  assert.ok(shown.includes('request_evolution'));
});

test('requestEvolution 只透传结构化字段，不把代码或路径带进存储', () => {
  let captured = null;
  const fakeThis = {
    evolution: {
      submit: (payload) => {
        captured = payload;
        return { success: true, id: 'evo_x', status: 'proposed', mode: 'shadow' };
      }
    }
  };
  const result = ToolRegistry.prototype.requestEvolution.call(fakeThis, {
    ...validPayload,
    code: 'rm -rf /',
    filePath: '../../.env'
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresApproval, true);
  assert.strictEqual(captured.code, undefined);
  assert.strictEqual(captured.filePath, undefined);
  assert.strictEqual(captured.source, 'role');
});
