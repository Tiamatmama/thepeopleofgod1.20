# 编程沙箱 16-Agent 集群与中枢控制设计

- 日期：2026-11-02
- 状态：待用户确认
- 范围：编程沙箱新增「🧬 集群」子界面；4 个写手 + 12 个只读侦察；任务头文件声明 + 接线员 + 监控员
- 非目标：不替换现有编码闭环、工人池、竞技场；不新增第二套代码执行器；不默认开启自动派发

---

## 1. 背景与现有事实

- `CodingLoop` 是唯一代码执行入口：`prepare/start/drive/evaluate`，一个 `run` 绑定一个 `userId + taskId + workspace`。
- `WorkerPool` 默认 `auto=false`、并发 3、`maxAttempts=2`；派单前把信任档设 `auto`（`codingWorkers.js:134-144`）。
- 工作区按 `userId + taskId` 隔离，`CodingCenter.createWorkspace` 建 git 仓；`resolveInWorkspace` 做词法 + realpath 双校验。
- 竞技场已有整目录复制 `copyWorkspace`（先 `.tmp` 再原子替换，跳过 `node_modules/data/.trae` 等）。
- `CodingLoop.prepare` 已支持 `policy {maxWrites,maxReads}`、`tokenBudget`、`plan`（子任务 DAG）、`requireChange`、`passCommand`。
- 前端任务板是 modal 内的 Tab 组（`public/coding.html:670-714`），天然可加「🧬 集群」Tab。

---

## 2. 目标与验收

### 2.1 目标

1. 16 个逻辑 Agent 可同时出现在一个集群面板：4 个写手、12 个只读侦察。
2. 任何写任务派发前，必须先提交「任务头文件」声明；接线员检查通过才发租约。
3. 4 个写手各自独立工作区，互不抢文件；只归并声明过的路径。
4. 监控员运行期盯防：心跳、TTL、越界写检测、暂停/回滚/告警。
5. 全部执行复用 `CodingLoop`，不新增第二套执行路径；所有产物可回放到现有运行记录。

### 2.2 验收标准

- 16 个槽位状态可实时看到：`idle/queued/running/reviewing/merging/done/failed/blocked`。
- 两个写手声明同一文件时，第二个必须进入 `queued`，不得同时启动。
- 依赖成环、路径越界、碰保护路径的 manifest 必须在派发前被拒，且返回明确原因。
- 写手越界改文件时，监控员在 5 秒内发现并暂停该写手，其它写手不受影响。
- 4 个写手全部通过后，基座工作区得到合并结果，并跑一次合并后验收。
- 全局 token 预算耗尽时，集群进入 `budget_exhausted`，未启动的槽位不再派发。

---

## 3. 总体架构

```
用户目标
   │
   ▼
AgentFleet（中枢）── 调一次规划模型 → 子任务 DAG + 16 个槽位编制
   │
   ▼
TaskManifest（任务头文件）── 每个子任务一份声明
   │
   ▼
DispatchDesk（接线员）── 静态检查 + 同步预留租约
   │
   ├─ 写手通道 w1..w4 ──► CodingLoop（独立 worktree）
   └─ 侦察通道 s1..s12 ──► FleetScout（只读工具循环，无写权限）
   │
   ▼
FleetMonitor（监控员）── 心跳 / TTL / git diff 对账 / 越界处置
   │
   ▼
MergeQueue（合并队列）── 只合并声明路径 → 基座 → 合并后验收
```

### 3.1 新增模块

| 文件 | 职责 |
|---|---|
| `src/core/taskManifest.js` | manifest 规范化、路径校验、写集相交、依赖环检测、保护路径规则 |
| `src/core/dispatchDesk.js` | 接线员：收 manifest、检查、同步预留 lease、拒绝/排队 |
| `src/core/fleetMonitor.js` | 监控员：lease 心跳、TTL 回收、越界写对账、暂停与回滚 |
| `src/core/agentFleet.js` | 中枢：规划 DAG、分配 16 槽、启动写手/侦察、合并队列、状态与落盘 |
| `src/core/fleetScout.js` | 只读侦察：复用 `outputModule.callWithTools`，工具白名单只含读工具 |

### 3.2 装配位置

- `src/server/index.js` 在 `codingWorkers` 之后创建 `AgentFleet`，注入 `coding`、`codingLoop`、`sandboxRuntime.outputModule`、`codingTeam`（可选，用于规划/评审）、`codingWorkers`（用于占用互斥）。
- 路由挂在 `src/server/routes/coding.js`，沿用 `requireCodingUser` + `codingOwner`。
- 事件沿用 `coding-event` WS 通道，新增 `fleet-*` 子类型；前端按 `owner + fleetId` 过滤。

