// 📉 遗忘参数标定（方向三）：离线、只读、0 模型成本。
//
// 读 data/user_memories/*.json（真实记忆档）+ data/sessions/*.json（取最近活动时间当「现在」），
// 用 memoryLifecycle 的遗忘曲线重放时间轴，输出：
//   1) 数据概览：可衰减条数 / 耐久条数 / |value| 与年龄分布
//   2) 半衰期分组：验证「情绪高光留存久、琐事淡出快」——本轮的验收项
//   3) 当前快照：默认参数下的留存分布与「风险条数」（将被归档 / 删除的条数）
//   4) 参数网格扫描：S0/K 决定区分度，archiveRetention/pruneRetention 决定归档/删除线
// 本脚本只读，不改动任何数据文件。
// 用法：node scripts/calibrate-forgetting.js
const fs = require('fs');
const path = require('path');
const {
  DEFAULTS, isDurable, stabilityDays, computeRetention
} = require('../src/core/memoryLifecycle');

const DAY = 86400000;
const memDir = path.join(__dirname, '..', 'data', 'user_memories');
const sessionDir = path.join(__dirname, '..', 'data', 'sessions');

// 载入所有用户记忆档（跳过 .bak / 隔离文件——它们不以 .json 结尾）
function loadStores() {
  if (!fs.existsSync(memDir)) return [];
  const stores = [];
  for (const file of fs.readdirSync(memDir)) {
    if (!file.endsWith('.json') || file.includes('.bak')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(memDir, file), 'utf8'));
      stores.push({
        key: file.replace(/\.json$/, ''),
        memories: Array.isArray(data.memories) ? data.memories : []
      });
    } catch (error) {
      console.warn(`[skip] 解析失败 ${file}: ${error.message}`);
    }
  }
  return stores;
}

// 用会话里最晚的活动时间作为「现在」；会话缺失时回退到记忆里的最晚时间戳
function loadPresentTime(memories) {
  let latest = 0;
  if (fs.existsSync(sessionDir)) {
    for (const file of fs.readdirSync(sessionDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
        latest = Math.max(latest, Number(s.updatedAt) || 0, Number(s.createdAt) || 0);
        const users = s.users && typeof s.users === 'object' ? Object.values(s.users) : [];
        for (const u of users) {
          for (const turn of (Array.isArray(u.conversationHistory) ? u.conversationHistory : [])) {
            latest = Math.max(latest, Number(turn && turn.timestamp) || 0);
          }
        }
      } catch (error) {
        console.warn(`[skip] 会话解析失败 ${file}: ${error.message}`);
      }
    }
  }
  for (const m of memories) {
    latest = Math.max(latest, Number(m && m.timestamp) || 0, Number(m && m.lastRecallAt) || 0);
  }
  return latest || Date.now();
}

function mean(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
}

