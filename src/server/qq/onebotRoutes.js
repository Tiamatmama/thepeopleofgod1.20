'use strict';

// QQ 对接读取接口（从 server/index.js 抽出）——只暴露读取类接口；
// 发送能力仅由 qq/bridge.js 内部调用。依赖经 ctx 注入。
const { describeError: describeOneBotError } = require('../../core/oneBotClient');
const qqChatRules = require('../../core/qqChatRules');

function registerOnebotRoutes(app, ctx) {
    const { requireAdmin, serverError, oneBotConfig, oneBotClient, validateServiceUrl } = ctx;

// ==================== QQ 对接（OneBot v11 / NapCat）====================
// 这里只暴露读取类接口；发送能力仅由下面的 QQ 群聊桥接内部调用（send_group_msg）
app.get('/api/onebot/config', requireAdmin, (req, res) => {
    try {
        res.json({ success: true, config: oneBotConfig.getMasked() });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/onebot/config', requireAdmin, (req, res) => {
    try {
        const body = req.body || {};
        const httpUrl = typeof body.httpUrl === 'string' ? body.httpUrl.trim() : '';
        if (httpUrl && !validateServiceUrl(httpUrl)) {
            return res.status(400).json({ success: false, message: 'OneBot 地址必须是 http/https 开头的合法 URL' });
        }
        const config = oneBotConfig.update(body);
        console.log('[OneBot] 配置已通过网页更新');
        res.json({ success: true, config });
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/onebot/config', requireAdmin, (req, res) => {
    try {
        console.log('[OneBot] 配置已清除，回到 .env 默认值');
        res.json({ success: true, config: oneBotConfig.reset() });
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/onebot/test', requireAdmin, async (req, res) => {
    res.json(await oneBotClient.testConnection());
});

app.get('/api/onebot/status', requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, status: await oneBotClient.getStatus() });
    } catch (error) {
        res.json({ success: false, message: describeOneBotError(error) });
    }
});

app.get('/api/onebot/friends', requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, friends: await oneBotClient.getFriendList() });
    } catch (error) {
        res.json({ success: false, message: describeOneBotError(error) });
    }
});

app.get('/api/onebot/groups', requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, groups: await oneBotClient.getGroupList() });
    } catch (error) {
        res.json({ success: false, message: describeOneBotError(error) });
    }
});

app.get('/api/onebot/groups/:groupId/members', requireAdmin, async (req, res) => {
    try {
        const members = await oneBotClient.getGroupMemberList(req.params.groupId);
        res.json({ success: true, members: Array.isArray(members) ? members : [] });
    } catch (error) {
        res.json({ success: false, message: describeOneBotError(error) });
    }
});

// 历史消息：type=friend 按 user_id 取，type=group 按 group_id 取
app.get('/api/onebot/messages', requireAdmin, async (req, res) => {
    const type = req.query.type;
    const id = String(req.query.id || '').trim();
    const count = Math.min(Math.max(Number(req.query.count) || 20, 1), 100);

    if (!id || (type !== 'friend' && type !== 'group')) {
        return res.json({ success: false, message: '参数不全：需要 type=friend|group 与 id' });
    }
    if (!/^\d+$/.test(id)) {
        return res.json({ success: false, message: 'id 必须是纯数字' });
    }

    try {
        const data = type === 'friend'
            ? await oneBotClient.getFriendMsgHistory(id, count)
            : await oneBotClient.getGroupMsgHistory(id, count);
        // NapCat 把消息放在 {messages:[...]} 里，也有实现直接返回数组，两种都认
        const messages = Array.isArray(data)
            ? data
            : (data && Array.isArray(data.messages) ? data.messages : []);
        res.json({ success: true, type, id, messages });
    } catch (error) {
        res.json({ success: false, message: describeOneBotError(error) });
    }
});

// ==================== 群聊白名单 / 发言规则 ====================
app.get('/api/qq/rules', requireAdmin, (req, res) => {
    res.json({ success: true, groups: qqChatRules.listGroupRules() });
});

app.post('/api/qq/rules', requireAdmin, (req, res) => {
    const body = req.body || {};
    const groupId = String(body.groupId || '').trim();
    if (!/^\d+$/.test(groupId)) {
        return res.status(400).json({ success: false, message: '群号必须是纯数字' });
    }

    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name || '').trim().slice(0, 80);
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.mode !== undefined) {
        const mode = String(body.mode);
        if (!qqChatRules.MODES.includes(mode)) {
            return res.status(400).json({ success: false, message: '未知的发言规则' });
        }
        patch.mode = mode;
    }
    if (body.keywords !== undefined) {
        const rawList = Array.isArray(body.keywords)
            ? body.keywords
            : String(body.keywords || '').split(/[,，\s]+/);
        patch.keywords = rawList
            .map(item => String(item || '').trim().slice(0, 30))
            .filter(Boolean);
    }
    if (body.muted !== undefined) patch.muted = body.muted === true;

    res.json({ success: true, group: qqChatRules.upsertGroupRule(groupId, patch) });
});

app.delete('/api/qq/rules/:groupId', requireAdmin, (req, res) => {
    const removed = qqChatRules.removeGroupRule(req.params.groupId);
    res.json({ success: true, removed });
});

}

module.exports = registerOnebotRoutes;
