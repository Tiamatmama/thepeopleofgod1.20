// 负向好感区间的修复阻尼：纯算术单测。
// 只 require 模块拿纯函数，不构造 GalgameModule（构造会读写 data/，测试不该碰真实档）
const { test } = require('node:test');
const assert = require('node:assert');

const GalgameModule = require('../src/core/galgame');
const { applyRecoveryDamping, DEFAULT_RECOVERY_DAMPING, DELAYED_REPAIR_WINDOW_MS } = GalgameModule;

// 借原型造一个不落盘的实例：构造器会 ensureStorageDir/loadRelationship，会碰 data/，
// 这里只做 Object.create + 覆盖掉写盘与日志两个副作用方法
function makeInstance() {
  const inst = Object.create(GalgameModule.prototype);
  inst.relationships = {};
  inst.negativeRecoveryDamping = DEFAULT_RECOVERY_DAMPING;
  inst.affectionRules = [];
  inst.relationshipStages = { STRANGER: { name: '陌生', availableActions: [], availableVoices: [], permissions: [] } };
  inst.getRelationshipStage = () => 'STRANGER';
  inst.getRelationshipStageByScore = () => 'STRANGER';
  inst.saveRelationship = () => {};
  inst.logs = [];
  inst.logAffectionChange = (...args) => { inst.logs.push(args); };
  return inst;
}

test('D1：分数在负区间时，正向收益按七成折算', () => {
  assert.equal(applyRecoveryDamping(-50, 10), 7);
  assert.equal(applyRecoveryDamping(-50, 5), 4);   // 3.5 → 4
  assert.equal(applyRecoveryDamping(-1, 3), 2);    // 2.1 → 2
  assert.equal(DEFAULT_RECOVERY_DAMPING, 0.7);
});

test('D2：小额正向收益保底 +1，做对的事不能毫无进展', () => {
  assert.equal(applyRecoveryDamping(-80, 1), 1);   // 0.7 → 保底 1
  assert.equal(applyRecoveryDamping(-80, 2), 1);   // 1.4 → 1
  assert.equal(applyRecoveryDamping(-80, 10, 0), 1); // 系数归零也只保底 1
});

test('D3：分数 >= 0 时不打折，负向变化与零变化原样通过', () => {
  assert.equal(applyRecoveryDamping(0, 10), 10);
  assert.equal(applyRecoveryDamping(40, 5), 5);
  assert.equal(applyRecoveryDamping(100, 3), 3);
  assert.equal(applyRecoveryDamping(-30, -5), -5);
  assert.equal(applyRecoveryDamping(20, -10), -10);
  assert.equal(applyRecoveryDamping(-30, 0), 0);
});

test('D4：系数为 1 等于关闭阻尼；系数越界按 [0,1] 夹取', () => {
  assert.equal(applyRecoveryDamping(-50, 10, 1), 10);
  assert.equal(applyRecoveryDamping(-50, 10, 2), 10);    // >1 夹到 1
  assert.equal(applyRecoveryDamping(-50, 10, -1), 1);    // <0 夹到 0，剩保底
  assert.equal(applyRecoveryDamping(-50, 4, 0.5), 2);
});

test('D5：系数为空或非法时回落默认值 0.7（null 不等于关闭）', () => {
  assert.equal(applyRecoveryDamping(-50, 10, NaN), 7);
  assert.equal(applyRecoveryDamping(-50, 10, 'abc'), 7);
  assert.equal(applyRecoveryDamping(-50, 10, null), 7);
  assert.equal(applyRecoveryDamping(-50, 10, undefined), 7);
});

test('D6：入参非有限数时原样返回，不制造 NaN', () => {
  assert.equal(applyRecoveryDamping(NaN, 10), 10);
  assert.equal(applyRecoveryDamping(-50, NaN), NaN);
  assert.equal(applyRecoveryDamping(undefined, 5), 5);
  assert.equal(applyRecoveryDamping(-50, '7'), 5);     // 字符串数字按数算：7×0.7=4.9→5
});

test('D7：跨过零点的那一轮只按当时状态折算，不追溯', () => {
  // -3 + 7 → 阻尼后 +5 → 2（回到正区间），下一轮起全额
  const gain = applyRecoveryDamping(-3, 7);
  assert.equal(gain, 5);
  assert.equal(-3 + gain, 2);
  assert.equal(applyRecoveryDamping(2, 7), 7);
});

test('D8：类挂出来的常量与纯函数默认值同源', () => {
  assert.equal(GalgameModule.DEFAULT_RECOVERY_DAMPING, 0.7);
  assert.equal(GalgameModule.DEFAULT_RECOVERY_DAMPING, DEFAULT_RECOVERY_DAMPING);
  assert.equal(DELAYED_REPAIR_WINDOW_MS, 48 * 60 * 60 * 1000);
});

// ——— 明账：阻尼必须同时留下一条「这句还没接住」的迟疑 ———

