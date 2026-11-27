'use strict';

const { ROUTES } = require('./creativeWorld');

// 🍺 酒馆节律：把「现在几点」翻译成「谁该站在哪、在做什么」。
// 计划部分是纯函数（不碰 fs、不碰网络），方便单测；真正挪人、收钱由 TavernKeeper 做。
// 点位按 creativeWorld 的 ROUTES 排，不做寻路——这间馆子是一整片空地，直线过去就行。

// 同一段作息里隔多久换个点位，让「看店」不是一根柱子站到底
const ROTATE_MINUTES = 10;
const SAY_TTL = 120000;

// from / to 是小时（可带小数，左闭右开）；routes 里放 ROUTES 的点位名
const PLAN = Object.freeze({
  ai: Object.freeze([
    { from: 0, to: 6, routes: ['barIn'], action: '休息', text: '趴在后厨打盹，杯盏都收进了柜子' },
    { from: 6, to: 9, routes: ['tableA', 'tableB'], action: '打扫', text: '擦桌子、把凳子归位' },
    { from: 9, to: 10, routes: ['door'], action: '开门', text: '把门板支起来，让街上的人看见店里亮了灯' },
    { from: 10, to: 12, routes: ['barFront', 'tableA', 'barFront', 'tableB'], action: '看店', text: '在吧台前招呼客人、擦杯子' },
    { from: 12, to: 13, routes: ['tableB'], action: '午饭', text: '坐在南侧桌边吃午饭' },
    { from: 13, to: 17, routes: ['barrel', 'barIn'], action: '备料', text: '搬酒、切配菜，顺口哼歌' },
    { from: 17, to: 19, routes: ['barFront'], action: '看店', text: '在吧台前看店，准备晚市' },
    { from: 19, to: 21, routes: ['tableA', 'tableB', 'barFront'], action: '陪客', text: '端酒上桌，陪客人说话' },
    { from: 21, to: 24, routes: ['barIn'], action: '收尾', text: '洗杯子、把吧台抹干净' }
  ]),
  you: Object.freeze([
    { from: 0, to: 7, routes: ['backroom'], action: '歇下', text: '在后间算账，算着算着打起盹' },
    { from: 7, to: 9, routes: ['door', 'barrel'], action: '收货', text: '开门收货，把酒坛搬进后间' },
    { from: 9, to: 12, routes: ['barIn'], action: '坐镇', text: '站在吧台后，守着钱箱' },
    { from: 12, to: 13, routes: ['tableA'], action: '午饭', text: '在桌边吃午饭，顺便歇脚' },
    { from: 13, to: 18, routes: ['barIn', 'barFront'], action: '看店', text: '在吧台后来回踱步，看店里客流' },
    { from: 18, to: 20, routes: ['barFront'], action: '迎客', text: '站在吧台前迎晚市的客人' },
    { from: 20, to: 22, routes: ['tableA', 'tableB'], action: '陪客', text: '坐到桌边跟客人聊两句' },
    { from: 22, to: 24, routes: ['backroom'], action: '算账', text: '回后间清点今天的进项' }
  ])
});

// 点单：到点由 AI 角色走到吧台付钱。金额压得小，免得两天就把她的钱包掏空
const ORDERS = Object.freeze([
  { id: 'lunch', from: 11.4, to: 11.6, amount: 2, dish: '烤鱼饭', line: '老板，来一份烤鱼饭，2 金币放柜上了。' },
  { id: 'dinner', from: 18.4, to: 18.6, amount: 3, dish: '麦酒配炖肉', line: '晚市来一份麦酒配炖肉，3 金币给你。' }
]);

const SPEED = 0.9;          // 格 / 秒，走起来不快，像在店里晃
const PERSIST_MS = 30000;   // 位置落盘间隔：每 3 秒挪人，但不能每 3 秒写一次世界

function pad(n) {
  return String(n).padStart(2, '0');
}

