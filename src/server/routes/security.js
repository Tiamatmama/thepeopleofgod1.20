'use strict';

// 安全护栏查询接口：父本账本（谁/何时/从哪来）+ 命令规则清单。
// 只读接口，不提供「放行」或「删除记录」入口，避免护栏被远程关掉。

const securityGuard = require('../../core/securityGuard');

function registerSecurityRoutes(app, ctx = {}) {
  const { requireLogin, serverError } = ctx;
  const gate = typeof requireLogin === 'function' ? requireLogin : (req, res, next) => next();
  const fail = (res, error) => {
    if (typeof serverError === 'function') return serverError(res, error);
    return res.status(500).json({ success: false, error: error.message });
  };

  // 最近的安全事件（拦截记录 + 可疑写入），默认 50 条，最新在前
  app.get('/api/security/events', gate, (req, res) => {
    try {
      res.json({ success: true, events: securityGuard.ledger.recent(req.query.limit) });
    } catch (error) {
      fail(res, error);
    }
  });

  // 路径溯源：给一个文件/目录，返回它相关的写入与执行记录
  app.get('/api/security/explain', gate, (req, res) => {
    const target = String(req.query.path || '').trim();
    if (!target) {
      res.status(400).json({ success: false, error: '缺少 path 参数' });
      return;
    }
    try {
      res.json({ success: true, path: target, events: securityGuard.ledger.explain(target, req.query.limit) });
    } catch (error) {
      fail(res, error);
    }
  });

  // 规则清单：只是给人看的元信息，不带匹配表达式
  app.get('/api/security/rules', gate, (req, res) => {
    const simplify = (list) => list.map((item) => ({ id: item.id, name: item.name, reason: item.reason }));
    res.json({
      success: true,
      block: simplify(securityGuard.rules.block),
      confirm: simplify(securityGuard.rules.confirm)
    });
  });
}

module.exports = registerSecurityRoutes;
