'use strict';

// 冷启动保护：进程从「起来」到「初始化完成」之间是最脆弱的窗口。
// 这段时间里环境变量可能被注入预加载、初始化出错会导致半死状态、
// 外部请求也可能在角色/记忆没加载完时打进来，拿到一份空状态。
// 这里只做三件事：启动前体检（启动注入 + 流量劫持面）、就绪前闸门、就绪前崩溃即退。

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');

let ready = false;
let bootAt = Date.now();

// 临时目录、下载目录、公共目录是投毒重灾区，进程入口落在这里一律当可疑。
// 桌面不放进来：开发时项目本身就在桌面上，放进来会把自己判成劫持
function suspiciousRoots() {
  const roots = [];
  const home = os.homedir();
  roots.push(os.tmpdir());
  if (home) {
    roots.push(path.join(home, 'Downloads'));
  }
  if (process.platform === 'win32') {
    const drive = process.env.SystemDrive || 'C:';
    roots.push(path.join(drive, 'Users', 'Public'));
  }
  return roots.filter(Boolean).map((dir) => path.resolve(dir).toLowerCase());
}

function inSuspiciousDir(file) {
  if (!file) return false;
  const target = path.resolve(file).toLowerCase();
  return suspiciousRoots().some((root) => target === root || target.startsWith(root + path.sep));
}

// 流量劫持面：本机能让我们和模型 API 之间的对话被中途看/改的开关就这几处。
// 它们都必须在进程启动前由外部环境设好，所以在这里一次性查完最省事
const API_URL_KEYS = [
  'DOUBAO_API_URL',
  'DEEPSEEK_API_URL',
  'EMBEDDING_API_URL',
  'VISION_API_URL',
  'QDRANT_URL',
  'TTS_API_URL'
];
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

function hostsFilePath() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return path.join(root, 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

// 本机服务（Ollama / 本地 Qdrant 之类）本来就落在 hosts 里的 localhost 行上，
// 把它当成"被改指"会直接误杀自己的配置，所以这类主机名不参与比对
const LOCAL_API_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isLocalApiHost(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_API_HOSTS.has(name) || name.endsWith('.localhost');
}

// 从配置里取出真正要连的主机名，再去和 hosts 文件对。
// extraUrls 用来补上「运行时才确定」的实际地址（例如网页端配的 apiUrl 不在 env 里）
function apiHosts(env = process.env, extraUrls = []) {
  const hosts = new Set();
  const urls = API_URL_KEYS.map((key) => env[key]).concat(extraUrls);
  urls.forEach((raw) => {
    const text = String(raw || '').trim();
    if (!text) return;
    try {
      const host = new URL(text).hostname.toLowerCase();
      if (host && !isLocalApiHost(host)) hosts.add(host);
    } catch {
      // 不是完整 URL 就不参与比对
    }
  });
  return hosts;
}

// 私有/保留网段：DNS 污染和「把域名指到本地反代」最终都会落在这里
const PRIVATE_V4_BLOCKS = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
  ['0.0.0.0', 8],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
];

function ipv4ToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateAddress(ip) {
  const text = String(ip || '').trim().toLowerCase();
  if (!text) return true;
  if (text === '::1' || text === '::') return true;
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (text.includes(':')) {
    if (/^f[cd][0-9a-f]{2}:/.test(text)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(text)) return true; // fe80::/10 链路本地
    return false;
  }
  const value = ipv4ToInt(text);
  if (value === null) return true;
  return PRIVATE_V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

// 解析结果全落在内网/回环，说明这个域名被指到了本机或局域网——
// 正常 API 不可能这样，等同于「DNS 污染 / 本地反代中间人」
function evaluateLookup(hostname, addresses) {
  if (isLocalApiHost(hostname)) return;
  const list = (addresses || []).filter((item) => item && item.address);
  if (!list.length) return;
  const privates = list.filter((item) => isPrivateAddress(item.address));
  if (privates.length !== list.length) return;
  if (process.env.COLD_START_ALLOW_PRIVATE_RESOLVE === '1') return;
  const err = new Error(
    `解析结果落在内网/回环，疑似 DNS 污染或本地反代：${hostname} → ${privates.map((item) => item.address).join(', ')}`
  );
  err.code = 'DNS_PRIVATE_ADDRESS';
  throw err;
}

// 直接给 https.request / Agent 用的 lookup：解析完先判一次地址，再交给连接。
// mode=public-only 用于明文 HTTP：内网目标放行（局域网 Qdrant 之类），
// 公网地址一律拒绝——否则 API Key 会以明文出网
function makeLookup(mode) {
  return function lookupFn(hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : options || {};
    const cb = typeof options === 'function' ? options : callback;
    dns.lookup(hostname, opts, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      try {
        evaluateLookup(hostname, list);
        if (mode === 'public-only' && !isLocalApiHost(hostname)) {
          const allPrivate = list.length > 0 && list.every((item) => isPrivateAddress(item.address));
          if (!allPrivate && process.env.COLD_START_ALLOW_PLAIN_PUBLIC !== '1') {
            const err2 = new Error(`公网地址不允许明文 HTTP（凭据会裸奔）：${hostname}`);
            err2.code = 'PLAIN_HTTP_PUBLIC';
            throw err2;
          }
        }
      } catch (blocked) {
        return cb(blocked);
      }
      return cb(null, address, family);
    });
  };
}

