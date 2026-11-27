'use strict';

// 🧠 编码闭环的独立工作记忆
// 与角色记忆体系完全隔离：只记「这次编码任务里做过什么」，不参与好感度/角色记忆。
// 解决的问题：codingLoop 的 history 是按字节截断的，长任务跑到后半程会忘掉
// 前面读过哪些文件、改过哪些文件、上一次测试为什么挂。这里把这些事实压成
// 一小段结构化文本，每轮重新注入 system prompt，截断也不会断片。
//
// 硬约束：
// - 只存路径、结论、报错尾巴（≤200 字），绝不存文件内容或密钥；
// - 单文件落盘，写临时文件再 rename，避免半截 JSON；
// - userId / taskId 只允许安全字符，防目录穿越。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMORY_DIR = path.join('data', 'coding', 'memory');
const LIMITS = {
    filesRead: 60,
    filesChanged: 60,
    checks: 24,
    notes: 30,
    renderFiles: 12,
    renderChecks: 4,
    renderNotes: 4,
    lineChars: 200
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// 中文用户名 / 带冒号的 taskId 都会落到哈希分支：既不能穿越目录，也不能互相串档。
function safeId(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    if (SAFE_ID.test(text)) return text;
    if (!text) return fallback;
    return 'h_' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// 单行化 + 限长：报错尾巴常常带换行和超长堆栈，进 prompt 前必须压平。
function oneLine(value, max = LIMITS.lineChars) {
    return String(value == null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function emptyMemory() {
    return {
        version: 1,
        goal: '',
        filesRead: [],
        filesChanged: [],
        checks: [],
        notes: [],
        updatedAt: ''
    };
}

class CodingMemory {
    constructor({ userId, taskId, baseDir } = {}) {
        this.userId = safeId(userId, 'unknown');
        this.taskId = safeId(taskId, 'unknown');
        this.baseDir = baseDir || MEMORY_DIR;
        this.data = emptyMemory();
    }

    filePath() {
        return path.join(this.baseDir, this.userId, `${this.taskId}.json`);
    }

    load() {
        try {
            const raw = fs.readFileSync(this.filePath(), 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return this;
            this.data = {
                ...emptyMemory(),
                goal: oneLine(parsed.goal, 300),
                filesRead: this.cleanList(
                    parsed.filesRead,
                    LIMITS.filesRead,
                    item => oneLine(typeof item === 'string' ? item : item && item.path, 160)
                ),
                filesChanged: this.cleanList(
                    parsed.filesChanged,
                    LIMITS.filesChanged,
                    item => ({
                        path: oneLine(typeof item === 'string' ? item : item && item.path, 160),
                        ok: !!(item && item.ok),
                        at: Number(item && item.at) || 0
                    }),
                    item => Boolean(item.path)
                ),
                checks: this.cleanList(parsed.checks, LIMITS.checks, item => ({
                    tool: oneLine(item && item.tool, 40),
                    ok: !!(item && item.ok),
                    detail: oneLine(item && item.detail)
                }), item => Boolean(item.tool)),
                notes: this.cleanList(
                    parsed.notes,
                    LIMITS.notes,
                    item => oneLine(typeof item === 'string' ? item : item && item.text)
                ),
                updatedAt: oneLine(parsed.updatedAt, 40)
            };
        } catch (error) {
            // 文件不存在 / 解析失败都按「新建」处理：记忆坏了不能挡住任务开跑。
            this.data = emptyMemory();
        }
        return this;
    }

    cleanList(list, max, mapItem, isValid) {
        if (!Array.isArray(list)) return [];
        const keep = typeof isValid === 'function' ? isValid : Boolean;
        const mapped = list.map(mapItem).filter(keep);
        return mapped.slice(-max);
    }

    setGoal(goal) {
        const text = oneLine(goal, 300);
        if (text && !this.data.goal) this.data.goal = text;
        return this;
    }

    note(text) {
        const line = oneLine(text);
        if (!line) return this;
        this.data.notes.push(line);
        if (this.data.notes.length > LIMITS.notes) {
            this.data.notes = this.data.notes.slice(-LIMITS.notes);
        }
        return this;
    }

    // 把一个工具调用折叠进记忆。ok / output 来自 tool_result 事件。
    recordToolCall(name, args, ok, output) {
        const tool = String(name || '');
        const params = args && typeof args === 'object' ? args : {};
        const resultText = oneLine(output);
        if (tool === 'code_read_range' || tool === 'code_read') {
            this.pushOnce(this.data.filesRead, oneLine(params.path || params.name, 160), LIMITS.filesRead);
        } else if (tool === 'code_apply_patch' || tool === 'code_write_file') {
            const file = oneLine(params.path || params.name, 160);
            if (file) {
                this.data.filesChanged = this.data.filesChanged.filter(item => item.path !== file);
                this.data.filesChanged.push({ path: file, ok: ok !== false, at: Date.now() });
                if (this.data.filesChanged.length > LIMITS.filesChanged) {
                    this.data.filesChanged = this.data.filesChanged.slice(-LIMITS.filesChanged);
                }
            }
        } else if (tool === 'code_run_tests' || tool === 'code_diagnose') {
            this.data.checks.push({
                tool,
                ok: ok !== false,
                detail: ok === false ? resultText : oneLine(params.command || params.path || '通过')
            });
            if (this.data.checks.length > LIMITS.checks) {
                this.data.checks = this.data.checks.slice(-LIMITS.checks);
            }
        } else if (tool === 'code_git' && (params.action === 'commit' || params.action === 'checkout')) {
            this.note(`git ${params.action}：${resultText || (ok === false ? '失败' : '完成')}`);
        }
        this.save();
        return this;
    }

    pushOnce(list, value, max) {
        if (!value) return;
        const existing = list.findIndex(item => (typeof item === 'string' ? item : item.path) === value);
        if (existing >= 0) list.splice(existing, 1);
        list.push(value);
        if (list.length > max) list.splice(0, list.length - max);
    }

    // 给模型看的紧凑文本。上限约 1200 字，每轮重发也只占很小一段。
    render(maxChars = 1200) {
        const parts = [];
        if (this.data.goal) parts.push(`目标：${this.data.goal}`);
        const read = this.data.filesRead.slice(-LIMITS.renderFiles).map(item => (typeof item === 'string' ? item : item.path));
        if (read.length) parts.push(`已读文件（最近 ${read.length} 个）：${read.join('、')}`);
        const changed = this.data.filesChanged.slice(-LIMITS.renderFiles)
            .map(item => `${item.path}${item.ok ? '' : '（上次写入失败）'}`);
        if (changed.length) parts.push(`已改文件：${changed.join('、')}`);
        const checks = this.data.checks.slice(-LIMITS.renderChecks)
            .map(item => `${item.tool}${item.ok ? ' 通过' : ' 失败：' + (item.detail || '无输出')}`);
        if (checks.length) parts.push(`最近验证：${checks.join('；')}`);
        const notes = this.data.notes.slice(-LIMITS.renderNotes);
        if (notes.length) parts.push(`备注：${notes.join('；')}`);
        if (!parts.length) return '';
        const text = `\n\n【编码工作记忆 · 自动维护】\n${parts.join('\n')}`;
        return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    }

    save() {
        this.data.updatedAt = new Date().toISOString();
        const target = this.filePath();
        const tmp = `${target}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
            fs.renameSync(tmp, target);
        } catch (error) {
            try { fs.unlinkSync(tmp); } catch (cleanupError) { /* 临时文件可能没建出来 */ }
        }
        return this;
    }
}

module.exports = { CodingMemory, LIMITS, MEMORY_DIR };
