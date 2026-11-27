'use strict';

/**
 * 讨论期只读工具：让人格在发言前读真实代码，把断言落在「文件:行」上。
 *
 * 契约（与 CodingTeam.readTools 一致）：
 *   { definitions, execute(name, args) }
 * - 所有路径钉在 root 内，越界（.. 逃逸或绝对路径跑到外面）直接拒绝；
 * - 只读，绝不写盘；
 * - 大文件/重目录跳过，输出有上限，避免把上下文撑爆。
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const TEXT_EXTS = new Set(['.js', '.json', '.md', '.ts', '.mjs', '.cjs', '.txt', '.yml', '.yaml', '.py']);
const MAX_FILE_BYTES = 400 * 1024;
const MAX_LIST_ENTRIES = 400;
const DEFAULT_SEARCH_RESULTS = 40;
const MAX_SEARCH_RESULTS = 200;
const MAX_LINE_LENGTH = 200;

function createReadTools({ root, onCall = null } = {}) {
    const ROOT = path.resolve(root || process.cwd());

    // 把模型给的路径钉在 root 内，越界（.. 逃逸或绝对路径跑到外面）直接拒绝
    function safeResolve(p) {
        const abs = path.resolve(ROOT, String(p == null ? '.' : p));
        const rel = path.relative(ROOT, abs);
        if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
            throw new Error(`路径越界（只允许根目录内）：${p}`);
        }
        return abs;
    }

    function relOf(abs) {
        return path.relative(ROOT, abs).split(path.sep).join('/');
    }

    // 读文件（可选行范围），输出带行号，便于引用「文件:行」
    function readFileTool({ path: p, startLine, endLine } = {}) {
        const abs = safeResolve(p);
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error(`不是文件：${p}`);
        if (stat.size > MAX_FILE_BYTES) {
            throw new Error(`文件过大（${stat.size} 字节），请改用 search_code 或缩小范围：${p}`);
        }
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const total = lines.length;
        const from = Math.max(1, Math.min(parseInt(startLine, 10) || 1, total));
        const to = Math.min(total, Math.max(from, parseInt(endLine, 10) || total));
        const body = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
        return `# ${relOf(abs)}（第 ${from}-${to} 行，共 ${total} 行）\n${body}`;
    }

    // 列目录树（限制深度与条数）
    function listFilesTool({ path: p = '.', depth } = {}) {
        const abs = safeResolve(p);
        const maxDepth = Math.max(1, Math.min(parseInt(depth, 10) || 2, 4));
        const out = [];
        const walk = (dir, d) => {
            if (d > maxDepth || out.length > MAX_LIST_ENTRIES) return;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { return; }
            for (const e of entries) {
                if (SKIP_DIRS.has(e.name) || out.length > MAX_LIST_ENTRIES) continue;
                const rel = relOf(path.join(dir, e.name));
                out.push(e.isDirectory() ? `${rel}/` : rel);
                if (e.isDirectory()) walk(path.join(dir, e.name), d + 1);
            }
        };
        walk(abs, 1);
        return out.length ? out.join('\n') : `（空目录：${relOf(abs)}）`;
    }

    // 按正则搜代码（跨文本文件，跳过重目录/大文件），返回「文件:行: 内容」
    function searchCodeTool({ pattern, path: p = '.', maxResults } = {}) {
        const src = String(pattern || '');
        if (!src) throw new Error('缺少 pattern');
        let re;
        try { re = new RegExp(src, 'i'); } catch (error) { throw new Error(`正则非法：${error.message}`); }
        const abs = safeResolve(p);
        const limit = Math.max(1, Math.min(parseInt(maxResults, 10) || DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
        const hits = [];
        const scanFile = (full) => {
            if (hits.length >= limit) return;
            if (!TEXT_EXTS.has(path.extname(full))) return;
            let stat; try { stat = fs.statSync(full); } catch (error) { return; }
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
            let text; try { text = fs.readFileSync(full, 'utf8'); } catch (error) { return; }
            const rel = relOf(full);
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && hits.length < limit; i++) {
                if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_LENGTH)}`);
            }
        };
        const walk = (dir) => {
            if (hits.length >= limit) return;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { return; }
            for (const e of entries) {
                if (hits.length >= limit) return;
                if (SKIP_DIRS.has(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full); else scanFile(full);
            }
        };
        if (fs.statSync(abs).isFile()) scanFile(abs); else walk(abs);
        return hits.length ? hits.join('\n') : `（未找到匹配：${src}）`;
    }

    const definitions = [
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: '读取项目内某个文件的正文（可指定起止行），返回带行号的内容。用于核对代码事实。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '相对于项目根目录的文件路径，如 src/core/codingTeam.js' },
                        startLine: { type: 'integer', description: '起始行（从 1 开始，可选）' },
                        endLine: { type: 'integer', description: '结束行（含，可选；省略则读到文件末尾）' }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_files',
                description: '列出项目内某个目录的文件/子目录（限制深度），用于确认文件是否存在、结构如何。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '相对于项目根目录的目录路径，默认项目根 "."' },
                        depth: { type: 'integer', description: '递归深度，1-4，默认 2' }
                    },
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'search_code',
                description: '在项目文本文件里按正则搜索，返回「文件:行: 内容」。用于定位某函数/关键字出现在哪里。',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: '正则表达式（忽略大小写）' },
                        path: { type: 'string', description: '搜索起点（相对项目根目录），默认整个项目' },
                        maxResults: { type: 'integer', description: '最多返回条数，默认 40，上限 200' }
                    },
                    required: ['pattern']
                }
            }
        }
    ];

    async function execute(name, args) {
        const a = (args && typeof args === 'object') ? args : {};
        if (typeof onCall === 'function') onCall(name, a);
        switch (name) {
            case 'read_file': return readFileTool(a);
            case 'list_files': return listFilesTool(a);
            case 'search_code': return searchCodeTool(a);
            default: return `（未知只读工具：${name}）`;
        }
    }

    return { root: ROOT, definitions, execute };
}

module.exports = { createReadTools };
