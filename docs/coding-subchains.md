# 编程沙箱子链路接线（含角色态）

覆盖编程沙箱页的全部子链路：任务板 / 工作区 / 文件与信任审批 / 脚本工作台 / 编码闭环 / 工人池 / 竞技场 / 团队讨论与巡检 / 点子板与 spike / Claude Code 入口，以及「角色态 ↔ 沙箱态」的运行时接线。
只写「谁调谁、字段叫什么、落在哪、失败怎么表现」；行号以落盘时为准，改动后按函数名检索。核对日期：2026-11-01。

> Claude Code 执行链单独见 `docs/claude-code-wiring.md`；本轮六项深化见 `docs/coding-wiring.md`。

---

## 0. 子链路一览

| 子链路 | 前端入口 | 服务端入口 | 核心实现 | 主落盘 |
|---|---|---|---|---|
| 任务板 | 左侧任务列 | `/api/coding/tasks*`（`routes/coding.js:88-119`） | `CodingCenter.addTask/updateTask/listTasks`（`coding.js:105-168`） | `data/coding/tasks.json` |
| 工作区 | 新建 / 导入 / 删除 / 文件树 | `/workspaces`、`/workspace/*`、`/tree`、`/reveal`、`/open-vscode` | `createWorkspace`(542)、`importDir`(954)、`deleteWorkspace`(717)、`resolveInWorkspace`(574) | `data/coding/workspaces/<userKey>/<taskId>/` |
| 文件 / 状态 | 代码面板 | `/ws/file`、`/state`、`/file-history` | `codeReadRange`、`getUiState/saveUiState`、`readFileChanges` | 工作区文件 + `ui-state` + `file_history.log` |
| 信任 / 审批 | 信任档下拉 / 弹窗 | `/trust`、`/approvals*`；WS `tool-confirm-request` | `codeTrustDecision`（`toolRegistry.js:1518`） | `ui-state/<userKey>.json` 的 `trust` |
| 脚本工作台 | 「脚本」Tab | `/scripts`、`/file`、`/run`、`/save`、`/runs` | `resolveWorkspaceScript`(296)、`codeRun`(2797) | `data/coding/workspace/`、`runs.log` |
| 编码闭环 | 目标输入框 / 运行态卡片 | `/loop/start`、`/loop/stop`、`/loop/answer`、`/loop/status` | `CodingLoop.prepare/start/drive/evaluate` | `loop_runs.json`、`checkpoints/`、`project.json` |
| 工人池 | 工人面板 | `/workers/status`、`/workers/tick`、`/workers/auto` | `WorkerPool.tick/dispatchOne/settleTask` | 回写 `tasks.json` |
| 竞技场 | 竞赛面板 | `/compete/start`、`/compete/status`、`/compete/list`、`/compete/stop` | `CodingCompetition.start/launch/evaluate/rank` | `data/coding/competitions/<id>.json` |
| 集群（16 槽） | 🧬 集群 Tab | `/fleet/plan`、`/fleet/dispatch`、`/fleet/status`、`/fleet/list`、`/fleet/pause`、`/fleet/resume`、`/fleet/stop` | `AgentFleet.plan/dispatch/runFleet/mergeWriter`；`DispatchDesk.admit`；`FleetMonitor.tick`；`FleetScout.run` | `data/coding/fleets/<id>.json` + `events.jsonl` |
| 讨论 / 评审 / 巡检 | 讨论 / 评审 / 告警卡 | `/discuss*`、`/review*`、`/patrol`、`/alerts` | `CodingTeam.discuss/review/patrolOnce` | `data/coding/discussions/`、`alerts.log` |
| 点子板 / spike | 点子板 | `/diverge`、`/ideas*`、`/spike/*` | `CodingTeam.diverge/shortlistIdeas/judgeSpike` | `data/coding/ideas.json`、`VERDICT.md` |
| Claude Code | 🚀 / ⚡ 按钮 | `/agents*` | `SandboxAgents.start` | `data/coding/agents/<userKey>/<taskId>/*.log` |

---

## 1. 身份 / 门禁 / 运行时装配

```
coding.html ──x-session-id 头（登录态）──► routes/coding.js
   requireCodingUser（index.js:513）：本机 IP 校验（CODING_ACCESS=cloud 可关）+ 登录会话校验
   codingOwner(req)（index.js:527）：用户名派生归属；admin 可用 ?owner= 窥看他人
        ▼
   toolRegistry.coding / codingLoop / codingWorkers / codingCompetition / sandboxAgents / codingTeam
```

