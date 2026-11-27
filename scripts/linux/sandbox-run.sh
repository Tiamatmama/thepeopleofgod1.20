#!/usr/bin/env bash
# Linux 沙箱监督进程：切到低权限用户执行命令，限制资源，写回 out/err/result。
# 与 Windows 的 sandbox-run.ps1 一一对应；参数由 src/core/sandboxExec.js 传入。
# 只依赖 bash + coreutils（setsid / stat / awk），不装任何额外软件包。

set -u

SCRIPT="" CWD="" OUT="" ERR="" RESULT="" WORK_BASE=""
IDLE_MS=600000 MAX_RUNTIME_MS=0 MAX_MEMORY_MB=4096 MAX_PROCESSES=64 CPU_LIMIT_MS=0
USER_NAME="pog_sandbox" MODE="sudo" PARENT_PID=0 PRESERVE_ENV=0

while [ $# -gt 0 ]; do
  case "$1" in
    --script) SCRIPT="$2"; shift 2 ;;
    --cwd) CWD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --err) ERR="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --work-base) WORK_BASE="$2"; shift 2 ;;
    --idle-ms) IDLE_MS="$2"; shift 2 ;;
    --max-runtime-ms) MAX_RUNTIME_MS="$2"; shift 2 ;;
    --max-memory-mb) MAX_MEMORY_MB="$2"; shift 2 ;;
    --max-processes) MAX_PROCESSES="$2"; shift 2 ;;
    --cpu-limit-ms) CPU_LIMIT_MS="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --parent-pid) PARENT_PID="$2"; shift 2 ;;
    --privileged) MODE="setpriv"; shift ;;
    --sudo) MODE="sudo"; shift ;;
    --preserve-env) PRESERVE_ENV=1; shift ;;
    *) shift ;;
  esac
done

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'
}

# job_ready：ulimit 是否真的挂上；没挂上时上层会把这次执行标成 degraded
write_result() {
  local code="$1" reason="$2" extra="${3:-}" ready="${4:-0}"
  [ -n "$RESULT" ] || return 0
  local tail=""
  [ -n "$extra" ] && tail=",$extra"
  [ "$ready" = "1" ] && ready="true" || ready="false"
  printf '{"exitCode":%s,"reason":"%s","accountMode":"account","jobReady":%s%s}\n' \
    "$code" "$reason" "$ready" "$tail" > "$RESULT" 2>/dev/null || true
}

if [ -z "$SCRIPT" ] || [ -z "$CWD" ] || [ -z "$OUT" ] || [ -z "$ERR" ] || [ -z "$RESULT" ]; then
  echo "sandbox-run.sh: 缺少必要参数" >&2
  exit 2
fi

mkdir -p "$WORK_BASE" 2>/dev/null || true
: > "$OUT" 2>/dev/null || true
: > "$ERR" 2>/dev/null || true

if ! cd "$CWD" 2>/dev/null; then
  write_result 127 start_failed '"startError":"工作目录不可用"' 0
  exit 1
fi

# 以哪个身份跑：服务本身是 root 时用 setpriv，否则用预配置好的 sudoers 切用户
if [ "$MODE" = "setpriv" ]; then
  GROUP_NAME="$(id -g "$USER_NAME" 2>/dev/null || echo "$USER_NAME")"
  RUN_PREFIX=(setpriv --reuid "$USER_NAME" --regid "$GROUP_NAME" --init-groups)
else
  # sudo 默认清空环境；上层只传了最小环境（PATH/LANG/PYTHON*/模型配置），带 -E 保住它们
  if [ "$PRESERVE_ENV" = "1" ]; then
    RUN_PREFIX=(sudo -n -E -u "$USER_NAME" --)
  else
    RUN_PREFIX=(sudo -n -u "$USER_NAME" --)
  fi
fi

VMEM_KB=$(( MAX_MEMORY_MB * 1024 ))
CPU_SEC=0
if [ "$CPU_LIMIT_MS" -gt 0 ]; then
  CPU_SEC=$(( (CPU_LIMIT_MS + 999) / 1000 ))
fi
LIMITS_FILE="$RESULT.limits"
rm -f "$LIMITS_FILE" 2>/dev/null || true

# setsid 让子进程成为独立进程组，后面按组杀才能连孙进程一起收掉
setsid bash -c '
  ready=1
  ulimit -v "$1" 2>/dev/null || ready=0
  ulimit -u "$2" 2>/dev/null || ready=0
  if [ "$3" -gt 0 ]; then ulimit -t "$3" 2>/dev/null || ready=0; fi
  printf "%s" "$ready" > "$4" 2>/dev/null || true
  shift 4
  exec "$@"
' _ "$VMEM_KB" "$MAX_PROCESSES" "$CPU_SEC" "$LIMITS_FILE" "${RUN_PREFIX[@]}" /bin/sh "$SCRIPT" \
  >"$OUT" 2>"$ERR" &
pid=$!

read_ready() {
  local value
  value="$(cat "$LIMITS_FILE" 2>/dev/null || echo 0)"
  [ "$value" = "1" ] && echo 1 || echo 0
}

kill_tree() {
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  kill -KILL -"$pid" 2>/dev/null || true
}

STOP_REASON=""
trap 'STOP_REASON="parent_exit"; kill_tree; wait "$pid" 2>/dev/null; write_result 143 "parent_exit" "" "$(read_ready)"; exit 0' TERM INT

started_at=$(date +%s)
last_activity=$started_at
last_stamp=$(stat -c %Y "$OUT" "$ERR" 2>/dev/null | sort -n | tail -1)
last_cpu=0

while kill -0 "$pid" 2>/dev/null; do
  sleep 0.5
  now=$(date +%s)
  stamp=$(stat -c %Y "$OUT" "$ERR" 2>/dev/null | sort -n | tail -1)
  cpu=$(awk '{print $14 + $15}' "/proc/$pid/stat" 2>/dev/null || echo 0)
  if [ "$stamp" != "$last_stamp" ] || [ "$cpu" != "$last_cpu" ]; then
    last_stamp="$stamp"
    last_cpu="$cpu"
    last_activity=$now
  fi
  if [ "$IDLE_MS" -gt 0 ] && [ $(( (now - last_activity) * 1000 )) -ge "$IDLE_MS" ]; then
    STOP_REASON="idle_timeout"
    break
  fi
  if [ "$MAX_RUNTIME_MS" -gt 0 ] && [ $(( (now - started_at) * 1000 )) -ge "$MAX_RUNTIME_MS" ]; then
    STOP_REASON="max_runtime"
    break
  fi
  if [ "$PARENT_PID" -gt 0 ] && ! kill -0 "$PARENT_PID" 2>/dev/null; then
    STOP_REASON="parent_exit"
    break
  fi
done

if [ -n "$STOP_REASON" ]; then
  kill_tree
  wait "$pid" 2>/dev/null
  write_result 143 "$STOP_REASON" "" "$(read_ready)"
  exit 0
fi

wait "$pid"
code=$?
write_result "$code" "exited" "" "$(read_ready)"
exit 0
