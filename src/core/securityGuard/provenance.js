/**
 * 父本账本：记录「谁、什么时候、从哪弄进来的、改了什么」
 *
 * 用途是出事后的追溯，不是拦截：一个文件被扫描器判为可疑时，
 * 能顺藤摸瓜找到它是模型这次生成的、从某个 URL 下载的、还是导入项目带进来的。
 * 只记经过本系统的动作，系统外的程序追不到。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const DEFAULT_FILE = path.join(ROOT, 'data', 'security', 'provenance.jsonl');
const ALLOWED_ACTIONS = new Set(['write', 'exec', 'install', 'import', 'delete']);
const ALLOWED_SOURCES = new Set(['model', 'user', 'download', 'import', 'dependency', 'unknown']);
const MAX_HASH_BYTES = 4 * 1024 * 1024;

function fileSha256(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

class ProvenanceLedger {
  constructor(options = {}) {
    this.file = options.file || DEFAULT_FILE;
    // 超过上限就轮转：只留最近 keepLines 条，避免账本无限长大
    this.maxBytes = options.maxBytes || 4 * 1024 * 1024;
    this.keepLines = options.keepLines || 3000;
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  /**
   * @param {{action:string, path?:string, source?:string, command?:string,
   *          actor?:object, level?:string, blocked?:boolean, reason?:string, detail?:string}} entry
   */
  record(entry) {
    const action = ALLOWED_ACTIONS.has(entry.action) ? entry.action : 'unknown';
    const source = ALLOWED_SOURCES.has(entry.source) ? entry.source : 'unknown';
    const record = {
      time: new Date().toISOString(),
      action,
      source,
      path: entry.path ? String(entry.path) : undefined,
      // 文件已经存在就顺手算哈希；调用方明确传 hash:false 时跳过
      sha256: entry.sha256 || (entry.hash === false ? undefined : (entry.path ? fileSha256(entry.path) : undefined)),
      command: entry.command ? String(entry.command).slice(0, 300) : undefined,
      actor: entry.actor && typeof entry.actor === 'object' ? entry.actor : undefined,
      level: entry.level || undefined,
      blocked: entry.blocked === true ? true : undefined,
      reason: entry.reason ? String(entry.reason).slice(0, 300) : undefined,
      detail: entry.detail ? String(entry.detail).slice(0, 300) : undefined
    };
    try {
      this.ensureDir();
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
      this.compactIfNeeded();
    } catch (error) {
      console.warn(`[安全账本] 写入失败: ${error.message}`);
    }
    return record;
  }

  compactIfNeeded() {
    try {
      if (fs.statSync(this.file).size <= this.maxBytes) return;
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-this.keepLines).join('\n');
      fs.writeFileSync(this.file, kept ? `${kept}\n` : '', 'utf8');
    } catch (error) {
      console.warn(`[安全账本] 轮转失败: ${error.message}`);
    }
  }

  readAll() {
    try {
      return fs.readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return { raw: line }; }
        });
    } catch {
      return [];
    }
  }

  // 最近的在前；limit 收敛到 1~500
  recent(limit = 50) {
    const size = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    return this.readAll().slice(-size).reverse();
  }

  // 路径溯源：精确匹配或落在该目录下都算；返回最近的在前
  explain(targetPath, limit = 50) {
    const size = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const absolute = path.resolve(String(targetPath || ''));
    const normalized = absolute.replace(/\\/g, '/');
    return this.readAll()
      .filter((item) => {
        if (!item.path) return false;
        const itemPath = path.resolve(item.path).replace(/\\/g, '/');
        return itemPath === normalized || itemPath.startsWith(`${normalized}/`) || normalized.startsWith(`${itemPath}/`);
      })
      .slice(-size)
      .reverse();
  }
}

module.exports = { ProvenanceLedger, fileSha256, DEFAULT_FILE };
