'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const MemoryVectorStore = require('../src/learning/memoryVectorStore');
const dialogue = require('../src/learning/dialogueRetriever');
const VectorLearner = require('../src/learning/vectorLearner');

// 学习层此前零测试。这里只覆盖「不触网也能验证」的关键契约：
//   1) 云端不可用 / 链路失败时的降级语义（必须返回 null，调用方据此回退本地）
//   2) pointId 幂等与用户物理隔离
//   3) classifyLine 六类句式（纯函数）
//   4) VectorLearner 落盘路径必须显式指定（防"忘传参"静默写错文件）

// 造一个只带被测方法所需字段的 store，避开真实构造（构造会读 globalConfig）。
function makeStore(overrides = {}) {
    const store = Object.create(MemoryVectorStore.prototype);
    store.collection = 'test_memories';
    store.scoreThreshold = 0.42;
    store.ensured = null;
    store.embedCache = new Map();
    return Object.assign(store, overrides);
}

test('学习层降级：向量功能未启用时 search 返回 null（不是空数组）', async () => {
    const store = makeStore({ isEnabled: () => false });
    assert.equal(await store.search('u1', '随便一句话'), null);
});

test('学习层降级：集合不可用时 search 返回 null，调用方回退本地字面召回', async () => {
    const store = makeStore({
        isEnabled: () => true,
        ensureCollection: async () => false
    });
    assert.equal(await store.search('u1', '随便一句话'), null);
});

test('pointId：同一 (userId, memoryId) 幂等，不同用户物理隔离', () => {
    const store = makeStore();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    const a1 = store.pointId('u1', 'm1');
    const a2 = store.pointId('u1', 'm1');
    const b = store.pointId('u2', 'm1');

    assert.equal(a1, a2);                 // 反复写同一条记忆 → 同 id，幂等覆盖
    assert.match(a1, uuidRe);             // Qdrant 只认 UUID
    assert.notEqual(a1, b);               // 不同用户即使 memoryId 相同也不撞
});

test('classifyLine：问候/道别/致谢/道歉/疑问/日常 六类归位', () => {
    const c = dialogue.classifyLine;
    assert.equal(c('你好'), 'greeting');
    assert.equal(c('再见'), 'farewell');
    assert.equal(c('谢谢你'), 'thanks');
    assert.equal(c('对不起'), 'apology');
    assert.equal(c('你吃饭了吗？'), 'question');
    assert.equal(c('今天天气不错'), 'other');
    assert.equal(c(''), 'other');         // 空串落 other，不抛
});

test('VectorLearner：未显式指定 storagePath 时构造失败（防静默写错文件）', () => {
    assert.throws(() => new VectorLearner(), /storagePath/);
    // 显式指定一个不存在的临时路径：只读不写，构造应成功且训练集为空
    const tmp = path.join(os.tmpdir(), `vl-test-${Date.now()}-${process.pid}.json`);
    const learner = new VectorLearner(tmp);
    assert.deepEqual(learner.trainingData, []);
    assert.equal(learner.storagePath, tmp);
});
