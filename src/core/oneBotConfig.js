/**
 * OneBot v11 协议端（NapCat / LLOneBot 等）连接配置
 *
 * 网页「伪开发者界面 → QQ 只读对接」里填写的 HTTP 地址与 access_token，
 * 持久化到 data/oneBotConfig.json；文件里没有的字段回退到 .env。
 * 只读客户端每次请求都从这里取值，因此在网页上改完立即生效，无需重启。
 */

const fs = require('fs');
const path = require('path');

require('./config');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'oneBotConfig.json');

// NapCat / SnowLuma 的 HTTP 服务默认都开在 3000；本项目自己占的是 41888，两者不冲突
const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';

// 支持的协议端。两者都讲 OneBot v11，HTTP 客户端通用，这里只用来存「用户选的是哪个」
const BACKENDS = ['napcat', 'snowluma'];
const DEFAULT_BACKEND = 'napcat';

const FIELDS = ['backend', 'httpUrl', 'accessToken'];

function emptyStore() {
    return { backend: '', httpUrl: '', accessToken: '' };
}

function loadStore() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return emptyStore();
        }
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const store = emptyStore();
        FIELDS.forEach((field) => {
            if (typeof raw[field] === 'string') {
                store[field] = raw[field];
            }
        });
        return store;
    } catch (error) {
        console.error('[OneBot配置] 读取失败，改用 .env:', error.message);
        return emptyStore();
    }
}

let store = loadStore();

// 网页上留空的字段视为「不修改」，因此这里只认非空字符串，其余回退 .env
function pick(value, envKey, fallback = '') {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    const env = process.env[envKey];
    if (typeof env === 'string' && env.trim()) {
        return env.trim();
    }
    return fallback;
}

function getConfig() {
    const backend = pick(store.backend, 'ONEBOT_BACKEND', DEFAULT_BACKEND).toLowerCase();
    return {
        backend: BACKENDS.includes(backend) ? backend : DEFAULT_BACKEND,
        httpUrl: pick(store.httpUrl, 'ONEBOT_HTTP_URL', DEFAULT_HTTP_URL).replace(/\/+$/, ''),
        accessToken: pick(store.accessToken, 'ONEBOT_ACCESS_TOKEN', '')
    };
}

function mask(secret) {
    if (!secret) return '';
    if (secret.length <= 8) return '****';
    return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

// 回给网页的配置：token 只回打码值，避免真实 token 出现在前端
function getMasked() {
    const config = getConfig();
    return {
        backend: config.backend,
        httpUrl: config.httpUrl,
        tokenMasked: mask(config.accessToken)
    };
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2));
    } catch (error) {
        console.error('[OneBot配置] 保存失败:', error.message);
    }
}

function update(patch = {}) {
    FIELDS.forEach((field) => {
        const value = (patch || {})[field];
        if (typeof value !== 'string') return;
        const trimmed = value.trim();
        if (!trimmed) return; // 留空表示沿用已保存 / .env 的值
        if (field === 'backend') {
            const lower = trimmed.toLowerCase();
            if (BACKENDS.includes(lower)) store.backend = lower;
            return;
        }
        store[field] = trimmed;
    });
    persist();
    return getMasked();
}

// 清掉网页上保存的覆盖项，全部回到 .env
function reset() {
    store = emptyStore();
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            fs.unlinkSync(CONFIG_PATH);
        }
    } catch (error) {
        console.error('[OneBot配置] 清除失败:', error.message);
    }
    return getMasked();
}

module.exports = {
    getConfig,
    getMasked,
    update,
    reset
};
