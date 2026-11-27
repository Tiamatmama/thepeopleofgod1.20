'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cssDpr,
  normalizeRect,
  clientToViewport,
  toRatioBox,
  buildDesignSpec,
  parsePowerShellReport,
  readPngSize,
  buildWindowProbeScript,
  buildRegionCaptureScript,
} = require('../src/core/designCapture');
const {
  McpStdioClient,
  resolveMcpConfig,
  collectText,
  collectImage,
} = require('../src/core/designMcp');

const FRAME = { left: 100, top: 50, right: 1100, bottom: 650 };

test('尺子1：DPI → CSS 缩放比', () => {
  assert.equal(cssDpr(96), 1);
  assert.equal(cssDpr(144), 1.5);
  assert.equal(cssDpr(192), 2);
  assert.equal(cssDpr(0), 1);
  assert.equal(cssDpr(960), 4); // 上限 4 倍
});

test('尺子1：客户区物理像素 → CSS 视口', () => {
  const viewport = clientToViewport({ width: 1500, height: 900 }, 144);
  assert.deepEqual(viewport, { width: 1000, height: 600, dpr: 1.5 });
});

test('矩形归一：缺宽高时按边界算，非法尺寸返回 null', () => {
  const rect = normalizeRect(FRAME);
  assert.equal(rect.width, 1000);
  assert.equal(rect.height, 600);
  assert.equal(normalizeRect({ left: 0, top: 0, right: 0, bottom: 0 }), null);
  assert.equal(normalizeRect(null), null);
});

test('尺子3：元素矩形 → 相对取景框的比例', () => {
  const ratio = toRatioBox({ left: 200, top: 80, right: 400, bottom: 230 }, FRAME);
  assert.deepEqual(ratio, { left: 0.1, top: 0.05, width: 0.2, height: 0.25 });
});

test('spec：浏览器优先取渲染控件矩形，元素落成比例', () => {
  const spec = buildDesignSpec({
    title: 'Reference',
    process: 'chrome',
    dpi: 144,
    windowRect: { left: 0, top: 0, right: 1600, bottom: 1000 },
    clientRect: { left: 100, top: 50, right: 1500, bottom: 950 },
    contentRect: FRAME,
    capturedAt: '2026-11-15T00:00:00.000Z',
    screenshot: { id: 'abc', width: 1000, height: 600 },
    elements: [{ name: '搜索框', role: 'input', rect: { left: 200, top: 80, right: 400, bottom: 230 } }],
  });

  assert.equal(spec.version, 1);
  assert.deepEqual(spec.viewport.width, 667);
  assert.deepEqual(spec.viewport.height, 400);
  assert.equal(spec.viewport.dpr, 1.5);
  assert.equal(spec.metrics.frame.width, 1000);
  assert.equal(spec.metrics.frameSource, 'content');
  assert.equal(spec.screenshot.originalWidth, 1000);
  assert.equal(spec.screenshot.scale, 1);
  assert.equal(spec.elements.length, 1);
  assert.equal(spec.elements[0].name, '搜索框');
  assert.equal(spec.contract.rootFontSize, 16);
  assert.ok(spec.contract.rules.length >= 4);
});

test('spec：没有客户区矩形时直接失败，不产出假视口', () => {
  assert.throws(() => buildDesignSpec({ dpi: 96 }), /客户区/);
});

test('spec：只有窗口矩形时拒绝出 spec（不拿标题栏冒充客户区）', () => {
  assert.throws(() => buildDesignSpec({
    dpi: 96,
    windowRect: { left: 0, top: 0, right: 800, bottom: 600 },
    screenshot: { id: 'x', width: 800, height: 600 },
  }), /客户区/);
});

test('解析 PowerShell 回包：多行 JSON + 告警噪声', () => {
  const text = [
    'Response: WARNING: something',
    '{"found":true,"title":"参考","dpi":144,',
    ' "contentRect":{"left":1,"top":2,"right":3,"bottom":4}}',
    'Status Code: 0',
  ].join('\n');
  const { statusCode, data } = parsePowerShellReport(text);
  assert.equal(statusCode, 0);
  assert.equal(data.found, true);
  assert.equal(data.dpi, 144);
});

test('解析 PowerShell 回包：没有 JSON 时报错', () => {
  assert.throws(() => parsePowerShellReport('Response: 没找到\nStatus Code: 1'), /JSON/);
});

