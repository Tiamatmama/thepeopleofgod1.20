const http = require('http');
const https = require('https');
const url = require('url');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// 公网地址一律要求 https：填成 http 时 apiKey 和整段对话都会以明文经过链路，
// 中间任何一跳都能读到。本机自建服务（Ollama、vLLM 之类）才放行 http。
function assertSecureUrl(parsedUrl, targetUrl) {
    if (parsedUrl.protocol === 'https:') return;
    const host = String(parsedUrl.hostname || '').replace(/^\[|\]$/g, '');
    if (parsedUrl.protocol === 'http:' && LOCAL_HOSTS.has(host)) return;
    throw new Error(`拒绝明文请求：${targetUrl}（公网 API 必须使用 https）`);
}

class UserApiClient {
    constructor() {
        this.timeout = 30000;
    }

    // 中转站文档通常只给到 /v1，用户照着抄就会 404。这里统一补全到真正的对话端点：
    // 已经带端点的完整地址原样放过，避免重复拼接
    normalizeApiUrl(apiUrl) {
        const trimmed = String(apiUrl || '').trim().replace(/\/+$/, '');
        if (!trimmed) {
            return trimmed;
        }

        if (trimmed.includes('/chat/completions')) {
            return trimmed;
        }

        // 已经带版本路径（/v1、/v1beta 之类）的，只差一个端点
        if (/\/v\d+[a-z]*$/i.test(trimmed)) {
            return `${trimmed}/chat/completions`;
        }

        // 只填了域名（可带端口）的，按 OpenAI 惯例补全整条路径
        try {
            const parsed = new URL(trimmed);
            if (!parsed.pathname || parsed.pathname === '/') {
                return `${trimmed}/v1/chat/completions`;
            }
        } catch (error) {
            return trimmed;
        }

        return `${trimmed}/chat/completions`;
    }

    // 从用户填的地址推出模型列表地址：去掉对话端点，补 /models
    buildModelsUrl(apiUrl) {
        const trimmed = this.normalizeApiUrl(apiUrl).replace(/\/+$/, '');
        if (!trimmed) {
            return '';
        }
        if (trimmed.includes('/chat/completions')) {
            return trimmed.replace(/\/chat\/completions.*$/, '/models');
        }
        return `${trimmed}/models`;
    }

    // 网关的状态码对用户没有意义，翻成人话，同时保留原话方便排查
    translateHttpError(statusCode, statusMessage, body, targetUrl) {
        const hints = {
            400: '请求被拒绝：模型名称可能不对，或该模型不支持当前参数',
            401: 'API密钥无效或已过期，请重新复制粘贴密钥',
            403: '密钥没有访问该模型的权限',
            404: 'API地址路径不对：请把地址填到 /v1，系统会自动补上 /chat/completions',
            413: '请求内容太大，请调小最大Token',
            429: '额度不足或请求过于频繁，请检查中转站账户余额',
            500: '中转站内部错误，稍后重试',
            502: '中转站网关错误，稍后重试',
            503: '该模型在当前分组没有可用渠道：请检查令牌分组和模型名是否匹配',
            504: '中转站响应超时，稍后重试'
        };
        const hint = hints[statusCode] || `请求失败（HTTP ${statusCode} ${statusMessage || ''}）`;
        const detail = String(body || '').trim().slice(0, 300);
        return new Error(`${hint}；当前地址：${targetUrl}；网关返回：${detail || '(空)'}`);
    }

    // 网络层错误的常见码也一并翻译
    translateNetworkError(error, targetUrl) {
        const hints = {
            ENOTFOUND: '域名解析失败：地址里的域名拼错了或无法访问',
            ECONNREFUSED: '连接被拒绝：地址的端口或 http/https 用错了',
            ETIMEDOUT: '连接超时：网络不通，可能需要代理',
            ECONNRESET: '连接被重置：中转站提前断开了连接',
            CERT_HAS_EXPIRED: '对方证书已过期，无法建立 https 连接',
            UNABLE_TO_VERIFY_LEAF_SIGNATURE: '对方证书无法验证，无法建立 https 连接'
        };
        const hint = hints[error.code];
        if (!hint) {
            return new Error(`${error.message}；当前地址：${targetUrl}`);
        }
        return new Error(`${hint}；当前地址：${targetUrl}；原始错误：${error.message}`);
    }

