'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 自由创意世界：把「概念」当成方块，在地台上一个个摆出来。
// 精度要求不高，所以不碰贴图管线——每种方块只有一个基色，棋盘格与明暗面交给前端算。
// 这里只管状态：调色板 / 网格 / 放置 / 移除 / 快照评分 / 原子落盘（data/creative/world.json）。

// 世界尺寸：24×24 的地台，最高 12 层。大到能塞下一间酒馆大厅，又不至于让 2.5D 渲染糊成一片。
const SIZE = Object.freeze({ x: 24, y: 12, z: 24 });

// 调色板：8 个基色，覆盖「地 / 木 / 石 / 水 / 植 / 砖 / 沙 / 特殊」这类常见语义
const PALETTE = Object.freeze([
  { id: 'grass', name: '草地', color: '#6aa84f' },
  { id: 'soil', name: '泥土', color: '#8b5a2b' },
  { id: 'stone', name: '石头', color: '#8c8c8c' },
  { id: 'water', name: '水', color: '#3d7ea6' },
  { id: 'wood', name: '木头', color: '#a97447' },
  { id: 'leaf', name: '树叶', color: '#4f8f3a' },
  { id: 'sand', name: '沙', color: '#d9c27e' },
  { id: 'brick', name: '砖', color: '#a44a3f' },
  { id: 'cloth', name: '绒布', color: '#8e3b4a' },
  { id: 'food', name: '食物', color: '#d9a441' },
  { id: 'coin', name: '金币', color: '#e9c25b' },
  // 家具：前端按几何层拆成桌面薄板 + 细腿 / 靠背，不再是一整块立方体
  { id: 'table', name: '木桌', color: '#9a7247' },
  { id: 'stool', name: '木凳', color: '#8d6a42' },
  { id: 'bar', name: '吧台', color: '#a97c4c' },
  { id: 'chair_n', name: '椅子·北背', color: '#8a6540' },
  { id: 'chair_s', name: '椅子·南背', color: '#8a6540' },
  { id: 'chair_e', name: '椅子·东背', color: '#8a6540' },
  { id: 'chair_w', name: '椅子·西背', color: '#8a6540' }
]);

const PALETTE_IDS = new Set(PALETTE.map((item) => item.id));
const VERSION = 1;

// 人物：站在世界里的两个角色，只能平移不能影响方块。
// 坐标用连续值（格子中心 0.5 起算），落地高度由脚下最高的方块自动算。
const DEFAULT_CHARACTERS = Object.freeze([
  { id: 'you', name: '你', skin: '#d8a273', cloth: '#3f5f8f', x: 6.5, z: 11.5, wallet: 20 },
  { id: 'ai', name: '她', skin: '#f0d6bd', cloth: '#2f7f86', x: 13.5, z: 12.5, wallet: 8 }
]);
// 台词只是现场气泡，不进存档：说出来两分钟后前端自己淡掉
const SAY_TTL = 120000;
// 钱箱区：酒架顶上的一排台面，每枚金币代表 10 个金币，按十位准数摆放
const COIN_CELLS = [[5, 3, 8], [5, 3, 9], [5, 3, 10], [5, 3, 11], [5, 3, 12], [5, 3, 13]];
const COIN_UNIT = 10;

// 酒馆点位：按现在这版布局取的落脚点（吧台在 x=7、桌区在 x=14~16、门在南边 x=11~12）。
// 连续坐标以格子中心 0.5 为准；tavernClock 只在这些点之间排作息，不做寻路。
const ROUTES = Object.freeze({
  barIn: Object.freeze({ x: 6.3, z: 11.5, label: '吧台后' }),
  barFront: Object.freeze({ x: 8.4, z: 12.5, label: '吧台前' }),
  barrel: Object.freeze({ x: 5.5, z: 10.2, label: '酒桶旁' }),
  tableA: Object.freeze({ x: 12.5, z: 11.5, label: '西侧桌边' }),
  tableB: Object.freeze({ x: 12.5, z: 15.5, label: '南侧桌边' }),
  door: Object.freeze({ x: 11.5, z: 20.5, label: '门口' }),
  backroom: Object.freeze({ x: 4.5, z: 19.5, label: '后间' })
});

