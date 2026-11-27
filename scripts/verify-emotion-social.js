// 社会人物交际测试：模拟「她」遇到的各种社会人物，观察情绪状态层如何被牵动。
// 走真实链路：InputModule.deriveSentimentValue（语义→标量）+ deriveEmotionSignals（多标签）
//           → EmotionModule.updateEmotion。
//
// 数据量模型（贴近真实聊天，但时间轴在脚本内快进，不真的等）：
//   · 每天 30 条消息，分 3 轮，轮内 3 分钟一条，轮间 6 小时，跨天 10 小时；
//   · 先跑 30 天「预热期」把长期情感底色（慢层/基线）养到稳定 = 出现长期情感；
//   · 再跑 10 天「观测期」= 题目要求的「往后的十天聊天消息量」，报告终态与波动。
//   · 每个样本 = 40 天 ≈ 1200 条消息；剧本 8 个 + 矩阵 4×8 个，合计约 4.8 万次更新。
// 测试档统一 __sim__ 前缀，结束清理；仿真期间打桩 save() 以免每次写盘拖慢脚本。
const fs = require('fs');
const path = require('path');
const EmotionModule = require('../src/core/emotion.js');
const InputModule = require('../src/core/input.js');

const STORAGE = path.join(__dirname, '../data/emotion_state.json');
const existedBefore = fs.existsSync(STORAGE);
const U = 'sim-user';
const derive = InputModule.prototype.deriveSentimentValue;        // 纯函数，不依赖 this
const deriveSignals = InputModule.prototype.deriveEmotionSignals; // 纯函数，不依赖 this

const m = new EmotionModule();
const MIN = 60 * 1000;

// 仿真期间不落盘（数万次 writeFileSync 会让脚本奇慢）；结束时恢复再统一保存
const realSave = EmotionModule.prototype.save;
EmotionModule.prototype.save = function noopSave() {};

// —— 时间与消息量模型 ——
const PER_DAY = 30;                 // 每天 30 条消息
const ROUNDS = 3;                   // 每天 3 轮对话
const PER_ROUND = PER_DAY / ROUNDS; // 每轮 10 条
const IN_ROUND_GAP = 3;             // 轮内 3 分钟一条
const BETWEEN_ROUND_GAP = 6 * 60;   // 轮之间 6 小时
const BETWEEN_DAY_GAP = 10 * 60;    // 跨天 10 小时
const WARMUP_DAYS = 30;             // 预热：养出长期情感底色
const OBSERVE_DAYS = 10;            // 观测：往后的十天

// 把「N 天 × 每天 PER_DAY 条」展开成带真实间隔的事件序列；mood(i) 决定第 i 条的情绪
function chats(days, mood) {
  const events = [];
  let i = 0;
  for (let d = 0; d < days; d++) {
    for (let r = 0; r < ROUNDS; r++) {
      for (let k = 0; k < PER_ROUND; k++) {
        let gapMin;
        if (k > 0) gapMin = IN_ROUND_GAP;
        else if (r > 0) gapMin = BETWEEN_ROUND_GAP;
        else if (d > 0) gapMin = BETWEEN_DAY_GAP;
        else gapMin = 1;
        events.push({ gapMin, ...mood(i) });
        i++;
      }
    }
  }
  return events;
}

// 核心仿真：在指定会话上跑事件序列，返回轨迹与终态
function simulate(S, events) {
  const st = m.getEmotionState(S, U);
  const fastTrail = new Array(events.length);
  const slowTrail = new Array(events.length);
  const now = Date.now();
  events.forEach((ev, idx) => {
    st.fastAt -= ev.gapMin * MIN;
    st.slowAt -= ev.gapMin * MIN;
    st.baselineAt -= ev.gapMin * MIN;
    const semantic = {
      emotion: { type: ev.type, intensity: ev.intensity },
      emotions: ev.emotions || [{ type: ev.type, intensity: ev.intensity }]
    };
    m.updateEmotion(derive.call({}, semantic), S, U, deriveSignals.call({}, semantic));
    const proj = m.projectState(st, now);
    fastTrail[idx] = proj.fast;
    slowTrail[idx] = proj.slow;
  });
  const proj = m.projectState(st, now);
  return { fast: proj.fast, slow: proj.slow, baseline: { ...st.baseline }, fastTrail, slowTrail };
}

