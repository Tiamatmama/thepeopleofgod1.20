'use strict';

const js = require('@eslint/js');

// Node 运行时自带的全局变量（CommonJS）。这里显式列出，免得逐条 no-undef 误报。
const nodeGlobals = {
    process: 'readonly',
    require: 'readonly',
    module: 'readonly',
    exports: 'writable',
    __dirname: 'readonly',
    __filename: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    global: 'readonly',
    globalThis: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
    queueMicrotask: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    structuredClone: 'readonly',
    fetch: 'readonly',
    WebSocket: 'readonly'
};

module.exports = [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: {
            // 存量代码里未使用变量较多，先按警告提示，不阻断
            'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
            // 允许以 _ 开头的占位参数/变量
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-prototype-builtins': 'warn',
            'no-useless-escape': 'warn',
            // 以下三条是 ESLint 新版 recommended 引入的规则，存量代码普遍不满足，
            // 先降级为警告保留可见性，避免一上来就红一片；新代码应尽量不新增
            'no-useless-assignment': 'warn',
            'preserve-caught-error': 'warn',
            // 清洗文件名/输入本就依赖匹配控制字符，属预期用法
            'no-control-regex': 'warn'
        }
    },
    {
        files: ['test/**/*.js'],
        languageOptions: { globals: { ...nodeGlobals } }
    },
    {
        // 前端脚本：UMD 的 coding-board.js 与直接操作 DOM 的 stage.js 都需要浏览器全局
        files: ['public/**/*.js'],
        languageOptions: {
            globals: {
                ...nodeGlobals,
                self: 'readonly',
                window: 'readonly',
                document: 'readonly',
                localStorage: 'readonly',
                MutationObserver: 'readonly',
                // live-vision.js：摄像头 / 帧率 / 动画循环
                navigator: 'readonly',
                performance: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                // sw.js：Service Worker 的缓存 API
                caches: 'readonly'
            }
        }
    },
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'backups/**',
            'coverage/**',
            'skills/**',
            '.trae/**',
            'assets/**',
            // 第三方前端库（Monaco 编辑器）原样 vendor，不参与本项目 lint
            'public/vendor/**'
        ]
    }
];
