'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeUsage, summarizeUsageList, formatHitRate } = require('../src/core/usageStats');

test('summarizeUsage：DeepSeek 的 hit/miss 字段直接采用', () => {
  const stat = summarizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 80,
    total_tokens: 1080,
    prompt_cache_hit_tokens: 640,
    prompt_cache_miss_tokens: 360
  });
  assert.equal(stat.prompt, 1000);
  assert.equal(stat.hit, 640);
  assert.equal(stat.miss, 360);
  assert.equal(stat.hitRate, 0.64);
});

test('summarizeUsage：只给 cached_tokens 时按输入量反推 miss', () => {
  const stat = summarizeUsage({
    prompt_tokens: 500,
    prompt_tokens_details: { cached_tokens: 125 }
  });
  assert.equal(stat.hit, 125);
  assert.equal(stat.miss, 375);
  assert.equal(stat.hitRate, 0.25);
});

test('summarizeUsage：没有缓存字段时命中率为未知，不按 0 算', () => {
  const stat = summarizeUsage({ prompt_tokens: 300 });
  assert.equal(stat.prompt, 300);
  assert.equal(stat.hit, null);
  assert.equal(stat.miss, null);
  assert.equal(stat.hitRate, null);
});

test('summarizeUsage：空 usage / 非法值返回 null', () => {
  assert.equal(summarizeUsage(null), null);
  assert.equal(summarizeUsage(undefined), null);
  const stat = summarizeUsage({ prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 'x' });
  assert.equal(stat.hit, null);
  assert.equal(stat.miss, null);
  assert.equal(stat.hitRate, null);
});

test('summarizeUsageList：跳过缺失 usage，按真实输入量聚合', () => {
  const list = [
    { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 },
    null,
    { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800 }
  ];
  const total = summarizeUsageList(list);
  assert.equal(total.prompt, 2000);
  assert.equal(total.hit, 1000);
  assert.equal(total.miss, 1000);
  assert.equal(total.hitRate, 0.5);
});

test('summarizeUsageList：部分调用无缓存字段时，分母仍是全部输入', () => {
  const total = summarizeUsageList([
    { prompt_tokens: 1000, prompt_cache_hit_tokens: 500, prompt_cache_miss_tokens: 500 },
    { prompt_tokens: 1000 }
  ]);
  assert.equal(total.prompt, 2000);
  assert.equal(total.hitRate, 0.25);
});

test('summarizeUsageList：完全没有缓存数据时命中率为 null', () => {
  const total = summarizeUsageList([{ prompt_tokens: 100 }, {}]);
  assert.equal(total.prompt, 100);
  assert.equal(total.hit, 0);
  assert.equal(total.miss, 0);
  assert.equal(total.hitRate, null);
});

test('formatHitRate：未知显示 —，已知按百分比', () => {
  assert.equal(formatHitRate(null), '—');
  assert.equal(formatHitRate(0.6412), '64.1%');
});
