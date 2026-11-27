'use strict';

/**
 * 页面级验收（webCheck）
 *
 * 由 runner 侧执行，模型只能声明判据、不能修改判据。
 * 浏览器使用本机 Chrome/Edge + CDP，不引入 playwright/puppeteer。
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

const MAX_STEPS = 50;
const MAX_TEXT = 2000;
const MAX_MESSAGE = 4000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MIN_VIEWPORT = { width: 320, height: 240 };
const MAX_VIEWPORT = { width: 3840, height: 2160 };
const START_READY_TIMEOUT_MS = 120000;
const START_MAX_READY_TIMEOUT_MS = 180000;
const RUN_TIMEOUT_MS = 240000;
const RUN_MAX_TIMEOUT_MS = 300000;
const STEP_TIMEOUT_MS = 15000;
const EXPECT_TIMEOUT_MS = 5000;
const CDP_TIMEOUT_MS = 15000;

const STEP_TYPES = new Set(['open', 'assert', 'click', 'type', 'wait']);

// 只允许常见运行时，避免把任意可执行文件当服务拉起。
const COMMAND_WHITELIST = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'py',
  'php', 'ruby', 'go', 'dotnet', 'cargo', 'deno',
]);

const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0',
]);

function fail(message) {
  const err = new Error(message);
  err.code = 'WEB_CHECK_INVALID';
  return err;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeText(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') throw fail(`${field} 必须是字符串`);
  if (value.length > MAX_TEXT) throw fail(`${field} 超过 ${MAX_TEXT} 字符`);
  return value;
}

function normalizeTextList(value, field) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) throw fail(`${field} 不能为空数组`);
  return list.map((item, i) => {
    const text = normalizeText(item, `${field}[${i}]`);
    if (text == null) throw fail(`${field}[${i}] 不能为空`);
    return text;
  });
}

function normalizeSelector(value, field) {
  const selector = normalizeText(value, field);
  if (!selector || !selector.trim()) throw fail(`${field} 不能为空`);
  return selector.trim();
}

function normalizeStep(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail(`steps[${index}] 必须是对象`);
  }
  const type = String(raw.type || '').toLowerCase();
  if (!STEP_TYPES.has(type)) {
    throw fail(`steps[${index}].type 不支持: ${raw.type}`);
  }

  const step = { type };

  if (type === 'open') {
    if (raw.url != null) {
      step.url = normalizeText(raw.url, `steps[${index}].url`);
      if (!/^https?:\/\//i.test(step.url)) {
        throw fail(`steps[${index}].url 必须是 http(s) 地址`);
      }
    } else {
      const p = normalizeText(raw.path, `steps[${index}].path`);
      if (!p || !p.startsWith('/')) {
        throw fail(`steps[${index}] 需要 url 或以 / 开头的 path`);
      }
      step.path = p;
    }
    return step;
  }

  if (type === 'assert') {
    step.selector = normalizeSelector(raw.selector, `steps[${index}].selector`);
    step.text = normalizeTextList(raw.text, `steps[${index}].text`);
    step.urlContains = normalizeText(raw.urlContains, `steps[${index}].urlContains`);
    if (raw.visible != null && typeof raw.visible !== 'boolean') {
      throw fail(`steps[${index}].visible 必须是布尔值`);
    }
    step.visible = raw.visible !== false; // 断言默认要求元素可见
    if (!step.text && !step.urlContains && raw.visible == null) {
      throw fail(`steps[${index}] 至少需要 text/visible/urlContains 之一`);
    }
    return step;
  }

  if (type === 'click') {
    step.selector = normalizeSelector(raw.selector, `steps[${index}].selector`);
    const expect = raw.expect;
    if (!expect || typeof expect !== 'object' || Array.isArray(expect)) {
      throw fail(`steps[${index}].expect 必填，用于判断点击是否生效`);
    }
    step.expect = {
      selector: expect.selector == null
        ? null
        : normalizeSelector(expect.selector, `steps[${index}].expect.selector`),
      text: normalizeTextList(expect.text, `steps[${index}].expect.text`),
      urlContains: normalizeText(expect.urlContains, `steps[${index}].expect.urlContains`),
      visible: expect.visible !== false,
      timeoutMs: clampInt(expect.timeoutMs, 500, 30000, EXPECT_TIMEOUT_MS),
    };
    if (!step.expect.selector && !step.expect.text && !step.expect.urlContains) {
      throw fail(`steps[${index}].expect 至少需要 selector/text/urlContains 之一`);
    }
    if (expect.visible == null && !step.expect.selector && !step.expect.text && !step.expect.urlContains) {
      throw fail(`steps[${index}].expect 判据不足`);
    }
    return step;
  }

  if (type === 'type') {
    step.selector = normalizeSelector(raw.selector, `steps[${index}].selector`);
    if (typeof raw.text !== 'string') throw fail(`steps[${index}].text 必须是字符串`);
    if (raw.text.length > MAX_TEXT) throw fail(`steps[${index}].text 超过 ${MAX_TEXT} 字符`);
    step.text = raw.text;
    step.submit = raw.submit === true;
    return step;
  }

  // wait
  const hasMs = raw.ms != null;
  const hasSelector = raw.selector != null;
  if (!hasMs && !hasSelector) {
    throw fail(`steps[${index}] 需要 ms 或 selector`);
  }
  if (hasMs) step.ms = clampInt(raw.ms, 0, 60000, 0);
  if (hasSelector) step.selector = normalizeSelector(raw.selector, `steps[${index}].selector`);
  return step;
}

function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw fail('webCheck.steps 必须是非空数组');
  }
  if (raw.length > MAX_STEPS) {
    throw fail(`webCheck.steps 最多 ${MAX_STEPS} 条`);
  }
  return raw.map((item, i) => normalizeStep(item, i));
}

function normalizeStart(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('webCheck.start 必须是对象');
  }
  const command = String(raw.command || '').trim();
  if (!command) throw fail('webCheck.start.command 不能为空');

  const base = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (!COMMAND_WHITELIST.has(base)) {
    throw fail(`webCheck.start.command 不在白名单: ${base}`);
  }

  let args = [];
  if (raw.args != null) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
      throw fail('webCheck.start.args 必须是字符串数组');
    }
    args = raw.args.slice(0, 32).map((a) => a.slice(0, MAX_MESSAGE));
  }

  const readyPath = raw.readyPath == null
    ? '/'
    : normalizeText(raw.readyPath, 'webCheck.start.readyPath') || '/';

  return {
    command,
    args,
    readyPath: readyPath.startsWith('/') ? readyPath : `/${readyPath}`,
    readyTimeoutMs: clampInt(
      raw.readyTimeoutMs,
      1000,
      START_MAX_READY_TIMEOUT_MS,
      START_READY_TIMEOUT_MS,
    ),
    env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? Object.fromEntries(
        Object.entries(raw.env)
          .filter(([, v]) => typeof v === 'string')
          .slice(0, 20),
      )
      : {},
  };
}

function normalizeBaseUrl(raw) {
  if (raw == null) return null;
  const value = normalizeText(raw, 'webCheck.baseUrl');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail('webCheck.baseUrl 不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail('webCheck.baseUrl 必须是 http(s)');
  }
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
}

function normalizeViewport(raw) {
  if (raw == null) return { ...DEFAULT_VIEWPORT };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('webCheck.viewport 必须是对象');
  }
  return {
    width: clampInt(raw.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width, DEFAULT_VIEWPORT.width),
    height: clampInt(raw.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height, DEFAULT_VIEWPORT.height),
  };
}

/**
 * 校验并规整 webCheck 声明。非法直接抛错（fail-closed）。
 * @returns {null | {start: object|null, baseUrl: string|null, viewport: object, steps: object[], timeoutMs: number}}
 */
