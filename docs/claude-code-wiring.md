# Claude Code 接线文档（编程沙箱 → 五人格会议 → Claude Code 执行）

覆盖：编程沙箱页「讨论」面板 → 多人格开会（只读工作区）→ 结论交给本机 Claude Code → 在沙箱监督通道里改工作区 → 验收闸 → 回写任务板 → 前端实时可见。
只写「谁调谁、字段叫什么、落在哪、失败怎么表现」；行号以落盘时为准，改动后按函数名检索。本文所有结论均按当前代码 + 实测日志核对过（2026-11-01）。

> 编程沙箱其余子链路（任务板 / 工作区 / 信任审批 / 脚本台 / 闭环 / 工人池 / 竞技场 / 讨论巡检 / 点子 spike）与角色态接线见 `docs/coding-subchains.md`。

---

## 1. 总链路

```
public/coding.html
  ├─ 🚀 开会并执行  runDiscussToAgent()  ─POST /api/coding/agents/team─┐
  └─ ⚡ 直接执行    runDirectToAgent()   ─POST /api/coding/agents/start┤
                                                                      ▼
src/server/routes/coding.js        ── requireCodingUser（本机 + 登录）/ codingOwner（登录用户名）
  ├─ resolveWorkspace(owner, taskId) → { taskId, dir }        （找不到就 400，不猜）
  ├─ codingTeam.discuss({ topic, context, memory, readTools, workspace, onProgress })
  ├─ rememberDiscussion(...) → codingLoop.appendProjectLesson （结论写回项目记忆）
  └─ sandboxAgents.start({ userId, taskId, prompt, model, title })
                                                                      ▼
src/core/sandboxAgents.js
  claimTask(doing) → 建日志 → startViaSandbox → 逐行解析 stream-json → finalizeRun → verifyRun → writeBackTask → agent_end
                                                                      ▼
src/core/sandboxExec.js  startStreamed()
  resolveCwd 路径闸 → resolveChannel 通道判定 → 写 .cmd/.prompt/.out/.err/.json
  → powershell scripts/windows/sandbox-run.ps1（低权账户 pog_sandbox + Job Object + 空闲超时 + EnvJson 白名单）
  → 300ms 增量读 .out → onLine
                                                                      ▼
claude.exe ──ANTHROPIC_BASE_URL=http://127.0.0.1:41888/relay──► src/server/routes/relay.js
                                                                  relayAuth（authToken）
                                                                      ▼
                                                     relayHub.resolveChain(model) → 通道（deepseek…）
                                                                      ▼
                                                            上游 api.deepseek.com
```

实时通道：`sandboxAgents.onEvent` → `src/server/index.js:700`（`sandboxAgents.setEventNotifier`）广播 `{type:'coding-event', kind:'agent_*'}` → 前端 `handleCodingEvent`。
追溯通道：HTTP `GET /api/coding/agents/:runId`（内存快照）+ `data/coding/agents/<userKey>/<taskId>/*.log`（全量原始流）。

---

## 2. 前端接线（`public/coding.html`）

