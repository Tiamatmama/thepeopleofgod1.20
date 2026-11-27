'use strict';

// 中转站（Relay）：把「一组可用的模型通道」收成一个本地 OpenAI 兼容端点，
// 任何只会说 OpenAI 协议的工具（编程沙箱、NewMax、Cherry Studio、Codeg…）
// 把 baseURL 指向 http://127.0.0.1:41888/relay/v1 就能用上这里配置的全部通道。
//
// 三块能力：
//   1. 路由：按优先级依次尝试，前一个失败（401/429/超时/网络错）自动换下一个；
//   2. 信箱：Agent 之间互发消息，落 data/relay/messages.jsonl，可经 WebSocket 实时推送；
//   3. 任务队列：把一段提示词丢进队列后台跑，结果可查、可取消，不占前端连接。
//
// 配置在 data/relay/config.json，首次启动用 .env 里的 key 播种；密钥只在服务端使用，
// 对外的配置接口一律返回掩码。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync, writeJsonAtomicSync } = require('../storage/atomicWrite');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TASKS_KEPT = 100;
const MAX_MESSAGES_KEPT = 5000;
const TASK_CONCURRENCY = 2;
const MESSAGE_MAX_LEN = 20000;

function nowIso() {
    return new Date().toISOString();
}

function trimSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

// 用户可能只填域名、只填 /v1，或者直接贴完整端点。统一补成 /chat/completions，
// 与 userApi.js 的补全规则保持一致，免得照着中转站文档抄就 404。
function normalizeEndpoint(input) {
    const value = trimSlash(input);
    if (!value) return '';
    if (/\/chat\/completions$/i.test(value)) return value;
    if (/\/v\d+[a-z]*$/i.test(value)) return `${value}/chat/completions`;
    try {
        const parsed = new URL(value);
        if (!parsed.pathname || parsed.pathname === '/') {
            return `${value}/v1/chat/completions`;
        }
    } catch (error) {
        return value;
    }
    return `${value}/chat/completions`;
}

function endpointToBase(endpoint) {
    return trimSlash(endpoint).replace(/\/chat\/completions$/i, '');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// 通道地址一旦走明文 http，apiKey 和整段对话都会裸奔在链路上。本机自建服务例外。
function assertSecureEndpoint(endpoint) {
    let parsed;
    try {
        parsed = new URL(endpoint);
    } catch (error) {
        return;
    }
    if (parsed.protocol === 'https:') return;
    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '');
    if (parsed.protocol === 'http:' && LOCAL_HOSTS.has(host)) return;
    throw new Error(`拒绝明文通道：${endpoint}（公网地址必须使用 https）`);
}

