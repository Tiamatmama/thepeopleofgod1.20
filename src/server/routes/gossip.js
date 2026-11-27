// 她们的闲话：她在群聊大厅里听别的角色说话，心里给对方留下的印象。
// 数据就是 plazaImpression 的影子层（data/social_plaza/shadow/），这里只读不写。
// 影子层本来就不进正式记忆，所以这条链路既不污染对话，也不需要新存储。
module.exports = function registerGossipRoutes(app, ctx) {
  const { requireLogin, serverError, socialPlaza, sessionManager } = ctx;

  const MAX_BUCKETS = 8;
  const MAX_NOTES_SHOWN = 6;

  // 会话必须真实存在，避免拿任意 id 探别人的档案
  function resolveSession(req, res) {
    const sessionId = String(req.params.sessionId || '');
    if (!sessionManager || typeof sessionManager.validateSession !== 'function') return null;
    if (!sessionManager.validateSession(sessionId)) {
      res.status(404).json({ success: false, message: '会话不存在' });
      return null;
    }
    return sessionId;
  }

  // 同一个用户名下的其他角色：她可能认识的人
  function peersOf(sessionId) {
    let session;
    try {
      session = sessionManager.getSession(sessionId);
    } catch {
      return [];
    }
    const creatorId = session && session.creatorId;
    if (!creatorId) return [];

    return sessionManager.getAllSessions()
      .filter((s) => s && s.sessionId && s.sessionId !== sessionId)
      .filter((s) => s.creatorId === creatorId)
      .filter((s) => s.characterConfig && s.characterConfig.name)
      .slice(0, 8)
      .map((s) => ({ sessionId: s.sessionId, name: String(s.characterConfig.name).slice(0, 20) }));
  }

  app.get('/api/gossip/:sessionId', requireLogin, (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;

      const store = socialPlaza && socialPlaza.impression;
      let subjects = {};
      try {
        if (store && typeof store.read === 'function') {
          const data = store.read(sessionId);
          subjects = (data && data.subjects) || {};
        }
      } catch (error) {
        console.warn('[闲话] 读取影子印象失败，按空处理:', error.message);
        subjects = {};
      }

      const buckets = Object.keys(subjects)
        .map((subjectId) => {
          const bucket = subjects[subjectId] || {};
          const notes = (Array.isArray(bucket.notes) ? bucket.notes : [])
            .slice(-MAX_NOTES_SHOWN)
            .map((n) => ({
              text: String((n && n.text) || '').slice(0, 120),
              at: Number(n && n.at) || 0
            }))
            .filter((n) => n.text);
          return {
            sessionId: subjectId,
            name: String(bucket.name || '').slice(0, 20) || '某个角色',
            notes
          };
        })
        .filter((b) => b.notes.length > 0)
        .sort((a, b) => {
          const at = (x) => (x.notes.length ? x.notes[x.notes.length - 1].at : 0);
          return at(b) - at(a);
        })
        .slice(0, MAX_BUCKETS);

      res.json({ success: true, peers: peersOf(sessionId), subjects: buckets });
    } catch (error) {
      serverError(res, error);
    }
  });
};
