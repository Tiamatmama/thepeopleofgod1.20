#!/usr/bin/env node
'use strict'
// jsoncheck.js —— JSON 语法检查器（只读）。零依赖、单文件、可复制到任意项目。
// 用法：node jsoncheck.js check <file> [--expect-len log=6]
// 退出码：0=合法且长度断言通过；1=坏档或断言失败；2=检查器自身输入错误
// 注意：只证明“是合法 JSON”，不证明字段值域，也不承诺写入安全（写入片段见 contract.md）。

const fs = require('fs')
const path = require('path')

const MAX_BYTES = 50 * 1024 * 1024

function main() {
    const argv = process.argv.slice(2)
    if (argv[0] !== 'check' || !argv[1]) throw new Error('用法：node jsoncheck.js check <file> [--expect-len key=n]')
    const file = path.resolve(argv[1])
    const expects = []
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--expect-len') {
            const v = argv[++i] || ''
            const m = /^([A-Za-z0-9_.-]+)=(\d+)$/.exec(v)
            if (!m) throw new Error(`--expect-len 格式应为 key=n：${v}`)
            expects.push({ key: m[1], n: Number(m[2]) })
        } else throw new Error(`未知参数：${argv[i]}`)
    }

    let st
    try { st = fs.statSync(file) } catch (e) { throw new Error(`文件不存在：${file}`) }
    if (!st.isFile()) throw new Error(`不是文件：${file}`)
    if (st.size > MAX_BYTES) throw new Error(`文件过大（${st.size} 字节），上限 ${MAX_BYTES}`)

    const text = fs.readFileSync(file, 'utf8')
    let data
    try {
        data = JSON.parse(text)
    } catch (e) {
        const msg = String(e && e.message || e)
        const m = /position\s+(\d+)/i.exec(msg)
        const offset = m ? Number(m[1]) : (/Unexpected end of JSON input/i.test(msg) ? text.length : -1)
        console.log(`UNPARSEABLE at=offset ${offset}`)
        console.log(`SUMMARY scanned=1 hits=1 unknown=0 skipped=0`)
        process.exit(1)
    }

    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : []
    console.log(`PARSED ok=true bytes=${st.size} top-keys=${keys.join(',') || '(none)'}`)
    for (const k of keys) {
        if (Array.isArray(data[k])) console.log(`${k}.length=${data[k].length}`)
    }

    let bad = 0
    for (const e of expects) {
        let cur = data
        for (const part of e.key.split('.')) cur = cur == null ? undefined : cur[part]
        if (!Array.isArray(cur) || cur.length !== e.n) {
            bad++
            console.log(`LEN ${e.key}=${Array.isArray(cur) ? cur.length : '(not-array)'} expected=${e.n}`)
        }
    }
    console.log(`SUMMARY scanned=1 hits=${bad} unknown=0 skipped=0`)
    process.exit(bad > 0 ? 1 : 0)
}

try { main() } catch (e) {
    console.error('ERROR ' + (e && e.message ? e.message : e))
    process.exit(2)
}
