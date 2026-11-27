'use strict';

// 启动装配 / 生命周期：就绪回调（落服务锁 + 起自主发言与 QQ 自主发言）、退出刷记忆、
// 监听失败兜底与退出信号处理。server/httpsServer/wss 的 listen 仍留在 index.js
// （它们是入口自建对象），这里只提供纯生命周期助手，依赖经 ctx 注入，避免循环依赖。

function setupLifecycle(ctx) {
    const {
        memoryModule,
        inputModule,
        systemNarrator,
        startQQProactiveSpeech,
        writeServerLock,
        clearServerLock
    } = ctx;

// 自主发言调度和 QQ 自主发言与端口无关，只在第一个起来的端口上跑一遍。
// 只开 HTTPS 时若把它们挂在 HTTP 的回调里，就永远不会启动
let started = false;
function onServerReady() {
    if (started) return;
    started = true;
    // 🔒 落服务锁：供 CLI 维护脚本探测「服务是否在跑」→ 拒绝并发整档写（方向二·持久化并发）
    writeServerLock(memoryModule.storagePath);
    console.log(`当前使用API: ${inputModule.getCurrentAPIName()}`);
    systemNarrator.start();
    startQQProactiveSpeech();
}

// 退出收尾：先把内存里尚未落盘的脏记忆刷到盘（close 内部 clearTimeout + flushDirty），
// 再清掉服务锁。任一环节失败都只告警，不挡住退出
function flushMemoryOnExit() {
    try {
        memoryModule.close();
    } catch (error) {
        console.error('[Server] 退出前刷记忆失败:', (error && error.message) ? error.message : error);
    }
    clearServerLock(memoryModule.storagePath);
}

// 退出时清掉服务锁（正常退出/process.exit 都会触发；信号残留由 pid 存活检测兜底）
process.on('exit', flushMemoryOnExit);

// Ctrl+C / kill 默认不触发 'exit' 事件——不显式接上就会丢掉 30s 节流窗口里还没落盘的记忆
['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
        flushMemoryOnExit();
        process.exit(0);
    });
});

// 监听失败兜底：端口占用等错误给出人话提示并退出，而不是未捕获异常崩溃
function onListenError(fallbackPort) {
    return (err) => {
        const port = (err && err.port) || fallbackPort;
        if (err && err.code === 'EADDRINUSE') {
            console.error(`[Server] 端口 ${port} 已被占用，无法启动。`);
            console.error(`[Server] 可能情感中枢已在运行，或其它程序占用了该端口；请关闭占用该端口的程序，或修改 .env 中的端口配置后重试。`);
        } else {
            console.error('[Server] 服务器启动失败：', (err && err.message) ? err.message : err);
        }
        process.exit(1);
    };
}

    return { onServerReady, flushMemoryOnExit, onListenError };
}

module.exports = setupLifecycle;