| 元素 / 函数 | 位置 | 作用 |
|---|---|---|
| `#btn-discuss`「🗣 让团队开会」 | 707 | `runDiscuss()`（2293）：只开会，不启动 Claude Code |
| `#btn-discuss-agent`「🚀 开会并执行」 | 708 | `runDiscussToAgent()`（2346）：开会 → 结论交给 Claude Code |
| `#btn-direct-agent`「⚡ 直接执行」 | 709 | `runDirectToAgent()`（2406）：跳过开会，用户原话直接交给 Claude Code |
| 议题输入 | `#discuss-topic`（702）、`#discuss-context`（704） | topic 必填；context 是「贴材料」，不读工作区文件 |
| 讨论状态卡 | `startStatusCard` + `startProgressPoll('/api/coding/discuss/status')`（2372-2378） | 四段：发言 / 反驳 / 表决 / 归纳 |
| `watchAgentRun(resultEl, run)` | 2445 | 执行态卡片：`setInterval` 1s 计时 + **2s 轮询** `GET /api/coding/agents/<runId>`（2470）；终态后改标题/用时/日志路径 |
| `pushAgentTail(runId, text)` | 2486 | 把实时输出刷到讨论页卡片末尾（保留最后 400 字），抽屉盖住对话流时也看得见 |
| `handleCodingEvent(ev)` | 1705 | 只处理 `type==='coding-event'`；按 `owner`、`taskId` 过滤；`STOPPING` 时除 `run_end` 一律丢弃 |
| `agent_start` / `agent_output` / `agent_end` | 1743 / 1746 / 1749 | 系统行「Claude Code 启动/结束」、正文进对话流、结束刷新文件树并重开当前文件 |
| 「运行」Tab | 2874、2955 | `GET /api/coding/agents` 列最近 50 次；`POST /api/coding/agents/<runId>/stop` 停止 |

失败表现：`post()` 抛错或 `res.success===false` 时，卡片直接显示「直接执行失败：<message>」，hint 变红——不会静默。

---

## 3. 接口清单（`src/server/routes/coding.js`）

| 方法 | 路径 | 入参 | 返回 / 失败 | 路由 |
|---|---|---|---|---|
| GET | `/api/coding/agents` | — | `{success, runs[]}`（本人，按开始时间倒序，最多 50） | 514 |
| POST | `/api/coding/agents/start` | `{taskId, prompt, model?, title?}` | `{success, run}`；失败带 `error`/`code`（`conflict`→409、`busy`→429、其余 200） | 524 |
| POST | `/api/coding/agents/team` | `{topic, context?, taskId, model?, personaIds?, rounds?, sessionId?, clientToken?, title?}` | `{success, discussion, workspace, run}`；**启动失败时仍回 discussion** | 547 |
| GET | `/api/coding/agents/:runId` | — | `{success, run}`（非本人 → `无权查看别人的运行`） | 617 |
| POST | `/api/coding/agents/:runId/stop` | — | `stop()` 结果（先校验归属） | 627 |
| POST | `/api/coding/discuss` | `{topic, context?, taskId?}` | 只开会，不执行 | 206 |
| GET | `/api/coding/discuss/status` | `?clientToken=` | `{phase}`，供进度卡 | 242 |

`/agents/team` 的 `taskId` 必须能 `resolveWorkspace` 解析成功，否则 400「工作区不存在或不可用」（`:556`）——不会退回项目根。

---

## 4. 服务端装配与身份

- `src/server/index.js:260-271` 构造 `SandboxAgents`：`coding`（CodingCenter）、`codingLoop`（验收/记忆/检查点）、`sandbox`（SandboxExec）、`projectRoot`、`relayBaseUrl`、`relayToken: () => relayHub.config.authToken`、`defaultModel:'deepseek'`、`smallModel:'qwen'`、`concurrency:2`。
  `relayHub` 在本文件后面（`:580`）才构造，所以令牌用函数惰性取，不在定义期取值。
- 事件广播：`:700-705` `setEventNotifier` → `JSON.stringify({type:'coding-event', ...event})` 发给所有 WS 客户端（前端负责按 owner/taskId 过滤）。
- 门禁 `requireCodingUser`（`:513`）：默认「本机来源 + 已登录」；`CODING_ACCESS=cloud` 时只校验登录。
- 身份 `codingOwner`（`:527`）：取 `req.user.username`；admin 可用 `?owner=` 代看。工作区按 `userKey = 'u_' + sha1(username).slice(0,16)` 分桶。

---

## 5. 讨论阶段（只读，不写工作区）

