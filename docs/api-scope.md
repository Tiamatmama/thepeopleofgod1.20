# API 作用域清单

> 基线：2026-11-11，直接扫描 `src/server/**/*.js` 的 `app.<method>()`，共 **245 条**。
> 判定：同一注册行及其后 3 行内出现 `requireAdmin` → 管理员；`requireCodingUser` → 编程沙箱；`requireHost` → 仅本机；`requireLogin` / `validateSession` → 登录；`relayAuth` → 中转令牌；`/api/onebot/event` 走来源校验 → 回环；其余 → 公开。
> 行号为 `app.method(` 所在行；改代码后需重扫，不要手改数字。

## 一、分级定义

| 作用域 | 数量 | 含义 | 判定入口 |
|---|---|---|---|
| 公开 | 21 | 不校验身份，任何人可调 | 无中间件 |
| 登录 | 57 | 需有效登录会话 | `requireLogin` / 处理器内 `validateSession` |
| 仅本机 | 50 | 只允许本机回环或本机网卡地址，不要求登录 | `requireHost` |
| 管理员 | 41 | 本机来源 + admin 账号 | `requireAdmin`（隐含本机） |
| 编程沙箱 | 71 | 需登录，派生 `userKey` 做用户隔离 | `requireCodingUser` |
| 中转令牌 | 4 | Claude Code 上行，认中转令牌 | `relayAuth`（`x-relay-token` / `Bearer` / `x-api-key`） |
| 回环 | 1 | OneBot 事件入口，来源校验 | `POST /api/onebot/event` |
| **合计** | **245** | | |

层级关系：`管理员 ⊂ 仅本机`，`编程沙箱 ⊂ 登录`。登录态统一读 `x-session-id` 头。

## 二、按模块清单

### admin.js（7 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/admin/users` | 管理员 | 10 |
| DELETE | `/api/admin/users/:username` | 管理员 | 23 |
| POST | `/api/bot/increment-count` | 仅本机 | 33 |
| GET | `/api/user/admin-invitation` | 登录 | 50 |
| POST | `/api/user/accept-admin-invitation` | 仅本机 | 74 |
| GET | `/api/user/bot-count` | 登录 | 91 |
| POST | `/api/server/shutdown` | 仅本机 | 107 |

### aiConfig.js（6 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/ai/config` | 公开 | 17 |
| POST | `/api/ai/rename` | 仅本机 | 26 |
| POST | `/api/ai/switch` | 仅本机 | 48 |
| POST | `/api/process/start/server` | 仅本机 | 62 |
| POST | `/api/process/stop/server` | 仅本机 | 71 |
| GET | `/api/process/status` | 公开 | 80 |

### auth.js（7 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/` | 公开 | 19 |
| POST | `/api/auth/login` | 公开 | 24 |
| POST | `/api/auth/register` | 公开 | 91 |
| POST | `/api/auth/logout` | 公开 | 107 |
| GET | `/api/auth/validate` | 登录 | 118 |
| POST | `/api/auth/change-password` | 公开 | 143 |
| POST | `/api/auth/reset-password` | 公开 | 162 |

### bilibili.js（15 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/bili/config` | 管理员 | 15 |
| POST | `/api/bili/config` | 管理员 | 19 |
| DELETE | `/api/bili/config` | 管理员 | 32 |
| POST | `/api/bili/live/start` | 管理员 | 36 |
| POST | `/api/bili/live/stop` | 管理员 | 45 |
| GET | `/api/bili/live/status` | 管理员 | 54 |
| POST | `/api/bili/test-danmaku` | 管理员 | 59 |
| POST | `/api/bili/say` | 管理员 | 65 |
| GET | `/api/tts/voices` | 公开 | 75 |
| POST | `/api/tts/synthesize` | 仅本机 | 80 |
| GET | `/api/tts/audio/:filename` | 公开 | 96 |
| DELETE | `/api/tts/audio/:filename` | 仅本机 | 106 |
| POST | `/api/tts/clone` | 仅本机 | 112 |
| POST | `/api/tts/clone-with-fileid` | 仅本机 | 136 |
| POST | `/api/tts/refresh-voices` | 仅本机 | 156 |

### bridge.js（3 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/qq/admin-commands` | 管理员 | 1565 |
| POST | `/api/qq/admin-commands` | 管理员 | 1569 |
| POST | `/api/onebot/event` | 回环 | 1581 |

### canvas.js（3 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| POST | `/api/canvas/save` | 仅本机 | 29 |
| GET | `/api/canvas/load` | 公开 | 55 |
| GET | `/api/canvas/list` | 公开 | 72 |

### capture.js（4 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/camera` | 公开 | 10 |
| POST | `/api/camera` | 公开 | 15 |
| GET | `/api/screen` | 公开 | 29 |
| POST | `/api/screen` | 公开 | 34 |

