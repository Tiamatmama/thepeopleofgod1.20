# src/core/danmaku 索引

B 站弹幕源适配：统一接口 + 官方 / 非官方 / mock 三种实现。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `base.js` | 113 | 弹幕源基类：统一连接、收消息、断开接口 | DanmakuSource / KINDS / cleanText | — |
| `index.js` | 54 | 弹幕源工厂：按配置选官方 / 非官方 / mock | createSource / describeSource / DanmakuSource / MockSource | — |
| `mock.js` | 67 | 本地 mock 弹幕源（开发调试） | MockSource | — |
| `official.js` | 282 | B 站官方弹幕源（开放平台） | OfficialSource / describeError | — |
| `unofficial.js` | 377 | B 站非官方弹幕源（网页协议） | UnofficialSource / encodePacket / decodePackets | — |

## 约定

- 新增弹幕源：继承 `base.js` 的接口，在 `index.js` 里选择实现。
- mock 实现用于本地开发，不依赖网络。
