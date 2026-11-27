'use strict';

// 🕰️ 时间线事件总线（路线 C：单点收口）
//
// 职责只有一件：把「系统真的做了这件事」追加成一条只追加的日志，并按天读回来。
// 不导入任何业务模块、不解读 payload 的业务含义、不做 scope 规范化（分档语义属于记忆层）。
//
// 落盘：data/timeline/<YYYY-MM-DD>/<scopeKey>.jsonl，一行一条；只追加、不重写、不 fsync。
// 失败绝不抛给调用方：告警 + 计数（failures），宁可漏记也不阻断正式回复。
// 详细设计见 docs/superpowers/specs/2026-11-06-timeline-event-bus-design.md

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'timeline');

function pad(n) {
    return String(n).padStart(2, '0');
}

// 本地日期键（不是 UTC）：跨天判定与目录名都用它
function dayKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 只做「负向拒绝」：scopeKey 会被拼进路径，含分隔符就能越出 data/timeline。
// 正向白名单会误杀中文昵称，故这里只挡非法段（与 memory 的 safeScopeBase 同一条基线）
function safeScope(scopeKey) {
    if (typeof scopeKey !== 'string') return null;
    const raw = scopeKey.trim();
    if (!raw || raw.length > 120) return null;
    if (raw === '.' || raw === '..') return null;
    if (/[/\\]/.test(raw) || raw !== path.basename(raw)) return null;
    return raw;
}

class TimelineStore {
    constructor({ dir = null } = {}) {
        this.dir = dir || process.env.TIMELINE_DIR || DEFAULT_DIR;
        this.failures = 0;   // append 失败累计（磁盘满 / 权限 / 非法入参）
        this.badLines = 0;   // 读到的坏行累计（半截行 / 非 JSON）
        this._seq = new Map();          // `${day}|${scopeKey}` → 当天最后一条的 seq
        this._subscribers = [];         // 泛型观察者：只收到事件，不参与存储
    }

    // 追加一条事件。返回是否写入成功（永不抛错）
    append(scopeKey, type, payload = {}, { now = Date.now() } = {}) {
        const key = safeScope(scopeKey);
        const t = typeof type === 'string' ? type.trim() : '';
        const at = Number.isFinite(now) ? now : Date.now();
        if (!key || !t) {
            this.failures += 1;
            console.warn(`[Timeline] 非法事件已丢弃：scope=${JSON.stringify(scopeKey)} type=${JSON.stringify(type)}`);
            return false;
        }

        try {
            const day = dayKey(new Date(at));
            const dayDir = path.join(this.dir, day);
            fs.mkdirSync(dayDir, { recursive: true });
            const file = path.join(dayDir, `${key}.jsonl`);
            const seq = this._nextSeq(file, day, key);
            const body = (payload && typeof payload === 'object' && !Array.isArray(payload))
                ? payload
                : { value: payload };
            const record = { v: 1, seq, at, type: t, payload: body };
            fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
            this._seq.set(`${day}|${key}`, seq);
            this._notify(record, key);
            return true;
        } catch (error) {
            this.failures += 1;
            console.warn('[Timeline] 写入失败（不影响调用方）:', error.message);
            return false;
        }
    }

    // 当天该 scope 的最后一条 seq：内存缓存优先；首次遇到这个文件时数一遍已有非空行
    _nextSeq(file, day, key) {
        const cacheKey = `${day}|${key}`;
        const cached = this._seq.get(cacheKey);
        if (Number.isFinite(cached)) return cached + 1;
        let count = 0;
        try {
            if (fs.existsSync(file)) {
                const raw = fs.readFileSync(file, 'utf8');
                for (const line of raw.split('\n')) {
                    if (line.trim()) count += 1;
                }
            }
        } catch (error) {
            console.warn('[Timeline] 读取已有行数失败，seq 从 1 开始:', error.message);
            count = 0;
        }
        return count + 1;
    }

    // 读某一天的某几类事件；坏行跳过并计数，全天日志仍可读
    readDay(scopeKey, date = dayKey(), { types = null } = {}) {
        const key = safeScope(scopeKey);
        const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
        if (!key || !day) return [];

        const file = path.join(this.dir, day, `${key}.jsonl`);
        let raw = '';
        try {
            if (!fs.existsSync(file)) return [];
            raw = fs.readFileSync(file, 'utf8');
        } catch (error) {
            console.warn('[Timeline] 读取失败:', error.message);
            return [];
        }

        const allow = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
        const records = [];
        let index = 0;
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            index += 1;
            let record = null;
            try {
                record = JSON.parse(line);
            } catch {
                this.badLines += 1;
                continue;
            }
            if (!record || typeof record !== 'object') {
                this.badLines += 1;
                continue;
            }
            if (allow && !allow.has(record.type)) continue;
            // 老行缺 seq 时按出现顺序补齐，读取方始终拿得到连续序号
            records.push({
                ...record,
                seq: Number.isFinite(record.seq) ? record.seq : index
            });
        }
        return records;
    }

    // 列出有记录的日期（新→旧），供入口页挑日子
    listDays(scopeKey, { limit = 30 } = {}) {
        const key = safeScope(scopeKey);
        if (!key) return [];
        const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30;
        try {
            if (!fs.existsSync(this.dir)) return [];
            const days = fs.readdirSync(this.dir)
                .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
                .filter((name) => fs.existsSync(path.join(this.dir, name, `${key}.jsonl`)))
                .sort()
                .reverse();
            return days.slice(0, max);
        } catch (error) {
            console.warn('[Timeline] 列目录失败:', error.message);
            return [];
        }
    }

    // 泛型订阅：只把已写入的事件交出去（投影 / 影子评估用），不影响存储
    subscribe(fn) {
        if (typeof fn === 'function') this._subscribers.push(fn);
        return () => {
            const i = this._subscribers.indexOf(fn);
            if (i >= 0) this._subscribers.splice(i, 1);
        };
    }

    _notify(record, scopeKey) {
        for (const fn of this._subscribers) {
            try {
                fn(record, scopeKey);
            } catch (error) {
                console.warn('[Timeline] 订阅者处理失败:', error.message);
            }
        }
    }
}

// 单进程共用一个实例：所有接线点写进同一份日志，seq 缓存也共用，避免同文件多计数器
let defaultStore = null;
function getTimeline() {
    if (!defaultStore) defaultStore = new TimelineStore();
    return defaultStore;
}

module.exports = { TimelineStore, getTimeline, dayKey, DEFAULT_DIR };