function normalizeWebCheck(spec) {
  if (spec == null) return null;
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw fail('webCheck 必须是对象');
  }
  const start = normalizeStart(spec.start);
  const baseUrl = normalizeBaseUrl(spec.baseUrl);
  if (!start && !baseUrl) {
    throw fail('webCheck 需要 start（自启服务）或 baseUrl（已有服务）');
  }
  return {
    start,
    baseUrl,
    viewport: normalizeViewport(spec.viewport),
    steps: normalizeSteps(spec.steps),
    timeoutMs: clampInt(spec.timeoutMs, 5000, RUN_MAX_TIMEOUT_MS, RUN_TIMEOUT_MS),
  };
}

const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const POSIX_BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
];

function isExecutableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findBrowserExecutable() {
  const envPath = process.env.CHROME_PATH || process.env.BROWSER_PATH;
  if (envPath && isExecutableFile(envPath)) return envPath;

  const candidates = process.platform === 'win32'
    ? WINDOWS_BROWSER_CANDIDATES
    : POSIX_BROWSER_CANDIDATES;

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  throw fail('未找到可用的 Chrome/Edge，可通过 CHROME_PATH 指定浏览器路径');
}

/** 同步杀进程树，用于 exit 兜底与 finally 清理。 */
function killTreeSync(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return;
  const id = String(pid);
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', id, '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-Number(id), 'SIGKILL');
      } catch {
        process.kill(Number(id), 'SIGKILL');
      }
    }
  } catch {
    /* 进程可能已退出 */
  }
}

