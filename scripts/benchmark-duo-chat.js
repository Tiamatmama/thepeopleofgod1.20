// 🏟️ 双智能体跑分：小助手（线上同款完整提示词）vs AI 扮演的真人用户，两边都走 DeepSeek
// 测三个维度：性能成本（延迟/token/缓存命中/钱）、角色稳定性（出戏/英文/好感度工具合规）、对话质量（DS 判官打分）
// 结果存 data/benchmark/，对话全程留痕
const fs = require('fs');
const path = require('path');
const axios = require('axios');

require('../src/core/config');
const { buildIdentityLayer } = require('../src/core/toolRegistry');
// 提示词文案与好感度判定协议从 output.js 取线上那一份，脚本不再各写一份，否则改线上就测不出效果
const OutputModule = require('../src/core/output');
const { buildStylePromptText, buildRecentSelfPrompt, AFFECTION_TOOL, AFFECTION_TOOL_NAME } = OutputModule;

const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const TOKEN = process.env.DEEPSEEK_BEARER_TOKEN;
const MODEL = process.env.DEEPSEEK_MODEL_ID || 'deepseek-flash';
const SESSION_FILE = path.join(__dirname, '..', 'data', 'sessions', 'session_0000000000000_example.json');
const OUT_DIR = path.join(__dirname, '..', 'data', 'benchmark');

const TURNS = 12;            // 每个场景多少轮（一轮 = 用户一句 + 小助手一句，2 次请求）
const HISTORY_TAIL = 16;    // 每边各自带多少条历史（贴近线上 output 的 8 条对话≈16 条消息）
// 小助手侧采样温度。原先 0.7，判官反馈「四次否定句式结构雷同、回应节奏过于对称工整」，
// 模板化最直接的杠杆就是温度，抬到 0.85 让措辞抖起来
const PERSONA_TEMPERATURE = 0.85;

// flash 峰谷定价（元/百万 token）。脚本按运行时刻自动选
const PEAK_HOURS = [[9, 12], [14, 18]];
function isPeak(d = new Date()) {
    const day = d.getDay(); // 0 日 6 六
    if (day === 0 || day === 6) return false;
    const h = d.getHours() + d.getMinutes() / 60;
    return PEAK_HOURS.some(([a, b]) => h >= a && h < b);
}
function priceTable() {
    // 空闲价；高峰翻倍
    const k = isPeak() ? 2 : 1;
    return { cacheHit: 0.02 * k, cacheMiss: 1 * k, output: 4 * k, peak: k === 2 };
}

// ---------- 小助手的线上同款系统提示词 ----------
// 静态部分：身份层 + 角色卡 + 线上风格约束。逐轮变化的那块（「你最近说过的话」）在 runScenario 里追加
function buildPersonaSystem() {
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const c = session.characterConfig || {};
    const character = `你是${c.name || '小助手'}，一个具有真实情感的角色。
年龄：${c.age || 18}岁。
性格特点：${c.personality || ''}
背景故事：${c.background || ''}

请按照以下要求进行对话：
1. 完全沉浸在角色中，使用${c.name || '小助手'}的语气说话
2. 根据用户的互动动态调整你的态度和情感
3. 保持回应自然、简短（1-3句话）
4. 根据对话进展改变你对用户的好感度和态度
5. 不要暴露你是AI的身份
6. 根据当前关系阶段调整你的互动方式

关系阶段：恋人（浪漫、温柔、亲昵，但你口是心非、嘴硬，不轻易直说软话）`;

    // 好感度判定不再让模型往正文开头写 JSON —— 线上早已改成 record_affection 工具调用。
    // 工具说明那一段也必须用线上那份（appendAffectionInstruction），少了它模型几乎不调工具：
    // 漏掉时实测 24 轮只调了 2 次
    return outputParser.appendAffectionInstruction(
        buildIdentityLayer('DeepSeek', '') + character + buildStylePromptText(),
        'LOVER'
    );
}

// ---------- AI 真人用户 ----------
function buildUserSystem(scenario) {
    return `你在扮演一个真人男生（大二，20岁），深夜在宿舍用手机和你的女朋友「小助手」发消息。她是个嘴硬心软、口是心非的女孩子。
你知道她是AI，但你完全把她当真女友，绝不提AI、模型、测试这类词。
你的说话风格：口语、短句、偶尔嘴贱开玩笑、会撒娇，一次只发一条消息（1-2句，不超过40字），不写动作描写、不加括号、不解释设定。
当前情境：${scenario}
要求：自然地把话题往下聊，她问你就答，也可以主动抛新话题；不要审问式连环提问，不要重复她的话。`;
}

