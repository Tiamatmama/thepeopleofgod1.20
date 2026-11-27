'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingCompetition = require('../src/core/codingCompetition');
const {
    buildCompetitionGoal,
    normalizeCandidates,
    topicScore,
    compareCandidates,
    createModelJudge,
    parseJudgeScores
} = CodingCompetition;

// 编程竞赛（竞技场）：验证四件事——
//   1. 起跑线一致：每个候选一份独立副本，goal 与 token 预算完全相同
//   2. 排名口径：过判据 > 不跑题 > 评委分 > 省 token
//   3. 跑题的候选即使「过了判据」也不能当冠军
//   4. 边界干净：只编排、不 require 任何记忆/情绪模块，也不直接调模型（评委靠注入）

// ---- 假工作区：真建目录、真复制，git 用固定输出，不碰真仓库 ----

function fakeCoding() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-'));
    const workspaces = path.join(root, 'workspaces');
    const gitCalls = [];
    const coding = {
        dir: path.join(root, 'coding'),
        workspaces,
        safeTaskId(id) {
            const value = String(id || '').trim();
            return /^[A-Za-z0-9_-]+$/.test(value) ? value : '';
        },
        taskDir(userId, taskId) {
            const id = this.safeTaskId(taskId);
            if (!id) return '';
            return path.join(workspaces, String(userId), id);
        },
        createWorkspace(userId, taskId) {
            const dir = this.taskDir(userId, taskId);
            if (!dir) return { success: false, error: 'bad taskId' };
            fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
            return { success: true, taskId, dir };
        },
        git(userId, taskId, args) {
            gitCalls.push({ taskId, args });
            if (args[0] === 'rev-parse') return { success: true, output: 'base_sha_1\n' };
            if (args[0] === 'diff' && args[1] === '--numstat') {
                const output = String(taskId).endsWith('c1')
                    ? '10\t2\tsrc/a.js\n'
                    : '1\t0\tsrc/b.js\n';
                return { success: true, output };
            }
            if (args[0] === 'diff') return { success: true, output: '+ 改动\n' };
            return { success: false, error: 'unexpected git args' };
        }
    };
    return { root, coding, gitCalls };
}

// 假闭环：start 立刻把终态写进 latestRun，省掉轮询等待
function fakeLoop(outcomeFor) {
    const started = [];
    const latest = new Map();
    return {
        started,
        start(params) {
            started.push(params);
            const outcome = (typeof outcomeFor === 'function' ? outcomeFor(params) : outcomeFor) || {};
            latest.set(params.taskId, {
                id: `run_${params.taskId}`,
                status: outcome.status || 'failed',
                finishedAt: outcome.status === 'awaiting_input' ? '' : '2026-01-01T00:00:00.000Z',
                iteration: outcome.iteration || 1,
                tokenUsage: outcome.tokenUsage || { prompt: 0, completion: 0, total: 0 },
                result: outcome.result || '',
                error: outcome.error || ''
            });
            return { success: true, taskId: params.taskId, run: { id: `run_${params.taskId}` } };
        },
        latestRun(taskId) {
            return latest.get(taskId) || null;
        },
        stop() {
            return { success: true };
        }
    };
}

function makeCompetition({ coding, loop, judge = null }) {
    return new CodingCompetition({
        coding,
        codingLoop: loop,
        judge,
        dir: path.join(coding.dir, 'competitions'),
        pollMs: 2
    });
}

