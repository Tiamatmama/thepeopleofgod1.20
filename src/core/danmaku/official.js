/**
 * 官方弹幕源：直播间「互动玩法」开放平台（需要报备过的 app_id / 密钥 / 主播身份码）
 *
 * 流程：
 *   1. POST /v2/app/start   传 code(主播身份码) + app_id，拿 game_id / auth_body / wss_link
 *   2. 连 wss_link[0]，连上就把 auth_body 原样发过去
 *   3. 每 20s POST /v2/app/heartbeat（超过 60s 不心跳会被自动关场次）
 *   4. 停止时 POST /v2/app/end（必须调用，否则下次开播要等 1 分钟以上）
 *
 * 每个请求都要签名：待签名串 = 所有 x-bili-* 请求头按 key 字典序、以 "key:value" 用 \n 拼接，
 * 用 accessKeySecret 做 HMAC-SHA256 取小写十六进制，放进 Authorization 头。
 *
 * 未配齐四要素时 start() 直接失败，不会发起任何请求。
 * 注意：官方协议里观众标识是 open_id，和数字 uid 不是同一套体系。
 */

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const { DanmakuSource } = require('./base');

const HEARTBEAT_MS = 20 * 1000;
const REQUEST_TIMEOUT = 15000;

const ERROR_HINTS = {
    4007: 'IP 不在白名单（4007），需要到开放平台把本机公网 IP 加进白名单',
    4003: '身份码无效或已过期（4003）',
    4004: 'access_key 不对（4004）',
    2002: '该直播间已开启其它互动玩法（2002），请先结束上一个场次'
};

function describeError(code, message) {
    if (code === 0) return '';
    const hint = ERROR_HINTS[code];
    return hint || `开放平台返回错误码 ${code}${message ? `：${message}` : ''}`;
}

class OfficialSource extends DanmakuSource {
    constructor(options = {}) {
        super(options);
        this.type = 'official';
        this.appId = String(options.openAppId || '');
        this.accessKeyId = String(options.openAccessKeyId || '');
        this.accessKeySecret = String(options.openAccessKeySecret || '');
        this.code = String(options.openCode || '');
        this.baseUrl = options.openLiveApi || 'https://live-open.biliapi.com';

        this.ws = null;
        this.heartbeatTimer = null;
        this.heartbeatFailures = 0;
        this.stopping = false;
        this.gameId = '';
        this.authBody = '';
    }

    isConfigured() {
        return Boolean(this.appId && this.accessKeyId && this.accessKeySecret && this.code);
    }

    async start(roomId) {
        if (!this.isConfigured()) {
            const message = '未配齐开放平台四要素（app_id / access_key_id / access_key_secret / 主播身份码），官方弹幕源无法启动';
            this.lastError = message;
            return { ok: false, message };
        }

        await this.shutdown();

        this.roomId = String(roomId || '').trim() || '全部';
        this.stopping = false;
        try {
            const data = await this.request('/v2/app/start', { code: this.code, app_id: Number(this.appId) });
            const gameInfo = data.game_info || {};
            const wsInfo = data.websocket_info || {};
            const anchor = data.anchor_info || {};
            const links = wsInfo.wss_link || [];

            this.gameId = String(gameInfo.game_id || '');
            this.authBody = wsInfo.auth_body || '';
            this.realRoomId = String(anchor.room_id || '');
            this.anchorUid = String(anchor.uid || '');
            this.startedAt = Date.now();
            this.running = true;
            this.lastError = '';
            this.heartbeatFailures = 0;

            if (!this.gameId || !this.authBody || !links.length) {
                throw new Error('开放平台返回的场次信息不完整，无法建立长连');
            }

            this.connect(links[0]);
            this.startHeartbeat();
            return {
                ok: true,
                message: `官方弹幕源已启动：场次 ${this.gameId}，主播 ${anchor.uname || '未知'}，房间 ${this.realRoomId}`
            };
        } catch (error) {
            this.running = false;
            this.connected = false;
            this.lastError = error.message;
            return { ok: false, message: error.message };
        }
    }

    async stop() {
        this.stopping = true;
        const wasRunning = this.running;
        const gameId = this.gameId;
        await this.shutdown();
        this.running = false;
        this.connected = false;
        this.emit('status', this.status());

        // 必须通知开放平台结束场次，否则下次开播要等冷却
        if (wasRunning && gameId) {
            try {
                await this.request('/v2/app/end', { game_id: Number(gameId) });
            } catch (error) {
                return { ok: false, message: `本地已停止，但结束场次失败：${error.message}` };
            }
        }
        return { ok: true, message: wasRunning ? '官方弹幕源已停止，场次已结束' : '官方弹幕源本来就未运行' };
    }