- 所有 `/api/coding/*` 路由都挂在 `requireCodingUser`；用户归属一律服务端派生，客户端传入的 `userId` 被覆盖（`routes/coding.js:99`、`434`、`486`）。
- 沙箱运行时（`runtimes.js:110-120`）：`createSandboxRuntime` 新建独立 `OutputModule`，`privateLife=null`、`ownsSession=false`。它只借器官（记忆 / 工具 / 情绪读取），不写情绪、不碰私生活。
- 装配（`index.js:244-280`、`364-376`）：`codingLoop` 用 `sandboxRuntime.outputModule`；`codingCompetition` 的评委也用它；`CodingTeam` 用独立 `new UnifiedAPI()` + `sessionManager`（只取主控名字）+ 项目根只读工具。
- 事件：`codingLoop.setEventNotifier`（`index.js:686`）与 `sandboxAgents.setEventNotifier`（`index.js:700`）都广播 `{type:'coding-event'}`；前端 `handleCodingEvent`（`coding.html:1705`）按 `owner/taskId` 过滤。
- `data/coding/workspace`（无 workspace 后缀）是扁平脚本工作台；`data/coding/workspaces`（复数）才是按用户/任务隔离的 git 工作区，两者不是一回事。

---

## 2. 任务板

- 存储 `data/coding/tasks.json`：`{seq, tasks[]}`，`writeJsonAtomicSync` 单写者 + 原子替换。
- 任务形状（`coding.js:73-89`）：`id=c_<seq>`、`title`、`desc`、`params{}`、`status ∈ todo|doing|done`、`result`、`createdBy`、`parent`、`order`、`createdAt/updatedAt`。
- `addTask`（113）：`parent` 只认已存在的任务 id，防悬空父子；`order` 缺省用自增序号；新任务 `unshift` 到表头。
- 路由：`GET/POST /api/coding/tasks`、`PUT/DELETE /api/coding/tasks/:id`；返回 `{success,task|tasks}`。
- 下游读取：工人池 `listTasks('todo')`；讨论结论 `findingsToTasks`；点子 `shortlistIdeas` 与 `promoteIdea` 都往这里立项。
- 一键开跑 `POST /api/coding/tasks/:id/start`（474）：按 `params.kind` 分派，`spike → startSpike`、`idea-promoted → 实现闭环`；归属不符 403、已完成 409、找不到 404。

---

## 3. 工作区

- 目录：`data/coding/workspaces/<userKey>/<taskId>/`；`userKey='u_'+sha1(用户名).slice(0,16)`（`coding.js:439`），中文用户名不会变成目录名。
- `createWorkspace`（542）：`mkdir` + 写 `.gitignore`（`node_modules/ .git/ data/`）+ `git init` + `add -A` + 首次提交；已存在则复用，返回 `{success,taskId,dir,existed,gitReady}`。
- 路径安全两道闸（`resolveInWorkspace` 574）：先词法（`target` 必须落在 `base` 内），再 `realpath`（真实位置也必须落在工作区真实位置内），挡住 junction / symlink 越界。
- 导入本地目录（`importDir` 954）：入口先过黑名单 `blockedImportReason`（612）——磁盘根、系统目录、用户主目录根、本项目自身一律拒；Windows 用 `mklink /J`（免管理员），POSIX 用 `fs.symlinkSync`；随后 `git init`，并给沙箱账户补 ACL（`grantSandboxAccess` 922，`icacls <real> /grant pog_sandbox:(OI)(CI)M`，失败只回 `warning`）。
- 删除（`deleteWorkspace` 717）：链接只摘链（Windows `rmdir` / POSIX `unlink`），真实目录才递归删；同时清掉该任务的信任档。
- 其他路由：`GET /workspaces`、`GET /workspace/status`（分支 + 是否干净）、`GET /tree`（工作区列表 + `codeListDir`）、`GET /ws/file`（`codeReadRange` 带行号）、`POST /reveal`（资源管理器）、`POST /open-vscode`。
- 失败表现：显式指定了 `taskId` 但解析不到，讨论/执行直接 400「工作区不存在或不可用」，**不会悄悄退回沙箱项目根**（`routes/coding.js:214-216`、`556-557`）。

