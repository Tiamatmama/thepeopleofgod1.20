'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ROUTES } = require('../src/core/creativeWorld');
const {
  PLAN,
  planFor,
  stepToward,
  orderDue,
  describeScene,
  TavernKeeper
} = require('../src/core/tavernClock');

function at(hour, minute = 0, second = 0, day = 25) {
  return new Date(2026, 10, day, hour, minute, second);
}

// 假的 world：只实现 TavernKeeper 用到的几个方法，避免测试去碰真实的 data/creative
function makeWorld() {
  const calls = { persist: 0, pays: [], says: [], events: new Set() };
  return {
    calls,
    characters: [
      { id: 'you', name: '你', x: 6.3, z: 11.5, wallet: 20 },
      { id: 'ai', name: '她', x: 6.3, z: 11.5, wallet: 10 }
    ],
    setPose(id, x, z) {
      const who = this.characters.find((item) => item.id === id);
      if (who) { who.x = x; who.z = z; }
    },
    persist() { calls.persist += 1; },
    hasTavernEvent(key) { return calls.events.has(key); },
    markTavernEvent(key) { calls.events.add(key); },
    pay(input) {
      calls.pays.push(input);
      const from = this.characters.find((item) => item.id === input.from);
      const to = this.characters.find((item) => item.id === input.to);
      if (!from || !to || from.wallet < input.amount) return { success: false };
      from.wallet -= input.amount;
      to.wallet += input.amount;
      return { success: true };
    },
    say(input) { calls.says.push(input); }
  };
}

test('作息表覆盖全天且点位都存在', () => {
  Object.entries(PLAN).forEach(([id, phases]) => {
    assert.equal(phases[0].from, 0, `${id} 应该从 0 点开始`);
    assert.equal(phases[phases.length - 1].to, 24, `${id} 应该覆盖到 24 点`);
    phases.forEach((phase) => {
      assert.ok(phase.to > phase.from, `${id} 的时段必须递增`);
      phase.routes.forEach((name) => assert.ok(ROUTES[name], `缺少点位 ${name}`));
    });
  });
});

test('不同时段给不同点位', () => {
  const dawn = planFor('ai', at(3, 0));
  const morning = planFor('ai', at(10, 5));
  const noon = planFor('ai', at(12, 30));
  assert.equal(dawn.route, 'barIn');
  assert.equal(morning.route, 'barFront');
  assert.equal(noon.route, 'tableB');
  assert.notEqual(dawn.route, noon.route);
});

test('同一段作息内按 10 分钟轮换点位', () => {
  const first = planFor('ai', at(10, 5));
  const later = planFor('ai', at(10, 15));
  assert.notEqual(first.route, later.route);
  assert.ok(first.x !== later.x || first.z !== later.z);
});

test('stepToward 限制单步距离并在到达后贴住目标', () => {
  const far = stepToward({ x: 0, z: 0 }, { x: 10, z: 0 }, 1);
  assert.ok(Math.abs(far.x - 1) < 1e-9);
  assert.equal(far.arrived, false);

  const near = stepToward({ x: 9.8, z: 0 }, { x: 10, z: 0 }, 1);
  assert.deepEqual(near, { x: 10, z: 0, arrived: true });
});

test('点单只在窗口内触发，并带上当天去重键', () => {
  assert.equal(orderDue(at(9, 0)), null);
  const lunch = orderDue(at(11, 30));
  assert.equal(lunch.id, 'lunch');
  assert.equal(lunch.key, '2026-11-25#lunch');
  const dinner = orderDue(at(18, 30));
  assert.equal(dinner.id, 'dinner');
});

test('describeScene 会带出位置、动作和刚才说的话', () => {
  const now = at(10, 5);
  const text = describeScene(now, [
    { id: 'ai', name: '她', say: '来一份烤鱼饭，2 金币放柜上了。', sayAt: now.getTime() - 1000 }
  ]);
  assert.match(text, /她/);
  assert.match(text, /吧台前/);
  assert.match(text, /烤鱼饭/);
});

test('TavernKeeper：到点只收一次钱，并让角色开口', () => {
  const world = makeWorld();
  const keeper = new TavernKeeper({ world });
  const now = at(11, 30);

  keeper.tick(now);
  keeper.tick(now);

  assert.equal(world.calls.pays.length, 1);
  assert.equal(world.calls.pays[0].from, 'ai');
  assert.equal(world.calls.pays[0].to, 'you');
  assert.equal(world.calls.pays[0].amount, 2);
  assert.ok(world.calls.says.some((item) => /烤鱼饭/.test(item.text)));
  assert.ok(world.calls.events.has('2026-11-25#lunch'));
});

test('TavernKeeper：钱包不够时只说话不扣钱，也不重复喊', () => {
  const world = makeWorld();
  world.characters.find((item) => item.id === 'ai').wallet = 1;
  const keeper = new TavernKeeper({ world });
  const now = at(18, 30);

  keeper.tick(now);
  keeper.tick(now);

  assert.equal(world.calls.pays.length, 1); // 尝试过，但失败
  assert.ok(world.calls.says.some((item) => /钱包/.test(item.text)));
  assert.equal(world.characters.find((item) => item.id === 'you').wallet, 20);
});

test('TavernKeeper：会朝目标移动，落盘按间隔节流', () => {
  const world = makeWorld();
  const keeper = new TavernKeeper({ world, persistMs: 30000 });
  const ai = world.characters.find((item) => item.id === 'ai');
  const startX = ai.x;

  // 10:05 的目标是吧台前，从吧台后出发要往东走
  keeper.tick(at(10, 5, 0));
  keeper.tick(at(10, 5, 3));
  keeper.tick(at(10, 5, 6));

  assert.ok(ai.x > startX, '应该朝东移动');
  assert.ok(world.calls.persist >= 1, '移动后应至少落盘一次');
});
