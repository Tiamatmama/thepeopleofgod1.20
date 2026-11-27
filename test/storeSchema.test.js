'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CURRENT_VERSIONS,
  LEGACY_VERSION,
  readVersion,
  isFutureVersion,
  stampVersion
} = require('../src/storage/storeSchema');
const MemoryModule = require('../src/core/memory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storeschema-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// 造一个只带落盘/加载所需字段的记忆模块，避开真实构造（其构造会迁移真实 data）
function makePersistMemory(root) {
  const mem = Object.create(MemoryModule.prototype);
  mem.storagePath = root;
  mem.userMemories = {};
  const store = {
    memories: [],
    relationshipScore: 0,
    summaryMemory: [],
    tombstones: [],
    lastSummaryTime: 0,
    eventsSinceLastSummary: 0,
    emotionHistory: [],
    address: mem.normalizeAddress(null)
  };
  mem.getUserMemoryStore = () => store;
  return { mem, store };
}

test('readVersion：缺失/非法按 v1 回落，合法取整', () => {
  assert.equal(readVersion({}), LEGACY_VERSION);
  assert.equal(readVersion(null), LEGACY_VERSION);
  assert.equal(readVersion({ schemaVersion: 0 }), LEGACY_VERSION);      // <1 视为缺省
  assert.equal(readVersion({ schemaVersion: 'x' }), LEGACY_VERSION);    // 非数字回落
  assert.equal(readVersion({ schemaVersion: 3 }), 3);
  assert.equal(readVersion({ schemaVersion: 3.9 }), 3);
  assert.equal(readVersion({}, 5), 5);                                  // 自定义 fallback
});

test('isFutureVersion：只在档版本高于当前时为真', () => {
  assert.equal(isFutureVersion({ schemaVersion: 2 }, CURRENT_VERSIONS.userMemory), true);
  assert.equal(isFutureVersion({ schemaVersion: 1 }, CURRENT_VERSIONS.userMemory), false);
  assert.equal(isFutureVersion({}, CURRENT_VERSIONS.userMemory), false); // 老档按 v1
});

test('stampVersion：不修改入参，返回带版本号的新对象', () => {
  const data = { memories: [] };
  const stamped = stampVersion(data, 7);
  assert.equal(stamped.schemaVersion, 7);
  assert.deepEqual(data, { memories: [] }); // 原对象未被污染
  assert.notEqual(stamped, data);
});

test('saveUserMemories：落盘档案带上当前结构版本号', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'user_memories'));
    const { mem } = makePersistMemory(root);
    mem.saveUserMemories('u1');

    const filePath = path.join(root, 'user_memories', 'u1__role.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(data.schemaVersion, CURRENT_VERSIONS.userMemory);
  } finally {
    cleanup(root);
  }
});

test('loadUserMemories：老档（无版本号）静默按 v1 加载', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'user_memories'));
    fs.writeFileSync(
      path.join(root, 'user_memories', 'u1__role.json'),
      JSON.stringify({ memories: [{ id: 1, data: 'x' }] })
    );
    const { mem } = makePersistMemory(root);

    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      mem.loadUserMemories('u1');
    } finally {
      console.warn = orig;
    }

    assert.equal(mem.userMemories.u1__role.memories.length, 1);
    assert.equal(warns.some((w) => w.includes('高于当前')), false);
  } finally {
    cleanup(root);
  }
});

test('loadUserMemories：遇到更高版本档告警但仍兜底加载', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'user_memories'));
    fs.writeFileSync(
      path.join(root, 'user_memories', 'u1__role.json'),
      JSON.stringify({ schemaVersion: 99, memories: [{ id: 1, data: 'x' }] })
    );
    const { mem } = makePersistMemory(root);

    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      mem.loadUserMemories('u1');
    } finally {
      console.warn = orig;
    }

    assert.equal(mem.userMemories.u1__role.memories.length, 1); // 兜底照读
    assert.equal(warns.some((w) => w.includes('高于当前')), true);
  } finally {
    cleanup(root);
  }
});