---

## 4. 文件、UI 状态、信任与审批

- UI 状态 `data/coding/ui-state/<userKey>.json`：`{openFiles[≤50], activeFile, trust{<taskId>: readonly|ask|auto}}`；`getUiState`(451) / `saveUiState`(469) 浅合并。
- 信任三档：`readonly` 写/跑/提交直接拒；`ask` 逐次弹审批；`auto` 放手。默认 `ask`（`coding.js:38-39`）。
- `codeTrustDecision`（`toolRegistry.js:1518`）统一裁决：`research` 全放行；`code_git` 的 status/diff/log/show 放行；白名单测试命令放行（`isWhitelistedTestCommand` 1553，含管道/重定向/串接符一律不放）；不在受管控集合的其他编码工具放行；否则按 `getTrustLevel(userId, taskId)` 判。
- 审批双通道：WS `tool-confirm-request`（`index.js:597-606`，带 `owner` 供前端过滤）+ HTTP 兜底 `GET /api/coding/approvals`、`POST /api/coding/approvals/:id`（`routes/coding.js:900-916`）。编码闭环 `origin:'coding'`，审批只投到编码页，不窜主界面。
- 文件账本 `data/coding/file_history.log`：JSONL，只记元数据（user/taskId/runId/path/action/beforeBytes/afterBytes），不存内容；`GET /file-history?taskId=&limit=` 倒序（默认 100、上限 500）。
- 转录：`data/coding/transcripts/<runId>.jsonl` append-only、单份 4MB 封顶；`GET /runs/:runId?limit=`（默认 3000、上限 5000）。
- 注意：`GET /api/coding/runs`（154）是脚本执行日志 `runs.log`，与 `GET /runs/:runId`（闭环回放）不同，别接错。

---

## 5. 脚本工作台（扁平沙箱）

- 根目录 `data/coding/workspace/`（`coding.js:14`），只放 `.py/.js` 脚本，无 git、无 taskId。
- `GET /scripts`：`listScripts`(318) 按 mtime 倒序；`GET /file?name=` → `codeRead`（`toolRegistry.js:2783`，`path.basename` + 目录内校验）。
- `POST /run` → `codeRun`（2797）：单次最长 10 分钟（`timeoutMs` 上限 600000）；跑完 `coding.logRun` 追加 `runs.log`（time/script/language/exitCode/success）。
- `POST /save` → `codeWrite`（2763）：按后缀推断语言（`.js`→node，其余→python）；顺手 `recordFileChange`，`path` 写成 `workspace/<name>`、`taskId` 为空，与 git 工作区区分。
- 这是「免授权但边界收紧」的入口：路径只能落在该目录内，不适合真实项目改动；真实项目走工作区 + 编码闭环。
- 团队巡检只盯这里：`recentRuns(50)` 读 `runs.log`，失败才拉人格做日志抓点。

---

## 6. 编码闭环（主力链路）

```
POST /loop/start (432) ─► CodingLoop.start (738)
  prepare (436)：校验 userId/taskId/goal；建/复用工作区；通道白名单 qwen|deepseek|custom
  clarify (546)：目标含糊先提问 → status=awaiting_input → POST /loop/answer (459)
  drive (1053)：每轮 callWithTools(history, {...}) → 工具执行 → 下一轮
  evaluate (1596)：静态诊断 → 测试命令 → securityGate → webCheck / stages
  commitCheckpoint (1876) → 更新 project.json → run_end
```

