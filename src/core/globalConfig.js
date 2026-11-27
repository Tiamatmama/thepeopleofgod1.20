/**
 * 全局服务配置（全局一份，作用于整个服务端）
 *
 * 网页「伪开发者界面 → 全局服务配置」里填写的默认API / Embedding / Qdrant / TTS 配置
 * 持久化到 data/globalConfig.json；文件里没有的字段回退到 .env。
 * 各模块统一从这里读取，因此在网页上改完立即生效，无需改 .env 再重启。
 */

const fs = require('fs');
const path = require('path');

require('./config');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'globalConfig.json');

const SECTION_FIELDS = {
    embedding: ['url', 'token', 'modelId'],
    qdrant: ['url', 'apiKey', 'articleCollection', 'dialogueCollection', 'bookCollection'],
    tts: ['apiKey']
};

function emptyStore() {
    return {
        defaultApi: { doubao: {}, deepseek: {} },
        embedding: {},
        qdrant: {},
        tts: {}
    };
}

function loadStore() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return emptyStore();
        }
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const store = emptyStore();
        const api = raw.defaultApi || {};
        ['doubao', 'deepseek'].forEach((key) => {
            store.defaultApi[key] = { ...(api[key] || {}) };
        });
        Object.keys(SECTION_FIELDS).forEach((section) => {
            store[section] = { ...(raw[section] || {}) };
        });
        return store;
    } catch (error) {
        console.error('[全局配置] 读取失败，改用 .env:', error.message);
        return emptyStore();
    }
}

let store = loadStore();

// 网页上留空的字段视为「不修改」，因此这里只认非空字符串，其余回退 .env
function pick(value, envKey, fallback = '') {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    const env = process.env[envKey];
    if (typeof env === 'string' && env.trim()) {
        return env.trim();
    }
    return fallback;
}

function getDefaultApi() {
    const section = store.defaultApi || {};
    const doubao = section.doubao || {};
    const deepseek = section.deepseek || {};
    return {
        doubao: {
            apiUrl: pick(doubao.apiUrl, 'DOUBAO_API_URL', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'),
            bearerToken: pick(doubao.bearerToken, 'DOUBAO_BEARER_TOKEN', ''),
            modelId: pick(doubao.modelId, 'DOUBAO_MODEL_ID', 'doubao-1.5-lite-32k-250115'),
            name: '豆包'
        },
        deepseek: {
            apiUrl: pick(deepseek.apiUrl, 'DEEPSEEK_API_URL', 'https://api.deepseek.com/v1/chat/completions'),
            bearerToken: pick(deepseek.bearerToken, 'DEEPSEEK_BEARER_TOKEN', ''),
            modelId: pick(deepseek.modelId, 'DEEPSEEK_MODEL_ID', 'deepseek-flash'),
            name: 'DeepSeek'
        }
    };
}

function getEmbedding() {
    const section = store.embedding || {};
    return {
        url: pick(section.url, 'EMBEDDING_API_URL', 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal'),
        token: pick(section.token, 'EMBEDDING_BEARER_TOKEN', ''),
        modelId: pick(section.modelId, 'EMBEDDING_MODEL_ID', 'doubao-embedding-vision-251215')
    };
}

function getQdrant() {
    const section = store.qdrant || {};
    return {
        url: pick(section.url, 'QDRANT_URL', ''),
        apiKey: pick(section.apiKey, 'QDRANT_API_KEY', ''),
        articleCollection: pick(section.articleCollection, 'QDRANT_ARTICLE_COLLECTION', 'web_articles'),
        dialogueCollection: pick(section.dialogueCollection, 'QDRANT_DIALOGUE_COLLECTION', 'semantic_dialogues'),
        // 📚 豆瓣书摘库（.env 里用的是最早的通用名 QDRANT_COLLECTION）
        bookCollection: pick(section.bookCollection, 'QDRANT_COLLECTION', 'douban_books')
    };
}

function getTTS() {
    const section = store.tts || {};
    return { apiKey: pick(section.apiKey, 'TTS_API_KEY', '') };
}

function mask(secret) {
    if (!secret) return '';
    if (secret.length <= 8) return '****';
    return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

// 回给网页的配置：密钥只回打码值，避免真实密钥出现在前端
function getMasked() {
    const api = getDefaultApi();
    const embedding = getEmbedding();
    const qdrant = getQdrant();
    const tts = getTTS();
    return {
        defaultApi: {
            doubao: {
                apiUrl: api.doubao.apiUrl,
                modelId: api.doubao.modelId,
                tokenMasked: mask(api.doubao.bearerToken)
            },
            deepseek: {
                apiUrl: api.deepseek.apiUrl,
                modelId: api.deepseek.modelId,
                tokenMasked: mask(api.deepseek.bearerToken)
            }
        },
        embedding: {
            url: embedding.url,
            modelId: embedding.modelId,
            tokenMasked: mask(embedding.token)
        },
        qdrant: {
            url: qdrant.url,
            articleCollection: qdrant.articleCollection,
            dialogueCollection: qdrant.dialogueCollection,
            bookCollection: qdrant.bookCollection,
            apiKeyMasked: mask(qdrant.apiKey)
        },
        tts: {
            apiKeyMasked: mask(tts.apiKey)
        }
    };
}

// 把默认大模型配置写进 global.API_CONFIG。它是同一个对象引用，
// 各模块构造时捕获的 APIManager 因此能在修改后立即生效，无需重启
function applyToRuntime() {
    const api = getDefaultApi();
    if (!global.API_CONFIG) {
        global.API_CONFIG = {};
    }
    ['doubao', 'deepseek'].forEach((key) => {
        if (!global.API_CONFIG[key] || typeof global.API_CONFIG[key] !== 'object') {
            global.API_CONFIG[key] = {};
        }
        const target = global.API_CONFIG[key];
        target.apiUrl = api[key].apiUrl;
        target.bearerToken = api[key].bearerToken;
        target.modelId = api[key].modelId;
        if (!target.name) {
            target.name = api[key].name;
        }
    });
}

function fill(target, incoming, fields) {
    fields.forEach((field) => {
        const value = incoming[field];
        if (typeof value !== 'string') return;
        const trimmed = value.trim();
        if (!trimmed) return; // 留空表示沿用已保存/ .env 的值
        target[field] = trimmed;
    });
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2));
    } catch (error) {
        console.error('[全局配置] 保存失败:', error.message);
    }
}

function update(patch = {}) {
    const incoming = patch || {};
    const api = incoming.defaultApi || {};
    ['doubao', 'deepseek'].forEach((key) => {
        const section = api[key];
        if (!section || typeof section !== 'object') return;
        store.defaultApi[key] = store.defaultApi[key] || {};
        fill(store.defaultApi[key], section, ['apiUrl', 'bearerToken', 'modelId']);
    });
    Object.keys(SECTION_FIELDS).forEach((sectionKey) => {
        const section = incoming[sectionKey];
        if (!section || typeof section !== 'object') return;
        store[sectionKey] = store[sectionKey] || {};
        fill(store[sectionKey], section, SECTION_FIELDS[sectionKey]);
    });
    persist();
    applyToRuntime();
    return getMasked();
}

// 清掉网页上保存的覆盖项，全部回到 .env
function reset() {
    store = emptyStore();
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            fs.unlinkSync(CONFIG_PATH);
        }
    } catch (error) {
        console.error('[全局配置] 清除失败:', error.message);
    }
    applyToRuntime();
    return getMasked();
}

module.exports = {
    getDefaultApi,
    getEmbedding,
    getQdrant,
    getTTS,
    getMasked,
    applyToRuntime,
    update,
    reset
};
