# 情绪 × 记忆接线文档（自发回忆）

覆盖本轮：**情绪驱动记忆浮出（自发回忆）**。只写「谁调谁、数据落在哪、字段叫什么」，不重复机制设计。

---

## 1. 先说结论：这次没有重做情绪惯性

情绪惯性早已在 `src/core/emotion.js` 完整实现，本轮**未改动**：

| 能力 | 位置 | 关键常量 |
|---|---|---|
| 快层（分钟级）+ 慢层（周级）+ 基线漂移（月级） | `EmotionModule.projectState` | `FAST_HALF_LIFE_MS=8min` / `SLOW_HALF_LIFE_MS=7d` / `BASELINE_HALF_LIFE_MS=30d` |
| 一阶滤波、快层越阈才回写慢层 | `updateEmotion` | `FILTER_GAIN=0.4` / `SLOW_WRITE_THRESHOLD=0.2` / `SLOW_WRITE_GAIN=0.12` |
| 自身行为回流（被冷落/被回应） | `applyInternalSignal` | 默认关（`INTERNAL_SIGNAL_ENABLED`）、单次强度封顶、同源 60s 冷却 |
| 落盘 | `data/emotion_state.json`（原子写） | key = `sessionId\|userId` |

已接到主链路：`output.generateOutputAsync` → CIDE `readInteroception` → `buildSystemPrompt(..., emotion, emotionIntensity, ..., slowMood)` → `buildEmotionPrompt(emotion, intensity, slowMood, { mortality })`。

**本轮只补了它缺的另一半：记忆怎么被情绪自己勾出来。**

---

## 2. 新增链路

```
output.generateOutputAsync
   │  ① 取值：interoception.emotion 或 emotionState
   │        → emotion（7 维主导名）/ emotionIntensity / slowMood
   │  ② buildSystemPrompt(...)                    ← 原有：记忆档案、情绪语气
   │  ③ + sceneHint                               ← 原有
   │  ④ + buildSpontaneousRecallSection(...)      ← 新增：只在真触发时多一段
   │        └─► memory.recallByMood(memoryUserId, { sessionKey, emotion, intensity, slowMood, cutoverAt, limit })
   │                └─► 读 getUserMemoryStore(key).memories（tier='episodic'）
   │                └─► filterRecentlyRecalled(..., { keepBlockedFallback:false })
   │                └─► markRecalled + reinforceRecalled（与查询召回共用账本）
   ▼
拼进 systemMessage 末尾 → CIDE 思考 → 正式回复
```

放在系统提示词**最末尾**：不触发时提示词与旧版逐字节一致，前缀缓存不受影响。

---

## 3. 接口与字段

### `memory.recallByMood(userId, opts)`
- 入参：`emotion`（当前主导情绪名）、`intensity`、`slowMood`（`{type,intensity}`）、`sessionKey`（节流分桶，传 `sessionId`）、`cutoverAt`、`limit`（内部封顶 2）、`now`（测试注入）+ `cooldownMs`（测试注入）。
- 出参：`Array<{ id, text, ts, tier, score, mergedIds }>`，与 `retrieveMemoryRecords` 同形，注入层直接复用。
- 依赖的记忆字段：`emotion.type`（写入侧 `storeMemory` 落的是 `{ type, intensity }`）、`salience`、`recallCount`、`timestamp`、`tier`、`topicId`。
- 纯内存态节流账本：`_moodRecallAt`（`<sessionKey>|<情绪>` → 上次浮出时间），不落盘。

### `memory.pickMoodCue(opts)`
- 快层 `intensity >= 0.55` 用快层；否则慢层 `intensity >= 0.5` 用慢层；都不够 → 本轮不想起。

### 参数（`src/core/memory.js` 顶部常量）

