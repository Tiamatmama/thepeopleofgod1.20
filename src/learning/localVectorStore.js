'use strict';

// 📦 本地向量索引：Qdrant 的可替换后端（进程内暴力余弦）
//
// 为什么可以本地化：索引是「派生数据」，真源永远是 data/user_memories 的 JSON；
// 索引丢了可以重扫重建，所以换实现的风险很低。
// 为什么不用 HNSW：当前量级只有几千条记忆，2048 维全量点积在 10ms 级，
// 引入原生依赖或本地 Qdrant 服务反而是净增运维。
//
// 接口与 memoryVectorStore 保持一致（isEnabled / embed / upsert / upsertPoints /
// search / scrollUserMids / ensureCollection），上层调用方不需要知道自己接的是哪种后端。
//
// 存储：data/vector_index/<collection>/<userId>.json
//   { version, dim, updatedAt, points: { [mid]: { text, ts, vec: base64(float32) } } }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { writeJsonAtomicSync } = require('../storage/atomicWrite');

const INDEX_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MIN_VECTOR_TEXT_LEN = 4;
const SELF_HIT_WINDOW_MS = 10 * 60 * 1000;

function safeUserId(userId) {
    const text = String(userId == null ? '' : userId).trim();
    if (SAFE_ID.test(text)) return text;
    return 'h_' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function effectiveLen(text) {
    return String(text || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;
}

function encodeVector(vector) {
    return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

function decodeVector(text) {
    const buffer = Buffer.from(String(text || ''), 'base64');
    return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

function cosine(a, b) {
    const length = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class LocalVectorStore {
    // embed / isEmbeddingEnabled 由外层注入：embedding 调用逻辑只有一份（memoryVectorStore）。
    constructor({ embed, isEmbeddingEnabled, baseDir, collection } = {}) {
        this.embedFn = typeof embed === 'function' ? embed : null;
        this.enabledFn = typeof isEmbeddingEnabled === 'function' ? isEmbeddingEnabled : () => false;
        this.collection = collection || process.env.LOCAL_VECTOR_COLLECTION || 'user_memories';
        this.scoreThreshold = parseFloat(process.env.MEMORY_SCORE_THRESHOLD || '0.42');
        this.baseDir = baseDir || path.join(__dirname, '../../data/vector_index');
    }

    isEnabled() {
        return !!this.embedFn && this.enabledFn();
    }

    filePath(userId) {
        return path.join(this.baseDir, this.collection, `${safeUserId(userId)}.json`);
    }

    ensureCollection() {
        try {
            fs.mkdirSync(path.join(this.baseDir, this.collection), { recursive: true });
            return true;
        } catch (error) {
            console.warn(`[LocalVector] 索引目录不可用：${error.message}`);
            return false;
        }
    }

    embed(text) {
        return this.embedFn ? this.embedFn(text) : Promise.resolve(null);
    }

    load(userId) {
        try {
            const raw = fs.readFileSync(this.filePath(userId), 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !parsed.points) {
                return { version: INDEX_VERSION, dim: 0, updatedAt: '', points: {} };
            }
            return {
                version: Number(parsed.version) || INDEX_VERSION,
                dim: Number(parsed.dim) || 0,
                updatedAt: parsed.updatedAt || '',
                points: parsed.points
            };
        } catch (error) {
            // 文件不存在 = 该用户还没有索引，返回空而不是失败
            if (error.code === 'ENOENT') {
                return { version: INDEX_VERSION, dim: 0, updatedAt: '', points: {} };
            }
            throw error;
        }
    }

    save(userId, index) {
        index.updatedAt = new Date().toISOString();
        writeJsonAtomicSync(this.filePath(userId), index);
    }

    // 维度变化（换了 embedding 模型）时旧向量一律作废，避免拿不同空间的距离硬算
    ensureDim(index, dim) {
        if (index.dim === dim) return index;
        if (index.dim && index.dim !== dim) {
            console.warn(`[LocalVector] 向量维度 ${index.dim} → ${dim}，旧索引已重置`);
        }
        return { version: INDEX_VERSION, dim, updatedAt: '', points: {} };
    }

    async upsert(userId, memory) {
        const text = String((memory && memory.data) || '').trim();
        if (!userId || !text || !this.isEnabled()) return false;
        if (effectiveLen(text) < MIN_VECTOR_TEXT_LEN) return false;
        if (!this.ensureCollection()) return false;
        try {
            const vector = await this.embed(text);
            if (!Array.isArray(vector) && !(vector instanceof Float32Array)) return false;
            const index = this.ensureDim(this.load(userId), vector.length);
            index.points[String(memory.id)] = {
                text: text.slice(0, 5000),
                ts: memory.timestamp || Date.now(),
                vec: encodeVector(vector)
            };
            this.save(userId, index);
            return true;
        } catch (error) {
            // 与远端同一约定：索引失败只警告，本地记忆照常
            console.warn(`[LocalVector] 写入失败：${error.message}`);
            return false;
        }
    }

    // 迁移脚本用：points 形如 [{ id, vector, payload: { userId, mid, text, ts } }]
    async upsertPoints(points) {
        if (!Array.isArray(points) || points.length === 0) return;
        if (!this.ensureCollection()) throw new Error('本地索引不可用');
        const grouped = new Map();
        for (const point of points) {
            const payload = (point && point.payload) || {};
            const userId = String(payload.userId || '');
            const mid = String(payload.mid || point.id || '');
            const vector = point && point.vector;
            if (!userId || !mid || !Array.isArray(vector) || !vector.length) continue;
            if (!grouped.has(userId)) grouped.set(userId, []);
            grouped.get(userId).push({ mid, vector, payload });
        }
        for (const [userId, items] of grouped) {
            let index = this.ensureDim(this.load(userId), items[0].vector.length);
            for (const item of items) {
                if (item.vector.length !== index.dim) continue;
                index.points[item.mid] = {
                    text: String(item.payload.text || '').slice(0, 5000),
                    ts: item.payload.ts || Date.now(),
                    vec: encodeVector(item.vector)
                };
            }
            this.save(userId, index);
        }
    }

    // 返回 [{mid, text, ts, score}]；链路/embedding 不可用返回 null（调用方回退字面召回）
    async search(userId, query, limit = 10) {
        if (!userId || !query || !this.isEnabled()) return null;
        if (!this.ensureCollection()) return null;
        let vector;
        try {
            vector = await this.embed(query);
        } catch (error) {
            console.warn(`[LocalVector] 查询向量失败：${error.message}`);
            return null;
        }
        if (!Array.isArray(vector) && !(vector instanceof Float32Array)) return null;

        let index;
        try {
            index = this.load(userId);
        } catch (error) {
            console.warn(`[LocalVector] 读取索引失败：${error.message}`);
            return null;
        }

        const queryVector = new Float32Array(vector);
        const hits = [];
        for (const [mid, point] of Object.entries(index.points)) {
            if (!point || !point.vec) continue;
            const score = cosine(queryVector, decodeVector(point.vec));
            if (score < this.scoreThreshold) continue;
            hits.push({ mid, text: String(point.text || ''), ts: point.ts || 0, score });
        }
        hits.sort((a, b) => b.score - a.score);

        const queryText = String(query).trim();
        const recentCutoff = Date.now() - SELF_HIT_WINDOW_MS;
        const out = [];
        for (const hit of hits) {
            if (hit.text.trim() === queryText) continue;
            if (hit.ts && hit.ts >= recentCutoff) continue;
            out.push(hit);
            if (out.length >= limit) break;
        }
        return out;
    }

    async scrollUserMids(userId) {
        if (!userId || !this.isEnabled()) return null;
        if (!this.ensureCollection()) return null;
        try {
            const index = this.load(userId);
            return new Set(Object.keys(index.points));
        } catch (error) {
            console.warn(`[LocalVector] 索引自检失败：${error.message}`);
            return null;
        }
    }
}

module.exports = LocalVectorStore;
