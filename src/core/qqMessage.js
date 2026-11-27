/**
 * QQ 桥接的「消息段解析」与「管理指令解析」——纯函数集合。
 *
 * 这里只做「输入字符串/消息段 → 输出结构化对象」的事，不碰网络、不碰会话、不读写文件，
 * 所以可以单独拿出来测。原先散在 server/index.js 里，随桥接一起膨胀；
 * 抽出来之后 index.js 只留状态编排，解析逻辑集中在这一个文件。
 */

function idText(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

// 拆消息段：拿到 @ 了谁（含 @全体）与去掉 @ 之后的正文
function readMention(segments, selfId) {
    const ats = [];
    const texts = [];
    (Array.isArray(segments) ? segments : []).forEach((seg) => {
        if (!seg || typeof seg !== 'object') return;
        const data = seg.data || {};
        if (seg.type === 'at') {
            ats.push(idText(data.qq));
        } else if (seg.type === 'text') {
            texts.push(String(data.text || ''));
        }
    });
    return {
        ats,
        mentionsSelf: ats.includes(selfId),
        mentionsAll: ats.includes('all'),
        text: texts.join('').trim()
    };
}

// 从消息段里抠出被引用（reply）消息的 id；没有引用返回空串
function readReplyId(segments) {
    const seg = (Array.isArray(segments) ? segments : []).find(
        item => item && item.type === 'reply' && item.data && item.data.id !== undefined
    );
    return seg ? idText(seg.data.id) : '';
}

// 把一条历史消息的正文拼出来：只取文字段，@、图片等一律丢掉
function messagePlainText(segments) {
    return (Array.isArray(segments) ? segments : [])
        .filter(seg => seg && seg.type === 'text' && seg.data)
        .map(seg => String(seg.data.text || ''))
        .join('')
        .trim();
}

// 把回复正文拼成 OneBot 消息段：普通文字原样发，图片标记转成 image 段。
// 支持标准 CQ 码 [CQ:image,file=xxx] 和口语写法 [图片:xxx]；file 可以是 http(s) 链接或协议端可见的本机路径。
function buildReplySegments(reply, options = {}) {
    const text = String(reply || '');
    const segments = [];
    if (options.atQQ) {
        segments.push({ type: 'at', data: { qq: options.atQQ } });
    }
    const pattern = /\[CQ:image,[^\]]*?file=([^,\]]+)[^\]]*\]|\[图片[:：]\s*([^\]]+)\]/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const before = text.slice(last, match.index);
        if (before) segments.push({ type: 'text', data: { text: before } });
        const file = String(match[1] || match[2] || '').trim();
        if (file) segments.push({ type: 'image', data: { file } });
        last = match.index + match[0].length;
    }
    const rest = text.slice(last);
    if (rest) segments.push({ type: 'text', data: { text: rest } });
    if (segments.length === 0) segments.push({ type: 'text', data: { text } });
    return segments;
}

// 管理员指令：只认明确的指令词，避免把普通聊天误判成改设定
const QQ_PROFILE_FIELDS = {
    '名字': 'name', '名称': 'name', 'name': 'name',
    '年龄': 'age', 'age': 'age',
    '性格': 'personality', 'personality': 'personality',
    '背景': 'background', '人设': 'background', 'background': 'background'
};
const QQ_PROFILE_LABELS = { name: '名字', age: '年龄', personality: '性格', background: '背景' };

