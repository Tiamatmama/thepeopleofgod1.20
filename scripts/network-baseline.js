#!/usr/bin/env node
'use strict';

/**
 * 网络基线检查（流量劫持的「发现 + 恢复建议」）
 *
 * 按用户口径：反制 = 找出劫持原因、尽量恢复、暴露对面 IP，不攻击对方。
 * 本脚本只做本机可见的三层信号：
 *   1. 根证书库：新增的可信根 CA（抓包中间人的常见落点，命中已知工具名报高）
 *   2. 系统代理 / PAC：ProxyServer、AutoConfigURL 相对基线的变化
 *   3. DNS：系统解析 vs DoH（腾讯 / 阿里）交叉比对；解析到内网/回环直接报高
 *   4. 默认网关 MAC：相对基线漂移（ARP 欺骗 / 中间人的典型迹象）
 * 另外复用 coldStart 的启动面体检（hosts 改指、TLS 校验被关、会话密钥落盘）。
 *
 * 用法：
 *   node scripts/network-baseline.js                  # 与基线对比，出「高」时退出码 1
 *   node scripts/network-baseline.js --json
 *   node scripts/network-baseline.js --update-baseline # 确认当前网络环境可信时建立基线
 *   node scripts/network-baseline.js --no-doh         # 不联网，只查本机配置
 *
 * 基线落 data/security/network-baseline.json（data/ 已在 .gitignore）。
 */

const { execFileSync } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

const coldStart = require('../src/core/coldStart');

const ROOT = path.join(__dirname, '..');
const BASELINE_FILE = path.join(ROOT, 'data', 'security', 'network-baseline.json');
// 没有配 .env 时也要有比对目标，用服务器代码里的默认 API 域名兜底
const DEFAULT_API_URLS = [
  'https://api.deepseek.com',
  'https://ark.cn-beijing.volces.com'
];

function runPowerShell(script, timeout = 20000) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout,
      windowsHide: true
    });
    const text = String(out || '').trim();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// 根证书只保留「谁的根、指纹、哪个库」；主题里的中文原样保留
function normalizeRoots(list) {
  const seen = new Set();
  const roots = [];
  toArray(list).forEach((item) => {
    const subject = String((item && item.subject) || '').trim();
    const thumbprint = String((item && item.thumbprint) || '').trim().toUpperCase();
    if (!subject || !thumbprint || seen.has(thumbprint)) return;
    seen.add(thumbprint);
    const storePath = String((item && item.store) || '');
    const storeMatch = storePath.match(/(LocalMachine|CurrentUser)\\(Root|CA)/i);
    roots.push({
      subject,
      thumbprint,
      store: storeMatch ? `${storeMatch[1]}\\${storeMatch[2]}` : storePath
    });
  });
  return roots.sort((a, b) => a.thumbprint.localeCompare(b.thumbprint));
}

function collectRoots() {
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    'Get-ChildItem Cert:\\LocalMachine\\Root,Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { [pscustomobject]@{ store=$_.PSParentPath; subject=$_.Subject; thumbprint=$_.Thumbprint } } | ' +
    'ConvertTo-Json -Compress';
  return normalizeRoots(runPowerShell(script));
}

function collectProxy() {
  const script =
    '$k=\'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\'; ' +
    '$p=Get-ItemProperty $k -ErrorAction SilentlyContinue; ' +
    '[pscustomobject]@{ ' +
    'proxyEnable=[int]($p.ProxyEnable); ' +
    'proxyServer=[string]($p.ProxyServer); ' +
    'autoConfigUrl=[string]($p.AutoConfigURL); ' +
    'autoDetect=[int]($p.AutoDetect) } | ConvertTo-Json -Compress';
  const raw = runPowerShell(script);
  return {
    proxyEnable: Number((raw && raw.proxyEnable) || 0),
    proxyServer: String((raw && raw.proxyServer) || ''),
    autoConfigUrl: String((raw && raw.autoConfigUrl) || ''),
    autoDetect: Number((raw && raw.autoDetect) || 0)
  };
}

