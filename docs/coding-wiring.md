# 编程沙箱接线文档

覆盖本轮六项：**删除工作区 / 历史对话追溯 / 文件历史路径追踪 / API 配置入口 / 右栏三分区 / 新开对话**。

只写「谁调谁、数据落在哪、字段叫什么」，不重复业务设计。行号以落盘时为准，改动后可能漂移，按函数名检索。

> Claude Code 链路（讨论 → 交结论 → 沙箱执行 → 验收 → 回写任务板）单独见 `docs/claude-code-wiring.md`。
> 编程沙箱各子链路（任务板 / 工作区 / 信任审批 / 脚本台 / 闭环 / 工人池 / 竞技场 / 讨论巡检 / 点子 spike）与角色态接线见 `docs/coding-subchains.md`。

---

## 1. 总链路

```
浏览器 public/coding.html
   │  fetch（api / post，带登录态 cookie）
   ▼
Express src/server/routes/coding.js   ── requireCodingUser ──► 未登录 401
   │
   ├─► toolRegistry.coding  (CodingCenter, src/core/coding.js)   ← 文件/任务/转录/账本/工作区
   ├─► codingLoop           (src/core/codingLoop.js)             ← 闭环运行、事件流、快照
   └─► toolRegistry.codeWrite / codeApplyPatch / codeWriteFile   ← 写文件时顺手记账
   │
   ▼
data/coding/…（见下表）
   │
   └─► WS coding-event / tool-confirm-request  ──► 前端 handleCodingEvent（实时）
```

实时（WS）与追溯（HTTP 读转录）是两条独立通道：WS 断了不影响复盘，复盘也不依赖 WS。

---

## 2. 落盘结构

| 路径 | 写入方 | 读取方 | 说明 |
|---|---|---|---|
| `data/coding/workspaces/<userKey>/<taskId>/` | 编码工具 | 文件树 / 读写工具 | 真实工作区目录；导入的本地目录是 junction / symlink |
| `data/coding/transcripts/<runId>.jsonl` | `CodingCenter.appendTranscript` | `readTranscript` | 一行一事件，append-only，单份 4MB 封顶（超出不再追加） |
| `data/coding/file_history.log` | `CodingCenter.recordFileChange` | `readFileChanges` | JSONL，只记元数据（路径/时间/动作/字节），**不存内容** |
| `data/coding/loop_runs.json` | `CodingLoop.appendRun` | `getStatus().recent` | 最近 30 条快照；`recent` 只回后 10 条并倒序 |
| `data/coding/ui-state/<userKey>.json` | UI 状态接口 | `getUiState` | 打开的文件、激活文件、各 taskId 的信任档 |

`userKey = 'u_' + sha1(登录用户名).slice(0,16)`（`coding.js:439`）。所有用户态数据按它分桶，中文用户名也不会变成目录名。

---

## 3. 接口清单

| 方法 | 路径 | 入参 | 返回 | 路由 | 实现 |
|---|---|---|---|---|---|
| GET | `/api/coding/loop/status` | — | `{busy, activeCount, models, modelDefault, current, currentAll, recent}` | `routes/coding.js:420` | `codingLoop.getStatus()` |
| GET | `/api/coding/runs/:runId` | `?limit=`（默认 3000，上限 5000） | `{success, runId, total, events[]}` | `routes/coding.js:163` | `coding.readTranscript` |
| GET | `/api/coding/file-history` | `?taskId=&limit=`（默认 100，上限 500） | `{success, changes[]}`，倒序 | `routes/coding.js:172` | `coding.readFileChanges` |
| DELETE | `/api/coding/workspace/:taskId` | — | `{success, taskId, linked}` | `routes/coding.js:755` | `coding.deleteWorkspace` |
| GET | `/api/coding/trust` | `?taskId=` | 当前信任档 | `routes/coding.js:878` | `coding.getTrustLevel` |
| POST | `/api/coding/trust` | `{taskId, level}` | 设置结果 | `routes/coding.js:890` | `coding.setTrustLevel` |
| POST | `/api/coding/workspace/create` | `{taskId, trust?}` | 创建结果 | `routes/coding.js:739` | `coding.createWorkspace` |
| GET | `/api/user/custom-api` | — | `{config}`（含 `enabled/apiKey/model`，密钥按既有规则脱敏） | `routes/userApi.js:9` | `authModule.getCustomApiConfig` |

