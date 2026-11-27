const axios = require('axios');
const globalConfig = require('../core/globalConfig');
const { httpsAgent } = require('./qdrantAgent');

require('../core/config');

// 📚 知识库检索器：查 Qdrant 里的豆瓣书摘库（douban_books）
// 目前专供自主发言证据层使用——角色可以顺着最近聊的话题，翻出一本"她读过的书"，
// 把书里的金句/简介当真实素材转述，而不是凭空编名人名言。
//
// 与 dialogueRetriever 的关系：
//   dialogueRetriever 查 semantic_dialogues（台词对），解决"怎么回"
//   knowledgeRetriever 查 douban_books（书摘），解决"说什么有出处"
//
// 所有失败一律静默降级返回 null，绝不能因为云端 Qdrant / Embedding 抖动就把发言链路搞挂。

// 书库向量是用「书名+作者+评分+900字简介」的长拼接文本做的，语义被稀释，
// 实测相关话题（迷茫/自由/江湖/爱情）分数在 0.28~0.40，无关话题（吃什么）约 0.22，
// 阈值卡在两者之间 0.27
const DEFAULT_SCORE_THRESHOLD = 0.27;
const TIMEOUT_MS = 8000;
// query 向量内存缓存条数：同一句话（比如用户反复问"你好"）不重复花钱 embed
const EMBED_CACHE_MAX = 300;

class KnowledgeRetriever {
    constructor() {
        this.scoreThreshold = parseFloat(process.env.BOOK_SCORE_THRESHOLD || String(DEFAULT_SCORE_THRESHOLD));
        // key = 归一化后的 query 文本，value = { vector, at }
        this.embedCache = new Map();
    }

    // 配置实时读 globalConfig（网页改完立即生效，不用重启）
    getConnection() {
        const embedding = globalConfig.getEmbedding();
        const qdrant = globalConfig.getQdrant();
        return {
            embeddingUrl: embedding.url,
            token: embedding.token,
            model: embedding.modelId,
            qdrantUrl: (qdrant.url || '').replace(/\/+$/, ''),
            qdrantApiKey: qdrant.apiKey,
            collection: qdrant.bookCollection
        };
    }

    isEnabled() {
        const conn = this.getConnection();
        return !!(conn.embeddingUrl && conn.token && conn.qdrantUrl && conn.qdrantApiKey && conn.collection);
    }

    // 文本归一化后做缓存 key：去首尾空白 + 压连续空格
    cacheKey(text) {
        return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    }

    // 调 embedding 接口，带内存缓存（缓存只存进程生命周期内，重启清空，不碰磁盘不落隐私）
    async embed(text) {
        const key = this.cacheKey(text);
        if (!key) return null;
        const hit = this.embedCache.get(key);
        if (hit) {
            return hit.vector;
        }

        const conn = this.getConnection();
        const res = await axios.post(
            conn.embeddingUrl,
            { model: conn.model, input: [{ type: 'text', text: key }] },
            {
                timeout: TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${conn.token}`
                }
            }
        );
        const data = res.data && res.data.data;
        // 火山这个接口的 data 既可能是数组也可能是对象，两种都兜住
        const first = Array.isArray(data) ? data[0] : data;
        const vector = first && first.embedding;
        if (!Array.isArray(vector)) {
            throw new Error('embedding 返回结构异常');
        }

        this.embedCache.set(key, { vector, at: Date.now() });
        if (this.embedCache.size > EMBED_CACHE_MAX) {
            // Map 保持插入顺序，删最旧的一条就行
            const oldestKey = this.embedCache.keys().next().value;
            this.embedCache.delete(oldestKey);
        }
        return vector;
    }

    // 把书的 payload 编成适合做"素材卡"的文本
    // 主语料用简介开头（够长、信息稳）；quote 字段里混着不少豆瓣标签式短评
    //（如"名侦探的代名词"），太短的不像是书里的话，只有 ≥10 字的才当名句附上
    formatBookPayload(payload = {}) {
        const title = String(payload.title || '').trim();
        const author = String(payload.author || '').trim();
        const quote = String(payload.quote || '').trim();
        const intro = String(payload.intro || '').trim();

        const head = title ? `《${title}》${author ? `（${author}）` : ''}` : '';
        let text = head ? `${head}。` : '';
        if (intro) {
            // 简介只取前 220 字，素材卡自己还会再截一次，别让一条书占掉全部额度
            text += intro.slice(0, 220);
        }
        if (quote && quote.length >= 10) {
            text += ` 书中名句：「${quote}」`;
        }
        // 简介和长名句都没有时，才退而用短 quote 兜底（哪怕它像标签）
        if (!intro && quote) {
            text += quote;
        }
        return text.trim();
    }

    // 检索书摘，返回原始命中数组（已按分排序、过阈值），任何失败返回 null
    async searchBooks(query, limit = 5) {
        if (!this.isEnabled()) return null;
        const key = this.cacheKey(query);
        if (!key) return null;

        const conn = this.getConnection();
        try {
            const vector = await this.embed(key);
            if (!vector) return null;

            const res = await axios.post(
                `${conn.qdrantUrl}/collections/${conn.collection}/points/search`,
                {
                    vector,
                    limit,
                    with_payload: true,
                    with_vector: false,
                    score_threshold: this.scoreThreshold
                },
                {
                    timeout: TIMEOUT_MS,
                    headers: { 'api-key': conn.qdrantApiKey, 'Content-Type': 'application/json' },
                    httpsAgent
                }
            );
            const hits = res.data && res.data.result;
            return Array.isArray(hits) ? hits : [];
        } catch (error) {
            const detail = error.response ? `${error.response.status}` : error.message;
            console.warn(`[KnowledgeRetriever] 书摘检索失败(${detail})，本次不带书摘素材`);
            return null;
        }
    }

    // 给证据层用的便捷方法：只取最贴切的一本书，编成素材卡需要的形状
    // 返回 { source:'书摘', text, title, author, quote, score } 或 null
    async retrieveBookCard(query) {
        const hits = await this.searchBooks(query, 5);
        if (!hits || hits.length === 0) return null;

        const best = hits[0];
        const payload = best.payload || {};
        const text = this.formatBookPayload(payload);
        if (!text) return null;

        return {
            source: '书摘',
            text,
            title: payload.title || '',
            author: payload.author || '',
            quote: payload.quote || '',
            score: best.score
        };
    }
}

module.exports = KnowledgeRetriever;