const safeLookup = makeLookup('default');
const safeLookupPlain = makeLookup('public-only');

// ---- 证书固定（TOFU）----
// 检测配置只能发现"链路被改"，验指纹才能确认"对端是谁"：
// 就算攻击者改了 hosts、又装了系统信任的 CA，也拿不到真实服务器的私钥
function pinsPath() {
  return process.env.COLD_START_PINS_FILE || path.join(__dirname, '..', '..', 'data', 'security', 'pins.json');
}

// 影子副本：单独删掉主文件不该等于"重置信任"，两份都在才叫干净
function pinsShadowPath() {
  return `${pinsPath()}.shadow`;
}

let pinsCache = null;

function persistPins(pins) {
  const body = JSON.stringify({ version: 1, pins }, null, 2);
  const file = pinsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  try {
    fs.writeFileSync(pinsShadowPath(), body);
  } catch {
    // 影子副本写不了不影响主文件
  }
}

function loadPins() {
  if (pinsCache) return pinsCache;
  const file = pinsPath();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    pinsCache = data && typeof data.pins === 'object' && data.pins ? data.pins : {};
    return pinsCache;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      try {
        const shadow = JSON.parse(fs.readFileSync(pinsShadowPath(), 'utf8'));
        if (shadow && shadow.pins && Object.keys(shadow.pins).length) {
          pinsCache = shadow.pins;
          persistPins(pinsCache);
          console.warn('[冷启动] 证书基线主文件缺失，已从影子副本恢复');
          return pinsCache;
        }
      } catch {
        // 影子也没有：当作首次
      }
      pinsCache = {};
      return pinsCache;
    }
    // 文件存在但读不出来：不能当成"首次连接"重新 TOFU，
    // 否则删改 pins.json 就等于一键重置信任、绕过证书固定
    console.warn(`[冷启动] 证书指纹文件损坏，拒绝重建基线：${file}`);
    pinsCache = { __broken__: String((err && err.message) || err) };
    return pinsCache;
  }
}

function savePins(pins) {
  try {
    persistPins(pins);
    pinsCache = pins;
  } catch (err) {
    console.warn(`[冷启动] 证书指纹落盘失败：${err.message}`);
  }
}

function resetPinCache() {
  pinsCache = null;
}

// 用公钥（SPKI）而不是整张证书：同一把钥匙换发证书不算变化
function pinOf(cert) {
  if (!cert || !cert.pubkey) return '';
  return `sha256/${crypto.createHash('sha256').update(cert.pubkey).digest('base64')}`;
}

function issuerText(cert) {
  try {
    return JSON.stringify((cert && cert.issuer) || {});
  } catch {
    return '';
  }
}

function pinList(entry) {
  if (Array.isArray(entry)) return entry;
  if (entry && Array.isArray(entry.prints)) return entry.prints;
  return [];
}

function setPins(pins, name, prints, source) {
  pins[name] = { prints: Array.from(new Set(prints)), addedAt: new Date().toISOString(), source };
  return pins;
}