注意：`GET /api/coding/runs`（无 `:runId`，`routes/coding.js:154`）是**脚本执行日志** `runs.log`，与闭环回放无关，别接错。

鉴权：全部走 `requireCodingUser`；`codingOwner(req)` 取 `req.user.username`，admin 可用 `?owner=` 代看（`src/server/index.js:523`）。

---

## 4. 功能接线

### 4.1 删除工作区

**前端**

- 左栏每个工作区项右侧 `✕` → `deleteWorkspace(taskId)`（`public/coding.html:1006`）
- 设置页「工作区」卡片 → `deleteCurrentWorkspace()`（`coding.html:1254`）→ 转调同一个函数
- 流程：`confirm`（明说「导入的目录只摘链接，源项目不会被动」）→ `DELETE /api/coding/workspace/<taskId>` → `loadWorkspaces()`
- 删的是当前工作区时，同步清 `CURRENT_TASK / ACTIVE_FILE / OPEN_FILES / 文件树 / 标签页 / 代码视图`，并自动切到 `TASKS[0]`；没有剩余工作区就 `renderTrust()`

**后端**（`src/core/coding.js:717`）

1. `userKey` + `safeTaskId` 双校验（`taskId` 只允许 `^[A-Za-z0-9_-]+$`）
2. `path.dirname(resolve(dir)) !== resolve(root)` → 拒绝，防越界
3. `lstatSync(dir).isSymbolicLink()` 分流：**链接只摘链**（Windows `rmdirSync` / POSIX `unlinkSync`），真实目录才 `rmSync(recursive)`
4. 成功后删除该 taskId 的信任档，避免同名重建继承旧档

> 这条是安全红线：junction 直接递归会连源项目一起删掉。

### 4.2 历史对话追溯（按运行回放）

**事件怎么落盘**

```
CodingLoop.emitEvent(payload)              // codingLoop.js:320
  ├─ recordTranscript(payload)             // 只认带 runId 的事件，codingLoop.js:332
  │    └─ CodingCenter.appendTranscript    // coding.js:356，写失败静默，不影响闭环
  └─ eventNotifier(payload)                // WS 推送
```

**列表从哪来**

- 数据源：`GET /api/coding/loop/status` 的 `recent`（`loop_runs.json` 后 10 条，倒序），**不是** `/api/coding/runs`
- 快照里没有 owner 字段，前端用「我名下的工作区 taskId 集合」过滤，避免把别人的目标显示出来（`coding.html:1069` `loadRuns`）
- 渲染：`renderRuns()`（`coding.html:1095`）→ 徽章 + taskId + 时间 + 目标；点击 `openRun(runId)`

**详情怎么读**

- `openRun`（`coding.html:1110`）→ `GET /api/coding/runs/<runId>?limit=2000` → `readTranscript` 逐行 `JSON.parse`
- 坏行降级为 `{kind:'raw', text: line}`，不整份失败
- `renderEvent`（`coding.html:1142`）把事件映射成一行；未知 kind 直接丢弃
- 展开区域带 `onclick="event.stopPropagation()"`，点回放不会触发折叠

**事件契约**（字段名对齐 `CodingLoop.emitEvent` / `OutputModule.onEvent`）

| kind | 关键字段 | 回放展示 |
|---|---|---|
| `run_start` | `goal, model, maxIterations` | ▶ 开跑 · 底模 · 目标 |
| `iteration` | `iteration, maxIterations, nodeId` | 第 N 轮（带节点） |
| `assistant` | `text` | 正文摘要（600 字截断） |
| `thinking` | `text` | 💭 思考摘要（300 字） |
| `tool_call` | `id, name, args` | 🔧 工具名 + 参数 JSON |
| `tool_result` | `id, name, ok, output` | ↳ 结果；`ok===false` 标红 ✕ |
| `check` | `ok, reason` | 判据通过 / 未通过 |
| `node` | `nodeId, ok, sha, reason` | 节点结果 |
| `stage` | `stageId, ok, verdict` | 阶段结果 |
| `ask` | `questions[]` | ❓ 等你回答 |
| `answers` | `answers[]` | 🙋 已回答 |
| `run_end` | `status, result, error` | ■ 结束 · 状态（`passed` 绿色） |
| `error` | `message / error` | ⚠ 错误 |

### 4.3 文件历史路径追踪（自己记账，不依赖 git）

