'use strict';

// E1 验收：与 D 类安全改动配套的关键分支护栏。
// auth.js：sessionId 走 CSPRNG（D1）、默认口令外置（D3c）、登录失败不泄露账号是否存在、会话过期即失效。
// security.js：CSRF 校验、限流、登录/账号锁定这几条决定放不放行的分支。
// 注意：auth.js 构造函数会读写真实 data/ 目录，这里一律用 Object.create(prototype) 造裸实例 + stub 落盘，
// 绝不 new AuthModule()，避免测试污染真实用户/会话档。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const AuthModule = require('../src/core/auth');
const SecurityModule = require('../src/core/security');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 造一个不碰磁盘的裸 auth 实例（只借用原型方法）
function makeAuth(overrides = {}) {
    const auth = Object.create(AuthModule.prototype);
    auth.users = {};
    auth.loginSessions = {};
    auth.saveUsers = () => {};
    auth.saveSessions = () => {};
    Object.assign(auth, overrides);
    return auth;
}

test('generateSessionId：返回不重复的 UUID，且能通过 sessionId 格式校验（D1）', () => {
    const auth = makeAuth();
    const a = auth.generateSessionId();
    const b = auth.generateSessionId();

    assert.match(a, UUID_RE);
    assert.notEqual(a, b);

    // 配套断言：新 ID 形态仍满足 SecurityModule.validateSessionId 的正则，别把校验写死成旧格式
    const sec = new SecurityModule();
    assert.equal(sec.validateSessionId(a), true);
});

test('createDefaultAdmin：口令取自 DEFAULT_ADMIN_PASSWORD，未配置时回落默认值 123456（D3c）', () => {
    const original = process.env.DEFAULT_ADMIN_PASSWORD;
    try {
        process.env.DEFAULT_ADMIN_PASSWORD = 'env-only-pass';
        const withEnv = makeAuth();
        withEnv.createDefaultAdmin();
        assert.equal(bcrypt.compareSync('env-only-pass', withEnv.users['管理员'].password), true);
        assert.equal(withEnv.users['管理员'].role, 'admin');

        delete process.env.DEFAULT_ADMIN_PASSWORD;
        const noEnv = makeAuth();
        noEnv.createDefaultAdmin();
        assert.equal(bcrypt.compareSync('123456', noEnv.users['管理员'].password), true);
    } finally {
        if (original === undefined) delete process.env.DEFAULT_ADMIN_PASSWORD;
        else process.env.DEFAULT_ADMIN_PASSWORD = original;
    }
});

test('login：账号不存在与密码错误返回同一句提示，正确凭据才建会话', async () => {
    const auth = makeAuth({
        dummyHash: bcrypt.hashSync('timing-equalization-dummy', 10)
    });
    auth.users.u1 = {
        username: 'u1',
        password: bcrypt.hashSync('correct-horse', 10),
        role: 'normal'
    };

    const ghost = await auth.login('nobody', 'whatever');
    assert.equal(ghost.success, false);
    assert.equal(ghost.message, '账号或密码错误');

    const wrong = await auth.login('u1', 'wrong-pass');
    assert.equal(wrong.success, false);
    assert.equal(wrong.message, '账号或密码错误'); // 与「账号不存在」同句，防账号枚举

    const ok = await auth.login('u1', 'correct-horse');
    assert.equal(ok.success, true);
    assert.match(ok.sessionId, UUID_RE);
    assert.equal(ok.username, 'u1');
    assert.equal(auth.loginSessions[ok.sessionId].userId, 'u1'); // 会话确实落到 store
});

test('validateSession：有效会话回 {userId, role, username}，过期会话失效并清除', () => {
    const auth = makeAuth();
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    auth.loginSessions.valid = { userId: 'u1', role: 'normal', expiresAt: farFuture };
    assert.deepEqual(auth.validateSession('valid'), {
        userId: 'u1',
        role: 'normal',
        username: 'u1'
    });

    auth.loginSessions.expired = { userId: 'u1', role: 'normal', expiresAt: Date.now() - 1000 };
    assert.equal(auth.validateSession('expired'), null);
    assert.equal('expired' in auth.loginSessions, false); // 过期即被清掉
    assert.equal(auth.validateSession('does-not-exist'), null);
});