function keyOf(x, y, z) {
  return `${x},${y},${z}`;
}

function parseKey(key) {
  const parts = String(key || '').split(',').map((part) => parseInt(part, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// 纯逻辑：从方块表算评分（便于单测，不碰 fs）
// 三个分量都直白可解释：铺了多少、用了多少种、左右/前后是否对称
function scoreWorld(blocks, size = SIZE) {
  const coords = Object.keys(blocks).map(parseKey).filter(Boolean);
  if (!coords.length) {
    return {
      total: 0,
      occupancy: 0,
      variety: 0,
      symmetry: 0,
      placed: 0,
      layers: 0
    };
  }
  const placed = coords.length;
  // 铺设度按地台面积定标：铺满约四成算满分，24×24 时约 230 块
  const occupancy = clamp01(placed / Math.max(16, size.x * size.z * 0.4));
  const variety = clamp01(new Set(coords.map((c) => blocks[keyOf(c.x, c.y, c.z)])).size / PALETTE.length);

  let mirrorX = 0;
  let mirrorZ = 0;
  for (const c of coords) {
    if (blocks[keyOf(size.x - 1 - c.x, c.y, c.z)]) mirrorX += 1;
    if (blocks[keyOf(c.x, c.y, size.z - 1 - c.z)]) mirrorZ += 1;
  }
  const symmetry = (mirrorX / placed + mirrorZ / placed) / 2;
  const layers = Math.max(...coords.map((c) => c.y)) + 1;

  return {
    total: Math.round(100 * (0.4 * occupancy + 0.3 * variety + 0.3 * symmetry)),
    occupancy: Number(occupancy.toFixed(2)),
    variety: Number(variety.toFixed(2)),
    symmetry: Number(symmetry.toFixed(2)),
    placed,
    layers
  };
}

class CreativeWorld {
  constructor(options = {}) {
    this.root = options.root || path.join(__dirname, '..', '..');
    this.file = options.file || path.join(this.root, 'data', 'creative', 'world.json');
    this.size = { ...SIZE };
    this.blocks = {};
    this.characters = DEFAULT_CHARACTERS.map((item) => ({ ...item, say: '', sayAt: 0 }));
    // 酒馆当日一次性事件（点单等）的去重记录：跨天自动清空，只留最近 40 条
    this.tavern = { day: '', events: [] };
    this.load();
    this.syncCoins();
  }

  // 坏档不抛错：读不出来就当空世界，下一次落盘会覆盖，避免整个页面 500
  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.blocks = {};
      return this;
    }
    const blocks = raw && raw.blocks && typeof raw.blocks === 'object' ? raw.blocks : {};
    const clean = {};
    for (const [key, id] of Object.entries(blocks)) {
      const coord = parseKey(key);
      if (!coord || !PALETTE_IDS.has(id)) continue;
      if (!this.inBounds(coord)) continue;
      clean[key] = id;
    }
    this.blocks = clean;

    // 人物跟随存档；缺字段就退回默认位，避免旧档把角色弄丢
    const saved = Array.isArray(raw && raw.characters) ? raw.characters : [];
    this.characters = DEFAULT_CHARACTERS.map((base) => {
      const hit = saved.find((item) => item && item.id === base.id);
      const spawn = { ...base, say: '', sayAt: 0 };
      if (!hit) return spawn;
      const x = Number(hit.x);
      const z = Number(hit.z);
      return {
        ...spawn,
        x: Number.isFinite(x) ? Math.min(this.size.x - 0.2, Math.max(0.2, x)) : base.x,
        z: Number.isFinite(z) ? Math.min(this.size.z - 0.2, Math.max(0.2, z)) : base.z,
        wallet: Number.isFinite(Number(hit.wallet)) ? Math.max(0, Math.floor(Number(hit.wallet))) : base.wallet
      };
    });

    // 事件去重记录：坏档按空处理，宁可当天多触发一次，也别让读档失败卡住整个世界
    const tavern = raw && raw.tavern;
    if (tavern && typeof tavern.day === 'string' && Array.isArray(tavern.events)) {
      this.tavern = {
        day: tavern.day,
        events: tavern.events.filter((item) => typeof item === 'string').slice(-40)
      };
    }
    return this;
  }

  // 脚下最高的方块顶面：从地面往上找，遇到第一个空位就停（避免站到屋顶上）
  feetOf(x, z) {
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    let y = 0;
    while (y < this.size.y && this.blocks[keyOf(cx, y, cz)]) y += 1;
    return y;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomicSync(this.file, {
      version: VERSION,
      size: this.size,
      blocks: this.blocks,
      characters: this.characters.map((item) => ({ id: item.id, x: item.x, z: item.z, wallet: item.wallet })),
      tavern: { day: this.tavern.day, events: this.tavern.events.slice(-40) }
    });
  }

  inBounds({ x, y, z }) {
    return x >= 0 && x < this.size.x && y >= 0 && y < this.size.y && z >= 0 && z < this.size.z;
  }

  normalizeCoord(input = {}) {
    const x = parseInt(input.x, 10);
    const y = parseInt(input.y, 10);
    const z = parseInt(input.z, 10);
    if (![x, y, z].every((n) => Number.isInteger(n))) return null;
    return { x, y, z };
  }

  place(input = {}) {
    const coord = this.normalizeCoord(input);
    if (!coord) return { success: false, error: '坐标必须是整数 x / y / z' };
    if (!this.inBounds(coord)) return { success: false, error: `坐标越界，范围 x 0~${this.size.x - 1}、y 0~${this.size.y - 1}、z 0~${this.size.z - 1}` };
    const id = String(input.block || '').trim();
    if (!PALETTE_IDS.has(id)) {
      return { success: false, error: `没有这种方块: ${id || '（空）'}；可用：${PALETTE.map((item) => item.id).join('、')}` };
    }
    const key = keyOf(coord.x, coord.y, coord.z);
    const previous = this.blocks[key] || null;
    this.blocks[key] = id;
    this.persist();
    return { success: true, placed: { ...coord, block: id }, replaced: previous, score: scoreWorld(this.blocks, this.size) };
  }

  remove(input = {}) {
    const coord = this.normalizeCoord(input);
    if (!coord) return { success: false, error: '坐标必须是整数 x / y / z' };
    const key = keyOf(coord.x, coord.y, coord.z);
    if (!this.blocks[key]) return { success: false, error: '这个位置没有方块' };
    const removed = this.blocks[key];
    delete this.blocks[key];
    this.persist();
    return { success: true, removed: { ...coord, block: removed }, score: scoreWorld(this.blocks, this.size) };
  }

  clear() {
    const count = Object.keys(this.blocks).length;
    this.blocks = {};
    this.persist();
    return { success: true, cleared: count };
  }

  // 把某个角色挪到新位置（连续坐标），越界自动夹住
  moveCharacter(input = {}) {
    const id = String(input.id || '').trim();
    const who = this.characters.find((item) => item.id === id);
    if (!who) {
      return { success: false, error: `没有这个角色: ${id || '（空）'}；可用：${this.characters.map((item) => item.id).join('、')}` };
    }
    const x = Number(input.x);
    const z = Number(input.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { success: false, error: '坐标必须是数字 x / z' };
    who.x = Math.min(this.size.x - 0.2, Math.max(0.2, x));
    who.z = Math.min(this.size.z - 0.2, Math.max(0.2, z));
    this.persist();
    return { success: true, character: { ...who }, characters: this.characters.map((item) => ({ ...item })) };
  }

  // 节律引擎专用：只改内存位置，不落盘。每秒都在挪人，扛不住每次都写整个世界；
  // 由调用方按间隔调用 persist() 收口。
  setPose(id, x, z) {
    const who = this.characters.find((item) => item.id === id);
    if (!who || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    who.x = Math.min(this.size.x - 0.2, Math.max(0.2, x));
    who.z = Math.min(this.size.z - 0.2, Math.max(0.2, z));
    return who;
  }

  // 当日一次性事件（点单）是否已经发生过：key 形如 2026-11-25#lunch
  hasTavernEvent(key) {
    return this.tavern.events.includes(key);
  }

  markTavernEvent(key) {
    const day = String(key).split('#')[0];
    if (this.tavern.day !== day) this.tavern = { day, events: [] };
    if (!this.tavern.events.includes(key)) this.tavern.events.push(key);
    this.tavern.events = this.tavern.events.slice(-40);
    this.persist();
    return true;
  }

  // 让角色说一句话，前端画成头顶气泡
  say(input = {}) {
    const id = String(input.id || '').trim();
    const who = this.characters.find((item) => item.id === id);
    if (!who) return { success: false, error: `没有这个角色: ${id || '（空）'}` };
    who.say = String(input.text || '').slice(0, 120);
    who.sayAt = Date.now();
    return { success: true, character: { ...who }, ttl: SAY_TTL };
  }

  // 付款：从一人的钱包划到另一人，余额不足直接拒绝
  pay(input = {}) {
    const fromId = String(input.from || '').trim();
    const toId = String(input.to || '').trim();
    const amount = Math.floor(Number(input.amount));
    const from = this.characters.find((item) => item.id === fromId);
    const to = this.characters.find((item) => item.id === toId);
    if (!from) return { success: false, error: `没有这个角色: ${fromId || '（空）'}` };
    if (!to) return { success: false, error: `没有这个角色: ${toId || '（空）'}` };
    if (fromId === toId) return { success: false, error: '不能自己付给自己' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: '金额必须是正整数' };
    if (from.wallet < amount) {
      return { success: false, error: `${from.name}只有 ${from.wallet} 金币，付不起 ${amount}` };
    }
    from.wallet -= amount;
    to.wallet += amount;
    this.persist();
    this.syncCoins();
    return {
      success: true,
      amount,
      from: { id: from.id, name: from.name, wallet: from.wallet },
      to: { id: to.id, name: to.name, wallet: to.wallet }
    };
  }

  // 钱箱区 = 老板余额的可视化：每枚金币代表 COIN_UNIT 个，按十位摆，多出来的收走
  syncCoins() {
    const boss = this.characters.find((item) => item.id === 'you');
    const wallet = boss ? boss.wallet : 0;
    const keep = new Set(COIN_CELLS.map(([x, y, z]) => keyOf(x, y, z)));
    // 钱箱区以外的手摆金币一律清掉，保证金币只反映余额
    for (const key of Object.keys(this.blocks)) {
      if (this.blocks[key] === 'coin' && !keep.has(key)) {
        const pos = parseKey(key);
        if (pos) this.remove(pos);
      }
    }
    const count = Math.min(COIN_CELLS.length, Math.floor(wallet / COIN_UNIT));
    COIN_CELLS.forEach(([x, y, z], index) => {
      const here = this.blocks[keyOf(x, y, z)];
      if (index < count) {
        if (here !== 'coin') this.place({ x, y, z, block: 'coin' });
      } else if (here === 'coin') {
        this.remove({ x, y, z });
      }
    });
    return count;
  }

  // 给前端与工具同一份快照：调色板 + 世界 + 人物 + 评分
  snapshot() {
    return {
      success: true,
      version: VERSION,
      size: this.size,
      palette: PALETTE.map((item) => ({ ...item })),
      blocks: { ...this.blocks },
      characters: this.characters.map((item) => ({ ...item, y: this.feetOf(item.x, item.z) })),
      score: scoreWorld(this.blocks, this.size)
    };
  }
}

module.exports = {
  CreativeWorld,
  PALETTE,
  SIZE,
  ROUTES,
  VERSION,
  scoreWorld,
  keyOf,
  parseKey
};
