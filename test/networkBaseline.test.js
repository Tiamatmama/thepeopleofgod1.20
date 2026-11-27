'use strict';

// 网络基线检查的纯逻辑测试：不跑 PowerShell、不联网、不读真实基线。
const { test } = require('node:test');
const assert = require('node:assert');

const net = require('../scripts/network-baseline');

test('normalizeRoots：去重、提取证书库、按指纹排序', () => {
  const roots = net.normalizeRoots([
    {
      store: 'Microsoft.PowerShell.Security\\Certificate::LocalMachine\\Root',
      subject: 'CN=Test Root',
      thumbprint: 'bbbb'
    },
    {
      store: 'Microsoft.PowerShell.Security\\Certificate::CurrentUser\\Root',
      subject: 'CN=Other Root',
      thumbprint: 'AAAA'
    },
    {
      store: 'Microsoft.PowerShell.Security\\Certificate::LocalMachine\\Root',
      subject: 'CN=Test Root',
      thumbprint: 'BBBB'
    }
  ]);
  assert.strictEqual(roots.length, 2);
  assert.strictEqual(roots[0].thumbprint, 'AAAA');
  assert.strictEqual(roots[0].store, 'CurrentUser\\Root');
  assert.strictEqual(roots[1].store, 'LocalMachine\\Root');
});

test('diffRoots：新增普通根证书报中，抓包工具根证书报高', () => {
  const prev = [{ subject: 'CN=Old Root', thumbprint: 'OLD', store: 'LocalMachine\\Root' }];
  const normal = net.diffRoots(prev, prev.concat([
    { subject: 'CN=Some New CA', thumbprint: 'NEW1', store: 'LocalMachine\\Root' }
  ]));
  assert.strictEqual(normal.length, 1);
  assert.strictEqual(normal[0].severity, '中');

  const mitm = net.diffRoots(prev, prev.concat([
    { subject: 'CN=Fiddler Root Certificate', thumbprint: 'NEW2', store: 'CurrentUser\\Root' }
  ]));
  assert.strictEqual(mitm.length, 1);
  assert.strictEqual(mitm[0].severity, '高');
  assert.match(mitm[0].hint, /certutil -user -delstore Root NEW2/);
});

test('diffRoots：没有任何变化时不报', () => {
  const prev = [{ subject: 'CN=A', thumbprint: 'A', store: 'LocalMachine\\Root' }];
  assert.deepStrictEqual(net.diffRoots(prev, prev), []);
});

test('diffProxy：代理服务器 / PAC 变化报中，开关变化报低', () => {
  const before = { proxyEnable: 0, proxyServer: '', autoConfigUrl: '' };
  const after = { proxyEnable: 1, proxyServer: '127.0.0.1:8080', autoConfigUrl: 'http://x/pac' };
  const findings = net.diffProxy(before, after);
  const ids = findings.map((item) => item.id).sort();
  assert.deepStrictEqual(ids, ['pac-changed', 'proxy-changed', 'proxy-switch']);
  assert.strictEqual(findings.find((item) => item.id === 'proxy-changed').severity, '中');
  assert.strictEqual(findings.find((item) => item.id === 'proxy-switch').severity, '低');
});

test('diffGateway：网关 MAC 漂移报高，首次记录报低，没变化不报', () => {
  const prev = { gateway: '192.168.1.1', mac: 'AA-BB-CC-DD-EE-FF' };
  const same = net.diffGateway(prev, { gateway: '192.168.1.1', mac: 'aa-bb-cc-dd-ee-ff' });
  assert.deepStrictEqual(same, []);

  const drifted = net.diffGateway(prev, { gateway: '192.168.1.1', mac: '11-22-33-44-55-66' });
  assert.strictEqual(drifted[0].severity, '高');
  assert.strictEqual(drifted[0].id, 'gateway-mac-changed');
  assert.match(drifted[0].hint, /192\.168\.1\.1/);

  const first = net.diffGateway(null, { gateway: '192.168.1.1', mac: 'AA-BB-CC-DD-EE-FF' });
  assert.strictEqual(first[0].severity, '低');
});

test('compareDns：解析到内网报高，与 DoH 不一致只作提示，一致不报', () => {
  const privateDns = net.compareDns('api.deepseek.com', ['127.0.0.1'], ['1.2.3.4']);
  assert.strictEqual(privateDns[0].severity, '高');
  assert.strictEqual(privateDns[0].id, 'dns-private');

  const mismatch = net.compareDns('api.deepseek.com', ['1.2.3.4'], ['5.6.7.8']);
  assert.strictEqual(mismatch[0].severity, '低');
  assert.strictEqual(mismatch[0].id, 'dns-mismatch');

  assert.deepStrictEqual(net.compareDns('api.deepseek.com', ['1.2.3.4'], ['1.2.3.4']), []);
  assert.deepStrictEqual(net.compareDns('api.deepseek.com', ['1.2.3.4'], null), []);
  assert.deepStrictEqual(net.compareDns('api.deepseek.com', [], ['1.2.3.4']), []);
});

test('targetHosts：默认 API 域名 + 环境变量，排除本地地址', () => {
  const hosts = net.targetHosts({ DEEPSEEK_API_URL: 'https://api.example.com/v1', QDRANT_URL: 'http://localhost:6333' });
  assert.ok(hosts.includes('api.deepseek.com'));
  assert.ok(hosts.includes('api.example.com'));
  assert.ok(!hosts.includes('localhost'));
});
