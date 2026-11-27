'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULTS,
    clamp01,
    effectiveLen,
    bigrams,
    diceSimilarity,
    normalizeTrait,
    mergeTrait,
    computeTraitMaturity,
    isTraitLeaseAlive,
    touchTrait,
    selectForInjection,
    parseSelfTraitOutput,
    normalizeModel,
    BOUNDARY_DEFAULTS,
    BOUNDARY_RESOLUTIONS,
    normalizeBoundary,
    mergeBoundary,
    retireBoundaries,
    closeBoundary,
    selectBoundariesForInjection,
    parseBoundaryOutput,
    parseBoundaryCloseOutput
} = require('../src/core/selfModel');

const DAY = 24 * 60 * 60 * 1000;

// 造一条自我认知条目
function trait(text, extra = {}) {
    return { text, confidence: 0.6, source: null, updatedAt: Date.now(), ...extra };
}

test('clamp01：非法值归 0，越界夹到 [0,1]', () => {
    assert.equal(clamp01(0.4), 0.4);
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(NaN), 0);
    assert.equal(clamp01('x'), 0);
});

test('effectiveLen：忽略标点与空白后计有效字符', () => {
    assert.equal(effectiveLen('你好'), 2);
    assert.equal(effectiveLen('我在意他，有没有回我消息！'), 11);
    assert.equal(effectiveLen('a b!c'), 3);
    assert.equal(effectiveLen(''), 0);
    assert.equal(effectiveLen(null), 0);
});

test('bigrams / diceSimilarity：与 memoryConsolidation 同款字面重合度', () => {
    assert.deepEqual([...bigrams('abcd')].sort(), ['ab', 'bc', 'cd']);
    assert.deepEqual([...bigrams('a')], ['a']);
    assert.equal(bigrams('   ').size, 0);
    const a = bigrams('我最近越来越在意他有没有回我消息');
    assert.equal(diceSimilarity(a, bigrams('我最近越来越在意他有没有回我消息')), 1);
    assert.equal(diceSimilarity(a, bigrams('我不喜欢被叫全名')), 0);
    assert.equal(diceSimilarity(new Set(), a), 0);
    assert.equal(diceSimilarity(a, null), 0);
});

test('normalizeTrait：去装饰、补默认置信度与时间，过短/空返回 null', () => {
    const item = normalizeTrait({ text: '“我不喜欢被叫全名”' });
    assert.equal(item.text, '我不喜欢被叫全名');
    assert.equal(item.confidence, DEFAULTS.defaultConfidence);
    assert.ok(item.updatedAt > 0);
    assert.equal(item.source, null);

    assert.equal(normalizeTrait({ text: '嗯嗯' }), null);      // 有效字符不足 4
    assert.equal(normalizeTrait({ text: '   ' }), null);
    assert.equal(normalizeTrait(null), null);
    assert.equal(normalizeTrait('字符串'), null);
});

test('normalizeTrait：置信度夹到 [0,1]，超长正文截断', () => {
    assert.equal(normalizeTrait(trait('我不喜欢被叫全名', { confidence: 3 })).confidence, 1);
    assert.equal(normalizeTrait(trait('我不喜欢被叫全名', { confidence: -1 })).confidence, 0);
    const long = normalizeTrait(trait('我'.repeat(200)));
    assert.equal(long.text.length, DEFAULTS.maxTraitLen);
});

test('mergeTrait：字面相近视为同一条并覆盖旧值，否则追加', () => {
    const base = normalizeTrait(trait('我最近越来越在意他有没有回我消息'));
    const first = mergeTrait([], base);
    assert.equal(first.traits.length, 1);
    assert.equal(first.merged, false);

    // 高度相近 → 合并覆盖
    const similar = normalizeTrait(trait('我最近越来越在意他有没有回我消息', { confidence: 0.9 }));
    const second = mergeTrait(first.traits, similar);
    assert.equal(second.merged, true);
    assert.equal(second.traits.length, 1);
    assert.equal(second.traits[0].confidence, 0.9);

    // 不相干 → 追加
    const other = normalizeTrait(trait('我不喜欢被叫全名'));
    const third = mergeTrait(second.traits, other);
    assert.equal(third.merged, false);
    assert.equal(third.traits.length, 2);
});