async function waitDone(comp, id, owner = 'alice') {
    for (let i = 0; i < 400; i++) {
        const res = comp.status(id, owner);
        if (res.success && ['finished', 'failed', 'stopped'].includes(res.competition.status)) {
            return res.competition;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('竞赛没有在预期时间内结束');
}

// ---- 纯函数 ----

test('候选清单：数字=人数，数组=各自模型，越界直接拒', () => {
    const three = normalizeCandidates(3, 'deepseek');
    assert.equal(three.success, true);
    assert.equal(three.list.length, 3);
    assert.equal(three.list[0].name, '工人A');
    assert.equal(three.list[0].model, 'deepseek');

    const mixed = normalizeCandidates([{ name: '甲', model: 'qwen' }, { name: '乙' }], 'deepseek');
    assert.equal(mixed.list[0].model, 'qwen');
    assert.equal(mixed.list[1].model, 'deepseek');

    assert.equal(normalizeCandidates(1, 'deepseek').success, false);
    assert.equal(normalizeCandidates(9, 'deepseek').list.length, 5);
    assert.equal(normalizeCandidates([], 'deepseek').success, false);
});

test('竞赛 goal：原目标保留，且强制写入「不得偏离主题 / 最小改动」', () => {
    const goal = buildCompetitionGoal('给任务板加导出按钮');
    assert.ok(goal.startsWith('给任务板加导出按钮'));
    assert.ok(goal.includes('不得改动与本目标无关的文件'));
    assert.ok(goal.includes('最小改动'));
});

test('跑题度：贴着目标的语料得分高，无关语料得分低', () => {
    const goal = '给任务板加导出按钮';
    assert.ok(topicScore(goal, '在任务板加了导出按钮并补了测试') > 0.5);
    assert.ok(topicScore(goal, '重构登录模块，顺手换了依赖') < 0.2);
});

test('排名口径：过判据 > 评委分 > onTopic > 省 token', () => {
    const passedExpensive = { passed: true, quality: null, onTopic: 0.5, tokens: 900, iterations: 3 };
    const failedCheap = { passed: false, quality: 1, onTopic: 0.9, tokens: 10, iterations: 1 };
    assert.ok(compareCandidates(passedExpensive, failedCheap) < 0, '过判据的永远排前面');

    const betterQuality = { passed: true, quality: 0.9, onTopic: 0.2, tokens: 9999, iterations: 5 };
    const worseQuality = { passed: true, quality: 0.3, onTopic: 0.9, tokens: 100, iterations: 1 };
    assert.ok(compareCandidates(betterQuality, worseQuality) < 0, '评委分高者优先');

    const cheap = { passed: true, quality: 0.5, onTopic: 0.5, tokens: 100, iterations: 3 };
    const pricey = { passed: true, quality: 0.5, onTopic: 0.5, tokens: 800, iterations: 3 };
    assert.ok(compareCandidates(cheap, pricey) < 0, '同分时省 token 的赢');

    const unknownTokens = { passed: true, quality: 0.5, onTopic: 0.5, tokens: 0, iterations: 1 };
    assert.ok(compareCandidates(pricey, unknownTokens) < 0, '没上报 token 的按最贵处理');
});

test('评委输出解析：容忍 ```json 包裹与多余文字', () => {
    const parsed = parseJudgeScores('好的，结果如下：\n```json\n{"scores":{"t1":{"onTopic":0.8}}}\n```');
    assert.equal(parsed.t1.onTopic, 0.8);
    assert.equal(parseJudgeScores('没有 JSON'), null);
});

test('评委工厂：注入的 outputModule 没有 callModelOnce 时返回 null', () => {
    assert.equal(createModelJudge({ outputModule: {} }), null);
    assert.equal(createModelJudge({}), null);
});

// ---- 编排 ----

test('开赛：每个候选一份独立副本，goal 与 token 预算完全一致', async () => {
    const { coding, root } = fakeCoding();
    const loop = fakeLoop({ status: 'passed', result: '任务板导出按钮已加好', tokenUsage: { prompt: 60, completion: 40, total: 100 } });
    const comp = makeCompetition({ coding, loop });

    const res = comp.start({
        userId: 'alice',
        goal: '给任务板加导出按钮',
        candidates: 2,
        tokenBudget: 5000,
        maxIterations: 4
    });
    assert.equal(res.success, true);
    const id = res.competition.id;
    const snapshot = await waitDone(comp, id);

    assert.equal(snapshot.status, 'finished');
    assert.equal(snapshot.candidates.length, 2);
    assert.equal(snapshot.baseSha, 'base_sha_1');
    assert.equal(snapshot.tokenBudget, 5000);

    const taskIds = snapshot.candidates.map(cand => cand.taskId);
    assert.equal(new Set(taskIds).size, 2, '候选不能共用同一个工作区');
    for (const taskId of taskIds) {
        const dir = coding.taskDir('alice', taskId);
        assert.ok(fs.existsSync(path.join(dir, 'README.md')), '副本必须带着基座文件');
        assert.ok(fs.existsSync(path.join(dir, '.git')), '副本必须带着同一份 git 基线');
    }
    assert.ok(fs.existsSync(path.join(root, 'workspaces', 'alice', snapshot.baseTaskId)));

    assert.equal(loop.started.length, 2);
    for (const params of loop.started) {
        assert.equal(params.tokenBudget, 5000);
        assert.equal(params.maxIterations, 4);
        assert.equal(params.clarify, false, '竞赛不应卡在提问阶段');
        assert.ok(params.goal.includes('不得改动与本目标无关的文件'));
    }
});

test('排名：过判据的候选当冠军，token 与 diff 都记进档案', async () => {
    const { coding } = fakeCoding();
    const loop = fakeLoop(params => (params.taskId.endsWith('c1')
        ? { status: 'passed', result: '任务板导出按钮已加好', tokenUsage: { prompt: 70, completion: 30, total: 100 } }
        : { status: 'failed', result: '任务板导出按钮写了一半', tokenUsage: { prompt: 90, completion: 60, total: 150 } }));
    const comp = makeCompetition({ coding, loop });

    const { competition } = comp.start({ userId: 'alice', goal: '给任务板加导出按钮', candidates: 2, tokenBudget: 5000 });
    const snapshot = await waitDone(comp, competition.id);

    const winner = snapshot.candidates.find(cand => cand.taskId === snapshot.winner);
    assert.ok(winner, '必须有冠军');
    assert.equal(winner.passed, true);
    assert.equal(winner.tokens, 100);
    assert.equal(winner.filesChanged, 1);
    assert.equal(winner.insertions, 10);
    assert.equal(snapshot.ranking[0], winner.taskId);
});

test('跑题淘汰：过了判据但改动与目标无关，不能当冠军', async () => {
    const { coding } = fakeCoding();
    const loop = fakeLoop(params => (params.taskId.endsWith('c1')
        // c1：判据过了，但自述与 diff 都跟目标无关
        ? { status: 'passed', result: '重构登录模块，顺手升级依赖', tokenUsage: { prompt: 10, completion: 10, total: 20 } }
        // c2：判据没过，但确实在做题
        : { status: 'failed', result: '任务板导出按钮已改到一半', tokenUsage: { prompt: 80, completion: 40, total: 120 } }));
    const comp = makeCompetition({ coding, loop });

    const { competition } = comp.start({ userId: 'alice', goal: '给任务板加导出按钮', candidates: 2, tokenBudget: 5000 });
    const snapshot = await waitDone(comp, competition.id);

    const offTopic = snapshot.candidates.find(cand => cand.offTopic);
    assert.ok(offTopic, '必须识别出走题的候选');
    assert.equal(offTopic.passed, true, '被淘汰的原因只能是跑题，不是判据');
    assert.notEqual(snapshot.winner, offTopic.taskId);
});

test('评委：注入后按 quality 排名，评委挂了退回硬指标', async () => {
    const { coding } = fakeCoding();
    const loop = fakeLoop({ status: 'passed', result: '任务板导出按钮已加好', tokenUsage: { prompt: 10, completion: 10, total: 20 } });
    const judge = async ({ candidates }) => {
        const scores = {};
        candidates.forEach((cand, index) => {
            scores[cand.taskId] = { onTopic: 0.9, quality: index === 0 ? 0.2 : 0.95, minimality: 0.8, reason: '更清晰的实现' };
        });
        return scores;
    };
    const comp = makeCompetition({ coding, loop, judge });
    const { competition } = comp.start({ userId: 'alice', goal: '给任务板加导出按钮', candidates: 2, tokenBudget: 5000 });
    const snapshot = await waitDone(comp, competition.id);

    assert.equal(snapshot.judge, 'model');
    assert.equal(snapshot.winner, snapshot.candidates[1].taskId, 'quality 高的胜出');
    assert.equal(snapshot.candidates[1].quality, 0.95);

    // 评委抛错：不阻断比赛，退回硬指标
    const { coding: coding2 } = fakeCoding();
    const comp2 = makeCompetition({
        coding: coding2,
        loop: fakeLoop({ status: 'passed', result: '任务板导出按钮已加好' }),
        judge: async () => { throw new Error('模型超时'); }
    });
    const second = comp2.start({ userId: 'alice', goal: '给任务板加导出按钮', candidates: 2 });
    const snapshot2 = await waitDone(comp2, second.competition.id);
    assert.equal(snapshot2.judge, 'heuristic');
    assert.ok(snapshot2.winner, '评委挂了也要有冠军');
    assert.ok(snapshot2.error.includes('评委调用失败'));
});

test('叫停：所有在跑候选一起停，记录落盘可回查', async () => {
    const { coding } = fakeCoding();
    const loop = fakeLoop({ status: 'awaiting_input' });
    const comp = makeCompetition({ coding, loop });
    const { competition } = comp.start({ userId: 'alice', goal: '给任务板加导出按钮', candidates: 2 });
    // 还没结束就叫停
    const stopped = comp.stop(competition.id, 'alice');
    assert.equal(stopped.success, true);
    assert.equal(stopped.competition.status, 'stopped');
    assert.ok(stopped.competition.candidates.every(cand => cand.status === 'stopped'));

    const reloaded = comp.status(competition.id, 'alice');
    assert.equal(reloaded.success, true);
    assert.equal(reloaded.competition.status, 'stopped');
    assert.equal(comp.status(competition.id, 'bob').success, false, '别人的竞赛看不了');
    assert.equal(comp.list('alice').competitions.length >= 1, true);
    assert.equal(comp.list('bob').competitions.length, 0);
});

test('参数校验：缺用户/缺目标/候选不足都不开赛', () => {
    const { coding } = fakeCoding();
    const comp = makeCompetition({ coding, loop: fakeLoop({}) });
    assert.equal(comp.start({ goal: '做点事', candidates: 2 }).success, false);
    assert.equal(comp.start({ userId: 'alice', candidates: 2 }).success, false);
    assert.equal(comp.start({ userId: 'alice', goal: '做点事', candidates: 1 }).success, false);
});

// ---- 边界 ----

test('异步启动：codingLoop.start 返回 Promise 时不能被误判成启动失败', async () => {
    const { coding } = fakeCoding();
    const latest = new Map();
    const loop = {
        starts: 0,
        async start(params) {
            loop.starts += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            latest.set(params.taskId, {
                id: `run_${params.taskId}`,
                status: 'passed',
                finishedAt: '2026-01-01T00:00:00.000Z',
                iteration: 1,
                tokenUsage: { prompt: 30, completion: 40, total: 70 },
                result: '改好了',
                error: ''
            });
            return { success: true, taskId: params.taskId, run: { id: `run_${params.taskId}` } };
        },
        latestRun(taskId) {
            return latest.get(taskId) || null;
        },
        stop() {
            return { success: true };
        }
    };
    const comp = new CodingCompetition({ coding, codingLoop: loop, dir: coding.dir, pollMs: 2 });
    const started = comp.start({ userId: 'alice', goal: '实现一个纯函数', candidates: 2, tokenBudget: 1000 });
    assert.equal(started.success, true, started.error);

    const snap = await waitDone(comp, started.competition.id, 'alice');
    assert.equal(loop.starts, 2, '两个候选都应该真的启动了');
    const failed = snap.candidates.filter(cand => cand.status === 'failed');
    assert.equal(failed.length, 0, '异步启动不该被记成失败：' + JSON.stringify(failed.map(c => c.error)));
    assert.equal(snap.candidates.every(cand => cand.passed === true), true);
    assert.ok(snap.winner, '应该产出冠军');
});

test('信任档：无人值守必须把候选工作区设成 auto，否则会卡在审批', async () => {
    const { coding } = fakeCoding();
    const trustCalls = [];
    coding.setTrustLevel = (userId, taskId, level) => {
        trustCalls.push({ userId, taskId, level });
        return { success: true };
    };
    const comp = new CodingCompetition({ coding, codingLoop: fakeLoop({ status: 'passed' }), dir: coding.dir, pollMs: 2 });
    const started = comp.start({ userId: 'alice', goal: '实现一个纯函数', candidates: 2 });
    assert.equal(started.success, true, started.error);
    await waitDone(comp, started.competition.id, 'alice');
    assert.equal(trustCalls.length, 2, '每个候选都要设一次');
    assert.equal(trustCalls.every(call => call.level === 'auto'), true);
    assert.equal(trustCalls.every(call => call.userId === 'alice'), true);
});

test('边界回归：不碰记忆/情绪，不直接调模型', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'codingCompetition.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/require\(['"]\.\/memory['"]\)/.test(code), '不得 require 记忆模块');
    assert.ok(!/require\(['"]\.\/emotion['"]\)/.test(code), '不得 require 情绪模块');
    assert.ok(!/user_memories/.test(code), '不得碰正式记忆表');
    assert.ok(!/require\(['"]\.\/output['"]\)/.test(code), '评委必须靠注入，不能自己拿模型入口');
});
