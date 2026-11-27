'use strict';

// QQ 群聊桥接（从 server/index.js 抽出）：群里 @ 角色 → 角色回一句，
// 另含 NapCat 事件上报入口与 QQ 自主发言。依赖经 ctx 注入。
// 本文件在 src/server/qq/ 下，data 路径相对 __dirname 比原 index.js 深一层（../../../data）。
const path = require('path');
const fs = require('fs');
const { describeError: describeOneBotError } = require('../../core/oneBotClient');
const SystemNarrator = require('../../core/narrator');
const { UnifiedAPI } = require('../../core/api');
// 🕰️ 时间线事件总线：QQ 的收发在必经点记，群聊只记管理员与角色自己的发言
const { getTimeline, dayKey } = require('../../core/timeline');
// 📮 物件投递：策略是纯函数，这里只负责「读时间线 → 选一件 → 发 → 记 delivery.sent」
const { resolveOptions, collectArtifacts, selectDeliverable, countUnanswered } = require('../../core/artifactDelivery');
const qqChatRules = require('../../core/qqChatRules');
const {
    idText,
    readMention,
    readReplyId,
    messagePlainText,
    buildReplySegments,
    QQ_PROFILE_LABELS,
    parseAdminCommand,
    resolveQQTarget,
    parseProfileFields,
    adminCommandHelp,
    looksLikeDistillRequest,
    buildDistillPrompt,
    buildQQIntentPrompt,
    extractJsonObject,
    intentToCommand
} = require('../../core/qqMessage');

