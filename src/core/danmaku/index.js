/**
 * 弹幕源工厂
 *
 * 三个实现共用一套契约（见 base.js）：
 *   start(roomId) -> {ok, message}
 *   stop()        -> {ok, message}
 *   status()      -> 状态快照
 *   on('danmaku', handler)  已归一化的事件
 *
 * 选哪个由 biliLiveConfig 的 sourceResolved 决定：
 *   手动指定 > 有官方四要素走 official > 有 SESSDATA 走 unofficial > 都没有走 mock
 * 也就是说「什么都不配」也能用 mock 源把整条链路跑起来。
 */

const { DanmakuSource, KINDS, cleanText } = require('./base');
const { MockSource } = require('./mock');
const { UnofficialSource } = require('./unofficial');
const { OfficialSource } = require('./official');

const SOURCE_LABELS = {
    mock: 'mock（本机假弹幕，不连 B站）',
    unofficial: 'unofficial（直连弹幕长连，需 SESSDATA）',
    official: 'official（开放平台互动玩法，需报备密钥）'
};

function createSource(type, options = {}) {
    switch (String(type || '').toLowerCase()) {
        case 'mock':
            return new MockSource(options);
        case 'unofficial':
            return new UnofficialSource(options);
        case 'official':
            return new OfficialSource(options);
        default:
            throw new Error(`未知弹幕源类型：${type}`);
    }
}

function describeSource(type) {
    return SOURCE_LABELS[String(type || '').toLowerCase()] || `未知弹幕源：${type}`;
}

module.exports = {
    createSource,
    describeSource,
    DanmakuSource,
    MockSource,
    UnofficialSource,
    OfficialSource,
    KINDS,
    cleanText,
    SOURCE_LABELS
};
