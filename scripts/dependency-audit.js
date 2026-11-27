#!/usr/bin/env node
'use strict';

/**
 * 开源投毒检查（依赖供应链）
 *
 * 目标：把「依赖被换掉 / 被投毒」这件事变得可见，而不是等它跑起来才发现。
 * 检查项：
 *   1. lockfile 与上次基线对比：同版本但 integrity 变了（最危险的「偷换包」信号）、
 *      版本变化、来源从官方 registry 换成 git/file/裸 http
 *   2. 安装期脚本：package.json 与已装依赖里的 preinstall / install / postinstall，
 *      新出现的一律报高（投毒最常用的执行点）
 *   3. typosquat：依赖名与常见包名只差一两个字符（expres / lodahs / axois）
 *   4. 完整性字段缺失：registry 包没有 integrity 就无法校验内容
 *
 * 用法：
 *   node scripts/dependency-audit.js                  # 与基线对比，出「高」时退出码 1
 *   node scripts/dependency-audit.js --json           # 机器可读
 *   node scripts/dependency-audit.js --update-baseline # 建立/更新基线（确认当前状态可信时用）
 *
 * 基线落 data/security/dependency-baseline.json（data/ 已在 .gitignore）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const BASELINE_FILE = path.join(ROOT, 'data', 'security', 'dependency-baseline.json');

// 安装期会自动执行的脚本；发布出去的包里 prepare/prepublish 不会在安装时跑，故不算
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
// 认可的官方/镜像源（https）：其余来源一律可疑
const TRUSTED_REGISTRY_HOSTS = ['registry.npmjs.org', 'registry.npmmirror.com', 'registry.yarnpkg.com'];

// 只用于 typosquat 比对的高频包名，不求全，够覆盖常见的仿冒目标
const POPULAR_PACKAGES = [
  'express', 'axios', 'ws', 'dotenv', 'lodash', 'react', 'react-dom', 'next', 'vue', 'angular',
  'typescript', 'webpack', 'vite', 'rollup', 'esbuild', 'babel', 'jest', 'mocha', 'vitest', 'chai',
  'chalk', 'commander', 'debug', 'fs-extra', 'glob', 'minimatch', 'semver', 'uuid', 'yargs',
  'inquirer', 'ora', 'cors', 'helmet', 'morgan', 'body-parser', 'cookie-parser', 'jsonwebtoken',
  'mongoose', 'mongodb', 'mysql', 'pg', 'redis', 'socket.io', 'node-fetch', 'form-data', 'multer',
  'sharp', 'jimp', 'cheerio', 'puppeteer', 'playwright', 'jsdom', 'marked', 'dayjs', 'moment',
  'date-fns', 'rxjs', 'immer', 'zustand', 'redux', 'mobx', 'tailwindcss', 'sass', 'postcss',
  'autoprefixer', 'nodemon', 'eslint', 'prettier', 'adm-zip', 'bcryptjs', 'bcrypt', 'dotenv-cli',
  'cross-env', 'rimraf', 'mkdirp', 'nanoid', 'undici', 'node-gyp', 'openai', 'anthropic'
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// lockfile 的 key 形如 node_modules/a/node_modules/@s/b，取最后一个 node_modules 之后的部分
function packageNameFromPath(key) {
  if (!key) return '';
  const parts = key.split(/[\\/]/);
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) return '';
  const rest = parts.slice(index + 1);
  if (!rest.length) return '';
  if (rest[0].startsWith('@')) return rest.slice(0, 2).join('/');
  return rest[0];
}

function isTrustedResolved(resolved) {
  if (!resolved) return true; // 无 resolved 的（link/本地）由另一条规则判断
  try {
    const url = new URL(resolved);
    return url.protocol === 'https:' && TRUSTED_REGISTRY_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function isLocalResolved(resolved) {
  return /^(file:|link:|portal:)/.test(String(resolved || ''))
    || /^git[+:]/.test(String(resolved || ''))
    || /^github:/.test(String(resolved || ''));
}

// 从 lockfile 抽出「包路径 → 版本/来源/完整性」，作为可对比的快照
function createSnapshot(lock) {
  const packages = {};
  const source = (lock && lock.packages) || {};
  Object.keys(source).forEach((key) => {
    if (!key) return; // '' 是项目自身
    const value = source[key] || {};
    const name = packageNameFromPath(key);
    if (!name) return;
    packages[key] = {
      name,
      version: String(value.version || ''),
      resolved: String(value.resolved || ''),
      integrity: String(value.integrity || ''),
      dev: Boolean(value.dev)
    };
  });
  return {
    lockfileVersion: (lock && lock.lockfileVersion) || null,
    packages
  };
}

// 取一个包在 package.json 里的安装期脚本
function lifecycleScripts(pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  return INSTALL_SCRIPTS.filter((name) => typeof scripts[name] === 'string' && scripts[name].trim());
}

function makeFinding(severity, id, name, target, detail, hint) {
  return { severity, id, name, target, detail, hint };
}

// 新旧快照对比。关键判据：版本没变但 integrity 变了 = 同一个版本号下换了内容
function diffSnapshots(prev, next) {
  const findings = [];
  const before = (prev && prev.packages) || {};
  const after = (next && next.packages) || {};

  Object.keys(after).forEach((key) => {
    const cur = after[key];
    const old = before[key];
    const label = `${cur.name}${cur.version ? `@${cur.version}` : ''}`;

    if (!old) {
      // 新增包：来源必须是官方 registry；否则直接报高
      if (cur.resolved && !isTrustedResolved(cur.resolved)) {
        findings.push(makeFinding('高', 'non-registry-resolved', '依赖来源不是官方 registry', label,
          `resolved=${cur.resolved}`,
          '确认这个包是否真的需要；非官方来源可能被替换成恶意 tarball'));
      } else {
        findings.push(makeFinding('低', 'package-added', '新增依赖', label, key,
          '升级时留意审核，尤其是首次出现的包'));
      }
      return;
    }

    if (old.version !== cur.version) {
      findings.push(makeFinding('中', 'version-changed', '依赖版本变化', label,
        `${old.version || '?'} → ${cur.version || '?'}`,
        '确认是主动升级；版本跳变同时伴随来源变化时要重点核查'));
    }

    if (old.version === cur.version && old.integrity && cur.integrity && old.integrity !== cur.integrity) {
      findings.push(makeFinding('高', 'integrity-changed', '同版本完整性哈希变化', label,
        `${old.integrity.slice(0, 24)}… → ${cur.integrity.slice(0, 24)}…`,
        '高度可疑：同一版本号下的内容被换过，先不要安装，核对 npm 官方 tarball'));
    }

    if (cur.resolved && !isTrustedResolved(cur.resolved) && !isLocalResolved(cur.resolved)) {
      findings.push(makeFinding('高', 'non-registry-resolved', '依赖来源不是官方 registry', label,
        `resolved=${cur.resolved}`,
        '非官方来源可能被替换成恶意 tarball；确认可信后改用官方源'));
    }

    if (old.resolved && isTrustedResolved(old.resolved) && isLocalResolved(cur.resolved)) {
      findings.push(makeFinding('高', 'resolved-downgraded', '依赖被改成本地/git 来源', label,
        `resolved=${cur.resolved}`,
        '官方包被换成本地或 git 来源，常见于投毒或人为替换'));
    }

    if (cur.resolved && !cur.integrity) {
      findings.push(makeFinding('中', 'integrity-missing', '缺少完整性哈希', label,
        `resolved=${cur.resolved}`,
        '没有 integrity 就无法校验 tarball 内容，建议重新 npm ci 生成 lockfile'));
    }
  });

  Object.keys(before).forEach((key) => {
    if (after[key]) return;
    const old = before[key];
    findings.push(makeFinding('低', 'package-removed', '移除依赖', `${old.name}@${old.version}`, key,
      '如果不是主动卸载，确认是否有安装脚本在改 lockfile'));
  });

  return findings;
}

// 读取 node_modules 下一层/两层的 package.json，找安装期脚本；不递归进依赖的依赖
function scanInstalledScripts(nodeModulesDir) {
  const out = [];
  const inspect = (dir) => {
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) return;
    let pkg;
    try {
      pkg = readJson(pkgFile);
    } catch {
      return;
    }
    const scripts = lifecycleScripts(pkg);
    if (!scripts.length) return;
    out.push({
      name: String(pkg.name || path.basename(dir)),
      version: String(pkg.version || ''),
      scripts: scripts.reduce((acc, key) => {
        acc[key] = String(pkg.scripts[key]);
        return acc;
      }, {})
    });
  };
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      let subs;
      try {
        subs = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (sub.isDirectory()) inspect(path.join(full, sub.name));
      }
    } else {
      inspect(full);
    }
  }
  return out;
}

// 依赖名与常见包名的编辑距离（含相邻字母换位，axois → axios 算 1）；
// 命中即视为疑似仿冒（同名的会先被排除）
function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const rows = s.length + 1;
  const cols = t.length + 1;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i][0] = i;
  for (let j = 0; j < cols; j += 1) grid[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(
        grid[i - 1][j] + 1,
        grid[i][j - 1] + 1,
        grid[i - 1][j - 1] + cost
      );
      // 相邻两位互换（Damerau 的 OSA 变体）
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + 1);
      }
    }
  }
  return grid[s.length][t.length];
}

function typosquatCandidates(names, popular = POPULAR_PACKAGES) {
  const known = new Set(popular);
  const hits = [];
  Array.from(new Set(names)).forEach((name) => {
    const lower = String(name).toLowerCase();
    // scope 包先跳过：@types/* 这类近名太多，会淹没真正的仿冒
    if (!lower || lower.startsWith('@') || known.has(lower)) return;
    for (const target of popular) {
      if (Math.abs(lower.length - target.length) > 2) continue;
      const distance = levenshtein(lower, target);
      const threshold = target.length <= 6 ? 1 : 2;
      if (distance > 0 && distance <= threshold) {
        hits.push({ name: String(name), target, distance });
        break;
      }
    }
  });
  return hits;
}

function loadBaseline(file = BASELINE_FILE) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function saveBaseline(snapshot, installScriptNames, file = BASELINE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = {
    createdAt: new Date().toISOString(),
    lockfileVersion: snapshot.lockfileVersion,
    // 允许的安装期脚本包：基线里已存在的不再重复报
    allowedInstallScripts: Array.from(new Set(installScriptNames)).sort(),
    packages: snapshot.packages
  };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

function collectReport(options = {}) {
  const pkg = readJson(PKG_FILE);
  const lock = readJson(LOCK_FILE);
  const snapshot = createSnapshot(lock);
  const baseline = options.baseline === undefined ? loadBaseline() : options.baseline;
  const findings = [];

  // 1) lockfile 与基线对比
  if (baseline && baseline.packages) {
    findings.push(...diffSnapshots({ packages: baseline.packages }, snapshot));
  }

  // 2) 项目自身的安装期脚本（发布前的钩子也要有人看过）
  const ownScripts = lifecycleScripts(pkg);
  ownScripts.forEach((name) => {
    findings.push(makeFinding('中', 'project-install-script', '项目自身有安装期脚本', `package.json#${name}`,
      String(pkg.scripts[name]),
      '确认脚本内容可信；它会在 npm install 时自动执行'));
  });

  // 3) 已装依赖的安装期脚本：基线允许名单之外的一律报高
  const installed = options.installedScripts || scanInstalledScripts(NODE_MODULES);
  const allowed = new Set((baseline && baseline.allowedInstallScripts) || []);
  installed.forEach((item) => {
    const label = `${item.name}${item.version ? `@${item.version}` : ''}`;
    const detail = INSTALL_SCRIPTS
      .filter((key) => item.scripts[key])
      .map((key) => `${key}: ${item.scripts[key]}`)
      .join('; ');
    if (allowed.has(item.name)) return;
    findings.push(makeFinding(
      baseline ? '高' : '中',
      'install-script',
      baseline ? '新出现安装期脚本' : '依赖带安装期脚本',
      label,
      detail,
      baseline
        ? '基线里没有这个包的安装脚本，确认来源后再放行；可用 --update-baseline 记录为可信'
        : '尚未建立基线，先人工确认这些脚本可信，再运行 --update-baseline'
    ));
  });

  // 4) typosquat：只看 package.json 直接声明的依赖，避免把间接依赖全扫一遍
  const declared = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  typosquatCandidates(declared).forEach((hit) => {
    findings.push(makeFinding('高', 'typosquat', '疑似仿冒包名', hit.name,
      `与常用包 ${hit.target} 编辑距离 ${hit.distance}`,
      '核对包名拼写与作者，确认不是把正常依赖装成了仿冒包'));
  });

  // 5) 连基线都没有时给一条提示，避免「看起来全绿其实没对比」
  if (!baseline) {
    findings.push(makeFinding('低', 'no-baseline', '尚未建立依赖基线', LOCK_FILE,
      '本次只做了静态检查，无法发现「同版本被换内容」',
      '确认当前依赖可信后运行 node scripts/dependency-audit.js --update-baseline'));
  }

  const order = { 高: 0, 中: 1, 低: 2 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity])
    || a.id.localeCompare(b.id)
    || a.target.localeCompare(b.target));

  return {
    snapshot,
    installedScripts: installed,
    findings
  };
}

function main() {
  const update = process.argv.includes('--update-baseline');
  const json = process.argv.includes('--json');

  let report;
  try {
    report = collectReport({ baseline: update ? null : undefined });
  } catch (error) {
    console.error(`依赖检查失败：${error.message}`);
    return 2;
  }

  if (update) {
    const saved = saveBaseline(report.snapshot, report.installedScripts.map((item) => item.name));
    console.log(`已写入基线：${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(`  包 ${Object.keys(saved.packages).length} 个；允许安装期脚本 ${saved.allowedInstallScripts.length} 个`);
    return 0;
  }

  const count = { 高: 0, 中: 0, 低: 0 };
  report.findings.forEach((item) => { count[item.severity] += 1; });

  if (json) {
    console.log(JSON.stringify({
      packages: Object.keys(report.snapshot.packages).length,
      installedWithInstallScripts: report.installedScripts.length,
      count,
      findings: report.findings
    }, null, 2));
  } else {
    console.log(`检查依赖 ${Object.keys(report.snapshot.packages).length} 个，安装期脚本 ${report.installedScripts.length} 个，命中 ${report.findings.length} 处：高 ${count.高} / 中 ${count.中} / 低 ${count.低}\n`);
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
  POPULAR_PACKAGES,
  INSTALL_SCRIPTS,
  TRUSTED_REGISTRY_HOSTS,
  packageNameFromPath,
  isTrustedResolved,
  isLocalResolved,
  createSnapshot,
  lifecycleScripts,
  diffSnapshots,
  scanInstalledScripts,
  levenshtein,
  typosquatCandidates,
  loadBaseline,
  saveBaseline,
  collectReport,
  main
};

if (require.main === module) {
  process.exitCode = main();
}
