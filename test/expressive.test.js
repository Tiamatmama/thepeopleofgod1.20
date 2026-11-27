'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const expressive = require(path.join(ROOT, 'src/core/expressive'));

// 模块内的 data/expressive 是按 cwd 解析的相对路径；测试统一换到临时目录，别碰真实语料。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-expressive-'));
process.chdir(tmp);

test.after(() => {
    process.chdir(ROOT);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('E1：投放语料时洗掉隐形字符与空行，批次按 cursor 顺延', () => {
    const zeroWidth = '这\u200b句\u200d有\uFEFF隐形字符';
    assert.equal(expressive.appendCorpus(`\n${zeroWidth}\n\n第二句\n`), 2);
    assert.equal(expressive.appendCorpus('第三句'), 1);
    assert.deepEqual(expressive.readBatch(2).lines, ['这句有隐形字符', '第二句']);
    assert.deepEqual(expressive.readBatch(2).lines, ['这句有隐形字符', '第二句']);
    expressive.saveNotes({ notes: [], cursor: 2 });
    assert.deepEqual(expressive.readBatch(2).lines, ['第三句']);
    expressive.saveNotes({ notes: [], cursor: 0 });
});

test('E2：审核结果只认合法条目，越界/重复/坏 verdict 一律丢弃，cursor 推进整批', () => {
    const out = expressive.applyLearnResult([
        { index: 1, verdict: 'accepted', insight: '像我说话的口气', scenes: ['日常'] },
        { index: 2, verdict: 'rejected', reason: '太书面' },
        { index: 1, verdict: 'rejected', reason: '重复序号' },
        { index: 9, verdict: 'accepted', insight: '越界' },
        { index: 3, verdict: 'maybe', insight: '坏结论' }
    ], 0, 3);

    assert.deepEqual(
        { processed: out.processed, accepted: out.accepted, rejected: out.rejected },
        { processed: 2, accepted: 1, rejected: 1 }
    );
    assert.equal(out.cursor, 3);
    const notes = expressive.loadNotes().notes;
    assert.equal(notes.length, 2);
    assert.equal(notes[0].verdict, 'accepted');
    assert.deepEqual(notes[0].scenes, ['日常']);
    assert.equal(notes[1].reason, '太书面');
    assert.equal(expressive.loadNotes().cursor, 3);
});

test('E3：同一句不重复入库（模型重跑同一批只留第一次结论）', () => {
    expressive.saveNotes({ notes: [], cursor: 0 });
    expressive.appendCorpus('重复的一句');
    expressive.applyLearnResult([{ index: 1, verdict: 'accepted', insight: '第一次' }], 0, 1);
    expressive.applyLearnResult([{ index: 1, verdict: 'rejected', reason: '第二次' }], 0, 1);
    const notes = expressive.loadNotes().notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].verdict, 'accepted');
});

test('E4：示例检索只取 accepted，按字面重合命中；无命中返回空数组', () => {
    expressive.saveNotes({
        notes: [
            { verdict: 'accepted', excerpt: '我先把话放这儿', insight: '先给结论', scenes: ['日常'], createdAt: 1 },
            { verdict: 'rejected', excerpt: '我先把话放这儿', insight: '重复的拒绝项', createdAt: 2 },
            { verdict: 'accepted', excerpt: '天凉了记得加衣服', insight: '关心但不腻', scenes: ['关心'], createdAt: 3 }
        ],
        cursor: 0
    });
    const hit = expressive.findExamples('那我把话放这儿了', 2);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].excerpt, '我先把话放这儿');
    assert.deepEqual(expressive.findExamples('', 2), []);
    assert.deepEqual(expressive.findExamples('完全无关的字符串xyz', 2), []);
});

test('E5：学习批次解析模型输出并落库，缺输出模块时明确报错', async () => {
    expressive.saveNotes({ notes: [], cursor: 0 });
    expressive.appendCorpus('第一句\n第二句');
    const fakeOutput = {
        callWithTools: async () => ({
            choices: [{
                message: {
                    content: '```json\n[{"index":1,"verdict":"accepted","insight":"像我"},{"index":2,"verdict":"rejected","reason":"别扭"}]\n```'
                }
            }]
        })
    };
    const result = await expressive.learnBatch({ outputModule: fakeOutput, batchSize: 2 });
    assert.deepEqual(result, { processed: 2, accepted: 1, rejected: 1 });
    assert.equal(expressive.getState().counts.accepted, 1);

    await assert.rejects(
        () => expressive.learnBatch({ outputModule: null }),
        /缺少可用的输出模块/
    );
});

