# devkit 契约 v1

来源：`emtionembedding` 的 7 个真实缺陷复盘（readout 重复尾值、key 硬编码、state 无校验、非原子写、无超时/结构校验、calib 调参口径不一致、实验产物覆盖正式配置）。
定位：**三个零依赖只读检查器**，整目录复制即可用。只覆盖已经真实发生过的错误形态，不做通用静态分析。

```
tools/devkit/
  callsite.js
  leakscan.js
  jsoncheck.js
  contract.md
  selftest/callsite/should-pass/a.js
  selftest/callsite/should-fail/b.js
```

## 0. 统一约定

| 退出码 | 含义 |
| --- | --- |
| `0` | 检查通过（或只有 unknown / skipped） |
| `1` | 被测对象有问题 |
| `2` | 检查器自身输入错误（参数错、路径不存在、空匹配） |

每个工具最后一行固定输出：

```
SUMMARY scanned=N hits=M unknown=K skipped=S
```

- `hits` 是**命中条数**，不是文件数；同一处可能被多条规则各记一次。
- `unknown` / `skipped` 不改变退出码。**看到 `unknown>0` 或 `skipped>0` 时，不许把 `exit 0` 读成「干净」**，必须人读 stderr 的 `UNKNOWN:` / `SKIP` 行。
- 三个工具都只读，不写被测目录。
- 门禁用例只用 `selftest/` 下的自建 fixture；真实仓库只作冒烟，不作 CI 门禁。

## 1. callsite —— 调用点是否显式传了某个键

```powershell
node callsite.js --symbol step --require updateB --in "calib.js,chat.js,src/**/*.js"
```

- `--symbol / --require / --in` 全部必填，`--in` 无默认值；逗号分隔，可混合文件、目录、glob（支持 `** * ? {a,b}`）。
- 判定：调用实参**少于 4 个** → `MISSING`；第 4 个实参是 `{...}` 字面量但不含该键 → `MISSING`；第 4 个实参是变量 → `UNKNOWN`（打到 stderr，不计命中、不改退出码）。
- 注释、字符串、函数/方法定义点不报。
- 退出码：有 `MISSING` 为 `1`，否则 `0`；参数/路径错为 `2`。

验收（已跑通）：

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `--in selftest/callsite/should-fail/b.js` | exit 1, hits 1 | `b.js:5 MISSING:updateB`，exit 1 |
| `--in selftest/callsite/should-pass/a.js` | exit 0, hits 0 | `scanned=1 hits=0`，exit 0 |
| `--in nope.js` | exit 2，无 findings | `ERROR 路径不存在：nope.js`，exit 2 |

真实仓库冒烟（cwd = `emtionembedding`）：

| 命令 | 实测 |
| --- | --- |
| `--symbol step --require updateB --in "calib.js,chat.js"` | `scanned=2 hits=0`，exit 0 |
| `--symbol step --require updateB --in "search_dyn.py"` | `search_dyn.py:133 MISSING:updateB`，exit 1 |

`search_dyn.py:133` 是真漏传，但只影响展示循环；补上 `updateB` 后此条翻转为 exit 0，所以**不能**把它当永久门禁。

测不到什么：

- 同名不同义：不同模块里的同名函数会被一起检查。
- 不查值：`updateB: false` 算「已显式传入」。
- 不做默认值推断、不追跨文件隐式前置条件。
- options 由变量、展开、工厂函数提供时只报 `UNKNOWN`，退出码不反映。
- 正则近似解析：嵌套模板字符串、正则字面量中的 `//` 可能被误当注释剥离。

## 2. leakscan —— 明文凭证扫描

```powershell
node leakscan.js .                         # 扫当前目录
node leakscan.js --glob "src/**/*.{js,py}" # 按模式扫
node leakscan.js config.env                # 指定文件
```

- 规则只有两条：`sk-` 后接 16+ 位字符；`api_key / token / secret` 赋值给 12+ 位的引号字符串。
- 流式按行读；文件上限 20MB、单行上限 1MB，超限记 `SKIP`，退出码仍只由 `hits` 决定。
- 输出只打前 4 位 + `…` + 后 4 位，不落完整凭证。
- 默认跳过 `node_modules/.git/dist/build/coverage/__pycache__`；`.env`、`.env.*` 在扫描范围内。

验收（已跑通）：

| 用例 | 期望 | 实测 |
| --- | --- | --- |
| 硬编码 `sk-...` | exit 1，脱敏 | `SK-LONG sk-a…3456` + `ASSIGN-SECRET apiKey=sk-a…3456`，exit 1 |
| `process.env.DK_KEY` / 短字符串 | 不报 | `hits=0`，exit 0 |
| 25MB 文件 | SKIP，不 OOM | `reason=file_too_large`，`skipped=1`，exit 0 |
| 2MB 单行文件 | SKIP，不 OOM | `reason=line_too_long`，`skipped=1`，exit 0 |
| 扫 `emtionembedding` 全仓 | 无明文 key | `scanned=55 hits=0 skipped=0`，exit 0 |

测不到什么：

- 只匹配明文模式：CSS 隐藏、编码/拼接变形、运行时注入都扫不到。
- **语义外泄扫不到**：例如 `blind_key.json` 这种把答案映射当普通 JSON 放仓库的文件，不含 `sk-` 也不含 `token=`，不会命中。这类问题要靠「产物目录不进版本库」的流程约束，不能靠本工具。
- 不判断凭证是否有效、是否已被撤销。
- 非 ASCII 内容跨 64KB 读缓冲边界可能出现替换符；不影响 ASCII 凭证规则。

