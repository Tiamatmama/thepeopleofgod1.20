/**
 * B站直播桥接
 *
 * 把「弹幕源 → 触发判定 → 限流 → 走一遍 QQ 那套编排链 → 合成语音 → 推给网页皮套」串起来。
 *
 * 数据隔离与 QQ 桥接一致：每个观众一份独立会话，落在 data/bili_sessions/，
 * 角色设定跟着网页端那份角色走，不碰网页端原有的会话与关系数据。
 *
 * 触发策略：@角色 / 关键词命中 / 送礼（含醒目留言、上舰）三类，其余弹幕只统计不回复。
 * 限流：同一观众冷却、同一观众重复弹幕、队列上限、每分钟总回复数四个闸门。
 * 弹幕源由 biliLiveConfig 决定，什么都没配时落到 mock，靠本机注入弹幕把链路跑通。
 */

const EventEmitter = require('events');
const biliLiveConfig = require('./biliLiveConfig');
const { createSource, describeSource } = require('./danmaku');

const SESSION_PREFIX = 'session_bili_';
// 只播她自己合成的声音
const BRIDGE_VOICE = 'persona';

// 回复超过上限时，尽量在标点处收尾而不是拦腰砍断
function trimReply(text, max) {
    if (!max || text.length <= max) return text;
    const head = text.slice(0, max);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('~'), head.lastIndexOf('，'));
    return cut >= Math.floor(max * 0.5) ? head.slice(0, cut + 1) : `${head}…`;
}

class BiliLiveBridge extends EventEmitter {
    constructor(deps = {}) {
        super();
        this.biliSessionManager = deps.biliSessionManager;
        this.roleSourceManager = deps.roleSourceManager;   // 网页端那份，用来取角色设定
        this.inputModule = deps.inputModule;
        this.memoryModule = deps.memoryModule;
        this.emotionModule = deps.emotionModule;
        this.emotionLedger = deps.emotionLedger;
        this.galgameModule = deps.galgameModule;
        this.outputModule = deps.outputModule;
        this.ttsModule = deps.ttsModule;

        this.source = null;
        this.sourceType = '';
        this.roleName = '小助手';
        this.autoSpeak = true;
        this.queue = [];
        this.processing = false;
        this.lastReplyByUser = new Map();
        this.lastTextByUser = new Map();
        this.replyTimes = [];
        this.lastReply = '';
        this.lastAudioUrl = '';
        this.stats = { received: 0, triggered: 0, replied: 0, throttled: 0, failed: 0 };
    }

    // ---------- 弹幕源生命周期 ----------

    async start() {
        if (this.source) {
            return { ok: false, message: `弹幕源已在运行（${describeSource(this.sourceType)}）` };
        }
        const config = biliLiveConfig.getConfig();
        this.roleName = config.roleName;
        this.autoSpeak = config.autoSpeak;

        const source = createSource(config.sourceResolved, {
            sessdata: config.sessdata,
            openAppId: config.openAppId,
            openAccessKeyId: config.openAccessKeyId,
            openAccessKeySecret: config.openAccessKeySecret,
            openCode: config.openCode,
            openLiveApi: config.openLiveApi
        });
        source.on('danmaku', (event) => this.handleEvent(event));
        source.on('status', () => this.emitMessage({ type: 'bili_status', ...this.status() }));

        const result = await source.start(config.roomId);
        if (!result.ok) {
            source.removeAllListeners();
            return result;
        }

        this.source = source;
        this.sourceType = config.sourceResolved;
        this.applyRoleToSessions();
        this.emitMessage({ type: 'bili_status', ...this.status() });
        return { ok: true, message: `${result.message}；触发策略：${config.keywords.join(' / ')}` };
    }

    async stop() {
        if (!this.source) {
            return { ok: true, message: '弹幕源本来就未运行' };
        }
        const source = this.source;
        this.source = null;
        this.sourceType = '';
        this.queue = [];
        const result = await source.stop();
        source.removeAllListeners();
        this.emitMessage({ type: 'bili_status', ...this.status() });
        return result;
    }

    status() {
        const config = biliLiveConfig.getConfig();
        return {
            running: Boolean(this.source),
            source: this.sourceType,
            sourceLabel: this.sourceType ? describeSource(this.sourceType) : '',
            sourceResolved: config.sourceResolved,
            credentials: config.credentials,
            roomId: config.roomId,
            roleName: this.roleName,
            autoSpeak: this.autoSpeak,
            keywords: config.keywords,
            queueLength: this.queue.length,
            processing: this.processing,
            lastReply: this.lastReply,
            lastAudioUrl: this.lastAudioUrl,
            stats: { ...this.stats },
            sourceStatus: this.source ? this.source.status() : null
        };
    }