**写入点**（`src/core/toolRegistry.js`，三处）

| 工具 | action | path | taskId | 行号 |
|---|---|---|---|---|
| `codeWrite`（扁平脚本沙箱） | `write` | `workspace/<basename>` | `''` | 2770 |
| `codeApplyPatch` | `patch` | 工作区内相对路径 | `resolved.taskId` | 3078 |
| `codeWriteFile` | `create` / `overwrite` | 工作区内相对路径 | `taskId` | 3289 |

- `runId` 取 `this.activeContext.runId`，缺失时回落 `args.runId`
- `codeWriteFile` 的 `beforeBytes` 必须在写之前 `stat`（已修，别写回之后再读）
- `recordFileChange` 内部再跑一遍 `userKey` / `safeTaskId`，非法直接丢弃；写失败只吞

**读取**

- 账本记录：`{at, user, taskId, runId, path, action, beforeBytes, afterBytes}`
- `readFileChanges`（`coding.js:413`）倒序遍历，`limit` 默认 100 / 上限 500；传 `userId` 只回本用户（admin 不传可看全部）
- 前端 `loadFileChanges`（`coding.html:1166`）固定 `limit=200`，有当前工作区就带 `taskId` 收窄
- 点击条目 `openHistoryFile(i)`（`coding.html:1196`）→ 切回「文件」分区并 `openFile(path)` 看当前内容

> 边界：账本只记「动过」，不存快照，所以回看的是**当前**文件内容；要对比历史版本得上 git，本文档所述方案刻意不依赖它。
> 另：`codeWrite` 的 `taskId` 为空，按工作区过滤时会看不到这条（扁平脚本本来就与工作区无关）。

### 4.4 API 配置入口

- 设置页「API」卡片：`renderSettings()`（`coding.html:1213`）→ `GET /api/user/custom-api`
- 展示：`<model> · 已启用/未启用`，未配置显示「未配置」；已启用文字为绿色
- 「打开配置」复用主界面同一份弹窗（同一存储、同一份密钥），编程页不再单独维护表单
- 闭环选 `model=custom` 时，`routes/coding.js:435` 才去读 `getCustomApiConfigRaw`，**密钥只在服务端使用，不回传前端**；没配就直接返回错误提示，不会静默回落默认通道

### 4.5 右栏三分区

**DOM**（`coding.html:469` 起）

```
#rtabs              三个 .rtab：files / history / settings
#rp-files           📁 文件：文件树 + 打开标签 + 代码视图（原有能力整体搬进来）
#rp-history         🕘 历史：#hist-seg（runs / files）+ #hist-runs / #hist-files
#rp-settings        ⚙ 设置：#set-nav（api / ws / track / about）+ 四个 #sec-*
```

**状态**

| 变量 | 含义 |
|---|---|
| `RIGHT_TAB` | `files` / `history` / `settings` |
| `HIST_TAB` | `runs` / `files` |
| `RUNS` / `FILE_CHANGES` | 当前列表数据 |
| `REPLAY_RUN` | 正在展开的 runId（再点一次收起） |

**切换**

- `switchRightTab(name)`（`coding.html:1034`）：切 `.rtab.active`、显示对应面板、更新 `#tree-note`；进 history 调 `loadHistoryPanel()`，进 settings 调 `renderSettings()`
- `switchHistTab(name)`（`1046`）/ `switchSetSec(name)`（`1054`）：只切显示，不重复请求
- `selectTask`（`1273`）末尾会按当前分区补刷：history 重置 `REPLAY_RUN` 后重载，settings 重渲染
- `deleteWorkspace` 成功后若停在 settings，也会重渲染，避免显示已删的工作区

### 4.6 新开对话

- 入口：「执行对话流」标题右侧「＋ 新对话」（`coding.html:436`）→ `newChat()`（`1618`）
- 只清当前工作区的 `#chat`，恢复到初始提示；同时清 `toolCards` / `pendingToolCard` / `seenApprovals`（它们持有已移除节点的引用）
- `RUNNING`（含 `awaiting_input`）时拒绝：否则提问卡和停止入口会一起消失
- **不动后端**：每次运行本来就有独立 `runId` 和转录，清屏后照样能在「历史」里回放
- 纯静态页改动，刷新即生效，不用重启服务

### 4.7 Agent 集群（16 槽：4 写手 + 12 侦察）

