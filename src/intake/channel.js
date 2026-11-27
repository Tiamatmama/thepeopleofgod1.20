'use strict';

// 开源方案准入通道：主进程侧的门面
//
// 调用方只跟这里打交道：vetSource() 拉起一个隔离子进程去拉取+分三段体检，
// 若结论落在「可疑」区间，再拉起第二个子进程做毒性复核——第二个进程手里
// 只有特征摘要，看不到原文，所以有害内容不会跟着判定链路流动。

const path = require('path');
const { spawn } = require('child_process');

const WORKER = path.join(__dirname, 'worker.js');

// 单行 JSON 请求 → 单行 JSON 响应；子进程退出/超时都会拒绝，不会挂死调用方
function callWorker(payload, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已经退出就不用管 */ }
      fn(value);
    };

    const timer = setTimeout(() => finish(reject, new Error('准入子进程超时')), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      const line = stdout.slice(0, newline).trim();
      try {
        finish(resolve, JSON.parse(line));
      } catch (error) {
        finish(reject, new Error(`子进程返回了非 JSON：${error.message}`));
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(reject, error));
    child.on('exit', (code) => {
      if (settled) return;
      const tail = stderr.trim().split('\n').slice(-3).join(' | ');
      finish(reject, new Error(`子进程退出 ${code}${tail ? `：${tail}` : ''}`));
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

function judgeEnabled() {
  return String(process.env.INTAKE_JUDGE || 'auto').toLowerCase() !== 'off';
}

// target:
//   { kind: 'github', repo: 'owner/name', path: 'README.md' }  —— 走白名单拉取
//   { kind: 'npm', package: 'left-pad' }
//   { content: '...', meta: { ... } }                          —— 已有内容（测试/离线）
// 返回：{ source, verdict, quarantine, review }
async function vetSource(target = {}, options = {}) {
  const payload = target.content !== undefined
    ? { action: 'scan', text: target.content, meta: target.meta || {} }
    : { action: 'fetch', target };

  const response = await callWorker(payload, { timeoutMs: options.timeoutMs || 60000 });
  if (!response.ok) throw new Error(response.error || '准入子进程失败');

  const result = response.result;
  let review = null;

  // 只在「可疑」区间花一次模型复核：干净的不必烧钱，明确有毒的直接拦
  if (judgeEnabled() && result.verdict && result.verdict.level === 'suspicious') {
    const judged = await callWorker(
      { action: 'judge', features: result.verdict },
      { timeoutMs: options.judgeTimeoutMs || 30000 }
    ).catch((error) => ({ ok: false, error: error.message }));

    review = judged && judged.ok ? judged.result.review : { ok: false, error: judged && judged.error };
  }

  return { ...result, review };
}

module.exports = { vetSource, callWorker };
