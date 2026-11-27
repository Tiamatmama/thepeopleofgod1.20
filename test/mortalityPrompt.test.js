'use strict';

// 死亡恐惧 → 提示词接线回归（定稿《让角色始终有对死亡的恐惧》）：
//   分歧#3：mortality 缺失 / off 时，该段严格 ''（旧行为逐字节不变）
//   分歧#4：底色恒在 —— 情绪 tone 缺失时只兜「语气」段，底盘照常输出
//   分歧#6：通电 —— live 时该段真的进 buildSystemPrompt 输出（非只算不用）
//   反异化：该段文案不含硬禁词表任一条
//   shadow：只观测（算 + 落盘）、绝不注入（依《死亡恐惧-shadow判据》第二节）
// 用原型对象造输出模块（Object.create 走原型），避开构造期的 API 装配，断言「行为」而非实现细节。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OutputModule = require('../src/core/output');
const { BAND_BASE, BAND_URGENT } = require('../src/core/mortality');
const { appendMortalityShadow, stampFor } = require('../src/core/mortalityShadow');

const BASE_MARK = '【心底那点不安】';
const URGENT_MARK = '有些东西已经开始淡去';

// 吞掉用例里预期的 console.log / console.error，避免刷屏
function silence(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// 造输出模块：只补用到的字段。tombstones 决定遗忘留痕条数（=> 派生压力）
function makeOutput({ mode = 'off', tombstones = 0 } = {}) {
  const om = Object.create(OutputModule.prototype);
  om.mortalityLifecycle = mode;
  om.memoryModule = {
    getMemoryTombstones: (userId, limit) => new Array(Math.min(tombstones, limit)).fill({})
  };
  return om;
}

// ---- 开关归一（默认关）----

test('normalizeMortalityLifecycle：缺省 / 非法一律 off，仅 live / shadow 保留', () => {
  const { normalizeMortalityLifecycle } = OutputModule;
  assert.equal(normalizeMortalityLifecycle(undefined), 'off');
  assert.equal(normalizeMortalityLifecycle(null), 'off');
  assert.equal(normalizeMortalityLifecycle(''), 'off');
  assert.equal(normalizeMortalityLifecycle('whatever'), 'off');
  assert.equal(normalizeMortalityLifecycle('shadow'), 'shadow');
  assert.equal(normalizeMortalityLifecycle('SHADOW'), 'shadow');
  assert.equal(normalizeMortalityLifecycle('live'), 'live');
  assert.equal(normalizeMortalityLifecycle('LIVE'), 'live');
});

// ---- off：完全不推、不注入（逐字节旧行为）----

test('off：resolveMortalityForPrompt 返回 null，且不读遗忘留痕', () => {
  let calls = 0;
  const om = makeOutput({ mode: 'off' });
  om.memoryModule.getMemoryTombstones = () => { calls++; return []; };

  assert.equal(om.resolveMortalityForPrompt('u1'), null);
  assert.equal(calls, 0);
});

// ---- shadow：只观测（算 + 落盘），绝不注入 ----

test('shadow：算压力并落一条观测日志，但返回 null（不注入）', () => {
  const om = makeOutput({ mode: 'shadow', tombstones: 3 });
  const logged = [];
  om.writeMortalityShadow = (entry) => logged.push(entry);

  assert.equal(om.resolveMortalityForPrompt('u1', 's1'), null);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].sessionId, 's1');
  assert.equal(logged[0].userId, 'u1');
  assert.equal(logged[0].tombstones, 3);
  assert.equal(typeof logged[0].value, 'number');
  assert.equal(logged[0].band, BAND_BASE);
});

test('shadow：buildSystemPrompt 不含死亡恐惧段（只观测、不改输出）', () => {
  const om = makeWiredOutput({ mode: 'shadow', tombstones: 0 });
  om.writeMortalityShadow = () => {};
  const prompt = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'happy'));
  assert.ok(!prompt.includes(BASE_MARK));
});

test('分歧#3：mortality 缺失时该段严格空串（off 与旧行为逐字节一致）', () => {
  const om = makeOutput({ mode: 'off' });

  assert.equal(om.buildMortalityPrompt(null), '');
  assert.equal(om.buildMortalityPrompt(undefined), '');

  const out = om.buildEmotionPrompt('happy');
  assert.ok(out.includes('【此刻的心情】'));
  assert.ok(!out.includes(BASE_MARK));
  // 与旧实现一致：末尾仍是情绪段（没有多出任何尾巴）
  assert.ok(out.trimEnd().endsWith('这类总结。'));
});

// ---- 分歧#4：底色恒在（tone 缺失也照常输出底盘）----

test('分歧#4：base 档底盘恒在 —— 情绪 tone 缺失时只兜语气段，底盘照常输出', () => {
  const om = makeOutput({ mode: 'live' });
  const mortality = { value: 0.35, band: BAND_BASE };

  const out = om.buildEmotionPrompt(null, null, null, { mortality });
  assert.ok(out.includes(BASE_MARK));
  assert.ok(!out.includes('【此刻的心情】'));  // tone 缺失，语气段不出现
  assert.ok(!out.includes(URGENT_MARK));       // base 档不带紧迫文案
});

