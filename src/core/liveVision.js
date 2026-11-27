'use strict';

// 👁️ 实时视觉中间层：浏览器端检测出的「现实物体坐标」在这里变成可被对话消费的场景状态。
//
// 为什么不做快照：
//   快照是「让她主动看一眼」，成本高、频率低，看不出来人是不是走开了；
//   她需要的是像人一样的余光——谁在画面里、大概多远、正在靠近还是离开。
//
// 边界：
//   - 检测跑在浏览器（public/live-vision.html），原图不出本机，这里只收结构化 track；
//   - 本模块不落盘、不写记忆，只维护一份内存场景（进程重启即清空），
//     是否值得记住由上层（记忆链路）自己判断，避免实时帧把记忆写爆；
//   - 坐标统一归一化到 0~1（相对画面宽高），深度仅用框高反推相对远近，不做厘米级标定。

// 常见 COCO 标签 → 中文。只翻常用的；没收录的原样显示英文，不猜。
const LABEL_ZH = Object.freeze({
  person: '人',
  cup: '杯子',
  bottle: '瓶子',
  'wine glass': '酒杯',
  cellphone: '手机',
  'cell phone': '手机',
  laptop: '笔记本电脑',
  keyboard: '键盘',
  mouse: '鼠标',
  book: '书',
  'potted plant': '盆栽',
  cat: '猫',
  dog: '狗',
  chair: '椅子',
  'dining table': '桌子',
  tv: '显示器',
  remote: '遥控器',
  scissors: '剪刀',
  clock: '闹钟',
  banana: '香蕉',
  apple: '苹果',
  sandwich: '三明治',
  'teddy bear': '玩偶',
  backpack: '背包',
  handbag: '手提包',
  bowl: '碗',
  fork: '叉子',
  spoon: '勺子',
  knife: '刀'
});

// 画面里的位置词：按中心点横向三分
function zoneOf(cx) {
  if (cx < 0.34) return '偏左';
  if (cx > 0.66) return '偏右';
  return '中间';
}

// 相对远近：只看框高。人站立时框高占比最稳，小物件只能作粗粒度参考
function depthOf(h) {
  if (h >= 0.34) return '近处';
  if (h >= 0.18) return '中等距离';
  return '远处';
}

// 浏览器端姿态/手势/表情只允许上报这些值，其他字符串一律当没有
const ALLOWED_GESTURES = new Set([
  '挥手', '举手', 'OK', '竖拇指', '张开手掌',
  '数字1', '数字2', '数字3', '数字4', '握拳'
]);
const ALLOWED_EXPRESSIONS = new Set(['微笑', '大笑', '皱眉', '惊讶', '张嘴']);
const ALLOWED_GAZE = new Set(['看你', '看别处', '看左边', '看右边', '看上方', '看下方']);
const ALLOWED_POSTURES = new Set(['叉腰', '抱胸', '托腮']);
const ALLOWED_HEAD = new Set(['正对你', '侧着头']);
const ALLOWED_BODY = new Set(['面向你', '侧身', '背对']);
const ALLOWED_FACE_DETAILS = new Set(['挑眉', '嘴角一边上扬', '眨眼频繁']);

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(1, Math.max(0, num));
}

// 输入框统一整理成 { x, y, w, h }（x/y 为左上角），非法值直接丢
function sanitizeBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  const w = clamp01(raw.w);
  const h = clamp01(raw.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w < 0.01 || h < 0.01) return null;
  // 越界裁到画面内
  return {
    x,
    y,
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y)
  };
}

