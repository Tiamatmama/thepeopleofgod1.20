// 关键持久化结构的版本号与兼容守卫（方向二·持久化健壮性）。
// 落盘时盖上当前结构版本号；加载时按版本兜底/告警。目的：
//   1) 格式演进后能识别旧档并迁移（有了统一的版本锚点）；
//   2) 遇到「比当前构建更新」的档（降级场景）能告警而非静默读错字段——便于回滚。
// 全是同步纯函数，不碰 IO，可离线单测。

// 各结构的当前版本。**改动结构时递增这里，并在对应 store 的加载路径补一次迁移**。
const CURRENT_VERSIONS = Object.freeze({
  userMemory: 1,  // data/user_memories/{key}.json
  selfModel: 1    // data/self_model/{key}.json
});

// 历史文件都没有版本号，一律按最早格式 v1 处理
const LEGACY_VERSION = 1;

// 读结构版本号：缺失/非法（NaN、<1）都回落到 fallback（默认 v1）
function readVersion(data, fallback = LEGACY_VERSION) {
  const v = Number(data && data.schemaVersion);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

// 该档是否来自「比当前构建更新的版本」——加载时据此告警，避免静默读错字段
function isFutureVersion(data, current) {
  return readVersion(data) > current;
}

// 给待落盘的 data 盖上版本号：不修改入参，返回带 schemaVersion 的新对象
function stampVersion(data, version) {
  return { ...data, schemaVersion: version };
}

module.exports = {
  CURRENT_VERSIONS,
  LEGACY_VERSION,
  readVersion,
  isFutureVersion,
  stampVersion
};
