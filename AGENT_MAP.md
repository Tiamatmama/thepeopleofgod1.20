# AGENT_MAP — 项目作业图

> 用途：Agent 专用的极简导航。用户说「看 §X」→ 只读该节，按节内命令验证，不扩散阅读。
> 与 `AGENTS.md`（输出纪律）、`.trae/documents/*`（历史交接）分工：本文件只写「改代码时去哪、怎么验」。

## §0 作业协议

1. 先定功能 → 查 §5 对应小节 → 只读该节列出的文件。
2. 改 JS：`node --check <file>`；改前端内嵌脚本：见 §6.1。
3. 收工前必跑：`npm run lint`（或仅对改动文件 `npx eslint <file>`）。
4. 临时脚本一律放 `%TEMP%`，用完删；不留在仓库。
5. 不擅自 `git commit` / 重启 41888 上的实例（可能是用户正在用的 QQ 桥）。
6. 不改：人格讨论轮数、单依赖约束（§1.3）、`.env` 里的既有密钥。

## §1 硬事实

### 1.1 运行
| 项 | 值 |
|---|---|
| 入口 | `src/server/index.js` |
| HTTP | `41888`（`config.serverPort`，env `SERVER_PORT`） |
| HTTPS | `41443`（env `SERVER_HTTPS_PORT`，需自签证书，缺失则跳过） |
| 启动 | `npm start` / `npm run dev`（nodemon）/ `npm run start:mock`（时间偏移） |
| 测试 | `npm test` → `node --test "test/**/*.test.js"` |
| Lint | `npm run lint` → `eslint src test scripts public` |
| CI | `.github/workflows/ci.yml`：Node 22 → `npm ci` → lint → test |

### 1.2 目录
```
src/server/       HTTP 装配 + routes/ + qq/ + bilibili.js + runtimes.js（通道装配层）+ lifecycle.js
src/core/         业务内核（情绪、记忆、编程、进化、TTS…）
src/learning/     向量/检索（qdrantAgent, memoryVectorStore, dialogueRetriever…）
src/storage/      atomicWrite / writeLock / storeGuard / storeSchema
src/session/      sessionManager.js
src/tools/        developerTool / processManager / 各类 feed
public/           静态页（见 §4.1）
data/             全部运行时数据（见 §3）
test/             node:test
scripts/          timeshift.js 等
```

### 1.3 依赖红线
运行时依赖只有 7 个：`axios` `bcryptjs` `dotenv` `express` `form-data` `web-tree-sitter` `ws`。
**加依赖前必须先问用户**；能用 Node 内置（fs/path/http/crypto）就别装包。

## §2 后端骨架

### 2.1 装配顺序（`src/server/index.js`）
1. 顶部：`config`、各 core 模块实例化（`emotionModule`、`memoryModule`、`inputModule`、`coding*`、`relayHub`、`globalConfig`、`oneBotClient`…）。
2. 器官实例化后：`runtimeDeps` → `createRoleRuntime / createInteractionRuntime / createSandboxRuntime / createBiliRuntime / createQQRuntime`（`src/server/runtimes.js`）。**运行时只 new 输出层，不 new 器官**。
3. 中部：定义 `requireHost / requireAdmin / requireLogin / serverError / isHostRequest`。
4. L1030–1108：各 `require('./routes/xxx')(app, ctx)` + `require('./qq/bridge')(app, ctx)` + `require('./server/bilibili')`。
5. 末尾：`server.listen(PORT)`、HTTPS、WS、`lifecycle` 钩子。

**新增路由模块的 5 步**
1. 建 `src/server/routes/foo.js`，签名 `module.exports = function registerFooRoutes(app, ctx) { ... }`。
2. 只用 `ctx` 里的依赖，不 `require` 内核（便于测试/替换）。
3. 在 index.js 注册段按字母序插入一行，显式传需要的 ctx。
4. 每个 handler 用统一的 `try { } catch (e) { ctx.serverError(res, e) }`。
5. 需要权限就挂 `ctx.requireHost / requireAdmin / requireLogin`。

### 2.2 权限语义
| 中间件 | 含义 |
|---|---|
| `requireHost` | 仅本机 `127.0.0.1 / ::1`，写操作/危险操作默认用它 |
| `requireAdmin` | 管理员账号 |
| `requireLogin` | 任意已登录用户 |
| `serverError(res, err, shape)` | 统一错误出口，`shape` 默认 `'success'` |

