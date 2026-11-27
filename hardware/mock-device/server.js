// 🦾 模拟本体：按 deviceLinkClient 的 /v1 契约返回状态与执行动作。
//
// 没有打印机、也没有舵机时，先用它验证「动作 → 回读 → 运动判据」这条闭环；
// ESP32 固件照着同一份契约实现即可，主项目不需要改代码。
//
// 用法：node hardware/mock-device/server.js [端口]（默认 7788）
//      MOCK_TOKEN=xxx node hardware/mock-device/server.js 7788   # 需要鉴权

const http = require('http');

const ACTIONS = ['nod', 'look_left', 'look_right', 'center', 'set_led'];
const PAN_LIMIT = 90;
const TILT_LIMIT = 60;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function createMockDevice({ token = '' } = {}) {
  const state = {
    mode: 'idle',
    battery: 87,
    joints: { pan: 0, tilt: 0 },
    led: 'warm',
    source: 'mock'
  };
  const timers = new Set();
  let pending = 0;

  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    if (timer.unref) timer.unref();
    timers.add(timer);
  }

  // 启动一次「执行中」：先立刻改变目标关节，保证第一次回读就能看到位移
  function begin() {
    pending += 1;
    state.mode = 'executing';
  }

  function end() {
    pending = Math.max(0, pending - 1);
    if (pending === 0) state.mode = 'idle';
  }

  function moveTo(name, target, durationMs = 400) {
    begin();
    const from = state.joints[name];
    const to = clamp(target, name === 'pan' ? -PAN_LIMIT : -30, name === 'pan' ? PAN_LIMIT : TILT_LIMIT);
    // 第一步立即落一点，避免客户端回读时还停在原角度、被误判成「没动」
    state.joints[name] = Math.round((from + (to - from) * 0.4) * 100) / 100;
    let step = 0;
    const steps = 8;
    const interval = Math.max(20, Math.floor(durationMs / steps));
    const walk = () => {
      step += 1;
      const ratio = Math.min(1, 0.4 + (0.6 * step) / steps);
      state.joints[name] = Math.round((from + (to - from) * ratio) * 100) / 100;
      if (step < steps) {
        schedule(walk, interval);
      } else {
        state.joints[name] = to;
        end();
      }
    };
    schedule(walk, interval);
  }

  function runAction(action, payload = {}) {
    switch (action) {
      case 'nod':
        moveTo('tilt', -14, 200);
        schedule(() => moveTo('tilt', 8, 200), 240);
        schedule(() => moveTo('tilt', 0, 220), 500);
        return true;
      case 'look_left':
        moveTo('pan', state.joints.pan - 25, 350);
        return true;
      case 'look_right':
        moveTo('pan', state.joints.pan + 25, 350);
        return true;
      case 'center':
        moveTo('pan', 0, 300);
        moveTo('tilt', 0, 300);
        return true;
      case 'set_led':
        state.led = String(payload.color || payload.value || 'soft').slice(0, 20);
        return true;
      default:
        return false;
    }
  }

  function authorized(req) {
    if (!token) return true;
    return String(req.headers.authorization || '') === `Bearer ${token}`;
  }

  function json(res, code, body) {
    const raw = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(raw)
    });
    res.end(raw);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!authorized(req)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
      json(res, 200, { actions: ACTIONS.slice(), serial: state });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/inbox') {
      json(res, 200, { events: [], cursor: Number(url.searchParams.get('since')) || 0 });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/actions') {
      const body = await readBody(req);
      if (!body || !body.action) {
        json(res, 400, { error: '缺少 action' });
        return;
      }
      if (!runAction(String(body.action), body)) {
        json(res, 400, { error: `未知动作：${body.action}` });
        return;
      }
      json(res, 200, { result: { success: true, action: body.action } });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/reply') {
      await readBody(req);
      json(res, 200, { success: true });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  function listen(port = 7788) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        resolve(address.port);
      });
    });
  }

  function close() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, state, listen, close };
}

module.exports = { createMockDevice, ACTIONS };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.MOCK_PORT) || 7788;
  const device = createMockDevice({ token: process.env.MOCK_TOKEN || '' });
  device.listen(port).then((actual) => {
    console.log(`[模拟本体] http://127.0.0.1:${actual} 已启动（actions: ${ACTIONS.join(' / ')}）`);
    if (process.env.MOCK_TOKEN) console.log('[模拟本体] 已开启 Bearer 鉴权');
  }).catch((error) => {
    console.error('[模拟本体] 启动失败:', error.message);
    process.exit(1);
  });
}