function collectGateway() {
  const script =
    '$r = Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.NextHop -ne \'0.0.0.0\' } | Sort-Object RouteMetric | Select-Object -First 1; ' +
    'if (-not $r) { return }; ' +
    '$mac=\'\'; ' +
    '$n = Get-NetNeighbor -IPAddress $r.NextHop -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
    'if ($n) { $mac=[string]$n.LinkLayerAddress }; ' +
    '[pscustomobject]@{ gateway=[string]$r.NextHop; interface=[string]$r.InterfaceAlias; mac=$mac.ToUpper() } | ' +
    'ConvertTo-Json -Compress';
  const raw = runPowerShell(script);
  if (!raw) return null;
  return {
    gateway: String(raw.gateway || ''),
    interface: String(raw.interface || ''),
    mac: String(raw.mac || '').toUpperCase()
  };
}

// 目标主机：.env 里配的 API 域名 + 默认域名；本地服务不参与
function targetHosts(env = process.env) {
  const hosts = coldStart.apiHosts(env, DEFAULT_API_URLS);
  return Array.from(hosts).sort();
}

function uniqSorted(list) {
  return Array.from(new Set((list || []).filter(Boolean))).sort();
}

async function resolveSystem(host) {
  try {
    return uniqSorted(await dns.promises.resolve4(host));
  } catch {
    return [];
  }
}

// DoH 结果拿不到时返回 null：不能把「查不到」当成「被劫持」
async function resolveDoh(host) {
  const endpoints = [
    `https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=A`,
    `https://223.5.5.5/resolve?name=${encodeURIComponent(host)}&type=A`
  ];
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const ips = (data.Answer || [])
        .filter((item) => item && (item.type === 1 || item.type === 'A'))
        .map((item) => String(item.data || '').trim())
        .filter(Boolean);
      if (ips.length) return uniqSorted(ips);
    } catch {
      // 换下一个端点
    }
  }
  return null;
}

function makeFinding(severity, id, name, target, detail, hint) {
  return { severity, id, name, target, detail, hint };
}

function diffRoots(prev, next) {
  const findings = [];
  const before = new Set((prev || []).map((item) => item.thumbprint));
  const after = new Set((next || []).map((item) => item.thumbprint));
  (next || []).forEach((item) => {
    if (before.has(item.thumbprint)) return;
    const mitm = coldStart.matchMitmCa([item.subject]);
    findings.push(makeFinding(
      mitm.length ? '高' : '中',
      mitm.length ? 'mitm-root-added' : 'root-added',
      mitm.length ? '新增的根证书像抓包工具' : '新增可信根证书',
      item.subject,
      `库=${item.store} 指纹=${item.thumbprint}`,
      mitm.length
        ? `确认不是自己装的代理工具；不需要就删：certutil ${
          item.store.startsWith('CurrentUser') ? '-user ' : ''
        }-delstore Root ${item.thumbprint}`
        : '新增根证书意味着它能签发任何网站的身份；确认来源，不需要就删掉'
    ));
  });
  (prev || []).forEach((item) => {
    if (after.has(item.thumbprint)) return;
    findings.push(makeFinding('低', 'root-removed', '移除可信根证书', item.subject,
      `库=${item.store} 指纹=${item.thumbprint}`,
      '多半是手动清理或系统更新；确认不是安全软件误删'));
  });
  return findings;
}