- `callWithTools` 关键参数（`codingLoop.js:1143-1187`）：`sessionId: ctx.sessionId || 'coding_<userId>_<taskId>'`、`scope:'ai'`、`origin:'coding'`、`taskId`、`toolFilter` 只放行 `code_*` + `web_search`/`fetch_url`、`includeAffectionTool:false`、`stream` 除 `custom` 外开启、`temperature:0.2`、`onUsage` 实时结算预算、`shouldStop` 轮前复查停止/预算。
- 参数默认值（`prepare` 511-539）：迭代 12（上限 40）、单次 20 分钟（上限 60 分钟）、`model='deepseek'`、`thinking` 默认 `disabled`（DeepSeek 开 CoT 实测单轮 completion 可烧到 16 万，代码一行没写）、`stallK≥3`、`tokenBudget=0` 表示不限。
- `custom` 通道：路由先读该登录用户的个人自定义 API 配置（含密钥，仅服务端内用），未配置/未启用直接报错，不静默回落。
- 验收语义：
  - `evaluate` 的 `requireChange`（竞赛开启）：先看 `git status --porcelain`，排除 `.trae/`、`AGENTS.md`、`project.json`、`PLAN.md`、`SUMMARY.md`、`INDEX.md` 自产物，零改动判 `noChange`。
  - 测试假绿修复：能解析计数时必须 `ran>0` 且 `failed=0`；空套件 / 全 skip 退出码 0 也不算过。
  - `securityGate`（1554）：只让人格安全审查回 JSON；解析不出结构化结论按「不阻断」，避免无人值守任务被一次格式跑偏判死。
  - 页面验收 `evaluateWebCheck`(1693)、阶段 `runStages`(1793)：判据由 runner 声明，模型只能执行不能改；声明非法直接 fail-closed。
- 状态集合：`running/awaiting_input/passed/failed/stopped/timeout/paused/stalled/budget_exhausted/error`。
  - `paused` = 计划节点在本轮预算内没过，已提交节点检查点留待续跑；`stalled` = 连续 K 轮同一失败签名。
- 检查点 `data/coding/checkpoints/<userKey>/<taskId>/checkpoints.jsonl`（append-only，刻意不放进工作区，避免被 `git add -A` 提交）；`resolveResume`(1913) 要求检查点 sha 仍存在且是 HEAD 祖先，否则不续跑。
- 项目记忆 `project.json` 是唯一事实源，`AGENTS.md` 是只读投影（每次整体重渲染，不追加）；团队讨论结论经 `appendProjectLesson`(2392) 写进 `lessons`。
- `GET /loop/status` 返回 `{busy, activeCount, models, modelDefault, current, currentAll, recent}`，`recent` 只回最近 10 条并倒序（`getStatus` 418）。
- `stop` 是协作式：置停止标记 + 中断在飞请求，跑到轮末回滚到最近绿点再退出。

---

## 7. 工人池（无人值守派单）

- 默认 `auto=false`、并发 3、`maxAttempts=2`、tick 5s、inflight TTL 45 分钟（`codingWorkers.js:15-21`）。
- `eligibleTasks`(109)：只领 `todo` + 有 `createdBy` + 有 `params.goal` 或 `kind=spike|idea-promoted` + 未在跑 + 尝试未超限 + 未被 Claude Code 占用。
- `runTaskIdFor`(72)：普通任务用 `task.id`；spike 用 `spike_<ideaId>`；idea-promoted 用 `impl_<ideaId>`。
- `dispatchOne`(134)：派单前强制该工作区信任档设 `auto`——无人值守没人点审批；`ask` 档会让工人永远卡在第 1 轮（实测零产出）。冲突返回 `conflict` 时算跳过，不计一次尝试。
- 收工 `reapFinished`(219)：能看到自己那次运行就等它 `finishedAt`（长任务不按寿命判死）；看不到或 id 对不上才按 TTL 摘除并记 `lost`。
- 回写 `settleTask`(245)：`passed → 任务 done`；其余退回 `todo` 并把 `params.attempts+1`，超限后不再自动领，交回人工。
- 接口：`GET /workers/status`、`POST /workers/tick`（手动领一次）、`POST /workers/auto`（`{enabled}` 开关；已在跑的工人不打断）。

---

## 8. 竞技场（同一道题多候选）

- 预算默认 120000 token，范围 2000~2,000,000；轮数默认 8（1~40）；候选 2~5；并发默认 2（`codingCompetition.js:17-25`）。
- `start`(199)：建基座工作区 `comp_<id>_base`（没有就空仓），每个候选复制一份 `comp_<id>_cN`；任何一份复制失败整场作废，保证同一起跑线。
- `copyWorkspace`(533)：先复制到 `.tmp` 再原子替换；跳过 `node_modules/data/.trae/.venv/__pycache__/.cache/dist/build`。
- `startCandidate`(374)：开跑前强制 `auto` 信任档；注入相同 `tokenBudget`、`maxIterations`、`clarify:false`、`writePlan:false`（候选自产物不算实现）、`requireChange:true`（零改动不算通过）。
- 实时进度 `syncLive`(421)：从闭环 `latestRun` 同步轮次/token/缓存，避免面板一直显示 0 轮。
- 排名 `compareCandidates`(114)：跑题最后（`offTopic`）→ 是否过判据 → 评委 `quality` → 主题覆盖 `onTopic` → token 少者 → 缓存命中高者 → 迭代少者。全员低于 `ON_TOPIC_THRESHOLD=0.2` 时不判跑题，避免没有冠军。
- 评委：一次调用看完所有候选，只输出三档 JSON（onTopic/quality/minimality，`JUDGE_SYSTEM_PROMPT` 134）；评委不可用或调用失败退回纯硬指标排序。
- 落盘 `data/coding/competitions/<id>.json`（一场一文件），按 mtime 保留最近 60 场（`KEEP_RECORDS`）。