test('validateCSRFToken：缺档/错 token/过期均拒，正确 token 才放行', () => {
    const sec = new SecurityModule();
    const token = sec.generateCSRFToken('sess1');
    assert.equal(sec.validateCSRFToken('sess1', token), true);
    assert.equal(sec.validateCSRFToken('sess1', 'wrong-token'), false);
    assert.equal(sec.validateCSRFToken('unknown-sess', token), false);

    sec.csrfTokens.set('sess2', { token: 't', expiresAt: Date.now() - 1 });
    assert.equal(sec.validateCSRFToken('sess2', 't'), false); // 过期不放行
});

test('checkRateLimit：超过每分钟上限后拒绝', () => {
    const sec = new SecurityModule();
    sec.maxRequestsPerMinute = 3;
    const ip = '10.0.0.9';

    assert.equal(sec.checkRateLimit(ip), true);
    assert.equal(sec.checkRateLimit(ip), true);
    assert.equal(sec.checkRateLimit(ip), true);
    assert.equal(sec.checkRateLimit(ip), false); // 第 4 次超限
});

test('登录锁定：连续 5 次失败上锁，reset 即解锁，锁到期自动放行', () => {
    const sec = new SecurityModule();
    const ip = '10.0.0.1';

    for (let i = 0; i < 4; i++) {
        assert.equal(sec.recordLoginFailure(ip).locked, false);
    }
    assert.equal(sec.recordLoginFailure(ip).locked, true); // 第 5 次触发
    assert.equal(sec.checkLoginLock(ip).locked, true);

    sec.resetLoginFailures(ip);
    assert.equal(sec.checkLoginLock(ip).locked, false);

    // 锁已过期 → 视为未锁并顺手清记录
    sec.loginFailures.set(ip, { count: 5, lockedUntil: Date.now() - 1000 });
    assert.equal(sec.checkLoginLock(ip).locked, false);
    assert.equal(sec.loginFailures.has(ip), false);
});

test('账号锁定：换 IP 也躲不掉，累计 10 次失败上锁，reset 解锁', () => {
    const sec = new SecurityModule();
    const username = 'hacker';

    for (let i = 0; i < 9; i++) {
        assert.equal(sec.recordAccountFailure(username).locked, false);
    }
    assert.equal(sec.recordAccountFailure(username).locked, true); // 第 10 次触发
    assert.equal(sec.checkAccountLock(username).locked, true);

    sec.resetAccountFailures(username);
    assert.equal(sec.checkAccountLock(username).locked, false);
});

test('validateSessionId：接受 UUID（含连字符），拒绝过短/非法字符', () => {
    const sec = new SecurityModule();
    assert.equal(sec.validateSessionId(crypto.randomUUID()), true);
    assert.equal(sec.validateSessionId('short'), false);
    assert.equal(sec.validateSessionId('has spaces!!'), false);
    assert.equal(sec.validateSessionId(12345), false);
});

test('cleanExpiredTokens：挂在 checkRateLimit 上按节流周期清理三张 Map（D2）', () => {
    const sec = new SecurityModule();
    const now = Date.now();

    // 造各表过期项
    sec.csrfTokens.set('expired', { token: 't', expiresAt: now - 1000 });
    sec.csrfTokens.set('alive', { token: 't', expiresAt: now + 60 * 60 * 1000 });
    sec.rateLimitStore.set('old-ip', { count: 9, minute: Math.floor(now / 60000) - 10 });
    sec.accountFailures.set('locked-user', { count: 10, lockedUntil: now - 1000 });

    // 到点（距上次清理已超周期）→ 触发清理
    sec.lastCleanupAt = now - sec.cleanupIntervalMs - 1;
    sec.checkRateLimit('fresh-ip');

    assert.equal(sec.csrfTokens.has('expired'), false); // 过期被清
    assert.equal(sec.csrfTokens.has('alive'), true);    // 未过期保留
    assert.equal(sec.rateLimitStore.has('old-ip'), false);
    assert.equal(sec.accountFailures.has('locked-user'), false);
});

test('cleanExpiredTokens：同一周期内不重复清理（节流生效）', () => {
    const sec = new SecurityModule();

    // 第一次调用触发清理并记下时刻
    sec.lastCleanupAt = 0;
    sec.checkRateLimit('1.1.1.1');

    // 周期内又塞过期项，紧接的调用不应清理
    sec.csrfTokens.set('expired', { token: 't', expiresAt: Date.now() - 1 });
    sec.checkRateLimit('1.1.1.1');
    assert.equal(sec.csrfTokens.has('expired'), true);
});
