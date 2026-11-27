# 共识收敛 JSON 契约（C 档）

圆桌结束后，主持人必须输出一段人话摘要 + 一个合法 JSON。**JSON 不合法不可落地。**

## 必填结构

```json
{
  "ideaId": "i_20261123_xxx",
  "topic": "一句话点子原文",
  "consensus": 72,
  "decisions": [
    { "id": "d1", "text": "先做本地优先，不依赖云端", "agree": 4, "object": 0, "abstain": 1,
      "lens": "规矩破坏者", "constraintDropped": "暂时忽略了服务器成本" }
  ],
  "disagreements": [
    { "id": "g1", "point": "是否先支持群聊", "sides": ["A：先私聊跑通", "B：私聊群聊一起做"], "core": "范围与验证成本的取舍" }
  ],
  "risks": [
    { "id": "r1", "text": "协议格式无出处，可能返工", "level": "high", "mitigation": "先做可替换的编解码层" }
  ],
  "openQuestions": ["真实抓包从哪里拿"],
  "specSeed": {
    "goal": "目标一句话",
    "capabilities": ["能力1", "能力2"],
    "nonGoals": ["明确不做1"],
    "milestones": ["M1 可运行", "M2 有测试"],
    "acceptance": ["可验证判据1", "判据2"]
  },
  "transcriptRef": "data/roundtables/<id>.json"
}
```

## 字段约束

| 字段 | 类型 | 规则 |
|---|---|---|
| `ideaId` | string | `i_` 前缀，仅字母数字下划线连字符 |
| `consensus` | number | 0–100 整数；按决策加权赞成率计算，保留计算口径 |
| `decisions` | array | 至少 1 条；`agree+object+abstain` 必须等于实际参与人数 |
| `disagreements` | array | 允许为空；每条必须有 `core`（分歧本质），不能只抄发言 |
| `risks` | array | `level` ∈ `low/medium/high`；每条必须有 `mitigation` |
| `openQuestions` | string[] | 允许为空；每条必须是可回答的问题 |
| `specSeed` | object | 五个字段都必填，`acceptance` 至少 1 条且可执行验证 |
| `transcriptRef` | string | 指向已保存的圆桌记录，缺失则不可落地 |

## 校验规则（D 档执行前）

1. `decisions.length ≥ 1` 且 `specSeed.acceptance.length ≥ 1`。
2. `consensus` 为 0–100 整数，且与 `decisions` 的赞成率口径一致（允许 ±5 误差）。
3. 所有 `id` 唯一。
4. `specSeed.nonGoals` 非空——没有非目标的 SPEC 视为无效。
5. 任何一条不满足：重试收敛一次；仍失败则只输出纯文本纪要，并明确“本轮不可落地”。

## 到 SPEC 的映射

- `specSeed.goal → SPEC.目标`
- `specSeed.capabilities → SPEC.能力`
- `specSeed.nonGoals → SPEC.非目标`
- `specSeed.milestones → SPEC.里程碑`
- `specSeed.acceptance → SPEC.验收`
- `risks → SPEC.风险`
- `openQuestions → SPEC.待确认`
