'use strict';

// 联网工具用到的网页文本处理与 URL 安全校验。
// 从 core/toolRegistry.js 抽出，保持纯函数、无副作用，便于单测与复用。

// 把 HTML 实体还原成普通字符（联网工具解析网页时用）
function decodeHtmlEntities(text = '') {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    hellip: '…', mdash: '—', ndash: '–', middot: '·', copy: '©',
    ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwj: '', zwnj: ''
  };
  const fromCodePoint = (code) => {
    try {
      return String.fromCodePoint(code);
    } catch (error) {
      return '';
    }
  };
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (named[name] !== undefined ? named[name] : m));
}

// 把 HTML 粗加工成可读纯文本：去掉脚本/样式/注释，块级标签换成换行
function htmlToText(html = '') {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 网页正文抽取：先按语义块去掉脚本/样式/导航/页脚/侧栏/表单等噪声，再优先取最长的
// <article>/<main> 主体（保留其内部 <header>，正文标题常在里面），找不到就退回整页。
// 用于 fetch_url，避免模型读到满屏菜单而不是正文。
function extractMainContent(html = '') {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');
  const blocks = [...text.matchAll(/<(article|main)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  if (blocks.length) {
    return blocks.sort((a, b) => b.length - a.length)[0];
  }
  return text;
}

// SSRF 防护：判断主机名是否指向内网 / 回环 / 链路本地 / 云元数据等不可信地址。
// fetch_url 的 url 由模型提供，若不拦住这些地址，模型可被外部页面诱导去读
// 本机服务或云厂商元数据接口（如 169.254.169.254）。
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;
  // IPv4：按段判定，覆盖回环、私网、链路本地与运营商级 NAT
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 127) return true;             // 0.0.0.0/8、回环 127/8
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 链路本地 169.254.0.0/16（含云元数据）
    if (a === 100 && b >= 64 && b <= 127) return true;  // 运营商级 NAT 100.64.0.0/10
    return false;
  }
  // IPv6：唯一本地 fc00::/7、链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // 任何以 :: 开头的地址都不是全局单播：未指定 ::、回环 ::1、IPv4-mapped ::ffff:x、
  // IPv4-compatible ::x 都在此列。注意 Node 的 URL 会把 ::ffff:127.0.0.1 归一成
  // ::ffff:7f00:1，只按点分十进制匹配会漏掉，所以这里直接按前缀拦。
  if (host.startsWith('::')) return true;
  return false;
}

// 校验待抓取 URL：协议限 http/https，且主机不能是内网 / 回环 / 元数据地址
function validateFetchTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return { ok: false, error: 'URL 格式不合法' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: '拒绝访问内网 / 本机 / 元数据等地址' };
  }
  return { ok: true, url: parsed.toString() };
}

module.exports = {
  decodeHtmlEntities,
  htmlToText,
  extractMainContent,
  isBlockedHost,
  validateFetchTarget
};