function median(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fixed(x, d = 2) {
  return Number.isFinite(x) ? x.toFixed(d) : '-';
}

// |value| 分档：情绪高光 / 中性 / 琐事闲聊
function valueBucket(memory) {
  const v = Math.abs(Number(memory && memory.value) || 0);
  if (v >= 0.6) return '情绪高光';
  if (v >= 0.3) return '中性';
  return '琐事闲聊';
}

function ageBucket(ageDays) {
  if (ageDays < 1) return '<1天';
  if (ageDays < 7) return '1~7天';
  if (ageDays < 30) return '7~30天';
  if (ageDays < 90) return '30~90天';
  return '>90天';
}

// ---------- 载入 ----------
const stores = loadStores();
const allMemories = stores.flatMap((s) => s.memories);
const present = loadPresentTime(allMemories);

// 只对「可衰减」条目做遗忘分析：耐久条目（受保护摘要 / 钉住 / 语义记忆）本就不进曲线
const ephemeral = allMemories.filter((m) => m && typeof m === 'object' && !isDurable(m));
const durable = allMemories.length - ephemeral.length;

// 逐条算：年龄、默认参数下的半衰期与当前留存
const rows = ephemeral.map((m) => {
  const last = Number(m.lastRecallAt) || Number(m.timestamp) || present;
  const ageDays = Math.max(0, (present - last) / DAY);
  const halfLife = stabilityDays(m) * Math.LN2;
  const retention = computeRetention(m, present);
  return { m, ageDays, halfLife, retention, bucket: valueBucket(m) };
});

console.log('=== 遗忘参数标定（离线，只读，未写入任何数据）===');
console.log(`数据源：${stores.length} 个记忆档（data/user_memories）+ data/sessions`);
console.log(`「现在」= ${new Date(present).toISOString()}`);

// ---------- 1. 概览 ----------
console.log('\n【1】数据概览');
console.log(`  记忆总条数 ${allMemories.length}：可衰减（情景）${ephemeral.length} 条，耐久（受保护/钉住/语义）${durable} 条`);
if (ephemeral.length === 0) {
  console.log('  ⚠️ 没有可衰减的记忆，无法标定（需要先积累真实对话记忆）');
}
const byValue = { '情绪高光': 0, '中性': 0, '琐事闲聊': 0 };
const byAge = { '<1天': 0, '1~7天': 0, '7~30天': 0, '30~90天': 0, '>90天': 0 };
for (const r of rows) {
  byValue[r.bucket]++;
  byAge[ageBucket(r.ageDays)]++;
}
console.log('  |value| 分档：' + Object.entries(byValue).map(([k, v]) => `${k} ${v}`).join(' / '));
console.log('  年龄分档：' + Object.entries(byAge).map(([k, v]) => `${k} ${v}`).join(' / '));
if (ephemeral.length < 20) {
  console.log('  ⚠️ 可衰减样本偏少，标定结论仅供参考（可先跑看数据量）');
}

// ---------- 2. 半衰期分组（验收：高光 ≫ 琐事）----------
console.log('\n【2】半衰期分组（默认参数 S0=' + DEFAULTS.s0Days + ', K=' + DEFAULTS.kSalience + '）');
const groups = { '情绪高光': [], '中性': [], '琐事闲聊': [] };
for (const r of rows) groups[r.bucket].push(r.halfLife);
for (const [name, list] of Object.entries(groups)) {
  console.log(`  ${name}：${list.length} 条  半衰期中位 ${fixed(median(list))} 天 / 均值 ${fixed(mean(list))} 天`);
}
const hi = median(groups['情绪高光']);
const lo = median(groups['琐事闲聊']);
if (hi > 0 && lo > 0) {
  const ratio = hi / lo;
  const verdict = ratio >= 1.5 ? '达标 ✔' : '偏弱 ✘';
  console.log(`  高光/琐事 半衰期比值 ≈ ${fixed(ratio)}  → 情绪高光留存更久 ${verdict}`);
} else {
  console.log('  ⚠️ 缺少「情绪高光」或「琐事闲聊」样本，无法计算区分度');
}

// ---------- 3. 当前快照（默认参数）----------
console.log('\n【3】当前快照（默认参数 S0=' + DEFAULTS.s0Days + ', K=' + DEFAULTS.kSalience
  + ', 归档线=' + DEFAULTS.archiveRetention + ', 删除线=' + DEFAULTS.pruneRetention + '）');
const bins = { '0~0.05': 0, '0.05~0.3': 0, '0.3~0.6': 0, '0.6~1': 0 };
let atRisk = 0;
let doomed = 0;
for (const r of rows) {
  const v = r.retention;
  if (v < 0.05) bins['0~0.05']++;
  else if (v < 0.3) bins['0.05~0.3']++;
  else if (v < 0.6) bins['0.3~0.6']++;
  else bins['0.6~1']++;
  if (v <= DEFAULTS.archiveRetention) atRisk++;
  if (v <= DEFAULTS.pruneRetention && (Number(r.m.recallCount) || 0) === 0) doomed++;
}
console.log('  留存分布：' + Object.entries(bins).map(([k, v]) => `${k} ${v}`).join(' / '));
console.log(`  风险条数：低于归档线 ${atRisk} 条（将被降为 archived，仍保留）；低于删除线且从未召回 ${doomed} 条（将被彻底删除）`);

// ---------- 4. 参数网格扫描 ----------
console.log('\n【4】参数网格扫描（只读推演，不落盘）');
console.log('  S0×K 决定区分度与绝对量级（半衰期 = S0·(1+K·salience)·ln2）：');
console.log('    S0\\K ' + [1, 2, 3, 4].map((k) => `K=${k}`.padEnd(24)).join(''));
const halfLifeWith = (m, s0, k) => stabilityDays(m, { s0Days: s0, kSalience: k }) * Math.LN2;
for (const s0 of [3, 7, 14, 21]) {
  let line = `    ${String(s0).padEnd(4)} `;
  for (const k of [1, 2, 3, 4]) {
    const hiList = rows.filter((r) => r.bucket === '情绪高光').map((r) => halfLifeWith(r.m, s0, k));
    const loList = rows.filter((r) => r.bucket === '琐事闲聊').map((r) => halfLifeWith(r.m, s0, k));
    const hm = median(hiList);
    const lm = median(loList);
    const ratio = lm > 0 ? (hm / lm) : 0;
    line += `高${fixed(hm, 1)}/琐${fixed(lm, 1)} 比${fixed(ratio, 1)}`.padEnd(24) + ' ';
  }
  console.log(line);
}
console.log('  → K 越大「高光 vs 琐事」区分度越高（比值随 K 单调升）；S0 只整体缩放半衰期，不改变比值。');

console.log('\n  归档线 archiveRetention（把当前留存已低于该线的条数改为 archived）：');
for (const ar of [0.2, 0.3, 0.4, 0.5]) {
  const n = rows.filter((r) => r.retention <= ar).length;
  console.log(`    archiveRetention=${ar} → 归档 ${n} / ${rows.length} 条`);
}
console.log('  删除线 pruneRetention（留存低于该线且从未召回的条数 → 彻底删除）：');
for (const pr of [0.03, 0.05, 0.1, 0.2]) {
  const n = rows.filter((r) => r.retention <= pr && (Number(r.m.recallCount) || 0) === 0).length;
  console.log(`    pruneRetention=${pr} → 删除 ${n} / ${rows.length} 条`);
}

// ---------- 建议 ----------
console.log('\n【建议】');
console.log(`  默认 K=${DEFAULTS.kSalience} 下高光/琐事 半衰期比值 ≈ ${fixed(hi > 0 && lo > 0 ? hi / lo : 0)}（目标 ≥ 1.5）。`);
console.log('  想拉开区分度就调大 K（已定 K=3 时比值 ≈ 1.6）；S0 只决定「整体记多久」，按需要的绝对时长选：');
console.log('    半衰期 ≈ S0·(1+K·salience)·ln2 —— S0=7/K=3 时高光≈14.3 天、琐事≈9.2 天。');
console.log('  归档/删除线决定「多淡才算想起不来」：默认 0.3/0.05 下，当前数据约 '
  + rows.filter((r) => r.retention <= DEFAULTS.archiveRetention).length + ' 条进归档池、'
  + rows.filter((r) => r.retention <= DEFAULTS.pruneRetention && (Number(r.m.recallCount) || 0) === 0).length + ' 条被删除。');

console.log('\n完成（dry-run，未写入任何数据）。若要调整真实参数，请改 src/core/memoryLifecycle.js 的 DEFAULTS 并跑测试。');
