const fs = require('fs');
const path = require('path');

// 原子写文件：先把内容写到同目录下的临时文件，再 rename 覆盖目标文件。
// 崩溃/断电时目标文件要么保持旧内容、要么变成新内容，绝不会留下写坏的半截 JSON。
// （rename 在同一分区内是原子操作；Windows 下 fs.renameSync 会替换已存在的目标文件）
function writeFileAtomicSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    // rename 失败时清掉临时文件，避免在目录里留垃圾
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 清理失败无所谓，忽略
    }
    throw error;
  }
}

// 原子写 JSON：space 与 JSON.stringify 第三参一致（默认 2 空格缩进）
function writeJsonAtomicSync(filePath, data, space = 2) {
  writeFileAtomicSync(filePath, JSON.stringify(data, null, space));
}

module.exports = {
  writeFileAtomicSync,
  writeJsonAtomicSync
};
