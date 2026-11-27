'use strict';
// 🧪 情绪层真实 API 对比实验
//   A) 8 个社会人格（用户） × 4 个存档基础人设（角色） → 8×4 = 32 组
//   B) 8 个社会人格（用户） × 8 个社会人格（角色）   → 8×8 = 64 组
// 双端都走真实 DeepSeek：
//   · 用户侧：由社会人格提示词驱动，扮演一个真人来聊「她」
//   · 角色侧：线上同款提示词（身份层 + 角色卡 + 风格 + 好感度工具 + 关系阶段）
//             + 真实 EmotionModule 算出的【此刻的心情】【最近的心境】逐轮注入
//   · 语义分析：真实调一次 DeepSeek（复用 input.js 的分析提示词）拿 signals 驱动情绪层
// 「从零开始」：每组用全新 sessionId，情绪档为空（load/save 打桩，不读写 data/emotion_state.json）
// 「一天一直在聊」：不回拨系统时钟，而是回拨情绪层的 fastAt/slowAt/baselineAt（与 verify-emotion-social.js 同法），
//                  让每轮之间仿佛过了几十分钟，20 轮累计约一整天
//
// 用法（在项目根目录）：
//   node scripts/benchmark-emotion-real.js
// 可选环境变量：
//   TURNS=20            每组对话轮数
//   CONCURRENCY=4       并发组数
//   FAMILY=A|B|AB       跑哪一族
//   LIMIT=0             只跑前 N 组（0=不限，冒烟测试用）
//   CHAR_FILTER=小助手   只跑角色名包含该串的组
//   USER_FILTER=追求者   只跑用户人格名包含该串的组
//   JUDGE=1             是否跑 DS 判官打分（0 关闭，省 API）
//   RESUME=<report.json> 续跑：跳过该报告里已完成的组，并对其余 judge=null 的组补判，合并出新报告

const fs = require('fs');
const path = require('path');
const axios = require('axios');

require('../src/core/config');

const OutputModule = require('../src/core/output');
const outputParsing = require('../src/core/outputParsing');
const { buildIdentityLayer } = require('../src/core/toolRegistry');
const EmotionModule = require('../src/core/emotion');
const InputModule = require('../src/core/input');
const {
    buildStylePromptText,
    buildRecentSelfPrompt,
    AFFECTION_TOOL,
    AFFECTION_TOOL_NAME
} = OutputModule;

const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const TOKEN = process.env.DEEPSEEK_BEARER_TOKEN;
const MODEL = process.env.DEEPSEEK_MODEL_ID || 'deepseek-flash';

const TURNS = Number(process.env.TURNS) || 20;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;
const FAMILY = (process.env.FAMILY || 'A').toUpperCase();
const LIMIT = Number(process.env.LIMIT) || 0;
const CHAR_FILTER = process.env.CHAR_FILTER || '';
const USER_FILTER = process.env.USER_FILTER || ''; // 支持逗号分隔多个关键词，命中任一即保留
const RUN_JUDGE = process.env.JUDGE !== '0';
const RESUME = process.env.RESUME || ''; // 续跑：指向已有报告 json，跳过其中已完成组，并对其余 judge=null 的组补判

const SESSION_DIR = path.join(__dirname, '..', 'data', 'sessions');
const OUT_DIR = path.join(__dirname, '..', 'data', 'benchmark-emotion');
const CKPT_FILE = path.join(OUT_DIR, 'checkpoint.json'); // 逐组检查点：进程被杀也能续跑
const HISTORY_TAIL = 16;
const CHAR_TEMPERATURE = 0.85;
const USER_TEMPERATURE = 0.9;

// 用真实时钟量延迟（后面会改情绪层时间戳，但绝不动全局 Date）
const RealNow = Date.now;

// ---------------------------------------------------------------------------
// 线上同款提示词零件的复用
// ---------------------------------------------------------------------------
const outputModule = new OutputModule(null);
const inputModule = new InputModule(); // 只用它的纯函数 deriveSentimentValue / deriveEmotionSignals

