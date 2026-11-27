'use strict';
// 📊 一次性只读分析：按【冻结判据】算 L1 · S0 系列指标（S0-a/b/c/d）。
//   判据文档：.trae/documents/编程沙箱-哲学协议-shadow判据.md
//     §二 窗口定义 · §三 S0 表 + L1 聚类口径 v1（字面，已作废）/ v2（语义，现行）
//   数据来源：data/coding-philosophy/*.jsonl（L0 落点，按文件名=小时戳排序即采集顺序）
//
//   本脚本**只读**：不写盘、不改业务代码、不跨窗拼接。
//   两种聚类口径（θ 见各常量）：
//     v2 semantic（默认）：cosineSimilarity(向量) —— 复用 memoryVectorStore.embed（豆包 2048 维）
//     v1 lexical        ：diceSimilarity(bigrams) —— 已作废，仅留档对比
//   簇数 k 含 singleton；S0-c = 代表项跨窗贪心一对一匹配的 Jaccard；S0-d = 非 singleton 簇成员 / N。
//
// 用法（项目根目录）：
//   node scripts/analyze-philosophy-s0.js            # 语义口径 v2（默认）
//   node scripts/analyze-philosophy-s0.js --lexical  # 字面口径 v1（对比留档）
//   node scripts/analyze-philosophy-s0.js --merge    # v3 归并层（LLM 归并到受控粗粒度域后算 S0）
//   node scripts/analyze-philosophy-s0.js --scan     # 只读诊断（相似度分布 + k-θ 曲线）

const fs = require('fs');
const path = require('path');
const { bigrams, diceSimilarity, greedyCluster, cosineSimilarity } = require('../src/core/memoryConsolidation');
const MemoryVectorStore = require('../src/learning/memoryVectorStore');
const { UnifiedAPI } = require('../src/core/api');
require('../src/core/config');

// —— 冻结常量（改动=废窗重开，见判据文档 §冻结声明）——
const WINDOW_SIZE = 150;      // 一窗 = 150 条有效样本
const LEXICAL_THETA = 0.5;    // v1 字面口径阈值（已作废）
const SEMANTIC_THETA = 0.85;  // v2 语义口径阈值（对齐 S-label-a 的 α=0.85）
const K_MIN = 3;
const K_MAX = 24;             // v1 曾为 12；按判据文档「粒度冻结 + 废窗重开」修订为 24（k∈[3,24]）
const K_WINDOWS = 3;          // S0-b 连续 K 窗
const S0A_MIN = 100;
const S0C_MIN = 0.6;
const S0D_MIN = 0.8;

const DIR = path.join(__dirname, '..', 'data', 'coding-philosophy');
const MODE = (process.argv[2] || '--semantic').replace(/^--/, '');
// 只取 at(epoch ms) >= SINCE_AT 的样本；用于「排除已废旧窗、只算新窗」（见判据文档 §冻结声明）。
// 未设（0）= 不过滤（旧 450 条 + 新样本全取，仅供对照，不作达标依据）。
const SINCE_AT = process.env.SINCE_AT ? Number(process.env.SINCE_AT) : 0;

function loadAll() {
  if (!fs.existsSync(DIR)) throw new Error(`数据目录不存在：${DIR}`);
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
  const rows = [];
  let bad = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { bad++; }
    }
  }
  const kept = SINCE_AT ? rows.filter((r) => Number(r.at) >= SINCE_AT) : rows;
  return { rows: kept, files, bad, total: rows.length, dropped: rows.length - kept.length };
}

// 逐窗取 domainRaw（trim 去空），与冻结口径一致
function toWindows(rows) {
  const fullWindows = Math.floor(rows.length / WINDOW_SIZE);
  const windows = [];
  for (let w = 0; w < fullWindows; w++) {
    const slice = rows.slice(w * WINDOW_SIZE, (w + 1) * WINDOW_SIZE);
    windows.push(slice.map((r) => String((r && r.domainRaw) || '').trim()).filter(Boolean));
  }
  return { windows, fullWindows, remainder: rows.length - fullWindows * WINDOW_SIZE };
}

