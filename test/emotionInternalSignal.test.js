'use strict';

// B3 验收：内部信号回流环（applyInternalSignal）。
// 用 Object.create 裸实例 + stub save()，不 new 真实构造，避免读写 data/emotion_state.json。

const test = require('node:test');
const assert = require('node:assert/strict');

const EmotionModule = require('../src/core/emotion');
const SystemNarrator = require('../src/core/narrator');

const KEY = { sessionId: 's1', userId: 'u1' };

function makeModule() {
  const mod = Object.create(EmotionModule.prototype);
  mod.states = {};
  mod.internalLastAt = {};
  mod.save = () => {}; // 不落盘
  return mod;
}

function withEnabled(fn) {
  process.env.INTERNAL_SIGNAL_ENABLED = 'true';
  try {
    return fn();
  } finally {
    delete process.env.INTERNAL_SIGNAL_ENABLED;
  }
}

test('isInternalSignalEnabled：默认关，设 true 才开', () => {
  const mod = makeModule();
  delete process.env.INTERNAL_SIGNAL_ENABLED;
  assert.equal(mod.isInternalSignalEnabled(), false);
  process.env.INTERNAL_SIGNAL_ENABLED = 'true';
  assert.equal(mod.isInternalSignalEnabled(), true);
  delete process.env.INTERNAL_SIGNAL_ENABLED;
});

test('applyInternalSignal：默认关时任何信号都不写状态', () => {
  delete process.env.INTERNAL_SIGNAL_ENABLED;
  const mod = makeModule();
  const res = mod.applyInternalSignal({ type: 'happy', intensity: 0.3 }, { ...KEY, source: 'narrator.answered' });
  assert.deepEqual(res, { applied: false, reason: 'disabled' });
  assert.equal(mod.states['s1|u1'], undefined);
});

test('applyInternalSignal：未知信号类型被拒', () => {
  withEnabled(() => {
    const mod = makeModule();
    const res = mod.applyInternalSignal({ type: 'ecstatic', intensity: 0.3 }, { ...KEY, source: 'x' });
    assert.deepEqual(res, { applied: false, reason: 'unknown-signal' });
    assert.equal(mod.states['s1|u1'], undefined);
  });
});

test('applyInternalSignal：开启后把 happy 折成快层涟漪，只追加 internal 历史，不动慢层', () => {
  withEnabled(() => {
    const mod = makeModule();
    const state = mod.getEmotionState(KEY.sessionId, KEY.userId);
    const slowBefore = { ...state.slow };
    const happyBefore = state.fast.happy;

    const res = mod.applyInternalSignal({ type: 'happy', intensity: 0.3 }, { ...KEY, source: 'narrator.answered' });

    assert.equal(res.applied, true);
    assert.equal(res.type, 'happy');
    assert.equal(res.intensity, 0.3);
    assert.ok(state.fast.happy > happyBefore, '快层 happy 应上升');
    Object.keys(slowBefore).forEach((k) => {
      assert.ok(Math.abs(state.slow[k] - slowBefore[k]) < 1e-9, `慢层 ${k} 不应被内部信号改写`);
    });
    const last = state.history[state.history.length - 1];
    assert.equal(last.origin, 'internal');
    assert.equal(last.source, 'narrator.answered');
  });
});

test('applyInternalSignal：强度封顶在 INTERNAL_INTENSITY_CAP（0.35）', () => {
  withEnabled(() => {
    const mod = makeModule();
    const res = mod.applyInternalSignal({ type: 'sad', intensity: 5 }, { ...KEY, source: 'narrator.ignored' });
    assert.equal(res.applied, true);
    assert.equal(res.intensity, 0.35);
  });
});

test('applyInternalSignal：同一来源在冷却期内被节流，不同来源互不影响', () => {
  withEnabled(() => {
    const mod = makeModule();
    const first = mod.applyInternalSignal({ type: 'sad', intensity: 0.2 }, { ...KEY, source: 'narrator.ignored' });
    assert.equal(first.applied, true);

    const sameSource = mod.applyInternalSignal({ type: 'sad', intensity: 0.2 }, { ...KEY, source: 'narrator.ignored' });
    assert.deepEqual(sameSource, { applied: false, reason: 'cooldown' });

    const otherSource = mod.applyInternalSignal({ type: 'happy', intensity: 0.2 }, { ...KEY, source: 'narrator.answered' });
    assert.equal(otherSource.applied, true);
  });
});