- 只读工具根钉在工作区：`readToolsFor(workspace)`（`routes/coding.js:39`）→ `createReadTools({ root: workspace.dir })`。不传就退回项目根——**这是早期「讨论读了沙箱源码、结论落到别的工作区」的坑**。
- 记忆注入：`projectMemoryText(owner, workspace)`（`:45`）→ `codingLoop.loadProjectMemory`。
- 讨论实现 `codingTeam.discuss`（`src/core/codingTeam.js:375`）：常规发言轮（1-3 轮）→ 定向反驳 → 立场表决 → 主控归纳；产出 `structured.consensus` / `structured.actions`。
- 议题边界 `scopeNote`（`codingTeam.js:412-422`）：明确「只回答议题本身、别扩展成整仓审查/重构/安全评估、别主动读议题外文件」。这条是为「一句话的小活被十段发言淹没」加的。
- 结论落盘 `rememberDiscussion`（`:55`）→ `codingLoop.appendProjectLesson`，进入该工作区 `project.json` 的 lessons，下一轮闭环/讨论都读得到。
- 进度：`discussProgress.set(token, evt.phase)`，前端轮询 `/api/coding/discuss/status`。

---

## 6. 交给 Claude Code 的 prompt

`/agents/team`（`routes/coding.js:577-595`）按段拼接：

```
你正在沙箱工作区里执行一个已经过多 Agent 讨论的需求。
【目标工作区】<taskId>
【工作区真实路径】<dir>
【讨论主题】<topic>
【任务背景】<context，≤4000 字>
【团队共识】1. … n.
【下一步动作】1. … n.        ← 没有共识/动作时改用【团队结论】≤6000 字
【执行要求】
- 只改当前工作目录（本任务工作区）内的文件，不要动工作区之外的内容。
- 当前工作目录里的实际文件是唯一事实来源；结论里提到的路径若不存在，不要臆造。
- 按「下一步动作」落地；动作与共识冲突时以共识为准。
- 完成后用一段话总结：改了哪些文件、怎么验证的、还有什么没做。
```

直执（`/agents/start`）：`prompt` = 用户原话，若填了材料则追加 `\n\n【补充说明】\n<context>`（`coding.html:2428`）。上限 `MAX_PROMPT_CHARS = 20000`（`sandboxAgents.js:15`），超限直接拒绝。

---

## 7. `SandboxAgents` 生命周期（`src/core/sandboxAgents.js`）

| 步骤 | 函数（行） | 要点 |
|---|---|---|
| 校验 | `start()` 125 | 依次：owner 非空 → prompt 非空/≤20000 → `claudeBin` 存在 → **中转站令牌非空**（否则 `code: relay_token_missing` 直接拒，不启动） |
| 建/复用工作区 | `coding.createWorkspace` | `<workspaces>/<userKey>/<taskId>`；导入目录是 junction |
| 互斥 | `runningRuns()` | 同 `owner:taskId` 只能跑一个；总数 ≤ `concurrency`(2)；还与 `codingLoop.latestRun` 反互斥（同一工作区不许两条链同时改） |
| 占板 | `claimTask()` 479 | 任务置 `doing`、result 写 `[Claude Code 已接管] <runId> · model=…` |
| 日志 | 220-222 | `data/coding/agents/<userKey>/<taskId>/cc_<ts>_<rand>.log`，首行 `# <时间> task=… model=… cwd=…` |
| 命令行 | `:176-182` | `-p --output-format stream-json --verbose --permission-mode acceptEdits --model <id>`；**prompt 走 stdin**，不进命令行 |
| 环境 | `:183-189` | 只这 5 个：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（中转站令牌）、`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` |
| 启动 | `startViaSandbox()` 246 | 先 `coding.ensureSandboxAccess(workspace.dir)`（幂等补 ACL，失败只记日志）→ `allowedRoots=[workspace.dir]` → **cwd 取 realpath** → `sandbox.startStreamed` |
| 流解析 | `consumeLine` 331 / `handleLine` 460 | 只认 `type:'assistant'` 的 text 块（emit `agent_output`，截 2000 字）与 `type:'result'`（取 `result`/`error`）；其余原样留日志 |
| 收尾 | `finishRun` 345 → `finalizeRun` 355 | 补写缓冲行；`stopRequested`→`stopped`；`code≠0` 或 `error`→`failed`；否则进验收闸 |
| 验收闸 | `verifyRun()` 386 | `codingLoop.evaluate(ctx, auditRun, criteria)`（`passCommand`/`webCheck`/`stages`/`requireChange`）；有 stages 再跑 `runStages`；全过才 `done` + `commitCheckpoint`。**无验收器 = fail-closed** |
| 回写 | `writeBackTask()` 489 | `done`→任务 `done`；否则回 `todo` 并把原因写进 result（截 4000 字） |
| 广播 | `agent_end` | 带 `verification`、`sandbox.mode/degraded/reason`、`logFile` |
| 停止 | `stop()` 502 | 有 `stopHandle` 就杀监督进程（Job 的 `KILL_ON_JOB_CLOSE` 带走整棵树）；否则 `taskkill /T /F` |
| 清理 | `prune()` 529 | 内存只留最近 `KEEP_RUNS=50` 条已结束运行 |

