#!/usr/bin/env bash
# 一键配置 Linux 沙箱：建低权限用户 + 授权数据目录 + 配 sudoers。
# 用法：sudo bash scripts/linux/sandbox-setup.sh
# 幂等：重复执行不会破坏已有配置。

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "[错误] 需要 root，请用：sudo bash scripts/linux/sandbox-setup.sh" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX_USER="${SANDBOX_USER:-pog_sandbox}"
SANDBOX_GROUP="${SANDBOX_GROUP:-$SANDBOX_USER}"
SERVER_USER="${SUDO_USER:-root}"
DATA_DIR="$ROOT/data"
TMP_DIR="$DATA_DIR/sandbox-tmp"
SUDOERS_FILE="/etc/sudoers.d/pog-sandbox"

echo "=== thepeopleofgod 沙箱配置（Linux）==="
echo "项目目录: $ROOT"
echo "沙箱用户: $SANDBOX_USER"
echo "服务用户: $SERVER_USER"
echo

echo "[1/5] 检查依赖..."
for bin in bash setsid stat awk sudo; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[错误] 缺少 $bin，请先安装（Debian/Ubuntu: apt install util-linux sudo）" >&2
    exit 1
  fi
done
echo "OK"

echo "[2/5] 创建沙箱用户与组（已存在则跳过）..."
if ! getent group "$SANDBOX_GROUP" >/dev/null 2>&1; then
  groupadd -r "$SANDBOX_GROUP"
  echo "已创建组 $SANDBOX_GROUP"
fi
if ! id -u "$SANDBOX_USER" >/dev/null 2>&1; then
  useradd -r -g "$SANDBOX_GROUP" -s /usr/sbin/nologin -d /nonexistent -M "$SANDBOX_USER"
  echo "已创建用户 $SANDBOX_USER（无登录 shell）"
else
  echo "用户 $SANDBOX_USER 已存在"
fi

echo "[3/5] 准备数据目录与权限..."
mkdir -p "$TMP_DIR"
# 数据目录组归沙箱：服务用户是 owner 仍有全权，沙箱作为组成员可读写
chgrp -R "$SANDBOX_GROUP" "$DATA_DIR" 2>/dev/null || true
chmod -R g+rwX "$DATA_DIR" 2>/dev/null || true
find "$DATA_DIR" -type d -exec chmod g+s {} + 2>/dev/null || true
echo "OK"

echo "[4/5] 写入 sudoers（只允许切到 $SANDBOX_USER，不需要密码）..."
if [ "$SERVER_USER" = "root" ]; then
  echo "服务以 root 运行时不需要 sudoers（监督脚本会用 setpriv 切用户），跳过"
else
  tmp_file="$(mktemp)"
  # SETENV：允许 sudo -E 传入最小环境（PATH / 模型配置）；范围仍只限切到沙箱用户
  printf '%s ALL=(%s) NOPASSWD: SETENV: ALL\n' "$SERVER_USER" "$SANDBOX_USER" > "$tmp_file"
  visudo -cf "$tmp_file" >/dev/null
  install -m 0440 -o root -g root "$tmp_file" "$SUDOERS_FILE"
  rm -f "$tmp_file"
  echo "已写入 $SUDOERS_FILE"
fi

echo "[5/5] 自检..."
if command -v runuser >/dev/null 2>&1; then
  if runuser -u "$SANDBOX_USER" -- /bin/sh -c 'test -w "$1"' _ "$TMP_DIR"; then
    echo "OK: 沙箱用户可写 $TMP_DIR"
  else
    echo "[警告] 沙箱用户暂时写不了 $TMP_DIR，请检查上面 chgrp/chmod 是否报错"
  fi
else
  echo "跳过写权限自检（没有 runuser）"
fi

cat <<EOF

=== 完成 ===
启动服务: bash scripts/linux/start.sh
验证沙箱: 在页面的代码执行里跑一条命令，或直接看服务日志
关闭沙箱: 环境变量 SANDBOX_ENABLED=false
放行宿主执行（危险，不推荐）: SANDBOX_ALLOW_HOST=true
EOF