function diffProxy(prev, next) {
  const findings = [];
  const before = prev || {};
  const now = next || {};
  if (String(before.proxyServer || '') !== String(now.proxyServer || '')) {
    findings.push(makeFinding('中', 'proxy-changed', '系统代理变化', now.proxyServer || '(空)',
      `原值=${before.proxyServer || '(空)'}，代理开关=${now.proxyEnable ? '开' : '关'}`,
      '不认识的代理会看到全部请求；确认是自家 VPN/代理，否则在「设置 → 网络 → 代理」里关掉'));
  }
  if (String(before.autoConfigUrl || '') !== String(now.autoConfigUrl || '')) {
    findings.push(makeFinding('中', 'pac-changed', 'PAC 自动配置变化', now.autoConfigUrl || '(空)',
      `原值=${before.autoConfigUrl || '(空)'}`,
      'PAC 能按域名把流量导到任意代理；确认脚本来源可信'));
  }
  if (Number(before.proxyEnable || 0) !== Number(now.proxyEnable || 0)) {
    findings.push(makeFinding('低', 'proxy-switch', '代理开关状态变化', now.proxyEnable ? '开启' : '关闭',
      `原值=${before.proxyEnable ? '开启' : '关闭'}`,
      '自己切换可忽略；不记得动过就查一下是谁改的'));
  }
  return findings;
}

function diffGateway(prev, next) {
  const findings = [];
  if (!next || !next.gateway) return findings;
  if (!prev || !prev.gateway) {
    findings.push(makeFinding('低', 'gateway-new', '未记录过默认网关', `${next.gateway} (${next.mac || '无 MAC'})`,
      `接口=${next.interface}`,
      '若是首次运行可忽略；之后同一网关的 MAC 变化会报高'));
    return findings;
  }
  if (String(prev.gateway) !== String(next.gateway)) {
    findings.push(makeFinding('低', 'gateway-changed', '默认网关变化', `${prev.gateway} → ${next.gateway}`,
      `新 MAC=${next.mac || '未知'}`,
      '换了网络/路由器属正常；同一网络里网关变了要留意'));
    return findings;
  }
  if (prev.mac && next.mac && String(prev.mac).toUpperCase() !== String(next.mac).toUpperCase()) {
    findings.push(makeFinding('高', 'gateway-mac-changed', '网关 MAC 漂移（疑似 ARP 欺骗）', `${next.gateway}`,
      `${prev.mac} → ${next.mac}`,
      `局域网里有人冒充网关，流量会先经过对方（对端 IP 就是网关 IP ${next.gateway}，MAC ${next.mac}）；` +
      '先重启路由器，再在路由器里绑定静态 ARP，或直接断开陌生设备'));
  }
  return findings;
}

function compareDns(host, systemIps, dohIps) {
  const findings = [];
  const system = uniqSorted(systemIps);
  if (!system.length) return findings;
  const privates = system.filter((ip) => coldStart.isPrivateAddress(ip));
  if (privates.length === system.length) {
    findings.push(makeFinding('高', 'dns-private', 'DNS 解析落在内网/回环', host,
      `系统解析=${system.join(', ')}`,
      `正常公网域名不该解析到内网（对端 IP ${system.join(', ')}）；先换 DNS 为 223.5.5.5 / 119.29.29.29，` +
      '再检查路由器 DHCP 下发的 DNS 是否被改'));
    return findings;
  }
  if (!dohIps || !dohIps.length) return findings;
  const overlap = system.some((ip) => dohIps.includes(ip));
  if (!overlap) {
    // CDN 会按出口地域返回不同 IP，单纯不一致不能定罪；只作提示，落内网才算高
    findings.push(makeFinding('低', 'dns-mismatch', '系统 DNS 与 DoH 结果不一致', host,
      `系统=${system.join(', ')}；DoH=${dohIps.join(', ')}`,
      '可能是 CDN 分流，也可能是 DNS 污染；连续多次不一致时换可信 DNS（223.5.5.5 / 119.29.29.29）复测'));
  }
  return findings;
}

