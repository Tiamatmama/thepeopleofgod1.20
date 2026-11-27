'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const proj = require('../src/core/expressionProjection');

// 表情投影层 L0：纯逻辑。重点验证三件事——
//   1. 方向正确（VAD 随情绪变化的方向不能反）
//   2. 能力探测（设备没这个动作就不动，不硬编码）
//   3. 边界干净（纯函数、不 require emotion.js、不落盘，哲学上不可能回写情绪）

const vec = (overrides = {}) => ({
    happy: 0,
    sad: 0,
    shy: 0,
    anxious: 0,
    jealous: 0,
    dependent: 0,
    calm: 0,
    ...overrides
});

test('projectVAD：happy 抬高愉悦与觉醒，sad 压低愉悦，calm 压低觉醒', () => {
    const happy = proj.projectVAD(vec({ happy: 0.9 }));
    assert.ok(happy.valence > 0.5, `happy 的 valence 应为正，实际 ${happy.valence}`);
    assert.ok(happy.arousal > 0, `happy 的 arousal 应为正，实际 ${happy.arousal}`);

    const sad = proj.projectVAD(vec({ sad: 0.9 }));
    assert.ok(sad.valence < -0.5, `sad 的 valence 应为负，实际 ${sad.valence}`);

    const calm = proj.projectVAD(vec({ calm: 0.9 }));
    assert.ok(calm.arousal < 0, `calm 的 arousal 应为负，实际 ${calm.arousal}`);
});

test('projectVAD：全零向量回落中性，不做除零放大', () => {
    assert.deepEqual(proj.projectVAD(vec()), { valence: 0, arousal: 0, dominance: 0 });
    assert.deepEqual(proj.projectVAD(null), { valence: 0, arousal: 0, dominance: 0 });
});

test('dominantOf：取最大维度；全零时停在 calm', () => {
    assert.equal(proj.dominantOf(vec({ happy: 0.7, calm: 0.3 })).type, 'happy');
    assert.equal(proj.dominantOf(vec()).type, 'calm');
    assert.equal(proj.dominantOf(vec()).intensity, 0);
});

test('resolveDevice：按回退链命中第一个存在的动作，支持大小写与中文', () => {
    assert.equal(proj.resolveDevice(['wag_tail', '摇尾巴'], ['摇尾巴']).action, '摇尾巴');
    assert.equal(proj.resolveDevice(['wag_tail', '摇尾巴'], ['WAG_TAIL']).action, 'WAG_TAIL');
    assert.equal(proj.resolveDevice(['wag_tail'], []), null);
    assert.equal(proj.resolveDevice(['wag_tail'], null), null);
    assert.equal(proj.resolveDevice(['wag_tail'], ['sit']), null, '动作表里没有就给 null，不许乱发');
});

test('project：强情绪才触发一次性动作，弱情绪只留下常驻与说话两层', () => {
    const strong = proj.project({ fast: vec({ happy: 0.8 }) }, { availableActions: [] });
    assert.equal(strong.primary.type, 'happy');
    assert.equal(strong.expression.name, 'smile');
    assert.ok(strong.layers.reaction, '强度 0.8 应触发 reaction');
    assert.equal(strong.layers.reaction.name, 'wag');
    assert.equal(strong.device, null, '动作表为空时不动设备');

    const weak = proj.project({ fast: vec({ happy: 0.3, calm: 0.2 }) }, {});
    assert.equal(weak.layers.reaction, null, '强度 0.3 不该抖一下');
    assert.equal(weak.layers.idle.name, 'breathe_light');
});

test('project：设备动作按预设意图回退，且不改动传入的快照', () => {
    const snapshot = Object.freeze({
        at: 1700000000000,
        sessionId: 's1',
        userId: 'u1',
        fast: Object.freeze(vec({ happy: 0.85 }))
    });
    const plan = proj.project(snapshot, { availableActions: ['sit', '摇尾巴'] });
    assert.deepEqual(plan.device, { intent: '摇尾巴', action: '摇尾巴' });
    assert.equal(plan.at, 1700000000000);
    assert.equal(plan.sessionId, 's1');
});

test('边界：投影层不引情绪写入口、不落盘（哲学回归）', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/core/expressionProjection.js'), 'utf8');
    assert.doesNotMatch(source, /require\(['"].*emotion['"]\)/, '不许 require emotion 模块');
    assert.doesNotMatch(source, /require\(['"]fs['"]\)/, '不许读写文件');
    assert.doesNotMatch(source, /applyInternalSignal|updateEmotion|\.save\(/, '不许出现情绪写方法');
});

test('预设完整性：7 个维度都有预设，且每个预设都有回退链', () => {
    proj.EMOTIONS.forEach((emotion) => {
        const preset = proj.PRESETS[emotion];
        assert.ok(preset, `${emotion} 缺预设`);
        assert.ok(preset.expression && preset.idle && preset.speech, `${emotion} 预设缺字段`);
        assert.ok(Array.isArray(preset.deviceIntents) && preset.deviceIntents.length > 0, `${emotion} 缺设备回退链`);
    });
});
