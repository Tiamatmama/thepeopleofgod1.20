# src/storage 索引

本地 JSON 持久化的公共设施：原子写、跨进程写锁、坏文件隔离、结构版本号。所有落盘模块都应复用这里。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `atomicWrite.js` | 33 | 原子写文件（临时文件 + rename） | writeFileAtomicSync / writeJsonAtomicSync | atomicWrite |
| `storeGuard.js` | 75 | 启动自检：清临时文件 + 隔离坏 JSON | isTempFile / cleanTempFiles / validateJsonFile / quarantineCorruptFiles | storeGuard |
| `storeSchema.js` | 39 | 持久化结构版本号与兼容守卫 | CURRENT_VERSIONS / LEGACY_VERSION / readVersion / isFutureVersion | storeSchema |
| `writeLock.js` | 162 | 跨进程写保护（文件锁 / 服务锁） | isProcessAlive / isLockStale / serverLockPath / writeServerLock | writeLock |

## 约定

- 写 JSON 一律走 `writeJsonAtomicSync`，禁止直接 `fs.writeFileSync` 覆盖业务文件。
- 需要「读-改-写」时用 `withFileLock`，避免 server 与脚本同时覆盖同一个文件。
- 新增持久化结构时在 `storeSchema.CURRENT_VERSIONS` 登记版本号。
