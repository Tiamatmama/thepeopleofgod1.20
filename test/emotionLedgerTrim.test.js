'use strict';

// A4 验收：情感履历的 signals / clusters 曾是无界数组，长跑会无限膨胀。
// 这里用裸实例（Object.create + 手搓 data）直接钉住 trimLedger 的收口行为，
// 不 new 真实构造，避免污染 data/emotion_ledger.json。

const test = require('node:test');
const assert = require('node:assert/strict');

const EmotionLedger = require('../src/core/emotionLedger');

function makeLedger() {
  const ledger = Object.create(EmotionLedger.prototype);
  ledger.data = { version: 1, signals: [], clusters: [], trust: {} };
  return ledger;
}

test('trimLedger：signals 超上限时保留最近 1000 条（追加序，尾部最新）', () => {
  const ledger = makeLedger();
  for (let i = 0; i < 1005; i++) {
    ledger.data.signals.push({ id: `sig_${i}`, timestamp: 1000 + i });
  }
  ledger.trimLedger();
  assert.equal(ledger.data.signals.length, 1000);
  assert.equal(ledger.data.signals[0].id, 'sig_5');       // 最早的 5 条被裁掉
  assert.equal(ledger.data.signals[999].id, 'sig_1004');  // 最新一条仍保留
});

test('trimLedger：clusters 超上限时按 lastSeenAt 保留最近 200 个', () => {
  const ledger = makeLedger();
  for (let i = 0; i < 205; i++) {
    ledger.data.clusters.push({ id: `clu_${i}`, lastSeenAt: 1000 + i });
  }
  ledger.trimLedger();
  assert.equal(ledger.data.clusters.length, 200);
  const ids = new Set(ledger.data.clusters.map(c => c.id));
  assert.equal(ids.has('clu_0'), false);   // lastSeenAt 最小的 5 个被淘汰
  assert.equal(ids.has('clu_4'), false);
  assert.equal(ids.has('clu_5'), true);
  assert.equal(ids.has('clu_204'), true);
});

test('trimLedger：未超上限时保持原数组引用（不复制、不重排）', () => {
  const ledger = makeLedger();
  ledger.data.signals.push({ id: 'sig_0', timestamp: 1 });
  ledger.data.clusters.push({ id: 'clu_0', lastSeenAt: 1 });
  const signalsRef = ledger.data.signals;
  const clustersRef = ledger.data.clusters;
  ledger.trimLedger();
  assert.equal(ledger.data.signals, signalsRef);
  assert.equal(ledger.data.clusters, clustersRef);
});
