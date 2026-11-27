'use strict';

const path = require('path');
const { spawn } = require('child_process');

// 本机兜底模型：Qwen3-0.6B（llm.asm 纯汇编引擎，Q8_0 量化）。
// 只在云端 API（含自定义 API 回退）全部失败后启用：把「模板一句话」换成真正生成的一句回复。
// Windows 经 WSL 调用，Linux 直接调用；失败 / 超时 / 并发占用一律返回 null，
// 由调用方退回原有模板兜底，绝不拖慢主链路。
//
// 环境变量：
//   LOCAL_LLM_FALLBACK=0        关闭兜底（默认开启）
//   LOCAL_LLM_BIN               二进制路径（默认 /root/llm-asm-audit/build/asm-llm）
//   LOCAL_LLM_MODEL             权重路径（默认 /root/llm-asm-audit/models/qwen3-0.6b-q8_0.asmbin）
//   LOCAL_LLM_THREADS           解码线程（默认 4）
//   LOCAL_LLM_CTX               上下文窗口（默认 2048）
//   LOCAL_LLM_MAX_TOKENS        单次生成上限（默认 96）
//   LOCAL_LLM_TIMEOUT_MS        超时（默认 60000）
//   LOCAL_LLM_MAX_PROMPT_CHARS  提示词字符预算（默认 420）
//   LOCAL_LLM_WSL               指定 WSL 发行版（默认系统默认发行版）
const DEFAULTS = {
  bin: '/root/llm-asm-audit/build/asm-llm',
  model: '/root/llm-asm-audit/models/qwen3-0.6b-q8_0.asmbin',
  threads: 4,
  context: 2048,
  maxTokens: 96,
  timeoutMs: 60000,
  maxPromptChars: 420
};

// 同一时刻只允许一个本地生成：0.6B 在 4 线程上跑满 CPU，排队只会让多条回复一起变慢
let busy = false;

function readInt(raw, fallback, min, max) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function getConfig() {
  const flag = String(process.env.LOCAL_LLM_FALLBACK || '1').toLowerCase();
  return {
    enabled: !(flag === '0' || flag === 'false' || flag === 'off'),
    bin: process.env.LOCAL_LLM_BIN || DEFAULTS.bin,
    model: process.env.LOCAL_LLM_MODEL || DEFAULTS.model,
    threads: readInt(process.env.LOCAL_LLM_THREADS, DEFAULTS.threads, 1, 64),
    context: readInt(process.env.LOCAL_LLM_CTX, DEFAULTS.context, 256, 32768),
    maxTokens: readInt(process.env.LOCAL_LLM_MAX_TOKENS, DEFAULTS.maxTokens, 1, 2048),
    timeoutMs: readInt(process.env.LOCAL_LLM_TIMEOUT_MS, DEFAULTS.timeoutMs, 1000, 300000),
    maxPromptChars: readInt(process.env.LOCAL_LLM_MAX_PROMPT_CHARS, DEFAULTS.maxPromptChars, 80, 4000)
  };
}

function isEnabled() {
  return getConfig().enabled;
}

// 单引号包裹，内部单引号按 shell 规则转义；路径来自配置，仍不给拼接留口子
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 提示词走环境变量传给 shell，不参与命令行解析，正文里的引号 / $ / 反引号都不会被展开
function buildCommand(cfg) {
  const script = `cd ${shQuote(path.posix.dirname(cfg.bin))}`
    + ` && exec ${shQuote(cfg.bin)} -m ${shQuote(cfg.model)}`
    + ` -t ${cfg.threads} -n ${cfg.maxTokens} -c ${cfg.context}`
    + ' --temp 0 -p "$LOCAL_LLM_PROMPT"';
  if (process.platform === 'win32') {
    const distro = process.env.LOCAL_LLM_WSL ? ['-d', process.env.LOCAL_LLM_WSL] : [];
    return ['wsl.exe', [...distro, '-e', 'bash', '-lc', script]];
  }
  return ['bash', ['-lc', script]];
}

