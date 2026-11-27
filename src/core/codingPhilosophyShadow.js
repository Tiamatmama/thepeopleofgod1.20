'use strict';

// 🧠 编程沙箱·哲学协议·L0 观测落盘（依《编程沙箱-哲学协议-方案-定稿》§3）
//
// 与纯逻辑的 codingPhilosophy.js 刻意分离：那个模块只做计算、不碰 fs，这个模块只碰 fs。
// 观测绝不允许打断 discuss 主链：任何异常一律吞掉（只告警），不向上抛。

const fs = require('fs');
const path = require('path');

// 落点：data/coding-philosophy/<stamp>.jsonl（data/ 已 gitignore，安全；
// 只往新目录写新文件，绝不改动既有数据文件）。
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'coding-philosophy');

// 时间戳分片到「小时」：既让单文件有界，又能按窗口选取，便于「不跨窗口拼接」的分析纪律
// （与死亡恐惧-shadow 的 mort-<stamp> 同粒度）。
function stampFor(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}`;
}

// 追加一行观测样本（一行 = 一条发言）。字段见定稿 §3；「at」与文件名共用同一个 now，
// 保证同一条样本时间自洽。返回是否写入成功。
function appendPhilosophySample(entry, options = {}) {
  try {
    const dir = options.dir || DEFAULT_DIR;
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const file = path.join(dir, `${stampFor(now)}.jsonl`);
    const record = { at: now, ...(entry && typeof entry === 'object' ? entry : {}) };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (error) {
    console.error('[CodingPhilosophyShadow] 写入观测日志失败:', error.message);
    return false;
  }
}

module.exports = { appendPhilosophySample, stampFor, DEFAULT_DIR };