---

## 4. 任务头文件（Task Manifest）

### 4.1 结构

```json
{
  "manifestId": "mf_<fleetId>_<taskId>",
  "fleetId": "fl_<seq>",
  "taskId": "fleet_<fleetId>_w1",
  "agentId": "w1",
  "role": "writer|scout",
  "goal": "只改 src/core/foo.js，补上参数校验",
  "reads": ["src/core/foo.js", "test/foo.test.js"],
  "writes": ["src/core/foo.js"],
  "exclusive": ["package.json"],
  "commands": ["node --test test/foo.test.js"],
  "dependsOn": ["s1"],
  "baseSha": "<合并前基座 HEAD>",
  "tokenBudget": 120000,
  "ttlSec": 3600,
  "claimId": "claim_<hash>"
}
```

### 4.2 校验规则（接线员在派发前执行）

1. `taskId/agentId` 符合 `safeTaskId` 字符集；`goal` 非空。
2. `reads/writes/exclusive` 全部是工作区内相对路径；先词法、再 realpath；越界或指向 junction 外的真实路径一律拒绝。
3. 保护路径禁止写：`test/`、`.git/`、`data/`、`node_modules/`、`.trae/`、`AGENTS.md`、`project.json`；`reads` 允许读 `test/`。
4. 写集与所有活跃写租约求交集；非空则 `conflict`，进入 `queued`，不得启动。
5. `exclusive` 与任何活跃读写租约相交；非空则排队。
6. `dependsOn` 必须指向同一 fleet 内已存在节点；DFS 检测成环。
7. `commands` 只允许白名单测试命令（复用 `isWhitelistedTestCommand`）；写手工具白名单不含任意 `code_run`。
8. `baseSha` 必须是当前基座 HEAD；合并前基座变了则要求重算 manifest。

### 4.3 「#pragma once」语义

- `claimId = sha1(workspaceRealPath + '|' + normalizedWritePath)`。
- 活跃 lease 集合中同一 `claimId` 只允许存在一份；重复声明直接拒绝，不做「后到覆盖」。
- 这与 C++ 头文件的 include guard 同构：声明阶段就防重复包含，运行时不再靠运气。

---

## 5. 生命周期

1. **规划**：`POST /fleet/plan` 输入目标，中枢调用 `sandboxRuntime.outputModule.callModelOnce`（默认 deepseek、`forceThinking:'disabled'`、`temperature:0.1`）输出 4 写手 + 12 侦察的子任务与 manifest；只返回、不启动。解析失败或结构非法直接报错，不退回「让模型自由发挥」。
2. **预览**：UI 展示 16 份 manifest、依赖图、冲突预检结果；用户可改 `writes` 或删除节点。
3. **派发**：`POST /fleet/dispatch`。接线员逐份校验并同步预留 lease；通过的进入 `queued`，按依赖拓扑排序后启动。
4. **执行**：
   - 写手：`CodingLoop.start({ userId, taskId, goal, passCommand, tokenBudget, maxIterations, policy, requireChange:true })`，工作区是独立 worktree。
   - 侦察：`FleetScout.run()`，只读工具 + 单轮/最多 3 轮，产出 `findings`，不写盘。
5. **监控**：每 5 秒心跳；每 30 秒对每个写手跑 `git diff --name-only`，与 `writes` 对账。
6. **合并**：写手 `passed` 后进入合并队列；只取声明路径的 patch，`git apply --3way` 到基座；失败则退回该写手重做或标 `conflict`。
7. **收尾**：全部合并后跑一次基座验收；更新 `project.json`；释放所有 lease；落盘总结。

---

## 6. 隔离与合并

### 6.1 工作区布局

```
data/coding/workspaces/<userKey>/fleet_<fleetId>_base/   # 基座，最终结果
data/coding/workspaces/<userKey>/fleet_<fleetId>_w1/     # 写手 1，独立 git 仓副本
data/coding/workspaces/<userKey>/fleet_<fleetId>_w2/
data/coding/workspaces/<userKey>/fleet_<fleetId>_w3/
data/coding/workspaces/<userKey>/fleet_<fleetId>_w4/
```

