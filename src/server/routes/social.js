// 社交平台（群聊大厅）路由。
// 网页端专用：QQ / B 站链路不调用这里的任何接口，因此「只在网页端可见」是由调用方决定的，
// 而不是靠路由做额外拦截。鉴权沿用网页端登录态（x-session-id）。
module.exports = function registerSocialRoutes(app, ctx) {
  const { requireLogin, serverError, socialPlaza } = ctx;

  app.get('/api/social/state', requireLogin, (req, res) => {
    try {
      res.json({ success: true, ...socialPlaza.getState() });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post('/api/social/start', requireLogin, (req, res) => {
    try {
      const body = req.body || {};
      const state = socialPlaza.start({
        participants: body.participants,
        topic: body.topic,
        intervalMs: body.intervalMs
      });
      res.json({ success: true, ...state });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.post('/api/social/stop', requireLogin, (req, res) => {
    try {
      res.json({ success: true, ...socialPlaza.stop('网页端手动停止') });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post('/api/social/say', requireLogin, (req, res) => {
    try {
      const text = (req.body || {}).text;
      res.json({ success: true, ...socialPlaza.say(text) });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.post('/api/social/clear', requireLogin, (req, res) => {
    try {
      res.json({ success: true, ...socialPlaza.clear() });
    } catch (error) {
      serverError(res, error);
    }
  });
};
