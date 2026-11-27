'use strict';

// 独立硬件设计代理：只做「目标 → 参数 → 调硬件通道构建 → 看回执迭代」。
// 不加载角色、记忆、工具表或编程沙箱；模型配置直接读 .env。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CHANNEL = (process.env.HARDWARE_MODEL_URL || 'http://localhost:41900').replace(/\/+$/, '');
const TOKEN = String(process.env.HARDWARE_MODEL_TOKEN || '').trim();
const DESIGN_DIR = path.join(ROOT, 'hardware', 'model', 'designs');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

function normalizeEndpoint(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return /\/chat\/completions\/?$/.test(value) ? value : `${value.replace(/\/+$/, '')}/chat/completions`;
}

function resolveChannel() {
  const channel = String(process.env.DESIGN_API_CHANNEL || process.env.CURRENT_API || 'doubao').trim();
  const map = {
    doubao: {
      url: normalizeEndpoint(process.env.DOUBAO_API_URL),
      key: process.env.DOUBAO_BEARER_TOKEN || '',
      model: process.env.DOUBAO_MODEL_ID || ''
    },
    deepseek: {
      url: normalizeEndpoint(process.env.DEEPSEEK_API_URL),
      key: process.env.DEEPSEEK_BEARER_TOKEN || '',
      model: process.env.DEEPSEEK_MODEL_ID || ''
    },
    qwen: {
      url: normalizeEndpoint(process.env.QWEN_API_URL),
      key: process.env.QWEN_API_KEY || '',
      model: process.env.QWEN_MODEL_ID || ''
    }
  };
  const config = map[channel];
  if (!config) throw new Error(`未知设计通道 ${channel}（可用 doubao / deepseek / qwen）`);
  if (!config.url || !config.key || !config.model) {
    throw new Error(`设计通道 ${channel} 未配置完整（需要 URL / KEY / MODEL）`);
  }
  return Object.assign({ channel }, config);
}

function parseJsonObject(text) {
  const source = String(text || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : source;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
  return JSON.parse(raw.slice(start, end + 1));
}

function sanitizeName(name) {
  const base = String(name || 'part').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 36) || 'part';
  return base.startsWith('agent-') ? base : `agent-${base}`;
}

// 回执验收：只按可观测指标判断，不猜模型意图
function evaluateReceipt(receipt, targetType = 'hydrant') {
  if (!receipt || receipt.ok !== true) return '构建失败';
  const [x, y, z] = receipt.bbox || [];
  if (![x, y, z].every(Number.isFinite)) return '包围盒无效';
  if (receipt.triangles < 2000) return `面数 ${receipt.triangles} 过少，细节可能丢失`;
  if (receipt.triangles > 80000) return `面数 ${receipt.triangles} 过多，请降低精度`;

  if (targetType === 'impeller') {
    if (z < 15 || z > 60) return `高度 ${z}mm 超出 15–60mm`;
    if (x > 130 || y > 130) return `外径 ${x}×${y}mm 过大`;
    if (!(receipt.volumeCm3 >= 8)) return `体积 ${receipt.volumeCm3}cm³ 过小，可能被窗口/中心孔切没`;
    return null;
  }

  if (z < 50 || z > 100) return `高度 ${z}mm 超出 50–100mm`;
  if (x > 70 || y > 70) return `底座 ${x}×${y}mm 过大`;
  if (!(receipt.volumeCm3 >= 5)) return `体积 ${receipt.volumeCm3}cm³ 过小，可能被窗口/内腔切没`;
  return null;
}

function schemaFor(targetType) {
  if (targetType === 'impeller') {
    return [
      '任务：为下面的几何编译器设计参数。目标类型固定为 impeller，只能输出 impeller。',
      'impeller 字段：type="impeller", name, unit="mm", outerRadius(30-55), hubRadius(10-22 且 <= outerRadius-8),',
      'height(18-40), bladeCount(6-12), bladeThickness(2-5), boreRadius(5-12 且 <= hubRadius-3), cell(1.6-2.2)。',
      '硬约束：中心孔贯通；叶片从轮毂伸到外缘并落在底盘上；只输出单一连通实体；不要输出 assembly。'
    ].join('\n');
  }
  return [
    '任务：为下面的几何编译器设计参数。目标类型固定为 hydrant，只能输出 hydrant。',
    'hydrant 字段：type="hydrant", name, unit="mm", outerRadius(12-20), innerRadius(5-16 且 <= outerRadius-3),',
    'height(50-90), baseRadius(18-28), baseHeight(4-10), windowCount(3-10), windowZ(15-70),',
    'windowHeight(10-35), windowWidth(6-14), nozzleZ(30-60), cell(1.8-2.5)。',
    '硬约束：窗口上下边各留 >=3mm；只输出单一连通实体；不要输出 assembly。'
  ].join('\n');
}

