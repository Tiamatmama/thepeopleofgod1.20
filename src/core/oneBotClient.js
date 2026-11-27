/**
 * OneBot v11 客户端（对接 NapCat / LLOneBot 等协议端的 HTTP 接口）
 *
 * 允许调用的动作在下面的白名单里写死，白名单之外的一律拒绝。
 * 读取类动作见 READ_ACTIONS；发送类动作只有 SEND_ACTIONS 里那一项，
 * 用于「群里有人 @ 角色 → 角色回一句」，不接受任意动作。
 *
 * 协议：HTTP 模式下对 {httpUrl}/{action} 发 POST，body 是参数对象，
 * 响应为 {status:'ok'|'failed', retcode, data}；access_token 走 Authorization 头。
 */

const axios = require('axios');
const oneBotConfig = require('./oneBotConfig');

// 读取类动作
const READ_ACTIONS = [
    'get_login_info',
    'get_status',
    'get_friend_list',
    'get_group_list',
    'get_group_member_list',
    'get_msg',                // 按 message_id 取单条消息（取被引用消息的作者/内容）
    'get_msg_history',
    'get_friend_msg_history', // NapCat 扩展
    'get_group_msg_history',  // NapCat 扩展
    'can_send_image',
    'get_cookies'             // NapCat 扩展，仅内部用来取 QZone 登录票据
];

// 发送类动作：群消息，以及只对管理员开放的私聊消息
const SEND_ACTIONS = [
    'send_group_msg',
    'send_private_msg'
];

// 管理类动作：换头像 / 改群名片 / 禁言。只由管理员的本地指令触发，不交给模型自主决定
const MANAGE_ACTIONS = [
    'set_group_ban',
    'set_group_whole_ban',
    'set_group_card',
    'set_qq_avatar'           // NapCat 扩展
];

const ALLOWED_ACTIONS = [...READ_ACTIONS, ...SEND_ACTIONS, ...MANAGE_ACTIONS];

const REQUEST_TIMEOUT = 15000;

// 把网络层/协议层的报错翻译成看得懂的话
function describeError(error) {
    if (!error) return '未知错误';
    if (error.code === 'ECONNREFUSED') {
        return '连不上协议端，请确认 NapCat 已启动、HTTP 服务已开启且地址端口正确';
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return '请求超时，协议端没有响应';
    }
    if (error.code === 'ENOTFOUND') {
        return '地址解析失败，请检查 OneBot HTTP 地址是否写对';
    }
    if (error.response) {
        const status = error.response.status;
        if (status === 401 || status === 403) {
            return `协议端拒绝了请求（HTTP ${status}），多半是 access_token 不对`;
        }
        return `协议端返回 HTTP ${status}`;
    }
    return error.message || '未知错误';
}

