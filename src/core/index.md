# src/core 索引

系统核心层：模型调用、对话主链、记忆与自我模型、编码闭环与 Agent 集群、时间线与生活档案、账号与运维。

**分层**：`core` 不依赖 `server`；`server` 通过 ctx 注入调用 `core`；`core` 之间允许横向依赖，但纯逻辑模块（*Lifecycle / *Shadow / *Guard）必须保持不碰 fs、不碰网络，便于单测。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 按主题速查

- **对话与模型**：[api.js](api.js)、[output.js](output.js)、[outputParsing.js](outputParsing.js)、[localLLM.js](localLLM.js)、[narrator.js](narrator.js)、[input.js](input.js)、[historyBudget.js](historyBudget.js)、[thinkingMap.js](thinkingMap.js)、[thinkingLog.js](thinkingLog.js)、[usageStats.js](usageStats.js)、[userApi.js](userApi.js)、[globalConfig.js](globalConfig.js)、[config.js](config.js)、[textGuard.js](textGuard.js)
- **记忆与自我**：[workingMemory.js](workingMemory.js)、[memory.js](memory.js)、[memoryGraph.js](memoryGraph.js)、[memoryLifecycle.js](memoryLifecycle.js)、[memoryConsolidation.js](memoryConsolidation.js)、[scene.js](scene.js)、[evolutionRequest.js](evolutionRequest.js)、[selfModel.js](selfModel.js)、[mortality.js](mortality.js)、[mortalityShadow.js](mortalityShadow.js)、[deviation.js](deviation.js)、[deviationShadow.js](deviationShadow.js)、[emotion.js](emotion.js)、[emotionLedger.js](emotionLedger.js)、[expressionProjection.js](expressionProjection.js)、[cide.js](cide.js)
- **人格与社交**：[personaEvolution.js](personaEvolution.js)、[personaEvolutionStore.js](personaEvolutionStore.js)、[personaDistill.js](personaDistill.js)、[roundtable.js](roundtable.js)、[socialPlaza.js](socialPlaza.js)、[plazaImpression.js](plazaImpression.js)、[qqChatRules.js](qqChatRules.js)、[qqMessage.js](qqMessage.js)、[gameTable.js](gameTable.js)、[galgame.js](galgame.js)、[skills.js](skills.js)、[autoToolStore.js](autoToolStore.js)
- **时间与生活**：[timeline.js](timeline.js)、[timelineView.js](timelineView.js)、[artifactDelivery.js](artifactDelivery.js)、[appointmentBook.js](appointmentBook.js)、[privateLife.js](privateLife.js)、[diary.js](diary.js)、[schedule.js](schedule.js)、[tavernClock.js](tavernClock.js)、[proactiveScheduler.js](proactiveScheduler.js)
- **编码与 Agent**：[toolDefinitions.js](toolDefinitions.js)、[toolRegistry.js](toolRegistry.js)、[codingLoop.js](codingLoop.js)、[coding.js](coding.js)、[codingTeam.js](codingTeam.js)、[codingWorkers.js](codingWorkers.js)、[codingCompetition.js](codingCompetition.js)、[codingPhilosophy.js](codingPhilosophy.js)、[codingPhilosophyShadow.js](codingPhilosophyShadow.js)、[codeIndex.js](codeIndex.js)、[plan.js](plan.js)、[checkpointLog.js](checkpointLog.js)、[taskManifest.js](taskManifest.js)、[dispatchDesk.js](dispatchDesk.js)、[fleetMonitor.js](fleetMonitor.js)、[fleetScout.js](fleetScout.js)、[agentFleet.js](agentFleet.js)、[workspaceCopy.js](workspaceCopy.js)、[sandboxExec.js](sandboxExec.js)、[sandboxAgents.js](sandboxAgents.js)、[webCheck.js](webCheck.js)、[healthCheck.js](healthCheck.js)、[deploy.js](deploy.js)、[relayHub.js](relayHub.js)、[readTools.js](readTools.js)、[trajectory.js](trajectory.js)、[progressTracker.js](progressTracker.js)、[webText.js](webText.js)、[designCapture.js](designCapture.js)、[designMcp.js](designMcp.js)
- **媒体与设备**：[camera.js](camera.js)、[screen.js](screen.js)、[liveVision.js](liveVision.js)、[tts.js](tts.js)、[biliLiveBridge.js](biliLiveBridge.js)、[biliLiveConfig.js](biliLiveConfig.js)、[deviceLinkClient.js](deviceLinkClient.js)、[danmaku/index.js](danmaku/index.js)
- **账号与运维**：[auth.js](auth.js)、[security.js](security.js)、[securityGuard/index.js](securityGuard/index.js)、[backup.js](backup.js)、[evolutionGate.js](evolutionGate.js)、[evolutionParams.js](evolutionParams.js)、[resourceGuard.js](resourceGuard.js)、[learningTask.js](learningTask.js)、[learningStore.js](learningStore.js)、[research.js](research.js)、[researchAgent.js](researchAgent.js)、[oneBotClient.js](oneBotClient.js)、[oneBotConfig.js](oneBotConfig.js)

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `agentFleet.js` | 1020 | Agent 集群：4 写手 + 12 侦察，规划→派发→合并 | AgentFleet / createAgentFleet / WRITER_TOOLS / DEFAULT_WRITERS | agentFleet |
| `api.js` | 602 | 统一模型调用层：多后端、流式、思考模式、缓存命中统计 | UnifiedAPI / APIManager | — |
| `appointmentBook.js` | 372 | 事件簿：约定/日程到点提醒与追问 | AppointmentBook | appointmentBook / timelineWiring |
| `artifactDelivery.js` | 141 | 物件投递策略（纯函数） | ARTIFACT_DEFAULTS / resolveOptions / isNightSilent / dailyMaxFor | artifactDelivery |
| `assistantTools.js` | 646 | 陪伴与感知工具（check_hijack / canvas_draw / canvas_clear / search_chat_history / archive_message / adjust_background_weight / pin_memory / unpin_memory / schedule_diary / request_evolution / speak / robot_action / check_body / look_at_user / recall_vision_memory / look_at_screen / recall_screen_memory）：从 ToolRegistry 拆出，会话/记忆/TTS/摄像头/屏幕/设备链路走 host；`handlers()` 供处理器表接管 | AssistantTools | — |
| `auth.js` | 457 | 账号体系：注册/登录/改密（bcrypt）；登录失败内存限速（5 次锁 5 分钟） | AuthModule | authSecurity |
| `autoToolStore.js` | 364 | 自建工具存储（§8.12 / §8.13）：情感履历判定「该自己造个工具」后，落到这里 | AutoToolStore / FORBIDDEN_STEP_TOOLS / MAX_STEPS | autoToolStore |
| `backup.js` | 185 | 数据目录打包备份（zip，不加密） | BackupManager | — |
| `biliLiveBridge.js` | 391 | B 站直播桥：弹幕 → 判定 → 限流 → 编排 → TTS → 皮套 | BiliLiveBridge / SESSION_PREFIX / BRIDGE_VOICE / trimReply | — |
| `biliLiveConfig.js` | 241 | B 站直播配置（房间号 / 身份 / 开关） | getConfig / getMasked / update / reset | — |
| `camera.js` | 512 | 摄像头 / 看图（视觉记忆），仅 AI 态可用 | CameraModule | — |
| `checkpointLog.js` | 179 | 检查点日志（append-only JSONL） | CHECKPOINT_FILE / MAX_LINE_BYTES / normalizeEntry / serializeEntry | checkpointLog / codingPlan / codingResume |
| `cide.js` | 1216 | CIDE 引擎：全局工作区 / 元认知 / 主动驱动 / 证据层 | CIDEEngine / GlobalWorkspace / MetaCognition / ProactiveDrive | cide |
| `codeExecTools.js` | 182 | 代码执行工具（run_command / run_python / run_node / open_in_vscode）：从 ToolRegistry 拆出的执行体，项目根与命令沙箱仍由 host 提供；`handlers()` 供处理器表接管；拼 shell 前拦截引号/换行；执行前过 `securityGuard` 命令闸门与父本账本（构造器 `options.securityGuard` 可注入） | CodeExecTools | securityGuard |
| `coldStart.js` | 770 | 冷启动保护：启动注入 + 流量劫持面 + 抓包根证书 + 原生模块体检（preflight）、运行期每次外连前复核并熔断（assertTrafficSafe / installAxiosCircuit 统一 axios 出网、明文 HTTP 公网拒绝）、解析地址校验（safeLookup 拒绝内网/回环）、证书固定（启动时 probePins 预置基线 + 握手时 checkPinnedIdentity 校验 + .shadow 副本防删）、诱饵凭据（assertNoCanary）、就绪前 `/api` 一律 503（gate，ready 探针带 traffic 状态）、就绪前崩溃即退（installCrashGuard）；取代原 security/guard.py | coldStart（inspectEnv / inspectTraffic / assertTrafficSafe / trafficStatus / installAxiosCircuit / isPrivateAddress / evaluateLookup / makeLookup / safeLookup / safeLookupPlain / pinOf / pinList / loadPins / resetPinCache / verifyPinned / checkPinnedIdentity / probePins / canaryToken / findCanary / assertNoCanary / matchMitmCa / scanTrustedRoots / inspectNativeModules / apiHosts / matchHosts / preflight / gate / markReady / isReady / bootMs / installCrashGuard） | coldStartTraffic + hijackDrill（scripts/hijack-drill.js） |
| `codeIndex.js` | 1172 | 按需符号索引：tree-sitter(WASM) 抽定义与引用 | CodeIndex / EXT_TO_LANG / DEFAULT_MAX_FILES | — |
| `codeMutateTools.js` | 150 | 代码写入工具（code_write / code_apply_patch / code_write_file）：从 ToolRegistry 拆出，读取追踪与测试目录保护走 host；`handlers()` 供处理器表接管 | CodeMutateTools | codeSearch / toolRegistry |
| `codeOpsTools.js` | 423 | 编码运维工具（code_read / code_run / code_list_dir / find_symbol / find_refs / repo_map / run_tests / diagnose / git / web_check / health_check / deploy / workspace_create）：从 ToolRegistry 拆出，工作区解析、测试日志、索引入口与验收执行体仍走 host；`handlers()` 供处理器表接管 | CodeOpsTools / parseTestOutput | codingE2E / toolRegistry |
| `codeWorkspaceTools.js` | 312 | 只读代码工作区工具（read_range / outline / search）：从 ToolRegistry 拆出的执行体，公共能力仍由 host 提供；`handlers()` 供处理器表接管 | CodeWorkspaceTools | codeSearch |
| `coding.js` | 1014 | 编程沙箱：任务板 / 工作台 / 运行日志 / 讨论记录 | CodingCenter | codingDiscussUI / codingGit / codingIdeation / codingP1 / codingProgress / codingProjectMemory / codingReviewUI |
| `codingCompetition.js` | 695 | 编程竞赛：同初始工作区多候选 + 硬指标排名 | CodingCompetition / buildCompetitionGoal / normalizeCandidates / topicScore | codingCompetition |
| `codingLoop.js` | 2700 | 编码闭环：目标 → 改代码 → 判据 → 检查点 / 可选自愈（网页端默认保留失败现场，每轮对话可手动回滚到起点）；先编译 SPEC（能力/非目标/里程碑），每轮注入 SPEC 与上轮失败诊断，结束时再走独立 verifier | CodingLoop / normalizeStages / evaluateStage | codingAutonomy / codingE2E / codingIdeation / codingLoop / codingP1 / codingPlan / codingPolicy / codingProjectMemory / codingResume / codingStage / historyBudget / webCheck |
| `codingMemory.js` | 207 | 编码闭环独立工作记忆：读/改文件、验证结果、备注，按上限收敛并落盘 data/coding/memory | CodingMemory / LIMITS / MEMORY_DIR | codingMemory |
| `codingSpec.js` | 130 | 目标 → SPEC 编译器：能力清单 / 非目标 / 里程碑 / 验收方式；渲染落盘 .trae/SPEC.md，供闭环与 verifier 共用 | buildSpecMessages / parseSpec / specIsUsable / renderSpec / missingCapabilities | codingSpec |
| `codingPhilosophy.js` | 91 | 编程哲学协议：开关归一 / 标注 prompt / 指纹抽取 | LIFECYCLE_DEFAULT / STANCES / FINGERPRINT_CAP / normalizeCodingPhilosophyLifecycle | codingPhilosophy |
| `codingPhilosophyShadow.js` | 43 | 编程哲学 L0 观测落盘（只观测不注入） | appendPhilosophySample / stampFor / DEFAULT_DIR | codingPhilosophy |
| `codingTaskTools.js` | 31 | 编程任务板工具（coding_task_list / coding_task_add / coding_task_update）：从 ToolRegistry 拆出，任务板走 host.coding；`handlers()` 供处理器表接管 | CodingTaskTools | — |
| `codingTeam.js` | 1119 | 编程团队：多人格方案讨论 + 抓点监控 | CodingTeam / PERSONAS / IDEATION_PERSONAS / applyVerdictTransition | codingDiscussUI / codingIdeation / codingProgress / codingReviewUI / personaEvolution |
| `codingWorkers.js` | 305 | 工人池：任务板待办自动领单并派给编码闭环 | WorkerPool | codingWorkers |
| `config.js` | 9 | 统一 .env 加载入口（全项目只读仓库根一份 .env） | — | — |
| `creativeTools.js` | 66 | 创意世界工具（world_place / world_remove / world_snapshot / world_clear / world_open_page）：从 ToolRegistry 拆出，世界状态与打开浏览器走 host | CreativeTools | — |
| `creativeWorld.js` | 360 | 自由创意世界：24×24×12 等距地台 / 纯色调色板与家具 / 放置移除 / 评分 / 角色钱包与付款 / ROUTES 酒馆点位 / 当日事件去重 / 原子落 data/creative/world.json | CreativeWorld / PALETTE / ROUTES / scoreWorld / keyOf / parseKey | tavernClock |
| `deploy.js` | 280 | 部署执行：runner 声明命令，模型只能执行不能改 | normalizeDeploy / runDeploy / redactSecrets | codingE2E / deploy |
| `designCapture.js` | 402 | 取景器量尺：客户区 + DPI → CSS 视口、元素比例化、design-spec 纯逻辑；采集脚本先切前台再抓屏 | cssDpr / clientToViewport / toRatioBox / buildDesignSpec / parsePowerShellReport / buildWindowProbeScript / buildRegionCaptureScript / readPngSize | designCapture |
| `designMcp.js` | 254 | MCP stdio 客户端（零依赖）：拉 windows-mcp sidecar，initialize → tools/call | McpStdioClient / resolveMcpConfig / collectText / collectImage | designCapture |
| `deviation.js` | 200 | 稳定偏移判据（纯逻辑） | DEVIATION_DEFAULTS / DEVIATION_VERDICTS / axisKey / normalizeSample | deviation |
| `deviationShadow.js` | 85 | 稳定偏移观测落盘 | appendDeviationShadow / readDeviationSamples / stampFor / DEFAULT_DIR | deviation |
| `deviceLinkClient.js` | 324 | 感知与行动平台（pog-sense）的 /v1 协议客户端（不装 serialport，共享 .token）；动作后回读本体状态并对比前后关节（moved/still/unknown），支撑 check_body 主动感知；4xx 只算指令被拒、不摘工具 | DeviceLinkClient / normalizeBodyState | deviceLink |
| `diary.js` | 452 | 日记本：到约定时间（默认 20:00，schedule_diary 可改）由角色自己写；素材取自记忆主链路与当天对话，正文以【日记】回流该用户记忆；每人一本 + 全局本，落 data/diary/，失败退避一小时 | DiaryModule / parseClock / safeOwnerDir | diary |
| `dispatchDesk.js` | 179 | 接线员：派发前唯一闸门（校验/冲突/租约） | DispatchDesk / manifestConflicts | agentFleet / codingFleetManifest |
| `emotion.js` | 393 | 情绪状态层：心情跨轮、跨重启延续 | EmotionModule | emotionInternalSignal |
| `emotionLedger.js` | 926 | 情感履历：记录「什么情绪下缺什么能力」 | EmotionLedger | autoToolStore / emotionLedgerTrim |
| `evolutionGate.js` | 442 | 沙箱进化闸：白名单 + 基线不劣化才放行 | EvolutionGate / MODULES / extractMetrics | evolutionGate |
| `evolutionParams.js` | 162 | 可进化参数的规格与落盘（PARAM_SPECS） | EvolutionParams / PARAM_SPECS / instance | evolutionGate / evolutionParams |
| `evolutionRequest.js` | 247 | 进化诉求：只落结构化提案（默认 shadow），批准/领取/落地在外部 agent；不执行、不写代码 | EvolutionRequestStore / MODES / SCOPES | evolutionRequest |
| `expressionProjection.js` | 188 | 表情投影：情绪快照 → 表达方式 | EMOTIONS / VAD_WEIGHTS / PRESETS / project | expressionProjection |
| `expressive.js` | 613 | 表达学习平台：语料投放 / 她的自学与自主审核 / accepted 示例按语境检索 / 使用记账与照抄冷却 / 对话回流候选（仅在她被用户接住时产生，待审不注入）；落 data/expressive/ | loadNotes / saveNotes / loadConfig / saveConfig / appendCorpus / readBatch / applyLearnResult / findExamples / detectCopies / markExamplesUsed / markExamplesCopied / rememberSpoken / observeUserReply / addDialogueCandidates / applyCandidateResult / getState / learnBatch | expressive |
| `fleetMonitor.js` | 104 | 集群监控：心跳 / TTL 回收 / 越界对账 | LOOP_ARTIFACTS / normalizeChangedPath / parseChangedPaths / findUndeclaredChanges | agentFleet |
| `fleetScout.js` | 138 | 只读侦察员：12 个不落盘槽位，工具白名单只留读工具 | FleetScout / READ_TOOLS / usageTotal | — |
| `galgame.js` | 621 | 好感度（galgame）计分与修复阻尼 | GalgameModule / applyRecoveryDamping / DEFAULT_RECOVERY_DAMPING / DELAYED_REPAIR_WINDOW_MS | galgameRecoveryDamping |
| `gameTable.js` | 211 | 陪她玩：骰子 / 猜拳 / 猜数字的确定性判定 | GameTable / GAMES / GUESS_LIMIT / GAME_LABELS | — |
| `globalConfig.js` | 239 | 全局服务配置（默认 API / Embedding / Qdrant / TTS），落 data/globalConfig.json | getDefaultApi / getEmbedding / getQdrant / getTTS | — |
| `healthCheck.js` | 278 | 健康检查：服务与依赖体检（code_health_check 的执行体） | normalizeHealthCheck / runHealthCheck | healthCheck |
| `historyBudget.js` | 247 | 对话历史有界化与摘要压缩 | DEFAULT_MAX_BYTES / DEFAULT_KEEP_ROUNDS / MAX_DIGEST_BYTES / SAFETY_LIMITS | historyBudget |
| `input.js` | 199 | 用户输入语义分析与训练 | InputModule | — |
| `learningStore.js` | 285 | 学习产物留存层（只认带 manifest 的目录） | LearningStore / newId / safeFileName / sha256 | learningStore / learningTask |
| `learningTask.js` | 446 | 学习任务：取数 → 分析/训练 → 沉淀（受管） | LearningTaskCenter / validateSource / validateRequest / resolvePython | learningTask |
| `learningTools.js` | 42 | 学习与技能包工具（learn_request / learn_run / skill_list / skill_load / skill_resource）：从 ToolRegistry 拆出，学习中心与技能库走 host；`handlers()` 供处理器表接管 | LearningTools | — |
| `liveVision.js` | 625 | 实时视觉中间层（纯逻辑 + 进程内存单例）：浏览器上报的结构化 track → track 生命周期（IoU/中心距匹配、稳定 id、速度、进入/离开确认）、运动学动作推断（靠近/走远/走动/坐着/站着）、姿态手势（挥手/举手）、手部细手势（OK/竖拇指/张开手掌/握拳/数字1-4）、表情（微笑/大笑/皱眉/惊讶/张嘴）、表情细节（挑眉/嘴角一边上扬/眨眼频繁）、视线（看你/看别处/看左右上下）、朝向（正对/侧头、面向/侧身/背对）、姿势（叉腰/抱胸/托腮），全部白名单校验、进出/动作/手势/远近/人数变化事件、紧凑中文场景摘要、按变化消费的提示词段、主动开口由头（进出 10 分钟冷却、挥手 60 秒冷却） | LiveVision / liveVision / LABEL_ZH / labelZh / zoneOf / depthOf / iou | liveVision |
| `localLLM.js` | 224 | 本机兜底模型（Qwen3-0.6B / llm.asm）：Windows 经 WSL、Linux 直连；短提示词预算（默认 420 字符）、超时、并发占用即跳过、过滤 `[asm-llm]` 计时行；失败一律返回 null 交给模板 | isEnabled / buildPrompt / cleanOutput / complete / completeFromMessages | localLLM |
| `memory.js` | 2680 | 记忆主模块：持久化 + 检索 + 注入（生命周期逻辑在 memoryLifecycle）；召回改为向量 + BM25 双路 RRF 融合；新增「最近 32 条」常驻区（近因×显著性浮动）与「强相关 5 条」直取（不受不应期/话题配额）；记忆带 `speaker`（user/self）归属，自主发言与引用她自己的话不再被注入成「用户说过」；自我认知变更写 `data/self_model/history/<user>.jsonl` | MemoryModule | deviation / memoryDedup / memoryDedupWiring / memoryFlushDirty / memoryMoodRecall / memoryRecall / memoryRem / memoryRrf / memoryScopeKey / pinMemory / storeGuard / storeSchema / timelineWiring |
| `memoryConsolidation.js` | 542 | 记忆巩固：情景 → 语义（纯逻辑） | DEFAULTS / MAX_SEMANTIC_LEN / effectiveLen / isConsolidationCandidate | memoryConsolidation / memoryDedup |
| `memoryGraph.js` | 257 | 记忆星图数据折叠（纯逻辑）：强度 / 淡忘 / 情绪色温 / 话题链与日期链边 / 每日概览 / 记忆键展示名 | buildMemoryGraph / memoryStrength / emotionWarmth / dayKey / parseScopeLabel / EMOTION_WARMTH / FADED_STRENGTH / DEFAULT_DAYS / DEFAULT_MAX_NODES | memoryGraph |
| `memoryLifecycle.js` | 359 | 记忆生命周期纯逻辑：衰减 / 强化 / 归档 / 淘汰 | DEFAULTS / isProtected / isPinned / isDurable | memoryDedup / memoryLifecycle |
| `mortality.js` | 61 | 死亡恐惧恒定底盘（纯计算） | DEFAULTS / BAND_BASE / BAND_URGENT / computeMortalityPressure | mortality / mortalityPrompt |
| `mortalityShadow.js` | 43 | 死亡恐惧 shadow 观测落盘 | appendMortalityShadow / stampFor / DEFAULT_DIR | mortalityPrompt |
| `narrator.js` | 1577 | 旁白与内心独白：按场景生成她的叙述与转场；自主开口前接入主对话记忆与场景投影（不落盘） | SystemNarrator | appointmentBook / dialogueInternalBlocks / emotionInternalSignal |
| `oneBotClient.js` | 263 | OneBot v11 客户端（动作白名单） | OneBotClient / READ_ACTIONS / SEND_ACTIONS / MANAGE_ACTIONS | — |
| `oneBotConfig.js` | 132 | OneBot 连接配置（NapCat 地址 / token） | getConfig / getMasked / update / reset | — |
| `output.js` | 2870 | 主对话链：组装提示词、调模型、解析情绪/好感、剥离内部块；云端通道全挂后先试本机 Qwen3-0.6B（`localLLM`），再退回模板；长期记忆按「最近 32 条 + 强相关 5 条 + 语义/归档/自我」分区注入并标注「他说/你说」，AI 态与角色态合并为同一个她；表达示例注入后记账、照抄冷却、观察用户是否接住她上一句；用户附图（data URL）只挂本轮 user 消息 | OutputModule / buildStylePromptText / buildRecentSelfPrompt / formatMemoryLine / normalizeImageDataUrl / stripInternalBlocks | delayedRepairPrompt / deviation / dialogueInternalBlocks / expressive / imageInput / memoryDedupWiring / memoryRecall / memoryRem / mortalityPrompt / selfModelLifecycle |
| `outputParsing.js` | 302 | 输出文本解析与归一（纯函数）：好感度 JSON 定位、围栏/未闭合 JSON、段位标记、元指令夹注、排版归一、内部块剥离、正文形工具调用还原 | parseAffectionChange / findAffectionJson / findMatchingBrace / normalizeAffectionChange / stripJsonBlocks / stripTierMark / stripMetaNotes / normalizeDialogueFormat / normalizeEmotion / stripToolTagDecoration / parseTextToolCalls / stripInternalBlocks | outputParsing / dialogueInternalBlocks |
| `personaDistill.js` | 469 | 大神蒸馏：联网语料 → 人格 → 二次筛查 | PersonaDistiller / ExpertLibrary / EXPERTS_DIR / ROUNDTABLE_DIR | personaDistill |
| `personaEvolution.js` | 741 | 角色自写新版人设与信号提炼 | PersonaEvolution / PERSONA_IDS / MIN_FOCUS_SCORE / normalizeLesson | personaEvolution |
| `personaEvolutionStore.js` | 592 | 人格进化落盘层（只碰 fs） | PersonaEvolutionStore / DEFAULT_DIR | personaEvolution |
| `plan.js` | 178 | 计划 DAG：里程碑 / 子任务 / 下一节点选择 | MAX_NODES / NODE_ID_RE / normalizePlan / orderPlanNodes | codingPlan |
| `plazaImpression.js` | 139 | 群聊印象影子层：A 眼里的 B 是什么样 | ImpressionStore / STORAGE_DIR / MAX_NOTES_PER_SUBJECT / PROMPT_NOTES_PER_SUBJECT | plazaImpression |
| `privateLife.js` | 413 | 私生活档案：不依赖用户也在走的时间线 | PrivateLife | — |
| `proactiveScheduler.js` | 65 | 事件驱动调度影子模式（只记录不投递） | RELEVANT_TYPES / isRelevant / shadowCandidate / attachShadowScheduler | artifactDelivery |
| `progressTracker.js` | 56 | 长任务进度跟踪（有界 Map） | createProgressTracker / DEFAULT_TTL_MS / DEFAULT_MAX_ENTRIES | progressTracker |
| `qqChatRules.js` | 114 | QQ 群白名单与发言模式（落 data/qq_chat_rules.json） | MODES / listGroupRules / getGroupRule / upsertGroupRule | — |
| `qqMessage.js` | 272 | QQ 消息解析与构造（@、回复、纯文本、管理命令） | idText / readMention / readReplyId / messagePlainText | qqMessage |
| `readTools.js` | 178 | 讨论期只读工具（路径钉在 root 内） | createReadTools | readTools |
| `relayHub.js` | 736 | 中转站：多模型通道收成 OpenAI 兼容端点 | RelayHub / normalizeEndpoint / endpointToBase | relayAuthToken |
| `research.js` | 312 | 研究平台：任务板 / 笔记 / 检索 / 脚本工作台 | ResearchCenter / keywordScore | research |
| `researchAgent.js` | 307 | 研究平台里的她：复用工具循环，research_* 免授权 | ResearchAgent | — |
| `researchTools.js` | 80 | 研究平台工具（research_search / task_list / task_add / task_update / run / note_save / open_page）：从 ToolRegistry 拆出，研究中心与脚本执行走 host；`handlers()` 供处理器表接管 | ResearchTools | — |
| `resourceGuard.js` | 279 | 资源闸：磁盘配额账本 + CPU 采样分级 | ResourceGuard / DEFAULT_BUCKETS / LIMITS / dirSize | learningTask / resourceGuard |
| `roundtable.js` | 232 | 大神圆桌：2~5 份人格轮流发言 + 主持归纳 | Roundtable / buildExpertPrompt | personaDistill |
| `sandboxAgents.js` | 538 | 沙箱内 Claude Code 执行器 | SandboxAgents | sandboxAgents |
| `sandboxExec.js` | 766 | 沙箱执行：危险命令拦截 + 输出批处理；Windows 走 scripts/windows/sandbox-run.ps1，Linux 走 scripts/linux/sandbox-run.sh（sudo/setpriv + ulimit） | SandboxExec / DANGEROUS_PATTERNS / dangerousReason / redirectionFailure / buildShellScript / buildStreamShell | sandboxAgents / sandboxExec / sandboxExecLinux |
| `schedule.js` | 143 | 角色时间表：到点由她自己开口，落 data/schedule.json | ScheduleStore | — |
| `screen.js` | 470 | 屏幕 / 看屏幕（屏幕记忆），仅 AI 态可用 | ScreenModule | — |
| `security.js` | 254 | 登录失败锁定与限流 | SecurityModule | authSecurity |
| `securityGuard/index.js` | 19 | 安全护栏单例：命令闸门 + 父本账本 + 规则清单 | guardCommand / normalizeCommand / ledger / ProvenanceLedger / rules | securityGuard |
| `securityGuard/commandGuard.js` | 161 | 命令分级（纯函数）：不可逆/硬件级 BLOCK，破坏性但可恢复 CONFIRM，其余放行；规则带 id/name/reason | check / normalize / BLOCK_RULES / CONFIRM_RULES | securityGuard |
| `securityGuard/provenance.js` | 118 | 父本账本（JSONL）：write/exec/install/import/delete 事件落 data/security/provenance.jsonl，带 sha256、来源、触发者；超限轮转；`recent` / `explain` 查询 | ProvenanceLedger / fileSha256 / DEFAULT_FILE | securityGuard |
| `scene.js` | 186 | 场景投影：从对话历史与长期记忆现算位置/相处状态；纯派生、不落盘、无写入口 | SCENE_QUERY / deriveScene / formatSceneHint / extract | scene |
| `selfModel.js` | 505 | 自我模型：反思落地的纯逻辑；trait 带 `sourceIds`（可追溯来源记忆），合并时取并集 | DEFAULTS / normalizeTrait / mergeTrait / selectForInjection / parseSelfTraitOutput | selfModel |
| `skills.js` | 145 | 可插拔技能库（三级渐进披露） | SkillLibrary | codingIdeation |
| `skillStore.js` | 317 | 本地技能市场：技能包新建/覆盖/删除 + zip 导入导出（zip-slip / 符号链接 / 条目数与体积闸） | SkillStore | skillStore |
| `socialPlaza.js` | 339 | 社交平台（群聊大厅），仅网页端存在 | SocialPlaza / ROOM_ID / cleanSpeech | — |
| `systemTools.js` | 38 | 系统运维与联网工具（自查 / 运行时状态 / 完整性 / 日志 / 服务启停 / 文件读写删 / web_search / fetch_url）：从 ToolRegistry 拆出，底层能力仍走 host；`handlers()` 供处理器表接管 | SystemTools | — |
| `tavernClock.js` | 220 | 酒馆节律：作息表 → 角色此刻点位与动作（纯逻辑）/ 朝目标缓步 / 点单窗口与当日去重 / 场景提示拼装 / TavernKeeper 状态层（移动节流落盘） | PLAN / ORDERS / planFor / stepToward / orderDue / describeScene / TavernKeeper | tavernClock |
| `taskManifest.js` | 306 | 任务头文件校验（读写集合 / 独占 / 命令） | ROLES / DEFAULT_WRITER_BUDGET / DEFAULT_SCOUT_BUDGET / DEFAULT_WRITER_TTL_SEC | codingFleetManifest |
| `teamTools.js` | 52 | 编程团队工具（team_discuss / team_review）：从 ToolRegistry 拆出，CodingTeam 由服务端注入；`handlers()` 供处理器表接管 | TeamTools | — |
| `textGuard.js` | 125 | 隐形字符防护（Tag 字符 / 零宽字符） | stripInvisibleChars / findInvisibleChars / scanInvisibleChars / scrubUserText | textGuard |
| `thinkingLog.js` | 49 | 思考原文按天落盘（仅分析用） | appendThinking / LOG_DIR | — |
| `thinkingMap.js` | 27 | 不同后端的「思考模式」字段映射 | buildThinkingPayload | — |
| `timeline.js` | 189 | 时间线事件总线（append-only，按天读回） | TimelineStore / getTimeline / dayKey / DEFAULT_DIR | timeline / timelineWiring |
| `timelineView.js` | 115 | 「她的一天」读模型（纯函数投影） | buildDayView / SECTIONS / sectionOf / timeLabel | timelineView |
| `toolDefinitions.js` | 1045 | 75 个工具的 OpenAI function calling schema（纯数据） | TOOL_DEFINITIONS（数组） | — |
| `toolRegistry.js` | 1631 | 工具中枢：审批/信任档/75 工具分发与执行；全部工具走 `toolHandlers()` 处理器表（代码工作区 / 执行 / 写入 / 编码运维 / 研究 / 学习 / 编程团队 / 系统运维 / 编程任务板 / 陪伴感知 / 创意世界 十一模块），switch 已清零，未知工具与自建工具走兜底；schedule_diary 只改写日记时间、不代写正文；robot_action 回执带本体状态，check_body 主动读状态；写文件后自动语法诊断回灌；code_search 流式逐行检索（glob/大小写/上下文/超时预算） | ToolRegistry / buildIdentityLayer / buildTimeLayer / TOOL_DEFINITIONS | autoDiagnose / codeSearch / codingE2E / codingLoop / deviceLink / pinMemory / textGuard / toolRegistry |
| `trajectory.js` | 78 | 自主能力轨迹：把一轮 run 拍平成可回归比对的序列 | ROUND_TOLERANCE / buildTrajectory / compareTrajectories | codingE2E / trajectory |
| `tts.js` | 498 | GLM-TTS 语音合成（音色 / 语速 / 克隆） | TTSModule | — |
| `usageStats.js` | 105 | 上下文缓存命中与 token 统计口径 | summarizeUsage / summarizeUsageList / summarizeTokens / sumTokens | usageStats |
| `userApi.js` | 384 | 用户自带自定义 API 的校验与调用 | UserApiClient | — |
| `webCheck.js` | 1422 | 页面级验收：本机 Chrome/Edge + CDP 驱动 | normalizeWebCheck / runWebCheck / findBrowserExecutable / launchBrowser | webCheck |
| `webText.js` | 121 | 网页文本处理与 SSRF 校验（纯函数） | decodeHtmlEntities / htmlToText / extractMainContent / isBlockedHost | — |
| `workingMemory.js` | 150 | L1 短时/工作记忆纯逻辑：4 个活动块、按轮次续命与淘汰、同 tag 干扰、首因/近因排序。**未接线**（表达层不持状态）；仅 `arrangePrimacyRecency` 供 output.js 注入排序，类留给 CIDE GlobalWorkspace | WorkingMemory / arrangePrimacyRecency / DEFAULT_CAPACITY | workingMemory |
| `workspaceCopy.js` | 34 | 工作区复制（竞技场与 Agent 集群共用跳过表） | COPY_SKIP / copyTaskWorkspace | — |

## 约定

- 改 `api.js` / `output.js` 前先看 `.trae/documents/` 里的提示词与记忆方案；这两处一动，缓存命中率会整体变化。
- 纯逻辑与落盘必须分离（`mortality.js` ↔ `mortalityShadow.js`、`codingPhilosophy.js` ↔ `codingPhilosophyShadow.js`），不要把 fs 塞进纯逻辑模块。
- 新增持久化文件：走 `storage/atomicWrite`，并在 `storage/storeSchema.js` 登记版本号。
- 工具相关改动要同时改三处：`core/toolDefinitions.js`（schema）、`core/toolRegistry.js`（execute 分发）、本索引。