    async shutdown() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        const socket = this.ws;
        this.ws = null;
        if (socket) {
            try {
                socket.removeAllListeners();
                socket.close();
            } catch (error) {
                // 关连接失败无所谓
            }
        }
        this.connected = false;
    }

    // 唯一出网口：签名 → POST → 校验 code
    async request(path, body) {
        const bodyText = JSON.stringify(body || {});
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const headers = {
            'x-bili-accesskeyid': this.accessKeyId,
            'x-bili-content-md5': crypto.createHash('md5').update(bodyText, 'utf8').digest('hex'),
            'x-bili-signature-method': 'HMAC-SHA256',
            'x-bili-signature-nonce': crypto.randomUUID(),
            'x-bili-signature-version': '1.0',
            'x-bili-timestamp': timestamp
        };

        // 待签名串：key 字典序，每行 "key:value"
        const signText = Object.keys(headers)
            .sort()
            .map((key) => `${key}:${headers[key]}`)
            .join('\n');
        const signature = crypto.createHmac('sha256', this.accessKeySecret).update(signText, 'utf8').digest('hex');

        let response;
        try {
            response = await axios.post(`${this.baseUrl}${path}`, bodyText, {
                timeout: REQUEST_TIMEOUT,
                headers: {
                    ...headers,
                    Authorization: signature,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                transformRequest: [(data) => data]
            });
        } catch (error) {
            if (error.response && error.response.status === 403) {
                throw new Error('开放平台拒绝签名（HTTP 403），请检查 access_key_secret 是否写对');
            }
            throw new Error(`请求开放平台失败：${error.message}`);
        }

        const result = response.data || {};
        if (result.code !== 0) {
            throw new Error(describeError(result.code, result.message));
        }
        return result.data || {};
    }

    connect(url) {
        const socket = new WebSocket(url);
        this.ws = socket;

        socket.on('open', () => {
            this.connected = true;
            socket.send(this.authBody);
            this.emit('status', this.status());
        });

        socket.on('message', (data) => {
            try {
                const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
                (Array.isArray(parsed) ? parsed : [parsed]).forEach((cmd) => this.handleCommand(cmd));
            } catch (error) {
                console.error('[官方弹幕源] 解析消息失败:', error.message);
            }
        });

        socket.on('error', (error) => {
            this.lastError = `长连出错：${error.message}`;
            console.error('[官方弹幕源]', this.lastError);
        });

        socket.on('close', () => {
            this.connected = false;
            this.emit('status', this.status());
            // 场次已经被开放平台关掉，重连没有意义；由心跳失败统一收尾
        });
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            if (!this.running || this.stopping || !this.gameId) return;
            this.request('/v2/app/heartbeat', { game_id: Number(this.gameId) })
                .then(() => {
                    this.heartbeatFailures = 0;
                })
                .catch((error) => {
                    this.heartbeatFailures += 1;
                    this.lastError = `心跳失败（第 ${this.heartbeatFailures} 次）：${error.message}`;
                    console.error('[官方弹幕源]', this.lastError);
                });
        }, HEARTBEAT_MS);
    }

    handleCommand(cmd = {}) {
        const name = String(cmd.cmd || '');
        const data = cmd.data || {};

        if (name === 'OPEN_LIVEROOM_DM') {
            this.emitDanmaku({
                kind: 'danmaku',
                uid: data.open_id,
                nickname: data.uname,
                text: data.msg,
                atAnchor: Boolean(data.reply_open_id) || String(data.msg || '').startsWith('@'),
                msgId: data.msg_id,
                guardLevel: data.guard_level,
                raw: { cmd: name, dmType: data.dm_type, isAdmin: data.is_admin }
            });
            return;
        }

        if (name.includes('GIFT')) {
            const gift = data.gift || data;
            this.emitDanmaku({
                kind: 'gift',
                uid: data.open_id,
                nickname: data.uname,
                text: `送出 ${gift.gift_name || gift.giftName || '礼物'} ×${gift.gift_num || gift.num || 1}`,
                gift: {
                    name: gift.gift_name || gift.giftName,
                    count: gift.gift_num || gift.num,
                    price: gift.price || 0
                },
                msgId: data.msg_id,
                raw: { cmd: name }
            });
        }
    }

    status() {
        return {
            ...super.status(),
            gameId: this.gameId,
            heartbeatFailures: this.heartbeatFailures
        };
    }
}

module.exports = { OfficialSource, describeError };
