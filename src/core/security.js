const crypto = require('crypto');

class SecurityModule {
    constructor() {
        this.csrfTokens = new Map();
        this.rateLimitStore = new Map();
        this.maxRequestsPerMinute = 100;
        // 登录失败锁定：同一个来源连续输错 5 次锁 15 分钟。
        // checkRateLimit 那个 100 次/分钟太宽松，挡不住对着登录接口慢慢试密码的
        this.loginFailures = new Map();
        this.maxLoginFailures = 5;
        this.loginLockMs = 15 * 60 * 1000;
        // 账号维度兜底：只按 IP 记的话，内网里换台设备/重连换个 IP 就能再试 5 次。
        // 同一账号累计错 10 次（不分来源）也锁 15 分钟；输对密码的本人不受影响，登录成功即清账
        this.accountFailures = new Map();
        this.maxAccountFailures = 10;
        this.accountLockMs = 15 * 60 * 1000;
        // 过期项清理节流：挂在每请求都走的 checkRateLimit 上，最多每 5 分钟扫一次，
        // 免得 csrfTokens / rateLimitStore / accountFailures 三张 Map 只增不减。
        this.lastCleanupAt = 0;
        this.cleanupIntervalMs = 5 * 60 * 1000;
    }

    sanitizeInput(input) {
        if (typeof input === 'string') {
            return input.replace(/[<>]/g, (match) => {
                return match === '<' ? '&lt;' : '&gt;';
            });
        }
        return input;
    }

    sanitizeForHTML(text) {
        if (!text || typeof text !== 'string') return '';
        
        const entities = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
            '/': '&#x2F;',
            '`': '&#x60;',
            '=': '&#x3D;'
        };
        