// 纯逻辑：store 传进来便于测试
function verifyPinned(hostname, cert, store, source = 'handshake') {
  if (isLocalApiHost(hostname)) return { ok: true, pinned: false, reason: 'local' };
  if (store && store.__broken__) return { ok: false, pinned: false, reason: 'pins-broken' };
  const pin = pinOf(cert);
  if (!pin) return { ok: true, pinned: false, reason: 'no-pubkey' };
  const name = String(hostname || '').toLowerCase();
  const pins = store || {};
  const known = pinList(pins[name]);
  if (known.length) {
    if (known.includes(pin)) return { ok: true, pinned: true, reason: 'match' };
    return { ok: false, pinned: true, reason: 'mismatch' };
  }
  // 首次见到时先看签发者：抓包工具的 CA 不能进基线，否则等于把中间人钉死
  if (matchMitmCa([issuerText(cert)]).length) return { ok: false, pinned: false, reason: 'mitm-issuer' };
  setPins(pins, name, [pin], source);
  return { ok: true, pinned: false, reason: 'pinned-first' };
}

// 交给 tls 的 checkServerIdentity：返回 undefined 才算通过
function checkPinnedIdentity(hostname, cert) {
  const pins = loadPins();
  const result = verifyPinned(hostname, cert, pins);
  if (result.reason === 'pinned-first') savePins(pins);
  if (result.ok) return undefined;
  if (result.reason === 'mismatch' && process.env.COLD_START_ALLOW_PIN_MISMATCH === '1') {
    const name = String(hostname || '').toLowerCase();
    setPins(pins, name, [...pinList(pins[name]), pinOf(cert)], 'relaxed');
    savePins(pins);
    console.warn(`[冷启动] 证书指纹变化已放行并追加基线：${name}`);
    return undefined;
  }
  lastTraffic = {
    checkedAt: Date.now(),
    alertCount: 1,
    alerts: [{ label: '证书指纹', value: `${hostname} ${result.reason}` }]
  };
  const err = new Error(`证书公钥指纹与基线不一致（${hostname}），可能存在中间人：${result.reason}`);
  err.code = 'PIN_MISMATCH';
  return err;
}

// 启动时就把基线定下来：把 TOFU 从「第一次聊天」提前到「服务启动」，
// 指纹直接打在日志里看得见；网络不通就跳过，不挡启动
let probeStarted = false;

function probePins(env = process.env, logger = console) {
  if (probeStarted) return Promise.resolve([]);
  probeStarted = true;
  const hosts = Array.from(apiHosts(env));
  if (!hosts.length) return Promise.resolve([]);
  const probeOne = (host) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ host, ...result });
      };
      let socket;
      try {
        // 探测本身也要过 lookup 校验：DNS 被指到内网时不能把本地反代的证书钉进基线
        socket = tls.connect({
          host,
          port: 443,
          servername: host,
          timeout: 6000,
          rejectUnauthorized: false,
          lookup: safeLookup
        });
      } catch (err) {
        finish({ ok: false, reason: err.message });
        return;
      }
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        const pins = loadPins();
        const result = verifyPinned(host, cert, pins, 'probe');
        if (result.reason === 'pinned-first') {
          savePins(pins);
          logger.log(`[冷启动] 已记录 ${host} 的公钥指纹 ${pinOf(cert)}（首次基线）`);
        } else if (result.ok) {
          logger.log(`[冷启动] ${host} 证书指纹与基线一致`);
        } else {
          logger.warn(`[冷启动] ${host} 证书指纹异常（${result.reason}），运行期外连会被熔断`);
        }
        socket.end();
        finish({ ok: result.ok, reason: result.reason });
      });
      socket.once('timeout', () => {
        socket.destroy();
        finish({ ok: false, reason: 'timeout' });
      });
      socket.once('error', (err) => finish({ ok: false, reason: err.code || err.message }));
    });
  return Promise.all(hosts.map(probeOne));
}

// ---- 诱饵凭据 ----
// .env 里放一个正常业务永不使用的假 Key。任何请求里出现它，就说明有人读了配置并拿去用了
function canaryToken() {
  const raw = String(process.env.COLD_START_CANARY || '').trim();
  return raw.length >= 8 ? raw : '';
}

function findCanary(text) {
  const token = canaryToken();
  if (!token) return false;
  return typeof text === 'string' && text.includes(token);
}

function assertNoCanary(parts) {
  const token = canaryToken();
  if (!token) return;
  const haystack = (parts || [])
    .map((part) => (typeof part === 'string' ? part : ''))
    .join('\n');
  if (!haystack.includes(token)) return;
  const err = new Error('外连请求里出现了诱饵凭据，疑似配置被读取并冒用');
  err.code = 'CANARY_LEAK';
  throw err;
}