function readDevToolsPort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const port = Number(lines[0]);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    /* 还没写出来 */
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function httpPut(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
      const page = Array.isArray(targets)
        ? targets.find((t) => t && t.type === 'page' && t.webSocketDebuggerUrl)
        : null;
      if (page) return page;

      const created = await httpPut(`http://127.0.0.1:${port}/json/new?about:blank`);
      if (created.status === 200) {
        const info = JSON.parse(created.body);
        if (info && info.webSocketDebuggerUrl) return info;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw fail(`等待浏览器页面超时${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(ws, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.on('message', (data) => this._handleMessage(data));
    ws.on('close', () => this._handleClose(new Error('CDP 连接已关闭')));
    ws.on('error', (err) => this._handleClose(err));
  }

  static connect(wsUrl, options = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        perMessageDeflate: false,
        maxPayload: 32 * 1024 * 1024,
      });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(fail('连接浏览器调试端口超时'));
      }, options.timeoutMs || CDP_TIMEOUT_MS);
      timer.unref?.();

      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws, options));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || 'CDP 调用失败');
        err.cdpError = msg.error;
        pending.reject(err);
      } else {
        pending.resolve(msg.result || {});
      }
      return;
    }

    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(msg.params || {});
        } catch {
          /* 监听方异常不影响主流程 */
        }
      }
    }
  }

  _handleClose(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.listeners.clear();
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), (err) => {
          if (!err) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    this.listeners.get(method)?.delete(handler);
  }

  waitForEvent(method, predicate, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        off();
        reject(new Error(`等待 CDP 事件 ${method} 超时`));
      }, timeoutMs);
      timer.unref?.();

      const off = this.on(method, (params) => {
        if (done) return;
        if (predicate && !predicate(params)) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
    try { this.ws.terminate(); } catch { /* ignore */ }
  }
}

/**
 * 启动无头浏览器并连接首个页面 target。
 * @returns {Promise<{proc, cdp, port, userDataDir, close: () => void}>}
 */
async function launchBrowser({ viewport = DEFAULT_VIEWPORT, timeoutMs = 20000 } = {}) {
  const executable = findBrowserExecutable();
  const userDataDir = path.join(os.tmpdir(), `tgp-webcheck-${crypto.randomUUID()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--mute-audio',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ];

  const proc = spawn(executable, args, {
    windowsHide: true,
    stdio: 'ignore',
  });

  let exited = false;
  let exitInfo = '';
  proc.once('exit', (code, signal) => {
    exited = true;
    exitInfo = `code=${code} signal=${signal}`;
  });

  const cleanup = () => {
    killTreeSync(proc.pid);
    // Windows 上 taskkill 返回后，浏览器子进程可能还短暂占着 user-data-dir 里的文件，
    // 立刻 rmSync 会 EBUSY/EPERM；这里同步重试几次，避免临时目录越积越多。
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        return;
      } catch {
        if (i === 4) return;
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        } catch {
          /* 环境不支持 Atomics.wait 时下面这轮直接重试 */
        }
      }
    }
  };

  try {
    const deadline = Date.now() + timeoutMs;
    let port = null;
    while (Date.now() < deadline) {
      if (exited) throw fail(`浏览器启动后立即退出（${exitInfo}）`);
      port = readDevToolsPort(userDataDir);
      if (port) break;
      await sleep(100);
    }
    if (!port) throw fail('等待浏览器调试端口超时');

    const page = await waitForPageTarget(port, timeoutMs);
    const cdp = await CdpClient.connect(page.webSocketDebuggerUrl, { timeoutMs: CDP_TIMEOUT_MS });

    return {
      proc,
      cdp,
      port,
      userDataDir,
      executable,
      close() {
        try { cdp.close(); } catch { /* ignore */ }
        cleanup();
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---- 本地服务启停 ----

const activeServers = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const server of activeServers) killTreeSync(server.pid);
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('分配端口失败'))));
    });
  });
}

