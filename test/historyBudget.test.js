'use strict';

// history 有界：逐条限长、旧轮压成摘要、硬预算兜底；并验证 drive 每轮开跑前 prompt 不超预算。
// 纯模块测试用合成 40 轮历史；drive 级用桩 callWithTools 复刻「直接 mutate messages」的真实行为。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingLoop = require('../src/core/codingLoop');
const {
  estimateBytes,
  truncateMessage,
  buildDigest,
  compactHistory,
  SAFETY_LIMITS
} = require('../src/core/historyBudget');

// 模拟 output.callWithTools 往同一个数组里追加的一轮：assistant(tool_calls) + tool 结果
function makeToolRound(i, size = 4000) {
  return [
    {
      role: 'assistant',
      content: `第${i}轮：跑测试 ${'a'.repeat(size)}`,
      tool_calls: [{
        id: `call_${i}`,
        type: 'function',
        function: { name: 'code_run_tests', arguments: JSON.stringify({ command: 'npm test', note: 'b'.repeat(size) }) }
      }]
    },
    { role: 'tool', tool_call_id: `call_${i}`, content: `第${i}轮输出 ${'c'.repeat(size)}` }
  ];
}

// 复刻 drive：每轮失败后 push 一条重试 user 提示，其下标即轮次边界
function makeHistory(rounds, options = {}) {
  const history = [
    { role: 'system', content: `系统提示 ${'s'.repeat(options.systemSize || 100)}` },
    { role: 'user', content: `本次目标 ${'k'.repeat(options.kickoffSize || 100)}` }
  ];
  const boundaries = [];
  const steps = [];
  for (let i = 1; i <= rounds; i++) {
    boundaries.push(history.length);
    history.push({ role: 'user', content: `重试${i}：判据未通过，继续修` });
    makeToolRound(i, options.roundSize).forEach(message => history.push(message));
    steps.push({ iteration: i, check: { ok: false, verdict: 'unverified', errorKind: 'diagnoseError', reason: `第${i}轮有语法错误` } });
  }
  return { history, boundaries, steps };
}

// 孤儿 tool 消息检查：tool 必须紧跟在「带有对应 tool_call_id 的 assistant」之后；
// user 出现时上一条 assistant 的工具调用必须都已有结果。
function assertNoOrphanTool(messages) {
  let pending = new Set();
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      assert.equal(pending.size, 0, `第 ${index} 条 assistant 之前有工具调用没有结果`);
      pending = new Set((message.tool_calls || []).map(call => call.id));
    } else if (message.role === 'tool') {
      assert.ok(pending.has(message.tool_call_id), `第 ${index} 条 tool 是孤儿（没有对应的 assistant 调用）`);
      pending.delete(message.tool_call_id);
    } else {
      assert.equal(pending.size, 0, `第 ${index} 条 ${message.role} 之前有工具调用没有结果`);
    }
  });
}

test('estimateBytes：按 UTF-8 字节计数，中文 3 字节', () => {
  assert.equal(estimateBytes([]), 0);
  const one = [{ role: 'user', content: '你好' }];
  assert.equal(estimateBytes(one), Buffer.byteLength(JSON.stringify(one[0]), 'utf8'));
  const bytes = Buffer.byteLength(JSON.stringify(one[0]), 'utf8');
  assert.ok(bytes > 5);
});

test('truncateMessage：system 不动，assistant/tool 与 tool_call 参数按上限截断', () => {
  const system = { role: 'system', content: 'x'.repeat(50000) };
  assert.equal(truncateMessage(system).content.length, 50000);

  const assistant = truncateMessage({
    role: 'assistant',
    content: 'a'.repeat(SAFETY_LIMITS.assistant + 100),
    tool_calls: [{
      id: 'c1',
      type: 'function',
      function: { name: 'code_run_tests', arguments: 'b'.repeat(SAFETY_LIMITS.arguments + 100) }
    }]
  });
  assert.ok(Buffer.byteLength(assistant.content, 'utf8') <= SAFETY_LIMITS.assistant + 3);
  assert.ok(Buffer.byteLength(assistant.tool_calls[0].function.arguments, 'utf8') <= SAFETY_LIMITS.arguments + 3);
  // 截断参数不能破坏配对信息
  assert.equal(assistant.tool_calls[0].id, 'c1');
  assert.equal(assistant.tool_calls[0].function.name, 'code_run_tests');

  const tool = truncateMessage({ role: 'tool', tool_call_id: 'c1', content: 't'.repeat(SAFETY_LIMITS.tool + 100) });
  assert.ok(Buffer.byteLength(tool.content, 'utf8') <= SAFETY_LIMITS.tool + 3);
});

test('buildDigest：摘要带上省略轮数，且自身不超上限', () => {
  const steps = Array.from({ length: 40 }, (_, i) => ({
    iteration: i + 1,
    check: { ok: false, verdict: 'unverified', reason: `第${i + 1}轮错误 ${'r'.repeat(500)}` }
  }));
  const digest = buildDigest(steps, { maxBytes: 1500 });
  assert.ok(digest.message);
  assert.ok(digest.omitted > 0);
  assert.match(digest.message.content, /<history-digest>/);
  assert.match(digest.message.content, /已省略/);
  assert.ok(Buffer.byteLength(digest.message.content, 'utf8') < 3000);
  // 压缩的是最近轮次，最早的行先被丢
  assert.ok(!digest.message.content.includes('第1轮错误'));
  assert.ok(digest.message.content.includes('第40轮错误'));
});

