const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const globalConfig = require('./globalConfig');
const coldStart = require('./coldStart');
const { buildThinkingPayload } = require('./thinkingMap');
const { summarizeUsage, formatHitRate } = require('./usageStats');

// 📊 缓存埋点：命中率是全局平均值，掺进意愿判断、意图识别这类每轮都不同的小请求后会被稀释，
// 所以按调用点（call-site）分账记，才能看出到底是谁在拖低。
// 同时给每次请求算一个 prefixDigest（模型 + system 全文 + 工具名及顺序的指纹）：
// 它不变说明我们组出了同一段前缀，命中率却掉了，那就是缓存端的事，不是我们改坏了顺序。
const cacheCallStats = new Map();   // callSite -> { calls, hit, miss }
const cacheMissingWarned = new Set();  // 已提示过「通道不返回缓存字段」的 callSite
const CACHE_SUMMARY_EVERY = 20;
// 重试间隔：上游 503 时给服务端留恢复时间（固定 6 秒，不再用 1/2/4 秒的指数退避）
const RETRY_INTERVAL_MS = 6000;

function buildPrefixDigest(model, messages, tools) {
    const systems = (Array.isArray(messages) ? messages : [])
        .filter(msg => msg && msg.role === 'system')
        .map(msg => String(msg.content || ''))
        .join('\u0000');
    const toolNames = Array.isArray(tools)
        ? tools.map(tool => (tool && tool.function && tool.function.name) || '')
        : [];
    return crypto.createHash('sha1')
        .update(JSON.stringify({ model, systems, toolNames }))
        .digest('hex')
        .slice(0, 8);
}

// 控制台日志出了终端就看不到了，缓存命中要复盘只能靠落盘。
// 只记缓存这一行（不含对话内容），超过 1MB 时保留最后 500 行再续写。
const CACHE_LOG_PATH = path.join(__dirname, '../../data/api_cache.log');
const CACHE_LOG_MAX_BYTES = 1024 * 1024;