test('applyInternalSignal：零/非法强度不写状态', () => {
  withEnabled(() => {
    const mod = makeModule();
    const res = mod.applyInternalSignal({ type: 'happy', intensity: 0 }, { ...KEY, source: 'x' });
    assert.deepEqual(res, { applied: false, reason: 'zero-intensity' });
    assert.equal(mod.states['s1|u1'], undefined);
  });
});

test('pruneInternalLastAt：账本超上限时回收过期记录，保证有界', () => {
  withEnabled(() => {
    const realNow = Date.now;
    const t0 = 1_700_000_000_000;
    let clock = t0;
    Date.now = () => clock;
    try {
      const mod = makeModule();
      // 灌入 1200 条同一时刻的过期冷却记录（超过 INTERNAL_LAST_AT_CAP=1000）
      for (let i = 0; i < 1200; i += 1) {
        mod.internalLastAt[`s${i}|u1#narrator.ignored`] = t0;
      }
      // 冷却是 60s；把时钟推到窗口之外，再施加一条新信号触发清扫
      clock = t0 + 60 * 1000 + 1;
      const res = mod.applyInternalSignal({ type: 'happy', intensity: 0.2 }, { ...KEY, source: 'narrator.answered' });
      assert.equal(res.applied, true);

      const keys = Object.keys(mod.internalLastAt);
      assert.equal(keys.length, 1, '过期的应被回收，只剩刚写入的一条');
      assert.equal(keys[0], 's1|u1#narrator.answered');
    } finally {
      Date.now = realNow;
    }
  });
});

// —— narrator 侧挂钩：把「她自己的遭遇」翻译成内部信号 ——

function makeNarrator({ enabled, drive }) {
  const calls = [];
  const narrator = Object.create(SystemNarrator.prototype);
  narrator.sessions = new Map();
  // Object.create 绕过构造函数，这里补上 noteUserMessage 会碰到的计时器表
  narrator.excitedTimers = new Map();
  narrator.sessionManager = null;
  narrator.cide = {
    getDrive: () => drive,
    noteUserMessage: () => { calls.push({ op: 'noteUserMessage' }); }
  };
  narrator.emotionModule = {
    isInternalSignalEnabled: () => enabled,
    applyInternalSignal: (signal, meta) => { calls.push({ op: 'signal', signal, meta }); }
  };
  return { narrator, calls };
}

test('emitInternalEmotion：未注入情绪模块或未开启时静默跳过', () => {
  const off = makeNarrator({ enabled: false, drive: { pendingFeedback: false, ignoredStreak: 0 } });
  off.narrator.emitInternalEmotion('s1', { userId: 'u1' }, { type: 'happy', intensity: 0.2 }, 'narrator.answered');
  assert.equal(off.calls.length, 0);

  const bare = Object.create(SystemNarrator.prototype);
  bare.emotionModule = null;
  bare.sessionManager = null;
  // 不应抛错
  bare.emitInternalEmotion('s1', { userId: 'u1' }, { type: 'happy', intensity: 0.2 }, 'narrator.answered');
});

test('noteUserMessage：此前在等回应 / 攒了冷落时，回流一条 happy（narrator.answered）', () => {
  const { narrator, calls } = makeNarrator({ enabled: true, drive: { pendingFeedback: true, ignoredStreak: 0 } });
  narrator.noteUserMessage('s1', 'u1', null);

  const signal = calls.find((c) => c.op === 'signal');
  assert.ok(signal, '应发出内部信号');
  assert.equal(signal.signal.type, 'happy');
  assert.equal(signal.meta.source, 'narrator.answered');
  assert.equal(signal.meta.sessionId, 's1');
  assert.equal(signal.meta.userId, 'u1');
});

test('noteUserMessage：此前没有等回应也没有冷落时，不回流', () => {
  const { narrator, calls } = makeNarrator({ enabled: true, drive: { pendingFeedback: false, ignoredStreak: 0 } });
  narrator.noteUserMessage('s1', 'u1', null);
  assert.equal(calls.filter((c) => c.op === 'signal').length, 0);
});

