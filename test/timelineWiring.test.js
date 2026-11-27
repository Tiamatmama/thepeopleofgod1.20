'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TimelineStore, dayKey } = require('../src/core/timeline');
const MemoryModule = require('../src/core/memory');
const AppointmentBook = require('../src/core/appointmentBook');

test('I1：storeMemory 成功后，当天日志出现对应 memory.created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-int-'));
  const timeline = new TimelineStore({ dir });
  const memory = new MemoryModule({ timeline });
  try {
    const now = Date.now();
    memory.storeMemory(
      { type: 'fact', scene: '日常闲聊' },
      'u_int__role',
      '他今天说要去跑步'
    );
    const list = timeline.readDay('u_int__role', dayKey());
    const created = list.filter((e) => e.type === 'memory.created');
    assert.equal(created.length, 1);
    assert.equal(created[0].payload.text, '他今天说要去跑步');
    assert.equal(created[0].payload.scene, '日常闲聊');
    assert.ok(created[0].payload.mid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I2：内容被过滤（不入库）时不写 memory.created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-int-'));
  const timeline = new TimelineStore({ dir });
  const memory = new MemoryModule({ timeline });
  try {
    const before = timeline.readDay('u_int2__role', dayKey()).length;
    memory.storeMemory({ type: 'fact', scene: '' }, 'u_int2__role', '');
    assert.equal(timeline.readDay('u_int2__role', dayKey()).length, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I3：约定真的记下后写 appointment.scheduled；重复约定不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-appt-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appt-data-'));
  const timeline = new TimelineStore({ dir });
  const book = new AppointmentBook({
    dataPath: path.join(dataDir, 'appointments.json'),
    timeline,
    timelineScope: (userId) => `${userId}__role`
  });
  try {
    const dueAt = Date.now() + 60 * 60 * 1000;
    assert.equal(book.addAppointment({ userId: 'u_appt', event: '一起看电影', dueAt }), true);
    assert.equal(book.addAppointment({ userId: 'u_appt', event: '一起看电影', dueAt }), false);

    const events = timeline.readDay('u_appt__role', dayKey()).filter((e) => e.type === 'appointment.scheduled');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.text, '一起看电影');
    assert.equal(events[0].payload.at, dueAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
