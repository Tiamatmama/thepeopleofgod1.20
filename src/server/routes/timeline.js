'use strict';

// 🌙 读模型「她的一天」接口。
// scope 只从登录会话解析（req.user.userId），绝不接受请求参数里的 userId / scope，
// 挡住 `__role` / `__ai` 后缀穿透读到他人时间线。

const { dayKey } = require('../../core/timeline');
const { buildDayView } = require('../../core/timelineView');

module.exports = (app, { requireLogin, serverError, timeline, memoryModule }) => {
    app.get('/api/timeline/days', requireLogin, (req, res) => {
        try {
            const scope = memoryModule.normalizeScopeKey(req.user.userId, 'role');
            const days = timeline.listDays(scope, { limit: 30 });
            res.json({ success: true, days });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/timeline/day', requireLogin, (req, res) => {
        try {
            const scope = memoryModule.normalizeScopeKey(req.user.userId, 'role');
            const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
                ? req.query.date
                : dayKey();
            const events = timeline.readDay(scope, date);
            res.json({ success: true, ...buildDayView(events, { date }) });
        } catch (error) {
            serverError(res, error);
        }
    });
};
