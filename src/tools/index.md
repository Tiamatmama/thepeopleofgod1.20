# src/tools 索引

工具与外部执行能力层：进程管理、代码完整性校验、网页/语料抓取。被 `core/toolRegistry.js` 与 `core/codingLoop.js` 消费。

纯函数与纯数据（工具 schema、网页文本解析）已下沉到 `src/core/`（见 [core/index.md](../core/index.md)），本目录只留「会碰外部世界」的执行器与抓取器。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `articleFeed.js` | 426 | 文章语料抓取：中文维基 → 清洗 → 向量入库 | CONFIG / collectArticles / buildArticle / isGoodArticle | — |
| `codeIntegrity.js` | 350 | 关键文件完整性校验（哈希签名 + 比对） | CodeIntegrity | sandboxExec |
| `developerTool.js` | 101 | 开发者日志工具（写 developer.log） | DeveloperTool | — |
| `dialogueFeed.js` | 479 | 对话语料抓取：LCCC/种子对 → 清洗 → 向量入库 | CONFIG / collectPairs / buildLcccPairs / buildSeedPairs | — |
| `processManager.js` | 134 | 服务进程管理（启动 / 停止 / 单实例判断） | ProcessManager | — |

## 约定

- 本目录允许依赖 `core`（低层），**禁止**被 `core` 反向依赖；分层方向由 `npm run check:layering` 强制。
- 语料抓取（articleFeed / dialogueFeed）会写 `data/` 并调 Embedding，属于「慢路径」，不要在请求热路径里 require。
- 工具 schema 在 `core/toolDefinitions.js`；新增工具要同步 `core/toolRegistry.js` 的 `execute` case 与审批/信任档名单。