- 基座来自 `sourceTaskId` 的复制；没有源任务则新建空仓。
- 每个写手从基座复制一份（先 `.tmp` 再原子替换，复用竞技场的复制策略与跳过列表）。本文的「worktree」指这种独立复制的 git 工作区，**不是** `git worktree add` 创建的 linked worktree。
- 侦察不建工作区，只读基座快照；需要隔离时用 `git show <baseSha>:<path>` 读固定版本。

### 6.2 合并规则

1. 写手结束后 `git add -A -N`，生成 `git diff <baseSha> -- <writes>`。
2. 合并队列串行执行；同一时刻只允许一个合并写基座。
3. `git apply --3way` 失败 → 该写手标 `conflict`，lease 释放，任务退回中枢重新声明或人工处理。
4. 合并成功后基座 `git add -A && git commit`，`baseSha` 前移；依赖该节点的子任务才可继续。
5. 合并后验收失败 → 回滚到合并前 `baseSha`，该写手标 `failed`，不阻塞其它无依赖写手。

---

## 7. 并发、预算与限流

- 槽位固定 16：`w1..w4` 写手，`s1..s12` 侦察。
- 写手并发 4；侦察并发 12；总并发 16，但受全局 `maxConcurrent` 二次约束（默认 16，可下调）。
- 预算默认：写手 120000 token/个，侦察 8000 token/个，全局 600000；任一超限立即熔断对应节点，全局耗尽则 `budget_exhausted`。
- 遇到 429/超时：该槽位指数退避（5s → 30s → 120s），连续 3 次失败标 `failed`，不拖垮整场。
- 工人池互斥：`AgentFleet` 启动写手前检查 `codingWorkers` 的 `inflight` 与 `claudeBusy`；同一工作区已被占用则 `queued`。
- 任务板隔离：集群的子任务**不写入** `tasks.json`；只有整场结束后的汇总结果可以生成一条 `params.kind='fleet-result'` 的任务，且不带 `params.goal`。`WorkerPool.eligibleTasks` 增加跳过规则：`params.kind==='fleet'|'fleet-result'`、`params.fleetId` 非空、或 `task.id` 以 `fleet_` 开头的一律不自动领。
- 源工作区快照：基座只从 `sourceTaskId` 的**已提交 HEAD** 复制，不复制正在被写的活工作区；若源工作区在 `codingWorkers.inflight` 或 `sandboxAgents.runningRuns()` 中，直接拒绝开集群，提示先等它跑完。
- 总并发：集群写手 4 + 工人池 3 = 最多 7 条 `CodingLoop`，低于现有单机可承受上限；若工人池已在跑 3 条，集群仍可起 4 条，但全局 token 预算独立计算，不互相挪用。
- Claude Code 互斥：集群基座/源工作区若被 `SandboxAgents` 占用，拒绝复制与合并；集群内不使用 Claude Code 执行器，避免与「讨论→执行」链路抢同一工作区。

---

## 8. 监控员与失败处理

| 事件 | 监控员动作 |
|---|---|
| 心跳缺失 > 2 个周期 | 标 `stalled`，继续观察；超过 TTL 释放 lease |
| `git diff` 出现未声明路径 | 立即 `codingLoop.stop`，写手标 `violated`，回滚 worktree，告警 |
| 写手进程/运行记录消失 | 按 TTL 回收 lease，任务退回 `queued` |
| 合并冲突 | 标 `conflict`，lease 释放，通知中枢 |
| 基座 HEAD 被外部改动 | 暂停合并队列，要求重新生成 manifest |
| 依赖节点失败 | 下游标 `blocked`，不启动 |
| 全局预算耗尽 | 所有未启动节点 `budget_exhausted`，已跑的允许收尾 |

告警落 `data/coding/fleets/<fleetId>/events.jsonl`，同时广播 `fleet-alert`；UI 告警条可点开对应槽位。

---

## 9. 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/coding/fleet/plan` | `{goal, sourceTaskId?, writers?, scouts?, tokenBudget?}` → 返回 16 份 manifest + 预检结果，不启动 |
| POST | `/api/coding/fleet/dispatch` | `{fleetId, manifests?}` → 接线员校验并派发；`manifests` 可覆盖预览里的写集 |
| GET | `/api/coding/fleet/status?id=` | 槽位、状态、当前任务、token、冲突队列、告警 |
| GET | `/api/coding/fleet/list` | 最近集群记录 |
| POST | `/api/coding/fleet/pause` | `{id}` 暂停派发，不杀在跑节点 |
| POST | `/api/coding/fleet/resume` | `{id}` 恢复派发 |
| POST | `/api/coding/fleet/stop` | `{id}` 停止全部节点并释放 lease |