function quoteWinArg(value) {
  const text = String(value);
  if (text && !/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Windows 上 npm/npx 是 .cmd shim，shell:false 无法直接执行。
 * 优先用 node + npm-cli.js，其余 .cmd 交给 cmd.exe /d /s /c。
 */
function resolveSpawnSpec(command, args) {
  if (process.platform !== 'win32') return { file: command, args };
  const base = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (base === 'npm' || base === 'npx') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${base}-cli.js`);
    if (fs.existsSync(cli)) return { file: process.execPath, args: [cli, ...args] };
  }
  // node/python 这类原生 exe 直接 spawn；只有 .cmd/.bat 生态才需要 cmd.exe
  const isCmdShim = /\.(cmd|bat)$/i.test(command)
    || ['npm', 'npx', 'pnpm', 'yarn', 'bun'].includes(base);
  if (!isCmdShim) return { file: command, args };

  const line = [command, ...args].map(quoteWinArg).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', line.startsWith('"') ? `"${line}"` : line],
  };
}

function probeUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode || 0 });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '探测超时' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

async function startServer(startSpec, { cwd } = {}) {
  installExitHook();
  const port = await findFreePort();
  const { file, args } = resolveSpawnSpec(startSpec.command, startSpec.args);
  const env = {
    ...process.env,
    ...startSpec.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    BROWSER: 'none',
    CI: '1',
    FORCE_COLOR: '0',
  };

  const proc = spawn(file, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const server = {
    proc,
    pid: proc.pid,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logText: '',
    exited: false,
    exitInfo: '',
    stopped: false,
    tail() {
      return this.logText.split(/\r?\n/).slice(-50).join('\n');
    },
  };

  const append = (chunk) => {
    server.logText += chunk.toString('utf8');
    if (server.logText.length > 65536) server.logText = server.logText.slice(-65536);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  proc.once('error', (err) => {
    server.exited = true;
    server.exitInfo = err.message;
  });
  proc.once('exit', (code, signal) => {
    server.exited = true;
    server.exitInfo = `code=${code} signal=${signal}`;
  });

  activeServers.add(server);
  return server;
}

function stopServer(server) {
  if (!server || server.stopped) return;
  server.stopped = true;
  activeServers.delete(server);
  killTreeSync(server.pid);
}

async function waitReady(server, startSpec) {
  const deadline = Date.now() + startSpec.readyTimeoutMs;
  let lastError = '';
  const readyPath = startSpec.readyPath || '/';

  while (Date.now() < deadline) {
    if (server.exited) {
      return { ok: false, error: `服务启动后退出（${server.exitInfo}）\n${server.tail()}` };
    }

    // dev server 常会打印实际端口，优先采信
    const match = server.logText.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i);
    if (match) {
      const candidate = `http://127.0.0.1:${match[1]}`;
      const probe = await probeUrl(candidate + readyPath);
      if (probe.ok && probe.status < 500) {
        server.baseUrl = candidate;
        return { ok: true, baseUrl: candidate };
      }
      lastError = probe.error || `HTTP ${probe.status}`;
    }

    const probe = await probeUrl(server.baseUrl + readyPath);
    if (probe.ok && probe.status < 500) {
      return { ok: true, baseUrl: server.baseUrl };
    }
    lastError = probe.error || `HTTP ${probe.status}`;
    await sleep(300);
  }

  return { ok: false, error: `服务就绪超时（${lastError || '无响应'}）\n${server.tail()}` };
}

// ---- 页面侧辅助 ----

function js(value) {
  return JSON.stringify(value);
}

const PAGE_HELPERS = `(() => {
  if (window.__tgpWebCheck) return true;
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
    return true;
  };
  window.__tgpWebCheck = {
    q(selector) {
      try { return Array.from(document.querySelectorAll(selector)); } catch (e) { return null; }
    },
    one(selector) {
      const list = this.q(selector);
      if (!list) return { error: '非法选择器: ' + selector };
      if (list.length !== 1) return { error: '匹配到 ' + list.length + ' 个元素（需要 1 个）' };
      return { el: list[0] };
    },
    visible,
    text(el) {
      return String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    }
  };
  return true;
})()`;