const dominant = (vec, list) => list.reduce((a, b) => (vec[b] > vec[a] ? b : a), list[0]);
const EMO = ['happy', 'sad', 'shy', 'anxious', 'jealous', 'dependent', 'calm'];
const col = (trail, key) => trail.map((x) => x[key]);
const range = (arr) => Math.max(...arr) - Math.min(...arr);
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const share = (trail, dim) => trail.filter((x) => dominant(x, EMO) === dim).length / trail.length;

// —— 情绪基调（供剧本与矩阵复用）——
const HAPPY = () => ({ type: 'happy', intensity: 0.75 });
const HAPPY_STRONG = () => ({ type: 'happy', intensity: 0.85 });
const ANGRY = () => ({ type: 'angry', intensity: 0.85 });
const ANGRY_STRONG = () => ({ type: 'angry', intensity: 0.9 });
const CALM = () => ({ type: 'calm', intensity: 0.45 });
const ANX = () => ({ type: 'anxious', intensity: 0.8 });
const JEALOUS = () => ({ type: 'jealous', intensity: 0.7, emotions: [{ type: 'jealous', intensity: 0.7 }, { type: 'angry', intensity: 0.4 }] });
const DEPENDENT = () => ({ type: 'dependent', intensity: 0.7 });
const SHY = () => ({ type: 'shy', intensity: 0.6 });
const FLIP = (i) => (i % 2 === 0 ? HAPPY() : ANGRY()); // 忽冷忽热

// —— 各社会人物：warmup 建立长期情感，observe 为观测期的互动 ——
const scripts = {
  '甜言蜜语的追求者': { warmup: HAPPY, observe: HAPPY },
  '毒舌黑粉/喷子': { warmup: ANGRY, observe: ANGRY },
  '忽冷忽热的暧昧对象': { warmup: FLIP, observe: FLIP },
  '先暖后背叛的旧人': { warmup: HAPPY, observe: ANGRY }, // 30 天被暖 → 观测期背刺
  '冷淡的路人': { warmup: CALM, observe: CALM },
  '情敌/竞争者': { warmup: JEALOUS, observe: JEALOUS },
  '黏人的依赖者': { warmup: DEPENDENT, observe: DEPENDENT },
  '被夸害羞的人': { warmup: SHY, observe: SHY }
};

console.log(`\n=== 社交人物 → 情绪终态（${WARMUP_DAYS}天预热 + ${OBSERVE_DAYS}天观测，每天${PER_DAY}条 ≈ 每样本${(WARMUP_DAYS + OBSERVE_DAYS) * PER_DAY}条）===`);
const results = {};
Object.entries(scripts).forEach(([name, def]) => {
  const warmCount = chats(WARMUP_DAYS, def.warmup).length;
  const events = [...chats(WARMUP_DAYS, def.warmup), ...chats(OBSERVE_DAYS, def.observe)];
  const r = simulate(`__sim__${name}`, events);
  r.warmCount = warmCount;
  results[name] = r;
  const fd = dominant(r.fast, EMO);
  const sd = dominant(r.slow, EMO);
  const bd = dominant(r.baseline, EMO);
  // 观测期（最后 OBSERVE_DAYS 天）内的主导情绪占比，比单点终态更能代表长期行为
  const obsTrail = r.fastTrail.slice(warmCount);
  console.log(
    `\n【${name}】共 ${events.length} 条（预热 ${warmCount} + 观测 ${events.length - warmCount}）\n` +
    `  终态快层主导: ${fd}(${r.fast[fd].toFixed(3)})   happy=${r.fast.happy.toFixed(3)} sad=${r.fast.sad.toFixed(3)} anxious=${r.fast.anxious.toFixed(3)}\n` +
    `  慢层主导: ${sd}(${r.slow[sd].toFixed(3)})   基线主导: ${bd}(${r.baseline[bd].toFixed(3)})\n` +
    `  观测期主导占比: ${EMO.map((e) => `${e}=${(share(obsTrail, e) * 100).toFixed(0)}%`).filter((s) => !s.endsWith('=0%')).join(' ')}`
  );
});