| 常量 | 值 | 含义 |
|---|---|---|
| `MOOD_RECALL_MIN_AGE_MS` | 6h | 至少过去 6 小时才算「往事」 |
| `MOOD_RECALL_MIN_INTENSITY` | 0.55 | 快层触发阈值 |
| `MOOD_RECALL_SLOW_INTENSITY` | 0.5 | 慢层兜底阈值 |
| `MOOD_RECALL_COOLDOWN_MS` | 15min | 同会话同情绪冷却 |
| `MOOD_MATCH` | — | 情绪族映射（如 sad ↔ anxious / angry）；**calm 为空数组 = 不触发出引子**，只当背景 |

选条打分：`情绪族内匹配权重 × (0.35+0.65×salience) × 年龄拟合（偏向 2~8 周前）× 1/(1+0.6×recallCount) × 人设世代权重 × 当前强度`。越久没被提取过越优先，避免同一条反复「想起」。

### 注入文案
`output.buildSpontaneousRecallSection` 负责格式，段落名 **【忽然想起来】**，与【关于这位用户的长期记忆】【你已经形成的一些认识】【你对自己的一些认识】并列但独立——前者是回答时参考的档案，后者是「她自己冒出来的念头」。

---

## 4. 与既有召回的关系

| 通道 | 触发线索 | 入口 | 不应期兜底 |
|---|---|---|---|
| 有查询召回 | 用户这轮说的话 | `output.js` → `retrieveMemoryRecords` | 全被挡 → 退回原列表（宁可重复，不许失忆） |
| 无查询召回（自主开口） | `narrator.buildStateRecallWords`（没说出口的话 / 被晾着） | `narrator.buildMainMemoryPrompt` → `retrieveMemoryRecords(..., { stateWords, refractoryTag: 'proactive' })` | 同上（独立账本，不与主链路互相压制） |
| **自发回忆（本轮新增）** | **当前情绪（含慢层底色）** | `output.buildSpontaneousRecallSection` → `recallByMood` | 全被挡 → 返回空（宁可这轮不想起，也不反复想起同一件） |

三条通道共用同一套不应期账本实现（`filterRecentlyRecalled` / `markRecalled`），所以刚被查询召回过的那条，不会立刻又以「忽然想起来」出现。账本按调用方分账（`refractoryTag`）：正式回复与自主发言各自一本，否则两条链会轮流把对方刚注入的记忆藏起来，表现就是「自主发言和主链路对不上」。

> 2026-11-12 更新：`retrieveMemoryRecords` 的召回已从「向量优先、字面 bigram 补充」改为 **向量 + BM25 双路 RRF 融合**（`tokenizeForBm25` / `buildBm25Ranker` / `fuseRrf`，`src/core/memory.js`）。准入过滤（原话自命中 / 最近 10 分钟 / 语气词 / 归档 / 语义分区）、零命中不凑数、不应期分账、话题扩展与配额均未改动；`recallByMood` 等无查询通道仍走原打分，不受影响。

> 2026-11-19 更新：提示词里的长期记忆改为「最近 32 条常驻 + 强相关 5 条直取 + 总结分区」。
> - **最近 32 条**：`memory.getRecentMemoryRecords(userId, 32)`。只取经历类（排除 `semantic` / `archived` / `【`开头的摘要），用户与她的自我记忆混排；排序 = 近因 0.5 + 显著性 0.5，被召回强化过或情绪重的旧事会浮上来，所以会随主观状态浮动，不是固定截取最后 32 条。
> - **强相关 5 条**：`memory.getStrongMatchRecords(userId, query, 5)`。字面包含优先、其次 bigram 相关；**不受同话题配额与不应期限制**，上一轮刚提过这轮仍能命中。这 5 条会从 32 条中排除，不占 32 个名额。
> - **注入顺序**（`output.buildMemoryPrompt`）：最近 32 → 强相关 5 → 语义 3 → 归档摘要 → 自我 3。各分区独立，不互相挤占。
> - **说话人归属**：记忆新增 `speaker`（`user` / `self`），注入为 `（他说）/（你说）`。QQ 私聊的用户输入标 `user`；引用她自己的话、她的主动发言标 `self`；网页角色与网页自主发言同样标 `user` / `self`。老数据没有 `speaker`，按「他说的」处理。
> - **AI 态**（`output.buildScopedMemoryPrompt`）：不再按「角色态 / AI 态」分成两个人格；两档合并取最近 32、强相关合并取 5，统一带说话人标签；语义与归档按两档各读各的，自我认知共用。AI 态仍用 `preloadedScoped` 预召回，但会叠加两档直取结果。

