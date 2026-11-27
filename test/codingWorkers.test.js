'use strict';

// 工人池回归：领单规则 / 并发名额 / 派单 / 收工回写 / 反打转 / 冲突不记尝试 / 定时开关。
// 桩法沿用 test/codingLoop.test.js：内存任务板 + 假的编码闭环，不碰真模型与真磁盘。

const test = require('node:test');
const assert = require('node:assert/strict');

const WorkerPool = require('../src/core/codingWorkers');

// 内存任务板：listTasks / updateTask 两个方法就够用（工人池只读这两个）
function makeCoding(tasks) {
    const store = tasks.map(t => ({ ...t, params: { ...(t.params || {}) } }));
    return {
        store,
        listTasksCalls: 0, // 计数器：没有它，「一个 tick 只读一次任务板」这条验收写不出来
        listTasks(status) {
            this.listTasksCalls++;
            return store
                .filter(t => !status || t.status === status)
                .map(t => ({ ...t, params: { ...(t.params || {}) } }));
        },
        updateTask(id, patch) {
            const t = store.find(x => x.id === id);
            if (!t) return { success: false, error: '任务不存在' };
            Object.assign(t, patch);
            if (patch && patch.params) t.params = { ...patch.params };
            return { success: true, task: { ...t } };
        }
    };
}

// 假的编码闭环：只记调用、能手动"跑完"，用来驱动收工回写
function makeLoop({ taskIdFor, fail } = {}) {
    const runs = new Map();
    const deriveId = taskIdFor || ((params) => params.taskId);
    return {
        calls: [],
        runs,
        seq: 0, // runId 用独立序号：原先取 calls.length，插一个用例就会改掉后续所有 runId，用例间存在顺序耦合
        nextRunId() {
            return `r${++this.seq}`;
        },
        async start(params) {
            this.calls.push({ fn: 'start', params });
            if (fail) return fail;
            const runId = this.nextRunId();
            runs.set(params.taskId, { id: runId, taskId: params.taskId, finishedAt: '', status: '' });
            return { success: true, taskId: params.taskId, run: { id: runId } };
        },
        async startFromTask(params) {
            this.calls.push({ fn: 'startFromTask', params });
            if (fail) return fail;
            const runTaskId = deriveId(params);
            const runId = this.nextRunId();
            runs.set(runTaskId, { id: runId, taskId: runTaskId, finishedAt: '', status: '' });
            return { success: true, taskId: runTaskId, run: { id: runId } };
        },
        latestRun(taskId) {
            return runs.get(taskId) || null;
        }
    };
}

// 让某条运行"跑完"，供 reapFinished 判定
function finish(loop, runTaskId, status, error) {
    const r = loop.runs.get(runTaskId);
    assert.ok(r, `没有在跑的工作区：${runTaskId}`);
    r.finishedAt = new Date().toISOString();
    r.status = status;
    if (error) r.error = error;
}

const BASE_TASKS = [
    { id: 'c_1', status: 'todo', createdBy: 'u', title: '抓点', params: {} },                                    // 无目标 → 不自动领
    { id: 'c_2', status: 'todo', createdBy: 'u', title: '写工具', params: { goal: '加一个去重工具' } },            // 有目标 → 领
    { id: 'c_3', status: 'todo', createdBy: '', title: '没归属', params: { goal: 'x' } },                          // 没归属 → 不领
    { id: 'c_4', status: 'todo', createdBy: 'u', title: '跑过两次', params: { goal: 'x', attempts: 2 } },          // 超限 → 不领
    { id: 'c_5', status: 'todo', createdBy: 'u', title: 'spike 候选', params: { kind: 'spike', ideaId: 'i1' } }   // 候选 → 领
];

test('eligibleTasks：只领「有归属 + 说清目标 + 未超重派上限」的任务', () => {
    const coding = makeCoding(BASE_TASKS);
    const pool = new WorkerPool({ coding, codingLoop: makeLoop() });
    const ids = pool.eligibleTasks().map(t => t.id).sort();
    assert.deepEqual(ids, ['c_2', 'c_5']);
});

test('eligibleTasks：集群子任务与汇总任务一律不领（避免和写手抢工作区）', () => {
    const tasks = [
        ...BASE_TASKS,
        { id: 'fleet_fl_1_w1', status: 'todo', createdBy: 'u', title: '集群写手', params: { goal: 'x' } },
        { id: 'c_fleet_kind', status: 'todo', createdBy: 'u', title: '集群汇总', params: { goal: 'x', kind: 'fleet-result' } },
        { id: 'c_fleet_id', status: 'todo', createdBy: 'u', title: '带 fleetId', params: { goal: 'x', fleetId: 'fl_1' } }
    ];
    const pool = new WorkerPool({ coding: makeCoding(tasks), codingLoop: makeLoop() });
    const ids = pool.eligibleTasks().map(t => t.id).sort();
    assert.deepEqual(ids, ['c_2', 'c_5']);
});