function centerOf(box) {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

function iou(a, b) {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function centerDistance(a, b) {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
}

// 中文名：优先查表，查不到保留原标签（截断防止撑爆提示词）
function labelZh(label) {
  const key = String(label || '').toLowerCase();
  return LABEL_ZH[key] || String(label || '').slice(0, 16) || '物体';
}

// 同一标签的多个实例在摘要里合并成「2 个杯子」，不逐个报坐标
function summarizeTracks(tracks) {
  const groups = new Map();
  tracks.forEach((track) => {
    const name = labelZh(track.label);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(track);
  });
  const parts = [];
  groups.forEach((list, name) => {
    // 取最靠前（面积最大）的那一个描述位置，代表这个类别的主实例
    const main = list.slice().sort((a, b) => (b.box.w * b.box.h) - (a.box.w * a.box.h))[0];
    const { cx } = centerOf(main.box);
    const where = `${zoneOf(cx)}、${depthOf(main.box.h)}`;
    const motion = motionWord(main);
    const countText = list.length > 1 ? `${list.length} 个${name}` : `1 ${name === '人' ? '个人' : `个${name}`}`;
    parts.push(`${countText}（${where}${motion ? `，${motion}` : ''}）`);
  });
  return parts;
}

// 动作词只看最近一小段速度，避免正常的轻微晃动被描述成走来走去
function motionWord(track) {
  if (track.label === 'person') {
    const bits = [];
    if (track.gesture) bits.push(`正在${track.gesture}`);
    else if (track.action) bits.push(track.action);
    if (track.posture) bits.push(track.posture);
    if (track.body && track.body !== '面向你') bits.push(track.body);
    if (track.head && track.head !== '正对你') bits.push(track.head);
    if (track.expression) bits.push(track.expression);
    if (track.faceDetail) bits.push(track.faceDetail);
    if (track.gaze) bits.push(track.gaze === '看你' ? '看着你' : track.gaze);
    return bits.join('，');
  }
  const vh = Number(track.velocity?.vh) || 0;
  const vx = Number(track.velocity?.vx) || 0;
  if (vh > 0.045) return '正在靠近';
  if (vh < -0.045) return '正在走远';
  if (Math.abs(vx) > 0.09) return vx > 0 ? '正在往右移动' : '正在往左移动';
  return '';
}

// 人体动作（只靠框的运动学推断，不引入姿态模型）：
//   靠近 / 走远 / 走动 / 坐着 / 站着
// 依据：框高变化率（前后移动）、中心点速度（横移）、框高相对个人基线（坐下会明显变矮）
function inferPersonAction(track, vh, speed) {
  const baseline = Math.max(0.05, track.heightBaseline || track.box.h);
  const ratio = track.box.h / baseline;
  // 先从坐姿恢复到接近基线高度 → 优先判为站起来，别被「变高」误判成走近
  if (track.action === '坐着' && ratio >= 0.9) return '站着';
  if (ratio < 0.78) return '坐着';
  if (vh > 0.06) return '靠近';
  if (vh < -0.06) return '走远';
  if (speed > 0.18) return '走动';
  return '站着';
}

const ACTION_TEXT = {
  靠近: '人走近了',
  走远: '人走远了',
  走动: '人在走动',
  坐着: '人坐下了',
  站着: '人站起来了'
};

const DEFAULTS = {
  // 超过这个时间没收到上报，就认为页面关了/暂停了，不再往提示词里注入
  staleMs: 8000,
  // 新目标连续出现这么久才算「进入画面」，过滤检测抖动
  enterMs: 500,
  // 消失超过这么久才算「离开画面」，中间短暂丢失按同一目标处理
  leaveMs: 1200,
  // 事件只留最近这么多条
  maxEvents: 40,
  // 单帧最多接受多少个目标（超出按置信度截断）
  maxTracks: 12,
  // 两次位置比较至少要隔这么久速度才可信
  minVelocityDtMs: 80,
  // 画面完全没变化时，隔这么久再补一次场景描述（否则每轮都塞一遍，白烧 token）
  promptRefreshMs: 20000,
  // 同一件事（有人进来/离开）最多这么久触发一次主动开口，避免她反复打招呼
  interactionCooldownMs: 10 * 60 * 1000,
  // 触发事件的有效期：页面开着但一直没人消费（比如没有会话）就作废
  interactionTtlMs: 60 * 1000,
  // 挥手这种明确对外的动作，冷却比「进出画面」短得多，她才能及时回应
  gestureCooldownMs: 60 * 1000
};

class LiveVision {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.config = Object.assign({}, DEFAULTS, options);
    this.enabled = options.enabled !== false;
    this.activeTracks = [];
    this.events = [];
    this.updatedAt = 0;
    this.lastIngestAt = 0;
    this.lastPromptAt = 0;
    this.lastInteractionAt = 0;
    this.lastGestureAt = 0;
    this.pendingInteraction = null;
    this.meta = { fps: 0, width: 0, height: 0 };
    // 每个标签各自发号，id 稳定且可读：person#1、cup#2
    this.sequences = new Map();
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
    if (!this.enabled) this.reset();
    return this.enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  reset() {
    this.activeTracks = [];
    this.events = [];
    this.updatedAt = 0;
    this.lastIngestAt = 0;
    this.lastPromptAt = 0;
    this.lastInteractionAt = 0;
    this.lastGestureAt = 0;
    this.pendingInteraction = null;
    this.meta = { fps: 0, width: 0, height: 0 };
    this.sequences.clear();
  }

  nextId(label) {
    const key = String(label || 'object').toLowerCase();
    const seq = (this.sequences.get(key) || 0) + 1;
    this.sequences.set(key, seq);
    return `${key}#${seq}`;
  }

  pushEvent(type, payload) {
    const at = this.now();
    this.events.push({ type, at, consumed: false, ...payload });
    if (this.events.length > this.config.maxEvents) {
      this.events.splice(0, this.events.length - this.config.maxEvents);
    }
    // 人的进出是最值得她主动开口的由头；用冷却时间压住，别每秒安一次
    if ((type === 'enter' || type === 'leave') && payload.label === 'person') {
      // lastInteractionAt=0 表示还没触发过，不能拿时间差去比冷却
      if (!this.lastInteractionAt || at - this.lastInteractionAt >= this.config.interactionCooldownMs) {
        this.lastInteractionAt = at;
        this.pendingInteraction = { kind: type, text: payload.text || '', at };
      }
    }
    // 挥手是明确冲着人来的，单独一条更短的冷却：看到就接，别等十分钟
    if (type === 'gesture' && payload.label === 'person') {
      if (!this.lastGestureAt || at - this.lastGestureAt >= this.config.gestureCooldownMs) {
        this.lastGestureAt = at;
        this.pendingInteraction = { kind: 'gesture', text: payload.text || '', at };
      }
    }
  }

  // 取一条「值得主动开口」的由头；没有就返回 null。消费即清空，保证同一件事只说一次
  takeInteractionTrigger(at = this.now()) {
    const pending = this.pendingInteraction;
    if (!pending) return null;
    this.pendingInteraction = null;
    if (at - pending.at > this.config.interactionTtlMs) return null;
    return pending;
  }

  // ========== 核心：一帧检测结果 → 场景状态 + 事件 ==========
  // tracks: [{ label, score, box:{x,y,w,h} }]；meta: { fps, width, height, active }
  ingest(rawTracks, meta = {}, at = this.now()) {
    if (!this.enabled) {
      return { tracks: [], events: [], summary: '' };
    }

    const list = Array.isArray(rawTracks) ? rawTracks
      .slice(0, this.config.maxTracks * 2)
      .map((item) => {
        const label = String(item?.label || '').toLowerCase().trim().slice(0, 24);
        const box = sanitizeBox(item?.box);
        if (!box || !label) return null;
        const score = Number(item?.score);
        const gesture = ALLOWED_GESTURES.has(item?.gesture) ? item.gesture : '';
        const expression = ALLOWED_EXPRESSIONS.has(item?.expression) ? item.expression : '';
        const gaze = ALLOWED_GAZE.has(item?.gaze) ? item.gaze : '';
        const posture = ALLOWED_POSTURES.has(item?.posture) ? item.posture : '';
        const head = ALLOWED_HEAD.has(item?.head) ? item.head : '';
        const body = ALLOWED_BODY.has(item?.body) ? item.body : '';
        const faceDetail = ALLOWED_FACE_DETAILS.has(item?.faceDetail) ? item.faceDetail : '';
        return {
          label,
          box,
          score: Number.isFinite(score) ? score : 0,
          gesture,
          expression,
          gaze,
          posture,
          head,
          body,
          faceDetail
        };
      })
      .filter(Boolean)
      // 置信度太低的目标只会在画面里闪烁，直接丢
      .filter((item) => item.score >= 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxTracks)
      : [];

    const personBefore = this.activeTracks.filter((track) => track.label === 'person').length;

    // 贪心匹配：同标签优先 IoU，其次中心距离（人走动时框会明显位移，IoU 会掉）
    const pairs = [];
    this.activeTracks.forEach((track, ti) => {
      list.forEach((item, ii) => {
        if (track.label !== item.label) return;
        const overlap = iou(track.box, item.box);
        const distance = centerDistance(track.box, item.box);
        if (overlap >= 0.2 || distance <= 0.12) {
          pairs.push({ ti, ii, score: overlap * 2 + (1 - distance) });
        }
      });
    });
    pairs.sort((a, b) => b.score - a.score);

    const matchedTrackIdx = new Set();
    const matchedItemIdx = new Set();
    const matched = new Map();
    pairs.forEach((pair) => {
      if (matchedTrackIdx.has(pair.ti) || matchedItemIdx.has(pair.ii)) return;
      matchedTrackIdx.add(pair.ti);
      matchedItemIdx.add(pair.ii);
      matched.set(pair.ti, list[pair.ii]);
    });

    // 更新已存在的目标
    this.activeTracks.forEach((track, index) => {
      const item = matched.get(index);
      if (!item) {
        track.missingSince = track.missingSince || at;
        return;
      }
      const prevCenter = centerOf(track.box);
      const prevH = track.box.h;
      const dt = Math.max(this.config.minVelocityDtMs, at - track.lastSeenAt);
      const box = item.box;
      const { cx } = centerOf(box);

      track.prevBox = track.box;
      track.box = box;
      track.score = item.score;
      track.lastSeenAt = at;
      track.missingSince = 0;

      // 姿态动作：只在「从没有变成挥手」时报一次，持续挥手不重复记
      const gesture = item.gesture || '';
      if (gesture !== track.gesture) {
        track.gesture = gesture;
        if (gesture === '挥手') {
          this.pushEvent('gesture', {
            trackId: track.id,
            label: track.label,
            text: '人在朝你挥手'
          });
        }
      }
      // 表情与视线只进摘要，不单独记事件，免得每次嘴角动一下都刷一条
      track.expression = item.expression || '';
      track.gaze = item.gaze || '';
      track.posture = item.posture || '';
      track.head = item.head || '';
      track.body = item.body || '';
      track.faceDetail = item.faceDetail || '';
      track.velocity = {
        vx: (cx - prevCenter.cx) / (dt / 1000),
        vy: (centerOf(box).cy - prevCenter.cy) / (dt / 1000),
        vh: (box.h - prevH) / (dt / 1000)
      };

      const prevZone = zoneOf(prevCenter.cx);
      const nextZone = zoneOf(cx);
      const prevDepth = depthOf(prevH);
      const nextDepth = depthOf(box.h);

      // 人的动作单独推断（靠近/走远/走动/坐着/站着），物件仍走远近/横移事件
      if (track.label === 'person') {
        const speed = Math.hypot(track.velocity.vx, track.velocity.vy);
        const action = inferPersonAction(track, track.velocity.vh, speed);
        if (action !== track.action) {
          const prevAction = track.action;
          track.action = action;
          // 只在真正值得说一声的动作上记事件：走近、走远、坐下、站起来；
          // 「站着 → 走动 → 站着」这种日常切换不往提示词里塞
          if (action === '靠近' || action === '走远' || action === '坐着' || prevAction === '坐着') {
            this.pushEvent('action', {
              trackId: track.id,
              label: track.label,
              text: ACTION_TEXT[action] || ''
            });
          }
        }
        // 个人身高基线缓慢跟随历史最大值：坐下时框会明显矮于基线
        track.heightBaseline = Math.max(box.h, (track.heightBaseline || box.h) * 0.995);
      }

      if (track.label !== 'person' && prevDepth !== nextDepth) {
        const order = ['远处', '中等距离', '近处'];
        const moved = order.indexOf(nextDepth) - order.indexOf(prevDepth);
        if (moved !== 0) {
          const name = labelZh(track.label);
          this.pushEvent('depth', {
            trackId: track.id,
            label: track.label,
            text: `${name}${moved > 0 ? '靠近了' : '走远了'}（${prevDepth} → ${nextDepth}）`
          });
        }
      } else if (track.label !== 'person' && prevZone !== nextZone && Math.abs(track.velocity.vx) > 0.12) {
        this.pushEvent('move', {
          trackId: track.id,
          label: track.label,
          text: `${labelZh(track.label)}从左往${nextZone === '偏右' ? '右' : nextZone === '偏左' ? '左' : '中间'}移动`
        });
      }

      if (!track.confirmed && at - track.firstSeenAt >= this.config.enterMs) {
        track.confirmed = true;
        this.pushEvent('enter', {
          trackId: track.id,
          label: track.label,
          text: `${labelZh(track.label)}进入画面（${zoneOf(cx)}、${depthOf(box.h)}）`
        });
      }
    });

    // 新目标
    list.forEach((item, index) => {
      if (matchedItemIdx.has(index)) return;
      const { cx } = centerOf(item.box);
      const track = {
        id: this.nextId(item.label),
        label: item.label,
        score: item.score,
        box: item.box,
        firstSeenAt: at,
        lastSeenAt: at,
        missingSince: 0,
        confirmed: false,
        // 人体动作初始按站立算，后面几帧的速度/框高变化会纠正
        action: item.label === 'person' ? '站着' : '',
        gesture: item.gesture || '',
        expression: item.expression || '',
        gaze: item.gaze || '',
        posture: item.posture || '',
        head: item.head || '',
        body: item.body || '',
        faceDetail: item.faceDetail || '',
        heightBaseline: item.box.h,
        velocity: { vx: 0, vy: 0, vh: 0 }
      };
      // 持续帧数够短时先不进摘要，等确认（enterMs）后再出现，避免闪一下就报
      if (at - track.firstSeenAt >= this.config.enterMs) {
        track.confirmed = true;
        this.pushEvent('enter', {
          trackId: track.id,
          label: item.label,
          text: `${labelZh(item.label)}进入画面（${zoneOf(cx)}、${depthOf(item.box.h)}）`
        });
      }
      this.activeTracks.push(track);
    });

    // 离开：超过 leaveMs 没再出现
    const leaving = this.activeTracks.filter((track) => track.missingSince && at - track.missingSince > this.config.leaveMs);
    if (leaving.length) {
      leaving.forEach((track) => {
        const { cx } = centerOf(track.box);
        this.pushEvent('leave', {
          trackId: track.id,
          label: track.label,
          text: `${labelZh(track.label)}离开画面（最后在${zoneOf(cx)}）`
        });
      });
      const leavingIds = new Set(leaving.map((track) => track.id));
      this.activeTracks = this.activeTracks.filter((track) => !leavingIds.has(track.id));
    }

    // 人的数量变化单独记一笔：这是「她意识到屋里多了一个人」最直接的信号
    const personAfter = this.activeTracks.filter((track) => track.label === 'person').length;
    if (personBefore !== personAfter) {
      this.pushEvent('person_count', {
        text: `画面里的人数从 ${personBefore} 变成 ${personAfter}`
      });
    }

    this.updatedAt = at;
    this.lastIngestAt = at;
    this.meta = {
      fps: Number(meta.fps) || this.meta.fps || 0,
      width: Number(meta.width) || this.meta.width || 0,
      height: Number(meta.height) || this.meta.height || 0
    };

    const visible = this.confirmedTracks();
    return {
      tracks: visible.map((track) => this.publicTrack(track)),
      events: this.events.slice(-8),
      summary: this.summaryText(visible)
    };
  }

  // 已确认且仍在画面的目标；短暂丢帧（未超过 leaveMs）仍算在场，避免检测抖动让她以为人走开了
  confirmedTracks(at = this.now()) {
    return this.activeTracks.filter((track) => track.confirmed
      && (!track.missingSince || at - track.missingSince <= this.config.leaveMs));
  }

  publicTrack(track) {
    const { cx } = centerOf(track.box);
    return {
      id: track.id,
      label: track.label,
      name: labelZh(track.label),
      score: Number(track.score.toFixed(3)),
      box: track.box,
      zone: zoneOf(cx),
      depth: depthOf(track.box.h),
      action: track.label === 'person' ? (track.action || '站着') : '',
      gesture: track.gesture || '',
      expression: track.expression || '',
      gaze: track.gaze || '',
      posture: track.posture || '',
      head: track.head || '',
      body: track.body || '',
      faceDetail: track.faceDetail || '',
      motion: motionWord(track)
    };
  }

  summaryText(tracks = this.confirmedTracks()) {
    if (!tracks.length) return '';
    return `画面里有${summarizeTracks(tracks).join('；')}。`;
  }

  // ========== 给对话用的提示词：只在有新鲜画面且确有变化时才说话 ==========
  // 返回空串表示这轮不加任何内容，调用方直接忽略即可。
  buildPromptSection(at = this.now()) {
    if (!this.enabled || !this.updatedAt) return '';
    if (at - this.updatedAt > this.config.staleMs) return '';
    const tracks = this.confirmedTracks();
    if (!tracks.length && !this.events.some((event) => !event.consumed)) return '';

    const summary = this.summaryText(tracks);
    // 只取还没被读过的变化，读完就标记，避免同一件事每轮重复说
    const pending = this.events
      .filter((event) => !event.consumed && at - event.at <= 12000)
      .slice(-4);
    // 没变化、又刚说过，就不重复注入；隔久了才补一次当前画面
    const quiet = !pending.length && at - this.lastPromptAt < this.config.promptRefreshMs;
    if (quiet) return '';
    pending.forEach((event) => { event.consumed = true; });

    const lines = [];
    if (summary) lines.push(summary);
    if (pending.length) {
      // 人多人少已经包含在人数事件里，摘要里不必重复
      lines.push(`刚才的变化：${pending.map((event) => event.text).filter(Boolean).join('；')}。`);
    }
    if (!lines.length) return '';
    this.lastPromptAt = at;
    return `\n【实时画面】${lines.join('\n')}（这是浏览器摄像头检测到的实时结果，只有大概位置和远近，看不清细节时别硬猜。）`;
  }

  snapshot(at = this.now()) {
    const tracks = this.confirmedTracks();
    return {
      enabled: this.enabled,
      active: Boolean(this.updatedAt) && at - this.updatedAt <= this.config.staleMs,
      updatedAt: this.updatedAt,
      fps: this.meta.fps || 0,
      summary: this.summaryText(tracks),
      tracks: tracks.map((track) => this.publicTrack(track)),
      events: this.events.slice(-8)
    };
  }
}

// 全进程一份：路由写入、对话读取，中间不经过任何持久化
const liveVision = new LiveVision();

module.exports = {
  LiveVision,
  liveVision,
  LABEL_ZH,
  labelZh,
  zoneOf,
  depthOf,
  iou
};
