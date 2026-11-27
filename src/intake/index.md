# src/intake 索引

开源方案准入通道：隔离子进程拉取外部方案，做三段体检（隐形字符 / 提示注入 / 供应链元数据），只产出结论不直接接入。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `channel.js` | 94 | 准入通道门面：拉起隔离子进程做三段体检 | vetSource / callWorker | intake |
| `rules.js` | 207 | 准入判定规则（纯函数：隐形字符 / 注入 / 供应链） | assess / scanInvisible / scanInjection / scanSupplyChain | intake |
| `worker.js` | 261 | 准入隔离工作进程（stdin/stdout 一行 JSON） | — | — |

## 约定

- `worker.js` 只通过 stdin/stdout 各收发一行 JSON，日志一律走 stderr。
- 判定规则 `rules.js` 必须是纯函数：不联网、不调模型，才能在主进程复算。
