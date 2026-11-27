'use strict';

/**
 * 自主能力垂直切片的被测服务（fixture）。
 *
 * 故意只依赖 Node 内置模块：闭环要验证的是「能不能把登录页做到健康检查通过」，
 * 而不是框架安装成功。默认 /health 返回 200，传入 healthStatus 可模拟故障。
 */

const http = require('http');

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>登录</title></head>
<body>
  <main>
    <h1 id="title">登录</h1>
    <form id="login-form" method="post" action="/login">
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button id="submit" type="submit">登录</button>
    </form>
    <p id="error" hidden>用户名或密码错误</p>
  </main>
</body>
</html>`;

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>控制台</title></head>
<body>
  <main>
    <h1 id="title">控制台</h1>
    <p id="welcome">欢迎回来</p>
  </main>
</body>
</html>`;

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function createServer(options = {}) {
  const state = {
    healthStatus: options.healthStatus == null ? 200 : Number(options.healthStatus)
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/health') {
      res.writeHead(state.healthStatus, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(state.healthStatus === 200 ? 'ok' : 'unhealthy');
      return;
    }

    if (pathname === '/' || pathname === '/login') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const form = new URLSearchParams(body);
          if (form.get('username') && form.get('password')) {
            res.writeHead(302, { location: '/dashboard' });
            res.end();
            return;
          }
          sendHtml(res, 401, LOGIN_HTML.replace('hidden', ''));
        });
        return;
      }
      sendHtml(res, 200, LOGIN_HTML);
      return;
    }

    if (pathname === '/dashboard') {
      sendHtml(res, 200, DASHBOARD_HTML);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.state = state;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer({ healthStatus: process.env.HEALTH_STATUS });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[fixture] listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer, LOGIN_HTML, DASHBOARD_HTML };