    // mock 源专用：本地喂一条弹幕
    inject(event) {
        if (!this.source) {
            return { ok: false, message: '弹幕源未启动，请先调用 /api/bili/live/start' };
        }
        if (typeof this.source.inject !== 'function') {
            return { ok: false, message: `当前是 ${this.sourceType} 源，弹幕来自真实直播间，不能注入` };
        }
        return this.source.inject(event);
    }

    // ---------- 触发与限流 ----------

    handleEvent(event) {
        this.stats.received += 1;
        this.emitMessage({ type: 'bili_danmaku', ...event });

        const gate = this.passTrigger(event);
        if (!gate.pass) {
            this.stats.throttled += 1;
            return gate;
        }
        const limit = this.passLimit(event);
        if (!limit.pass) {
            this.stats.throttled += 1;
            return limit;
        }

        this.stats.triggered += 1;
        // 冷却 / 去重 / 每分钟计数在「决定回」的这一刻就记账，
        // 否则同一秒涌进来的重复弹幕会在回复完成前全部放行
        const now = Date.now();
        if (event.kind === 'danmaku') {
            this.lastReplyByUser.set(event.uid, now);
            this.lastTextByUser.set(event.uid, event.text);
        }
        this.replyTimes.push(now);

        const config = biliLiveConfig.getConfig();
        while (this.queue.length >= config.queueMax) {
            this.queue.shift(); // 队列满时丢最旧的，保证最近的弹幕能得到回应
        }
        this.queue.push(event);
        this.pump();
        return { pass: true };
    }

    // 闸门一：这条弹幕该不该回
    passTrigger(event) {
        if (event.kind !== 'danmaku') {
            return { pass: true }; // 送礼 / 醒目留言 / 上舰一律回
        }
        const config = biliLiveConfig.getConfig();
        const hitKeyword = config.keywords.some((word) => word && event.text.includes(word));
        if (event.atAnchor || hitKeyword) {
            return { pass: true };
        }
        return { pass: false, reason: '未 @ 角色也没命中关键词' };
    }

    // 闸门二～五：冷却 / 重复 / 每分钟上限
    passLimit(event) {
        const config = biliLiveConfig.getConfig();
        const now = Date.now();

        if (event.kind === 'danmaku') {
            const last = this.lastReplyByUser.get(event.uid) || 0;
            if (now - last < config.userCooldownSec * 1000) {
                return { pass: false, reason: `同一观众冷却中（${config.userCooldownSec}s）` };
            }
            if (this.lastTextByUser.get(event.uid) === event.text) {
                return { pass: false, reason: '重复弹幕，跳过' };
            }
        }

        this.replyTimes = this.replyTimes.filter((time) => now - time < 60000);
        if (this.replyTimes.length >= config.replyPerMinute) {
            return { pass: false, reason: `每分钟回复数已达上限（${config.replyPerMinute}）` };
        }
        return { pass: true };
    }

    // 一条一条处理，避免同一时间把模型并发打满
    async pump() {
        if (this.processing) return;
        this.processing = true;
        try {
            while (this.queue.length) {
                const event = this.queue.shift();
                await this.processEvent(event);
            }
        } finally {
            this.processing = false;
        }
    }

    // ---------- 会话与角色 ----------

    characterConfig() {
        const source = this.roleSourceManager.findByName(this.roleName);
        const base = (source && source.characterConfig) ? { ...source.characterConfig } : { name: this.roleName };
        return { ...base, name: this.roleName };
    }

    ensureSession(uid, nickname) {
        const key = String(uid || 'unknown');
        const sessionId = `${SESSION_PREFIX}${key}`;
        const userId = `bili_${key}`;
        const characterConfig = { ...this.characterConfig(), creatorId: userId };
        const existing = this.biliSessionManager.getSession(sessionId);
        if (!existing) {
            this.biliSessionManager.createSession(characterConfig, sessionId);
            console.log(`[B站桥接] 已为观众 ${nickname || key}（${key}）建立独立会话 ${sessionId}`);
        } else {
            existing.characterConfig = { ...existing.characterConfig, ...characterConfig };
            this.biliSessionManager.saveSession(sessionId);
        }
        return { sessionId, userId };
    }

    // 切角色 / 改人设后，把新设定刷到每个观众的已有会话上
    applyRoleToSessions() {
        const config = this.characterConfig();
        const fields = {
            name: config.name,
            age: config.age || '',
            personality: config.personality || '',
            background: config.background || '',
            backgroundEnabled: config.backgroundEnabled !== undefined ? config.backgroundEnabled !== false : true,
            targetRelationship: config.targetRelationship || 'STRANGER'
        };
        if (config.backgroundWeight !== undefined) {
            fields.backgroundWeight = config.backgroundWeight;
        }
        const sessions = this.biliSessionManager.getAllSessions();
        sessions.forEach((session) => this.biliSessionManager.updateSession(session.sessionId, fields));
        console.log(`[B站桥接] 角色「${fields.name}」已刷新到 ${sessions.length} 个观众会话`);
    }

