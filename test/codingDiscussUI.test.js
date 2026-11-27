'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingCenter = require('../src/core/coding');
const CodingTeam = require('../src/core/codingTeam');
const CodingBoard = require('../public/coding-board');

// 哲学协议 L0 观测默认开启（shadow），会给 discuss 追加「每条发言一次标注调用」。
// 本文件专注 discuss 的 fence/脱敏与调用数，显式关掉观测，保持断言只针对讨论链。
process.env.CODING_PHILOSOPHY_LIFECYCLE = 'off';

// 深化六：M1 讨论进编码页 + E32 加固（discuss 的 context/topic 未脱敏）。
// 覆盖定稿 §3.4：E32 栅栏+脱敏+入口只 fence 一次全覆盖、discussView 纯函数、立项契约。

function makeCenter(tag) {
  return new CodingCenter(fs.mkdtempSync(path.join(os.tmpdir(), `coding-discuss-${tag}-`)));
}

const SECTION_JSON = '```json\n{"consensus":["c1"],"divergences":[{"topic":"t","positions":[{"persona":"p","stance":"支持"}]}],"actions":["a1"]}\n```';

// ---- E32：discuss 的 context 进 prompt 前统一 fenceData，topic 一并脱敏 ----

test('discuss：材料与议题里的密钥先脱敏，材料进一次性栅栏，且全部 prompt 复用一个 nonce', async () => {
  const captured = [];
  const api = {
    callAPI: async (messages) => {
      captured.push(messages);
      return { choices: [{ message: { content: SECTION_JSON } }] };
    }
  };
  const team = new CodingTeam({ coding: makeCenter('fence'), skills: null, api, sessionManager: null });

  await team.discuss({
    topic: '议题里的密钥 sk-ZZZZZZZZZZZZ 怎么处理',
    context: '相关代码 key sk-ABCDEF123456 结尾'
  });

  // 默认：5 人格 × 1 轮发言 + 5 人格表决 + 3 段归纳 = 13 次调用
  assert.equal(captured.length, 13, '默认应恰好 13 次 LLM 调用');

  const nonces = new Set();
  for (const msgs of captured) {
    const user = msgs[msgs.length - 1].content;
    assert.ok(!user.includes('sk-ABCDEF123456'), '材料里的原始密钥不得进 prompt');
    assert.ok(!user.includes('sk-ZZZZZZZZZZZZ'), '议题里的原始密钥不得进 prompt');
    assert.ok(user.includes('sk-***'), '密钥应被掩码为 sk-***');
    assert.ok(user.includes('相关代码') && user.includes('结尾'), '材料正文（非密钥部分）应完整保留在栅栏内，不退化');
    assert.ok(user.includes('<idea-data-'), '材料应被一次性 nonce 栅栏包裹');
    const m = /<idea-data-([0-9a-f]+)>([\s\S]*?)<\/idea-data-\1>/.exec(user);
    assert.ok(m, '栅栏须成对闭合、且前后 nonce 一致');
    nonces.add(m[1]);
  }
  assert.equal(nonces.size, 1, '同一场讨论入口 fence 一次、下游全部复用同一个 nonce');
});

test('discuss：无 context 时不产生栅栏，议题仍被脱敏', async () => {
  const captured = [];
  const api = {
    callAPI: async (messages) => {
      captured.push(messages);
      return { choices: [{ message: { content: SECTION_JSON } }] };
    }
  };
  const team = new CodingTeam({ coding: makeCenter('nocontext'), skills: null, api, sessionManager: null });

  await team.discuss({ topic: '要不要上 sk-ABCDEF123456 这个方案' });

  for (const msgs of captured) {
    const user = msgs[msgs.length - 1].content;
    assert.ok(!user.includes('<idea-data-'), '没有材料就不该有栅栏');
    assert.ok(!user.includes('sk-ABCDEF123456'), '议题里的原始密钥不得进 prompt');
    assert.ok(user.includes('sk-***'));
  }
});

// ---- 前端纯视图函数：discussView ----

