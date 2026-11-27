'use strict';

// 编程人格进化 CLI（无交互，退出码：0 成功 / 2 输入、状态或回放闸未过）。
//
// 两条入口：
//   A. 模型提议（推荐）：
//      signal（失败证据落盘，不调模型）→ suggest（一次复盘调用写出候选教训）
//      → verify / reject（人只做否决）→ 教训按当轮任务临时召回，不进系统提示
//      node scripts/persona-evolve.js signal --persona qa --kind test-failure --material "..."
//      node scripts/persona-evolve.js suggest --persona qa
//      node scripts/persona-evolve.js verify --id cand-xxxx --by operator
//   B. 手动记教训（第一次必须走这条，自动合并才能接管）：
//      record → propose → replay → approve → rollback
//      node scripts/persona-evolve.js record --persona qa --focus 3 --claim "..." --truth "..." \
//           --lesson "..." --source "user-feedback:2026-10-17" --verified
//      node scripts/persona-evolve.js propose --persona qa
//      node scripts/persona-evolve.js replay --id pev-xxxx --cases replay-cases.json --by operator
//      node scripts/persona-evolve.js approve --id pev-xxxx --by operator
//      node scripts/persona-evolve.js prompt --persona qa --task "补测试"
//                                                             # 看人格提示 + 这一轮会带哪条经验
//      node scripts/persona-evolve.js rollback --persona qa --by operator
//
// replay 用例文件：非空 JSON 数组（或 { "cases": [...] }），每项
//   { "input": "当时那段材料", "shouldFlag": true|false, "note": "可选" }
// shouldFlag=true 表示「这个补丁该让这个抓点报警」，false 是正常样本（不该误报）。

const fs = require('fs');
const path = require('path');
require('../src/core/config');
const { UnifiedAPI } = require('../src/core/api');
const {
  buildSuggestMessages,
  parseCandidateDraft,
  selectLessons,
  buildRecallLine
} = require('../src/core/personaEvolution');
const { PERSONAS } = require('../src/core/codingTeam');
const CodingTeam = require('../src/core/codingTeam');
const { PersonaEvolutionStore } = require('../src/core/personaEvolutionStore');

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positional, flags };
}

function personaOf(id) {
  const key = String(id || '').trim().toLowerCase();
  return PERSONAS.find((item) => item.id === key) || null;
}

function requireFlag(flags, key) {
  const value = flags[key];
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new Error(`缺少 --${key}`);
  }
  return String(value).trim();
}

function printChecks(proposal) {
  for (const check of proposal.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.key}${check.detail ? ` — ${check.detail}` : ''}`);
  }
}

function commandStatus(store) {
  const status = store.status();
  console.log(`dir: ${status.dir}`);
  for (const item of status.personas) {
    const active = item.active ? `${item.active.proposalId} @ ${item.active.appliedAt}` : '无';
    console.log(`${item.personaId}\t教训=${item.lessons}\t撤销=${item.revoked}\t生效补丁=${active}`);
  }
  console.log(`历史补丁=${status.history}`);
}

function commandRecord(store, flags) {
  const persona = personaOf(requireFlag(flags, 'persona'));
  if (!persona) throw new Error(`不认识的编程人格：${flags.persona}`);
  const input = {
    personaId: persona.id,
    focusIndex: flags.focus,
    claim: requireFlag(flags, 'claim'),
    truth: requireFlag(flags, 'truth'),
    lesson: requireFlag(flags, 'lesson'),
    source: requireFlag(flags, 'source'),
    verified: flags.verified === true || flags.verified === 'true'
  };
  const lesson = store.appendLesson(input, { persona });
  console.log(`recorded ${lesson.id} persona=${lesson.personaId} focus=${lesson.focusIndex} attribution=${lesson.attribution}`);
  console.log(`抓点：${lesson.focusText}`);
}

function commandPropose(store, flags) {
  const targets = String(flags.persona || '').trim() === 'all'
    ? PERSONAS
    : [personaOf(requireFlag(flags, 'persona'))].filter(Boolean);
  if (!targets.length) throw new Error(`不认识的编程人格：${flags.persona}`);
  for (const persona of targets) {
    const proposal = store.createProposal(persona.id, { persona });
    console.log(`${proposal.id} persona=${proposal.personaId} verdict=${proposal.verdict} status=${proposal.status}`);
    printChecks(proposal);
    if (proposal.patch.block) {
      console.log('--- 补丁预览 ---');
      console.log(proposal.patch.block);
    }
  }
}

function commandApprove(store, flags) {
  const proposal = store.approve(requireFlag(flags, 'id'), { approvedBy: requireFlag(flags, 'by') });
  console.log(`approved ${proposal.id} persona=${proposal.personaId} appliedAt=${proposal.appliedAt} by=${proposal.approvedBy}`);
}

// 用真实拼装顺序生成提示，避免手工拼字符串和 buildPersonaPrompt 漂移。
// 系统提示已不带教训，所以基线就是人格提示原文；候选 = 基线 + 待审补丁块，供回放对比。
function buildPrompt(persona, block) {
  const team = new CodingTeam({
    coding: null,
    skills: null,
    api: null,
    sessionManager: null,
    personaEvolution: null
  });
  const base = team.buildPersonaPrompt(persona);
  return block == null ? base : `${base}\n\n${block}`;
}

function loadReplayCases(file) {
  const target = path.resolve(String(file));
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    throw new Error(`读不到用例文件 ${target}：${error.message}`, { cause: error });
  }
  // PowerShell 的 Set-Content/Out-File 默认带 BOM，JSON.parse 会直接炸
  raw = raw.replace(/^\uFEFF/, '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`用例文件不是合法 JSON：${target}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.cases) ? parsed.cases : null);
  if (!list || !list.length) throw new Error('用例文件需要是非空数组（或 { "cases": [...] }）');
  list.forEach((item, index) => {
    const no = index + 1;
    if (!item || typeof item.input !== 'string' || !item.input.trim()) throw new Error(`第 ${no} 个用例缺 input`);
    if (typeof item.shouldFlag !== 'boolean') throw new Error(`第 ${no} 个用例缺 shouldFlag（布尔）`);
  });
  return list;
}

