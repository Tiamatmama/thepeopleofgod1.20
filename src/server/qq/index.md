# src/server/qq 索引

QQ（OneBot v11 / NapCat）接入：事件上报入口、群聊 @ 回复、自主发言与读取类接口。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `bridge.js` | 1684 | QQ 群聊桥：@ 回复 + 自主发言 + 事件入口；被 @ 的回复不再回 @ 人，只有关键词/意愿/持续窗口主动接话时才 @ 发送者；记忆按 speaker 归属（引用她自己的话/主动发言不再写成用户发言） | registerQqBridge | — |
| `onebotRoutes.js` | 152 | OneBot 只读接口（发送只在 bridge 内部） | registerOnebotRoutes | — |

## 约定

- 发送能力只由 `bridge.js` 内部调用；`onebotRoutes.js` 只暴露读取接口。
- 群聊白名单与发言模式在 `core/qqChatRules.js`，落 `data/qq_chat_rules.json`。
- 每个 QQ 会话独立落在 `data/qq_sessions/`，不复用网页端会话。
