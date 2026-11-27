'use strict';

/**
 * 取景器的量尺与比例化 spec（纯逻辑，不碰 fs / 网络）
 *
 * 三把尺子：
 *   1. 采集时用「客户区矩形 + DPI」换算出 CSS 视口（物理像素 ÷ 缩放比）；
 *   2. 渲染时用同一个 CSS 视口 + 相同的 deviceScaleFactor，保证两边像素 1:1；
 *   3. spec 只给比例（%、fr、rem），不把截图像素当绝对 px 写进页面。
 *
 * windows-mcp 单独作为 sidecar 运行，这里只负责「把它的报告换算成尺子」，
 * 所以全部是可直接单测的纯函数。
 */

const DPI_BASE = 96;
const MIN_DPR = 0.5;
const MAX_DPR = 4;
const ROOT_FONT_SIZE = 16;
const MAX_ELEMENTS = 200;

function toFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** DPI → CSS 缩放比（deviceScaleFactor）。144 DPI = 1.5 倍，192 = 2 倍 */
function cssDpr(dpi) {
  const value = toFinite(dpi, DPI_BASE);
  if (value <= 0) return 1;
  return round(clamp(value / DPI_BASE, MIN_DPR, MAX_DPR), 3);
}

/** 统一矩形表示；只给宽高时按左上角 0,0 补齐，缺一条边就返回 null */
function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const left = toFinite(raw.left, 0);
  const top = toFinite(raw.top, 0);
  const width = toFinite(raw.width);
  const height = toFinite(raw.height);
  const right = toFinite(raw.right, width == null ? null : left + width);
  const bottom = toFinite(raw.bottom, height == null ? null : top + height);
  if (right == null || bottom == null) return null;
  const finalWidth = width == null ? right - left : width;
  const finalHeight = height == null ? bottom - top : height;
  if (!(finalWidth > 0) || !(finalHeight > 0)) return null;
  return { left, top, right, bottom, width: finalWidth, height: finalHeight };
}

/**
 * 尺子 1：客户区（物理像素）+ DPI → CSS 视口。
 * 例：1500×900 物理像素 @144 DPI → 1000×600 CSS px。
 */
function clientToViewport(rect, dpi) {
  const box = normalizeRect(rect);
  if (!box) throw new Error('客户区矩形无效，无法建立视口');
  const dpr = cssDpr(dpi);
  return {
    width: Math.max(1, Math.round(box.width / dpr)),
    height: Math.max(1, Math.round(box.height / dpr)),
    dpr,
  };
}

/** 物理像素矩形 → 相对取景框的比例（0~1），供 % / fr 布局使用 */
function toRatioBox(rect, frame) {
  const box = normalizeRect(rect);
  const base = normalizeRect(frame);
  if (!box || !base) return null;
  const left = clamp((box.left - base.left) / base.width, 0, 1);
  const top = clamp((box.top - base.top) / base.height, 0, 1);
  const width = clamp(box.width / base.width, 0, 1 - left);
  const height = clamp(box.height / base.height, 0, 1 - top);
  return {
    left: round(left),
    top: round(top),
    width: round(width),
    height: round(height),
  };
}