function registerQqBridge(app, ctx) {
    const {
        oneBotClient, memoryModule, sessionManager, cideEngine, toolRegistry,
        appointmentBook, emotionModule, inputModule, emotionLedger, galgameModule,
        qqRuntime
    } = ctx;
    // QQ 运行时由 server/index.js 统一装配：会话库 / 输出实例 / 私生活都在那层建好，
    // 本文件只消费。这样 QQ 链路不再在路由文件里隐式 new 一套内核。
    const {
        sessionManager: qqSessionManager,
        outputModule: qqOutputModule,
        privateLife: qqPrivateLife
    } = qqRuntime;

    // 🕰️ 时间线：全部 QQ 事件写在这个实例上（与网页链路共用同一份日志目录）
    const timeline = getTimeline();
    function noteQQMessage(type, qqNumber, payload) {
        const { userId } = qqSessionIdentity(qqNumber);
        timeline.append(memoryModule.normalizeScopeKey(userId, 'role'), type, payload);
    }

// 自主发言的启动状态要在最前面声明：registerQqBridge 初始化时就会走到 applyRoleToQQSessions，
// 那里要读这个开关，放到文件后半段会踩 TDZ。
let qqProactiveTimer = null;
let qqProactiveStarted = false;

// ==================== QQ 群聊桥接（群里 @ 角色 → 角色回一句）====================
// 触发范围：仅群聊里被 @（含 @全体成员的不算），私聊不回。
// 数据隔离：每个 QQ 号一份独立会话，落在 data/qq_sessions/，不碰网页端原有的会话与关系数据。
const QQ_BRIDGE_SESSION_PREFIX = 'session_qq_';

// QQ 桥接管理员：只按 QQ 号认人（不走网页账号体系），名单在 .env 的 QQ_ADMIN_IDS（逗号分隔）
const QQ_ADMIN_IDS = new Set(
    String(process.env.QQ_ADMIN_IDS || '')
        .split(/[,，\s]+/)
        .map(id => id.trim())
        .filter(Boolean)
);

// 管理指令默认值：.env 的 QQ_ADMIN_COMMANDS 只作为首次启动的初始值，
// 之后以网页开关（落在 data/qq_bridge_state.json 的 adminCommands）为准
const QQ_ADMIN_COMMANDS_DEFAULT = /^(?:1|true|yes|on)$/i.test(String(process.env.QQ_ADMIN_COMMANDS || '').trim());

// 只给控制台看的：QQ 号只留尾 4 位，截图/旁人看屏幕时别把管理员号露出去 😶
function maskQQ(id) {
    const s = String(id);
    return s.length > 4 ? '****' + s.slice(-4) : '****';
}

// 当前角色名 + 管理员改过的人设落在 data/qq_bridge_state.json：
// 群里下指令能当场切换、重启后依然生效，网页端那份原始角色始终不动
const QQ_BRIDGE_STATE_PATH = path.join(__dirname, '../../../data/qq_bridge_state.json');
const QQ_BRIDGE_DEFAULT_ROLE = (process.env.QQ_BRIDGE_ROLE_NAME || '小助手').trim();

function loadQQBridgeState() {
    const fallback = {
        enabled: true,
        roleName: QQ_BRIDGE_DEFAULT_ROLE,
        lastRoleName: '',
        roleOverrides: {},
        adminCommands: QQ_ADMIN_COMMANDS_DEFAULT
    };
    try {
        if (!fs.existsSync(QQ_BRIDGE_STATE_PATH)) {
            return fallback;
        }
        const saved = JSON.parse(fs.readFileSync(QQ_BRIDGE_STATE_PATH, 'utf8')) || {};
        return {
            // 总开关：false 时 QQ 桥接既不回消息也不发心跳
            enabled: saved.enabled !== false,
            roleName: (saved.roleName ? String(saved.roleName).trim() : '') || QQ_BRIDGE_DEFAULT_ROLE,
            // 上次落盘的roleName：和当前值不一致 = 角色被改过名（不是走「切换角色」指令）
            lastRoleName: saved.lastRoleName ? String(saved.lastRoleName).trim() : '',
            roleOverrides: (saved.roleOverrides && typeof saved.roleOverrides === 'object') ? saved.roleOverrides : {},
            // 管理指令开关：网页上改过就按网页的，没改过才跟 .env 走
            adminCommands: typeof saved.adminCommands === 'boolean' ? saved.adminCommands : QQ_ADMIN_COMMANDS_DEFAULT
        };
    } catch (error) {
        console.error('[QQ桥接] 读取角色状态失败，改用 .env 默认值:', error.message);
        return fallback;
    }
}

function saveQQBridgeState() {
    try {
        // 每次落盘都把当前角色记成「上次的角色」：之后若有人直接改 state 文件里的 roleName，
        // 启动时就能凭这个差值认出「改名」，把旧角色的记忆接过来
        qqBridgeState.lastRoleName = qqBridgeState.roleName;
        fs.writeFileSync(QQ_BRIDGE_STATE_PATH, JSON.stringify(qqBridgeState, null, 2), 'utf8');
    } catch (error) {
        console.error('[QQ桥接] 保存角色状态失败:', error.message);
    }
}

const qqBridgeState = loadQQBridgeState();

// 读运行时状态而不是启动快照：网页上拨开关后立刻生效，不必重启
function adminCommandsEnabled() {
    return qqBridgeState.adminCommands === true;
}

// 角色被改名（不是走「切换角色」指令）时，记忆键会跟着换名字，旧记忆就再也读不到。
// 启动时凭 roleName / lastRoleName 的差值认出改名，把旧名字的档并进新名字（曾用名归并）
migrateRenamedRoleMemories();

// qqSessionManager / qqPrivateLife / qqOutputModule 已由 src/server/runtimes.js 的
// createQQRuntime 建好（含归档摘要 → 语义巩固 → 去重 → 自我模型那条串行链）。
// 这里原先的隐式装配已删除，避免「路由文件自己 new 内核」。QQ 侧私生活与网页端分开。
// QQ 聊天照旧不下发 61 个框架工具（每次上万 token），但记忆这条要与网页端对齐：
// 只放行 pin_memory / unpin_memory——「这条别忘」在 QQ 里一样会发生，钉住是长期记忆唯一的人工保险；
// 再加一个 schedule_diary，让 QQ 里也能和她约定几点写日记（只改时间，不代写正文）
const QQ_ALLOWED_TOOLS = new Set(['pin_memory', 'unpin_memory', 'schedule_diary']);
const qqToolFilter = (def) => QQ_ALLOWED_TOOLS.has(String((def && def.function && def.function.name) || ''));

// QQ 侧自主发言：判定逻辑与网页端同一套 SystemNarrator（CIDE 驱动力闸门、
// 每小时频率分档、静默期、主题饱和、饭点/深夜禁食），只是把会话库换成 QQ 的、
// 出口换成管理员私聊。它跑 tickProactive（主动开口）和 tickAppointments（约定到点/过点），
// 不接管群聊回复；tickSchedule 仍不跑——角色时间表只在网页端生效，两边都跑会双发。
const qqNarrator = new SystemNarrator(memoryModule, {
    sessionManager: qqSessionManager,
    // 🕰️ 时间线：QQ 的自主开口记 channel='qq'
    timelineChannel: 'qq',
    timeline: getTimeline(),
    // 网页端用 hasClients 挡「没人看就别开口」；QQ 是私聊，没有页面在不在的概念
    hasClients: () => true,
    onSpeech: handleQQProactiveSpeech,
    cide: cideEngine,
    toolRegistry,
    outputModule: qqOutputModule,
    emotionModule,
    // 📅 事件簿与网页端共用同一份数据：QQ 里聊定的约定，到点也得有人叮嘱/追问。
    // 只投管理员：非管理员的会话不会被登记成可主动私聊的对象，投进去没人接还会被标成「已提醒」
    appointmentBook,
    appointmentSessionFilter: (sessionId) => [...QQ_ADMIN_IDS]
        .some(id => qqSessionIdentity(id).sessionId === sessionId),
    // 🏠 私生活：QQ 与她自己的日子共用一份档案，私聊里开口也能是从自己的生活起头
    privateLife: qqPrivateLife,
    // QQ 这条链路不下发框架工具：私聊/群里开口用不到那 61 个 schema，每次白烧上万 token；
    // 只留记忆钉选（pin/unpin），让「这条别忘」在 QQ 里也能落地
    toolFilter: qqToolFilter,
    // 自主发言的出口固定是管理员私聊，先告诉她这是哪
    scenePrompt: '\n【当前场景】你在 QQ 私聊里主动开口，对面是你的管理员，一对一，群里的人看不到这段。',
    getContext: (sessionId, userId) => {
        const emotionState = emotionModule.calculateEmotion(sessionId, userId);
        const relationshipStatus = galgameModule.getCurrentRelationship(sessionId, userId);
        return {
            emotion: (emotionState && (emotionState.type || emotionState.primaryEmotion)) || 'calm',
            emotionIntensity: emotionState && typeof emotionState.intensity === 'number' ? emotionState.intensity : 0,
            relationStage: (relationshipStatus && relationshipStatus.stage) || 'STRANGER',
            relationStageName: (relationshipStatus && relationshipStatus.stageName) || '',
            // 与网页端同一套门控：好感分越低，她主动发给管理员的频率越低
            affinityScore: relationshipStatus && typeof relationshipStatus.score === 'number'
                ? relationshipStatus.score
                : null
        };
    }
});

// 事件上报只认本机（NapCat 与我们在同一台机器上），避免服务端暴露到局域网后被外部伪造
function isLoopbackRequest(req) {
    const raw = req.ip || (req.socket && req.socket.remoteAddress) || '';
    return raw === '::1' || raw === '127.0.0.1' || raw === '::ffff:127.0.0.1';
}

// 网页端角色名可能带后缀（如「角色名（后缀）」），QQ 状态里只记「角色名」。
// 先精确匹配，再按括号后缀互相匹配，避免拿不到人设时退化成空壳角色
function findWebRoleSession(roleName) {
    const target = String(roleName || '').trim();
    if (!target) return null;
    const exact = sessionManager.findByName(target);
    if (exact) return exact;
    const withSuffix = name => name.startsWith(`${target}（`) || name.startsWith(`${target}(`);
    const withoutSuffix = name => target.startsWith(`${name}（`) || target.startsWith(`${name}(`);
    return sessionManager.getAllSessions()
        .filter(session => {
            const name = String((session && session.characterConfig && session.characterConfig.name) || '').trim();
            return name && (withSuffix(name) || withoutSuffix(name));
        })
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
}

// 角色设定优先用管理员的覆盖值，其次跟网页端那份角色走：
// 网页上改了性格 / 背景，QQ 这边下一次回复就用新的
function bridgeCharacterConfig() {
    const roleName = qqBridgeState.roleName;
    const source = findWebRoleSession(roleName);
    const base = (source && source.characterConfig) ? { ...source.characterConfig } : { name: roleName };
    const override = qqBridgeState.roleOverrides[roleName];
    return override ? { ...base, ...override, name: roleName } : { ...base, name: roleName };
}

// 角色段要塞进 sessionId（会直接当文件名），先把 Windows 非法字符换掉
function roleKeyOf(roleName) {
    const raw = String(roleName || QQ_BRIDGE_DEFAULT_ROLE || 'default').trim();
    return raw.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'default';
}

function qqRoleKey() {
    return roleKeyOf(qqBridgeState.roleName);
}

// 启动时认「角色改名」：state 里上次落盘的 roleName ≠ 当前 roleName，
// 说明不是走「切换角色」指令（那条会把两者同步），而是直接改了名字。
// 这时把每个 QQ 号下旧角色名的记忆档并进新角色名，别让关系断在改名上。
function migrateRenamedRoleMemories() {
    const previousName = String(qqBridgeState.lastRoleName || '').trim();
    const currentName = String(qqBridgeState.roleName || '').trim();
    // 先把「上次的角色」对齐到当前值并落盘，避免下次启动重复归并
    saveQQBridgeState();
    if (!previousName || !currentName || previousName === currentName) return;

    const fromKey = roleKeyOf(previousName);
    const toKey = roleKeyOf(currentName);
    if (fromKey === toKey) return;

    const memDir = path.join(__dirname, '../../../data/user_memories');
    if (!fs.existsSync(memDir) || !memoryModule || typeof memoryModule.mergeAliasedMemories !== 'function') return;

    const aliases = {};
    fs.readdirSync(memDir)
        .filter(file => file.endsWith('.json') && !file.includes('.bak'))
        .forEach(file => {
            const name = file.slice(0, -'.json'.length);
            const matched = name.match(/^qq_(\d+)_(.+)__(role|ai)$/);
            if (matched && matched[2] === fromKey) {
                aliases[`qq_${matched[1]}_${fromKey}`] = `qq_${matched[1]}_${toKey}`;
            }
        });

    if (Object.keys(aliases).length === 0) {
        console.log(`[QQ桥接] 角色名由「${previousName}」改为「${currentName}」，但没有找到旧记忆档，跳过归并`);
        return;
    }
    console.log(`[QQ桥接] 角色名由「${previousName}」改为「${currentName}」，开始归并旧记忆`);
    memoryModule.mergeAliasedMemories(aliases);
}

// 每个 QQ 号 × 每个角色一份会话与记忆：切人格时互不污染
function qqSessionIdentity(qqNumber) {
    const roleKey = qqRoleKey();
    return {
        sessionId: `${QQ_BRIDGE_SESSION_PREFIX}${qqNumber}_${roleKey}`,
        userId: `qq_${qqNumber}_${roleKey}`
    };
}

function ensureQQSession(qqNumber) {
    const { sessionId, userId } = qqSessionIdentity(qqNumber);
    const existing = qqSessionManager.getSession(sessionId);
    if (!existing) {
        qqSessionManager.createSession({ ...bridgeCharacterConfig(), creatorId: userId }, sessionId);
        console.log(`[QQ桥接] 已为 QQ ${qqNumber} 建立独立会话 ${sessionId}`);
    } else {
        existing.characterConfig = { ...existing.characterConfig, ...bridgeCharacterConfig() };
        qqSessionManager.saveSession(sessionId);
    }
    return { sessionId, userId };
}

// 切角色 / 改人设后，把新设定刷到每个 QQ 的已有会话上，免得历史会话还留着旧人设
function applyRoleToQQSessions() {
    const cfg = bridgeCharacterConfig();
    const fields = {
        name: cfg.name,
        age: cfg.age || '',
        personality: cfg.personality || '',
        background: cfg.background || '',
        backgroundEnabled: cfg.backgroundEnabled !== undefined ? cfg.backgroundEnabled !== false : true,
        targetRelationship: cfg.targetRelationship || 'STRANGER'
    };
    if (cfg.backgroundWeight !== undefined) {
        fields.backgroundWeight = cfg.backgroundWeight;
    }
    const sessions = qqSessionManager.getAllSessions()
        .filter(session => {
            const id = String(session.sessionId || '');
            return id.startsWith(QQ_BRIDGE_SESSION_PREFIX) && id.endsWith(`_${qqRoleKey()}`);
        });
    sessions.forEach(session => qqSessionManager.updateSession(session.sessionId, fields));
    console.log(`[QQ桥接] 角色「${fields.name}」已刷新到 ${sessions.length} 个 QQ 会话`);
    // 换人格会换 sessionId：自主发言的登记跟着重播一遍，否则新会话永远轮不到开口
    if (qqProactiveStarted) seedQQProactiveSessions();
}

// ===== 群友蒸馏 =====
// 管理员在群里 @ 我 + @ 目标群员 + 引用对方「同意被蒸馏」的原话 → 把他在群里的发言喂给模型，
// 产出一份人格文件，落 data/personas/<QQ号>.json，同时在网页端建一个同名角色，方便在人格库里看到并切换。
const PERSONA_DIR = path.join(__dirname, '../../../data/personas');
const personaDistillAPI = new UnifiedAPI();
const DISTILL_MIN_SAMPLES = 8;      // 语料太少蒸不出东西，宁可拒绝
const DISTILL_HISTORY_COUNT = 200;  // 拉群历史的条数上限

// 执行蒸馏。targetIds 是消息里 @ 到的人（已排除机器人自己）；replyId 是被引用消息的 id。
// 返回要发回群里的文字。
async function distillGroupMember(groupId, senderId, targetIds, replyId) {
    // 1. 取被引用消息，确认真的是目标群员本人的话（"引用的确实是本人同意的原话"）
    let quoted;
    try {
        quoted = await oneBotClient.getMsg(replyId);
    } catch (error) {
        return `取被引用消息失败：${describeOneBotError(error)}`;
    }
    const quotedSender = (quoted && quoted.sender) || {};
    const quotedAuthor = idText(quoted.user_id || quotedSender.user_id);
    if (!quotedAuthor) {
        return '取不到被引用消息的作者，没法确认是本人同意，这次先不蒸馏。';
    }

    // 目标：优先用 @ 到的人；没 @ 就认被引用消息的作者
    const atTarget = Array.isArray(targetIds) && targetIds.length ? targetIds[0] : '';
    if (atTarget && atTarget !== quotedAuthor) {
        return `被引用的那条不是 @ 的 ${atTarget} 发的，得引用他本人同意被蒸馏的原话。`;
    }
    const targetId = atTarget || quotedAuthor;

    // 2. 拉群历史，过滤出目标群员的发言当语料
    let history;
    try {
        history = await oneBotClient.getGroupMsgHistory(groupId, DISTILL_HISTORY_COUNT);
    } catch (error) {
        return `拉群消息失败：${describeOneBotError(error)}`;
    }
    const list = Array.isArray(history)
        ? history
        : (history && Array.isArray(history.messages) ? history.messages : []);
    const samples = [];
    let nickname = '';
    list.forEach(msg => {
        if (!msg) return;
        const sender = msg.sender || {};
        const uid = idText(msg.user_id || sender.user_id);
        if (uid !== targetId) return;
        if (!nickname) nickname = String(sender.card || sender.nickname || '').trim();
        const text = messagePlainText(msg.message);
        if (text) samples.push(text);
    });
    if (samples.length < DISTILL_MIN_SAMPLES) {
        return `只捞到 ${samples.length} 条 ${targetId} 的发言，语料太少，蒸不出人格。`;
    }

    // 3. 喂给模型，产出结构化人格
    const messages = [
        { role: 'system', content: buildDistillPrompt() },
        { role: 'user', content: `群成员昵称：${nickname || targetId}\n发言样本：\n${samples.slice(-200).join('\n')}` }
    ];
    let raw = '';
    try {
        const result = await personaDistillAPI.callAPI(messages, null, { temperature: 0.4, callSite: 'personaDistill' });
        raw = (result && result.choices && result.choices[0] && result.choices[0].message)
            ? String(result.choices[0].message.content || '')
            : '';
    } catch (error) {
        return `蒸馏失败（模型调用出错）：${error.message}`;
    }
    const profile = extractJsonObject(raw);
    if (!profile || !String(profile.name || '').trim()) {
        return '模型没吐出可用的人格结构，再试一次。';
    }

    // 4. 落人格文件 + 建网页端角色
    const persona = {
        name: String(profile.name).trim(),
        age: String(profile.age || '').trim(),
        personality: String(profile.personality || '').trim(),
        background: String(profile.background || '').trim(),
        source: { type: 'qq_group', groupId, qq: targetId, nickname: nickname || '', samples: samples.length },
        createdAt: new Date().toISOString()
    };
    try {
        fs.mkdirSync(PERSONA_DIR, { recursive: true });
        fs.writeFileSync(path.join(PERSONA_DIR, `${targetId}.json`), JSON.stringify(persona, null, 2), 'utf8');
    } catch (error) {
        return `写人格文件失败：${error.message}`;
    }
    const existing = sessionManager.findByName(persona.name);
    if (existing) {
        sessionManager.updateSession(existing.sessionId, { ...persona });
    } else {
        sessionManager.createSession({ ...persona, creatorId: 'persona_distill' });
    }
    console.log(`[QQ桥接] 管理员 ${senderId} 蒸馏 ${targetId}（${samples.length} 条语料）→ 角色「${persona.name}」`);
    return `已把 ${targetId} 蒸馏成角色「${persona.name}」（用了 ${samples.length} 条发言），现在能在网页端角色库看到、也能「切换角色」过去。`;
}

// 正则只认「切换角色 小助手」这种死格式，管理员口语化地说（「管理员/切换角色/小助手」）就会漏。
// 这里让模型把整句话翻成上面那几种动作，再由本地代码执行——模型只负责听懂，改数据的仍是本地白名单逻辑
const qqIntentAPI = new UnifiedAPI();

// 模型容易把「我今天只吃两顿」这种自述当成「让我记住」，所以 editMemory 再加一道本地闸：
// 原话必须以明确的记忆指令开头，否则一律按闲聊处理（宁可漏记，也别把日常写进记忆再回一句「记住了」）。
const MEMORY_COMMAND_RE = /^(?:管理员[\s/、:：-]*)?(?:改记忆|修改记忆|加记忆|记一下|记住|帮我记住|记到记忆)/;

// 只对管理员调用：把一句自然语言翻成管理指令；不是指令、模型挂了、返回看不懂，都返回 null 走普通聊天
async function inferAdminCommand(text) {
    const roleNames = sessionManager.getAllSessions().map(session => sessionManager.getSessionName(session));
    const messages = [
        { role: 'system', content: buildQQIntentPrompt(roleNames, qqBridgeState.roleName) },
        { role: 'user', content: String(text || '').slice(0, 500) }
    ];

    let raw = '';
    try {
        const result = await qqIntentAPI.callAPI(messages, null, { temperature: 0.1, callSite: 'qqIntent' });
        raw = (result && result.choices && result.choices[0] && result.choices[0].message)
            ? String(result.choices[0].message.content || '')
            : '';
    } catch (error) {
        console.error('[QQ桥接] 指令意图识别失败，按普通聊天处理:', error.message);
        return null;
    }

    const command = intentToCommand(extractJsonObject(raw));
    // 兜底：模型判成 editMemory，但原话不是命令口气（自述、解释、反问）→ 当没听懂，走普通聊天
    if (command && command.action === 'editMemory' && !MEMORY_COMMAND_RE.test(String(text || '').trim())) {
        console.log(`[QQ桥接] 意图识别「${String(text).slice(0, 30)}」→ 模型想记，但原话不是记忆指令，按普通聊天处理`);
        return null;
    }
    if (command) {
        console.log(`[QQ桥接] 意图识别「${String(text).slice(0, 30)}」→ ${command.action}${command.value ? `：${command.value.slice(0, 30)}` : ''}`);
    } else {
        console.log(`[QQ桥接] 意图识别「${String(text).slice(0, 30)}」→ 不是指令，按普通聊天处理`);
    }
    return command;
}

// 执行管理员指令，返回要发回群里的文字（异步，因为发图/改名片等要真的调用协议端）
async function runQQAdminCommand(command, senderId, context = {}) {
    const groupId = idText(context.groupId);
    if (command.action === 'help') {
        return adminCommandHelp();
    }

    if (command.action === 'switchRole') {
        if (!findWebRoleSession(command.value)) {
            return `没找到角色「${command.value}」。先在网页端建好它，我再切过去。`;
        }
        qqBridgeState.roleName = command.value;
        saveQQBridgeState();
        applyRoleToQQSessions();
        console.log(`[QQ桥接] 管理员 ${senderId} 把角色切换为「${command.value}」`);
        return `已切换为「${command.value}」。`;
    }

    if (command.action === 'editProfile') {
        // 正则那条路给的是「字段=值」原文，模型那条路直接给结构化 fields，两条都收
        const fields = command.fields && Object.keys(command.fields).length
            ? command.fields
            : parseProfileFields(command.value);
        const keys = Object.keys(fields);
        if (keys.length === 0) {
            return '要写清改哪个字段，比如：改人设 性格=冷淡 背景=她是个安静的少女';
        }
        const roleName = qqBridgeState.roleName;
        qqBridgeState.roleOverrides[roleName] = { ...(qqBridgeState.roleOverrides[roleName] || {}), ...fields };
        saveQQBridgeState();
        applyRoleToQQSessions();
        console.log(`[QQ桥接] 管理员 ${senderId} 改人设「${roleName}」：${keys.join(',')}`);
        return `「${roleName}」的${keys.map(key => QQ_PROFILE_LABELS[key] || key).join('、')}已改好。`;
    }

    if (command.action === 'editMemory') {
        // 记忆按 QQ 号 × 当前角色分账：切换人格后不会串到别的角色
        const { userId } = qqSessionIdentity(senderId);
        memoryModule.storeMemory({ value: 0, scene: command.value }, userId, command.value);
        console.log(`[QQ桥接] 管理员 ${senderId} 写入记忆：${command.value.slice(0, 40)}`);
        return `记住了：${command.value.slice(0, 80)}`;
    }

    // 换头像：账号级操作，群/私聊都能用
    if (command.action === 'setAvatar') {
        const file = String(command.value || '').trim();
        if (!file) {
            return '要给我一张图，写法：换头像 <图片链接或本机路径>';
        }
        try {
            await oneBotClient.setQqAvatar(file);
        } catch (error) {
            return `换头像失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} 换了头像：${file}`);
        return '头像换好了。';
    }

    // 发空间（说说）：账号级操作，走实验性链路
    if (command.action === 'postQzone') {
        try {
            await oneBotClient.publishQzone(command.value);
        } catch (error) {
            return `发空间失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} 发了条说说：${String(command.value).slice(0, 40)}`);
        return '说说发出去了。';
    }

    // 发图：群/私聊都能用——在群里发到群里，私聊就发给管理员
    if (command.action === 'sendImage') {
        const file = String(command.value || '').trim();
        if (!file) {
            return '要发哪张图？写法：发图 <图片链接或本机路径>';
        }
        const segments = [{ type: 'image', data: { file } }];
        try {
            if (groupId) {
                await oneBotClient.sendGroupMsg(groupId, segments);
            } else {
                await oneBotClient.sendPrivateMsg(senderId, segments);
            }
        } catch (error) {
            return `发图失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} 发了图：${file}`);
        return '图发出去了。';
    }

    // 本群静默：不带目标的「闭嘴」只影响机器人自己；带 @ 目标 / QQ 号时仍按禁言处理
    if (command.action === 'muteSelf') {
        if (!groupId) {
            return '要在群里说「闭嘴」，我才知道该在哪个群安静。';
        }
        const { targetId, rest } = resolveQQTarget(context, command.value);
        if (targetId) {
            const minutes = parseFloat(rest);
            const duration = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 600;
            try {
                await oneBotClient.setGroupBan(groupId, targetId, duration);
            } catch (error) {
                return `禁言失败：${describeOneBotError(error)}`;
            }
            console.log(`[QQ桥接] 管理员 ${senderId} 禁言 ${targetId} ${duration} 秒`);
            return `已禁言 ${targetId} ${Math.round(duration / 60)} 分钟。`;
        }
        qqChatRules.setGroupMuted(groupId, true);
        console.log(`[QQ桥接] 管理员 ${senderId} 让机器人在群 ${groupId} 闭嘴`);
        return '好，这个群我先不说话。想让我开口，@ 我说「开嘴」。';
    }

    if (command.action === 'unmuteSelf') {
        if (!groupId) {
            return '要在群里说「开嘴」，我才知道该恢复哪个群。';
        }
        qqChatRules.setGroupMuted(groupId, false);
        console.log(`[QQ桥接] 管理员 ${senderId} 解除了群 ${groupId} 的闭嘴`);
        return '好，我回来了。';
    }

    // 以下是群管理操作，只认群里那一条上下文
    if (!groupId) {
        return '这个指令只能在群里用（得先把我拉进群）。';
    }

    if (command.action === 'setGroupCard') {
        const { targetId, rest } = resolveQQTarget(context, command.value);
        if (!targetId) {
            return '要指明改谁的名片，写法：改名片 @某人 新名片';
        }
        try {
            await oneBotClient.setGroupCard(groupId, targetId, rest);
        } catch (error) {
            return `改名片失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} 把 ${targetId} 的群名片改为「${rest}」`);
        return `已把 ${targetId} 的群名片改成「${rest || '(空)'}」。`;
    }

    if (command.action === 'ban') {
        const { targetId, rest } = resolveQQTarget(context, command.value);
        if (!targetId) {
            return '要指明禁言谁，写法：禁言 @某人 10';
        }
        const minutes = parseFloat(rest);
        const duration = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 600;
        try {
            await oneBotClient.setGroupBan(groupId, targetId, duration);
        } catch (error) {
            return `禁言失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} 禁言 ${targetId} ${duration} 秒`);
        return `已禁言 ${targetId} ${Math.round(duration / 60)} 分钟。`;
    }

    if (command.action === 'unban') {
        const { targetId } = resolveQQTarget(context, command.value);
        if (!targetId) {
            return '要指明解除谁的禁言，写法：解除禁言 @某人';
        }
        try {
            await oneBotClient.setGroupBan(groupId, targetId, 0);
        } catch (error) {
            return `解除禁言失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} 解除了 ${targetId} 的禁言`);
        return `已解除 ${targetId} 的禁言。`;
    }

    if (command.action === 'wholeBan') {
        // 没写参数默认开；写了「关/关闭/取消/off」就是关
        const enable = !/^(?:关|关闭|关上|取消|off|no)$/i.test(String(command.value || '').trim());
        try {
            await oneBotClient.setGroupWholeBan(groupId, enable);
        } catch (error) {
            return `全员禁言操作失败：${describeOneBotError(error)}`;
        }
        console.log(`[QQ桥接] 管理员 ${senderId} ${enable ? '开启' : '关闭'}了全员禁言`);
        return enable ? '已开启全员禁言。' : '已关闭全员禁言。';
    }

    return '没看懂这条指令，发「管理」看用法。';
}

// 自然语言查询：问自己有没有权限、自己的 QQ 号是多少。只回信息，绝不落库改设定
function parseAdminQuery(text) {
    const raw = String(text || '').trim().replace(/^[\/／]/, '').trim().replace(/[?？。！!~～]+$/, '').trim();
    // 只认短问句：长句子多半是在聊代码或跑题，别把角色扮演截胡
    if (!raw || raw.length > 16 || /在吗|在么/.test(raw)) return null;
    if (/(?:我的|看我|我)\s*(?:qq|QQ)\s*(?:号|号码)/.test(raw)) return { action: 'queryQQ' };
    if (/(?:admin|管理员)/i.test(raw) && /(?:权限|资格|身份|吗|么|能不能|可不可以|是不是|有没有)/.test(raw)) {
        return { action: 'queryAdmin' };
    }
    return null;
}

function runAdminQuery(query, senderId) {
    if (query.action === 'queryQQ') {
        return `你的 QQ 号是 ${senderId}。`;
    }
    if (QQ_ADMIN_IDS.has(senderId)) {
        return `你是管理员（${senderId}）。能用：切换角色 / 改人设 / 改记忆 / 换头像 / 发空间 / 改名片 / 禁言 / 全员禁言 / 发图 / 群友蒸馏（发「管理」看全部）`;
    }
    return `你不是管理员（${senderId}），这些指令你用不了。`;
}

// 启动时把当前角色套到所有 QQ 会话上：改了 .env 或上次在群里切过角色，历史会话一起生效
if (findWebRoleSession(qqBridgeState.roleName) || qqBridgeState.roleOverrides[qqBridgeState.roleName]) {
    applyRoleToQQSessions();
    console.log(`[QQ桥接] 当前角色：${qqBridgeState.roleName}；管理员：${QQ_ADMIN_IDS.size ? [...QQ_ADMIN_IDS].map(maskQQ).join('、') : '未配置'}；管理指令：${adminCommandsEnabled() ? '开启' : '关闭（可在网页 QQ 设置里打开）'}`);
} else {
    console.warn(`[QQ桥接] 网页端没有「${qqBridgeState.roleName}」这个角色，QQ 会话沿用各自已存的人设`);
}

// Q群管家、别的 bot 也是「群成员」，它们 @ 我不该被当真人来回应。
// 事件里带 is_robot 就直接用；否则查一次群成员表，结果缓存一段时间。
const qqRobotCache = new Map(); // groupId -> { ids: Set, at: number }
const QQ_ROBOT_CACHE_TTL = 10 * 60 * 1000;
// NapCat 偶尔不给 is_robot，这里兜底几个已知的官方机器人号
const QQ_KNOWN_ROBOTS = new Set(['2854196310']); // Q群管家

async function loadGroupRobots(groupId) {
    const now = Date.now();
    const cached = qqRobotCache.get(groupId);
    if (cached && now - cached.at < QQ_ROBOT_CACHE_TTL) {
        return cached.ids;
    }
    try {
        const members = await oneBotClient.getGroupMemberList(groupId);
        const ids = new Set();
        (Array.isArray(members) ? members : []).forEach((member) => {
            if (member && member.is_robot) {
                ids.add(idText(member.user_id));
            }
        });
        qqRobotCache.set(groupId, { ids, at: now });
        return ids;
    } catch (error) {
        // 查不到就退回上一次的缓存（没有就当空集），宁可多回一次也别把真人漏掉
        console.error(`[QQ桥接] 获取群 ${groupId} 成员失败，本轮不按机器人过滤:`, error.message);
        return cached ? cached.ids : new Set();
    }
}

// ===== 白名单群的「意愿发言」=====
// 管理员在群里 @ 她一次 → 进入持续接话窗口；窗口内（以及 mode=willing 的群）
// 非 @ 消息也会先问一次模型「想不想插话」，愿意才生成回复。
const QQ_CONTINUOUS_WINDOW_MS = 10 * 60 * 1000;
const qqContinuousUntil = new Map();      // groupId -> 持续接话截止时间
// 同一个人在同一个群 30 秒内只问一次「要不要插话」：连发几条时不重复烧 token
const QQ_WILLING_COOLDOWN_MS = 30 * 1000;
const qqWillingCooldown = new Map();      // `${groupId}|${senderId}` -> 上次判定时间
const qqWillingAPI = new UnifiedAPI();

// 同一个人连发多条 @：按 (群, 人) 排队，避免两条并发读同一份历史、各回一句
const qqReplyQueues = new Map();          // key -> 队尾 Promise
function enqueueQQReply(key, task) {
    const prev = qqReplyQueues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    qqReplyQueues.set(key, tail);
    tail.then(() => {
        if (qqReplyQueues.get(key) === tail) qqReplyQueues.delete(key);
    });
    return run;
}

function buildWillingnessPrompt(roleName, personality) {
    return [
        `你在扮演群聊角色「${roleName}」。性格：${personality || '自然地聊天'}`,
        '',
        '下面是群里最近的聊天。判断这个角色此刻会不会主动插一句话：',
        '· 只有话题你真的感兴趣、有人明显在问你、或者在聊你熟悉的事，才插话；',
        '· 别人互相打招呼、聊你不懂的硬核内容、刷屏、广告、机器人消息，都不要插；',
        '· 宁可少说，也别每条都接。',
        '',
        '只输出 JSON：{"speak":true} 或 {"speak":false}，不要解释。'
    ].join('\n');
}

// 🧾 本地群语境：协议端（NapCat）默认不开放 get_group_msg_history / get_group_info，
// 拉历史会静默失败，她就只能看着当前一句硬接、还容易把不同人串在一起。
// 这里自己留一份「这个群刚才谁说了什么」，意愿判断和回复提示词都读它
const QQ_GROUP_LOG_LIMIT = 20;
const QQ_GROUP_LOG_TTL_MS = 2 * 60 * 60 * 1000;
const qqGroupLog = new Map();   // groupId -> [{ name, text, at, self }]

function noteGroupLine(groupId, name, text, { self = false, qqId = '' } = {}) {
    const content = String(text || '').trim();
    if (!groupId || !content) return;
    const list = qqGroupLog.get(String(groupId)) || [];
    list.push({ name: String(name || '某人'), text: content.slice(0, 200), at: Date.now(), self, qqId: String(qqId || '') });
    while (list.length > QQ_GROUP_LOG_LIMIT) list.shift();
    qqGroupLog.set(String(groupId), list);
}

// 拼成「昵称：内容」的几行，只取最近 limit 条、两小时内的
function formatGroupLog(groupId, limit = 10, { excludeLast = false } = {}) {
    const list = qqGroupLog.get(String(groupId)) || [];
    const cutoff = Date.now() - QQ_GROUP_LOG_TTL_MS;
    const usable = list.filter(item => item.at >= cutoff);
    const picked = excludeLast ? usable.slice(0, -1) : usable;
    return picked
        .slice(-limit)
        .map(item => `${item.self ? '你' : item.name}：${item.text}`)
        .join('\n');
}

// 👥 群里的社交关系：从最近发过言的人里认人，再各自去查她和这个人的私下关系。
// QQ 会话本来就是一人一份，所以群里天然继承私聊的关系，这里只是把「在场的是谁、关系多深」列出来
function buildGroupRoster(groupId, { exclude = '', limit = 8 } = {}) {
    const list = qqGroupLog.get(String(groupId)) || [];
    const cutoff = Date.now() - QQ_GROUP_LOG_TTL_MS;
    const seen = new Map();
    for (const item of list) {
        if (item.at < cutoff || item.self || !item.qqId) continue;
        if (String(item.qqId) === String(exclude)) continue;
        // 只在「真跟她聊过」的人身上查关系，没聊过的不占提示词
        if (!qqSessionManager.getSession(qqSessionIdentity(item.qqId).sessionId)) continue;
        seen.set(String(item.qqId), item.name);
    }
    return [...seen.entries()].slice(-limit).map(([qqId, name]) => ({
        name,
        ...qqRelationOf(qqId)
    }));
}

// 她对某个 QQ 的私下关系：阶段 + 好感分
function qqRelationOf(qqId) {
    try {
        const { sessionId, userId } = qqSessionIdentity(qqId);
        const relation = galgameModule.getCurrentRelationship(sessionId, userId);
        return {
            stageName: relation ? relation.stageName : '',
            score: relation ? Math.round(Number(relation.score) || 0) : 0
        };
    } catch (error) {
        return { stageName: '', score: 0 };
    }
}

// 拼成提示词里的一段：只作背景，要求她不要点破
function formatRoster(roster, senderName, senderRelation) {
    const lines = [];
    if (senderRelation) {
        lines.push(`刚才这个人「${senderName}」：${senderRelation.stageName || '还不熟'}（好感 ${senderRelation.score}）`);
    }
    (roster || []).forEach((person) => {
        lines.push(`- ${person.name}：${person.stageName || '还不熟'}（好感 ${person.score}）`);
    });
    if (lines.length === 0) return '';
    return `\n群里这些人你都认识，你和他们各自私下的关系（只是背景，别念出来、别点破你们私聊过什么）：\n${lines.join('\n')}\n`;
}

// 拉最近群聊当语境：优先本地缓冲，空了才回退协议端（多半也取不到）
async function recentGroupContext(groupId) {
    const local = formatGroupLog(groupId, 10, { excludeLast: true });
    if (local) return local;
    try {
        const history = await oneBotClient.getGroupMsgHistory(groupId, 10);
        const list = Array.isArray(history)
            ? history
            : (history && Array.isArray(history.messages) ? history.messages : []);
        return list.map((msg) => {
            if (!msg) return '';
            const sender = msg.sender || {};
            const name = sender.card || sender.nickname || msg.user_id || '';
            const content = messagePlainText(msg.message);
            return content ? `${name}：${content}` : '';
        }).filter(Boolean).slice(-10).join('\n');
    } catch (error) {
        return '';
    }
}

// 引用消息：消息段里的 reply 只带 id，正文得再拉一次。
// 取不到就降级成占位，让模型知道「他在回某句话」，而不是完全瞎猜
const QQ_SEGMENT_LABELS = {
    image: '图片', face: '表情', mface: '表情', video: '视频', record: '语音', file: '文件', at: '@某人'
};

// 引用 id：先看消息段，再看 raw_message 里的 CQ 码（有的协议端推送事件时会丢掉 reply 段）
function readReplyIdFromEvent(event) {
    const fromSegments = readReplyId(event && event.message);
    if (fromSegments) return fromSegments;
    const match = String((event && event.raw_message) || '').match(/\[CQ:reply,id=([^,\]]+)/);
    return match ? match[1].trim() : '';
}

// 取被引用的原文。返回 { text, peerNote, selfQuoted, content }：
//  - text：引用本身，属于「这条消息的内容」，可以进模型上下文
//  - peerNote：跨会话借阅来的对方记忆，只给模型看，不进记忆档、不进情感履历
//  - selfQuoted：被引用的是她自己说过的话，不能算成发送者的发言
//  - content：被引用原文（不含包装），需要单独存档时用
async function readQuotedText(event) {
    const replyId = readReplyIdFromEvent(event);
    if (!replyId) return { text: '', peerNote: '', selfQuoted: false, content: '' };
    try {
        const quoted = await oneBotClient.getMsg(replyId);
        if (!quoted) return { text: '（对方引用了一条消息，原文没取到）', peerNote: '', selfQuoted: false, content: '' };
        const sender = quoted.sender || {};
        const name = sender.card || sender.nickname || idText(quoted.user_id) || '某人';
        const content = messagePlainText(quoted.message);
        console.log(`[QQ桥接] 引用 ${replyId} → ${name}：${(content || '非文字').slice(0, 40)}`);
        // 🫂 跨会话只读记忆通道：只有「引用别人的消息」（不是自己、不是机器人）才开放一次。
        // 读的是被引用者自己的记忆档：只读、不写、不建空档；本地只调「引用索引权重」，
        // 让这次真正用上的条目下次更靠前。其他任何场景都不跨会话读记忆
        let peerLine = '';
        const authorId = idText(quoted.user_id || sender.user_id);
        const viewerId = idText(event.user_id);
        const selfId = idText(event.self_id);
        // 「他引用了她自己说过的话」：这段原文属于她，不属于发送者。
        // 之前把它拼进 saidText 一起落库，召回时就变成「用户说过」，她会把自己说的话安到对方头上
        const selfQuoted = Boolean(content && authorId && selfId && authorId === selfId);
        if (content && authorId && authorId !== selfId && authorId !== viewerId && memoryModule
            && typeof memoryModule.retrievePeerMemories === 'function') {
            try {
                const peerUserId = qqSessionIdentity(authorId).userId;
                const recalls = memoryModule.retrievePeerMemories(peerUserId, content, 3);
                if (recalls.length > 0) {
                    peerLine = `（你隐约记得关于 ${name} 的几件事：「${recalls.join('」「')}」）`;
                }
            } catch (error) {
                console.warn(`[QQ桥接] 读取 ${name} 的记忆失败（不影响回复）：${error.message}`);
            }
        }
        // 正文用「」括起来：方括号形式（[引用 xx：...]）会被模型当成占位标记，
        // 明明拿到了原文也照样说「看不到」；引号的形式它才会当成真正的聊天内容
        if (content) {
            return {
                text: `（对方引用了 ${name} 的消息：「${content}」）`,
                peerNote: peerLine,
                selfQuoted,
                content
            };
        }
        const labels = (Array.isArray(quoted.message) ? quoted.message : [])
            .map(seg => seg && seg.type)
            .filter(type => type && type !== 'reply' && type !== 'text')
            .map(type => QQ_SEGMENT_LABELS[type] || type);
        return { text: `（对方引用了 ${name} 的一条${labels.join('、') || '空'}消息）`, peerNote: '', selfQuoted: false, content: '' };
    } catch (error) {
        console.warn(`[QQ桥接] 取被引用消息 ${replyId} 失败：${describeOneBotError(error)}`);
        return { text: '（对方引用了一条消息，原文没取到）', peerNote: '', selfQuoted: false, content: '' };
    }
}

async function shouldJoinGroupChat(groupId, text, senderName) {
    const config = bridgeCharacterConfig();
    const context = await recentGroupContext(groupId);
    const messages = [
        { role: 'system', content: buildWillingnessPrompt(config.name || qqBridgeState.roleName, config.personality) },
        { role: 'user', content: `${context ? `最近群聊：\n${context}\n\n` : ''}最新一条 —— ${senderName || '群友'}：${text}` }
    ];

    let raw = '';
    try {
        const result = await qqWillingAPI.callAPI(messages, null, { temperature: 0.8, callSite: 'qqWilling' });
        raw = (result && result.choices && result.choices[0] && result.choices[0].message)
            ? String(result.choices[0].message.content || '')
            : '';
    } catch (error) {
        console.error('[QQ桥接] 意愿判断失败，这次不插话:', error.message);
        return false;
    }
    const intent = extractJsonObject(raw);
    return !!(intent && intent.speak === true);
}

// ===== 场景识别：让角色知道自己此刻在哪个群、还是私聊 =====
// 群资料（群名/人数）按群号缓存：同一条消息的回复和意愿判断都会用到，不必每次都问协议端
const qqGroupInfoCache = new Map(); // groupId -> { name, memberCount, at }
const QQ_GROUP_INFO_TTL_MS = 30 * 60 * 1000;

async function getGroupInfo(groupId) {
    const cached = qqGroupInfoCache.get(groupId);
    if (cached && Date.now() - cached.at < QQ_GROUP_INFO_TTL_MS) return cached;
    let info = { name: '', memberCount: 0, at: Date.now() };
    try {
        const data = await oneBotClient.getGroupInfo(groupId) || {};
        info = {
            name: String(data.group_name || ''),
            memberCount: Number(data.member_count) || 0,
            at: Date.now()
        };
    } catch (error) {
        // 协议端不支持 get_group_info 时只记群号，不阻断回复
        console.warn(`[QQ桥接] 取群 ${groupId} 资料失败，场景里只带群号:`, error.message);
    }
    qqGroupInfoCache.set(groupId, info);
    return info;
}

// 群聊场景：强调「当众说话」的分寸——短句、不抖私聊内容、不用两个人的专属称呼
// ⏰ 正式回复也得知道现在几点：自主发言那条链路有 formatClock + 饭点规则，
// 但私聊/群聊回话时 prompt 里原本没有任何时间，她只能靠记忆时间戳猜
function formatNowLine() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const { part, meal, isNight } = qqNarrator.describeDaypart(now);
    const clock = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const tail = isNight ? '，深夜该睡了' : meal ? `，${meal.name}饭点` : '，不是饭点';
    return `现在是 ${clock}（${part}${tail}）。`;
}

