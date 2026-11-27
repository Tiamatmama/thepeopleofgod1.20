/**
 * 弹幕源基类
 *
 * 三个实现（mock / unofficial / official）都继承它，并只暴露 4 个方法：
 *   start(roomId) -> {ok, message}   开始收弹幕
 *   stop()        -> {ok, message}   停止
 *   status()      -> 运行状态快照
 *   on('danmaku', handler)           收到一条已归一化的事件
 *
 * 上层（biliLiveBridge）只认这里定义的归一化事件，不关心弹幕从哪来：
 *   { source, kind, uid, nickname, text, atAnchor, gift, guardLevel, msgId, ts, raw }
 * kind: 'danmaku' 普通弹幕 / 'gift' 礼物 / 'superchat' 醒目留言 / 'guard' 上舰
 * 注意 uid 的体系：非官方源是数字 uid，官方源是 open_id，两者不通用。
 */

const EventEmitter = require('events');

const KINDS = ['danmaku', 'gift', 'superchat', 'guard'];

// 弹幕文本里可能混进控制字符，收进来之前先洗掉
function cleanText(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

class DanmakuSource extends EventEmitter {
    constructor(options = {}) {
        super();
        this.type = 'base';
        this.options = options;
        this.running = false;
        this.connected = false;
        this.roomId = '';
        this.realRoomId = '';
        this.anchorUid = '';
        this.startedAt = 0;
        this.lastError = '';
        this.counters = { danmaku: 0, gift: 0, superchat: 0, guard: 0, dropped: 0 };
    }

    // 子类实现
    async start() {
        throw new Error('子类必须实现 start()');
    }

    async stop() {
        this.running = false;
        this.connected = false;
        this.emit('status', this.status());
        return { ok: true, message: '已停止' };
    }

    status() {
        return {
            running: this.running,
            connected: this.connected,
            source: this.type,
            roomId: this.roomId,
            realRoomId: this.realRoomId,
            anchorUid: this.anchorUid,
            startedAt: this.startedAt,
            uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
            lastError: this.lastError,
            counters: { ...this.counters }
        };
    }

    // 归一化 + 计数 + 抛出事件；文本为空且不是礼物的直接丢掉
    emitDanmaku(event = {}) {
        const normalized = this.normalize(event);
        if (!normalized) {
            this.counters.dropped += 1;
            return null;
        }
        this.counters[normalized.kind] = (this.counters[normalized.kind] || 0) + 1;
        this.emit('danmaku', normalized);
        return normalized;
    }

    normalize(event = {}) {
        const kind = KINDS.includes(event.kind) ? event.kind : 'danmaku';
        const text = cleanText(event.text).slice(0, 200);
        if (kind === 'danmaku' && !text) return null;

        let gift = null;
        if (event.gift) {
            gift = {
                name: cleanText(event.gift.name).slice(0, 40) || '礼物',
                count: Math.max(1, Math.floor(Number(event.gift.count) || 1)),
                price: Number(event.gift.price) || 0
            };
        }

        return {
            source: this.type,
            kind,
            uid: String(event.uid === undefined || event.uid === null ? '' : event.uid),
            nickname: cleanText(event.nickname).slice(0, 24) || '观众',
            text,
            atAnchor: Boolean(event.atAnchor),
            gift,
            guardLevel: Math.max(0, Math.floor(Number(event.guardLevel) || 0)),
            msgId: String(event.msgId === undefined || event.msgId === null ? '' : event.msgId),
            ts: Number(event.ts) || Date.now(),
            raw: event.raw || null
        };
    }
}

module.exports = { DanmakuSource, KINDS, cleanText };
