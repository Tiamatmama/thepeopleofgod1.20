'use strict';

// 依赖投毒检查的纯逻辑测试：不读真实 lockfile/node_modules，全部用构造数据。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const audit = require('../scripts/dependency-audit');

test('packageNameFromPath：普通包 / scoped 包 / 嵌套包', () => {
  assert.strictEqual(audit.packageNameFromPath('node_modules/express'), 'express');
  assert.strictEqual(audit.packageNameFromPath('node_modules/@eslint/js'), '@eslint/js');
  assert.strictEqual(
    audit.packageNameFromPath('node_modules/@eslint-community/eslint-utils/node_modules/eslint-visitor-keys'),
    'eslint-visitor-keys'
  );
  assert.strictEqual(audit.packageNameFromPath(''), '');
});

test('createSnapshot：抽出名称、版本、来源、完整性', () => {
  const snapshot = audit.createSnapshot({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', version: '1.0.0' },
      'node_modules/express': {
        version: '4.18.2',
        resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz',
        integrity: 'sha512-AAA'
      }
    }
  });
  assert.strictEqual(snapshot.lockfileVersion, 3);
  assert.deepStrictEqual(Object.keys(snapshot.packages), ['node_modules/express']);
  assert.strictEqual(snapshot.packages['node_modules/express'].name, 'express');
  assert.strictEqual(snapshot.packages['node_modules/express'].integrity, 'sha512-AAA');
});

test('diffSnapshots：同版本 integrity 变化判为高', () => {
  const before = {
    packages: {
      'node_modules/express': {
        name: 'express',
        version: '4.18.2',
        resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz',
        integrity: 'sha512-OLD'
      }
    }
  };
  const after = {
    packages: {
      'node_modules/express': {
        name: 'express',
        version: '4.18.2',
        resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz',
        integrity: 'sha512-NEW'
      }
    }
  };
  const findings = audit.diffSnapshots(before, after);
  const hit = findings.find((item) => item.id === 'integrity-changed');
  assert.ok(hit, '应命中 integrity-changed');
  assert.strictEqual(hit.severity, '高');
});

test('diffSnapshots：新增包来源是 git 判为高，版本变化判为中', () => {
  const before = {
    packages: {
      'node_modules/ws': {
        name: 'ws',
        version: '8.14.2',
        resolved: 'https://registry.npmjs.org/ws/-/ws-8.14.2.tgz',
        integrity: 'sha512-AAA'
      }
    }
  };
  const after = {
    packages: {
      'node_modules/ws': {
        name: 'ws',
        version: '8.15.0',
        resolved: 'https://registry.npmjs.org/ws/-/ws-8.15.0.tgz',
        integrity: 'sha512-BBB'
      },
      'node_modules/evil': {
        name: 'evil',
        version: '1.0.0',
        resolved: 'git+https://github.com/attacker/evil.git',
        integrity: ''
      }
    }
  };
  const findings = audit.diffSnapshots(before, after);
  const ids = findings.map((item) => item.id);
  assert.ok(ids.includes('non-registry-resolved'));
  assert.strictEqual(findings.find((item) => item.id === 'non-registry-resolved').severity, '高');
  assert.strictEqual(findings.find((item) => item.id === 'version-changed').severity, '中');
});

test('lifecycleScripts：只认 preinstall / install / postinstall', () => {
  assert.deepStrictEqual(
    audit.lifecycleScripts({ scripts: { preinstall: 'a', install: 'b', postinstall: 'c', build: 'd' } }),
    ['preinstall', 'install', 'postinstall']
  );
  assert.deepStrictEqual(audit.lifecycleScripts({ scripts: { build: 'd' } }), []);
});

test('scanInstalledScripts：找到普通包与 scoped 包的安装期脚本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-dep-'));
  try {
    const write = (rel, pkg) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, 'package.json'), JSON.stringify(pkg), 'utf8');
    };
    write('plain', { name: 'plain', version: '1.0.0', scripts: { postinstall: 'node setup.js' } });
    write('@scope/thing', { name: '@scope/thing', version: '2.0.0', scripts: { preinstall: 'node pre.js' } });
    write('quiet', { name: 'quiet', version: '3.0.0' });

    const found = audit.scanInstalledScripts(dir);
    const names = found.map((item) => item.name).sort();
    assert.deepStrictEqual(names, ['@scope/thing', 'plain']);
    const plain = found.find((item) => item.name === 'plain');
    assert.strictEqual(plain.scripts.postinstall, 'node setup.js');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('typosquatCandidates：命中近似名，跳过同名与 scope 包', () => {
  const hits = audit.typosquatCandidates(['expres', 'axios', 'axois', '@scope/express']);
  const names = hits.map((item) => item.name);
  assert.ok(names.includes('expres'));
  assert.ok(names.includes('axois'));
  assert.ok(!names.includes('axios'), '同名不应命中');
  assert.ok(!names.includes('@scope/express'), 'scope 包应跳过');
  assert.strictEqual(hits.find((item) => item.name === 'expres').target, 'express');
});

test('isTrustedResolved：官方源与镜像放行，git / 裸 http 不放行', () => {
  assert.strictEqual(audit.isTrustedResolved('https://registry.npmjs.org/express/-/express-4.18.2.tgz'), true);
  assert.strictEqual(audit.isTrustedResolved('https://registry.npmmirror.com/express/-/express-4.18.2.tgz'), true);
  assert.strictEqual(audit.isTrustedResolved('http://registry.npmjs.org/express/-/express-4.18.2.tgz'), false);
  assert.strictEqual(audit.isTrustedResolved('git+https://github.com/x/y.git'), false);
  assert.strictEqual(audit.isTrustedResolved('https://evil.example.com/x.tgz'), false);
});
