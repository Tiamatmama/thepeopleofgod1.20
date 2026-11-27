'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULTS,
    MAX_SEMANTIC_LEN,
    effectiveLen,
    isConsolidationCandidate,
    salienceOf,
    selectCandidates,
    bigrams,
    diceSimilarity,
    cosineSimilarity,
    greedyCluster,
    clusterByVectors,
    clusterByText,
    clusterCandidates,
    pickClusters,
    REM_DEFAULTS,
    planRemAssociations,
    findConsolidatedSources,
    restoreConsolidatedSource,
    parseConsolidationOutput
} = require('../src/core/memoryConsolidation');

// 造一条情景记忆
function m(data, extra = {}) {
    return {
        id: Math.random(),
        data,
        value: 0,
        salience: 0.6,
        recallCount: 0,
        tier: 'episodic',
        timestamp: Date.now(),
        ...extra
    };
}

test('effectiveLen：忽略标点与空白后计有效字符', () => {
    assert.equal(effectiveLen('你好'), 2);
    assert.equal(effectiveLen('你好，世界！'), 4);
    assert.equal(effectiveLen('a b!c'), 3);
    assert.equal(effectiveLen(''), 0);
    assert.equal(effectiveLen(null), 0);
});

test('isConsolidationCandidate：仅接受够长的情景记忆（文本 + 视觉/屏幕）', () => {
    assert.equal(isConsolidationCandidate(m('今天去公园散步很开心')), true);
    assert.equal(isConsolidationCandidate(m('嗯嗯')), false);
    assert.equal(isConsolidationCandidate(m('今天去公园', { tier: 'archived' })), false);
    assert.equal(isConsolidationCandidate(m('今天去公园散步', { tier: 'semantic' })), false);
    assert.equal(isConsolidationCandidate(m('今天去公园散步', { consolidatedInto: 'x' })), false);
    assert.equal(isConsolidationCandidate(m('【摘要】今天去公园散步')), false);
    assert.equal(isConsolidationCandidate(m('今天去公园散步', { modality: 'image' })), false);
    assert.equal(isConsolidationCandidate(m('今天去公园散步', { modality: 'text' })), true);
    assert.equal(isConsolidationCandidate(m('今天去公园散步', { modality: 'vision' })), true);
    assert.equal(isConsolidationCandidate(m('今天去公园散步', { modality: 'screen' })), true);
    assert.equal(isConsolidationCandidate({ data: 123 }), false);
    assert.equal(isConsolidationCandidate(null), false);
});

test('salienceOf：有 salience 用它并夹到 [0,1]，缺失时按 value 推初值', () => {
    assert.equal(salienceOf({ salience: 0.42, value: 0 }), 0.42);
    assert.equal(salienceOf({ salience: 2, value: 0 }), 1);
    assert.ok(Math.abs(salienceOf({ value: 1 }) - 0.8) < 1e-9);
    assert.ok(Math.abs(salienceOf({ value: 0 }) - 0.3) < 1e-9);
});

test('selectCandidates：过滤非候选，按显著性降序同分按时间新→旧，并截断', () => {
    const now = Date.now();
    const list = [
        m('今天去公园散步很开心', { salience: 0.5, timestamp: now - 1000 }),
        m('明天要交一份重要的工作报告', { salience: 0.9, timestamp: now - 5000 }),
        m('后天我们去看那场电影吧', { salience: 0.9, timestamp: now - 100 }),
        m('嗯嗯', { salience: 0.9 }),                                   // 太短 → 排除
        m('【摘要】旧对话', { salience: 0.9 }),                          // 系统条目 → 排除
        m('这是语义记忆的内容', { tier: 'semantic', salience: 0.9 }),    // 非情景 → 排除
        m('他不喜欢香菜这件事', { salience: 0.2 })                       // 显著性不足 → 排除
    ];
    const picked = selectCandidates(list, { maxCandidates: 2 });
    assert.equal(picked.length, 2);
    assert.equal(picked[0].salience, 0.9);
    assert.equal(picked[1].salience, 0.9);
    // 同分 0.9 时，时间更新的在前
    assert.ok(picked[0].timestamp > picked[1].timestamp);
});