function hourOf(now) {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

function minutesOf(now) {
  return now.getHours() * 60 + now.getMinutes();
}

function dayKey(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function phaseOf(id, hour) {
  const table = PLAN[id];
  if (!table) return null;
  return table.find((item) => hour >= item.from && hour < item.to) || null;
}

// 纯逻辑：某个角色此刻该去的点位与动作
function planFor(id, now = new Date()) {
  const phase = phaseOf(id, hourOf(now));
  if (!phase) return null;
  const names = phase.routes;
  // 按 10 分钟一格轮换点位，同一个人在同一段作息里也会挪几次
  const slot = Math.floor(minutesOf(now) / ROTATE_MINUTES);
  const routeName = names[slot % names.length];
  const route = ROUTES[routeName];
  if (!route) return null;
  return {
    id,
    route: routeName,
    label: route.label,
    x: route.x,
    z: route.z,
    action: phase.action,
    text: phase.text
  };
}

// 纯逻辑：朝目标走一步，最多走 maxDistance 格；到了就贴住目标，避免抖动
function stepToward(current, target, maxDistance) {
  const x = Number(current && current.x);
  const z = Number(current && current.z);
  const tx = Number(target && target.x);
  const tz = Number(target && target.z);
  if (![x, z, tx, tz].every(Number.isFinite)) return { x, z, arrived: false };
  const dx = tx - x;
  const dz = tz - z;
  const dist = Math.hypot(dx, dz);
  const step = Math.max(0, Number(maxDistance) || 0);
  if (dist <= step || dist < 1e-6) return { x: tx, z: tz, arrived: true };
  return { x: x + (dx / dist) * step, z: z + (dz / dist) * step, arrived: false };
}

// 纯逻辑：此刻是否踩在某个点单窗口里
function orderDue(now = new Date()) {
  const hour = hourOf(now);
  const order = ORDERS.find((item) => hour >= item.from && hour < item.to);
  if (!order) return null;
  return { ...order, key: `${dayKey(now)}#${order.id}` };
}

// 给提示词用：一眼看清店里此刻谁在哪、刚才说了什么
function describeScene(now = new Date(), characters = []) {
  if (!Array.isArray(characters) || characters.length === 0) return '';
  const lines = [`此刻（${pad(now.getHours())}:${pad(now.getMinutes())}）店里：`];
  characters.forEach((who) => {
    const plan = planFor(who.id, now);
    if (!plan) return;
    lines.push(`- ${who.name || who.id}在${plan.label}，${plan.text}`);
    if (who.say && now.getTime() - (who.sayAt || 0) < SAY_TTL) {
      lines.push(`  刚说：「${who.say}」`);
    }
  });
  return lines.join('\n');
}

// 有状态的一层：只做「按时间挪人 + 到点收钱」，不直接读时钟以外的外部状态
class TavernKeeper {
  constructor({ world, speed = SPEED, persistMs = PERSIST_MS } = {}) {
    this.world = world;
    this.speed = speed;
    this.persistMs = persistMs;
    this.lastAt = 0;
    this.lastPersist = 0;
  }

  tick(now = new Date()) {
    if (!this.world || !Array.isArray(this.world.characters)) return null;
    const at = now instanceof Date ? now : new Date(now);
    const ts = at.getTime();
    // 间隔封顶 60 秒：机器睡眠后醒来别一口气瞬移半个店
    const dt = this.lastAt ? Math.min(60, Math.max(0, (ts - this.lastAt) / 1000)) : 0;
    this.lastAt = ts;

    let moved = false;
    this.world.characters.forEach((who) => {
      const plan = planFor(who.id, at);
      if (!plan) return;
      who.action = plan.text;
      if (typeof this.world.setPose !== 'function') return;
      const next = stepToward(who, plan, this.speed * dt);
      if (next.x !== who.x || next.z !== who.z) {
        this.world.setPose(who.id, next.x, next.z);
        moved = true;
      }
    });

    if (moved && ts - this.lastPersist >= this.persistMs && typeof this.world.persist === 'function') {
      this.world.persist();
      this.lastPersist = ts;
    }

    return this.maybeOrder(at);
  }

  // 点单闭环：她走到窗口时间就付钱给老板并开口；同一天同一个窗口只收一次
  maybeOrder(now) {
    const order = orderDue(now);
    if (!order) return null;
    if (typeof this.world.hasTavernEvent === 'function' && this.world.hasTavernEvent(order.key)) return null;

    const payer = this.world.characters.find((item) => item.id === 'ai');
    if (!payer) return null;

    const paid = typeof this.world.pay === 'function'
      ? this.world.pay({ from: 'ai', to: 'you', amount: order.amount })
      : { success: false };
    if (!paid.success) {
      // 钱不够就只说话不扣钱，然后把窗口记掉，免得每 3 秒重复喊
      this.world.say({ id: 'ai', text: `想吃${order.dish}，可钱包只剩 ${payer.wallet} 金币…` });
    } else {
      this.world.say({ id: 'ai', text: order.line });
    }
    if (typeof this.world.markTavernEvent === 'function') this.world.markTavernEvent(order.key);
    return paid;
  }
}

module.exports = {
  PLAN,
  ORDERS,
  SPEED,
  dayKey,
  hourOf,
  planFor,
  stepToward,
  orderDue,
  describeScene,
  TavernKeeper
};
