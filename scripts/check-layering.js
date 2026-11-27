'use strict';

// 分层依赖方向检查：只允许「高层 → 低层」，禁止反向。
//
// 分层（数字越小越底层）：
//   storage(0)  纯持久化设施，按约定不依赖任何业务层
//   core(1)     业务核心；可以依赖 storage，不许依赖 tools / learning / session / intake / server
//   tools(2) / learning(2) / session(2) / intake(2)   外围能力；可以依赖 core / storage，层内互通
//   server(3)   装配层；可以依赖上面所有层
//
// 为什么不用「显式允许全部合法边」的白名单：边太多，维护成本高且容易漏。
// 这里用「层级序」表达方向，只把确实需要的倒挂写进 EXCEPTIONS（技术债），
// 这样新增的倒挂会立刻失败，旧债则每次都被打印出来提醒。
//
// 用法：node scripts/check-layering.js [src]
// 有违规时退出码 1。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'src');

const LAYERS = {
  storage: 0,
  core: 1,
  tools: 2,
  learning: 2,
  session: 2,
  intake: 2,
  server: 3
};

// 已接受的反向依赖：每条都要写清原因，新增必须先在这里登记（等于一次显式决策）。
const EXCEPTIONS = [
  {
    from: 'src/core/toolRegistry.js',
    to: 'src/tools/processManager.js',
    reason: '进程管理是工具中枢的执行器，属历史结构，待把执行器下沉到 tools 内部完成'
  },
  {
    from: 'src/core/toolRegistry.js',
    to: 'src/tools/codeIntegrity.js',
    reason: '完整性校验是工具中枢的执行器，属历史结构，待把执行器下沉到 tools 内部完成'
  },
  {
    from: 'src/core/memory.js',
    to: 'src/learning/vectorStore.js',
    reason: '向量索引（Qdrant/本地）是记忆的可选加速层，缺失时应降级到本地字面检索'
  }
];

function layerOf(abs) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const top = rel.split('/')[0];
  return Object.prototype.hasOwnProperty.call(LAYERS, top) ? top : null;
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (entry.name.endsWith('.js')) acc.push(path.resolve(abs));
  }
  return acc;
}

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const relOf = (abs) => path.relative(process.cwd(), abs).replace(/\\/g, '/');
const isExempt = (from, to) => EXCEPTIONS.find((e) => from === e.from && to.startsWith(e.to));

if (!fs.existsSync(ROOT)) {
  console.error(`根目录不存在: ${ROOT}`);
  process.exit(1);
}

const files = walk(ROOT, []);
const violations = [];
const exempted = [];

for (const file of files) {
  const fromLayer = layerOf(file);
  if (!fromLayer) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveRequire(file, m[1]);
    if (!target) continue;
    const toLayer = layerOf(target);
    if (!toLayer) continue;
    if (LAYERS[toLayer] <= LAYERS[fromLayer]) continue;
    const from = relOf(file);
    const to = relOf(target);
    const exempt = isExempt(from, to);
    (exempt ? exempted : violations).push({ from, to, fromLayer, toLayer, reason: exempt && exempt.reason });
  }
}

for (const item of exempted) {
  console.log(`[豁免] ${item.from} → ${item.to}（${item.fromLayer} → ${item.toLayer}）：${item.reason}`);
}

if (!violations.length) {
  console.log(`分层依赖检查通过：${files.length} 个文件；已登记豁免 ${exempted.length} 处。`);
  process.exit(0);
}

console.error(`发现 ${violations.length} 处分层违规（只允许高层引用低层）：`);
for (const v of violations) {
  console.error(`[违规] ${v.from} → ${v.to}（${v.fromLayer}(${LAYERS[v.fromLayer]}) 不应依赖 ${v.toLayer}(${LAYERS[v.toLayer]})）`);
}
console.error('\n修法：把被依赖的部分下沉到更底层；确需保留就在 scripts/check-layering.js 的 EXCEPTIONS 登记原因。');
process.exit(1);
