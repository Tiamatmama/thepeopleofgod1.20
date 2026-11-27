// 大神蒸馏：给一个名字 + 领域，联网找他的公开语料（访谈/演讲/博客），
// 先让模型抽一份人格，再做一层「二次筛查」——每条原话必须能在抓到的正文里逐字找到，
// 机构/职务这类事实断言交给模型对着语料复核，复核不过就降级或删掉。
// 目的很明确：宁可人格薄一点，也不要蒸出一个满嘴编造履历的假大神。
const fs = require('fs');
const path = require('path');
const { UnifiedAPI } = require('./api');

const EXPERTS_DIR = path.join(__dirname, '../../data/personas/experts');
const ROUNDTABLE_DIR = path.join(__dirname, '../../data/roundtables');

// 抓取预算：搜 3 轮关键词、每轮 4 条结果、最多打开 5 篇、每篇 6000 字、总语料 18000 字
const SEARCH_QUERIES = 3;
const SEARCH_PER_QUERY = 4;
const MAX_PAGES = 5;
const PAGE_CHARS = 6000;
const CORPUS_MAX_CHARS = 18000;

const DISTILL_SYSTEM = `你在做「公开人物人格蒸馏」。读者要拿这份人格去和真人圆桌讨论，所以准确性比丰满度重要。

铁律：
1. 先判断语料是不是在讲目标人物本人。如果是同名不同人（比如「余弦」讲的是三角函数、人名讲的是字义），relevant 填 false，其余字段留空即可。
2. 只能依据给定语料。语料里没有的履历、奖项、作品、任职，一律不写。
3. 每一条观点都要带一条 evidence：从语料里逐字摘出的原话（20~60 字，不改写、不拼接）。
4. 拿不准的写进 unknowns，不要猜。
5. 说话风格（语气、句长、爱用的词、爱举什么例子）要从语料里归纳，不要套模板。

只输出一个 JSON 对象，不要解释、不要代码块：
{
  "relevant": true,
  "name": "中文名",
  "aliases": ["英文名/网名/常用 ID"],
  "field": "领域",
  "title": "一句话身份（只写语料支持的）",
  "affiliations": [{"name": "机构", "role": "职务", "evidence": "语料原话"}],
  "style": {"tone": "语气", "sentence": "句子长短/结构特点", "catchphrases": ["口头禅/高频词"], "habits": "爱举什么例子、爱怎么反驳"},
  "stances": [{"topic": "议题", "position": "立场（一句话）", "evidence": "逐字原话", "sourceIndex": 1}],
  "heuristics": ["他判断问题的固定套路，每条一句"],
  "taboos": ["他明确反感/反对的东西"],
  "unknowns": ["语料不足以判断的点"]
}`;

const SCREEN_SYSTEM = `你在做人格蒸馏的「二次筛查」。给一份人格 JSON 和原始语料，逐条核对：
- facts：机构、职务、奖项、代表作品这类事实断言，语料里有没有直接依据？
- quotes：引用的原话，是否逐字出现在语料里？
只按语料判断，不要用你的世界知识补全。语料没提就算不支持。
只输出 JSON：
{"facts":[{"claim":"...","supported":true,"why":"依据或缺失原因"}],
 "quotes":[{"quote":"...","supported":true}]}`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function slugify(name) {
  const raw = String(name || '').trim().toLowerCase();
  const ascii = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 40);
  // 全中文名：用码点转写，保证同一名字稳定映射到同一个文件名
  let hash = 0;
  for (const ch of raw) hash = (hash * 31 + ch.codePointAt(0)) % 0xffffffff;
  return `expert-${hash.toString(36)}`;
}

