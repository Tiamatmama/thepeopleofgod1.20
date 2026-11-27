'use strict';

// 📦 学习产物留存层：data/learn/assets/<id>/
// 只认带 manifest 的目录：没有 manifest 的目录既不算产物、也不进索引。
// 负责 TTL + LRU 淘汰，保证 assets 桶不越过配额。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GB = 1024 * 1024 * 1024;
const DEFAULT_MAX_BYTES = Math.floor(1.5 * GB);
const DEFAULT_TTL_DAYS = 30;
const KINDS = new Set(['dataset', 'analysis', 'train', 'weights', 'tool', 'note']);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{5,79}$/i;

function newId(now = Date.now()) {
  return `${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 文件名只允许单段：`../`、绝对路径、子目录一律拒绝
function safeFileName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw || raw.length > 120) return null;
  if (raw === '.' || raw === '..') return null;
  if (/[/\\]/.test(raw)) return null;
  if (raw !== path.basename(raw)) return null;
  return raw;
}

function readBody(entry, fsImpl = fs) {
  if (!entry || typeof entry !== 'object') return null;
  if (Buffer.isBuffer(entry.content)) return entry.content;
  if (typeof entry.content === 'string') return Buffer.from(entry.content, 'utf8');
  if (typeof entry.path === 'string' && entry.path) {
    try {
      return fsImpl.readFileSync(entry.path);
    } catch {
      return null;
    }
  }
  return null;
}

class LearningStore {
  constructor(options = {}) {
    this.root = options.root || path.join(__dirname, '..', '..', 'data', 'learn');
    this.assetsDir = path.join(this.root, 'assets');
    this.indexFile = path.join(this.root, 'index.json');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlDays = Number.isFinite(options.ttlDays) ? options.ttlDays : DEFAULT_TTL_DAYS;
    this.maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.fs = options.fs || fs;
  }

  ensure() {
    this.fs.mkdirSync(this.assetsDir, { recursive: true });
  }

  _readIndex() {
    try {
      const raw = this.fs.readFileSync(this.indexFile, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return { v: 1, entries: {} };
      }
      return { v: 1, entries: data.entries };
    } catch {
      return { v: 1, entries: {} };
    }
  }

  _writeIndex(index) {
    this.ensure();
    const tmp = `${this.indexFile}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    // Windows 下 rename 覆盖可能失败：先删旧文件再换名
    try {
      this.fs.rmSync(this.indexFile, { force: true });
    } catch {
      // 旧索引删不掉时下面的 rename 会报错，交给调用方
    }
    this.fs.renameSync(tmp, this.indexFile);
  }

  // 留存产物。manifest 字段不全（来源 / license / 文件）直接拒绝，不写半成品。
  retain(input = {}) {
    const kind = String(input.kind || 'asset').toLowerCase();
    if (!KINDS.has(kind)) return { success: false, error: `不支持的产物类型: ${kind}` };

    const title = String(input.title || '').trim();
    if (!title || title.length > 120) return { success: false, error: 'title 必须是 1–120 字' };

    const source = String(input.source || '').trim();
    if (!source) return { success: false, error: '缺少来源（source），无法生成 manifest' };

    const license = String(input.license || '').trim();
    if (!license) return { success: false, error: '缺少 license，产物不予留存' };

    const rawFiles = Array.isArray(input.files) ? input.files : [];
    if (!rawFiles.length) return { success: false, error: '没有可留存的产物文件' };

    const files = [];
    let totalBytes = 0;
    for (const item of rawFiles) {
      const name = safeFileName(item && item.name);
      if (!name) return { success: false, error: `非法文件名: ${item && item.name}` };
      const body = readBody(item, this.fs);
      if (!body) return { success: false, error: `文件读取失败: ${name}` };
      totalBytes += body.length;
      files.push({ name, body, bytes: body.length, sha256: sha256(body) });
    }
    if (totalBytes > this.maxBytes) {
      return { success: false, error: `产物 ${totalBytes} 字节超过留存上限 ${this.maxBytes}` };
    }

    const id = SAFE_ID.test(String(input.id || '')) ? String(input.id) : newId(this.now());
    const dir = path.join(this.assetsDir, id);
    if (this.fs.existsSync(dir)) return { success: false, error: `产物 id 已存在: ${id}` };

    const createdAt = this.now();
    try {
      this.fs.mkdirSync(dir, { recursive: true });
      for (const file of files) {
        this.fs.writeFileSync(path.join(dir, file.name), file.body);
      }
      const manifest = {
        v: 1,
        id,
        kind,
        title,
        source,
        license,
        script: typeof input.script === 'string' ? input.script : '',
        createdAt,
        bytes: totalBytes,
        files: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 }))
      };
      this.fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const index = this._readIndex();
      index.entries[id] = {
        id,
        kind,
        title,
        bytes: totalBytes,
        createdAt,
        lastAccess: createdAt,
        fileCount: files.length
      };
      this._writeIndex(index);
      return { success: true, id, bytes: totalBytes, manifest };
    } catch (error) {
      try {
        this.fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响返回
      }
      return { success: false, error: `写入产物失败: ${error.message}` };
    }
  }

  _manifestOf(id) {
    if (!SAFE_ID.test(String(id || ''))) return null;
    const file = path.join(this.assetsDir, id, 'manifest.json');
    try {
      const data = JSON.parse(this.fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  // 列表只返回 manifest 可读的条目，顺手清掉索引里的幽灵条目
  list() {
    const index = this._readIndex();
    const entries = [];
    let dirty = false;
    for (const [id, entry] of Object.entries(index.entries)) {
      const manifest = this._manifestOf(id);
      if (!manifest) {
        delete index.entries[id];
        dirty = true;
        continue;
      }
      entries.push({ ...entry, manifested: true });
    }
    if (dirty) {
      try {
        this._writeIndex(index);
      } catch {
        // 索引写不回去只影响下次清理，不影响本次读取
      }
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return entries;
  }

  get(id) {
    const manifest = this._manifestOf(id);
    if (!manifest) return { success: false, error: '产物不存在或缺少 manifest' };
    const index = this._readIndex();
    const entry = index.entries[id];
    if (entry) {
      entry.lastAccess = this.now();
      try {
        this._writeIndex(index);
      } catch {
        // 访问时间更新失败不影响读取
      }
    }
    return {
      success: true,
      id,
      manifest,
      dir: path.join(this.assetsDir, id),
      lastAccess: entry ? entry.lastAccess : manifest.createdAt
    };
  }

  remove(id) {
    if (!SAFE_ID.test(String(id || ''))) return { success: false, error: '非法产物 id' };
    const dir = path.join(this.assetsDir, id);
    const existed = this.fs.existsSync(dir);
    try {
      this.fs.rmSync(dir, { recursive: true, force: true });
      const index = this._readIndex();
      if (index.entries[id]) {
        delete index.entries[id];
        this._writeIndex(index);
      }
      return { success: true, removed: existed };
    } catch (error) {
      return { success: false, error: `删除失败: ${error.message}` };
    }
  }

  // 先按 TTL 清过期，再按 lastAccess 从旧到新淘汰，直到总量回到 maxBytes 以内
  prune() {
    const now = this.now();
    const index = this._readIndex();
    const ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;
    const entries = Object.values(index.entries)
      .map((entry) => ({ ...entry, lastAccess: Number.isFinite(entry.lastAccess) ? entry.lastAccess : entry.createdAt }))
      .sort((a, b) => a.lastAccess - b.lastAccess);

    let total = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0);
    const removed = [];
    for (const entry of entries) {
      const expired = ttlMs > 0 && now - entry.createdAt > ttlMs;
      const over = total > this.maxBytes;
      const missing = !this._manifestOf(entry.id);
      if (!expired && !over && !missing) continue;
      try {
        this.fs.rmSync(path.join(this.assetsDir, entry.id), { recursive: true, force: true });
        delete index.entries[entry.id];
        total -= Number.isFinite(entry.bytes) ? entry.bytes : 0;
        removed.push(entry.id);
      } catch {
        // 删不掉的条目留到下次再试
      }
    }
    if (removed.length) {
      try {
        this._writeIndex(index);
      } catch {
        // 索引写失败时目录已删，下次 list() 会兜底清理
      }
    }
    return { success: true, removed, remainingBytes: Math.max(0, total) };
  }

  stats() {
    const entries = this.list();
    const bytes = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0);
    return { count: entries.length, bytes, maxBytes: this.maxBytes, ttlDays: this.ttlDays };
  }
}

module.exports = { LearningStore, newId, safeFileName, sha256, KINDS, DEFAULT_MAX_BYTES };
