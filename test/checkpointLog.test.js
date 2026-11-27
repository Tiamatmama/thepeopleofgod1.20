'use strict';

// 检查点日志（append-only JSONL）纯模块单测：
// 追加/读取、坏行跳过、尾部读取、单行上限、lastCommitted、summarizeLatestRun。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_LINE_BYTES,
  normalizeEntry,
  serializeEntry,
  appendCheckpoint,
  readCheckpoints,
  lastCommitted,
  summarizeLatestRun
} = require('../src/core/checkpointLog');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-log-'));
  return path.join(dir, 'nested', 'checkpoints.jsonl');
}

test('appendCheckpoint：自动建目录、逐行追加，读回字段完整', () => {
  const file = tempFile();
  assert.equal(appendCheckpoint(file, {
    at: '2026-01-01T00:00:00.000Z',
    runId: 'run_a',
    taskId: 't_a',
    iteration: 1,
    kind: 'stage',
    stageId: 'web',
    nodeId: '',
    ok: true,
    verdict: 'verified',
    sha: 'sha1',
    reason: 'ok'
  }), true);

  const entries = readCheckpoints(file);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    at: '2026-01-01T00:00:00.000Z',
    runId: 'run_a',
    taskId: 't_a',
    iteration: 1,
    kind: 'stage',
    stageId: 'web',
    nodeId: '',
    ok: true,
    verdict: 'verified',
    errorKind: '',
    sha: 'sha1',
    reason: 'ok'
  });
});

test('appendCheckpoint：缺文件路径直接返回 false，不抛', () => {
  assert.equal(appendCheckpoint('', { kind: 'iteration' }), false);
});

test('readCheckpoints：坏行与空行跳过，不影响后续行', () => {
  const file = tempFile();
  appendCheckpoint(file, { runId: 'r1', kind: 'iteration', iteration: 1 });
  fs.appendFileSync(file, '{ this is not json }\n\n', 'utf8');
  appendCheckpoint(file, { runId: 'r1', kind: 'iteration', iteration: 2 });

  const entries = readCheckpoints(file);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.iteration), [1, 2]);
});

test('readCheckpoints：只读尾部字节，且不返回被截断的半行', () => {
  const file = tempFile();
  for (let i = 1; i <= 10; i++) {
    appendCheckpoint(file, { runId: 'r1', kind: 'iteration', iteration: i, reason: 'x'.repeat(200) });
  }
  const entries = readCheckpoints(file, { maxBytes: 700 });
  assert.ok(entries.length > 0 && entries.length < 10);
  // 截断位置落在行中间时，第一行必须被丢弃，返回的都是完整 JSON 行
  assert.equal(entries[entries.length - 1].iteration, 10);
  entries.forEach(e => assert.equal(e.runId, 'r1'));
});

test('serializeEntry：超长 reason 被裁剪到单行上限内', () => {
  const line = serializeEntry({ runId: 'r1', kind: 'iteration', reason: 'y'.repeat(20000) });
  assert.ok(Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES);
  const parsed = JSON.parse(line);
  assert.equal(parsed.runId, 'r1');
  assert.ok(parsed.reason.length < 20000);
});

test('normalizeEntry：非法 kind 归一到 iteration，非 true 的 ok 一律 false', () => {
  const item = normalizeEntry({ kind: 'nope', ok: 'true', iteration: '3' });
  assert.equal(item.kind, 'iteration');
  assert.equal(item.ok, false);
  assert.equal(item.iteration, 0);
});

test('lastCommitted：只认「stage + ok + sha」，跳过迭代与失败记录', () => {
  const entries = [
    normalizeEntry({ kind: 'iteration', ok: true, sha: 'sha_iter' }),
    normalizeEntry({ kind: 'stage', stageId: 'web', ok: true, sha: 'sha_web' }),
    normalizeEntry({ kind: 'stage', stageId: 'health', ok: false, sha: 'sha_bad' }),
    normalizeEntry({ kind: 'run_end', ok: false, sha: 'sha_end' })
  ];
  assert.equal(lastCommitted(entries).sha, 'sha_web');
});

test('summarizeLatestRun：按最后一个 runId 汇总阶段结果与最终状态', () => {
  const entries = [
    normalizeEntry({ runId: 'old', kind: 'stage', stageId: 'web', ok: true, sha: 'sha_old' }),
    normalizeEntry({ runId: 'new', kind: 'stage', stageId: 'web', ok: true, sha: 'sha_web' }),
    normalizeEntry({ runId: 'new', kind: 'iteration', ok: false }),
    normalizeEntry({ runId: 'new', kind: 'run_end', ok: false, verdict: 'failed' })
  ];
  const summary = summarizeLatestRun(entries);
  assert.equal(summary.runId, 'new');
  assert.equal(summary.status, 'failed');
  assert.deepEqual(summary.passedStages, ['web']);
});

test('summarizeLatestRun：空日志返回 null', () => {
  assert.equal(summarizeLatestRun([]), null);
  assert.equal(summarizeLatestRun(null), null);
});