test('mergeTrait：按置信度降序 + 时间降序，超限淘汰低分旧条', () => {
    const now = Date.now();
    let list = [];
    list = mergeTrait(list, normalizeTrait(trait('我不喜欢被叫全名', { confidence: 0.3, updatedAt: now }))).traits;
    list = mergeTrait(list, normalizeTrait(trait('我最近越来越在意他有没有回我消息', { confidence: 0.9, updatedAt: now }))).traits;
    list = mergeTrait(list, normalizeTrait(trait('我更愿意安静地陪着他', { confidence: 0.6, updatedAt: now }))).traits;
    assert.equal(list[0].confidence, 0.9);
    assert.equal(list[1].confidence, 0.6);
    assert.equal(list[2].confidence, 0.3);

    // 超限：maxTraits=2 时丢掉最低分那条
    const capped = mergeTrait(list, normalizeTrait(trait('我讨厌被敷衍', { confidence: 0.5 })), { maxTraits: 2 });
    assert.equal(capped.traits.length, 2);
    assert.equal(capped.traits[0].confidence, 0.9);
    assert.equal(capped.traits[1].confidence, 0.6);
});

test('mergeTrait：空 trait 不产生变化', () => {
    const list = [normalizeTrait(trait('我不喜欢被叫全名'))];
    const out = mergeTrait(list, null);
    assert.equal(out.merged, false);
    assert.equal(out.traits.length, 1);
});

test('selectForInjection：过滤低置信，按置信度降序取前 limit 条纯文本', () => {
    const now = Date.now();
    const list = [
        trait('我不喜欢被叫全名', { confidence: 0.9, updatedAt: now }),
        trait('我更愿意安静地陪着他', { confidence: 0.7, updatedAt: now }),
        trait('我最近越来越在意他有没有回我消息', { confidence: 0.5, updatedAt: now }),
        trait('我讨厌被敷衍', { confidence: 0.1, updatedAt: now })          // 低于 minConfidence → 排除
    ];
    const picked = selectForInjection(list, 2);
    assert.equal(picked.length, 2);
    assert.equal(picked[0], '我不喜欢被叫全名');
    assert.equal(picked[1], '我更愿意安静地陪着他');
});

test('selectForInjection：同置信度按时间新→旧，非法输入返回空', () => {
    const older = trait('我不喜欢被叫全名', { confidence: 0.8, updatedAt: 1000 });
    const newer = trait('我更愿意安静地陪着他', { confidence: 0.8, updatedAt: 2000 });
    const picked = selectForInjection([older, newer], 2);
    assert.equal(picked[0], '我更愿意安静地陪着他');
    assert.deepEqual(selectForInjection(null), []);
    assert.deepEqual(selectForInjection([], 3), []);
});

test('parseSelfTraitOutput：去围栏/引号/列表前缀，一行一条，拒绝 JSON 与过短', () => {
    assert.deepEqual(
        parseSelfTraitOutput('```\n我不喜欢被叫全名\n我最近越来越在意他有没有回我消息\n```'),
        ['我不喜欢被叫全名', '我最近越来越在意他有没有回我消息']
    );
    assert.deepEqual(parseSelfTraitOutput('"我不喜欢被叫全名"'), ['我不喜欢被叫全名']);
    assert.deepEqual(parseSelfTraitOutput('- 我更愿意安静地陪着他'), ['我更愿意安静地陪着他']);
    assert.deepEqual(parseSelfTraitOutput('1. 我讨厌被敷衍'), ['我讨厌被敷衍']);
    assert.deepEqual(parseSelfTraitOutput('{"a":1}'), []);
    assert.deepEqual(parseSelfTraitOutput('[1,2,3]'), []);
    assert.deepEqual(parseSelfTraitOutput('嗯嗯'), []);
    assert.deepEqual(parseSelfTraitOutput(''), []);
    assert.deepEqual(parseSelfTraitOutput(null), []);
});

