'use strict';

/**
 * MCP stdio 客户端（零依赖）
 *
 * 取景器的第一步是「把参考界面量准」，量尺在 windows-mcp 这个 sidecar 里。
 * 这里只做一件事：把 sidecar 拉起来，按 MCP 的 newline-delimited JSON-RPC
 * 完成 initialize → tools/call，用完回收。不引 MCP SDK：主项目只允许用
 * Node 内置模块跟 sidecar 说话，sidecar 自己管自己的 Python 依赖。
 */

const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const DEFAULT_COMMAND = 'uvx';
const DEFAULT_ARGS = ['windows-mcp', 'serve'];
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'tgp-design', version: '0.1.0' };
// uvx 首次可能要下载/解压依赖，启动超时给宽一点；单次工具调用另算
const START_TIMEOUT_MS = 120000;
const CALL_TIMEOUT_MS = 120000;
const MAX_STDERR_TAIL = 4000;

function killTree(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      process.kill(Number(pid), 'SIGKILL');
    }
  } catch {
    /* 进程可能已经退出 */
  }
}

/**
 * 从环境变量解析 sidecar 启动方式。
 * 默认 `uvx windows-mcp serve`；指向本地仓库时用
 * DESIGN_MCP_ARGS='["uv","--directory","C:\\\\path\\\\Windows-MCP","run","windows-mcp","serve"]'
 */
function resolveMcpConfig(env = process.env) {
  const command = String(env.DESIGN_MCP_COMMAND || '').trim() || DEFAULT_COMMAND;
  let args = DEFAULT_ARGS.slice();
  if (env.DESIGN_MCP_ARGS) {
    let parsed;
    try {
      parsed = JSON.parse(env.DESIGN_MCP_ARGS);
    } catch {
      throw new Error('DESIGN_MCP_ARGS 必须是 JSON 字符串数组');
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('DESIGN_MCP_ARGS 必须是 JSON 字符串数组');
    }
    args = parsed;
  }
  return { command, args };
}

class McpStdioClient {
  constructor({
    command,
    args = [],
    env = {},
    startTimeoutMs = START_TIMEOUT_MS,
    callTimeoutMs = CALL_TIMEOUT_MS,
  } = {}) {
    if (!command) throw new Error('MCP 客户端缺少启动命令');
    this.command = command;
    this.args = args;
    this.env = env;
    this.startTimeoutMs = startTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.child = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = '';
    this.exited = false;
    this.exitInfo = '';
    this.ready = false;
  }

  async start() {
    if (this.child) return this;

    const child = spawn(this.command, this.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 遥测默认关掉：这是本机工具，不该往外发任何东西
      env: { ...process.env, ANONYMIZED_TELEMETRY: 'false', ...this.env },
    });
    this.child = child;

    child.on('error', (error) => {
      this._failAll(new Error(`MCP sidecar 启动失败：${error.message}`));
    });
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = `code=${code} signal=${signal}`;
      this._failAll(new Error(`MCP sidecar 已退出（${this.exitInfo}）${this._tail()}`));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this._onLine(line));

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, this.startTimeoutMs);

    this._write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true;
    return this;
  }

  _tail() {
    const tail = this.stderrTail.trim();
    return tail ? `\n${tail.slice(-800)}` : '';
  }

  _write(payload) {
    if (!this.child || this.exited) {
      throw new Error(`MCP sidecar 不可写（${this.exitInfo || '未启动'}）`);
    }
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      throw new Error(`MCP sidecar 写入失败：${error.message}`, { cause: error });
    }
  }

  _onLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // 非协议输出（启动横幅、告警）不参与匹配
      return;
    }
    if (!message || message.id == null || !this.pending.has(message.id)) return;

    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.error) {
      const detail = message.error.message || JSON.stringify(message.error);
      entry.reject(new Error(`MCP 调用失败：${detail}`));
      return;
    }
    entry.resolve(message.result);
  }

  _failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  request(method, params, timeoutMs = this.callTimeoutMs) {
    if (this.exited) {
      return Promise.reject(new Error(`MCP sidecar 已退出（${this.exitInfo}）`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 调用超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async callTool(name, args = {}, timeoutMs = this.callTimeoutMs) {
    if (!this.ready) await this.start();
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (result && result.isError) {
      throw new Error(`MCP 工具 ${name} 执行失败：${collectText(result).slice(0, 400)}`);
    }
    return result || { content: [] };
  }

  close() {
    this._failAll(new Error('MCP sidecar 已关闭'));
    this.ready = false;
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* 忽略 */
      }
      killTree(this.child.pid);
      this.child = null;
    }
  }
}

/** 取 MCP 工具结果里的纯文本（多段拼起来） */
function collectText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

/** 取 MCP 工具结果里的第一张图片（base64） */
function collectImage(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  const image = content.find((item) => item && item.type === 'image' && item.data);
  if (!image) return null;
  return { data: image.data, mimeType: image.mimeType || 'image/png' };
}

module.exports = {
  McpStdioClient,
  resolveMcpConfig,
  collectText,
  collectImage,
  killTree,
  constants: {
    DEFAULT_COMMAND,
    DEFAULT_ARGS,
    PROTOCOL_VERSION,
    START_TIMEOUT_MS,
    CALL_TIMEOUT_MS,
  },
};
