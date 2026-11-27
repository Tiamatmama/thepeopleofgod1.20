const test = require('node:test');
const assert = require('node:assert');

const { LiveVision, zoneOf, depthOf, iou } = require('../src/core/liveVision');

// 固定时钟，避免测试依赖真实时间
function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    set: (ms) => { now = ms; }
  };
}

function box(x, y, w, h) {
  return { x, y, w, h };
}

test('IoU：完全重合为 1，不相交为 0', () => {
  assert.ok(Math.abs(iou(box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2)) - 1) < 1e-9);
  assert.strictEqual(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.1, 0.1)), 0);
});

test('位置词与远近分档', () => {
  assert.strictEqual(zoneOf(0.1), '偏左');
  assert.strictEqual(zoneOf(0.5), '中间');
  assert.strictEqual(zoneOf(0.9), '偏右');
  assert.strictEqual(depthOf(0.5), '近处');
  assert.strictEqual(depthOf(0.2), '中等距离');
  assert.strictEqual(depthOf(0.1), '远处');
});

test('新目标要连续出现够久才确认，并报「进入画面」', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 500 });

  const first = vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }], { fps: 10 });
  assert.strictEqual(first.tracks.length, 0);
  assert.ok(!first.events.some((event) => event.type === 'enter'));

  clock.advance(600);
  const second = vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }], { fps: 10 });
  assert.strictEqual(second.tracks.length, 1);
  assert.ok(second.events.some((event) => event.type === 'enter'));
  assert.ok(second.summary.includes('1 个人'));
});

test('跨帧匹配保持同一个 id，不会每帧都换新号', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 100 });

  vision.ingest([{ label: 'cup', score: 0.8, box: box(0.1, 0.4, 0.1, 0.15) }]);
  clock.advance(200);
  const second = vision.ingest([{ label: 'cup', score: 0.8, box: box(0.12, 0.4, 0.1, 0.15) }]);
  assert.strictEqual(second.tracks.length, 1);
  assert.strictEqual(second.tracks[0].id, 'cup#1');
});

test('目标消失超过 leaveMs 才报离开，短暂丢帧不算', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 100, leaveMs: 1000 });

  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  clock.advance(200);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);

  // 短暂丢失：仍然保留
  clock.advance(300);
  const brief = vision.ingest([]);
  assert.strictEqual(brief.tracks.length, 1);

  // 超过 leaveMs：报离开并移除
  clock.advance(1200);
  const gone = vision.ingest([]);
  assert.strictEqual(gone.tracks.length, 0);
  assert.ok(gone.events.some((event) => event.type === 'leave'));
});

test('人的框明显变大判为靠近，明显变小判为走远', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0, leaveMs: 5000 });

  vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.3, 0.15, 0.15) }]);
  clock.advance(200);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.2, 0.2, 0.25) }]);
  clock.advance(200);
  const closer = vision.ingest([{ label: 'person', score: 0.9, box: box(0.35, 0.1, 0.3, 0.45) }]);
  assert.strictEqual(closer.tracks[0].action, '靠近');
  assert.ok(closer.events.some((event) => event.type === 'action' && event.text.includes('走近')));
  assert.ok(closer.summary.includes('靠近'));
});

test('提示词只在有新鲜画面时注入；没变化时第二轮返回空串', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 100, staleMs: 8000, promptRefreshMs: 20000 });

  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  clock.advance(200);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);

  const first = vision.buildPromptSection(clock.now());
  assert.ok(first.includes('【实时画面】'));
  assert.ok(first.includes('1 个人'));

  // 画面没变化、也没离开刷新窗口：不重复注入
  clock.advance(1000);
  assert.strictEqual(vision.buildPromptSection(clock.now()), '');

  // 超过刷新窗口但仍在持续上报：补一次当前画面
  clock.advance(21000);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  assert.ok(vision.buildPromptSection(clock.now()).includes('1 个人'));
});

test('画面停止上报超过 staleMs 就不再注入', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0, staleMs: 8000 });

  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  clock.advance(9000);
  assert.strictEqual(vision.buildPromptSection(clock.now()), '');
});

test('单帧目标数超限时按置信度截断', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0, maxTracks: 2 });
  const tracks = [
    { label: 'cup', score: 0.5, box: box(0.1, 0.1, 0.1, 0.1) },
    { label: 'cup', score: 0.9, box: box(0.3, 0.1, 0.1, 0.1) },
    { label: 'cup', score: 0.7, box: box(0.5, 0.1, 0.1, 0.1) }
  ];
  vision.ingest(tracks);
  assert.strictEqual(vision.activeTracks.length, 2);
  assert.deepStrictEqual(vision.activeTracks.map((track) => track.score).sort(), [0.7, 0.9]);
});