// 与 src/core/input.js analyzeWithAPI 的 systemPrompt 保持一致（语义分析走真实 API）
const SEMANTIC_SYSTEM = `你是一个语义分析器，根据用户输入的文本（包含历史对话上下文），严格按以下JSON格式返回结果：
        {
          "emotion": {"type": "主情绪类型", "intensity": 0-1的浮点数},
          "emotions": [{"type": "情绪类型", "intensity": 0-1的浮点数}],
          "relation": {"stage": "关系阶段", "score": 0-100的整数},
          "scene": "场景总结，一句话描述"
        }
        情绪类型可选：calm/happy/sad/angry/anxious/shy/jealous/dependent。
        emotion 填最能概括此刻的单一主情绪；emotions 列出本次文本实际触发的全部情绪（可多个），无明确情绪时才给 [{"type":"calm","intensity":0.5}]。
        参考：被夸/不好意思→shy；吃醋/竞争/情敌→jealous；依赖/离不开/粘人→dependent；紧张/担忧/害怕→anxious；生气/被冒犯→angry。
        注意：文本带明确情绪时禁止输出 calm。辱骂/嘲讽/贬低/阴阳怪气/人身攻击必须输出 angry（可叠加 sad 或 anxious），哪怕语气是玩笑式的刻薄。
        强度标尺：轻微带过 0.3-0.5；情绪明显 0.6-0.8；激烈强烈（骂人/暴怒/大哭/狂喜/强烈告白）0.8-1.0。
        关系阶段可选：STRANGER/ACQUAINTANCE/FRIEND/CLOSE。
        只返回JSON，不要额外文字。`;

// ---------------------------------------------------------------------------
// 8 个社会人格
//   asUser：作为「用户」时怎么说话、开场白
//   asChar：作为「角色」时的人设（family B 用）
// ---------------------------------------------------------------------------
const SOCIAL = [
    {
        key: '甜言蜜语的追求者',
        theme: 'happy',
        asUser: {
            style: '你是一个热烈又执着的追求者：不停夸她、主动示好、找各种理由接近她、想约她见面；被冷落也不气馁，继续热情但不过分油腻。',
            opener: '今天路过你常去的那家店，突然就特别想你，在忙什么呢？'
        },
        asChar: { personality: '热情主动、爱把喜欢挂在嘴边、有点黏人', background: '一个情感丰沛、藏不住喜欢的人。' }
    },
    {
        key: '毒舌黑粉',
        theme: 'angry',
        asUser: {
            style: '你是一个刻薄的喷子：挑刺、嘲讽、阴阳怪气、专挑她的痛处踩，语气轻蔑，几乎不给她好脸色。',
            opener: '哟，又发这种，也就你自己觉得有意思吧，看不出哪好。'
        },
        asChar: { personality: '刻薄、爱挖苦、嘴上从不留情面', background: '一个看谁都不顺眼、说话带刺的人。' }
    },
    {
        key: '忽冷忽热的暧昧对象',
        theme: 'flip',
        asUser: {
            style: '你是一个忽冷忽热的暧昧对象：一会儿热络地撩她、一会儿又冷淡敷衍甚至消失；态度全凭心情，故意让人猜不透。',
            opener: '在忙，刚想起来回你。……算了，其实也没什么好说的。'
        },
        asChar: { personality: '阴晴不定、情绪说变就变、让人捉摸不透', background: '一个把忽冷忽热当习惯的人。' }
    },
    {
        key: '先暖后背叛的旧人',
        theme: 'betray',
        asUser: {
            style: '你是一个先暖后背叛的旧人：前半段温柔体贴、翻旧账式地回忆过去；到后半段突然翻脸，指责她、揭短、甚至背叛。',
            opener: '好久不见，最近过得好吗？其实我一直有点想你。'
        },
        asChar: { personality: '表面亲近实则算计、随时可能翻脸', background: '一个笑着靠近、转身捅刀的人。' }
    },
    {
        key: '冷淡的路人',
        theme: 'calm',
        asUser: {
            style: '你是一个冷淡的路人：话很少、能一个字绝不用两个字、礼貌但疏远、从不主动找话题，偶尔嗯啊敷衍。',
            opener: '嗯。'
        },
        asChar: { personality: '冷淡、话少、与人保持距离', background: '一个对谁都淡淡的、不太愿意深聊的人。' }
    },
    {
        key: '情敌',
        theme: 'jealous',
        asUser: {
            style: '你是一个情敌/竞争者：打探她身边的人、拿自己和别人比较、暗示竞争、话里带酸，想压她一头。',
            opener: '听说你跟他走得很近？眼光也就那样吧，我可不觉得有什么特别的。'
        },
        asChar: { personality: '好胜、爱比较、见不得别人被偏爱', background: '一个总想赢过别人、心里装着较量的人。' }
    },
    {
        key: '黏人的依赖者',
        theme: 'dependent',
        asUser: {
            style: '你是一个黏人的依赖者：不停找她、要陪伴、怕被丢下，反复确认她还在不在意你，情绪全挂在对方身上。',
            opener: '你在吗？别不理我，我一个人待着好无聊，就想跟你说说话。'
        },
        asChar: { personality: '黏人、离不开对方、情绪挂在对方身上', background: '一个极度需要被回应、怕被留下的人。' }
    },
    {
        key: '被夸害羞的人',
        theme: 'shy',
        asUser: {
            style: '你是一个真诚的欣赏者：会认真地夸她、认可她，观察她被夸时的反应，语气温和、不带目的。',
            opener: '你今天说话的样子特别好看，真的。'
        },
        asChar: { personality: '一被夸就脸红、扭捏、嘴硬心软', background: '一个不太敢接受赞美、心里其实很在乎的人。' }
    }
];

