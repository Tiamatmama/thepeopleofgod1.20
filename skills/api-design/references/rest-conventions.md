# REST 约定速查

## 命名
- 资源用**名词复数**：`/users`、`/tasks`、`/discussions`。
- 层级用路径表达从属：`/tasks/:id/comments`。
- 动作用 HTTP 方法承接：GET 读、POST 建、PUT 改、PATCH 局部改、DELETE 删。
- 避免动词化路径：不要 `/getUser`、`/deleteTask`。

## 状态码
| 码 | 语义 |
|----|------|
| 200 | 成功返回 |
| 201 | 创建成功（返回新资源） |
| 400 | 参数错误 |
| 401 | 未认证 |
| 403 | 已认证但无权限 |
| 404 | 资源不存在 |
| 409 | 冲突（重复创建/版本冲突） |
| 500 | 服务端错误 |

## 响应结构（保持一致）
成功：`{ "success": true, "data": ... }`
失败：`{ "success": false, "error": "可读的错误信息" }`
列表：`{ "success": true, "items": [...], "nextCursor": "..." }`

## 列表参数
- 分页：`limit` + `cursor`（优于 `offset`，更抗插入）。
- 过滤：显式命名，如 `status=todo`。
- 排序：`sort=-createdAt`（`-` 表倒序）。

## 安全
- 每个写操作校验身份与**资源归属**，防止用别人的 id 操作别人的资源。
- 错误信息不泄露内部路径、堆栈、密钥。
