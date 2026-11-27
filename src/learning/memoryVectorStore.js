const crypto = require('crypto');
const axios = require('axios');
const globalConfig = require('../core/globalConfig');
const { httpsAgent } = require('./qdrantAgent');

require('../core/config');

// 🧠 长期记忆向量库（Qdrant collection: user_memories）
//
// 本地 data/user_memories/*.json 永远是记忆的「真相源」，这里只是它的向量索引：
//   - 写入：memory.storeMemory() 落本地后 best-effort 异步双写一份向量，失败只警告不丢记忆
//   - 读取：向量命中后还要回本地按 mid 校验，本地已经删掉/挤掉的旧记忆即使残留在云端也不会被召回
//   - 多用户：payload 带 userId，search 时强制 filter，各用户之间物理隔离
//
// point id 用 userId + memoryId 的 md5 摊成 UUID——同一条记忆反复写也是幂等覆盖，迁移可安全重跑。

const TIMEOUT_MS = 8000;
const VECTOR_SIZE = 2048;
// 实测无阈值分布：真正跨句召回的质量带在 0.42~0.81，0.30 会放进 0.32 的「亲」这类语气词凑数
const DEFAULT_SCORE_THRESHOLD = 0.42;
const EMBED_CACHE_MAX = 300;
// 🚫 短于这个长度的纯语气词（亲/喵/好了/爱你…）不进向量库：它们语义上到处撞，分数还不低
const MIN_VECTOR_TEXT_LEN = 4;
// 最近 10 分钟说过的话不进长期记忆召回——眼前对话短期历史里已经有，召回它纯属浪费名额
const SELF_HIT_WINDOW_MS = 10 * 60 * 1000;
// 记忆库探测失败后的冷却时间：以前一失败就整进程停用，一次网络抖动会让向量召回永久失效
const ENSURE_RETRY_MS = 5 * 60 * 1000;

