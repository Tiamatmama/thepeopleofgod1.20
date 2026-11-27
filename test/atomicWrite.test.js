'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJsonAtomicSync } = require('../src/storage/atomicWrite');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomicwrite-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function tmpLeftovers(dir) {
  // 目录里任何以 . 开头、以 .tmp 结尾的文件都算临时残留
  return fs.readdirSync(dir).filter((name) => name.startsWith('.') && name.endsWith('.tmp'));
}

test('正常写入：内容落盘且不留 .tmp 残留', () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'a.json');
    writeJsonAtomicSync(file, { hello: 'world' });

    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hello: 'world' });
    assert.deepEqual(tmpLeftovers(root), []); // 临时文件已被 rename 走，无垃圾
  } finally {
    cleanup(root);
  }
});

test('覆盖写：旧内容被新内容整体替换（不留旧尾巴）', () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'b.json');
    writeJsonAtomicSync(file, { v: 1, old: '一段很长的旧内容xxxxxxxxxxxxxxxxxxxxxxxx' });
    writeJsonAtomicSync(file, { v: 2 });

    const raw = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(raw), { v: 2 });
    assert.equal(raw.includes('旧内容'), false); // 旧内容整体消失，不是半截拼接
    assert.deepEqual(tmpLeftovers(root), []);
  } finally {
    cleanup(root);
  }
});

test('renameSync 抛错：目标旧档无损，且临时文件被清理', () => {
  const root = makeTempDir();
  const file = path.join(root, 'c.json');
  writeJsonAtomicSync(file, { keep: 'old' });

  const orig = fs.renameSync;
  fs.renameSync = () => { throw new Error('模拟 rename 失败'); };
  try {
    assert.throws(() => writeJsonAtomicSync(file, { keep: 'new' }));
  } finally {
    fs.renameSync = orig;
  }

  try {
    // 目标仍是旧内容（没被写坏）
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { keep: 'old' });
    assert.deepEqual(tmpLeftovers(root), []); // 临时文件已被清理
  } finally {
    cleanup(root);
  }
});

test('writeFileSync（写临时文件）抛错：目标旧档无损', () => {
  const root = makeTempDir();
  const file = path.join(root, 'd.json');
  writeJsonAtomicSync(file, { keep: 'old' });

  const orig = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('模拟写临时文件失败'); };
  try {
    assert.throws(() => writeJsonAtomicSync(file, { keep: 'new' }));
  } finally {
    fs.writeFileSync = orig;
  }

  try {
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { keep: 'old' });
  } finally {
    cleanup(root);
  }
});
