'use strict';

// 🧭 稳定偏移·观测落盘（只观测、不注入）
//
// 职责：把「界线核对样本」和「判据结果」追加成 jsonl，一行一条。
// 与纯计算的 deviation.js 分离——那个模块不碰 fs（方便单测），这个模块只碰 fs。
// 观测绝不允许打断真实回复主链：任何异常一律吞掉（只告警），不向上抛。

const fs = require('fs');
const path = require('path');

// 落点：data/deviation-shadow/dev-<stamp>.jsonl（data/ 已 gitignore，安全；
// 只往新目录写新文件，绝不改动既有数据文件）
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'deviation-shadow');

// 时间戳分片到「小时」：单文件有界、可按窗口选取，便于「只看最近这段」的分析纪律
function stampFor(now) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}`;
}

// 追加一行。kind = 'sample'（核对样本）| 'verdict'（判据结果）。
function appendDeviationShadow(entry, options = {}) {
    try {
        const dir = options.dir || DEFAULT_DIR;
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const file = path.join(dir, `dev-${stampFor(now)}.jsonl`);
        const record = {
            kind: 'sample',
            at: now,
            ...(entry && typeof entry === 'object' ? entry : {})
        };
        fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
        return true;
    } catch (error) {
        console.error('[DeviationShadow] 写入观测日志失败:', error.message);
        return false;
    }
}

// 读回观测记录（判据分析 / 汇总脚本用）。默认只取 kind='sample'（kind 可传 'verdict'），
// 支持 since / userId / limit；分析永远看「最近还在发生的」，不把陈年样本混进来。
function readDeviationSamples(options = {}) {
    const dir = options.dir || DEFAULT_DIR;
    const since = Number.isFinite(options.since) ? options.since : 0;
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 500;
    const userId = typeof options.userId === 'string' && options.userId.trim() ? options.userId.trim() : null;
    const kind = typeof options.kind === 'string' && options.kind.trim() ? options.kind.trim() : 'sample';
    try {
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir)
            .filter(name => name.startsWith('dev-') && name.endsWith('.jsonl'))
            .sort();
        const samples = [];
        for (const name of files) {
            const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                let record = null;
                try {
                    record = JSON.parse(line);
                } catch {
                    continue;   // 半截行（写到一半被打断）直接跳过，不让它污染判据
                }
                if (!record || record.kind !== kind) continue;
                if (userId && record.userId !== userId) continue;
                if (since && !(Number(record.at) >= since)) continue;
                samples.push(record);
            }
        }
        return samples
            .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
            .slice(-limit);
    } catch (error) {
        console.error('[DeviationShadow] 读取观测日志失败:', error.message);
        return [];
    }
}

module.exports = { appendDeviationShadow, readDeviationSamples, stampFor, DEFAULT_DIR };
