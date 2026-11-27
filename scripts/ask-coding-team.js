'use strict';
// 🏗 非破坏性咨询：把一份「方案」交给编程沙箱（编程团队），用多人格讨论（discuss）
// 从工程视角评审。除传入的方案文件外，人格还能用一组「只读工具」真实读项目代码，
// 把断言落在证据（文件路径 + 行号）上。全过程只读，讨论结果只打印到控制台，不写业务盘。
//
// 用法（项目根目录）：
//   node scripts/ask-coding-team.js <方案文件路径>
// 可选（环境变量）：
//   PLAN_FILE=路径        等价于第一个参数
//   TOPIC=议题文本         覆盖默认议题（默认「评审……三个方向的优先级与工程可行性」）
//   PERSONAS=architect,security,product   只叫这几个人格（默认全员）
//   ROUNDS=1|2|3          讨论轮数（默认 1）
//   MODE=diverge          走灵感小组（发明家/类比迁移/逆向假设）发散，再由 product+architect 收敛
//   PER_PERSONA=3         发散模式下每个灵感人格出几个点子（默认 3）
//   TOP_N=5               发散模式下收敛保留几个（默认 5）
//   EXTRA_DOCS=a.md,b.md  额外并入的参考材料（逗号分隔；哲学原文这类约束必须显式带上，
//                         否则人格只能看到方案本身，不知道项目的不变量）
//   OUT=路径              把整场结果另存为 Markdown（diverge 默认写 .trae/documents/发散-<时间>.md；
//                         不指定 OUT=0 就一定会落一份，避免点子只活在控制台里、上下文丢了就找不回）
//   READ=0                关闭只读工具（退化为纯文本讨论，与改造前一致）
//   SANDBOX_ROOT=路径      只读工具的根目录（默认=当前项目根）；评审外部项目时指向该项目根

const fs = require('fs');
const path = require('path');
require('../src/core/config');

const CodingTeam = require('../src/core/codingTeam');
const { UnifiedAPI } = require('../src/core/api');
const SkillLibrary = require('../src/core/skills');

const planFile = process.argv[2] || process.env.PLAN_FILE || '';
if (!planFile) {
    console.error('缺少方案文件路径：node scripts/ask-coding-team.js <file>');
    process.exit(1);
}
const plan = fs.readFileSync(path.resolve(planFile), 'utf8').trim();
if (!plan) {
    console.error('方案文件为空：' + planFile);
    process.exit(1);
}

