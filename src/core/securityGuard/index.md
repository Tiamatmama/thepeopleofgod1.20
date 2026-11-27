# src/core/securityGuard 索引

安全护栏：危险命令分级 + 父本账本。只覆盖经过本系统工具层的动作，管不到系统其它程序与内核层劫持。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `index.js` | 19 | 单例装配：命令闸门 + 父本账本 + 规则清单 | guardCommand / normalizeCommand / ledger / ProvenanceLedger / rules | securityGuard |
| `commandGuard.js` | 161 | 命令分级（纯函数）：不可逆/硬件级 BLOCK，破坏性但可恢复 CONFIRM，其余 ok；支持 `// security-scan-ignore` 无关的规则元信息输出 | check / normalize / BLOCK_RULES / CONFIRM_RULES | securityGuard |
| `provenance.js` | 118 | 父本账本（append-only JSONL）：write / exec / install / import / delete 事件，带 sha256、来源、触发者；超 4MB 轮转保留最近 3000 行；路径溯源支持文件与目录前缀双向匹配 | ProvenanceLedger / fileSha256 / DEFAULT_FILE | securityGuard |

## 约定

- 规则只做「拦截 / 标记」，不做修复；账本只写不改，接口层不提供放行与删记录入口。
- `commandGuard.js` 保持纯函数（不碰 fs、不碰网络），新增规则只加数据，不加 IO。
- 账本落 `data/security/provenance.jsonl`；调用方若需隔离（测试），向 `CodeExecTools` 注入 `options.securityGuard`。
