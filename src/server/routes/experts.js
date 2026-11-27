// 大神蒸馏 + 圆桌讨论的路由。
// 蒸馏要联网搜+抓好几篇正文，再跑两次模型，单次几十秒，所以不设短超时；
// 圆桌走 NDJSON 流式输出（每说完一条推一行），前端可以边看边说。
const { PersonaDistiller, ExpertLibrary } = require('../../core/personaDistill');
const { Roundtable } = require('../../core/roundtable');

module.exports = function registerExpertRoutes(app, ctx) {
  const { requireLogin, serverError, toolRegistry } = ctx;

  const library = new ExpertLibrary();
  const roundtable = new Roundtable();
  const distiller = new PersonaDistiller({
    search: (query, count) => toolRegistry.webSearch(query, count),
    fetchPage: (url, maxChars) => toolRegistry.fetchUrl(url, maxChars),
    library
  });

  // 同一个名字不并发蒸两份：重复点击直接复用第一次的结果
  const running = new Map();

  app.get('/api/experts', requireLogin, (req, res) => {
    try {
      res.json({ success: true, experts: library.list() });
    } catch (error) {
      serverError(res, error);
    }
  });

  // 圆桌列表必须排在 /:id 前面，否则会被当成一个人格 id
  app.get('/api/experts/roundtables', requireLogin, (req, res) => {
    try {
      res.json({ success: true, roundtables: roundtable.list(req.query.limit) });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.get('/api/experts/roundtables/:id', requireLogin, (req, res) => {
    const data = roundtable.load(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: '这场讨论不存在' });
    res.json({ success: true, roundtable: data });
  });

  app.get('/api/experts/:id', requireLogin, (req, res) => {
    const data = library.load(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: '没有这份人格，先蒸馏' });
    res.json({ success: true, expert: data });
  });

  app.post('/api/experts/distill', requireLogin, async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: '要蒸谁？给个名字' });
    if (name.length > 40) return res.status(400).json({ success: false, message: '名字太长了' });

    try {
      // 手动贴的链接优先：搜索源不可用时，这是唯一稳定的入口
      const urls = (Array.isArray(body.urls) ? body.urls : [])
        .map((item) => String(item || '').trim())
        .filter((item) => /^https?:\/\//i.test(item))
        .slice(0, 5);

      let job = running.get(name);
      if (!job) {
        job = distiller.distill({
          name,
          field: String(body.field || '网络安全').trim().slice(0, 30),
          hint: String(body.hint || '').trim().slice(0, 200),
          urls
        });
        running.set(name, job);
        // 不论成败都要清掉，否则失败后同一个人永远蒸不了
        job.finally(() => running.delete(name)).catch(() => {});
      }
      const expert = await job;
      res.json({ success: true, expert });
    } catch (error) {
      res.status(502).json({ success: false, message: error.message || '蒸馏失败' });
    }
  });

  app.post('/api/experts/roundtable', requireLogin, async (req, res) => {
    const body = req.body || {};
    const topic = String(body.topic || '').trim();
    const ids = Array.isArray(body.expertIds) ? body.expertIds.map((id) => String(id)) : [];
    if (!topic) return res.status(400).json({ success: false, message: '话题不能为空' });

    const experts = ids.map((id) => library.load(id)).filter(Boolean);
    if (experts.length < 2) {
      return res.status(400).json({ success: false, message: '至少选两位已经蒸馏过的大神' });
    }

    // NDJSON：每行一个事件，前端按行解析，不用等整场说完
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const send = (payload) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const result = await roundtable.run({
        topic,
        experts,
        rounds: Number(body.rounds) || 2,
        // 需求理解产出的共同前提：拼进每个人设，避免专家自作主张换问题
        brief: body.brief == null ? '' : body.brief,
        // 项目现状（只读事实）：让专家对着真实文件说话，而不是讲通用方法论
        context: body.context == null ? '' : body.context,
        onTurn: (turn) => send({ type: 'turn', turn })
      });
      send({ type: 'done', roundtable: result });
      res.end();
    } catch (error) {
      send({ type: 'error', message: error.message || '圆桌开不起来' });
      res.end();
    }
  });
};