function buildGroupScenePrompt({ groupId, groupInfo, senderName, isAdmin, proactive, recentLines, rosterText }) {
    const namePart = groupInfo && groupInfo.name ? `「${groupInfo.name}」` : '';
    const sizePart = groupInfo && groupInfo.memberCount ? `，约 ${groupInfo.memberCount} 人` : '';
    const who = senderName || '一位群友';
    const chatPart = recentLines
        ? `\n群里刚才的对话（「你」是你自己说的，其余是不同群员）：\n${recentLines}\n`
        : '';
    return `\n【当前场景】QQ 群聊${namePart}（群号 ${groupId}${sizePart}）。
${formatNowLine()}
${chatPart}${rosterText || ''}
${proactive ? `你是在群里主动接话，刚才说话的是群成员「${who}」` : `刚才 @ 你的是群成员「${who}」`}${isAdmin ? '（你的管理员）' : ''}。
在群里说话的分寸：句子短、像群聊里随手回的一句；只接当前这个人这一句，别把别人的话算到他头上；称呼和语气按你对各人的关系来，但别说破关系深浅、别把私聊内容端到群里；也不要一次输出一大段。`;
}

// 私聊场景：一对一，可以放松、可以长一点
function buildPrivateScenePrompt(senderName) {
    const who = senderName || 'TA';
    return `\n【当前场景】QQ 私聊，只有你和「${who}」两个人，群里的人看不到这段对话。
${formatNowLine()}
可以放松一些，称呼、语气、话题都按你们两人的关系来，不用像在群里那样收着。`;
}

