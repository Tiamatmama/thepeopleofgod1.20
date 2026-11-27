/**
 * mock 弹幕源：零凭证也能跑通整条链路的那个「假直播间」
 *
 * 不发起任何网络请求，start() 立刻就是 connected 状态，
 * 弹幕由本机接口 POST /api/bili/test-danmaku 手动注入（桥接层会调 inject()）。
 * 用途：没有 SESSDATA / 开放平台密钥时，验证「弹幕 → 回复 → 语音 → 网页」全通。
 */

const { DanmakuSource } = require('./base');

class MockSource extends DanmakuSource {
    constructor(options = {}) {
        super(options);
        this.type = 'mock';
        this.history = [];
    }

    async start(roomId) {
        this.roomId = String(roomId || 'mock-room');
        this.realRoomId = this.roomId;
        this.running = true;
        this.connected = true;
        this.startedAt = Date.now();
        this.lastError = '';
        this.emit('status', this.status());
        return {
            ok: true,
            message: 'mock 弹幕源已就绪：不会连接 B站，弹幕由 POST /api/bili/test-danmaku 本地注入'
        };
    }

    async stop() {
        const result = await super.stop();
        return { ...result, message: 'mock 弹幕源已停止' };
    }

    // 外部喂一条弹幕进来，走和真实源完全一样的归一化 / 事件出口
    inject(event = {}) {
        if (!this.running) {
            return { ok: false, message: 'mock 弹幕源未启动，请先调用 /api/bili/live/start' };
        }
        const normalized = this.emitDanmaku({
            kind: event.kind || 'danmaku',
            uid: event.uid || 'mock-uid-1',
            nickname: event.nickname || '测试观众',
            text: event.text || '',
            atAnchor: Boolean(event.atAnchor),
            gift: event.gift || null,
            guardLevel: event.guardLevel || 0,
            msgId: event.msgId || `mock-${Date.now()}`,
            ts: Date.now()
        });
        if (!normalized) {
            return { ok: false, message: '弹幕内容为空，已丢弃' };
        }
        this.history.push(normalized);
        if (this.history.length > 50) this.history.shift();
        return { ok: true, message: '已注入 mock 弹幕', event: normalized };
    }

    status() {
        return { ...super.status(), history: this.history.slice(-10) };
    }
}

module.exports = { MockSource };
