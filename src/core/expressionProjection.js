'use strict';

// 表情投影层：把「此刻的情绪快照」投影成「此刻怎么表达」。
//
// 设计边界（对应 .trae/documents/哲学设计-交接.md 的三条不变量）：
//   1. 纯函数：只吃快照、只吐参数；不 require emotion.js，不落盘，不持有任何状态
//      —— 物理上没有写入口，就不可能出现「表达层反向定义情绪」。
//   2. 输入只读：fast 向量由 emotionModule.getCurrentEmotions() 现算给出，本模块不缓存。
//   3. 输出只给表达层（网页皮套 / ESP32 动作）：表情名、分层动作、设备动作。
//
// 这里唯一借鉴外部方案（GHOST / Soullink）的是「情绪 → VAD → 分层动作 → 能力探测」这条
// 表演链，不借鉴它的「LLM 给台词打情绪标签」——在本地，情绪只能来自器官层。

// 与 emotion.js 的维度保持一致；此处刻意复制而不 require，保持单向依赖。
const EMOTIONS = ['happy', 'sad', 'shy', 'anxious', 'jealous', 'dependent', 'calm'];

// 7 维 → VAD 三轴（取值 -1..1）。只影响表达力度，不参与情绪真值计算。
const VAD_WEIGHTS = {
    happy: { valence: 1.0, arousal: 0.55, dominance: 0.35 },
    sad: { valence: -0.85, arousal: -0.6, dominance: -0.6 },
    shy: { valence: 0.1, arousal: 0.35, dominance: -0.7 },
    anxious: { valence: -0.6, arousal: 0.8, dominance: -0.6 },
    jealous: { valence: -0.45, arousal: 0.6, dominance: 0.1 },
    dependent: { valence: 0.35, arousal: -0.25, dominance: -0.8 },
    calm: { valence: 0.2, arousal: -0.75, dominance: 0.1 }
};

// 主导情绪 → 表达预设。三层动作各管一段，互不夺权：
//   idle     常驻（呼吸/视线），跟觉醒度走，情绪过去后自然回落
//   speech   说话时的表演，跟情绪强度走
//   reaction 强情绪才触发的一次性动作，弱情绪下为 null
// deviceIntents 是「语义意图 → 动作名」的回退链，按顺序找设备动作表里第一个存在的；
// 一个都没有就不动设备（能力探测，不硬编码具体机型）。
const PRESETS = {
    happy: {
        expression: 'smile',
        idle: 'breathe_light',
        speech: 'bounce',
        reaction: 'wag',
        deviceIntents: ['happy', 'tail_wag', 'wag_tail', '摇尾巴', '开心']
    },
    sad: {
        expression: 'droop',
        idle: 'breathe_slow',
        speech: 'murmur',
        reaction: 'sink',
        deviceIntents: ['sad', 'lie_down', '趴下', '低头', '难过']
    },
    shy: {
        expression: 'avert',
        idle: 'breathe_light',
        speech: 'stammer',
        reaction: 'flinch',
        deviceIntents: ['shy', 'ear_down', 'look_away', '耳朵下垂', '低头', '害羞']
    },
    anxious: {
        expression: 'tense',
        idle: 'breathe_fast',
        speech: 'quiver',
        reaction: 'shiver',
        deviceIntents: ['anxious', 'tremble', 'tail_down', '发抖', '夹尾巴', '紧张']
    },
    jealous: {
        expression: 'side_eye',
        idle: 'breathe_normal',
        speech: 'clip',
        reaction: 'turn_away',
        deviceIntents: ['jealous', 'turn_away', '扭头', '转头', '吃醋']
    },
    dependent: {
        expression: 'lean',
        idle: 'breathe_slow',
        speech: 'whisper',
        reaction: 'nuzzle',
        deviceIntents: ['dependent', 'lean_in', 'come_closer', '贴贴', '靠近', '蹭']
    },
    calm: {
        expression: 'soft',
        idle: 'breathe_soft',
        speech: 'steady',
        reaction: null,
        deviceIntents: ['calm', 'sit', 'idle', '坐下', '安静']
    }
};

const NEUTRAL_VAD = { valence: 0, arousal: 0, dominance: 0 };
// 全零向量时不硬算 VAD（分母过小会被噪声放大），直接给中性
const MIN_WEIGHT = 0.05;

function clamp01(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function dominantOf(vector) {
    let type = 'calm';
    let intensity = 0;
    EMOTIONS.forEach((emotion) => {
        const value = clamp01(vector[emotion]);
        if (value > intensity) {
            intensity = value;
            type = emotion;
        }
    });
    return { type, intensity: round3(intensity) };
}

// fast 向量 → VAD：按各维数值做加权平均。数值全零 → 返回中性。
function projectVAD(fast) {
    const vector = fast && typeof fast === 'object' ? fast : {};
    let total = 0;
    const acc = { valence: 0, arousal: 0, dominance: 0 };
    EMOTIONS.forEach((emotion) => {
        const weight = clamp01(vector[emotion]);
        if (weight <= 0) return;
        const target = VAD_WEIGHTS[emotion];
        total += weight;
        acc.valence += target.valence * weight;
        acc.arousal += target.arousal * weight;
        acc.dominance += target.dominance * weight;
    });
    if (total < MIN_WEIGHT) return { ...NEUTRAL_VAD };
    return {
        valence: round3(acc.valence / total),
        arousal: round3(acc.arousal / total),
        dominance: round3(acc.dominance / total)
    };
}

// 能力探测：只在设备真实存在的动作里挑，挑不到就返回 null（宁可不做，也不报错）
function resolveDevice(intents, availableActions) {
    const list = Array.isArray(availableActions)
        ? availableActions.map((name) => String(name == null ? '' : name).trim()).filter(Boolean)
        : [];
    if (list.length === 0) return null;
    const lower = list.map((name) => name.toLowerCase());
    for (const intent of intents || []) {
        const key = String(intent);
        let index = list.indexOf(key);
        if (index < 0) index = lower.indexOf(key.toLowerCase());
        if (index >= 0) return { intent: key, action: list[index] };
    }
    return null;
}

// 主投影：snapshot = { at, sessionId, userId, fast }，options = { availableActions }
function project(snapshot = {}, options = {}) {
    const fast = snapshot && typeof snapshot.fast === 'object' && snapshot.fast ? snapshot.fast : {};
    const primary = dominantOf(fast);
    const preset = PRESETS[primary.type] || PRESETS.calm;
    const vad = projectVAD(fast);
    // 常驻动作跟觉醒度走；情绪越强，呼吸越快
    const idleIntensity = clamp01(0.4 + 0.6 * Math.max(0, vad.arousal));
    // 一次性动作只在情绪够强时触发，避免每轮都抖一下
    const reaction = preset.reaction && primary.intensity >= 0.6
        ? { name: preset.reaction, intensity: primary.intensity }
        : null;
    return {
        at: Number.isFinite(snapshot.at) ? snapshot.at : Date.now(),
        sessionId: snapshot.sessionId || null,
        userId: snapshot.userId || null,
        primary,
        vad,
        expression: { name: preset.expression, intensity: primary.intensity },
        layers: {
            idle: { name: preset.idle, intensity: round3(idleIntensity) },
            speech: { name: preset.speech, intensity: primary.intensity },
            reaction
        },
        device: resolveDevice(preset.deviceIntents, options.availableActions)
    };
}

module.exports = {
    EMOTIONS,
    VAD_WEIGHTS,
    PRESETS,
    project,
    projectVAD,
    dominantOf,
    resolveDevice
};