function parseAdminCommand(text) {
    const raw = String(text || '').trim().replace(/^[\/／]/, '').trim();
    if (!raw) return null;
    let match = raw.match(/^(?:切换角色|切换人设|换角色|换人设)\s*[:：]?\s*([\s\S]+)$/);
    if (match) return { action: 'switchRole', value: match[1].trim() };
    match = raw.match(/^(?:改人设|修改人设|设置人设|改性格|改背景)\s*[:：]?\s*([\s\S]+)$/);
    if (match) return { action: 'editProfile', value: match[1].trim() };
    match = raw.match(/^(?:改记忆|修改记忆|加记忆|记一下)\s*[:：]?\s*([\s\S]+)$/);
    if (match) return { action: 'editMemory', value: match[1].trim() };
    // 换头像 / 发空间是账号级操作，群和私聊都能用
    match = raw.match(/^(?:换头像|设置头像|改头像)\s*[:：]?\s*([\s\S]+)$/);
    if (match) return { action: 'setAvatar', value: match[1].trim() };
    match = raw.match(/^(?:发空间|发说说|发个说说|发条说说)\s*[:：]?\s*([\s\S]+)$/);
    if (match) return { action: 'postQzone', value: match[1].trim() };
    // 以下都是群管理操作，只在群里生效
    match = raw.match(/^(?:解除禁言|解禁)\s*[:：]?\s*([\s\S]*)$/);
    if (match) return { action: 'unban', value: match[1].trim() };
    match = raw.match(/^(?:全员禁言|全体禁言|全员闭麦)\s*[:：]?\s*([\s\S]*)$/);
    if (match) return { action: 'wholeBan', value: match[1].trim() };
    // 「禁言」永远是禁言别人；「闭嘴」不带目标时是让机器人本群静音，
    // 带 @ 目标或 QQ 号时仍按禁言处理（在 runQQAdminCommand 里分流）
    match = raw.match(/^(?:禁言)\s*[:：]?\s*([\s\S]*)$/);
    if (match) return { action: 'ban', value: match[1].trim() };
    match = raw.match(/^(?:闭嘴)\s*[:：]?\s*([\s\S]*)$/);
    if (match) return { action: 'muteSelf', value: match[1].trim() };
    match = raw.match(/^(?:开嘴|解除闭嘴|可以说话了)\s*[:：]?\s*([\s\S]*)$/);
    if (match) return { action: 'unmuteSelf', value: match[1].trim() };
    match = raw.match(/^(?:改名片|改群名片|设置群名片|改群昵称)\s*[:：]?\s*([\s\S]*)$/);
    if (match) return { action: 'setGroupCard', value: match[1].trim() };
    match = raw.match(/^(?:发图|发图片|发张图)\s*[:：]?\s*([\s\S]+)$/);
    if (match) return { action: 'sendImage', value: match[1].trim() };
    if (/^(?:管理|管理员|帮助|指令|help)$/i.test(raw)) return { action: 'help' };
    return null;
}

// 解析群管理指令的目标人：优先取被 @ 的人（排掉机器人自己和 @全体），
// 没有 @ 就看正文开头是不是一个 QQ 号。返回剩下的正文给调用方当参数用。
function resolveQQTarget(context, value) {
    const ats = (Array.isArray(context.ats) ? context.ats : [])
        .map(idText)
        .filter(id => id && id !== idText(context.selfId) && id !== 'all');
    if (ats.length) {
        return { targetId: ats[0], rest: String(value || '').trim() };
    }
    const match = String(value || '').trim().match(/^(\d{5,12})\s*([\s\S]*)$/);
    if (match) {
        return { targetId: match[1], rest: match[2].trim() };
    }
    return { targetId: '', rest: String(value || '').trim() };
}

// 改人设按「字段=值」解析，如：改人设 性格=冷淡 背景=她是个安静的少女
function parseProfileFields(text) {
    const source = String(text || '');
    const fieldNames = Object.keys(QQ_PROFILE_FIELDS).join('|');
    const matches = [...source.matchAll(new RegExp(`(${fieldNames})\\s*[=＝:：]\\s*`, 'gi'))];
    const result = {};
    matches.forEach((match, index) => {
        const field = QQ_PROFILE_FIELDS[match[1].toLowerCase()] || QQ_PROFILE_FIELDS[match[1]];
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
        const value = source.slice(start, end).trim();
        if (field && value) result[field] = value;
    });
    return result;
}

function adminCommandHelp() {
    return [
        '管理员指令（群里 @ 我，或管理员直接私聊我）：',
        '· 切换角色 <角色名>',
        '· 改人设 性格=… 背景=… 年龄=…',
        '· 改记忆 <内容>',
        '· 换头像 <图片链接/本机路径>',
        '· 发空间 <内容>（实验性）',
        '— 以下只在群里可用 —',
        '· 改名片 @某人 <新名片>',
        '· 禁言 @某人 [分钟]（默认 10 分钟）',
        '· 解除禁言 @某人',
        '· 全员禁言 开/关',
        '· 闭嘴（让我在这个群停止发言，管理员不用 @ 我）',
        '· 开嘴（解除本群闭嘴；带 @ 目标时「闭嘴」等于禁言）',
        '· 发图 <图片链接/本机路径>',
        '— 群友蒸馏 —',
        '· 群里同时 @ 我 和 目标群员，并引用他本人同意被蒸馏的那条消息',
        '  （他会生成一份人格文件，并存进网页端角色库）'
    ].join('\n');
}

