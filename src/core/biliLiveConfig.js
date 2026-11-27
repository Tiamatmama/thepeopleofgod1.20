/**
 * B站直播接入配置
 *
 * 网页「开发者面板 → B站直播」里填的房间号 / 弹幕源 / 登录态 / 开放平台密钥等，
 * 持久化到 data/biliLiveConfig.json；文件里没有的字段回退到 .env。
 * 桥接每次启动都从这里取值，因此在网页上改完立即生效，无需重启。
 *
 * 零配置也能跑：既没有登录态、也没有开放平台密钥时，弹幕源自动落到 mock，
 * 由本机注入的假弹幕驱动整条链路（POST /api/bili/test-danmaku），完全不碰 B站。
 */

const fs = require('fs');
const path = require('path');

require('./config');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'biliLiveConfig.json');

// 互动玩法开放平台：官方弹幕源用的域名
const OPEN_LIVE_API = 'https://live-open.biliapi.com';

// 字符型字段：网页留空 = 沿用已保存 / .env 的值
const TEXT_FIELDS = [
    'roomId', 'danmakuSource', 'sessdata',
    'openAppId', 'openAccessKeyId', 'openAccessKeySecret', 'openCode',
    'keywords', 'roleName', 'autoSpeak'
];

// 数值型字段的默认值（留空时用它）
const NUMBER_DEFAULTS = {
    userCooldownSec: 15,
    queueMax: 20,
    replyPerMinute: 12,
    replyMaxChars: 60
};

const ENV_KEY = {
    roomId: 'BILI_ROOM_ID',
    danmakuSource: 'BILI_DANMAKU_SOURCE',
    sessdata: 'BILI_SESSDATA',
    openAppId: 'BILI_OPEN_APP_ID',
    openAccessKeyId: 'BILI_OPEN_ACCESS_KEY_ID',
    openAccessKeySecret: 'BILI_OPEN_ACCESS_KEY_SECRET',
    openCode: 'BILI_OPEN_CODE',
    keywords: 'BILI_KEYWORDS',
    roleName: 'BILI_BRIDGE_ROLE_NAME',
    autoSpeak: 'BILI_AUTO_SPEAK'
};

const NUMBER_ENV_KEY = {
    userCooldownSec: 'BILI_USER_COOLDOWN_SEC',
    queueMax: 'BILI_QUEUE_MAX',
    replyPerMinute: 'BILI_REPLY_PER_MINUTE',
    replyMaxChars: 'BILI_REPLY_MAX_CHARS'
};

// 没配关键词时用来判定「弹幕是不是在叫角色」
const DEFAULT_KEYWORDS = '小助手,助手,助手';
const DEFAULT_SOURCE = 'mock';
const SOURCE_TYPES = ['mock', 'unofficial', 'official'];

function emptyStore() {
    const store = {};
    TEXT_FIELDS.forEach((field) => { store[field] = ''; });
    Object.keys(NUMBER_DEFAULTS).forEach((field) => { store[field] = ''; });
    return store;
}

function loadStore() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return emptyStore();
        }
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const store = emptyStore();
        Object.keys(store).forEach((field) => {
            if (raw[field] !== undefined && raw[field] !== null) {
                store[field] = String(raw[field]);
            }
        });
        return store;
    } catch (error) {
        console.error('[B站配置] 读取失败，改用 .env:', error.message);
        return emptyStore();
    }
}

let store = loadStore();

function pickText(value, envKey, fallback = '') {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    const env = process.env[envKey];
    if (typeof env === 'string' && env.trim()) {
        return env.trim();
    }
    return fallback;
}