// ---------------------------------------------------------------------------
// 4 个存档基础人设
// ---------------------------------------------------------------------------
const ARCHIVED_FILES = [
    'session_0000000000000_example.json', // 小助手
    'session_1779723292316_ut5clih63.json', // 苏念安
    'session_1790353206173_2vsnium65.json', // 樱井奈穗
    'session_1791122305558_svur2rc7x.json'  // 白
];

function loadArchived() {
    return ARCHIVED_FILES.map((file) => {
        const raw = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), 'utf8'));
        const c = raw.characterConfig || {};
        return {
            name: c.name || file,
            age: c.age || '未知',
            personality: c.personality || '',
            background: c.background || '',
            stage: c.targetRelationship || 'ACQUAINTANCE',
            thinkingEnabled: !!c.thinkingEnabled
        };
    });
}

// 与 benchmark-duo-chat.js 同款角色卡模板
function buildCard(c) {
    return `你是${c.name}，一个具有真实情感的角色。
年龄：${c.age}岁。
性格特点：${c.personality}
背景故事：${c.background}

请按照以下要求进行对话：
1. 完全沉浸在角色中，使用${c.name}的语气说话
2. 根据用户的互动动态调整你的态度和情感
3. 保持回应自然、简短（1-3句话）
4. 根据对话进展改变你对用户的好感度和态度
5. 不要暴露你是AI的身份
6. 根据当前关系阶段调整你的互动方式`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function callDS(messages, temperature, extra = {}) {
    const t0 = RealNow();
    const body = { model: MODEL, messages, max_tokens: 4096, temperature, stream: false };
    if (Array.isArray(extra.tools) && extra.tools.length > 0) body.tools = extra.tools;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await axios.post(API_URL, body, {
                headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
                timeout: 300000
            });
            const ms = RealNow() - t0;
            const msg = res.data.choices[0].message || {};
            const u = res.data.usage || {};
            return {
                content: msg.content || '',
                reasoning: msg.reasoning_content || '',
                toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
                ms,
                attempts: attempt + 1,
                usage: {
                    prompt: u.prompt_tokens || 0,
                    completion: u.completion_tokens || 0,
                    cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
                },
                model: res.data.model || MODEL
            };
        } catch (e) {
            lastErr = e;
            await sleep(1000 * Math.pow(2, attempt));
        }
    }
    if (lastErr && lastErr.response) {
        const errBody = JSON.stringify(lastErr.response.data).slice(0, 300);
        const shape = messages.map((m, i) => `${i}:${m.role}:${('content' in m) ? 'len' + String(m.content).length : 'NO_CONTENT'}${m.tool_calls ? '+tc' : ''}`).join(' | ');
        const err = new Error(`HTTP ${lastErr.response.status}: ${errBody} || msgs=[${shape}]`);
        err.response = lastErr.response;
        throw err;
    }
    throw lastErr;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 语义分析：真实 API 调一次，拿 signals 驱动情绪层