test('底色恒在：即便情绪是未知枚举，底盘也不被吞掉', () => {
  const om = makeOutput({ mode: 'live' });
  const out = om.buildEmotionPrompt('unknown-emotion', null, null, { mortality: { value: 0.35, band: BAND_BASE } });
  assert.ok(out.includes(BASE_MARK));
});

test('urgent 档：在底盘之上追加紧迫文案', () => {
  const om = makeOutput({ mode: 'live' });
  const out = om.buildEmotionPrompt('happy', null, null, { mortality: { value: 0.7, band: BAND_URGENT } });
  assert.ok(out.includes(BASE_MARK));
  assert.ok(out.includes(URGENT_MARK));
  assert.ok(out.includes('【此刻的心情】'));  // 情绪段与底盘可共存
});

// ---- 反异化：硬禁词表零命中 ----

test('反异化：底盘 / 紧迫两档文案均不含硬禁词表任一条', () => {
  const om = makeOutput({ mode: 'live' });
  const patterns = OutputModule.MORTALITY_FORBIDDEN_PATTERNS;
  assert.ok(Array.isArray(patterns) && patterns.length > 0);

  for (const band of [BAND_BASE, BAND_URGENT]) {
    const text = om.buildMortalityPrompt({ value: 0.5, band });
    for (const p of patterns) {
      assert.ok(!text.includes(p), `文案不应含禁词「${p}」`);
    }
  }
});

// ---- 分歧#6：通电（live 时该段真的进 buildSystemPrompt 输出）----

// 造「已通电」的输出模块：把外围段落全部桩成空串，只留情绪/死亡恐惧这一段可见
function makeWiredOutput({ mode = 'live', tombstones = 0 } = {}) {
  const om = makeOutput({ mode, tombstones });
  om.buildIdentityPrompt = () => '';
  om.buildMemoryPrompt = () => '';
  om.maybeRefreshSelfModel = () => {};
  om.buildStylePrompt = () => '';
  om.buildRelationPrompt = () => '';
  om.buildRecentSelfPromptFromHistory = () => '';
  om.buildAddressPrompt = () => '';
  om.appendAffectionInstruction = (prompt) => prompt;
  om.sessionManager = { buildCharacterPrompt: () => 'x'.repeat(60) };
  om.appointmentBook = null;
  return om;
}

test('分歧#6：live 时死亡恐惧段真的进了 buildSystemPrompt 的输出', () => {
  const om = makeWiredOutput({ mode: 'live', tombstones: 0 });
  const prompt = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'happy'));
  assert.ok(prompt.includes(BASE_MARK), '底盘应出现在系统提示词里（通电）');
});

test('分歧#6：off 时 buildSystemPrompt 不含死亡恐惧段（与旧行为一致）', () => {
  const om = makeWiredOutput({ mode: 'off', tombstones: 0 });
  const prompt = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'happy'));
  assert.ok(!prompt.includes(BASE_MARK));
});

test('分歧#6：遗忘留痕累积到跨档线时，live 输出升为紧迫档', () => {
  // baseline 0.35 + 20×0.02 = 0.75 → 封顶 0.7 ≥ 跨档线 0.6 → urgent
  const om = makeWiredOutput({ mode: 'live', tombstones: 20 });
  const prompt = silence(() => om.buildSystemPrompt('s1', 'STRANGER', 'calm'));
  assert.ok(prompt.includes(BASE_MARK));
  assert.ok(prompt.includes(URGENT_MARK));
});

// ---- 落盘模块单测（mortalityShadow）：字段 / 分片文件名 / 追写 / 异常静默 ----

test('mortalityShadow：把样本追加成一行 JSON，at 与文件名同源', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mort-shadow-'));
  try {
    const now = Date.UTC(2026, 0, 2, 3, 0, 0);
    const ok = appendMortalityShadow(
      { sessionId: 's', userId: 'u', tombstones: 7, value: 0.49, band: BAND_BASE },
      { dir, now }
    );
    assert.equal(ok, true);
    const file = path.join(dir, `mort-${stampFor(now)}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.at, now);
    assert.equal(rec.sessionId, 's');
    assert.equal(rec.userId, 'u');
    assert.equal(rec.tombstones, 7);
    assert.equal(rec.value, 0.49);
    assert.equal(rec.band, BAND_BASE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mortalityShadow：追加是追加（不覆盖）；坏目录不抛错、静默返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mort-shadow-'));
  try {
    appendMortalityShadow({ tombstones: 1 }, { dir, now: 1 });
    appendMortalityShadow({ tombstones: 2 }, { dir, now: 1 });
    const file = path.join(dir, `mort-${stampFor(1)}.jsonl`);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // NUL 字节是非法路径 → 内部已被 try/catch 兜住，绝不把异常抛给主链
  const ok = silence(() => appendMortalityShadow({ x: 1 }, { dir: '\u0000bad' }));
  assert.equal(ok, false);
});