/** 元素清单：物理像素 → 比例，丢掉落在取景框外的项 */
function normalizeElements(elements, frame, limit = MAX_ELEMENTS) {
  if (!Array.isArray(elements)) return [];
  const out = [];
  for (const item of elements) {
    if (!item || typeof item !== 'object') continue;
    const ratio = toRatioBox(item.rect || item, frame);
    if (!ratio) continue;
    out.push({
      name: String(item.name || item.label || '').slice(0, 120),
      role: item.role ? String(item.role).slice(0, 40) : null,
      ...ratio,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeScreenshot(raw, frame) {
  if (!raw || typeof raw !== 'object') return null;
  const width = toFinite(raw.width);
  const height = toFinite(raw.height);
  const originalWidth = toFinite(raw.originalWidth, frame ? frame.width : null);
  const originalHeight = toFinite(raw.originalHeight, frame ? frame.height : null);
  const scale = toFinite(
    raw.scale,
    width && originalWidth ? round(width / originalWidth, 6) : 1,
  );
  return {
    id: raw.id ? String(raw.id) : null,
    width,
    height,
    originalWidth,
    originalHeight,
    scale,
  };
}

/**
 * 尺子 3：给生成页面的比例契约。
 * 这里不写任何绝对 px 的版式要求，只固定基准与单位。
 */
function buildContract(viewport) {
  return {
    rootFontSize: ROOT_FONT_SIZE,
    viewport: `${viewport.width}x${viewport.height}@${viewport.dpr}x`,
    rules: [
      '根容器用 width:100% / height:100%（或 100vw/100vh），不要按截图分辨率写死 px',
      '字号用 rem（根 16px）；间距用 rem / % / clamp()；布局用 flex / grid 的 fr 与百分比',
      '圆角、描边、阴影用 rem / em，不跟随截图分辨率放大',
      '参考图只用于对比例与位置，不用于抄像素；同一页面在其它视口下应同比缩放',
    ],
  };
}

/**
 * 采集报告 → design-spec
 * @param {object} input {title, process, handle, dpi, windowRect, clientRect, contentRect,
 *                        capturedAt, screenshot, elements}
 */
function buildDesignSpec(input = {}) {
  const contentRect = normalizeRect(input.contentRect);
  const clientRect = normalizeRect(input.clientRect);
  const windowRect = normalizeRect(input.windowRect);
  // 浏览器/Electron 的客户区含工具栏，优先用渲染控件（网页内容）矩形
  const frame = contentRect || clientRect;
  if (!frame) throw new Error('没有可用的客户区矩形，无法建立视口尺子');

  const dpi = toFinite(input.dpi, DPI_BASE);
  // 进程没拿到 DPI 感知时，系统给的矩形已经是 CSS 像素，不能再除一次缩放比
  const dpiAware = input.dpiAware !== false;
  const viewport = dpiAware
    ? clientToViewport(frame, dpi)
    : { width: Math.round(frame.width), height: Math.round(frame.height), dpr: 1 };
  // 记下取景框来源：content = 网页渲染控件（不含浏览器工具栏），client = 整个客户区
  const frameSource = contentRect ? 'content' : 'client';

  return {
    version: 1,
    capturedAt: input.capturedAt ? String(input.capturedAt) : new Date().toISOString(),
    source: {
      title: input.title ? String(input.title).slice(0, 200) : '',
      process: input.process ? String(input.process).slice(0, 80) : '',
      handle: toFinite(input.handle),
    },
    metrics: {
      dpi,
      dpr: viewport.dpr,
      dpiAware,
      windowRect,
      clientRect,
      contentRect,
      frame,
      frameSource,
    },
    viewport: { ...viewport, frame, frameSource },
    screenshot: normalizeScreenshot(input.screenshot, frame),
    contract: buildContract(viewport),
    elements: normalizeElements(input.elements, frame),
  };
}

/**
 * 解析 PowerShell 工具的回包：`Response: <body>\nStatus Code: <n>`。
 * body 可能是多行 JSON，也可能混着告警，所以再从首个 { 到末个 } 截一次。
 */
function parsePowerShellReport(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('PowerShell 回包为空');
  }
  const lines = text.split(/\r?\n/);
  let statusCode = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/^Status Code:\s*(-?\d+)/);
    if (match) {
      statusCode = Number(match[1]);
      lines.splice(i, 1);
      break;
    }
  }
  let body = lines.join('\n').trim();
  if (body.startsWith('Response:')) body = body.slice('Response:'.length).trim();

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`PowerShell 回包里没有 JSON：${body.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`PowerShell 回包 JSON 解析失败：${error.message}`, { cause: error });
  }
  return { statusCode, data };
}

/** 读 PNG 头拿到实际像素尺寸（不引图像库） */
function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, i) => buffer[i] !== byte)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

// PowerShell 里单引号字符串的转义：成对单引号
function psQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

const WINDOW_PROBE_TYPES = `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TgpWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  // 不开 DPI 感知时，系统会把窗口坐标「虚拟化」成 96 DPI 的 CSS 像素，
  // 再拿 144 DPI 去除一遍就会缩两次；这里先把自己声明成 per-monitor-v2，
  // 之后量到的都是物理像素，尺子才对得上。
  public static string EnableDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch {}
    try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; } catch {}
    return "none";
  }
  // 浏览器/Electron 的网页内容是一个 Chrome_RenderWidgetHostHWND 子窗口，
  // 它可能是孙子节点（Edge、VS Code），所以要递归枚举而不是只找直接子窗口
  public static IntPtr FindRenderWidget(IntPtr parent) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      StringBuilder sb = new StringBuilder(256);
      GetClassName(child, sb, 256);
      if (sb.ToString().IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0) {
        found = child;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@`;

/**
 * 生成「量窗口」的 PowerShell 脚本。
 * 输出 JSON：窗口矩形、客户区矩形（屏幕坐标）、渲染控件矩形、DPI。
 */
function buildWindowProbeScript({ title = '', process: processName = '' } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    WINDOW_PROBE_TYPES,
    '$aware = [TgpWin32]::EnableDpiAwareness()',
    `$pattern = '${psQuote(title)}'`,
    `$wanted = '${psQuote(processName)}'`,
    "$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })",
    "if ($wanted) { $procs = @($procs | Where-Object { $_.ProcessName -like \"*$wanted*\" }) }",
    "if ($pattern) { $procs = @($procs | Where-Object { $_.MainWindowTitle -like \"*$pattern*\" }) }",
    "if ($procs.Count -eq 0) { Write-Output '{\"found\":false}'; exit 0 }",
    '$p = $procs | Select-Object -First 1',
    '$h = [IntPtr]$p.MainWindowHandle',
    '$wr = New-Object TgpWin32+RECT',
    '[TgpWin32]::GetWindowRect($h, [ref]$wr) | Out-Null',
    '$cr = New-Object TgpWin32+RECT',
    '[TgpWin32]::GetClientRect($h, [ref]$cr) | Out-Null',
    '$origin = New-Object TgpWin32+POINT',
    '[TgpWin32]::ClientToScreen($h, [ref]$origin) | Out-Null',
    '$dpi = 0',
    'try { $dpi = [int][TgpWin32]::GetDpiForWindow($h) } catch { $dpi = 0 }',
    'if ($dpi -le 0) { $dc = [TgpWin32]::GetDC($h); $dpi = [int][TgpWin32]::GetDeviceCaps($dc, 88); [TgpWin32]::ReleaseDC($h, $dc) | Out-Null }',
    "$content = $null",
    "$child = [TgpWin32]::FindRenderWidget($h)",
    'if ($child -ne [IntPtr]::Zero) {',
    '  $rr = New-Object TgpWin32+RECT',
    '  [TgpWin32]::GetWindowRect($child, [ref]$rr) | Out-Null',
    '  if ($rr.Right -gt $rr.Left -and $rr.Bottom -gt $rr.Top) { $content = @{ left = $rr.Left; top = $rr.Top; right = $rr.Right; bottom = $rr.Bottom } }',
    '}',
    '[pscustomobject]@{',
    "  found = $true; title = $p.MainWindowTitle; process = $p.ProcessName; handle = $h.ToInt64(); dpi = $dpi;",
    '  windowRect = @{ left = $wr.Left; top = $wr.Top; right = $wr.Right; bottom = $wr.Bottom };',
    '  clientRect = @{ left = $origin.X; top = $origin.Y; right = ($origin.X + $cr.Right); bottom = ($origin.Y + $cr.Bottom) };',
    '  contentRect = $content;',
    "  dpiAware = ($aware -ne 'none')",
    '} | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
}

/**
 * 生成「把目标窗口切到前台，再按物理像素截一块」的 PowerShell 脚本。
 * 抓屏只能拿到屏幕上看得见的东西，所以先 ShowWindow + SetForegroundWindow；
 * 随后重新量一次矩形（还原后位置可能变），量到哪块就截哪块。
 * 输出 JSON：saved / width / height / frameSource / rect。
 */
function buildRegionCaptureScript({ outFile, handle } = {}) {
  if (!outFile) throw new Error('截图脚本需要输出路径');
  const hwnd = Number(handle);
  const hasHandle = Number.isFinite(hwnd) && hwnd > 0;

  return [
    "$ErrorActionPreference = 'Stop'",
    WINDOW_PROBE_TYPES,
    '[TgpWin32]::EnableDpiAwareness() | Out-Null',
    hasHandle
      ? `$h = [IntPtr]${Math.trunc(hwnd)}`
      : '$h = [IntPtr]::Zero',
    hasHandle ? '[TgpWin32]::ShowWindow($h, 9) | Out-Null' : '',
    hasHandle ? '[TgpWin32]::BringWindowToTop($h) | Out-Null' : '',
    hasHandle ? '[TgpWin32]::SetForegroundWindow($h) | Out-Null' : '',
    hasHandle ? 'Start-Sleep -Milliseconds 250' : '',
    '$cr = New-Object TgpWin32+RECT',
    '[TgpWin32]::GetClientRect($h, [ref]$cr) | Out-Null',
    '$origin = New-Object TgpWin32+POINT',
    '[TgpWin32]::ClientToScreen($h, [ref]$origin) | Out-Null',
    '$frame = @{ left = $origin.X; top = $origin.Y; right = ($origin.X + $cr.Right); bottom = ($origin.Y + $cr.Bottom) }',
    '$source = "client"',
    '$child = [TgpWin32]::FindRenderWidget($h)',
    'if ($child -ne [IntPtr]::Zero) {',
    '  $rr = New-Object TgpWin32+RECT',
    '  [TgpWin32]::GetWindowRect($child, [ref]$rr) | Out-Null',
    '  if ($rr.Right -gt $rr.Left -and $rr.Bottom -gt $rr.Top) {',
    '    $frame = @{ left = $rr.Left; top = $rr.Top; right = $rr.Right; bottom = $rr.Bottom }',
    '    $source = "content"',
    '  }',
    '}',
    '$w = [int]($frame.right - $frame.left)',
    '$hgt = [int]($frame.bottom - $frame.top)',
    'if ($w -le 0 -or $hgt -le 0) { throw "窗口矩形无效" }',
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap($w, $hgt)',
    '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
    '$graphics.CopyFromScreen([int]$frame.left, [int]$frame.top, 0, 0, (New-Object System.Drawing.Size($w, $hgt)))',
    '$graphics.Dispose()',
    `$bmp.Save('${psQuote(outFile)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
    '[pscustomobject]@{ saved = $true; width = $w; height = $hgt; frameSource = $source; rect = $frame } | ConvertTo-Json -Depth 5 -Compress',
  ].filter((line) => line !== '').join('\n');
}

module.exports = {
  DPI_BASE,
  ROOT_FONT_SIZE,
  MAX_ELEMENTS,
  cssDpr,
  normalizeRect,
  clientToViewport,
  toRatioBox,
  normalizeElements,
  buildContract,
  buildDesignSpec,
  parsePowerShellReport,
  readPngSize,
  buildWindowProbeScript,
  buildRegionCaptureScript,
  round,
  clamp,
};
