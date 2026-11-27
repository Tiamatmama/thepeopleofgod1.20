'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingCenter = require('../src/core/coding');
const CodingTeam = require('../src/core/codingTeam');
const CodingBoard = require('../public/coding-board');

// 深化五：把「她的编程团队」的抓点评审接进编码页（M1）+ 运行/巡检只读展示（M2）。
// 覆盖定稿 §7：材料脱敏/栅栏、findings 结构、部分失败占位、commit 传对象、纯视图函数。

function makeCenter(tag) {
  return new CodingCenter(fs.mkdtempSync(path.join(os.tmpdir(), `coding-review-${tag}-`)));
}

// ---- M1：review 材料进 prompt 前统一走 fenceData（脱敏 + 栅栏）----

test('review：材料里的密钥先脱敏、再进一次性栅栏，且每条 finding 带稳定 personaId', async () => {
  const captured = [];
  const api = {
    callAPI: async (messages) => {
      captured.push(messages);
      return { choices: [{ message: { content: '发现：这里有个隐患' } }] };
    }
  };
  const team = new CodingTeam({ coding: makeCenter('fence'), skills: null, api, sessionManager: null });

  const res = await team.review({ target: 'key sk-ABCDEF123456 尾巴' });

  assert.equal(res.kind, 'code');
  assert.ok(res.findings.length >= 1);
  for (const f of res.findings) {
    assert.equal(typeof f.personaId, 'string');
    assert.ok(f.personaId, ' personaId 不能为空（前端据此选中/立项）');
    assert.equal(typeof f.output, 'string');
  }
  const userMsg = captured[0][1].content;
  assert.ok(userMsg.includes('sk-***'), '密钥应被掩码为 sk-***');
  assert.ok(!userMsg.includes('sk-ABCDEF123456'), '原始密钥不得进 prompt');
  assert.ok(userMsg.includes('<idea-data-'), '材料应被一次性 nonce 栅栏包裹');
  assert.ok(/<\/idea-data-[0-9a-f]+>/.test(userMsg), '栅栏须闭合');
});

test('review：某人格调用失败 → 该条为「调用失败」占位，其余正常，整体不抛', async () => {
  let n = 0;
  const api = {
    callAPI: async () => {
      if (n++ === 1) throw new Error('boom');
      return { choices: [{ message: { content: '正常发现' } }] };
    }
  };
  const team = new CodingTeam({ coding: makeCenter('partial'), skills: null, api, sessionManager: null });

  const res = await team.review({ target: 'function a(){}' });
  const failed = res.findings.filter(f => /^（.*失败.*）$/.test(f.output.trim()));
  const okOnes = res.findings.filter(f => !/^（.*失败.*）$/.test(f.output.trim()));
  assert.equal(failed.length, 1);
  assert.ok(okOnes.length >= 1);
  for (const f of okOnes) assert.equal(f.output, '正常发现');
});

// ---- M1：commit 只立收到的条目（对象数组，非下标） ----

test('findingsToTasks：只立传入条目，source=code；纯失败占位不产任务', () => {
  const team = new CodingTeam({
    coding: makeCenter('commit'),
    skills: null,
    api: { callAPI: async () => ({ choices: [{ message: { content: 'x' } }] }) },
    sessionManager: null
  });
  const created = team.findingsToTasks([
    { persona: '架构师', personaId: 'arch', output: '这里耦合太重，建议抽接口' },
    { persona: '安全', personaId: 'sec', output: '（安全 调用失败：timeout）' }
  ], { kind: 'code' });

  assert.equal(created.length, 1);
  assert.equal(created[0].params.source, 'code');
  assert.equal(created[0].params.persona, 'arch');
});

// ---- 前端纯视图函数：reviewView ----

test('reviewView：归一字段，失败占位判 ok=false，非数组/缺字段兜底', () => {
  const vm = CodingBoard.reviewView({
    kind: 'code',
    createdAt: '2026-01-01T00:00:00.000Z',
    findings: [
      { persona: '架构师', personaId: 'arch', output: '<img src=x onerror=alert(1)>' },
      { persona: '安全', personaId: 'sec', output: '（安全 调用失败：boom）' }
    ]
  });
  assert.equal(vm.kind, 'code');
  assert.equal(vm.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(vm.findings.length, 2);
  assert.equal(vm.findings[0].personaId, 'arch');
  assert.equal(vm.findings[0].ok, true, '正常文本（即便含 HTML）不算失败');
  assert.equal(vm.findings[1].ok, false, '失败占位判为 ok=false');
  assert.equal(vm.findings[1].output, '（安全 调用失败：boom）');

  const empty = CodingBoard.reviewView(null);
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.kind, '');
  // 脏项兜底
  const dirty = CodingBoard.reviewView({ findings: [null, { output: 123 }] });
  assert.equal(dirty.findings.length, 2);
  assert.equal(dirty.findings[0].personaId, '');
  assert.equal(dirty.findings[0].ok, true);
  assert.equal(dirty.findings[1].output, '123');
});

// ---- 前端纯视图函数：runsView / alertsView ----

test('runsView：入参已倒序（最新在前），只取前 N 条并归一字段', () => {
  const runs = Array.from({ length: 25 }, (_, i) => ({ time: 't' + i, script: 's' + i, exitCode: i, success: i % 2 === 0 }));
  const rv = CodingBoard.runsView(runs, 20);
  assert.equal(rv.length, 20);
  assert.equal(rv[0].time, 't0');
  assert.equal(rv[0].script, 's0');
  assert.equal(rv[0].exitCode, '0');
  assert.equal(rv[0].success, true);
  assert.equal(rv[1].success, false);
  assert.deepEqual(CodingBoard.runsView(null), []);
});

test('alertsView：只取前 N 条，归一 failedCount / findings；缺字段兜底', () => {
  const alerts = [{
    id: 'a1',
    createdAt: 'x',
    failedCount: 2,
    findings: [{ persona: 'qa', output: 'o1' }, { persona: 'perf', output: 'o2' }]
  }];
  const av = CodingBoard.alertsView(alerts, 10);
  assert.equal(av.length, 1);
  assert.equal(av[0].failedCount, 2);
  assert.equal(av[0].findings.length, 2);
  assert.equal(av[0].findings[0].persona, 'qa');

  const av2 = CodingBoard.alertsView([{}], 10);
  assert.equal(av2[0].failedCount, 0);
  assert.deepEqual(av2[0].findings, []);
  assert.deepEqual(CodingBoard.alertsView(null), []);
});
