'use strict';

// 独立硬件建模通道：只依赖 hardware/model，不 require src/，不接角色、QQ、B 站或编程沙箱。
// 默认只监听 127.0.0.1；设置 HARDWARE_MODEL_TOKEN 后，构建与列表接口要求 Bearer。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildFromSpec } = require('./build');

const SPECS_DIR = path.join(__dirname, 'specs');
const OUT_DIR = path.join(__dirname, 'out');
const MAX_BODY = 64 * 1024;
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:41888',
  'http://localhost:41888',
  'https://127.0.0.1:41443',
  'https://localhost:41443'
]);
const SAFE_FILE = /^[A-Za-z0-9_-]+\.(step|stl|svg|scad)$/;

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
  }
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, data) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function listSpecs() {
  let files = [];
  try {
    files = fs.readdirSync(SPECS_DIR).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SPECS_DIR, file), 'utf8'));
      return { file, name: raw.name || file.replace(/\.json$/, ''), type: raw.type || 'phone-stand' };
    } catch {
      return { file, name: file.replace(/\.json$/, ''), type: 'unknown' };
    }
  });
}

function summarizeBuild(result) {
  const files = {};
  for (const [key, filePath] of Object.entries(result.files)) {
    files[key.replace(/Path$/, '')] = path.basename(filePath);
  }
  return {
    ok: true,
    part: result.spec.name,
    type: result.spec.type,
    unit: result.spec.unit,
    bbox: result.bbox.size.map(value => Math.round(value * 100) / 100),
    volumeCm3: Math.round(result.volume / 10) / 100,
    triangles: result.triangleCount,
    edges: result.edges,
    files
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（上限 64KB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createHardwareService(options = {}) {
  const token = String(options.token || process.env.HARDWARE_MODEL_TOKEN || '').trim();
  let building = false;

  const authorized = (req) => {
    if (!token) return true;
    return String(req.headers.authorization || '') === `Bearer ${token}`;
  };

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname;

    try {
      if (req.method === 'GET' && route === '/health') {
        sendJson(res, 200, { ok: true, service: 'hardware-model', parts: listSpecs().length });
        return;
      }

      const fileMatch = route.match(/^\/v1\/files\/([^/]+)$/);
      if (route === '/v1/parts' || route === '/v1/build' || fileMatch) {
        if (!authorized(req)) {
          sendJson(res, 401, { ok: false, error: '需要 Bearer token' });
          return;
        }
      }

      if (req.method === 'GET' && fileMatch) {
        const name = decodeURIComponent(fileMatch[1]);
        if (!SAFE_FILE.test(name)) {
          sendJson(res, 400, { ok: false, error: '文件名不合法' });
          return;
        }
        const filePath = path.join(OUT_DIR, name);
        if (!fs.existsSync(filePath)) {
          sendJson(res, 404, { ok: false, error: '文件不存在' });
          return;
        }
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': body.length
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && route === '/v1/parts') {
        sendJson(res, 200, { ok: true, parts: listSpecs() });
        return;
      }

      if (req.method === 'POST' && route === '/v1/build') {
        if (building) {
          sendJson(res, 429, { ok: false, error: '正在构建，请稍后重试' });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: `JSON 解析失败：${error.message}` });
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          sendJson(res, 400, { ok: false, error: '需要 { "spec": { ... } } 或 { "file": "xxx.json" }' });
          return;
        }

        let spec = payload.spec;
        if (!spec && typeof payload.file === 'string') {
          const file = path.basename(payload.file);
          if (file !== payload.file || !/^[A-Za-z0-9_-]+\.json$/.test(file)) {
            sendJson(res, 400, { ok: false, error: 'file 必须是 specs 目录下的 .json 文件名' });
            return;
          }
          const filePath = path.join(SPECS_DIR, file);
          if (!fs.existsSync(filePath)) {
            sendJson(res, 404, { ok: false, error: '模型参数不存在' });
            return;
          }
          spec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
          sendJson(res, 400, { ok: false, error: '需要 { "spec": { ... } } 或 { "file": "xxx.json" }' });
          return;
        }

        building = true;
        try {
          const result = buildFromSpec(spec);
          sendJson(res, 200, summarizeBuild(result));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        } finally {
          building = false;
        }
        return;
      }

      if (route === '/v1/parts' || route === '/v1/build' || fileMatch) {
        sendJson(res, 405, { ok: false, error: `不支持 ${req.method}` });
        return;
      }

      sendJson(res, 404, { ok: false, error: '未知路径' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

module.exports = { createHardwareService, listSpecs, summarizeBuild };