// 群回复的共用生成段：@ 触发与白名单群的主动接话都走这里
async function generateGroupReply(senderId, inputText, scene = {}) {
    const { sessionId, userId } = ensureQQSession(senderId);
    // 送进模型的是 inputText（可能带借来的对方记忆）；落盘/算情绪只用发送者自己说的 memoryInput
    const memoryInput = typeof scene.memoryInput === 'string' && scene.memoryInput ? scene.memoryInput : inputText;
    // 管理员在群里说话也算「人还在」，自主发言这边同步登记一下
    if (QQ_ADMIN_IDS.has(String(senderId))) qqNarrator.noteUserMessage(sessionId, userId);
    const history = qqSessionManager.getConversationHistory(sessionId, userId, 5);

    const processedInput = await inputModule.process({ data: memoryInput, sessionId, userId }, history, null);
    // 群里的发言带场景前缀再入长期记忆：以后召回时能看出「这是在某群里、某个人说的」，
    // 不会被当成两个人私下的对话翻出来
    const memoryText = `（群聊「${(scene.groupInfo && scene.groupInfo.name) || `群${scene.groupId}`}」·${scene.senderName || '群友'}说）${memoryInput}`;
    memoryModule.storeMemory(processedInput, userId, memoryText);
    emotionModule.updateEmotion(processedInput.value, sessionId, userId, processedInput.signals);
    setImmediate(() => {
        emotionLedger.observe(processedInput, {
            sessionId, userId, text: memoryInput, source: 'qq_group'
        }).catch(error => console.error('[情感工具] 履历记账失败:', error.message));
    });
    const emotionState = emotionModule.calculateEmotion(sessionId, userId);

    // 正式回复生成期间挡住自主发言，免得它插进来跟这条回复抢同一段历史
    const sceneHint = buildGroupScenePrompt({
        groupId: scene.groupId,
        groupInfo: scene.groupInfo,
        senderName: scene.senderName,
        isAdmin: scene.isAdmin,
        proactive: scene.proactive,
        recentLines: scene.recentLines,
        rosterText: scene.rosterText
    });
    let output;
    qqNarrator.setGenerating(sessionId, true);
    try {
        output = await qqOutputModule.generateOutputAsync(
            emotionState,
            galgameModule.getCurrentRelationship(sessionId, userId),
            { data: inputText, sessionId, userId },
            history,
            sessionId,
            userId,
            null,
            'role',
            sceneHint,
            // 61 个工具 schema 每次要吃掉上万 token，只留好感度旁路与记忆钉选
            // 群聊里「你们俩此刻在哪」不成立，场景投影只走私聊/网页
            { toolFilter: qqToolFilter, sceneContext: false }
        );
    } finally {
        qqNarrator.setGenerating(sessionId, false);
    }

    const apiAffectionChange = typeof output.apiAffectionChange === 'number' ? output.apiAffectionChange : null;
    galgameModule.updateRelationship(processedInput, apiAffectionChange, output.apiThinking || '', sessionId, userId);

    const currentUser = qqSessionManager.getUser(sessionId, userId);
    if (currentUser) {
        const localDelta = (Number(processedInput.value) || 0) * 5;
        const scoreDelta = apiAffectionChange !== null ? apiAffectionChange : localDelta;
        qqSessionManager.updateUserRelationship(sessionId, userId, currentUser.relationshipScore + scoreDelta);
    }

    return typeof output.data === 'string' ? output.data.trim().replace(/\n{2,}/g, '\n') : '';
}