---

## 8. `SandboxExec` 监督通道（`src/core/sandboxExec.js`）

- **路径闸** `resolveCwd(raw, allowedRoots)`（159）：`realpathSync` 后与 `projectRoot ∪ allowedRoots`（各自 realpath）小写比对，精确匹配或以 `<root>+path.sep` 开头才放行；否则返回 `null` → `startStreamed` 回 `工作目录不可用（只允许项目内或已导入的工作区路径）`。
- **通道判定** `resolveChannel`（238）：`mode=account` 且凭据文件存在 → `ok`；否则 `degraded`，`startStreamed` **默认拒绝**，只有 `SANDBOX_ALLOW_HOST=true` 才退回宿主直跑。
- **启动文件**（483-495）：`.cmd`（`@echo off` + `chcp 65001` + `"exe" "args" < "prompt"`）、`.prompt`（prompt 全文）、`.out`、`.err`、`.json`（结果）。
- **监督参数** `supervisorArgs`（423）：`-IdleMs/-MaxRuntimeMs/-MaxMemoryMB/-MaxProcesses/-CpuLimitMs/-ParentPid`，加 `-EnvJson`（经 `sanitizeAgentEnv` 过滤），account 模式再加 `-RunAsUser/-CredentialFile`。
- **环境白名单** `sanitizeAgentEnv`（72）：只留 `/^(ANTHROPIC_|CLAUDE_CODE_)/`，值 ≤500 字符且不含换行；宿主 `PATH`、API Key、代理一律不带进去。
- **增量读**（519-547）：`setInterval(drain, 300)` 只读 `.out` 的新增字节，`StringDecoder('utf8')` 续接跨块的多字节字符，按 `\n` 切行回调 `onLine`。
- **超时语义**（`scripts/windows/sandbox-run.ps1:388-394`）：`MaxRuntimeMs>0` 才封顶；`IdleMs>0` 时无输出即杀（默认 600000ms = 10 分钟）。Claude Code 传 `timeoutMs:0` 且 `SANDBOX_MAX_RUNTIME_MS` 默认 0 → **只有空闲超时，没有最长时长**。
- 默认值（`getConfig` 110-138）：`SANDBOX_MODE=account`、`SANDBOX_USER=pog_sandbox`、`SANDBOX_IDLE_MS=600000`、`SANDBOX_MAX_MEMORY_MB=4096`、`SANDBOX_MAX_PROCESSES=64`、`SANDBOX_CREDENTIAL_FILE=data/sandbox-credential.json`。
- 安装位置：`defaultClaudeBin()`（`sandboxAgents.js:19`）默认 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，可用 `SANDBOX_CLAUDE_BIN` 指向沙箱可读的副本。