// 比较用的归一化：去掉空白与标点，只留字符本身，避免「逐字引用」被排版差异误杀
function normalize(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function extractJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

class ExpertLibrary {
  constructor({ dir = EXPERTS_DIR } = {}) {
    this.dir = dir;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        name: item.name,
        field: item.field,
        title: item.title || '',
        stanceCount: Array.isArray(item.stances) ? item.stances.length : 0,
        sourceCount: Array.isArray(item.sources) ? item.sources.length : 0,
        droppedCount: (item.screen && item.screen.dropped) || 0,
        updatedAt: item.updatedAt || item.createdAt || ''
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  load(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return null;
    const file = path.join(this.dir, `${safe}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(profile) {
    ensureDir(this.dir);
    const file = path.join(this.dir, `${profile.id}.json`);
    fs.writeFileSync(file, JSON.stringify(profile, null, 2), 'utf8');
    return profile;
  }
}

class PersonaDistiller {
  /**
   * @param {object} options
   * @param {(query: string, count: number) => Promise<object>} options.search    toolRegistry.webSearch
   * @param {(url: string, maxChars: number) => Promise<object>} options.fetchPage toolRegistry.fetchUrl
   * @param {UnifiedAPI} [options.unifiedAPI]
   * @param {ExpertLibrary} [options.library]
   */
  constructor({ search, fetchPage, unifiedAPI = null, library = null } = {}) {
    if (typeof search !== 'function' || typeof fetchPage !== 'function') {
      throw new Error('PersonaDistiller 需要 search / fetchPage 两个函数');
    }
    this.search = search;
    this.fetchPage = fetchPage;
    this.unifiedAPI = unifiedAPI || new UnifiedAPI();
    this.library = library || new ExpertLibrary();
  }

  // 检索 + 抓正文。返回 {docs, skipped}：docs 是真正能用的素材，
  // skipped 记下被丢弃的 URL（太短，或通篇没提到本人）
  async collect({ name, field, hint, urls = [] }) {
    // 用别名当锚点：中文名单独搜很容易撞上字典页、数学名词页，
    // hint 里给的英文名/网名往往才是真正的检索钥匙
    const aliases = String(hint || '')
      .split(/[\s,，、;；/]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 4);
    const anchors = [name, ...aliases].map(normalize).filter(Boolean);

    const queries = [
      aliases.length ? `${name} ${aliases[0]} ${field}` : `${name} ${field} 访谈`,
      `${name} ${field} 观点 演讲`,
      `${name} 博客 文章 技术`
    ].slice(0, SEARCH_QUERIES);

    const seen = new Set();
    const candidates = [];
    // 手动给了链接就直接抓，完全不碰搜索：搜索源不稳时这是唯一可靠的入口
    if (urls.length > 0) {
      urls.slice(0, MAX_PAGES).forEach((url) => {
        const clean = String(url || '').trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        candidates.push({ url: clean, title: '' });
      });
    } else {
      for (const query of queries) {
        let result;
        try {
          result = await this.search(query, SEARCH_PER_QUERY);
        } catch {
          continue;
        }
        const list = (result && Array.isArray(result.results)) ? result.results : [];
        for (const item of list) {
          const url = String((item && item.url) || '').trim();
          if (!url || seen.has(url)) continue;
          seen.add(url);
          candidates.push({ url, title: String((item && item.title) || '') });
          if (candidates.length >= MAX_PAGES * 2) break;
        }
      }
    }

    const docs = [];
    const skipped = [];
    for (const candidate of candidates) {
      if (docs.length >= MAX_PAGES) break;
      let page;
      try {
        page = await this.fetchPage(candidate.url, PAGE_CHARS);
      } catch {
        skipped.push(candidate.url);
        continue;
      }
      const text = String((page && page.content) || '').trim();
      // 太短的页面多半是登录墙/JS 壳，塞进语料只会稀释信号
      if (!page || !page.success || text.length < 400) {
        skipped.push(candidate.url);
        continue;
      }
      // 相关性闸门：通篇没提过本人（或别名）的页面，基本是撞名的字典/百科/数学词条，
      // 拿它去蒸只会蒸出个假人
      const plain = normalize(text);
      if (!anchors.some((anchor) => plain.includes(anchor))) {
        skipped.push(candidate.url);
        continue;
      }
      docs.push({ url: candidate.url, title: candidate.title, text: text.slice(0, PAGE_CHARS) });
    }
    return { docs, skipped };
  }

  buildCorpus(docs) {
    let used = 0;
    const blocks = [];
    docs.forEach((doc, index) => {
      if (used >= CORPUS_MAX_CHARS) return;
      const room = CORPUS_MAX_CHARS - used;
      const body = doc.text.slice(0, room);
      used += body.length;
      blocks.push(`【语料 ${index + 1}】${doc.title || ''} ${doc.url}\n${body}`);
    });
    return blocks.join('\n\n');
  }

  async distill({ name, field = '网络安全', hint = '', urls = [] } = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('缺少要蒸馏的名字');
    const links = (Array.isArray(urls) ? urls : [])
      .map((item) => String(item || '').trim())
      .filter((item) => /^https?:\/\//i.test(item))
      .slice(0, MAX_PAGES);

    const { docs } = await this.collect({ name: cleanName, field, hint, urls: links });
    if (docs.length === 0) {
      const reason = links.length
        ? `给的 ${links.length} 条链接都不可用（打不开、正文太短，或整篇没出现名字/别名）`
        : '搜到的页面要么打不开，要么通篇没提到这个人';
      throw new Error(`没抓到 ${cleanName} 的可用正文：${reason}。`
        + '中文名容易撞上同名词条，把网名/英文名填进「补充线索」再试');
    }
    const corpus = this.buildCorpus(docs);

    const extracted = await this.callJson([
      { role: 'system', content: DISTILL_SYSTEM },
      { role: 'user', content: `目标人物：${cleanName}\n领域：${field}\n${hint ? `补充线索：${hint}\n` : ''}\n${corpus}` }
    ], 0.35);
    if (!extracted || !String(extracted.name || '').trim()) {
      throw new Error('模型没有产出可用的人格结构，再试一次');
    }

    const profile = this.normalizeProfile(extracted, { name: cleanName, field, docs });
    // 同名不同人：模型看完语料说「这不是他」，那就当场停手
    if (profile.relevant === false) {
      throw new Error(`语料和 ${cleanName} 对不上（多半是同名不同人），这次不落盘。补一个英文名/网名再试`);
    }
    // 抓到了页面但榨不出观点，说明语料不是这个人——宁可报错，也不要往库里塞一个空壳
    if (profile.stances.length === 0 && profile.heuristics.length === 0) {
      throw new Error(`读到 ${docs.length} 篇正文，但里面没有 ${cleanName} 的实质观点，不落盘。换个名字或补个别名再试`);
    }
    const screened = await this.screen(profile, corpus);
    screened.sources = docs.map((doc) => ({ url: doc.url, title: doc.title, chars: doc.text.length }));
    screened.updatedAt = new Date().toISOString();
    return this.library.save(screened);
  }

  normalizeProfile(raw, { name, field, docs }) {
    const list = (value) => (Array.isArray(value) ? value : []);
    const text = (value, max = 400) => String(value == null ? '' : value).trim().slice(0, max);
    const stances = list(raw.stances)
      .map((item) => ({
        topic: text(item && item.topic, 60),
        position: text(item && item.position, 200),
        evidence: text(item && item.evidence, 300),
        sourceIndex: Number(item && item.sourceIndex) || 0
      }))
      .filter((item) => item.topic && item.position);
    const affiliations = list(raw.affiliations)
      .map((item) => ({
        name: text(item && item.name, 60),
        role: text(item && item.role, 40),
        evidence: text(item && item.evidence, 300)
      }))
      .filter((item) => item.name);

    return {
      id: slugify(name),
      relevant: raw.relevant !== false,
      name: text(raw.name, 40) || name,
      aliases: list(raw.aliases).map((item) => text(item, 40)).filter(Boolean).slice(0, 6),
      field: text(raw.field, 30) || field,
      title: text(raw.title, 120),
      affiliations,
      style: {
        tone: text(raw.style && raw.style.tone, 120),
        sentence: text(raw.style && raw.style.sentence, 120),
        catchphrases: list(raw.style && raw.style.catchphrases).map((item) => text(item, 30)).filter(Boolean).slice(0, 8),
        habits: text(raw.style && raw.style.habits, 200)
      },
      stances: stances.slice(0, 10),
      heuristics: list(raw.heuristics).map((item) => text(item, 160)).filter(Boolean).slice(0, 8),
      taboos: list(raw.taboos).map((item) => text(item, 120)).filter(Boolean).slice(0, 6),
      unknowns: list(raw.unknowns).map((item) => text(item, 120)).filter(Boolean).slice(0, 6),
      sources: docs.map((doc) => ({ url: doc.url, title: doc.title, chars: doc.text.length })),
      screen: { kept: 0, dropped: 0, notes: [] },
      version: 1,
      createdAt: new Date().toISOString()
    };
  }

  // 二次筛查第 1 层：字面核验。引文在语料里找不到，直接当幻觉删掉
  verbatimScreen(profile, corpus) {
    const haystack = normalize(corpus);
    const notes = [];
    const keptStances = [];
    let dropped = 0;

    for (const stance of profile.stances) {
      const quote = normalize(stance.evidence);
      if (quote && quote.length >= 6 && haystack.includes(quote)) {
        stance.screened = 'verbatim';
        keptStances.push(stance);
        continue;
      }
      // 引文过长时允许退一步：摘前 20 字命中即视为有依据（模型常把两句自己接起来）
      const head = quote.slice(0, 20);
      if (head.length >= 10 && haystack.includes(head)) {
        stance.screened = 'verbatim-partial';
        keptStances.push(stance);
        continue;
      }
      dropped += 1;
      // 备注里带上被判定的原话，出问题时能直接看出删的是哪一句
      notes.push(`删除无原文支撑的观点：${stance.topic}｜原话「${stance.evidence.slice(0, 24)}」`);
    }

    profile.stances = keptStances;
    profile.style.catchphrases = profile.style.catchphrases.filter((phrase) => {
      const key = normalize(phrase);
      if (!key) return false;
      if (haystack.includes(key)) return true;
      dropped += 1;
      return false;
    });
    return { dropped, notes };
  }

  // 二次筛查第 2 层：事实断言复核。模型只许按语料判断，没依据的机构/职务整条撤掉
  async modelScreen(profile, corpus) {
    const facts = profile.affiliations.map((item) => `${item.name}${item.role ? `·${item.role}` : ''}`);
    const claims = [
      profile.title ? `身份：${profile.title}` : '',
      ...facts
    ].filter(Boolean);
    if (claims.length === 0 && profile.stances.length === 0) return { dropped: 0, notes: [] };

    let result;
    try {
      result = await this.callJson([
        { role: 'system', content: SCREEN_SYSTEM },
        {
          role: 'user',
          content: `待核事实：\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n') || '（无）'}\n\n`
            + `待核原话：\n${profile.stances.map((s, i) => `${i + 1}. ${s.evidence}`).join('\n') || '（无）'}\n\n`
            + `原始语料：\n${corpus}`
        }
      ], 0.1);
    } catch {
      result = null;
    }
    if (!result) return { dropped: 0, notes: ['事实复核调用失败，本轮只保留字面核验结果'] };

    const unsupported = new Set(
      (Array.isArray(result.facts) ? result.facts : [])
        .filter((item) => item && item.supported === false)
        .map((item) => String(item.claim || '').trim())
    );
    const notes = [];
    let dropped = 0;

    if (unsupported.size > 0) {
      const beforeTitle = profile.title;
      if (beforeTitle && unsupported.has(`身份：${beforeTitle}`)) {
        profile.title = '';
        dropped += 1;
        notes.push(`撤掉无依据的身份描述：${beforeTitle}`);
      }
      const keptAffiliations = profile.affiliations.filter((item) => {
        const label = `${item.name}${item.role ? `·${item.role}` : ''}`;
        if (!unsupported.has(label)) return true;
        dropped += 1;
        notes.push(`撤掉无依据的机构/职务：${label}`);
        return false;
      });
      profile.affiliations = keptAffiliations;
    }

    const badQuotes = new Set(
      (Array.isArray(result.quotes) ? result.quotes : [])
        .filter((item) => item && item.supported === false)
        .map((item) => normalize(item.quote))
    );
    if (badQuotes.size > 0) {
      const before = profile.stances.length;
      profile.stances = profile.stances.filter((stance) => !badQuotes.has(normalize(stance.evidence)));
      dropped += before - profile.stances.length;
      if (before !== profile.stances.length) notes.push('删掉复核不通过的原话引用');
    }
    return { dropped, notes };
  }

  async screen(profile, corpus) {
    const verbatim = this.verbatimScreen(profile, corpus);
    const modeled = await this.modelScreen(profile, corpus);
    const dropped = verbatim.dropped + modeled.dropped;
    profile.screen = {
      kept: profile.stances.length,
      dropped,
      notes: [...verbatim.notes, ...modeled.notes].slice(0, 20)
    };
    return profile;
  }

  async callJson(messages, temperature) {
    const result = await this.unifiedAPI.callAPI(messages, null, {
      temperature,
      callSite: 'personaDistill',
      // 十来个观点 + 原话引用的中文 JSON 动辄四五千字，给少了会被截断成非法 JSON
      maxTokens: 4096,
      // 纯结构化抽取，不需要长篇推理；开着思考模式会把 token 全烧在思维链上，
      // 正文直接空手而归（finish_reason=length 但 content 为空）
      thinking: 'disabled'
    });
    const choice = result && result.choices && result.choices[0];
    const content = choice && choice.message ? choice.message.content : '';
    const parsed = extractJson(content);
    if (!parsed) {
      console.warn(`[PersonaDistill] 模型输出不是合法 JSON（${String(content || '').length} 字符，`
        + `finish_reason=${(choice && choice.finish_reason) || '—'}，结尾：${String(content || '').slice(-80).replace(/\s+/g, ' ')}）`);
    }
    return parsed;
  }
}

module.exports = {
  PersonaDistiller,
  ExpertLibrary,
  EXPERTS_DIR,
  ROUNDTABLE_DIR,
  slugify,
  normalize,
  extractJson
};