test('bigrams：去标点空白后切相邻二字，单字退化自身', () => {
    assert.deepEqual([...bigrams('abcd')].sort(), ['ab', 'bc', 'cd']);
    assert.deepEqual([...bigrams('a')], ['a']);
    assert.equal(bigrams('   ').size, 0);
    // 逗号被忽略，a,b → ab
    assert.deepEqual([...bigrams('a,b')], ['ab']);
});

test('diceSimilarity：完全重合为 1，无重合为 0，空集为 0', () => {
    const a = bigrams('今天去公园散步');
    assert.equal(diceSimilarity(a, bigrams('今天去公园散步')), 1);
    assert.equal(diceSimilarity(a, bigrams('完全不相干的话')), 0);
    assert.equal(diceSimilarity(new Set(), a), 0);
    assert.equal(diceSimilarity(a, null), 0);
});

test('cosineSimilarity：同向为 1，正交为 0，长度不一或零向量为 0', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0) < 1e-9);
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
});

test('greedyCluster：够相似并入簇代表，否则另起新簇', () => {
    const items = [1, 2, 3, 4];
    const clusters = greedyCluster(items, (a, b) => (Math.abs(a - b) === 1 ? 1 : 0), 0.5);
    assert.deepEqual(clusters, [[1, 2], [3, 4]]);
});

test('clusterByText：字面相近的并入同簇，无关的各成一簇', () => {
    const a = m('今天去公园散步很开心');
    const b = m('今天去公园散步心情很好');
    const c = m('明天要交一份重要的工作报告');
    const clusters = clusterByText([a, b, c]);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters[0], [a, b]);
    assert.deepEqual(clusters[1], [c]);
});

test('clusterByVectors：有向量按余弦聚类，无向量条目按字面并入', () => {
    const a = m('今天去公园散步很开心');
    const b = m('今天去公园散步心情很好');   // 无向量，文本近似 a
    const c = m('明天要交一份重要的工作报告'); // 向量与 a 正交
    const vectors = [[1, 0], null, [0, 1]];
    const clusters = clusterByVectors([a, b, c], vectors);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters[0], [a, b]);
    assert.deepEqual(clusters[1], [c]);
});

test('clusterCandidates：有可用向量走向量聚类，否则退化字面聚类', () => {
    const a = m('今天去公园散步很开心');
    const b = m('今天去公园散步心情很好');
    const c = m('明天要交一份重要的工作报告');
    const byText = clusterCandidates([a, b, c], null);
    assert.deepEqual(byText, clusterByText([a, b, c]));

    const byVec = clusterCandidates([a, b, c], [[1, 0], [0.95, 0.05], [0, 1]]);
    assert.equal(byVec.length, 2);
    assert.deepEqual(byVec[0], [a, b]);
});

test('pickClusters：只保留达到最小规模的簇，按权重排序并截断', () => {
    const mk = () => m('某条情景记忆内容', { salience: 0.5 });
    const small = [mk(), mk()];
    const mid = [mk(), mk(), mk()];
    const big = [mk(), mk(), mk(), mk()];
    const picked = pickClusters([small, mid, big]);
    assert.equal(picked.length, 2);       // 默认 maxClustersPerRun=2
    assert.equal(picked[0].length, 4);    // 体积最大在前
    assert.equal(picked[1].length, 3);
});

test('pickClusters：默认最小簇规模为 3，可被 opts 覆盖', () => {
    const mk = () => m('某条情景记忆内容', { salience: 0.5 });
    const one = [mk()];
    assert.equal(pickClusters([one]).length, 0);
    assert.equal(pickClusters([one], { minClusterSize: 1 }).length, 1);
});

test('parseConsolidationOutput：去围栏/引号/列表前缀，取首行，拒绝 JSON 与过短', () => {
    assert.equal(parseConsolidationOutput('```\n他知道我喜欢画画\n```'), '他知道我喜欢画画');
    assert.equal(parseConsolidationOutput('"他知道我不爱吃香菜"'), '他知道我不爱吃香菜');
    assert.equal(parseConsolidationOutput('- 他知道我喜欢安静'), '他知道我喜欢安静');
    assert.equal(parseConsolidationOutput('1. 他知道我最近很忙'), '他知道我最近很忙');
    assert.equal(parseConsolidationOutput('他知道我喜欢安静\n这是第二行应被丢掉'), '他知道我喜欢安静');
    assert.equal(parseConsolidationOutput('{"a":1}'), '');
    assert.equal(parseConsolidationOutput('[1,2,3]'), '');
    assert.equal(parseConsolidationOutput('嗯嗯'), '');
    assert.equal(parseConsolidationOutput(''), '');
    assert.equal(parseConsolidationOutput(null), '');
});

