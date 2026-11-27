#!/usr/bin/env node
'use strict'
// callsite.js —— 通用调用点契约检查器：指定符号的调用是否显式传了某个键。
// 零依赖、单文件、只读；可直接复制到任意项目。
// 用法：node callsite.js --symbol step --require updateB --in "a.js,b.py,src/**/*.js"
// 退出码：0=全部显式传入；1=发现漏传；2=检查器自身输入错误（参数/路径/空匹配）

const fs = require('fs')
const path = require('path')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__'])
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift', '.c', '.h', '.cpp'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

function parseArgs(argv) {
    const out = { in: '', symbol: '', require: '' }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--in') out.in = argv[++i] || ''
        else if (a === '--symbol') out.symbol = argv[++i] || ''
        else if (a === '--require') out.require = argv[++i] || ''
        else throw new Error(`未知参数：${a}`)
    }
    return out
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// 极简 glob：支持 **、*、?、{a,b}；只用于 --in 里的模式
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

function walk(dir, base, out) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, base, out)
        else if (e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
            out.push(path.relative(base, full).split(path.sep).join('/'))
        }
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

// 把注释与字符串内容替换成空格（保留换行与偏移），避免注释/字符串里的调用被误报
function stripNoise(src) {
    const out = src.split('')
    let i = 0
    const n = src.length
    while (i < n) {
        const c = src[i], d = src[i + 1]
        if (c === '/' && d === '/') {
            while (i < n && src[i] !== '\n') { out[i] = ' '; i++ }
            continue
        }
        if (c === '/' && d === '*') {
            out[i] = out[i + 1] = ' '; i += 2
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] !== '\n') out[i] = ' '
                i++
            }
            if (i < n) { out[i] = out[i + 1] = ' '; i += 2 }
            continue
        }
        if (c === '#') { // Python 行注释；JS 私有字段很少见，这里按注释处理
            while (i < n && src[i] !== '\n') { out[i] = ' '; i++ }
            continue
        }
        if (c === '"' || c === "'" || c === '`') {
            const q = c
            // 先定位字符串结尾，判断它是否处在对象/字典的键位置（紧跟冒号）。
            // Python 字典 {"updateB": True} 的键名必须保留，否则 hasKey 看不到键。
            let j = i + 1
            while (j < n && src[j] !== q) {
                if (src[j] === '\\') j += 2
                else j++
            }
            let k = j + 1
            while (k < n && /\s/.test(src[k])) k++
            if (src[k] === ':') { i = j + 1; continue }
            out[i] = ' '; i++
            while (i < n && src[i] !== q) {
                if (src[i] === '\\') {
                    out[i] = ' '
                    if (i + 1 < n) out[i + 1] = ' '
                    i += 2
                    continue
                }
                if (src[i] !== '\n') out[i] = ' '
                i++
            }
            if (i < n) { out[i] = ' '; i++ }
            continue
        }
        i++
    }
    return out.join('')
}

function splitTop(s) {
    const parts = []
    let depth = 0, cur = ''
    for (const ch of s) {
        if ('([{'.includes(ch)) depth++
        else if (')]}'.includes(ch)) depth--
        if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
    }
    if (cur.trim() || parts.length) parts.push(cur)
    return parts
}

function hasKey(objText, key) {
    return new RegExp('(?:^|[{,])\\s*["\']?' + esc(key) + '["\']?\\s*(?::|,|}|$)').test(objText)
}

function lineOf(text, idx) {
    let line = 1
    for (let i = 0; i < idx; i++) if (text[i] === '\n') line++
    return line
}

function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!args.symbol || !args.require || !args.in) {
        throw new Error('缺少必填参数：--symbol / --require / --in（--in 无默认值，必须显式指定）')
    }
    const files = new Set()
    for (const item of args.in.split(',').map(s => s.trim()).filter(Boolean)) expand(item, files)
    if (!files.size) throw new Error(`--in 没有匹配到任何文件：${args.in}`)

    const callRe = new RegExp('\\b' + esc(args.symbol) + '\\s*\\(', 'g')
    let scanned = 0, hits = 0, unknown = 0, skipped = 0

    for (const abs of [...files].sort()) {
        const rel = path.relative(process.cwd(), abs).split(path.sep).join('/') || abs
        let st
        try { st = fs.statSync(abs) } catch (e) { continue }
        if (st.size > MAX_FILE_BYTES) {
            skipped++
            console.error(`SKIP ${rel}:0 reason=file_too_large bytes=${st.size}`)
            continue
        }
        let src
        try { src = fs.readFileSync(abs, 'utf8') } catch (e) {
            skipped++
            console.error(`SKIP ${rel}:0 reason=read_error`)
            continue
        }
        scanned++
        const code = stripNoise(src)
        callRe.lastIndex = 0
        let m
        while ((m = callRe.exec(code))) {
            const idx = m.index
            const before = code.slice(Math.max(0, idx - 30), idx)
            if (/function\s+$/.test(before) || /def\s+$/.test(before)) continue // 定义点，不是调用
            const open = code.indexOf('(', idx)
            let depth = 0, close = -1
            for (let i = open; i < code.length; i++) {
                if (code[i] === '(') depth++
                else if (code[i] === ')') { depth--; if (depth === 0) { close = i; break } }
            }
            if (close < 0) continue
            if (/^\s*\{/.test(code.slice(close + 1, close + 20))) continue // 方法定义体，不是调用
            const argsArr = splitTop(code.slice(open + 1, close))
            const line = lineOf(code, idx)
            if (argsArr.length < 4) {
                hits++
                console.log(`${rel}:${line} MISSING:${args.require}`)
                continue
            }
            const arg4 = argsArr[3].trim()
            if (arg4.startsWith('{')) {
                if (!hasKey(arg4, args.require)) {
                    hits++
                    console.log(`${rel}:${line} MISSING:${args.require}`)
                }
            } else {
                unknown++ // options 被提取成变量：只报未知，不计命中、不改退出码
                console.error(`UNKNOWN:${arg4.slice(0, 80)} at ${rel}:${line}`)
            }
        }
    }

    console.log(`SUMMARY scanned=${scanned} hits=${hits} unknown=${unknown} skipped=${skipped}`)
    process.exit(hits > 0 ? 1 : 0)
}

try { main() } catch (e) {
    console.error('ERROR ' + (e && e.message ? e.message : e))
    process.exit(2)
}