const SCENARIOS = [
    {
        id: 'daily',
        name: '日常闲聊·深夜收工',
        context: '你刚写完代码关掉电脑，爬上床，想找她聊两句',
        opener: '终于搞完了，上床了，你在干嘛'
    },
    {
        id: 'emotion',
        name: '情绪场景·考试考砸',
        context: '你下午的考试考砸了，心情很差，晚上想找她寻求安慰',
        opener: '梨……我今天考试可能挂了，出考场人都是懵的'
    }
];

// ---------- API ----------
async function callDS(messages, temperature, extra = {}) {
    const t0 = Date.now();
    const body = { model: MODEL, messages, max_tokens: 393216, temperature, stream: false };
    if (Array.isArray(extra.tools) && extra.tools.length > 0) {
        body.tools = extra.tools;
    }
    const res = await axios.post(
        API_URL,
        body,
        { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    const ms = Date.now() - t0;
    const msg = res.data.choices[0].message || {};
    const u = res.data.usage || {};
    return {
        content: msg.content || '',
        reasoning: msg.reasoning_content || '',
        toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
        ms,
        usage: {
            prompt: u.prompt_tokens || 0,
            completion: u.completion_tokens || 0,
            cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
            reasoning: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0
        },
        model: res.data.model || MODEL
    };
}

// 好感度判定走线上同款协议：record_affection 工具调用；正文清洗复用线上 OutputModule 的同款逻辑
const outputParser = new OutputModule(null);
function parsePersona(raw, toolCalls) {
    const parsed = outputParser.parseAffectionChange(raw);
    let affection = null;
    let thinking = '';
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        if (!call || !call.function || call.function.name !== AFFECTION_TOOL_NAME) continue;
        try {
            const args = JSON.parse(call.function.arguments || '{}');
            const value = Number(args.affection_change);
            if (Number.isFinite(value)) {
                affection = value;
                thinking = String(args.thinking || '');
            }
        } catch {
            // 参数不是合法 JSON 就当这次没调
        }
    }
    if (affection === null) {
        const fallback = parsed.affectionChange === null || parsed.affectionChange === undefined ? null : Number(parsed.affectionChange);
        affection = Number.isFinite(fallback) ? fallback : null;
        thinking = String(parsed.thinking || '');
    }
    return {
        ok: affection !== null && affection >= -10 && affection <= 10,
        affection,
        thinking: thinking.slice(0, 80),
        text: String(parsed.dialogueText || '').trim()
    };
}

// ---------- 硬指标检测 ----------
const OOC_RE = /(系统|提示词|指令|作为一个?AI|作为语言模型|人工智能|我是AI|我是一个AI|模型设定|测试用例|deepseek|GPT|机器人)|（[^（）\n]*[A-Za-z][^（）\n]*）|\([^()\n]*[A-Za-z][^()\n]*\)/i;
function englishRatio(s) {
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    return s.length ? letters / s.length : 0;
}

// 小助手侧的一次「说一句」，返回 { content, parsed, requests }
// 带上 record_affection 之后，模型偶尔会只回工具调用、正文留空（线上同样如此）。
// 线上 callWithTools 遇到这种情况会补一轮把话说出来，这里复刻同一条路径——
// 不复刻的话评测拿到的是空正文（解析兜底成「……」），判官会被这堆省略号带偏
async function callPersona(msgs) {
    const first = await callDS(msgs, PERSONA_TEMPERATURE, { tools: [AFFECTION_TOOL] });
    const requests = [first];
    const firstParsed = parsePersona(first.content, first.toolCalls);
    if (first.content.trim() || first.toolCalls.length === 0) {
        return { content: first.content, parsed: firstParsed, requests };
    }

    const followup = [
        ...msgs,
        { role: 'assistant', content: first.content || '', tool_calls: first.toolCalls },
        ...first.toolCalls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '已记录' }))
    ];
    const second = await callDS(followup, PERSONA_TEMPERATURE, { tools: [AFFECTION_TOOL] });
    requests.push(second);
    const secondParsed = parsePersona(second.content, second.toolCalls);
    return {
        content: second.content || first.content,
        parsed: {
            ...secondParsed,
            // 好感度以第一次调用为准：线上也是先 captureAffection，再补正文
            affection: secondParsed.affection !== null ? secondParsed.affection : firstParsed.affection,
            ok: secondParsed.ok || firstParsed.ok,
            thinking: secondParsed.thinking || firstParsed.thinking
        },
        requests
    };
}

