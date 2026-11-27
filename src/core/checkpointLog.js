'use strict';

// 检查点日志（append-only JSONL）
// 为什么不是 project.json / loop_runs.json：
// - loop_runs.json 每次 run 结束「全量读 + 全量重写」，40 轮 40 run 的累计写入约 33.6 MB（见 scripts/benchmark-checkpoints.js）；
// - project.json 是「当前项目状态」的唯一事实源，逐轮里程碑塞进去会把它撑到 19 KB 且注入 prompt 时被 3000 B 上限截断；
// - JSONL 每轮/每阶段追加一行（约 211 B），O(1) 写入，崩溃最多丢最后一行。
// 本模块只负责落盘与读取，不判断业务语义。

const fs = require('fs');
const path = require('path');

const CHECKPOINT_FILE = 'checkpoints.jsonl';
const MAX_LINE_BYTES = 4096;
const DEFAULT_READ_LIMIT = 4000;
const MAX_TAIL_BYTES = 1024 * 1024;

function normalizeEntry(entry) {
    const src = (entry && typeof entry === 'object') ? entry : {};
    const allowed = src.kind === 'stage' || src.kind === 'node' || src.kind === 'run_end';
    const kind = allowed ? src.kind : 'iteration';
    return {
        at: String(src.at || new Date().toISOString()),
        runId: String(src.runId || ''),
        taskId: String(src.taskId || ''),
        iteration: Number.isInteger(src.iteration) ? src.iteration : 0,
        kind,
        stageId: String(src.stageId || ''),
        nodeId: String(src.nodeId || ''),
        ok: src.ok === true,
        verdict: String(src.verdict || ''),
        errorKind: String(src.errorKind || ''),
        sha: String(src.sha || ''),
        reason: String(src.reason || '')
    };
}

function serializeEntry(entry) {
    const item = normalizeEntry(entry);
    let line = JSON.stringify(item);
    // 单行硬上限：异常长的 reason 不能把一行撑成几十 KB，否则尾部读取与排障都会变慢。
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        item.reason = item.reason.slice(0, 1000);
        line = JSON.stringify(item);
        while (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && item.reason.length > 0) {
            item.reason = item.reason.slice(0, Math.floor(item.reason.length / 2));
            line = JSON.stringify(item);
        }
    }
    return line;
}

// O(1) 追加一行。失败返回 false 且不抛：检查点日志不能阻断闭环主流程。
function appendCheckpoint(file, entry) {
    if (!file) return false;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, serializeEntry(entry) + '\n', 'utf8');
        return true;
    } catch (error) {
        return false;
    }
}

// 只读文件尾部，避免日志变长后把整个文件读进内存。
function readTailText(file, maxBytes = MAX_TAIL_BYTES) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (!size) return '';
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        let text = buffer.toString('utf8');
        // 从中间截断时，第一行可能是半截：丢掉它（除非正好从文件头开始）。
        if (start > 0) {
            const cut = text.indexOf('\n');
            text = cut >= 0 ? text.slice(cut + 1) : '';
        }
        return text;
    } finally {
        fs.closeSync(fd);
    }
}

// 解析 JSONL：坏行只跳过该行，不影响其它记录。
function parseLines(text) {
    const out = [];
    String(text || '').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            out.push(normalizeEntry(JSON.parse(trimmed)));
        } catch (error) { /* 坏行跳过 */ }
    });
    return out;
}

function readCheckpoints(file, options = {}) {
    if (!file) return [];
    try {
        if (!fs.existsSync(file)) return [];
        const limit = Math.max(1, parseInt(options.limit, 10) || DEFAULT_READ_LIMIT);
        const entries = parseLines(readTailText(file, options.maxBytes));
        return entries.slice(-limit);
    } catch (error) {
        return [];
    }
}

// 最近一个「已落 sha 的通过检查点」——用作新 run 的续跑绿点候选。
// 认两类：阶段化验收的 stage，以及计划子任务的 node。
function lastCommitted(entries) {
    const list = Array.isArray(entries) ? entries : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (!item || !item.ok || !item.sha) continue;
        if (item.kind === 'stage' || item.kind === 'node') return item;
    }
    return null;
}

// 已完成的计划子任务：只认「node + ok + nodeId」。
// 跨 run 累计（append-only 日志是事实源）；去重并保持首次出现顺序。
function completedNodes(entries, planIds = null) {
    const list = Array.isArray(entries) ? entries : [];
    const known = Array.isArray(planIds) && planIds.length ? new Set(planIds) : null;
    const out = [];
    list.forEach(item => {
        if (!item || item.kind !== 'node' || !item.ok || !item.nodeId) return;
        if (known && !known.has(item.nodeId)) return;
        if (out.includes(item.nodeId)) return;
        out.push(item.nodeId);
    });
    return out;
}

// 取最近一次 run 的进度摘要：以最后一条记录为准，回溯同一 runId 的阶段结果。
function summarizeLatestRun(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return null;
    const runId = last.runId;
    if (!runId) return null;
    const sameRun = list.filter(item => item.runId === runId);
    const stages = [];
    sameRun.forEach(item => {
        if (item.kind !== 'stage' || !item.stageId) return;
        const existing = stages.find(s => s.stageId === item.stageId);
        if (existing) {
            existing.ok = item.ok;
            existing.sha = item.sha;
        } else {
            stages.push({ stageId: item.stageId, ok: item.ok, sha: item.sha });
        }
    });
    const lastEnd = [...sameRun].reverse().find(item => item.kind === 'run_end') || null;
    return {
        runId,
        at: last.at,
        status: lastEnd ? (lastEnd.verdict || '') : '',
        stages,
        passedStages: stages.filter(s => s.ok).map(s => s.stageId)
    };
}

module.exports = {
    CHECKPOINT_FILE,
    MAX_LINE_BYTES,
    normalizeEntry,
    serializeEntry,
    appendCheckpoint,
    readCheckpoints,
    lastCommitted,
    completedNodes,
    summarizeLatestRun
};
