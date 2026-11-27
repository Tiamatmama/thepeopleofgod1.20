'use strict';

// 工作区复制：竞技场与 16-Agent 集群共用同一份跳过列表与原子替换逻辑。
// 只复制可重建的项目文件；node_modules / data / .trae 等本地产物一律不进副本，避免拖慢与放大磁盘。

const fs = require('fs');
const path = require('path');

const COPY_SKIP = new Set(['node_modules', 'data', '.trae', '.venv', '__pycache__', '.cache', 'dist', 'build']);

function copyTaskWorkspace(coding, userId, fromTaskId, toTaskId) {
  const from = coding.taskDir(userId, fromTaskId);
  const to = coding.taskDir(userId, toTaskId);
  if (!from || !to) return { success: false, error: '工作区路径非法' };
  if (!fs.existsSync(from)) return { success: false, error: `基座工作区不存在：${fromTaskId}` };
  const tmp = `${to}.tmp`;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(from, tmp, {
      recursive: true,
      filter: (src) => !COPY_SKIP.has(path.basename(src))
    });
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(tmp, to);
    return { success: true, dir: to };
  } catch (error) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响报错 */ }
    return { success: false, error: error.message };
  }
}

module.exports = { COPY_SKIP, copyTaskWorkspace };
