# 在线 / 离线自进化（学习任务）设计

日期：2026-11-06
状态：已定稿（用户豁免设计评审，直接实现）

## 1. 目标

让角色能把「取数 → 分析 → 必要时训练 → 沉淀产物」表达为一次受管学习任务：

- 在线：从白名单公开数据源拉取已清洗数据。
- 离线：在沙箱里用 Python 3.10.11 + torch 做分析与小规模训练。
- 产物：带 manifest 落到 `data/learn/`，可被后续任务复用。

## 2. 硬约束

- 磁盘总量 6GB，按桶分配，超限拒绝新任务。
- CPU 不允许连续 5 小时高占用；高负载降载 + 强制冷却。
- 解释器固定 Python 3.10.11，不依赖 PATH。
- 不训练大模型、不自动改 `toolRegistry`、不做多实例。

## 3. 模块

### 3.1 `src/core/resourceGuard.js`

磁盘配额账本 + CPU 采样分级闸。

磁盘四桶（默认合计 6GB）：

| 桶 | 上限 | 用途 |
|---|---|---|
| datasets | 2GB | 下载/解压临时数据，任务结束即删 |
| assets | 1.5GB | 留存产物（TTL + LRU） |
| weights | 1.5GB | 模型权重 |
| workspace | 1GB | 任务脚本与工作目录 |

规则：

- 单桶或全局预估占用 > 80%：告警（`warn`），任务仍可跑。
- 单桶或全局预估占用 > 95%：拒绝新任务（`refuse`）。
- 解压前后都按实际目录大小计量。

CPU 规则（15 秒采样，样本保留 90 分钟）：

- 最近 20 分钟均值 > 60%：降载（`degraded`，只允许轻量任务）。
- 最近 90 分钟均值 > 60%：强制暂停 30 分钟（`paused`）。
- 单任务 wall-clock > 45 分钟：终止。
- 23:00–07:00 只允许轻量任务。

### 3.2 `src/core/learningStore.js`

产物留存层，根目录 `data/learn/`。

- 目录：`assets/<id>/`，内含 `manifest.json` 与产物文件。
- manifest 必填：来源 URL、license、脚本、每个文件的 sha256 与体积、创建时间。
- 无 manifest 的目录不认为有效产物（读取时直接忽略）。
- `index.json` 维护条目；`prune()` 按 TTL（默认 30 天）与 LRU 淘汰到 1.5GB 以内。

### 3.3 `src/core/learningTask.js`

需求 → 计划 → 校验 → 执行 → 沉淀。

来源白名单（仅 https）：

- `huggingface.co/datasets/`
- `www.kaggle.com/datasets/`
- `archive.ics.uci.edu/`
- `raw.githubusercontent.com/`

校验项：

- goal 非空、≤500 字。
- sources 1–10 条，全部命中白名单。
- estimatedBytes > 0 且不超过 datasets 桶。
- 留存时必须给 license，否则只返回结果、不落盘。

执行：

- 脚本写入 `data/learn/workspace/<taskId>/task.py`。
- 走 `SandboxExec.startStreamed`，显式 Python 3.10.11 路径。
- 执行前后调用 `ResourceGuard.admit`；运行期 15 秒采样，命中 `paused` 立即停止。
- 任务结束删除 datasets 临时目录。

### 3.4 API 与工具

`src/server/routes/learning.js`：

- `GET /api/learning/status`：配额、CPU 分级、产物列表。
- `GET /api/learning/tasks`：任务列表。
- `POST /api/learning/tasks`：创建计划。
- `POST /api/learning/tasks/:id/run`：执行。
- `DELETE /api/learning/assets/:id`：删除产物。

`toolRegistry` 新增：

- `learn_request`：创建计划，不执行、免审批。
- `learn_run`：执行任务，需人工确认（加入 `APPROVAL_REQUIRED_TOOLS`）。

时间线事件：`learning.task`（状态变化）、`learning.artifact`（产物留存）。

## 4. 非目标

- 不训练大模型、不做分布式训练。
- 不自动注册新工具，不自动修改系统代码。
- 不合并网页 / QQ 身份。
- 不引入新的学习服务进程。

## 5. 测试

- `test/resourceGuard.test.js`：配额分级、CPU 窗口、夜间限制、任务超时。
- `test/learningStore.test.js`：manifest 校验、TTL/LRU、路径穿越拒绝。
- `test/learningTask.test.js`：来源白名单、配额拒绝、执行与沉淀、失败清理。

全部测试进现有 `node --test --test-concurrency=1 "test/**/*.test.js"`。