test('G1：阻尼生效时留下迟延记录（48 小时窗口、差额可查）', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.currentScore = -10;
  const r = inst.updateRelationship({}, 10, 'test', 's', 'u');

  assert.equal(r.affectionChange.change, 7);        // 打七折
  assert.equal(r.affectionChange.currentScore, -3);
  assert.equal(r.affectionChange.delayed, true);
  assert.ok(r.affectionChange.delayedRepair, '应留下迟延记录');
  assert.equal(r.affectionChange.delayedRepair.gap, 3);   // 少给的那 3 分就是「还没接住」的量
  assert.ok(r.affectionChange.delayedRepair.expireAt - r.affectionChange.delayedRepair.at === DELAYED_REPAIR_WINDOW_MS);
  assert.equal(r.affectionChange.recovered, false);
});

test('G2：连续阻尼不重置窗口，只累加没接住的那部分', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.currentScore = -60;
  const first = inst.updateRelationship({}, 10, 'test', 's', 'u');
  const at = first.affectionChange.delayedRepair.at;
  const expireAt = first.affectionChange.delayedRepair.expireAt;
  const second = inst.updateRelationship({}, 10, 'test', 's', 'u');

  assert.equal(second.affectionChange.delayedRepair.at, at);
  assert.equal(second.affectionChange.delayedRepair.expireAt, expireAt);
  assert.equal(second.affectionChange.delayedRepair.gap, 6);
  assert.equal(second.affectionChange.currentScore, -46);
});

test('G3：回到正区间即修复落定，迟疑清空且不追加旧账', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.currentScore = -20;
  inst.updateRelationship({}, 10, 'test', 's', 'u');   // -13，仍为负，挂着迟疑
  inst.updateRelationship({}, 10, 'test', 's', 'u');   // -6，仍为负

  const r = inst.updateRelationship({}, 10, 'test', 's', 'u');   // 跨过零点：-6 + 7 = 1
  assert.equal(r.affectionChange.recovered, true);
  assert.equal(r.affectionChange.delayedRepair, null);
  assert.equal(r.affectionChange.currentScore, 1);
  // 这一轮当时还在负区间，所以仍按七折；落定之后不再追加任何惩罚
  assert.equal(r.affectionChange.change, 7);

  const next = inst.updateRelationship({}, 10, 'test', 's', 'u');
  assert.equal(next.affectionChange.change, 10);   // 已回到正区间，全额
  assert.equal(next.affectionChange.delayed, false);
});

test('G4：过了 48 小时仍未走回正区间，迟疑按失效处理', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.currentScore = 5;
  state.delayedRepair = { at: Date.now() - 1000, lastAt: Date.now() - 1000, expireAt: Date.now() - 1, fromScore: -20, gap: 3 };

  const r = inst.updateRelationship({}, 10, 'test', 's', 'u');
  assert.equal(r.affectionChange.delayedRepair, null);
  assert.equal(r.affectionChange.recovered, false);   // 失效不算「修复落定」
});

test('G5：getDelayedRepair 只返回窗口内的迟疑，过期即 null', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.delayedRepair = { at: Date.now(), lastAt: Date.now(), expireAt: Date.now() + 1000, fromScore: -10, gap: 3 };
  const pending = inst.getDelayedRepair('s', 'u');
  assert.ok(pending);
  assert.equal(pending.gap, 3);

  state.delayedRepair.expireAt = Date.now() - 1;
  assert.equal(inst.getDelayedRepair('s', 'u'), null);
  assert.equal(inst.getDelayedRepair('s', 'nobody'), null);   // 无档位也不炸
});

test('G6：日志带 delayed / recovered 两个观测字段，不再只记分数', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.currentScore = -10;
  inst.updateRelationship({}, 10, 'test', 's', 'u');
  const opts = inst.logs[0][7];
  assert.equal(opts.delayed, true);
  assert.equal(opts.recovered, false);
  assert.ok(opts.delayedRepair);

  const r2 = inst.updateRelationship({}, -10, 'test', 's', 'u');
  assert.equal(inst.logs[1][7].delayed, false);
  assert.equal(r2.affectionChange.change, -10);   // 负向不受阻尼影响
});

test('G7：关系快照自带 delayedRepair，各通道拿同一份快照就能看见迟疑', () => {
  const inst = makeInstance();
  const state = inst.getRelationshipState('s', 'u');
  state.currentScore = -10;
  inst.updateRelationship({}, 10, 'test', 's', 'u');

  const relation = inst.getCurrentRelationship('s', 'u');
  assert.ok(relation.delayedRepair, '关系快照应带出还没落定的迟疑');
  assert.equal(relation.delayedRepair.gap, 3);
  assert.equal(relation.stage, 'STRANGER');

  // 没有迟疑时字段恒为 null（形状稳定，上层不用判断 undefined）
  assert.equal(inst.getCurrentRelationship('s', 'nobody').delayedRepair, null);
});