test('解析截图元数据：PNG 头给出真实像素尺寸', () => {
  const buf = Buffer.alloc(24);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((byte, i) => { buf[i] = byte; });
  buf.writeUInt32BE(1918, 16);
  buf.writeUInt32BE(1078, 20);
  assert.deepEqual(readPngSize(buf), { width: 1918, height: 1078 });
  assert.equal(readPngSize(Buffer.from('not a png')), null);
});

test('截图脚本：先切前台再按物理像素抓屏，路径单引号转义', () => {
  const script = buildRegionCaptureScript({ outFile: "C:\\tmp\\it's.png", handle: 12345 });
  assert.ok(script.includes('$h = [IntPtr]12345'));
  assert.ok(script.includes('ShowWindow($h, 9)'));
  assert.ok(script.includes('SetForegroundWindow($h)'));
  assert.ok(script.includes('CopyFromScreen([int]$frame.left, [int]$frame.top'));
  assert.ok(script.includes("'C:\\tmp\\it''s.png'"));
  assert.ok(script.includes('EnableDpiAwareness'));

  const bare = buildRegionCaptureScript({ outFile: 'x.png' });
  assert.ok(bare.includes('$h = [IntPtr]::Zero'));
  assert.ok(!bare.includes('[TgpWin32]::SetForegroundWindow'));

  assert.throws(() => buildRegionCaptureScript({}), /输出路径/);
});

test('spec：没拿到 DPI 感知时不再二次缩放', () => {
  const spec = buildDesignSpec({
    dpi: 144,
    dpiAware: false,
    clientRect: { width: 1278, height: 718 },
    screenshot: { id: 'x', width: 1278, height: 718 },
  });
  assert.equal(spec.viewport.width, 1278);
  assert.equal(spec.viewport.height, 718);
  assert.equal(spec.viewport.dpr, 1);
  assert.equal(spec.metrics.dpiAware, false);
});

test('量窗口脚本：标题里的单引号成对转义', () => {
  const script = buildWindowProbeScript({ title: "it's mine", process: 'chrome' });
  assert.ok(script.includes("$pattern = 'it''s mine'"));
  assert.ok(script.includes('Chrome_RenderWidgetHostHWND'));
  assert.ok(script.includes('GetDpiForWindow'));
});

test('sidecar 配置：默认 uvx，可用环境变量覆盖', () => {
  assert.deepEqual(resolveMcpConfig({}), { command: 'uvx', args: ['windows-mcp', 'serve'] });
  assert.deepEqual(
    resolveMcpConfig({ DESIGN_MCP_COMMAND: 'uv', DESIGN_MCP_ARGS: '["run","windows-mcp","serve"]' }),
    { command: 'uv', args: ['run', 'windows-mcp', 'serve'] },
  );
  assert.throws(() => resolveMcpConfig({ DESIGN_MCP_ARGS: '{"bad":1}' }), /JSON/);
});

// MCP 协议最小回路：拉起一个假的 sidecar，验证 initialize → tools/call 与超时
const FAKE_SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method !== 'tools/call') return;
  const name = msg.params && msg.params.name;
  if (name === 'Echo') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(msg.params.arguments.text) }] } });
  } else if (name === 'Image') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }] } });
  } else if (name === 'Boom') {
    send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
  }
});
`;

test('MCP 客户端：握手、文本、图片、错误与超时', async () => {
  const client = new McpStdioClient({
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
    callTimeoutMs: 3000,
  });
  try {
    await client.start();

    const echo = await client.callTool('Echo', { text: 'hello 尺子' });
    assert.equal(collectText(echo), 'hello 尺子');

    const image = await client.callTool('Image', {});
    assert.deepEqual(collectImage(image), { data: 'aGk=', mimeType: 'image/png' });

    await assert.rejects(() => client.callTool('Boom', {}), /boom/);

    const slowClient = new McpStdioClient({
      command: process.execPath,
      args: ['-e', FAKE_SERVER],
      callTimeoutMs: 150,
    });
    try {
      await assert.rejects(() => slowClient.callTool('Slow', {}), /超时/);
    } finally {
      slowClient.close();
    }
  } finally {
    client.close();
  }
});

test('MCP 客户端：命令不存在时给出可读错误', async () => {
  const client = new McpStdioClient({ command: 'definitely-not-a-command-tgp', args: [] });
  try {
    await assert.rejects(() => client.start(), /启动失败/);
  } finally {
    client.close();
  }
});
