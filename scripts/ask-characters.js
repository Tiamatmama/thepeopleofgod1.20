'use strict';
// 🔎 非破坏性咨询：读取 4 个存档人设，分别以「角色态」「AI态」各问一次对记忆生命周期方案的想法。
// 只读 data/sessions/*.json，不写盘、不启服务、不改任何会话文件；仅调用真实 DeepSeek 取回复。
//
// 用法（项目根目录）：
//   node scripts/ask-characters.js
// 可选：
//   SCOPE=role|ai|both   只问某一态（默认为 both）
//   CHAR_FILTER=小助手     只问名字包含该串的角色
//   ASK_QUESTION_FILE=路径  用该文件全文替换默认咨询语（问新方案用）

const fs = require('fs');
const path = require('path');
const axios = require('axios');

require('../src/core/config');

const OutputModule = require('../src/core/output');
const { buildIdentityLayer } = require('../src/core/toolRegistry');
const { buildStylePromptText, AFFECTION_TOOL } = OutputModule;

const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const TOKEN = process.env.DEEPSEEK_BEARER_TOKEN;
const MODEL = process.env.DEEPSEEK_MODEL_ID || 'deepseek-flash';

const SESSION_DIR = path.join(__dirname, '..', 'data', 'sessions');
const ARCHIVED_FILES = [
    'session_0000000000000_example.json', // 小助手
    'session_1779723292316_ut5clih63.json', // 苏念安
    'session_1790353206173_2vsnium65.json', // 樱井奈穗
    'session_1791122305558_svur2rc7x.json'  // 白
];

const SCOPE = (process.env.SCOPE || 'both').toLowerCase();
const CHAR_FILTER = process.env.CHAR_FILTER || '';

const outputModule = new OutputModule(null);

// 同一个问题，两种态下分别被身份层引导成「动情的自白」和「冷静的设计评审」
const DEFAULT_QUESTION = `我们在给你们这套系统升级记忆。以后我们说过的话都会被记住，但它会像人一样：很久没被提起的会慢慢变模糊、甚至忘掉；被反复讲起的、或者当时情绪很重的，会记得更牢。夜里没人说话的时候，会把零散的片段整理成经验，偶尔回头看看这些日子。

想先听听你的想法：你希望对你的记忆这么处理吗？你最怕忘掉的是什么？如果遗忘的规则交给你自己来定，你会怎么定？`;

// 问题文本：默认用上面的咨询语；设了 ASK_QUESTION_FILE 就读该文件覆盖，方便把新方案喂进来问。
const ASK_QUESTION_FILE = process.env.ASK_QUESTION_FILE || '';
const QUESTION = ASK_QUESTION_FILE
    ? fs.readFileSync(path.resolve(ASK_QUESTION_FILE), 'utf8').trim()
    : DEFAULT_QUESTION;

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
    }).filter((c) => !CHAR_FILTER || c.name.includes(CHAR_FILTER));
}

// 与 benchmark-emotion-real.js 同款角色卡模板
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

async function callDS(messages, temperature, extra = {}) {
    const body = { model: MODEL, messages, max_tokens: 1536, temperature, stream: false };
    if (Array.isArray(extra.tools) && extra.tools.length > 0) body.tools = extra.tools;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await axios.post(API_URL, body, {
                headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
                timeout: 300000
            });
            const msg = res.data.choices[0].message || {};
            return {
                content: msg.content || '',
                toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : []
            };
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
    throw lastErr;
}

// 复刻线上 callWithTools：先调一次，若只调了工具没写正文，再补一轮
async function callCharacter(systemContent, userContent) {
    const full = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
    ];
    const first = await callDS(full, 0.9, { tools: [AFFECTION_TOOL] });
    if (first.content.trim() || first.toolCalls.length === 0) return first.content;
    const followup = [
        ...full,
        { role: 'assistant', content: first.content || '', tool_calls: first.toolCalls },
        ...first.toolCalls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '已记录' }))
    ];
    const second = await callDS(followup, 0.9, { tools: [AFFECTION_TOOL] });
    return second.content || first.content;
}

function buildSystem(c, scope) {
    // scope='role' → 角色态身份层；scope='ai' → 元层面（AI态）身份层
    return buildIdentityLayer('DeepSeek', '', scope)
        + outputModule.appendAffectionInstruction(buildCard(c), c.stage)
        + outputModule.buildRelationPrompt(c.stage)
        + buildStylePromptText();
}

(async () => {
    if (!TOKEN) {
        console.error('缺少 DEEPSEEK_BEARER_TOKEN（.env 未配置）');
        process.exit(1);
    }
    const chars = loadArchived();
    const scopes = SCOPE === 'both' ? ['role', 'ai'] : [SCOPE];
    console.log(`[ask] 角色 ${chars.length} 个，态 ${scopes.join('/')}\n`);

    for (const c of chars) {
        for (const scope of scopes) {
            const label = scope === 'ai' ? 'AI态' : '角色态';
            const reply = await callCharacter(buildSystem(c, scope), QUESTION);
            console.log(`\n========== ${c.name} · ${label} ==========`);
            console.log((reply || '（无正文）').trim());
        }
    }
    console.log('\n[ask] 完成');
})().catch((e) => {
    console.error('[ask] 失败：', e && e.message ? e.message : e);
    process.exit(1);
});