// 有些客户端把 @ 当纯文本发过来，拿不到 at 消息段：从正文里扒出 @ 后面的名字。
// 不要求 @ 前面有空格/标点——「陌陌3433428404@鱼」这种紧贴着名字的写法很常见
function readTextAtNames(text) {
    const normalized = String(text || '').replace(/＠/g, '@');
    // 邮箱里的 @ 不是叫人，先抠掉
    const stripped = normalized.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ');
    const re = /@([^\s@，,。！!？?、:：~～]{1,20})/g;
    return [...stripped.matchAll(re)].map(match => match[1].trim()).filter(Boolean);
}

// 正文里的这个 @ 是不是在叫我。三种叫法都算：全名、全名的前缀（「角色名」对「角色名（后缀）」）、
// 带尾巴的连写（「@角色名在吗」会整段被抓成名字，只要它以我的名字开头也算）
function isSelfAtName(name, config) {
    const target = String(name || '').trim();
    if (!target) return false;
    const mine = [config && config.name, qqBridgeState.roleName]
        .filter(Boolean)
        .map(item => String(item).trim())
        // 「角色名（后缀）」这种带括号后缀的角色名，比对时只用括号前的部分
        .map(item => item.replace(/[（(].*$/, '').trim())
        .filter(Boolean);
    return mine.some(item => item && (item === target || item.startsWith(target) || target.startsWith(item)));
}

// 群里收到消息：@ 我、白名单群的主动接话、管理员指令都在这里分流。
// 返回对象里 skipped 非空表示这条不该回
async function replyToGroupMention(event) {
    const selfId = idText(event.self_id);
    const groupId = idText(event.group_id);
    const senderId = idText(event.user_id);

    if (!groupId || !senderId || !selfId) {
        return { skipped: '事件字段不全' };
    }
    if (senderId === selfId) {
        return { skipped: '自己发的消息' };
    }

    const mention = readMention(event.message, selfId);
    if (mention.mentionsAll) {
        return { skipped: '@全体成员，不回' };
    }

    // 机器人（Q群管家、别的 bot）一律不理，避免跟机器人互相刷屏。
    // 只按「昵称/名片正好是群管家」判，不做模糊包含：叫「我是群管家」的真人不能被一起静音
    const sender = event.sender || {};
    const senderName = `${sender.nickname || ''}${sender.card || ''}`;
    const nicknames = [String(sender.nickname || '').trim(), String(sender.card || '').trim()];
    if (sender.is_robot === true || nicknames.includes('群管家') || QQ_KNOWN_ROBOTS.has(senderId)) {
        return { skipped: '发送者是机器人' };
    }
    const robots = await loadGroupRobots(groupId);
    if (robots.has(senderId)) {
        return { skipped: '发送者是机器人' };
    }

    const isAdmin = QQ_ADMIN_IDS.has(senderId);
    const rules = qqChatRules.getGroupRule(groupId);

    // 诊断：白名单群每条消息记下实际 @ 了谁，排查「@ 别人家的机器人却被接话」时一眼能看出来
    if (rules.enabled) {
        console.log(`[QQ桥接] 群 ${groupId} 收到 ${senderName || senderId}：ats=[${mention.ats.join(',')}] 正文=${(mention.text || '').slice(0, 40)}`);
    }

    // 所有群消息先记进本地群语境（回不回都记）：协议端不给群历史，
    // 这份缓冲是她在群里唯一能看到的「刚才谁说了什么」
    if (mention.text) {
        noteGroupLine(groupId, sender.card || sender.nickname || senderId, mention.text, { qqId: senderId });
    }

    // 群友蒸馏：管理员 @ 我 + @ 目标群员 + 引用对方同意的原话，就触发。只有管理员能用
    const replyId = readReplyId(event.message);
    if (mention.mentionsSelf && replyId && isAdmin && adminCommandsEnabled() && looksLikeDistillRequest(mention.text)) {
        const targetIds = mention.ats
            .map(idText)
            .filter(id => id && id !== selfId && id !== 'all');
        const distillText = await distillGroupMember(groupId, senderId, targetIds, replyId);
        // 指令类回复不再 @ 人：本来就是冲着机器人说的，再 @ 回去只是刷屏
        await oneBotClient.sendGroupMsg(groupId, buildReplySegments(` ${distillText}`));
        console.log(`[QQ桥接] 管理员 ${senderId} 触发蒸馏 → ${distillText.slice(0, 60)}`);
        return { replied: true, reply: distillText, adminCommand: 'distill' };
    }

    // 管理指令：
    // - @ 我：完整指令通道（含模型意图识别），别人发同样的词会被拒绝
    // - 没 @ 我：只认管理员发的「闭嘴 / 开嘴」，普通聊天不当指令
    if (mention.text) {
        if (mention.mentionsSelf) {
            const handled = await handleQQAdminText(mention.text, senderId, { groupId, ats: mention.ats, selfId });
            if (handled.handled) {
                await oneBotClient.sendGroupMsg(groupId, buildReplySegments(` ${handled.text}`));
                if (handled.kind === 'denied') {
                    return { skipped: '非管理员下达管理指令' };
                }
                if (handled.kind === 'query') {
                    console.log(`[QQ桥接] ${senderId} 查询 ${handled.action} → ${handled.text.slice(0, 60)}`);
                    return { replied: true, reply: handled.text, adminQuery: handled.action };
                }
                console.log(`[QQ桥接] 管理员 ${senderId} 执行指令 ${handled.action} → ${handled.text.split('\n')[0].slice(0, 60)}`);
                return { replied: true, reply: handled.text, adminCommand: handled.action };
            }
        } else if (isAdmin && adminCommandsEnabled()) {
            const command = parseAdminCommand(mention.text);
            if (command && (command.action === 'muteSelf' || command.action === 'unmuteSelf')) {
                const text = await runQQAdminCommand(command, senderId, { groupId, ats: mention.ats, selfId });
                await oneBotClient.sendGroupMsg(groupId, buildReplySegments(` ${text}`));
                console.log(`[QQ桥接] 管理员 ${senderId} 执行指令 ${command.action} → ${text.slice(0, 60)}`);
                return { replied: true, reply: text, adminCommand: command.action };
            }
        }
    }

    // 管理员叫闭嘴后不再接话；但上面的管理指令仍能执行，否则没法「开嘴」
    if (rules.muted) {
        return { skipped: '本群已被管理员叫闭嘴' };
    }
    if (rules.enabled && rules.mode === 'off') {
        return { skipped: '本群发言规则为关闭' };
    }

    // 引用消息的正文不在消息段里，单独取一次，和本条正文一起送进模型
    const quoted = await readQuotedText(event);
    const quotedText = quoted.text;
    // 借来的对方记忆只挂在提示词上；对话主键、历史、关系、情绪仍然全是发送者这一份
    const peerNote = quoted.peerNote;

    let saidText = '';   // 发送者真正说了什么（含被引用原文），进记忆档与情感履历
    let inputText = '';  // 送进模型的完整输入（多出 peerNote）
    let proactive = false;
    if (mention.mentionsSelf) {
        // 只 @ 了人、没带正文也算一次招呼，用「在吗」当作这次输入的语义。
        // 引用她自己的话只进语境，不进「发送者说了什么」
        saidText = quoted.selfQuoted ? (mention.text || '在吗') : [quotedText, mention.text || '在吗'].filter(Boolean).join('\n');
        inputText = [quotedText, mention.text || '在吗', peerNote].filter(Boolean).join('\n');
        // 白名单群：管理员 @ 一次 → 开一段持续接话窗口，之后她可以自己接话
        if (rules.enabled && isAdmin) {
            qqContinuousUntil.set(groupId, Date.now() + QQ_CONTINUOUS_WINDOW_MS);
            console.log(`[QQ桥接] 群 ${groupId} 进入持续接话窗口（${Math.round(QQ_CONTINUOUS_WINDOW_MS / 60000)} 分钟）`);
        }
    } else {
        // 不在白名单：保持「@ 才回」
        if (!rules.enabled) {
            return { skipped: '没有 @ 我（不在白名单）' };
        }
        // 这条 @ 了别人（别人家的机器人、群友）就不是在叫我，别插话。
        // 按 QQ 号而不是昵称判定，所以「鱼」「角色名」这类重名角色也能分开
        const atOthers = mention.ats.some(id => id && id !== selfId && id !== 'all');
        if (atOthers) {
            return { skipped: '这条消息 @ 的是别人，不接话' };
        }
        // 兜底：有些客户端把 @ 当纯文本发、没有 at 消息段，正文里 @ 的不是我也不接
        const textAts = readTextAtNames(mention.text);
        if (textAts.length && !textAts.some(name => isSelfAtName(name, bridgeCharacterConfig()))) {
            return { skipped: `正文 @ 的是别人（${textAts[0]}），不接话` };
        }
        if (!mention.text && !quotedText) {
            return { skipped: '非文字消息' };
        }

        saidText = quoted.selfQuoted ? mention.text : [quotedText, mention.text].filter(Boolean).join('\n');
        inputText = [quotedText, mention.text, peerNote].filter(Boolean).join('\n');
        const continuous = (qqContinuousUntil.get(groupId) || 0) > Date.now();
        const keywordHit = rules.keywords.some(keyword => saidText.toLowerCase().includes(keyword.toLowerCase()));
        const keywordMode = rules.mode === 'keyword' || rules.mode === 'both';
        const canSpeakByWilling = rules.mode === 'willing' || continuous;

        if (!(keywordMode && keywordHit) && !canSpeakByWilling) {
            return { skipped: `未触发发言规则（${rules.mode}）` };
        }
        // 关键词命中直接接；纯「意愿」路径先问模型这次要不要插话
        if (!(keywordMode && keywordHit)) {
            const cooldownKey = `${groupId}|${senderId}`;
            if (Date.now() - (qqWillingCooldown.get(cooldownKey) || 0) < QQ_WILLING_COOLDOWN_MS) {
                return { skipped: `意愿判断冷却中（${Math.round(QQ_WILLING_COOLDOWN_MS / 1000)} 秒内已判过一次）` };
            }
            qqWillingCooldown.set(cooldownKey, Date.now());
            const willing = await shouldJoinGroupChat(groupId, saidText, senderName);
            if (!willing) {
                return { skipped: '意愿判断：这次不插话' };
            }
        }
        proactive = true;
    }

    // 🕰️ 时间线：群聊只记管理员说的话（普通成员闲聊不入库，控制量与隐私）
    if (isAdmin && saidText) {
        noteQQMessage('message.in', senderId, {
            channel: 'qq', scene: 'group', groupId, userId: qqSessionIdentity(senderId).userId,
            text: saidText.slice(0, 500)
        });
    }

    // 场景识别：带上这个群的群名/人数，让她分得清现在在哪个群、当众说话该收着
    const groupInfo = await getGroupInfo(groupId);
    // 群里引用她自己的话：存成「你说过」的自我记忆，别混进「群友说了什么」
    if (quoted.selfQuoted && quoted.content) {
        const ownerId = qqSessionIdentity(senderId).userId;
        const groupLabel = (groupInfo && groupInfo.name) || `群${groupId}`;
        memoryModule.storeMemory({ value: 0, scene: '' }, ownerId, `（群聊「${groupLabel}」里你说）${quoted.content}`, {
            speaker: 'self',
            source: 'qq_group_quote'
        });
    }
    const speakerName = sender.nickname || sender.card || senderId;
    // 社交关系：当前说话人的私下关系 + 群里其他熟人的关系，只作语气背景，不明说
    const rosterText = formatRoster(buildGroupRoster(groupId, { exclude: senderId }), speakerName, qqRelationOf(senderId));
    const reply = await generateGroupReply(senderId, inputText, {
        groupId,
        groupInfo,
        recentLines: formatGroupLog(groupId, 10, { excludeLast: Boolean(mention.text) }),
        rosterText,
        senderName: speakerName,
        isAdmin,
        proactive,
        // 落记忆/算情绪只用发送者自己说的内容，不把借来的对方记忆腌进去
        memoryInput: saidText
    });
    if (!reply) {
        return { skipped: '生成结果为空' };
    }

    // 你 @ 我时我不再 @ 回去；只有我自己接话（关键词/意愿/持续窗口）才 @，
    // 用来指明这句是在回谁。群里被 @ 的那条本来就有引用关系，@ 只是噪音
    await oneBotClient.sendGroupMsg(groupId, buildReplySegments(` ${reply}`, proactive ? { atQQ: senderId } : {}));
    // 🕰️ 时间线：角色在群里真的发出去了才记
    noteQQMessage('message.out', senderId, {
        channel: 'qq', scene: 'group', groupId, userId: qqSessionIdentity(senderId).userId,
        text: reply.slice(0, 500)
    });
    // 自己的话也进群语境：避免同一件事在群里被重复追问第二遍
    noteGroupLine(groupId, bridgeCharacterConfig().name || qqBridgeState.roleName, reply, { self: true });
    console.log(`[QQ桥接] 已在群 ${groupId} ${proactive ? '主动' : ''}回复 ${senderId}（收到：${inputText.slice(0, 30).replace(/\n/g, ' ')}）：${reply.slice(0, 60)}`);
    return { replied: true, reply };
}

// 群聊与私聊共用：先把一句话当成查询或管理指令处理。
// handled 为 false 表示这不是指令，调用方继续当普通聊天处理
async function handleQQAdminText(text, senderId, context = {}) {
    // 开关关闭时整条指令通道短路：不查权限、不匹配正则、不调模型识别意图，一律回到普通聊天
    if (!adminCommandsEnabled()) {
        return { handled: false };
    }
    // 自然语言查询先走：问权限、问自己的号，谁问都回，但完全不改设定
    const query = parseAdminQuery(text);
    if (query) {
        return { handled: true, kind: 'query', action: query.action, text: runAdminQuery(query, senderId) };
    }

    const isAdmin = QQ_ADMIN_IDS.has(senderId);
    let command = parseAdminCommand(text);
    // 正则认不出的口语写法（「管理员/切换角色/小助手」）交给模型再识一次意图。
    // 只对管理员调，别人发什么都落普通聊天，不替外人白烧 token
    if (!command && isAdmin) {
        command = await inferAdminCommand(text);
    }
    if (!command) {
        return { handled: false };
    }
    if (!isAdmin) {
        return { handled: true, kind: 'denied', text: '这个指令只有管理员能用。' };
    }
    const replyText = await runQQAdminCommand(command, senderId, context);
    return { handled: true, kind: 'command', action: command.action, text: replyText };
}

// 私聊：只认 QQ_ADMIN_IDS 里的号，其他人发什么都不回、也不进模型。
// 会话与记忆沿用这个 QQ 号在群里的那一份，同一个人在群和私聊里是同一个角色、同一段关系
async function replyToPrivateMessage(event) {
    const selfId = idText(event.self_id);
    const senderId = idText(event.user_id);

    if (!senderId || !selfId) {
        return { skipped: '事件字段不全' };
    }
    if (senderId === selfId) {
        return { skipped: '自己发的消息' };
    }
    if (!QQ_ADMIN_IDS.has(senderId)) {
        return { skipped: '私聊发送者不是管理员' };
    }

    const text = readMention(event.message, selfId).text;
    // 引用消息的正文单独取；只引用不说话也算一条有效输入
    const quoted = await readQuotedText(event);
    const quotedText = quoted.text;
    if (!text && !quotedText) {
        return { skipped: '私聊内容为空' };
    }
    // 引用原文进模型上下文；但引用的是她自己说过的话时，那段原文不能算「他说的」。
    // 借来的对方记忆只给模型看、不落盘
    const saidText = quoted.selfQuoted ? text : [quotedText, text].filter(Boolean).join('\n');
    const inputText = [quotedText, text, quoted.peerNote].filter(Boolean).join('\n');

    const handled = await handleQQAdminText(text, senderId, { selfId });
    if (handled.handled) {
        await oneBotClient.sendPrivateMsg(senderId, buildReplySegments(handled.text));
        if (handled.kind === 'denied') {
            return { skipped: '非管理员下达管理指令' };
        }
        if (handled.kind === 'query') {
            console.log(`[QQ桥接] 私聊 ${senderId} 查询 ${handled.action} → ${handled.text.slice(0, 60)}`);
        } else {
            console.log(`[QQ桥接] 私聊管理员 ${senderId} 执行指令 ${handled.action} → ${handled.text.split('\n')[0].slice(0, 60)}`);
        }
        return { replied: true, reply: handled.text };
    }

    // 不是指令 → 正常聊天
    const { sessionId, userId } = ensureQQSession(senderId);
    // 🕰️ 时间线：私聊收到一条真人消息（管理指令已在上方返回，不算对话）
    noteQQMessage('message.in', senderId, { channel: 'qq', scene: 'private', userId, text: inputText.slice(0, 500) });
    // 登记到自主发言调度：用户刚说话，narrator 知道这会儿不该插嘴
    qqNarrator.noteUserMessage(sessionId, userId);
    const history = qqSessionManager.getConversationHistory(sessionId, userId, 5);

    const processedInput = saidText
        ? await inputModule.process({ data: saidText, sessionId, userId }, history, null)
        : { value: 0, scene: '', signals: {} };
    // 只有「他真正说的新内容」进用户记忆与情绪账；引用她的原文不算他说的话
    if (saidText) {
        memoryModule.storeMemory(processedInput, userId, saidText, { speaker: 'user', source: 'qq_private' });
        emotionModule.updateEmotion(processedInput.value, sessionId, userId, processedInput.signals);
        setImmediate(() => {
            emotionLedger.observe(processedInput, {
                sessionId, userId, text: saidText, source: 'qq_private'
            }).catch(error => console.error('[情感工具] 履历记账失败:', error.message));
        });
    }
    // 引用她自己的话：存成「你说过」的自我记忆，将来召回时不会被安到他头上
    if (quoted.selfQuoted && quoted.content) {
        memoryModule.storeMemory({ value: 0, scene: '' }, userId, `（你在 QQ 私聊里说过）${quoted.content}`, {
            speaker: 'self',
            source: 'qq_private_quote'
        });
    }
    const emotionState = emotionModule.calculateEmotion(sessionId, userId);

    // 正式回复生成期间挡住自主发言，免得它插进来跟这条回复抢同一段历史
    // 场景识别：私聊是一对一，跟群聊的分寸分开
    const sceneHint = buildPrivateScenePrompt((event.sender && (event.sender.card || event.sender.nickname)) || '');
    let output;
    qqNarrator.setGenerating(sessionId, true);
    try {
        output = await qqOutputModule.generateOutputAsync(
            emotionState,
            galgameModule.getCurrentRelationship(sessionId, userId),
            { data: inputText, sessionId, userId },
            history,
            sessionId,
            userId,
            null,
            'role',
            sceneHint,
            // 61 个工具 schema 每次要吃掉上万 token，只留好感度旁路与记忆钉选
            { toolFilter: qqToolFilter }
        );
    } finally {
        qqNarrator.setGenerating(sessionId, false);
    }

    const apiAffectionChange = typeof output.apiAffectionChange === 'number' ? output.apiAffectionChange : null;
    galgameModule.updateRelationship(processedInput, apiAffectionChange, output.apiThinking || '', sessionId, userId);

    const currentUser = qqSessionManager.getUser(sessionId, userId);
    if (currentUser) {
        const localDelta = (Number(processedInput.value) || 0) * 5;
        const scoreDelta = apiAffectionChange !== null ? apiAffectionChange : localDelta;
        qqSessionManager.updateUserRelationship(sessionId, userId, currentUser.relationshipScore + scoreDelta);
    }

    const reply = typeof output.data === 'string' ? output.data.trim().replace(/\n{2,}/g, '\n') : '';
    if (!reply) {
        return { skipped: '生成结果为空' };
    }

    await oneBotClient.sendPrivateMsg(senderId, buildReplySegments(reply));
    // 🕰️ 时间线：私聊真正发出后才记（发送失败不记，日志只认「真的发出去了」）
    noteQQMessage('message.out', senderId, { channel: 'qq', scene: 'private', userId, text: reply.slice(0, 500) });
    console.log(`[QQ桥接] 已私聊回复 ${senderId}：${reply.slice(0, 60)}`);
    return { replied: true, reply };
}

// QQ 自主发言（原「心跳」）：不再定时硬发一句固定文案，而是按网页端同一套判定问一遍
// SystemNarrator「这会儿想不想开口、说什么」——闸门不过、这一小时说够了、主题饱和、
// 模型刚说过不想说，都照网页端一样闭嘴。
// 20~30 分钟的随机间隔只作为判定节拍，同时保留原来「保持 OneBot 链路有流量」的作用。
const QQ_PROACTIVE_MIN_MS = 20 * 60 * 1000;
const QQ_PROACTIVE_MAX_MS = 30 * 60 * 1000;
// 每日上限可用 QQ_ARTIFACT_DAILY_MAX 覆盖（默认 4），其余策略参数固定在 artifactDelivery
const QQ_ARTIFACT_OPTIONS = resolveOptions();
const QQ_ARTIFACT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// 读某个 scope 近 24 小时的事件（跨天时两天都读，不重复）
function readArtifactWindow(scopeKey, now) {
    const days = new Set([dayKey(new Date(now)), dayKey(new Date(now - QQ_ARTIFACT_LOOKBACK_MS))]);
    const events = [];
    for (const day of days) events.push(...timeline.readDay(scopeKey, day));
    return events;
}

// 📮 投递一件攒着的物件：只发管理员私聊，成功才记 delivery.sent（幂等靠这条记录）
async function deliverPendingArtifacts() {
    if (!qqBridgeState.enabled || QQ_ADMIN_IDS.size === 0) return;
    const now = Date.now();
    if (isNightSilentByOptions(now)) return;

    for (const adminId of QQ_ADMIN_IDS) {
        const { userId } = qqSessionIdentity(adminId);
        const scope = memoryModule.normalizeScopeKey(userId, 'role');
        try {
            const events = readArtifactWindow(scope, now);
            const sent = events
                .filter((e) => e.type === 'delivery.sent')
                .map((e) => ({
                    artifactId: String((e.payload || {}).artifactId || ''),
                    kind: (e.payload || {}).kind || '',
                    at: e.at
                }));
            const artifacts = collectArtifacts(events, { now });
            const unansweredStreak = countUnanswered({ sent, events });
            const pick = selectDeliverable({
                artifacts,
                sent,
                now,
                opts: QQ_ARTIFACT_OPTIONS,
                unansweredStreak
            });
            if (!pick) continue;

            await oneBotClient.sendPrivateMsg(adminId, buildReplySegments(pick.text));
            timeline.append(scope, 'delivery.sent', {
                artifactId: pick.artifactId,
                channel: 'qq',
                kind: pick.kind,
                at: now
            });
            console.log(`[QQ投递] 已私聊 ${maskQQ(adminId)}（${pick.kind}）：${pick.text.slice(0, 60)}`);
        } catch (error) {
            // 不重试超过 1 次：物件留在时间线里，不为送达突破频次约束
            console.warn(`[QQ投递] 私聊 ${maskQQ(adminId)} 失败：${describeOneBotError(error)}`);
        }
    }
}

function isNightSilentByOptions(now) {
    const hour = new Date(now).getHours();
    return hour >= QQ_ARTIFACT_OPTIONS.nightStartHour || hour < QQ_ARTIFACT_OPTIONS.nightEndHour;
}

// 自主发言只服务管理员：把这几个 QQ 的会话登记进 narrator，它才会为这些会话判定。
// 空闲时间取真实最后一条消息的时间，重启后不会把「刚聊完」误当成「很久没聊」。
function seedQQProactiveSessions() {
    const keep = new Set();
    for (const adminId of QQ_ADMIN_IDS) {
        const { sessionId, userId } = ensureQQSession(adminId);
        keep.add(sessionId);
        const state = qqNarrator.ensureState(sessionId);
        state.userId = userId;
        const recent = qqSessionManager.getConversationHistory(sessionId, userId, 20);
        // 只看用户消息：她自己的主动发言不算「人还在」，否则重启后会把她的独白
        // 误当成刚聊过，自主发言的空闲判定和「接话还是自言自语」都会跟着错
        const lastUser = [...recent].reverse().find(msg => msg && msg.role === 'user');
        if (lastUser && lastUser.timestamp) {
            state.lastUserMessageAt = lastUser.timestamp;
        }
    }
    // 切角色 / 改名单后旧 sessionId 会留下孤儿状态，不清掉会继续为不存在的会话烧 API
    for (const sessionId of Array.from(qqNarrator.sessions.keys())) {
        if (!keep.has(sessionId)) qqNarrator.sessions.delete(sessionId);
    }
}

// narrator 判定通过后由它回调进来：落进 QQ 会话历史，再私聊发给对应的管理员
async function handleQQProactiveSpeech({ sessionId, userId, text }) {
    if (!text) return;
    if (!qqBridgeState.enabled) return;
    const adminId = [...QQ_ADMIN_IDS].find(id => qqSessionIdentity(id).sessionId === sessionId);
    if (!adminId) return;

    try {
        qqSessionManager.addConversationMessage(sessionId, userId, {
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            // 标记为角色自己主动开口，后续检索/AI 态可辨认
            proactive: true
        });
    } catch (error) {
        console.error('[QQ自主发言] 写入 QQ 会话历史失败:', error.message);
    }

    try {
        await oneBotClient.sendPrivateMsg(adminId, buildReplySegments(text));
        // 她主动说出口的话也进长期记忆（speaker='self'）：短期历史滑走后，
        // 还能记得「这件事是我自己提过的」，而不是被当成对方说的事实
        memoryModule.storeMemory({ value: 0, scene: '' }, userId, `（你在 QQ 私聊里主动说）${text}`, {
            speaker: 'self',
            source: 'qq_proactive'
        });
        console.log(`[QQ自主发言] 已私聊 ${maskQQ(adminId)}：${text.slice(0, 60)}`);
    } catch (error) {
        console.warn(`[QQ自主发言] 私聊 ${maskQQ(adminId)} 失败：${describeOneBotError(error)}`);
    }
}

async function runQQProactiveTick() {
    if (!qqProactiveStarted || !qqBridgeState.enabled || !qqNarrator.isEnabled()) return;
    try {
        // 事件簿先跑：约定到点/过点是「必须说」的事，别被后面主动发言的判定顺序挤掉
        await qqNarrator.tickAppointments();
        await qqNarrator.tickProactive();
        // 📮 最后投递一件攒着的物件（夜间静默/限额/冷却不满足时自己憋着）
        await deliverPendingArtifacts();
    } catch (error) {
        console.warn('[QQ自主发言] 本轮判定失败:', error.message);
    }
}

function scheduleQQProactiveTick() {
    const delay = QQ_PROACTIVE_MIN_MS + Math.round(Math.random() * (QQ_PROACTIVE_MAX_MS - QQ_PROACTIVE_MIN_MS));
    qqProactiveTimer = setTimeout(() => {
        runQQProactiveTick().finally(scheduleQQProactiveTick);
    }, delay);
    if (typeof qqProactiveTimer.unref === 'function') {
        qqProactiveTimer.unref();
    }
    console.log(`[QQ自主发言] 下一次判定在 ${Math.round(delay / 60000)} 分钟后`);
}

function startQQProactiveSpeech() {
    if (!qqBridgeState.enabled) {
        console.log('[QQ自主发言] QQ 角色已关闭，不启动');
        return;
    }
    if (QQ_ADMIN_IDS.size === 0) {
        console.log('[QQ自主发言] 未配置 QQ_ADMIN_IDS，不启动');
        return;
    }
    qqProactiveStarted = true;
    seedQQProactiveSessions();
    console.log(`[QQ自主发言] 已启动：每 20~30 分钟按网页端同一套判定决定要不要开口（${[...QQ_ADMIN_IDS].map(maskQQ).join('、')}）`);
    scheduleQQProactiveTick();
}

// 同一条消息可能被重复上报（协议端超时重试等），按 message_id 挡一道
const handledQQMessageIds = new Set();
function isDuplicateQQMessage(messageId) {
    const key = idText(messageId);
    if (!key) return false;
    if (handledQQMessageIds.has(key)) return true;
    handledQQMessageIds.add(key);
    if (handledQQMessageIds.size > 200) {
        const keep = [...handledQQMessageIds].slice(-100);
        handledQQMessageIds.clear();
        keep.forEach(id => handledQQMessageIds.add(id));
    }
    return false;
}

// 网页端「QQ 管理指令」开关：控制管理员在群里/私聊发的指令是否被解析执行
app.get('/api/qq/admin-commands', ctx.requireAdmin, (req, res) => {
    res.json({ success: true, enabled: adminCommandsEnabled() });
});

app.post('/api/qq/admin-commands', ctx.requireAdmin, (req, res) => {
    const body = req.body || {};
    if (typeof body.enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'enabled 必须是布尔值' });
    }
    qqBridgeState.adminCommands = body.enabled;
    saveQQBridgeState();
    console.log(`[QQ桥接] 管理指令已${body.enabled ? '开启' : '关闭'}（网页设置）`);
    res.json({ success: true, enabled: adminCommandsEnabled() });
});

