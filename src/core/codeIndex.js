'use strict';

// 按需符号索引：用 tree-sitter(WASM) 解析工作区里的源码，抽出「定义」和「引用」。
// 不做全量预索引（实测 2140 文件要 16s），只在调用时扫一次，并且：
//   1) 先用原始文本做名字预筛，不含目标名字的文件根本不解析；
//   2) 解析结果按 mtime+size 缓存，文件没改就复用；
//   3) 单次扫描有文件数上限，超了如实回报 truncated；截断时按「源码目录优先、
//      测试/示例/第三方目录靠后」挑文件，而不是按文件系统遍历顺序随便砍。
// 扫描遵守 .gitignore（含子目录里的），否则 vendor/生成目录会先吃掉配额。
// 正则 grep 会命中注释/字符串，这里只认语法树里的标识符，所以给模型的定位更准。

const fs = require('fs');
const path = require('path');

const GRAMMAR_DIR = path.join(__dirname, 'parsers', 'grammars');

// 扩展名 → grammar 名（只覆盖随包携带的 8 个 grammar）
const EXT_TO_LANG = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  // C++ 用独立 grammar。`.h` 默认归 C，但 langOf 会按「同名 .cpp 存在 / 内容含 C++ 关键字」
  // 改判为 cpp——否则 C++ 项目里 .h 的 class/namespace 会被 c grammar 解析成 ERROR。
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
  // 模板实现与 CUDA 都是 C++ 的派生方言，节点结构一致
  '.ipp': 'cpp',
  '.tpp': 'cpp',
  '.inl': 'cpp',
  '.cu': 'cpp',
  '.cuh': 'cpp',
  '.cs': 'csharp',
  '.php': 'php'
};

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.tox', '.mypy_cache', 'dist', 'build', 'target', '.next', '.nuxt', 'coverage'
]);

const MAX_FILE_BYTES = 1024 * 1024;
const CACHE_LIMIT = 4000;
const DEFAULT_MAX_FILES = 3000;
// web-tree-sitter 初始化后会改写自己的 module.exports，进程内只取一次类并存这里
let ParserClass = null;