function buildPrompt(goal, round, previous, targetType = 'hydrant') {
  const system = [
    '你是独立硬件设计代理，只输出一个 JSON 对象，不写解释、不写代码、不写文件路径。',
    schemaFor(targetType),
    '可以附带 "rationale": "一句话设计理由"。'
  ].join('\n');
  const lines = [`目标：${goal}`, `这是第 ${round} 轮。`];
  if (previous) {
    lines.push(`上一轮参数：${JSON.stringify(previous.spec)}`);
    lines.push(`上一轮结果：${previous.error || JSON.stringify(previous.receipt)}`);
  } else {
    lines.push('还没有上一轮，请给出第一版参数。');
  }
  lines.push('只返回 JSON。');
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }];
}

async function askModel(config, messages) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.key}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.5,
      max_tokens: 1600,
      stream: false
    }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data && (data.error && (data.error.message || data.error) || data.message);
    throw new Error(`模型调用失败 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!content) throw new Error('模型返回为空');
  return content;
}

async function buildViaChannel(spec) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`${CHANNEL}/v1/build`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ spec }),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((data && data.error) || `硬件通道 HTTP ${response.status}`);
  }
  return data;
}

function saveDesign(goal, config, rounds, finalSpec, targetType) {
  fs.mkdirSync(DESIGN_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(DESIGN_DIR, `${stamp}-${targetType}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    goal,
    model: `${config.channel}:${config.model}`,
    createdAt: new Date().toISOString(),
    rounds,
    finalSpec
  }, null, 2)}\n`);
  return file;
}

async function design(goal, options = {}) {
  loadEnv();
  const config = resolveChannel();
  const targetType = options.type === 'impeller' ? 'impeller' : 'hydrant';
  console.log(`[设计代理] 模型：${config.channel}:${config.model} · 类型：${targetType}`);
  const maxRounds = Math.max(1, Math.min(6, Number(options.rounds) || 4));
  const rounds = [];
  let previous = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const content = await askModel(config, buildPrompt(goal, round, previous, targetType));
    let parsed;
    try {
      parsed = parseJsonObject(content);
    } catch (error) {
      previous = { error: `JSON 解析失败：${error.message}`, spec: previous ? previous.spec : {} };
      rounds.push(previous);
      console.log(`[设计代理] 第 ${round} 轮：${previous.error}`);
      continue;
    }

    const spec = Object.assign({}, parsed, {
      name: sanitizeName(parsed.name),
      type: targetType,
      unit: 'mm'
    });
    const rationale = parsed.rationale ? String(parsed.rationale).slice(0, 300) : '';

    try {
      const receipt = await buildViaChannel(spec);
      const problem = evaluateReceipt(receipt, targetType);
      rounds.push({ spec, rationale, receipt });
      console.log(`[设计代理] 第 ${round} 轮：${spec.name} · ${receipt.bbox.join(' × ')}mm · ${receipt.volumeCm3}cm³ · ${receipt.triangles} 面`);
      if (!problem) {
        const file = saveDesign(goal, config, rounds, spec, targetType);
        return { ok: true, spec, receipt, rationale, rounds, file };
      }
      console.log(`[设计代理] 第 ${round} 轮未通过：${problem}`);
      previous = { spec, receipt, error: problem };
    } catch (error) {
      rounds.push({ spec, rationale, error: error.message });
      console.log(`[设计代理] 第 ${round} 轮构建失败：${error.message}`);
      previous = { spec, error: error.message };
    }
  }

  const file = saveDesign(goal, config, rounds, null, targetType);
  return { ok: false, rounds, file, error: `达到 ${maxRounds} 轮仍未通过` };
}

async function main() {
  const args = process.argv.slice(2);
  let rounds = null;
  let targetType = 'hydrant';
  const goalParts = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--rounds') {
      rounds = args[i + 1];
      i += 1;
    } else if (args[i] === '--type') {
      targetType = args[i + 1];
      i += 1;
    } else {
      goalParts.push(args[i]);
    }
  }
  if (targetType !== 'hydrant' && targetType !== 'impeller') {
    console.error('[设计代理] --type 只支持 hydrant / impeller');
    process.exitCode = 1;
    return;
  }
  const goal = goalParts.join(' ')
    || (targetType === 'impeller'
      ? '设计一个镂空离心叶轮：单一连通实体，空心轮毂，8 片径向叶片，底盘带窗口，外径约 90mm。'
      : '设计一个镂空的消防栓：单一连通实体，内部空腔，6 个穿墙窗口，两侧接口，高度约 55–75mm。');

  try {
    console.log(`[设计代理] 目标：${goal}`);
    const result = await design(goal, { rounds, type: targetType });
    if (result.ok) {
      console.log(`[设计代理] 通过。设计文件：${path.relative(ROOT, result.file)}`);
      console.log(JSON.stringify(result.spec, null, 2));
      console.log(JSON.stringify(result.receipt, null, 2));
    } else {
      console.error(`[设计代理] 未通过：${result.error}`);
      console.error(`设计记录：${path.relative(ROOT, result.file)}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[设计代理] 失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseJsonObject, evaluateReceipt, sanitizeName, buildPrompt, design };
