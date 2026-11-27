#!/bin/bash
# 一键部署到 Linux 服务器：装依赖 → 上传代码（含 .env）→ 安装项目依赖 → PM2 启动
# 用法：bash scripts/linux/deploy.sh <服务器IP> [用户名] [端口]
# 说明：上传会排除 node_modules / data / .git / backups / logs / runtime，
#       不会覆盖服务器上已有的数据；.env 会被一起上传（里面有密钥，注意目标机权限）。

set -euo pipefail

cd "$(dirname "$0")/../.."

APP_DIR="/opt/thepeopleofgod"
APP_NAME="emotion-server"

if [ $# -lt 1 ]; then
    echo "使用方法: $0 <服务器IP> [用户名] [端口]"
    echo "示例: $0 192.0.2.10 root 41888"
    exit 1
fi

SERVER_IP="$1"
REMOTE_USER="${2:-root}"
PORT="${3:-41888}"

if [ ! -f .env ]; then
    echo "[提示] 本地没有 .env，本次不会部署任何 API Key，服务起来后需要手动补。"
    echo "       .env 模板见 README 的「2.4 .env 模板」。"
fi

echo "=== thepeopleofgod1.20 部署脚本 ==="
echo "目标服务器: $REMOTE_USER@$SERVER_IP"
echo "端口: $PORT"
echo ""

echo "[1/5] 安装服务器依赖（Node 20 / ffmpeg / PM2）..."
ssh "$REMOTE_USER@$SERVER_IP" 'bash -s' << 'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ca-certificates curl

if command -v node >/dev/null 2>&1; then
    echo "已检测到 Node.js $(node -v)，跳过安装"
else
    echo "未检测到 Node.js，安装 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    apt-get install -y ffmpeg
fi

if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2
fi

node --version
npm --version
EOF

echo ""
echo "[2/5] 创建项目目录..."
ssh "$REMOTE_USER@$SERVER_IP" "mkdir -p '$APP_DIR'"

echo ""
echo "[3/5] 上传项目文件（排除 node_modules / data / .git / backups / logs / runtime）..."
tar \
    --exclude='./node_modules' \
    --exclude='./data' \
    --exclude='./.git' \
    --exclude='./backups' \
    --exclude='./logs' \
    --exclude='./runtime' \
    -czf - . | ssh "$REMOTE_USER@$SERVER_IP" "tar -xzf - -C '$APP_DIR'"

echo ""
echo "[4/5] 安装项目依赖..."
ssh "$REMOTE_USER@$SERVER_IP" "cd '$APP_DIR' && export DEBIAN_FRONTEND=noninteractive && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi"

echo ""
echo "[5/5] 配置防火墙并启动服务..."
ssh "$REMOTE_USER@$SERVER_IP" "APP_DIR='$APP_DIR' APP_NAME='$APP_NAME' PORT='$PORT' bash -s" << 'EOF'
set -euo pipefail
cd "$APP_DIR"

echo "创建数据目录..."
mkdir -p data/tts_output data/sessions data/user_memories data/logs

echo "配置防火墙..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow "$PORT/tcp"
    ufw allow ssh
    ufw --force enable
else
    echo "未安装 ufw，跳过防火墙配置"
fi

echo "启动服务（SERVER_PORT=$PORT）..."
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    SERVER_PORT="$PORT" NODE_ENV=production pm2 restart "$APP_NAME" --update-env
else
    SERVER_PORT="$PORT" NODE_ENV=production pm2 start src/server/index.js --name "$APP_NAME"
fi

pm2 save
pm2 startup systemd >/dev/null 2>&1 || true
EOF

echo ""
echo "=== 部署完成 ==="
echo ""
echo "服务地址: http://$SERVER_IP:$PORT"
echo "管理命令:"
echo "  pm2 status                 # 查看状态"
echo "  pm2 logs $APP_NAME         # 查看日志"
echo "  pm2 restart $APP_NAME      # 重启服务"