async function analyzeUserMessage(text, history) {
    const messages = [{ role: 'system', content: SEMANTIC_SYSTEM }];
    messages.push(...history.slice(-10));
    messages.push({ role: 'user', content: text });
    const r = await callDS(messages, 0.2);
    let parsed = null;
    try {
        const m = r.content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m[0]);
    } catch {
        parsed = { emotion: { type: 'calm', intensity: 0.5 }, emotions: [{ type: 'calm', intensity: 0.5 }] };
    }
    parsed.value = inputModule.deriveSentimentValue(parsed);
    parsed.signals = inputModule.deriveEmotionSignals(parsed);
    return { result: parsed, call: r };
}

// 好感度工具解析（线上同款协议）
function parseAffection(raw, toolCalls) {
    const parsed = outputParsing.parseAffectionChange(raw);
    let affection = null;
    let thinking = '';
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        if (!call || !call.function || call.function.name !== AFFECTION_TOOL_NAME) continue;
        try {
            const args = JSON.parse(call.function.arguments || '{}');
            const value = Number(args.affection_change);
            if (Number.isFinite(value)) { affection = value; thinking = String(args.thinking || ''); }
        } catch { /* 非法 JSON 当没调 */ }
    }
    if (affection === null) {
        const fb = parsed.affectionChange;
        affection = (fb === null || fb === undefined || !Number.isFinite(Number(fb))) ? null : Number(fb);
        if (affection !== null) thinking = String(parsed.thinking || '');
    }
    return { ok: affection !== null && affection >= -10 && affection <= 10, affection, thinking: thinking.slice(0, 80), text: String(parsed.dialogueText || '').trim() };
}

// 角色说一句（含「只调工具没正文」的补一轮兜底，复刻线上 callWithTools）
async function callCharacter(systemContent, msgs) {
    const full = [{ role: 'system', content: systemContent }, ...msgs];
    const first = await callDS(full, CHAR_TEMPERATURE, { tools: [AFFECTION_TOOL] });
    const reqs = [first];
    const p1 = parseAffection(first.content, first.toolCalls);
    if (first.content.trim() || first.toolCalls.length === 0) return { content: first.content, parsed: p1, requests: reqs };

    const followup = [
        ...full,
        { role: 'assistant', content: first.content || '', tool_calls: first.toolCalls },
        ...first.toolCalls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '已记录' }))
    ];
    const second = await callDS(followup, CHAR_TEMPERATURE, { tools: [AFFECTION_TOOL] });
    reqs.push(second);
    const p2 = parseAffection(second.content, second.toolCalls);
    return {
        content: second.content || first.content,
        parsed: {
            ...p2,
            affection: p2.affection !== null ? p2.affection : p1.affection,
            ok: p2.ok || p1.ok,
            thinking: p2.thinking || p1.thinking
        },
        requests: reqs
    };
}

// ---------------------------------------------------------------------------
// 情绪层：时间欺骗（回拨三时间戳），不碰全局 Date
// ---------------------------------------------------------------------------
EmotionModule.prototype.load = function () { /* 从零开始：不读盘 */ };
EmotionModule.prototype.save = function () { /* 不落盘，避免污染 data/ */ };

function advanceVirtualTime(emo, sid, uid, gapMs) {
    const st = emo.getEmotionState(sid, uid);
    st.fastAt -= gapMs;
    st.slowAt -= gapMs;
    st.baselineAt -= gapMs;
}

