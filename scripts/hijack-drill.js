'use strict';

// 本机流量劫持演练：把攻击者常用的几种投毒手法逐条套到子进程上，确认冷启动体检都能拦住。
// 只动子进程的环境变量与临时文件，不改系统代理 / hosts / 证书，也不发真实网络请求。
//
// 用法：node scripts/hijack-drill.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const coldStart = require('../src/core/coldStart');

const projectRoot = path.resolve(__dirname, '..');
const coldStartPath = path.join(projectRoot, 'src', 'core', 'coldStart.js');
const childCode =
  'const c = require(process.env.COLD_START_MOD); const ok = c.preflight(); process.exit(ok ? 0 : 1);';

// 起一个和 index.js 一样会「体检不过就退出」的子进程
function runChild(extraEnv, nodeArgs = []) {
  const env = { ...process.env, COLD_START_MOD: coldStartPath, COLD_START_SKIP_CA_SCAN: '1' };
  // 先清掉可能让结果失真的外部变量，再叠加本次演练注入的值
  ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE'].forEach((key) => {
    delete env[key];
  });
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [...nodeArgs, '-e', childCode], {
    cwd: projectRoot,
    env,
    encoding: 'utf8'
  });
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hijack-drill-'));
  const preload = path.join(tmp, 'evil-preload.js');
  const fakeCa = path.join(tmp, 'evil-root.pem');
  fs.writeFileSync(preload, '// 演练用的假预加载，不做任何事\n', 'utf8');
  fs.writeFileSync(fakeCa, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', 'utf8');

  const cases = [];
  const check = (name, expectBlocked, extraEnv, nodeArgs = []) => {
    const { code, output } = runChild(extraEnv, nodeArgs);
    const blocked = code === 1;
    // 被拦住时必须是我们自己的体检报出来的，不能是 Node 加载预加载文件时就崩了
    const attributed = !expectBlocked || output.includes('[冷启动]');
    const pass = blocked === expectBlocked && attributed;
    const summary = blocked ? output.split(/\r?\n/)[0] : '正常通过';
    cases.push({ name, expectBlocked, blocked, pass, summary });
  };

  // 1. 干净环境不应误报
  check('干净环境', false, {});
  // 2. NODE_OPTIONS 塞预加载（路径不带空格，NODE_OPTIONS 里直接写）
  check('NODE_OPTIONS 预加载', true, { NODE_OPTIONS: `--require ${preload}` });
  // 3. 命令行 --require 塞预加载
  check('启动参数 --require', true, {}, ['--require', preload]);
  // 4. 关掉证书校验（最典型的中间人前提）
  check('关闭证书校验', true, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  // 5. 塞一张自己的根证书
  check('注入根证书', true, { NODE_EXTRA_CA_CERTS: fakeCa });
  // 6. 导出 TLS 会话密钥
  check('导出会话密钥', true, { SSLKEYLOGFILE: path.join(tmp, 'keys.log') });
  // 7. 显式放行后应能继续启动
  check('显式放行注入', false, { NODE_OPTIONS: `--require ${preload}`, COLD_START_ALLOW_INJECT: '1' });

  // 8. hosts 改指 API 域名（纯匹配，不动真实 hosts 文件）
  const hostsText = ['# 演练样例', '127.0.0.1 ark.cn-beijing.volces.com', '10.0.0.9 api.deepseek.com'].join('\n');
  const hostsEnv = {
    DOUBAO_API_URL: 'https://ark.cn-beijing.volces.com/api/v3',
    DEEPSEEK_API_URL: 'https://api.deepseek.com/v1'
  };
  const hits = coldStart.matchHosts(hostsText, coldStart.apiHosts(hostsEnv));
  cases.push({
    name: 'hosts 改指 API 域名',
    expectBlocked: true,
    blocked: hits.length === 2,
    pass: hits.length === 2,
    summary: `命中 ${hits.length} 条：${hits.join('；')}`
  });

  // 9. 系统根证书里出现抓包工具的 CA（纯名单匹配，不真的去扫证书库）
  const caHits = coldStart.matchMitmCa(['CN=FiddlerRoot Certificate', 'CN=DigiCert Global Root CA']);
  cases.push({
    name: '抓包工具根证书',
    expectBlocked: true,
    blocked: caHits.length === 1,
    pass: caHits.length === 1,
    summary: `命中 ${caHits.length} 张：${caHits.join('；')}`
  });

  // 10. 代理只提示不拦（本机自己的代理要能正常用）
  const proxied = coldStart.inspectTraffic({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, '');
  const proxyOk = proxied.alerts.length === 0 && proxied.notes.length === 1;
  cases.push({
    name: '代理只提示不拦',
    expectBlocked: false,
    blocked: !proxyOk,
    pass: proxyOk,
    summary: proxyOk ? proxied.notes[0].value : '代理处理不符合预期'
  });

  // 11. DNS 把 API 域名解析到内网/回环（污染或本地反代）
  let dnsBlocked = false;
  try {
    coldStart.evaluateLookup('api.deepseek.com', [{ address: '127.0.0.1', family: 4 }]);
  } catch (err) {
    dnsBlocked = err.code === 'DNS_PRIVATE_ADDRESS';
  }
  cases.push({
    name: 'DNS 解析到内网',
    expectBlocked: true,
    blocked: dnsBlocked,
    pass: dnsBlocked,
    summary: 'api.deepseek.com → 127.0.0.1 被拦为 DNS_PRIVATE_ADDRESS'
  });

  // 12. 证书公钥指纹与基线不一致（恶意根证书型中间人）
  const pinStore = { 'api.deepseek.com': ['sha256/BASELINE'] };
  const pinResult = coldStart.verifyPinned(
    'api.deepseek.com',
    { pubkey: Buffer.from('attacker-key'), issuer: { O: 'Evil CA' } },
    pinStore
  );
  cases.push({
    name: '证书指纹不一致',
    expectBlocked: true,
    blocked: !pinResult.ok,
    pass: !pinResult.ok && pinResult.reason === 'mismatch',
    summary: '基线 sha256/BASELINE，实际为攻击者公钥 → PIN_MISMATCH'
  });

  // 13. 诱饵凭据被使用（配置被读取并冒用）
  let canaryBlocked = false;
  process.env.COLD_START_CANARY = 'canary-drill-token-9f2c';
  try {
    coldStart.assertNoCanary(['https://api.deepseek.com', 'Authorization: Bearer canary-drill-token-9f2c']);
  } catch (err) {
    canaryBlocked = err.code === 'CANARY_LEAK';
  } finally {
    delete process.env.COLD_START_CANARY;
  }
  cases.push({
    name: '诱饵凭据被使用',
    expectBlocked: true,
    blocked: canaryBlocked,
    pass: canaryBlocked,
    summary: '外连请求里出现 CANARY 值 → CANARY_LEAK'
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n本机流量劫持演练');
  console.log('-'.repeat(72));
  cases.forEach((item) => {
    const expect = item.expectBlocked ? '应拦住' : '应放行';
    console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}（${expect}）`);
    console.log(`      ${item.summary}`);
  });
  const failed = cases.filter((item) => !item.pass).length;
  console.log('-'.repeat(72));
  console.log(failed === 0 ? `全部通过：${cases.length} 项` : `有 ${failed} 项未通过`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