test('parseConsolidationOutput：超长结论截断到上限', () => {
    const long = '他'.repeat(200);
    const out = parseConsolidationOutput(long);
    assert.equal(out.length, MAX_SEMANTIC_LEN);
});

test('DEFAULTS：暴露可标定参数且取值合理', () => {
    assert.equal(typeof DEFAULTS.minClusterSize, 'number');
    assert.ok(DEFAULTS.minClusterSize >= 2);
    assert.ok(DEFAULTS.vectorSimThreshold > DEFAULTS.lexicalSimThreshold);
});

test('findConsolidatedSources：按 consolidatedInto 反查源情景记忆，id 按字符串比对', () => {
    const s1 = m('今天去公园散步很开心', { consolidatedInto: 'S1' });
    const s2 = m('今天去公园散步心情很好', { consolidatedInto: 123 });   // 数字 id
    const s3 = m('明天要交一份重要的工作报告', { consolidatedInto: null }); // 未巩固
    const s4 = m('另一条语义结论正文', { tier: 'semantic' });             // 语义记忆本身
    const list = [s1, s2, s3, s4];

    assert.deepEqual(findConsolidatedSources(list, 'S1'), [s1]);
    assert.deepEqual(findConsolidatedSources(list, 123), [s2]);          // 数字入参也能命中字符串字段
    assert.deepEqual(findConsolidatedSources(list, 'NOPE'), []);
    assert.deepEqual(findConsolidatedSources(null, 'S1'), []);
});

test('restoreConsolidatedSource：清溯源/回 episodic/还原减半的 salience', () => {
    const source = m('今天去公园散步很开心', { consolidatedInto: 'S1', tier: 'archived', salience: 0.25 });
    assert.equal(restoreConsolidatedSource(source), true);
    assert.equal(source.consolidatedInto, null);
    assert.equal(source.tier, 'episodic');
    assert.ok(Math.abs(source.salience - 0.5) < 1e-9);

    // 还原结果夹到上限 1（减半前为 1 的极端情况）
    const high = m('某条高显著度记忆', { consolidatedInto: 'S1', tier: 'archived', salience: 0.8 });
    assert.equal(restoreConsolidatedSource(high), true);
    assert.equal(high.salience, 1);
});

test('restoreConsolidatedSource：非源条目原样返回 false', () => {
    const plain = m('普通情景记忆');
    assert.equal(restoreConsolidatedSource(plain), false);
    assert.equal(plain.tier, 'episodic');
    assert.equal(restoreConsolidatedSource(null), false);
    assert.equal(restoreConsolidatedSource('not-a-memory'), false);
});

test('REM_DEFAULTS：暴露弱关联带参数且 maxSimilarity > minSimilarity', () => {
    assert.equal(typeof REM_DEFAULTS.minSimilarity, 'number');
    assert.equal(typeof REM_DEFAULTS.maxSimilarity, 'number');
    assert.ok(REM_DEFAULTS.maxSimilarity > REM_DEFAULTS.minSimilarity);
    assert.ok(REM_DEFAULTS.maxAssociations >= 1);
});

