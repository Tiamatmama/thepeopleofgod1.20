// 🧭 场景投影：回答「你们此刻在哪、是不是在同一个空间」。
//
// 这不是一份新的权威状态——不落盘、不缓存、不提供写入口。
// 它和 CIDE 的内感受快照同构：每次开口前，从已有器官（这段对话、长期记忆）现算一份投影，
// 只由 output.generateOutputAsync 单点消费。拿不到证据时返回 unknown，宁可不知道，也不猜。
//
// 为什么要它：QQ 私聊的静态提示只有「你们在私聊」，模型手里没有位置，
// 于是会按恋爱剧本自行补出「你站在门外、去开门」这种对话里从未发生的物理动作。

const HISTORY_WINDOW = 8;      // 只看最近 8 条，更早的位置早该被新对话覆盖
const MEMORY_LIMIT = 6;        // 场景定向召回条数
const HALF_LIFE_DAYS = 7;      // 记忆里提到「在家」的权重，每 7 天减半
const MIN_MEMORY_WEIGHT = 0.15;

// 只做定向召回，不参与常规语义检索；词都偏「位置/相处状态」
const SCENE_QUERY = '在家 家里 客厅 卧室 房间 公司 学校 地铁 路上 出差 异地 门口 门外 到家';

const PLACES = [
  '家里', '家', '客厅', '卧室', '房间', '厨房', '书房', '阳台',
  '公司', '办公室', '学校', '教室', '图书馆', '医院', '酒店', '地铁', '车上',
  '门外', '门口', '楼下', '路上'
].sort((a, b) => b.length - a.length);

const PLACE_ALT = PLACES.join('|');
const EXPLICIT_PLACE = new RegExp(`(?:我|我们)?(?:现在|已经|刚|正)?(?:在|回到|到了|到)(${PLACE_ALT})`, 'g');
const ARRIVED_HOME = /(?:我|我们)?(?:回到家|到家|回家)了?/g;
const APART_CUES = /(?:在门外|在门口|在楼下|到门外|到门口|到楼下|到了门外|到了门口|到了楼下|还没到|马上到|快到了|在路上|出门了|我出去|不在家)/g;
const TOGETHER_CUES = /(?:在一起|在你旁边|在你身边|躺你旁边|抱着你|在你怀里|靠着你|枕着你)/g;
const ACTIVITY = /(?:我|我们)?(?:在|正在)(看|吃|做|写|玩|收拾|洗|等|睡|听|聊)[^，。！？\s]{0,8}/g;

function normalizePlace(raw) {
  const text = String(raw || '').trim();
  if (text === '家里') return '家';
  return text;
}

// 从一段文本里抽出位置 / 相处状态 / 正在做什么，只返回白名单地点，避免把原文整段塞进提示词
function extract(text) {
  const source = String(text || '');
  const found = { places: [], apart: false, together: false, activity: '' };

  let match;
  EXPLICIT_PLACE.lastIndex = 0;
  while ((match = EXPLICIT_PLACE.exec(source)) !== null) {
    found.places.push(normalizePlace(match[1]));
  }
  ARRIVED_HOME.lastIndex = 0;
  if (ARRIVED_HOME.test(source)) found.places.push('家');

  APART_CUES.lastIndex = 0;
  if (APART_CUES.test(source)) found.apart = true;
  TOGETHER_CUES.lastIndex = 0;
  if (TOGETHER_CUES.test(source)) found.together = true;

  const activity = ACTIVITY.exec(source);
  ACTIVITY.lastIndex = 0;
  if (activity) found.activity = String(activity[0]).slice(0, 16);

  return found;
}

function memoryText(memory) {
  if (typeof memory === 'string') return memory;
  if (!memory || typeof memory !== 'object') return '';
  return String(memory.text || memory.data || memory.value || '');
}

function memoryWeight(memory, now) {
  const at = Number(memory && (memory.timestamp || memory.createdAt)) || 0;
  if (!at) return 0.4;
  const days = Math.max(0, (now - at) / 86400000);
  const weight = Math.pow(0.5, days / HALF_LIFE_DAYS) * 0.6;
  return weight >= MIN_MEMORY_WEIGHT ? weight : 0;
}

/**
 * 纯派生：历史优先，记忆补位；同分取更近的说法。
 * @returns {{place: string|null, together: boolean|null, activity: string|null,
 *            confidence: number, evidence: Array<{source: string, text: string}>}}
 */