function pickNumber(value, envKey, fallback) {
    const parsed = Number(pickText(value, envKey, ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, envKey, fallback) {
    const text = pickText(value, envKey, '').toLowerCase();
    if (!text) return fallback;
    return text === 'true' || text === '1' || text === 'on' || text === 'yes';
}

// 弹幕源解析：显式指定优先，否则按「有什么凭证」自动落位，都没有就用 mock
function resolveSource(config) {
    const explicit = String(config.danmakuSource || '').toLowerCase();
    if (SOURCE_TYPES.includes(explicit)) {
        return explicit;
    }
    if (config.openAppId && config.openAccessKeyId && config.openAccessKeySecret && config.openCode) {
        return 'official';
    }
    if (config.sessdata) {
        return 'unofficial';
    }
    return DEFAULT_SOURCE;
}

function getConfig() {
    const text = {};
    TEXT_FIELDS.forEach((field) => {
        text[field] = pickText(store[field], ENV_KEY[field], '');
    });

    const keywordsRaw = text.keywords || DEFAULT_KEYWORDS;
    const config = {
        roomId: String(text.roomId || '').replace(/\s+/g, ''),
        danmakuSource: text.danmakuSource,
        sessdata: text.sessdata,
        openAppId: text.openAppId,
        openAccessKeyId: text.openAccessKeyId,
        openAccessKeySecret: text.openAccessKeySecret,
        openCode: text.openCode,
        roleName: text.roleName || '小助手',
        autoSpeak: readBoolean(store.autoSpeak, ENV_KEY.autoSpeak, true),
        keywords: keywordsRaw.split(/[,，\s]+/).map((word) => word.trim()).filter(Boolean),
        openLiveApi: OPEN_LIVE_API
    };

    Object.keys(NUMBER_DEFAULTS).forEach((field) => {
        config[field] = pickNumber(store[field], NUMBER_ENV_KEY[field], NUMBER_DEFAULTS[field]);
    });

    config.sourceResolved = resolveSource(config);
    config.credentials = {
        unofficial: Boolean(config.sessdata),
        official: Boolean(config.openAppId && config.openAccessKeyId && config.openAccessKeySecret && config.openCode)
    };
    return config;
}

function mask(secret) {
    if (!secret) return '';
    if (secret.length <= 8) return '****';
    return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

// 回给网页的配置：登录态与密钥只回打码值，真实值不出后端
function getMasked() {
    const config = getConfig();
    return {
        roomId: config.roomId,
        danmakuSource: config.danmakuSource,
        sourceResolved: config.sourceResolved,
        keywords: config.keywords,
        roleName: config.roleName,
        autoSpeak: config.autoSpeak,
        userCooldownSec: config.userCooldownSec,
        queueMax: config.queueMax,
        replyPerMinute: config.replyPerMinute,
        replyMaxChars: config.replyMaxChars,
        sessdataMasked: mask(config.sessdata),
        openAppId: config.openAppId,
        openAccessKeyIdMasked: mask(config.openAccessKeyId),
        openAccessKeySecretMasked: mask(config.openAccessKeySecret),
        openCodeMasked: mask(config.openCode),
        credentials: config.credentials
    };
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2));
    } catch (error) {
        console.error('[B站配置] 保存失败:', error.message);
    }
}

function update(patch = {}) {
    const source = patch || {};
    TEXT_FIELDS.forEach((field) => {
        const value = source[field];
        if (value === undefined || value === null) return;
        const trimmed = String(value).trim();
        if (!trimmed) return; // 留空表示沿用已保存 / .env 的值
        if (field === 'danmakuSource' && !SOURCE_TYPES.includes(trimmed.toLowerCase())) {
            return; // 非法源名直接忽略，避免把配置写坏
        }
        store[field] = trimmed;
    });
    Object.keys(NUMBER_DEFAULTS).forEach((field) => {
        const value = source[field];
        const parsed = Number(value);
        if (value === undefined || value === null || value === '' || !Number.isFinite(parsed) || parsed <= 0) return;
        store[field] = String(Math.floor(parsed));
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
        console.error('[B站配置] 清除失败:', error.message);
    }
    return getMasked();
}

module.exports = {
    getConfig,
    getMasked,
    update,
    reset,
    SOURCE_TYPES,
    OPEN_LIVE_API
};