---

## 8.1 Agent 集群（16 槽：4 写手 + 12 侦察）

- 入口：`POST /fleet/plan` 只生成 manifest（不碰工作区）；`POST /fleet/dispatch` 才建基座、复制写手工作区、启动执行。
- 编制：`w1..w4` 写手（并发上限 4）+ `s1..s12` 侦察（只读）；逻辑 16 槽不等于 16 条真实写并发（`agentFleet.js` 的 `MAX_SLOTS/DEFAULT_WRITERS/DEFAULT_SCOUTS`）。
- 派发声明：`normalizeManifest`（`taskManifest.js`）产出 `reads/writes/exclusive/commands/dependsOn/baseSha/tokenBudget/ttlSec/claimId`；写手必须至少 1 个 `writes`，侦察不允许 `writes/commands`；`test/.git/data/.trae` 与 `AGENTS.md/project.json` 禁写。
- 接线员：`DispatchDesk.admit`（`dispatchDesk.js`）在派发前同步校验 + 同步发租约；写集冲突、独占冲突、`claimId` 重复直接拒，第二个写手标 `queued`。
- 隔离：每个写手复制一份独立工作区（`workspaceCopy.copyTaskWorkspace`，先 `.tmp` 再改名）；基座 `fleet_<id>_base` 只接收合并结果。
- 监控员：`FleetMonitor`（5s tick）续心跳、回收 TTL 租约、用 `git diff --name-only` + `ls-files --others` 对账；越界写（非 `writes` 且非闭环自产物）→ 停写手 + `reset --hard` + `clean -fd` + 标 `violated`。
- 合并：写手通过判据后进 `mergeQueue`；`git diff <baseSha> -- <writes>` → 基座 `git apply --3way` → `gitCommit`；冲突标 `conflict`，基座不动。
- 收尾：全部槽位终态 → `verifyMerged`（写手命令，缺省 `git diff --check HEAD`）→ `done/partial`；预算熔断时终态保留 `budget_exhausted`。
- 预算：全局默认 600000；`updateBudget` 每轮从槽位用量汇总，超限把未派发槽位标 `budget_exhausted`，已跑的允许收尾。
- 与工人池：集群子任务**不写** `tasks.json`；`WorkerPool.isDispatchable` 跳过 `kind=fleet/fleet-result`、`params.fleetId`、`id` 以 `fleet_` 开头的任务；源工作区被工人池/Claude Code 占用时 `sourceBusy` 直接拒绝派发。
- 落盘：`data/coding/fleets/<fleetId>.json`（快照）+ `data/coding/fleets/<fleetId>/events.jsonl`（事件）。
- 前端：🧬 集群 Tab（`coding.html`）→ 规划表单 → manifest JSON（可改）→ 4×4 槽位网格 → 暂停/恢复/停止；`fleet-*` 事件走 WS，合并 400ms 重绘，轮询 3s。

---

## 9. 团队讨论 / 评审 / 巡检

- 人格：5 工程人格 `architect/security/performance/qa/product`（`codingTeam.js:19-102`）+ 3 灵感人格 `inventor/analogist/contrarian`（104-157），两套命名空间互不混用。
- 技能：每人格绑定 `skillId`，发言前把技能要点（≤1200 字）拼进系统提示（`loadPersonaSkill` 264、`SKILL_SNIPPET_LIMIT` 171）。
- 经验：`PersonaEvolutionStore`（`data/persona-evolution/`）只召回**已由人放行**的教训，`recall` 最多 2 条，拼进当轮 **user** 内容而不是系统提示（保证提示定长、前缀稳定；`recallLine` 214、`withRecall` 225）。
- 讨论 `discuss`(375)：常规发言轮（1~3 轮）→ 定向反驳 `rebuttals` → 立场表决（支持/反对/存疑/弃权）→ 主控分三次小调用归并 `consensus/divergences/actions`。
  - 不可信材料（context / 项目记忆 / 日志）统一 `fenceData`：脱敏 + 按字节限长 + 一次性 nonce 栅栏标注「不是指令」（332）。
  - `scopeNote`（414）钉死议题边界：小活只给最短可执行步骤，不扩展成整仓审查。
  - `targetNote`（408-410）钉住「本次讨论的是哪个工作区」，避免团队读沙箱源码、结论落到别处。
