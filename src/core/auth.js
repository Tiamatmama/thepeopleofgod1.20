const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

class AuthModule {
    constructor() {
        this.storagePath = path.join(__dirname, '../../data');
        this.usersFile = path.join(this.storagePath, 'users.json');
        this.sessionsFile = path.join(this.storagePath, 'login_sessions.json');
        
        this.ensureStorageDir();
        this.loadUsers();
        this.loadSessions();

        // 登录时账号不存在也要照跑一次 bcrypt（见 login）：预生成一个同强度的哈希。
        // 否则「账号不存在」明显更快返回，爆破的人据此就能先把账号枚举出来
        this.dummyHash = bcrypt.hashSync('timing-equalization-dummy', 10);

        // 登录失败限速：同一账号 5 分钟内错 5 次就锁 5 分钟。
        // 只存在内存里，重启即清空；目的是挡住在线爆破，不追求持久化
        this.loginFailures = new Map();
        this.maxLoginFailures = 5;
        this.loginLockMs = 5 * 60 * 1000;

        if (!this.users.admin) {
            this.createDefaultAdmin();
        }
    }
    
    ensureStorageDir() {
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
        }
    }
    
    loadUsers() {
        try {
            if (fs.existsSync(this.usersFile)) {
                const data = fs.readFileSync(this.usersFile, 'utf8');
                this.users = JSON.parse(data);
            } else {
                this.users = {};
            }
        } catch (error) {
            console.error('[Auth] 加载用户数据失败:', error);
            this.users = {};
        }
    }
    
    loadSessions() {
        try {
            if (fs.existsSync(this.sessionsFile)) {
                const data = fs.readFileSync(this.sessionsFile, 'utf8');
                this.loginSessions = JSON.parse(data);
            } else {
                this.loginSessions = {};
            }
        } catch (error) {
            console.error('[Auth] 加载会话数据失败:', error);
            this.loginSessions = {};
        }
    }
    
    saveUsers() {
        try {
            writeJsonAtomicSync(this.usersFile, this.users);
        } catch (error) {
            console.error('[Auth] 保存用户数据失败:', error);
        }
    }
    
    saveSessions() {
        try {
            writeJsonAtomicSync(this.sessionsFile, this.loginSessions);
        } catch (error) {
            console.error('[Auth] 保存会话数据失败:', error);
        }
    }
    
    createDefaultAdmin() {
        // 默认口令外置到 .env（DEFAULT_ADMIN_PASSWORD）；未配置时回落到 123456，保证本机首启仍能登录
        const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || '123456';
        const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
        this.users['管理员'] = {
            username: '管理员',
            password: hashedPassword,
            role: 'admin',
            createdAt: new Date().toISOString(),
            registerSource: 'admin_create',
            botCount: 0,
            hasAdminInvitation: false,
            botIds: []
        };
        
        this.saveUsers();
        console.log('[Auth] 默认管理员账号已创建');
    }
    
    async register(username, password, role = 'normal') {
        if (this.users[username]) {
            return { success: false, message: '账号已存在' };
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        this.users[username] = {
            username: username,
            password: hashedPassword,
            role: role,
            createdAt: new Date().toISOString(),
            registerSource: 'web',
            botCount: 0,
            hasAdminInvitation: false,
            botIds: [],
            customApiConfig: null
        };
        this.saveUsers();
        
        return { success: true, message: '注册成功' };
    }

    // 账号是否存在。只给服务端内部用（账号维度失败记账要跳过瞎编的用户名），别把这个结果直接回给前端
    userExists(username) {
        return !!this.users[username];
    }

    async login(username, password) {
        // 锁定期间直接拒绝，连 bcrypt 都不跑，避免被当成免费算力
        if (!this.loginFailures) this.loginFailures = new Map();
        const failure = this.loginFailures.get(username);
        if (failure && failure.lockedUntil > Date.now()) {
            const left = Math.ceil((failure.lockedUntil - Date.now()) / 60000);
            return { success: false, message: `尝试次数过多，请 ${left} 分钟后再试` };
        }

        const user = this.users[username];
        if (!user) {
            // 账号不存在也照跑一次 bcrypt，抹平响应时间；提示语也不区分，
            // 否则爆破的人可以先枚举出有哪些账号，再集中打那几个
            await bcrypt.compare(password, this.dummyHash);
            this.recordLoginFailure(username);
            return { success: false, message: '账号或密码错误' };
        }
        
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            this.recordLoginFailure(username);
            return { success: false, message: '账号或密码错误' };
        }

        this.loginFailures.delete(username);

        const sessionId = this.generateSessionId();
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        
        this.loginSessions[sessionId] = {
            userId: username,
            role: user.role,
            expiresAt: expiresAt,
            loginTime: new Date().toISOString()
        };
        this.saveSessions();
        
        return {
            success: true,
            message: '登录成功',
            sessionId: sessionId,
            role: user.role,
            username: username
        };
    }
    
    // 记一次失败：窗口内累计到阈值就锁；顺手清理过期记录，防止乱编用户名把 Map 撑大
    recordLoginFailure(username) {
        const now = Date.now();
        if (!this.loginFailures) this.loginFailures = new Map();
        let record = this.loginFailures.get(username);
        if (!record || record.resetAt <= now) {
            record = { count: 0, resetAt: now + this.loginLockMs, lockedUntil: 0 };
        }
        record.count += 1;
        if (record.count >= this.maxLoginFailures) {
            record.lockedUntil = now + this.loginLockMs;
        }
        this.loginFailures.set(username, record);

        if (this.loginFailures.size > 500) {
            for (const [key, value] of this.loginFailures) {
                if (value.resetAt <= now && value.lockedUntil <= now) {
                    this.loginFailures.delete(key);
                }
            }
        }
    }

    logout(sessionId) {
        if (this.loginSessions[sessionId]) {
            delete this.loginSessions[sessionId];
            this.saveSessions();
            return { success: true, message: '登出成功' };
        }
        return { success: false, message: '会话不存在' };
    }
    
    validateSession(sessionId) {
        const session = this.loginSessions[sessionId];
        if (!session) {
            return null;
        }
        
        if (session.expiresAt < Date.now()) {
            delete this.loginSessions[sessionId];
            this.saveSessions();
            return null;
        }

        // 续期节流：剩余有效期还够 1 小时就不重写文件 💾 以前每次请求都续+落盘，
        // 前端轮询 /api/status 时这个文件几秒被写一次，外部工具（NewMax 面板）也一直报变动
        const now = Date.now();
        if (session.expiresAt - now < 60 * 60 * 1000) {
            session.expiresAt = now + 24 * 60 * 60 * 1000;
            this.saveSessions();
        }

        return {
            userId: session.userId,
            role: session.role,
            username: session.userId
        };
    }
    
    generateSessionId() {
        // 用 CSPRNG 生成会话 ID：旧实现的 Math.random() 可预测，攻击者能猜到他人 session
        return crypto.randomUUID();
    }
    
    getUser(username) {
        return this.users[username] ? {
            username: username,
            role: this.users[username].role,
            createdAt: this.users[username].createdAt,
            registerSource: this.users[username].registerSource
        } : null;
    }
    
    changePassword(username, oldPassword, newPassword) {
        const user = this.users[username];
        if (!user) {
            return { success: false, message: '账号不存在' };
        }
        
        return bcrypt.compare(oldPassword, user.password).then(isValid => {
            if (!isValid) {
                return { success: false, message: '旧密码错误' };
            }
            
            return bcrypt.hash(newPassword, 10).then(hashedPassword => {
                user.password = hashedPassword;
                this.saveUsers();
                return { success: true, message: '密码修改成功' };
            });
        });
    }
    
    // 忘记密码时的兜底：不做旧密码校验，安全性完全靠调用方（仅限本机）把关
    async resetPassword(username, newPassword) {
        const user = this.users[username];
        if (!user) {
            return { success: false, message: '账号不存在' };
        }
        if (!newPassword || !String(newPassword).trim()) {
            return { success: false, message: '新密码不能为空' };
        }
        user.password = await bcrypt.hash(newPassword, 10);
        this.saveUsers();
        return { success: true, message: '密码已重置' };
    }

    deleteUser(username) {
        if (username === '管理员') {
            return { success: false, message: '不能删除管理员账号' };
        }
        
        if (this.users[username]) {
            delete this.users[username];
            this.saveUsers();
            return { success: true, message: '删除成功' };
        }
        return { success: false, message: '账号不存在' };
    }
    
    incrementBotCount(username, botId) {
        if (!this.users[username]) {
            return { success: false, message: '用户不存在' };
        }
        
        const user = this.users[username];
        user.botCount = (user.botCount || 0) + 1;
        
        if (!user.botIds) {
            user.botIds = [];
        }
        if (botId && !user.botIds.includes(botId)) {
            user.botIds.push(botId);
        }
        
        const BOT_COUNT_THRESHOLD = 10;
        if (user.botCount >= BOT_COUNT_THRESHOLD && !user.hasAdminInvitation && user.role !== 'admin') {
            user.hasAdminInvitation = true;
            console.log(`[Auth] 用户 ${username} 创建了 ${user.botCount} 个bot，已获得管理员资格邀请`);
        }
        
        this.saveUsers();
        
        return {
            success: true,
            botCount: user.botCount,
            botIds: user.botIds,
            hasAdminInvitation: user.hasAdminInvitation
        };
    }
    
    getBotCount(username) {
        if (!this.users[username]) {
            return 0;
        }
        return this.users[username].botCount || 0;
    }
    
    getUserBotIds(username) {
        if (!this.users[username]) {
            return [];
        }
        return this.users[username].botIds || [];
    }
    
    isOwner(username, botId) {
        if (!this.users[username]) {
            return false;
        }
        return (this.users[username].botIds || []).includes(botId);
    }
    
    removeBotFromUser(username, botId) {
        if (!this.users[username]) {
            return false;
        }
        const user = this.users[username];
        if (user.botIds) {
            const index = user.botIds.indexOf(botId);
            if (index > -1) {
                user.botIds.splice(index, 1);
                user.botCount = Math.max(0, (user.botCount || 1) - 1);
                this.saveUsers();
                return true;
            }
        }
        return false;
    }
    
    setCustomApiConfig(username, config) {
        if (!this.users[username]) {
            return { success: false, message: '用户不存在' };
        }
        
        const validation = this.validateApiConfig(config);
        if (!validation.valid) {
            return validation;
        }
        
        const user = this.users[username];
        const existingKey = user.customApiConfig && user.customApiConfig.apiKey;
        // 前端回填的是打码后的密钥，用户留空即表示沿用已保存的真实密钥
        const incomingKey = (typeof config.apiKey === 'string' && config.apiKey.trim() !== '')
            ? config.apiKey.trim()
            : '';
        user.customApiConfig = {
            // 只保留 OpenAI 兼容协议，老配置里残留的 anthropic/custom 一并归一到 openai
            apiType: 'openai',
            apiUrl: config.apiUrl,
            apiKey: incomingKey || existingKey || '',
            model: config.model,
            maxTokens: config.maxTokens || 2048,
            temperature: config.temperature || 0.7,
            enabled: config.enabled || false,
            createdAt: new Date().toISOString()
        };
        
        this.saveUsers();
        return { success: true, message: 'API配置保存成功' };
    }
    
    // 供界面展示使用：返回打码后的副本，绝不改动已存储的真实密钥
    getCustomApiConfig(username) {
        if (!this.users[username]) {
            return null;
        }
        const config = this.users[username].customApiConfig;
        if (!config) {
            return null;
        }
        const masked = { ...config };
        if (masked.apiKey) {
            masked.apiKey = this.maskApiKey(masked.apiKey);
        }
        return masked;
    }
    
    // 供服务端实际调用使用：返回含真实密钥的副本
    getCustomApiConfigRaw(username) {
        if (!this.users[username]) {
            return null;
        }
        const config = this.users[username].customApiConfig;
        return config ? { ...config } : null;
    }
    
    validateApiConfig(config) {
        if (!config || !config.apiUrl) {
            return { valid: false, message: 'API地址不能为空' };
        }
        
        try {
            new URL(config.apiUrl);
        } catch (e) {
            return { valid: false, message: '无效的API地址格式' };
        }
        
        // 类型只支持 OpenAI 兼容，保存时统一归一，这里不再校验 apiType
        if (config.apiUrl.includes('localhost') || config.apiUrl.includes('127.0.0.1')) {
            return { valid: false, message: '不允许使用本地地址' };
        }
        
        if (config.apiUrl.startsWith('file://')) {
            return { valid: false, message: '不允许访问本地文件' };
        }
        
        return { valid: true, message: '配置验证通过' };
    }
    
    maskApiKey(apiKey) {
        if (!apiKey) return '';
        if (apiKey.length <= 8) return '******';
        return apiKey.substring(0, 4) + '******' + apiKey.substring(apiKey.length - 4);
    }
    
    removeCustomApiConfig(username) {
        if (!this.users[username]) {
            return { success: false, message: '用户不存在' };
        }
        this.users[username].customApiConfig = null;
        this.saveUsers();
        return { success: true, message: 'API配置已删除' };
    }
    
    acceptAdminInvitation(username, sessionId) {
        const session = this.validateSession(sessionId);
        if (!session || session.username !== username) {
            return { success: false, message: '会话无效' };
        }
        
        const user = this.users[username];
        if (!user) {
            return { success: false, message: '用户不存在' };
        }
        
        if (!user.hasAdminInvitation) {
            return { success: false, message: '没有管理员邀请' };
        }
        
        if (user.role === 'admin') {
            return { success: false, message: '已经是管理员' };
        }
        
        user.role = 'admin';
        user.hasAdminInvitation = false;
        this.saveUsers();
        
        if (this.loginSessions[sessionId]) {
            this.loginSessions[sessionId].role = 'admin';
            this.saveSessions();
        }
        
        console.log(`[Auth] 用户 ${username} 接受了管理员邀请`);
        return { success: true, message: '恭喜！您已成为管理员' };
    }
    
    checkAdminInvitation(username) {
        if (!this.users[username]) {
            return false;
        }
        return this.users[username].hasAdminInvitation || false;
    }
}

module.exports = AuthModule;