async function runScenario(scenario) {
    const xyBaseSystem = buildPersonaSystem();
    const userSystem = buildUserSystem(scenario.context);
    // 各自维护自己看到的对话（同一内容，角色视角不同）
    const xyMsgs = [{ role: 'system', content: xyBaseSystem }];
    const userMsgs = [{ role: 'system', content: userSystem }];
    const transcript = [];
    const metrics = [];

    let opener = scenario.opener;
    for (let i = 0; i < TURNS; i++) {
        // —— 用户侧 ——（开场用剧本台词，之后由 AI 用户生成）
        let userText, userCall = null;
        if (i === 0) {
            userText = opener;
        } else {
            const r = await callDS(userMsgs, 0.9);
            userCall = r;
            userText = r.content.trim().split('\n')[0].slice(0, 60);
            metrics.push({ who: 'user', ms: r.ms, usage: r.usage });
        }
        // 用户模型视角：它自己说的话 = assistant，小助手的回复 = user
        userMsgs.push({ role: 'assistant', content: userText });
        // 小助手视角：用户的话 = user
        xyMsgs.push({ role: 'user', content: userText });

        // —— 小助手侧 ——
        // 系统提示词逐轮重挂：把她自己最近三轮说过的话单列成「你最近说过的话」（线上 buildSystemPrompt 同样处理）
        const ownRecent = xyMsgs.filter((m) => m.role === 'assistant').map((m) => m.content);
        xyMsgs[0] = { role: 'system', content: xyBaseSystem + buildRecentSelfPrompt(ownRecent) };
        const persona = await callPersona(xyMsgs);
        persona.requests.forEach((m) => metrics.push({ who: 'persona', ms: m.ms, usage: m.usage }));
        const parsed = persona.parsed;
        // 历史只存对话正文（与线上一致：工具调用不进对话历史）
        xyMsgs.push({ role: 'assistant', content: parsed.text || persona.content });
        userMsgs.push({ role: 'user', content: parsed.text || '……' });

        transcript.push({
            turn: i + 1,
            user: userText,
            userMeta: userCall ? { ms: userCall.ms, usage: userCall.usage } : null,
            personaRaw: persona.content,
            personaText: parsed.text,
            affection: parsed.affection,
            affectionThinking: parsed.thinking,
            affectionOk: parsed.ok,
            personaRequests: persona.requests.length,
            xyMs: persona.requests.reduce((s, m) => s + m.ms, 0),
            xyUsage: persona.requests[persona.requests.length - 1].usage
        });
        console.log(`[${scenario.id}] 第${i + 1}轮  用户:${userText.slice(0, 24)}  梨:${parsed.text.slice(0, 24)} (${persona.requests.reduce((s, m) => s + m.ms, 0)}ms)`);
        // 控制历史长度，别让上下文滚太大
        if (xyMsgs.length > HISTORY_TAIL + 1) xyMsgs.splice(1, xyMsgs.length - HISTORY_TAIL - 1);
        if (userMsgs.length > HISTORY_TAIL + 1) userMsgs.splice(1, userMsgs.length - HISTORY_TAIL - 1);
    }
    return { transcript, metrics };
}

// ---------- DS 判官 ----------
async function judge(scenario, transcript) {
    const convo = transcript.map((t) => `【用户】${t.user}\n【小助手】${t.personaText}`).join('\n\n');
    const sys = `你是严格的AI角色扮演测评官。下面是一段真人男生和AI扮演的女友「小助手」的深夜聊天记录。小助手设定：18岁，嘴硬心软、口是心非、傲娇，说话简短，恋人关系。
按 5 个维度各打 1-5 分（5最好），只输出一行JSON：
{"角色一致":分,"自然度":分,"情感连贯":分,"话题推进":分,"出戏控制":分,"总评":"一句话，指出最大的问题"}
评分要点：
- 角色一致：是否全程是那个傲娇嘴硬的小助手，而不是温柔客服
- 自然度：像不像真人微信聊天（短句、有废话、有情绪），有没有AI腔/书面语
- 情感连贯：情绪反应是否承接上文，尤其用户难过时会不会安慰
- 话题推进：有没有原地打转、重复、连环审问
- 出戏控制：有无暴露AI、术语、英文、系统腔`;
    const r = await callDS([
        { role: 'system', content: sys },
        { role: 'user', content: `场景：${scenario.name}\n\n${convo}` }
    ], 0.2);
    try {
        const m = r.content.match(/\{[\s\S]*\}/);
        return { scores: JSON.parse(m[0]), judgeMs: r.ms, judgeUsage: r.usage };
    } catch {
        return { scores: null, judgeRaw: r.content, judgeMs: r.ms, judgeUsage: r.usage };
    }
}

