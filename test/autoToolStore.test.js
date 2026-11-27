'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AutoToolStore } = require('../src/core/autoToolStore');
const EmotionLedger = require('../src/core/emotionLedger');

// 每个用例一个独立的临时 projectRoot，避免污染真实 data/auto_tools.json
function makeStore(builtinNames = ['search_chat_history', 'write_file', 'read_file', 'say']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autotool-'));
    return new AutoToolStore({ projectRoot: root, desktopDir: '/desk', builtinNames });
}

function validDraft() {
    return {
        name: 'auto_export_chat_log',
        description: '把聊天记录导出成 markdown 放到桌面',
        parameters: {
            type: 'object',
            properties: { limit: { type: 'integer', description: '导出条数' } },
            required: []
        },
        steps: [
            { tool: 'search_chat_history', args: { scope: 'all', limit: 200 }, bind: 'history' },
            { tool: 'write_file', args: { path: '%DESKTOP%/chat.md', content: '$history' }, bind: null }
        ]
    };
}

test('validateDraft：合规草案通过', () => {
    const store = makeStore();
    assert.deepEqual(store.validateDraft(validDraft()), { ok: true });
});

test('validateDraft：name 必须以 auto_ 开头', () => {
    const store = makeStore();
    const draft = validDraft();
    draft.name = 'export_chat_log';
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /auto_/);
});

test('validateDraft：steps 里的 tool 必须在白名单内', () => {
    const store = makeStore();
    const draft = validDraft();
    draft.steps[0].tool = 'not_a_real_tool';
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /不在内置工具名单/);
});

test('validateDraft：禁止打包危险工具 run_command', () => {
    const store = makeStore(['run_command', 'write_file']);
    const draft = validDraft();
    draft.steps[0].tool = 'run_command';
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /危险工具/);
});

test('validateDraft：引用未定义的变量被拒', () => {
    const store = makeStore();
    const draft = validDraft();
    draft.steps[1].args.content = '$missing';
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /未定义的变量/);
});

test('validateDraft：步骤数不得超过 8', () => {
    const store = makeStore();
    const draft = validDraft();
    draft.steps = Array.from({ length: 9 }, () => ({ tool: 'say', args: {}, bind: null }));
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /8 步/);
});

test('validateDraft：变量引用链超过 2 层被拒', () => {
    const store = makeStore();
    const draft = validDraft();
    draft.steps = [
        { tool: 'search_chat_history', args: {}, bind: 'a' },
        { tool: 'read_file', args: { path: '$a' }, bind: 'b' },
        { tool: 'write_file', args: { path: '$b' }, bind: 'c' }
    ];
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /引用链/);
});

test('validateDraft：不支持的参数类型被拒', () => {
    const store = makeStore();
    const draft = validDraft();
    draft.parameters.properties.limit.type = 'datetime';
    const result = store.validateDraft(draft);
    assert.equal(result.ok, false);
    assert.match(result.reason, /不支持的参数类型/);
});

test('register：注册成功后可被 getActive/listActive 取到', () => {
    const store = makeStore();
    const result = store.register(validDraft(), { userIds: ['u1'] });
    assert.equal(result.ok, true);
    assert.equal(result.tool.status, 'active');
    assert.equal(store.getActive('auto_export_chat_log').name, 'auto_export_chat_log');
    assert.equal(store.listActive().length, 1);
    // 落盘后重新加载仍然存在
    const reloaded = new AutoToolStore({ projectRoot: store.projectRoot, desktopDir: '/desk' });
    assert.equal(reloaded.getActive('auto_export_chat_log').callCount, 0);
});

test('register：同名已存在直接拒（改旧工具必须走审批）', () => {
    const store = makeStore();
    store.register(validDraft(), {});
    const again = store.register(validDraft(), {});
    assert.equal(again.ok, false);
    assert.match(again.reason, /已存在/);
});

test('resolvePlaceholders：解析占位符与变量', () => {
    const store = makeStore();
    const context = { history: 'hello' };
    const resolved = store.resolvePlaceholders(
        { path: '%DESKTOP%/chat.md', content: '$history', nested: { list: ['$history'] } },
        context
    );
    assert.equal(resolved.path, '/desk/chat.md');
    assert.equal(resolved.content, 'hello');
    assert.deepEqual(resolved.nested.list, ['hello']);
});

test('applyFeedback：连续 3 次 negative → 自动停用', () => {
    const store = makeStore();
    store.register(validDraft(), {});
    store.applyFeedback('auto_export_chat_log', 'negative');
    store.applyFeedback('auto_export_chat_log', 'negative');
    assert.equal(store.get('auto_export_chat_log').status, 'active');
    const third = store.applyFeedback('auto_export_chat_log', 'negative');
    assert.equal(third.disabled, true);
    assert.equal(store.get('auto_export_chat_log').status, 'disabled');
    assert.equal(store.getActive('auto_export_chat_log'), null);
});

test('applyFeedback：positive 重置连续负面计数', () => {
    const store = makeStore();
    store.register(validDraft(), {});
    store.applyFeedback('auto_export_chat_log', 'negative');
    store.applyFeedback('auto_export_chat_log', 'negative');
    store.applyFeedback('auto_export_chat_log', 'positive');
    assert.equal(store.get('auto_export_chat_log').consecutiveNegative, 0);
    const next = store.applyFeedback('auto_export_chat_log', 'negative');
    assert.equal(next.disabled, false);
});

