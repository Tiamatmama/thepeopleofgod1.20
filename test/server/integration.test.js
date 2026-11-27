'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_ENTRY = path.resolve(__dirname, '..', '..', 'src', 'server', 'index.js');
const ROOT = path.resolve(__dirname, '..', '..');

// 取一个当前空闲的回环端口（拿到即刻释放，供子进程去绑）
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function request(port, options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(Object.assign({ host: '127.0.0.1', port }, options), (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

// 轮询公开接口，等服务器真正起来（避免用固定 sleep 造成偶发失败）
async function waitForReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const res = await request(port, { method: 'GET', path: '/api/ai/config' });
            if (res.statusCode === 200) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('服务器未在超时内就绪: ' + (lastError ? lastError.message : 'unknown'));
}

// 最小集成：真起一次服务，验证「能启动 + 公开接口 JSON 契约 + 安全头 + 全局错误兜底」。
// 不引入 supertest：index.js 在 require 时就 listen，只能以子进程方式端到端验证。
test('server：能启动、公开接口返回 JSON 且带安全头、漏网请求体错误走全局兜底', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        shell: false,
        env: Object.assign({}, process.env, {
            SERVER_PORT: String(port),
            SERVER_MODE: 'http'
        })
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', () => {});

    try {
        await waitForReady(port, 30000);

        // ① 公开 GET 接口：200 + JSON 契约 + 安全响应头
        const config = await request(port, { method: 'GET', path: '/api/ai/config' });
        assert.equal(config.statusCode, 200, `stderr=${stderr}`);
        assert.match(String(config.headers['content-type'] || ''), /application\/json/);
        assert.equal(config.headers['x-content-type-options'], 'nosniff');
        const parsed = JSON.parse(config.body);
        assert.equal(typeof parsed.currentAPI, 'string');

        // ② 漏网的请求体解析错误：应被全局错误中间件接住 → 400 通用话术，不回吐内部 details
        const bad = await request(
            port,
            { method: 'POST', path: '/api/input', headers: { 'Content-Type': 'application/json' } },
            '{ this is not valid json'
        );
        assert.equal(bad.statusCode, 400);
        const badBody = JSON.parse(bad.body);
        assert.equal(badBody.success, false);
        assert.equal(badBody.message, '请求体格式错误');
    } finally {
        child.kill();
        await new Promise((resolve) => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
            child.on('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
});
