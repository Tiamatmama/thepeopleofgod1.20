'use strict';

// 从 server/index.js 抽出：全局服务配置（默认API / Embedding / Qdrant / TTS）路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

const axios = require('axios');

// 只覆盖非空字符串，其余沿用已保存的值（网页上留空即「不修改」）
function mergeNonEmptyStrings(base, patch) {
    const merged = { ...base };
    Object.keys(patch || {}).forEach((key) => {
        const value = patch[key];
        if (typeof value === 'string' && value.trim()) {
            merged[key] = value.trim();
        }
    });
    return merged;
}

function registerGlobalConfigRoutes(app, ctx) {
    const { requireLogin, serverError, globalConfig, validateServiceUrl } = ctx;

    // 全局服务配置（默认API / Embedding / Qdrant / TTS）：全局一份，作用于整个服务端
    app.get('/api/global-config', requireLogin, (req, res) => {
        try {
            res.json({ success: true, config: globalConfig.getMasked() });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/global-config', requireLogin, (req, res) => {
        try {
            const body = req.body || {};
            const urls = [
                body.defaultApi && body.defaultApi.doubao && body.defaultApi.doubao.apiUrl,
                body.defaultApi && body.defaultApi.deepseek && body.defaultApi.deepseek.apiUrl,
                body.embedding && body.embedding.url,
                body.qdrant && body.qdrant.url
            ];
            if (urls.some((url) => typeof url === 'string' && url.trim() && !validateServiceUrl(url.trim()))) {
                return res.status(400).json({ success: false, message: '接口地址必须是 http/https 开头的合法 URL' });
            }

            const config = globalConfig.update(body);
            console.log('[全局配置] 已通过网页更新');
            res.json({ success: true, config });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.delete('/api/global-config', requireLogin, (req, res) => {
        try {
            const config = globalConfig.reset();
            console.log('[全局配置] 已恢复为 .env 默认值');
            res.json({ success: true, config });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 测试 Embedding 与 Qdrant 是否可用；请求体里的非空字段优先（便于保存前先试）
    app.post('/api/global-config/test', requireLogin, async (req, res) => {
        const body = req.body || {};
        const embedding = mergeNonEmptyStrings(globalConfig.getEmbedding(), body.embedding);
        const qdrant = mergeNonEmptyStrings(globalConfig.getQdrant(), body.qdrant);
        const result = {
            embedding: { success: false, message: '未配置 Embedding 地址或密钥' },
            qdrant: { success: false, message: '未配置 Qdrant 地址或密钥' }
        };

        if (embedding.url && embedding.token) {
            try {
                const response = await axios.post(
                    embedding.url,
                    { model: embedding.modelId, input: [{ type: 'text', text: '连接测试' }] },
                    {
                        timeout: 15000,
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embedding.token}` }
                    }
                );
                const data = response.data && response.data.data;
                const vector = Array.isArray(data) ? data[0] && data[0].embedding : data && data.embedding;
                result.embedding = Array.isArray(vector)
                    ? { success: true, message: `连接成功，向量维度 ${vector.length}` }
                    : { success: false, message: '返回结构异常，未取到向量' };
            } catch (error) {
                result.embedding = {
                    success: false,
                    message: error.response ? `HTTP ${error.response.status}` : error.message
                };
            }
        }

        if (qdrant.url && qdrant.apiKey) {
            try {
                const response = await axios.get(`${qdrant.url.replace(/\/+$/, '')}/collections`, {
                    timeout: 15000,
                    headers: { 'api-key': qdrant.apiKey }
                });
                const names = ((response.data && response.data.result && response.data.result.collections) || [])
                    .map((item) => item.name);
                const missing = [qdrant.articleCollection, qdrant.dialogueCollection]
                    .filter((name) => name && !names.includes(name));
                result.qdrant = {
                    success: true,
                    message: `连接成功，共 ${names.length} 个集合${missing.length ? `；缺少集合: ${missing.join('、')}` : ''}`
                };
            } catch (error) {
                result.qdrant = {
                    success: false,
                    message: error.response ? `HTTP ${error.response.status}` : error.message
                };
            }
        }

        res.json({ success: true, result });
    });
}

module.exports = registerGlobalConfigRoutes;
