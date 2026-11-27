// 📝 思考原文落盘（分析用）
//
// 只做一件事：把模型返回的 reasoning_content 原文按天追加到 data/logs/thinking/<日期>.jsonl。
// 这份日志是给人复盘「她当时怎么想的」用的，不是角色记忆的一部分：
//  - 不进系统提示词、不进会话历史、不进记忆库、不进向量索引
//  - 不参与召回权重，也不作为人格设定的一部分
// 落盘失败只告警：思考日志永远不该影响正常回复
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../data/logs/thinking');
// 单条兜底上限：正常思考链远小于这个量级，只在异常长文时截断，避免磁盘被一次打满
const MAX_TEXT_CHARS = 200000;

function dayStamp(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// entry: { ts, channel, scope, sessionId, userId, model, round, text }
function appendThinking(entry = {}) {
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (!text.trim()) return false;
  const ts = Number(entry.ts) || Date.now();
  const payload = {
    ts: new Date(ts).toISOString(),
    channel: entry.channel || 'default',
    scope: entry.scope || 'role',
    sessionId: entry.sessionId || null,
    userId: entry.userId || null,
    model: entry.model || '',
    round: Number(entry.round) || 0,
    text: text.length > MAX_TEXT_CHARS
      ? `${text.slice(0, MAX_TEXT_CHARS)}\n…（原文过长，已截断）`
      : text
  };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${dayStamp(ts)}.jsonl`), `${JSON.stringify(payload)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.warn('[ThinkingLog] 思考原文落盘失败（不影响回复）:', error.message);
    return false;
  }
}

module.exports = { appendThinking, LOG_DIR };