---

## 9. 中转站（模型出口）

- 鉴权 `relayAuth`（`routes/relay.js:21-32`）：`relayHub.config.authToken` 为空 → **403「中转站未配置访问令牌」**；令牌从 `x-relay-token` / `Authorization: Bearer` / `x-api-key` 任一处取，比对失败 401。
- 令牌自动补齐（`relayHub.js:158-196`）：配置里 `authToken` 为空时生成 48 位十六进制并立即落盘；`RELAY_AUTH_TOKEN` 可显式播种。`SandboxAgents` 用 `relayToken: () => relayHub.config.authToken` 取同一枚 → `ANTHROPIC_AUTH_TOKEN`。
- 协议入口：`POST /relay/v1/messages`（`relay.js:311`）→ `anthropicToOpenAI(body)` → `relayHub.chat()` → `toAnthropicResponse`；`stream:true` 走 SSE；`POST /relay/v1/messages/count_tokens`（336）按字符量 `/3` 粗估。
- 模型路由 `resolveChain`（`relayHub.js:303`）：`auto`/空 → 全部启用通道按优先级；**别名**（默认 `main: [deepseek, qwen, doubao]`）→ 别名列表；通道 id 或模型名 → 单通道；认不出 → 回落全部启用通道。
  因此 `--model deepseek` = 别名命中 `deepseek` 通道（模型 `deepseek-flash`）。

---

## 10. 落盘

| 路径 | 写入方 | 内容 |
|---|---|---|
| `data/coding/agents/<userKey>/<taskId>/cc_<ts>_<rand>.log` | `SandboxAgents` | 首行元信息 + 原始 stream-json 逐行 + 末行 `# exit=… status=… verification=…`；启动失败时是 `# 启动被拒绝: <原因>` |
| `data/coding/tasks.json` | `CodingCenter.updateTask` | `doing` → `done`/`todo`，result 带 `[Claude Code <状态>] …` |
| `data/coding/workspaces/<userKey>/<taskId>/project.json` | `codingLoop.appendProjectLesson` | 讨论结论进 `lessons`（只读投影下一轮复用） |
| `data/relay/config.json` | `RelayHub` | `authToken`（明文，仅服务端使用）+ 通道 `apiKey`（对外接口返回掩码） |

日志按行全量保留（不做截断）；进前端对话流的正文截 2000 字、结果截 4000 字。

---

## 11. 权限与安全边界

- `scripts/windows/sandbox-setup.ps1`：项目目录 `pog_sandbox:(OI)(CI)M`（185-188）；敏感子目录/文件显式 deny（190-221）；**Claude Code 安装目录只给 `(OI)(CI)RX`**（224-229，可用 `SANDBOX_CLAUDE_DIR` 指定）；凭据文件清继承并只给创建者（252-258）。重装/升级 Claude Code 后需以管理员重跑一次。
- 导入工作区是 **junction**（`coding.js:990` `mklink /J`），而 `icacls` 不跟随 junction（`coding.js:919` 注释）→ 沙箱账户在真实目录上默认没有任何 ACE。`ensureSandboxAccess`（`coding.js:941`）按 `realpath` 小写做进程内缓存，首次补 `icacls <real> /grant pog_sandbox:(OI)(CI)M`。
- `SandboxAgents` 启动前调一次 `ensureSandboxAccess(workspace.dir)`（`sandboxAgents.js:249-258`），失败只打日志、不阻断启动。
- `allowedRoots` 只放**当前工作区这一条**，不放开整棵上级目录（与 `code_run_tests` 同一做法）。
- **cwd 取 realpath**（`sandboxAgents.js:262-269`）：cwd 是 junction 时，Claude Code 的 Write/Read 在权限检查后会再解析一次链接，判 `symlink resolution changed after permission was checked`，只能退回 bash 写文件；换成真实路径后工具链正常。发生替换时日志里补一行 `# cwd 是 junction，改用真实路径: …`。
- 输出与事件：`agent_end` 带 `sandbox` 字段（`mode`、`degraded`、`reason`、`durationMs`），前端「运行」Tab 与状态卡据此判断是账户模式还是降级。