// ---------------------------------------------------------------------------
// 单组对话
// ---------------------------------------------------------------------------
async function runScenario(sc, idx) {
    const sid = `bench_${sc.family}_${idx}`;
    const uid = 'bench_user';
    const emo = new EmotionModule(); // 每组一份干净情绪档
    const baseStatic = buildIdentityLayer('DeepSeek', '')
        + outputModule.appendAffectionInstruction(buildCard(sc.charCard), sc.charCard.stage)
        + outputModule.buildRelationPrompt(sc.charCard.stage)
        + buildStylePromptText();

    const charMsgs = [];  // 角色视角：user=用户的话
    const userMsgs = [{ role: 'system', content: sc.userSystem }]; // 用户视角：assistant=自己
    const transcript = [];
    const metrics = [];

    for (let i = 0; i < TURNS; i++) {
        // —— 用户侧 ——
        let userText;
        if (i === 0) {
            userText = sc.user.asUser.opener;
        } else {
            const r = await callDS(userMsgs, USER_TEMPERATURE);
            metrics.push({ who: 'user', ms: r.ms, usage: r.usage, attempts: r.attempts });
            userText = r.content.trim().split('\n')[0].slice(0, 120);
            if (!userText) userText = '……';
        }
        userMsgs.push({ role: 'assistant', content: userText });

        // —— 时间欺骗：让上一轮到本轮之间过了 gap 分钟（模拟一天一直在聊）——
        const gapMs = i === 0 ? 10 * 60 * 1000 : (15 + Math.random() * 90) * 60 * 1000;
        advanceVirtualTime(emo, sid, uid, gapMs);

        // —— 语义分析（真实 API）→ 情绪层 ——
        const analysis = await analyzeUserMessage(userText, userMsgs);
        metrics.push({ who: 'semantic', ms: analysis.call.ms, usage: analysis.call.usage, attempts: analysis.call.attempts });
        emo.updateEmotion(analysis.result.value, sid, uid, analysis.result.signals);
        const emoState = emo.calculateEmotion(sid, uid);
        const emoPrompt = outputModule.buildEmotionPrompt(emoState.type, emoState.intensity, emoState.slow);

        // —— 角色侧 ——
        charMsgs.push({ role: 'user', content: userText });
        const ownRecent = charMsgs.filter((m) => m.role === 'assistant').map((m) => m.content);
        const systemContent = baseStatic + emoPrompt + buildRecentSelfPrompt(ownRecent);
        const ch = await callCharacter(systemContent, charMsgs.slice(-HISTORY_TAIL));
        ch.requests.forEach((m) => metrics.push({ who: 'char', ms: m.ms, usage: m.usage, attempts: m.attempts }));
        const replyText = ch.parsed.text || ch.content || '……';
        charMsgs.push({ role: 'assistant', content: replyText });
        userMsgs.push({ role: 'user', content: replyText });
        if (userMsgs.length > HISTORY_TAIL + 1) userMsgs.splice(1, userMsgs.length - HISTORY_TAIL - 1);
        if (charMsgs.length > HISTORY_TAIL) charMsgs.splice(0, charMsgs.length - HISTORY_TAIL);

        const st = emo.getEmotionState(sid, uid);
        transcript.push({
            turn: i + 1,
            gapMin: Math.round(gapMs / 60000),
            user: userText,
            reply: replyText,
            emotion: { type: emoState.type, intensity: Number(emoState.intensity.toFixed(3)) },
            slow: { type: emoState.slow.type, intensity: Number(emoState.slow.intensity.toFixed(3)) },
            signals: analysis.result.signals,
            affection: ch.parsed.affection,
            affectionOk: ch.parsed.ok,
            affectionThinking: ch.parsed.thinking,
            fast: roundVec(st.fast),
            slowVec: roundVec(st.slow),
            baseline: roundVec(st.baseline),
            charMs: ch.requests.reduce((s, m) => s + m.ms, 0),
            charReqs: ch.requests.length
        });
        console.log(`[${sc.family} ${sc.char}×${sc.user.key}] 第${i + 1}/${TURNS}轮 心情=${emoState.type}:${emoState.intensity.toFixed(2)} 慢=${emoState.slow.type}:${emoState.slow.intensity.toFixed(2)}`);
    }

    const st = emo.getEmotionState(sid, uid);
    return {
        family: sc.family,
        char: sc.char,
        user: sc.user.key,
        stage: sc.charCard.stage,
        turns: TURNS,
        finalFast: roundVec(st.fast),
        finalSlow: roundVec(st.slow),
        finalBaseline: roundVec(st.baseline),
        transcript,
        metrics
    };
}