const MASK_SCRIPT = `(() => {
  if (document.getElementById('__tgp_mask')) return true;
  const style = document.createElement('style');
  style.id = '__tgp_mask';
  style.textContent = 'input[type=password],[data-mask]{color:transparent !important;caret-color:transparent !important;}';
  if (document.head) document.head.appendChild(style);
  return true;
})()`;

async function evaluate(cdp, expression, timeoutMs = STEP_TIMEOUT_MS) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);

  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = (details.exception && details.exception.description)
      || details.text
      || '页面脚本执行异常';
    throw new Error(message);
  }
  return result.result ? result.result.value : undefined;
}

async function ensureHelpers(cdp) {
  await evaluate(cdp, PAGE_HELPERS);
}

async function initPage(cdp, viewport) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  await cdp.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024 }).catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function captureScreenshot(cdp, filePath) {
  try {
    await evaluate(cdp, MASK_SCRIPT).catch(() => {});
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    if (!shot || !shot.data) return false;
    fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
    return true;
  } catch {
    return false;
  }
}

function isLocalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (['data:', 'blob:', 'about:', 'chrome:', 'chrome-extension:', 'devtools:'].includes(parsed.protocol)) {
      return true;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

// ---- 单步执行 ----

async function runOpenStep(cdp, step, baseUrl) {
  const url = step.url || `${baseUrl.replace(/\/$/, '')}${step.path}`;
  const nav = await cdp.send('Page.navigate', { url }, STEP_TIMEOUT_MS);
  if (nav.errorText) return { ok: false, detail: `导航失败: ${nav.errorText}`, fatal: true };

  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, 'document.readyState').catch(() => null);
    if (state === 'complete') return { ok: true, detail: `已打开 ${url}`, url };
    await sleep(100);
  }
  return { ok: true, detail: `页面未在时限内 complete，继续执行: ${url}`, url };
}

async function runAssertStep(cdp, step) {
  const expression = `(() => {
    const h = window.__tgpWebCheck;
    const found = h.one(${js(step.selector)});
    if (found.error) return { ok: false, detail: found.error };
    const el = found.el;
    if (${step.visible ? 'true' : 'false'} && !h.visible(el)) {
      return { ok: false, detail: '元素不可见' };
    }
    const text = h.text(el);
    const expects = ${js(step.text || null)};
    if (expects && !expects.some((t) => text.includes(t))) {
      return { ok: false, detail: '文本不匹配，期望包含 ' + expects.join(' / ') + '，实际: ' + text.slice(0, 200) };
    }
    const urlContains = ${js(step.urlContains || null)};
    if (urlContains && !location.href.includes(urlContains)) {
      return { ok: false, detail: 'URL 不含 "' + urlContains + '"，实际: ' + location.href };
    }
    return { ok: true, detail: '断言通过', text: text.slice(0, 200), url: location.href };
  })()`;
  return evaluate(cdp, expression);
}

function expectExpression(expect) {
  return `(() => {
    const h = window.__tgpWebCheck;
    const selector = ${js(expect.selector || null)};
    let el = null;
    if (selector) {
      const found = h.one(selector);
      if (found.error) return { ok: false, detail: '等待目标: ' + found.error };
      el = found.el;
      if (${expect.visible ? 'true' : 'false'} && !h.visible(el)) {
        return { ok: false, detail: '目标已出现但不可见' };
      }
    }
    const expects = ${js(expect.text || null)};
    if (expects) {
      const haystack = el ? h.text(el) : h.text(document.body || document.documentElement);
      if (!expects.some((t) => haystack.includes(t))) {
        return { ok: false, detail: '文本未出现，期望 ' + expects.join(' / ') + '，实际: ' + haystack.slice(0, 200) };
      }
    }
    const urlContains = ${js(expect.urlContains || null)};
    if (urlContains && !location.href.includes(urlContains)) {
      return { ok: false, detail: 'URL 不含 "' + urlContains + '"，实际: ' + location.href };
    }
    return { ok: true, detail: '判据满足' };
  })()`;
}

