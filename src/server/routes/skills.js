'use strict';

const path = require('path');
const SkillStore = require('../../core/skillStore');

// 本地技能市场：技能包的新建 / 查看 / 删除 / 导出 / 导入。
// 由 server/index.js 通过 registerSkillsRoutes(app, ctx) 装配；
// 门禁与错误出口从 ctx 取（requireCodingUser / serverError），避免反向 require index.js。

// 内置示例（市场空库时也能给前端一排可安装的卡片）。
// description / body 优先读 skills/ 里的真实技能，读不到就用这里的占位。
const CATALOG = [
    {
        name: 'brainstorming',
        description: '发散式点子生成的方法论骨架。当需要「想出更多可能」「有没有别的解法」时加载。',
        body: '# 头脑风暴\n\n先发散再收敛：先列可能，再按成本/收益筛。',
        tags: ['ideas', 'divergence']
    },
    {
        name: 'code-review',
        description: '对一段代码或一次改动做系统性评审，产出按严重度分级的问题清单。',
        body: '# 代码评审\n\n按正确性、安全、可维护性、资源、一致性逐项给结论。',
        tags: ['review', 'quality']
    },
    {
        name: 'debugging',
        description: '定位并修复 bug：用科学方法收敛，而不是猜。',
        body: '# 调试\n\n先稳定复现，再缩小范围，最后验证修复。',
        tags: ['bug', 'diagnosis']
    },
    {
        name: 'refactor',
        description: '在不改变外部行为的前提下重构代码，产出小步、可回退的方案。',
        body: '# 重构\n\n先补测试锁行为，再小步改造，每一步可回退。',
        tags: ['refactor', 'maintainability']
    },
    {
        name: 'security-audit',
        description: '对代码做安全审查，聚焦可利用的风险。',
        body: '# 安全审查\n\n只报能证实、由本次改动引入的风险，给出最小修复。',
        tags: ['security', 'audit']
    },
    {
        name: 'test-writing',
        description: '为代码编写有效的自动化测试，覆盖边界与错误路径。',
        body: '# 写测试\n\n覆盖正常路径、边界条件与错误路径，避免只测 happy path。',
        tags: ['test', 'quality']
    }
];

// core 抛出的 Error.code → HTTP 状态码；未登记的一律交给 serverError（500）
const STATUS_BY_CODE = {
    INVALID_NAME: 400,
    INVALID_ZIP: 400,
    UNSAFE_ENTRY: 400,
    NO_SKILL_FILE: 400,
    FORBIDDEN: 400,
    EXISTS: 409,
    NOT_FOUND: 404,
    TOO_MANY_ENTRIES: 413,
    TOO_LARGE: 413
};

function invalidBase64() {
    const error = new Error('zipBase64 不是有效的 base64');
    error.code = 'INVALID_ZIP';
    return error;
}

function decodeBase64(input) {
    const text = String(input == null ? '' : input).replace(/^data:[^,]*,/, '').trim();
    if (!text || !/^[A-Za-z0-9+/=\r\n]+$/.test(text)) throw invalidBase64();
    const buffer = Buffer.from(text, 'base64');
    if (!buffer.length) throw invalidBase64();
    return buffer;
}

function registerSkillsRoutes(app, ctx = {}) {
    const { requireCodingUser, serverError } = ctx;
    const store = ctx.skillStore || new SkillStore(path.join(__dirname, '..', '..', '..'));

    const sendError = (res, error) => {
        const status = STATUS_BY_CODE[error && error.code];
        if (!status) return serverError(res, error);
        return res.status(status).json({ success: false, message: error.message });
    };

    // 市场目录：内置示例 + 是否已装（按当前技能库判断）
    app.get('/api/skills/catalog', requireCodingUser, (req, res) => {
        try {
            const installed = new Map(store.scan().map(skill => [skill.name.toLowerCase(), skill]));
            const catalog = CATALOG.map((item) => {
                const found = installed.get(item.name);
                let description = item.description;
                let body = item.body;
                if (found) {
                    description = found.description || description;
                    const loaded = store.load(found.name);
                    if (loaded.success && loaded.instructions) body = loaded.instructions;
                }
                return {
                    name: item.name,
                    description,
                    body,
                    tags: item.tags,
                    installed: Boolean(found)
                };
            });
            res.json({ success: true, catalog });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/skills/:name/export', requireCodingUser, (req, res) => {
        try {
            const buffer = store.exportZip(req.params.name);
            const fileName = String(req.params.name).replace(/[^a-zA-Z0-9._-]/g, '') || 'skill';
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}.skill.zip"`);
            res.send(buffer);
        } catch (error) {
            sendError(res, error);
        }
    });

    app.get('/api/skills', requireCodingUser, (req, res) => {
        try {
            res.json({ success: true, skills: store.list() });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/skills/:name', requireCodingUser, (req, res) => {
        try {
            const skill = store.detail(req.params.name);
            if (!skill) return res.status(404).json({ success: false, message: '技能不存在' });
            res.json({ success: true, skill });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/skills/import', requireCodingUser, (req, res) => {
        try {
            const body = req.body || {};
            const buffer = decodeBase64(body.zipBase64);
            const result = store.importZip(buffer, { overwrite: body.overwrite === true });
            res.json({ success: true, name: result.name, files: result.files });
        } catch (error) {
            sendError(res, error);
        }
    });

    app.post('/api/skills', requireCodingUser, (req, res) => {
        try {
            const body = req.body || {};
            const skill = store.save(
                { name: body.name, description: body.description, body: body.body },
                { overwrite: body.overwrite === true }
            );
            res.json({ success: true, skill });
        } catch (error) {
            sendError(res, error);
        }
    });

    app.delete('/api/skills/:name', requireCodingUser, (req, res) => {
        try {
            const removed = store.remove(req.params.name);
            if (!removed) return res.status(404).json({ success: false, message: '技能不存在' });
            res.json({ success: true });
        } catch (error) {
            sendError(res, error);
        }
    });
}

module.exports = registerSkillsRoutes;
module.exports.registerSkillsRoutes = registerSkillsRoutes;