    // 发起一次对话补全请求，返回原始 JSON 响应。options.tools 非空时请求体里会带上工具定义
    async requestApi(config, messages, systemPrompt, options = {}) {
        if (!config || !config.enabled || !config.apiUrl) {
            throw new Error('API配置未启用或不完整');
        }

        const targetUrl = this.normalizeApiUrl(config.apiUrl);
        const parsedUrl = url.parse(targetUrl);

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            throw new Error('API地址必须以 http:// 或 https:// 开头');
        }
        assertSecureUrl(parsedUrl, targetUrl);

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const headers = {
            'Content-Type': 'application/json'
        };

        if (config.apiKey) {
            headers['Authorization'] = `Bearer ${config.apiKey}`;
        }

        // 只保留 OpenAI 兼容协议。老配置里残留的 apiType 一律按 OpenAI 处理，
        // 免得用户不重新保存就一直走已经删掉的旧请求格式
        const data = this.buildOpenAIRequest(messages, systemPrompt, config, options);

        const postData = JSON.stringify(data);

        headers['Content-Length'] = Buffer.byteLength(postData);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.path,
                method: 'POST',
                headers: headers,
                timeout: this.timeout
            };

            const req = client.request(options, (res) => {
                let body = '';

                res.on('data', (chunk) => {
                    body += chunk;
                });

                res.on('end', () => {
                    // 非 2xx 一律当失败。网关的错误体（401 未授权 / 404 路径错 / 429 限流）也是合法 JSON，
                    // 不判状态码就会把它当成正常响应喂给上层，最后表现成「一个字没拿到但调用成功」
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(this.translateHttpError(res.statusCode, res.statusMessage, body, targetUrl));
                        return;
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(new Error(`解析响应失败: ${error.message}；原始响应：${body.slice(0, 200)}`));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`请求超时（${this.timeout / 1000} 秒无响应）：网络不通或中转站没有响应；当前地址：${targetUrl}`));
            });

            req.on('error', (error) => {
                reject(this.translateNetworkError(error, targetUrl));
            });

            req.write(postData);
            req.end();
        });
    }

    // 只取文本的常规调用（CIDE 思考、输入预处理、旁白等场景沿用这个）
    // options 目前用于透传 thinking（CIDE 内部思考强制开），不支持该字段的通道会被自动跳过
    async callApi(config, messages, systemPrompt, options = {}) {
        const response = await this.requestApi(config, messages, systemPrompt, options);
        return this.parseResponse(response);
    }

    // 带工具的调用：把响应统一成 OpenAI 的 { choices: [{ message: { content, tool_calls } }] } 结构，
    // 与默认 API 通道的返回完全一致，可以直接喂给上层的工具循环
    async callApiWithTools(config, messages, systemPrompt, options = {}) {
        const response = await this.requestApi(config, messages, systemPrompt, options);
        return this.normalizeMessage(response);
    }

    buildOpenAIRequest(messages, systemPrompt, config, options = {}) {
        const allMessages = [];
        
        if (systemPrompt) {
            allMessages.push({
                role: 'system',
                content: systemPrompt
            });
        }

        allMessages.push(...messages);

        const payload = {
            model: config.model || 'gpt-3.5-turbo',
            messages: allMessages,
            // 单次生成上限：调用方给了就取更小的那个，避免一次回复把 token 预算冲爆
            max_tokens: (Number(options.maxTokens) > 0)
                ? Math.min(config.maxTokens || 2048, Number(options.maxTokens))
                : (config.maxTokens || 2048),
            temperature: config.temperature || 0.7
        };

        const tools = Array.isArray(options.tools) ? options.tools : [];
        if (tools.length > 0) {
            payload.tools = tools;
            payload.tool_choice = options.toolChoice || 'auto';
        }

        // 思考模式：只有 DeepSeek 系接口认 thinking 字段，别的中转站收到会直接 400，
        // 所以先按模型名/地址判定支持再下发，避免把整条 CIDE 调用打挂
        if ((options.thinking === 'enabled' || options.thinking === 'disabled') && this.supportsThinking(config)) {
            payload.thinking = { type: options.thinking };
        }

        return payload;
    }

    // 该通道是否认 thinking 字段：模型名或地址里带 deepseek 才算
    supportsThinking(config) {
        const model = String((config && config.model) || '').toLowerCase();
        const apiUrl = String((config && config.apiUrl) || '').toLowerCase();
        return model.includes('deepseek') || apiUrl.includes('deepseek');
    }

    parseResponse(response) {
        const content = response?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
            return content;
        }
        return typeof response === 'string' ? response : JSON.stringify(response);
    }

    // 把响应统一成 OpenAI 的 message 结构，便于和默认通道共用同一套工具循环
    normalizeMessage(response) {
        const message = { role: 'assistant', content: '' };

        const raw = response?.choices?.[0]?.message || {};
        message.content = typeof raw.content === 'string' ? raw.content : '';
        if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
            message.tool_calls = raw.tool_calls;
        }

        return { choices: [{ message }] };
    }

    // 拉取中转站的模型列表供面板下拉选择。浏览器直连会被 CORS 拦掉，所以放在服务端代取
    fetchModels(config) {
        const targetUrl = this.buildModelsUrl(config.apiUrl);

        if (!targetUrl) {
            return Promise.resolve({ success: false, message: '请先填写API地址' });
        }

        const parsedUrl = url.parse(targetUrl);

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return Promise.resolve({ success: false, message: 'API地址必须以 http:// 或 https:// 开头' });
        }

        try {
            assertSecureUrl(parsedUrl, targetUrl);
        } catch (error) {
            return Promise.resolve({ success: false, message: error.message });
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const headers = {};
        if (config.apiKey) {
            headers['Authorization'] = `Bearer ${config.apiKey}`;
        }

        return new Promise((resolve) => {
            const req = client.request({
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.path,
                method: 'GET',
                headers: headers,
                timeout: 15000
            }, (res) => {
                let body = '';

                res.on('data', (chunk) => {
                    body += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        resolve({ success: false, message: this.translateHttpError(res.statusCode, res.statusMessage, body, targetUrl).message });
                        return;
                    }
                    try {
                        const models = this.extractModelIds(JSON.parse(body));
                        if (models.length === 0) {
                            resolve({ success: false, message: `接口没有返回模型列表；原始响应：${body.slice(0, 300)}` });
                            return;
                        }
                        resolve({ success: true, models: models });
                    } catch (error) {
                        resolve({ success: false, message: `解析模型列表失败：${error.message}；原始响应：${body.slice(0, 300)}` });
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, message: `获取模型列表超时；当前地址：${targetUrl}` });
            });

            req.on('error', (error) => {
                resolve({ success: false, message: this.translateNetworkError(error, targetUrl).message });
            });

            req.end();
        });
    }

    // 兼容 OpenAI 的 { data: [{id}] }、Gemini 的 { models: [{name}] } 和 { data: ["x"] }
    extractModelIds(payload) {
        const list = Array.isArray(payload) ? payload : (payload && (payload.data || payload.models));

        if (!Array.isArray(list)) {
            return [];
        }

        const ids = list.map((item) => {
            if (typeof item === 'string') {
                return item;
            }
            if (!item || typeof item !== 'object') {
                return '';
            }
            // Gemini 的 name 形如 models/gemini-2.0-flash，去掉前缀
            return String(item.id || item.name || item.model || '').replace(/^models\//, '');
        }).filter(Boolean);

        return Array.from(new Set(ids)).sort();
    }

    async testApi(config) {
        const testMessages = [
            { role: 'user', content: 'Hello' }
        ];

        try {
            // 直接走 requestApi 拿原始响应，好在「200 但内容为空」时把网关的原话带出去
            const raw = await this.requestApi(config, testMessages, 'You are a helpful assistant.', {});
            const result = this.parseResponse(raw);

            // 200 也可能是个空壳：模型名不对、渠道没配额时网关常回 200 但内容为空。
            // 这种情况必须报失败，否则界面上永远是「连接成功」
            if (!result || !String(result).trim()) {
                return {
                    success: false,
                    message: `接口返回成功状态但内容为空：多半是模型名不对或该渠道没有配额；原始响应：${JSON.stringify(raw).slice(0, 300)}`,
                    code: 0
                };
            }

            return { success: true, response: String(result).slice(0, 100) };
        } catch (error) {
            return { 
                success: false, 
                message: error.message,
                code: 0
            };
        }
    }
}

module.exports = UserApiClient;