所有接口 `requireCodingUser`；owner 由 `codingOwner` 派生；跨用户 403。

---

## 10. 前端

- 在 `public/coding.html` 的任务板 Tab 组加 `🧬 集群`（与 `⚔ 竞技场` 同级），新增 `#board-fleet` 面板。
- 面板结构：
  1. 顶部中枢条：目标输入、写手/侦察数量、全局预算、`生成编制` / `派发` / `暂停` / `停止`。
  2. 4×4 槽位网格：每格显示 `agentId`、角色、状态、当前任务、token、耗时；点击打开 manifest / lease / 事件抽屉。
  3. 冲突队列：写集冲突、依赖阻塞、越界违规，按时间倒序。
  4. 合并队列：基座 HEAD、待合并、合并结果。
- 轮询 `/fleet/status` 3 秒；同时监听 `coding-event` 的 `fleet-*` 事件即时更新。
- 未派发前必须显示 manifest 预览与预检红黄绿，用户确认后才允许 `派发`。

---

## 11. 落盘

| 路径 | 内容 |
|---|---|
| `data/coding/fleets/<fleetId>.json` | 集群快照：目标、16 槽、状态、预算、基座 HEAD |
| `data/coding/fleets/<fleetId>/manifests.jsonl` | 每份 manifest 及校验结果，append-only |
| `data/coding/fleets/<fleetId>/leases.jsonl` | 租约授予/释放/回收 |
| `data/coding/fleets/<fleetId>/events.jsonl` | 状态变更、越界、冲突、告警 |
| `data/coding/workspaces/<userKey>/fleet_<id>_base/` | 基座工作区 |
| `data/coding/workspaces/<userKey>/fleet_<id>_wN/` | 写手工作区 |

---

## 12. 安全边界

- manifest 来自模型/用户，按不可信输入处理：路径、命令、依赖全部白名单化。
- 写手只允许 `code_write/code_apply_patch/code_read/code_list_dir/code_search/code_find_symbol/code_find_refs/code_repo_map/code_diagnose/code_run_tests`；不含 `code_run`、`code_write_file`、`code_deploy`。
- `test/` 只读不可写；`AGENTS.md`、`project.json`、`.git/` 禁止写。
- 写手使用独立 worktree，越界写最多污染该副本；监控员发现即回滚，不影响基座。
- 合并只接受声明路径的 patch，且合并后必须重新验收；不接受写手直接推基座。
- 所有操作保留 `origin:'coding'` 与 `sessionId`，审批不窜主界面。

---

## 13. 测试

### 13.1 单元

- `taskManifest`：路径越界、保护路径、写集相交、exclusive 相交、依赖成环、命令非白名单、baseSha 过期。
- `dispatchDesk`：同一 `claimId` 二次声明被拒；依赖未满足进入 queued；租约预留是同步的，两个并发 dispatch 不会都拿到同一路径。
- `fleetMonitor`：心跳缺失、TTL 回收、越界 diff、外部 HEAD 变动。
- `agentFleet`：16 槽编制、预算熔断、429 退避、停止释放。

### 13.2 集成

- 4 写手改互不相干文件：全部并行通过并合并成功。
- 两个写手声明同一文件：第二个排队，第一个完成后才启动。
- 一个写手越界写 `test/`：被拒或运行期回滚，其它写手继续。
- 合并冲突：写手标 `conflict`，基座回滚，事件落盘。
- 全局预算耗尽：未启动槽位标 `budget_exhausted`。

### 13.3 回归

- 现有 `npm test` 全量通过；`eslint` 0 errors。
- 工人池/竞技场/闭环原有测试不受影响。

---

## 14. 实施阶段

1. **P1 声明层**：`taskManifest` + `dispatchDesk` + 单测；先不上 UI。
2. **P2 中枢与写手**：`agentFleet` 4 写手 + 独立 worktree + 合并队列 + 监控员。
3. **P3 侦察与界面**：`fleetScout` 12 路只读 + 「🧬 集群」Tab + 轮询/事件。
4. **P4 收口**：预算/限流/告警、全量测试、文档 `docs/coding-wiring.md` 与 `docs/coding-subchains.md` 补接线。

---

## 15. 明确不做

- 不做 64 路或 16 路全部写代码。
- 不做写手直接改基座工作区。
- 不做跨用户共享集群。
- 不做自动合并未经声明的路径。
- 不替换工人池；集群是「一道大题拆给 16 个 Agent」，工人池仍是「任务板逐单派发」。