- 入口：任务板抽屉「🧬 集群」Tab（`public/coding.html`）→ 目标 + 写手数 + 侦察数 + 源工作区 + 全局 token → 「🧠 规划」
- 规划：`POST /api/coding/fleet/plan`（`routes/coding.js`）→ `AgentFleet.plan`；有 `services.plan` 用注入规划器，否则 `planWithModel` 走 `outputModule.callModelOnce`，只输出 JSON
- 派发前声明：规划返回 `manifests[]`，前端用可编辑 JSON 展示；`POST /api/coding/fleet/dispatch` 可带 `manifests` 覆盖写集/读集，`normalizeManifest` + `DispatchDesk.admit` 会再校验一遍
- 执行：写手走 `codingLoop.start`（`toolAllowlist=WRITER_TOOLS`，不含 `code_run/code_git/code_deploy`）；侦察走 `FleetScout.run`（`outputModule.callWithTools`，只读工具集）
- 隔离：写手各复制一份工作区（`copyTaskWorkspace`），只把 `writes` 声明的路径 `git diff` 后 `git apply --3way` 回基座；源工作区被工人池/Claude Code 占用时 `sourceBusy` 拒绝
- 监控：`FleetMonitor` 5s tick，心跳续租 + TTL 回收 + 越界写对账（`git diff --name-only` / `ls-files --others`），越界即停写手并回滚
- 事件：`agentFleet.setEventNotifier`（`index.js`）广播 `{type:'fleet-*'}`；前端 `handleFleetEvent` 合并 400ms 重绘，Tab 打开且有在跑集群时 3s 轮询
- 控制：`/fleet/pause`、`/fleet/resume`、`/fleet/stop`；停止会断闭环 + 停侦察 + 释放全部租约
- 落盘：`data/coding/fleets/<fleetId>.json` + `data/coding/fleets/<fleetId>/events.jsonl`

---

## 5. 隔离与安全约束

1. **用户隔离**：所有用户态落盘都带 `userKey`；`codingOwner(req)` 是唯一取用户的地方，admin 才能 `?owner=` 越权查看
2. **命名白名单**：`taskId` / `runId` 一律过 `safeTaskId`（`^[A-Za-z0-9_-]+$`），拒绝 `..` 与路径分隔符
3. **路径越界**：工作区解析后必须落在 `workspaces/<userKey>/<taskId>` 内；删除前再校验一次父目录
4. **链接不递归**：junction / symlink 只摘链，绝不 `rmSync` 进去
5. **容量**：转录单份 4MB 封顶；账本读取有条数上限；`loop_runs.json` 只留最近 30 条
6. **失败不扩散**：转录、记账写失败都静默，不能让「复盘能力」把闭环本身弄挂
7. **命令执行根**：沙箱默认只认项目根；`code_run_tests` 会把当前工作区的**真实目录**作为 `allowedRoots` 传进去（`sandboxExec.resolveCwd(raw, allowedRoots)`）。导入目录在项目外，`icacls` 不跟随 junction，所以导入时（以及老工作区首次跑命令时 `ensureSandboxAccess`）会给 `pog_sandbox` 补 `(OI)(CI)M`——只影响用户明确交出来的那个目录
8. **联网工具**：闭环的 `toolFilter` 放行 `code_*` + `web_search` / `fetch_url`；这两个是只读外部请求，审批侧本就一律放行，不改变信任档语义
9. **Claude Code 通道**：`SandboxAgents` 不再把 `claude.exe` 直接 spawn 在宿主，而是走 `SandboxExec.startStreamed()` —— 与 `run_command` 同一套 `pog_sandbox` 账户 + Job Object（内存/进程数/杀树）+ 空闲与最长运行时长。prompt 经 stdin 文件送进（`-p` 不接位置参数），命令行里只有开关与模型名；环境只放行 `ANTHROPIC_*` / `CLAUDE_CODE_*`（`sanitizeAgentEnv`），宿主其余环境不进沙箱。输出由监督脚本写 `.out`，Node 侧按 300ms 增量读并逐行回流，`agent_output` 仍是实时的
10. **Claude Code 可读性**：CLI 默认装在宿主 `%APPDATA%\npm\...`，沙箱账户默认读不到。`sandbox-setup.ps1` 会给该目录授 `(OI)(CI)RX`（可用 `SANDBOX_CLAUDE_DIR` 换路径）；也可用 `SANDBOX_CLAUDE_BIN` 指向沙箱可读的副本。读不到时运行会失败并给出这两条修复路径，不会退回宿主直跑
11. **通道缺席**：凭据缺失 / 脚本缺失 / `SANDBOX_ENABLED=false` 时 `startStreamed` 直接拒绝启动（fail-closed），只有显式 `SANDBOX_ALLOW_HOST=true` 才退回宿主直跑，并在 `run.sandbox.degraded` 上标明

