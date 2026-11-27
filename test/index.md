# test 索引

测试是验收标准的载体：**任何工具（code_apply_patch / code_write_file）都不允许改写 `test/` 下的文件**（见 `core/toolRegistry.js` 的 `isProtectedTestPath`）。改行为先改/补测试，再改实现。

## 运行

```bash
npm test                                          # 全量（串行，约 150s，当前基线 1187 用例）
node --test test/memoryRecall.test.js             # 单文件
node --test --test-concurrency=1 "test/**/*.test.js"   # 与 npm test 等价
```

必须串行：用例共享 `data/` 与临时端口，并发会互相污染。

## 按领域

| 领域 | 测试文件 |
|---|---|
| 编码闭环 / Agent 集群 | `codingAutonomy` `codingBoard` `codingCompetition` `codingDiscussTrace` `codingDiscussUI` `codingE2E` `codingFleetManifest` `codingGit` `codingIdeation` `codingLoop` `codingMemory` `codingSpec` `codingP1` `codingPhilosophy` `codingPlan` `codingPolicy` `codingProgress` `codingProjectMemory` `codingResume` `codingReviewUI` `codingStage` `codingWorkers` `agentFleet` `checkpointLog` `deploy` `healthCheck` `trajectory` `webCheck` `progressTracker` |
| 记忆 / 自我 / 情绪 | `workingMemory` `memoryConsolidation` `memoryDedup` `memoryDedupWiring` `memoryFlushDirty` `memoryLifecycle` `memoryManage` `memoryMoodRecall` `memoryRecall` `memoryRem` `memoryScopeKey` `selfModel` `selfModelLifecycle` `mortality` `mortalityPrompt` `deviation` `emotionInternalSignal` `emotionLedgerTrim` `expressionProjection` `cide` `delayedRepairPrompt` `dialogueInternalBlocks` `historyBudget` |
| 时间线 / 生活 | `timeline` `timelineView` `timelineWiring` `appointmentBook` `artifactDelivery` `diary` `tavernClock` |
| 对话 / 工具 | `toolRegistry` `codeSearch`（含 code_read_range 防重复读） `autoDiagnose` `pinMemory` `readTools` `textGuard` `imageInput` `qqMessage` `usageStats` `relayAuthToken` `localLLM` |
| 社交 / 人格 | `personaDistill` `personaEvolution` `plazaImpression` `autoToolStore` `skills`（在 codingIdeation 内） |
| 存储 / 安全 | `atomicWrite` `storeGuard` `storeSchema` `writeLock` `authSecurity` `securityGuard` `dependencyAudit` `networkBaseline` `coldStartTraffic` `sandboxExec` `sandboxAgents` |
| 学习 / 准入 | `learningRetrieval` `learningStore` `learningTask` `localVectorStore` `resourceGuard` `intake` |
| 研究平台 | `research` |
| server 装配 / 路由 | `serverRoutes`（23 个路由模块 + onebotRoutes + bilibili） |

## 约定

- 只测纯逻辑与可注入依赖；需要磁盘时用 `os.tmpdir()` 建的临时目录，跑完清理。
- 涉及「当前时间」的用例必须显式传 `now` / `today`，不要依赖真实日期（跨天会红）。
- 新增模块时同步在对应目录的 `index.md`「相关测试」列登记。
