# src/server/routes 索引

按业务域拆分的 Express 路由。每个文件导出一个 `registerXxxRoutes(app, ctx)`，依赖全部来自 `ctx`。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `admin.js` | 119 | 管理端：用户 / 机器人 / 服务器关闭 | registerAdminRoutes | — |
| `aiConfig.js` | 86 | AI 配置读取 / 切换 / 进程管理 | registerAiConfigRoutes | — |
| `auth.js` | 180 | 登录 / 注册 / 登出 / 改密 | registerAuthRoutes | — |
| `canvas.js` | 100 | 画板笔迹存档（data/canvas/*.json） | registerCanvasRoutes | — |
| `capture.js` | 49 | 摄像头 / 屏幕状态与配置 | registerCaptureRoutes | — |
| `coding.js` | 1052 | 编程沙箱 / 团队 / 点子板 / 编码闭环；工作区文件读写（编辑器保存）与相对 HEAD 的逐块审阅基线 | registerCodingRoutes | — |
| `creative.js` | 168 | 自由创意世界：世界快照 / 放置 / 拆除 / 清空 / 场景上下文（技能白名单）/ 边聊边放（callWithTools，仅放行 world_* 与 skill_* 八个工具，6 轮封顶），仅本机 | registerCreativeRoutes | — |
| `design.js` | 255 | 取景器：sidecar 采集参考界面 / 比例化 spec / 同尺子渲染（仅本机，截图落 data/design） | registerDesignRoutes | designCapture |
| `evolution.js` | 127 | 沙箱进化闸管理端 API | registerEvolutionRoutes | — |
| `expressive.js` | 88 | 表达学习平台：状态 / 语料投放 / 手动学一批 / 学习约定 | registerExpressiveRoutes | — |
| `experts.js` | 115 | 大神蒸馏 + 圆桌讨论 | (函数) | — |
| `feed.js` | 130 | 她的动态（朋友圈） | (函数) | — |
| `games.js` | 225 | 陪她玩：开局 / 出手 / 认输 | (函数) | — |
| `globalConfig.js` | 123 | 全局服务配置读写 | registerGlobalConfigRoutes | — |
| `gossip.js` | 86 | 她们的闲话（群聊印象，只读） | (函数) | — |
| `input.js` | 134 | 对话输入与本地语义分析 | registerInputRoutes | — |
| `intake.js` | 146 | 开源方案准入评审页接口 | registerIntakeRoutes | — |
| `learning.js` | 54 | 学习任务：状态 / 计划 / 执行 / 产物删除 | — | — |
| `ops.js` | 175 | 运维：日志 / 好感度规则 / 旁白 / 时间表 / 备份 | registerOpsRoutes | — |
| `relay.js` | 452 | 中转站入口（OpenAI / Anthropic 兼容） | registerRelayRoutes | — |
| `research.js` | 184 | 研究平台页面与 LLM 代理 | registerResearchRoutes | — |
| `security.js` | 50 | 安全护栏只读查询：最近事件 / 路径溯源 / 命令规则清单（无放行与删记录入口） | registerSecurityRoutes | securityGuard |
| `session.js` | 355 | 会话与角色（创建 / 列表 / 加入 / 历史） | registerSessionRoutes | — |
| `skills.js` | 181 | 本地技能市场：列表 / 目录 / 详情 / 新建 / 删除 / 导出 / 导入（zip） | registerSkillsRoutes | — |
| `social.js` | 54 | 群聊大厅（仅网页端） | (函数) | — |
| `status.js` | 118 | 状态 / 记忆概览 / 记忆维护 / 背景音乐清单 | registerStatusRoutes | — |
| `timeline.js` | 34 | 「她的一天」接口 | — | — |
| `memory.js` | 141 | 记忆管理：列表 / 钉住 / 归档（需 confirm）/ 还原；scope 只取登录会话；`GET /api/memory/graph/scopes` 列出来源（管理员含本机 QQ 档），`GET /api/memory/graph?source=` 只读星图数据（节点 / 边 / 每日概览，由 core/memoryGraph 折叠） | — | memoryManage / memoryGraph |
| `userApi.js` | 126 | 用户自定义 API 配置与测试 | registerUserApiRoutes | — |
| `vision.js` | 60 | 实时视觉上报：批量 track / 场景快照 / 关闭清空 / 开关；状态只在 core/liveVision 内存里，不落盘 | registerVisionRoutes | liveVision |

## 约定

- 鉴权中间件从 ctx 取（`requireLogin` / `requireAdmin` / `requireHost`），不要在路由里自己判断用户。
- 不要在路由文件里 `require("../index")`，会造成循环依赖。
- 返回统一 `{ success, ... }`，异常交给 `serverError(res, error)`。