        return text.replace(/[&<>"'`=\/]/g, (char) => entities[char] || char);
    }

    generateCSRFToken(sessionId) {
        const token = crypto.randomBytes(32).toString('hex');
        this.csrfTokens.set(sessionId, { token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        return token;
    }

    validateCSRFToken(sessionId, token) {
        const stored = this.csrfTokens.get(sessionId);
        if (!stored) return false;
        
        if (stored.expiresAt < Date.now()) {
            this.csrfTokens.delete(sessionId);
            return false;
        }
        
        return stored.token === token;
    }

    invalidateCSRFToken(sessionId) {
        this.csrfTokens.delete(sessionId);
    }

    checkRateLimit(ip) {
        const now = Date.now();

        // 顺手清理过期项（节流：最多每 cleanupIntervalMs 一次）
        if (now - this.lastCleanupAt >= this.cleanupIntervalMs) {
            this.lastCleanupAt = now;
            this.cleanExpiredTokens();
        }

        const minute = Math.floor(now / 60000);
        
        if (!this.rateLimitStore.has(ip)) {
            this.rateLimitStore.set(ip, { count: 1, minute });
            return true;
        }
        
        const entry = this.rateLimitStore.get(ip);
        if (entry.minute !== minute) {
            entry.count = 1;
            entry.minute = minute;
            return true;
        }
        
        if (entry.count >= this.maxRequestsPerMinute) {
            return false;
        }
        
        entry.count++;
        return true;
    }

    // 登录前先问一句：这个来源还在不在锁定期
    checkLoginLock(ip) {
        const entry = this.loginFailures.get(ip);
        if (!entry || !entry.lockedUntil) {
            return { locked: false, remaining: this.maxLoginFailures };
        }

        // 锁到期就放人，顺手把记录清掉，别让它一直攒着
        if (entry.lockedUntil <= Date.now()) {
            this.loginFailures.delete(ip);
            return { locked: false, remaining: this.maxLoginFailures };
        }

        return {
            locked: true,
            retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
            remaining: 0
        };
    }

    // 登录失败记账，够了就上锁
    recordLoginFailure(ip) {
        const now = Date.now();
        const entry = this.loginFailures.get(ip) || { count: 0, lockedUntil: 0 };
        entry.count++;

        if (entry.count >= this.maxLoginFailures) {
            entry.lockedUntil = now + this.loginLockMs;
            this.loginFailures.set(ip, entry);
            return { locked: true, retryAfterSec: Math.ceil(this.loginLockMs / 1000), remaining: 0 };
        }

        this.loginFailures.set(ip, entry);
        return { locked: false, remaining: this.maxLoginFailures - entry.count };
    }

    // 登录成功要把欠的账一笔勾销，否则白天手滑几次会攒着算
    resetLoginFailures(ip) {
        this.loginFailures.delete(ip);
    }

    // 账号在不在锁定期（换 IP 也躲不掉的那道）
    checkAccountLock(username) {
        const entry = this.accountFailures.get(username);
        if (!entry || !entry.lockedUntil) {
            return { locked: false, remaining: this.maxAccountFailures };
        }

        if (entry.lockedUntil <= Date.now()) {
            this.accountFailures.delete(username);
            return { locked: false, remaining: this.maxAccountFailures };
        }

        return {
            locked: true,
            retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
            remaining: 0
        };
    }

    // 账号维度记账。只对真实存在的账号调用，别让瞎编的用户名把表撑爆
    recordAccountFailure(username) {
        const now = Date.now();
        const entry = this.accountFailures.get(username) || { count: 0, lockedUntil: 0 };
        entry.count++;

        if (entry.count >= this.maxAccountFailures) {
            entry.lockedUntil = now + this.accountLockMs;
            this.accountFailures.set(username, entry);
            return { locked: true, retryAfterSec: Math.ceil(this.accountLockMs / 1000), remaining: 0 };
        }

        this.accountFailures.set(username, entry);
        return { locked: false, remaining: this.maxAccountFailures - entry.count };
    }

    resetAccountFailures(username) {
        this.accountFailures.delete(username);
    }

    cleanExpiredTokens() {
        const now = Date.now();
        this.csrfTokens.forEach((value, key) => {
            if (value.expiresAt < now) {
                this.csrfTokens.delete(key);
            }
        });
        
        this.rateLimitStore.forEach((value, key) => {
            if (Math.floor(now / 60000) - value.minute > 5) {
                this.rateLimitStore.delete(key);
            }
        });

        // 锁已到期又一直没人来碰的账号记录，顺手清掉
        this.accountFailures.forEach((value, key) => {
            if (value.lockedUntil && value.lockedUntil <= now) {
                this.accountFailures.delete(key);
            }
        });
    }

    getSecurityHeaders() {
        // CSP 白名单说明（不是随手写的，逐条对应现有页面）：
        //   'unsafe-inline'  —— 全站页面都是内联 <style>/<script>，去掉会让所有页面失去样式与交互
        //   'wasm-unsafe-eval' —— live-vision.html 的 MediaPipe 检测器要在本地实例化 WASM
        //   cdn.jsdelivr.net —— live2d.html 的 pixi / pixi-live2d-display、continue.html 的 font-awesome
        //   cubism.live2d.com —— live2d.html 的 Cubism Core SDK
        //   cdn.tailwindcss.com —— continue.html 的 Tailwind Play CDN
        //   media-src blob:  —— TTS 音频有走 object URL 的路径
        //   connect-src ws:  —— 前端用 location.host 建 WebSocket，页面从 localhost/127.0.0.1 打开都要能连
        // base-uri / form-action 才是真正防「登录页被改写提交目标」的两条，缺了它们 CSP 意义不大
        return {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
            'Content-Security-Policy': [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://cubism.live2d.com https://cdn.tailwindcss.com",
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
                "img-src 'self' data: blob: https://cdn.jsdelivr.net https://cubism.live2d.com",
                "font-src 'self' data: https://cdn.jsdelivr.net",
                "media-src 'self' blob: data:",
                "connect-src 'self' ws: wss: http://localhost:* https://localhost:* https://cdn.jsdelivr.net",
                "worker-src 'self' blob:",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
                "frame-ancestors 'none'"
            ].join('; '),
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'geolocation=(), microphone=(), camera=(self)'
        };
    }

    validateUsername(username) {
        if (!username || typeof username !== 'string') return false;
        return /^[a-zA-Z0-9\u4e00-\u9fa5_-]{3,32}$/.test(username);
    }

    validatePassword(password) {
        if (!password || typeof password !== 'string') return false;
        return password.length >= 6;
    }

    validateSessionId(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') return false;
        return /^[\w-]{10,50}$/.test(sessionId);
    }
}

module.exports = SecurityModule;