const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isTempFile,
  cleanTempFiles,
  validateJsonFile,
  quarantineCorruptFiles
} = require('../src/storage/storeGuard');
const MemoryModule = require('../src/core/memory');

// 每个用例一个临时目录，用完即删，零污染真实 data
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storeguard-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

test('isTempFile：只认 .tmp 残留临时文件', () => {
  assert.equal(isTempFile('.foo.json.1234.1700000000000.tmp'), true);
  assert.equal(isTempFile('foo__role.json'), false);
  assert.equal(isTempFile('foo.json.corrupt-123'), false);
  assert.equal(isTempFile(null), false);
});

test('cleanTempFiles：只删 .tmp，保留正式数据，缺目录返回空', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'user__role.json'), '{}');
    fs.writeFileSync(path.join(dir, '.user__role.json.999.111.tmp'), 'half');
    fs.writeFileSync(path.join(dir, '.other.json.1.2.tmp'), 'half');
    fs.mkdirSync(path.join(dir, 'sub'));

    const removed = cleanTempFiles(dir);
    assert.equal(removed.length, 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['sub', 'user__role.json']);

    assert.deepEqual(cleanTempFiles(path.join(dir, 'not-exist')), []);
  } finally {
    cleanup(dir);
  }
});

test('validateJsonFile：合法 vs 损坏分别给出 ok/error', () => {
  const dir = makeTempDir();
  try {
    const good = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(good, JSON.stringify({ a: 1 }));
    fs.writeFileSync(bad, '{ "a": 1,');

    assert.deepEqual(validateJsonFile(good), { ok: true, error: null });
    const result = validateJsonFile(bad);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('quarantineCorruptFiles：坏文件改名隔离、好文件不动，且隔离名不再以 .json 结尾', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'u1__role.json'), JSON.stringify({ memories: [] }));
    fs.writeFileSync(path.join(dir, 'u2__role.json'), '{ 坏掉的');
    fs.writeFileSync(path.join(dir, 'u3__role.json.bak'), 'also-ignore');

    const report = quarantineCorruptFiles(dir, { stamp: 424242 });
    assert.equal(report.scanned, 2); // .bak 不计入
    assert.equal(report.quarantined.length, 1);
    const q = report.quarantined[0];
    assert.equal(q.file, 'u2__role.json');
    assert.equal(q.to, 'u2__role.json.corrupt-424242');
    assert.ok(q.error.length > 0);

    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['u1__role.json', 'u2__role.json.corrupt-424242', 'u3__role.json.bak']);
    // 隔离文件不再以 .json 结尾 → 后续 loadAllUserMemories 不会把它当记忆扫进来
    assert.equal(left.some((f) => f.endsWith('.json') && f.includes('corrupt')), false);
  } finally {
    cleanup(dir);
  }
});

test('quarantineCorruptFiles：目录不存在时返回零结果', () => {
  const missing = path.join(os.tmpdir(), 'storeguard-missing-xyz');
  assert.deepEqual(quarantineCorruptFiles(missing), { scanned: 0, quarantined: [] });
});

test('MemoryModule.guardUserMemoryStore：启动时清 tmp 并隔离坏记忆文件', () => {
  const root = makeTempDir();
  const userMemDir = path.join(root, 'user_memories');
  fs.mkdirSync(userMemDir);
  try {
    fs.writeFileSync(path.join(userMemDir, 'ok__role.json'), JSON.stringify({ memories: [] }));
    fs.writeFileSync(path.join(userMemDir, 'broken__role.json'), '{ 半截');
    fs.writeFileSync(path.join(userMemDir, '.ok__role.json.1.2.tmp'), 'half');

    // 只造一个带 storagePath 的轻量对象，避免走真实构造（其构造会迁移真实 data）
    const mod = Object.create(MemoryModule.prototype);
    mod.storagePath = root;
    mod.guardUserMemoryStore();

    const left = fs.readdirSync(userMemDir);
    assert.equal(left.some((f) => f.endsWith('.tmp')), false);
    assert.ok(left.includes('ok__role.json'));
    assert.equal(left.some((f) => f.includes('broken__role.json.corrupt-')), true);
    assert.equal(left.includes('broken__role.json'), false);
  } finally {
    cleanup(root);
  }
});

test('quarantineCorruptFiles：隔离时原档字节原样保留、原名不再被当数据档（V1）', () => {
  const dir = makeTempDir();
  try {
    const original = '{ "memories": [ 半截的坏内容';
    const target = path.join(dir, 'u1__role.json');
    fs.writeFileSync(target, original);

    const report = quarantineCorruptFiles(dir, { stamp: 99 });
    assert.equal(report.quarantined.length, 1);

    const renamed = path.join(dir, 'u1__role.json.corrupt-99');
    assert.equal(fs.existsSync(renamed), true);
    assert.equal(fs.readFileSync(renamed, 'utf8'), original); // 改名不动内容，原字节完整保留
    assert.equal(fs.existsSync(target), false);               // 原名让位，加载器扫不到
    assert.equal(renamed.endsWith('.json'), false);           // 只认 .json → 不再被当记忆档加载
  } finally {
    cleanup(dir);
  }
});