### 2.3 已有路由前缀（速查）
`/api/auth` `admin` `ai` `process` `canvas` `camera` `screen` `coding` `evolution` `global-config` `input` `local-semantic` `logs` `affection*` `developer` `narrator` `schedule` `backup` `relay` `research` `session` `social` `status` `memory` `user/custom-api` `bili` `tts` `qq` `onebot` `feed` `games` `gossip` `experts`

### 2.4 通道运行时表（谁在哪说话）

器官（`emotionModule` / `memoryModule` / `galgameModule` / `cideEngine` / `appointmentBook` / `privateLife`）全局只有一份，运行时只读消费、不回写；**每个通道独立的是会话库实例、输出模块实例、场景提示与工具策略**。

| 通道 | 工厂（`src/server/runtimes.js`） | 会话库 | 用自己的输出实例 | 场景/工具策略 | 主要入口 |
|---|---|---|---|---|---|
| 角色自主生活 | `createRoleRuntime` | `data/sessions`（共享） | `roleRuntime.outputModule` | 无固定场景；自主发言走 narrator 的 `scenePrompt` 与 `toolFilter` | `/api/narrator/*`、`/api/schedule*`、`/api/feed/*`、`/api/social/*`、`/api/research/*`、`/api/session/*` |
| 用户↔角色互动 | `createInteractionRuntime` | `data/sessions`（共享，历史才接得上） | `interactionRuntime.outputModule` | `SCENE_PROMPT.interaction`（网页一对一） | `/api/input`、`/api/games/*` |
| 编程沙箱 | `createSandboxRuntime` | `data/sessions`（共享） | `sandboxRuntime.outputModule` | 只借器官；调用方传 `includeAffectionTool:false`，不碰私生活 | `/api/coding/*`、`/api/evolution/*` |
| QQ | `createQQRuntime` | `data/qq_sessions` + `qq_archives` | `qqRuntime.outputModule` | 只放行 `pin_memory` / `unpin_memory`；管理员私聊场景 | `/api/qq/*`、`/api/onebot/*` |
| B站直播 | `createBiliRuntime` | `data/bili_sessions` + `bili_archives` | `biliRuntime.outputModule` | 弹幕/直播场景，与网页存档隔离 | `/api/bili/*`、`/api/tts/*` |

无运行时（纯运维/代理，不产生角色文本）：`/api/auth`、`/api/admin`、`/api/user/*`、`/api/global-config*`、`/api/ai/*`、`/api/relay/*`、`/api/logs`、`/api/backup/*`、`/api/canvas/*`、`/api/camera`、`/api/screen`、`/api/experts/*`。

**改通道的判据**：要动「这个通道怎么说话、能用哪些工具、读哪份会话」→ 改 `runtimes.js`；要动「她怎么想」→ 改器官层。禁止在 `routes/*.js` 里 `new` 内核（QQ 桥原先就是这么耦合的）。

## §3 存储与数据

### 3.1 写盘铁律
- 一律 `src/storage/atomicWrite.js`：`writeFileAtomicSync(file, data)` / `writeJsonAtomicSync(file, obj)`。
- 禁止 `fs.writeFileSync` 直写 `data/`（断电会留半截 JSON）。
- 进程单例用 `writeLock.js`（`data/.server.lock`），勿手删锁文件。
- 读取前用 `storeGuard.js` / `storeSchema.js` 兜底，坏档进 `data/archives/corrupt/`。

### 3.2 关键数据文件
| 文件/目录 | 内容 |
|---|---|
| `data/emotion_state.json` | 当前情绪状态 |
| `data/emotion_ledger.json` | 情绪流水 |
| `data/user_memories/<user>__role.json` | 角色记忆（按用户/角色隔离） |
| `data/sessions/` `archives/` `qq_sessions/` `bili_sessions/` | 会话档 |
| `data/personas/` | 人格卡 |
| `data/oneBotConfig.json` `qq_chat_rules.json` `qq_bridge_state.json` | QQ 桥配置/规则/状态 |
| `data/camera_config.json` | 摄像头开关 |
| `data/canvas/` | 画板 JSON（笔迹母本） |
| `data/coding/{tasks,ideas,loop_runs}.json` + `discussions/ competitions/ logs/ workspace/ ui-state/` | 编程沙箱 |
| `data/coding-philosophy/*.jsonl` | 编程哲学日志 |
| `data/persona-evolution/{state.json,audit.jsonl,lessons.jsonl,proposals/}` | 人格进化 |
| `data/evolution/internal-signal.jsonl` | 进化信号 |
| `data/logs/thinking/YYYY-MM-DD.jsonl` | 思考日志 |
| `data/login_sessions.json` `developer_settings.json` | 登录态 / 开发者设置 |

