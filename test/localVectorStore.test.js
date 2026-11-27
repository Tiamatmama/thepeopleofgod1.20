'use strict';

// 本地向量索引：与远端同一套接口契约（含 null 降级语义），额外验证落盘、用户隔离与维度迁移。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalVectorStore = require('../src/learning/localVectorStore');
const { pickStore } = require('../src/learning/vectorStore');

const VECTORS = {
  '猫在窗台上晒太阳': [1, 0, 0, 0],
  '猫咪喜欢阳光': [0.92, 0.08, 0, 0],
  '今天天气不好': [0, 1, 0, 0],
  '她昨天提到了搬家': [0, 0, 1, 0]
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-vector-'));
}

function makeStore({ baseDir = tempDir(), embed, enabled = true } = {}) {
  return new LocalVectorStore({
    baseDir,
    collection: 'test_memories',
    embed: embed || (async (text) => VECTORS[text] || [0, 0, 0, 1]),
    isEmbeddingEnabled: () => enabled
  });
}

test('写入后能按语义召回：mid、文本、分数都在', async () => {
  const store = makeStore();
  assert.equal(await store.upsert('u1', { id: 'm1', data: '猫在窗台上晒太阳', timestamp: 1 }), true);
  const hits = await store.search('u1', '猫咪喜欢阳光', 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mid, 'm1');
  assert.equal(hits[0].text, '猫在窗台上晒太阳');
  assert.ok(hits[0].score > 0.9);
});

test('用户物理隔离：查不到别人的记忆', async () => {
  const store = makeStore();
  await store.upsert('u1', { id: 'm1', data: '猫在窗台上晒太阳', timestamp: 1 });
  assert.deepEqual(await store.search('u2', '猫咪喜欢阳光', 5), []);
});

test('短语气词不入索引（与远端同一规则）', async () => {
  const store = makeStore();
  assert.equal(await store.upsert('u1', { id: 'm1', data: '好的', timestamp: 1 }), false);
  const mids = await store.scrollUserMids('u1');
  assert.equal(mids.size, 0);
});

test('低于阈值的候选不返回', async () => {
  const store = makeStore();
  await store.upsert('u1', { id: 'm1', data: '猫在窗台上晒太阳', timestamp: 1 });
  assert.deepEqual(await store.search('u1', '今天天气不好', 5), []);
});

test('剔除原话自命中与最近 10 分钟的眼前对话', async () => {
  const store = makeStore();
  await store.upsert('u1', { id: 'self', data: '猫咪喜欢阳光', timestamp: 1 });
  await store.upsert('u1', { id: 'fresh', data: '猫在窗台上晒太阳', timestamp: Date.now() });
  const hits = await store.search('u1', '猫咪喜欢阳光', 5);
  assert.deepEqual(hits, []);
});

test('落盘可恢复：换一个实例仍能召回', async () => {
  const baseDir = tempDir();
  const first = makeStore({ baseDir });
  await first.upsert('u1', { id: 'm1', data: '猫在窗台上晒太阳', timestamp: 1 });
  const second = makeStore({ baseDir });
  const hits = await second.search('u1', '猫咪喜欢阳光', 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mid, 'm1');
});

test('upsertPoints：迁移脚本批量导入后可直接检索', async () => {
  const store = makeStore();
  await store.upsertPoints([
    { id: 'p1', vector: [1, 0, 0, 0], payload: { userId: 'u1', mid: 'm1', text: '猫在窗台上晒太阳', ts: 1 } }
  ]);
  const hits = await store.search('u1', '猫咪喜欢阳光', 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mid, 'm1');
});

test('embedding 抛错：search 返回 null，调用方回退字面召回', async () => {
  const store = makeStore({ embed: async () => { throw new Error('network down'); } });
  assert.equal(await store.search('u1', '随便问一句'), null);
});

test('维度变化：旧索引整体作废，不拿不同空间的向量硬算', async () => {
  const baseDir = tempDir();
  const four = makeStore({ baseDir });
  await four.upsert('u1', { id: 'm1', data: '猫在窗台上晒太阳', timestamp: 1 });
  const three = new LocalVectorStore({
    baseDir,
    collection: 'test_memories',
    embed: async () => [1, 0, 0],
    isEmbeddingEnabled: () => true
  });
  await three.upsert('u1', { id: 'm2', data: '她昨天提到了搬家', timestamp: 1 });
  const mids = await three.scrollUserMids('u1');
  assert.deepEqual([...mids], ['m2']);
});

test('索引未启用时 search 返回 null（不是空数组）', async () => {
  const store = makeStore({ enabled: false });
  assert.equal(await store.search('u1', '猫咪喜欢阳光'), null);
});

test('pickStore：配了 Qdrant 选远端，否则选本地', () => {
  const remote = { kind: 'remote' };
  const local = { kind: 'local' };
  assert.equal(pickStore({ remote, local, remoteReady: true }), remote);
  assert.equal(pickStore({ remote, local, remoteReady: false }), local);
});