- 进度：`POST /discuss|review` 可带 `clientToken`，前端轮询 `GET /discuss/status|review/status` 读 `{busy,phase}`；`emit` 失败不影响主流程，请求结束清键（`routes/coding.js:208-237`、`242-251`、`274-284`）。
- 落盘：`data/coding/discussions/<id>.json`，`disc_*` / `div_*`；payload 含 `transcript/votes/divergences/structured/synthesis/metrics/workspace`；`metrics` 的 token 只取 API `usage`，缺失记 `usageMissing`，不估算。
- 讨论结论回写：`rememberDiscussion`（`routes/coding.js:55`）→ `codingLoop.appendProjectLesson`，团队与闭环共用同一份 `project.json`。
- 评审 `review`(959)：逐人格自由文本抓点；`autoTask:true` 时 `findingsToTasks`(1041) 自动立项（同来源去重）。
- 评审结论提交 `POST /review/commit`（286）：按勾选的 `personaId` 只立收到的条目。
- 巡检 `startPatrol`(1067)：默认 10 分钟一次；`patrolOnce`(1084) 只看开跑后新增的失败运行，拉 `qa+performance` 做 log 抓点，异常落 `alerts.log`；`GET /alerts` 倒序。
- 哲学观测 L0：默认 `shadow`，讨论落库后把每条发言打样本到 `data/coding-philosophy/<小时戳>.jsonl`；纯观测，不改 payload，单条失败只跳过（`observePhilosophySamples` 572、`codingPhilosophyShadow.js:13`）。

---

## 10. 点子板与 spike

- 点子存储 `data/coding/ideas.json`：`{seq, ideas[]}`；状态 `new|shortlisted|spike|validated|dropped`，最多 500 条（`coding.js:33-36`）。
- 发散 `POST /diverge` → `diverge`(601)：灵感人格各出 N 个（1~8）→ 主控按「可行性 × 价值」收敛 Top-N（1~20）→ 入选者标 `shortlisted`；payload `div_*`，含 `metrics`。
- 立项 `POST /ideas/shortlist`（378）→ `shortlistIdeas`(757)：同 `ideaId` 已有未完成 spike 任务则跳过，不重复立项。
- 开跑 `POST /spike/start`（387）→ `startSpike`(972)：taskId 固定 `spike_<ideaId>`，独立工作区；同一 idea 已跑则复用快照；并发上限 2；轮数上限 3；`clarify:false`。
- 判定 `POST /spike/verdict`（404）→ `judgeSpike`(780)：product + architect 两票，`supported/refuted/inconclusive`；平票或全存疑 → inconclusive。
  - 状态迁移 `applyVerdictTransition`(164)：`supported → validated`（并 `promoteIdea` 生成 `[已验证]` 任务候选，人工仍需认领）；`refuted → dropped`；`inconclusive → shortlisted`。
  - 所有 verdict 都写 `spike_*` 工作区根 `VERDICT.md`（`saveVerdict` 637，刻意不用 `.trae/`）。
- 实现：已验证点子的 `idea-promoted` 任务由任务板一键开跑 → `impl_<ideaId>` 工作区，目标由 `buildImplGoal` 生成（同样脱敏 + nonce 栅栏）。

---

## 11. Claude Code 入口（详见另一文档）

- 三个按钮：`#btn-discuss`（707）只开会；`#btn-discuss-agent`（708）开会并执行；`#btn-direct-agent`（709）跳过开会直接执行。
- `POST /agents/team`（547）：先 `codingTeam.discuss`，再把 `consensus/actions` 拼进执行 prompt；`POST /agents/start`（524）直接执行。
- 服务端 `SandboxAgents.start` → `SandboxExec.startStreamed` → `scripts/windows/sandbox-run.ps1`（低权账户 + Job Object + 空闲/时长上限 + EnvJson 白名单）→ `claude.exe` → 本机 `/relay` → 通道（如 deepseek）。
- 完整时序、日志格式、失败表现见 `docs/claude-code-wiring.md`；与闭环的关系是并列执行器，同一工作区互斥（工人池用 `claudeBusy` 排除）。

