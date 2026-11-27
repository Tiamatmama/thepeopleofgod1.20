// 陪她玩路由：开局 / 出手 / 认输。
// 判定在 gameTable 里做（确定规则），这里只负责：校验会话、记「今天陪她玩过」、让她说一句。
// 刻意不写主会话历史——玩游戏不是私聊，写进去会污染对话上下文。
module.exports = function registerGameRoutes(app, ctx) {
  const { requireLogin, serverError, gameTable, galgameModule, sessionManager, outputModule } = ctx;

  function resolveSession(req, res) {
    const sessionId = String(req.params.sessionId || '');
    if (!sessionManager || typeof sessionManager.validateSession !== 'function') return null;
    if (!sessionManager.validateSession(sessionId)) {
      res.status(404).json({ success: false, message: '会话不存在' });
      return null;
    }
    return sessionId;
  }

  // 好感度必须落在「本人 × 本角色」这一档，不能回落到 default 共享档
  function resolveUser(req) {
    const body = req.body || {};
    return String(body.userId || req.query.userId || (req.user && req.user.username) || '');
  }

  function relationshipOf(sessionId, userId) {
    try {
      return galgameModule.getCurrentRelationship(sessionId, userId);
    } catch {
      return null;
    }
  }

  // 输赢只决定这一局的气氛，不换分数。好感来自「你陪她玩了一会儿」：
  // 每天第一局玩完记 +1，同一角色同一天第二局起不加。
  // 这样既不会让运气替她表态，也没法靠反复开局刷分。
  const DAILY_GAME_BONUS = 1;

  function applyAffection(sessionId, userId, delta, reason) {
    if (!delta) return relationshipOf(sessionId, userId);
    try {
      const updated = galgameModule.updateRelationship({ value: 0 }, delta, reason, sessionId, userId);
      return {
        stage: updated.stage,
        score: updated.score,
        stageName: updated.stageName,
        change: updated.affectionChange ? updated.affectionChange.change : delta
      };
    } catch (error) {
      console.warn('[陪她玩] 好感度记录失败:', error.message);
      return relationshipOf(sessionId, userId);
    }
  }

  // 每天第一次玩完一局才算数；同一天再玩只陪她玩，不动分数
  function grantDailyBonus(sessionId, userId) {
    let granted;
    try {
      granted = gameTable.takeDailyBonus(sessionId, userId);
    } catch {
      granted = false;
    }
    if (!granted) return { delta: 0, relationship: relationshipOf(sessionId, userId) };
    return {
      delta: DAILY_GAME_BONUS,
      relationship: applyAffection(sessionId, userId, DAILY_GAME_BONUS, '今天第一次陪她玩')
    };
  }

  function describeOutcome(game, result, detail) {
    if (game === 'dice') {
      return `你掷出 ${detail.yoursTotal}（${detail.yours.join('+')}），她掷出 ${detail.hersTotal}（${detail.hers.join('+')}），${result === 'win' ? '你赢了' : result === 'lose' ? '她赢了' : '平了'}。`;
    }
    if (game === 'rps') {
      return `你出${detail.yoursLabel}，她出${detail.hersLabel}，${result === 'win' ? '你赢了' : result === 'lose' ? '她赢了' : '平了'}。`;
    }
    if (detail && detail.quit) return `他玩到一半认输了，答案是 ${detail.answer}。`;
    if (result === 'win') return `他猜到第 ${detail.guess} 次就猜中了，答案是 ${detail.answer}。`;
    return `他最后一次猜 ${detail.guess}，${detail.hint}，次数用完了，答案是 ${detail.answer}。`;
  }

  // 她的一句话。失败就返回 null，不挡住输赢结果
  async function herLine({ sessionId, userId, game, result, detail }) {
    let characterPrompt;
    try {
      characterPrompt = sessionManager.buildCharacterPrompt(sessionId) || '';
    } catch {
      characterPrompt = '';
    }
    const relation = relationshipOf(sessionId, userId);
    const relationText = relation ? `【你们现在的关系】${relation.stageName}（好感 ${relation.score}）` : '';
    const moodHint = result === 'win'
      ? '你输了，按约定要撒娇，别嘴硬到底。'
      : result === 'lose'
        ? '你赢了，可以得意，也可以要求他撒娇、提个小要求。'
        : '平局，吐槽一句就行。';

    const system = `${String(characterPrompt).slice(0, 1500)}
${relationText}
【你们刚在玩】${gameTable.gameLabel(game)}
【这一局】${describeOutcome(game, result, detail)}
${moodHint}

请以第一人称说一句，1-2 句，口语，带情绪；不要复述规则或点数，不要用括号写动作，只输出这句话。`;

    try {
      const response = await outputModule.callModelOnce(
        [{ role: 'system', content: system }, { role: 'user', content: '（这一局结束了）' }],
        [],
        null,
        { maxTokens: 120, sessionId }
      );
      const raw = response?.choices?.[0]?.message?.content || '';
      return String(raw).replace(/^["'「]|["'」]$/g, '').split('\n')[0].trim().slice(0, 160) || null;
    } catch (error) {
      console.warn('[陪她玩] 台词生成失败:', error.message);
      return null;
    }
  }

  // 猜数字中途的提示不需要模型，直接给判定结果，省一次调用
  function hintLine(result, detail) {
    if (result !== 'continue') return null;
    return `${detail.hint}。还剩 ${detail.triesLeft} 次。`;
  }

  app.post('/api/games/:sessionId/start', requireLogin, (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;

      const userId = resolveUser(req);
      if (!userId) {
        res.status(400).json({ success: false, message: '缺少用户标识' });
        return;
      }

      const started = gameTable.start({ sessionId, userId, game: String((req.body || {}).game || '') });
      if (started.error) {
        res.status(400).json({ success: false, message: started.error });
        return;
      }

      res.json({ success: true, ...started, relationship: relationshipOf(sessionId, userId) });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post('/api/games/:sessionId/move', requireLogin, async (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;

      const userId = resolveUser(req);
      if (!userId) {
        res.status(400).json({ success: false, message: '缺少用户标识' });
        return;
      }

      const outcome = gameTable.move({ sessionId, userId, move: (req.body || {}).move });
      if (outcome.error) {
        res.status(400).json({ success: false, message: outcome.error });
        return;
      }

      const affection = outcome.finished
        ? grantDailyBonus(sessionId, userId)
        : { delta: 0, relationship: relationshipOf(sessionId, userId) };

      const line = outcome.finished
        ? await herLine({ sessionId, userId, game: outcome.state.game, result: outcome.result, detail: outcome.detail })
        : hintLine(outcome.result, outcome.detail);

      res.json({
        success: true,
        result: outcome.result,
        finished: outcome.finished,
        state: outcome.state,
        detail: outcome.detail,
        herLine: line,
        affection
      });
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post('/api/games/:sessionId/quit', requireLogin, async (req, res) => {
    try {
      const sessionId = resolveSession(req, res);
      if (!sessionId) return;

      const userId = resolveUser(req);
      if (!userId) {
        res.status(400).json({ success: false, message: '缺少用户标识' });
        return;
      }

      const outcome = gameTable.quit({ sessionId, userId });
      if (outcome.error) {
        res.status(400).json({ success: false, message: outcome.error });
        return;
      }

      const line = await herLine({
        sessionId,
        userId,
        game: outcome.state.game,
        result: outcome.result,
        detail: { ...outcome.detail, quit: true }
      });

      res.json({
        success: true,
        result: outcome.result,
        finished: true,
        state: outcome.state,
        detail: outcome.detail,
        herLine: line,
        affection: { delta: 0, relationship: relationshipOf(sessionId, userId) }
      });
    } catch (error) {
      serverError(res, error);
    }
  });
};