test('动作识别：横移快判为走动，稳定后回到站着', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0, minVelocityDtMs: 100 });
  const at = (x) => vision.ingest([{ label: 'person', score: 0.9, box: box(x, 0.3, 0.2, 0.5) }]);

  at(0.2);
  clock.advance(200);
  const walking = at(0.26); // 0.06 / 0.2s = 0.3/s，超过走动阈值
  assert.strictEqual(walking.tracks[0].action, '走动');

  clock.advance(200);
  const still = at(0.26);
  assert.strictEqual(still.tracks[0].action, '站着');
});

test('动作识别：框高明显矮于个人基线判为坐着，回弹判为站起来', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0, minVelocityDtMs: 100 });

  vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.1, 0.2, 0.6) }]);
  clock.advance(300);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.1, 0.2, 0.6) }]);
  clock.advance(300);
  // 坐下：框高 0.6 → 0.4，且位置稳定
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.25, 0.2, 0.4) }]);
  clock.advance(300);
  const seated = vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.25, 0.2, 0.4) }]);
  assert.strictEqual(seated.tracks[0].action, '坐着');
  assert.ok(seated.events.some((event) => event.type === 'action' && event.text === '人坐下了'));

  clock.advance(300);
  const stood = vision.ingest([{ label: 'person', score: 0.9, box: box(0.4, 0.1, 0.2, 0.6) }]);
  assert.strictEqual(stood.tracks[0].action, '站着');
  assert.ok(stood.events.some((event) => event.type === 'action' && event.text === '人站起来了'));
});

test('姿态手势：挥手只报一次并触发主动开口，非法值被忽略', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0, gestureCooldownMs: 60000 });
  const frame = (gesture) => ([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5), gesture }]);

  vision.ingest(frame(''));
  clock.advance(200);
  const waved = vision.ingest(frame('挥手'));
  assert.strictEqual(waved.tracks[0].gesture, '挥手');
  assert.ok(waved.events.some((event) => event.type === 'gesture'));
  assert.ok(waved.summary.includes('正在挥手'));
  assert.strictEqual(vision.takeInteractionTrigger(clock.now()).kind, 'gesture');

  // 持续挥手：不重复记事件、不重复触发
  clock.advance(200);
  vision.ingest(frame('挥手'));
  assert.strictEqual(vision.takeInteractionTrigger(clock.now()), null);

  // 白名单之外的值一律当没有
  clock.advance(200);
  const invalid = vision.ingest(frame('跳舞'));
  assert.strictEqual(invalid.tracks[0].gesture, '');
});

test('表情、视线与细手势：白名单生效并进入场景摘要', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 0 });
  const frame = (extra) => ([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5), ...extra }]);

  vision.ingest(frame({}));
  clock.advance(200);
  const seen = vision.ingest(frame({ gesture: 'OK', expression: '微笑', gaze: '看你' }));
  assert.strictEqual(seen.tracks[0].gesture, 'OK');
  assert.strictEqual(seen.tracks[0].expression, '微笑');
  assert.strictEqual(seen.tracks[0].gaze, '看你');
  assert.ok(seen.summary.includes('正在OK'));
  assert.ok(seen.summary.includes('微笑'));
  assert.ok(seen.summary.includes('看着你'));

  clock.advance(200);
  const detailed = vision.ingest(frame({ posture: '抱胸', head: '侧着头', body: '侧身', faceDetail: '挑眉' }));
  assert.strictEqual(detailed.tracks[0].posture, '抱胸');
  assert.ok(detailed.summary.includes('抱胸'));
  assert.ok(detailed.summary.includes('侧身'));
  assert.ok(detailed.summary.includes('侧着头'));
  assert.ok(detailed.summary.includes('挑眉'));

  clock.advance(200);
  const invalid = vision.ingest(frame({ gesture: '比心', expression: '愤怒', gaze: '看天' }));
  assert.strictEqual(invalid.tracks[0].gesture, '');
  assert.strictEqual(invalid.tracks[0].expression, '');
  assert.strictEqual(invalid.tracks[0].gaze, '');
});

test('人的进出会产出一次主动开口的由头，且受冷却限制', () => {
  const clock = makeClock();
  const vision = new LiveVision({ now: clock.now, enterMs: 100, leaveMs: 500, interactionCooldownMs: 10000 });

  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  clock.advance(200);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);

  const trigger = vision.takeInteractionTrigger(clock.now());
  assert.ok(trigger);
  assert.strictEqual(trigger.kind, 'enter');
  assert.ok(trigger.text.includes('进入画面'));

  // 消费后不会重复
  assert.strictEqual(vision.takeInteractionTrigger(clock.now()), null);

  // 冷却期内再进出，不再触发
  clock.advance(200);
  vision.ingest([]);
  clock.advance(700);
  vision.ingest([]);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  clock.advance(200);
  vision.ingest([{ label: 'person', score: 0.9, box: box(0.3, 0.2, 0.3, 0.5) }]);
  assert.strictEqual(vision.takeInteractionTrigger(clock.now()), null);
});
