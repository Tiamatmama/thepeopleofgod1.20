'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LearningStore, sha256 } = require('../src/core/learningStore');

function makeStore(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-store-'));
  const store = new LearningStore({ root, ...options });
  return { store, root };
}

function retain(store, extra = {}) {
  return store.retain({
    kind: 'analysis',
    title: '测试产物',
    source: 'https://huggingface.co/datasets/demo',
    license: 'CC-BY-4.0',
    script: 'print(1)',
    files: [{ name: 'result.json', content: '{"ok":true}' }],
    ...extra
  });
}

test('S1：retain 写 manifest / 文件 / 索引，sha256 可校验', () => {
  const { store, root } = makeStore();
  try {
    const saved = retain(store);
    assert.equal(saved.success, true);
    assert.equal(saved.bytes, '{"ok":true}'.length);

    const manifestFile = path.join(root, 'assets', saved.id, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.source, 'https://huggingface.co/datasets/demo');
    assert.equal(manifest.license, 'CC-BY-4.0');
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].sha256, sha256(Buffer.from('{"ok":true}')));
    assert.equal(
      fs.readFileSync(path.join(root, 'assets', saved.id, 'result.json'), 'utf8'),
      '{"ok":true}'
    );

    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, saved.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S2：缺 license / source / 非法文件名一律拒绝', () => {
  const { store, root } = makeStore();
  try {
    assert.equal(retain(store, { license: '' }).success, false);
    assert.equal(retain(store, { source: '' }).success, false);
    assert.equal(retain(store, { files: [{ name: '../evil.py', content: 'x' }] }).success, false);
    assert.equal(retain(store, { files: [{ name: 'a/b.json', content: 'x' }] }).success, false);
    assert.equal(retain(store, { kind: 'nope' }).success, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S3：没有 manifest 的目录不算产物，并从索引清掉幽灵条目', () => {
  const { store, root } = makeStore();
  try {
    const saved = retain(store);
    fs.rmSync(path.join(root, 'assets', saved.id, 'manifest.json'), { force: true });
    assert.equal(store.list().length, 0);
    assert.equal(store.get(saved.id).success, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S4：TTL 过期会被 prune 清掉', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-store-'));
  let now = 1000;
  const store = new LearningStore({ root, now: () => now, ttlDays: 1 });
  try {
    const saved = retain(store);
    now = 1000 + 2 * 24 * 60 * 60 * 1000;
    const result = store.prune();
    assert.deepEqual(result.removed, [saved.id]);
    assert.equal(fs.existsSync(path.join(root, 'assets', saved.id)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S5：超过 maxBytes 按 lastAccess 从旧到新 LRU 淘汰', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-store-'));
  let now = 1000;
  const store = new LearningStore({ root, now: () => now, maxBytes: 30, ttlDays: 0 });
  try {
    const a = retain(store, { files: [{ name: 'a.txt', content: '0123456789' }] });
    now += 10;
    const b = retain(store, { files: [{ name: 'b.txt', content: '0123456789' }] });
    now += 10;
    const c = retain(store, { files: [{ name: 'c.txt', content: '0123456789' }] });
    assert.equal(a.success && b.success && c.success, true);

    // 访问 b，让 a 成为最旧
    store.get(b.id);
    now += 10;
    const d = retain(store, { files: [{ name: 'd.txt', content: '0123456789' }] });
    assert.equal(d.success, true);

    const result = store.prune();
    assert.deepEqual(result.removed, [a.id]);
    assert.deepEqual(store.list().map((item) => item.id).sort(), [b.id, c.id, d.id].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S6：remove 同时删目录与索引；非法 id 拒绝', () => {
  const { store, root } = makeStore();
  try {
    const saved = retain(store);
    assert.equal(store.remove('../../etc').success, false);
    assert.equal(store.remove(saved.id).success, true);
    assert.equal(store.list().length, 0);
    assert.equal(fs.existsSync(path.join(root, 'assets', saved.id)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