function appendCacheLog(line) {
    try {
        if (fs.existsSync(CACHE_LOG_PATH) && fs.statSync(CACHE_LOG_PATH).size > CACHE_LOG_MAX_BYTES) {
            const kept = fs.readFileSync(CACHE_LOG_PATH, 'utf8').split('\n').slice(-500).join('\n');
            fs.writeFileSync(CACHE_LOG_PATH, kept);
        }
        fs.appendFileSync(CACHE_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch (error) {
        // 落盘失败不影响主链路
    }
}

// 让 data/globalConfig.json（网页「全局服务配置」里保存的默认API密钥）对所有调用方生效
if (!global.API_CONFIG) {
    globalConfig.applyToRuntime();
}

// 手动停止：用同一个 name 标记，方便上层识别「是自己停的」而不是网络错误
function abortError() {
    const error = new Error('已手动停止');
    error.name = 'AbortError';
    return error;
}

function isAborted(signal, error) {
    return Boolean((signal && signal.aborted) || (error && error.name === 'AbortError'));
}

// Qwen 走 DashScope 的 OpenAI 兼容端点。makeRequest 用的是 url.pathname 作为完整请求路径，
// 所以这里必须是带 /chat/completions 的完整端点；只给了 base 时自动补上，免得改配置就 404。
function normalizeQwenEndpoint(url) {
    const fallback = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const value = String(url || '').trim();
    if (!value) return fallback;
    if (/\/chat\/completions\/?$/.test(value)) return value;
    return `${value.replace(/\/+$/, '')}/chat/completions`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// 公网 API 一律要求 https：配置里写错一个字符就会把 key 和对话内容发成明文
function assertSecureEndpoint(url) {
    if (url.protocol === 'https:') return;
    if (LOCAL_HOSTS.has(url.hostname)) return;
    throw new Error(`拒绝明文请求：${url.protocol}//${url.hostname}（公网 API 必须使用 https）`);
}

class APIManager {
    constructor() {
        this.config = global.API_CONFIG || {
            doubao: {
                apiUrl: process.env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
                bearerToken: process.env.DOUBAO_BEARER_TOKEN || '',
                modelId: process.env.DOUBAO_MODEL_ID || 'doubao-1.5-lite-32k-250115',
                name: '豆包'
            },
            deepseek: {
                apiUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
                bearerToken: process.env.DEEPSEEK_BEARER_TOKEN || '',
                modelId: process.env.DEEPSEEK_MODEL_ID || 'deepseek-flash',
                name: 'DeepSeek'
            }
        };

        // Qwen3.8-Max 通道：globalConfig 只维护 doubao/deepseek，
        // 这里补一个默认通道（同样是 OpenAI 兼容格式），供编码闭环按 apiChannel='qwen' 强制使用。
        // global.API_CONFIG 是共享对象引用，补进去后所有 APIManager 实例都能看到。
        if (!this.config.qwen || typeof this.config.qwen !== 'object') {
            this.config.qwen = {
                apiUrl: normalizeQwenEndpoint(process.env.QWEN_API_URL),
                bearerToken: process.env.QWEN_API_KEY || '',
                modelId: process.env.QWEN_MODEL_ID || 'qwen3.8-max',
                name: 'Qwen'
            };
        }

        const initialAPI = this.config.currentAPI || process.env.CURRENT_API || 'doubao';
        this.currentAPI = this.config[initialAPI] ? initialAPI : 'doubao';
    }

    getCurrentConfig() {
        return this.config[this.currentAPI];
    }

    getCurrentAPI() {
        return this.currentAPI;
    }

    getCurrentAPIName() {
        return this.config[this.currentAPI].name;
    }

    switchAPI(apiName) {
        if (this.config[apiName]) {
            this.currentAPI = apiName;
            return true;
        }
        return false;
    }

    getAllConfigs() {
        return {
            doubao: {
                name: this.config.doubao.name,
                modelId: this.config.doubao.modelId,
                isActive: this.currentAPI === 'doubao'
            },
            deepseek: {
                name: this.config.deepseek.name,
                modelId: this.config.deepseek.modelId,
                isActive: this.currentAPI === 'deepseek'
            },
            qwen: {
                name: this.config.qwen.name,
                modelId: this.config.qwen.modelId,
                isActive: this.currentAPI === 'qwen'
            }
        };
    }
}

class UnifiedAPI {
    constructor() {
        this.apiManager = new APIManager();
        this.maxRetries = 2;
        this.timeout = 45000;
        // 流式请求的空闲超时：只要还在持续吐数据就不算超时。
        // qwen 在大上下文 + 思考模式下非流式会长时间不出首字节（实测 145KB 上下文 >180s 无响应），
        // 只能走流式；流式下首字节约 4s，之后持续增量返回，用「空闲」而非「总时长」判定超时
        this.streamIdleTimeout = 90000;
    }

    // 单次回复最大生成 token：MAX_TOKENS 填多大都行，这里按各通道服务端硬上限夹紧
    // 上限来自实测：豆包返回 expected a value <= 12288；DeepSeek 返回 valid range [1, 393216]；
    // Qwen3.8-Max 官方 Max Output 131072（128K，思考模式下同为 131072）
    // 超上限的值服务端会直接 400 拒掉，所以一律夹到该通道上限内
    // override：调用方按剩余预算下发的单次生成上限（编码竞赛的轮内熔断用）。
    // 它只能把上限压小，不能突破通道硬上限，否则服务端直接 400。
    resolveMaxTokens(currentAPI, override = null) {
        const caps = { doubao: 12288, deepseek: 393216, qwen: 131072 };
        const cap = caps[currentAPI] || 4096;
        const wanted = Number.isFinite(Number(override)) && Number(override) > 0
            ? Number(override)
            : parseInt(process.env.MAX_TOKENS, 10);
        const bounded = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, cap) : cap;
        return Math.max(1, Math.floor(bounded));
    }

    async callAPI(messages, customConfig = null, options = {}) {
        // 允许按 options.apiChannel 指定通道（如编码闭环强制走 qwen），
        // 未指定或通道不存在时回落到当前通道，主会话因此不受影响
        const requested = options.apiChannel;
        const currentAPI = (requested && this.apiManager.config[requested])
            ? requested
            : this.apiManager.getCurrentAPI();
        const config = customConfig || this.apiManager.config[currentAPI];

        // 运行期复核流量面：hosts 在启动后被改指的是最常见的劫持手法，
        // 这里每次外连前再看一眼，命中就抛错熔断，请求不出网。
        // config.apiUrl 是本次真正要连的地址（网页端配置可能不在 env 里），一并纳入比对
        coldStart.assertTrafficSafe(process.env, [config.apiUrl]);

        // 手动停止信号：编码闭环点「停止」时中断在飞的请求，避免整轮模型调用跑完才停
        const signal = options.signal || null;

        // qwen（DashScope compatible-mode）在大上下文 + 思考模式下非流式会长时间不返回任何字节，
        // 因此该通道强制走流式（options.stream=true 也可显式开启）；其他通道维持原有非流式行为
        const useStream = options.stream === true || currentAPI === 'qwen';

        console.log(`[API调用] 当前API: ${currentAPI}, 模型: ${config.modelId}`);
        console.log(`[API调用] 消息数量: ${messages.length}`);
        if (messages.length > 0) {
            console.log(`[API调用] 第一条消息角色: ${messages[0].role}, 长度: ${messages[0].content?.length || 0}字符`);
        }

        const payload = {
            model: config.modelId,
            messages: messages,
            max_tokens: this.resolveMaxTokens(currentAPI, options.maxTokens),
            // 事实性发言（如自主发言走 RAG）可传低温压缩自由发挥，默认仍是 0.7
            temperature: Number.isFinite(options.temperature) ? options.temperature : 0.7,
            stream: useStream
        };
        // 流式默认不回传 usage；显式要一次，否则缓存命中统计在 qwen 这类强制流式的通道上永远是空的
        if (useStream) {
            payload.stream_options = { include_usage: true };
        }

        // function calling：把系统框架能力清单透传给模型，允许模型主动发起工具调用
        const tools = Array.isArray(options.tools) ? options.tools : null;
        if (tools && tools.length > 0) {
            payload.tools = tools;
            payload.tool_choice = options.toolChoice || 'auto';
            console.log(`[API调用] 已注入 ${tools.length} 个系统工具（function calling）`);
        }

        // 思考模式字段：按通道映射（deepseek 用 thinking、qwen 用 preserve_thinking、豆包不认），
        // 映射规则集中在 thinkingMap，三通道复用同一处逻辑
        const thinkingPayload = buildThinkingPayload(currentAPI, options);
        if (thinkingPayload) {
            Object.assign(payload, thinkingPayload);
            console.log(`[API调用] 思考模式: ${JSON.stringify(thinkingPayload)}`);
        }

        const postData = JSON.stringify(payload);

        // 诱饵凭据：正常请求里绝不会出现那个假 Key，出现即说明配置被读取并冒用
        // （必须在 postData 生成之后检查，否则会踩到暂时性死区）
        coldStart.assertNoCanary([config.apiUrl, `Bearer ${config.bearerToken}`, postData]);

        console.log(`[API调用] 请求体大小: ${Buffer.byteLength(postData)}字节`);

        for (let retry = 0; retry <= this.maxRetries; retry++) {
            if (signal && signal.aborted) throw abortError();
            try {
                const result = useStream
                    ? await this.makeStreamRequest(config, postData, currentAPI, signal)
                    : await this.makeRequest(config, postData, currentAPI, signal);
                console.log(`[API成功] ${currentAPI} 调用成功（第${retry + 1}次尝试）`);
                // 缓存命中只做观测：字段缺失时打「—」，不按 0 处理
                const cache = summarizeUsage(result && result.usage);
                if (cache && (cache.hit !== null || cache.miss !== null)) {
                    const callSite = options.callSite || 'other';
                    const digest = buildPrefixDigest(config.modelId, messages, tools);
                    const cacheLine = `[API缓存] ${callSite} ${currentAPI} digest=${digest} 命中 ${cache.hit ?? '—'} / 未命中 ${cache.miss ?? '—'}（命中率 ${formatHitRate(cache.hitRate)}）`;
                    console.log(cacheLine);
                    appendCacheLog(cacheLine);
                    const stat = cacheCallStats.get(callSite) || { calls: 0, hit: 0, miss: 0 };
                    stat.calls += 1;
                    stat.hit += cache.hit || 0;
                    stat.miss += cache.miss || 0;
                    cacheCallStats.set(callSite, stat);
                    if (stat.calls % CACHE_SUMMARY_EVERY === 0) {
                        const total = stat.hit + stat.miss;
                        const rate = total > 0 ? formatHitRate(stat.hit / total) : '—';
                        const summaryLine = `[API缓存汇总] ${callSite} 调用 ${stat.calls} 次，累计命中 ${stat.hit} / 未命中 ${stat.miss}（命中率 ${rate}）`;
                        console.log(summaryLine);
                        appendCacheLog(summaryLine);
                    }
                } else {
                    // 通道不返回缓存字段时一行都不打，会误以为埋点没生效。
                    // 每个调用点只提示一次，并带上 usage 的实际字段，便于判断是哪个通道缺字段。
                    const callSite = options.callSite || 'other';
                    if (!cacheMissingWarned.has(callSite)) {
                        cacheMissingWarned.add(callSite);
                        const fields = result && result.usage ? Object.keys(result.usage).join(',') : '无 usage';
                        appendCacheLog(`[API缓存缺失] ${callSite} ${currentAPI} 响应未带缓存字段（usage: ${fields}）`);
                    }
                }
                return result;
            } catch (error) {
                console.error(`[API错误] ${currentAPI} 第${retry + 1}次尝试失败: ${error.message}`);
                // 手动停止不是故障：立刻上抛，别重试、别继续等
                if (isAborted(signal, error)) throw abortError();
                if (retry < this.maxRetries) {
                    const delay = RETRY_INTERVAL_MS;
                    console.log(`[API重试] 等待${delay}ms后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error(`[API失败] ${currentAPI} 已达到最大重试次数(${this.maxRetries + 1}次)`);
                    throw error;
                }
            }
        }
    }

    makeRequest(config, postData, currentAPI, signal = null) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) { reject(abortError()); return; }
            const url = new URL(config.apiUrl);
            try { assertSecureEndpoint(url); } catch (error) { reject(error); return; }
            const isHttps = url.protocol === 'https:';
            const protocol = isHttps ? https : http;

            const timeout = setTimeout(() => {
                req.destroy(new Error('API调用超时'));
                console.error(`[API错误] ${currentAPI} 调用超时`);
                reject(new Error('API调用超时'));
            }, this.timeout);

            const options = {
                hostname: url.hostname,
                port: isHttps ? 443 : 80,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Authorization': `Bearer ${config.bearerToken}`
                },
                timeout: this.timeout,
                // 证书必须校验：关闭它等于把 API key 明文交给链路上的任何人
                rejectUnauthorized: true,
                // 跨境 TLS：Node 24 + OpenSSL 3.5 默认的 X25519MLKEM768 会被中间设备 RST
                ...(isHttps ? { ecdhCurve: 'X25519:P-256:P-384' } : {}),
                keepAlive: true,
                keepAliveMsecs: 30000,
                // 解析结果落在内网/回环就拒绝连接（DNS 污染 / 本地反代中间人）
                lookup: coldStart.safeLookup,
                // 证书公钥指纹必须与首次连接时记录的一致（挡恶意根证书）
                checkServerIdentity: coldStart.checkPinnedIdentity
            };

            console.log(`[API调用] 请求选项: ${JSON.stringify({
                hostname: options.hostname,
                port: options.port,
                path: options.path,
                method: options.method
            })}`);

            const req = protocol.request(options, (res) => {
                clearTimeout(timeout);
                console.log(`[API响应] 状态码: ${res.statusCode}`);
                
                try {
                    const headersObj = typeof res.headers === 'object' && res.headers !== null 
                        ? Object.keys(res.headers).reduce((acc, key) => {
                            acc[key] = res.headers[key];
                            return acc;
                        }, {})
                        : {};
                    console.log(`[API响应] 响应头: ${JSON.stringify(headersObj)}`);
                } catch (e) {
                    console.log(`[API响应] 响应头无法解析: ${e.message}`);
                }

                // 必须让流自己按 UTF-8 解码：直接 chunk.toString() 会把跨 TCP 分片的中文
                // 从字节中间切断，变成替换字符 U+FFFD；而 JSON 仍能解析，乱码会静默落库
                res.setEncoding('utf8');
                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                    console.log(`[API响应] 接收数据: ${chunk.length}字符`);
                });

                res.on('end', () => {
                    console.log(`[API响应] 数据接收完成，总长度: ${data.length}字符`);
                    try {
                        const result = JSON.parse(data);
                        if (result.error) {
                            console.error(`[API错误] ${currentAPI} API错误: ${result.error.message}`);
                            reject(new Error(`${currentAPI} API错误: ${result.error.message}`));
                        } else if (!result.choices || result.choices.length === 0) {
                            console.error(`[API错误] ${currentAPI} 没有返回有效响应`);
                            reject(new Error(`${currentAPI} 没有返回有效响应`));
                        } else {
                            console.log(`[API成功] ${currentAPI} 调用成功`);
                            resolve(result);
                        }
                    } catch (e) {
                        console.error(`[API错误] 解析响应失败: ${e.message}`);
                        console.error(`[API错误] 原始响应: ${data.substring(0, 500)}...`);
                        reject(new Error(`解析响应失败: ${e.message}`));
                    }
                });
            });

            req.on('error', (e) => {
                clearTimeout(timeout);
                console.error(`[API错误] ${currentAPI} 请求错误: ${e.message}`);
                reject(e);
            });

            req.on('timeout', () => {
                console.error(`[API错误] ${currentAPI} 请求超时`);
                req.destroy();
                reject(new Error('API调用超时'));
            });

            // 手动停止：直接掐断连接，让 await 立即返回（错误名 AbortError）
            if (signal) {
                const onAbort = () => { req.destroy(abortError()); };
                signal.addEventListener('abort', onAbort, { once: true });
                req.on('close', () => signal.removeEventListener('abort', onAbort));
            }

            req.write(postData);
            req.end();
        });
    }

    // 流式（SSE）请求：把 data: 增量聚合成与非流式一致的 choices[0].message 结构，
    // 这样上层的工具循环（output.js callWithTools）无需感知传输方式即可照常读取
    // content / reasoning_content / tool_calls
    makeStreamRequest(config, postData, currentAPI, signal = null) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) { reject(abortError()); return; }
            const url = new URL(config.apiUrl);
            try { assertSecureEndpoint(url); } catch (error) { reject(error); return; }
            const isHttps = url.protocol === 'https:';
            const protocol = isHttps ? https : http;

            let role = 'assistant';
            let finishReason = null;
            let usage = null;
            let reasoning = '';
            const contentParts = [];
            const toolCalls = [];   // 按 index 聚合：流式下 arguments 会分片到达

            let settled = false;
            let idleTimer = null;
            // 用「空闲超时」而非「总超时」：只要还有增量到达就顺延，避免长生成被误杀
            const armIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    req.destroy();
                    console.error(`[API错误] ${currentAPI} 流式空闲超时`);
                    reject(new Error('API调用超时'));
                }, this.streamIdleTimeout);
            };

            const consumeEvent = (data) => {
                if (!data || data === '[DONE]') return;
                let json;
                try { json = JSON.parse(data); } catch { return; }
                if (json.usage) usage = json.usage;
                const choice = Array.isArray(json.choices) ? json.choices[0] : null;
                if (!choice) return;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta || {};
                if (typeof delta.role === 'string') role = delta.role;
                if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
                if (typeof delta.content === 'string') contentParts.push(delta.content);
                if (Array.isArray(delta.tool_calls)) {
                    for (const piece of delta.tool_calls) {
                        const index = Number.isInteger(piece.index) ? piece.index : toolCalls.length;
                        if (!toolCalls[index]) {
                            toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                        }
                        const slot = toolCalls[index];
                        if (piece.id) slot.id = piece.id;
                        if (piece.type) slot.type = piece.type;
                        if (piece.function) {
                            if (piece.function.name) slot.function.name += piece.function.name;
                            if (piece.function.arguments) slot.function.arguments += piece.function.arguments;
                        }
                    }
                }
            };

            const buildResult = () => {
                const message = { role, content: contentParts.join('') };
                if (reasoning) message.reasoning_content = reasoning;
                const calls = toolCalls.filter(Boolean);
                if (calls.length > 0) message.tool_calls = calls;
                return {
                    id: `chatcmpl-stream-${Date.now()}`,
                    object: 'chat.completion',
                    model: config.modelId,
                    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
                    usage
                };
            };

            console.log(`[API调用] 流式请求: ${url.hostname}${url.pathname} 模型: ${config.modelId}`);

            armIdle();
            const req = protocol.request({
                hostname: url.hostname,
                port: isHttps ? 443 : 80,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Authorization': `Bearer ${config.bearerToken}`,
                    'Accept': 'text/event-stream'
                },
                // 证书必须校验：关闭它等于把 API key 明文交给链路上的任何人
                rejectUnauthorized: true,
                // 跨境 TLS：Node 24 + OpenSSL 3.5 默认的 X25519MLKEM768 会被中间设备 RST
                ...(isHttps ? { ecdhCurve: 'X25519:P-256:P-384' } : {}),
                keepAlive: true,
                keepAliveMsecs: 30000,
                // 解析结果落在内网/回环就拒绝连接（DNS 污染 / 本地反代中间人）
                lookup: coldStart.safeLookup,
                // 证书公钥指纹必须与首次连接时记录的一致（挡恶意根证书）
                checkServerIdentity: coldStart.checkPinnedIdentity
            }, (res) => {
                console.log(`[API响应] 状态码: ${res.statusCode}（流式）`);

                // 非 2xx：把错误体读全再抛出，保持与 makeRequest 一致的错误文案
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    let errBody = '';
                    res.on('data', chunk => { errBody += chunk; });
                    res.on('end', () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(idleTimer);
                        let msg = errBody.substring(0, 300);
                        try {
                            const parsed = JSON.parse(errBody);
                            if (parsed.error && parsed.error.message) msg = parsed.error.message;
                        } catch { /* 保留原始文本 */ }
                        console.error(`[API错误] ${currentAPI} API错误: ${msg}`);
                        reject(new Error(`${currentAPI} API错误: ${msg}`));
                    });
                    return;
                }

                // 同上：流式分片也必须按 UTF-8 解码，否则跨片的中文会被截成替换字符
                res.setEncoding('utf8');
                let buffer = '';
                res.on('data', (chunk) => {
                    armIdle();
                    buffer += chunk;
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        if (!line.startsWith('data:')) continue;
                        consumeEvent(line.slice(5).trim());
                    }
                });

                res.on('end', () => {
                    clearTimeout(idleTimer);
                    if (settled) return;
                    settled = true;
                    const tail = buffer.trim();
                    if (tail.startsWith('data:')) consumeEvent(tail.slice(5).trim());
                    const calls = toolCalls.filter(Boolean);
                    if (!finishReason && contentParts.length === 0 && calls.length === 0) {
                        console.error(`[API错误] ${currentAPI} 流式响应没有返回有效内容`);
                        reject(new Error(`${currentAPI} 没有返回有效响应`));
                        return;
                    }
                    console.log(`[API成功] ${currentAPI} 流式调用成功（正文 ${contentParts.join('').length} 字符 / 工具调用 ${calls.length}）`);
                    resolve(buildResult());
                });
            });

            req.on('error', (e) => {
                clearTimeout(idleTimer);
                if (settled) return;
                settled = true;
                console.error(`[API错误] ${currentAPI} 请求错误: ${e.message}`);
                reject(e);
            });

            // 手动停止：流式连接也一并掐断，不再继续消费增量
            if (signal) {
                const onAbort = () => { req.destroy(abortError()); };
                signal.addEventListener('abort', onAbort, { once: true });
                req.on('close', () => signal.removeEventListener('abort', onAbort));
            }

            req.on('timeout', () => {
                if (settled) return;
                settled = true;
                clearTimeout(idleTimer);
                req.destroy();
                reject(new Error('API调用超时'));
            });

            req.write(postData);
            req.end();
        });
    }

    getAPIManager() {
        return this.apiManager;
    }

    switchAPI(apiName) {
        return this.apiManager.switchAPI(apiName);
    }

    getCurrentAPI() {
        return this.apiManager.getCurrentAPI();
    }

    getCurrentAPIName() {
        return this.apiManager.getCurrentAPIName();
    }
}

module.exports = { UnifiedAPI, APIManager };