### coding.js（71 条，全部编程沙箱）

| 方法 | 路径 | 行 | 方法 | 路径 | 行 |
|---|---|---|---|---|---|
| GET | `/api/coding/me` | 80 | GET | `/api/coding/workspaces` | 731 |
| GET | `/api/coding/tasks` | 89 | POST | `/api/coding/workspace/create` | 740 |
| POST | `/api/coding/tasks` | 97 | DELETE | `/api/coding/workspace/:taskId` | 756 |
| PUT | `/api/coding/tasks/:id` | 106 | POST | `/api/coding/reveal` | 765 |
| DELETE | `/api/coding/tasks/:id` | 114 | GET | `/api/coding/browse` | 774 |
| GET | `/api/coding/scripts` | 122 | POST | `/api/coding/import-dir` | 783 |
| GET | `/api/coding/file` | 130 | GET | `/api/coding/workspace/status` | 800 |
| POST | `/api/coding/run` | 138 | GET | `/api/coding/tree` | 809 |
| POST | `/api/coding/save` | 147 | GET | `/api/coding/project` | 829 |
| GET | `/api/coding/runs` | 155 | GET | `/api/coding/ws/file` | 846 |
| GET | `/api/coding/runs/:runId` | 164 | POST | `/api/coding/ws/file` | 863 |
| GET | `/api/coding/file-history` | 173 | GET | `/api/coding/ws/diff` | 880 |
| POST | `/api/coding/open-vscode` | 188 | GET | `/api/coding/state` | 903 |
| GET | `/api/coding/personas` | 197 | POST | `/api/coding/state` | 911 |
| POST | `/api/coding/discuss` | 207 | GET | `/api/coding/trust` | 920 |
| GET | `/api/coding/discuss/status` | 243 | POST | `/api/coding/trust` | 932 |
| POST | `/api/coding/review` | 255 | GET | `/api/coding/approvals` | 942 |
| GET | `/api/coding/review/status` | 275 | POST | `/api/coding/approvals/:id` | 951 |
| POST | `/api/coding/review/commit` | 287 | GET | `/api/coding/fleet/list` | 965 |
| GET | `/api/coding/alerts` | 299 | POST | `/api/coding/fleet/plan` | 975 |
| POST | `/api/coding/patrol` | 308 | POST | `/api/coding/fleet/dispatch` | 993 |
| GET | `/api/coding/discussions` | 317 | GET | `/api/coding/fleet/status` | 1008 |
| GET | `/api/coding/discussions/:id` | 328 | POST | `/api/coding/fleet/pause` | 1019 |
| GET | `/api/coding/ideation/personas` | 344 | POST | `/api/coding/fleet/resume` | 1029 |
| GET | `/api/coding/ideas` | 353 | POST | `/api/coding/fleet/stop` | 1040 |
| POST | `/api/coding/diverge` | 362 | GET | `/api/coding/loop/status` | 421 |
| POST | `/api/coding/ideas/shortlist` | 379 | POST | `/api/coding/loop/start` | 433 |
| POST | `/api/coding/spike/start` | 388 | POST | `/api/coding/loop/stop` | 450 |
| POST | `/api/coding/spike/verdict` | 405 | POST | `/api/coding/loop/answer` | 460 |
| POST | `/api/coding/tasks/:id/start` | 475 | GET | `/api/coding/workers/status` | 644 |
| GET | `/api/coding/agents` | 515 | POST | `/api/coding/workers/tick` | 654 |
| POST | `/api/coding/agents/start` | 525 | POST | `/api/coding/workers/auto` | 664 |
| POST | `/api/coding/agents/team` | 548 | POST | `/api/coding/compete/start` | 680 |
| GET | `/api/coding/agents/:runId` | 618 | GET | `/api/coding/compete/status` | 700 |
| POST | `/api/coding/agents/:runId/stop` | 628 | GET | `/api/coding/compete/list` | 710 |
| | | | POST | `/api/coding/compete/stop` | 720 |

### evolution.js（11 条，全部管理员）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/evolution/status` | 14 |
| GET | `/api/evolution/params` | 23 |
| POST | `/api/evolution/params` | 32 |
| DELETE | `/api/evolution/params/:name` | 46 |
| GET | `/api/evolution/modules` | 55 |
| POST | `/api/evolution/enabled` | 64 |
| GET | `/api/evolution/proposals` | 74 |
| POST | `/api/evolution/proposals` | 82 |
| POST | `/api/evolution/proposals/:id/evaluate` | 93 |
| POST | `/api/evolution/proposals/:id/promote` | 104 |
| POST | `/api/evolution/proposals/:id/rollback` | 115 |

### experts.js（6 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/experts` | 21 |
| GET | `/api/experts/roundtables` | 30 |
| GET | `/api/experts/roundtables/:id` | 38 |
| GET | `/api/experts/:id` | 44 |
| POST | `/api/experts/distill` | 50 |
| POST | `/api/experts/roundtable` | 82 |