// 命中 host 本身或其子域才算；只看精确匹配，避免把 .com 这种后缀当成命中
function matchHosts(text, hosts) {
  const hits = [];
  if (!text || !hosts || !hosts.size) return hits;
  String(text).split(/\r?\n/).forEach((line) => {
    const body = line.split('#')[0].trim();
    if (!body) return;
    const parts = body.split(/\s+/);
    if (parts.length < 2) return;
    parts.slice(1).forEach((name) => {
      const target = name.toLowerCase();
      hosts.forEach((host) => {
        if (target === host || target.endsWith('.' + host)) hits.push(`${parts[0]} ${name}`);
      });
    });
  });
  return hits;
}

// hosts 可能被 adblock 类工具撑到十万行，按 mtime+size 缓存，没变就不重读。
// 运行期改 hosts 会同时改动这两项，缓存不会掩盖劫持
let hostsCache = { key: '', text: '' };

function readHostsFile() {
  const file = hostsFilePath();
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (hostsCache.key === key) return hostsCache.text;
    const text = fs.readFileSync(file, 'utf8');
    hostsCache = { key, text };
    return text;
  } catch {
    return '';
  }
}

function inspectTraffic(env = process.env, hostsText = readHostsFile(), extraUrls = []) {
  const alerts = [];
  const notes = [];
  const add = (label, value, reason) => alerts.push({ label, value: String(value), reason });
  const note = (label, value, reason) => notes.push({ label, value: String(value), reason });

  if (String(env.NODE_TLS_REJECT_UNAUTHORIZED || '').trim() === '0') {
    add(
      'NODE_TLS_REJECT_UNAUTHORIZED',
      '0',
      '证书校验被关掉，任何自签中间人都能冒充模型 API，连带把我们的 Key 看走'
    );
  }
  const extraCa = String(env.NODE_EXTRA_CA_CERTS || '').trim();
  if (extraCa) {
    add('NODE_EXTRA_CA_CERTS', extraCa, '额外信任了一张根证书，签发权等于交给了这个文件');
  }
  const keylog = String(env.SSLKEYLOGFILE || '').trim();
  if (keylog) {
    add('SSLKEYLOGFILE', keylog, 'TLS 会话密钥会落盘，抓包工具能离线解开我们的全部流量');
  }

  const proxies = PROXY_KEYS.filter((key) => String(env[key] || '').trim());
  if (proxies.length) {
    const value = proxies.map((key) => `${key}=${env[key]}`).join(' ');
    note('代理', value, '请求会先经这个代理；自己的代理正常，来路不明的要查清');
  }

  const hits = matchHosts(hostsText, apiHosts(env, extraUrls));
  if (hits.length) {
    add('hosts', hits.join('；'), '模型 API 域名被 hosts 改指到别的地址，请求会先到攻击者机器');
  }

  return { success: alerts.length === 0, hijacked: alerts.length > 0, alertCount: alerts.length, alerts, notes };
}

// 抓包工具装完根证书后，任何 https 都能被它解开。只按名字认，不做取证：
// 命中名单就当「本机存在能解密我们流量的中间人」
const MITM_CA_HINTS = [
  'clash',
  'mihomo',
  'fiddler',
  'charles',
  'mitmproxy',
  'burp',
  'proxyman',
  'httptoolkit',
  'whistle',
  'anyproxy',
  'reqable'
];

function matchMitmCa(subjects) {
  const hits = [];
  (subjects || []).forEach((subject) => {
    const text = String(subject || '').trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (MITM_CA_HINTS.some((hint) => lower.includes(hint))) hits.push(text);
  });
  return hits;
}

// 根证书库只在启动时扫一次；扫不出来（超时/权限）就当没发现，不因此挡住启动
function scanTrustedRoots() {
  if (process.platform !== 'win32') return [];
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    'Get-ChildItem Cert:\\LocalMachine\\Root,Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { $_.Subject }';
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    });
    return matchMitmCa(String(out || '').split(/\r?\n/));
  } catch {
    return [];
  }
}

// 原生模块（.node）从临时/下载目录加载，等于把本机代码直接放进了进程
function inspectNativeModules() {
  const alerts = [];
  try {
    const report = process.report && typeof process.report.getReport === 'function' ? process.report.getReport() : null;
    const shared = (report && report.sharedObjects) || [];
    shared.forEach((file) => {
      if (!/\.node$/i.test(file)) return;
      if (!inSuspiciousDir(file)) return;
      alerts.push({
        label: '原生模块',
        value: file,
        reason: '从临时/下载/公共目录加载的 .node，等同于把外部代码注入进程'
      });
    });
  } catch {
    // 取不到进程报告就跳过
  }
  return alerts;
}