// 去掉标点空白后数有效字符，用来判断是不是短语气词
function effectiveLen(text) {
    return String(text || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;
}

class MemoryVectorStore {
    constructor() {
        this.collection = process.env.QDRANT_MEMORY_COLLECTION || 'user_memories';
        this.scoreThreshold = parseFloat(process.env.MEMORY_SCORE_THRESHOLD || String(DEFAULT_SCORE_THRESHOLD));
        // null = 还没确认过，true/false = ensureCollection 的结论；失败只冷却一段时间，之后重试
        this.ensured = null;
        this.ensuredRetryAt = 0;
        this.embedCache = new Map();
    }

    getConnection() {
        const embedding = globalConfig.getEmbedding();
        const qdrant = globalConfig.getQdrant();
        return {
            embeddingUrl: embedding.url,
            token: embedding.token,
            model: embedding.modelId,
            qdrantUrl: (qdrant.url || '').replace(/\/+$/, ''),
            qdrantApiKey: qdrant.apiKey
        };
    }

    isEnabled() {
        const conn = this.getConnection();
        return !!(conn.embeddingUrl && conn.token && conn.qdrantUrl && conn.qdrantApiKey);
    }

    cacheKey(text) {
        return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 2000);
    }

    // 同一条记忆反复更新/迁移重跑时不重复花 embedding 的钱（内存缓存，进程内有效）
    async embed(text) {
        const key = this.cacheKey(text);
        if (!key) return null;
        const hit = this.embedCache.get(key);
        if (hit) return hit.vector;

        const conn = this.getConnection();
        // 批量迁移容易触发限流，429 / 5xx 时退避重试 3 次（400 类直接抛出，重试无意义）
        let res;
        for (let attempt = 0; ; attempt++) {
            try {
                res = await axios.post(
                    conn.embeddingUrl,
                    { model: conn.model, input: [{ type: 'text', text: key }] },
                    {
                        timeout: 30000, // 归档摘要很长，给 embedding 多留点时间
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${conn.token}`
                        }
                    }
                );
                break;
            } catch (error) {
                const status = error.response && error.response.status;
                const retryable = status === 429 || (status >= 500 && status < 600);
                if (!retryable || attempt >= 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
        const data = res.data && res.data.data;
        const first = Array.isArray(data) ? data[0] : data;
        const vector = first && first.embedding;
        if (!Array.isArray(vector)) {
            throw new Error('embedding 返回结构异常');
        }

        this.embedCache.set(key, { vector });
        if (this.embedCache.size > EMBED_CACHE_MAX) {
            const oldestKey = this.embedCache.keys().next().value;
            this.embedCache.delete(oldestKey);
        }
        return vector;
    }

    // userId + memoryId → 合法 UUID（Qdrant 的 point id 只认正整数或 UUID）
    pointId(userId, memoryId) {
        const hex = crypto
            .createHash('md5')
            .update(`${userId}|${memoryId}`)
            .digest('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }

    headers(conn) {
        return { 'api-key': conn.qdrantApiKey, 'Content-Type': 'application/json' };
    }

    // 确认 collection 存在，不存在就建；顺带保证 userId 的 keyword 索引就绪
    //（按 userId 过滤必须有索引，否则 Qdrant 直接 400）。失败返回 false 并进入冷却，冷却结束会重新探测
    async ensureCollection() {
        if (this.ensured === true) return true;
        if (this.ensured === false && Date.now() < this.ensuredRetryAt) return false;
        this.ensured = null;
        const conn = this.getConnection();
        try {
            await axios.get(`${conn.qdrantUrl}/collections/${this.collection}`, {
                headers: this.headers(conn),
                httpsAgent,
                timeout: TIMEOUT_MS
            });
        } catch (error) {
            const status = error.response && error.response.status;
            if (status !== 404) {
                console.warn(`[MemoryVector] 检查记忆库失败(${status || error.message})，${ENSURE_RETRY_MS / 60000} 分钟后重试`);
                this.ensured = false;
                this.ensuredRetryAt = Date.now() + ENSURE_RETRY_MS;
                return false;
            }
            try {
                await axios.put(
                    `${conn.qdrantUrl}/collections/${this.collection}`,
                    { vectors: { size: VECTOR_SIZE, distance: 'Cosine' } },
                    { headers: this.headers(conn), httpsAgent, timeout: TIMEOUT_MS }
                );
                console.log(`[MemoryVector] 已创建记忆向量库 ${this.collection}`);
            } catch (createError) {
                console.warn(`[MemoryVector] 创建记忆库失败:${createError.message}，${ENSURE_RETRY_MS / 60000} 分钟后重试`);
                this.ensured = false;
                this.ensuredRetryAt = Date.now() + ENSURE_RETRY_MS;
                return false;
            }
        }

        // 幂等建 userId 索引：已存在时 Qdrant 返回错误，忽略即可
        try {
            await axios.put(
                `${conn.qdrantUrl}/collections/${this.collection}/index`,
                { field_name: 'userId', field_schema: 'keyword' },
                { headers: this.headers(conn), httpsAgent, timeout: TIMEOUT_MS }
            );
            console.log('[MemoryVector] userId 过滤索引已就绪');
        } catch (indexError) {
            const st = indexError.response && indexError.response.status;
            // 409 = 索引已存在；已存在也是就绪
            if (st !== 409) {
                console.warn(`[MemoryVector] userId 索引创建失败(${st || indexError.message})，按用户过滤暂不可用`);
                this.ensured = false;
                this.ensuredRetryAt = Date.now() + ENSURE_RETRY_MS;
                return false;
            }
        }
        this.ensured = true;
        return this.ensured;
    }

    // 单条记忆双写（best-effort：失败只警告，不影响本地记忆）
    async upsert(userId, memory) {
        const text = String((memory && memory.data) || '').trim();
        if (!userId || !text || !this.isEnabled()) return false;
        // 🚫 纯语气词短条目不进向量库（本地记忆照存，只不做语义索引）
        if (effectiveLen(text) < MIN_VECTOR_TEXT_LEN) return false;
        if (!(await this.ensureCollection())) return false;

        const conn = this.getConnection();
        const vector = await this.embed(text);
        if (!vector) return false;

        await axios.put(
            `${conn.qdrantUrl}/collections/${this.collection}/points?wait=true`,
            {
                points: [
                    {
                        id: this.pointId(userId, memory.id),
                        vector,
                        payload: {
                            userId: String(userId),
                            mid: String(memory.id),
                            text: text.slice(0, 5000),
                            ts: memory.timestamp || Date.now()
                        }
                    }
                ]
            },
            { headers: this.headers(conn), httpsAgent, timeout: TIMEOUT_MS }
        );
        return true;
    }

    // 批量双写：迁移脚本用。points 由外部准备好（含 vector），失败抛给调用方计数
    async upsertPoints(points) {
        if (!points || points.length === 0) return;
        if (!(await this.ensureCollection())) {
            throw new Error('记忆库不可用');
        }
        const conn = this.getConnection();
        await axios.put(
            `${conn.qdrantUrl}/collections/${this.collection}/points?wait=true`,
            { points },
            { headers: this.headers(conn), httpsAgent, timeout: 120000 }
        );
    }

    // 向量召回：强制按 userId 过滤。返回 [{mid, text, score, ts}]，任何失败返回 null（调用方回退本地）
    async search(userId, query, limit = 10) {
        if (!userId || !query || !this.isEnabled()) return null;
        if (!(await this.ensureCollection())) return null;

        const conn = this.getConnection();
        const vector = await this.embed(query);
        if (!vector) return null;

        // 多取一些：下面要剔除「query 原话自命中」和「最近 10 分钟的眼前对话」，先留足余量
        const fetchLimit = Math.min(limit * 4, 40);
        const res = await axios.post(
            `${conn.qdrantUrl}/collections/${this.collection}/points/search`,
            {
                vector,
                limit: fetchLimit,
                with_payload: true,
                with_vector: false,
                score_threshold: this.scoreThreshold,
                filter: {
                    must: [{ key: 'userId', match: { value: String(userId) } }]
                }
            },
            { headers: this.headers(conn), httpsAgent, timeout: TIMEOUT_MS }
        );
        const hits = res.data && res.data.result;
        if (!Array.isArray(hits)) return [];

        const queryText = String(query).trim();
        const recentCutoff = Date.now() - SELF_HIT_WINDOW_MS;
        const out = [];
        for (const hit of hits) {
            const payload = hit.payload || {};
            const text = String(payload.text || '');
            // 剔除原话自命中（用户刚说的这句自己在库里排第一，信息量为零）
            if (text.trim() === queryText) continue;
            // 剔除最近 10 分钟的眼前对话：短期历史里已有，不该占长期记忆召回的名额
            if (payload.ts && payload.ts >= recentCutoff) continue;
            out.push({
                mid: String(payload.mid || ''),
                text,
                ts: payload.ts || 0,
                score: hit.score
            });
            if (out.length >= limit) break;
        }
        return out;
    }

    // 索引自检用：把某个 userId 下已入库的记忆 mid 全部翻出来（分页 scroll）。
    // 失败返回 null（与 search 同一约定：null 表示链路不通，不是「没有数据」）
    async scrollUserMids(userId) {
        if (!userId || !this.isEnabled()) return null;
        if (!(await this.ensureCollection())) return null;

        const conn = this.getConnection();
        const mids = new Set();
        let offset = null;
        try {
            for (;;) {
                const body = {
                    filter: { must: [{ key: 'userId', match: { value: String(userId) } }] },
                    limit: 400,
                    with_payload: true,
                    with_vector: false
                };
                if (offset) body.offset = offset;
                const res = await axios.post(
                    `${conn.qdrantUrl}/collections/${this.collection}/points/scroll`,
                    body,
                    { headers: this.headers(conn), httpsAgent, timeout: TIMEOUT_MS }
                );
                const points = (res.data && res.data.result && res.data.result.points) || [];
                points.forEach((point) => {
                    const mid = String((point.payload && point.payload.mid) || '');
                    if (mid) mids.add(mid);
                });
                offset = res.data && res.data.result && res.data.result.next_page_offset;
                if (!offset || points.length === 0) break;
            }
        } catch (error) {
            console.warn(`[MemoryVector] 索引自检翻页失败(${error.response ? error.response.status : error.message})`);
            return null;
        }
        return mids;
    }
}

module.exports = MemoryVectorStore;