// 从 Cookie 串里取某个键的值
function parseCookieValue(cookieText, name) {
    const match = String(cookieText || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? match[1] : '';
}

// QZone 内部接口用的 g_tk：由 p_skey 按固定的 hash33 算法算出
function gtkFromPskey(pskey) {
    let hash = 5381;
    for (let i = 0; i < String(pskey || '').length; i += 1) {
        hash += (hash << 5) + String(pskey).charCodeAt(i);
    }
    return hash & 0x7fffffff;
}

class OneBotClient {
    // 唯一的出网口：白名单校验 → 发请求 → 校验 OneBot 响应结构
    async call(action, params = {}) {
        if (!ALLOWED_ACTIONS.includes(action)) {
            throw new Error(`客户端不允许调用动作：${action}`);
        }

        const config = oneBotConfig.getConfig();
        if (!config.httpUrl) {
            throw new Error('尚未配置 OneBot HTTP 地址');
        }

        const headers = { 'Content-Type': 'application/json' };
        if (config.accessToken) {
            headers.Authorization = `Bearer ${config.accessToken}`;
        }

        const response = await axios.post(`${config.httpUrl}/${action}`, params || {}, {
            timeout: REQUEST_TIMEOUT,
            headers
        });

        const body = response.data || {};
        if (body.status === 'failed' || (typeof body.retcode === 'number' && body.retcode !== 0)) {
            const detail = body.message || body.wording || `retcode ${body.retcode}`;
            throw new Error(`协议端返回失败：${detail}`);
        }
        if (body.status !== 'ok' && typeof body.retcode !== 'number') {
            throw new Error('返回结构不像 OneBot v11 响应，请确认地址指向协议端的 HTTP 接口');
        }

        return body.data;
    }

    getLoginInfo() {
        return this.call('get_login_info');
    }

    getStatus() {
        return this.call('get_status');
    }

    getFriendList() {
        return this.call('get_friend_list');
    }

    getGroupList() {
        return this.call('get_group_list');
    }

    getGroupMemberList(groupId) {
        return this.call('get_group_member_list', { group_id: Number(groupId) });
    }

    // 群资料：群名、人数。用来让角色分得清「现在在哪个群」
    getGroupInfo(groupId) {
        return this.call('get_group_info', { group_id: Number(groupId) });
    }

    // 按 message_id 取单条消息，用于解析被引用（reply）消息的作者与正文
    getMsg(messageId) {
        return this.call('get_msg', { message_id: Number(messageId) });
    }

    getFriendMsgHistory(userId, count = 20) {
        return this.call('get_friend_msg_history', { user_id: Number(userId), count: Number(count) });
    }

    getGroupMsgHistory(groupId, count = 20) {
        return this.call('get_group_msg_history', { group_id: Number(groupId), count: Number(count) });
    }

    // 发群消息。message 传 OneBot 消息段数组，形如
    // [{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' 你好' } }]
    sendGroupMsg(groupId, message) {
        return this.call('send_group_msg', {
            group_id: Number(groupId),
            message: Array.isArray(message) ? message : String(message || '')
        });
    }

    // 发私聊消息，只给 QQ 管理员私聊桥接用
    sendPrivateMsg(userId, message) {
        return this.call('send_private_msg', {
            user_id: Number(userId),
            message: Array.isArray(message) ? message : String(message || '')
        });
    }

    // 群单人禁言，duration 单位为秒，0 表示解除禁言
    setGroupBan(groupId, userId, duration) {
        return this.call('set_group_ban', {
            group_id: Number(groupId),
            user_id: Number(userId),
            duration: Number(duration) || 0
        });
    }

    // 群全员禁言开关
    setGroupWholeBan(groupId, enable) {
        return this.call('set_group_whole_ban', {
            group_id: Number(groupId),
            enable: !!enable
        });
    }

    // 设置群名片（群备注）
    setGroupCard(groupId, userId, card) {
        return this.call('set_group_card', {
            group_id: Number(groupId),
            user_id: Number(userId),
            card: String(card || '')
        });
    }

    // 设置登录号头像。file 支持图片链接或协议端可见的本机路径
    setQqAvatar(file) {
        return this.call('set_qq_avatar', { file: String(file || '') });
    }

    // 取指定域名的登录 Cookie（字符串），仅供内部发布 QZone 时使用
    getCookies(domain) {
        return this.call('get_cookies', domain ? { domain: String(domain) } : {});
    }

    // 发 QZone 说说：OneBot/NapCat 没有原生接口，只能靠登录票据走 QZone 内部接口。
    // 实验性能力——依赖协议端能返回 p_skey，且腾讯侧接口可能随时变动。
    async publishQzone(content) {
        const text = String(content || '').trim();
        if (!text) throw new Error('说说内容为空');

        const cookies = await this.getCookies('qzone.qq.com');
        const cookieText = typeof cookies === 'string'
            ? cookies
            : (cookies && (cookies.cookies || cookies.cookie)) || '';
        const pskey = parseCookieValue(cookieText, 'p_skey') || parseCookieValue(cookieText, 'skey');
        const uin = parseCookieValue(cookieText, 'uin').replace(/^o/, '') || parseCookieValue(cookieText, 'p_uin').replace(/^o/, '');
        if (!cookieText || !pskey) {
            throw new Error('没取到 QZone 登录票据（协议端 get_cookies 未返回 p_skey）');
        }

        const gtk = gtkFromPskey(pskey);
        const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk}`;
        const body = new URLSearchParams({
            conformat: 'json',
            content: text,
            qzreferrer: `https://user.qzone.qq.com/${uin}`
        }).toString();

        const response = await axios.post(url, body, {
            timeout: REQUEST_TIMEOUT,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookieText,
                Referer: `https://user.qzone.qq.com/${uin}`
            }
        });

        const result = response.data || {};
        if (result.code !== undefined && Number(result.code) !== 0) {
            throw new Error(result.message || result.msg || `QZone 返回 code ${result.code}`);
        }
        return result;
    }

    async testConnection() {
        try {
            const login = await this.getLoginInfo();
            const nickname = (login && login.nickname) || '(未取到昵称)';
            const userId = (login && login.user_id) || '未知';
            return { success: true, message: `连接成功，当前登录：${nickname}（${userId}）`, login };
        } catch (error) {
            return { success: false, message: describeError(error) };
        }
    }
}

module.exports = { OneBotClient, READ_ACTIONS, SEND_ACTIONS, MANAGE_ACTIONS, ALLOWED_ACTIONS, describeError };
