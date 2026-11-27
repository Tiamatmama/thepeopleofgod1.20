'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_ENTRY = path.resolve(__dirname, '..', '..', 'src', 'server', 'index.js');
const ROOT = path.resolve(__dirname, '..', '..');

// 占住一个端口，验证 server 在 EADDRINUSE 时能给出人话提示并以非 0 退出（而非未捕获崩溃）。
test('server：端口被占用时输出人话提示并以非 0 退出', async () => {
    const blocker = http.createServer((req, res) => res.end('blocked'));
    // 占位必须与 server 实际绑定的地址一致：server 现绑 127.0.0.1，
    // 若这里仍绑 0.0.0.0，Windows 下两者不冲突（server 能照常起），EADDRINUSE 路径就测不到
    const port = await new Promise((resolve) => {
        blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
    });

    const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        shell: false,
        env: Object.assign({}, process.env, {
            SERVER_PORT: String(port),
            SERVER_MODE: 'http'
        })
    });

    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({ timedOut: true });
        }, 30000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ timedOut: false, code });
        });
    });

    try {
        assert.equal(exit.timedOut, false, `server 未在超时前退出，stdout=${stdout}`);
        assert.notEqual(exit.code, 0, '端口占用时退出码应非 0');
        assert.ok(
            stderr.includes('已被占用'),
            `stderr 应包含「已被占用」人话提示，实际 stderr=${stderr}`
        );
    } finally {
        if (exit.timedOut) {
            child.kill();
        }
        await new Promise((resolve) => blocker.close(resolve));
    }
});
