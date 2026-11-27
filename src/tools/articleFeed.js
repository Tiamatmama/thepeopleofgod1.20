const path = require('path');
const fs = require('fs');
const axios = require('axios');

require('../core/config');

// ========== 配置 ==========
const CONFIG = {
  // 语料源：中文维基百科（长文本，纯正文），经 HuggingFace datasets-server 读取
  wiki: {
    rowsApi: 'https://datasets-server.huggingface.co/rows',
    dataset: 'wikimedia/wikipedia',
    config: '20231101.zh',
    split: 'train',
    pageSize: 20,
    // 游标安全上限，防止异常情况下无限翻页；读到末尾时接口返回空数组会自然退出
    maxOffset: 5000000,
    // 本机访问 HuggingFace 需要走系统代理，node 默认不走，故显式读取
    proxy: process.env.HF_PROXY || ''
  },
  maxArticles: 100,
  requestDelayMs: 300,
  // 过滤与截断：短文（消歧义页/小作品）不入库；超长正文只截前段做向量，全文仍完整存进 payload
  minChars: 800,
  maxEmbedChars: 4000,
  embedding: {
    url: process.env.EMBEDDING_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
    token: process.env.EMBEDDING_BEARER_TOKEN,
    model: process.env.EMBEDDING_MODEL_ID || 'doubao-embedding-vision-251215',
    maxRetries: 5
  },
  qdrant: {
    url: (process.env.QDRANT_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.QDRANT_API_KEY,
    collection: process.env.QDRANT_ARTICLE_COLLECTION || 'web_articles',
    upsertBatchSize: 16,
    timeout: 120000
  },
  corpusFile: path.join(__dirname, '..', '..', 'data', 'web_articles.json'),
  // 向量缓存：向量化成本高，缓存后重跑（如入库失败）无需重复付费调用
  embeddingCacheFile: path.join(__dirname, '..', '..', 'data', 'web_articles_embeddings.json'),
  // 增量游标：记录下一轮从数据集第几行继续，避免每次从头重抓同一批文章
  stateFile: path.join(__dirname, '..', '..', 'data', 'web_articles_state.json')
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (msg) => console.log(`[${new Date().toLocaleString()}] ${msg}`);

// ========== 语料抓取 ==========
function parseProxy(url) {
  try {
    const u = new URL(url);
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: parseInt(u.port, 10) };
  } catch (error) {
    return undefined;
  }
}

async function fetchWikiRows(offset, length) {
  const { rowsApi, dataset, config, split, proxy } = CONFIG.wiki;
  const res = await axios.get(rowsApi, {
    params: { dataset, config, split, offset, length },
    timeout: 45000,
    validateStatus: () => true,
    ...(proxy ? { proxy: parseProxy(proxy) } : {})
  });
  if (res.status !== 200) throw new Error(`数据集接口返回 ${res.status}`);
  return res.data;
}

// 正文规范化：折叠过量空行，去掉首尾空白
function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chineseRatio(text) {
  const chars = text.replace(/\s/g, '');
  if (chars.length === 0) return 0;
  const matched = chars.match(/[\u4e00-\u9fa5]/g);
  return (matched ? matched.length : 0) / chars.length;
}

// 过滤不适合做长文样本的条目（消歧义页、列表页、小作品、非中文正文等）
function isGoodArticle(title, text) {
  if (!text) return false;
  if (text.length < CONFIG.minChars) return false;
  if (chineseRatio(text) < 0.3) return false;
  // 「XX可以指：」「XX列表」「XX年」这类页面信息密度低，不适合做语义样本
  if (/可以指[：:]?$/.test(title)) return false;
  if (/(列表|年表|消歧义|索引)$/.test(title)) return false;
  return true;
}

// 把一条数据集记录转成待入库的文章；不合格返回 null
function buildArticle(row, rowIdx) {
  if (!row) return null;
  const id = String(row.id || '').trim();
  const title = String(row.title || '').trim();
  const content = cleanText(row.text);
  if (!id || !title) return null;
  if (!isGoodArticle(title, content)) return null;
  return {
    id,
    url: String(row.url || ''),
    title,
    content,
    textLen: content.length,
    rowIdx,
    source: 'wikipedia'
  };
}

// 增量：从 startOffset 起读数据集，只收集 seenIds 里没有的新文章；
// 返回本轮新增的文章与「已读到的行号」，供下一轮继续
async function collectArticles(limit, options) {
  const { startOffset = 0, seenIds = null } = options || {};
  const articles = [];
  const seen = seenIds || new Set();
  const { pageSize, maxOffset } = CONFIG.wiki;
  let offset = Math.min(Math.max(startOffset, 0), maxOffset);
  let lastLogged = 0;

  while (articles.length < limit && offset < maxOffset) {
    const data = await fetchWikiRows(offset, pageSize);
    const rows = (data && data.rows) || [];
    if (rows.length === 0) break;

    let consumed = 0;
    for (const row of rows) {
      consumed++;
      const article = buildArticle(row.row, row.row_idx);
      if (!article) continue;
      if (seen.has(article.id)) continue;
      seen.add(article.id);
      articles.push(article);
      if (articles.length >= limit) break;
    }

    offset += consumed;
    if (articles.length - lastLogged >= 20 || articles.length >= limit) {
      lastLogged = articles.length;
      log(`已收集 ${articles.length} 篇新文章（已读至数据集第 ${offset} 行）`);
    }
    if (articles.length >= limit) break;
    await sleep(CONFIG.requestDelayMs);
  }

  return { articles: articles.slice(0, limit), nextOffset: offset };
}

// ========== 向量化（豆包 doubao-embedding-vision，多模态端点） ==========
// 多模态端点会把 input 数组整体编码为一条向量，因此每篇文档单独请求
async function embedOne(text) {
  const { url, token, model, maxRetries } = CONFIG.embedding;
  if (!token) throw new Error('缺少 EMBEDDING_BEARER_TOKEN 配置');
  if (!url) throw new Error('缺少 EMBEDDING_API_URL 配置');

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.post(
        url,
        { model, input: [{ type: 'text', text }] },
        {
          timeout: 60000,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          }
        }
      );

      const data = res.data && res.data.data;
      const embedding = Array.isArray(data) ? data[0] && data[0].embedding : data && data.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('embedding 返回结构异常');
      }
      return embedding;
    } catch (error) {
      lastError = error;
      const code =
        error.response && error.response.data && error.response.data.error
          ? error.response.data.error.code
          : '';
      const status = error.response ? error.response.status : 0;
      const retriable = code === 'ModelNotOpen' || status >= 500;
      if (retriable && attempt < maxRetries) {
        await sleep(attempt * 2000);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// 向量化输入：标题 + 正文前段；缓存键用文章 id，避免超长正文整段当 key
function embeddingText(article) {
  return `${article.title}\n${article.content.slice(0, CONFIG.maxEmbedChars)}`;
}

async function embedArticles(articles, cache) {
  const store = cache || {};
  const vectors = [];
  for (let i = 0; i < articles.length; i++) {
    const key = articles[i].id;
    if (Array.isArray(store[key])) {
      vectors.push(store[key]);
      continue;
    }
    const vector = await embedOne(embeddingText(articles[i]));
    store[key] = vector;
    vectors.push(vector);
    if ((i + 1) % 10 === 0 || i === articles.length - 1) {
      saveEmbeddingCache(store);
      log(`已向量化 ${i + 1}/${articles.length} 篇`);
    }
  }
  return vectors;
}

function loadEmbeddingCache() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.embeddingCacheFile, 'utf8'));
  } catch (error) {
    return {};
  }
}