async function runClickStep(cdp, step) {
  const clickExpression = `(() => {
    const h = window.__tgpWebCheck;
    const found = h.one(${js(step.selector)});
    if (found.error) return { ok: false, detail: found.error };
    const el = found.el;
    if (!h.visible(el)) return { ok: false, detail: '元素不可见，无法点击' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true, detail: '已点击' };
  })()`;

  const clicked = await evaluate(cdp, clickExpression);
  if (!clicked || !clicked.ok) return clicked || { ok: false, detail: '点击失败' };

  const deadline = Date.now() + step.expect.timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(100);
    last = await evaluate(cdp, expectExpression(step.expect));
    if (last && last.ok) return { ok: true, detail: '点击后判据满足' };
  }
  return { ok: false, detail: last ? last.detail : '点击后判据超时' };
}

async function runTypeStep(cdp, step) {
  const expression = `(() => {
    const h = window.__tgpWebCheck;
    const found = h.one(${js(step.selector)});
    if (found.error) return { ok: false, detail: found.error };
    const el = found.el;
    if (!h.visible(el)) return { ok: false, detail: '输入框不可见' };
    el.focus();
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && desc.set) desc.set.call(el, ${js(step.text)});
    else el.value = ${js(step.text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (${step.submit ? 'true' : 'false'}) {
      const form = el.form || (el.closest ? el.closest('form') : null);
      if (!form) return { ok: false, detail: 'submit:true 但输入框不在表单内' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }
    return { ok: true, detail: '已输入' };
  })()`;
  return evaluate(cdp, expression);
}

async function runWaitStep(cdp, step, deadline) {
  if (step.selector) {
    const until = Math.min(deadline, Date.now() + STEP_TIMEOUT_MS);
    let last = null;
    while (Date.now() < until) {
      last = await evaluate(cdp, `(() => {
        const h = window.__tgpWebCheck;
        const found = h.one(${js(step.selector)});
        if (found.error) return { ok: false, detail: found.error };
        if (!h.visible(found.el)) return { ok: false, detail: '元素不可见' };
        return { ok: true, detail: '元素已出现' };
      })()`);
      if (last && last.ok) return { ok: true, detail: '等待元素完成' };
      await sleep(150);
    }
    return { ok: false, detail: last ? last.detail : '等待元素超时' };
  }
  const ms = Math.min(step.ms || 0, Math.max(0, deadline - Date.now()));
  await sleep(ms);
  return { ok: true, detail: `等待 ${ms}ms` };
}

function attachDiagnostics(cdp, consoleErrors, requestFailures, blockedHosts) {
  const push = (list, item) => {
    if (list.length < 100) list.push(item);
  };

  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (!params || params.type !== 'error') return;
    const text = (params.args || []).map((arg) => {
      if (arg && arg.value != null) return String(arg.value);
      return (arg && arg.description) || '';
    }).join(' ');
    push(consoleErrors, {
      type: 'console',
      text: text.slice(0, 500),
      url: (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]
        && params.stackTrace.callFrames[0].url) || '',
    });
  });

  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = (params && params.exceptionDetails) || {};
    push(consoleErrors, {
      type: 'exception',
      text: String((details.exception && details.exception.description) || details.text || '页面异常').slice(0, 500),
      url: details.url || '',
      lineNumber: details.lineNumber,
    });
  });

  cdp.on('Log.entryAdded', (params) => {
    const entry = (params && params.entry) || {};
    if (entry.level !== 'error') return;
    push(consoleErrors, {
      type: 'log',
      text: String(entry.text || '').slice(0, 500),
      url: entry.url || '',
    });
  });

  cdp.on('Network.loadingFailed', (params) => {
    if (!params || params.canceled) return;
    push(requestFailures, {
      errorText: String(params.errorText || '').slice(0, 300),
      type: params.type || '',
    });
  });

  cdp.on('Fetch.requestPaused', (params) => {
    const requestId = params && params.requestId;
    const url = (params && params.request && params.request.url) || '';
    if (!requestId) return;

    if (isLocalUrl(url)) {
      cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }

    try {
      blockedHosts.add(new URL(url).hostname);
    } catch {
      blockedHosts.add(url.slice(0, 100));
    }
    cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
  });
}

function redactStep(step) {
  if (!step) return null;
  return step.type === 'type' ? { ...step, text: '***' } : { ...step };
}

/**
 * 执行一次页面级验收。永不抛出，总是返回结构化结果。
 *
 * verdict:
 *   verified  - 全部步骤通过
 *   failed    - 步骤判据不满足
 *   error     - 基础设施错误（服务/浏览器/CDP/导航）
 */
