'use strict';

// 开源方案准入通道：单通道评审页的路由（页面 public/intake.html）
//
// 只做三件事：转交 vetSource、列出隔离区记录、对单条记录重跑一次隔离复核。
// 一律 requireHost——拉取和查看原文都只允许在服务所在机器上做。

const fs = require('fs');
const path = require('path');
const { vetSource, callWorker } = require('../../intake/channel');

const QUARANTINE_ROOT = process.env.INTAKE_QUARANTINE_DIR
    || path.join(__dirname, '../../../data/intake/quarantine');

const RECORD_ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;

function recordDir(id) {
    if (!RECORD_ID_RE.test(String(id || ''))) return null;
    const dir = path.join(QUARANTINE_ROOT, id);
    return path.dirname(path.resolve(dir)) === path.resolve(QUARANTINE_ROOT) ? dir : null;
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return fallback;
    }
}

function listRecords(limit) {
    let names;
    try {
        names = fs.readdirSync(QUARANTINE_ROOT, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch (error) {
        return [];
    }
    return names
        .map((name) => {
            const dir = path.join(QUARANTINE_ROOT, name);
            const features = readJson(path.join(dir, 'features.json'), null);
            let stat = null;
            try { stat = fs.statSync(dir); } catch (error) { /* 目录被删了就算了 */ }
            let bytes = 0;
            try { bytes = fs.statSync(path.join(dir, 'source.txt')).size; } catch (error) { /* 没有原文 */ }
            return {
                id: name,
                createdAt: stat ? stat.mtime.toISOString() : null,
                level: features ? features.level : 'unknown',
                score: features ? features.score : null,
                bytes
            };
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
}

function registerIntakeRoutes(app, ctx) {
    const { requireHost, serverError } = ctx;

    // 单通道体检：一次只审一个来源
    app.post('/api/intake/vet', requireHost, async (req, res) => {
        const body = req.body || {};
        const kind = String(body.kind || 'text');
        let target;

        if (kind === 'text') {
            const content = typeof body.content === 'string' ? body.content : '';
            if (!content.trim()) {
                return res.json({ success: false, error: '粘贴内容为空' });
            }
            target = { content, meta: body.meta && typeof body.meta === 'object' ? body.meta : {} };
        } else if (kind === 'github' || kind === 'npm') {
            target = { kind, repo: body.repo, path: body.path, package: body.package };
            if (kind === 'github' && !String(body.repo || '').trim()) {
                return res.json({ success: false, error: '需要 owner/name' });
            }
            if (kind === 'npm' && !String(body.package || '').trim()) {
                return res.json({ success: false, error: '需要包名' });
            }
        } else {
            return res.json({ success: false, error: `不支持的来源类型：${kind}` });
        }

        try {
            const result = await vetSource(target);
            res.json({ success: true, ...result });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 隔离区列表：供人工挑一条单独评审
    app.get('/api/intake/records', requireHost, (req, res) => {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        try {
            res.json({ success: true, records: listRecords(limit) });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 取单条记录：features（特征）/ source（原文，需显式点名才给）
    app.get('/api/intake/records/:id', requireHost, (req, res) => {
        const dir = recordDir(req.params.id);
        if (!dir) {
            return res.json({ success: false, error: '记录 id 不合法' });
        }
        const file = req.query.file === 'source' ? 'source.txt' : 'features.json';
        try {
            if (!fs.existsSync(dir)) {
                return res.json({ success: false, error: '记录不存在' });
            }
            const text = fs.readFileSync(path.join(dir, file), 'utf8');
            res.json({ success: true, file, content: text });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 单独评审：对已隔离的一条记录重跑一次隔离复核（判定进程仍只看特征，不看原文）
    app.post('/api/intake/records/:id/review', requireHost, async (req, res) => {
        const dir = recordDir(req.params.id);
        if (!dir) {
            return res.json({ success: false, error: '记录 id 不合法' });
        }
        const features = readJson(path.join(dir, 'features.json'), null);
        if (!features) {
            return res.json({ success: false, error: '记录缺少特征文件' });
        }
        try {
            const judged = await callWorker({ action: 'judge', features }, { timeoutMs: 30000 });
            if (!judged.ok) {
                return res.json({ success: false, error: judged.error || '判定子进程失败' });
            }
            res.json({ success: true, review: judged.result.review });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerIntakeRoutes;
