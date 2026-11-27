const fs = require('fs');
const path = require('path');

// 本地 JSON 存储的启动自检（DB-5）：清残留临时文件 + 隔离坏文件。
// 全是同步纯函数，只在启动时跑一次（数据量小），不参与运行时热路径。

// 原子写残留的临时文件：形如 `.xxx.json.12345.1700000000000.tmp`
// （atomicWrite 先写临时文件再 rename，崩溃/断电时可能把它留在目录里）
function isTempFile(fileName) {
  return typeof fileName === 'string' && fileName.endsWith('.tmp');
}

// 清理目录里残留的 .tmp 文件（只删 .tmp，绝不碰正式数据）。
// 返回被清掉的文件名数组，便于日志核对
function cleanTempFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!isTempFile(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // 单个删不掉（被占用等）不阻断启动，跳过
    }
  }
  return removed;
}

// 校验单个 JSON 文件能否解析。返回 { ok, error }
function validateJsonFile(filePath) {
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 启动时校验目录下所有 .json：能解析的放过；解析不了的改名隔离成
// `<name>.json.corrupt-<stamp>`（不删，留证据；后缀不以 .json 结尾，
// 后续加载不会再把坏文件扫进来），避免一条坏文件拖垮整个加载流程。
// 返回 { scanned, quarantined: [{ file, to, error }] }
function quarantineCorruptFiles(dir, options = {}) {
  const stamp = options.stamp != null ? options.stamp : Date.now();
  if (!fs.existsSync(dir)) return { scanned: 0, quarantined: [] };

  let scanned = 0;
  const quarantined = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json') || file.includes('.bak')) continue;
    const filePath = path.join(dir, file);
    scanned++;
    const result = validateJsonFile(filePath);
    if (result.ok) continue;

    const to = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(filePath, path.join(dir, to));
      quarantined.push({ file, to, error: result.error });
    } catch (renameError) {
      // 隔离都失败（极少见）就如实记下，交给上层日志
      quarantined.push({ file, to: null, error: `${result.error}（隔离失败：${renameError.message}）` });
    }
  }
  return { scanned, quarantined };
}

module.exports = {
  isTempFile,
  cleanTempFiles,
  validateJsonFile,
  quarantineCorruptFiles
};
