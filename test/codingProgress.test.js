'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingCenter = require('../src/core/coding');
const CodingTeam = require('../src/core/codingTeam');
const CodingBoard = require('../public/coding-board');

// 哲学协议 L0 观测默认开启（shadow），会给 discuss 追加「每条发言一次标注调用」。
// 本文件专注 discuss 主链相位/调用数，显式关掉观测，保证断言只针对讨论链本身。
process.env.CODING_PHILOSOPHY_LIFECYCLE = 'off';

// 深化十：discuss/review 步进可见性。覆盖域层 onProgress 相位序列 / 回调违约不拖垮主链 /
// 缺省行为不变 / 故障注入仍跑完；服务端两条 status 路由门禁；前端纯函数与禁 innerHTML。

function makeCenter(tag) {
  return new CodingCenter(fs.mkdtempSync(path.join(os.tmpdir(), `coding-progress-${tag}-`)));
}

const SECTION_JSON = '```json\n{"consensus":["c1"],"divergences":[],"actions":["a1"]}\n```';
const okApi = (captured) => ({
  callAPI: async (messages) => {
    if (captured) captured.push(messages);
    return { choices: [{ message: { content: SECTION_JSON } }] };
  }
});

// ---- 域层：discuss 相位序列 ----

test('discuss：默认先 5×speech → 5×vote → 3×synthesis，共 13 次且与调用数一一对应', async () => {
  const phases = [];
  const captured = [];
  const team = new CodingTeam({ coding: makeCenter('disc-phases'), skills: null, api: okApi(captured), sessionManager: null });

  await team.discuss({ topic: '要不要重构', onProgress: (e) => phases.push(e.phase) });

  assert.equal(captured.length, 13, '默认应恰好 13 次 LLM 调用');
  assert.deepEqual(phases, [
    'speech', 'speech', 'speech', 'speech', 'speech',
    'vote', 'vote', 'vote', 'vote', 'vote',
    'synthesis', 'synthesis', 'synthesis'
  ]);
});

test('discuss：带 rebuttals 时在发言与表决之间插入 rebuttal 相位', async () => {
  const phases = [];
  const captured = [];
  const team = new CodingTeam({ coding: makeCenter('disc-reb'), skills: null, api: okApi(captured), sessionManager: null });

  await team.discuss({
    topic: '要不要重构',
    rebuttals: [{ from: 'architect', to: 'security', point: '你漏了成本' }],
    onProgress: (e) => phases.push(e.phase)
  });

  assert.ok(phases.includes('rebuttal'), '定向反驳应上报 rebuttal 相位');
  assert.ok(phases.indexOf('rebuttal') > phases.lastIndexOf('speech'), 'rebuttal 应在所有发言之后');
  assert.ok(phases.indexOf('rebuttal') < phases.indexOf('vote'), 'rebuttal 应在表决之前');
});

test('discuss：onProgress 抛异常也不拖垮讨论链，仍跑完 13 次并正常返回', async () => {
  const captured = [];
  const team = new CodingTeam({ coding: makeCenter('disc-throw'), skills: null, api: okApi(captured), sessionManager: null });

  const result = await team.discuss({
    topic: '要不要重构',
    onProgress: () => { throw new Error('回调违约'); }
  });

  assert.equal(captured.length, 13);
  assert.ok(result && typeof result.id === 'string' && result.id.startsWith('disc_'));
  assert.equal(result.transcript.length, 10, '5 发言 + 5 表决记录（归纳不并入 transcript）');
});

test('discuss：不带 onProgress 时行为与旧版一致（13 次调用、返回形状不变）', async () => {
  const captured = [];
  const team = new CodingTeam({ coding: makeCenter('disc-default'), skills: null, api: okApi(captured), sessionManager: null });

  const result = await team.discuss({ topic: '要不要重构' });

  assert.equal(captured.length, 13);
  assert.equal(typeof result.id, 'string');
  assert.equal(result.topic, '要不要重构');
  assert.equal(result.votes.length, 5);
  assert.equal(typeof result.synthesis, 'string');
});

// ---- 域层：review 相位 + 故障注入 ----

test('review：每个人格调用前上报一次 review 相位', async () => {
  const phases = [];
  const team = new CodingTeam({ coding: makeCenter('rev-phases'), skills: null, api: okApi(), sessionManager: null });

  await team.review({ target: 'code', onProgress: (e) => phases.push(e.phase) });

  assert.deepEqual(phases, ['review', 'review', 'review', 'review', 'review']);
});

test('故障注入：discuss 中途某次调用抛错，讨论仍跑完并返回完整结果', async () => {
  let n = 0;
  const api = {
    callAPI: async () => {
      n += 1;
      if (n === 6) throw new Error('boom'); // 第 6 次＝第一次表决，链内已兜底
      return { choices: [{ message: { content: SECTION_JSON } }] };
    }
  };
  const team = new CodingTeam({ coding: makeCenter('disc-fault'), skills: null, api, sessionManager: null });

  const result = await team.discuss({ topic: '要不要重构' });

  assert.equal(n, 13, '单次失败不应中断串行链，13 次调用照跑');
  assert.equal(result.votes[0].stance, '未表态', '失败表决落「未表态」占位');
  assert.equal(result.votes.length, 5);
});

test('故障注入：review 首个调用抛错，评审仍返回全部人格结果（失败留痕不中断）', async () => {
  let n = 0;
  const api = {
    callAPI: async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { choices: [{ message: { content: 'ok' } }] };
    }
  };
  const team = new CodingTeam({ coding: makeCenter('rev-fault'), skills: null, api, sessionManager: null });

  const result = await team.review({ target: 'code' });

  assert.equal(n, 5, '每个人格各一次调用，失败不中断');
  assert.equal(result.findings.length, 5);
  assert.ok(result.findings[0].output.includes('调用失败'), '失败人格应留痕');
});

