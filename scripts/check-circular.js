'use strict';

// 循环依赖检测（零依赖）：从 src/ 下所有 .js 的 require() 静态图里找环。
// 为什么自己做而不用 madge：这条检查要能在 CI 与本机离线跑，不额外引入依赖。
// 用法：
//   node scripts/check-circular.js            # 检查 src/
//   node scripts/check-circular.js src test   # 指定根目录
// 有环时退出码 1，并打印每条环的完整路径。

const fs = require('fs');
const path = require('path');

const ROOTS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const roots = ROOTS.length ? ROOTS : ['src'];

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
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const files = new Set();
for (const root of roots) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) {
    console.error(`根目录不存在: ${root}`);
    process.exit(1);
  }
  walk(abs, []).forEach((f) => files.add(f));
}

const graph = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const deps = new Set();
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveRequire(file, m[1]);
    if (target && files.has(target)) deps.add(target);
  }
  graph.set(file, deps);
}

// Tarjan：强连通分量 > 1 即环；单点自环单独判
const index = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const sccs = [];
let counter = 0;

function strongConnect(v) {
  index.set(v, counter);
  low.set(v, counter);
  counter += 1;
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v)) {
    if (!index.has(w)) {
      strongConnect(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), index.get(w)));
    }
  }
  if (low.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length > 1 || graph.get(v).has(v)) sccs.push(comp);
  }
}

for (const file of files) {
  if (!index.has(file)) strongConnect(file);
}

const rel = (f) => path.relative(process.cwd(), f).replace(/\\/g, '/');

if (!sccs.length) {
  const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
  console.log(`循环依赖检查通过：${files.size} 个文件、${edges} 条内部依赖，无环。`);
  process.exit(0);
}

console.error(`发现 ${sccs.length} 组循环依赖：`);
for (const comp of sccs) {
  console.error(`\n[环] ${comp.map(rel).join('  ⇄  ')}`);
}
console.error('\n修法：把环上共用的一小块抽到更底层（无业务依赖）的模块，让依赖方向单向。');
process.exit(1);