---

## 12. 已知边界（有意为之）

- 无中转站令牌时不启动，宁可直接报错也不发一个注定 403 的请求。
- 无验收器（`codingLoop` 缺失）时 fail-closed：CLI 退出 0 也只算 `failed`，任务回 `todo`。
- Claude Code 没有最长时长，只有 10 分钟空闲关停；长任务需在 `SANDBOX_MAX_RUNTIME_MS` 里显式设上限。
- 同一工作区两条链互斥（Claude Code 与内置闭环不能同时改同一批文件），不同工作区最多并行 2 个。
- 讨论阶段只读，且只读工具钉在工作区；`context` 是用户贴的材料，不会被当作工作区文件去读。
- `scripts/*.ps1` 必须是**单个 UTF-8 BOM**；重复 BOM 会让 PowerShell 5.1 解析 `param(` 失败，报「赋值表达式无效」（`sandbox-setup.ps1`、`sandbox-run.ps1` 都踩过）。
- `relayHub` 自动补令牌只影响「空配置」；已有令牌一律不覆盖。

---

## 13. 自测（可直接照抄）

```powershell
# 1) 语法/结构
node --test test/sandboxAgents.test.js test/sandboxExec.test.js test/relayAuthToken.test.js
npx eslint src/core/sandboxAgents.js src/core/sandboxExec.js src/core/relayHub.js

# 2) 中转站鉴权：不带令牌应 401，带令牌应 200
$t = (Get-Content data\relay\config.json -Raw | ConvertFrom-Json).authToken
try { (Invoke-WebRequest http://127.0.0.1:41888/relay/v1/models -UseBasicParsing).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }
(Invoke-WebRequest http://127.0.0.1:41888/relay/v1/models -Headers @{Authorization="Bearer $t"} -UseBasicParsing).StatusCode

# 3) 沙箱账户能在导入工作区改文件
icacls.exe 'C:\Users\<用户名>\Desktop\program\safety' | Select-String 'pog_sandbox'

# 4) 真实链路：页面点「⚡ 直接执行」后看最新日志
Get-ChildItem data\coding\agents -Recurse -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  ForEach-Object { $_.FullName; Get-Content $_.FullName -Tail 2 }
# 期望末行： # exit=0 status=done verification=passed reason=…
# 若出现：# 启动被拒绝: 工作目录不可用 / 中转站未配置访问令牌 / 沙箱账户读不到 Claude Code —— 按上文第 8、9、11 节对应处理
```

---

## 14. 与 Agent 集群的互斥

- 源工作区互斥：`AgentFleet.dispatch` 前调 `sourceBusy(fleet)`，若 `sandboxAgents.runningRuns()` 里有同 `taskId` 的 Claude Code 运行，直接拒绝派发（`agentFleet.js:529-550`）。
- 工作区隔离：集群写手各复制一份基座工作区，不复用 Claude Code 的 `taskId`，两条链不会在同一目录里同时写。
- 事件分道：Claude Code 仍广播 `{type:'coding-event', kind:'agent_*'}`；集群广播 `{type:'fleet-*'}`，前端分别由 `handleCodingEvent` / `handleFleetEvent` 接管。
- 停止互不影响：`/api/coding/fleet/stop` 只停集群自己的写手闭环与侦察，不调用 `sandboxAgents.stop`；反之 `/agents/stop` 也不动集群槽位。
- 工人池同理：`WorkerPool.isDispatchable` 跳过 `fleet_` 前缀 / `kind=fleet*` / 带 `params.fleetId` 的任务，避免自动领单把集群子任务再跑一遍。
