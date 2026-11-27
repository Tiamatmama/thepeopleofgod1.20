const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 研究平台（她的自留地）😀
// 任务板、研究方向笔记、论文/新闻检索、脚本工作台，数据全落在 data/research/ 下。
// 这个目录里的东西她可以免授权直接读写（工具层控制），这里只管存取和外部检索。

const RESEARCH_DIR = path.join('data', 'research');
const WORKSPACE_DIR = path.join(RESEARCH_DIR, 'workspace');

// 新闻源：全是有 RSS 的免费源，不用任何 key 📡
const NEWS_FEEDS = [
  { key: 'solidot', name: 'Solidot', url: 'https://www.solidot.org/index.rss' },
  { key: '36kr', name: '36氪', url: 'https://36kr.com/feed' },
  { key: 'hnrss', name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { key: 'nature', name: 'Nature', url: 'https://www.nature.com/nature.rss' }
];

// 任务状态白名单，别让脏字符串混进面板
const TASK_STATUS = new Set(['todo', 'doing', 'done']);

// arXiv API 礼貌间隔（官方条款建议 ≥3 秒）：实测连发是吃 406 的直接原因，所有论文搜索串行节流
const PAPER_REQ_GAP_MS = 3500;

// 中文/多词友好的关键词打分（0~1）：优先整串命中；否则按空格等拆成 token，
// 对每个 token 取 2-gram 命中比例，任一 token 命中即可。避免「AI 芯片」被当成一整串去匹配标题而搜不到。
function keywordScore(text, keyword) {
  const hay = String(text || '').toLowerCase();
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return 1;
  if (hay.includes(kw)) return 1;
  const tokens = kw.split(/[\s,，、/|]+/).filter(Boolean);
  let best = 0;
  for (const token of tokens) {
    if (token.length < 2) {
      if (hay.includes(token)) best = Math.max(best, 0.5);
      continue;
    }
    const grams = new Set();
    for (let i = 0; i < token.length - 1; i++) grams.add(token.slice(i, i + 2));
    let hit = 0;
    for (const gram of grams) if (hay.includes(gram)) hit++;
    best = Math.max(best, hit / grams.size);
  }
  return best;
}

class ResearchCenter {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.dir = path.join(projectRoot, RESEARCH_DIR);
    this.workspace = path.join(projectRoot, WORKSPACE_DIR);
    this.tasksFile = path.join(this.dir, 'tasks.json');
    this.noteFile = path.join(this.dir, 'notes.md');
    this.runsFile = path.join(this.dir, 'runs.log');
    this._lastPaperReqAt = 0;
    fs.mkdirSync(this.workspace, { recursive: true });
    if (!fs.existsSync(this.tasksFile)) {
      fs.writeFileSync(this.tasksFile, JSON.stringify({ seq: 0, tasks: [] }, null, 2), 'utf8');
    }
    if (!fs.existsSync(this.noteFile)) {
      fs.writeFileSync(this.noteFile, '# 研究方向笔记\n\n（在这里随手写方向、想法、待验证的东西）\n', 'utf8');
    }
  }

  // ---- 任务板 ----

  loadTasks() {
    try {
      const data = JSON.parse(fs.readFileSync(this.tasksFile, 'utf8'));
      return { seq: Number(data.seq) || 0, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
    } catch (error) {
      return { seq: 0, tasks: [] };
    }
  }

  saveTasks(store) {
    fs.writeFileSync(this.tasksFile, JSON.stringify(store, null, 2), 'utf8');
  }

  listTasks(status) {
    const tasks = this.loadTasks().tasks;
    if (status && TASK_STATUS.has(String(status))) {
      return tasks.filter(t => t.status === status);
    }
    return tasks;
  }

  addTask(input = {}) {
    const title = String(input.title || '').trim();
    if (!title) {
      return { success: false, error: '任务得有个标题（title）' };
    }
    const store = this.loadTasks();
    store.seq += 1;
    const now = new Date().toISOString();
    const task = {
      id: `t_${store.seq}`,
      title,
      desc: String(input.desc || '').trim(),
      params: (input.params && typeof input.params === 'object') ? input.params : {},
      status: 'todo',
      result: '',
      createdAt: now,
      updatedAt: now
    };
    store.tasks.unshift(task);
    this.saveTasks(store);
    return { success: true, task };
  }

  updateTask(id, patch = {}) {
    if (!id) return { success: false, error: '缺少任务 id' };
    const store = this.loadTasks();
    const task = store.tasks.find(t => t.id === id);
    if (!task) return { success: false, error: `找不到任务: ${id}` };

    if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim();
    if (typeof patch.desc === 'string') task.desc = patch.desc.trim();
    if (patch.params && typeof patch.params === 'object') task.params = patch.params;
    if (typeof patch.status === 'string' && TASK_STATUS.has(patch.status)) task.status = patch.status;
    if (typeof patch.result === 'string') task.result = patch.result;
    task.updatedAt = new Date().toISOString();
    this.saveTasks(store);
    return { success: true, task };
  }

  deleteTask(id) {
    const store = this.loadTasks();
    const before = store.tasks.length;
    store.tasks = store.tasks.filter(t => t.id !== id);
    if (store.tasks.length === before) return { success: false, error: `找不到任务: ${id}` };
    this.saveTasks(store);
    return { success: true, deleted: id };
  }

  // ---- 研究笔记 ----

  getNote() {
    return { success: true, content: fs.readFileSync(this.noteFile, 'utf8') };
  }

  saveNote(content) {
    fs.writeFileSync(this.noteFile, String(content || ''), 'utf8');
    return { success: true, bytes: Buffer.byteLength(String(content || ''), 'utf8'), file: this.noteFile };
  }

  // ---- 论文检索：arXiv 官方接口，不要 key 📚 ----

  async searchPapers(query, max = 8) {
    const q = String(query || '').trim();
    if (!q) return { success: false, error: '搜索词不能为空' };
    const limit = Math.min(Math.max(parseInt(max, 10) || 8, 1), 20);
    // arXiv 两套端点：export 主用，主站兜底。必须 https——走明文等于把检索词广播给链路上所有人
    const endpoints = [
      `https://export.arxiv.org/api/query`,
      `https://arxiv.org/api/query`
    ];
    const params = `search_query=all:${encodeURIComponent(q)}&start=0&max_results=${limit}&sortBy=relevance`;
    const opts = {
      timeout: 20000,
      responseType: 'text',
      headers: {
        Accept: 'application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
      }
    };
    // 实测根因是突发限流：连发时两个端点一起回 406，停十几秒又自己好。
    // 所以治法不是快速换端点猛重试，而是礼貌间隔 + 被限流时长长地等
    const now = Date.now();
    const gap = now - (this._lastPaperReqAt || 0);
    if (this._lastPaperReqAt && gap < PAPER_REQ_GAP_MS) {
      await new Promise(r => setTimeout(r, PAPER_REQ_GAP_MS - gap));
    }
    let lastStatus = '连接失败';
    let xml = '';
    // 节奏：export 端点最多试 3 次（406/429/503 等 8s、15s；别的错等 2s），还不行再摸一次主站
    const plan = [
      { endpoint: 0, wait: 0 },
      { endpoint: 0, wait: 8000, retryOn: [406, 429, 503, 502] },
      { endpoint: 0, wait: 15000, retryOn: [406, 429, 503, 502] },
      { endpoint: 1, wait: 5000 }
    ];
    for (let i = 0; i < plan.length && !xml; i++) {
      const step = plan[i];
      if (step.wait) await new Promise(r => setTimeout(r, step.wait));
      this._lastPaperReqAt = Date.now();
      try {
        const resp = await axios.get(`${endpoints[step.endpoint]}?${params}`, opts);
        xml = String(resp.data || '');
      } catch (error) {
        lastStatus = error.response ? error.response.status : lastStatus;
        console.warn(`[Research] arXiv 抓取失败（第${i + 1}次, HTTP ${lastStatus}）: ${error.message}`);
        // 非限流类错误（比如超时）不必傻等长退避，plan 里的长等只对限流状态有意义，这里直接继续也行
      }
    }
    if (!xml) {
      return {
        success: false,
        error: `arXiv 这会儿在限流（HTTP ${lastStatus}），不是关键词的问题，等一两分钟再搜一次就行；急的话我可以在工作台用 python 自己抓`
      };
    }
    const papers = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml)) && papers.length < limit) {
      const block = m[1];
      const pick = (tag) => {
        const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return r ? r[1].replace(/\s+/g, ' ').trim() : '';
      };
      const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => a[1].trim());
      papers.push({
        title: pick('title'),
        url: pick('id'),
        authors: authors.slice(0, 4).join(', ') + (authors.length > 4 ? ' 等' : ''),
        published: pick('published').slice(0, 10),
        summary: pick('summary').slice(0, 320)
      });
    }
    return { success: true, source: 'arxiv', query: q, count: papers.length, papers };
  }

  // ---- 新闻检索：并行抓几个 RSS，按关键词过滤、按时间排 📰 ----

  async searchNews(query, max = 10) {
    const limit = Math.min(Math.max(parseInt(max, 10) || 10, 1), 30);
    const jobs = NEWS_FEEDS.map(async (feed) => {
      const resp = await axios.get(feed.url, {
        timeout: 15000,
        responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/rss+xml, application/xml, text/xml, */*' }
      });
      const xml = String(resp.data || '');
      const items = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml)) && items.length < 40) {
        const block = m[1];
        const pick = (tag) => {
          const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
          if (!r) return '';
          return r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        };
        const ts = new Date(pick('pubDate')).getTime() || 0;
        items.push({
          source: feed.name,
          title: pick('title'),
          link: pick('link'),
          date: ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '',
          ts,
          snippet: pick('description').slice(0, 160)
        });
      }
      return items;
    });
    const settled = await Promise.allSettled(jobs);
    let all = [];
    settled.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });

    const kw = String(query || '').trim().toLowerCase();
    if (kw) {
      // 关键词打分过滤：整串命中优先，多词/中文短语按 2-gram 命中比例兜底（阈值 0.5），再按分数、时间排
      all = all
        .map(it => ({ ...it, _score: keywordScore(`${it.title} ${it.snippet}`, kw) }))
        .filter(it => it._score >= 0.5);
      all.sort((a, b) => b._score - a._score || b.ts - a.ts);
    } else {
      all.sort((a, b) => b.ts - a.ts);
    }
    const news = all.slice(0, limit).map(({ ts, _score, ...rest }) => rest);
    return { success: true, source: 'rss', query: kw, count: news.length, news };
  }

  // ---- 脚本工作台：只认 data/research/workspace/ 里、且只按文件名给 ----

  // name 只取文件名（防路径穿越），language 定后缀；给了 code 就先写进工作台
  resolveWorkspaceScript(name, language, code) {
    const kind = String(language) === 'node' ? 'node' : 'python';
    const ext = kind === 'node' ? '.js' : '.py';
    let base = String(name || '').trim();
    if (!base) {
      base = `script_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    }
    base = path.basename(base); // 只留文件名，..\ 这类一律剪掉 🚫
    if (!/\.(py|js)$/i.test(base)) base += ext;
    const target = path.join(this.workspace, base);
    if (!target.startsWith(path.resolve(this.workspace))) {
      return { success: false, error: '脚本只能放在研究工作台（data/research/workspace/）里' };
    }
    if (typeof code === 'string' && code.length > 0) {
      fs.writeFileSync(target, code, 'utf8');
    } else if (!fs.existsSync(target)) {
      return { success: false, error: `工作台里没有这个脚本，也没给 code: ${base}` };
    }
    return { success: true, kind, file: target, cwd: this.workspace };
  }

  // 每次跑码都记一笔，方便复盘也方便看她又折腾了啥 😆
  logRun(entry) {
    try {
      fs.appendFileSync(this.runsFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
      // 记日志失败不影响跑码本身
    }
  }
}

module.exports = ResearchCenter;
module.exports.keywordScore = keywordScore;