// 启动注入：能往 Node 启动流程里塞代码的地方只有这几处
function inspectEnv(env = process.env, execArgv = process.execArgv) {
  const alerts = [];
  const notes = [];
  const add = (label, value, reason) => alerts.push({ label, value: String(value), reason });
  const note = (label, value, reason) => notes.push({ label, value: String(value), reason });

  const options = String(env.NODE_OPTIONS || '').trim();
  if (options) {
    if (/--(require|import|loader|experimental-loader)\b/.test(options)) {
      add('NODE_OPTIONS', options, '含预加载/加载器参数，等于让外部文件进我们的启动流程');
    } else {
      note('NODE_OPTIONS', options, '存在但不含预加载参数，仅记录');
    }
    if (/--inspect(-brk)?\b/.test(options)) {
      note('NODE_OPTIONS', options, '开了调试端口，本机其它进程可接入');
    }
  }

  if (String(env.NODE_PATH || '').trim()) {
    note('NODE_PATH', env.NODE_PATH, '会改变模块解析顺序，若非本机自设请清掉');
  }

  (Array.isArray(execArgv) ? execArgv : []).forEach((arg) => {
    if (/^--(require|import|loader|experimental-loader)$/.test(arg)) {
      add('execArgv', arg, '进程启动参数里带预加载，不是我们自己传的就要怀疑');
    }
  });

  const entry = (process.argv && process.argv[1]) || '';
  if (inSuspiciousDir(entry)) {
    add('进程入口', entry, '入口文件落在临时/下载/公共目录，典型的投毒落点');
  }

  const traffic = inspectTraffic(env);
  alerts.push(...traffic.alerts);
  notes.push(...traffic.notes);
  alerts.push(...inspectNativeModules());

  return {
    success: alerts.length === 0,
    hijacked: alerts.length > 0,
    alertCount: alerts.length,
    alerts,
    notes,
    info: {
      execPath: process.execPath,
      entry,
      cwd: process.cwd(),
      pid: process.pid,
      ppid: process.ppid,
      execArgv: Array.isArray(execArgv) ? execArgv.slice() : []
    }
  };
}

// 运行期复核：hosts 随时能被改，而 Node 每次连接都会重新走系统解析，
// 所以启动时查一次不够。每次外连前再查，命中就熔断这一次调用——
// 宁可不说话，也别把 Key 顺着被改指的域名送出去
let bypassWarned = false;
let lastTraffic = { checkedAt: null, alertCount: 0, alerts: [] };

function assertTrafficSafe(env = process.env, extraUrls = []) {
  const report = inspectTraffic(env, readHostsFile(), extraUrls);
  lastTraffic = { checkedAt: Date.now(), alertCount: report.alertCount, alerts: report.alerts };
  if (!report.hijacked) return report;
  const detail = report.alerts.map((item) => `${item.label}=${item.value}`).join('；');
  if (env.COLD_START_ALLOW_INJECT === '1') {
    if (!bypassWarned) {
      bypassWarned = true;
      console.warn(`[冷启动] 流量面异常但已显式放行，外连继续：${detail}`);
    }
    return report;
  }
  const err = new Error(`检测到流量劫持面，已熔断外连：${detail}`);
  err.code = 'TRAFFIC_HIJACK';
  err.alerts = report.alerts;
  throw err;
}

// 给探针用的最近一次复核结果
function trafficStatus() {
  return {
    checkedAt: lastTraffic.checkedAt,
    alertCount: lastTraffic.alertCount,
    alerts: lastTraffic.alerts.slice(0, 5)
  };
}

// 统一出网闸门：项目里 axios 是主要客户端（embedding / Qdrant / TTS / 研究与插件），
// 在全局实例上挂一次 request 拦截器，所有 axios 出网共用同一道复核
function installAxiosCircuit(axios) {
  if (!axios || !axios.interceptors || axios.__coldStartCircuit) return false;
  // 给 axios 换上带 lookup 校验的 agent：域名解析出内网/回环地址时直接拒绝连接
  const https = require('https');
  const http = require('http');
  const agents = {
    'https:': new https.Agent({ lookup: safeLookup, checkServerIdentity: checkPinnedIdentity }),
    'http:': new http.Agent({ lookup: safeLookupPlain })
  };
  axios.interceptors.request.use((config) => {
    assertTrafficSafe(process.env, [config && config.url]);
    assertNoCanary([
      config && config.url,
      JSON.stringify((config && config.headers) || {}),
      typeof (config && config.data) === 'string' ? config.data : ''
    ]);
    const target = String((config && config.url) || '');
    const full = /^https?:/i.test(target) ? target : String((config && config.baseURL) || '');
    const scheme = /^http:/i.test(full) ? 'http:' : 'https:';
    if (scheme === 'https:' && !config.httpsAgent) config.httpsAgent = agents['https:'];
    if (scheme === 'http:' && !config.httpAgent) config.httpAgent = agents['http:'];
    return config;
  });
  axios.__coldStartCircuit = true;
  return true;
}