// NapCat 的事件上报入口：接住 → 立即应答 → 后台生成回复（回复另走发送接口发）
app.post('/api/onebot/event', (req, res) => {
    if (!isLoopbackRequest(req)) {
        return res.status(403).json({ success: false, message: '仅接受本机上报' });
    }

    const event = req.body || {};
    res.json({ success: true });

    // QQ 角色总开关关掉时，事件照收但一律不处理
    if (!qqBridgeState.enabled) {
        return;
    }
    if (event.post_type !== 'message') {
        return;
    }
    if (isDuplicateQQMessage(event.message_id)) {
        return;
    }

    // 私聊：只服务 QQ_ADMIN_IDS 里的号
    if (event.message_type === 'private') {
        // 同一个人连发多条：也按 QQ 号排队，后一条等前一条回完再处理，
        // 否则两条并发读同一份历史，既会各回一句，落库时还会互相覆盖
        const queueKey = `private|${idText(event.user_id)}`;
        enqueueQQReply(queueKey, () => replyToPrivateMessage(event))
            .then((result) => {
                if (result && result.skipped) {
                    console.log(`[QQ桥接] 跳过私聊 ${idText(event.user_id)}：${result.skipped}`);
                }
            })
            .catch((error) => {
                console.error('[QQ桥接] 处理私聊消息失败:', error.message);
            });
        return;
    }

    if (event.message_type !== 'group') {
        return;
    }

    // 同一个人连发多条：先排队，后一条等前一条回完再处理，历史才是接得上的
    const queueKey = `${idText(event.group_id)}|${idText(event.user_id)}`;
    enqueueQQReply(queueKey, () => replyToGroupMention(event))
        .then((result) => {
            if (result && result.skipped) {
                console.log(`[QQ桥接] 跳过群消息 ${idText(event.message_id)}：${result.skipped}`);
            }
        })
        .catch((error) => {
            console.error('[QQ桥接] 处理群消息失败:', error.message);
        });
});

    return { startQQProactiveSpeech };
}

module.exports = registerQqBridge;
