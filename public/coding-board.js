// 任务板 / 点子板 的纯视图逻辑（不触 DOM、可单测）。
// 浏览器里挂 window.CodingBoard；Node 里 require 到同一批函数。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodingBoard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TASK_STATUS_ORDER = ['todo', 'doing', 'done'];

  // 三态分组：状态非法/缺失一律归 todo（读不炸），同组内保持原序。
  function groupTasksByStatus(tasks) {
    const out = { todo: [], doing: [], done: [] };
    const list = Array.isArray(tasks) ? tasks : [];
    for (const task of list) {
      const status = task && TASK_STATUS_ORDER.indexOf(task.status) >= 0 ? task.status : 'todo';
      out[status].push(task);
    }
    return out;
  }

  // 把 taskId 投影成运行态：先看在跑的（currentAll），再回落历史（recent），都没有就 run:null。
  function summarizeRun(loopStatus, taskId) {
    const id = String(taskId || '');
    const status = loopStatus || {};
    const currentAll = Array.isArray(status.currentAll) ? status.currentAll : [];
    const running = currentAll.find(r => r && String(r.taskId || '') === id);
    if (running) return { running: true, run: running };
    const recent = Array.isArray(status.recent) ? status.recent : [];
    const last = recent.find(r => r && String(r.taskId || '') === id);
    if (last) return { running: false, run: last };
    return { running: false, run: null };
  }

  // 工作区治理：只读提示。超阈值时给出建议归档的 spike 产物（前缀 spike_），不做任何写操作。
  function governanceHint(workspaces, threshold = 30) {
    const list = Array.isArray(workspaces) ? workspaces : [];
    const total = list.length;
    const th = Number.isFinite(threshold) ? threshold : 30;
    const over = total >= th;
    const candidates = over
      ? list.filter(w => /^spike_/.test(String((w && w.taskId) || ''))).map(w => String(w.taskId || ''))
      : [];
    return { total, threshold: th, over, candidates };
  }

  const START_ERROR_TEXT = {
    not_found: '任务不存在或已被删除',
    forbidden: '这条任务不属于你，无法开跑',
    conflict: '这个工作区已经有闭环在跑了，先停或等它结束',
    done: '任务已完成，不再重复开跑',
    unsupported_kind: '这类任务不支持一键开跑（仅限 spike / 已验证实现的候选）'
  };

  // 把后端错误码翻成人话；未知码回落原始 error，两者都空时给个兜底。
  function startErrorText(code, error) {
    const text = START_ERROR_TEXT[String(code || '')];
    if (text) return text;
    const msg = String(error || '').trim();
    return msg || '开跑失败';
  }

  // 链接协议白名单：只放行 http/https，其余（javascript: / data: 等）一律丢弃，杜绝注入。
  function safeLinkHref(url) {
    const raw = String(url == null ? '' : url).trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? raw : '';
    } catch (e) {
      return '';
    }
  }

  // ISO 时效的安全格式化：不可解析/缺失一律给空串，避免渲染出 Invalid Date。
  function safeIso(v) {
    const s = String(v == null ? '' : v).trim();
    return Number.isFinite(Date.parse(s)) ? s : '';
  }

  // 把项目记忆 DTO 归一成安全渲染模型：字符串强转、数组兜底、进度倒序截断最近 N 条。
  function projectView(project, limit) {
    const n = (Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 20;
    const src = (project && typeof project === 'object') ? project : {};
    const goal = String(src.goal || '');
    const status = String(src.status || 'active');
    const all = (Array.isArray(src.progress) ? src.progress : []).map(p => {
      const it = (p && typeof p === 'object') ? p : {};
      return {
        at: String(it.at || ''),
        runId: String(it.runId || ''),
        status: String(it.status || ''),
        iterations: String(it.iterations == null ? '' : it.iterations),
        result: String(it.result || '')
      };
    });
    const lessons = (Array.isArray(src.lessons) ? src.lessons : []).map(l => {
      const it = (l && typeof l === 'object') ? l : {};
      return { at: String(it.at || ''), text: String(it.text || '') };
    });
    const total = all.length;
    const progress = all.slice().reverse().slice(0, n);   // 倒序：最新的在前
    return {
      goal,
      status,
      updatedAt: safeIso(src.updatedAt),
      progress,
      lessons,
      truncated: total > progress.length,
      total,
      hasMemory: !!(goal || total || lessons.length)
    };
  }

  // 一次评审的归一：{ kind, createdAt, findings:[{ personaId, persona, output, ok }] }。
  // output 是模型产物（不可信）：只做字符串强转；ok=false 表示该人格本轮调用失败
  // （后端约定占位文案「（<人格名> 调用失败：<msg>）」），据此禁用勾选、避免把失败文案立成任务。
  const REVIEW_FAIL_RE = /^（[\s\S]*失败[\s\S]*）$/;
  function reviewView(review) {
    const src = (review && typeof review === 'object') ? review : {};
    const list = Array.isArray(src.findings) ? src.findings : [];
    const findings = list.map(f => {
      const it = (f && typeof f === 'object') ? f : {};
      const output = String(it.output == null ? '' : it.output);
      return {
        personaId: String(it.personaId || ''),
        persona: String(it.persona || ''),
        output,
        ok: !REVIEW_FAIL_RE.test(output.trim())
      };
    });
    return {
      kind: String(src.kind || ''),
      createdAt: String(src.createdAt || ''),
      findings
    };
  }

  // 运行日志归一：入参已倒序（最新在前），只截最近 N 条并做字符串强转。
  function runsView(runs, limit) {
    const n = (Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 20;
    const list = Array.isArray(runs) ? runs : [];
    return list.slice(0, n).map(r => {
      const it = (r && typeof r === 'object') ? r : {};
      return {
        time: String(it.time || ''),
        script: String(it.script || ''),
        exitCode: String(it.exitCode == null ? '' : it.exitCode),
        success: it.success === true
      };
    });
  }

  // 巡检告警归一：{ id, createdAt, failedCount, findings:[{ persona, output }] }，只取最近 N 条。
  function alertsView(alerts, limit) {
    const n = (Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 10;
    const list = Array.isArray(alerts) ? alerts : [];
    return list.slice(0, n).map(a => {
      const it = (a && typeof a === 'object') ? a : {};
      const fs = Array.isArray(it.findings) ? it.findings : [];
      const failedCount = Number(it.failedCount);
      return {
        id: String(it.id || ''),
        createdAt: String(it.createdAt || ''),
        failedCount: Number.isFinite(failedCount) ? failedCount : 0,
        findings: fs.map(f => {
          const ff = (f && typeof f === 'object') ? f : {};
          return { persona: String(ff.persona || ''), output: String(ff.output == null ? '' : ff.output) };
        })
      };
    });
  }

  // 讨论结果归一：{ topic, orchestrator, transcript[], votes[], structured{consensus,divergences,actions}, synthesis }。
  // 全部字段来自模型产物（不可信）：只做字符串强转 / 数组兜底，缺段给空；脏项一律不炸。
  // transcript 按 kind 分成 speech / rebuttal / vote 三组，供「发言记录」分段渲染。
  function discussView(discussion) {
    const src = (discussion && typeof discussion === 'object') ? discussion : {};
    const rawTx = Array.isArray(src.transcript) ? src.transcript : [];
    const transcript = rawTx.map(t => {
      const it = (t && typeof t === 'object') ? t : {};
      const kind = String(it.kind || '');
      return {
        persona: String(it.persona || ''),
        personaId: String(it.personaId || ''),
        round: String(it.round == null ? '' : it.round),
        kind: (kind === 'rebuttal' || kind === 'vote') ? kind : 'speech',
        toName: String(it.toName || ''),
        text: String(it.text == null ? '' : it.text)
      };
    });
    const rawVotes = Array.isArray(src.votes) ? src.votes : [];
    const votes = rawVotes.map(v => {
      const it = (v && typeof v === 'object') ? v : {};
      return {
        persona: String(it.persona || ''),
        personaId: String(it.personaId || ''),
        stance: String(it.stance || ''),
        reason: String(it.reason || '')
      };
    });
    const structured = (src.structured && typeof src.structured === 'object') ? src.structured : {};
    const consensus = (Array.isArray(structured.consensus) ? structured.consensus : []).map(x => String(x));
    const actions = (Array.isArray(structured.actions) ? structured.actions : []).map(x => String(x));
    const rawDiv = Array.isArray(structured.divergences) ? structured.divergences : [];
    const divergences = rawDiv.map(d => {
      const it = (d && typeof d === 'object') ? d : {};
      const positions = (Array.isArray(it.positions) ? it.positions : []).map(p => {
        const pp = (p && typeof p === 'object') ? p : {};
        return { persona: String(pp.persona || ''), stance: String(pp.stance || '') };
      });
      return { topic: String(it.topic || ''), positions };
    });
    const speeches = transcript.filter(t => t.kind === 'speech');
    const rebuttals = transcript.filter(t => t.kind === 'rebuttal');
    const voteLines = transcript.filter(t => t.kind === 'vote');
    const synthesis = String(src.synthesis || '');
    return {
      id: String(src.id || ''),
      topic: String(src.topic || ''),
      orchestrator: String(src.orchestrator || ''),
      rounds: String(src.rounds == null ? '' : src.rounds),
      createdAt: safeIso(src.createdAt),
      transcript,
      speeches,
      rebuttals,
      voteLines,
      votes,
      consensus,
      divergences,
      actions,
      synthesis,
      hasContent: !!(transcript.length || votes.length || consensus.length || divergences.length || actions.length || synthesis)
    };
  }

  // 讨论记录 id 白名单：与服务端 DISCUSSION_ID_RE 一致（生产端为 disc_<ts>_<rand> / div_<ts>_<rand>）。
  const DISCUSS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function isDiscussRecordId(id) {
    return DISCUSS_ID_RE.test(String(id == null ? '' : id));
  }

  // 来源徽章文案：空 topic 回落固定文案，过长截断（完整 topic 走 title 提示）。
  function sourceBadgeLabel(topic) {
    const t = String(topic == null ? '' : topic).trim();
    if (!t) return '🗣 来源讨论';
    return '🗣 ' + (t.length > 18 ? t.slice(0, 18) + '…' : t);
  }

  // 「来源讨论」弹窗取数后归一：ok（有效）/ unavailable（记录不可用）/ error（请求失败）。
  // res 为 GET /discussions/:id 返回（命中 {success:true,discussion}；未命中 {success:false}）；err 为请求异常。
  function discussDetailView(res, err) {
    if (err) return { state: 'error', message: '加载失败：' + ((err && err.message) || '未知错误') };
    if (!res || res.success === false || !res.discussion) {
      return { state: 'unavailable', message: '来源讨论不可用（记录可能已被清理）。' };
    }
    return { state: 'ok', vm: discussView(res.discussion) };
  }

  // 长任务等待计时（深化九 M1）：把毫秒格式化成 mm:ss。
  // 只报「真实流逝时间」，负数/非法一律回落 00:00——绝不编造进度/百分比。
  function formatElapsed(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '00:00';
    const total = Math.floor(n / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return m + ':' + s;
  }

  // 长任务步进标签（深化十）：服务端 phase → 固定人话。未知/缺失一律空串（前端回落通用文案）。
  // 只映射已知枚举，绝不臆造步骤；phase 是「哪一段在跑」，不是百分比。
  const PROGRESS_LABELS = {
    speech: '各人格发言中',
    rebuttal: '定向反驳中',
    vote: '人格表决中',
    synthesis: '主控归纳中',
    review: '逐个抓点中'
  };
  function progressLabel(phase) {
    return PROGRESS_LABELS[String(phase == null ? '' : phase)] || '';
  }

  return { groupTasksByStatus, summarizeRun, governanceHint, startErrorText, safeLinkHref, projectView, reviewView, runsView, alertsView, discussView, isDiscussRecordId, sourceBadgeLabel, discussDetailView, formatElapsed, progressLabel };
});
