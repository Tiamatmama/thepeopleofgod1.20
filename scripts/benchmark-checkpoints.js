'use strict';

// 40 轮检查点存储 benchmark（§10 待决策项 1 的裁决依据）
// 只做量测、不写业务数据：临时目录用完即删。
// 指标：
//   1) prompt 字节数：真实 buildSystemPrompt / buildKickoff / buildRetryPrompt 拼出的 history；
//   2) 现方案 loop_runs.json：每次 appendRun 全量读 + 全量重写，40 次 run 的累计写入字节；
//   3) 备选 JSONL：每轮/每阶段追加一行，累计写入字节与最终文件大小；
//   4) 备选 milestones：把 40 轮阶段结果塞进 project.json 并注入 prompt 的字节数。

const fs = require('fs');
const os = require('os');
const path = require('path');
const CodingLoop = require('../src/core/codingLoop');
const { compactHistory } = require('../src/core/historyBudget');

const ROUNDS = 40;
const RUNS = 40;
const RECENT_KEEP = 30;
const ASSISTANT_BYTES = 800;
const SUMMARY_BYTES = 800;
// 与 CodingLoop.prepare 的默认值一致：48 KB 预算、保留最近 3 轮原文
const HISTORY_MAX_BYTES = 48 * 1024;
const HISTORY_KEEP_ROUNDS = 3;

function bytes(text) {
  return Buffer.byteLength(String(text == null ? '' : text), 'utf8');
}

function repeatTo(text, size) {
  const base = String(text || 'x');
  return base.repeat(Math.ceil(size / bytes(base))).slice(0, size);
}

function makeLoop() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-checkpoint-'));
  const ws = path.join(root, 'task');
  fs.mkdirSync(ws, { recursive: true });
  const loop = new CodingLoop({
    coding: {
      dir: root,
      taskDir: () => ws,
      getTrustLevel: () => 'auto',
      git: () => ({ success: true, output: '' }),
      gitCommit: () => ({ success: true })
    },
    outputModule: {},
    toolRegistry: {}
  });
  return { loop, root, ws };
}

function makeCtx() {
  return {
    userId: 'bench_user',
    taskId: 'bench_task',
    goal: '把登录页做到部署后 health 200',
    passCommand: 'npm test',
    maxIterations: ROUNDS,
    sessionId: 'bench_session',
    stages: [
      { id: 'login', kind: 'webCheck', requires: [], description: '登录页可打开并登录成功', check: {} },
      { id: 'health', kind: 'health', requires: ['login'], description: '部署后健康检查', check: {} }
    ],
    webCheck: null
  };
}

// 与 drive 里回灌给模型的失败结构同形
function makeCheck(iteration) {
  return {
    ok: false,
    errorKind: 'testFailure',
    reason: `测试未通过（failed=3/${10 + iteration}）`,
    ran: 10 + iteration,
    passed: 7,
    failed: 3,
    skipped: 0,
    logPath: `data/coding/workspaces/u/t/.logs/test_${iteration}.log`,
    failures: [1, 2, 3].map(n => ({
      test: `login flow ${n}`,
      message: repeatTo(`断言失败：期望跳转到 /dashboard，实际停留在 /login（第 ${iteration} 轮第 ${n} 条）`, 400),
      trace: repeatTo('at LoginPage.submit (src/pages/login.js:42:13)', 400),
      logPath: `data/coding/workspaces/u/t/.logs/test_${iteration}.log`
    }))
  };
}

