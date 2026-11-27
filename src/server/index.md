# src/server 索引

HTTP/WebSocket 装配层（Composition Root）：`index.js` 组装依赖并 listen，其余文件按「运行时通道」或「路由分组」拆分，统一通过 ctx 注入依赖，避免反向 require `index.js`。

WebSocket 安全约束：连接升级时校验 Origin（仅 localhost / 127.0.0.1 / ::1，防第三方网页直连）；`ws-auth` 带登录 sessionId 并通过 `authModule.validateSession` 才算已认证；`tool-confirm-response` 只接受已认证连接，自报用户名不算。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `bilibili.js` | 168 | B 站直播 + TTS 路由 | registerBilibiliRoutes | — |
| `index.js` | 1248 | 服务入口：装配依赖、注册路由、启动 HTTP/WSS；日记本在此建实例，并起一分钟定时器分别调度网页与 QQ 两套会话库 | — | diary |
| `lifecycle.js` | 70 | 启动与退出生命周期（服务锁 / 刷记忆 / 信号） | setupLifecycle | — |
| `runtimes.js` | 177 | 通道装配：角色 / 互动 / 沙箱 / QQ / B 站运行时 | RUNTIME_KIND / SCENE_PROMPT / createRoleRuntime / createInteractionRuntime | — |

## 约定

- 新增路由：在 `routes/` 建文件导出 `registerXxxRoutes(app, ctx)`，再到 `index.js` 装配一行。
- 路由层不写业务逻辑：校验会话/参数后转交 `core/*`，错误统一走 `serverError`。
- 端口/鉴权/HTTPS 证书都在 `index.js`，改这些先看 `core/security.js`。