## §4 前端

### 4.1 页面清单
| 文件 | 角色 |
|---|---|
| `public/index.html` | 主控台（单文件，内嵌 CSS+JS，约 4700 行） |
| `public/coding.html` + `coding-board.js` | 编程沙箱 |
| `public/research.html` | 研究平台（仅本机） |
| `public/social.html` | 多人格社交 |
| `public/relay.html` | 中转站 |
| `public/live2d.html` | Live2D 形象 |
| `public/login.html` `boot.html` `continue.html` | 登录/启动/续接 |

### 4.2 index.html 结构
- 顶栏按钮 → `showTab('<key>')`；`key` ∈ `developer` `pseudo-dev` `user-chat` `semantic` `canvas` `settings`。
- `showTab()` 在 L1733：先切 `.nav-tab.active`，再对每个容器 `classList.toggle('hidden', tab !== key)`，最后按 tab 调 `loadXxx()`。
- 容器 id 不统一：`developer-tab`、`pseudo-dev-tab`、`settings-tab`，但 `user-chat-tab-content`、`semantic-tab-content`、`canvas-tab-content`。**新增 tab 必须同步 4 处**：导航按钮、容器 div、`showTab` 的 toggle 行、`showTab` 的分支加载函数。

### 4.3 CSS 工具类（改 UI 优先复用）
| 类 | 用途 |
|---|---|
| `.panel` / `.panel-title` | 基础卡片 |
| `.section-label` | 分区标题（带右侧细线） |
| `.guide-box` + `.guide-steps` | 蓝紫引导框，写「这页怎么用」 |
| `.panel-note` | 灰色补充说明（放 guide-box 之后） |
| `details.fold-panel` | 整块低频面板折叠，summary 内用 `.fold-hint` / `.fold-arrow` |
| `details.fold-sub` | 面板内部的小折叠（如「高级：Embedding / Qdrant / TTS」） |
| `.char-layout` | 300px + 1fr 双栏，≤1100px 自动单列 |

布局约束：`.main-content` 是 `repeat(auto-fit, minmax(300px,1fr))` 网格；宽面板加 `style="grid-column: span 2"`。

### 4.4 前端请求
```js
const res = await secureFetch('/api/xxx', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-session-id': currentSessionId },
  body: JSON.stringify(payload)
});
```
- 所有用户可控文本进 DOM 前过 `sanitizeHTML()`。
- 不要裸 `fetch` 调本机 API（会丢 session header）。

## §5 功能地图

格式：**文件 → 路由 → 前端 → 数据 → 坑**。

### 5.1 情绪 / 好感度
- 核心：`src/core/emotion.js`、`emotionLedger.js`、`galgame.js`
- 路由：`routes/status.js`（`/api/status`）、`routes/ops.js`（`/api/affection/rules` GET/POST/reset、`/api/affection-logs`）
- 前端：index.html 开发者页情绪卡；角色管理页「好感度判定规则」
- 数据：`emotion_state.json`、`emotion_ledger.json`、`affection_logs.json`
- 坑：规则改错会直接影响回复倾向；reset 走 `requireHost`。

### 5.2 记忆 / 学习
- 核心：`core/memory.js`、`memoryConsolidation.js`、`memoryLifecycle.js`；`learning/*`（向量、检索、Qdrant）
- 路由：`routes/status.js`（`/api/status`、`/api/memory/rollback-dedup`）、`routes/input.js`（`/api/local-semantic/*`）
- 前端：角色管理页「记忆与学习」（最近记忆 / 学习数据 / 跨话题联想 / 去重合并）
- 数据：`user_memories/`、`dialogue_corpus.json`、`dialogue_embeddings.json`、`peer_index.json`
- 坑：记忆按用户+角色双维度隔离，文件名形如 `<user>__role.json`；删除需连带清理向量库。