// 1) prompt 字节：真实 history 拼接，同时量 raw（不裁剪）与 bounded（historyBudget）两条路径
function measurePrompt() {
  const { loop, root } = makeLoop();
  const ctx = makeCtx();
  const head = [
    { role: 'system', content: loop.buildSystemPrompt(ctx) },
    { role: 'user', content: loop.buildKickoff(ctx) }
  ];
  const rounds = [];
  const steps = [];
  for (let i = 1; i <= ROUNDS; i++) {
    rounds.push([
      { role: 'assistant', content: repeatTo(`第 ${i} 轮：定位登录跳转问题并修改。`, ASSISTANT_BYTES) },
      { role: 'user', content: loop.buildRetryPrompt(makeCheck(i), i, ctx) }
    ]);
    steps.push({ iteration: i, check: makeCheck(i) });
  }

  // 两条路径都在「每轮开跑前」量 prompt：
  // raw 只 push 从不裁剪；bounded 在上一轮失败回灌后按 drive 的顺序压缩，
  // 所以第 1 轮两者相同，差异从第 2 轮开始累计。
  const history = head.slice();
  let bounded = head.slice();
  let boundaries = [];
  const perRound = [];
  const boundedPerRound = [];
  let totalBytes = 0;
  let boundedTotal = 0;
  rounds.forEach(([assistant, retry], i) => {
    perRound.push(bytes(JSON.stringify(history)));
    boundedPerRound.push(bytes(JSON.stringify(bounded)));
    totalBytes += perRound[perRound.length - 1];
    boundedTotal += boundedPerRound[boundedPerRound.length - 1];

    history.push(assistant, retry);
    bounded.push(assistant);
    boundaries.push(bounded.length);
    bounded.push(retry);
    const compacted = compactHistory(bounded, {
      steps: steps.slice(0, i + 1),
      boundaries,
      maxBytes: HISTORY_MAX_BYTES,
      keepRounds: HISTORY_KEEP_ROUNDS
    });
    bounded = compacted.messages;
    boundaries = compacted.boundaries;
  });

  fs.rmSync(root, { recursive: true, force: true });
  return {
    systemPromptBytes: bytes(JSON.stringify(head[0])),
    round1Bytes: perRound[0],
    round40Bytes: perRound[perRound.length - 1],
    growthBytes: perRound[perRound.length - 1] - perRound[0],
    totalBytes,
    bounded: {
      maxBytes: HISTORY_MAX_BYTES,
      keepRounds: HISTORY_KEEP_ROUNDS,
      round1Bytes: boundedPerRound[0],
      round40Bytes: boundedPerRound[boundedPerRound.length - 1],
      peakBytes: Math.max(...boundedPerRound),
      totalBytes: boundedTotal,
      hasDigest: bounded.some(message => String(message.content || '').includes('<history-digest>'))
    }
  };
}

// 2) 现方案：appendRun 全量重写
function measureFullRewrite() {
  let runs = [];
  let totalWritten = 0;
  let peak = 0;
  for (let n = 1; n <= RUNS; n++) {
    const run = {
      id: `run_${n}`,
      taskId: 'bench_task',
      goal: '把登录页做到部署后 health 200',
      status: n % 2 ? 'failed' : 'passed',
      iteration: ROUNDS,
      lastGreen: `sha_${n}`,
      verdict: 'failed',
      stages: [
        { stageId: 'login', ok: true, reason: 'ok', commitSha: `sha_${n}_login` },
        { stageId: 'health', ok: false, reason: '健康检查未通过：状态码 500', commitSha: '' }
      ],
      steps: Array.from({ length: ROUNDS }, (_, i) => ({
        iteration: i + 1,
        summary: repeatTo(`第 ${i + 1} 轮：尝试修复登录跳转与健康检查。`, SUMMARY_BYTES),
        check: { ok: false, errorKind: 'testFailure', reason: '测试未通过', verdict: 'failed', stages: [] },
        stages: [],
        error: ''
      }))
    };
    runs.push(run);
    runs = runs.slice(-RECENT_KEEP);
    const text = JSON.stringify({ runs }, null, 2);
    totalWritten += bytes(text);
    peak = Math.max(peak, bytes(text));
  }
  return {
    runs: RUNS,
    kept: runs.length,
    totalWrittenBytes: totalWritten,
    peakWriteBytes: peak,
    finalFileBytes: bytes(JSON.stringify({ runs }, null, 2))
  };
}

