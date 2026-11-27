#!/usr/bin/env node
'use strict'
// leakscan.js —— 明文凭证扫描器。零依赖、单文件、只读；可直接复制到任意项目。
// 用法：node leakscan.js [--glob "**/*.{js,py,json,jsonl,md,txt,html}"] [路径或模式...]
// 退出码：0=未命中；1=命中；2=扫描器自身输入错误（参数/空匹配）
// 注意：只匹配明文模式。CSS 隐藏、编码变形、语义外泄（如盲测映射文件）都扫不到。

const fs = require('fs')
const path = require('path')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__'])
const EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.py', '.json', '.jsonl', '.md', '.txt', '.html', '.yml', '.yaml'])
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_LINE_CHARS = 1024 * 1024

const RULES = [
    { name: 'SK-LONG', re: /sk-[A-Za-z0-9_-]{16,}/g },
    { name: 'ASSIGN-SECRET', re: /(api[_-]?key|token|secret)\s*[:=]\s*(['"])([^'"]{12,})\2/gi }
]

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function globToRegExp(g) {
    const s = g.replace(/\\/g, '/')
    let re = '^'
    for (let i = 0; i < s.length; i++) {
        const c = s[i]
        if (c === '*') {
            if (s[i + 1] === '*') {
                i++
                if (s[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
            } else re += '[^/]*'
        } else if (c === '?') re += '[^/]'
        else if (c === '{') {
            const end = s.indexOf('}', i)
            if (end < 0) re += '\\{'
            else {
                re += '(?:' + s.slice(i + 1, end).split(',').map(esc).join('|') + ')'
                i = end
            }
        } else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c
        else re += c
    }
    return new RegExp(re + '$')
}

function inScope(p) {
    const b = path.basename(p)
    if (b === '.env' || b.startsWith('.env.')) return true
    return EXT.has(path.extname(p).toLowerCase())
}

function walk(dir, base, out) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, base, out)
        else if (e.isFile() && inScope(full)) out.push(path.relative(base, full).split(path.sep).join('/'))
    }
}

function expand(item, out) {
    const abs = path.resolve(item)
    if (fs.existsSync(abs)) {
        const st = fs.statSync(abs)
        if (st.isFile()) { out.add(abs); return }
        if (st.isDirectory()) {
            const rels = []
            walk(abs, abs, rels)
            for (const r of rels) out.add(path.join(abs, r))
            return
        }
    }
    if (!/[*?{]/.test(item)) throw new Error(`路径不存在：${item}`)
    const rels = []
    walk(process.cwd(), process.cwd(), rels)
    const re = globToRegExp(item)
    for (const r of rels) if (re.test(r)) out.add(path.resolve(r))
}

function redact(s) {
    if (s.length <= 8) return s.slice(0, 2) + '…'
    return s.slice(0, 4) + '…' + s.slice(-4)
}

function main() {
    const argv = process.argv.slice(2)
    const inputs = []
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--glob') {
            const v = argv[++i]
            if (!v) throw new Error('--glob 缺少值')
            inputs.push(v)
        } else inputs.push(argv[i])
    }
    if (!inputs.length) inputs.push('.')
    const files = new Set()
    for (const item of inputs) expand(item, files)
    if (!files.size) throw new Error(`没有匹配到任何可扫描文件：${inputs.join(', ')}`)

    let scanned = 0, hits = 0, skipped = 0
    const stdout = []

    for (const abs of [...files].sort()) {
        const rel = path.relative(process.cwd(), abs).split(path.sep).join('/') || abs
        let size
        try { size = fs.statSync(abs).size } catch (e) { continue }
        if (size > MAX_FILE_BYTES) {
            skipped++
            console.error(`SKIP ${rel}:0 reason=file_too_large bytes=${size}`)
            continue
        }
        let fd
        try { fd = fs.openSync(abs, 'r') } catch (e) {
            skipped++
            console.error(`SKIP ${rel}:0 reason=read_error`)
            continue
        }
        scanned++
        const buf = Buffer.allocUnsafe(65536)
        let rest = '', lineNo = 0, discarding = false
        const check = (line) => {
            for (const rule of RULES) {
                rule.re.lastIndex = 0
                let m
                while ((m = rule.re.exec(line))) {
                    hits++
                    if (rule.name === 'SK-LONG') stdout.push(`${rel}:${lineNo} ${rule.name} ${redact(m[0])}`)
                    else stdout.push(`${rel}:${lineNo} ${rule.name} ${m[1]}=${redact(m[3])}`)
                }
            }
        }
        try {
            let n
            while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                rest += buf.toString('utf8', 0, n)
                let idx
                while ((idx = rest.indexOf('\n')) >= 0) {
                    const line = rest.slice(0, idx)
                    rest = rest.slice(idx + 1)
                    lineNo++
                    if (discarding) { discarding = false; continue }
                    check(line)
                }
                if (!discarding && rest.length > MAX_LINE_CHARS) {
                    lineNo++
                    skipped++
                    console.error(`SKIP ${rel}:${lineNo} reason=line_too_long`)
                    rest = ''
                    discarding = true
                } else if (discarding && rest.length > MAX_LINE_CHARS) {
                    rest = ''
                }
            }
            if (rest && !discarding) { lineNo++; check(rest) }
        } finally {
            fs.closeSync(fd)
        }
    }

    for (const line of stdout) console.log(line)
    console.log(`SUMMARY scanned=${scanned} hits=${hits} unknown=0 skipped=${skipped}`)
    process.exit(hits > 0 ? 1 : 0)
}

try { main() } catch (e) {
    console.error('ERROR ' + (e && e.message ? e.message : e))
    process.exit(2)
}