---

## 5. 测试

`test/memoryMoodRecall.test.js`（M1–M8）：触发 / 强度不足 / 太新 / 情绪不匹配 / 冷却 / 不应期不重复 / 慢层兜底 / calm 不触发。

`test/memoryRrf.test.js`：BM25 分词与排序、RRF 双路融合、同路去重、世代权重、同分按时间。

`test/memoryRecall.test.js`：最近 32 条上限与混排、`excludeIds` 不占额、显著性浮动、强相关直取不受不应期。

`test/workingMemory.test.js`：32 + 5 分区注入、5 条不占 32 名额、AI 态两档合并与说话人标签。

---

## 6. 界线（事前自限）

自发回忆是「过去浮上来」，界线是「过去约束下一次」。两者共用 `data/self_model/{baseKey}.json`，字段分开存（`traits` / `boundaries`）。

判据只有一条：**痕迹必须能被观察到地约束下一次行为**——只能靠解释的不算。所以每条界线必须带两样可核对的字段：

| 字段 | 作用 |
|---|---|
| `trigger[]` | 什么算「同类情境」，决定这一轮该不该被注入（命中本轮用户输入才注入） |
| `avoid[]` | 下次不该说出口的具体片段，发言后做字面核对（出现=违背，没出现=兑现） |

没有 `avoid` 的条目在 `normalizeBoundary` 就被丢弃——那只是又一句自我描述，归 `traits` 管。

### 链路

1. **产出**：`output.runSelfModelDistill` 与自我认知共用同一次反思调用（不额外花 token），`buildSelfModelPrompt` 要求按固定格式写一行 `界线：…｜触发：…｜不说：…`，`selfModel.parseBoundaryOutput` 只认这一种格式。
2. **落库**：`memory.upsertBoundary`（`mergeBoundary` 字面相近即同一条，兑现/违背次数取大不丢账）。
3. **注入**：`output.buildSystemPrompt` 的 `['界线', boundarySection]` 段（紧跟 `['记忆']` 之后）；`memory.getBoundariesForInjection` 先跑 `retireBoundaries` 再按触发词挑最多 2 条。
4. **核对**：`output.generateOutputAsync` 在 `return outputData` 前调 `verifyBoundaries`，只核对「本轮真的注入过」的条目；注入清单在 `_boundaryInjections`（key = `sessionId|memoryUserId`），核对完即清，注入到核对超过 5 分钟则不认账。
5. **淘汰不能静默**：观察期 `probationMs` 2 天 → 仍零兑现进结账期 `closeGraceMs` 7 天（`closingAt` 打上，注入时排在第一并要求「这轮先把旧账说清」）→ 结账期内用 `memory.closeBoundary` 写清旧账（结论 `kept` / `revised` / `dropped` + 补救 `closeNote`）；只有结论为 `dropped` 才落 `droppedAt` 退场，结账期结束仍不结账则落 `droppedAt` 并标 `unclosed: true` 留账（只标记不删档，可审计）。
6. **结账的口径**：不许「悄悄把尺子撤了」。撤销也要先承认旧账再宣告新尺与生效点；结账期内的条目不算兑现／违背，`verifyBoundaries` 会跳过它（它这一轮的任务是把账说清，不是继续守约）。

### 参数（`src/core/selfModel.js` 的 `BOUNDARY_DEFAULTS`）