### feed.js（3 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/feed/:sessionId` | 31 |
| POST | `/api/feed/:sessionId/:postId/like` | 59 |
| POST | `/api/feed/:sessionId/:postId/comment` | 74 |

### games.js（3 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| POST | `/api/games/:sessionId/start` | 124 |
| POST | `/api/games/:sessionId/move` | 147 |
| POST | `/api/games/:sessionId/quit` | 186 |

### globalConfig.js（4 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/global-config` | 24 |
| POST | `/api/global-config` | 32 |
| DELETE | `/api/global-config` | 53 |
| POST | `/api/global-config/test` | 64 |

### gossip.js（1 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/gossip/:sessionId` | 登录 | 40 |

### input.js（4 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| POST | `/api/input` | 公开 | 19 |
| POST | `/api/local-semantic/analyze` | 登录 | 45 |
| POST | `/api/local-semantic/learn` | 登录 | 105 |
| GET | `/api/local-semantic/train-stats` | 登录 | 123 |

### intake.js（4 条，全部仅本机）

| 方法 | 路径 | 行 |
|---|---|---|
| POST | `/api/intake/vet` | 64 |
| GET | `/api/intake/records` | 96 |
| GET | `/api/intake/records/:id` | 106 |
| POST | `/api/intake/records/:id/review` | 124 |

### learning.js（5 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/learning/status` | 登录 | 10 |
| GET | `/api/learning/tasks` | 登录 | 22 |
| POST | `/api/learning/tasks` | 仅本机 | 30 |
| POST | `/api/learning/tasks/:id/run` | 仅本机 | 38 |
| DELETE | `/api/learning/assets/:id` | 仅本机 | 46 |

### memory.js（4 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/memory/list` | 11 |
| POST | `/api/memory/:id/pin` | 24 |
| POST | `/api/memory/:id/archive` | 36 |
| POST | `/api/memory/:id/restore` | 53 |

### onebotRoutes.js（12 条，全部管理员）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/onebot/config` | 13 |
| POST | `/api/onebot/config` | 21 |
| DELETE | `/api/onebot/config` | 36 |
| GET | `/api/onebot/test` | 45 |
| GET | `/api/onebot/status` | 49 |
| GET | `/api/onebot/friends` | 57 |
| GET | `/api/onebot/groups` | 65 |
| GET | `/api/onebot/groups/:groupId/members` | 73 |
| GET | `/api/onebot/messages` | 83 |
| GET | `/api/qq/rules` | 110 |
| POST | `/api/qq/rules` | 114 |
| DELETE | `/api/qq/rules/:groupId` | 144 |

### ops.js（14 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/logs` | 管理员 | 21 |
| GET | `/api/affection-logs` | 管理员 | 40 |
| POST | `/api/developer/swear` | 管理员 | 59 |
| GET | `/api/developer/settings` | 管理员 | 70 |
| GET | `/api/affection/rules` | 公开 | 82 |
| POST | `/api/affection/rules` | 仅本机 | 92 |
| POST | `/api/affection/rules/reset` | 仅本机 | 103 |
| GET | `/api/narrator/status` | 公开 | 113 |
| POST | `/api/narrator/trigger` | 仅本机 | 117 |
| POST | `/api/narrator/toggle` | 仅本机 | 127 |
| GET | `/api/schedule` | 公开 | 138 |
| POST | `/api/schedule/save` | 仅本机 | 142 |
| GET | `/api/backup/list` | 管理员 | 159 |
| POST | `/api/backup/create` | 管理员 | 163 |

### relay.js（13 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/relay/v1/models` | 中转令牌 | 266 |
| POST | `/relay/v1/chat/completions` | 中转令牌 | 278 |
| POST | `/relay/v1/messages` | 中转令牌 | 311 |
| POST | `/relay/v1/messages/count_tokens` | 中转令牌 | 336 |
| GET | `/api/relay/status` | 登录 | 355 |
| GET | `/api/relay/config` | 登录 | 359 |
| PUT | `/api/relay/config` | 登录 | 363 |
| GET | `/api/relay/messages` | 登录 | 372 |
| POST | `/api/relay/messages` | 登录 | 381 |
| GET | `/api/relay/tasks` | 登录 | 396 |
| POST | `/api/relay/tasks` | 登录 | 400 |
| POST | `/api/relay/tasks/:taskId/cancel` | 登录 | 416 |
| POST | `/api/relay/test` | 登录 | 425 |