    // ---------- 主链路 ----------

    async processEvent(event) {
        const config = biliLiveConfig.getConfig();
        const { sessionId, userId } = this.ensureSession(event.uid, event.nickname);
        const history = this.biliSessionManager.getConversationHistory(sessionId, userId, 5);

        // 礼物没有正文，用礼物本身当这次输入的语义
        const inputText = event.text || (event.gift ? `送出了${event.gift.name}×${event.gift.count}` : '在吗');

        try {
            const processedInput = await this.inputModule.process({ data: inputText, sessionId, userId }, history, null);
            this.memoryModule.storeMemory(processedInput, userId, inputText);
            this.emotionModule.updateEmotion(processedInput.value, sessionId, userId, processedInput.signals);
            setImmediate(() => {
                this.emotionLedger.observe(processedInput, {
                    sessionId, userId, text: inputText, source: 'bili_live'
                }).catch((error) => console.error('[情感工具] 履历记账失败:', error.message));
            });
            const emotionState = this.emotionModule.calculateEmotion(sessionId, userId);

            const output = await this.outputModule.generateOutputAsync(
                emotionState,
                this.galgameModule.getCurrentRelationship(sessionId, userId),
                { data: inputText, sessionId, userId },
                history,
                sessionId,
                userId,
                null
            );

            const apiAffectionChange = typeof output.apiAffectionChange === 'number' ? output.apiAffectionChange : null;
            this.galgameModule.updateRelationship(processedInput, apiAffectionChange, output.apiThinking || '', sessionId, userId);

            const currentUser = this.biliSessionManager.getUser(sessionId, userId);
            if (currentUser) {
                const localDelta = (Number(processedInput.value) || 0) * 5;
                const scoreDelta = apiAffectionChange !== null ? apiAffectionChange : localDelta;
                this.biliSessionManager.updateUserRelationship(sessionId, userId, currentUser.relationshipScore + scoreDelta);
            }

            const raw = typeof output.data === 'string' ? output.data.trim().replace(/\n{2,}/g, '\n') : '';
            if (!raw) {
                this.stats.failed += 1;
                return { skipped: '生成结果为空' };
            }
            const reply = trimReply(raw, config.replyMaxChars);

            let audioUrl = '';
            if (this.autoSpeak) {
                const tts = await this.ttsModule.synthesize(reply, { voice: BRIDGE_VOICE });
                if (tts && tts.success) {
                    audioUrl = `/tts-audio/${tts.filename}`;
                } else {
                    console.error('[B站桥接] 语音合成失败:', (tts && tts.message) || '未知原因');
                }
            }

            this.lastReply = reply;
            this.lastAudioUrl = audioUrl;
            this.stats.replied += 1;
            const now = Date.now();

            this.emitMessage({
                type: 'bili_reply',
                sessionId,
                userId,
                uid: event.uid,
                nickname: event.nickname,
                kind: event.kind,
                input: inputText,
                reply,
                emotion: (emotionState && emotionState.type) || 'calm',
                audioUrl,
                ts: now
            });
            console.log(`[B站桥接] 回复 ${event.nickname}（${event.uid}）：${reply.slice(0, 60)}`);
            return { replied: true, reply, audioUrl };
        } catch (error) {
            this.stats.failed += 1;
            console.error('[B站桥接] 处理弹幕失败:', error.message);
            return { error: error.message };
        }
    }

    // 手动让角色说一句（调试 / 直播间隙用）
    async say(text) {
        const content = String(text || '').trim();
        if (!content) {
            return { ok: false, message: '内容不能为空' };
        }
        const config = biliLiveConfig.getConfig();
        const reply = trimReply(content, config.replyMaxChars);
        let audioUrl = '';
        if (this.autoSpeak) {
            const tts = await this.ttsModule.synthesize(reply, { voice: BRIDGE_VOICE });
            if (tts && tts.success) {
                audioUrl = `/tts-audio/${tts.filename}`;
            } else {
                return { ok: false, message: (tts && tts.message) || '语音合成失败' };
            }
        }
        this.lastReply = reply;
        this.lastAudioUrl = audioUrl;
        this.emitMessage({
            type: 'bili_reply',
            sessionId: '',
            userId: '',
            uid: '',
            nickname: '手动',
            kind: 'manual',
            input: '',
            reply,
            emotion: 'calm',
            audioUrl,
            ts: Date.now()
        });
        return { ok: true, message: '已播报', reply, audioUrl };
    }

    emitMessage(payload) {
        this.emit('message', payload);
    }
}

module.exports = { BiliLiveBridge, SESSION_PREFIX, BRIDGE_VOICE, trimReply };