function deriveScene({ history = [], memories = [], now = Date.now(), channelTogether = null } = {}) {
  const evidence = [];
  // place -> { score, owner }：owner 决定提示词里写「你」还是「他」——
  // 用户说「我到门外了」是他在门外，不能写成她在门外
  const placeScores = new Map();
  const addPlace = (place, score, owner) => {
    const previous = placeScores.get(place);
    if (!previous || score > previous.score) placeScores.set(place, { score, owner });
  };
  let together = null;
  let togetherScore = 0;
  let activity = null;
  let activityScore = 0;

  const lines = (Array.isArray(history) ? history : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_WINDOW);

  lines.forEach((message, index) => {
    const weight = (message.role === 'assistant' ? 0.7 : 1) * (1 + index / HISTORY_WINDOW);
    const owner = message.role === 'assistant' ? 'assistant' : 'user';
    const found = extract(message.content);
    found.places.forEach((place) => {
      addPlace(place, weight * (place === '门外' || place === '门口' || place === '楼下' ? 1.2 : 1), owner);
    });
    if (found.places.length || found.apart || found.together) {
      evidence.push({ source: 'history', text: String(message.content).slice(0, 60) });
    }
    if (found.together && weight >= togetherScore) {
      together = true;
      togetherScore = weight;
    }
    if (found.apart && weight >= togetherScore) {
      together = false;
      togetherScore = weight;
    }
    if (found.activity && weight >= activityScore) {
      activity = found.activity;
      activityScore = weight;
    }
  });

  function weightOf(memory) {
    return memoryWeight(memory, now);
  }

  (Array.isArray(memories) ? memories : []).slice(0, MEMORY_LIMIT).forEach((memory) => {
    const weight = weightOf(memory);
    if (weight <= 0) return;
    const text = memoryText(memory);
    const found = extract(text);
    // 记忆正文是用户说过的话，位置归属按「他」记
    found.places.forEach((place) => addPlace(place, weight, 'user'));
    if (found.places.length || found.apart || found.together) {
      evidence.push({ source: 'memory', text: text.slice(0, 60) });
    }
    if (found.together && weight >= togetherScore) {
      together = true;
      togetherScore = weight;
    }
    if (found.apart && weight >= togetherScore) {
      together = false;
      togetherScore = weight;
    }
  });

  // 渠道自己声明过「面对面」时，把它当作一条弱证据；不覆盖对话里更明确的反证
  if (together === null && channelTogether !== null) {
    together = channelTogether === true;
    togetherScore = Math.max(togetherScore, 1.5);
    evidence.push({ source: 'channel', text: '渠道声明' });
  }

  let place = null;
  let placeOwner = null;
  let placeScore = 0;
  const perOwner = { user: null, assistant: null };
  for (const [candidate, entry] of placeScores.entries()) {
    if (entry.score > placeScore) {
      place = candidate;
      placeOwner = entry.owner;
      placeScore = entry.score;
    }
    const known = perOwner[entry.owner];
    if (!known || entry.score > known.score) perOwner[entry.owner] = { place: candidate, score: entry.score };
  }

  const confidence = Math.min(1, Math.max(placeScore, togetherScore) / 3);
  return {
    place,
    placeOwner,
    // 双方各自最近说过的位置：不在一起时两句都要说，不能只报一个
    userPlace: perOwner.user ? perOwner.user.place : null,
    selfPlace: perOwner.assistant ? perOwner.assistant.place : null,
    together,
    activity,
    confidence: Number(confidence.toFixed(2)),
    evidence
  };
}

// 注入文本：有证据才说地点；没有就给硬规则。永远附一句「没写到的不要补」。
function formatSceneHint(scene) {
  if (!scene || (scene.place === null && scene.together === null && !scene.activity)) {
    return '\n【此刻的处境】你并不确定你们此刻各自在哪、是否在同一个空间。不要假设地点，也不要让对方「开门 / 进来 / 过来」或替对方安排身体动作；需要弄清时，先问一句。';
  }
  const parts = [];
  // 位置归属：用户说的写成「他」，她说的写成「你」，来源不明就不带主语
  const who = scene.placeOwner === 'user' ? '他' : (scene.placeOwner === 'assistant' ? '你' : '');
  if (scene.together === true) {
    parts.push(`你们此刻在同一个空间${scene.place ? `（${scene.place}）` : ''}`);
  } else if (scene.together === false) {
    parts.push(who
      ? `你们此刻不在一起（${who}在${scene.place}）`
      : `你们此刻不在一起${scene.place ? `（${scene.place}）` : ''}`);
  } else if (scene.place) {
    // 双方各自的位置都说过时，两句都给，不拿一个人的位置代表两个人
    if (scene.userPlace && scene.selfPlace && scene.userPlace !== scene.selfPlace) {
      parts.push(`他此刻在${scene.userPlace}，你此刻在${scene.selfPlace}`);
    } else {
      parts.push(who ? `${who}此刻在${scene.place}` : `地点线索：${scene.place}`);
    }
  }
  if (scene.activity) parts.push(`你正在${scene.activity.replace(/^(?:我|我们)?(?:正在|在)/, '')}`);
  return `\n【此刻的处境】${parts.join('；')}。只把这里写到的当作已确认事实，没写到的不要自行补全，也不要替对方安排身体动作。`;
}

module.exports = {
  SCENE_QUERY,
  deriveScene,
  formatSceneHint,
  extract
};
