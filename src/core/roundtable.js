// 大神圆桌：把 2~5 份蒸馏出来的人格放进同一场讨论，按轮次轮流发言，最后由主持人归纳。
// 与编程团队讨论（codingTeam.discuss）分开：那边的人格是写死的工程角色，
// 这边的人格来自蒸馏（有出处、有可信度标记），纪律也不同——不许替别人编履历、不许假装有共识。
const fs = require('fs');
const path = require('path');
const { UnifiedAPI } = require('./api');
const { ROUNDTABLE_DIR } = require('./personaDistill');

const MIN_EXPERTS = 2;
const MAX_EXPERTS = 5;
const MAX_ROUNDS = 3;
const TURN_MAX_CHARS = 260;   // 单条发言的软上限：圆桌要交锋，不要长篇
const HISTORY_CHARS = 6000;   // 带进下一轮的历史上限

const RULES = [
  '讨论纪律：',
  '- 你就是这个人本人，用第一人称说话，按你的语气和句式，别写成教科书。',
  '- 只用你确实经历过/公开说过的东西。没听过的事就说「这个我不了解」，不要编履历、数据、案例。',
  '- 引用自己的旧观点可以说「我以前讲过」，但没有公开原话就别加引号假装引用。',
  '- 别人说错了就直接反驳，讲清为什么；别人说得对就承认，别为了立场硬拗。',
  `- 每次发言 ${TURN_MAX_CHARS} 字以内，短句、口语，不要复述别人刚说过的话。`
].join('\n');

