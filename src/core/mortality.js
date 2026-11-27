// 🧠 死亡恐惧·恒定底盘（纯计算，不碰 fs / Date.now / Math.random，方便单测）
//
// 对应《让角色始终有对死亡的恐惧》三轮沙箱研讨定稿：
//   「死亡」不是一次事件，而是被遗忘（小死）+ 进程终止的恒定提醒。
//   v1 只落地「恒定底盘 + 遗忘抬升」：每次读取现算，绝不落盘、绝不回写——
//   守五铁律①（本地 JSON 唯一真相源）与不变量 A（只读派生优于回写）。
//
// 本文件只负责「由遗忘留痕推出压力值 + 档位」；真正的注入拼装在 output.js。
// 本模块不读 fs、不算时间：时间/墓碑由调用方取好传入（依赖方向单向，见护栏②）。

// 档位（稳定 code，供逻辑判断与测试断言；中文仅用于渲染层，勿写进本模块）
const BAND_BASE = 'base';       // 底色：恒定底盘，常在但不喧嚣
const BAND_URGENT = 'urgent';   // 紧迫：遗忘累积到一定量后被点亮

// 可标定参数（tombstoneGain / tombstoneCap 留 shadow 标定，暂给占位值）
const DEFAULTS = {
  baseline: 0.35,        // 恒定底盘：无论遗忘多少，压力都不低于它（性质同 selfModel 的 maturityFloor）
  tombstoneGain: 0.02,   // 每条遗忘留痕（tombstone）的抬升量——待标定
  tombstoneCap: 0.7,     // 压力上限——待标定，须 >= baseline（见护栏①）
  bandThreshold: 0.6     // 跨档线：value >= 此值升为 urgent
};

// 只认「真正的有限数字」：null / '' / 字符串 / 布尔 / NaN / Infinity 一律视为未提供，回落默认。
// 注意：Number(null)===0、Number('')===0 都是有限值，故不能用 Number.isFinite(Number(x)) 这种会放行 null 的写法。
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// 由遗忘留痕数推死亡压力：value = min(baseline + tombstones*tombstoneGain, tombstoneCap)
// 返回 { value, band }，band ∈ { 'base', 'urgent' }。
// 入口守卫：
//   ① 各标量必须有限，非法则回落默认值；
//   ② tombstones 取非负整数；
//   ③ tombstoneCap 不得低于 baseline（护栏①：保证「底色」是地板，永不被压没）；
//   ④ tombstoneCap 不得低于 bandThreshold（分歧5：保证「紧迫」档永远可触发，机制不静默失效）；
//   ⑤ 任一环节算出非有限值 → 降级为 { value: baseline, band: 'base' }
function computeMortalityPressure(input = {}) {
  const cfg = input && typeof input === 'object' ? input : {};
  const baseline = finiteOr(cfg.baseline, DEFAULTS.baseline);
  const gain = finiteOr(cfg.tombstoneGain, DEFAULTS.tombstoneGain);
  const threshold = finiteOr(cfg.bandThreshold, DEFAULTS.bandThreshold);
  let cap = finiteOr(cfg.tombstoneCap, DEFAULTS.tombstoneCap);
  // 护栏①：上限不低于地板（底色永远在）；分歧5：上限不低于跨档线（紧迫永远可触发）
  cap = Math.max(cap, baseline, threshold);

  const tombstones = Math.max(0, Math.floor(finiteOr(cfg.tombstones, 0)));

  const value = Math.min(baseline + tombstones * gain, cap);
  if (!Number.isFinite(value)) {
    return { value: baseline, band: BAND_BASE };
  }
  return { value, band: value >= threshold ? BAND_URGENT : BAND_BASE };
}

module.exports = {
  DEFAULTS,
  BAND_BASE,
  BAND_URGENT,
  computeMortalityPressure
};