test('parseSelfTraitOutput：最多取 5 条，超长截断到上限', () => {
    const many = ['我不喜欢被叫全名', '我最近越来越在意他有没有回我消息', '我更愿意安静地陪着他',
        '我讨厌被敷衍', '我希望他能多看我一眼', '我在意他今天开不开心'].join('\n');
    assert.equal(parseSelfTraitOutput(many).length, 5);

    const out = parseSelfTraitOutput('我'.repeat(200));
    assert.equal(out[0].length, DEFAULTS.maxTraitLen);
});

test('normalizeModel：兼容老档/坏档，坏条目被剔除', () => {
    const model = normalizeModel({
        updatedAt: 123,
        traits: [{ text: '我不喜欢被叫全名' }, { text: '嗯' }, null, 'x']
    });
    assert.equal(model.version, 1);
    assert.equal(model.updatedAt, 123);
    assert.equal(model.traits.length, 1);
    assert.equal(model.traits[0].text, '我不喜欢被叫全名');

    const empty = normalizeModel(null);
    assert.equal(empty.updatedAt, 0);
    assert.deepEqual(empty.traits, []);
});

test('DEFAULTS：暴露可标定参数且取值合理', () => {
    assert.equal(typeof DEFAULTS.maxTraits, 'number');
    assert.ok(DEFAULTS.maxTraits >= 3);
    assert.ok(DEFAULTS.injectLimit >= 1 && DEFAULTS.injectLimit <= DEFAULTS.maxTraits);
    assert.ok(DEFAULTS.dedupeSimilarity > 0 && DEFAULTS.dedupeSimilarity < 1);
    assert.ok(DEFAULTS.minConfidence > 0 && DEFAULTS.minConfidence < DEFAULTS.defaultConfidence);
});

// ——— 自我认知租约（用进废退）：新增纯逻辑 ———

test('normalizeTrait：默认 useCount=0 / lastUsedAt=0，保留合法值并夹取负值', () => {
    const plain = normalizeTrait({ text: '我不喜欢被叫全名' });
    assert.equal(plain.useCount, 0);
    assert.equal(plain.lastUsedAt, 0);

    const used = normalizeTrait({ text: '我不喜欢被叫全名', useCount: 3.9, lastUsedAt: 12345 });
    assert.equal(used.useCount, 3);
    assert.equal(used.lastUsedAt, 12345);

    assert.equal(normalizeTrait({ text: '我不喜欢被叫全名', useCount: -5 }).useCount, 0);
    assert.equal(normalizeTrait({ text: '我不喜欢被叫全名', useCount: 'x' }).useCount, 0);
});

test('normalizeModel：白名单重建时保留 useCount / lastUsedAt（读一次不丢）', () => {
    const model = normalizeModel({ traits: [{ text: '我不喜欢被叫全名', useCount: 7, lastUsedAt: 999 }] });
    assert.equal(model.traits[0].useCount, 7);
    assert.equal(model.traits[0].lastUsedAt, 999);
});

test('computeTraitMaturity：用进废退——新条目=floor×conf，用满逼近 conf，闲置半衰，超 cap 不增', () => {
    const now = 1000 * DAY;
    const fresh = { text: '我不喜欢被叫全名', confidence: 0.8, updatedAt: now, useCount: 0, lastUsedAt: 0 };
    assert.ok(Math.abs(computeTraitMaturity(fresh, now) - 0.8 * DEFAULTS.maturityFloor) < 1e-9);

    const maxed = { ...fresh, useCount: DEFAULTS.useCap, lastUsedAt: now };
    assert.ok(Math.abs(computeTraitMaturity(maxed, now) - 0.8) < 1e-9);

    const over = { ...maxed, useCount: DEFAULTS.useCap * 100 };
    assert.ok(Math.abs(computeTraitMaturity(over, now) - 0.8) < 1e-9);        // 对数有界

    const idle = { ...maxed, lastUsedAt: now - DEFAULTS.halfLifeDays * DAY };
    assert.ok(Math.abs(computeTraitMaturity(idle, now) - 0.4) < 1e-9);       // 半衰期后恰好减半

    assert.ok(computeTraitMaturity({ ...maxed, lastUsedAt: now - 10000 * DAY }, now) < 1e-6);
});