### 5.3 输入 / 输出 / 人格
- 核心：`core/input.js`、`output.js`、`selfModel.js`、`expressionProjection.js`、`historyBudget.js`、`narrator.js`
- 路由：`routes/input.js`（`/api/input`）、`routes/session.js`（`/api/session/*`）、`routes/aiConfig.js`（`/api/ai/*`）
- 运行时：`/api/input` → **互动运行时**（`interactionRuntime.outputModule` + `SCENE_PROMPT.interaction`）；`/api/session/*` 的人设与提示词预览 → **角色运行时**
- 前端：开发者页「测试输入」、用户对话页
- 坑：`/api/input` 是主链路，改动前先看 `input.js` 的 prompt 拼装顺序；轮数别动。互动与角色共用会话库，所以历史接得上，但输出实例是两份，别再把 `outputModule` 当成全局单例传。

### 5.4 编程沙箱
- 核心：`core/coding.js`、`codingLoop.js`、`codingTeam.js`、`codingWorkers.js`、`codingCompetition.js`、`sandboxAgents.js`、`sandboxExec.js`、`codingPhilosophy.js`、`codeIndex.js`、`parsers/grammars/*.wasm`
- 路由：`routes/coding.js`（`/api/coding/*`，约 80 个端点），全部 `requireCodingUser`
- 运行时：**沙箱运行时**（`sandboxRuntime.outputModule`）；`codingLoop` 与竞赛评委共用这一份，与互动对话的工具上下文隔离
- 前端：`public/coding.html` + `coding-board.js`
- 数据：`data/coding/*`
- 坑：本地中转走 `http://127.0.0.1:41888/relay`；沙箱代码只写 `data/coding/workspace|workspaces`。

### 5.5 QQ / OneBot
- 核心：`src/server/qq/bridge.js`、`qq/onebotRoutes.js`、`core/oneBotClient.js`、`oneBotConfig.js`、`qqChatRules.js`、`qqMessage.js`
- 路由：`/api/qq/*`（规则 `/api/qq/rules`、管理指令开关 `/api/qq/admin-commands`）、`/api/onebot/*`
- 运行时：**QQ 运行时**（`createQQRuntime`：独立会话库 `data/qq_sessions` + 独立输出实例 + 独立私生活）。`bridge.js` 只消费 `ctx.qqRuntime`，不再自建内核；归档链由 `runtimes.js` 的 `wireArchivePipeline` 挂一次
- 前端：设置页 QQ 面板（仅 admin 可见，`loadOneBotConfig/loadQQChatRules/loadQQAdminCommands`）
- 数据：`oneBotConfig.json`、`qq_chat_rules.json`、`qq_bridge_state.json`、`qq_sessions/`
- 坑：修复时不要重启线上实例；`QQ_ADMIN_COMMANDS` 只作首次默认值，运行态以接口为准。

### 5.6 B 站直播 / TTS
- 核心：`src/server/bilibili.js`（路由+装配）、`core/biliLiveBridge.js`、`biliLiveConfig.js`、`danmaku/*`、`core/tts.js`
- 路由：`/api/bili/*`、`/api/tts/*`（`voices` `synthesize` `audio/:filename` `clone` `refresh-voices`）
- 运行时：**B站运行时**（`createBiliRuntime`：独立会话库 `data/bili_sessions` + 独立输出实例）
- 数据：`bili_sessions/`、`src/data/tts_output/*.wav`
- 坑：不配 B 站参数会自动落 mock，用 `POST /api/bili/test-danmaku` 跑通链路；TTS 合成仅 `requireHost`。

### 5.7 摄像头 / 屏幕
- 核心：`core/camera.js`、`screen.js`；路由 `routes/capture.js`（`/api/camera`、`/api/screen` GET/POST）
- 前端：角色管理页「感知与规则」（默认关闭）
- 数据：`camera_config.json`
- 坑：默认必须关闭；开启是显式写操作。

### 5.8 进化
- 核心：`core/evolutionGate.js`、`evolutionParams.js`、`personaEvolution.js`、`personaEvolutionStore.js`、`mortality.js`、`mortalityShadow.js`
- 路由：`routes/evolution.js`（`/api/evolution/*`，全部 `requireAdmin`）
- 数据：`evolution/internal-signal.jsonl`、`persona-evolution/*`
- 坑：proposal 生命周期 `evaluate → promote → rollback`，promote 前必须有 evaluate 记录。