// 定义节点表：[节点类型, 符号种类, 取名字段, 额外选项]
// fnOnly：变量声明只收「值是函数/类」的，避免把每个局部 const 都当符号
const DEF_SPECS = {
  javascript: [
    ['function_declaration', 'function'],
    ['generator_function_declaration', 'function'],
    ['class_declaration', 'class'],
    ['method_definition', 'method'],
    ['variable_declarator', 'function', 'name', { fnOnly: true, moduleLevelKind: 'variable' }],
    ['public_field_definition', 'field', 'name', { fnOnly: true }],
    ['field_definition', 'field', 'name', { fnOnly: true }]
  ],
  typescript: [
    ['function_declaration', 'function'],
    ['generator_function_declaration', 'function'],
    ['class_declaration', 'class'],
    ['abstract_class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['type_alias_declaration', 'type'],
    ['enum_declaration', 'enum'],
    ['method_definition', 'method'],
    ['method_signature', 'method'],
    ['variable_declarator', 'function', 'name', { fnOnly: true, moduleLevelKind: 'variable' }],
    ['public_field_definition', 'field', 'name', { fnOnly: true }],
    ['field_definition', 'field', 'name', { fnOnly: true }]
  ],
  python: [
    ['function_definition', 'function'],
    ['class_definition', 'class']
  ],
  go: [
    ['function_declaration', 'function'],
    ['method_declaration', 'method'],
    ['type_spec', 'type']
  ],
  rust: [
    ['function_item', 'function'],
    ['struct_item', 'struct'],
    ['enum_item', 'enum'],
    ['trait_item', 'trait'],
    ['type_item', 'type'],
    ['union_item', 'union'],
    ['const_item', 'constant'],
    ['static_item', 'static'],
    ['mod_item', 'module'],
    ['macro_definition', 'macro']
  ],
  java: [
    ['class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['enum_declaration', 'enum'],
    ['record_declaration', 'record'],
    ['annotation_type_declaration', 'annotation'],
    ['method_declaration', 'method'],
    ['constructor_declaration', 'constructor']
  ],
  c: [
    ['function_definition', 'function', 'declarator'],
    // 只有带 body 的 struct/enum 才算定义；`struct point p;` 只是使用
    ['struct_specifier', 'struct', 'name', { bodyType: 'field_declaration_list' }],
    ['enum_specifier', 'enum', 'name', { bodyType: 'enumerator_list' }],
    ['type_definition', 'type', 'declarator']
  ],
  cpp: [
    // 类内联定义和类外定义（`void Engine::run()`）都是 function_definition；
    // 有容器（类/结构体）时算 method，容器为空（namespace 里的自由函数）时回落成 function
    ['function_definition', 'method', 'declarator', { globalKind: 'function' }],
    ['class_specifier', 'class', 'name', { bodyType: 'field_declaration_list' }],
    ['struct_specifier', 'struct', 'name', { bodyType: 'field_declaration_list' }],
    ['union_specifier', 'union', 'name', { bodyType: 'field_declaration_list' }],
    ['enum_specifier', 'enum', 'name', { bodyType: 'enumerator_list' }],
    ['type_definition', 'type', 'declarator'],
    // 类内/头文件里的「只有声明没有 body」的成员函数：`void run();`
    // globalKind：容器为空时按普通函数算（头文件里的全局函数声明也是有效符号）
    ['declaration', 'method', 'declarator', { fnDeclarator: true, globalKind: 'function' }],
    // `void run() override;` / `int value() const;` 在 cpp grammar 里是 field_declaration
    ['field_declaration', 'method', 'declarator', { fnDeclarator: true }]
  ],
  csharp: [
    ['class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['struct_declaration', 'struct'],
    ['record_declaration', 'record'],
    ['enum_declaration', 'enum'],
    ['delegate_declaration', 'type'],
    ['method_declaration', 'method'],
    ['constructor_declaration', 'constructor'],
    ['property_declaration', 'property'],
    ['operator_declaration', 'method']
  ],
  php: [
    ['class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['trait_declaration', 'trait'],
    ['enum_declaration', 'enum'],
    ['method_declaration', 'method'],
    ['function_definition', 'function']
  ]
};
DEF_SPECS.tsx = DEF_SPECS.typescript;

// 这些节点出现在引用位置时，其文本才可能是一个符号名
const REF_NODE_TYPES = new Set([
  'identifier', 'field_identifier', 'type_identifier', 'property_identifier',
  'namespace_identifier', 'shorthand_property_identifier', 'shorthand_field_identifier',
  'package_identifier', 'name'
]);

// 能当作「所属容器」的节点类型
const CONTAINER_TYPES = new Set([
  'class_declaration', 'abstract_class_declaration', 'class_definition', 'class_specifier',
  'interface_declaration', 'impl_item', 'trait_item', 'trait_declaration',
  'struct_specifier', 'struct_item', 'struct_declaration',
  'enum_declaration', 'enum_specifier', 'enum_item', 'mod_item', 'namespace_declaration',
  'union_specifier', 'record_declaration'
]);

// 变量声明往上走到 program 之前允许经过的节点
const MODULE_LEVEL_ALLOWED = new Set([
  'lexical_declaration', 'variable_declaration', 'export_statement', 'ambient_declaration',
  'program', 'module'
]);

const FUNCTION_VALUE_TYPES = new Set([
  'arrow_function', 'function', 'function_expression', 'generator_function', 'class', 'class_declaration'
]);

// repo map 只列「结构型」符号：导入语句解构出来的 `{ add }`、纯数据常量不进地图，
// 否则一张图会被 fs/path/axios 这类 require 噪音占满。完整符号仍可用 code_find_symbol 查。
const MAP_SYMBOL_KINDS = new Set([
  'function', 'class', 'method', 'interface', 'type', 'enum', 'struct', 'trait',
  'record', 'annotation', 'constructor', 'module', 'macro', 'constant', 'static', 'union'
]);
const PLAIN_NAME_RE = /^[A-Za-z_$][\w$]*$/;

function langOf(file, text) {
  const ext = path.extname(file).toLowerCase();
  const lang = EXT_TO_LANG[ext] || '';
  if (lang !== 'c' || ext !== '.h') return lang;
  return looksLikeCpp(file, text) ? 'cpp' : lang;
}

// C++ 专属结构：class/namespace 声明、带名匿名命名空间、模板。C 里这些都不是关键字。
const CPP_HEADER_RE = /\b(?:class|namespace)\s+[A-Za-z_$]|\bnamespace\s*\{|\btemplate\s*</;
const CPP_SOURCE_EXTS = ['.cpp', '.cc', '.cxx', '.c++'];

// `.h` 的归属判决。先看同目录有没有同名 C++ 源文件（最可靠），再看内容特征。
// 传入的可能是 collectFiles 里的裸文件名，这种情况跳过存在性检查。
function looksLikeCpp(file, text) {
  if (path.isAbsolute(file)) {
    const stem = file.slice(0, file.length - path.extname(file).length);
    for (const ext of CPP_SOURCE_EXTS) {
      if (fs.existsSync(stem + ext)) return true;
    }
  }
  return !!text && CPP_HEADER_RE.test(text);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// 沿 declarator 链找真正的名字节点（C 的 `int *foo(...)` 这类要靠它）
function resolveNameNode(node, field) {
  if (field === 'declarator') {
    let cur = node.childForFieldName('declarator');
    let guard = 0;
    while (cur && guard++ < 8) {
      if (cur.type === 'identifier' || cur.type === 'type_identifier' || cur.type === 'field_identifier') {
        return cur;
      }
      // C++ 类外定义 `void Engine::run()`：名字藏在 qualified_identifier 的 name 上
      if (cur.type === 'qualified_identifier') {
        const named = cur.childForFieldName('name') || (cur.namedChildren || []).slice(-1)[0];
        if (!named || named.type === 'destructor_name') return null;
        return named;
      }
      // 析构函数不建符号（与构造函数不对称，先不引噪音）
      if (cur.type === 'destructor_name') return null;
      const next = cur.childForFieldName('declarator')
        || (cur.namedChildren || []).find(child =>
          child.type === 'function_declarator'
          || child.type === 'pointer_declarator'
          || child.type === 'reference_declarator'
          || child.type === 'array_declarator'
          || child.type === 'parenthesized_declarator'
        );
      if (!next) return null;
      cur = next;
    }
    return null;
  }
  return node.childForFieldName('name');
}

// declarator 链里是否出现 function_declarator（C++ 里区分「成员函数声明」和「数据成员」）
function hasFunctionDeclarator(node, depth = 0) {
  if (!node || depth > 3) return false;
  if (node.type === 'function_declarator') return true;
  for (const child of node.namedChildren || []) {
    if (hasFunctionDeclarator(child, depth + 1)) return true;
  }
  return false;
}

// 仅模块级变量声明（顶层 const/let）才收成符号，局部变量不进表
function isModuleLevel(node) {
  let cur = node.parent;
  let guard = 0;
  while (cur && guard++ < 6) {
    if (cur.type === 'program' || cur.type === 'module') return true;
    if (!MODULE_LEVEL_ALLOWED.has(cur.type)) return false;
    cur = cur.parent;
  }
  return false;
}

function containerName(node) {
  let cur = node.parent;
  let guard = 0;
  while (cur && guard++ < 8) {
    if (CONTAINER_TYPES.has(cur.type)) {
      const nameNode = cur.childForFieldName('name') || cur.childForFieldName('type');
      if (nameNode) {
        const text = nameNode.text.trim();
        if (text) {
          // `Cfg<T>` / `*Server` 这类取第一个标识符当容器名
          const head = text.match(/[A-Za-z_$][\w$]*/);
          return head ? head[0] : text;
        }
      }
    }
    cur = cur.parent;
  }
  return '';
}

// C++ 类外定义（`void Engine::run()` / `int core::Base::run()`）的容器只写在
// declarator 链里的 qualified_identifier 上，祖先节点里没有，需要单独挖。
function containerFromQualified(node, field) {
  if (field !== 'declarator') return '';
  let cur = node.childForFieldName('declarator');
  let guard = 0;
  while (cur && guard++ < 8) {
    if (cur.type === 'qualified_identifier') {
      // 去掉模板参数再按 `::` 切段，倒数第二段就是容器（最后一段是函数名）
      const parts = cur.text.replace(/<[^<>]*>/g, '').split('::').map(part => part.trim()).filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 2] : '';
    }
    const next = cur.childForFieldName('declarator')
      || (cur.namedChildren || []).find(child =>
        child.type === 'function_declarator'
        || child.type === 'pointer_declarator'
        || child.type === 'reference_declarator'
        || child.type === 'qualified_identifier'
      );
    if (!next) return '';
    cur = next;
  }
  return '';
}

// 依赖声明的抽取表：repo map 用「文件 → 被依赖文件」建图，再做 PageRank。
// 只记录能落到本仓库文件的引用；npm 包、系统头文件这类解析不到的会被丢弃。
const QUOTE_RE = /^['"`]|['"`]$/g;

function unquote(text) {
  return String(text || '').replace(QUOTE_RE, '').trim();
}

function collectImport(node, langName, out) {
  const add = value => {
    const v = String(value || '').trim();
    if (v) out.push(v);
  };
  const isJsLike = langName === 'javascript' || langName === 'typescript' || langName === 'tsx';

  if (isJsLike && (node.type === 'import_statement' || node.type === 'export_statement')) {
    const source = node.childForFieldName('source');
    if (source) add(unquote(source.text));
    return;
  }
  if (isJsLike && node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (!fn || fn.text !== 'require') return;
    const args = node.childForFieldName('arguments');
    const first = args && args.namedChildren && args.namedChildren[0];
    if (first && /^['"`]/.test(first.text)) add(unquote(first.text));
    return;
  }
  if (langName === 'python') {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren || []) {
        if (child.type === 'dotted_name') add(child.text);
        else if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) add(nameNode.text);
        }
      }
      return;
    }
    if (node.type === 'import_from_statement') {
      const match = /^from\s+([.\w]+)\s+import/.exec(node.text);
      if (match) add(match[1]);
      return;
    }
  }
  if (langName === 'go' && node.type === 'import_spec') {
    const pathNode = node.childForFieldName('path');
    if (pathNode) add(unquote(pathNode.text));
    return;
  }
  if (langName === 'rust' && node.type === 'use_declaration') {
    const raw = node.text.replace(/^use\s+/, '').replace(/;\s*$/, '').trim();
    if (!raw) return;
    const head = raw.split('{')[0].replace(/::\s*$/, '').trim();
    if (head) add(head);
    const group = /\{([^}]*)\}/.exec(raw);
    if (group && head) {
      for (const part of group[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) add(`${head}::${name}`);
      }
    }
    return;
  }
  if (langName === 'rust' && node.type === 'mod_item') {
    // `mod foo;` 才是文件模块；带 body 的内联模块不产生文件依赖
    if (!node.childForFieldName('body')) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) add(`mod$${nameNode.text}`);
    }
    return;
  }
  if (langName === 'java' && node.type === 'import_declaration') {
    const match = /^import\s+(?:static\s+)?([\w.]+)\s*;/.exec(node.text);
    if (match) add(match[1]);
    return;
  }
  if (langName === 'csharp' && node.type === 'using_directive') {
    // `using System;` / `using App.Core;` / `using Alias = App.Core;` 都取最后一个名字节点
    const last = (node.namedChildren || []).slice(-1)[0];
    if (last) add(`cs$${last.text}`);
    return;
  }
  if (langName === 'php') {
    if (node.type === 'namespace_use_declaration') {
      for (const clause of node.namedChildren || []) {
        if (clause.type !== 'namespace_use_clause') continue;
        const nameNode = (clause.namedChildren || []).find(child => child.type === 'qualified_name');
        if (nameNode) add(`php$${nameNode.text}`);
      }
      return;
    }
    if (node.type === 'require_expression' || node.type === 'require_once_expression'
      || node.type === 'include_expression' || node.type === 'include_once_expression') {
      const str = (node.namedChildren || []).find(child => child.type === 'string');
      if (str) add(unquote(str.text));
      return;
    }
  }
  if ((langName === 'c' || langName === 'cpp') && node.type === 'preproc_include') {
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return;
    if (pathNode.type === 'string_literal') {
      add(unquote(pathNode.text));
      return;
    }
    // 尖括号 include 走 `sys$` 标记：只按「仓库根 + 相对路径」解析，不做同名文件兜底，
    // 否则 <types.h> 这类系统头会误连到仓库里任意同名文件上。
    if (pathNode.type === 'system_lib_string') {
      const inner = pathNode.text.replace(/^</, '').replace(/>$/, '').trim();
      if (inner) add(`sys$${inner}`);
    }
  }
}

// ---------- .gitignore（子集实现） ----------
// 只支持实际会用到的语法：注释、空行、`!` 反选、结尾 `/` 只匹配目录、`*` `?` `**`、`[...]`。
// 规则按 git 的语义「最后一条命中的说了算」；被忽略的目录不再往下走（所以目录里的反选无效，
// 与 git 一致）。
function globToRegex(pattern) {
  let body = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { body += '(?:.*/)?'; i += 2; } else { body += '.*'; i += 1; }
      } else {
        body += '[^/]*';
      }
    } else if (ch === '?') {
      body += '[^/]';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) { body += '\\['; } else { body += pattern.slice(i, end + 1); i = end; }
    } else if ('\\^$.+()|{}'.includes(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
  }
  return new RegExp(`^${body}$`);
}

