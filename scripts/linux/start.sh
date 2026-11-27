#!/usr/bin/env bash
# 一键启动（Linux）：检查 node / 依赖 → 交给 scripts/launch.js 起服务并打开浏览器
# 用法：bash scripts/linux/start.sh [--http|--https|--both]

set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MODE="both"
for arg in "$@"; do
  case "$arg" in
    --http) MODE="http" ;;
    --https) MODE="https" ;;
    --both) MODE="both" ;;
    -h|--help)
      echo "用法: bash scripts/linux/start.sh [--http|--https|--both]"
      exit 0
      ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

echo "===================================="
echo "  thepeopleofgod1.20 - 一键启动"
echo "===================================="

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$ROOT/runtime/node" ]; then
  NODE_BIN="$ROOT/runtime/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "[错误] 没找到 Node.js，也没有 runtime/node。" >&2
  echo "       请安装 Node.js 18+：https://nodejs.org/zh-cn/download" >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[错误] Node 版本过低：$("$NODE_BIN" -v)，需要 18 以上" >&2
  exit 1
fi
echo "[1/3] Node 已就绪：$("$NODE_BIN" -v)  ($NODE_BIN)"

if [ -d "$ROOT/node_modules/express" ]; then
  echo "[2/3] 依赖已就绪（node_modules）"
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "[错误] 缺少依赖且找不到 npm，请先安装 Node.js 18+" >&2
    exit 1
  fi
  echo "[2/3] 首次运行，安装依赖（npm install）..."
  npm install
fi

if ! id -u "${SANDBOX_USER:-pog_sandbox}" >/dev/null 2>&1; then
  echo "[提示] 没检测到沙箱用户，代码执行会被拒绝。"
  echo "       需要时执行一次：sudo bash scripts/linux/sandbox-setup.sh"
fi

export SERVER_MODE="$MODE"
echo "[3/4] 启动独立硬件建模通道..."
if (exec 3<>/dev/tcp/127.0.0.1/41900) 2>/dev/null; then
  exec 3>&-
  echo "      已在运行：http://127.0.0.1:41900"
else
  mkdir -p "$ROOT/data/logs"
  nohup "$NODE_BIN" "$ROOT/hardware/model/cli.js" serve >> "$ROOT/data/logs/hardware-model.log" 2>&1 &
  echo "      已启动：http://127.0.0.1:41900 (pid $!)"
fi
echo "[4/4] 启动主服务（SERVER_MODE=$MODE）..."
exec "$NODE_BIN" "$ROOT/scripts/launch.js"
