'use strict';

// 上下文缓存命中的统一口径（只读 usage，不估算）。
// - DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens
// - OpenAI 兼容通道（豆包 / Qwen 等）：prompt_tokens_details.cached_tokens
// 字段缺失时返回 null，调用方必须把 null 当「未知」而不是 0。

function toCount(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = toCount(usage.prompt_tokens);
  const details = (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object')
    ? usage.prompt_tokens_details
    : {};
  let hit = toCount(usage.prompt_cache_hit_tokens);
  if (hit === null) hit = toCount(details.cached_tokens);
  if (hit === null) hit = toCount(usage.cached_tokens);
  let miss = toCount(usage.prompt_cache_miss_tokens);
  // 只给了 cached_tokens 的通道：输入里没命中的部分即 miss
  if (miss === null && hit !== null && prompt !== null && prompt >= hit) miss = prompt - hit;

  let hitRate = null;
  if (hit !== null) {
    const denom = (prompt !== null && prompt > 0) ? prompt : (miss !== null && miss + hit > 0 ? hit + miss : null);
    if (denom) hitRate = hit / denom;
  }
  return { prompt, hit, miss, hitRate };
}

// 聚合多轮 usage：缺失的调用不参与命中率，prompt 只累计真实返回的输入量
function summarizeUsageList(list) {
  const items = Array.isArray(list) ? list : [];
  let prompt = 0;
  let hit = 0;
  let miss = 0;
  let hasCache = false;
  for (const item of items) {
    const stat = summarizeUsage(item);
    if (!stat) continue;
    if (stat.prompt !== null) prompt += stat.prompt;
    if (stat.hit !== null) { hit += stat.hit; hasCache = true; }
    if (stat.miss !== null) { miss += stat.miss; hasCache = true; }
  }
  const denom = prompt > 0 ? prompt : (hasCache ? hit + miss : 0);
  return {
    prompt,
    hit,
    miss,
    hitRate: hasCache && denom > 0 ? hit / denom : null
  };
}

function formatHitRate(hitRate) {
  return Number.isFinite(hitRate) ? `${(hitRate * 100).toFixed(1)}%` : '—';
}

// token 总量口径：只服务「预算熔断 / 竞赛排名」，不参与缓存命中统计。
// 输入输出字段名各通道不一致（OpenAI 兼容用 prompt/completion，Anthropic 用 input/output），
// 缺失一律返回 null，由调用方当「未知」处理，不估算、不补 0 糊过去。
function summarizeTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  let prompt = toCount(usage.prompt_tokens);
  if (prompt === null) prompt = toCount(usage.input_tokens);
  let completion = toCount(usage.completion_tokens);
  if (completion === null) completion = toCount(usage.output_tokens);
  if (prompt === null && completion === null) return null;
  const p = prompt === null ? 0 : prompt;
  const c = completion === null ? 0 : completion;
  return { prompt: p, completion: c, total: p + c };
}

// 聚合多轮 token：calls 只统计真正返回了 token 字段的调用次数
function sumTokens(list) {
  const items = Array.isArray(list) ? list : [];
  let prompt = 0;
  let completion = 0;
  let calls = 0;
  for (const item of items) {
    const stat = summarizeTokens(item);
    if (!stat) continue;
    prompt += stat.prompt;
    completion += stat.completion;
    calls++;
  }
  return { prompt, completion, total: prompt + completion, calls };
}

// 预算计费口径：只算「未命中缓存的输入 + 输出」。
// 缓存命中的 prompt 是每轮重发的同一段上下文，按全量计费会让长上下文任务在写代码前就熔断
// （实测 150k 预算里 120k 是缓存命中，真正花钱的 miss 只有 8k）。
// 缓存字段缺失时退回全量 prompt，不估算、不补 0。
function billableTokens(usage) {
  const tokens = summarizeTokens(usage);
  if (!tokens) return null;
  const stat = summarizeUsage(usage);
  const miss = stat && stat.miss !== null ? stat.miss : tokens.prompt;
  return miss + tokens.completion;
}

module.exports = { summarizeUsage, summarizeUsageList, summarizeTokens, sumTokens, billableTokens, formatHitRate };
