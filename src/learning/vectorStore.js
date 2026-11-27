'use strict';

// 🔀 向量后端选择：配了 Qdrant 就走远端，否则用进程内本地索引。
// 上层（memory.js）只依赖这个工厂，不关心后端差异；两条路径的接口完全一致。

const MemoryVectorStore = require('./memoryVectorStore');
const LocalVectorStore = require('./localVectorStore');

// 纯选择函数，便于单测：不构造真实 store，也不读环境变量。
function pickStore({ remote, local, remoteReady }) {
    return remoteReady ? remote : local;
}

function createVectorStore({ baseDir } = {}) {
    const remote = new MemoryVectorStore();
    const conn = remote.getConnection();
    const remoteReady = !!(conn.qdrantUrl && conn.qdrantApiKey);
    const local = new LocalVectorStore({
        embed: (text) => remote.embed(text),
        isEmbeddingEnabled: () => !!(conn.embeddingUrl && conn.token),
        baseDir
    });
    return pickStore({ remote, local, remoteReady });
}

module.exports = { createVectorStore, pickStore };
