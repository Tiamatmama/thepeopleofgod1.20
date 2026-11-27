const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { classifyLine, SAME_TYPE_TYPES } = require('../learning/dialogueRetriever');

require('../core/config');

// ========== 配置 ==========
const CONFIG = {
  // 语料源：LCCC（中文多轮对话语料，约 680 万条真实会话），经 HuggingFace datasets-server 读取
  lccc: {
    rowsApi: 'https://datasets-server.huggingface.co/rows',
    dataset: 'silver/lccc',
    config: 'base',
    split: 'train',
    pageSize: 100,
    maxOffset: 300000,
    // 本机访问 HuggingFace 需要走系统代理，node 默认不走，故显式读取
    proxy: process.env.HF_PROXY || ''
  },
  maxPairs: 800,
  requestDelayMs: 300,
  embedding: {
    url: process.env.EMBEDDING_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
    token: process.env.EMBEDDING_BEARER_TOKEN,
    model: process.env.EMBEDDING_MODEL_ID || 'doubao-embedding-vision-251215',
    maxRetries: 5
  },
  qdrant: {
    url: (process.env.QDRANT_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.QDRANT_API_KEY,
    collection: process.env.QDRANT_DIALOGUE_COLLECTION || 'semantic_dialogues',
    upsertBatchSize: 16,
    timeout: 120000
  },
  corpusFile: path.join(__dirname, '..', '..', 'data', 'dialogue_corpus.json'),
  // 向量缓存：向量化成本高，缓存后重跑（如入库失败）无需重复付费调用
  embeddingCacheFile: path.join(__dirname, '..', '..', 'data', 'dialogue_embeddings.json'),
  // 增量游标：记录下一轮从 LCCC 第几行继续，避免每天从头重抓同一批对话
  stateFile: path.join(__dirname, '..', '..', 'data', 'dialogue_feed_state.json')
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (msg) => console.log(`[${new Date().toLocaleString()}] ${msg}`);

// 寒暄语料：LCCC 是网友闲聊语料，几乎不含「你好/再见/谢谢」这类礼节性对话
// （实测 3000 对里问候对仅 3 对），这里补一份人工整理的寒暄样本，
// 保证「问候对问候」有稳定、高质量的数据可用
const COURTESY_SEED = [
  { input: '你好', reply: '你好呀' },
  { input: '你好', reply: '嗨，你好' },
  { input: '你好', reply: '你好，很高兴见到你' },
  { input: '你好啊', reply: '你好，你好' },
  { input: '你好呀', reply: '你好呀，见到你真开心' },
  { input: '早上好', reply: '早上好呀' },
  { input: '早安', reply: '早安，今天也要加油哦' },
  { input: '中午好', reply: '中午好，吃饭了吗？' },
  { input: '下午好', reply: '下午好，今天过得怎么样？' },
  { input: '晚上好', reply: '晚上好，今天辛苦啦' },
  { input: '好久不见', reply: '好久不见，最近还好吗？' },
  { input: '在吗', reply: '在的，怎么啦？' },
  { input: '在吗', reply: '在呢，有什么事吗？' },
  { input: '嗨', reply: '嗨，好久不见' },
  { input: '再见', reply: '再见，下次聊' },
  { input: '拜拜', reply: '拜拜，早点休息' },
  { input: '我走了', reply: '好，那我先走了' },
  { input: '我先走了', reply: '那我先走了，路上小心' },
  { input: '晚安', reply: '晚安，做个好梦' },
  { input: '下次聊', reply: '好，下次再聊' },
  { input: '回头见', reply: '嗯，回见' },
  { input: '有空再聊', reply: '好的，下次聊' },
  { input: '谢谢', reply: '不客气' },
  { input: '谢谢你', reply: '别客气，应该的' },
  { input: '多谢', reply: '客气了' },
  { input: '感谢', reply: '不客气，有事随时找我' },
  { input: '对不起', reply: '没关系' },
  { input: '抱歉', reply: '没关系，我理解' },
  { input: '不好意思', reply: '没事，别在意' },
  { input: '我错了', reply: '好了，原谅你了' }
];

// 把人工寒暄样本转成与 LCCC 相同的结构，且必须满足配对的句式要求
function buildSeedPairs() {
  return COURTESY_SEED.map(({ input, reply }) => ({
    input,
    reply,
    inputType: classifyLine(input),
    replyType: classifyLine(reply),
    rowIdx: -1,
    source: 'seed'
  })).filter(
    (pair) =>
      pair.inputType !== 'other' &&
      (!SAME_TYPE_TYPES.includes(pair.inputType) || pair.replyType === pair.inputType)
  );
}

// ========== LCCC 语料抓取 ==========
function parseProxy(url) {
  try {
    const u = new URL(url);
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: parseInt(u.port, 10) };
  } catch (error) {
    return undefined;
  }
}

async function fetchLcccRows(offset, length) {
  const { rowsApi, dataset, config, split, proxy } = CONFIG.lccc;
  const res = await axios.get(rowsApi, {
    params: { dataset, config, split, offset, length },
    timeout: 45000,
    validateStatus: () => true,
    ...(proxy ? { proxy: parseProxy(proxy) } : {})
  });
  if (res.status !== 200) throw new Error(`数据集接口返回 ${res.status}`);
  return res.data;
}

// LCCC 文本字间带空格（如「你 好 呀」），先去掉空白
function cleanLine(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

// 过滤不适合做对话样本的行
function isGoodLine(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 2 || t.length > 30) return false;
  if (/…$/.test(t) || /\.\.\.$/.test(t)) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  // 整行括号内容多为旁白/场景说明，不是对白
  if (/^[（(].*[)）]$/.test(t)) return false;
  // 链接、@、话题标签、表情占位符等不是自然对话
  if (/(https?:\/\/|www\.|@\S|#[^#\s]{1,20}#|\[[^\]]{1,6}\])/i.test(t)) return false;
  return true;
}

// 把一段多轮对话切成「上一句 → 下一句」的对话对
function buildLcccPairs(dialog, rowIdx) {
  const pairs = [];
  if (!Array.isArray(dialog)) return pairs;

  const lines = dialog.map(cleanLine);
  for (let i = 0; i + 1 < lines.length; i++) {
    const input = lines[i];
    const reply = lines[i + 1];
    if (!isGoodLine(input) || !isGoodLine(reply) || input === reply) continue;

    const inputType = classifyLine(input);
    const replyType = classifyLine(reply);
    // 问候/道别必须同类回应，避免「你好 → 雪茄」式错配
    if (SAME_TYPE_TYPES.includes(inputType) && replyType !== inputType) continue;

    pairs.push({ input, reply, inputType, replyType, rowIdx, source: 'lccc' });
  }
  return pairs;
}

// 增量：从 startOffset 起读 LCCC，只收集 seenKeys 里没有的新对话对；
// 返回本轮新增的 pairs 与「已读到的行号」，供下一轮继续
async function collectPairs(limit, options) {
  const { startOffset = 0, seenKeys = null } = options || {};
  const pairs = [];
  const seen = seenKeys || new Set();
  const { pageSize, maxOffset } = CONFIG.lccc;
  let offset = Math.min(Math.max(startOffset, 0), maxOffset);
  let lastLogged = 0;

  // 人工寒暄样本优先入列，保证问候/道别类永远有可用样本（已在本地语料里的不重复加）
  for (const pair of buildSeedPairs()) {
    const key = pairKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  if (pairs.length > 0) log(`已加入 ${pairs.length} 对人工寒暄样本`);

  while (pairs.length < limit && offset < maxOffset) {
    const data = await fetchLcccRows(offset, pageSize);
    const rows = (data && data.rows) || [];
    if (rows.length === 0) break;

    let consumed = 0;
    for (const row of rows) {
      consumed++;
      const list = buildLcccPairs(row.row && row.row.dialog, row.row_idx);
      for (const pair of list) {
        const key = pairKey(pair);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(pair);
        if (pairs.length >= limit) break;
      }
      if (pairs.length >= limit) break;
    }

    offset += consumed;
    if (pairs.length - lastLogged >= 100 || pairs.length >= limit) {
      lastLogged = pairs.length;
      log(`已收集 ${pairs.length} 对新对话（已读至 LCCC 第 ${offset} 行）`);
    }
    if (pairs.length >= limit) break;
    await sleep(CONFIG.requestDelayMs);
  }

  return { pairs: pairs.slice(0, limit), nextOffset: offset };
}

// ========== 向量化（豆包 doubao-embedding-vision，多模态端点） ==========
// 多模态端点会把 input 数组整体编码为一条向量，因此每条文本单独请求
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

async function embedTexts(texts, cache) {
  const store = cache || {};
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    if (Array.isArray(store[texts[i]])) {
      vectors.push(store[texts[i]]);
      continue;
    }
    const vector = await embedOne(texts[i]);
    store[texts[i]] = vector;
    vectors.push(vector);
    if ((i + 1) % 20 === 0 || i === texts.length - 1) {
      saveEmbeddingCache(store);
      log(`已向量化 ${i + 1}/${texts.length} 条`);
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
function saveCorpus(pairs) {
  const dir = path.dirname(CONFIG.corpusFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.corpusFile, JSON.stringify(pairs, null, 2));
  log(`已保存 ${pairs.length} 对对话到 ${path.relative(process.cwd(), CONFIG.corpusFile)}`);
}

// 去重键：同一句输入配同一句回应视为同一对
function pairKey(pair) {
  return `${pair.input}||${pair.reply}`;
}

// 读取本地已有语料，用于增量：已抓过的对话对不再重复抓
function loadCorpus() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.corpusFile, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

// 读取/保存增量游标：nextOffset 记录下一轮从 LCCC 第几行继续
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
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : CONFIG.maxPairs;
  const skipEmbed = process.argv.includes('--no-embed');

  // 增量：本地已有语料直接去重跳过；游标决定从 LCCC 第几行继续，不再每次从头
  const existing = loadCorpus();
  const seenKeys = new Set(existing.map(pairKey));
  const state = loadState();
  log(
    `本地已有 ${existing.length} 对对话，本轮从 LCCC 第 ${state.nextOffset} 行起，目标新增 ${limit} 对`
  );

  log(`开始从 LCCC 对话语料（${CONFIG.lccc.dataset}）抓取对话对...`);
  let result;
  try {
    result = await collectPairs(limit, { startOffset: state.nextOffset, seenKeys });
  } catch (error) {
    throw new Error(
      `${error.message}（若本机需要代理访问 HuggingFace，请在 .env 配置 HF_PROXY=http://127.0.0.1:7897）`
    );
  }
  const pairs = result.pairs;
  saveState({ nextOffset: result.nextOffset });

  if (pairs.length === 0) {
    log('本轮未发现新对话，跳过向量化与入库');
    return;
  }
  log(`抓取完成，本轮新增 ${pairs.length} 对对话`);
  const merged = existing.concat(pairs);
  saveCorpus(merged);

  if (skipEmbed) {
    log('已跳过向量化与入库（--no-embed）');
    return;
  }

  log(`开始向量化（模型：${CONFIG.embedding.model}）...`);
  let vectors;
  try {
    vectors = await embedTexts(pairs.map((p) => p.input), loadEmbeddingCache());
  } catch (error) {
    throw wrapEmbeddingError(error);
  }
  const size = vectors[0].length;
  log(`向量化完成，维度 ${size}`);

  const client = qdrantClient();
  await ensureCollection(client, size);

  // 追加模式：id 从「本地已有条数 + 1」接着编，避免与已入库向量冲突
  const firstId = existing.length + 1;
  const points = pairs.map((pair, index) => ({
    id: firstId + index,
    vector: vectors[index],
    payload: {
      input: pair.input,
      reply: pair.reply,
      inputType: pair.inputType,
      replyType: pair.replyType,
      rowIdx: pair.rowIdx,
      source: pair.source
    }
  }));

  await upsertPoints(client, points);
  log(
    `完成：新增 ${points.length} 对对话已写入 Qdrant 集合「${CONFIG.qdrant.collection}」，` +
      `本地累计 ${merged.length} 对`
  );
}

module.exports = {
  CONFIG,
  collectPairs,
  buildLcccPairs,
  buildSeedPairs,
  isGoodLine,
  cleanLine,
  embedTexts,
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
