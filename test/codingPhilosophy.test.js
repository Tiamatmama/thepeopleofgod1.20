'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const phil = require('../src/core/codingPhilosophy');
const shadow = require('../src/core/codingPhilosophyShadow');

// 编程沙箱·哲学协议 L0：纯逻辑（三态归一 / 标注 prompt / 解析 / 指纹抽取）+ 落盘模块。
// 落盘刻意与纯逻辑分离，故分别验证；落盘用临时目录 + 固定 now，绝不碰真实 data/。

// ---- 三态归一：缺省 / 非法一律 shadow（本协议特例，非 off）----

test('normalizeCodingPhilosophyLifecycle：缺省/非法 → shadow，仅显式 off/live 才变', () => {
  assert.equal(phil.LIFECYCLE_DEFAULT, 'shadow');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle(undefined), 'shadow');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle(null), 'shadow');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle(''), 'shadow');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle('bogus'), 'shadow');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle('shadow'), 'shadow');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle('  LIVE '), 'live');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle('off'), 'off');
  assert.equal(phil.normalizeCodingPhilosophyLifecycle('OFF'), 'off');
});

// ---- 标注 prompt ----

test('buildLabelingMessages：两条消息、system 含 JSON 模板与字段说明、user 为发言原文', () => {
  const msgs = phil.buildLabelingMessages('  这段发言提到 src/core/x.js:10  ');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.match(msgs[0].content, /```json/);
  assert.match(msgs[0].content, /hasEvidence/);
  assert.equal(msgs[1].content, '这段发言提到 src/core/x.js:10', 'user 内容应 trim');
});

// ---- 解析：宽松取数、严格校验 ----

test('parseLabeling：合法（含无栅栏）通过，字段不合法一律 null', () => {
  assert.deepEqual(
    phil.parseLabeling('```json\n{"domain":"接口设计","stance":"支持","hasEvidence":true}\n```'),
    { domain: '接口设计', stance: '支持', hasEvidence: true }
  );
  // 无栅栏：整段就是 JSON 也能解析
  assert.deepEqual(
    phil.parseLabeling('{"domain":"数据一致性","stance":"存疑","hasEvidence":false}'),
    { domain: '数据一致性', stance: '存疑', hasEvidence: false }
  );
  // 非法：domain 空
  assert.equal(phil.parseLabeling('```json\n{"domain":"  ","stance":"支持","hasEvidence":true}\n```'), null);
  // 非法：stance 非枚举
  assert.equal(phil.parseLabeling('```json\n{"domain":"x","stance":"中立","hasEvidence":true}\n```'), null);
  // 非法：hasEvidence 非布尔
  assert.equal(phil.parseLabeling('```json\n{"domain":"x","stance":"支持","hasEvidence":"yes"}\n```'), null);
  // 非法：非 JSON / 数组
  assert.equal(phil.parseLabeling('随便一句话'), null);
  assert.equal(phil.parseLabeling('```json\n["a"]\n```'), null);
  assert.equal(phil.parseLabeling(null), null);
});

// ---- 指纹抽取 ----

test('extractFingerprints：抓「文件:行号」与十六进制散列，去重并限 20 个', () => {
  const fps = phil.extractFingerprints('见 src/core/codingTeam.js:342 又见 src/core/codingTeam.js:342，runId=deadbee1f00d，校验和 a1b2c3d4e5f6');
  assert.ok(fps.includes('src/core/codingTeam.js:342'));
  assert.ok(fps.includes('deadbee1f00d'));
  assert.ok(fps.includes('a1b2c3d4e5f6'));
  assert.equal(fps.filter((f) => f === 'src/core/codingTeam.js:342').length, 1, '同一指纹应去重');

  assert.deepEqual(phil.extractFingerprints('没有任何指纹'), []);
  assert.deepEqual(phil.extractFingerprints(''), []);
  assert.deepEqual(phil.extractFingerprints(null), []);

  const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.js:${i + 1}`).join(' ');
  assert.equal(phil.extractFingerprints(many).length, phil.FINGERPRINT_CAP, '超量应被截到上限');
});

// ---- 落盘模块：小时分片、追加不覆盖、坏目录静默失败 ----

test('appendPhilosophySample：小时分片追加 jsonl，at 与文件名同源；坏落点吞异常返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-phil-'));
  const now = Date.UTC(2026, 0, 2, 3, 4, 5);
  const expectedFile = path.join(dir, `${shadow.stampFor(now)}.jsonl`);

  assert.equal(shadow.appendPhilosophySample({ taskId: 'disc_1', domainRaw: '接口设计' }, { dir, now }), true);
  assert.equal(shadow.appendPhilosophySample({ taskId: 'disc_1', domainRaw: '数据一致性' }, { dir, now }), true);

  const lines = fs.readFileSync(expectedFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, '两次追加应留两行（追加而非覆盖）');
  const first = JSON.parse(lines[0]);
  assert.equal(first.at, now, 'at 与文件名共用同一个 now');
  assert.equal(first.taskId, 'disc_1');
  assert.equal(first.domainRaw, '接口设计');

  // 坏落点：父路径是一个文件 → mkdir 抛错被吞，返回 false，不向上抛
  fs.writeFileSync(path.join(dir, 'afile'), 'x');
  assert.equal(shadow.appendPhilosophySample({ a: 1 }, { dir: path.join(dir, 'afile', 'sub'), now }), false);
});