### 5.9 中转站
- 核心：`core/relayHub.js`；路由 `routes/relay.js`（`/api/relay/*`，`requireLogin`，含 `isHostRequest`）
- 前端：`public/relay.html`
- 坑：编程沙箱依赖它，改协议先看 `coding.js` 里 `relayBaseUrl` 的用法。

### 5.10 研究平台
- 核心：`core/research.js`、`researchAgent.js`、`toolRegistry.js`、`readTools.js`、`webCheck.js`
- 路由：`routes/research.js`（`/api/research/*`，`requireHost`）
- 前端：`public/research.html`
- 坑：仅本机；任务存 `research/tasks`，笔记走 `/api/research/note`。

### 5.11 画板 / 社交 / Live2D
- 画板：`routes/canvas.js`（`/api/canvas/*`，save 需 host），数据 `data/canvas/*.json`，格式见 index.html L1774 注释（`{version,size,strokes:[{color,baseWidth,points:[{x,y,p,t}]}]}`）。
- 社交：`core/socialPlaza.js` + `routes/social.js`（`/api/social/*`）+ `public/social.html`；走角色运行时的 API 通道，不读写信箱以外的记忆。
- 她的动态 / 陪她玩 / 闲话：`routes/feed.js`（角色运行时，内容取自私生活档案）、`routes/games.js`（互动运行时）、`routes/gossip.js`（只读大厅影子印象、不调模型）。
- Live2D：`public/live2d.html`，无独立后端路由。

### 5.12 认证 / 用户 API / 运维
- 认证：`core/auth.js`、`core/security.js`、`routes/auth.js`（`/api/auth/*`）、`routes/admin.js`（`/api/admin/*`、`/api/user/*`、`/api/server/shutdown`）、`routes/userApi.js`（`/api/user/custom-api*`）
- 全局配置：`core/globalConfig.js` + `routes/globalConfig.js`（`/api/global-config*`，含 `/test`）
- 运维：`routes/ops.js`（`/api/logs`、`/api/developer/*`、`/api/narrator/*`、`/api/schedule*`、`/api/backup/*`）、`core/backup.js`、`core/schedule.js`、`lifecycle.js`
- 坑：`/api/server/shutdown` 是 host-only，可能中断用户正在用的服务，先问。

## §6 验证清单

### 6.1 index.html 内嵌脚本语法
```
# 1) 抽 <script> 到临时文件
# 2) node --check tmp.js
```
（PowerShell 下不要用内联 `node -e` 带双引号，会被吞引号；写成临时文件再执行。）

### 6.2 标签配平
改完 index.html 统计：`<details>`/`</details>`、`<div>`/`</div>`、`<summary>`/`</summary>` 数量必须相等。

### 6.3 元素 ID 存活
改 UI 后确认被 JS 引用的 `getElementById` id 仍存在且唯一（尤其 `semantic-*`、`address-*`、`camera-*`、`screen-*`、`affection-*`）。

### 6.4 端口 41888 被占
多为旧实例仍在跑 → 先 `Get-NetTCPConnection -LocalPort 41888` 找 PID，问用户后再处理；不要直接杀。

## §7 常见改动落点

| 需求 | 改哪 |
|---|---|
| 加一个 API | `src/server/routes/<域>.js` → index.js 注册 → §4.4 前端调用 |
| 加页面板块 | index.html 对应 `*-tab` 容器 + 复用 §4.3 工具类 |
| 调整引导文案 | 只改 `.guide-box` / `.panel-note`，不动结构 |
| 新增低频面板 | `details.fold-panel`，summary = `›` + 标题 + `.fold-hint` |
| 新增存档 | §3.1 原子写 + 在 §3.2 补一行 |
| 改某个通道的出口/场景/工具白名单 | `src/server/runtimes.js`；路由只消费运行时对象 |
| 改她「怎么想」（情绪/记忆/好感） | 器官层 `src/core/*`，禁止在运行时里复制状态 |
| 改情绪/记忆算法 | 先读对应 core 文件与 `test/` 里相关用例 |

## §8 既有资料（避免重复造轮子）
- `AGENTS.md`：输出纪律、预算、字数阈值。
- `.trae/skills/token-guard/SKILL.md`：token 口径细则。
- `.trae/documents/接口与代码区块索引.md`、`接口与依赖-交接.md`、`流程与协作-交接.md`、`哲学设计-交接.md`：历史交接，冲突时以代码为准。
- `README.md`：项目说明；历史问题记录与旧方案统一收在 `过往痕迹/`（设计存档，不参与构建）。
