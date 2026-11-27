'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AppointmentBook = require('../src/core/appointmentBook');
const SystemNarrator = require('../src/core/narrator');

// 用临时文件构造事件簿：绝不读写真实 data/appointments.json
function makeBook(entries = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appointment-book-'));
  const dataPath = path.join(dir, 'appointments.json');
  fs.writeFileSync(dataPath, JSON.stringify({ appointments: entries }), 'utf8');
  const book = new AppointmentBook({ unifiedAPI: {}, dataPath });
  return { book, dir };
}

function entry({ id = 'a1', userId = 'u1', event, dueAt, status = 'pending' }) {
  return {
    id,
    userId,
    event,
    dueAt,
    raw: '',
    createdAt: Date.now() - 60 * 60 * 1000,
    remindedAt: 0,
    followedUpAt: 0,
    status,
    result: '',
    resolvedAt: 0
  };
}

// 事情刚过点、还没到「追问」窗口（60 分钟），原本既不进提示词也不会被追问，
// 提示词里等于完全没有这件事——而用户此刻正在做这件事。
test('刚过点 20 分钟的事必须留在提示词里，并标注已过多久', () => {
  const now = Date.now();
  const { book, dir } = makeBook([entry({ event: '开会', dueAt: now - 20 * 60 * 1000 })]);
  try {
    const text = book.getPendingText('u1');
    assert.match(text, /开会/, '刚过点的事不能从提示词里消失');
    assert.match(text, /已过约 20 分钟/, '要写明已过多久，别让模型自己算');
    assert.match(text, /可能/, '要提示这件事可能还在进行中');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 只写绝对日期时模型要拿末尾的时间层去反算，算错就会把明天的事当今天
test('待发生的事必须带「还有多久」的相对标注', () => {
  const now = Date.now();
  const { book, dir } = makeBook([entry({ event: '体检', dueAt: now + 30 * 60 * 1000 })]);
  try {
    const text = book.getPendingText('u1');
    assert.match(text, /体检/);
    assert.match(text, /还有约 30 分钟/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 已经拿到结局的事不能又被当成「时间已过、可能还没结束」
test('已了结的事不进「已过点」段', () => {
  const now = Date.now();
  const { book, dir } = makeBook([
    entry({ event: '面试', dueAt: now - 3 * 60 * 60 * 1000, status: 'resolved' })
  ]);
  book.appointments[0].result = '过了';
  book.appointments[0].resolvedAt = now;
  try {
    const text = book.getPendingText('u1');
    assert.doesNotMatch(text, /可能还没结束/);
    assert.match(text, /过了/, '已了结的结论仍要保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 事件簿的 userId 对不上任何会话时，原实现会退回「最近说过话的会话」——
// 等于把 A 的约定讲给 B；宁可不提醒，也不能说错人。
test('约定找不到主人时不投递，不能落到别的会话', () => {
  const narrator = new SystemNarrator({}, {
    sessionManager: {
      getAllSessions: () => [
        { sessionId: 's1', users: { a: { userId: 'u1', isCreator: true } } },
        { sessionId: 's2', users: { b: { userId: 'u2' } } }
      ]
    }
  });

  assert.equal(narrator.findSessionForUser('qq_999'), null);
  assert.equal(narrator.findSessionForUser('u2').sessionId, 's2');

  // 记忆键带分区/世代后缀时仍要能对上本人
  assert.equal(narrator.findSessionForUser('u1__role').sessionId, 's1');
});