test('planRemAssociations：按弱关联带出跨话题联想，confidence 降序且 maxAssociations 截断', () => {
    // 6 维向量，每两维归属一个话题对，块间正交：只有块内的对才落在弱关联带
    const head = block => { const a = [0, 0, 0, 0, 0, 0]; a[block] = 1; return a; };
    const t = (block, cos) => { const a = [0, 0, 0, 0, 0, 0]; a[block] = cos; a[block + 1] = Math.sqrt(1 - cos * cos); return a; };

    const a1 = m('第一话题的记忆甲', { id: 'a1', topicId: 'T1' });
    const a2 = m('第二话题的记忆乙', { id: 'a2', topicId: 'T2' });
    const b1 = m('第三话题的记忆丙', { id: 'b1', topicId: 'T3' });
    const b2 = m('第四话题的记忆丁', { id: 'b2', topicId: 'T4' });
    const c1 = m('第五话题的记忆戊', { id: 'c1', topicId: 'T5' });
    const c2 = m('第六话题的记忆己', { id: 'c2', topicId: 'T6' });

    const memories = [a1, a2, b1, b2, c1, c2];
    const vectors = [head(0), t(0, 0.75), head(2), t(2, 0.6), head(4), t(4, 0.4)];

    const out = planRemAssociations(memories, vectors);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(o => o.topicIds), [['T1', 'T2'], ['T3', 'T4'], ['T5', 'T6']]);
    assert.deepEqual(out[0].sourceMemoryIds, ['a1', 'a2']);
    assert.ok(Math.abs(out[0].confidence - (0.75 - 0.35) / 0.45) < 1e-3);
    assert.ok(Math.abs(out[1].confidence - (0.6 - 0.35) / 0.45) < 1e-3);
    assert.ok(Math.abs(out[2].confidence - (0.4 - 0.35) / 0.45) < 1e-3);
    assert.equal(out[0].pairCount, 1);
    assert.ok(Math.abs(out[0].maxSimilarity - 0.75) < 1e-3);
    assert.equal(out[0].samples[0].topicId, 'T1');

    // 截断：只保留 confidence 最高的两条
    const top2 = planRemAssociations(memories, vectors, { maxAssociations: 2 });
    assert.equal(top2.length, 2);
    assert.deepEqual(top2.map(o => o.topicIds), [['T1', 'T2'], ['T3', 'T4']]);
});

test('planRemAssociations：无向量时退化为字面 Dice（落在带内才联想）', () => {
    const x = m('今天在公园散步看见很多花', { id: 'x', topicId: 'TX' });
    const y = m('昨天在公园散步看到了花', { id: 'y', topicId: 'TY' });
    const out = planRemAssociations([x, y]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].topicIds, ['TX', 'TY']);
    assert.ok(out[0].maxSimilarity > REM_DEFAULTS.minSimilarity);
    assert.ok(out[0].maxSimilarity < REM_DEFAULTS.maxSimilarity);
});

test('planRemAssociations：太像 / 同话题 / 缺话题号 / 跨归属 / 不可巩固 均不联想', () => {
    // 太像（≥maxSimilarity）：同一件事，交给巩固，不算弱关联
    const tooAlike = [m('完全一样的一段话', { id: 'p', topicId: 'T1' }), m('完全一样的一段话', { id: 'q', topicId: 'T2' })];
    assert.deepEqual(planRemAssociations(tooAlike), []);

    // 同话题
    const sameTopic = [m('今天在公园散步看见很多花', { id: 'p', topicId: 'T1' }), m('昨天在公园散步看到了花', { id: 'q', topicId: 'T1' })];
    assert.deepEqual(planRemAssociations(sameTopic), []);

    // 缺 topicId
    const noTopic = [m('今天在公园散步看见很多花', { id: 'p' }), m('昨天在公园散步看到了花', { id: 'q' })];
    assert.deepEqual(planRemAssociations(noTopic), []);

    // 跨归属（不同 userId）绝不联想
    const crossOwner = [
        m('今天在公园散步看见很多花', { id: 'p', topicId: 'T1', userId: 'u1' }),
        m('昨天在公园散步看到了花', { id: 'q', topicId: 'T2', userId: 'u2' })
    ];
    assert.deepEqual(planRemAssociations(crossOwner), []);

    // 不可巩固（已巩固）不入池
    const notCandidate = [
        m('今天在公园散步看见很多花', { id: 'p', topicId: 'T1', consolidatedInto: 'S1' }),
        m('昨天在公园散步看到了花', { id: 'q', topicId: 'T2' })
    ];
    assert.deepEqual(planRemAssociations(notCandidate), []);
});

test('planRemAssociations：不改动入参记忆对象，且空输入安全', () => {
    const x = m('今天在公园散步看见很多花', { id: 'x', topicId: 'TX' });
    const y = m('昨天在公园散步看到了花', { id: 'y', topicId: 'TY' });
    const before = { ...x };
    planRemAssociations([x, y]);
    assert.deepEqual(x, before);
    assert.deepEqual(y.topicId, 'TY');

    assert.deepEqual(planRemAssociations([], []), []);
    assert.deepEqual(planRemAssociations(null), []);
    assert.deepEqual(planRemAssociations([m('只有一条够长的情景记忆', { id: 's', topicId: 'T1' })]), []);
});
