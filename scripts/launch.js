'use strict';

// 情感中枢便携包启动器（supervisor）：
//   1) 用当前 node 拉起 src/server/index.js
//   2) HTTP 探针轮询「服务已就绪」（GET / 任意响应即就绪）
//   3) 就绪后打开浏览器到 /boot.html（确认过渡页）
//   4) 收 Ctrl+C / 关窗时带走子进程树
// 约定：只用 Node 内置模块，新增 0 依赖、0 服务端点；spawn 一律 argv 数组 + shell:false。

const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PORT = 41888;
const READY_INTERVAL_MS = 300;
const READY_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 2000;

// 严格校验端口：仅接受 1..65535 的整数，其余一律抛错。
function normalizePort(port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`非法端口：${port}`);
    }
    return n;
}

// 返回回环上的确认过渡页地址（固定 127.0.0.1、纯数字端口、无凭证参数）。
function buildBootUrl(port) {
    return `http://127.0.0.1:${normalizePort(port)}/boot.html`;
}

// 读取 SERVER_PORT，口径与 server 端 `Number(process.env.SERVER_PORT) || 41888` 对齐：
// 空/非法（NaN/0）回落默认端口；越界（如 70000）则判失败。
function parsePort(env) {
    const raw = env ? env.SERVER_PORT : undefined;
    const n = Number(raw) || DEFAULT_PORT;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`SERVER_PORT 不是合法端口：${raw}`);
    }
    return n;
}

// 单次探针：拿到任意 HTTP 响应即视为就绪；连接失败/超时视为未就绪。
function httpProbeOnce(url, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ready) => {
            if (settled) return;
            settled = true;
            resolve(ready);
        };
        let req;
        try {
            req = http.get(url, (res) => {
                res.resume(); // 丢弃响应体，释放连接
                done(true);
            });
        } catch (err) {
            done(false);
            return;
        }
        req.on('error', () => done(false));
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            done(false);
        });
    });
}

// 轮询等待就绪：成功 / 超时 / 取消三条路径都会清理定时器，且只 settle 一次。
function waitForReady(options = {}) {
    const {
        url,
        intervalMs = READY_INTERVAL_MS,
        timeoutMs = READY_TIMEOUT_MS,
        probe = httpProbeOnce,
        signal
    } = options;

    return new Promise((resolve) => {
        let settled = false;
        let interval = null;
        let timeout = null;

        function cleanup() {
            if (interval !== null) {
                clearInterval(interval);
                interval = null;
            }
            if (timeout !== null) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        }

        function settle(result) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function onAbort() {
            settle({ ok: false, reason: 'aborted' });
        }

        function tick() {
            if (settled) return;
            Promise.resolve()
                .then(() => probe(url))
                .then((ready) => {
                    if (ready) settle({ ok: true });
                })
                .catch(() => {
                    // 探测异常按「未就绪」处理，继续轮询
                });
        }

        if (signal) {
            if (signal.aborted) {
                settle({ ok: false, reason: 'aborted' });
                return;
            }
            signal.addEventListener('abort', onAbort);
        }

        timeout = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);
        interval = setInterval(tick, intervalMs);
        tick();
    });
}

// 打开浏览器：各平台用各自的原生打开命令，argv 数组 + shell:false，避免字符串注入。
function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            spawn('cmd.exe', ['/c', 'start', '', url], {
                shell: false,
                windowsHide: true,
                stdio: 'ignore'
            });
            return;
        }
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(opener, [url], { shell: false, stdio: 'ignore', detached: true });
        child.on('error', () => {
            // 没装 xdg-open 的服务器环境很常见，提示但不影响服务
            console.warn('[启动器] 打不开浏览器，请手动访问上面的地址');
        });
        child.unref();
    } catch (err) {
        // 打开浏览器失败不影响服务本身运行
        console.warn('[启动器] 打开浏览器失败：', err.message);
    }
}

// 杀掉子进程整棵树（Windows 用 taskkill /T；POSIX 先 SIGTERM，留给进程自己收尾）。
function killTree(child) {
    if (!child || !child.pid || child.exitCode !== null) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false });
        } else {
            child.kill('SIGTERM');
            setTimeout(() => {
                try {
                    if (child.exitCode === null) child.kill('SIGKILL');
                } catch (err) {
                    void err;
                }
            }, 5000).unref();
        }
    } catch (err) {
        // 进程可能已退出，忽略
        void err;
    }
}

function main() {
    const root = path.resolve(__dirname, '..');

    let port;
    try {
        port = parsePort(process.env);
    } catch (err) {
        console.error(`[启动器] ${err.message}`);
        console.error('[启动器] 请检查 .env 里的 SERVER_PORT 后重试。');
        process.exit(1);
        return;
    }

    const serverEntry = path.join(root, 'src', 'server', 'index.js');
    const child = spawn(process.execPath, [serverEntry], {
        cwd: root,
        stdio: 'inherit',
        shell: false,
        env: process.env
    });

    const controller = new AbortController();
    const probeUrl = `http://127.0.0.1:${port}/`;
    const bootUrl = buildBootUrl(port);
    let phase = 'waiting'; // waiting -> ready -> exited

    child.on('error', (err) => {
        if (phase !== 'waiting') return;
        phase = 'exited';
        controller.abort();
        console.error(`[启动器] 无法启动服务器进程：${err.message}`);
        process.exit(1);
    });

    child.on('exit', (code, signal) => {
        if (phase === 'waiting') {
            phase = 'exited';
            controller.abort();
            console.error(`[启动器] 启动失败：服务器进程已退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}），详见上方输出。`);
            process.exit(typeof code === 'number' && code !== 0 ? code : 1);
            return;
        }
        if (phase === 'ready') {
            phase = 'exited';
            process.exit(typeof code === 'number' ? code : 0);
        }
    });

    waitForReady({ url: probeUrl, signal: controller.signal }).then((result) => {
        if (phase !== 'waiting') return;
        if (!result.ok) {
            phase = 'exited';
            console.error(`[启动器] 启动失败：等待服务就绪超时（${READY_TIMEOUT_MS}ms 内未收到 ${probeUrl} 的任何响应）。`);
            console.error('[启动器] 请查看上方服务器输出，确认端口是否被占用或 .env 配置是否正确。');
            killTree(child);
            process.exit(1);
            return;
        }
        phase = 'ready';
        console.log(`[启动器] 服务已就绪：${probeUrl}`);
        console.log('[启动器] 正在打开浏览器…');
        openBrowser(bootUrl);
    });

    function onSignal() {
        controller.abort();
        killTree(child);
        process.exit(0);
    }
    process.on('SIGINT', onSignal);
    process.on('SIGBREAK', onSignal);
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizePort,
    buildBootUrl,
    parsePort,
    httpProbeOnce,
    waitForReady,
    DEFAULT_PORT,
    READY_INTERVAL_MS,
    READY_TIMEOUT_MS
};