async function runWebCheck({ coding, userId, taskId, runId, spec }) {
  const startedAt = Date.now();
  const timings = {};
  const result = {
    success: false,
    ok: false,
    verdict: 'error',
    errorKind: 'webCheckError',
    reason: '',
    failedStepIndex: null,
    failedStep: null,
    steps: [],
    consoleErrors: [],
    requestFailures: [],
    blockedHosts: [],
    evidenceDir: '',
    screenshots: [],
    logsTail: '',
    timings,
    server: null,
  };

  let check;
  try {
    check = normalizeWebCheck(spec);
  } catch (error) {
    result.reason = `webCheck 声明非法: ${error.message}`;
    return result;
  }

  if (!check) {
    result.verdict = 'unverified';
    result.errorKind = null;
    result.reason = '本任务未声明 webCheck 判据';
    return result;
  }

  const cwd = coding && typeof coding.taskDir === 'function' ? coding.taskDir(userId, taskId) : '';
  if (!cwd || !fs.existsSync(cwd)) {
    result.reason = `工作区不存在: ${taskId}`;
    return result;
  }

  const key = (coding.userKey && coding.userKey(userId)) || 'anonymous';
  const safeTask = (coding.safeTaskId && coding.safeTaskId(taskId)) || 'unknown';
  const baseRunId = String(runId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || `run_${startedAt}`;
  let evidenceDir = path.join(path.dirname(coding.workspaces), 'evidence', key, safeTask, baseRunId);
  try {
    let suffix = 2;
    while (fs.existsSync(evidenceDir) && fs.readdirSync(evidenceDir).length > 0) {
      evidenceDir = path.join(path.dirname(coding.workspaces), 'evidence', key, safeTask, `${baseRunId}_${suffix++}`);
    }
    fs.mkdirSync(evidenceDir, { recursive: true });
  } catch (error) {
    result.reason = `创建证据目录失败: ${error.message}`;
    return result;
  }
  result.evidenceDir = evidenceDir;

  const gitHead = coding.git ? coding.git(userId, taskId, ['rev-parse', 'HEAD']) : { success: false };
  const gitSha = gitHead.success ? String(gitHead.output || '').trim() : '';

  const consoleErrors = [];
  const requestFailures = [];
  const blockedHosts = new Set();

  let server = null;
  let browser = null;
  let cdp = null;
  let watchdog = null;

  try {
    let baseUrl = check.baseUrl;
    let deadline = startedAt + check.timeoutMs;

    if (check.start) {
      timings.serverStartMs = Date.now() - startedAt;
      server = await startServer(check.start, { cwd });
      result.server = {
        pid: server.pid,
        baseUrl: '',
        command: check.start.command,
        args: check.start.args,
      };

      const ready = await waitReady(server, check.start);
      if (!ready.ok) {
        result.verdict = 'error';
        result.errorKind = 'buildFailed';
        result.reason = ready.error;
        return result;
      }
      baseUrl = ready.baseUrl;
      result.server.baseUrl = baseUrl;
      timings.serverReadyMs = Date.now() - startedAt;
    }

    if (!baseUrl) {
      result.reason = '缺少可访问的 baseUrl';
      return result;
    }
    if (!isLocalUrl(baseUrl)) {
      result.reason = `webCheck 只允许访问本地服务，拒绝: ${baseUrl}`;
      return result;
    }

    // 整体超时兜底：步骤循环之外再杀一次服务，避免 dev server 挂住
    watchdog = setInterval(() => {
      if (Date.now() > deadline + 5000) stopServer(server);
    }, 5000);
    watchdog.unref?.();

    timings.browserLaunchMs = Date.now() - startedAt;
    browser = await launchBrowser({ viewport: check.viewport });
    cdp = browser.cdp;
    attachDiagnostics(cdp, consoleErrors, requestFailures, blockedHosts);

    await initPage(cdp, check.viewport);
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    timings.browserReadyMs = Date.now() - startedAt;

    let failed = null;

    for (let index = 0; index < check.steps.length; index += 1) {
      const step = check.steps[index];

      if (Date.now() > deadline) {
        failed = { index, step, detail: `整体超时（${check.timeoutMs}ms）`, fatal: true };
        break;
      }

      const stepStarted = Date.now();
      let stepResult;
      try {
        await ensureHelpers(cdp);
        switch (step.type) {
          case 'open':
            stepResult = await runOpenStep(cdp, step, baseUrl);
            break;
          case 'assert':
            stepResult = await runAssertStep(cdp, step);
            break;
          case 'click':
            stepResult = await runClickStep(cdp, step);
            break;
          case 'type':
            stepResult = await runTypeStep(cdp, step);
            break;
          case 'wait':
            stepResult = await runWaitStep(cdp, step, deadline);
            break;
          default:
            stepResult = { ok: false, detail: `未知步骤类型: ${step.type}`, fatal: true };
        }
      } catch (error) {
        stepResult = { ok: false, detail: error.message || String(error), fatal: true };
      }

      const entry = {
        index,
        type: step.type,
        ok: !!(stepResult && stepResult.ok),
        detail: (stepResult && stepResult.detail) || '',
        screenshot: '',
        durationMs: Date.now() - stepStarted,
      };
      result.steps.push(entry);

      if (!entry.ok) {
        const shotPath = path.join(evidenceDir, `failure-${index}.png`);
        if (await captureScreenshot(cdp, shotPath)) {
          entry.screenshot = shotPath;
          result.screenshots.push(shotPath);
        }
        failed = {
          index,
          step,
          detail: entry.detail || '步骤失败',
          fatal: !!(stepResult && stepResult.fatal),
        };
        break;
      }
    }

    if (!failed) {
      const finalShot = path.join(evidenceDir, 'final.png');
      if (await captureScreenshot(cdp, finalShot)) result.screenshots.push(finalShot);

      result.success = true;
      result.ok = true;
      result.verdict = 'verified';
      result.errorKind = null;
      result.reason = `webCheck 全部通过（${check.steps.length} 步）`;
    } else {
      result.failedStepIndex = failed.index;
      result.failedStep = redactStep(failed.step);
      result.verdict = failed.fatal ? 'error' : 'failed';
      result.errorKind = failed.fatal ? 'webCheckError' : 'webCheck';
      result.reason = `第 ${failed.index + 1} 步（${failed.step.type}）失败: ${failed.detail}`;
    }
  } catch (error) {
    result.verdict = 'error';
    result.errorKind = 'webCheckError';
    result.reason = (error && error.message) || String(error);
  } finally {
    if (watchdog) clearInterval(watchdog);
    if (browser) {
      try { browser.close(); } catch { /* ignore */ }
    }
    stopServer(server);

    result.consoleErrors = consoleErrors.slice(0, 100);
    result.requestFailures = requestFailures.slice(0, 100);
    result.blockedHosts = [...blockedHosts];
    if (server) result.logsTail = server.tail();
    timings.totalMs = Date.now() - startedAt;
    result.timings = timings;

    try {
      if (server && server.logText) {
        fs.writeFileSync(path.join(evidenceDir, 'server.log'), server.logText, 'utf8');
      }
      if (consoleErrors.length) {
        fs.writeFileSync(
          path.join(evidenceDir, 'console.log'),
          consoleErrors.map((item) => `[${item.type}] ${item.text}`).join('\n'),
          'utf8',
        );
      }
      writeJsonAtomicSync(path.join(evidenceDir, 'manifest.json'), {
        taskId: String(taskId || ''),
        runId: baseRunId,
        userKey: key,
        gitSha,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        verdict: result.verdict,
        errorKind: result.errorKind,
        reason: result.reason,
        failedStepIndex: result.failedStepIndex,
        failedStep: result.failedStep,
        webCheck: {
          ...check,
          steps: check.steps.map(redactStep),
        },
        steps: result.steps,
        consoleErrors: result.consoleErrors,
        requestFailures: result.requestFailures,
        blockedHosts: result.blockedHosts,
        server: result.server,
        timings: result.timings,
      });
    } catch {
      /* 证据落盘失败不影响主流程 */
    }
  }

  return result;
}

module.exports = {
  normalizeWebCheck,
  runWebCheck,
  findBrowserExecutable,
  launchBrowser,
  killTreeSync,
  sleep,
  httpGetJson,
  CdpClient,
  constants: {
    MAX_STEPS,
    MAX_TEXT,
    DEFAULT_VIEWPORT,
    STEP_TIMEOUT_MS,
    EXPECT_TIMEOUT_MS,
    CDP_TIMEOUT_MS,
    LOCAL_HOSTS,
  },
};
