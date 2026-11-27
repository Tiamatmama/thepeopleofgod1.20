'use strict';

// 🕰️ 时间位移脚本（仅测试用，临时）
//
// 目的：测试「事件簿到点叮嘱 / 过点追问 / 结果回写」，以及记忆、自主发言里所有跟时间
// 相关的逻辑，但不想真的等上几小时、几天。做法是把进程内的「现在」整体平移一段偏移量：
// 全局 Date 被替换，Date.now() / new Date() 全部返回「真实时间 + 偏移」。
// 于是系统、以及角色看到的时钟，都以为自己处在另一个时间点，看不到真实系统时间。
//
// 偏移量存在 data/.timeshift-ms，运行中每 1 秒重读一次 → 不用重启就能推进时间。
//
// 用法：
//   1) 带时间位移启动服务（二选一，任选其一）：
//        npm run start:mock
//        node -r ./scripts/timeshift.js src/server/index.js
//   2) 运行中随时改偏移（另开一个终端）：
//        node scripts/timeshift.js +1d     # 把「现在」往后拨 1 天
//        node scripts/timeshift.js +30m    # 往后拨 30 分钟
//        node scripts/timeshift.js -2h     # 往前拨 2 小时
//        node scripts/timeshift.js 45      # 不带单位默认按分钟：+45 分钟
//        node scripts/timeshift.js reset   # 归零，回到真实时间
//        node scripts/timeshift.js         # 查看当前偏移
//   3) 关闭：不带 -r 正常 npm start 即可（没有改动任何业务代码）

const fs = require('fs');
const path = require('path');

const OFFSET_FILE = path.join(__dirname, '..', 'data', '.timeshift-ms');
const POLL_MS = 1000;

function readOffsetFromFile() {
  try {
    const raw = fs.readFileSync(OFFSET_FILE, 'utf8').trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0; // 文件不存在 = 不位移，一切照旧
  }
}

function writeOffsetToFile(ms) {
  fs.mkdirSync(path.dirname(OFFSET_FILE), { recursive: true });
  fs.writeFileSync(OFFSET_FILE, String(Math.round(ms)));
}

function fmtDuration(ms) {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const parts = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分`);
  if (s && !d && !h) parts.push(`${s}秒`);
  return `${sign}${parts.length ? parts.join('') : '0'}`;
}

// 解析 "+1d" / "-30m" / "45" / "2h" 这类写法，返回毫秒；无法识别返回 null
function parseDuration(input) {
  const m = String(input).trim().match(/^([+-]?)(\d+(?:\.\d+)?)\s*(ms|毫秒|min|分钟|sec|秒|hr|小时|day|天|s|m|分|h|时|d)?$/i);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const value = parseFloat(m[2]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[3] || 'min').toLowerCase();
  const factor =
    (unit === 'ms' || unit === '毫秒') ? 1 :
      (unit === 's' || unit === 'sec' || unit === '秒') ? 1000 :
        (unit === 'h' || unit === 'hr' || unit === '时' || unit === '小时') ? 3600000 :
          (unit === 'd' || unit === 'day' || unit === '天') ? 86400000 :
            60000; // m / min / 分 / 分钟 / 缺省
  return Math.round(sign * value * factor);
}

if (require.main !== module) {
  // ===== 被 -r 预加载：安装全局时间位移 =====
  const RealDate = Date;
  let offsetMs = 0;
  let fixedByEnv = false;

  if (Number.isFinite(Number(process.env.TIME_SHIFT_MS))) {
    offsetMs = Number(process.env.TIME_SHIFT_MS);
    fixedByEnv = true;
  } else if (Number.isFinite(Number(process.env.TIME_SHIFT_MIN))) {
    offsetMs = Number(process.env.TIME_SHIFT_MIN) * 60000;
    fixedByEnv = true;
  } else {
    offsetMs = readOffsetFromFile();
  }

  function FakeDate(...args) {
    const shifted = RealDate.now() + offsetMs;
    if (new.target) {
      return args.length === 0 ? new RealDate(shifted) : new RealDate(...args);
    }
    return new RealDate(shifted).toString();
  }
  FakeDate.now = () => RealDate.now() + offsetMs;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  global.Date = FakeDate;

  // 只读钩子：给测试夹具取「未位移的真实时间 / 当前偏移」用，不影响任何业务逻辑
  global.__timeshiftRealNow = () => RealDate.now();
  module.exports = { realNow: () => RealDate.now(), getOffset: () => offsetMs };

  console.log(`[时间位移] 已启用：偏移 ${fmtDuration(offsetMs)}（${offsetMs} ms）→ 假「现在」= 真实时间 ${fmtDuration(offsetMs)}`);

  if (!fixedByEnv) {
    setInterval(() => {
      const next = readOffsetFromFile();
      if (next !== offsetMs) {
        offsetMs = next;
        console.log(`[时间位移] 偏移更新为 ${fmtDuration(offsetMs)}（${offsetMs} ms）`);
      }
    }, POLL_MS).unref();
  }
} else {
  // ===== 直接运行：CLI 修改偏移 =====
  const arg = process.argv[2];

  if (arg === undefined || arg === '') {
    const cur = readOffsetFromFile();
    console.log(`当前偏移：${fmtDuration(cur)}（${cur} ms）`);
    console.log(`含义：进程以为「现在」= 真实时间 ${cur >= 0 ? '+' : '-'} ${Math.abs(cur)} ms`);
    console.log('用法：node scripts/timeshift.js +1d | +2h | -30m | 45 | reset');
  } else if (/^(reset|clear|off)$/i.test(arg) || arg === '0') {
    writeOffsetToFile(0);
    console.log('已归零：回到真实时间（服务端约 1 秒内生效）');
  } else {
    const ms = parseDuration(arg);
    if (ms === null) {
      console.error(`无法识别的时间参数：${arg}`);
      process.exit(1);
    }
    writeOffsetToFile(ms);
    console.log(`时间位移已设为 ${fmtDuration(ms)}（${ms} ms）`);
    console.log(`假「现在」≈ ${new Date(Date.now() + ms).toLocaleString('zh-CN')}`);
    console.log('前提：服务是用 npm run start:mock（带 -r 预加载）起的；约 1 秒内生效，无需重启。');
  }
}