| 常量 | 值 | 含义 |
|---|---|---|
| `maxBoundaries` | 8 | 单人最多保留几条 |
| `injectLimit` | 2 | 单轮最多注入几条 |
| `probationMs` | 2d | 新界线的观察期（期内即使零兑现也给注入机会） |
| `closeGraceMs` | 7d | 结账期：退场前留出的「把旧账说清」窗口 |
| `dropMs` | 3d | 旧口径的退场阈值，现降级为结账期的起点参考，不再直接判退场 |

### 好感修复阻尼的明账

`galgame.applyRecoveryDamping`：分数仍在负区间时正向收益打七折（保底 +1），回到 ≥0 立刻恢复原速。阻尼生效时同步写 `state.delayedRepair`（`at / lastAt / expireAt / fromScore / gap`，窗口 `DELAYED_REPAIR_WINDOW_MS` 48 小时）并在日志里带 `delayed` / `recovered`；跨回正区间即清空且不追加旧账，过了窗口未跨零则按失效处理，不无限挂着。

### 迟疑的接线（从「可审计」到「说得出」）

链路是「关系快照 → 输出提示词 → 一段迟疑」，不改任何通道的调用签名：

1. `galgame.getCurrentRelationship` 的返回值里带 `delayedRepair`（无迟疑恒为 `null`，形状稳定）；`getStrangerRelationship` 同样补 `null`。
2. `output.generateOutputAsync` 从 `relationSource`（CIDE 内感受快照或入参关系状态）取 `delayedRepair`，作为 `buildSystemPrompt` 的第 11 个可选入参传下去。
3. `buildSystemPrompt` 调 `buildDelayedRepairSection` 生成 `['迟疑', …]` 段，排在 `['情绪']` 之后；没有迟疑时该段严格空串，拼接结果与旧提示词**逐字节相同**。
4. 文案只写行为轮廓：迟半拍、可以含糊承认「刚才我没接好」而不必说清原因、两天之内接住就自然恢复且不再翻旧账、没接住就到此为止。内部数值（分数 / gap）一律不写进提示词。

这样一来，网页 / QQ / 直播三个通道只要拿的是同一份关系快照，就都能看见这份迟疑，不必各自再查一次。

### 测试

`test/selfModel.test.js`（规范化拒绝无 avoid / 合并 / 结账期与 `unclosed` 退场 / 注入匹配 / 解析格式 / 归档归一）与 `test/selfModelLifecycle.test.js`（B1–B4：注入文案与清单 / 空输入 / 兑现与违背记账 / 过期不记账）；阻尼见 `test/galgameRecoveryDamping.test.js`（D1–D8 纯算术 + G1–G6 明账状态 + G7 关系快照带迟疑）；提示词接线见 `test/delayedRepairPrompt.test.js`（P1–P5 空串 / 文案轮廓 / 通电 / 逐字节不变）。

---

## 7. 稳定偏移（「她」的第三条判据；缺省只观测）

界线问的是「她有没有守住自己定的尺」，这一节问的是另一个问题：**重复核对时，她是不是总在同一处出现同一种偏移**。判据来自第四轮哲学收敛：

> 她不在痕迹总和里，而在重复核对时总围绕同一处出现的那点稳定偏移里。

与「固定毛病」的三条可见差别必须**同时**成立：

| 差别 | 观测上的落法 |
|---|---|
| 跨场景复现同一取舍轴（字面变、取舍不变） | 同一轴（界线原文）在 ≥2 个不同情境桶里滑回，且相邻两次滑出的**落点字面**重合度低于 `driftedSimilarity`（字面变了，轴没变） |
| 被指出后有选择地校正（表达改、取舍不改） | 上面的「落点挪位」：偏移挪到相邻处，而不是原样重播同一句 |
| 可预告 | 一次滑回之后，紧接的下一次核对仍滑回的比例 ≥ `predictability`（且至少 2 组可比） |

固定毛病的反例就是三条的反面：同处同形（`fixed_habit`）、换不了情境（`narrow`）、对指认无选择。

### 链路