// 3) 备选：append-only JSONL，每轮一行 + 每阶段一行
function measureJournal() {
  const lines = [];
  for (let i = 1; i <= ROUNDS; i++) {
    lines.push(JSON.stringify({
      at: new Date(1700000000000 + i * 60000).toISOString(),
      runId: 'run_1',
      taskId: 'bench_task',
      iteration: i,
      kind: 'iteration',
      ok: false,
      verdict: 'failed',
      errorKind: 'testFailure',
      stageId: '',
      sha: '',
      reason: '测试未通过'
    }));
    ['login', 'health'].forEach(stageId => {
      lines.push(JSON.stringify({
        at: new Date(1700000000000 + i * 60000).toISOString(),
        runId: 'run_1',
        taskId: 'bench_task',
        iteration: i,
        kind: 'stage',
        ok: stageId === 'login',
        verdict: stageId === 'login' ? 'verified' : 'failed',
        errorKind: stageId === 'login' ? '' : 'healthCheck',
        stageId,
        sha: stageId === 'login' ? `sha_${i}_login` : '',
        reason: stageId === 'login' ? '通过' : '健康检查未通过'
      }));
    });
  }
  const total = lines.reduce((sum, line) => sum + bytes(line) + 1, 0);
  return {
    rounds: ROUNDS,
    lines: lines.length,
    avgLineBytes: Math.round(total / lines.length),
    totalWrittenBytes: total,
    finalFileBytes: total
  };
}

// 4) 备选：milestones 版本化写进 project.json 并注入 prompt
function measureMilestones() {
  const milestones = Array.from({ length: RUNS }, (_, n) => ({
    version: n + 1,
    at: new Date(1700000000000 + n * 60000).toISOString(),
    runId: `run_${n + 1}`,
    status: n % 2 ? 'failed' : 'passed',
    goal: '把登录页做到部署后 health 200',
    stages: [
      { id: 'login', ok: true, sha: `sha_${n}_login`, at: new Date(1700000000000 + n * 60000).toISOString() },
      { id: 'health', ok: false, sha: '', at: new Date(1700000000000 + n * 60000).toISOString() }
    ]
  }));
  const state = { version: 1, projectId: 'u__t', taskId: 'bench_task', goal: '把登录页做到部署后 health 200', status: 'failed', milestones, lessons: [], updatedAt: new Date().toISOString() };
  const text = JSON.stringify(state, null, 2);
  return {
    runs: RUNS,
    projectJsonBytes: bytes(text),
    injectedPromptBytes: Math.min(bytes(text), 3000),
    truncated: bytes(text) > 3000
  };
}

const result = {
  rounds: ROUNDS,
  prompt: measurePrompt(),
  fullRewrite: measureFullRewrite(),
  journal: measureJournal(),
  milestones: measureMilestones()
};

result.verdict = {
  recommended: 'append-only-jsonl',
  reasons: [
    `写入量：JSONL 40 轮 ${result.journal.totalWrittenBytes} B ≈ ${(result.journal.totalWrittenBytes / 1024).toFixed(1)} KB；` +
      `loop_runs.json 全量重写 ${result.fullRewrite.totalWrittenBytes} B ≈ ${(result.fullRewrite.totalWrittenBytes / 1024 / 1024).toFixed(2)} MB`,
    `单次写入：JSONL 每行约 ${result.journal.avgLineBytes} B（O(1) 追加）；全量重写峰值 ${result.fullRewrite.peakWriteBytes} B`,
    `prompt：milestones 全量 ${result.milestones.projectJsonBytes} B 会被 3000 B 上限截断（${result.milestones.truncated}），` +
      '逐轮里程碑不该整体进 prompt，只留尾部摘要',
    `history raw 从第 1 轮 ${result.prompt.round1Bytes} B 涨到第 40 轮 ${result.prompt.round40Bytes} B（+${result.prompt.growthBytes} B）；` +
      `bounded 峰值 ${result.prompt.bounded.peakBytes} B（预算 ${result.prompt.bounded.maxBytes} B），` +
      `40 轮累计 ${result.prompt.bounded.totalBytes} B vs raw ${result.prompt.totalBytes} B`
  ]
};

console.log(JSON.stringify(result, null, 2));
