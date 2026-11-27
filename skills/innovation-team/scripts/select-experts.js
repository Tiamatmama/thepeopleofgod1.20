#!/usr/bin/env node
// 创新团队·选人：按点子关键词给已蒸馏专家打分，取前 N 个。
// 纯本地只读脚本：不联网、不调用模型、不写文件。
// 用法：
//   node skills/innovation-team/scripts/select-experts.js "做一个本地优先的 QQ 协议层" --top 5
//   node skills/innovation-team/scripts/select-experts.js "点子" --json
//   node skills/innovation-team/scripts/select-experts.js "点子" --dir <专家目录>
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DIR = path.join(REPO_ROOT, 'data', 'personas', 'experts');
const CREATIVES_FILE = path.resolve(__dirname, '..', 'references', 'creative-personas.json');

// 字段权重：名字最高，领域/观点次之，习惯/风格最低。
const WEIGHTS = { name: 4, field: 3, title: 2, stances: 2, heuristics: 1.5, style: 1 };

// 领域映射：点子里出现这些词，就把对应领域的专家加权。
// 只做粗粒度路由，不做语义理解；命中即加分，不命中不扣分。
const DOMAINS = [
  { keys: ['协议', '逆向', '抓包', '客户端', 'hook', '封包', '加密', '安全', '漏洞', '审计', '风控', '反作弊', 'qq', '微信', 'wechat'], fields: ['安全', '审计', '逆向', '协议'] },
  { keys: ['模型', '大模型', 'llm', 'ai', '智能', '算法', '训练', '推理', '提示词', 'agent', '智能体'], fields: ['人工智能', '深度学习', '大语言模型', 'ai'] },
  { keys: ['前端', '界面', 'ui', '交互', '体验', '设计', '视觉', '页面'], fields: ['前端', '设计', '产品', '体验'] },
  { keys: ['产品', '需求', '商业', '增长', '运营', '用户'], fields: ['产品', '商业', '运营'] },
  { keys: ['数据', '分析', '统计', '指标', '实验'], fields: ['数据', '分析'] }
];
const DOMAIN_BONUS = 3;
const WEAK_SCORE = 3;

const STOP = new Set(['的', '了', '是', '在', '和', '与', '或', '把', '被', '我', '你', '他', '她', '它', '们', '这', '那', '一个', '一下', '怎么', '什么', '如何', '需要', '可以', '今天', '明天', '昨天', '现在', '目前', '这个', '那个', '我们', '你们', '他们', '大家', '东西']);

function parseArgs(argv) {
  const out = { topic: '', top: 5, creative: 0, json: false, dir: DEFAULT_DIR };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--creative') out.creative = Number(argv[++i]);
    else if (a === '--dir') out.dir = path.resolve(argv[++i] || '');
    else if (!a.startsWith('--')) words.push(a);
  }
  out.topic = words.join(' ').trim();
  if (!Number.isInteger(out.top) || out.top < 1) out.top = 5;
  out.top = Math.min(out.top, 10);
  if (!Number.isInteger(out.creative) || out.creative < 0) out.creative = 0;
  out.creative = Math.min(out.creative, 8);
  return out;
}

// 抽词：英文按词，中文取 2 字滑窗，过滤停用词与纯数字。
function extractTerms(topic) {
  const terms = new Set();
  const text = String(topic || '').toLowerCase();
  for (const m of text.matchAll(/[a-z][a-z0-9+#.-]{1,}/g)) {
    if (m[0].length >= 2) terms.add(m[0]);
  }
  const cjkRuns = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 4 && !STOP.has(run)) terms.add(run);
    for (let i = 0; i + 2 <= run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOP.has(bigram)) terms.add(bigram);
    }
  }
  return Array.from(terms).slice(0, 80);
}

function countHits(term, text) {
  if (!text || !term) return 0;
  let n = 0;
  let from = 0;
  while (n < 3) {
    const at = text.indexOf(term, from);
    if (at < 0) break;
    n++;
    from = at + term.length;
  }
  return n;
}

function fieldText(profile, key) {
  const value = profile[key];
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item == null) return '';
      if (typeof item === 'string') return item;
      if (typeof item === 'object') return Object.values(item).filter((v) => typeof v === 'string').join(' ');
      return String(item);
    }).join(' ');
  }
  if (typeof value === 'object') return Object.values(value).filter((v) => typeof v === 'string').join(' ');
  return String(value);
}