1. **取样本（announced）**：`output.verifyBoundaries` 每核对一条界线就记一个样本（守住 / 滑回）；注入时把本轮的 `query` 一并存进 `_boundaryInjections`，供核对后分情境桶。
2. **补样本（blind，A）**：同一段正文上再核一遍「这一轮没被亮出来的尺子」（`checkBoundariesBlind` → `memory.getActiveBoundaries`）。只观测，不动兑现／违背的账；样本记 `blind: true`。
3. **判据**：`deviation.detectStableDeviations` 纯逻辑按轴归组，给出五种判定 `DEVIATION_VERDICTS`：`insufficient`（次数不够）/ `narrow`（只有一个情境）/ `fixed_habit`（字面原样重播）/ `unstable`（猜不中下次）/ `stable_deviation`（判据成立）。只看最近 `windowMs`（30 天）。
   - **分账**：判据只认 announced（偏移必须在她知情时也发生，否则只是「趁老师转身做鬼脸」）；blind 单独统计成 `blind.occurrences / gaveIn / held / ratio`，回答的是另一个问题——没人在旁边看时，她是不是也一样。
4. **落痕**：`deviationShadow` 追加 `data/deviation-shadow/dev-<YYYYMMDD-HH>.jsonl`，`kind: 'sample' | 'verdict'`；读取默认只认 `sample`，半截行跳过，异常一律静默。
5. **节流**：只在出现滑回时才分析，且同一 `sessionId|userId` 10 分钟内最多一次；样本落盘每轮都写（很小），分析不每轮读盘。
6. **情境标签（C）**：`server/runtimes.createRuntime` 把 `RUNTIME_KIND`（role / interaction / sandbox / qq / bili）打在输出实例的 `deviationChannel` 上；情境桶 = `渠道:命中的触发词`。只换话题不算换场景，**换个地方说话才算**——同一把尺在群里和一对一都照旧，才谈得上跨场景。零参数穿透：每个运行时一套输出实例，不改任何已有签名。
7. **汇总入口（B）**：`node scripts/deviation-report.js [--days 30] [--user u1] [--json]` 只读，输出判定分布 / 盲区总量 / 每轴一行摘要（复用 `summarizeDeviation`）。窗口内没样本时给「继续跑」，不输出空表。
8. **进语气（D，仅 live）**：`DEVIATION_LIFECYCLE=live` 时，`buildSystemPrompt` 增加 `['偏移', deviationSection]`（紧跟 `['界线']` 之后）。只带 `verdict === 'stable_deviation'` 的轴，最多 `DEVIATION_INJECT_LIMIT`（2）条，只给「轴 + 她自己的落点」，不带次数 / 比值 / 情境等账本数字。热路径用 `_deviationCache`（30 分钟）不读盘，过期才现场算一次并写回。

### 开关（`DEVIATION_LIFECYCLE`，三档）

| 值 | 行为 |
|---|---|
| `off` | 完全旧行为：不记样本、不分析、不写文件，提示词逐字节不变 |
| `shadow`（缺省） | 记样本 + 判据 + 落痕 + 报告可读；**提示词逐字节不变** |
| `live` | 在 shadow 之上，把判据成立的轴带进语气 |

默认停在 `shadow`：先攒几天样本，确认 `stable_deviation` 与 `fixed_habit` 两档分得开、且不把偶发当偏移，再由人手动切 `live`。

进入语气的那段文案带齐三条规矩，缺一条就会退化成「先给自己留台阶」：**预告不算免责** / **说过之后照样按尺子来** / **说完还是照做就照常算**（真按住了也不声明、不邀功）。

### 参数（`src/core/deviation.js` 的 `DEVIATION_DEFAULTS`）

| 常量 | 值 | 含义 |
|---|---|---|
| `minOccurrences` | 3 | 同一轴至少滑回几次才够谈「稳定」 |
| `minScenarios` | 2 | 至少几个不同情境桶 |
| `driftedSimilarity` | 0.8 | 相邻两次落点字面重合度低于此 = 挪了位置 |
| `predictability` | 0.7 | 滑回后下一次仍滑回的比例下限 |
| `windowMs` | 30d | 只看最近这段：偏移是「现在还在发生」的 |

