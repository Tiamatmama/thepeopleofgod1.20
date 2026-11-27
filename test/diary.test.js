'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DiaryModule = require('../src/core/diary');
const { ToolRegistry } = require('../src/core/toolRegistry');

// 固定一个本地时间点：dayKey / 到了几点 都按本地时区算，避免 UTC 偏到前一天
function at(hour, minute = 0, day = 16) {
    return new Date(2026, 10, day, hour, minute, 0).getTime();
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
}

function makeApi(reply = '今天和他聊了很久，心里有点乱，但不想说出口。') {
    const calls = [];
    return {
        calls,
        callAPI: async (messages, _, opts) => {
            calls.push({ messages, opts });
            return { choices: [{ message: { content: reply } }] };
        }
    };
}

function makeMemory(records = [{ data: '他说想去看海', timestamp: at(20, 10) }]) {
    const stored = [];
    return {
        stored,
        retrieveMemoryRecords: async () => records,
        storeMemory: (input, ownerId, rawText) => {
            stored.push({ input, ownerId, rawText });
            return { stored: true, queued: true };
        }
    };
}

function makeSessionManager(overrides = {}) {
    const history = overrides.history || [
        { role: 'user', content: '今天有点累', timestamp: at(19, 30) },
        { role: 'assistant', content: '那早点睡', timestamp: at(19, 31) }
    ];
    return {
        history,
        getAllSessions: () => overrides.sessions || [
            { sessionId: 's1', creatorId: 'u1', users: { u1: { name: '小星' } }, updatedAt: at(19, 31) }
        ],
        getConversationHistory: () => history,
        buildCharacterPrompt: () => '你是小助手。'
    };
}

test('safeOwnerDir：可读名保留，路径字符被替换且同一 owner 稳定', () => {
    assert.equal(DiaryModule.safeOwnerDir('u1'), 'u1');
    const withCjk = DiaryModule.safeOwnerDir('qq_123456789_测试角色');
    assert.match(withCjk, /^qq_123456789_测试角色_[0-9a-f]{6}$/);
    const evil = DiaryModule.safeOwnerDir('../a/b');
    assert.equal(evil.includes('/'), false);
    assert.equal(evil.includes('\\'), false);
    assert.equal(evil, DiaryModule.safeOwnerDir('../a/b'));
});

test('未到约定时间不写：19:00 不落盘也不调模型', async () => {
    const dir = tmpDir();
    const api = makeApi();
    const diary = new DiaryModule({ unifiedAPI: api, memory: makeMemory(), dataDir: dir });
    const result = await diary.tick({ sessionManager: makeSessionManager(), now: at(19, 0) });

    assert.deepEqual(result, { written: 0, global: false });
    assert.equal(api.calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'u1')), false);
});

test('当天没有活动不写：昨天的对话不算今天', async () => {
    const dir = tmpDir();
    const api = makeApi();
    const diary = new DiaryModule({ unifiedAPI: api, memory: makeMemory(), dataDir: dir });
    const manager = makeSessionManager({
        history: [{ role: 'user', content: '昨天聊的', timestamp: at(21, 0, 15) }],
        sessions: [{ sessionId: 's1', creatorId: 'u1', users: {}, updatedAt: at(21, 0, 15) }]
    });

    const result = await diary.tick({ sessionManager: manager, now: at(20, 30) });
    assert.equal(result.written, 0);
    assert.equal(api.calls.length, 0);
});

test('同一天只写一次：第二次 tick 不再调模型', async () => {
    const dir = tmpDir();
    const api = makeApi();
    const diary = new DiaryModule({ unifiedAPI: api, memory: makeMemory(), dataDir: dir });
    const manager = makeSessionManager();

    const first = await diary.tick({ sessionManager: manager, now: at(20, 30) });
    assert.equal(first.written, 1);
    const afterFirst = api.calls.length;

    const second = await diary.tick({ sessionManager: manager, now: at(21, 30) });
    assert.equal(second.written, 0);
    assert.equal(api.calls.length, afterFirst);
});