## 3. jsoncheck —— JSON 语法与长度断言

```powershell
node jsoncheck.js check params.json
node jsoncheck.js check state.json --expect-len log=6
```

- 只证明「是合法 JSON」。坏档输出 `UNPARSEABLE at=offset N`，exit 1。
- `--expect-len key=n` 支持点路径（`a.b`），对象数组长度不符输出 `LEN key=实际 expected=n`，exit 1。
- 文件不存在 / 参数错 / 超过 50MB → exit 2。

验收（已跑通）：

| 用例 | 期望 | 实测 |
| --- | --- | --- |
| 合法 JSON | exit 0 | `PARSED ok=true`，exit 0 |
| `--expect-len log=3` 命中 | exit 0 | `log.length=3`，exit 0 |
| `--expect-len log=6` 不符 | exit 1 | `LEN log=3 expected=6`，exit 1 |
| 截断文件 | exit 1 + offset | `UNPARSEABLE at=offset 13`，exit 1 |
| 文件不存在 | exit 2 | `ERROR 文件不存在：…`，exit 2 |

测不到什么：

- 只证语法合法，不证值域、不证字段齐全（值域要靠 `--expect-len` 或业务断言）。
- 不承诺写入安全：写入必须配下面的原子写片段，否则「能解析」和「写坏了」可以同时成立。

## 4. 片段（降级交付，不随工具做门禁）

### 4.1 原子写（Node，12 行）

```js
function saveState(file, obj) {
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(obj))
    fs.fsyncSync(fd)          // 先落盘
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)    // 同目录 rename 才是原子的
}
```

要点：临时文件必须和目标同目录（跨盘 rename 不原子）；先 `fsync` 再 rename；失败时保留 `.tmp` 供排查。

### 4.2 远端响应校验（Node，5 行）

```js
const res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
const raw = await res.text()
if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`)  // 诊断只读前 200B
const data = JSON.parse(raw)
if (typeof data?.score !== 'number' || !Number.isFinite(data.score)) throw new Error('score 非法')
```

要点：必须有超时；错误体只截前 200B；数值字段显式做 `typeof + isFinite`，不要信 `JSON.parse`。

### 4.3 双实现对拍模板（40 行）

复制后替换 `--a` / `--b` 两条子进程命令。退出码分层：`1` = 数值超差，`3` = 对拍自身坏了（子进程失败/输出不是 JSON），避免把「对拍坏了」误读成「实现不一致」。

```js
#!/usr/bin/env node
'use strict'
// parity.js —— 双实现对拍模板。A/B 双方各返回 {log:[...]}，逐项比较最近窗口。
// 退出码：0=一致；1=超差；3=对拍自身坏了。
// 用法：node parity.js --a "node a.js" --b "python b.py" --tol 1e-6

const { execFileSync } = require('child_process')
const rest = process.argv.slice(2)
const arg = (name, def) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def }

function run(spec) {
    const [cmd, ...args] = spec.split(' ')
    try { return JSON.parse(execFileSync(cmd, args, { encoding: 'utf8' })) }
    catch (e) { console.error(`PARITY-BROKEN ${spec}: ${e.message}`); process.exit(3) }
}

const a = run(arg('--a')), b = run(arg('--b'))
const tol = Number(arg('--tol', '1e-6'))
if (!Array.isArray(a.log) || !Array.isArray(b.log)) {
    console.error('PARITY-BROKEN 两边都必须返回 {log: []}'); process.exit(3)
}

// 展示窗口 = 最近 5 条（含当前值）。长度不足时整体收窄，n=0 时为空。
// 历史 bug：窗口写成 slice(-5)，当前值被重复显示一次。
const winSize = (log) => Math.max(0, Math.min(log.length - 1, 4)) + 1
const win = (log) => log.slice(-winSize(log))
const wa = win(a.log), wb = win(b.log)

if (wa.length !== wb.length) {
    console.log(`PARITY-DIFF len ${wa.length} != ${wb.length}`); process.exit(1)
}
let diff = 0
for (let i = 0; i < wa.length; i++) {
    const d = Math.abs(wa[i] - wb[i])
    if (!(d <= tol)) { diff++; console.log(`PARITY-DIFF idx=${i} a=${wa[i]} b=${wb[i]} d=${d}`) }
}
console.log(`SUMMARY compared=${wa.length} diff=${diff} tol=${tol}`)
process.exit(diff ? 1 : 0)
```

说明：`parity` 与 `guardfetch` 是**模板/片段**，未接入任何仓库的运行时验证；复制后必须先用一组已知一致、一组人为制造偏差的数据自测 `exit 0 / exit 1 / exit 3` 三档。

## 5. 复制到新项目

1. 整个 `tools/devkit/` 拷到目标项目，不改路径也能跑。
2. 先跑三条 callsite fixture，确认检查器自身没坏。
3. 只把**与真实缺陷一一对应**的检查接进 CI；真实仓库冒烟结果写进 PR 描述，不做门禁。
4. 每次 `unknown>0` / `skipped>0`，在 PR 里写明原因，不许只贴 `exit 0`。