function scoreProfile(profile, terms) {
  const buckets = {};
  for (const key of Object.keys(WEIGHTS)) buckets[key] = fieldText(profile, key).toLowerCase();
  let score = 0;
  const matched = [];
  for (const term of terms) {
    let best = 0;
    let bestKey = '';
    for (const [key, weight] of Object.entries(WEIGHTS)) {
      const hits = countHits(term, buckets[key]);
      if (!hits) continue;
      const value = hits * weight;
      if (value > best) { best = value; bestKey = key; }
    }
    if (best > 0) {
      score += best;
      matched.push({ term, key: bestKey, value: best });
    }
  }
  matched.sort((a, b) => b.value - a.value);
  return {
    score: Math.round(score * 10) / 10,
    reason: matched.slice(0, 3).map((m) => `${m.term}(${m.key})`).join('、')
  };
}

// 按点子里出现的领域词，给专家补领域分；返回命中的领域名。
function matchDomains(topic, profile) {
  const text = [fieldText(profile, 'field'), fieldText(profile, 'title'), fieldText(profile, 'stances')]
    .join(' ').toLowerCase();
  const idea = String(topic || '').toLowerCase();
  const hits = [];
  for (const domain of DOMAINS) {
    if (!domain.keys.some((key) => idea.includes(key))) continue;
    const hit = domain.fields.find((field) => text.includes(field));
    if (hit) hits.push(hit);
  }
  return hits;
}

function listExperts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function hashText(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// 创意角色：不是真人，是思考镜头。按 bestFor 命中优先，其余按点子哈希轮转，保证每次组合有变化。
function pickCreatives(topic, count) {
  if (!count) return [];
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(CREATIVES_FILE, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(list) || !list.length) return [];
  const idea = String(topic || '').toLowerCase();
  const scored = list.map((persona, order) => {
    const bestFor = Array.isArray(persona.bestFor) ? persona.bestFor : [];
    const hits = bestFor.filter((key) => idea.includes(String(key).toLowerCase()));
    return {
      ...persona,
      kind: 'creative',
      score: hits.length * 2,
      reason: hits.length ? `命中:${hits.join('/')}` : '',
      order
    };
  });
  const strong = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const seed = hashText(topic) % list.length;
  const rest = scored
    .filter((item) => item.score === 0)
    .sort((a, b) => ((a.order + seed) % list.length) - ((b.order + seed) % list.length));
  return [...strong, ...rest].slice(0, count);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.topic) {
    console.error('用法: node select-experts.js "<点子原文>" [--top 5] [--json] [--dir <专家目录>]');
    process.exit(2);
  }
  const experts = listExperts(args.dir);
  if (!experts.length) {
    console.error(`没找到专家档案：${args.dir}`);
    process.exit(1);
  }
  const terms = extractTerms(args.topic);
  const scored = experts.map((profile) => {
    const s = scoreProfile(profile, terms);
    const domains = matchDomains(args.topic, profile);
    const reason = [s.reason, domains.length ? `领域:${domains.join('/')}` : ''].filter(Boolean).join('、');
    return {
      id: profile.id || '',
      name: profile.name || '(未命名)',
      field: profile.field || '',
      title: profile.title || '',
      score: Math.round((s.score + domains.length * DOMAIN_BONUS) * 10) / 10,
      reason,
      updatedAt: profile.updatedAt || profile.createdAt || ''
    };
  });

  // 没有任何人达到弱相关线时，按最近更新取默认班子，并标明原因。
  const fallback = !scored.some((item) => item.score >= WEAK_SCORE);
  scored.sort((a, b) => (b.score - a.score) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const picked = scored.slice(0, args.top).map((item) => {
    if (fallback) return { ...item, reason: '无有效命中，按最近更新默认入选' };
    if (item.score === 0) return { ...item, reason: '无命中（补位）' };
    return item;
  });

  const creatives = pickCreatives(args.topic, args.creative);

  if (args.json) {
    const cleanCreatives = creatives.map(({ order, ...rest }) => rest);
    process.stdout.write(JSON.stringify({
      topic: args.topic, terms: terms.length, fallback, experts: picked, creatives: cleanCreatives
    }, null, 2) + '\n');
    return;
  }
  console.log(`点子：${args.topic}`);
  console.log(`候选 ${experts.length} 人，取前 ${picked.length}${fallback ? '（无命中，默认班子）' : ''}`);
  picked.forEach((item, i) => {
    console.log(`${i + 1}. ${item.name}｜${item.field || item.title || '-'}｜score=${item.score}｜${item.reason}`);
  });
  if (creatives.length) {
    console.log(`— 创意角色 ${creatives.length} 人 —`);
    creatives.forEach((persona, i) => {
      const lens = String(persona.lens || '').slice(0, 46);
      console.log(`${i + 1}. ${persona.name}｜${persona.reason || '轮转入选'}｜镜头：${lens}…`);
    });
  }
}

main();