test('computeTraitMaturity：非法输入返回 0，正常输入落在 (0,1]', () => {
    assert.equal(computeTraitMaturity(null, 0), 0);
    assert.equal(computeTraitMaturity('x', 0), 0);
    const now = Date.now();
    const m = computeTraitMaturity(trait('我不喜欢被叫全名', { confidence: 1, lastUsedAt: now }), now);
    assert.ok(m > 0 && m <= 1);
});

test('isTraitLeaseAlive：偏好 lastUsedAt、缺失回落 updatedAt，TTL 边界与时钟回拨', () => {
    const now = 100 * DAY;
    // 无 lastUsedAt → 回落 updatedAt
    assert.equal(isTraitLeaseAlive(trait('我不喜欢被叫全名', { updatedAt: now - DAY, lastUsedAt: 0 }), now), true);
    // 超过 TTL → 过期
    assert.equal(isTraitLeaseAlive(trait('我不喜欢被叫全名', { updatedAt: now - 40 * DAY, lastUsedAt: now - 40 * DAY }), now), false);
    // 恰好等于 TTL → 严格小于才算活，故判死
    assert.equal(isTraitLeaseAlive(trait('我不喜欢被叫全名', { updatedAt: now, lastUsedAt: now - DEFAULTS.leaseTtlMs }), now), false);
    // 时钟回拨（now < touchAt）→ 保守判活
    assert.equal(isTraitLeaseAlive(trait('我不喜欢被叫全名', { updatedAt: now + DAY, lastUsedAt: now + DAY }), now), true);
    assert.equal(isTraitLeaseAlive(null, now), false);
});

test('touchTrait：不可变、useCount+1、刷新 lastUsedAt；非法返回 null', () => {
    const now = 5 * DAY;
    const base = normalizeTrait(trait('我不喜欢被叫全名', { useCount: 2, lastUsedAt: DAY }));
    const touched = touchTrait(base, now);
    assert.notEqual(touched, base);
    assert.equal(base.useCount, 2);                 // 原对象未被改动
    assert.equal(base.lastUsedAt, DAY);
    assert.equal(touched.useCount, 3);
    assert.equal(touched.lastUsedAt, now);
    assert.equal(touchTrait(null, now), null);
    assert.equal(touchTrait('x', now), null);
});

test('mergeTrait：同一条合并时累积使用痕迹（较大 useCount、较新 lastUsedAt）', () => {
    const old = normalizeTrait(trait('我不喜欢被叫全名', { useCount: 5, lastUsedAt: 1000, confidence: 0.6 }));
    const first = mergeTrait([old], old);
    assert.equal(first.traits[0].useCount, 5);

    const incoming = normalizeTrait(trait('我不喜欢被叫全名', { useCount: 2, lastUsedAt: 9000, confidence: 0.9 }));
    const merged = mergeTrait(first.traits, incoming);
    assert.equal(merged.merged, true);
    assert.equal(merged.traits[0].useCount, 5);       // 取较大
    assert.equal(merged.traits[0].lastUsedAt, 9000);  // 取较新
    assert.equal(merged.traits[0].confidence, 0.9);   // 正文/来源取新
});

// ---- 可追溯：来源记忆 id 与变更历史 ----

