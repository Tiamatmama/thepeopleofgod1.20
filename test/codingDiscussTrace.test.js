'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CodingBoard = require('../public/coding-board');

// 深化八：② 溯源前半（任务卡片「来源讨论」徽章 + 只读弹窗）+ getDiscussion :id 白名单。
// 覆盖：纯视图函数四态 / 客户端-服务端白名单一致 / 前端禁 innerHTML 门禁。

// 编程沙箱路由（含 :id 白名单）已抽到独立模块，改读该模块源码。
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'routes', 'coding.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'coding.html'), 'utf8');

// 截取 [startMarker, endMarker) 之间的源码切片（找不到返回空串）。
function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return '';
  const j = src.indexOf(endMarker, i + startMarker.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

// ---- 纯视图函数：id 白名单（与服务端同一条正则）----

test('isDiscussRecordId：只放行 disc_/div_ 格式，拒绝穿越、空白、超长、异常字符', () => {
  assert.equal(CodingBoard.isDiscussRecordId('disc_123_ab'), true);
  assert.equal(CodingBoard.isDiscussRecordId('div_123_ab'), true);
  assert.equal(CodingBoard.isDiscussRecordId('a-b_C9'), true);
  assert.equal(CodingBoard.isDiscussRecordId('x'.repeat(64)), true);

  assert.equal(CodingBoard.isDiscussRecordId(''), false);
  assert.equal(CodingBoard.isDiscussRecordId(null), false);
  assert.equal(CodingBoard.isDiscussRecordId(undefined), false);
  assert.equal(CodingBoard.isDiscussRecordId('..'), false, '单段 .. 应被拒（basename 不消除）');
  assert.equal(CodingBoard.isDiscussRecordId('../secret'), false);
  assert.equal(CodingBoard.isDiscussRecordId('a/b'), false);
  assert.equal(CodingBoard.isDiscussRecordId('a b'), false, '空格应被拒（Windows 尾随空格面）');
  assert.equal(CodingBoard.isDiscussRecordId('a:ads'), false, 'NTFS ADS 冒号应被拒');
  assert.equal(CodingBoard.isDiscussRecordId('a.json'), false, '点应被拒');
  assert.equal(CodingBoard.isDiscussRecordId('x'.repeat(65)), false, '超 64 字符应被拒');
});

// ---- 纯视图函数：来源徽章文案 ----

test('sourceBadgeLabel：空 topic 回落固定文案，过长截断（完整留给 title 提示）', () => {
  assert.equal(CodingBoard.sourceBadgeLabel(''), '🗣 来源讨论');
  assert.equal(CodingBoard.sourceBadgeLabel('   '), '🗣 来源讨论');
  assert.equal(CodingBoard.sourceBadgeLabel(null), '🗣 来源讨论');
  assert.equal(CodingBoard.sourceBadgeLabel('要不要重构'), '🗣 要不要重构');

  const long = '一二三四五六七八九十一二三四五六七八九十'; // 20 字
  assert.equal(CodingBoard.sourceBadgeLabel(long), '🗣 ' + long.slice(0, 18) + '…');
});

// ---- 纯视图函数：弹窗取数三态 ----

test('discussDetailView：有效 → 渲染 vm；记录缺失 → unavailable；请求异常 → error', () => {
  const ok = CodingBoard.discussDetailView({
    success: true,
    discussion: { id: 'disc_1', topic: 'T', transcript: [{ persona: 'p', kind: 'speech', text: 'x' }] }
  }, null);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.vm.topic, 'T');
  assert.equal(ok.vm.hasContent, true);

  const miss = CodingBoard.discussDetailView({ success: false, error: '未找到' }, null);
  assert.equal(miss.state, 'unavailable');
  assert.ok(miss.message.includes('不可用'));

  assert.equal(CodingBoard.discussDetailView(null, null).state, 'unavailable', '空响应判不可用');

  const err = CodingBoard.discussDetailView(null, new Error('boom'));
  assert.equal(err.state, 'error');
  assert.ok(err.message.includes('boom'));
  assert.equal(CodingBoard.discussDetailView(null, {}).state, 'error', '无 message 的异常也判 error');
  assert.ok(CodingBoard.discussDetailView(null, {}).message.includes('未知错误'));
});

// ---- 服务端门禁：:id 白名单 + 不匹配 400 ----

test('服务端：GET /discussions/:id 声明 id 白名单，不匹配即 400', () => {
  assert.match(SERVER_SRC, /const DISCUSSION_ID_RE = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/, '应声明与客户端一致的白名单正则');
  const route = sliceBetween(SERVER_SRC, "app.get('/api/coding/discussions/:id'", '});');
  assert.ok(route, '应存在 :id 路由');
  assert.match(route, /DISCUSSION_ID_RE\.test\(/, '路由内应使用白名单');
  assert.match(route, /status\(400\)/, '白名单不匹配应返回 400');
});

// ---- 前端门禁：徽章/弹窗按 createElement + textContent 构造，不注入 innerHTML ----

test('前端：来源徽章与只读弹窗均无 innerHTML，弹窗结构齐全', () => {
  assert.match(HTML_SRC, /id="discuss-detail-modal"/, '应有来源讨论弹窗容器');
  assert.match(HTML_SRC, /id="discuss-detail-body"/, '应有弹窗内容容器');
  assert.match(HTML_SRC, /function openDiscussDetail\(/, '应有 openDiscussDetail');
  assert.match(HTML_SRC, /function closeDiscussDetail\(/, '应有 closeDiscussDetail');
  assert.match(HTML_SRC, /'board-badge src'/, '应渲染来源徽章');

  const open = sliceBetween(HTML_SRC, 'function openDiscussDetail(', 'function closeDiscussDetail(');
  assert.ok(open.length > 0);
  assert.ok(!/innerHTML/.test(open), 'openDiscussDetail 不得使用 innerHTML');

  const render = sliceBetween(HTML_SRC, 'function renderDiscussInto(', '// 一键立项');
  assert.ok(render.length > 0);
  assert.ok(!/innerHTML/.test(render), 'renderDiscussInto 不得使用 innerHTML');

  const build = sliceBetween(HTML_SRC, 'function buildTaskRow(', 'async function startTask(');
  assert.ok(build.length > 0);
  assert.ok(!/innerHTML/.test(build), 'buildTaskRow 不得使用 innerHTML');
  assert.match(build, /CodingBoard\.sourceBadgeLabel\(/, '来源徽章文案应复用纯函数');
});
