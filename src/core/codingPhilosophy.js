'use strict';

// 🧠 编程沙箱·哲学协议（依《编程沙箱-哲学协议-方案-定稿》§3 / §6）
//
// 本模块是「纯逻辑」：只做开关归一 / 标注 prompt / 标注解析 / 指纹抽取，
// 不碰 fs、不发网络请求——方便单测。真正的落盘在 codingPhilosophyShadow.js。
//
// 当前阶段只落地 L0（原始发言样本观测），且默认 shadow：只观测、不改 discuss 行为。

// 三态开关默认值。与 MORTALITY_LIFECYCLE 同构（off/shadow/live），但默认是 shadow——
// 这是本协议的特性特例（定稿 §0 拍板 #3 / §6）：协议边界本就该从数据里长出来，
// 故缺省即观测；只有显式 'off' 才关、只有显式 'live' 才生效。
const LIFECYCLE_DEFAULT = 'shadow';

// 立场枚举（与 discuss 的表决口径一致，另加「无关」以容纳非表态类发言）。
const STANCES = ['支持', '反对', '存疑', '无关'];

// 指纹上限：单条发言最多留 20 个，防脏文本把样本撑爆。
const FINGERPRINT_CAP = 20;

// 把环境变量归一到三态。缺省 / 非法一律 shadow（本协议特例，非 off）。
function normalizeCodingPhilosophyLifecycle(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'live') return 'live';
  return LIFECYCLE_DEFAULT;
}

// 构造「独立标注小调用」的 messages（拍板：每条发言一次轻量 LLM 调用）。
// 只让模型产出一个极短的 JSON：domain（自报决策域，自由文本）/ stance / hasEvidence。
function buildLabelingMessages(text) {
  const body = String(text == null ? '' : text).trim();
  const system = [
    '你是《编程沙箱·哲学协议》的观测标注器，只做一件事：给一段发言打结构化标签。',
    '严格只输出一个 JSON 代码块，不要任何其它文字：',
    '```json',
    '{"domain":"...","stance":"支持/反对/存疑/无关","hasEvidence":true}',
    '```',
    '字段含义：',
    '- domain：这段发言在「拍板哪个决策域」，用简短自由文本（如「接口设计」「数据一致性」）。',
    '- stance：对当前议题的立场，只能取 支持/反对/存疑/无关 之一。',
    '- hasEvidence：是否给出可追溯证据（引用 文件:行号 / 测试输出 / 外部来源）。'
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: body }
  ];
}

// 解析标注结果。优先取 ```json 代码块，取不到再退化为整段 JSON 解析（宽松取数、
// 严格校验）。任一字段不合法（domain 空 / stance 非枚举 / hasEvidence 非布尔）即判废返回 null。
function parseLabeling(text) {
  const s = String(text == null ? '' : text);
  const m = /```json\s*([\s\S]*?)```/i.exec(s);
  const raw = m ? m[1] : s;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const domain = String(obj.domain == null ? '' : obj.domain).trim();
  if (!domain) return null;
  const stance = String(obj.stance == null ? '' : obj.stance).trim();
  if (STANCES.indexOf(stance) === -1) return null;
  if (typeof obj.hasEvidence !== 'boolean') return null;
  return { domain, stance, hasEvidence: obj.hasEvidence };
}

// 抽取发言里出现的「指纹」（P-M2 新指纹闸门用）：
// ① 文件:行号（如 src/core/codingTeam.js:342）；② 十六进制散列串。去重后限 20 个。
const FILE_LINE_RE = /[\w./\\-]+\.[A-Za-z]{1,6}:\d{1,6}/g;
const HASH_RE = /\b[0-9a-f]{7,40}\b/gi;

function extractFingerprints(text) {
  const s = String(text == null ? '' : text);
  const out = new Set();
  const files = s.match(FILE_LINE_RE);
  if (files) files.forEach((f) => out.add(f));
  const hashes = s.match(HASH_RE);
  if (hashes) hashes.forEach((h) => out.add(h.toLowerCase()));
  return Array.from(out).slice(0, FINGERPRINT_CAP);
}

module.exports = {
  LIFECYCLE_DEFAULT,
  STANCES,
  FINGERPRINT_CAP,
  normalizeCodingPhilosophyLifecycle,
  buildLabelingMessages,
  parseLabeling,
  extractFingerprints
};