test('compactHistory：40 轮压缩进预算，保留最近 K 轮原文并生成摘要', () => {
  const { history, boundaries, steps } = makeHistory(40, { roundSize: 4000 });
  const before = estimateBytes(history);
  assert.ok(before > 300 * 1024, `原始历史应远超预算，实际 ${before}`);

  const result = compactHistory(history, { steps, boundaries, maxBytes: 48000, keepRounds: 3 });
  const after = estimateBytes(result.messages);

  assert.ok(after <= 48000, `压缩后应不超预算，实际 ${after}`);
  assert.ok(after < before / 10, `压缩后应显著变小，实际 ${after}`);
  // 不修改入参
  assert.equal(estimateBytes(history), before);

  const digest = result.messages.find(m => typeof m.content === 'string' && m.content.includes('<history-digest>'));
  assert.ok(digest, '应生成 <history-digest> 摘要');
  assert.equal(digest.role, 'user');

  // 最近 3 轮原文还在（含工具输出），更早的轮次已被摘要替代
  const all = JSON.stringify(result.messages);
  assert.ok(all.includes('第40轮：跑测试'));
  assert.ok(all.includes('第38轮：跑测试'));
  assert.ok(!all.includes('第1轮：跑测试'));
  assertNoOrphanTool(result.messages);

  // 边界回写到压缩后的下标，且指向最近的重试提示
  assert.equal(result.boundaries.length, 3);
  result.boundaries.forEach((index, i) => {
    assert.equal(result.messages[index].role, 'user');
    assert.ok(result.messages[index].content.startsWith(`重试${38 + i}`), `边界 ${index} 应指向第 ${38 + i} 轮重试提示`);
  });
});

test('compactHistory：极小预算下继续缩 K 并兜底，仍不产生孤儿 tool 消息', () => {
  const { history, boundaries, steps } = makeHistory(12, { roundSize: 6000, systemSize: 3000 });
  const result = compactHistory(history, { steps, boundaries, maxBytes: 8000, keepRounds: 5 });
  assert.ok(estimateBytes(result.messages) <= 8000);
  assertNoOrphanTool(result.messages);
});

test('compactHistory：无边界时只做逐条限长与硬预算裁剪', () => {
  const history = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'kickoff' },
    { role: 'assistant', content: 'a'.repeat(20000) },
    { role: 'tool', tool_call_id: 'c1', content: 't'.repeat(20000) }
  ];
  const result = compactHistory(history, { steps: [], boundaries: [], maxBytes: 10000 });
  assert.ok(estimateBytes(result.messages) <= 10000);
  assert.deepEqual(result.boundaries, []);
});

test('drive：每轮开跑前 history 不超预算，且长跑会压出摘要', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-budget-'));
  const seen = [];       // 每次 callWithTools 入参的字节数
  const payloads = [];   // 每次入参快照（用于检查摘要与 tool 配对）
  let evalCount = 0;

  const coding = {
    dir,
    userKey: () => 'u_history_hash',
    taskDir: () => '',
    getTrustLevel: () => 'auto',
    git: () => ({ success: true, output: '' }),
    gitCommit: () => ({ success: true })
  };
  const outputModule = {
    callWithTools: async (messages) => {
      seen.push(estimateBytes(messages));
      payloads.push(messages.map(message => ({ ...message })));
      // 复刻真实实现：直接往同一个数组追加 assistant(tool_calls) + tool 结果
      const id = `call_${seen.length}`;
      messages.push({
        role: 'assistant',
        content: `第${seen.length}轮：跑测试`,
        tool_calls: [{
          id,
          type: 'function',
          function: { name: 'code_run_tests', arguments: JSON.stringify({ command: 'npm test', note: 'p'.repeat(4000) }) }
        }]
      });
      messages.push({ role: 'tool', tool_call_id: id, content: 'q'.repeat(6000) });
      return { choices: [{ message: { content: `第${seen.length}轮改了登录页` } }] };
    }
  };
  const toolRegistry = {
    codeDiagnose: async () => {
      evalCount++;
      return { success: true, checked: 1, errorCount: 1, errors: [{ file: 'login.js', line: evalCount, message: `第${evalCount}处错误` }] };
    },
    codeRunTests: async () => ({ exitCode: 1, counts: { known: false } })
  };

  const loop = new CodingLoop({ coding, outputModule, toolRegistry });
  const run = {
    id: 'r_history',
    taskId: 't_history',
    userId: 'u_history',
    goal: '把登录页做到上线',
    status: 'running',
    maxIterations: 6,
    model: 'qwen',
    iterations: [],
    lastGreen: null,
    result: '',
    error: ''
  };
  const ctx = {
    userId: 'u_history',
    taskId: 't_history',
    sessionId: 's_history',
    goal: '把登录页做到上线',
    passCommand: '',
    model: 'qwen',
    maxIterations: 6,
    timeoutMs: 60000,
    stallK: 99,
    userApiConfig: null,
    webCheck: null,
    healthCheck: null,
    stages: [],
    historyMaxBytes: 12000,
    historyKeepRounds: 2
  };

  await loop.drive(run, ctx, Date.now() + 60000);

  assert.equal(run.status, 'failed');
  assert.equal(seen.length, 6);
  seen.forEach((bytes, i) => {
    assert.ok(bytes <= 12000, `第 ${i + 1} 轮开跑前 history ${bytes} B 超预算`);
  });
  assert.ok(payloads.some(messages => JSON.stringify(messages).includes('<history-digest>')), '长跑应出现摘要');
  payloads.forEach(assertNoOrphanTool);
  // 失败回滚没有绿点可退时不应伪造 rolledBackTo
  assert.equal(run.rolledBackTo, undefined);
});
