// 她的动态（朋友圈）路由。
// 内容来自 privateLife 的生活档案：每天 22 点生成「今天」时顺带产出的一条动态。
// 这里只做三件事：读流、点赞、评论（评论会让角色回一句）。
// 刻意不写主会话历史——朋友圈不是私聊，写进去会污染对话上下文。
module.exports = function registerFeedRoutes(app, ctx) {
  const { requireLogin, serverError, privateLife, sessionManager, outputModule } = ctx;

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

  // 取最近的对话，供首次补写时参考；取不到就给空数组，不让它挡住请求
  function recentHistory(sessionId) {
    try {
      const session = sessionManager.getSession(sessionId);
      const userId = session && (session.creatorId || Object.keys(session.users || {})[0]);
      if (!userId) return [];
      return sessionManager.getConversationHistory(sessionId, userId, 12) || [];
    } catch {
      return [];
    }
  }

  app.get('/api/feed/:sessionId', requireLogin, async (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;

      // 一条动态都没有时补写一次，否则白天打开永远是空页
      if (privateLife.listPosts(sessionId).length === 0) {
        let characterPrompt = '';
        try {
          characterPrompt = sessionManager.buildCharacterPrompt(sessionId) || '';
        } catch {
          characterPrompt = '';
        }
        await privateLife.ensureFirstFeed({
          sessionId,
          characterPrompt,
          history: recentHistory(sessionId),
          // 🕰️ 时间线要知道这条生活属于谁（记忆键与它对齐）
          userId: sessionManager.getSession(sessionId)?.creatorId || ''
        });
      }

      res.json({ success: true, posts: privateLife.listPosts(sessionId) });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post('/api/feed/:sessionId/:postId/like', requireLogin, (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;
      const result = privateLife.toggleLike(sessionId, String(req.params.postId || ''));
      if (!result) {
        res.status(404).json({ success: false, message: '动态不存在' });
        return;
      }
      res.json({ success: true, ...result });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post('/api/feed/:sessionId/:postId/comment', requireLogin, async (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;

      const postId = String(req.params.postId || '');
      const text = String((req.body || {}).text || '').trim();
      if (!text) {
        res.status(400).json({ success: false, message: '评论不能为空' });
        return;
      }

      const hit = privateLife.findPost(sessionId, postId);
      if (!hit) {
        res.status(404).json({ success: false, message: '动态不存在' });
        return;
      }

      const mine = privateLife.addComment(sessionId, postId, 'user', text);

      // 她回一句。失败不影响评论本身已经落下
      let reply = null;
      try {
        let characterPrompt = '';
        try {
          characterPrompt = sessionManager.buildCharacterPrompt(sessionId) || '';
        } catch {
          characterPrompt = '';
        }
        const system = `${String(characterPrompt).slice(0, 1500)}

【你前几天发过的一条动态】${hit.post.text}
【他看到后评论】${text}

请以第一人称回他一句，1-2 句，口语，别解释你为什么这么发，别用括号加动作描写。只输出这一句话。`;
        const result = await outputModule.callModelOnce(
          [{ role: 'system', content: system }, { role: 'user', content: text }],
          [],
          null,
          { maxTokens: 200, sessionId }
        );
        const raw = result?.choices?.[0]?.message?.content || '';
        const clean = String(raw).replace(/^["'「]|["'」]$/g, '').split('\n')[0].trim().slice(0, 200);
        if (clean) {
          reply = privateLife.addComment(sessionId, postId, 'assistant', clean);
        }
      } catch (error) {
        console.warn('[朋友圈] 评论回复生成失败:', error.message);
      }

      res.json({ success: true, comment: mine, reply });
    } catch (error) {
      serverError(res, error);
    }
  });
};
