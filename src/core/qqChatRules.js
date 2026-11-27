'use strict';

// QQ 群聊白名单与发言规则：落 data/qq_chat_rules.json。
// 名单外的群保持「@ 就回」；名单内的群按 mode 决定是否/如何主动接话。
// 这里只管读写，不碰网络；bridge 与 onebotRoutes 共享同一份内存状态。
const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, '../../data/qq_chat_rules.json');

// mention：仅 @ 回复；keyword：仅关键词；both：@ 或关键词；
// willing：看她意愿自主接话；off：本群不发言（管理员指令除外）
const MODES = ['mention', 'keyword', 'both', 'willing', 'off'];
const DEFAULT_MODE = 'mention';

function defaultGroupRule(groupId) {
    return {
        groupId: String(groupId || '').trim(),
        name: '',
        enabled: false,
        mode: DEFAULT_MODE,
        keywords: [],
        muted: false
    };
}

function normalizeGroupRule(groupId, raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const mode = MODES.includes(String(source.mode)) ? String(source.mode) : DEFAULT_MODE;
    const keywords = Array.isArray(source.keywords)
        ? source.keywords.map(item => String(item || '').trim()).filter(Boolean)
        : [];
    return {
        groupId: String(groupId || '').trim(),
        name: String(source.name || '').trim(),
        enabled: source.enabled === true,
        mode,
        keywords,
        muted: source.muted === true
    };
}

let cachedState = null;

function loadRules() {
    if (cachedState) return cachedState;
    cachedState = { groups: {} };
    try {
        if (!fs.existsSync(RULES_PATH)) return cachedState;
        const saved = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')) || {};
        const groups = saved.groups && typeof saved.groups === 'object' ? saved.groups : {};
        Object.keys(groups).forEach((groupId) => {
            if (!/^\d+$/.test(groupId)) return;
            cachedState.groups[groupId] = normalizeGroupRule(groupId, groups[groupId]);
        });
    } catch (error) {
        console.error('[QQ规则] 读取群聊白名单失败，改用空配置:', error.message);
    }
    return cachedState;
}

function saveRules() {
    try {
        fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
        fs.writeFileSync(RULES_PATH, JSON.stringify(cachedState, null, 2), 'utf8');
    } catch (error) {
        console.error('[QQ规则] 保存群聊白名单失败:', error.message);
    }
}

function listGroupRules() {
    return Object.values(loadRules().groups).map(rule => ({ ...rule }));
}

function getGroupRule(groupId) {
    const id = String(groupId || '').trim();
    const saved = loadRules().groups[id];
    return saved ? { ...saved } : defaultGroupRule(id);
}

// 新增或局部更新一个群；groupId 不是纯数字就返回 null
function upsertGroupRule(groupId, patch = {}) {
    const id = String(groupId || '').trim();
    if (!/^\d+$/.test(id)) return null;
    const state = loadRules();
    const next = normalizeGroupRule(id, { ...(state.groups[id] || {}), ...patch });
    state.groups[id] = next;
    saveRules();
    return { ...next };
}

function removeGroupRule(groupId) {
    const id = String(groupId || '').trim();
    const state = loadRules();
    if (!state.groups[id]) return false;
    delete state.groups[id];
    saveRules();
    return true;
}

// 群级静默：管理员说「闭嘴」置 true，「开嘴」置 false。与是否在白名单无关
function setGroupMuted(groupId, muted) {
    return upsertGroupRule(groupId, { muted: muted === true });
}

module.exports = {
    MODES,
    listGroupRules,
    getGroupRule,
    upsertGroupRule,
    removeGroupRule,
    setGroupMuted
};