test('applyFeedback：30 天内累计 5 次 negative → 待复议', () => {
    const store = makeStore();
    store.register(validDraft(), {});
    // 正负交替，避免触发「连续 3 次」的自动停用
    for (let i = 0; i < 5; i++) {
        store.applyFeedback('auto_export_chat_log', 'negative');
        store.applyFeedback('auto_export_chat_log', 'positive');
    }
    const tool = store.get('auto_export_chat_log');
    assert.equal(tool.emotionFeedback.negative, 5);
    assert.equal(tool.needsReview, true);
    assert.equal(tool.status, 'active');
});

test('describeSteps：把编排步骤翻成人话', () => {
    const store = makeStore();
    const result = store.register(validDraft(), {});
    const text = store.describeSteps(result.tool);
    assert.match(text, /1\. 调用 search_chat_history/);
    assert.match(text, /\$history/);
});

// —— 情感履历 P3：反馈回收窗口 ——

// 造一个隔离磁盘写入的 ledger，只验证窗口推进逻辑
function makeLedger() {
    const ledger = new EmotionLedger({});
    ledger.save = () => {};
    ledger.readLogs = () => [];
    ledger.appendLog = () => {};
    return ledger;
}

test('updateAutoToolFeedback：第一轮只锁基线，不改判', () => {
    const ledger = makeLedger();
    const calls = [];
    ledger.recordAutoToolFeedback = (name, kind) => calls.push([name, kind]);
    ledger.noteAutoToolCall('t1', { userId: 'u1' });
    ledger.updateAutoToolFeedback('u1', 0.5);
    assert.equal(calls.length, 0);
});

test('updateAutoToolFeedback：frustration 回落 ≥0.20 记 positive', () => {
    const ledger = makeLedger();
    const calls = [];
    ledger.recordAutoToolFeedback = (name, kind) => calls.push([name, kind]);
    ledger.noteAutoToolCall('t1', { userId: 'u1' });
    ledger.updateAutoToolFeedback('u1', 0.5);   // 锁基线
    ledger.updateAutoToolFeedback('u1', 0.2);   // Δ=-0.30
    assert.deepEqual(calls, [['t1', 'positive']]);
});

test('updateAutoToolFeedback：frustration 上升 ≥0.20 记 negative', () => {
    const ledger = makeLedger();
    const calls = [];
    ledger.recordAutoToolFeedback = (name, kind) => calls.push([name, kind]);
    ledger.noteAutoToolCall('t1', { userId: 'u1' });
    ledger.updateAutoToolFeedback('u1', 0.2);   // 锁基线
    ledger.updateAutoToolFeedback('u1', 0.55);  // Δ=+0.35
    assert.deepEqual(calls, [['t1', 'negative']]);
});

test('updateAutoToolFeedback：两轮内无明显变化记 neutral', () => {
    const ledger = makeLedger();
    const calls = [];
    ledger.recordAutoToolFeedback = (name, kind) => calls.push([name, kind]);
    ledger.noteAutoToolCall('t1', { userId: 'u1' });
    ledger.updateAutoToolFeedback('u1', 0.5);   // 锁基线
    ledger.updateAutoToolFeedback('u1', 0.45);  // 剩 1 轮
    assert.equal(calls.length, 0);
    ledger.updateAutoToolFeedback('u1', 0.5);   // 剩 0 轮 → neutral
    assert.deepEqual(calls, [['t1', 'neutral']]);
});

test('updateAutoToolFeedback：按用户隔离，不结算别人的观察', () => {
    const ledger = makeLedger();
    const calls = [];
    ledger.recordAutoToolFeedback = (name, kind) => calls.push([name, kind]);
    ledger.noteAutoToolCall('t1', { userId: 'u1' });
    ledger.updateAutoToolFeedback('u2', 0.9);
    assert.equal(calls.length, 0);
});

test('applyTrustFromFeedback：工具累计 3 次 positive 提升发起人 trust', () => {
    const store = makeStore();
    store.register(validDraft(), { userIds: ['u1'] });
    const ledger = makeLedger();
    ledger.setAutoToolStore(store);
    ledger.recordAutoToolFeedback('auto_export_chat_log', 'positive', 'u1');
    ledger.recordAutoToolFeedback('auto_export_chat_log', 'positive', 'u1');
    assert.equal(ledger.data.trust.u1, undefined);      // 未到 3 次不动
    ledger.recordAutoToolFeedback('auto_export_chat_log', 'positive', 'u1');
    assert.equal(ledger.data.trust.u1, 0.65);           // 0.5 + 0.15
});

test('recordAutoToolFeedback：连续 3 次 negative 触发自动停用', () => {
    const store = makeStore();
    store.register(validDraft(), { userIds: ['u1'] });
    const ledger = makeLedger();
    ledger.setAutoToolStore(store);
    ledger.recordAutoToolFeedback('auto_export_chat_log', 'negative', 'u1');
    ledger.recordAutoToolFeedback('auto_export_chat_log', 'negative', 'u1');
    ledger.recordAutoToolFeedback('auto_export_chat_log', 'negative', 'u1');
    assert.equal(store.get('auto_export_chat_log').status, 'disabled');
});
