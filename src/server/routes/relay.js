'use strict';

// 中转站路由（依赖经 ctx 注入，避免反向 require index.js）：
//   /relay/v1/*   —— 给外部工具用的 OpenAI / Anthropic 兼容入口（本机或 relay token）
//   /api/relay/*  —— 自家面板用的管理接口（需要登录）
//
// 外部入口不要求登录，是因为 Claude Code / Cherry Studio 这类客户端不会带我们的
// x-session-id；但它们必须带上 relay token。

function registerRelayRoutes(app, ctx) {
    const { requireLogin, serverError, relayHub } = ctx;

    function relayError(res, status, message) {
        return res.status(status).json({
            error: { message, type: status === 401 ? 'authentication_error' : 'upstream_error' }
        });
    }

    // 一律要求 relay token。只认来源 IP 不够：同一台机器上的任何进程
    // （脚本、被投毒的依赖）都能直接冒用这条通道，读对话、烧 key。
    function relayAuth(req, res, next) {
        const token = String(relayHub.config.authToken || '');
        if (!token) {
            return relayError(res, 403, '中转站未配置访问令牌：请先在「中转站」面板填写，再填到客户端的 API Key 里');
        }
        const header = String(req.headers.authorization || '');
        const apiKey = String(req.headers['x-api-key'] || '');
        const supplied = String(
            req.headers['x-relay-token'] || header.replace(/^Bearer\s+/i, '') || apiKey
        ).trim();
        if (supplied && supplied === token) return next();
        return relayError(res, 401, 'Relay token 不正确');
    }

    // OpenAI 的 content 可能是字符串，也可能是 [{type:'text',text:'…'}] 数组
    function contentToText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (!part || typeof part !== 'object') return '';
                    if (part.type === 'text') return part.text || '';
                    if (part.type === 'tool_result') return contentToText(part.content);
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        return content == null ? '' : String(content);
    }

    function anthropicToOpenAI(body) {
        const messages = [];
        const system = contentToText(body.system);
        if (system) messages.push({ role: 'system', content: system });

        (Array.isArray(body.messages) ? body.messages : []).forEach((message) => {
            if (!message || !message.role) return;
            const role = message.role === 'assistant' ? 'assistant' : 'user';
            const blocks = Array.isArray(message.content)
                ? message.content
                : [{ type: 'text', text: message.content == null ? '' : String(message.content) }];

            if (role === 'assistant') {
                const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
                const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
                if (toolUses.length) {
                    messages.push({
                        role: 'assistant',
                        content: text || null,
                        tool_calls: toolUses.map((b) => ({
                            id: b.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                            type: 'function',
                            function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
                        }))
                    });
                } else if (text) {
                    messages.push({ role: 'assistant', content: text });
                }
                return;
            }

            // Claude Code 的工具结果放在 user 消息的 tool_result 块里，要拆成 OpenAI 的 tool 消息
            blocks.filter((b) => b && b.type === 'tool_result').forEach((b) => {
                messages.push({
                    role: 'tool',
                    tool_call_id: b.tool_use_id,
                    content: contentToText(b.content)
                });
            });

            const parts = [];
            blocks.forEach((b) => {
                if (!b) return;
                if (b.type === 'text' && b.text) {
                    parts.push({ type: 'text', text: b.text });
                } else if (b.type === 'image' && b.source) {
                    const url = b.source.data
                        ? `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`
                        : b.source.url;
                    if (url) parts.push({ type: 'image_url', image_url: { url } });
                }
            });
            if (parts.length === 1 && parts[0].type === 'text') {
                messages.push({ role: 'user', content: parts[0].text });
            } else if (parts.length) {
                messages.push({ role: 'user', content: parts });
            }
        });

        const payload = {
            model: body.model,
            messages,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            stream: false
        };

        if (Array.isArray(body.tools) && body.tools.length) {
            payload.tools = body.tools.filter((t) => t && t.name).map((t) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description || '',
                    parameters: t.input_schema || { type: 'object', properties: {} }
                }
            }));
            const choice = body.tool_choice;
            if (choice && choice.type === 'auto') payload.tool_choice = 'auto';
            else if (choice && choice.type === 'any') payload.tool_choice = 'required';
            else if (choice && choice.type === 'tool' && choice.name) {
                payload.tool_choice = { type: 'function', function: { name: choice.name } };
            }
        }
        return payload;
    }

    function toAnthropicResponse(body, channel, json) {
        const choice = (json.choices && json.choices[0]) || {};
        const reply = choice.message || {};
        const content = [];
        const text = contentToText(reply.content);
        if (text) content.push({ type: 'text', text });

        const toolCalls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
        toolCalls.forEach((call) => {
            let input = {};
            try {
                input = JSON.parse((call.function && call.function.arguments) || '{}');
            } catch (error) {
                input = { _raw: (call.function && call.function.arguments) || '' };
            }
            content.push({
                type: 'tool_use',
                id: call.id || `tool_${Date.now().toString(36)}`,
                name: (call.function && call.function.name) || 'tool',
                input
            });
        });
        if (!content.length) content.push({ type: 'text', text: '' });

        let stopReason = 'end_turn';
        if (toolCalls.length) stopReason = 'tool_use';
        else if (choice.finish_reason === 'length') stopReason = 'max_tokens';

        const usage = json.usage || {};
        return {
            id: `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            model: json.model || channel.model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: Number(usage.prompt_tokens) || 0,
                output_tokens: Number(usage.completion_tokens) || 0
            }
        };
    }

    // 按 Anthropic SSE 协议回放一个完整的 message（文本 + tool_use 都要发）
    function writeAnthropicStream(res, message) {
        const send = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send('message_start', {
            type: 'message_start',
            message: {
                id: message.id,
                type: 'message',
                role: 'assistant',
                model: message.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 }
            }
        });

        message.content.forEach((block, index) => {
            if (block.type === 'tool_use') {
                send('content_block_start', {
                    type: 'content_block_start',
                    index,
                    content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
                });
                const json = JSON.stringify(block.input || {});
                const chunks = json.match(/[\s\S]{1,60}/g) || [''];
                chunks.forEach((chunk) => {
                    send('content_block_delta', {
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'input_json_delta', partial_json: chunk }
                    });
                });
            } else {
                const text = String(block.text || '');
                send('content_block_start', {
                    type: 'content_block_start',
                    index,
                    content_block: { type: 'text', text: '' }
                });
                const chunks = text.match(/[\s\S]{1,60}/g) || [''];
                chunks.forEach((chunk) => {
                    send('content_block_delta', {
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'text_delta', text: chunk }
                    });
                });
            }
            send('content_block_stop', { type: 'content_block_stop', index });
        });

        send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: null },
            usage: { output_tokens: message.usage.output_tokens }
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
    }

    // 把上游 SSE 原样转给客户端；客户端断开时顺手取消上游读取，避免连接悬着
    async function pipeUpstream(upstream, res) {
        const reader = upstream.body.getReader();
        let closed = false;
        res.on('close', () => {
            closed = true;
            reader.cancel().catch(() => {});
        });
        try {
            while (!closed) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
            }
        } finally {
            if (!closed) res.end();
        }
    }

    // ---------- 外部入口 ----------

    app.get('/relay/v1/models', relayAuth, (req, res) => {
        const ids = new Set(['auto']);
        relayHub.enabledChannels().forEach((channel) => {
            ids.add(channel.id);
            if (channel.model) ids.add(channel.model);
        });
        res.json({
            object: 'list',
            data: Array.from(ids).map((id) => ({ id, object: 'model', owned_by: 'relay' }))
        });
    });

    app.post('/relay/v1/chat/completions', relayAuth, async (req, res) => {
        const body = req.body || {};
        if (!Array.isArray(body.messages) || !body.messages.length) {
            return relayError(res, 400, 'messages 不能为空');
        }
        if (body.stream) {
            try {
                const { response, channel } = await relayHub.chatStream(body);
                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Relay-Channel', channel.id);
                res.flushHeaders();
                await pipeUpstream(response, res);
            } catch (error) {
                if (res.headersSent) {
                    res.end();
                    return;
                }
                return relayError(res, 502, error.message);
            }
            return;
        }
        try {
            const { channel, json } = await relayHub.chat(body);
            res.setHeader('X-Relay-Channel', channel.id);
            res.json(json);
        } catch (error) {
            return relayError(res, 502, error.message);
        }
    });

    app.post('/relay/v1/messages', relayAuth, async (req, res) => {
        const body = req.body || {};
        if (!Array.isArray(body.messages) || !body.messages.length) {
            return relayError(res, 400, 'messages 不能为空');
        }
        try {
            const { channel, json } = await relayHub.chat(anthropicToOpenAI(body));
            const message = toAnthropicResponse(body, channel, json);
            res.setHeader('X-Relay-Channel', channel.id);
            if (body.stream) {
                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();
                writeAnthropicStream(res, message);
                return;
            }
            res.json(message);
        } catch (error) {
            return relayError(res, 502, error.message);
        }
    });

    // Claude Code 会先算 token 数；我们不做真实分词，按字符量粗估即可
    app.post('/relay/v1/messages/count_tokens', relayAuth, (req, res) => {
        const body = req.body || {};
        let chars = contentToText(body.system).length;
        (Array.isArray(body.messages) ? body.messages : []).forEach((message) => {
            if (!message) return;
            chars += contentToText(message.content).length;
            const blocks = Array.isArray(message.content) ? message.content : [];
            blocks.forEach((block) => {
                if (block && block.type === 'tool_use') chars += JSON.stringify(block.input || {}).length;
            });
        });
        (Array.isArray(body.tools) ? body.tools : []).forEach((tool) => {
            chars += JSON.stringify(tool || {}).length;
        });
        res.json({ input_tokens: Math.max(1, Math.ceil(chars / 3)) });
    });

    // ---------- 管理接口 ----------

    app.get('/api/relay/status', requireLogin, (req, res) => {
        res.json({ success: true, status: relayHub.status() });
    });

    app.get('/api/relay/config', requireLogin, (req, res) => {
        res.json({ success: true, config: relayHub.publicConfig() });
    });

    app.put('/api/relay/config', requireLogin, (req, res) => {
        try {
            const config = relayHub.updateConfig(req.body || {});
            res.json({ success: true, config });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    });

    app.get('/api/relay/messages', requireLogin, (req, res) => {
        const messages = relayHub.listMessages({
            agent: req.query.agent,
            since: req.query.since,
            limit: req.query.limit
        });
        res.json({ success: true, messages });
    });

    app.post('/api/relay/messages', requireLogin, (req, res) => {
        try {
            const body = req.body || {};
            const message = relayHub.postMessage({
                from: body.from,
                to: body.to,
                content: body.content,
                meta: body.meta
            });
            res.json({ success: true, message });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    });

    app.get('/api/relay/tasks', requireLogin, (req, res) => {
        res.json({ success: true, tasks: relayHub.listTasks(req.query.limit) });
    });

    app.post('/api/relay/tasks', requireLogin, (req, res) => {
        try {
            const body = req.body || {};
            const task = relayHub.createTask({
                prompt: body.prompt,
                model: body.model,
                system: body.system,
                title: body.title,
                agent: body.agent
            });
            res.json({ success: true, task });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    });

    app.post('/api/relay/tasks/:taskId/cancel', requireLogin, (req, res) => {
        const task = relayHub.cancelTask(req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        res.json({ success: true, task });
    });

    // 面板上的「测一下」：指定通道打一句最短的话，返回耗时与回复
    app.post('/api/relay/test', requireLogin, async (req, res) => {
        const body = req.body || {};
        const channelId = String(body.channel || '').trim();
        if (!channelId) {
            return res.status(400).json({ success: false, message: '请指定要测试的通道' });
        }
        const started = Date.now();
        try {
            const { channel, json } = await relayHub.chat({
                model: channelId,
                messages: [{ role: 'user', content: String(body.prompt || '用一句话介绍你自己') }],
                max_tokens: 64
            });
            const choice = (json.choices && json.choices[0]) || {};
            res.json({
                success: true,
                channel: channel.id,
                latencyMs: Date.now() - started,
                text: (choice.message && choice.message.content) || ''
            });
        } catch (error) {
            res.status(502).json({ success: false, message: error.message, latencyMs: Date.now() - started });
        }
    });
}

module.exports = registerRelayRoutes;