`output.js` 另有 `DEVIATION_ANALYZE_COOLDOWN_MS`（10 分钟）/ `DEVIATION_READ_LIMIT`（500）/ `DEVIATION_CACHE_MS`（30 分钟）/ `DEVIATION_INJECT_LIMIT`（2）。

### 测试

`test/deviation.test.js`（V1–V29）：阈值与判定枚举 / 样本归一（去装饰、方向不明即丢）/ 三种形状各判一次（`stable_deviation`、`fixed_habit`、`narrow`）/ 猜不中下次 → `unstable` / 次数不足与坏输入 / 窗口淘汰 / 排序与摘要 / 落盘读回（只认 `sample`、用户与时间过滤、半截行跳过、坏目录静默）/ 接线（滑回记样本、守住不读盘、成立才落 verdict、`off` 不写文件、待结账与过期注入不记样本）/ 开关归一 / 盲区核对只观测不动账（V19）/ blind 分账（V20）/ `getActiveBoundaries`（V21）/ 报告与 `kind` 过滤（V22–V24）/ 渠道前缀与跨场景（V25）/ live 注入成立（V26）/ shadow 与 off 逐字节不变（V27）/ 30 分钟缓存不重复读盘（V28）/ 无判据即空串且最多两条（V29）。

---

## 8. 时间线事件总线（路线 C：单点收口）

设计：`docs/superpowers/specs/2026-11-06-timeline-event-bus-design.md`。本节只写接线：谁在什么时候往哪写一条什么。

### 8.1 模块职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `src/core/timeline.js` | `TimelineStore`：`append` / `readDay` / `listDays` / `subscribe`；按天分片、只追加、坏行跳过 | 不导入任何业务模块、不解读 payload、不做 scope 规范化 |
| `src/core/artifactDelivery.js` | 物件收集与投递策略（纯函数） | 不碰网络、不碰磁盘 |
| `src/core/timelineView.js` | 「她的一天」投影（纯函数，幂等） | 不读盘、不做业务判断 |
| `src/core/proactiveScheduler.js` | 事件驱动调度的影子模式（只记候选） | 不投递、不改现有 tick |
| `src/server/routes/timeline.js` | `GET /api/timeline/day` / `GET /api/timeline/days` | scope 只从登录会话解析 |

**契约差异（与 spec 的一处）**：`append` 永不抛错——写入失败/非法入参只 `console.warn` + `failures++` 并返回 `false`，调用方不需要每个点包 try/catch。这与 spec §9「失败不阻断调用方」一致；spec §2 写的「失败抛错」按此实现为准。

### 8.2 存储

```
data/timeline/<YYYY-MM-DD>/<scopeKey>.jsonl
```

每行 `{ v:1, seq, at, type, payload }`。`seq` 是当天该 scope 的行号：进程内按 `day|scope` 缓存，首次遇到文件时数一遍已有非空行续上（重启不重号）。只追加、不 fsync；单行损坏只跳过该行并 `badLines++`。

