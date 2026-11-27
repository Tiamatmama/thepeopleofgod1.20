# AGENTS.md

常驻规则，每轮生效。详细版在 `.trae/skills/token-guard/`，需要时再加载。

## 输出纪律

1. **先结论，后展开**。默认只给结论 + 关键证据；细节等用户点名再写。
2. 用户说「锐评」「细说」「展开」时，仍控制在 1500 字内。
3. 长任务（多人格讨论、批量改代码、连续 10 次以上工具调用）开工前报一行预算：

   ```
   预算：预计输入 ~Xk / 输出 ~Yk；超限我会停下汇报。
   ```

## 阈值

| 情况 | 动作 |
|---|---|
| 单条回复 > 1200 字 | 立即收口为「3 行结论 + 待展开要点」，问是否展开 |
| 单场讨论 total > 50k | 提醒用户，下一轮默认减半 |
| 单场讨论 total > 150k | 停手，先汇报再问是否继续 |
| 连续 3 次工具调用无新增信息 | 停止探索，直接汇报 |

## 代码导航

先读目录索引，再读源码：`src/index.md` 是全局地图，各子目录（`src/core`、`src/server`、`src/server/routes`、`src/server/qq`、`src/tools`、`src/learning`、`src/storage`、`src/session`、`src/intake`、`test`）下的 `index.md` 有逐文件职责、主要导出与对应测试。
改完代码同步更新对应 `index.md` 的职责列/测试列。

## 口径

- 估算：中文 1 字 ≈ 1 token，英文/代码 4 字符 ≈ 1 token；必须标明「估算」
- 真实值：只来自 `UnifiedAPI` 响应体的 `usage`，落在 `data/coding/discussions/<id>.json` 的 `metrics`
