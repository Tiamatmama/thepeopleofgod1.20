'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const localLLM = require('../src/core/localLLM');

// 假子进程：按需吐 stdout/stderr 再 close，测试不依赖 WSL 与本机模型
function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
}

test('buildPrompt：忽略 system / 工具消息，只带最近几轮并限制长度', () => {
  const messages = [
    { role: 'system', content: '这是一段很长的系统提示词，不应该进入本地兜底提示词' },
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '今天好累啊，想早点睡。' }
  ];
  const prompt = localLLM.buildPrompt(messages, { maxPromptChars: 420 });
  assert.ok(prompt.includes('用户：今天好累啊，想早点睡。'));
  assert.ok(prompt.includes('你：嗯'));
  assert.ok(prompt.endsWith('你：'));
  assert.ok(!prompt.includes('系统提示词'));
});

test('buildPrompt：单条过长时截断，不超字符预算', () => {
  const long = '啊'.repeat(1200);
  const prompt = localLLM.buildPrompt([{ role: 'user', content: long }], { maxPromptChars: 300 });
  assert.ok(prompt.length < 300);
});

test('cleanOutput：剔除 [asm-llm] 计时行，同一行计时只砍后半段', () => {
  const raw = [
    '今天也要好好吃饭。',
    '[asm-llm] prefill: 22 tok in 1209.85 ms (18.18 tok/s) [asm-llm] decode : 64 tok in 2601.49 ms',
    '晚安。 [asm-llm] decode : 4 tok in 100 ms'
  ].join('\n');
  const cleaned = localLLM.cleanOutput(raw);
  assert.equal(cleaned, '今天也要好好吃饭。\n晚安。');
});

test('isEnabled：默认开启，LOCAL_LLM_FALLBACK=0 关闭', (t) => {
  const original = process.env.LOCAL_LLM_FALLBACK;
  t.after(() => {
    if (original === undefined) delete process.env.LOCAL_LLM_FALLBACK;
    else process.env.LOCAL_LLM_FALLBACK = original;
  });

  delete process.env.LOCAL_LLM_FALLBACK;
  assert.equal(localLLM.isEnabled(), true);
  process.env.LOCAL_LLM_FALLBACK = '0';
  assert.equal(localLLM.isEnabled(), false);
});

test('complete：注入假进程时返回清洗后的正文', async () => {
  const reply = await localLLM.complete('用户：在吗\n你：', {
    spawn: () => fakeChild({ stdout: '在的，怎么啦？\n[asm-llm] decode : 6 tok in 200 ms' })
  });
  assert.equal(reply, '在的，怎么啦？');
});

test('complete：引擎非零退出返回 null', async () => {
  const reply = await localLLM.complete('用户：在吗\n你：', {
    spawn: () => fakeChild({ stderr: 'model not found', code: 2 })
  });
  assert.equal(reply, null);
});

test('complete：关闭时直接返回 null，不启动进程', async () => {
  const original = process.env.LOCAL_LLM_FALLBACK;
  process.env.LOCAL_LLM_FALLBACK = '0';
  let called = false;
  try {
    const reply = await localLLM.complete('用户：在吗', {
      spawn: () => { called = true; return fakeChild(); }
    });
    assert.equal(reply, null);
    assert.equal(called, false);
  } finally {
    if (original === undefined) delete process.env.LOCAL_LLM_FALLBACK;
    else process.env.LOCAL_LLM_FALLBACK = original;
  }
});