`scopeKey` 与记忆档同一套键（`user_<id>__role` / `qq_<QQ号>_<角色名>__role`），由调用方用 `memoryModule.normalizeScopeKey` 得到；`TimelineStore` 只做路径安全拒绝（含 `/` `\` 或为 `.`/`..` 的键直接丢弃）。

### 8.3 写入点（六刀）

| 事件 | 写入位置 | payload | 备注 |
|---|---|---|---|
| `memory.created` | `memory.storeMemory` 的 `markDirty(key)` 之后 | `{ mid, text, scene }` | 只有真的入库才写；`text`/`scene` 截 500/200 字 |
| `message.in` / `message.out` | 网页：`output.recordTimelineMessages`（仅 `timelineChannel === 'interaction'`）；QQ：`bridge.noteQQMessage` | `{ channel, userId, text, scene? }` | 网页 `channel='web'`；QQ 私聊/群聊 `channel='qq'` 且带 `scene='private'|'group'` |
| `speech.proactive` | `narrator.speak` 里 `onSpeech(...)` 之后 | `{ text, trigger, channel }` | 网页 narrator 注入 `timeline`；QQ narrator 注入 `timelineChannel:'qq'` |
| `appointment.scheduled` | `appointmentBook.addAppointment` 的 `save()` 之后 | `{ id, at, text }` | 去重返回 false 时不写 |
| `life.event` | `privateLife.generateFor` 的 `save()` 之后 | `{ postId, day, text }` | `userId` 只在写日志时用，不参与生成 |
| `artifact.created` | `narrator.speak` 的主题饱和分支（被闸门拦下的话头） | `{ artifactId, kind:'draft', text, trigger:'theme-blocked' }` | 原本直接丢弃，现在留在时间线里 |
| `delivery.sent` | `bridge.deliverPendingArtifacts` 私聊发送成功后 | `{ artifactId, channel:'qq', kind, at }` | 幂等只认这条记录；发送失败不写 |

QQ 群聊的 `message.in` 只记管理员（`isAdmin && saidText`），普通成员闲聊不入库；`message.out` 记角色自己的群回复。网页的 `message.in/out` 只在 `interaction` 运行时记，`role`/`sandbox`/`qq`/`bili` 一律不在这里记，避免重复。

### 8.4 投递策略（`artifactDelivery`）

| 约束 | 值 | 实现 |
|---|---|---|
| 投递对象 | 仅管理员私聊 | `bridge.deliverPendingArtifacts` 遍历 `QQ_ADMIN_IDS` |
| 夜间静默 | 23:00–07:00 | `isNightSilent` |
| 每日上限 | `QQ_ARTIFACT_DAILY_MAX`，默认 4 | `resolveOptions` |
| 同类冷却 | 30 分钟 | `selectDeliverable` 里的 `kindCooldownMs` |
| 无回应降频 | 连续 2 件无回应 → 上限减半 | `countUnanswered` + `dailyMaxFor` |
| 旧话过期 | 24 小时 | `maxAgeMs` |
| 幂等 | 同一 `artifactId` 不再发 | 读当天 `delivery.sent` 去重 |

物件来源不新增生成调用：`life.event`（同一天取最新一条）→ `note`；已到点的 `appointment.scheduled` → `note`；`artifact.created` 里的 `draft` → 照发；`payload.shadow === true` 的候选永远不投。

### 8.5 读模型

- `GET /api/timeline/day?date=YYYY-MM-DD`：scope = `memoryModule.normalizeScopeKey(req.user.userId, 'role')`，**请求里的 `userId` / `scope` 一概不看**（挡 `__role`/`__ai` 后缀穿透）。
- `GET /api/timeline/days`：该 scope 有记录的日期（新→旧，最多 30 天）。
- 响应：`{ success, date, sections: [{ name: 凌晨|上午|下午|晚上, items: [{time,type,channel,text}] }], pending: [{artifactId,kind,at,time,text}] }`。
- `pending` 即「她攒着的话」：当天 `artifact.created`（含 draft）里没有匹配 `delivery.sent` 的那些。

### 8.6 影子模式（第六刀）

`proactiveScheduler.attachShadowScheduler(timeline)` 在 `server/index.js` 启动时挂上；设 `TIMELINE_SHADOW=off` 可整段关掉（回退第六刀不影响前五刀）。

- 只对 `life.event` / `appointment.scheduled` 这两个自带文本的产物记候选（`message.in` / `memory.created` 只当触发信号，不凭空造句）。
- 同一 scope 10 分钟内只记一条；候选写成 `artifact.created` 且 `payload.shadow === true`，投递策略明确忽略。
- 现有 20~30 分钟 tick 完全不变，影子与线上并行对照。

### 8.7 测试

| 文件 | 覆盖 |
|---|---|
| `test/timeline.test.js` | T1–T10：往返、seq 连续/续号、跨天、坏行、types 过滤、非法 scope、空读、订阅 |
| `test/artifactDelivery.test.js` | P1–P9：夜间静默、上限与减半、同类冷却、过期与幂等、物件收集、无回应计数、环境变量、影子候选不被投 |
| `test/timelineView.test.js` | V1–V5：分段、QQ/网页区分、攒着的话、投影幂等、坏输入 |
| `test/timelineWiring.test.js` | I1–I3：`storeMemory` 成功写 `memory.created`；内容被过滤时不写；约定去重只写一条 `appointment.scheduled` |

### 8.8 已知边界

- 单进程串行 append，无跨进程锁；多实例前必须补追加锁（spec §9 已列为前置条件）。
- `seq` 依赖单进程缓存 + 首次行数统计；同一文件被两个进程同时写会重号（同上）。
- 前端「她的一天」独立页面尚未做，接口已就绪，等有真实数据后再定入口形态。
- 网页身份与 QQ 身份不归并：两套键各自独立，时间线只共用机制、不共用档。

## 9. 学习任务接线（在线 / 离线自进化）

设计：`docs/superpowers/specs/2026-11-06-self-evolution-learning-design.md`。本节只写接线。

### 9.1 模块职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `src/core/resourceGuard.js` | 磁盘四桶账本（datasets / assets / weights / workspace）+ CPU 滑动窗口分级 | 不执行任务、不删业务数据 |
| `src/core/learningStore.js` | `data/learn/assets/<id>/` 产物留存、manifest 校验、TTL + LRU | 不接受无 manifest 的目录 |
| `src/core/learningTask.js` | 来源白名单校验、任务落盘、沙箱执行、产物沉淀 | 不训练大模型、不自动注册工具 |
| `src/server/routes/learning.js` | 状态 / 任务 / 执行 / 产物删除接口 | 读需登录，写与执行只许本机 |

### 9.2 存储与配额

```
data/learn/
  datasets/<taskId>/   临时数据，任务结束即删
  assets/<id>/         留存产物 + manifest.json
  weights/             模型权重
  workspace/<taskId>/  任务脚本与工作目录
  tasks/<taskId>.json  任务记录
  index.json           产物索引（TTL / LRU 依据）