test('E6：注入示例后只回写使用次数与时间，不改变检索结果', () => {
    expressive.saveNotes({
        notes: [{
            id: 'ex_used', verdict: 'accepted', excerpt: '天凉了记得加衣服',
            insight: '关心但不腻', scenes: [], createdAt: 1
        }],
        cursor: 0
    });
    assert.equal(expressive.markExamplesUsed(['ex_used']), 1);
    assert.equal(expressive.markExamplesUsed(['ex_used']), 1);
    const note = expressive.loadNotes().notes[0];
    assert.equal(note.usedCount, 2);
    assert.ok(note.lastUsedAt > 0);
    // 只观测：记账不影响检索，避免「用过的越用」的自我强化
    assert.equal(expressive.findExamples('天凉了记得加衣服', 2).length, 1);
});

test('E7：照抄按 2-gram 覆盖率判定，抄过的示例冷却且不再注入', () => {
    expressive.saveNotes({
        notes: [{
            id: 'ex_copy', verdict: 'accepted', excerpt: '我先把话放这儿',
            insight: '先给结论', scenes: [], createdAt: 1
        }],
        cursor: 0
    });
    const examples = expressive.findExamples('话放这儿', 2);
    assert.equal(examples.length, 1);
    // 正常改写不算抄
    assert.deepEqual(expressive.detectCopies('天凉了，你把外套穿上', examples), []);
    const copied = expressive.detectCopies('我先把话放这儿吧', examples);
    assert.deepEqual(copied, ['ex_copy']);
    assert.equal(expressive.markExamplesCopied(copied), 1);
    const note = expressive.loadNotes().notes[0];
    assert.equal(note.copyCount, 1);
    assert.ok(note.cooldownUntil > Date.now());
    // 冷却期内不再注入
    assert.deepEqual(expressive.findExamples('话放这儿', 2), []);
});

test('E8：她说过的话被用户原样接住才成候选，没接住就丢掉', () => {
    expressive.saveNotes({ notes: [], cursor: 0 });
    assert.equal(expressive.rememberSpoken('天凉了，你把外套穿上，别硬扛'), 1);
    // 「嗯」这类接话不算接住，观察槽整体清空
    assert.equal(expressive.observeUserReply('嗯嗯'), 0);
    assert.equal(expressive.loadNotes().notes.length, 0);
    assert.equal(expressive.observeUserReply('天凉了，你把外套穿上'), 0);

    expressive.rememberSpoken('天凉了，你把外套穿上，别硬扛');
    assert.equal(expressive.observeUserReply('行行行，天凉了，你把外套穿上'), 1);
    const notes = expressive.loadNotes().notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].verdict, 'pending');
    assert.equal(notes[0].source, 'dialogue');
});

test('E9：待审候选永不注入，审成 accepted 后才进入检索', () => {
    const note = expressive.loadNotes().notes.find(n => n.verdict === 'pending');
    assert.ok(note);
    // 字面完全一致也不注入
    assert.deepEqual(expressive.findExamples(note.excerpt, 2), []);
    const data = expressive.loadNotes();
    data.notes.forEach((item) => { if (item.id === note.id) item.verdict = 'accepted'; });
    expressive.saveNotes(data);
    assert.equal(expressive.findExamples(note.excerpt, 2).length, 1);
});

test('E10：学习批次先审对话候选，漏审的按未给结论拒掉', async () => {
    expressive.saveNotes({
        notes: [
            { id: 'ex_d1', excerpt: '天凉了，你把外套穿上', verdict: 'pending', source: 'dialogue', createdAt: 1, scenes: [] },
            { id: 'ex_d2', excerpt: '我先去把灯关了', verdict: 'pending', source: 'dialogue', createdAt: 2, scenes: [] }
        ],
        cursor: Number.MAX_SAFE_INTEGER
    });
    const fakeOutput = {
        callWithTools: async () => ({
            choices: [{
                message: {
                    content: '[{"index":1,"verdict":"accepted","insight":"像我","scenes":["关心"]}]'
                }
            }]
        })
    };
    const result = await expressive.learnBatch({ outputModule: fakeOutput, batchSize: 10 });
    assert.deepEqual(result, { processed: 2, accepted: 1, rejected: 1 });
    const notes = expressive.loadNotes().notes;
    assert.equal(notes[0].verdict, 'accepted');
    assert.equal(notes[0].insight, '像我');
    assert.equal(notes[1].verdict, 'rejected');
    assert.equal(notes[1].reason, '学习时没有给出结论');
});
