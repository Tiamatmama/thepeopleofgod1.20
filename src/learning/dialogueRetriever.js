const axios = require('axios');
const globalConfig = require('../core/globalConfig');
const { httpsAgent } = require('./qdrantAgent');

require('../core/config');

// 招呼类话语：必须「同类回应」（问候对问候、道别对道别），否则就是答非所问
const SAME_TYPE_TYPES = ['greeting', 'farewell'];

const GREETING_RE =
    /^(你好|您好|哈喽|哈啰|嗨|hi|hello|早上好|早安|早啊|中午好|下午好|晚上好|好久不见|在吗|在么|在的|在呢|幸会)/i;
const FAREWELL_RE = /(再见|拜拜|拜了|回见|回头见|下次聊|再聊|先这样|我走了|先走了|晚安|886|bye|goodbye)/i;
const THANKS_RE = /(谢谢|多谢|感谢|谢了|3q|thank)/i;
const APOLOGY_RE = /(对不起|抱歉|不好意思|对不住|我错了|原谅我)/i;

// 把一句话归到某个句式类型，用于匹配「同类型」的回应
function classifyLine(text) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t) return 'other';
    if (GREETING_RE.test(t)) return 'greeting';
    if (FAREWELL_RE.test(t)) return 'farewell';
    if (THANKS_RE.test(t)) return 'thanks';
    if (APOLOGY_RE.test(t)) return 'apology';
    if (/[?？]$/.test(t)) return 'question';
    return 'other';
}

// 从 Qdrant 的对话语料库中检索与输入最相似的台词，作为语义分析的回应来源
class DialogueRetriever {
    constructor() {
        // 阈值是调参项，仍由 .env 提供
        this.scoreThreshold = parseFloat(process.env.DIALOGUE_SCORE_THRESHOLD || '0.75');
        // 日常句语义分散、相似度天然偏低，用更宽松的阈值，避免「我饿了」这类句子全部落空
        this.otherThreshold = parseFloat(process.env.DIALOGUE_SCORE_THRESHOLD_OTHER || '0.66');
        this.timeout = 8000;
    }

    // Embedding / Qdrant 走全局服务配置（.env 兜底），每次检索都实时读取，
    // 因此在网页上改完地址/密钥后立即生效，无需重启
    getConnection() {
        const embedding = globalConfig.getEmbedding();
        const qdrant = globalConfig.getQdrant();
        return {
            embeddingUrl: embedding.url,
            token: embedding.token,
            model: embedding.modelId,
            qdrantUrl: (qdrant.url || '').replace(/\/+$/, ''),
            qdrantApiKey: qdrant.apiKey,
            collection: qdrant.dialogueCollection
        };
    }

    isEnabled() {
        const conn = this.getConnection();
        return !!(conn.embeddingUrl && conn.token && conn.qdrantUrl && conn.qdrantApiKey);
    }

    async embed(text) {
        const conn = this.getConnection();
        const res = await axios.post(
            conn.embeddingUrl,
            { model: conn.model, input: [{ type: 'text', text }] },
            {
                timeout: this.timeout,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${conn.token}`
                }
            }
        );
        const data = res.data && res.data.data;
        const embedding = Array.isArray(data) ? data[0] && data[0].embedding : data && data.embedding;
        if (!Array.isArray(embedding)) {
            throw new Error('embedding 返回结构异常');
        }
        return embedding;
    }

    // 命中返回 { reply, matchedInput, score, title }，未命中或不可用返回 null
    async retrieve(text) {
        if (!this.isEnabled()) return null;
        const queryType = classifyLine(text);
        const requireSameType = SAME_TYPE_TYPES.includes(queryType);
        // 招呼类用严格阈值 + 同类型强制；日常句用宽松阈值
        const threshold = requireSameType ? this.scoreThreshold : this.otherThreshold;
        const conn = this.getConnection();
        try {
            const vector = await this.embed(text);
            // 多取一些候选，好在其中挑「同类型」的回应
            const res = await axios.post(
                `${conn.qdrantUrl}/collections/${conn.collection}/points/search`,
                { vector, limit: 20, with_payload: true, score_threshold: threshold },
                {
                    timeout: this.timeout,
                    headers: { 'api-key': conn.qdrantApiKey, 'Content-Type': 'application/json' },
                    httpsAgent
                }
            );

            const hits = res.data && res.data.result;
            if (!Array.isArray(hits) || hits.length === 0) return null;

            // 问候/道别要求「同类回应」：候选里必须有同类型的回应，否则宁可不答
            let best = hits[0];
            if (requireSameType) {
                const sameType = hits.find((hit) => (hit.payload || {}).replyType === queryType);
                if (!sameType) return null;
                best = sameType;
            }

            const payload = best.payload || {};
            if (!payload.reply) return null;

            return {
                reply: payload.reply,
                matchedInput: payload.input || '',
                score: best.score,
                title: payload.title || ''
            };
        } catch (error) {
            const detail = error.response ? `${error.response.status}` : error.message;
            console.error(`[DialogueRetriever] 检索失败(${detail})，降级到本地训练数据`);
            return null;
        }
    }
}

module.exports = DialogueRetriever;
module.exports.classifyLine = classifyLine;
module.exports.SAME_TYPE_TYPES = SAME_TYPE_TYPES;