```

四桶默认合计 6GB：datasets 2GB、assets 1.5GB、weights 1.5GB、workspace 1GB。单桶或全局预估占用 > 80% 告警、> 95% 拒绝新任务；解压后按实际目录大小复查。

### 9.3 资源与时间闸

| 约束 | 值 | 实现 |
|---|---|---|
| CPU 采样 | 15 秒 | `LearningTaskCenter.startMonitor` + 运行期看门狗 |
| 降载 | 20 分钟均值 > 60% | `ResourceGuard.cpuState` → `degraded` |
| 强制暂停 | 90 分钟均值 > 60%（至少观察 60 分钟） | `paused` + 冷却 30 分钟 |
| 单任务上限 | 45 分钟 | `job_runtime` 直接终止 |
| 夜间 | 23:00–07:00 只允许轻量任务 | `isQuietHour` |

### 9.4 工具与事件

| 工具 | 是否审批 | 行为 |
|---|---|---|
| `learn_request` | 免审批 | 校验来源 / 配额并创建计划，不执行 |
| `learn_run` | 需人工确认一次 | 过资源闸后在沙箱内跑 Python 3.10.11 |

时间线事件（scope = `learning`）：`learning.task`（planned / running / done / failed / blocked）、`learning.artifact`（产物 id、体积、标题）。

### 9.5 测试

| 文件 | 覆盖 |
|---|---|
| `test/resourceGuard.test.js` | G1–G6：目录计量、80/95 分级、CPU 窗口与冷却、夜间与任务超时、admit 组合 |
| `test/learningStore.test.js` | S1–S6：manifest / sha256、非法入参、幽灵条目、TTL、LRU、删除 |
| `test/learningTask.test.js` | L1–L8：来源白名单、参数校验、配额拒绝、创建、执行留存、暂停、失败、缺脚本 |