### research.js（16 条，全部仅本机）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/research/tasks` | 15 |
| POST | `/api/research/tasks` | 23 |
| PUT | `/api/research/tasks/:id` | 31 |
| DELETE | `/api/research/tasks/:id` | 39 |
| GET | `/api/research/note` | 47 |
| POST | `/api/research/note` | 55 |
| GET | `/api/research/search` | 63 |
| POST | `/api/research/run` | 75 |
| POST | `/api/research/open-vscode` | 83 |
| POST | `/api/research/llm` | 95 |
| GET | `/api/research/bots` | 127 |
| GET | `/api/research/chat` | 135 |
| POST | `/api/research/chat` | 143 |
| DELETE | `/api/research/chat` | 151 |
| GET | `/api/research/agent` | 159 |
| POST | `/api/research/agent` | 168 |

### session.js（11 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| POST | `/api/session/create` | 仅本机 | 17 |
| GET | `/api/session/list` | 登录 | 70 |
| GET | `/api/session/get/:sessionId` | 登录 | 94 |
| GET | `/api/session/:sessionId/prompt-preview` | 登录 | 119 |
| POST | `/api/session/:sessionId/evolve` | 仅本机 | 150 |
| DELETE | `/api/session/delete/:sessionId` | 仅本机 | 199 |
| GET | `/api/session/:sessionId` | 登录 | 229 |
| POST | `/api/session/:sessionId/join` | 仅本机 | 253 |
| GET | `/api/session/:sessionId/user/:userId` | 登录 | 286 |
| GET | `/api/session/:sessionId/user/:userId/history` | 登录 | 309 |
| DELETE | `/api/session/:sessionId` | 仅本机 | 333 |

### social.js（5 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/social/state` | 7 |
| POST | `/api/social/start` | 15 |
| POST | `/api/social/stop` | 29 |
| POST | `/api/social/say` | 37 |
| POST | `/api/social/clear` | 46 |

### status.js（6 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/status` | 登录 | 24 |
| GET | `/api/expression` | 登录 | 44 |
| GET | `/api/summary` | 登录 | 67 |
| POST | `/api/memory/rollback-dedup` | 登录 | 88 |
| GET | `/api/ambient/tracks` | 公开 | 102 |
| POST | `/api/address` | 登录 | 115 |

### timeline.js（2 条，全部登录）

| 方法 | 路径 | 行 |
|---|---|---|
| GET | `/api/timeline/days` | 11 |
| GET | `/api/timeline/day` | 21 |

### userApi.js（5 条）

| 方法 | 路径 | 作用域 | 行 |
|---|---|---|---|
| GET | `/api/user/custom-api` | 登录 | 9 |
| POST | `/api/user/custom-api` | 仅本机 | 25 |
| DELETE | `/api/user/custom-api` | 仅本机 | 41 |
| POST | `/api/user/custom-api/test` | 仅本机 | 57 |
| POST | `/api/user/custom-api/models` | 仅本机 | 91 |

## 三、公开面风险点

| 接口 | 现象 | 风险 | 建议 |
|---|---|---|---|
| `GET/POST /api/camera`、`GET/POST /api/screen` | `capture.js:10-45` 无任何中间件，可读状态、改开关与间隔 | 任意访客能关掉抓帧或改频率 | 读取至少 `requireLogin`，写入改 `requireHost` |
| `POST /api/input` | 公开，直接驱动完整模型与记忆写入 | 可被刷 token、灌记忆 | 加 `rateLimit` + 来源校验，或要求登录 |
| `POST /api/auth/change-password`、`/reset-password` | 公开，依赖处理器内部校验 | 若内部无旧密码/令牌校验即为高危 | 复核处理器与 `rateLimit` 覆盖 |
| `GET /api/ai/config` | 公开返回 `apiType/model` 等 | 信息面暴露 | 确认响应不含密钥与端点凭证 |
| `GET /api/tts/audio/:filename` | 公开可读音频 | 文件名可枚举时泄露 | 确认文件名为随机串且不可遍历 |
| `GET /api/affection/rules`、`/api/narrator/status`、`/api/schedule` | 公开只读 | 低危，属前端展示需要 | 保持只读，勿在这些路由加写操作 |

**本机判定的前提**：`requireHost` 依赖 `req.ip`。未设置 `trust proxy` 时，反代会把外部请求识别成 `127.0.0.1`，本机限制形同虚设；部署反代时必须显式配置可信代理。

## 四、维护

- 重算：扫描 `src/server/**/*.js` 的 `app.(get|post|put|delete|patch)('<path>'`，对每条取注册行 + 后 3 行判守卫。
- 新增路由必须显式选择中间件；顺序固定为 `requireAdmin` → `requireHost` → `requireLogin` → `requireCodingUser`，避免多层叠加。
- 用户归属只从登录会话派生，不接受请求体里的 `userId`；编程沙箱统一用 `codingOwner(req)`。
- 与 `.trae/documents/接口与代码区块索引.md` 分工：本文管「谁能调」，索引管「在哪一行、走哪条链」。
