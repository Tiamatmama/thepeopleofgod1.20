/**
 * 非官方弹幕源：直连 B站直播的弹幕长连（需要自己账号的 SESSDATA）
 *
 * 流程：
 *   1. room_init    短号 → 真实房号（房间号填短号也能用）
 *   2. getDanmuInfo 拿 token 与弹幕服务器列表（这一步必须带 Cookie: SESSDATA，否则 -352）
 *   3. wss://<host>:<wss_port>/sub 建连 → 发 op=7 认证包 → 每 30s 发 op=2 心跳
 *   4. 收 op=5 普通包；协议版本 2 是 zlib 压缩、3 是 brotli，解完还要再按包结构拆
 *   5. 断线按指数退避重连（1s → 2s → 4s … 上限 30s）
 *
 * 未填 SESSDATA 时 start() 直接失败，不会发起任何连接。
 */

const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const { DanmakuSource } = require('./base');

const ROOM_INIT_API = 'https://api.live.bilibili.com/room/v1/Room/room_init';
const DANMU_INFO_API = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';

const OP_HEARTBEAT = 2;
const OP_HEARTBEAT_REPLY = 3;
const OP_MESSAGE = 5;
const OP_AUTH = 7;
const OP_AUTH_REPLY = 8;

const HEARTBEAT_MS = 30 * 1000;
const REQUEST_TIMEOUT = 10000;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://live.bilibili.com/'
};

// 16 字节包头：总长(4) 头长(2) 协议版本(2) 操作码(4) 序号(4)
function encodePacket(op, body, version = 1) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body === undefined || body === null ? '' : body), 'utf8');
    const header = Buffer.alloc(16);
    header.writeUInt32BE(16 + payload.length, 0);
    header.writeUInt16BE(16, 4);
    header.writeUInt16BE(version, 6);
    header.writeUInt32BE(op, 8);
    header.writeUInt32BE(1, 12);
    return Buffer.concat([header, payload]);
}

function decodePackets(buffer) {
    const packets = [];
    let offset = 0;
    while (offset + 16 <= buffer.length) {
        const total = buffer.readUInt32BE(offset);
        const headerLen = buffer.readUInt16BE(offset + 4);
        const version = buffer.readUInt16BE(offset + 6);
        const op = buffer.readUInt32BE(offset + 8);
        if (total < headerLen || offset + total > buffer.length) break;
        packets.push({ version, op, body: buffer.subarray(offset + headerLen, offset + total) });
        offset += total;
    }
    return packets;
}

function inflateBody(body) {
    try {
        return zlib.inflateSync(body);
    } catch (error) {
        return zlib.inflateRawSync(body);
    }
}

// 说明错误码，方便在网页上直接看懂
function describeCode(code) {
    if (code === -352) return '登录态无效或已过期（-352），请在网页重新填 SESSDATA';
    if (code === -400) return '请求参数不对（-400），请检查房间号';
    if (code === 0) return '';
    return `B站返回错误码 ${code}`;
}

class UnofficialSource extends DanmakuSource {
    constructor(options = {}) {
        super(options);
        this.type = 'unofficial';
        this.sessdata = options.sessdata || '';
        this.ws = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.stopping = false;
        this.token = '';
        this.wsHost = '';
        this.popularity = 0;
    }