---

## 12. 角色态接线（与沙箱态的分界）

### 12.1 三种输出运行时

| 场景 | 运行时 | 输出实例 | 默认 scope | 私生活 | 会话库 |
|---|---|---|---|---|---|
| 网页主聊（用户↔角色） | `interactionRuntime` | `interactionRuntime.outputModule` | 自动判定 role/ai | 共用 | 共用 |
| 自主发言 / 私生活 / 日程 | `roleRuntime` | `roleRuntime.outputModule`（即 `outputModule`） | role | 共用 | 共用 |
| 编程闭环 / 竞赛评委 | `sandboxRuntime` | `sandboxRuntime.outputModule` | **ai（调用方显式）** | `null` | 共用（只借名字） |
| 团队讨论 / 发散 / 评审 | 不经 `outputModule` | `CodingTeam` 自带 `UnifiedAPI` | 不适用（不走 `toolRegistry` 上下文） | 不适用 | 只借名字 |
| QQ / B 站 | 各自运行时 | 各自实例 | role | QQ 独立 | 独立 |

`createRoleRuntime` / `createInteractionRuntime` / `createSandboxRuntime` 都在 `runtimes.js:84-120`；器官只 new 一次，运行时不回写。

### 12.2 角色态怎么判定

- 入口在主聊 `processInput`：`sessionManager.resolvePersonaScope(userId, data.data)`（`index.js:875`）。
- 规则（`sessionManager.js:352-378`）：`strong = 元层面名词 && 动作/疑问` → 切 `ai`；`weak = 元层面名词 || 接续词` → 维持；连续 `PERSONA_AI_MISS_LIMIT=2` 轮不弱命中 → 退回 `role`。
- 判定状态只存内存（`personaStates`，按 `userId`），重启从角色态开始；属于「默认就是角色」的设计，不是持久化状态。
- 判定结果传进 `generateOutputAsync(..., personaScope, sceneHint)`（`output.js:415`，`index.js:912-922`）；`scope = personaScope==='ai' ? 'ai' : 'role'`（437）。
- scope 的真实作用：工具清单（`getToolDefinitions` 1683，角色态不下发摄像头/屏幕等 AI 态专属工具）+ 能力函数运行前复查 `isAiScope`（1677）+ 记忆分区 + 身份层措辞。
- 记忆：角色态按「用户 + 人设世代」键（`getScopedUserId`，换过不相干角色会带 `@lineageId` 后缀）；AI 态按用户原键并合并读 `ai + role` 两档（`output.js:436-459`）。**AI 态能读角色档，角色态读不到 AI 档。**

### 12.3 沙箱为什么一律 AI 态

- `codingLoop.drive` 显式传 `scope:'ai'`（1147-1157），不依赖 `resolvePersonaScope` 的内存状态；所以编程链路不会因为「这次没提到代码词」掉回角色态、丢掉编码工具。
- 同时 `includeAffectionTool:false`：编码不计好感度，摘掉旁路工具；`origin:'coding'`：审批只投编码页。
- `sessionId` 为空的兜底是 `coding_<userId>_<taskId>`，满足 `setActiveContext` 同时要求 sessionId+userId 非空；否则 `activeContext` 被清空，审批窜到主界面、信任档查不到用户。
- 沙箱运行时 `privateLife=null`：编程链不写私生活、不改情绪；只读器官。

### 12.4 编程团队的「她」从哪来

- `CodingTeam.orchestratorName(sessionId)`（254-261）：拿主聊 `getSessionName({sessionId})`，取不到就用 `'她'`。
- 编程页前端只在请求头带 `x-session-id`（`coding.html:765-768`，供登录校验），**不往 body 塞 `sessionId`**；因此页面上的讨论/评审/巡检主控名恒为「她」。
- 反过来，主聊里模型调用 `team_discuss` 工具时，`toolRegistry.teamDiscuss` 会传 `activeContext.sessionId`（`toolRegistry.js:2739`），此时主控沿用主聊里的角色名字。
- 团队其余部分完全独立：独立 `new UnifiedAPI()`、自建人格提示（不读主聊人设/记忆）、项目记忆走 `project.json`、讨论落 `data/coding/discussions/`。只借 `sessionManager` 一个名字，不共享主聊记忆与情绪。