test('normalizeTrait：保留来源记忆 id，去重、去空、最多 5 条', () => {
    const t = normalizeTrait(trait('我开始相信不解释也没关系', {
        sourceIds: ['m1', 'm1', '', null, 'm2', 'm3', 'm4', 'm5', 'm6']
    }));
    assert.deepEqual(t.sourceIds, ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.deepEqual(normalizeTrait(trait('我不喜欢被叫全名')).sourceIds, []);
    assert.deepEqual(normalizeTrait(trait('我不喜欢被叫全名', { sourceIds: 'm1' })).sourceIds, []);
});

test('mergeTrait：同一条合并时来源记忆 id 取并集，仍限 5 条', () => {
    const prev = normalizeTrait(trait('我最近很在意他有没有回消息', { sourceIds: ['a', 'b'] }));
    const incoming = normalizeTrait(trait('我最近很在意他有没有回消息', { sourceIds: ['c', 'a'] }));
    const { traits } = mergeTrait([prev], incoming);
    assert.deepEqual(traits[0].sourceIds, ['c', 'a', 'b']);
});

test('selectForInjection：缺省（lifecycle 非 live）与显式 off 结果一致（回归保护）', () => {
    const now = Date.now();
    const list = [
        trait('我不喜欢被叫全名', { confidence: 0.9, updatedAt: now }),
        trait('我更愿意安静地陪着他', { confidence: 0.7, updatedAt: now }),
        trait('我最近越来越在意他有没有回我消息', { confidence: 0.5, updatedAt: now })
    ];
    assert.deepEqual(selectForInjection(list, 3), selectForInjection(list, 3, { lifecycle: 'off' }));
});

test('selectForInjection：live 时租约过期的条目被过滤（即便置信度更高）', () => {
    const now = 10 * DAY;
    const fresh = trait('我更愿意安静地陪着他', { confidence: 0.6, updatedAt: now, lastUsedAt: now });
    const stale = trait('我不喜欢被叫全名', { confidence: 0.95, updatedAt: now - 40 * DAY, lastUsedAt: now - 40 * DAY });
    assert.deepEqual(selectForInjection([stale, fresh], 3, { lifecycle: 'live', now }), ['我更愿意安静地陪着他']);
});

test('selectForInjection：live 时「越用越像自己」——成熟条目排在生条目前', () => {
    const now = 10 * DAY;
    const newborn = trait('我更愿意安静地陪着他', { confidence: 0.6, updatedAt: now, lastUsedAt: now });
    const matured = trait('我不喜欢被叫全名', { confidence: 0.6, updatedAt: now, lastUsedAt: now, useCount: DEFAULTS.useCap });
    assert.deepEqual(selectForInjection([newborn, matured], 3, { lifecycle: 'live', now }),
        ['我不喜欢被叫全名', '我更愿意安静地陪着他']);
});

test('selectForInjection：live 时萎缩到 minMaturity 以下的条目不再注入（租约却仍在有效期）', () => {
    const now = 10 * DAY;
    // useCount=0,conf=0.6 → base=0.3；闲置 2 个半衰期 → recency=0.25 → 0.075 < minMaturity；但 < TTL 仍「活」
    const wilted = trait('我不喜欢被叫全名', { confidence: 0.6, updatedAt: now - 28 * DAY, lastUsedAt: now - 28 * DAY });
    assert.equal(isTraitLeaseAlive(wilted, now, {}), true);
    assert.ok(computeTraitMaturity(wilted, now, {}) < DEFAULTS.minMaturity);
    assert.deepEqual(selectForInjection([wilted], 3, { lifecycle: 'live', now }), []);
});

test('DEFAULTS：暴露租约/成熟度可标定参数且取值合理', () => {
    assert.ok(DEFAULTS.useCap >= 1);
    assert.ok(DEFAULTS.halfLifeDays > 0);
    assert.ok(DEFAULTS.maturityFloor > 0 && DEFAULTS.maturityFloor < 1);
    assert.ok(DEFAULTS.leaseTtlMs > 0);
    assert.ok(DEFAULTS.minMaturity >= 0 && DEFAULTS.minMaturity < DEFAULTS.maturityFloor);
});

// ——— 界线（事前自限）：唯一判据是「可被观察到地约束下一次行为」 ———

// 造一条界线条目
function boundary(text, extra = {}) {
    return {
        text,
        trigger: ['道歉'],
        avoid: ['我什么都做不好'],
        createdAt: Date.now(),
        ...extra
    };
}

test('normalizeBoundary：没有可核对的 avoid 就不是界线（只是又一句自我描述）', () => {
    assert.equal(normalizeBoundary({ text: '我以后不再自责了' }), null);
    assert.equal(normalizeBoundary({ text: '我以后不再自责了', avoid: [] }), null);
    // 片段太短（有效字符 < 2）也不算可核对
    assert.equal(normalizeBoundary({ text: '我以后不再自责了', avoid: ['嗯'] }), null);
    assert.equal(normalizeBoundary(null), null);
});

test('normalizeBoundary：补齐默认值、截断超长正文、去引号包裹', () => {
    const item = normalizeBoundary(boundary('“被道歉时别急着认错”'));
    assert.equal(item.text, '被道歉时别急着认错');
    assert.deepEqual(item.trigger, ['道歉']);
    assert.deepEqual(item.avoid, ['我什么都做不好']);
    assert.equal(item.honoredCount, 0);
    assert.equal(item.violatedCount, 0);
    assert.equal(item.lastCheckedAt, 0);
    assert.equal(item.droppedAt, 0);
    assert.ok(item.createdAt > 0);

    const long = normalizeBoundary(boundary('我'.repeat(200)));
    assert.equal(long.text.length, BOUNDARY_DEFAULTS.maxTextLen);

    assert.deepEqual(normalizeBoundary(boundary('被道歉时别急着认错', { trigger: ['a', 'b', 'c', 'd', 'e', 'f'] })).trigger,
        ['a', 'b', 'c', 'd']);
});

test('mergeBoundary：正文相近即同一条，兑现/违背次数取大不丢账', () => {
    const first = mergeBoundary([], normalizeBoundary(boundary('被道歉时别急着认错')));
    assert.equal(first.merged, false);
    assert.equal(first.boundaries.length, 1);

    const incoming = normalizeBoundary(boundary('被道歉时别急着认错', { honoredCount: 2, violatedCount: 1 }));
    const merged = mergeBoundary(first.boundaries, incoming);
    assert.equal(merged.merged, true);
    assert.equal(merged.boundaries.length, 1);
    assert.equal(merged.boundaries[0].honoredCount, 2);
    assert.equal(merged.boundaries[0].violatedCount, 1);

    const other = normalizeBoundary(boundary('他说累的时候不要追着问', { avoid: ['你根本不懂'] }));
    const third = mergeBoundary(merged.boundaries, other);
    assert.equal(third.merged, false);
    assert.equal(third.boundaries.length, 2);
});

test('retireBoundaries：过了观察期还一次没兑现 → 退场（只标记不删档）', () => {
    const now = 10 * DAY;
    const fresh = normalizeBoundary(boundary('被道歉时别急着认错', { createdAt: now - 1000 }));
    const stale = normalizeBoundary(boundary('他说累的时候不要追着问', { avoid: ['你根本不懂'], createdAt: now - 5 * DAY }));
    const proven = normalizeBoundary(boundary('别拿他的沉默当默认同意', { avoid: ['算了'], createdAt: now - 9 * DAY, honoredCount: 3 }));

    const { boundaries, retired, closing } = retireBoundaries([fresh, stale, proven], now);
    assert.equal(retired, 0);                          // 不静默退场
    assert.equal(closing, 1);                          // 到点零兑现 → 进结账期
    assert.equal(boundaries[0].droppedAt, 0);          // 观察期内：留着
    assert.equal(boundaries[0].closingAt, 0);
    assert.equal(boundaries[1].closingAt, now);         // 先结旧账，不删尺
    assert.equal(boundaries[1].droppedAt, 0);
    assert.equal(boundaries[2].droppedAt, 0);          // 兑现过：不退场
    assert.equal(boundaries[1].text, '他说累的时候不要追着问');  // 留档可审计
});

test('retireBoundaries：结账期到点仍不结账，才留一条 unclosed 的退场记录', () => {
    const now = 20 * DAY;
    const stuck = normalizeBoundary(boundary('他说累的时候不要追着问', {
        avoid: ['你根本不懂'],
        createdAt: now - 12 * DAY,
        closingAt: now - BOUNDARY_DEFAULTS.closeGraceMs - 1000
    }));
    const { boundaries, retired, closing } = retireBoundaries([stuck], now);
    assert.equal(retired, 1);
    assert.equal(closing, 0);
    assert.equal(boundaries[0].droppedAt, now);
    assert.equal(boundaries[0].unclosed, true);        // 不是「合法撤尺」，是「她没能面对」
});

test('retireBoundaries：结过账（保留/收紧）的界线不再走退场流程', () => {
    const now = 20 * DAY;
    const kept = normalizeBoundary(boundary('被道歉时别急着认错', {
        createdAt: now - 30 * DAY,
        closingAt: now - 20 * DAY,
        closedAt: now - 19 * DAY,
        resolution: 'kept'
    }));
    const { boundaries, retired } = retireBoundaries([kept], now);
    assert.equal(retired, 0);
    assert.equal(boundaries[0].droppedAt, 0);
    assert.equal(boundaries[0].resolution, 'kept');
});

test('closeBoundary：必须点名，撤销才落 droppedAt，保留/收紧不删', () => {
    const now = 20 * DAY;
    const item = normalizeBoundary(boundary('被道歉时别急着认错', { createdAt: now - 8 * DAY, closingAt: now - DAY }));

    // 没点名 = 不认，防止凭一句「我变了」就撤尺
    const miss = closeBoundary([item], '我变了', { resolution: 'dropped', now });
    assert.equal(miss.closed, null);

    // 结论必须落在白名单里
    assert.equal(closeBoundary([item], item.text, { resolution: 'whatever', now }).closed, null);

    const kept = closeBoundary([item], item.text, { resolution: 'kept', note: '上次道歉时我还是说了那句', now }).closed;
    assert.equal(kept.resolution, 'kept');
    assert.equal(kept.droppedAt, 0);
    assert.equal(kept.closeNote, '上次道歉时我还是说了那句');
    assert.equal(kept.closedAt, now);

    const dropped = closeBoundary([item], item.text, { resolution: 'dropped', note: '换一种方式', now }).closed;
    assert.equal(dropped.droppedAt, now);
    assert.equal(dropped.unclosed, false);              // 这是合法撤尺，不是逃避

    // 模型复述差几个字也要认得出
    const fuzzy = closeBoundary([item], '被道歉的时候别急着认错', { resolution: 'revised', now }).closed;
    assert.ok(fuzzy);
    assert.equal(fuzzy.resolution, 'revised');
});

test('selectBoundariesForInjection：只带进触发词命中本轮输入的条目', () => {
    const now = Date.now();
    const hit = normalizeBoundary(boundary('被道歉时别急着认错', { createdAt: now }));
    const miss = normalizeBoundary(boundary('他说累的时候不要追着问', { avoid: ['你根本不懂'], trigger: ['加班'] }));

    const picked = selectBoundariesForInjection([hit, miss], { now, query: '我跟你道歉，昨天是我不好' });
    assert.equal(picked.length, 1);
    assert.equal(picked[0].text, '被道歉时别急着认错');

    // 没有输入（主动开口）时全放行，交给后续排序限条
    assert.equal(selectBoundariesForInjection([hit, miss], { now, query: '' }).length, 2);
    // 无命中的普通闲聊不注入
    assert.deepEqual(selectBoundariesForInjection([hit, miss], { now, query: '今天天气不错' }), []);
});

test('selectBoundariesForInjection：已退场 / 过了观察期零兑现且未兑现过的不再注入', () => {
    const now = 10 * DAY;
    const dropped = normalizeBoundary(boundary('被道歉时别急着认错', { createdAt: now, droppedAt: now }));
    const expired = normalizeBoundary(boundary('他说累的时候不要追着问', { avoid: ['你根本不懂'], createdAt: now - 5 * DAY }));
    assert.deepEqual(selectBoundariesForInjection([dropped, expired], { now, query: '道歉' }), []);
});

test('selectBoundariesForInjection：待结账的最优先，且不因触发词没命中就被跳过', () => {
    const now = Date.now();
    const pending = normalizeBoundary(boundary('他说累的时候不要追着问', {
        avoid: ['你根本不懂'], trigger: ['加班'], createdAt: now - 5 * DAY, closingAt: now
    }));
    const settled = normalizeBoundary(boundary('被道歉时别急着认错', { trigger: ['道歉'], createdAt: now, honoredCount: 2 }));

    const picked = selectBoundariesForInjection([settled, pending], { now, query: '今天天气不错', limit: 2 });
    assert.equal(picked.length, 1);   // 欠的账不会因为这一轮没聊到就消失
    assert.equal(picked[0].text, '他说累的时候不要追着问');

    // 结过账的重新变成普通条目：没命中就不带
    const closed = closeBoundary([pending], pending.text, { resolution: 'kept', now }).boundaries[0];
    assert.deepEqual(selectBoundariesForInjection([closed], { now, query: '今天天气不错' }), []);
});

test('parseBoundaryCloseOutput：只认「结账｜结论｜做到」三件；不与界线行、认知行串味', () => {
    const raw = [
        '结账：被道歉时别急着认错｜结论：撤销｜做到：上次道歉时我还是说了「我什么都做不好」',
        '结账：他说累的时候不要追着问｜结论：收紧',
        '结账：只写了名字没有结论',
        '界线：真界线别急着认错｜触发：道歉｜不说：都是我的错'
    ].join('\n');
    const out = parseBoundaryCloseOutput(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, '被道歉时别急着认错');
    assert.equal(out[0].resolution, 'dropped');
    assert.ok(out[0].note.includes('我什么都做不好'));
    assert.equal(out[1].resolution, 'revised');   // 缺「做到」仍可结账，只是没有补救内容

    // 结账行不能同时被当成新界线，也不能被当成自我认知
    assert.deepEqual(parseBoundaryOutput(raw).map(item => item.text), ['真界线别急着认错']);
    assert.deepEqual(parseSelfTraitOutput(raw), []);
    assert.ok(BOUNDARY_RESOLUTIONS.includes('dropped'));
});

test('parseBoundaryOutput：只认规定格式，缺任一字段整行丢弃；被当成 trait 的行不会混进来', () => {
    const raw = [
        '界线：被道歉时别急着认错｜触发：道歉,对不起｜不说：我什么都做不好,都是我的错',
        '界线：缺了不说字段这条不算｜触发：道歉',
        '这条不是界线格式',
        '```'
    ].join('\n');
    const out = parseBoundaryOutput(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '被道歉时别急着认错');
    assert.deepEqual(out[0].trigger, ['道歉', '对不起']);
    assert.deepEqual(out[0].avoid, ['我什么都做不好', '都是我的错']);

    // parseSelfTraitOutput 不能把界线行当成自我认知收走
    assert.deepEqual(parseSelfTraitOutput('界线：被道歉时别急着认错｜触发：道歉｜不说：我什么都做不好'), []);
    assert.deepEqual(parseBoundaryOutput(null), []);
});

test('normalizeModel：同时归一 traits 与 boundaries，坏档补空数组', () => {
    const model = normalizeModel({
        traits: [{ text: '我不喜欢被叫全名' }],
        boundaries: [boundary('被道歉时别急着认错'), { text: '没有不说字段' }]
    });
    assert.equal(model.traits.length, 1);
    assert.equal(model.boundaries.length, 1);
    assert.equal(normalizeModel(null).boundaries.length, 0);
    assert.deepEqual(normalizeModel({ traits: [] }).boundaries, []);
});