function maskKey(apiKey) {
    const key = String(apiKey || '');
    if (!key) return '';
    if (key.length <= 10) return '****';
    return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

function isMasked(value) {
    return typeof value === 'string' && value.includes('****');
}

function seedChannels() {
    return [
        {
            id: 'deepseek',
            label: 'DeepSeek',
            format: 'openai',
            endpoint: normalizeEndpoint(process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1'),
            apiKey: process.env.DEEPSEEK_BEARER_TOKEN || '',
            model: process.env.DEEPSEEK_MODEL_ID || 'deepseek-flash',
            enabled: Boolean(process.env.DEEPSEEK_BEARER_TOKEN),
            priority: 10,
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        {
            id: 'qwen',
            label: 'Qwen',
            format: 'openai',
            endpoint: normalizeEndpoint(process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
            apiKey: process.env.QWEN_API_KEY || '',
            model: process.env.QWEN_MODEL_ID || 'qwen3.8-max',
            enabled: Boolean(process.env.QWEN_API_KEY),
            priority: 20,
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        {
            id: 'doubao',
            label: '豆包',
            format: 'openai',
            endpoint: normalizeEndpoint(process.env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3'),
            apiKey: process.env.DOUBAO_BEARER_TOKEN || '',
            model: process.env.DOUBAO_MODEL_ID || 'doubao-1.5-lite-32k-250115',
            enabled: Boolean(process.env.DOUBAO_BEARER_TOKEN),
            priority: 30,
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        {
            id: 'newmax',
            label: 'NewMax',
            format: 'openai',
            endpoint: 'https://api.newmax.cc/v1/chat/completions',
            apiKey: '',
            model: 'deepseek-v4-pro',
            enabled: false,
            priority: 40,
            timeoutMs: DEFAULT_TIMEOUT_MS
        }
    ];
}

class RelayHub {
    constructor({ dataDir, onEvent = null } = {}) {
        this.dir = path.join(dataDir || path.join(__dirname, '../../data'), 'relay');
        this.configPath = path.join(this.dir, 'config.json');
        this.tasksPath = path.join(this.dir, 'tasks.json');
        this.messagesPath = path.join(this.dir, 'messages.jsonl');
        this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};

        fs.mkdirSync(this.dir, { recursive: true });

        this.config = this.loadConfig();
        this.stats = new Map();
        this.recent = [];
        this.tasks = new Map();
        this.queue = [];
        this.running = 0;
        this.controllers = new Map();
        this.messages = [];

        this.loadTasks();
        this.loadMessages();
        this.pump();
    }

    // ---------- 配置 ----------

    loadConfig() {
        // 令牌留空等于中转站对所有人回 403：Claude Code 只会看到一句「认证失败」，
        // 用户完全不知道要去填令牌。本地中转站按 Jupyter 那套做法：没配置就自动生成
        // 一枚强随机令牌并落盘（面板随时可替换），RELAY_AUTH_TOKEN 可显式播种。
        const seedToken = () => {
            const fromEnv = String(process.env.RELAY_AUTH_TOKEN || '').trim();
            return fromEnv || crypto.randomBytes(24).toString('hex');
        };
        let stored = null;
        try {
            stored = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        } catch (error) {
            stored = null;
        }
        if (!stored || typeof stored !== 'object') {
            const seeded = {
                enabled: true,
                authToken: seedToken(),
                channels: seedChannels(),
                aliases: { main: ['deepseek', 'qwen', 'doubao'] }
            };
            writeJsonAtomicSync(this.configPath, seeded);
            return seeded;
        }
        if (!Array.isArray(stored.channels) || !stored.channels.length) {
            stored.channels = seedChannels();
        }
        if (!stored.aliases || typeof stored.aliases !== 'object') {
            stored.aliases = {};
        }
        stored.enabled = stored.enabled !== false;
        stored.authToken = String(stored.authToken || '');
        if (!stored.authToken) {
            stored.authToken = seedToken();
            writeJsonAtomicSync(this.configPath, stored);
        }
        this.config = stored;
        return stored;
    }

    saveConfig() {
        writeJsonAtomicSync(this.configPath, this.config);
    }

    // 对外只给掩码：前端拿到再原样提交回来时，updateConfig 会认出掩码并保留原值
    publicConfig() {
        return {
            enabled: this.config.enabled !== false,
            authToken: this.config.authToken ? maskKey(this.config.authToken) : '',
            hasAuthToken: Boolean(this.config.authToken),
            aliases: { ...this.config.aliases },
            channels: (this.config.channels || []).map((channel) => ({
                id: channel.id,
                label: channel.label,
                format: channel.format || 'openai',
                endpoint: channel.endpoint,
                baseUrl: endpointToBase(channel.endpoint),
                apiKey: maskKey(channel.apiKey),
                hasKey: Boolean(channel.apiKey),
                model: channel.model,
                enabled: channel.enabled !== false,
                priority: Number(channel.priority) || 100,
                timeoutMs: Number(channel.timeoutMs) || DEFAULT_TIMEOUT_MS
            }))
        };
    }

    updateConfig(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new Error('配置必须是对象');
        }
        if (patch.enabled !== undefined) {
            this.config.enabled = patch.enabled !== false;
        }
        if (patch.authToken !== undefined) {
            const token = String(patch.authToken || '');
            if (token === '') {
                this.config.authToken = '';
            } else if (!isMasked(token)) {
                this.config.authToken = token;
            }
        }
        if (patch.aliases && typeof patch.aliases === 'object' && !Array.isArray(patch.aliases)) {
            const aliases = {};
            Object.entries(patch.aliases).forEach(([alias, value]) => {
                if (!Array.isArray(value)) return;
                const ids = value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10);
                if (alias && ids.length) aliases[String(alias).trim()] = ids;
            });
            this.config.aliases = aliases;
        }
        if (Array.isArray(patch.channels)) {
            const next = [];
            patch.channels.forEach((input, index) => {
                if (!input || typeof input !== 'object') return;
                const id = String(input.id || '').trim();
                if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
                    throw new Error(`第 ${index + 1} 个通道的 id 非法`);
                }
                const previous = (this.config.channels || []).find((channel) => channel.id === id) || {};
                let apiKey = previous.apiKey || '';
                if (input.apiKey === null) {
                    apiKey = '';
                } else if (typeof input.apiKey === 'string' && input.apiKey && !isMasked(input.apiKey)) {
                    apiKey = input.apiKey;
                }
                const endpoint = normalizeEndpoint(input.endpoint || input.baseUrl || previous.endpoint);
                if (!endpoint) {
                    throw new Error(`通道 ${id} 缺少接口地址`);
                }
                assertSecureEndpoint(endpoint);
                next.push({
                    id,
                    label: String(input.label || previous.label || id).trim(),
                    format: 'openai',
                    endpoint,
                    apiKey,
                    model: String(input.model || previous.model || '').trim(),
                    enabled: input.enabled !== false,
                    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
                    timeoutMs: Math.max(5000, Math.min(600000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS))
                });
            });
            if (!next.length) {
                throw new Error('至少需要保留一个通道');
            }
            this.config.channels = next;
        }
        this.saveConfig();
        return this.publicConfig();
    }

    // ---------- 路由 ----------

    enabledChannels() {
        return (this.config.channels || [])
            .filter((channel) => channel.enabled !== false && channel.endpoint && channel.apiKey)
            .sort((a, b) => (Number(a.priority) || 100) - (Number(b.priority) || 100));
    }

    // 返回本次请求可用的通道顺序：
    //   auto/空 → 全部启用通道按优先级
    //   别名 → 别名里列出的通道
    //   通道 id 或模型名 → 只打那个通道
    //   认不出来 → 回落到全部启用通道（兼容那些写死 gpt-4o 的客户端）
    resolveChain(requestedModel) {
        const all = this.enabledChannels();
        const name = String(requestedModel || '').trim();
        if (!name || name === 'auto' || name === 'relay') return all;

        const alias = this.config.aliases && this.config.aliases[name];
        if (Array.isArray(alias) && alias.length) {
            const picked = alias
                .map((id) => all.find((channel) => channel.id === id))
                .filter(Boolean);
            if (picked.length) return picked;
        }

        const direct = all.find((channel) => channel.id === name || channel.model === name);
        if (direct) return [direct];
        return all;
    }

    buildPayload(channel, payload, stream) {
        const body = {
            model: channel.model,
            messages: Array.isArray(payload.messages) ? payload.messages : [],
            stream: Boolean(stream)
        };
        const maxTokens = Number(payload.max_tokens || payload.max_completion_tokens);
        if (Number.isFinite(maxTokens) && maxTokens > 0) {
            body.max_tokens = Math.min(maxTokens, 200000);
        }
        if (Number.isFinite(Number(payload.temperature))) {
            body.temperature = Number(payload.temperature);
        }
        if (Number.isFinite(Number(payload.top_p))) {
            body.top_p = Number(payload.top_p);
        }
        ['tools', 'tool_choice', 'response_format'].forEach((key) => {
            if (payload[key] !== undefined) body[key] = payload[key];
        });
        return body;
    }

    async requestChannel(channel, payload, stream, signal) {
        // 存量配置可能是加校验之前保存的 http 地址，这里再拦一道
        assertSecureEndpoint(channel.endpoint);
        const timeout = AbortSignal.timeout(Math.max(5000, Number(channel.timeoutMs) || DEFAULT_TIMEOUT_MS));
        const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const started = Date.now();
        const response = await fetch(channel.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${channel.apiKey}`
            },
            body: JSON.stringify(this.buildPayload(channel, payload, stream)),
            signal: merged
        });
        return { response, started };
    }

    noteResult(channelId, ok, latencyMs, error) {
        const stat = this.stats.get(channelId) || { ok: 0, fail: 0, lastError: '', lastUsedAt: 0, lastLatencyMs: 0 };
        if (ok) {
            stat.ok += 1;
            stat.lastError = '';
        } else {
            stat.fail += 1;
            stat.lastError = String(error || '').slice(0, 300);
        }
        stat.lastUsedAt = Date.now();
        stat.lastLatencyMs = latencyMs;
        this.stats.set(channelId, stat);

        this.recent.unshift({
            at: Date.now(),
            channel: channelId,
            ok,
            latencyMs,
            error: ok ? '' : stat.lastError
        });
        this.recent = this.recent.slice(0, 100);
    }

    async chat(payload) {
        if (this.config.enabled === false) {
            throw new Error('中转站已关闭');
        }
        const chain = this.resolveChain(payload && payload.model);
        if (!chain.length) {
            throw new Error('没有可用通道：请在中转站配置里启用至少一个带密钥的通道');
        }

        const failures = [];
        for (const channel of chain) {
            const started = Date.now();
            try {
                const { response } = await this.requestChannel(channel, payload, false);
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    const message = `HTTP ${response.status} ${String(detail || '').slice(0, 200)}`;
                    this.noteResult(channel.id, false, Date.now() - started, message);
                    failures.push(`${channel.id}: ${message}`);
                    continue;
                }
                const json = await response.json();
                this.noteResult(channel.id, true, Date.now() - started);
                return { channel, json };
            } catch (error) {
                const reason = error && error.name === 'TimeoutError'
                    ? `超时（${channel.timeoutMs || DEFAULT_TIMEOUT_MS}ms）`
                    : (error && error.message) || '请求失败';
                this.noteResult(channel.id, false, Date.now() - started, reason);
                failures.push(`${channel.id}: ${reason}`);
            }
        }
        throw new Error(`所有通道均失败：${failures.join('；')}`);
    }

    // 流式只在前端拿到 200 后才算成功；一旦开始吐字就不再换通道（换会拼接出两段答案）
    async chatStream(payload) {
        if (this.config.enabled === false) {
            throw new Error('中转站已关闭');
        }
        const chain = this.resolveChain(payload && payload.model);
        if (!chain.length) {
            throw new Error('没有可用通道：请在中转站配置里启用至少一个带密钥的通道');
        }

        const failures = [];
        for (const channel of chain) {
            const started = Date.now();
            try {
                const { response } = await this.requestChannel(channel, payload, true);
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    const message = `HTTP ${response.status} ${String(detail || '').slice(0, 200)}`;
                    this.noteResult(channel.id, false, Date.now() - started, message);
                    failures.push(`${channel.id}: ${message}`);
                    continue;
                }
                this.noteResult(channel.id, true, Date.now() - started);
                return { channel, response };
            } catch (error) {
                const reason = error && error.name === 'TimeoutError'
                    ? `超时（${channel.timeoutMs || DEFAULT_TIMEOUT_MS}ms）`
                    : (error && error.message) || '请求失败';
                this.noteResult(channel.id, false, Date.now() - started, reason);
                failures.push(`${channel.id}: ${reason}`);
            }
        }
        throw new Error(`所有通道均失败：${failures.join('；')}`);
    }

    status() {
        const channels = (this.config.channels || []).map((channel) => {
            const stat = this.stats.get(channel.id) || {};
            return {
                id: channel.id,
                label: channel.label,
                model: channel.model,
                enabled: channel.enabled !== false,
                hasKey: Boolean(channel.apiKey),
                priority: Number(channel.priority) || 100,
                ok: stat.ok || 0,
                fail: stat.fail || 0,
                lastError: stat.lastError || '',
                lastUsedAt: stat.lastUsedAt || 0,
                lastLatencyMs: stat.lastLatencyMs || 0
            };
        });
        return {
            enabled: this.config.enabled !== false,
            channels,
            tasks: {
                queued: this.queue.length,
                running: this.running,
                total: this.tasks.size
            },
            messages: this.messages.length,
            recent: this.recent.slice(0, 20)
        };
    }

    // ---------- 信箱 ----------

    loadMessages() {
        try {
            const raw = fs.readFileSync(this.messagesPath, 'utf8');
            const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_MESSAGES_KEPT);
            this.messages = lines
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch (error) {
                        return null;
                    }
                })
                .filter(Boolean);
        } catch (error) {
            this.messages = [];
        }
    }

    postMessage({ from, to, content, meta = null } = {}) {
        const text = String(content || '').trim();
        if (!text) throw new Error('消息内容不能为空');
        if (text.length > MESSAGE_MAX_LEN) throw new Error(`消息过长（上限 ${MESSAGE_MAX_LEN} 字符）`);
        const message = {
            id: `m_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
            from: String(from || 'user').trim() || 'user',
            to: String(to || 'all').trim() || 'all',
            content: text,
            meta: meta && typeof meta === 'object' ? meta : null,
            timestamp: Date.now()
        };
        this.messages.push(message);
        if (this.messages.length > MAX_MESSAGES_KEPT) {
            this.messages = this.messages.slice(-MAX_MESSAGES_KEPT);
            this.rewriteMessages();
        } else {
            try {
                fs.appendFileSync(this.messagesPath, `${JSON.stringify(message)}\n`);
            } catch (error) {
                console.error('[中转站] 消息落盘失败:', error.message);
            }
        }
        this.emit('message', message);
        return message;
    }

    rewriteMessages() {
        try {
            const body = this.messages.map((message) => JSON.stringify(message)).join('\n');
            writeFileAtomicSync(this.messagesPath, body ? `${body}\n` : '');
        } catch (error) {
            console.error('[中转站] 消息重写失败:', error.message);
        }
    }

    listMessages({ agent = '', since = 0, limit = 50 } = {}) {
        const sinceTs = Number(since) || 0;
        const max = Math.max(1, Math.min(500, Number(limit) || 50));
        const name = String(agent || '').trim();
        const filtered = this.messages.filter((message) => {
            if (message.timestamp <= sinceTs) return false;
            if (!name) return true;
            return message.from === name || message.to === name || message.to === 'all';
        });
        return filtered.slice(-max);
    }

    // ---------- 任务队列 ----------

    loadTasks() {
        try {
            const stored = JSON.parse(fs.readFileSync(this.tasksPath, 'utf8'));
            if (Array.isArray(stored)) {
                stored.forEach((task) => {
                    if (!task || !task.id) return;
                    // 上次进程退出时还在跑的任务一律标记为中断，不给假希望
                    if (task.status === 'running' || task.status === 'queued') {
                        task.status = 'failed';
                        task.error = task.error || '服务重启，任务中断';
                        task.finishedAt = task.finishedAt || Date.now();
                    }
                    this.tasks.set(task.id, task);
                });
            }
        } catch (error) {
            // 首次启动没有任务文件，正常
        }
    }

    saveTasks() {
        const list = Array.from(this.tasks.values())
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, MAX_TASKS_KEPT);
        this.tasks = new Map(list.map((task) => [task.id, task]));
        try {
            writeJsonAtomicSync(this.tasksPath, list);
        } catch (error) {
            console.error('[中转站] 任务落盘失败:', error.message);
        }
    }

    createTask({ prompt, model = 'auto', system = '', title = '', agent = 'relay' } = {}) {
        const text = String(prompt || '').trim();
        if (!text) throw new Error('任务提示词不能为空');
        if (text.length > MESSAGE_MAX_LEN) throw new Error(`任务过长（上限 ${MESSAGE_MAX_LEN} 字符）`);
        const task = {
            id: `t_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
            title: String(title || '').trim() || text.slice(0, 40),
            agent: String(agent || 'relay').trim() || 'relay',
            model: String(model || 'auto').trim() || 'auto',
            system: String(system || '').slice(0, 20000),
            prompt: text,
            status: 'queued',
            createdAt: Date.now(),
            startedAt: 0,
            finishedAt: 0,
            channel: '',
            result: '',
            usage: null,
            error: ''
        };
        this.tasks.set(task.id, task);
        this.queue.push(task.id);
        this.saveTasks();
        this.emit('task', task);
        this.pump();
        return task;
    }

    pump() {
        while (this.running < TASK_CONCURRENCY && this.queue.length) {
            const id = this.queue.shift();
            const task = this.tasks.get(id);
            if (!task || task.status !== 'queued') continue;
            this.running += 1;
            this.runTask(task)
                .catch((error) => {
                    console.error('[中转站] 任务执行异常:', error.message);
                })
                .finally(() => {
                    this.running -= 1;
                    this.pump();
                });
        }
    }

    async runTask(task) {
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        task.status = 'running';
        task.startedAt = Date.now();
        this.saveTasks();
        this.emit('task', task);

        const messages = [];
        if (task.system) messages.push({ role: 'system', content: task.system });
        messages.push({ role: 'user', content: task.prompt });

        try {
            const { channel, json } = await this.chatWithSignal({ model: task.model, messages }, controller.signal);
            const choice = (json.choices && json.choices[0]) || {};
            task.channel = channel.id;
            task.result = (choice.message && choice.message.content) || '';
            task.usage = json.usage || null;
            task.status = controller.signal.aborted ? 'cancelled' : 'done';
        } catch (error) {
            if (controller.signal.aborted) {
                task.status = 'cancelled';
                task.error = '已取消';
            } else {
                task.status = 'failed';
                task.error = String((error && error.message) || '任务失败').slice(0, 500);
            }
        } finally {
            this.controllers.delete(task.id);
            task.finishedAt = Date.now();
            this.saveTasks();
            this.emit('task', task);
        }
        return task;
    }

    // 与 chat() 相同，但把中止信号一路传到 fetch，取消任务时能真的断开上游
    async chatWithSignal(payload, signal) {
        const chain = this.resolveChain(payload && payload.model);
        if (!chain.length) {
            throw new Error('没有可用通道：请在中转站配置里启用至少一个带密钥的通道');
        }
        const failures = [];
        for (const channel of chain) {
            const started = Date.now();
            try {
                const { response } = await this.requestChannel(channel, payload, false, signal);
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    const message = `HTTP ${response.status} ${String(detail || '').slice(0, 200)}`;
                    this.noteResult(channel.id, false, Date.now() - started, message);
                    failures.push(`${channel.id}: ${message}`);
                    continue;
                }
                const json = await response.json();
                this.noteResult(channel.id, true, Date.now() - started);
                return { channel, json };
            } catch (error) {
                if (signal && signal.aborted) throw new Error('已取消');
                const reason = error && error.name === 'TimeoutError'
                    ? `超时（${channel.timeoutMs || DEFAULT_TIMEOUT_MS}ms）`
                    : (error && error.message) || '请求失败';
                this.noteResult(channel.id, false, Date.now() - started, reason);
                failures.push(`${channel.id}: ${reason}`);
            }
        }
        throw new Error(`所有通道均失败：${failures.join('；')}`);
    }

    cancelTask(id) {
        const task = this.tasks.get(id);
        if (!task) return null;
        if (task.status === 'queued') {
            this.queue = this.queue.filter((item) => item !== id);
            task.status = 'cancelled';
            task.finishedAt = Date.now();
            this.saveTasks();
            this.emit('task', task);
            return task;
        }
        const controller = this.controllers.get(id);
        if (controller && task.status === 'running') {
            controller.abort();
            return task;
        }
        return task;
    }

    listTasks(limit = 30) {
        const max = Math.max(1, Math.min(MAX_TASKS_KEPT, Number(limit) || 30));
        return Array.from(this.tasks.values())
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, max);
    }

    emit(type, payload) {
        try {
            this.onEvent({ type, payload, at: Date.now() });
        } catch (error) {
            // 广播失败不能影响主流程
        }
    }
}

module.exports = { RelayHub, normalizeEndpoint, endpointToBase };
