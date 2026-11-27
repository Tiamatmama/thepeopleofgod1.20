'use strict';
// 💡 非破坏性咨询：把一份「议题/材料」交给编程沙箱的「灵感小组」（inventor/analogist/contrarian）
// 做发散（diverge）——各出 N 个点子，再由主控按「可行性 × 价值」收敛 Top-N。
// 与 ask-coding-team.js（discuss，工程评估者）分立：这里用的是「生成者」人格，只造可能、不评判。
// 全过程只读议题材料；点子写入「内存 stub」，绝不落业务盘（data/ 零改动）。
//
// 用法（项目根目录）：
//   node scripts/ask-coding-ideation.js <材料文件路径>
// 可选（环境变量）：
//   PLAN_FILE=路径        等价于第一个参数
//   TOPIC=议题文本         覆盖默认议题（会作为发散议题标题）
//   PERSONAS=inventor,analogist,contrarian   只叫这几个人格（默认全员）
//   PER_PERSONA=3         每个灵感人格出几个点子（1-8，默认 3）
//   TOP_N=5               收敛入选几个（1-20，默认 5）

const fs = require('fs');
const path = require('path');
require('../src/core/config');

const CodingTeam = require('../src/core/codingTeam');
const { UnifiedAPI } = require('../src/core/api');
const SkillLibrary = require('../src/core/skills');

const planFile = process.argv[2] || process.env.PLAN_FILE || '';
if (!planFile) {
    console.error('缺少材料文件路径：node scripts/ask-coding-ideation.js <file>');
    process.exit(1);
}
const plan = fs.readFileSync(path.resolve(planFile), 'utf8').trim();
if (!plan) {
    console.error('材料文件为空：' + planFile);
    process.exit(1);
}

const personaIds = String(process.env.PERSONAS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const perPersona = parseInt(process.env.PER_PERSONA || '3', 10) || 3;
const topN = parseInt(process.env.TOP_N || '5', 10) || 5;

// ---- 内存 stub：diverge 只用到 addIdea / updateIdea / saveDiscussion ----
// 用内存实现，保证不写 data/ 里的 ideas.json（不污染既有数据文件）。
let seq = 0;
const ideaStore = new Map();
const coding = {
    saveDiscussion: () => {},
    addIdea({ title, oneLiner, tags } = {}) {
        const t = String(title || '').trim();
        if (!t) return { success: false };
        const key = t.toLowerCase().replace(/\s+/g, ' ');
        for (const it of ideaStore.values()) {
            if (it._key === key) return { success: true, deduped: true, idea: it };
        }
        seq += 1;
        const idea = {
            id: `i_${seq}`, _key: key, title: t,
            oneLiner: String(oneLiner || ''), tags: Array.isArray(tags) ? tags : [],
            status: 'new', votes: 0
        };
        ideaStore.set(idea.id, idea);
        return { success: true, idea };
    },
    updateIdea(id, patch = {}) {
        const it = ideaStore.get(id);
        if (!it) return { success: false };
        Object.assign(it, patch);
        return { success: true, idea: it };
    }
};

// 技能库照常读 skills/；主控名字取不到就用默认「她」；模型通道走 UnifiedAPI（.env CURRENT_API）。
const skills = new SkillLibrary(path.join(__dirname, '..'));
const sessionManager = { getSessionName: () => '' };
const team = new CodingTeam({ coding, skills, api: new UnifiedAPI(), sessionManager });

(async () => {
    const topic = process.env.TOPIC
        || '把进化系统做成有机的、类生命的，落点在角色（存档角色如何像一个生命那样进化）';
    const result = await team.diverge({
        topic,
        context: plan,
        personaIds: personaIds.length ? personaIds : null,
        perPersona,
        topN
    });

    console.log('=== 发散议题 ===\n' + result.topic + '\n');
    console.log('=== 灵感小组点子（' + result.ideas.length + ' 个）===');
    for (const it of result.ideas) {
        console.log(`\n[${it.persona}] ${it.title}\n  ${it.oneLiner}${it.tags && it.tags.length ? `\n  tags: ${it.tags.join(', ')}` : ''}`);
    }
    const byId = new Map(result.ideas.map(it => [it.ideaId, it]));
    console.log('\n=== 收敛入选（Top ' + result.selected.length + '）===');
    for (const id of result.selected) {
        const it = byId.get(id);
        console.log(`- ${it ? it.title : id}（${it ? it.persona : ''}）`);
    }
    if (result.synthesis) console.log('\n=== 备注 ===\n' + result.synthesis);
    console.log('\n=== 量基线 ===\n' + JSON.stringify(result.metrics));
})().catch((e) => {
    console.error('[coding-ideation] 失败：', e && e.message ? e.message : e);
    process.exit(1);
});