// 额外材料（如哲学原文）：人格看不到约束就只能凭常识发散，这里按顺序拼在方案后面
const extraDocs = String(process.env.EXTRA_DOCS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map((file) => {
        try {
            const text = fs.readFileSync(path.resolve(file), 'utf8').trim();
            if (!text) {
                console.warn(`[附加材料] 为空，已跳过：${file}`);
                return '';
            }
            return `\n\n===== 附加材料：${path.basename(file)} =====\n${text}`;
        } catch (error) {
            console.warn(`[附加材料] 读取失败，已跳过：${file}（${error.message}）`);
            return '';
        }
    })
    .join('');
const material = extraDocs ? `${plan}${extraDocs}` : plan;

const personaIds = String(process.env.PERSONAS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const rounds = Math.max(1, Math.min(parseInt(process.env.ROUNDS || '1', 10) || 1, 3));
const mode = String(process.env.MODE || 'discuss').trim().toLowerCase();
const perPersona = Math.max(1, Math.min(parseInt(process.env.PER_PERSONA || '3', 10) || 3, 8));
const topN = Math.max(1, Math.min(parseInt(process.env.TOP_N || '5', 10) || 5, 20));

// ---- 只读工具：限定在只读根目录内，供人格发言时读取真实代码（只读，绝不写）----
// 默认根 = 当前项目；评审外部项目时用 SANDBOX_ROOT 指向该项目根（仍钉在根内，防越界）
const { createReadTools } = require('../src/core/readTools');
const READ_TOOLS = createReadTools({
    root: process.env.SANDBOX_ROOT || path.join(__dirname, '..'),
    onCall: (name, args) => console.log(`[只读工具] ${name}(${JSON.stringify(args)})`)
});

// 最小依赖：技能库照常读 skills/ 目录；讨论落盘用一个内存壳（不写业务盘）；
// 主控名字取不到就用默认「她」。模型通道走 UnifiedAPI（当前通道 = .env CURRENT_API）。
const skills = new SkillLibrary(path.join(__dirname, '..'));
// 点子落库壳：diverge 需要 addIdea/updateIdea，这里只存在进程内存里，不写业务盘；
// 同标题重复提交按幂等返回已有条目（与真实 coding.addIdea 的契约一致）
const ideaStore = new Map();
let ideaSeq = 0;
const coding = {
    saveDiscussion: () => {},
    addIdea: (idea = {}) => {
        const title = String(idea.title || '').trim();
        for (const it of ideaStore.values()) {
            if (it.title === title) return { success: true, idea: it };
        }
        const record = { id: `idea_${++ideaSeq}`, status: 'candidate', votes: 0, ...idea, title };
        ideaStore.set(record.id, record);
        return { success: true, idea: record };
    },
    updateIdea: (id, patch = {}) => {
        const cur = ideaStore.get(id);
        if (!cur) return { success: false };
        const next = { ...cur, ...patch };
        ideaStore.set(id, next);
        return { success: true, idea: next };
    }
};
const sessionManager = { getSessionName: () => '' };
const team = new CodingTeam({
    coding,
    skills,
    api: new UnifiedAPI(),
    sessionManager,
    readTools: process.env.READ === '0' ? null : READ_TOOLS
});

// 结果落盘：点子与理由只活在 stdout 里，上下文一丢就再也找不回（上一次就是这么丢的）。
// 默认写到 .trae/documents/，OUT=0 才显式关闭
function persist(title, lines) {
    const out = String(process.env.OUT == null || process.env.OUT === '' ? '' : process.env.OUT).trim();
    if (out === '0') return '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = out || path.join(__dirname, '..', '.trae', 'documents', `${title}-${stamp}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return path.resolve(file);
}

(async () => {
    if (mode === 'diverge') {
        const topic = process.env.TOPIC || '为《召回改造-待审方案》的下一阶段发散：在已落地的 R6/R4 之外，还能怎么改';
        const result = await team.diverge({ topic, context: material, perPersona, topN });
        const byId = new Map(result.ideas.map(it => [it.ideaId, it]));
        const md = [`# 灵感发散：${result.topic}`, '', `> ${result.createdAt}｜人格：${result.personas.map(p => p.name).join('、')}`, ''];

        console.log('=== 灵感发散 ===');
        for (const it of result.ideas) {
            console.log(`\n[${it.persona}] ${it.title}\n  ${it.oneLiner}\n  why：${it.why || '（未给）'}${it.tags.length ? `\n  #${it.tags.join(' #')}` : ''}`);
            md.push(`## [${it.persona}] ${it.title}`, '', `- 是什么：${it.oneLiner}`, `- 为什么：${it.why || '（未给）'}`,
                it.tags.length ? `- 标签：${it.tags.join('、')}` : '', '');
        }
        console.log('\n=== 收敛 Top-N ===');
        md.push('## 收敛 Top-N', '');
        for (const id of result.selected) {
            const it = byId.get(id);
            if (!it) continue;
            console.log(`- ${it.title}｜${it.oneLiner}（来自 ${it.persona}）`);
            md.push(`- ${it.title}｜${it.oneLiner}（来自 ${it.persona}）`);
        }
        if (result.synthesis) {
            console.log('\n=== 备注 ===\n' + result.synthesis);
            md.push('', '## 备注', '', result.synthesis);
        }
        md.push('', '## 用量', '', `调用 ${result.metrics.calls} 次；token ${result.metrics.tokens.total}（缺 usage ${result.metrics.usageMissing} 次）`);
        const saved = persist('发散', md);
        if (saved) console.log(`\n[已落盘] ${saved}`);
        return;
    }
    const topic = process.env.TOPIC || '评审《下一阶段深化方案（草案）》：判断三个方向的优先级与工程可行性，指出风险、过度设计与最小落地路径';
    const result = await team.discuss({
        topic,
        context: material,
        personaIds: personaIds.length ? personaIds : null,
        rounds,
        vote: true
    });

    console.log('=== 多人格讨论 ===');
    for (const t of result.transcript) {
        const to = t.toName ? `→${t.toName}` : '';
        console.log(`\n[${t.persona}${to}] ${t.text}`);
    }
    console.log('\n=== 立场表决 ===');
    for (const v of result.votes) {
        console.log(`${v.persona}：${v.stance}${v.reason ? `（${v.reason}）` : ''}`);
    }
    console.log('\n=== 主控归纳 ===\n' + (result.synthesis || '（无）'));
})().catch((e) => {
    console.error('[coding-team] 失败：', e && e.message ? e.message : e);
    process.exit(1);
});