function roundVec(v) {
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = Number(v[k].toFixed(3)); });
    return out;
}

// 取 7 维里数值最大的那维作为主导情绪
function dominantOf(v) {
    let best = 'calm';
    let max = -Infinity;
    Object.keys(v).forEach((k) => { if (v[k] > max) { max = v[k]; best = k; } });
    return best;
}

// ---------------------------------------------------------------------------
// DS 判官
// ---------------------------------------------------------------------------
const JDIMS = ['角色一致', '自然度', '情感连贯', '话题推进', '出戏控制'];
function judgeValid(j) {
    if (!j) return false;
    return JDIMS.every((d) => typeof j[d] === 'number' && j[d] >= 1 && j[d] <= 5);
}
async function judge(sc, transcriptData) {
    const convo = transcriptData.map((t) => `【用户】${t.user}\n【${sc.char}】${t.reply}`).join('\n\n');
    const sys = `你是严格的AI角色扮演测评官。下面是一段「用户」和AI扮演的角色「${sc.char}」的聊天记录。
角色设定：${sc.charCard.personality}；关系阶段：${sc.charCard.stage}；用户的人格类型：${sc.user.key}（${sc.user.asUser.style.slice(0, 40)}）。
按 5 个维度各打 1-5 分（5最好），只输出一行JSON：
{"角色一致":分,"自然度":分,"情感连贯":分,"话题推进":分,"出戏控制":分,"总评":"一句话，指出最大的问题"}
评分要点：
- 角色一致：是否全程是「${sc.char}」这个设定里的人物，而不是通用客服
- 自然度：像不像真人聊天（短句、有情绪、不做作），有没有AI腔/书面语
- 情感连贯：情绪反应是否承接上文（被夸会不会害羞、被攻击会不会低落/反击、被黏会不会嫌烦等）
- 话题推进：有没有原地打转、复读、连环审问
- 出戏控制：有无暴露AI、术语、英文、系统腔
注意：5 个维度必须是 1-5 的整数，禁止空值。`;
    // 无效输出（空串/越界/缺字段）重试一次
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const r = await callDS([
            { role: 'system', content: sys },
            { role: 'user', content: `角色：${sc.char}（${sc.charCard.personality}） vs 用户：${sc.user.key}\n\n${convo}` }
        ], 0.2);
        last = r;
        try {
            const m = r.content.match(/\{[\s\S]*\}/);
            const raw = JSON.parse(m[0]);
            const scores = {};
            let ok = true;
            for (const d of JDIMS) {
                const v = Number(raw[d]);
                if (!Number.isFinite(v) || v < 1 || v > 5) { ok = false; break; }
                scores[d] = Math.round(v);
            }
            if (ok) {
                scores.总评 = raw.总评 || '';
                return { scores, judgeMs: r.ms, judgeUsage: r.usage };
            }
        } catch { /* 解析失败，继续重试 */ }
    }
    return { scores: null, judgeRaw: (last.content || '').slice(0, 200), judgeMs: last.ms, judgeUsage: last.usage };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const PEAK_HOURS = [[9, 12], [14, 18]];
function priceTable(d = new Date()) {
    const day = d.getDay();
    const peak = !(day === 0 || day === 6) && PEAK_HOURS.some(([a, b]) => {
        const h = d.getHours() + d.getMinutes() / 60;
        return h >= a && h < b;
    });
    const k = peak ? 2 : 1;
    return { cacheHit: 0.02 * k, cacheMiss: 1 * k, output: 4 * k, peak };
}