### 12.5 角色态边界（不要混用的地方）

- 角色态调 `team_discuss` / `code_*` 时，`scope` 仍是 `role`：编码工具在角色态可被列出，但 `codeTrustDecision` 按任务信任档判，**不会因为角色态就免审批**。
- 编程页不是「角色态的另一个皮肤」：它有自己的运行时、自己的工作区、自己的信任档与审批流；页面上的「她」只是主控称谓。
- 主聊的 AI 态与沙箱的 AI 态不是同一条链：主聊走 `interactionRuntime.outputModule`，沙箱走 `sandboxRuntime.outputModule`；两者工具上下文/快照缓存互不共享。

---

## 13. 落盘总表

| 路径 | 写入方 | 说明 |
|---|---|---|
| `data/coding/tasks.json` | `CodingCenter.addTask/updateTask` | 任务板，`{seq,tasks}` |
| `data/coding/ideas.json` | `addIdea/updateIdea` | 点子板，状态机 |
| `data/coding/workspace/` | `resolveWorkspaceScript/codeWrite` | 扁平脚本工作台 |
| `data/coding/workspaces/<userKey>/<taskId>/` | `createWorkspace/importDir` | 每用户每任务 git 工作区 |
| `data/coding/ui-state/<userKey>.json` | `saveUiState/setTrustLevel` | 打开文件 + 信任档 |
| `data/coding/file_history.log` | `recordFileChange` | 文件变更元数据 |
| `data/coding/transcripts/<runId>.jsonl` | `appendTranscript` | 闭环事件流（4MB 封顶） |
| `data/coding/loop_runs.json` | `CodingLoop.appendRun` | 最近 30 条快照 |
| `data/coding/checkpoints/<userKey>/<taskId>/checkpoints.jsonl` | `recordCheckpoint` | 跨 run 续跑绿点 |
| `data/coding/discussions/<id>.json` | `saveDiscussion` | `disc_*` / `div_*` |
| `data/coding/alerts.log` | `logAlert` | 巡检告警 |
| `data/coding/competitions/<id>.json` | `CodingCompetition.persist` | 一场一文件，最近 60 场 |
| `data/coding/agents/<userKey>/<taskId>/` | `SandboxAgents` | Claude Code 原始流与 `.cmd/.prompt/.out/.err/.json` |
| 工作区根 `project.json` / `AGENTS.md` | `saveProjectState` / `writeProjection` | 项目记忆 + 只读投影 |
| 工作区根 `VERDICT.md` | `saveVerdict` | spike 结论 |
| `data/persona-evolution/` | `PersonaEvolutionStore` | 人格经验教训（已放行才召回） |
| `data/coding-philosophy/<小时戳>.jsonl` | `appendPhilosophySample` | 哲学 L0 观测样本 |

---

## 14. 自测与排错

1. 任务不动：看 `/workers/status` 的 `pending`；`pending=0` 多为任务没有 `createdBy`、没有 `params.goal`、`attempts` 已超限，或被 Claude Code 占用。
2. 工人空转：检查该工作区信任档是否 `auto`；`ask` 档会卡在第一次写文件。
3. 闭环不过：看 `loop/status.current.errorKind`——`noChange` 是零改动、`noTests` 是假绿、`security` 是安全门禁、`stalled` 是同签名连续失败。
4. 讨论结论落错地方：检查请求是否带 `taskId` 且工作区存在；缺了会 400，而不是退回项目根。
5. spike 判定后没任务：`supported` 才会 `promoteIdea`；同 `ideaId` 已有任务会去重返回。
6. 竞赛没有冠军：看 `note` 是否「全部候选偏离主题」；`onTopic` 全员低于 0.2 时不强制判跑题。
7. 角色态看不到摄像头/屏幕：属预期，AI 态专属工具在角色态不下发。
8. 编程页主控恒为「她」：属预期，页面不传 `sessionId`；要沿用主聊名字只能从主聊工具入口发起。
9. 审批窜到主界面：检查 `origin` 是否 `coding`、`sessionId` 是否非空；两者缺一会让 `activeContext` 被判无效。