// 启动前体检：有问题就拒绝启动，除非显式放行（COLD_START_ALLOW_INJECT=1）
function preflight(logger = console) {
  const report = inspectEnv();

  // 根证书库有抓包工具的 CA，就等于我们跟 API 的 https 可被解密
  if (process.env.COLD_START_SKIP_CA_SCAN !== '1') {
    scanTrustedRoots().forEach((subject) => {
      report.alerts.push({
        label: '可信根证书',
        value: subject,
        reason: '本机装了抓包工具的根证书，跟 API 的 https 可被它解开'
      });
    });
    report.alertCount = report.alerts.length;
    report.hijacked = report.alertCount > 0;
    report.success = !report.hijacked;
  }

  if (report.hijacked) {
    logger.error('[冷启动] 检测到启动注入：');
    report.alerts.forEach((item) => {
      logger.error(`[冷启动]   ${item.label} = ${item.value}（${item.reason}）`);
    });
    if (process.env.COLD_START_ALLOW_INJECT !== '1') {
      logger.error('[冷启动] 已拒绝启动。确认可控后在 .env 里设 COLD_START_ALLOW_INJECT=1 再试。');
      return false;
    }
    logger.warn('[冷启动] COLD_START_ALLOW_INJECT=1，带注入继续启动');
  }
  report.notes.forEach((item) => {
    logger.warn(`[冷启动] 提示：${item.label} = ${item.value}（${item.reason}）`);
  });
  return true;
}

// 就绪闸门：静态资源照常给，/api 在初始化完成前一律 503，避免拿到空状态
function gate() {
  return (req, res, next) => {
    const p = req.path || req.url || '';
    // 就绪探针：无论是否就绪都能拿到明确答复，顺带带上最近一次流量复核结果
    if (p === '/api/health/ready') {
      return res.status(200).json({ ready, bootMs: Date.now() - bootAt, traffic: trafficStatus() });
    }
    if (ready) return next();
    if (!p.startsWith('/api')) return next();
    res.setHeader('Retry-After', '1');
    return res.status(503).json({
      success: false,
      code: 'COLD_START',
      message: '服务正在冷启动，初始化完成后自动恢复',
      bootMs: Date.now() - bootAt
    });
  };
}

function markReady() {
  ready = true;
  return Date.now() - bootAt;
}

function isReady() {
  return ready;
}

function bootMs() {
  return Date.now() - bootAt;
}

// 初始化未完成就崩溃时直接退出，别留一个端口在听、内部却是空壳的进程
function installCrashGuard(logger = console) {
  const die = (kind, err) => {
    const detail = err && err.stack ? err.stack : String(err);
    if (!ready) {
      logger.error(`[冷启动] ${kind}，初始化未完成，直接退出：\n${detail}`);
      process.exit(1);
      return;
    }
    logger.error(`[冷启动] ${kind}（已就绪，仅记录）：\n${detail}`);
  };
  process.on('uncaughtException', (err) => die('未捕获异常', err));
  process.on('unhandledRejection', (err) => die('未处理的 Promise 拒绝', err));
}

// 测试用：把就绪状态与启动时间复位
function reset() {
  ready = false;
  bootAt = Date.now();
}

module.exports = {
  inspectEnv,
  inspectTraffic,
  assertTrafficSafe,
  trafficStatus,
  installAxiosCircuit,
  isPrivateAddress,
  evaluateLookup,
  safeLookup,
  safeLookupPlain,
  pinOf,
  pinList,
  loadPins,
  resetPinCache,
  verifyPinned,
  checkPinnedIdentity,
  probePins,
  canaryToken,
  findCanary,
  assertNoCanary,
  matchMitmCa,
  scanTrustedRoots,
  inspectNativeModules,
  apiHosts,
  matchHosts,
  preflight,
  gate,
  markReady,
  isReady,
  bootMs,
  installCrashGuard,
  reset
};