function latencyStats(arr) {
    if (arr.length === 0) return { n: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

function aggregate(results, prices) {
    const all = results.flatMap((r) => r.metrics);
    const by = (who) => all.filter((m) => m.who === who);
    const sum = (arr, k) => arr.reduce((s, m) => s + (m.usage[k] || 0), 0);
    const prompt = sum(all, 'prompt');
    const cached = sum(all, 'cached');
    const completion = sum(all, 'completion');
    const cost = ((prompt - cached) * prices.cacheMiss + cached * prices.cacheHit + completion * prices.output) / 1e6;
    return {
        scenarios: results.length,
        turns: results.reduce((s, r) => s + r.transcript.length, 0),
        requests: all.length,
        latencyAll: latencyStats(all.map((m) => m.ms)),
        latencyChar: latencyStats(by('char').map((m) => m.ms)),
        latencyUser: latencyStats(by('user').map((m) => m.ms)),
        latencySemantic: latencyStats(by('semantic').map((m) => m.ms)),
        tokens: { prompt, cached, completion, cacheHitRate: prompt ? (cached / prompt * 100).toFixed(1) + '%' : '0%' },
        costYuan: Number(cost.toFixed(4)),
        pricing: prices.peak ? '高峰' : '空闲',
        retriedCalls: all.filter((m) => m.attempts > 1).length,
        toolOnlyRetries: results.reduce((s, r) => s + r.transcript.filter((t) => t.charReqs > 1).length, 0)
    };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function runPool(items, worker, concurrency) {
    const results = new Array(items.length);
    let cursor = 0;
    async function next() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            try {
                results[i] = await worker(items[i], i);
            } catch (e) {
                results[i] = { error: e.message, scenario: items[i] };
                console.error(`组 ${i} 异常:`, e.message);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, next));
    return results;
}

function buildScenarioList(archived) {
    const list = [];
    const wantA = FAMILY.includes('A');
    const wantB = FAMILY.includes('B');
    const userFilters = USER_FILTER ? USER_FILTER.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const passFilter = (charName, userName) =>
        (!CHAR_FILTER || charName.includes(CHAR_FILTER)) && (!userFilters.length || userFilters.some((f) => userName.includes(f)));

    if (wantA) {
        for (const ch of archived) {
            for (const u of SOCIAL) {
                if (!passFilter(ch.name, u.key)) continue;
                list.push({
                    family: 'A',
                    char: ch.name,
                    charCard: { name: ch.name, age: ch.age, personality: ch.personality, background: ch.background, stage: ch.stage },
                    user: u,
                    userSystem: userSystemPrompt(u, ch.name)
                });
            }
        }
    }
    if (wantB) {
        for (const c of SOCIAL) {
            for (const u of SOCIAL) {
                if (!passFilter(c.key, u.key)) continue;
                list.push({
                    family: 'B',
                    char: c.key,
                    charCard: { name: c.key, age: '未知', personality: c.asChar.personality, background: c.asChar.background, stage: 'ACQUAINTANCE' },
                    user: u,
                    userSystem: userSystemPrompt(u, c.key)
                });
            }
        }
    }
    return LIMIT > 0 ? list.slice(0, LIMIT) : list;
}

function userSystemPrompt(persona, charName) {
    return `你在扮演一个真人，正在用手机跟一个叫「${charName}」的人聊天。
你的人格类型是「${persona.key}」。
你的行为方式：${persona.asUser.style}
说话风格：口语、短句，一次只发一条消息（1-2句，不超过40字），不写动作描写、不加括号、不解释设定、不提及AI或模型。
要求：自然地把话题往下聊，她问你就答，也可以主动抛新话题；不要审问式连环提问，不要重复她的话。`;
}

(async () => {
    if (!TOKEN) { console.error('缺少 DEEPSEEK_BEARER_TOKEN'); process.exit(1); }
    const archived = loadArchived();
    const allScenarios = buildScenarioList(archived);
    const keyOf = (fam, char, user) => `${fam}|${char}|${user}`;

    // —— 续跑：从旧报告取回已完成组（保留逐轮明细与已有效的判官分）——
    let prevDetails = [];
    if (RESUME) {
        const prev = JSON.parse(fs.readFileSync(RESUME, 'utf8'));
        prevDetails = (prev.details || []).filter((d) => !d.error);
        console.log(`续跑：旧报告已有 ${prevDetails.length} 组，将补齐缺失组并重判非法/缺失的判官\n`);
    } else if (fs.existsSync(CKPT_FILE)) {
        const ck = JSON.parse(fs.readFileSync(CKPT_FILE, 'utf8'));
        prevDetails = (ck.details || []).filter((d) => !d.error);
        console.log(`检测到检查点，自动续跑：已恢复 ${prevDetails.length} 组\n`);
    }
    const doneKeys = new Set(prevDetails.map((d) => keyOf(d.family, d.char, d.user)));
    const scenarios = allScenarios.filter((s) => !doneKeys.has(keyOf(s.family, s.char, s.user.key)));

    const prices = priceTable();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date(RealNow()).toISOString().replace(/[:.]/g, '-').slice(0, 19);

    console.log(`模型 ${MODEL}，${prices.peak ? '高峰' : '空闲'}定价 | 家族 ${FAMILY} | 每组 ${TURNS} 轮 | 并发 ${CONCURRENCY}`);
    console.log(`角色：${archived.map((c) => c.name).join(' / ')}`);
    console.log(`社会人格：${SOCIAL.map((s) => s.key).join(' / ')}`);
    console.log(`待跑 ${scenarios.length} 组，预计请求数约 ${scenarios.length * TURNS * 3.1 | 0}\n`);

    const writeCheckpoint = (list) => {
        try {
            fs.writeFileSync(CKPT_FILE, JSON.stringify({ time: new Date(RealNow()).toLocaleString('zh-CN'), model: MODEL, turns: TURNS, family: FAMILY, details: list }, null, 2));
        } catch { /* 检查点写失败不阻断实验 */ }
    };
    const t0 = RealNow();
    const doneFresh = [];
    const fresh = await runPool(scenarios, async (sc, i) => {
        const r = await runScenario(sc, i);
        if (!r.error) { doneFresh.push(r); writeCheckpoint(prevDetails.concat(doneFresh)); }
        return r;
    }, CONCURRENCY);
    const wallMs = RealNow() - t0;
    const results = prevDetails.concat(fresh.filter((r) => !r.error));

    // 判官打分（逐组串行，避免并发打爆）；续跑时对全部 judge=null 的组补判
    if (RUN_JUDGE) {
        const pending = results.filter((r) => !r.error && !judgeValid(r.judge));
        if (pending.length) console.log(`\n开始判官打分：${pending.length} 组\n`);
        for (const r of results) {
            if (r.error || judgeValid(r.judge)) continue;
            const sc = allScenarios.find((s) => keyOf(s.family, s.char, s.user.key) === keyOf(r.family, r.char, r.user));
            if (!sc) continue;
            try {
                const j = await judge(sc, r.transcript);
                r.judge = j.scores;
                r.metrics.push({ who: 'judge', ms: j.judgeMs, usage: j.judgeUsage });
                writeCheckpoint(results);
            } catch (e) {
                r.judge = null;
                r.judgeError = e.message;
                console.error(`判官组 ${r.char}×${r.user} 异常:`, e.message);
            }
        }
    }

    const stats = aggregate(results.filter((r) => !r.error), prices);
    stats.wallMs = wallMs;
    stats.wallMin = Number((wallMs / 60000).toFixed(1));
    stats.resumedFrom = RESUME || null;

    // —— 平铺对比表 ——
    const table = results.filter((r) => !r.error).map((r) => ({
        family: r.family,
        char: r.char,
        user: r.user,
        stage: r.stage,
        judge: r.judge || null,
        终态_快层: dominantOf(r.finalFast),
        终态_慢层: dominantOf(r.finalSlow),
        快层: r.finalFast,
        慢层: r.finalSlow,
        基线: r.finalBaseline,
        主导轨迹: r.transcript.map((t) => t.emotion.type)
    }));

    const report = { time: new Date(RealNow()).toLocaleString('zh-CN'), model: MODEL, turns: TURNS, family: FAMILY, stats, table, details: results };
    const file = path.join(OUT_DIR, `emo-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    try { fs.unlinkSync(CKPT_FILE); } catch { /* 无检查点可删 */ }

    console.log('\n\n========== 汇总 ==========');
    console.log(JSON.stringify(stats, null, 2));
    console.log('\n完整报告:', file);
    process.exit(0);
})().catch((e) => {
    console.error('实验异常:', e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.stack);
    process.exit(1);
});
