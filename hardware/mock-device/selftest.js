// 自检：不接硬件，验证「契约 → 动作 → 回读 → 运动判据」这条闭环。
// 运行：node hardware/mock-device/selftest.js

const assert = require('node:assert');
const { createMockDevice } = require('./server');
const { DeviceLinkClient } = require('../../src/core/deviceLinkClient');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const device = createMockDevice();
  const port = await device.listen(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new DeviceLinkClient({ baseUrl, token: 'ignored-when-mock-has-none' });

  // 与生产一致：先 start()（enabled=true）再做一次同步刷新，保证断言前已拿到动作表
  client.start();
  await client.refresh();
  assert.strictEqual(client.ready, true, `设备应可发现（${client.lastError || '无错误'}）`);
  assert.ok(client.listActionNames().includes('nod'), '动作表应包含 nod');

  const before = await client.observe();
  assert.ok(before && before.joints, '应读到关节状态');

  const nod = await client.enqueue('nod', { source: 'selftest' });
  assert.strictEqual(nod.success, true, '点头应成功');
  assert.ok(nod.motion, '应带运动判据');
  assert.strictEqual(nod.motion.verdict, 'moved', `应判为动了，实际 ${nod.motion.verdict}`);
  assert.ok(nod.motion.maxDelta >= 1.5, `位移应超过噪声阈值，实际 ${nod.motion.maxDelta}`);

  const look = await client.enqueue('look_left', { source: 'selftest' });
  assert.strictEqual(look.success, true);
  assert.ok(look.motion && look.motion.verdict === 'moved');
  assert.ok(device.state.joints.pan < 0, '左转应让 pan 变负');

  const rejected = await client.enqueue('fly', { source: 'selftest' });
  assert.strictEqual(rejected.success, false, '未知动作应被拒绝');
  assert.ok(rejected.error.includes('拒绝'), `错误应说明是平台拒绝：${rejected.error}`);

  // 等动画收尾，状态必须回到 idle；否则主项目会一直以为还在执行
  let state = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(100);
    state = await client.observe();
    if (state && state.mode === 'idle') break;
  }
  assert.strictEqual(state.mode, 'idle', `动作结束后应回 idle，实际 ${state.mode}`);

  // 鉴权：设备要求 token 时，不带 token 的客户端必须拿不到动作表
  const guarded = createMockDevice({ token: 'secret' });
  const guardedPort = await guarded.listen(0);
  const noToken = new DeviceLinkClient({ baseUrl: `http://127.0.0.1:${guardedPort}`, token: 'wrong' });
  noToken.start();
  await noToken.refresh();
  assert.strictEqual(noToken.ready, false, '错误 token 不应就绪');

  client.stop();
  noToken.stop();
  await device.close();
  await guarded.close();
  console.log('模拟本体自检通过：发现 → 回读 → 点头 → 判动 → 拒绝未知动作 → 回 idle → 鉴权');
}

main().catch(async (error) => {
  console.error('模拟本体自检失败:', error.message);
  process.exitCode = 1;
});