test('dispatchOne：普通目标任务走 loop.start，工作区 taskId 用板上 id', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop();
    const pool = new WorkerPool({ coding, codingLoop: loop });

    const r = await pool.dispatchOne(coding.listTasks('todo').find(t => t.id === 'c_2'));
    assert.equal(r.dispatched, true);
    assert.equal(r.runTaskId, 'c_2');
    assert.equal(loop.calls[0].fn, 'start');
    assert.equal(loop.calls[0].params.taskId, 'c_2');
    assert.equal(loop.calls[0].params.goal, '加一个去重工具');
    // 派单即把板上状态推到 doing，并记在在跑表里
    assert.equal(coding.store.find(t => t.id === 'c_2').status, 'doing');
    assert.equal(pool.status().running, 1);
});

test('dispatchOne：spike 候选走 loop.startFromTask，工作区 taskId 带 spike_ 前缀', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop({ taskIdFor: (p) => `spike_${p.taskId === 'c_5' ? 'i1' : p.taskId}` });
    const pool = new WorkerPool({ coding, codingLoop: loop });

    const r = await pool.dispatchOne(coding.listTasks('todo').find(t => t.id === 'c_5'));
    assert.equal(r.dispatched, true);
    assert.equal(loop.calls[0].fn, 'startFromTask');
    assert.equal(loop.calls[0].params.taskId, 'c_5');
    assert.equal(r.runTaskId, 'spike_i1');
    assert.equal(coding.store.find(t => t.id === 'c_5').status, 'doing');
});

test('tick：按并发名额派单，一个慢的不影响另一个（互不 await 到跑完）', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop({ taskIdFor: () => 'spike_i1' });
    const pool = new WorkerPool({ coding, codingLoop: loop, concurrency: 2 });

    const out = await pool.tick();
    assert.equal(out.dispatched.length, 2);
    assert.equal(out.running, 2);
    // 两条都只是"起跑"（finishedAt 还空着），说明 tick 没被某一条拖住
    assert.equal(pool.status().workers.every(w => loop.latestRun(w.runTaskId).finishedAt === ''), true);
});

test('tick：并发名额满时不再派新单', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop({ taskIdFor: () => 'spike_i1' });
    const pool = new WorkerPool({ coding, codingLoop: loop, concurrency: 1 });

    const first = await pool.tick();
    assert.equal(first.dispatched.length, 1);
    const second = await pool.tick();
    assert.equal(second.dispatched.length, 0);
    assert.equal(second.running, 1);
});

test('reapFinished：跑完通过判据 → 任务板回写 done，在跑表清空', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop();
    const pool = new WorkerPool({ coding, codingLoop: loop });

    await pool.dispatchOne(coding.listTasks('todo').find(t => t.id === 'c_2'));
    finish(loop, 'c_2', 'passed');
    const settled = pool.reapFinished();

    assert.equal(settled.length, 1);
    const task = coding.store.find(t => t.id === 'c_2');
    assert.equal(task.status, 'done');
    assert.match(task.result, /通过判据/);
    assert.equal(pool.status().running, 0);
});

test('reapFinished：没过判据 → 退回待办并记一次尝试；超上限后不再被领', async () => {
    const coding = makeCoding([BASE_TASKS[1]]); // 只有 c_2（有目标）
    const loop = makeLoop();
    const pool = new WorkerPool({ coding, codingLoop: loop, maxAttempts: 2 });

    // 第一次：派单 → 失败 → 退回待办，attempts=1
    await pool.tick();
    finish(loop, 'c_2', 'failed', '测试没过');
    pool.reapFinished();
    let task = coding.store.find(t => t.id === 'c_2');
    assert.equal(task.status, 'todo');
    assert.equal(task.params.attempts, 1);
    assert.match(task.result, /第 1\/2 次/);
    assert.equal(pool.eligibleTasks().length, 1); // 还能再领一次

    // 第二次：再失败 → attempts=2，达上限 → 不再自动领
    await pool.tick();
    finish(loop, 'c_2', 'failed', '还是没过');
    pool.reapFinished();
    task = coding.store.find(t => t.id === 'c_2');
    assert.equal(task.params.attempts, 2);
    assert.match(task.result, /第 2\/2 次/);
    assert.equal(pool.eligibleTasks().length, 0);
});

