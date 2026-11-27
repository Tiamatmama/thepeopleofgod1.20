const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const coldStart = require('../src/core/coldStart');

function labels(report) {
  return report.alerts.map((item) => item.label);
}

test('inspectTraffic：干净环境不误报', () => {
  const report = coldStart.inspectTraffic({}, '');
  assert.equal(report.hijacked, false);
  assert.equal(report.alertCount, 0);
});

test('inspectTraffic：关掉证书校验要被拦住', () => {
  const report = coldStart.inspectTraffic({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, '');
  assert.equal(report.hijacked, true);
  assert.deepEqual(labels(report), ['NODE_TLS_REJECT_UNAUTHORIZED']);
});

test('inspectTraffic：注入根证书要被拦住', () => {
  const report = coldStart.inspectTraffic({ NODE_EXTRA_CA_CERTS: path.join('tmp', 'evil.pem') }, '');
  assert.equal(report.hijacked, true);
  assert.deepEqual(labels(report), ['NODE_EXTRA_CA_CERTS']);
});

test('inspectTraffic：导出会话密钥要被拦住', () => {
  const report = coldStart.inspectTraffic({ SSLKEYLOGFILE: path.join('tmp', 'keys.log') }, '');
  assert.equal(report.hijacked, true);
  assert.deepEqual(labels(report), ['SSLKEYLOGFILE']);
});

test('inspectTraffic：代理只提示不拦', () => {
  const report = coldStart.inspectTraffic({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, '');
  assert.equal(report.hijacked, false);
  assert.equal(report.notes.length, 1);
  assert.match(report.notes[0].value, /127\.0\.0\.1:7897/);
});

test('matchHosts：API 域名被 hosts 改指时命中', () => {
  const env = {
    DOUBAO_API_URL: 'https://ark.cn-beijing.volces.com/api/v3',
    DEEPSEEK_API_URL: 'https://api.deepseek.com/v1'
  };
  const hosts = coldStart.apiHosts(env);
  assert.equal(hosts.size, 2);
  const text = ['127.0.0.1 ark.cn-beijing.volces.com', '10.0.0.9 api.deepseek.com', '127.0.0.1 localhost'].join(
    '\n'
  );
  const hits = coldStart.matchHosts(text, hosts);
  assert.equal(hits.length, 2);
});

test('matchHosts：同名后缀不算命中，子域才算', () => {
  const hosts = new Set(['api.deepseek.com']);
  // 只是后缀相同、绑在别的域名上，不能算
  assert.equal(coldStart.matchHosts('1.2.3.4 notapi.deepseek.com', hosts).length, 0);
  // 真正的子域是攻击者可以拿来冒充的，要算
  assert.equal(coldStart.matchHosts('1.2.3.4 evil.api.deepseek.com', hosts).length, 1);
  // 注释行忽略
  assert.equal(coldStart.matchHosts('# 127.0.0.1 api.deepseek.com', hosts).length, 0);
});

test('inspectEnv：流量告警会并入启动体检', () => {
  const report = coldStart.inspectEnv({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, []);
  assert.equal(report.hijacked, true);
  assert.ok(labels(report).includes('NODE_TLS_REJECT_UNAUTHORIZED'));
});

test('inspectEnv：启动参数预加载与流量注入同时报出', () => {
  const report = coldStart.inspectEnv({ SSLKEYLOGFILE: 'keys.log' }, ['--require', 'evil.js']);
  assert.equal(report.hijacked, true);
  assert.equal(report.alertCount, 2);
  assert.ok(labels(report).includes('execArgv'));
  assert.ok(labels(report).includes('SSLKEYLOGFILE'));
});

test('assertTrafficSafe：干净环境放行外连', () => {
  const report = coldStart.assertTrafficSafe({});
  assert.equal(report.hijacked, false);
});

test('assertTrafficSafe：运行期出现劫持面就熔断', () => {
  assert.throws(
    () => coldStart.assertTrafficSafe({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    (err) => err.code === 'TRAFFIC_HIJACK' && /已熔断外连/.test(err.message)
  );
});

test('assertTrafficSafe：显式放行时只提示不熔断', () => {
  const report = coldStart.assertTrafficSafe({
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    COLD_START_ALLOW_INJECT: '1'
  });
  assert.equal(report.hijacked, true);
});

test('apiHosts：本机服务不参与 hosts 比对，避免误杀自己的配置', () => {
  const hosts = coldStart.apiHosts({ QDRANT_URL: 'http://localhost:6333' });
  assert.equal(hosts.size, 0);
  // Windows 默认 hosts 里就有这条，误报会让服务直接起不来
  const report = coldStart.inspectTraffic({ QDRANT_URL: 'http://127.0.0.1:6333' }, '127.0.0.1 localhost');
  assert.equal(report.hijacked, false);
});

test('assertTrafficSafe：网页端配的 apiUrl 也会被纳入比对', () => {
  // env 里没有这个域名，但它是本次真正要连的地址
  const env = { QDRANT_URL: 'http://localhost:6333' };
  const hostsText = '10.0.0.9 ark.cn-beijing.volces.com';
  const report = coldStart.inspectTraffic(env, hostsText, ['https://ark.cn-beijing.volces.com/api/v3']);
  assert.equal(report.hijacked, true);
  assert.deepEqual(labels(report), ['hosts']);
});

test('matchMitmCa：认抓包工具的根证书，不误伤正常 CA', () => {
  const hits = coldStart.matchMitmCa([
    'CN=DigiCert Global Root CA, O=DigiCert Inc',
    'CN=FiddlerRoot Certificate, O=DO_NOT_TRUST_FiddlerRoot',
    'CN=Charles Proxy CA (1 Jan 2024)',
    'CN=Microsoft Root Certificate Authority 2011'
  ]);
  assert.equal(hits.length, 2);
  assert.ok(hits.join(' ').includes('Fiddler'));
});

test('installAxiosCircuit：拦截器命中劫持面就熔断，且只挂一次', () => {
  const handlers = [];
  const mock = { interceptors: { request: { use: (fn) => handlers.push(fn) } } };
  assert.equal(coldStart.installAxiosCircuit(mock), true);
  assert.equal(coldStart.installAxiosCircuit(mock), false);
  assert.equal(handlers.length, 1);
  // 干净环境放行
  assert.ok(handlers[0]({ url: 'https://api.deepseek.com/v1/chat/completions' }));
});

test('trafficStatus：熔断后能查到最近一次复核结果', () => {
  assert.throws(() => coldStart.assertTrafficSafe({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
  const status = coldStart.trafficStatus();
  assert.equal(status.alertCount, 1);
  assert.equal(status.alerts[0].label, 'NODE_TLS_REJECT_UNAUTHORIZED');
  assert.ok(status.checkedAt > 0);
});

test('inspectNativeModules：在当前进程里可安全调用', () => {
  const alerts = coldStart.inspectNativeModules();
  assert.ok(Array.isArray(alerts));
});

test('isPrivateAddress：内网/回环/保留段都认，公网放行', () => {
  ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.3.3', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'].forEach(
    (ip) => assert.equal(coldStart.isPrivateAddress(ip), true, ip)
  );
  ['8.8.8.8', '1.1.1.1', '104.18.0.1', '2400:3200::1'].forEach((ip) =>
    assert.equal(coldStart.isPrivateAddress(ip), false, ip)
  );
});

test('evaluateLookup：API 域名解析到内网要拦，公网与本机名放行', () => {
  assert.throws(
    () => coldStart.evaluateLookup('api.deepseek.com', [{ address: '10.0.0.9', family: 4 }]),
    (err) => err.code === 'DNS_PRIVATE_ADDRESS'
  );
  assert.doesNotThrow(() => coldStart.evaluateLookup('api.deepseek.com', [{ address: '104.18.0.1', family: 4 }]));
  assert.doesNotThrow(() => coldStart.evaluateLookup('localhost', [{ address: '127.0.0.1', family: 4 }]));
});

test('safeLookup：本机名能正常解析，不误伤本地服务', async () => {
  const addrs = await new Promise((resolve, reject) => {
    coldStart.safeLookup('localhost', { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
  });
  assert.ok(addrs.length > 0);
});

test('installAxiosCircuit：给 axios 装上带 lookup 校验的 agent', () => {
  const handlers = [];
  const mock = { interceptors: { request: { use: (fn) => handlers.push(fn) } } };
  coldStart.installAxiosCircuit(mock);
  const config = handlers[0]({ url: 'https://api.deepseek.com/v1' });
  assert.ok(config.httpsAgent);
  assert.equal(typeof config.httpsAgent.options.lookup, 'function');
  assert.equal(typeof config.httpsAgent.options.checkServerIdentity, 'function');
});

test('verifyPinned：首次记录、同指纹放行、换了公钥就拦', () => {
  const cert = { pubkey: Buffer.from('demo-key'), issuer: { O: 'DigiCert' } };
  const store = {};
  assert.equal(coldStart.verifyPinned('api.deepseek.com', cert, store).reason, 'pinned-first');
  assert.equal(coldStart.pinList(store['api.deepseek.com']).length, 1);
  assert.equal(store['api.deepseek.com'].source, 'handshake');
  assert.equal(coldStart.verifyPinned('api.deepseek.com', cert, store).reason, 'match');
  const other = coldStart.verifyPinned('api.deepseek.com', { pubkey: Buffer.from('evil-key'), issuer: { O: 'X' } }, store);
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'mismatch');
});

test('verifyPinned：抓包工具签发的证书不能进基线', () => {
  const store = {};
  const result = coldStart.verifyPinned('api.deepseek.com', {
    pubkey: Buffer.from('k'),
    issuer: { O: 'DO_NOT_TRUST_FiddlerRoot' }
  }, store);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mitm-issuer');
  assert.equal(store['api.deepseek.com'], undefined);
});

test('verifyPinned：兼容旧版纯数组格式的基线', () => {
  const store = { 'api.deepseek.com': ['sha256/OLD'] };
  const hit = coldStart.verifyPinned('api.deepseek.com', { pubkey: Buffer.from('k'), issuer: {} }, store);
  assert.equal(hit.reason, 'mismatch');
  assert.equal(coldStart.pinList(store['api.deepseek.com']).length, 1);
});

test('verifyPinned：指纹文件损坏时拒绝重建基线（防止删文件绕过）', () => {
  const store = { __broken__: 'JSON 解析失败' };
  const result = coldStart.verifyPinned('api.deepseek.com', { pubkey: Buffer.from('k'), issuer: {} }, store);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pins-broken');
});

test('pins 影子副本：主文件被单独删掉时能从副本恢复基线', () => {
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
  const file = path.join(dir, 'pins.json');
  const old = process.env.COLD_START_PINS_FILE;
  process.env.COLD_START_PINS_FILE = file;
  try {
    coldStart.resetPinCache();
    const cert = { pubkey: Buffer.from('shadow-key'), issuer: { O: 'DigiCert' } };
    coldStart.checkPinnedIdentity('api.deepseek.com', cert);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(`${file}.shadow`));
    fs.unlinkSync(file);
    coldStart.resetPinCache();
    const pins = coldStart.loadPins();
    assert.equal(coldStart.pinList(pins['api.deepseek.com']).length, 1);
    assert.ok(fs.existsSync(file), '恢复时应把主文件重新写回');
  } finally {
    if (old === undefined) delete process.env.COLD_START_PINS_FILE;
    else process.env.COLD_START_PINS_FILE = old;
    coldStart.resetPinCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertNoCanary：未配置时放行，命中诱饵即 CANARY_LEAK', () => {
  assert.doesNotThrow(() => coldStart.assertNoCanary(['https://api.deepseek.com', 'body']));
  process.env.COLD_START_CANARY = 'canary-demo-token-123';
  try {
    assert.throws(
      () => coldStart.assertNoCanary(['https://x', 'Authorization: Bearer canary-demo-token-123']),
      (err) => err.code === 'CANARY_LEAK'
    );
    assert.doesNotThrow(() => coldStart.assertNoCanary(['https://y', 'nothing']));
  } finally {
    delete process.env.COLD_START_CANARY;
  }
});