function buildEnv(prompt) {
  const env = { ...process.env, LOCAL_LLM_PROMPT: prompt };
  if (process.platform === 'win32') {
    // WSL 只把 WSLENV 里列出的变量带进 Linux 侧，漏了这一步提示词会变成空串
    const existing = String(process.env.WSLENV || '').trim();
    env.WSLENV = existing ? `${existing}:LOCAL_LLM_PROMPT` : 'LOCAL_LLM_PROMPT';
  }
  return env;
}

// 兼容纯文本与多模态分段（图片段直接忽略），并把换行折平，避免小模型把排版当指令
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join(' ');
  }
  return '';
}

// 只取最近几轮对话拼一个极短提示词：
// 0.6B 在 293 token 的提示上 prefill 约 8.5 秒，超过 2000 token 要 80 秒以上，
// 所以系统提示词、记忆、工具清单一律不带，预算按字符硬卡。
function buildPrompt(messages, options = {}) {
  const maxChars = readInt(options.maxPromptChars, getConfig().maxPromptChars, 80, 4000);
  const list = Array.isArray(messages) ? messages : [];
  const turns = [];
  let used = 0;

  for (let i = list.length - 1; i >= 0 && turns.length < 6; i--) {
    const msg = list[i];
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const text = textOf(msg.content).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const room = maxChars - used;
    if (room <= 10) break;
    // 最近一条用户消息优先给足空间，更早的轮次只留一点语气上下文
    const cap = turns.length === 0 ? Math.min(260, room) : Math.min(90, room);
    turns.unshift({ role: msg.role, text: text.slice(0, cap) });
    used += Math.min(text.length, cap);
  }

  if (turns.length === 0) return '';
  const lines = ['请用简短自然的中文接着对话，只输出回复正文。'];
  for (const turn of turns) {
    lines.push(`${turn.role === 'user' ? '用户' : '你'}：${turn.text}`);
  }
  if (turns[turns.length - 1].role === 'user') lines.push('你：');
  return lines.join('\n');
}

// 引擎的计时行会和正文混在 stdout 里（[asm-llm] prefill: … / decode: …）；
// 同一行里计时出现在正文之后，所以按标记位置截断，保留前面的正文。
function cleanOutput(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => {
      const index = line.indexOf('[asm-llm]');
      // 整行都是计时信息时直接丢弃，避免在正文里留下空行
      if (index === 0) return null;
      return (index > 0 ? line.slice(0, index) : line).trimEnd();
    })
    .filter(line => line !== null)
    .join('\n')
    .trim();
}

function complete(prompt, options = {}) {
  const cfg = getConfig();
  if (!cfg.enabled) return Promise.resolve(null);
  const text = String(prompt || '').trim();
  if (!text) return Promise.resolve(null);
  if (busy) {
    console.warn('[本地兜底] 上一次生成尚未结束，跳过本次兜底');
    return Promise.resolve(null);
  }

  busy = true;
  return new Promise(resolve => {
    const spawnFn = typeof options.spawn === 'function' ? options.spawn : spawn;
    const [command, args] = buildCommand(cfg);
    let child;
    try {
      child = spawnFn(command, args, { env: buildEnv(text), windowsHide: true });
    } catch (error) {
      busy = false;
      console.warn('[本地兜底] 启动失败:', error.message);
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      busy = false;
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
      console.warn(`[本地兜底] 生成超时（${cfg.timeoutMs}ms），放弃本次兜底`);
      finish(null);
    }, cfg.timeoutMs);

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', chunk => { stdout += String(chunk); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', chunk => { stderr += String(chunk); });
    }
    child.on('error', error => {
      console.warn('[本地兜底] 调用失败:', error.message);
      finish(null);
    });
    child.on('close', code => {
      const reply = cleanOutput(stdout);
      if (code !== 0 || !reply) {
        if (stderr) console.warn('[本地兜底] 引擎退出', code, stderr.slice(0, 200));
        finish(null);
        return;
      }
      finish(reply);
    });
  });
}

async function completeFromMessages(messages, options = {}) {
  const prompt = buildPrompt(messages, options);
  if (!prompt) return null;
  const reply = await complete(prompt, options);
  if (!reply) return null;
  return reply.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  DEFAULTS,
  getConfig,
  isEnabled,
  buildPrompt,
  cleanOutput,
  complete,
  completeFromMessages
};