function saveEmbeddingCache(cache) {
  const dir = path.dirname(CONFIG.embeddingCacheFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.embeddingCacheFile, JSON.stringify(cache));
}

function wrapEmbeddingError(error) {
  const body = error.response && error.response.data;
  const code = body && body.error ? body.error.code : '';
  if (code === 'ModelNotOpen') {
    return new Error(
      `豆包向量模型「${CONFIG.embedding.model}」尚未开通生效。请到火山引擎方舟控制台「开通管理 → 向量模型」确认已开通后重试。`
    );
  }
  const detail = body ? JSON.stringify(body).slice(0, 300) : error.message;
  return new Error(`向量化失败: ${detail}`);
}

// ========== Qdrant ==========
function qdrantClient() {
  const { url, apiKey } = CONFIG.qdrant;
  if (!url || !apiKey) throw new Error('缺少 QDRANT_URL 或 QDRANT_API_KEY 配置');
  return axios.create({
    baseURL: url,
    timeout: CONFIG.qdrant.timeout,
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' }
  });
}

async function ensureCollection(client, size) {
  const name = CONFIG.qdrant.collection;
  // 增量模式：集合已存在则复用，只追加新向量，不再每次清空重建
  try {
    const res = await client.get(`/collections/${name}`);
    const existing = res.data.result.config.params.vectors.size;
    if (existing !== size) {
      throw new Error(`集合「${name}」已存在但维度为 ${existing}，与当前向量维度 ${size} 不一致`);
    }
    log(`集合「${name}」已存在，维度 ${size}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      await client.put(`/collections/${name}`, {
        vectors: { size, distance: 'Cosine' }
      });
      log(`已创建集合「${name}」，维度 ${size}`);
    } else {
      throw error;
    }
  }
}

async function upsertPoints(client, points) {
  const name = CONFIG.qdrant.collection;
  for (let i = 0; i < points.length; i += CONFIG.qdrant.upsertBatchSize) {
    const batch = points.slice(i, i + CONFIG.qdrant.upsertBatchSize);
    await client.put(`/collections/${name}/points?wait=true`, { points: batch });
    log(`已写入 ${Math.min(i + CONFIG.qdrant.upsertBatchSize, points.length)}/${points.length} 条向量`);
  }
}

// 本地留一份语料，便于离线查看与重新入库
function saveCorpus(articles) {
  const dir = path.dirname(CONFIG.corpusFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.corpusFile, JSON.stringify(articles, null, 2));
  log(`已保存 ${articles.length} 篇文章到 ${path.relative(process.cwd(), CONFIG.corpusFile)}`);
}

// 读取本地已有语料，用于增量：已抓过的文章不再重复抓
function loadCorpus() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.corpusFile, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

// 读取/保存增量游标：nextOffset 记录下一轮从数据集第几行继续
function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    const nextOffset = parseInt(state && state.nextOffset, 10);
    return { nextOffset: Number.isNaN(nextOffset) || nextOffset < 0 ? 0 : nextOffset };
  } catch (error) {
    return { nextOffset: 0 };
  }
}

function saveState(state) {
  const dir = path.dirname(CONFIG.stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), 'utf8');
}

// ========== 主流程 ==========
async function run() {
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : CONFIG.maxArticles;
  const skipEmbed = process.argv.includes('--no-embed');

  // 增量：本地已有文章直接去重跳过；游标决定从数据集第几行继续，不再每次从头
  const existing = loadCorpus();
  const seenIds = new Set(existing.map((a) => a.id));
  const state = loadState();
  log(
    `本地已有 ${existing.length} 篇文章，本轮从数据集第 ${state.nextOffset} 行起，目标新增 ${limit} 篇`
  );

  log(`开始从中文维基语料（${CONFIG.wiki.dataset} / ${CONFIG.wiki.config}）抓取文章...`);
  let result;
  try {
    result = await collectArticles(limit, { startOffset: state.nextOffset, seenIds });
  } catch (error) {
    throw new Error(
      `${error.message}（若本机需要代理访问 HuggingFace，请在 .env 配置 HF_PROXY=http://127.0.0.1:7897）`
    );
  }
  const articles = result.articles;
  saveState({ nextOffset: result.nextOffset });

  if (articles.length === 0) {
    log('本轮未发现新文章，跳过向量化与入库');
    return;
  }
  log(`抓取完成，本轮新增 ${articles.length} 篇文章`);
  const merged = existing.concat(articles);
  saveCorpus(merged);

  if (skipEmbed) {
    log('已跳过向量化与入库（--no-embed）');
    return;
  }

  log(`开始向量化（模型：${CONFIG.embedding.model}）...`);
  let vectors;
  try {
    vectors = await embedArticles(articles, loadEmbeddingCache());
  } catch (error) {
    throw wrapEmbeddingError(error);
  }
  const size = vectors[0].length;
  log(`向量化完成，维度 ${size}`);

  const client = qdrantClient();
  await ensureCollection(client, size);

  // 追加模式：id 从「本地已有条数 + 1」接着编，避免与已入库向量冲突
  const firstId = existing.length + 1;
  const points = articles.map((article, index) => ({
    id: firstId + index,
    vector: vectors[index],
    payload: {
      docId: article.id,
      url: article.url,
      title: article.title,
      content: article.content,
      textLen: article.textLen,
      rowIdx: article.rowIdx,
      source: article.source
    }
  }));

  await upsertPoints(client, points);
  log(
    `完成：新增 ${points.length} 篇文章已写入 Qdrant 集合「${CONFIG.qdrant.collection}」，` +
      `本地累计 ${merged.length} 篇`
  );
}

module.exports = {
  CONFIG,
  collectArticles,
  buildArticle,
  isGoodArticle,
  cleanText,
  chineseRatio,
  embeddingText,
  embedArticles,
  loadCorpus,
  loadState,
  saveState
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`[${new Date().toLocaleString()}] 执行失败: ${error.message}`);
      process.exit(1);
    });
}
