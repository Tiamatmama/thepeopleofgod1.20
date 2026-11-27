// 目标 → SPEC 编译器（仿 Trae 的 plan/spec 阶段）。
//
// 为什么单独一层：闭环最大的失败模式不是写不出代码，而是「把目标理解错」——
// 用户说「实现和 X 一样的功能」，模型却只改适配层，然后用自写测试证明自己通过。
// 这里在动手前把目标压成一份可验收的 SPEC：能力清单、非目标、里程碑、验收方式。
// 后续每一轮都以 SPEC 为唯一权威，闭环结束再由独立 verifier 按 SPEC 审查。

const MAX_CAPABILITIES = 12;
const MAX_MILESTONES = 6;
const MAX_ITEMS = 8;

function text(value, limit) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** 生成 SPEC 用的提示词。只读、无工具：模型只能根据目标、记录和参考文档摘要做规划。 */
function buildSpecMessages({ goal, memoryText = '', referenceText = '' }) {
  const system = [
    '你是编码任务的需求编译器。把用户目标压成一份可验收的 SPEC，供后续自动编码闭环执行。',
    '规则：',
    '- 不要替用户扩大需求；目标没写的功能放进 nonGoals。',
    '- 每条 capability 必须有「可观察的验收方式」，不能写成“实现 X”这种空话。',
    '- 如果目标包含「实现和 X 一样的功能 / 替代 X」，capabilities 必须来自 X 的真实能力，不能只写适配层接线。',
    '- 只改适配层、或自定义一套与 X 无关的格式，不算满足；这类方案不要写进 capabilities。',
    '- 里程碑按依赖排序，每个里程碑小到能在一轮闭环内完成并验收。',
    '只输出 JSON，不要任何其它文字：',
    '{"goal":"...","capabilities":[{"id":"C1","name":"...","acceptance":"...","existing":false}],',
    '"nonGoals":["..."],"milestones":[{"id":"M1","title":"...","capabilities":["C1"],"acceptance":"..."}]}'
  ].join('\n');
  const user = [
    memoryText ? `【已有记录】\n${memoryText}` : '',
    referenceText ? `【参考实现摘要】\n${referenceText}` : '',
    `【本次目标】${text(goal, 1500)}`
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 容错解析：允许 ```json 包裹或前后废话。解析失败返回 null（fail-open 到旧流程）。 */
function parseSpec(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(s.slice(start, end + 1)); } catch (error) { return null; }
  if (!data || typeof data !== 'object') return null;

  const capabilities = list(data.capabilities).map((item, i) => {
    const it = item && typeof item === 'object' ? item : {};
    const name = text(it.name, 120);
    if (!name) return null;
    return {
      id: text(it.id, 12) || `C${i + 1}`,
      name,
      acceptance: text(it.acceptance, 240),
      existing: it.existing === true
    };
  }).filter(Boolean).slice(0, MAX_CAPABILITIES);
  if (!capabilities.length) return null;

  const ids = new Set(capabilities.map(c => c.id));
  const milestones = list(data.milestones).map((item, i) => {
    const it = item && typeof item === 'object' ? item : {};
    const title = text(it.title, 160);
    if (!title) return null;
    return {
      id: text(it.id, 12) || `M${i + 1}`,
      title,
      capabilities: list(it.capabilities).map(c => text(c, 12)).filter(c => ids.has(c)).slice(0, MAX_ITEMS),
      acceptance: text(it.acceptance, 300)
    };
  }).filter(Boolean).slice(0, MAX_MILESTONES);

  return {
    goal: text(data.goal, 500),
    capabilities,
    nonGoals: list(data.nonGoals).map(x => text(x, 160)).filter(Boolean).slice(0, MAX_ITEMS),
    milestones
  };
}

/** SPEC 是否可用：至少有能力，且至少一个里程碑。 */
function specIsUsable(spec) {
  return !!(spec && Array.isArray(spec.capabilities) && spec.capabilities.length
    && Array.isArray(spec.milestones) && spec.milestones.length);
}

/** 渲染成 Markdown，落盘到 .trae/SPEC.md，也用于注入 prompt。 */
function renderSpec(spec) {
  if (!specIsUsable(spec)) return '';
  const lines = [
    '# SPEC',
    '',
    `目标：${spec.goal || '—'}`,
    '',
    '## 能力清单',
    ...spec.capabilities.map(c => `- ${c.id} ${c.name}${c.existing ? '（已有）' : ''}：验收=${c.acceptance || '未写'}`),
    '',
    '## 非目标',
    ...(spec.nonGoals.length ? spec.nonGoals.map(x => `- ${x}`) : ['- （无）']),
    '',
    '## 里程碑',
    ...spec.milestones.map(m => `- ${m.id} ${m.title}（覆盖 ${m.capabilities.join(',') || '未标注'}）：验收=${m.acceptance || '未写'}`)
  ];
  return lines.join('\n');
}

/** 校验：跑完后的能力覆盖是否完整（由 verifier 调用，这里只做结构判断）。 */
function missingCapabilities(spec, coveredIds) {
  if (!specIsUsable(spec)) return [];
  const covered = new Set(list(coveredIds).map(x => text(x, 12)));
  return spec.capabilities.filter(c => !c.existing && !covered.has(c.id)).map(c => c.id);
}


module.exports = { buildSpecMessages, parseSpec, specIsUsable, renderSpec, missingCapabilities };

