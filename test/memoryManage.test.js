'use strict';

// 记忆管理 + 同意闸门：纯逻辑方法 + 路由层的确认语义。
// 原则：不做删除，只做可逆的归档/还原；归档必须显式 confirm。

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');
const registerMemoryRoutes = require('../src/server/routes/memory');

function makeMemory() {
    const memories = [
        { id: 'a', data: '她说过喜欢雨天', tier: 'episodic', timestamp: 100, pinned: false, salience: 0.5 },
        { id: 'b', data: '她在准备面试', tier: 'semantic', timestamp: 200, pinned: true },
        { id: 'c', data: '很久以前的事', tier: 'archived', timestamp: 50 }
    ];
    const mem = Object.create(MemoryModule.prototype);
    mem.getUserMemoryStore = () => ({ memories });
    mem.saveUserMemories = () => true;
    mem.normalizeScopeKey = userId => `${userId}__role`;
    return { mem, memories };
}

test('listMemoryViews：时间倒序，只暴露视图字段', () => {
    const { mem } = makeMemory();
    const items = mem.listMemoryViews('u1');
    assert.deepEqual(items.map(item => item.id), ['b', 'a', 'c']);
    assert.deepEqual(Object.keys(items[0]).sort(),
        ['id', 'pinned', 'salience', 'text', 'tier', 'timestamp']);
});

test('listMemoryViews：按层级与关键词过滤，limit 生效', () => {
    const { mem } = makeMemory();
    assert.deepEqual(mem.listMemoryViews('u1', { tier: 'semantic' }).map(i => i.id), ['b']);
    assert.deepEqual(mem.listMemoryViews('u1', { query: '雨天' }).map(i => i.id), ['a']);
    assert.equal(mem.listMemoryViews('u1', { limit: 1 }).length, 1);
});

test('archiveMemoryRecord：降级为 archived 并标记时间，原文不动', () => {
    const { mem, memories } = makeMemory();
    const result = mem.archiveMemoryRecord('u1', 'a');
    assert.equal(result.ok, true);
    assert.equal(result.previousTier, 'episodic');
    assert.equal(memories[0].tier, 'archived');
    assert.equal(memories[0].data, '她说过喜欢雨天');
    assert.ok(memories[0].archivedAt > 0);
});

test('archiveMemoryRecord：不存在返回 not_found，不误伤其他条目', () => {
    const { mem, memories } = makeMemory();
    assert.deepEqual(mem.archiveMemoryRecord('u1', 'missing'), { ok: false, reason: 'not_found' });
    assert.equal(memories[0].tier, 'episodic');
});

test('archiveMemoryRecord：落盘失败回滚层级与归档时间', () => {
    const { mem, memories } = makeMemory();
    mem.saveUserMemories = () => false;
    const result = mem.archiveMemoryRecord('u1', 'a');
    assert.deepEqual(result, { ok: false, reason: 'save_failed' });
    assert.equal(memories[0].tier, 'episodic');
    assert.equal(memories[0].archivedAt, undefined);
});

test('restoreMemoryRecord：归档条回到指定层级，非归档条不动', () => {
    const { mem, memories } = makeMemory();
    mem.archiveMemoryRecord('u1', 'a');
    assert.equal(mem.restoreMemoryRecord('u1', 'a', 'semantic').tier, 'semantic');
    assert.equal(memories[0].tier, 'semantic');

    assert.deepEqual(mem.restoreMemoryRecord('u1', 'b', 'semantic'), { ok: true, tier: 'semantic' });
    assert.equal(memories[1].tier, 'semantic');
});

test('restoreMemoryRecord：非法层级回落 episodic', () => {
    const { mem, memories } = makeMemory();
    mem.archiveMemoryRecord('u1', 'a');
    assert.equal(mem.restoreMemoryRecord('u1', 'a', 'bogus').tier, 'episodic');
    assert.equal(memories[0].tier, 'episodic');
});

// ---- 路由层：未确认不动，确认后才归档 ----

function makeApp(mem) {
    const routes = [];
    const app = {
        get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }),
        post: (path, ...handlers) => routes.push({ method: 'post', path, handlers })
    };
    registerMemoryRoutes(app, {
        requireLogin: (req, res, next) => (typeof next === 'function' ? next() : undefined),
        serverError: (res, error) => res.status(500).json({ success: false, error: error.message }),
        memoryModule: mem
    });
    const find = path => routes.find(route => route.path === path);
    return { routes, find };
}

function callHandler(route, req) {
    const handler = route.handlers[route.handlers.length - 1];
    const out = { statusCode: 200, body: null };
    const res = {
        status(code) { out.statusCode = code; return res; },
        json(payload) { out.body = payload; return res; }
    };
    handler(req, res);
    return out;
}

test('路由：归档未带 confirm=true 返回 409，记忆保持原样', () => {
    const { mem, memories } = makeMemory();
    const { find } = makeApp(mem);
    const route = find('/api/memory/:id/archive');
    assert.ok(route, '应注册归档路由');

    const out = callHandler(route, { user: { userId: 'u1' }, params: { id: 'a' }, body: {} });
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.needsConfirm, true);
    assert.equal(memories[0].tier, 'episodic');
});

test('路由：confirm=true 才归档，scope 由登录会话解析', () => {
    const { mem, memories } = makeMemory();
    const { find } = makeApp(mem);
    const route = find('/api/memory/:id/archive');

    const out = callHandler(route, { user: { userId: 'u1' }, params: { id: 'a' }, body: { confirm: true } });
    assert.equal(out.body.success, true);
    assert.equal(memories[0].tier, 'archived');
});

test('路由：列表只走登录会话的 role 作用域', () => {
    const { mem } = makeMemory();
    let seen = null;
    const original = mem.listMemoryViews;
    mem.listMemoryViews = (scope, opts) => {
        seen = { scope, opts };
        return original.call(mem, scope, opts);
    };
    const { find } = makeApp(mem);
    const out = callHandler(find('/api/memory/list'), { user: { userId: 'u9' }, query: { limit: '5' } });
    assert.equal(out.body.success, true);
    assert.equal(seen.scope, 'u9__role');
    assert.equal(seen.opts.limit, '5');
});