test('dispatchOne：并发冲突(code=conflict) 只跳过，不算一次失败尝试', async () => {
    const coding = makeCoding([BASE_TASKS[1]]);
    const loop = makeLoop({ fail: { success: false, code: 'conflict', error: '工作区已有闭环在跑' } });
    const pool = new WorkerPool({ coding, codingLoop: loop });

    const r = await pool.dispatchOne(coding.listTasks('todo')[0]);
    assert.equal(r.dispatched, false);
    assert.equal(r.skipped, true);
    const task = coding.store.find(t => t.id === 'c_2');
    assert.equal(task.status, 'todo');
    assert.equal(Number(task.params.attempts) || 0, 0); // 没记尝试
    assert.equal(pool.status().running, 0);
});

test('start / stop：定时开关幂等，stop 后不再自动领单（在跑的不打断）', async () => {
    const coding = makeCoding([BASE_TASKS[1]]);
    const loop = makeLoop();
    const pool = new WorkerPool({ coding, codingLoop: loop, intervalMs: 60000 });

    assert.equal(pool.status().auto, false);
    assert.equal(pool.start().auto, true);
    assert.ok(pool.timer);
    pool.start(); // 幂等：不重建定时器
    assert.equal(pool.status().auto, true);
    assert.equal(pool.status().concurrency, 3);
    assert.equal(pool.stop().auto, false);
    assert.equal(pool.timer, null);
});

// ---- 以下四条是「加任何新维度之前」的守卫：先红，再修 ----

test('reapFinished：运行记录彻底不可见时按墙钟超时摘除，不永久占槽', async () => {
    const coding = makeCoding([BASE_TASKS[1]]);
    const loop = makeLoop();
    let clock = Date.parse('2026-01-01T00:00:00Z');
    // maxAttempts=1：摘除后会立刻重派（合法），钉死它只为看「槽位是否释放」这一个变量
    const pool = new WorkerPool({ coding, codingLoop: loop, inflightTtlMs: 1000, now: () => clock, maxAttempts: 1 });

    await pool.dispatchOne(coding.listTasks('todo')[0]);
    assert.equal(pool.status().running, 1);
    loop.runs.delete('c_2'); // 模拟历史被裁剪：那条 run 再也查不到

    await pool.tick(); // 还没超时 → 继续等，不误杀
    assert.equal(pool.status().running, 1);

    clock += 2000;
    await pool.tick(); // 超时 → 摘掉并记一次尝试
    assert.equal(pool.status().running, 0);
    const task = coding.store.find(t => t.id === 'c_2');
    assert.equal(task.status, 'todo');
    assert.equal(task.params.attempts, 1);
});

test('reapFinished：有记录但 id 对不上，同样不静默卡死', async () => {
    const coding = makeCoding([BASE_TASKS[1]]);
    const loop = makeLoop();
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const pool = new WorkerPool({ coding, codingLoop: loop, inflightTtlMs: 1000, now: () => clock, maxAttempts: 1 });

    await pool.dispatchOne(coding.listTasks('todo')[0]);
    // 工作区被别的运行顶掉：latestRun 能返回，但 id 不是我们那次
    loop.runs.set('c_2', { id: 'other', taskId: 'c_2', finishedAt: new Date().toISOString(), status: 'passed' });

    await pool.tick();
    assert.equal(pool.status().running, 1, 'id 不匹配时不能当成自己跑完，照样占槽等超时');

    clock += 2000;
    await pool.tick();
    assert.equal(pool.status().running, 0);
    assert.equal(coding.store.find(t => t.id === 'c_2').params.attempts, 1);
});

test('settleTask：任务已被删除时不抛异常、不造幽灵任务', async () => {
    const coding = makeCoding([BASE_TASKS[1]]);
    const loop = makeLoop();
    const pool = new WorkerPool({ coding, codingLoop: loop });

    await pool.dispatchOne(coding.listTasks('todo')[0]);
    coding.store.length = 0; // 开跑后任务被删
    finish(loop, 'c_2', 'failed', '测试没过');

    assert.doesNotThrow(() => pool.reapFinished());
    assert.equal(coding.store.length, 0);
    assert.equal(pool.status().running, 0);
});

test('tick：重入保护——两次并发 tick 不会把同一条派两次', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop({ taskIdFor: () => 'spike_i1' });
    const pool = new WorkerPool({ coding, codingLoop: loop, concurrency: 2 });

    const [a, b] = await Promise.all([pool.tick(), pool.tick()]);
    const runIds = [...a.dispatched, ...b.dispatched].map(r => r.runTaskId);
    assert.ok(runIds.length <= 2, `并发派单数 ${runIds.length} 超过名额`);
    assert.equal(new Set(runIds).size, runIds.length, '同一条任务被派了两次');
});

test('tick：一个 tick 只读一次任务板（任务数增长也不放大 IO）', async () => {
    const coding = makeCoding(BASE_TASKS);
    const loop = makeLoop({ taskIdFor: () => 'spike_i1' });
    const pool = new WorkerPool({ coding, codingLoop: loop, concurrency: 2 });

    await pool.tick();
    assert.equal(coding.listTasksCalls, 1);
});

