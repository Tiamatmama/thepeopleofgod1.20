'use strict';

// 🧠 死亡恐惧·shadow 观测落盘（依《死亡恐惧-shadow判据》第二节「只观测、不注入」与第三节落点）
//
// 职责：把每回合的观测样本追加成一行 jsonl。刻意与纯计算的 mortality.js 分离——
// 那个模块不碰 fs（方便单测），这个模块只碰 fs。
// 观测绝不允许打断真实回复主链：任何异常一律吞掉（只告警），不向上抛。

const fs = require('fs');
const path = require('path');

// 落点：data/mortality-shadow/mort-<stamp>.jsonl（data/ 已 gitignore，安全；
// 只往新目录写新文件，绝不改动既有数据文件）。
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'mortality-shadow');

// 时间戳分片到「小时」：既让单文件有界，又能按窗口选取，便于「不跨窗口拼接」的分析纪律。
function stampFor(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}`;
}

// 追加一行观测样本。字段（依判据文档第三节）：at、sessionId、userId、tombstones、value、band。
// 「at」与文件名共用同一个 now，保证同一条样本时间自洽。返回是否写入成功。
function appendMortalityShadow(entry, options = {}) {
  try {
    const dir = options.dir || DEFAULT_DIR;
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const file = path.join(dir, `mort-${stampFor(now)}.jsonl`);
    const record = { at: now, ...(entry && typeof entry === 'object' ? entry : {}) };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (error) {
    console.error('[MortalityShadow] 写入观测日志失败:', error.message);
    return false;
  }
}

module.exports = { appendMortalityShadow, stampFor, DEFAULT_DIR };