test('saveUserMemories：磁盘档来自更高版本时拒绝降级写（P0-4）', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'user_memories'));
    const filePath = path.join(root, 'user_memories', 'u1__role.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, memories: [{ id: 1, data: 'x' }] }));

    // 不用 makePersistMemory：它把 getUserMemoryStore 固定成同一 store，会绕开 futureVersion 守卫
    const mem = Object.create(MemoryModule.prototype);
    mem.storagePath = root;
    mem.userMemories = {};

    const origWarn = console.warn;
    console.warn = () => {};
    let saved;
    try {
      mem.loadUserMemories('u1');
      mem.userMemories.u1__role.memories.push({ id: 2, data: 'y' }); // 模拟降级构建又写了一次
      saved = mem.saveUserMemories('u1');
    } finally {
      console.warn = origWarn;
    }

    assert.equal(saved, false); // 拒绝写
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, 99);  // 版本没被降级
    assert.equal(onDisk.memories.length, 1); // 新内容没被覆盖
  } finally {
    cleanup(root);
  }
});

test('setMemoryPinned：落盘失败返回 false 并回滚 pinned（P0-3）', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'user_memories'));
    // 目标文件位置放一个同名目录 → 原子写的 renameSync 必失败，可确定性触发写失败
    fs.mkdirSync(path.join(root, 'user_memories', 'u1__role.json'));

    const mem = Object.create(MemoryModule.prototype);
    mem.storagePath = root;
    mem.userMemories = {
      u1__role: {
        memories: [{ id: 'a', data: 'hello', pinned: false }],
        relationshipScore: 0,
        emotionHistory: [],
        summaryMemory: [],
        tombstones: [],
        lastSummaryTime: Date.now(),
        eventsSinceLastSummary: 0,
        address: mem.normalizeAddress(null),
        initialized: true
      }
    };

    const origErr = console.error;
    console.error = () => {};
    let ok;
    try {
      ok = mem.setMemoryPinned('u1', 'a', true);
    } finally {
      console.error = origErr;
    }

    assert.equal(ok, false);                                  // 落盘失败 → false
    assert.equal(mem.getMemoryById('u1', 'a').pinned, false); // 内存标记已回滚
  } finally {
    cleanup(root);
  }
});

test('close：退出时将脏键批量落盘（V-O1）', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'user_memories'));
    const { mem, store } = makePersistMemory(root);
    mem._dirtyKeys = new Set();
    mem._flushTimer = null;
    mem._flushDelayMs = 30 * 1000;
    mem.maintainStore = () => ({ sweep: null, evicted: 0 }); // 避开遗忘扫描副作用，只验落盘

    store.memories.push({ id: 'm1', data: '关闭前写入的新内容', timestamp: 1 });
    mem.markDirty('u1');
    mem.close();

    const filePath = path.join(root, 'user_memories', 'u1__role.json');
    assert.equal(fs.existsSync(filePath), true);           // 档文件确实生成
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(data.memories.some((m) => m.data === '关闭前写入的新内容'), true);
  } finally {
    cleanup(root);
  }
});

test('saveSelfModel：schemaVersion 与 version 并存且能读回（V3）', () => {
  const root = makeTempDir();
  try {
    const mem = Object.create(MemoryModule.prototype);
    mem.storagePath = root;
    mem.selfModels = {};
    mem.selfModelDir = path.join(root, 'self_model');
    fs.mkdirSync(mem.selfModelDir, { recursive: true });

    const res = mem.upsertSelfTrait('u1', { text: '我不喜欢被叫全名', confidence: 0.9, source: 'test' });
    assert.equal(res.saved, true);

    const filePath = path.join(root, 'self_model', 'u1.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(data.schemaVersion, CURRENT_VERSIONS.selfModel); // 结构版本号已盖
    assert.equal(data.version, 1);                                // 白名单重建依赖的 version 仍在
    assert.equal(data.traits.length, 1);

    // 新实例从盘读回（不命中内存缓存），验证 traits 往返一致
    const mem2 = Object.create(MemoryModule.prototype);
    mem2.storagePath = root;
    mem2.selfModels = {};
    mem2.selfModelDir = mem.selfModelDir;
    const model = mem2.loadSelfModel('u1');
    assert.equal(model.traits.length, 1);
    assert.equal(model.traits[0].text, '我不喜欢被叫全名');
  } finally {
    cleanup(root);
  }
});
