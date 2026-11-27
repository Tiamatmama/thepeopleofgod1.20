#!/usr/bin/env node
/**
 * 轻量静态安全扫描（借鉴 360 代码卫士那类「规则 + 分级」思路，按本项目裁剪）
 *
 * 为什么不用 360 代码卫士：它是企业版 Windows 客户端，主打 Java/C/C++/PHP，
 * 对 Node/JS 规则很少，还得把代码导入它的工程库。这里只保留真正能命中的规则，
 * 零依赖、本地跑、代码不出机器，结果可直接对照修复。
 *
 * 用法：
 *   node scripts/security-scan.js          # 人类可读报告，有「高」时退出码 1
 *   node scripts/security-scan.js --json   # 输出 JSON，便于接 CI
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts', 'public'];
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.html']);
// 第三方产物、模型、数据不扫，避免几十万行噪音
const SKIP_PATH = /(^|[\\/])(node_modules|data|vendor|models|\.git|tts_output|workspace)([\\/]|$)/;
const SKIP_FILE = /(security-scan\.js$|\.min\.js$)/;

const RULES = [
  {
    id: 'no-eval',
    name: '动态执行代码',
    severity: '高',
    // eval / new Function 会把字符串当代码跑；本项目不允许出现
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    hint: '改用具体解析逻辑，或 JSON.parse 等安全解析'
  },
  {
    id: 'shell-dynamic',
    name: '动态命令拼接',
    severity: '高',
    // exec(`...${var}...`) 这类模板拼接，变量里带引号/分号即可注入
    pattern: /\bexec(Sync)?\s*\(\s*`[^`]*\$\{/,
    hint: '改用 spawn(bin, [args]) 参数数组，不要把变量拼进命令串'
  },
  {
    id: 'path-tainted',
    name: '请求参数进入文件路径',
    severity: '高',
    // req 参数直接进 path.join/readFile 等，可能造成路径穿越
    pattern: /req\.(query|body|params)[^\n]{0,100}(path\.(join|resolve)|readFile|writeFile|unlink|rmSync|readdir)/,
    hint: '对文件名做白名单或 path.basename，并校验最终路径仍在允许目录内'
  },
  {
    id: 'innerhtml-tainted',
    name: '未转义 HTML 注入',
    severity: '中',
    // 把接口/消息数据直接塞进 innerHTML 是 XSS 的典型入口
    pattern: /innerHTML\s*=\s*(?!['"`])(data|msg|message|resp|response|raw|text|content|item|row)\b/,
    hint: '改用 textContent，或先经过 sanitizeHTML / escapeHTML'
  },
  {
    id: 'hardcoded-secret',
    name: '疑似硬编码密钥',
    severity: '中',
    // 16 位以上的字面量赋给 key/token/secret 类字段；占位词单独排除
    pattern: /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/i,
    hint: '移到 .env，并确认已在 .gitignore 里'
  },
  {
    id: 'cors-wildcard',
    name: 'CORS 全放开',
    severity: '中',
    pattern: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*/,
    hint: '只回显白名单来源，不要用 *，尤其带 Cookie 的接口'
  },
  {
    id: 'url-tainted',
    name: '请求参数作请求地址（SSRF）',
    severity: '中',
    // 地址来自 req 参数时，可能被诱导访问内网
    pattern: /(axios|fetch|http\.request|https\.request)\s*\(\s*(req\.|`\s*\$\{req\.)/,
    hint: '对目标域名做白名单，并禁止解析到内网地址'
  },
  {
    id: 'auto-approve',
    name: '高危工具自动放行',
    severity: '低',
    pattern: /TOOL_AUTO_APPROVE[^\n]{0,40}(true|['"]1['"])/,
    hint: '保持默认拒绝；远程通道（QQ 群）开启自动放行等于把命令执行交给群成员'
  },
  {
    id: 'ws-no-origin',
    name: 'WebSocket 未校验 Origin',
    severity: '低',
    // 仅做提示：出现 WebSocket.Server 但同文件没有 origin 校验时人工确认
    pattern: /new\s+WebSocket\.Server\s*\(/,
    hint: '确认升级阶段校验了 Origin，否则任意网页都能直连本地端口'
  }
];

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (SKIP_PATH.test(full) || SKIP_FILE.test(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(file) {
  const findings = [];
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return findings;
  }
  const hasOriginCheck = /isTrustedWsOrigin|verifyClient|headers\.origin/.test(lines.join('\n'));
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    // 注释行不参与匹配，减少假阳性
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) return;
    // 允许用注释定向豁免：`// security-scan-ignore`（全部）或 `// security-scan-ignore <规则id>`
    const ignoreInLine = `${lines[index - 1] || ''}\n${line}`.match(/security-scan-ignore(?:\s+([\w-]+))?/);
    const ignoreRule = ignoreInLine ? (ignoreInLine[1] || '*') : null;
    for (const rule of RULES) {
      if (ignoreRule && (ignoreRule === '*' || ignoreRule === rule.id)) continue;
      if (rule.id === 'ws-no-origin' && hasOriginCheck) continue;
      // 容器模板：innerHTML 里包一层 .map 生成列表时，字段通常在模板内部各自转义
      if (rule.id === 'innerhtml-tainted' && /\.map\(/.test(line)) continue;
      if (!rule.pattern.test(line)) continue;
      // 硬编码密钥排除「值本身是全大写环境变量名」的占位写法
      if (rule.id === 'hardcoded-secret' && /['"][A-Z][A-Z0-9_]{3,}['"]/.test(line)) continue;
      findings.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: index + 1,
        id: rule.id,
        name: rule.name,
        severity: rule.severity,
        hint: rule.hint,
        code: trimmed.slice(0, 160)
      });
    }
  });
  return findings;
}

function main() {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), []));
  const findings = files.flatMap(scanFile);
  const order = { 高: 0, 中: 1, 低: 2 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
    return findings.some((item) => item.severity === '高') ? 1 : 0;
  }

  const count = { 高: 0, 中: 0, 低: 0 };
  findings.forEach((item) => { count[item.severity] += 1; });
  console.log(`扫描 ${files.length} 个文件，命中 ${findings.length} 处：高 ${count.高} / 中 ${count.中} / 低 ${count.低}\n`);
  findings.forEach((item) => {
    console.log(`[${item.severity}] ${item.file}:${item.line}  ${item.name}（${item.id}）`);
    console.log(`      ${item.code}`);
    console.log(`      → ${item.hint}`);
  });
  if (!findings.length) console.log('未发现命中项。');
  return count.高 > 0 ? 1 : 0;
}

process.exitCode = main();