test('每人本落盘且回流主记忆：正文以【日记】写回该用户', async () => {
    const dir = tmpDir();
    const memory = makeMemory();
    const diary = new DiaryModule({ unifiedAPI: makeApi(), memory, dataDir: dir });

    await diary.tick({ sessionManager: makeSessionManager(), now: at(20, 30) });

    const file = path.join(dir, 'u1', '2026-11-16.md');
    assert.equal(fs.existsSync(file), true);
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /2026-11-16 · 关于小星/);
    assert.match(body, /心里有点乱/);

    assert.equal(memory.stored.length, 1);
    assert.equal(memory.stored[0].ownerId, 'u1');
    assert.match(memory.stored[0].rawText, /^【日记】/);
    assert.match(memory.stored[0].rawText, /心里有点乱/);
});

test('全局本落盘但不回流任何用户记忆', async () => {
    const dir = tmpDir();
    const memory = makeMemory();
    const diary = new DiaryModule({ unifiedAPI: makeApi(), memory, dataDir: dir });

    const result = await diary.tick({ sessionManager: makeSessionManager(), now: at(20, 30) });
    assert.equal(result.global, true);

    const globalFile = path.join(dir, '_global', '2026-11-16.md');
    assert.equal(fs.existsSync(globalFile), true);
    assert.match(fs.readFileSync(globalFile, 'utf8'), /心里有点乱/);
    // 只有每人本那一次回流，全局本不进任何人的记忆
    assert.equal(memory.stored.length, 1);
});

test('模型失败不崩且同轮不重试：失败后一小时内跳过', async () => {
    const dir = tmpDir();
    let calls = 0;
    const api = {
        callAPI: async () => {
            calls += 1;
            throw new Error('upstream down');
        }
    };
    const diary = new DiaryModule({ unifiedAPI: api, memory: makeMemory(), dataDir: dir });
    const manager = makeSessionManager();

    const first = await diary.tick({ sessionManager: manager, now: at(20, 30) });
    assert.equal(first.written, 0);
    assert.equal(calls, 1);

    const second = await diary.tick({ sessionManager: manager, now: at(20, 40) });
    assert.equal(second.written, 0);
    assert.equal(calls, 1);   // 退避期内不再打模型
    assert.equal(fs.existsSync(path.join(dir, 'u1', '2026-11-16.md')), false);
});

test('schedule_diary：HH:mm 校验 + 约定落盘 + 工具接线', () => {
    const dir = tmpDir();
    const diary = new DiaryModule({ unifiedAPI: makeApi(), memory: makeMemory(), dataDir: dir });

    const bad = diary.setSchedule({ time: '25:00' });
    assert.equal(bad.success, false);

    const reg = Object.create(ToolRegistry.prototype);
    reg.diary = diary;
    const ok = reg.scheduleDiary({ time: '21:30' });
    assert.equal(ok.success, true);
    assert.match(ok.message, /21:30/);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.hour, 21);
    assert.equal(saved.minute, 30);
    assert.equal(saved.enabled, true);

    const off = reg.scheduleDiary({ enabled: false });
    assert.equal(off.success, true);
    assert.equal(diary.getConfig().enabled, false);
});

test('没有接记忆链路时只靠当天对话也能写；两者都没有则跳过', async () => {
    const dir = tmpDir();
    const api = makeApi();
    const diary = new DiaryModule({ unifiedAPI: api, memory: null, dataDir: dir });

    const result = await diary.tick({ sessionManager: makeSessionManager(), now: at(20, 30) });
    assert.equal(result.written, 1);
    assert.equal(fs.existsSync(path.join(dir, 'u1', '2026-11-16.md')), true);

    const emptyManager = makeSessionManager({
        history: [],
        sessions: [{ sessionId: 's2', creatorId: 'u2', users: {}, updatedAt: at(19, 0) }]
    });
    const empty = await diary.tick({ sessionManager: emptyManager, now: at(20, 30) });
    assert.equal(empty.written, 0);
});
