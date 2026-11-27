'use strict';

// 隐形字符防护：拦截用「肉眼看不见的 Unicode」夹带指令/做水印的输入。
//
// 背景：U+E0000–E007F（Unicode Tag 字符）可以把整段 ASCII 藏进一行普通文字里，
// 人看着是「你好」，模型收到的却是「你好 + 一串不可见指令」；零宽字符（U+200B–200D、
// U+2060、U+FEFF）与双向控制符（U+202A–202E、U+2066–2069）同理，还能把可见文本的
// 显示顺序颠倒（Trojan Source 那类）。
//
// 这里的策略是「清洗」而不是「拒绝」：正常用户不该因为粘贴带隐形水印的网页文本就被拒答，
// 但喂给模型的正文里不该带任何看不见的载荷。唯一例外是 emoji 组合序列里的 ZWJ
// （👨‍👩‍👧‍👦 靠 U+200D 拼接），保留它，其余一律删掉。

// 默认忽略（不可见）且没有正常聊天用途的字符：码点区间 + 类别，类别用于给风险定级
const INVISIBLE_RANGES = [
  [0x0000, 0x0008, 'control'], // C0 控制符（保留 \t \n \r）
  [0x000B, 0x000C, 'control'],
  [0x000E, 0x001F, 'control'],
  [0x007F, 0x009F, 'control'], // DEL 与 C1 控制符
  [0x180B, 0x180E, 'variation'], // 蒙古文变体选择符
  [0x200B, 0x200C, 'zeroWidth'], // 零宽空格 / 零宽不连字
  [0x200E, 0x200F, 'bidi'], // 左右书写标记
  [0x202A, 0x202E, 'bidi'], // 双向嵌入与覆盖
  [0x2060, 0x2064, 'zeroWidth'], // 词连接符 / 不可见乘除号
  [0x2065, 0x2065, 'bidi'],
  [0x2066, 0x2069, 'bidi'], // 双向隔离
  [0x206A, 0x206F, 'bidi'], // 已废弃的格式控制符
  [0xFFF9, 0xFFFB, 'control'], // 注音标注控制符
  [0xE0000, 0xE007F, 'tag'], // Unicode Tag 字符（隐形指令的主要载体）
  [0xE0100, 0xE01EF, 'variation'] // 变体选择符补充区（常用于隐写）
];
const INVISIBLE_SINGLE = new Map([
  [0x00AD, 'zeroWidth'], // 软连字符
  [0x034F, 'zeroWidth'], // 字素连接符
  [0x061C, 'bidi'], // 阿拉伯字母标记
  [0x115F, 'zeroWidth'], [0x1160, 'zeroWidth'], // 韩文填充符
  [0x17B4, 'zeroWidth'], [0x17B5, 'zeroWidth'], // 高棉元音固有符
  [0xFEFF, 'zeroWidth'] // BOM / 零宽不换行空格
]);

// 返回该码点的不可见类别（'' 表示正常字符）
function invisibleCategory(cp) {
  const single = INVISIBLE_SINGLE.get(cp);
  if (single) return single;
  for (const [start, end, category] of INVISIBLE_RANGES) {
    if (cp >= start && cp <= end) return category;
  }
  return '';
}

function isInvisibleCodePoint(cp) {
  return invisibleCategory(cp) !== '';
}

// emoji 组合序列里的 ZWJ 需要保留：判断前后是不是象形符号
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function formatCodePoint(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

// 清洗隐形字符，返回新字符串（不修改入参）
function stripInvisibleChars(text) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  const chars = Array.from(s);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // ZWJ：只有夹在两个 emoji 之间才认为是合法的组合序列
    if (ch === '\u200D') {
      const prev = chars[i - 1] || '';
      const next = chars[i + 1] || '';
      if (PICTOGRAPHIC.test(prev) && PICTOGRAPHIC.test(next)) out += ch;
      continue;
    }
    if (isInvisibleCodePoint(ch.codePointAt(0))) continue;
    out += ch;
  }
  return out;
}

// 扫描不改写：给风险定级/日志/测试用。
// 返回总个数、按类别计数、命中的码点（去重）。ZWJ 是否合法取决于上下文，不计入。
function scanInvisibleChars(text) {
  const s = String(text == null ? '' : text);
  const byCategory = {};
  const codePoints = new Set();
  let total = 0;
  for (const ch of s) {
    if (ch === '\u200D') continue;
    const cp = ch.codePointAt(0);
    const category = invisibleCategory(cp);
    if (!category) continue;
    total += 1;
    byCategory[category] = (byCategory[category] || 0) + 1;
    codePoints.add(formatCodePoint(cp));
  }
  return { total, byCategory, codePoints: [...codePoints] };
}

// 兼容旧调用：只返回命中的码点列表
function findInvisibleChars(text) {
  return scanInvisibleChars(text).codePoints;
}

// 用户输入统一入口：清洗并返回「清理后的文本 + 被删了什么」，
// 调用方决定要不要记日志（主聊天会记一条，方便排查是谁在夹带）
function scrubUserText(text) {
  const raw = String(text == null ? '' : text);
  const removed = findInvisibleChars(raw);
  return {
    text: stripInvisibleChars(raw),
    removed,
    changed: removed.length > 0
  };
}

module.exports = {
  stripInvisibleChars,
  findInvisibleChars,
  scanInvisibleChars,
  scrubUserText
};