test('discussView：字段归一、按 kind 分类、缺段/脏项兜底', () => {
  const vm = CodingBoard.discussView({
    id: 'disc_1',
    topic: '要不要重构',
    orchestrator: '主控',
    rounds: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    transcript: [
      { persona: '架构师', personaId: 'arch', round: 1, kind: 'speech', text: 'S' },
      { persona: '安全', personaId: 'sec', round: 1, kind: 'rebuttal', toName: '架构师', text: 'R' },
      { persona: '产品', personaId: 'pm', round: 1, kind: 'vote', text: 'V' },
      { persona: '怪项', kind: 'wat', text: 'X' },
      null
    ],
    votes: [{ persona: '架构师', stance: '支持', reason: 'r' }, null],
    structured: {
      consensus: ['c1'],
      divergences: [{ topic: 'd', positions: [{ persona: 'a', stance: '反对' }, null] }],
      actions: ['a1']
    },
    synthesis: 's'
  });

  assert.equal(vm.id, 'disc_1');
  assert.equal(vm.topic, '要不要重构');
  assert.equal(vm.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(vm.transcript.length, 5);
  assert.equal(vm.speeches.length, 3, '非法 kind 与 null 都归 speech');
  assert.equal(vm.rebuttals.length, 1);
  assert.equal(vm.voteLines.length, 1);
  assert.equal(vm.votes.length, 2);
  assert.equal(vm.votes[1].stance, '');
  assert.deepEqual(vm.consensus, ['c1']);
  assert.deepEqual(vm.actions, ['a1']);
  assert.equal(vm.divergences[0].positions.length, 2);
  assert.equal(vm.divergences[0].positions[1].persona, '');
  assert.equal(vm.hasContent, true);

  const empty = CodingBoard.discussView(null);
  assert.deepEqual(empty.transcript, []);
  assert.deepEqual(empty.actions, []);
  assert.equal(empty.hasContent, false);
  assert.equal(empty.createdAt, '', '不可解析时间给空串，不渲染 Invalid Date');
});

// ---- 立项契约：动作 → 任务，source=discuss，失败占位不产任务 ----

test('findingsToTasks：讨论动作立成任务，source=discuss、topic 落库；失败占位不产任务', () => {
  const team = new CodingTeam({
    coding: makeCenter('commit'),
    skills: null,
    api: { callAPI: async () => ({ choices: [{ message: { content: 'x' } }] }) },
    sessionManager: null
  });
  const created = team.findingsToTasks([
    { persona: '主控', output: '补齐 discuss 的 context 脱敏' },
    { persona: '主控', output: '（主控 调用失败：timeout）' }
  ], { kind: 'discuss', topic: '深化六' });

  assert.equal(created.length, 1, '纯失败占位不产任务');
  assert.equal(created[0].params.source, 'discuss');
  assert.equal(created[0].params.topic, '深化六');
  assert.ok(created[0].title.includes('补齐 discuss 的 context 脱敏'));
  assert.equal(created[0].desc, '补齐 discuss 的 context 脱敏');
});

// ---- 回溯：讨论立项带 discussionId，review 任务不带 ----

test('findingsToTasks：讨论立项透传 params.discussionId，review 任务不含该字段', () => {
  const team = new CodingTeam({
    coding: makeCenter('discid'),
    skills: null,
    api: { callAPI: async () => ({ choices: [{ message: { content: 'x' } }] }) },
    sessionManager: null
  });

  const withId = team.findingsToTasks(
    [{ persona: '主控', output: '补齐回溯字段' }],
    { kind: 'discuss', topic: '深化七', discussionId: 'disc_123_ab' }
  );
  assert.equal(withId[0].params.discussionId, 'disc_123_ab', '讨论任务应带来源讨论 id');

  const review = team.findingsToTasks(
    [{ persona: '安全', output: '材料未脱敏' }],
    { kind: 'code', topic: '' }
  );
  assert.ok(!('discussionId' in review[0].params), 'review 任务不应出现 discussionId 字段');
});