function loadBaseline(file = BASELINE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveBaseline(state, file = BASELINE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { createdAt: new Date().toISOString(), ...state };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

async function collectReport(options = {}) {
  const baseline = options.baseline === undefined ? loadBaseline() : options.baseline;
  const findings = [];
  const roots = options.roots || collectRoots();
  const proxy = options.proxy || collectProxy();
  const gateway = options.gateway || collectGateway();

  if (baseline) {
    findings.push(...diffRoots(baseline.roots || [], roots));
    findings.push(...diffProxy(baseline.proxy || {}, proxy));
    findings.push(...diffGateway(baseline.gateway || null, gateway));
  }

  // 启动面体检：hosts 改指 / 证书校验被关 / 会话密钥落盘，命中即高
  const traffic = coldStart.inspectTraffic(process.env);
  traffic.alerts.forEach((item) => {
    findings.push(makeFinding('高', 'traffic-alert', `启动面：${item.label}`, item.value, item.reason,
      '见 coldStart 的说明；改完环境变量后重启服务'));
  });

  // DNS：系统解析 vs DoH（--no-doh / 非 Windows 也照常跑，只看系统解析）
  const dnsResults = [];
  if (!options.noDoh) {
    for (const host of targetHosts(options.env || process.env)) {
      const systemIps = await resolveSystem(host);
      const dohIps = await resolveDoh(host);
      dnsResults.push({ host, system: systemIps, doh: dohIps });
      findings.push(...compareDns(host, systemIps, dohIps));
    }
  }

  if (!baseline) {
    findings.push(makeFinding('低', 'no-baseline', '尚未建立网络基线', BASELINE_FILE,
      '本次只能查当前状态，无法发现「证书/代理/网关相对上次的变化」',
      '确认当前环境可信后运行 node scripts/network-baseline.js --update-baseline'));
  }

  const order = { 高: 0, 中: 1, 低: 2 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity])
    || a.id.localeCompare(b.id)
    || a.target.localeCompare(b.target));

  return { roots, proxy, gateway, dnsResults, findings };
}

async function main() {
  const update = process.argv.includes('--update-baseline');
  const json = process.argv.includes('--json');
  const noDoh = process.argv.includes('--no-doh');

  let report;
  try {
    report = await collectReport({ baseline: update ? null : undefined, noDoh: update || noDoh });
  } catch (error) {
    console.error(`网络检查失败：${error.message}`);
    return 2;
  }

  if (update) {
    const saved = saveBaseline({
      roots: report.roots,
      proxy: report.proxy,
      gateway: report.gateway
    });
    console.log(`已写入基线：${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(`  根证书 ${saved.roots.length} 张；代理=${saved.proxy.proxyServer || '(空)'}；` +
      `网关=${saved.gateway ? `${saved.gateway.gateway} (${saved.gateway.mac || '无 MAC'})` : '未取到'}`);
    return 0;
  }

  const count = { 高: 0, 中: 0, 低: 0 };
  report.findings.forEach((item) => { count[item.severity] += 1; });

  if (json) {
    console.log(JSON.stringify({
      roots: report.roots.length,
      gateway: report.gateway,
      dns: report.dnsResults,
      count,
      findings: report.findings
    }, null, 2));
  } else {
    console.log(`根证书 ${report.roots.length} 张，网关 ${
      report.gateway ? `${report.gateway.gateway} (${report.gateway.mac || '无 MAC'})` : '未取到'
    }，命中 ${report.findings.length} 处：高 ${count.高} / 中 ${count.中} / 低 ${count.低}\n`);
    report.findings.forEach((item) => {
      console.log(`[${item.severity}] ${item.name}（${item.id}）`);
      console.log(`      ${item.target}`);
      console.log(`      ${item.detail}`);
      console.log(`      → ${item.hint}`);
    });
    if (!report.findings.length) console.log('未发现异常。');
  }

  return count.高 > 0 ? 1 : 0;
}

module.exports = {
  DEFAULT_API_URLS,
  normalizeRoots,
  collectRoots,
  collectProxy,
  collectGateway,
  targetHosts,
  diffRoots,
  diffProxy,
  diffGateway,
  compareDns,
  loadBaseline,
  saveBaseline,
  collectReport,
  main
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
