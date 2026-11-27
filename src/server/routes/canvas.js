'use strict';

// 从 server/index.js 抽出：画板笔迹存档路由（母本一律是 JSON，落 data/canvas/<name>.json）。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。
// 注意：本文件在 server/routes/ 下，相对路径比原 index.js 深一层。

const path = require('path');
const fs = require('fs');

// 画板笔迹存档：母本一律是 JSON（strokes 里每点带 x/y/p 笔压/t 时间戳），落 data/canvas/<name>.json
const CANVAS_DIR = path.join(__dirname, '../../../data/canvas');

function canvasNameToFile(name) {
    const base = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/, '');
    if (!base) {
        return null;
    }
    const file = path.join(CANVAS_DIR, base.slice(0, 60) + '.json');
    // 兜底：解析后必须仍在 CANVAS_DIR 内，防路径穿越
    if (path.dirname(path.resolve(file)) !== path.resolve(CANVAS_DIR)) {
        return null;
    }
    return { name: base.slice(0, 60), file };
}

function registerCanvasRoutes(app, ctx) {
    const { requireHost, serverError } = ctx;

    app.post('/api/canvas/save', requireHost, (req, res) => {
        const { name, data } = req.body || {};
        const target = canvasNameToFile(name);

        if (!target) {
            return res.json({ success: false, error: '作品名不合法' });
        }
        if (!data || !Array.isArray(data.strokes) || !data.strokes.length) {
            return res.json({ success: false, error: '没有可保存的笔迹' });
        }

        try {
            fs.mkdirSync(CANVAS_DIR, { recursive: true });
            fs.writeFileSync(target.file, JSON.stringify({
                version: 1,
                updatedAt: new Date().toISOString(),
                size: data.size || null,
                strokes: data.strokes
            }, null, 2), 'utf8');
            res.json({ success: true, name: target.name, strokeCount: data.strokes.length });
        } catch (error) {
            console.error('[画板] 保存失败:', error);
            serverError(res, error);
        }
    });

    app.get('/api/canvas/load', (req, res) => {
        const target = canvasNameToFile(req.query.name);

        if (!target) {
            return res.json({ success: false, error: '作品名不合法' });
        }
        try {
            if (!fs.existsSync(target.file)) {
                return res.json({ success: false, error: '没找到「' + target.name + '」' });
            }
            res.json({ success: true, data: JSON.parse(fs.readFileSync(target.file, 'utf8')) });
        } catch (error) {
            console.error('[画板] 载入失败:', error);
            serverError(res, error);
        }
    });

    app.get('/api/canvas/list', (req, res) => {
        const list = [];

        try {
            if (fs.existsSync(CANVAS_DIR)) {
                fs.readdirSync(CANVAS_DIR).filter((f) => f.endsWith('.json')).forEach((f) => {
                    try {
                        const saved = JSON.parse(fs.readFileSync(path.join(CANVAS_DIR, f), 'utf8'));
                        list.push({
                            name: f.slice(0, -5),
                            strokeCount: Array.isArray(saved.strokes) ? saved.strokes.length : 0,
                            updatedAt: saved.updatedAt || null
                        });
                    } catch (error) {
                        console.error('[画板] 跳过损坏的存档 ' + f + ':', error.message);
                    }
                });
            }
            list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
            res.json({ success: true, list });
        } catch (error) {
            console.error('[画板] 列表失败:', error);
            serverError(res, error);
        }
    });
}

module.exports = registerCanvasRoutes;