// 这条消息要不要触发蒸馏：正文为空，或带「蒸馏/人格/提取」关键字才算，免得别的引用被误当成蒸馏
function looksLikeDistillRequest(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    return /蒸馏|人格|提取/.test(t);
}

function buildDistillPrompt() {
    return [
        '你在做人物人格提取。用户会给你某个 QQ 群成员在群里的若干条发言样本，',
        '请据此推断他作为一个「角色」的人格设定，用于角色扮演。',
        '',
        '只输出一个 JSON 对象，不要解释、不要加 markdown 代码块，字段如下：',
        '{',
        '  "name": "适合当角色名的称呼（优先用他在群里被叫的名字/昵称，可稍作润色）",',
        '  "age": "推测年龄（不确定就留空字符串）",',
        '  "personality": "性格特点，一段话，涵盖语气、常用表达、情绪倾向、说话风格",',
        '  "background": "背景故事，一段话，基于发言合理想象其身份/处境"',
        '}',
        '',
        '要求：只依据发言样本推断，不要编造与样本明显冲突的内容；profile 要能让人一眼看出就是他。'
    ].join('\n');
}

function buildQQIntentPrompt(roleNames, currentRole) {
    const rolesText = roleNames.length ? roleNames.map(name => `「${name}」`).join('、') : '（网页端还没有角色）';
    return [
        '你在给一个 QQ 群聊机器人做指令识别。管理员 @ 机器人说话时，判断他是不是在下达「改角色设定」的指令，并整理成 JSON。',
        '',
        `可选角色：${rolesText}`,
        `当前角色：${currentRole}`,
        '',
        '只输出一个 JSON 对象，不要解释、不要加 markdown 代码块。五种可能：',
        '1. 切换群聊角色：{"action":"switchRole","roleName":"角色名"}；roleName 只能从上面的可选角色里挑最接近的一个',
        '2. 只有管理员明确要求记录时才输出：{"action":"editMemory","content":"要记的内容"}。必须是「记住 / 记一下 / 帮我记住 / 改记忆：…」这类明确的指令口气。',
        '   陈述自己的情况、习惯、开销、计划、情绪，或者解释、反问、纠正某句话，一律 {"action":"none"}——即使内容看起来值得记住，也不要自动记。',
        '3. 让机器人先在这个群别说话：{"action":"muteSelf"}',
        '4. 让机器人恢复在这个群说话：{"action":"unmuteSelf"}',
        '5. 不是指令（闲聊、提问、跑题、单纯打招呼）：{"action":"none"}',
        '',
        '「改人设」不在你的判断范围内：那必须由管理员用固定格式明确下达，你不用管、也不要替他猜。',
        '',
        '注意：管理员可能用 / 、空格或换行来分隔，也可能在指令前加「管理员」「管理」两个字。'
    ].join('\n');
}

// 模型有时会裹一层 ```json 或前后加解释，这里只抠第一个 { 到最后一个 } 之间的内容
function extractJsonObject(text) {
    const raw = String(text || '').replace(/```[a-zA-Z]*/g, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
        return null;
    }
}

// 把模型给的意图收敛成 runQQAdminCommand 认识的结构，字段一律过白名单，认不出就当没这条指令
function intentToCommand(intent) {
    if (!intent || typeof intent !== 'object') return null;
    const action = String(intent.action || '').trim();

    if (action === 'switchRole') {
        const roleName = String(intent.roleName || intent.value || '').trim();
        return roleName ? { action: 'switchRole', value: roleName } : null;
    }

    // 改人设只能走 parseAdminCommand 那条死格式，模型再怎么理解都不放行
    if (action === 'editMemory') {
        const content = String(intent.content || intent.value || '').trim();
        return content ? { action: 'editMemory', value: content } : null;
    }

    if (action === 'help') return { action: 'help' };
    if (action === 'muteSelf') return { action: 'muteSelf', value: '' };
    if (action === 'unmuteSelf') return { action: 'unmuteSelf', value: '' };
    return null;
}

module.exports = {
    idText,
    readMention,
    readReplyId,
    messagePlainText,
    buildReplySegments,
    QQ_PROFILE_FIELDS,
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
};