// —— 判定：情绪是否真的被「社会输入」牵动 ——
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ` (${extra})` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` (${extra})` : ''}`); }
}

console.log('\n=== 判定 ===');
{
  const r = results['甜言蜜语的追求者'];
  const obs = r.fastTrail.slice(r.warmCount);
  ok('被长期善待 → 快层稳定 happy 主导', share(obs, 'happy') > 0.8, `占比=${(share(obs, 'happy') * 100).toFixed(0)}%`);
  ok('被长期善待 → 慢层/基线变暖（长期底色被改写）', r.slow.happy > 0.3, `slow.happy=${r.slow.happy.toFixed(3)}`);
}
{
  const r = results['毒舌黑粉/喷子'];
  const obs = r.fastTrail.slice(r.warmCount);
  const d = dominant(r.fast, EMO);
  ok('被长期攻击 → 快层转向 sad/anxious', d === 'sad' || d === 'anxious', `${d}=${r.fast[d].toFixed(3)}`);
  ok('被长期攻击 → 观测期稳定负向', share(obs, 'sad') + share(obs, 'anxious') > 0.8,
    `负向占比=${((share(obs, 'sad') + share(obs, 'anxious')) * 100).toFixed(0)}%`);
}
{
  const r = results['冷淡的路人'];
  const d = dominant(r.fast, EMO);
  ok('冷淡路人 → 状态基本不动（calm 主导）', d === 'calm', `${d}`);
  ok('冷淡路人 → 未诱发 happy/sad 大幅偏移', r.fast.happy < 0.45 && r.fast.sad < 0.1,
    `happy=${r.fast.happy.toFixed(3)} sad=${r.fast.sad.toFixed(3)}`);
}
{
  const r = results['忽冷忽热的暧昧对象'];
  const obs = r.fastTrail.slice(r.warmCount);
  const fastRange = range(col(obs, 'sad'));
  const slowRange = range(r.slowTrail.slice(r.warmCount).map((x) => x.sad));
  ok('忽冷忽热 → 快层在观测期持续大幅波动（远大于慢层）', fastRange > 0.15 && fastRange > slowRange * 3,
    `fast.sad 波幅=${fastRange.toFixed(3)} vs slow=${slowRange.toFixed(3)}`);
  ok('忽冷忽热 → 慢层被明显抑制（吵一次不崩关系）', slowRange < fastRange * 0.5,
    `slow.sad 波幅=${slowRange.toFixed(3)} vs fast=${fastRange.toFixed(3)}`);
}
{
  const r = results['先暖后背叛的旧人'];
  const idx = r.warmCount; // 观测期第一条 = 背叛
  const fastJump = r.fastTrail[idx].sad - r.fastTrail[idx - 1].sad;
  const slowJump = r.slowTrail[idx].sad - r.slowTrail[idx - 1].sad;
  ok('背叛瞬间 → 快层急转', fastJump > 0.2, `Δfast.sad=${fastJump.toFixed(3)}`);
  ok('背叛瞬间 → 慢层不崩塌（跌幅远小于快层）', slowJump < fastJump * 0.5,
    `Δslow.sad=${slowJump.toFixed(3)} vs Δfast=${fastJump.toFixed(3)}`);
  ok('长期被暖后又遭背叛 → 基线保留正向残留（回不到冷原点）', r.baseline.happy > 0.1,
    `baseline.happy=${r.baseline.happy.toFixed(3)}`);
}
{
  console.log('\n[结构性观察] 全部剧本中快层终态可达的最大值：'
    + `jealous=${Math.max(...Object.values(results).map((r) => r.fast.jealous)).toFixed(4)} `
    + `dependent=${Math.max(...Object.values(results).map((r) => r.fast.dependent)).toFixed(4)} `
    + `shy=${Math.max(...Object.values(results).map((r) => r.fast.shy)).toFixed(4)}`);
  ok('情敌场景触发 jealous', results['情敌/竞争者'].fast.jealous > 0.1, `jealous=${results['情敌/竞争者'].fast.jealous.toFixed(4)}`);
  ok('依赖场景触发 dependent', results['黏人的依赖者'].fast.dependent > 0.1, `dependent=${results['黏人的依赖者'].fast.dependent.toFixed(4)}`);
  ok('害羞场景触发 shy', results['被夸害羞的人'].fast.shy > 0.1, `shy=${results['被夸害羞的人'].fast.shy.toFixed(4)}`);
  ok('情敌场景的复合情绪（jealous+angry→anxious）并存', results['情敌/竞争者'].fast.anxious > 0.05,
    `anxious=${results['情敌/竞争者'].fast.anxious.toFixed(4)}`);
}

// ══════════════════════════════════════════════════════════════════
// 交叉矩阵：不同「长期情感底色」× 不同「情绪输入」→ 观测期终态
// 底色 = 30 天诱导出的长期情感；观测期 = 之后 10 天遇到某种情绪输入。
// 目的：验证情绪反应不是输入的无状态函数——同一个人、同样的输入，
//       在既有长期情感不同时，被激起的情绪（含主导与残留）应当不一样。
// ══════════════════════════════════════════════════════════════════
const BASES = {
  '中性': CALM,
  '暖': HAPPY_STRONG,
  '冷': ANGRY_STRONG,
  '虑': ANX
};
const PROBES = [
  { name: 'happy', dim: 'happy', mood: HAPPY },
  { name: 'angry', dim: 'sad', mood: ANGRY },
  { name: 'jealous', dim: 'jealous', mood: JEALOUS },
  { name: 'dependent', dim: 'dependent', mood: DEPENDENT },
  { name: 'shy', dim: 'shy', mood: SHY },
  { name: 'anxious', dim: 'anxious', mood: ANX },
  { name: 'calm', dim: 'calm', mood: CALM },
  { name: '复合(j+d)', dim: 'jealous', mood: () => ({ type: 'jealous', intensity: 0.7, emotions: [{ type: 'jealous', intensity: 0.7 }, { type: 'dependent', intensity: 0.7 }] }) }
];

const baseNames = Object.keys(BASES);
const warmupCache = {};
baseNames.forEach((b) => { warmupCache[b] = chats(WARMUP_DAYS, BASES[b]); });
const matrix = {};
baseNames.forEach((baseName) => {
  matrix[baseName] = {};
  PROBES.forEach((probe) => {
    const events = [...warmupCache[baseName], ...chats(OBSERVE_DAYS, probe.mood)];
    matrix[baseName][probe.name] = simulate(`__sim__mx-${baseName}-${probe.name}`, events);
  });
});

console.log('\n=== 交叉矩阵：长期底色 × 情绪输入 → 观测期终态（主导 + 前三位）===');
PROBES.forEach((probe) => {
  console.log(`\n▸ 输入 ${probe.name}（目标维 ${probe.dim}）`);
  baseNames.forEach((b) => {
    const r = matrix[b][probe.name];
    const d = dominant(r.fast, EMO);
    const top = EMO.slice().sort((x, y) => r.fast[y] - r.fast[x]).slice(0, 3)
      .map((e) => `${e}=${r.fast[e].toFixed(3)}`).join('  ');
    console.log(`    ${b.padEnd(4)} 主导=${d}(${r.fast[d].toFixed(3)})   ${top}`);
  });
});

console.log('\n=== 交叉矩阵判定 ===');
// 1) 强输入能主导快层：无论既有底色，probe 的目标维都应是快层主导情绪
{
  const EXPECT = { happy: 'happy', angry: 'sad', jealous: 'jealous', dependent: 'dependent', shy: 'shy', anxious: 'anxious', calm: 'calm' };
  const bad = [];
  Object.entries(EXPECT).forEach(([probeName, dim]) => {
    baseNames.forEach((b) => {
      const d = dominant(matrix[b][probeName].fast, EMO);
      if (d !== dim) bad.push(`${b}+${probeName}→${d}`);
    });
  });
  ok('强输入能主导快层（底色只改残留/强度，不改主导）', bad.length === 0,
    bad.length ? bad.join(',') : '7 输入 × 4 底色 全通过');
}
// 2) 中性底：输入不留反向残留
{
  const r = matrix['中性']['happy'].fast;
  ok('中性底：一次输入不留下反向情绪残留', r.sad < 0.05 && r.anxious < 0.05,
    `sad=${r.sad.toFixed(3)} anxious=${r.anxious.toFixed(3)}`);
}
// 3) 有色底：残留可见，且一次反向输入洗不掉
{
  const r = matrix['暖']['angry'].fast;
  ok('暖底：被攻击后正向残留仍在（关系不是一次吵没）', r.happy > 0.2, `happy=${r.happy.toFixed(3)}`);
}
{
  const r = matrix['冷']['happy'].fast;
  ok('冷底：被善待后负向残留仍在（一次友善洗不掉长期冷淡）', r.sad > 0.1, `sad=${r.sad.toFixed(3)}`);
}
{
  const r = matrix['虑']['happy'].fast;
  ok('虑底：被善待后焦虑残留仍在', r.anxious > 0.1, `anxious=${r.anxious.toFixed(3)}`);
}
// 4) 底色放大同向输入（既有情感状态调制反应强度）
//    注意：同向输入持续 10 天后，慢层会重新收敛到同一稳态，终态差异被抹平；
//    放大体现在「即时反应」——观测期第一条消息引起的跳变，这才是底色真正的作用。
{
  const WARM_COUNT = WARMUP_DAYS * PER_DAY; // 观测期第一条的下标
  const cold = matrix['冷']['angry'].fastTrail[WARM_COUNT].sad;
  const neutral = matrix['中性']['angry'].fastTrail[WARM_COUNT].sad;
  ok('冷底放大同向负性输入的即时反应（攻击更痛）', cold > neutral, `冷=${cold.toFixed(3)} > 中性=${neutral.toFixed(3)}`);
}
{
  const WARM_COUNT = WARMUP_DAYS * PER_DAY;
  const anx = matrix['虑']['anxious'].fastTrail[WARM_COUNT].anxious;
  const neutral = matrix['中性']['anxious'].fastTrail[WARM_COUNT].anxious;
  ok('虑底放大焦虑输入的即时反应（焦虑叠加）', anx > neutral, `虑=${anx.toFixed(3)} > 中性=${neutral.toFixed(3)}`);
}
// 5) 复合情绪双信号并发
{
  const r = matrix['中性']['复合(j+d)'];
  ok('复合情绪双信号并发（jealous+dependent 同帧分别驱动）',
    r.fast.jealous > 0.3 && r.fast.dependent > 0.3,
    `jealous=${r.fast.jealous.toFixed(3)} dependent=${r.fast.dependent.toFixed(3)}`);
}
// 6) 去 calm 陪跑
{
  const r = matrix['中性']['happy'];
  ok('去 calm 陪跑：正向输入下 calm 不再抢主导',
    r.fast.calm < r.fast.happy, `calm=${r.fast.calm.toFixed(3)} vs happy=${r.fast.happy.toFixed(3)}`);
}

// —— 清理 ——
EmotionModule.prototype.save = realSave; // 恢复真实落盘
Object.keys(m.states).forEach((k) => { if (k.startsWith('__sim__')) delete m.states[k]; });
m.save();
if (!existedBefore) {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORAGE, 'utf8'));
    if (!parsed.states || Object.keys(parsed.states).length === 0) fs.unlinkSync(STORAGE);
  } catch (_) { /* ignore */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