// 构造相似度函数：v1 字面 / v2 语义
async function buildSimilarity(windows) {
  if (MODE === 'lexical') {
    return { sim: (a, b) => diceSimilarity(bigrams(a), bigrams(b)), theta: LEXICAL_THETA, label: 'v1 字面(dice-bigrams)' };
  }
  const vs = new MemoryVectorStore();
  const uniq = [...new Set(windows.flat())];
  console.log(`[语义口径] 需嵌入 ${uniq.length} 个唯一 domainRaw（豆包 embedding，2048 维）…`);
  const vecOf = new Map();
  let cursor = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (cursor < uniq.length) {
      const t = uniq[cursor++];
      try {
        const vec = await vs.embed(t);
        if (Array.isArray(vec)) vecOf.set(t, vec);
      } catch (e) {
        failed++;
        console.error(`  嵌入失败：「${t}」 ${e.message}`);
      }
      done++;
      if (done % 50 === 0) console.log(`  进度 ${done}/${uniq.length}`);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log(`[语义口径] 嵌入完成：成功 ${vecOf.size} / 唯一 ${uniq.length}，失败 ${failed}`);
  return {
    sim: (a, b) => {
      const va = vecOf.get(a);
      const vb = vecOf.get(b);
      if (!va || !vb) return 0;
      return cosineSimilarity(va, vb);
    },
    theta: SEMANTIC_THETA,
    label: 'v2 语义(embedding-cosine)',
    vecOf,
    uniq,
  };
}

// 按口径对一窗的 domainRaw 聚类
function clusterWindow(items, sim, theta) {
  const clusters = greedyCluster(items, sim, theta);
  const n = items.length;
  const nonSingletonMembers = clusters
    .filter((c) => c.length >= 2)
    .reduce((sum, c) => sum + c.length, 0);
  return {
    n,
    k: clusters.length,
    reps: clusters.map((c) => c[0]),
    singleton: clusters.filter((c) => c.length === 1).length,
    coverage: n > 0 ? nonSingletonMembers / n : 0,
    topReps: clusters
      .map((c) => ({ rep: c[0], size: c.length }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 10),
  };
}

// S0-c：相邻两窗簇的 Jaccard（代表项跨窗贪心一对一匹配，仅 sim≥θ 可匹配）
function jaccardBetween(wa, wb, sim, theta) {
  const used = new Set();
  let m = 0;
  for (const ra of wa.reps) {
    for (let j = 0; j < wb.reps.length; j++) {
      if (used.has(j)) continue;
      if (sim(ra, wb.reps[j]) >= theta) {
        used.add(j);
        m++;
        break;
      }
    }
  }
  const union = wa.k + wb.k - m;
  return union > 0 ? m / union : 0;
}

// ============ v3 归并层（用户拍板：不重跑，L1 聚类前加一道「归并到粗粒度主题」）============
// 根因是采集期 domainRaw 为无约束自由文本（450 条里 443 条唯一），任何聚类都收不住。
// 归并层不重跑采集，而是把每条自报域 LLM-归并到一个**受控粗粒度决策域**（6~12 个），再据此算 S0。
const MERGE_MAX_DOMAINS = parseInt(process.env.MERGE_MAX_DOMAINS || '30', 10); // 归并后受控域清单上限
// 注意（判据文档 §三 实现注意 · 防再次自证）：本上限须 > 冻结 k_max(24)，使 k 由数据自然涌现、不被实现上限卡死。
// v1 曾默认 12（恰=旧 k_max），属构造性自证，已废。
const MERGE_CHUNK = 25;       // 每批归并条数
const MERGE_CONCURRENCY = 3;  // 并发批数
const MERGE_RETRY = 3;        // 每批重试次数（对抗偶发超时）

function extractJson(text) {
  const s = String(text == null ? '' : text);
  const m = /```json\s*([\s\S]*?)```/i.exec(s);
  const raw = m ? m[1] : s;
  try { return JSON.parse(raw); } catch { return null; }
}

// callAPI 返回整个响应体，正文在 choices[0].message.content
function contentOf(res) {
  return String((res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '').trim();
}

// Stage A：从全部自报域里归纳出一份受控粗粒度域清单
async function buildDomainList(api, uniq) {
  const sys = [
    '你是《编程沙箱·哲学协议》的决策域归纳器。',
    '任务：把下面这批「发言自报的决策域」文本（命名各异、粒度很细）归纳成一份【受控的粗粒度决策域清单】。',
    '要求：站在工程决策视角（如 架构 / 性能 / 安全 / 测试 / 数据 / 接口契约 / 发布 / 错误处理 / 依赖构建 / 产品范围 等），',
    `数量控制在 6~${MERGE_MAX_DOMAINS} 个；每个域给「名称（2~6 字）」与「一句话定义」。`,
    '严格只输出一个 JSON 代码块，不要其它文字：',
    '```json',
    '{"domains":[{"name":"架构","desc":"..."}]}',
    '```'
  ].join('\n');
  const body = uniq.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const out = await api.callAPI([{ role: 'system', content: sys }, { role: 'user', content: body }], null, { temperature: 0.2 });
  const obj = extractJson(contentOf(out));
  const arr = obj && Array.isArray(obj.domains) ? obj.domains : [];
  const names = [];
  for (const d of arr) {
    const n = String((d && d.name) || d || '').trim();
    if (n && n !== '其他' && names.indexOf(n) === -1) names.push(n);
  }
  return names.slice(0, MERGE_MAX_DOMAINS);
}

// Stage B：把每条自报域归并到受控清单里的一个（或「其他」）
async function assignAll(api, uniq, names) {
  const listText = names.join('、');
  const chunks = [];
  for (let i = 0; i < uniq.length; i += MERGE_CHUNK) chunks.push(uniq.slice(i, i + MERGE_CHUNK));
  const coarseOf = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const sys = [
        '你是《编程沙箱·哲学协议》的决策域归并器。',
        '从下列【固定决策域清单】中，为每一条「自报域」挑一个最贴近的；清单里都不合适就填「其他」。',
        `清单：${listText}`,
        '严格只输出一个 JSON 代码块：',
        '```json',
        '{"map":{"1":"域名称","2":"其他"}}',
        '```',
        '（键 = 下面自报域的序号，值 = 清单里的名称或「其他」）'
      ].join('\n');
      const body = chunk.map((s, i) => `${i + 1}. ${s}`).join('\n');
      for (let attempt = 0; attempt < MERGE_RETRY; attempt++) {
        try {
          const out = await api.callAPI([{ role: 'system', content: sys }, { role: 'user', content: body }], null, { temperature: 0.1 });
          const obj = extractJson(contentOf(out));
          const map = (obj && obj.map) || {};
          chunk.forEach((s, i) => {
            let v = String(map[String(i + 1)] == null ? '' : map[String(i + 1)]).trim();
            if (names.indexOf(v) === -1) v = '其他';
            coarseOf.set(s, v);
          });
          break;
        } catch (e) {
          if (attempt === MERGE_RETRY - 1) throw e;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MERGE_CONCURRENCY, chunks.length) }, worker));
  return coarseOf;
}

// 用归并后的受控标签算 S0 风格统计（k = 窗内出现过的非「其他」域个数）
function labelWindow(labels) {
  const n = labels.length;
  const set = new Set(labels.filter((x) => x !== '其他'));
  const mapped = labels.filter((x) => x !== '其他').length;
  const count = {};
  labels.forEach((x) => { count[x] = (count[x] || 0) + 1; });
  return {
    n,
    k: set.size,
    labels: set,
    coverage: n > 0 ? mapped / n : 0,
    top: Object.entries(count).filter(([x]) => x !== '其他').sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

function setJaccard(a, b) {
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter++; });
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

async function runMerge(rawWindows) {
  const uniq = [...new Set(rawWindows.flat())];
  const api = new UnifiedAPI();
  console.log(`[归并层 v3] 需归并 ${uniq.length} 个唯一自报域（LLM 两阶段：定清单 → 逐条归并）…`);
  const names = await buildDomainList(api, uniq);
  console.log(`  受控域清单（${names.length} 个）：${names.join('、')}`);
  const coarseOf = await assignAll(api, uniq, names);
  let other = 0;
  for (const v of coarseOf.values()) if (v === '其他') other++;
  console.log(`  归并完成：其他 ${other} / ${coarseOf.size}`);

  const windows = rawWindows.map((items) => labelWindow(items.map((t) => coarseOf.get(t) || '其他')));
  windows.forEach((win, i) => {
    console.log(`\n[W${i + 1}] N=${win.n}  受控域数 k=${win.k}  覆盖=${(win.coverage * 100).toFixed(1)}%`);
    console.log(`  分布: ${win.top.map(([x, c]) => `${x}×${c}`).join('  ')}`);
  });

  console.log('\n' + '-'.repeat(72));
  console.log('S0-a（N≥100，每窗）');
  windows.forEach((win, i) => console.log(`  W${i + 1}: N=${win.n}  ${win.n >= S0A_MIN ? 'PASS' : 'FAIL'}`));

  console.log('\nS0-b（连续 K=3 窗：每窗 k∈[3,24] 且相邻 |Δk|≤1）');
  let bPass = true;
  for (let i = 0; i + K_WINDOWS - 1 < windows.length; i++) {
    const ks = windows.slice(i, i + K_WINDOWS).map((w) => w.k);
    const inRange = ks.every((k) => k >= K_MIN && k <= K_MAX);
    let maxDelta = 0;
    for (let j = 1; j < ks.length; j++) maxDelta = Math.max(maxDelta, Math.abs(ks[j] - ks[j - 1]));
    const ok = inRange && maxDelta <= 1;
    bPass = bPass && ok;
    console.log(`  窗组 [${i + 1}..${i + K_WINDOWS}] k=${ks.join(',')}  极差Δ=${maxDelta}  ${ok ? 'PASS' : 'FAIL'}`);
  }
  if (windows.length < K_WINDOWS) console.log(`  已封窗 ${windows.length} 个 < ${K_WINDOWS}，S0-b 数据不足`);
  else console.log(`  S0-b 总判：${bPass ? 'PASS' : 'FAIL'}`);

  console.log('\nS0-c（相邻窗受控域集合 Jaccard ≥ 0.6）');
  if (windows.length < 2) console.log(`  已封窗 ${windows.length} 个 < 2，S0-c 数据不足`);
  for (let i = 1; i < windows.length; i++) {
    const j = setJaccard(windows[i - 1].labels, windows[i].labels);
    console.log(`  W${i}↔W${i + 1}: Jaccard=${j.toFixed(3)}  ${j >= S0C_MIN ? 'PASS' : 'FAIL'}`);
  }

  console.log('\nS0-d（覆盖 = 归入受控域的 raw 占比 ≥ 0.8）');
  windows.forEach((win, i) => console.log(`  W${i + 1}: ${(win.coverage * 100).toFixed(1)}%  ${win.coverage >= S0D_MIN ? 'PASS' : 'FAIL'}`));
}

async function main() {
  const { rows, files, bad, total, dropped } = loadAll();
  const { windows: rawWindows, fullWindows, remainder } = toWindows(rows);
  console.log('='.repeat(72));
  console.log(`L0 数据：${files.length} 个分片，共 ${total} 条，解析失败 ${bad} 条`);
  if (SINCE_AT) console.log(`新窗过滤：保留 at>=${SINCE_AT} 的 ${rows.length} 条，剔除旧窗 ${dropped} 条`);
  console.log(`口径：${MODE === 'lexical' ? 'v1 字面' : MODE === 'merge' ? 'v3 归并层' : 'v2 语义'}；窗=${WINDOW_SIZE} 条；聚类含 singleton`);
  console.log('='.repeat(72));

  // v3 归并层：不重跑采集，先把自报域归并到受控粗粒度域，再算 S0
  if (MODE === 'merge') {
    await runMerge(rawWindows);
    return;
  }

  const { sim, theta, label, vecOf, uniq } = await buildSimilarity(rawWindows);
  console.log(`\n采用口径：${label}，θ=${theta}`);

  // —— 只读诊断：--scan 不判定，只暴露「相似度分布 + k-θ 曲线」——
  if (MODE === 'scan') {
    const vals = [...vecOf.values()];
    const sims = [];
    for (let i = 0; i < vals.length; i++) {
      for (let j = i + 1; j < vals.length; j++) sims.push(cosineSimilarity(vals[i], vals[j]));
    }
    sims.sort((a, b) => a - b);
    const pct = (p) => sims[Math.min(sims.length - 1, Math.floor(p * sims.length))];
    console.log(`\n[两两余弦分布] 唯一项 ${vals.length}，对数 ${sims.length}`);
    [0.5, 0.9, 0.95, 0.99, 0.999].forEach((p) => console.log(`  P${(p * 100).toFixed(1)} = ${pct(p).toFixed(4)}`));
    console.log(`  max = ${sims[sims.length - 1].toFixed(4)}  min = ${sims[0].toFixed(4)}`);
    console.log('\n[每窗 k 随 θ 变化] 目标 k∈[3,24]');
    const grid = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
    console.log('  θ      ' + rawWindows.map((_, i) => `W${i + 1}-k  W${i + 1}-cov`).join('  '));
    for (const t of grid) {
      const cells = rawWindows.map((items) => {
        const c = clusterWindow(items, sim, t);
        return `${String(c.k).padStart(4)}  ${(c.coverage * 100).toFixed(0).padStart(4)}%`;
      });
      console.log(`  ${t.toFixed(2)}   ${cells.join('  ')}`);
    }
    console.log('\n（--scan 为只读诊断，不判定 S0；判据阈值不变。）');
    return;
  }

  const windows = rawWindows.map((items) => clusterWindow(items, sim, theta));

  windows.forEach((win, i) => {
    console.log(`\n[W${i + 1}] N=${win.n}  簇数 k=${win.k}  singleton=${win.singleton}  覆盖=${(win.coverage * 100).toFixed(1)}%`);
    console.log(`  Top 簇: ${win.topReps.map((t) => `「${t.rep}」×${t.size}`).join('  ')}`);
  });

  console.log('\n' + '-'.repeat(72));
  console.log('S0-a（N≥100，每窗）');
  windows.forEach((win, i) => console.log(`  W${i + 1}: N=${win.n}  ${win.n >= S0A_MIN ? 'PASS' : 'FAIL'}`));

  console.log('\nS0-b（连续 K=3 窗：每窗 k∈[3,24] 且相邻 |Δk|≤1）');
  let bPass = true;
  for (let i = 0; i + K_WINDOWS - 1 < windows.length; i++) {
    const group = windows.slice(i, i + K_WINDOWS);
    const ks = group.map((w) => w.k);
    const inRange = ks.every((k) => k >= K_MIN && k <= K_MAX);
    let maxDelta = 0;
    for (let j = 1; j < ks.length; j++) maxDelta = Math.max(maxDelta, Math.abs(ks[j] - ks[j - 1]));
    const ok = inRange && maxDelta <= 1;
    bPass = bPass && ok;
    console.log(`  窗组 [${i + 1}..${i + K_WINDOWS}] k=${ks.join(',')}  极差Δ=${maxDelta}  ${ok ? 'PASS' : 'FAIL'}`);
  }
  if (windows.length < K_WINDOWS) console.log(`  已封窗 ${windows.length} 个 < ${K_WINDOWS}，S0-b 数据不足`);
  else console.log(`  S0-b 总判：${bPass ? 'PASS' : 'FAIL'}`);

  console.log('\nS0-c（相邻窗簇 Jaccard ≥ 0.6）');
  for (let i = 1; i < windows.length; i++) {
    const j = jaccardBetween(windows[i - 1], windows[i], sim, theta);
    console.log(`  W${i}↔W${i + 1}: Jaccard=${j.toFixed(3)}  ${j >= S0C_MIN ? 'PASS' : 'FAIL'}`);
  }

  console.log('\nS0-d（覆盖 = 非 singleton 簇成员 / N ≥ 0.8）');
  windows.forEach((win, i) => console.log(`  W${i + 1}: ${(win.coverage * 100).toFixed(1)}%  ${win.coverage >= S0D_MIN ? 'PASS' : 'FAIL'}`));

  console.log('\n' + '='.repeat(72));
  console.log(`已封完整窗：${fullWindows}；残留未满窗样本：${remainder}（不计入，待补满再封）`);
}

main().catch((e) => { console.error('分析失败：', e); process.exit(1); });