// ---- 前端纯函数：progressLabel ----

test('progressLabel：已知 phase → 固定人话，未知 / 缺失 → 空串', () => {
  assert.equal(CodingBoard.progressLabel('speech'), '各人格发言中');
  assert.equal(CodingBoard.progressLabel('rebuttal'), '定向反驳中');
  assert.equal(CodingBoard.progressLabel('vote'), '人格表决中');
  assert.equal(CodingBoard.progressLabel('synthesis'), '主控归纳中');
  assert.equal(CodingBoard.progressLabel('review'), '逐个抓点中');

  assert.equal(CodingBoard.progressLabel('nope'), '');
  assert.equal(CodingBoard.progressLabel(''), '');
  assert.equal(CodingBoard.progressLabel(null), '');
  assert.equal(CodingBoard.progressLabel(undefined), '');
});

// ---- 服务端：两条 status 路由门禁 + POST 清键 ----

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'index.js'), 'utf8');
// 编程沙箱路由已抽到独立模块，路由级断言改读该模块源码（PROGRESS_ID_RE 声明仍留在 index.js）。
const CODING_ROUTES_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'routes', 'coding.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'coding.html'), 'utf8');

function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return '';
  const j = src.indexOf(endMarker, i + startMarker.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

test('服务端：声明进度 id 白名单，两条 status 路由都过 requireCodingUser + 白名单，未知回 busy:false', () => {
  assert.match(SERVER_SRC, /const PROGRESS_ID_RE = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/, '应声明进度 id 白名单');

  const discuss = sliceBetween(CODING_ROUTES_SRC, "app.get('/api/coding/discuss/status'", "app.post('/api/coding/review'");
  assert.ok(discuss, '应存在 discuss/status 路由');
  assert.match(discuss, /requireCodingUser/, 'discuss/status 应过编程沙箱门禁');
  assert.match(discuss, /PROGRESS_ID_RE\.test\(/, 'discuss/status 应校验 id 白名单');
  assert.match(discuss, /status\(400\)/, '非法 id 应 400');
  assert.match(discuss, /busy: false/, '未知/已结束应回 busy:false');

  const review = sliceBetween(CODING_ROUTES_SRC, "app.get('/api/coding/review/status'", "app.post('/api/coding/review/commit'");
  assert.ok(review, '应存在 review/status 路由');
  assert.match(review, /requireCodingUser/);
  assert.match(review, /PROGRESS_ID_RE\.test\(/);
  assert.match(review, /status\(400\)/);
  assert.match(review, /busy: false/);
});

test('服务端：POST discuss/review 读 clientToken 注入 onProgress，finally 清键', () => {
  const discuss = sliceBetween(CODING_ROUTES_SRC, "app.post('/api/coding/discuss'", "app.get('/api/coding/discuss/status'");
  assert.ok(discuss);
  assert.match(discuss, /normalizeProgressToken\(body\.clientToken\)/, 'discuss 应读 clientToken');
  assert.match(discuss, /onProgress:/, 'discuss 应注入 onProgress');
  assert.match(discuss, /finally/, 'discuss 应 finally 清键');
  assert.match(discuss, /discussProgress\.end\(token\)/, 'discuss 结束时清进度键');

  const review = sliceBetween(CODING_ROUTES_SRC, "app.post('/api/coding/review'", "app.get('/api/coding/review/status'");
  assert.ok(review);
  assert.match(review, /normalizeProgressToken\(body\.clientToken\)/);
  assert.match(review, /onProgress:/);
  assert.match(review, /reviewProgress\.end\(token\)/);
});

// ---- 前端：轮询客户端关联 id + 禁 innerHTML ----

test('前端：讨论/评审带 clientToken 并在飞时轮询 status，2.5s 间隔，无 innerHTML', () => {
  assert.match(HTML_SRC, /function genProgressId\(/, '应有客户端关联 id 生成器');
  assert.match(HTML_SRC, /function startProgressPoll\(/, '应有轮询封装');
  assert.match(HTML_SRC, /PROGRESS_POLL_MS = 2500/, '轮询间隔应为 2.5s');
  assert.match(HTML_SRC, /CodingBoard\.progressLabel\(/, '应复用纯函数把 phase 转人话');

  const poll = sliceBetween(HTML_SRC, 'function startProgressPoll(', '// ===== 评审面板');
  assert.ok(poll.length > 0);
  assert.ok(!/innerHTML/.test(poll), 'startProgressPoll 不得使用 innerHTML');

  const discuss = sliceBetween(HTML_SRC, 'async function runDiscuss(', 'function discussLine(');
  assert.ok(discuss.length > 0);
  assert.match(discuss, /clientToken/, 'runDiscuss 应带 clientToken 上行');
  assert.match(discuss, /\/api\/coding\/discuss\/status/, 'runDiscuss 应轮询 discuss/status');
  assert.match(discuss, /stopPoll\(\)/, 'runDiscuss 应在 finally 停止轮询');
  assert.ok(!/innerHTML/.test(discuss), 'runDiscuss 不得使用 innerHTML');

  const review = sliceBetween(HTML_SRC, 'async function runReview(', 'function renderReviewResult(');
  assert.ok(review.length > 0);
  assert.match(review, /clientToken/, 'runReview 应带 clientToken 上行');
  assert.match(review, /\/api\/coding\/review\/status/, 'runReview 应轮询 review/status');
  assert.match(review, /stopPoll\(\)/, 'runReview 应在 finally 停止轮询');
  assert.ok(!/innerHTML/.test(review), 'runReview 不得使用 innerHTML');
});