    async start(roomId) {
        if (!this.sessdata) {
            const message = '未填写 SESSDATA，非官方弹幕源无法启动';
            this.lastError = message;
            return { ok: false, message };
        }
        const input = String(roomId || '').trim();
        if (!input) {
            const message = '未填写直播间房间号';
            this.lastError = message;
            return { ok: false, message };
        }

        await this.shutdown();

        this.roomId = input;
        this.stopping = false;
        try {
            this.realRoomId = await this.fetchRealRoomId(input);
            const info = await this.fetchDanmuInfo(this.realRoomId);
            this.token = info.token;
            this.wsHost = info.host;
            this.startedAt = Date.now();
            this.running = true;
            this.lastError = '';
            this.reconnectAttempts = 0;
            this.connect();
            return {
                ok: true,
                message: `非官方弹幕源已启动：真实房号 ${this.realRoomId}，弹幕服务器 ${info.host}`
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
        await this.shutdown();
        this.running = false;
        this.connected = false;
        this.emit('status', this.status());
        return { ok: true, message: wasRunning ? '非官方弹幕源已停止' : '非官方弹幕源本来就未运行' };
    }

    async shutdown() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.ws;
        this.ws = null;
        if (socket) {
            try {
                socket.removeAllListeners();
                socket.close();
            } catch (error) {
                // 关连接失败无所谓，后面会重建
            }
        }
        this.connected = false;
    }

    async fetchRealRoomId(roomId) {
        const response = await axios.get(ROOM_INIT_API, {
            params: { id: roomId },
            timeout: REQUEST_TIMEOUT,
            headers: { ...COMMON_HEADERS, Cookie: `SESSDATA=${this.sessdata}` }
        });
        const body = response.data || {};
        if (body.code !== 0 || !body.data) {
            throw new Error(describeCode(body.code) || 'room_init 没有返回房间数据');
        }
        this.anchorUid = String(body.data.uid || '');
        return String(body.data.room_id);
    }

    async fetchDanmuInfo(realRoomId) {
        const response = await axios.get(DANMU_INFO_API, {
            params: { id: realRoomId, type: 0 },
            timeout: REQUEST_TIMEOUT,
            headers: {
                ...COMMON_HEADERS,
                Referer: `https://live.bilibili.com/${realRoomId}`,
                Cookie: `SESSDATA=${this.sessdata}`
            }
        });
        const body = response.data || {};
        if (body.code !== 0 || !body.data) {
            throw new Error(describeCode(body.code) || 'getDanmuInfo 没有返回弹幕服务器信息');
        }
        const hosts = body.data.host_list || [];
        if (!hosts.length) {
            throw new Error('getDanmuInfo 没有返回可用弹幕服务器');
        }
        const host = hosts[0];
        return {
            token: body.data.token,
            host: `${host.host}:${host.wss_port}`
        };
    }

    connect() {
        const socket = new WebSocket(`wss://${this.wsHost}/sub`, {
            headers: { ...COMMON_HEADERS, Origin: 'https://live.bilibili.com' }
        });
        this.ws = socket;

        socket.on('open', () => {
            this.connected = true;
            this.reconnectAttempts = 0;
            socket.send(encodePacket(OP_AUTH, JSON.stringify({
                uid: Number(this.anchorUid) || 0,
                roomid: Number(this.realRoomId),
                protover: 3,
                platform: 'web',
                type: 2,
                key: this.token
            })));
            this.startHeartbeat();
            this.emit('status', this.status());
        });

        socket.on('message', (data) => {
            try {
                this.handleFrame(Buffer.from(data));
            } catch (error) {
                console.error('[非官方弹幕源] 解包失败:', error.message);
            }
        });

        socket.on('error', (error) => {
            this.lastError = `弹幕连接出错：${error.message}`;
            console.error('[非官方弹幕源]', this.lastError);
        });

        socket.on('close', () => {
            this.connected = false;
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
            this.emit('status', this.status());
            if (this.running && !this.stopping) {
                this.scheduleReconnect();
            }
        });
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.connected) {
                // 心跳载荷服务端不看内容，保持和官方客户端一致即可
                this.ws.send(encodePacket(OP_HEARTBEAT, '[object Object]'));
            }
        }, HEARTBEAT_MS);
    }

    scheduleReconnect() {
        this.reconnectAttempts += 1;
        this.counters.reconnect = this.reconnectAttempts;
        const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)));
        console.log(`[非官方弹幕源] ${delay / 1000}s 后重连（第 ${this.reconnectAttempts} 次）`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (!this.running || this.stopping) return;
            this.fetchDanmuInfo(this.realRoomId)
                .then((info) => {
                    this.token = info.token;
                    this.wsHost = info.host;
                    this.connect();
                })
                .catch((error) => {
                    this.lastError = `重连取弹幕服务器失败：${error.message}`;
                    this.scheduleReconnect();
                });
        }, delay);
    }

    handleFrame(buffer) {
        decodePackets(buffer).forEach((packet) => {
            if (packet.op === OP_HEARTBEAT_REPLY) {
                this.popularity = packet.body.length >= 4 ? packet.body.readUInt32BE(0) : 0;
                return;
            }
            if (packet.op === OP_AUTH_REPLY) {
                const body = JSON.parse(packet.body.toString('utf8') || '{}');
                if (body.code !== 0) {
                    this.lastError = describeCode(body.code) || '弹幕服务器认证失败';
                    console.error('[非官方弹幕源]', this.lastError);
                }
                return;
            }
            if (packet.op !== OP_MESSAGE) return;

            if (packet.version === 2) {
                this.handleFrame(inflateBody(packet.body));
            } else if (packet.version === 3) {
                this.handleFrame(zlib.brotliDecompressSync(packet.body));
            } else {
                const text = packet.body.toString('utf8').trim();
                if (!text) return;
                const parsed = JSON.parse(text);
                (Array.isArray(parsed) ? parsed : [parsed]).forEach((cmd) => this.handleCommand(cmd));
            }
        });
    }

    handleCommand(cmd = {}) {
        const name = String(cmd.cmd || '');
        const data = cmd.data || {};
        if (name.startsWith('DANMU_MSG')) {
            const info = data.info || [];
            const user = info[2] || [];
            const text = String(info[1] || '');
            this.emitDanmaku({
                kind: 'danmaku',
                uid: user[0],
                nickname: user[1],
                text,
                atAnchor: text.startsWith('@'),
                msgId: (info[0] && info[0][5]) || '',
                raw: { cmd: name }
            });
            return;
        }
        if (name === 'SEND_GIFT') {
            this.emitDanmaku({
                kind: 'gift',
                uid: data.uid,
                nickname: data.uname,
                text: `送出 ${data.giftName || '礼物'} ×${data.num || 1}`,
                gift: { name: data.giftName, count: data.num, price: data.price },
                msgId: data.tid || '',
                raw: { cmd: name }
            });
            return;
        }
        if (name === 'SUPER_CHAT_MESSAGE') {
            const userInfo = data.user_info || {};
            this.emitDanmaku({
                kind: 'superchat',
                uid: data.uid,
                nickname: userInfo.uname,
                text: data.message || '',
                gift: { name: '醒目留言', count: 1, price: data.price },
                msgId: data.id,
                raw: { cmd: name }
            });
            return;
        }
        if (name === 'GUARD_BUY') {
            this.emitDanmaku({
                kind: 'guard',
                uid: data.uid,
                nickname: data.username,
                text: `开通了 ${data.gift_name || '大航海'} ×${data.num || 1}`,
                guardLevel: data.guard_level,
                gift: { name: data.gift_name, count: data.num, price: 0 },
                raw: { cmd: name }
            });
        }
    }

    status() {
        return {
            ...super.status(),
            popularity: this.popularity,
            reconnectAttempts: this.reconnectAttempts
        };
    }
}

module.exports = { UnofficialSource, encodePacket, decodePackets };