---

## 6. 已知边界（有意为之）

- 运行回放列表只有最近 10 条（`loop_runs.json` 保留 30 条，`getStatus` 只回 10）；更早的 run 仍能在 `transcripts/` 里按 runId 直接读，但页面上没有全量索引
- 转录超 4MB 后不再追加（保头不保尾）
- 文件账本不含内容，回看的是当前文件；不做 diff
- 回放只展示自己工作区的运行，不做跨用户浏览（admin 走接口层面 `?owner=`）
- 历史列表读的是内存/文件快照，正在跑的 run 状态可能滞后于 WS 实时流
- Claude Code 走沙箱通道要求 `pog_sandbox` 对 CLI 安装目录有 `(OI)(CI)(RX)`，由 `sandbox-setup.ps1` 授权。已实测走通：`claude.exe --version` → `2.1.268 (Claude Code)`，`exitCode=0`、`mode=account`、`degraded=false`。**重装 / 升级 Claude Code 后需以管理员重跑一次 setup**，否则报「沙箱账户读不到 Claude Code」
- `scripts/*.ps1` 必须保存为**单个 UTF-8 BOM**。重复 BOM（`EF BB BF` ×2/×3）会让 PowerShell 5.1 在第一个 `#` 前留下 U+FEFF，`param(` 块随之解析失败，报「赋值表达式无效」——`sandbox-setup.ps1` 与 `sandbox-run.ps1` 都踩过这个坑，改完脚本用 `[System.Management.Automation.Language.Parser]::ParseFile` 验一遍
- Claude Code 的模型请求走本地中转站（`/relay`），中转站**一律要求访问令牌**：令牌留空时所有请求 403，CLI 只在流里吐一句「认证失败」。因此 `relayHub` 启动时若发现 `authToken` 为空会自动生成一枚强随机令牌并落盘（`RELAY_AUTH_TOKEN` 可显式播种），`SandboxAgents` 取同一枚交给 `ANTHROPIC_AUTH_TOKEN`；没令牌时在启动前就拒绝并提示去「中转站」面板填，不再让用户对着 403 猜
- 导入的工作区是 junction，`realpath` 之后落在项目外：`SandboxAgents` 只把**当前工作区这一条真实路径**放进 `allowedRoots`（不放开整棵上级目录），并在启动前调 `coding.ensureSandboxAccess` 幂等补 `pog_sandbox:(OI)(CI)(M)`，否则老工作区一个 ACE 都没有、沙箱账户连文件都写不进去

---

## 7. 自测清单

**接口**（未登录应 401，登录后 200）

```powershell
# 列表与详情
curl.exe -s -b cookies.txt "http://127.0.0.1:41888/api/coding/loop/status"
curl.exe -s -b cookies.txt "http://127.0.0.1:41888/api/coding/runs/<runId>?limit=50"
curl.exe -s -b cookies.txt "http://127.0.0.1:41888/api/coding/file-history?limit=5"

# 删除工作区（先建一个测试工作区再删）
curl.exe -s -b cookies.txt -X DELETE "http://127.0.0.1:41888/api/coding/workspace/<taskId>"
```

**页面**

1. 左栏工作区点 `✕` → 确认 → 列表消失；若是当前工作区，中间栏清空并自动切到下一个
2. 导入的本地目录删除后，**源目录仍在**（只摘链接）
3. 历史 → 运行：点一条展开事件流，助手/思考/工具/判据/结束齐全；再点收起
4. 历史 → 文件改动：动作徽章与 `a→b B` 正确；点击跳到文件并打开
5. 设置：API 卡片显示模型与启用状态；信任三档切换后重进仍保持；删除工作区按钮可用
6. 对话流头部「＋ 新对话」：空闲时可清屏；执行中点击被拒绝并提示
7. 切工作区时，停在历史/设置的分区内容跟着换

**回归**

```powershell
npx eslint src public/coding.html --no-error-on-unmatched-pattern
node --test test/codingPolicy.test.js
```