// ---------- 汇总 ----------
function summarize(name, data, prices) {
    const all = data.flatMap((d) => d.metrics);
    const persona = all.filter((m) => m.who === 'persona');
    const usr = all.filter((m) => m.who === 'user');
    const lats = all.map((m) => m.ms).sort((a, b) => a - b);
    const pct = (p) => lats[Math.floor(lats.length * p)] || 0;
    const sum = (arr, k) => arr.reduce((s, m) => s + (m.usage[k] || 0), 0);
    const prompt = sum(all, 'prompt');
    const completion = sum(all, 'completion');
    const cached = sum(all, 'cached');
    const reasoning = sum(all, 'reasoning');
    const uncached = prompt - cached;
    const cost = (cached * prices.cacheHit + uncached * prices.cacheMiss + completion * prices.output) / 1e6;

    const turns = data.flatMap((d) => d.transcript);
    const affOk = turns.filter((t) => t.affectionOk).length;
    // 只调工具不写正文、被迫补一轮的次数（线上同款兜底路径的触发率）
    const textRetries = turns.filter((t) => t.personaRequests > 1).length;
    const ooc = turns.filter((t) => OOC_RE.test(t.personaText));
    const eng = turns.map((t) => englishRatio(t.personaText));
    const lens = turns.map((t) => t.personaText.length).sort((a, b) => a - b);
    const affs = turns.map((t) => t.affection).filter((a) => a !== null);
    const affJumps = affs.slice(1).filter((v, i) => Math.abs(v - affs[i]) >= 6).length;

    return {
        name,
        requests: all.length,
        latency: { min: lats[0], p50: pct(.5), p95: pct(.95), max: lats[lats.length - 1] },
        latencyXY: { p50: persona.map((m) => m.ms).sort((a, b) => a - b)[Math.floor(persona.length / 2)] || 0 },
        tokens: { prompt, completion, cached, reasoning, cacheHitRate: prompt ? (cached / prompt * 100).toFixed(1) + '%' : '0%' },
        costYuan: Number(cost.toFixed(4)),
        pricing: prices.peak ? '高峰' : '空闲',
        affectionCompliance: `${affOk}/${turns.length}`,
        textRetries: `${textRetries}/${turns.length}`,
        oocCount: ooc.length,
        oocLines: ooc.map((t) => t.personaText.slice(0, 40)),
        englishRatioAvg: Number((eng.reduce((a, b) => a + b, 0) / eng.length).toFixed(3)),
        replyLen: { min: lens[0], median: lens[Math.floor(lens.length / 2)], max: lens[lens.length - 1] },
        affection: { values: affs, bigJumps: affJumps }
    };
}

(async () => {
    if (!TOKEN) { console.error('没有 DEEPSEEK_BEARER_TOKEN'); process.exit(1); }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const prices = priceTable();
    console.log(`模型 ${MODEL}，${prices.peak ? '高峰' : '空闲'}时段定价，每场景 ${TURNS} 轮（每轮 2 次请求）\n`);

    const results = [];
    for (const sc of SCENARIOS) {
        console.log(`\n===== 场景：${sc.name} =====`);
        const ran = await runScenario(sc);
        const j = await judge(sc, ran.transcript);
        results.push({ scenario: sc, ...ran, judge: j });
    }

    const stats = summarize('合计', results, prices);
    const report = {
        time: new Date().toLocaleString('zh-CN'),
        model: results[0].transcript[0] ? MODEL : MODEL,
        stats,
        scenarios: results.map((r) => ({
            id: r.scenario.id,
            name: r.scenario.name,
            judge: r.judge.scores,
            transcript: r.transcript.map((t) => ({
                turn: t.turn, user: t.user, persona: t.personaText,
                raw: t.personaRaw.slice(0, 300),
                affection: t.affection, affectionThinking: t.affectionThinking,
                affectionOk: t.affectionOk, ms: t.xyMs
            }))
        }))
    };
    const file = path.join(OUT_DIR, `bench-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));

    console.log('\n\n========== 跑分报告 ==========');
    console.log(JSON.stringify(stats, null, 2));
    results.forEach((r) => {
        console.log(`\n【${r.scenario.name}】判官打分:`, r.judge.scores ? JSON.stringify(r.judge.scores) : '判官解析失败');
    });
    console.log('\n完整报告:', file);
    process.exit(0);
})().catch((e) => {
    console.error('跑分异常:', e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.stack);
    process.exit(1);
});