function nowId() {
  return `rt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// 把人格档案压成一份可用的系统提示：事实只保留过了筛查的，立场带出处
// 需求简报：由需求理解环节产出，作为全场共同前提拼进每个人设。
// 支持字符串或对象；对象只取已知字段，避免把任意结构塞进 prompt。
function renderBrief(brief) {
  if (!brief) return '';
  if (typeof brief === 'string') return brief.trim().slice(0, 2000);
  if (typeof brief !== 'object' || Array.isArray(brief)) return '';
  const lines = [];
  const scalar = [['goal', '目标'], ['why', '为什么做'], ['user', '谁在用'], ['pain', '痛点'], ['success', '成功的样子']];
  for (const [key, label] of scalar) {
    const value = String(brief[key] == null ? '' : brief[key]).trim();
    if (value) lines.push(`${label}：${value}`);
  }
  const list = [['constraints', '约束'], ['nonGoals', '明确不做']];
  for (const [key, label] of list) {
    const items = Array.isArray(brief[key]) ? brief[key].map((v) => String(v).trim()).filter(Boolean) : [];
    if (items.length) lines.push(`${label}：${items.join('；')}`);
  }
  return lines.join('\n').slice(0, 2000);
}

// 项目现状：由调用方（需求理解/代码检索）整理好的只读事实，单独成段注入发言请求。
// 与 brief 分开——brief 是"为什么做"，context 是"现在有什么"。
function renderContext(context) {
  if (!context) return '';
  return String(context).trim().slice(0, 6000);
}

function buildExpertPrompt(expert, brief = '') {
  const lines = [];
  const premise = renderBrief(brief);
  if (premise) {
    lines.push(`本场共同前提（需求方给定，不可更改；与你的个人观点冲突时以这里为准）：\n${premise}`);
  }
  lines.push(`你是「${expert.name}」${expert.aliases && expert.aliases.length ? `（${expert.aliases.join(' / ')}）` : ''}。`);
  if (expert.title) lines.push(`身份：${expert.title}。`);
  if (expert.affiliations && expert.affiliations.length) {
    lines.push(`机构：${expert.affiliations.map((a) => `${a.name}${a.role ? `（${a.role}）` : ''}`).join('、')}。`);
  }
  const style = expert.style || {};
  if (style.tone || style.sentence || style.habits) {
    lines.push(`说话方式：${[style.tone, style.sentence, style.habits].filter(Boolean).join('；')}。`);
  }
  if (style.catchphrases && style.catchphrases.length) {
    lines.push(`你会用的说法：${style.catchphrases.join('、')}。`);
  }
  if (expert.stances && expert.stances.length) {
    lines.push('你的观点：');
    for (const stance of expert.stances) {
      lines.push(`- ${stance.topic}：${stance.position}${stance.evidence ? `（原话：「${stance.evidence}」）` : ''}`);
    }
  }
  if (expert.heuristics && expert.heuristics.length) {
    lines.push(`你判断问题的习惯：${expert.heuristics.join('；')}。`);
  }
  if (expert.taboos && expert.taboos.length) {
    lines.push(`你反感的东西：${expert.taboos.join('；')}。`);
  }
  if (expert.unknowns && expert.unknowns.length) {
    lines.push(`你资料里没有依据的部分（被问到要承认不知道）：${expert.unknowns.join('；')}。`);
  }
  lines.push(RULES);
  return lines.join('\n');
}

function formatHistory(transcript) {
  const rows = transcript.map((turn) => `${turn.name}：${turn.text}`);
  let text = rows.join('\n');
  if (text.length > HISTORY_CHARS) text = text.slice(text.length - HISTORY_CHARS);
  return text;
}

class Roundtable {
  constructor({ unifiedAPI = null, dir = ROUNDTABLE_DIR } = {}) {
    this.unifiedAPI = unifiedAPI || new UnifiedAPI();
    this.dir = dir;
  }

  async call(messages, temperature = 0.75, maxTokens = 600) {
    const result = await this.unifiedAPI.callAPI(messages, null, {
      temperature,
      callSite: 'roundtable',
      maxTokens,
      // 思考模式会把 600 token 全烧在思维链上，正文空手而归；圆桌要的是短发言，关掉
      thinking: 'disabled'
    });
    const content = result && result.choices && result.choices[0] && result.choices[0].message
      ? result.choices[0].message.content
      : '';
    return String(content || '').trim();
  }

  /**
   * @param {object} params
   * @param {string} params.topic
   * @param {Array<object>} params.experts  已蒸馏的人格档案
   * @param {number} [params.rounds]
   * @param {(turn: object) => void} [params.onTurn] 每说完一条就回调，路由用它做流式输出
   */
  async run({ topic, experts, rounds = 2, brief = '', context = '', onTurn = null } = {}) {
    const cleanTopic = String(topic || '').trim();
    if (!cleanTopic) throw new Error('缺少讨论话题');
    const cleanBrief = renderBrief(brief);
    const cleanContext = renderContext(context);
    const members = (Array.isArray(experts) ? experts : []).filter((item) => item && item.name);
    if (members.length < MIN_EXPERTS) throw new Error(`至少要选 ${MIN_EXPERTS} 位大神才能开圆桌`);
    if (members.length > MAX_EXPERTS) throw new Error(`一场最多 ${MAX_EXPERTS} 位`);
    const roundCount = Math.max(1, Math.min(MAX_ROUNDS, Number(rounds) || 2));

    const id = nowId();
    const transcript = [];

    for (let round = 1; round <= roundCount; round++) {
      for (const expert of members) {
        const history = formatHistory(transcript.slice(-12));
        const userContent = [
          `【议题】${cleanTopic}`,
          cleanContext ? `【项目现状（只读事实；只能依据这里出现的内容下判断，不要编造文件里没有的东西）】\n${cleanContext}` : '',
          `【这是第 ${round} 轮】`,
          history ? `【前面说过的话】\n${history}` : '',
          round === 1
            ? '请直接亮出你的判断，别客套。'
            : '接着前面的话往下说：可以反驳、可以补证据、可以修正自己上一轮的说法。'
        ].filter(Boolean).join('\n\n');

        let text;
        try {
          text = await this.call([
            { role: 'system', content: buildExpertPrompt(expert, cleanBrief) },
            { role: 'user', content: userContent }
          ]);
        } catch (error) {
          text = `（发言失败：${error.message}）`;
        }
        const turn = {
          round,
          expertId: expert.id || expert.name,
          name: expert.name,
          text: text.slice(0, TURN_MAX_CHARS * 4)
        };
        transcript.push(turn);
        if (typeof onTurn === 'function') onTurn(turn);
      }
    }

    const synthesis = await this.summarize(cleanTopic, transcript, members, cleanBrief, cleanContext);
    const payload = {
      id,
      topic: cleanTopic,
      brief: cleanBrief,
      context: cleanContext,
      rounds: roundCount,
      experts: members.map((item) => ({ id: item.id, name: item.name, title: item.title || '' })),
      transcript,
      synthesis,
      createdAt: new Date().toISOString()
    };
    this.save(payload);
    return payload;
  }

  // 主持人归纳：只做三件事——分歧、各自最强的论据、值得追问的点。做不成结构就给纯文本
  async summarize(topic, transcript, members, brief = '', context = '') {
    const material = transcript.map((turn) => `${turn.name}：${turn.text}`).join('\n');
    const names = members.map((item) => item.name).join('、');
    const premise = renderBrief(brief);
    const facts = renderContext(context);
    let raw;
    try {
      raw = await this.call([
        {
          role: 'system',
          content: '你是圆桌主持人。只依据记录归纳，不添观点、不替嘉宾补话。'
            + '输出 JSON：{"disagreements":[{"topic":"分歧点","positions":[{"name":"谁","stance":"立场"}]}],'
            + '"strongest":["各方最硬的一条论据，标明是谁说的"],"followups":["值得继续追问的问题"]}。'
            + '只输出 JSON，不要解释。'
        },
        { role: 'user', content: `${premise ? `共同前提：\n${premise}\n\n` : ''}${facts ? `项目现状：\n${facts}\n\n` : ''}议题：${topic}\n参与：${names}\n\n发言记录：\n${material}` }
      ], 0.3, 1400);
    } catch {
      raw = '';
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        return {
          disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements : [],
          strongest: Array.isArray(parsed.strongest) ? parsed.strongest : [],
          followups: Array.isArray(parsed.followups) ? parsed.followups : [],
          raw
        };
      } catch {
        // 落到纯文本兜底
      }
    }
    return { disagreements: [], strongest: [], followups: [], raw: raw || '归纳失败' };
  }

  save(payload) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${payload.id}.json`), JSON.stringify(payload, null, 2), 'utf8');
  }

  list(limit = 20) {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(this.dir, name);
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          return { stat: fs.statSync(file), data };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(({ data }) => ({
        id: data.id,
        topic: data.topic,
        experts: (data.experts || []).map((item) => item.name),
        createdAt: data.createdAt
      }));
  }

  load(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe) return null;
    const file = path.join(this.dir, `${safe}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
}

module.exports = { Roundtable, buildExpertPrompt, renderContext };