function parseGitignore(text, baseDir) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    // 中间带 `/` 或开头带 `/` 的都按「相对 .gitignore 所在目录」匹配，否则只比文件名
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    rules.push({ base: baseDir, negate, dirOnly, anchored, re: globToRegex(line) });
  }
  return rules;
}

function gitignoreFileRules(dir) {
  try {
    return parseGitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), dir);
  } catch (error) {
    return [];
  }
}

function isIgnored(rules, full, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const rel = toPosix(path.relative(rule.base, full));
    if (rel.startsWith('../')) continue;
    const target = rule.anchored ? rel : path.posix.basename(rel);
    if (!rule.re.test(target)) continue;
    ignored = !rule.negate;
  }
  return ignored;
}

// ---------- 截断时的取舍 ----------
// 超过文件数上限时，留下「更像真源码」的文件：源码目录加分，测试/示例/文档/第三方目录减分，
// 同分时浅层优先。目的是让 dst/、vendor/ 这类目录别把 src/ 挤出去。
const IMPORTANCE_RULES = [
  [/(^|\/)(src|lib|app|packages|internal|core|server|client|cmd|pkg)\//i, 3],
  [/(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|__mocks__|benchmarks?)\//i, -3],
  [/(^|\/)(examples?|samples?|docs?|demo|scripts?|tools?|migrations?)\//i, -2],
  [/(^|\/)(vendor|third_party|3rdparty|external|deps|bower_components)\//i, -5]
];

function importanceOf(rel) {
  let score = 0;
  for (const [re, bonus] of IMPORTANCE_RULES) if (re.test(rel)) score += bonus;
  return score;
}

// 遍历工作区，只收认识扩展名的文件；不跟随符号链接/junction（防环也防越界）
function collectFiles(root, maxFiles, base = root) {
  const files = [];
  let truncated = false;
  let scanned = 0;
  // 硬上限：真要全量遍历一个 10 万文件的仓库，walk 本身就要好几秒；多扫 10 倍已经够排序用了
  const hardLimit = Math.max(maxFiles, maxFiles * 10);

  // root 可能是子目录，从 base 到 root 这条链上的 .gitignore 都要先生效
  const chain = [];
  let cur = root;
  while (cur && cur !== path.dirname(cur)) {
    chain.unshift(cur);
    if (cur === base) break;
    cur = path.dirname(cur);
  }
  let rootRules = [];
  for (const dir of chain) rootRules = rootRules.concat(gitignoreFileRules(dir));

  const stack = [{ dir: root, rules: rootRules }];
  while (stack.length) {
    const { dir, rules } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= hardLimit) { truncated = true; stack.length = 0; break; }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (isIgnored(rules, full, true)) continue;
        const extra = gitignoreFileRules(full);
        stack.push({ dir: full, rules: extra.length ? rules.concat(extra) : rules });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!langOf(entry.name)) continue;
      if (isIgnored(rules, full, false)) continue;
      files.push(full);
      scanned += 1;
    }
  }

  files.sort((a, b) => {
    const ra = toPosix(path.relative(root, a));
    const rb = toPosix(path.relative(root, b));
    return importanceOf(rb) - importanceOf(ra)
      || ra.split('/').length - rb.split('/').length
      || ra.localeCompare(rb);
  });
  const skipped = files.length > maxFiles ? files.length - maxFiles : 0;
  return {
    files: skipped ? files.slice(0, maxFiles) : files,
    truncated: truncated || skipped > 0,
    scanned,
    skipped
  };
}

class CodeIndex {
  constructor() {
    this.parser = null;
    this.languages = new Map();
    this.brokenLangs = new Set();
    this.cache = new Map();      // fullPath -> { mtimeMs, size, symbols, imports }
    this.repoMaps = new Map();   // root|base|maxFiles -> { stamp, ranked }
    this.currentLang = '';
    this.readyPromise = null;
  }

  async ensureReady() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        // web-tree-sitter 的 init() 会把 module.exports 换成已初始化的 Emscripten 模块，
        // 之后再 require 拿到的对象上没有 init/Language。所以整个进程只在这里取一次类，
        // 后面的 CodeIndex 实例（比如 ToolRegistry 里那个）复用同一个类。
        if (!ParserClass) {
          const mod = require('web-tree-sitter');
          if (typeof mod.init === 'function') {
            await mod.init();
            ParserClass = mod;
          } else {
            // 已被别的模块初始化过：导出是 Emscripten 模块，Parser 类在 Parser 字段上
            ParserClass = mod.Parser || mod;
          }
        }
        this.Parser = ParserClass;
        this.parser = new ParserClass();
      })().catch(error => {
        this.readyPromise = null;
        throw error;
      });
    }
    await this.readyPromise;
  }

  async languageOf(name) {
    if (this.languages.has(name)) return this.languages.get(name);
    if (this.brokenLangs.has(name)) return null;
    const file = path.join(GRAMMAR_DIR, `tree-sitter-${name}.wasm`);
    if (!fs.existsSync(file)) {
      this.brokenLangs.add(name);
      return null;
    }
    try {
      const language = await this.Parser.Language.load(file);
      this.languages.set(name, language);
      return language;
    } catch (error) {
      // grammar 与运行时 ABI 不匹配会在这里炸（web-tree-sitter 必须锁 0.20.x），静默降级为不支持
      this.brokenLangs.add(name);
      return null;
    }
  }

  evictIfNeeded() {
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  // 解析一份文本，同时抽出「定义」和「依赖声明」（不缓存树，抽完立刻释放 WASM 内存）
  parseFileInfo(text, langName) {
    this.parser.setLanguage(this.languages.get(langName));
    const tree = this.parser.parse(text);
    const specs = DEF_SPECS[langName] || [];
    const symbols = [];
    const imports = [];
    try {
      const stack = [tree.rootNode];
      while (stack.length) {
        const node = stack.pop();
        for (const spec of specs) {
          if (node.type !== spec[0]) continue;
          const kind = spec[1];
          const field = spec[2] || 'name';
          const options = spec[3] || {};
          if (options.bodyType && !(node.namedChildren || []).some(child => child.type === options.bodyType)) break;
          if (options.fnOnly) {
            const value = node.childForFieldName('value');
            const fnLike = value && FUNCTION_VALUE_TYPES.has(value.type);
            if (!fnLike && !isModuleLevel(node)) break;
          }
          if (options.fnDeclarator) {
            const decl = node.childForFieldName('declarator');
            if (!hasFunctionDeclarator(decl)) break;
          }
          const nameNode = resolveNameNode(node, field);
          if (!nameNode) break;
          const name = nameNode.text;
          if (!name || name.length > 120) break;
          // Go 的方法容器写在 receiver 上，不在祖先节点里
          let container = containerName(node) || containerFromQualified(node, field);
          if (node.type === 'method_declaration') {
            const receiver = node.childForFieldName('receiver');
            if (receiver) {
              // receiver 形如 `(s *Server)`，取最后一个标识符
              const parts = receiver.text.replace(/[^A-Za-z0-9_$]+/g, ' ').trim().split(/\s+/);
              if (parts.length && parts[parts.length - 1]) container = parts[parts.length - 1];
            }
          }
          const finalKind = !container && options.globalKind ? options.globalKind : kind;
          symbols.push({
            name,
            kind: options.fnOnly && !FUNCTION_VALUE_TYPES.has((node.childForFieldName('value') || {}).type)
              ? (options.moduleLevelKind || finalKind)
              : finalKind,
            line: nameNode.startPosition.row + 1,
            container
          });
          break;
        }
        collectImport(node, langName, imports);
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    } finally {
      if (typeof tree.delete === 'function') tree.delete();
    }
    return { symbols, imports };
  }

  // 缓存键：mtime + size。老缓存（只有 symbols、没有 imports 的版本）按未命中处理
  fileInfoOf(full, text, stat, langName, stats) {
    const cached = this.cache.get(full);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.imports) {
      stats.cacheHits += 1;
      return cached;
    }
    stats.parsed += 1;
    const info = this.parseFileInfo(text, langName);
    this.cache.set(full, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      symbols: info.symbols,
      imports: info.imports
    });
    this.evictIfNeeded();
    return this.cache.get(full);
  }

  // 命中规则：全名/容器名精确 > 忽略大小写精确 > 名字包含。容器只参与精确匹配，
  // 否则查 Svc 会把 Svc.run、Svc.fetch 全带出来，噪音太大。
  static symbolScore(symbol, query, lowerQuery) {
    const name = symbol.name;
    const qualified = symbol.container ? `${symbol.container}.${name}` : '';
    if (name === query || qualified === query) return 3;
    if (name.toLowerCase() === lowerQuery || (qualified && qualified.toLowerCase() === lowerQuery)) return 2;
    if (name.toLowerCase().includes(lowerQuery)) return 1;
    return 0;
  }

  async findSymbols({ root, base, query, limit = 30, maxFiles = DEFAULT_MAX_FILES }) {
    await this.ensureReady();
    const started = Date.now();
    const { files, truncated, scanned: scannedFiles, skipped } = collectFiles(root, maxFiles, base);
    const lowerQuery = query.toLowerCase();
    // 预筛只需要文件里出现「名字本身」；Container.name 这种限定写法，文件里不会有整串
    const needle = lowerQuery.split('.').pop() || lowerQuery;
    const stats = {
      scanned: files.length, scannedAll: scannedFiles, skippedByLimit: skipped,
      skippedLarge: 0, candidates: 0, parsed: 0, cacheHits: 0
    };
    const found = [];
    for (const full of files) {
      if (found.length >= limit * 5) break;
      let stat;
      let text;
      try {
        stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) { stats.skippedLarge += 1; continue; }
        text = fs.readFileSync(full, 'utf8');
      } catch (error) {
        continue;
      }
      if (text.indexOf('\u0000') !== -1) continue;
      if (!text.toLowerCase().includes(needle)) continue;
      stats.candidates += 1;
      const langName = langOf(full, text);
      const language = await this.languageOf(langName);
      if (!language) continue;
      let symbols;
      try {
        symbols = this.fileInfoOf(full, text, stat, langName, stats).symbols;
      } catch (error) {
        continue;
      }
      for (const symbol of symbols) {
        const score = CodeIndex.symbolScore(symbol, query, lowerQuery);
        if (!score) continue;
        found.push({
          path: toPosix(path.relative(base, full)),
          line: symbol.line,
          kind: symbol.kind,
          name: symbol.name,
          container: symbol.container || undefined,
          score
        });
      }
    }
    found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
    const matches = found.slice(0, limit);
    return {
      query,
      total: found.length,
      truncated: truncated || found.length > matches.length,
      stats: Object.assign(stats, { elapsedMs: Date.now() - started }),
      matches
    };
  }

  // 引用查询不缓存（引用表太大），但同样先做文本预筛，只解析含目标名字的文件
  async findRefs({ root, base, name, limit = 50, maxFiles = DEFAULT_MAX_FILES }) {
    await this.ensureReady();
    const started = Date.now();
    const { files, truncated, scanned: scannedFiles, skipped } = collectFiles(root, maxFiles, base);
    const stats = {
      scanned: files.length, scannedAll: scannedFiles, skippedByLimit: skipped,
      skippedLarge: 0, candidates: 0, parsed: 0
    };
    const refs = [];
    for (const full of files) {
      if (refs.length >= limit) break;
      let stat;
      let text;
      try {
        stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) { stats.skippedLarge += 1; continue; }
        text = fs.readFileSync(full, 'utf8');
      } catch (error) {
        continue;
      }
      if (text.indexOf('\u0000') !== -1) continue;
      if (!text.includes(name)) continue;
      stats.candidates += 1;
      const langName = langOf(full, text);
      const language = await this.languageOf(langName);
      if (!language) continue;
      stats.parsed += 1;
      this.parser.setLanguage(language);
      const tree = this.parser.parse(text);
      try {
        const lines = text.split(/\r?\n/);
        const defNodes = new Set();
        const stack = [tree.rootNode];
        const hits = [];
        while (stack.length) {
          const node = stack.pop();
          for (const spec of (DEF_SPECS[langName] || [])) {
            if (node.type !== spec[0]) continue;
            const nameNode = resolveNameNode(node, spec[2] || 'name');
            if (nameNode) defNodes.add(nameNode.id);
          }
          if (REF_NODE_TYPES.has(node.type) && node.text === name) {
            const line = node.startPosition.row + 1;
            hits.push({
              id: node.id,
              line,
              column: node.startPosition.column + 1,
              context: (lines[node.startPosition.row] || '').trim().slice(0, 200)
            });
          }
          const children = node.namedChildren;
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
        // 定义自身的名字节点不算引用（前面先调用说明也能被正确排除）
        for (const hit of hits) {
          if (defNodes.has(hit.id)) continue;
          if (refs.length >= limit) break;
          refs.push({
            path: toPosix(path.relative(base, full)),
            line: hit.line,
            column: hit.column,
            context: hit.context
          });
        }
      } finally {
        if (typeof tree.delete === 'function') tree.delete();
      }
    }
    refs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return {
      name,
      total: refs.length,
      truncated: truncated || refs.length >= limit,
      stats: Object.assign(stats, { elapsedMs: Date.now() - started }),
      refs
    };
  }
  // 建一份「相对路径 → 绝对路径」索引，供依赖解析反复查询
  buildFileIndex(files, base) {
    const byRel = new Map();
    const byBase = new Map();
    const filesInDir = new Map();
    for (const full of files) {
      const norm = path.normalize(full);
      byRel.set(toPosix(path.relative(base, norm)), norm);
      const name = path.basename(norm);
      if (!byBase.has(name)) byBase.set(name, []);
      const baseList = byBase.get(name);
      if (baseList.length < 4) baseList.push(norm);
      const dir = path.normalize(path.dirname(norm));
      if (!filesInDir.has(dir)) filesInDir.set(dir, []);
      const dirList = filesInDir.get(dir);
      if (dirList.length < 12) dirList.push(norm);
    }
    return { byRel, byBase, filesInDir };
  }

  // 把一条依赖声明解析成仓库内的绝对路径（最多 8 个目标；解析不到返回空数组）
  resolveImport(fromFull, spec, base, index) {
    const langName = langOf(fromFull);
    const dir = path.normalize(path.dirname(fromFull));
    const out = new Set();
    const exists = p => index.byRel.get(toPosix(path.relative(base, path.normalize(p)))) || null;
    const tryPaths = list => {
      for (const p of list) {
        const hit = exists(p);
        if (hit) return hit;
      }
      return null;
    };
    const exts = {
      python: ['.py', '.pyi'],
      c: ['.h', '.c'],
      cpp: ['.hpp', '.hh', '.hxx', '.h', '.cpp', '.cc', '.cxx'],
      go: ['.go'],
      rust: ['.rs'],
      java: ['.java'],
      csharp: ['.cs'],
      php: ['.php']
    }[langName] || ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
    const stemsFor = stem => {
      const list = [stem];
      for (const e of exts) list.push(stem + e);
      for (const e of exts) list.push(path.join(stem, 'index' + e));
      if (langName === 'python') list.push(path.join(stem, '__init__.py'));
      return list;
    };
    const addPath = hit => { if (hit) out.add(hit); };
    const addBasename = (name, cap) => {
      for (const f of (index.byBase.get(name) || []).slice(0, cap || 2)) out.add(f);
    };

    if (langName === 'rust' && spec.startsWith('mod$')) {
      const name = spec.slice(4);
      addPath(tryPaths([path.join(dir, `${name}.rs`), path.join(dir, name, 'mod.rs')]));
      return [...out];
    }
    if (langName === 'rust') {
      const parts = spec.split('::').map(s => s.trim()).filter(Boolean);
      let start = dir;
      while (parts[0] === 'super') { start = path.dirname(start); parts.shift(); }
      if (parts[0] === 'self') parts.shift();
      if (parts[0] === 'crate') { parts.shift(); start = path.join(base, 'src'); }
      if (parts.length) {
        addPath(tryPaths([
          `${path.join(base, 'src', ...parts)}.rs`,
          path.join(base, 'src', ...parts, 'mod.rs'),
          `${path.join(start, ...parts)}.rs`,
          path.join(start, ...parts, 'mod.rs')
        ]));
      }
      if (!out.size && parts.length) addBasename(parts[parts.length - 1] + '.rs');
      return [...out];
    }
    if (langName === 'python') {
      const dots = /^(\.*)/.exec(spec)[1].length;
      if (dots) {
        let start = dir;
        for (let i = 1; i < dots; i++) start = path.dirname(start);
        const rest = spec.slice(dots).replace(/\./g, '/');
        addPath(tryPaths(stemsFor(rest ? path.join(start, rest) : start)));
        return [...out];
      }
      addPath(tryPaths(stemsFor(path.join(base, spec.replace(/\./g, '/')))));
      if (!out.size) addBasename(spec.split('.').pop() + '.py', 3);
      return [...out];
    }
    if (langName === 'go') {
      const parts = spec.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (!last) return [];
      const direct = index.filesInDir.get(path.normalize(path.join(base, ...parts)));
      if (direct) for (const f of direct) out.add(f);
      if (!out.size) {
        // 模块路径未必与仓库目录一致，退化为「同名目录」
        for (const [d, list] of index.filesInDir) {
          if (path.basename(d) !== last) continue;
          for (const f of list) out.add(f);
          if (out.size >= 8) break;
        }
      }
      return [...out];
    }
    if (langName === 'java') {
      const segments = spec.split('.').filter(Boolean);
      addBasename((segments.pop() || '') + '.java');
      // 静态导入 `a.b.C.method`：去掉方法名再试一次
      if (!out.size && segments.length) addBasename((segments.pop() || '') + '.java');
      return [...out];
    }
    if (langName === 'csharp' && spec.startsWith('cs$')) {
      // `using App.Core;` → 按命名空间对应目录（App/Core.cs）解析，PTR 项目常见的排布
      addPath(tryPaths(stemsFor(path.resolve(base, spec.slice(3).replace(/\./g, '/')))));
      if (!out.size) addBasename((spec.split('.').pop() || '') + '.cs', 3);
      return [...out];
    }
    if (langName === 'php' && spec.startsWith('php$')) {
      // `use App\Core\Base;` → 按 PSR-4 反斜杠转目录
      addPath(tryPaths(stemsFor(path.resolve(base, spec.slice(4).replace(/\\/g, '/')))));
      if (!out.size) addBasename((spec.split('\\').pop() || '') + '.php', 3);
      return [...out];
    }
    if (langName === 'c' || langName === 'cpp') {
      // 尖括号 include：只认仓库根下的相对路径（含 -I 之后的常见形态），不做同名兜底
      if (spec.startsWith('sys$')) {
        addPath(tryPaths(stemsFor(path.resolve(base, spec.slice(4)))));
        return [...out];
      }
      addPath(tryPaths(stemsFor(path.resolve(dir, spec))));
      if (!out.size) addPath(tryPaths(stemsFor(path.resolve(base, spec))));
      if (!out.size) addBasename(path.basename(spec));
      return [...out];
    }
    if (langName === 'php') {
      // require/include 的裸路径：先按当前文件目录，再按仓库根
      addPath(tryPaths(stemsFor(path.resolve(dir, spec))));
      if (!out.size) addPath(tryPaths(stemsFor(path.resolve(base, spec))));
      return [...out];
    }
    // JS/TS：只处理相对路径，裸包名（node_modules）一律忽略
    if (spec.startsWith('.')) addPath(tryPaths(stemsFor(path.resolve(dir, spec))));
    return [...out];
  }

  // 标准 PageRank：damping 0.85，20 轮足够收敛；悬挂节点把权重均分回全图
  static pageRank(nodes, edges, damping = 0.85, iterations = 20) {
    const count = nodes.length;
    let rank = new Map(nodes.map(n => [n, 1 / count]));
    const outCount = new Map(nodes.map(n => [n, (edges.get(n) || []).length]));
    for (let iter = 0; iter < iterations; iter++) {
      let dangling = 0;
      for (const n of nodes) if (!outCount.get(n)) dangling += rank.get(n);
      const baseScore = (1 - damping) / count + (damping * dangling) / count;
      const next = new Map(nodes.map(n => [n, baseScore]));
      for (const n of nodes) {
        const outs = edges.get(n);
        if (!outs || !outs.length) continue;
        const share = (damping * rank.get(n)) / outs.length;
        for (const target of outs) next.set(target, (next.get(target) || 0) + share);
      }
      let sum = 0;
      for (const v of next.values()) sum += v;
      if (sum > 0) for (const [k, v] of next) next.set(k, v / sum);
      rank = next;
    }
    return rank;
  }

  // 仓库地图：文件依赖图 + PageRank，按重要性排序后输出「文件 + 关键符号」。
  // 图结果按文件 mtime+size 指纹缓存，源码没改就只做一次排序和预算截断。
  async repoMap({ root, base, maxTokens = 700, maxSymbolsPerFile = 12, maxFiles = DEFAULT_MAX_FILES }) {
    await this.ensureReady();
    const started = Date.now();
    const { files, truncated: scanTruncated, scanned: scannedFiles, skipped } =
      collectFiles(root, maxFiles, base);
    const nodes = files.map(f => path.normalize(f));
    const statMap = new Map();
    let stampMtime = 0;
    let stampSize = 0;
    for (const full of nodes) {
      try {
        const stat = fs.statSync(full);
        statMap.set(full, stat);
        stampMtime += stat.mtimeMs;
        stampSize += stat.size;
      } catch (error) { /* 读不到就跳过，不影响其余文件 */ }
    }
    const stamp = `${nodes.length}:${Math.round(stampMtime)}:${stampSize}`;
    const key = `${base}|${root}|${maxFiles}`;
    const cachedMap = this.repoMaps.get(key);
    let ranked;
    let stats;
    const baseStats = { scanned: nodes.length, scannedAll: scannedFiles, skippedByLimit: skipped, skippedLarge: 0 };
    if (cachedMap && cachedMap.stamp === stamp) {
      ranked = cachedMap.ranked;
      stats = Object.assign({}, baseStats, { parsed: 0, cacheHits: nodes.length, edges: cachedMap.edges });
    } else {
      stats = Object.assign({}, baseStats, { parsed: 0, cacheHits: 0, edges: 0 });
      const infos = new Map();
      for (const [full, stat] of statMap) {
        if (stat.size > MAX_FILE_BYTES) { stats.skippedLarge += 1; continue; }
        const cached = this.cache.get(full);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.imports) {
          stats.cacheHits += 1;
          infos.set(full, cached);
          continue;
        }
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch (error) { continue; }
        if (text.indexOf('\u0000') !== -1) continue;
        // 先读内容再定语言：.h 的 C/C++ 归属要靠内容特征判决
        const langName = langOf(full, text);
        const language = await this.languageOf(langName);
        if (!language) continue;
        stats.parsed += 1;
        try {
          const info = this.parseFileInfo(text, langName);
          const entry = { mtimeMs: stat.mtimeMs, size: stat.size, symbols: info.symbols, imports: info.imports };
          this.cache.set(full, entry);
          infos.set(full, entry);
        } catch (error) { /* 单文件解析失败不影响整图 */ }
      }
      this.evictIfNeeded();
      const index = this.buildFileIndex(nodes, base);
      const edges = new Map();
      for (const [full, info] of infos) {
        const outs = new Set();
        for (const spec of info.imports) {
          for (const target of this.resolveImport(full, spec, base, index)) {
            if (target !== full) outs.add(target);
          }
          if (outs.size >= 12) break;
        }
        if (outs.size) edges.set(full, [...outs]);
      }
      const rank = CodeIndex.pageRank(nodes, edges);
      ranked = nodes.map(full => {
        const info = infos.get(full);
        return {
          path: toPosix(path.relative(base, full)),
          rank: rank.get(full) || 0,
          symbols: info ? info.symbols : [],
          symbolCount: info ? info.symbols.length : 0
        };
      }).sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
      stats.edges = [...edges.values()].reduce((sum, list) => sum + list.length, 0);
      this.repoMaps.set(key, { stamp, ranked, edges: stats.edges });
    }

    // 预算按字符算（英文/代码约 4 字符 ≈ 1 token），超出就少列文件，不硬塞
    const maxSymbols = Math.max(1, Math.min(parseInt(maxSymbolsPerFile, 10) || 12, 40));
    const budgetChars = Math.max(200, maxTokens) * 4;
    const rootLabel = toPosix(path.relative(base, root)) || '.';
    // 被上限砍过就显示「保留/总数」，让调用方知道地图并不完整
    const countLabel = skipped > 0 ? `${nodes.length}/${scannedFiles}` : `${nodes.length}`;
    const header = `# repo map ${rootLabel} · ${countLabel} files${scanTruncated ? ' (扫描已达上限)' : ''}`;
    const lines = [header];
    let used = header.length + 1;
    let included = 0;
    for (const entry of ranked) {
      const eligible = entry.symbols.filter(symbol =>
        MAP_SYMBOL_KINDS.has(symbol.kind) && PLAIN_NAME_RE.test(symbol.name));
      const names = eligible.slice(0, maxSymbols).map(symbol => {
        const name = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
        return `${name}@${symbol.line}`;
      });
      const extra = eligible.length > names.length ? ` …+${eligible.length - names.length}` : '';
      const line = `${entry.path} ${entry.rank.toFixed(4)} ${names.join(', ')}${extra}`.trim();
      if (used + line.length + 1 > budgetChars) break;
      lines.push(line);
      used += line.length + 1;
      included += 1;
    }
    const map = lines.join('\n');
    return {
      root: rootLabel,
      totalFiles: nodes.length,
      includedFiles: included,
      truncated: scanTruncated || included < nodes.length,
      estimatedTokens: Math.ceil(map.length / 4),
      stats: Object.assign(stats, { elapsedMs: Date.now() - started }),
      map
    };
  }
}

module.exports = CodeIndex;
module.exports.EXT_TO_LANG = EXT_TO_LANG;
module.exports.DEFAULT_MAX_FILES = DEFAULT_MAX_FILES;