// 模型判断「这段材料下你会不会指出问题」，只认是/否，压低温避免自由发挥。
// 通道按需创建：用例/提案先校验完，再真正发请求。
function makeModelJudge() {
  let api = null;
  return async (prompt, item) => {
    if (!api) api = new UnifiedAPI();
    const result = await api.callAPI([
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: `下面是一段待审材料。按你上面的职责与抓点，你会不会明确指出其中的问题？\n只回答一个字：「是」或「否」。\n\n${item.input}`
      }
    ], null, { temperature: 0, maxTokens: 8 });
    const text = String(result?.choices?.[0]?.message?.content || '').replace(/[\s「」"'“”‘’。.，,、：:]/g, '');
    return text.startsWith('是');
  };
}

function fmtMetric(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

async function commandReplay(store, flags) {
  const proposal = store.readProposal(requireFlag(flags, 'id'));
  const persona = personaOf(proposal.personaId);
  if (!persona) throw new Error(`提案里的人格不认识：${proposal.personaId}`);
  const cases = loadReplayCases(requireFlag(flags, 'cases'));
  const replay = await store.replay(proposal.id, {
    cases,
    baselinePrompt: buildPrompt(persona, null),
    candidatePrompt: buildPrompt(persona, proposal.patch.block),
    judge: makeModelJudge(),
    by: requireFlag(flags, 'by')
  });
  console.log(`replay ${proposal.id} persona=${proposal.personaId} verdict=${replay.verdict} 用例=${replay.sampleSize}`);
  console.log(`  baseline recall=${fmtMetric(replay.baseline.recall)} fpr=${fmtMetric(replay.baseline.falsePositiveRate)} chars=${replay.baseline.promptChars}`);
  console.log(`  candidate recall=${fmtMetric(replay.candidate.recall)} fpr=${fmtMetric(replay.candidate.falsePositiveRate)} chars=${replay.candidate.promptChars}`);
  for (const reason of replay.reasons) console.log(`  ! ${reason}`);
  if (replay.verdict !== 'pass') process.exitCode = 2;
}

function commandRollback(store, flags) {
  const result = store.rollback(requireFlag(flags, 'persona'), { by: String(flags.by || '') });
  if (!result.success) throw new Error(result.error);
  console.log(`rolled back persona=${result.personaId} proposal=${result.proposalId}`);
}

function commandRevoke(store, flags) {
  const lessonId = requireFlag(flags, 'id');
  const result = store.revokeLesson(lessonId, { by: String(flags.by || '') });
  console.log(`revoked ${result.id}`);
}

function commandSignal(store, flags) {
  const persona = personaOf(requireFlag(flags, 'persona'));
  if (!persona) throw new Error(`不认识的编程人格：${flags.persona}`);
  const signal = store.recordSignal({
    personaId: persona.id,
    kind: String(flags.kind || 'other'),
    material: requireFlag(flags, 'material'),
    sessionId: String(flags.session || '')
  });
  console.log(`signal ${signal.id} persona=${signal.personaId} kind=${signal.kind}`);
}

// 复盘调用按需创建：没有待处理信号时一次请求都不发
function makeModelCaller() {
  let api = null;
  return async (messages) => {
    if (!api) api = new UnifiedAPI();
    return api.callAPI(messages, null, { temperature: 0.2, maxTokens: 600 });
  };
}

// 模型自己提议：把待处理的失败信号交给它写成候选教训。
// 候选只是草稿（verified=false），人不 verify 就永远进不了提示。
async function commandSuggest(store, flags) {
  const persona = personaOf(requireFlag(flags, 'persona'));
  if (!persona) throw new Error(`不认识的编程人格：${flags.persona}`);
  const limit = Math.max(1, Math.min(20, Number(flags.limit) || 8));
  const pending = store.listSignals(persona.id, { pendingOnly: true }).slice(-limit);
  if (!pending.length) {
    console.log(`没有待复盘的信号（persona=${persona.id}）`);
    return;
  }

  const messages = buildSuggestMessages({
    persona,
    signals: pending,
    existing: store.listLessons(persona.id).filter((item) => !item.revoked)
  });
  const result = await makeModelCaller()(messages);
  const draft = parseCandidateDraft(result?.choices?.[0]?.message?.content || '');
  if (!draft) throw new Error('模型没有返回可解析的 JSON，信号保持待处理');

  const signalIds = pending.map((item) => item.id);
  if (draft.none) {
    store.consumeSignals(signalIds);
    console.log(`这批记录没有值得固化的失误，已标记 ${signalIds.length} 条信号`);
    return;
  }

  const candidate = store.appendCandidate(draft, { persona, signalIds });
  store.consumeSignals(signalIds);
  console.log(`candidate ${candidate.id} persona=${candidate.personaId} focus=${candidate.focusIndex || '未定'} attribution=${candidate.attribution}`);
  console.log(`  claim: ${candidate.claim}`);
  console.log(`  truth: ${candidate.truth}`);
  console.log(`  lesson: ${candidate.lesson}`);
  console.log(`确认：verify --id ${candidate.id} --by <你的名字>；否决：reject --id ${candidate.id} --by <你的名字>`);
}

function commandCandidates(store, flags) {
  const list = store.listCandidates(String(flags.persona || ''));
  if (!list.length) {
    console.log('没有候选教训');
    return;
  }
  for (const item of list) {
    console.log(`${item.id}\t${item.personaId}\t${item.status}\tfocus=${item.focusIndex || '?'}\t${item.lesson}`);
  }
}

function commandVerify(store, flags) {
  const id = requireFlag(flags, 'id');
  const pending = store.listCandidates().find((item) => item.id === id && item.status === 'pending');
  if (!pending) throw new Error(`没有待确认的候选：${id}`);
  const persona = personaOf(pending.personaId);
  if (!persona) throw new Error(`候选里的人格不认识：${pending.personaId}`);
  const result = store.verifyCandidate(id, {
    by: requireFlag(flags, 'by'),
    persona,
    focusIndex: flags.focus == null ? null : flags.focus
  });
  console.log(`verified ${id} → lesson=${result.lesson.id} persona=${result.lesson.personaId} focus=${result.lesson.focusIndex} attribution=${result.lesson.attribution}`);
}

function commandReject(store, flags) {
  const result = store.rejectCandidate(requireFlag(flags, 'id'), {
    by: requireFlag(flags, 'by'),
    reason: String(flags.reason || '')
  });
  console.log(`rejected ${result.id}`);
}

function commandPrompt(store, flags) {
  const persona = personaOf(requireFlag(flags, 'persona'));
  if (!persona) throw new Error(`不认识的编程人格：${flags.persona}`);
  const team = new CodingTeam({
    coding: null,
    skills: null,
    api: null,
    sessionManager: null,
    personaEvolution: store
  });
  console.log(team.buildPersonaPrompt(persona));
  // 教训不在系统提示里：这里按 --task 预演「这一轮会想起哪条经验」（只读，不记强化）
  const task = String(flags.task || '').trim();
  const preview = buildRecallLine(selectLessons(store.listLessons(persona.id), task, { limit: 2 }));
  console.log('\n--- 当轮经验（拼在 user 内容最前面，不进系统提示） ---');
  console.log(preview || '（本轮没有命中任何教训）');
}

async function main() {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const command = positional[0] || 'status';
  const store = new PersonaEvolutionStore({
    dir: process.env.CODING_PERSONA_EVOLUTION_DIR || undefined
  });
  switch (command) {
    case 'status': commandStatus(store); break;
    case 'record': commandRecord(store, flags); break;
    case 'signal': commandSignal(store, flags); break;
    case 'suggest': await commandSuggest(store, flags); break;
    case 'candidates': commandCandidates(store, flags); break;
    case 'verify': commandVerify(store, flags); break;
    case 'reject': commandReject(store, flags); break;
    case 'propose': commandPropose(store, flags); break;
    case 'replay': await commandReplay(store, flags); break;
    case 'approve': commandApprove(store, flags); break;
    case 'rollback': commandRollback(store, flags); break;
    case 'revoke': commandRevoke(store, flags); break;
    case 'prompt': commandPrompt(store, flags); break;
    default:
      console.error(`未知命令：${command}`);
      console.error('可用：status | record | signal | suggest | candidates | verify | reject | propose | replay | approve | rollback | revoke | prompt');
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 2;
});
