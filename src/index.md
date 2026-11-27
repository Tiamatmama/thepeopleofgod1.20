# src 索引

本目录是服务端源码。**每个子目录都有自己的 `index.md`**，写明该目录下每个文件的职责、导出与对应测试；本文件只负责全局导航。

## 分层与依赖方向

```
src/server  ──→  src/core  ──→  src/tools
    │              │  │  └──→  src/learning
    │              │  └─────→  src/storage
    │              └────────→  src/session
    └───────────────────────→  src/intake
```

- `server` 只做装配与协议转换，依赖经 `ctx` 注入，**禁止反向 require `server/index.js`**。
- `core` 不依赖 `server`；纯逻辑模块（`*Lifecycle` / `*Shadow` / `*Guard`）不碰 fs、不碰网络。
- `storage` 是所有落盘的唯一底座；新增 JSON 一律走 `atomicWrite` + `writeLock`。

## 子模块

| 目录 | 索引 | 一句话 |
|---|---|---|
| `core/` | [index.md](core/index.md) | 模型调用、对话主链、记忆与自我、编码闭环与 Agent 集群、时间线 |
| `server/` | [index.md](server/index.md) | HTTP/WSS 装配与生命周期 |
| `server/routes/` | [index.md](server/routes/index.md) | 按业务域拆分的 Express 路由 |
| `server/qq/` | [index.md](server/qq/index.md) | QQ（OneBot v11 / NapCat）接入 |
| `core/danmaku/` | [index.md](core/danmaku/index.md) | B 站弹幕源适配 |
| `core/securityGuard/` | [index.md](core/securityGuard/index.md) | 危险命令闸门 + 父本账本 |
| `tools/` | [index.md](tools/index.md) | 进程管理、工具 schema、网页/语料抓取 |
| `learning/` | [index.md](learning/index.md) | Qdrant 向量检索与学习 |
| `storage/` | [index.md](storage/index.md) | 原子写、写锁、坏文件隔离 |
| `session/` | [index.md](session/index.md) | 会话历史管理 |
| `intake/` | [index.md](intake/index.md) | 开源方案准入通道 |

`config/`、`data/`、`galgame/` 目前为空（历史遗留或运行时产物），无代码。

## 启动路径

`npm start` → [server/index.js](server/index.js)：加载配置 → 建 Express/WSS → [lifecycle.js](server/lifecycle.js) 落服务锁 → [runtimes.js](server/runtimes.js) 装配各通道 → `routes/*` 注册接口。

## 数据落盘

运行时数据都在仓库根的 `data/`（未纳入 git）。常用位置：`data/sessions/`（会话）、`data/research/`、`data/coding/`、`data/learn/`、`data/timeline/`、`data/persona-evolution/`、`data/globalConfig.json`。

## 架构检查

`npm run lint` = ESLint + 循环依赖 + 分层方向，三道闸串行，CI 直接复用这条命令。

- **循环依赖**：[check-circular.js](../scripts/check-circular.js)，扫 `src/` 的 require 图，有环退出码 1 并打印整条环路径。单独跑 `npm run check:circular`。
- **分层方向**：[check-layering.js](../scripts/check-layering.js)，只允许高层引用低层：`storage(0) < core(1) < tools / learning / session / intake(2) < server(3)`。新增倒挂直接失败；历史倒挂登记在脚本的 `EXCEPTIONS` 里并每次打印。单独跑 `npm run check:layering`。

当前已登记的 3 处倒挂（技术债）：`toolRegistry` → `tools/{processManager,codeIntegrity}`、`memory` → `learning/memoryVectorStore`。纯函数/纯数据（`webText`、`toolDefinitions`）已下沉到 core，不再计入。

## 文档

- 深度设计文档：`.trae/documents/`、`docs/`。
- 代码级索引：各目录 `index.md`（改代码后请同步职责列）。
