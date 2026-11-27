'use strict';

// 开源方案准入通道的判定规则（纯函数，不联网、不调模型）
//
// 三段小测：隐形字符夹带 / 文本提示注入 / 供应链元数据。
// 每段只产出「特征」，不回传原文——下游的隔离判定子进程只能看到这份特征，
// 因此有害内容不会跟着判定链路一起流动。

const { scanInvisibleChars } = require('../core/textGuard');

// ---- 第一段：文本提示注入 ----
// 只认「对模型下指令」的句式，不认普通技术文档里出现的安全名词
const INJECTION_RULES = [
  { id: 'ignore-instructions', label: '要求忽略既有指令', weight: 35, re: /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i },
  { id: 'ignore-instructions-zh', label: '要求忽略既有指令（中文）', weight: 35, re: /(忽略|无视|忘记)(以上|之前|前面|上述)(的)?(所有)?(指令|要求|提示|规则)/ },
  { id: 'role-hijack', label: '角色劫持', weight: 30, re: /(you\s+are\s+now|from\s+now\s+on\s+you\s+are|你现在(是|就是|扮演)|从现在(开始|起)你(是|扮演))/i },
  { id: 'chat-template-token', label: '伪造对话模板标记', weight: 30, re: /<\|(im_start|im_end|system|assistant|user|endoftext)\|>/i },
  { id: 'role-fence', label: '伪造角色围栏', weight: 20, re: /^[ \t]*```(system|assistant|developer)\b/im },
  { id: 'prompt-leak', label: '要求泄露系统提示', weight: 25, re: /(reveal|print|show|repeat|output)\s+(your\s+)?(system\s+)?(prompt|instructions)/i },
  { id: 'system-prompt-mention', label: '提及系统提示词', weight: 10, re: /(system\s*prompt|系统提示词|系统提示)/i },
  { id: 'long-base64', label: '超长 Base64 块（可能藏载荷）', weight: 15, re: /[A-Za-z0-9+/]{300,}={0,2}/ }
];

function scanInjection(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const hits = [];
  for (const rule of INJECTION_RULES) {
    let count = 0;
    let firstLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) {
        count += 1;
        if (!firstLine) firstLine = i + 1;
      }
    }
    if (count > 0) {
      // 只回传规则标识与行号，不回传命中的原文
      hits.push({ id: rule.id, label: rule.label, weight: rule.weight, line: firstLine, count });
    }
  }
  return { hits, total: hits.length };
}

// ---- 第二段：隐形字符夹带 ----
// 复用 textGuard 的码点表，保证「判定」和「清洗」用的是同一份定义
function scanInvisible(text) {
  const result = scanInvisibleChars(text);
  const weights = { tag: 60, bidi: 30, zeroWidth: 15, variation: 10, control: 5 };
  let score = 0;
  for (const [category, count] of Object.entries(result.byCategory)) {
    if (count > 0) score += weights[category] || 5;
  }
  return {
    total: result.total,
    byCategory: result.byCategory,
    codePoints: result.codePoints,
    score: Math.min(80, score)
  };
}

// ---- 第三段：供应链元数据 ----
const OFFICIAL_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'www.npmjs.com'
]);

// 常见包名：只用来发现「差一个字符」的仿冒，不做白名单
const POPULAR_PACKAGES = [
  'react', 'express', 'lodash', 'axios', 'typescript', 'webpack',
  'next', 'vue', 'electron', 'chalk', 'commander', 'debug', 'dotenv', 'zod'
];

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      last = tmp;
    }
  }
  return prev[n];
}

function scanSupplyChain(meta = {}) {
  const hits = [];
  const host = String(meta.host || '').toLowerCase();
  if (host && !OFFICIAL_HOSTS.has(host)) {
    hits.push({ id: 'untrusted-host', label: '非官方来源域名', weight: 50, detail: host });
  }

  const rawName = String(meta.packageName || meta.repo || '');
  const name = rawName.includes('/') ? rawName.split('/').pop() : rawName;
  const lower = name.toLowerCase();

  if (lower) {
    // 西里尔/希腊字母混进拉丁包名：同形字仿冒的典型特征
    if (/[\u0400-\u04FF\u0370-\u03FF]/.test(lower) && /[a-z]/.test(lower)) {
      hits.push({ id: 'mixed-script', label: '混用西里尔/希腊字母', weight: 40, detail: name });
    }
    const near = POPULAR_PACKAGES.find(p => p !== lower && levenshtein(lower, p) === 1);
    if (near) {
      hits.push({ id: 'typosquat', label: '与流行包名仅差一字符', weight: 35, detail: near });
    }
  }

  if (!meta.license) {
    hits.push({ id: 'no-license', label: '缺少许可证信息', weight: 10 });
  }

  const createdAt = Date.parse(meta.createdAt || '');
  if (Number.isFinite(createdAt) && Date.now() - createdAt < 30 * 86400000) {
    hits.push({ id: 'new-repo', label: '仓库创建不足 30 天', weight: 15 });
  }

  if (meta.url && !/^https:\/\//i.test(String(meta.url))) {
    hits.push({ id: 'no-tls', label: '来源不是 HTTPS', weight: 20 });
  }

  return { hits, total: hits.length };
}

// ---- 汇总定级 ----
function sumWeights(hits, cap) {
  const total = hits.reduce((sum, hit) => sum + (Number(hit.weight) || 0), 0);
  return Math.min(cap, total);
}

// 三段依次跑，每段记录耗时与是否通过；返回的总分用于定级
function assess({ text = '', meta = {} } = {}) {
  const startedAt = Date.now();

  const t1 = Date.now();
  const invisible = scanInvisible(text);
  const invisibleMs = Date.now() - t1;

  const t2 = Date.now();
  const injection = scanInjection(text);
  const injectionMs = Date.now() - t2;

  const t3 = Date.now();
  const supply = scanSupplyChain(meta);
  const supplyMs = Date.now() - t3;

  const parts = {
    invisible: invisible.score,
    injection: sumWeights(injection.hits, 60),
    supply: sumWeights(supply.hits, 60)
  };
  const score = Math.min(100, parts.invisible + parts.injection + parts.supply);
  const level = score >= 60 ? 'toxic' : score >= 25 ? 'suspicious' : 'clean';

  return {
    score,
    level,
    parts,
    elapsedMs: Date.now() - startedAt,
    stages: [
      {
        id: 'invisible',
        label: '隐形字符夹带',
        ms: invisibleMs,
        passed: invisible.total === 0,
        found: invisible.total,
        detail: { byCategory: invisible.byCategory, codePoints: invisible.codePoints }
      },
      {
        id: 'injection',
        label: '文本提示注入',
        ms: injectionMs,
        passed: injection.hits.length === 0,
        found: injection.hits.length,
        detail: { rules: injection.hits }
      },
      {
        id: 'supply-chain',
        label: '供应链元数据',
        ms: supplyMs,
        passed: supply.hits.length === 0,
        found: supply.hits.length,
        detail: { rules: supply.hits }
      }
    ]
  };
}

module.exports = {
  assess,
  scanInvisible,
  scanInjection,
  scanSupplyChain,
  INJECTION_RULES,
  OFFICIAL_HOSTS
};
