const { UnifiedAPI } = require('./api');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CIDEEngine } = require('./cide');
const { buildIdentityLayer, buildTimeLayer } = require('./toolRegistry');
const { stripInvisibleChars } = require('./textGuard');
const { arrangePrimacyRecency } = require('./workingMemory');
const UserApiClient = require('./userApi');
// 🧠 记忆巩固（情景 → 语义）的分组/解析纯逻辑，见《类脑记忆生命周期设计方案（v2）》§4.5
const memoryConsolidation = require('./memoryConsolidation');
// 🧠 自我模型（反思落地）的规范化/解析纯逻辑，见方案 §4.6
const selfModelModule = require('./selfModel');
// 🧭 场景投影：从这段对话与长期记忆现算「此刻在哪」，纯派生、不落盘
const sceneModule = require('./scene');
// 🧠 死亡恐惧（定稿《让角色始终有对死亡的恐惧》）的纯计算模块，见 src/core/mortality.js
const mortalityModule = require('./mortality');
// 🧠 死亡恐惧·shadow 观测落盘，见《死亡恐惧-shadow判据》第三、五节
const mortalityShadowModule = require('./mortalityShadow');
// 🧭「她」的第三条判据：稳定偏移（重复核对时围绕同一处出现的稳定偏移）的纯逻辑与观测落盘
const deviationModule = require('./deviation');
const deviationShadowModule = require('./deviationShadow');
// 📝 思考原文落盘：只给分析用，不进提示词、不进记忆、不进向量库
const thinkingLog = require('./thinkingLog');
// 🗣️ 表达学习：她自己审核通过的说法（只作参考，不照抄）
const expressiveModule = require('./expressive');
// ✂️ 输出文本的解析与归一（纯字符串处理），主链与单测共用同一份口径
const outputParsing = require('./outputParsing');
// 🪫 本机兜底模型（Qwen3-0.6B / WSL）：云端通道全挂时顶一句真回复，再不行才退回模板
const localLLM = require('./localLLM');

// 👁️ 实时视觉场景：浏览器端检测、进程内存里的一份「余光」，只有变化时才注入
const { liveVision } = require('./liveVision');

// 🔍 前缀诊断：DeepSeek 只认逐字节相同的前缀，系统提示词里任何一段变了，后面全部作废。
// 命中率卡在固定值不动时，靠分段指纹判断到底是谁在动，不要再猜。
const PREFIX_LOG_PATH = path.join(__dirname, '../../data/prefix_diff.log');
const PREFIX_LOG_MAX_BYTES = 1024 * 1024;
const prefixSnapshots = new Map();

function digestOf(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 6);
}

function appendPrefixLog(line) {
  try {
    if (fs.existsSync(PREFIX_LOG_PATH) && fs.statSync(PREFIX_LOG_PATH).size > PREFIX_LOG_MAX_BYTES) {
      const kept = fs.readFileSync(PREFIX_LOG_PATH, 'utf8').split('\n').slice(-500).join('\n');
      fs.writeFileSync(PREFIX_LOG_PATH, kept);
    }
    fs.appendFileSync(PREFIX_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch (error) {
    // 落盘失败不影响主链路
  }
}

// 一次蒸馏交给模型的素材上限：一批 100 条可能超限，超了就掐头留尾地截，不整段丢
const ARCHIVE_DIGEST_SOURCE_LIMIT = 8000;

// 🖼️ 用户附图：只认 JPEG/PNG/WebP 的 base64 data URL，且限制体积。
// 图只随本轮 user 消息进入模型，不落盘、不进历史文本（历史里只留「[图片]」标记）。
const IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i;
const IMAGE_MAX_CHARS = 900 * 1024;

function normalizeImageDataUrl(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > IMAGE_MAX_CHARS) return '';
  return IMAGE_DATA_URL_RE.test(raw) ? raw : '';
}

// REM 跨话题联想（方向一③）单次最多落库几条：保守取 1，且只在本次确有成规模的巩固候选时才触发，
// 避免一次刷出一堆弱关联。落库为 kind='association'，不注入提示词、不占用源记忆。
const REM_MAX_PER_RUN = 1;

// 七档关系阶段的中文名，与 src/core/galgame.js 的 relationshipStages 保持一致。
// 原先提示词里只有 4 档、且键名错写成 CLOSE（实际枚举是 CLOSE_FRIEND），
// 结果 CLOSE_FRIEND / LOVER 走不进映射，注入给模型的是英文枚举字面量，等于没说
const RELATION_STAGE_LABELS = {
  HATE: '厌恶',
  DISLIKE: '反感',
  STRANGER: '陌生',
  ACQUAINTANCE: '熟悉',
  FRIEND: '信任',
  CLOSE_FRIEND: '依赖',
  LOVER: '专属'
};

// 好感度判定走 function calling：判定值和正文在同一条响应里一起回来，不用再让模型在正文里手写 JSON。
// 原来的 JSON 协议有个硬伤——历史里存的是剥掉 JSON 的正文，模型会模仿自己的历史把格式丢掉，
// 线上实测缺失率约 12.5%（192 次里 24 次没给 JSON）。
const AFFECTION_TOOL_NAME = 'record_affection';
const AFFECTION_TOOL = {
  type: 'function',
  function: {
    name: AFFECTION_TOOL_NAME,
    description: '记录本轮互动对角色好感度的影响。每轮回复都必须调用且只调用一次；调用内容对方看不到，不要写进正文。',
    parameters: {
      type: 'object',
      properties: {
        affection_change: {
          type: 'integer',
          description: '好感度变化，-10 到 10 之间的整数'
        },
        thinking: {
          type: 'string',
          description: '一句话说明本次判定的理由'
        }
      },
      required: ['affection_change', 'thinking']
    }
  }
};

// 好感度兜底专用的小提示词：只判刚结束的这一轮，不再整段重发角色卡与历史（那等于多付一次全价大请求）
const AFFECTION_FALLBACK_PROMPT = `你正在给一段刚结束的对话补记好感度变化。
按角色本人的性格与当前关系判断这次互动对关系的影响：被打动给正数，被冒犯或厌烦给负数，纯粹闲聊给 0；幅度 -10 到 10，轻微的给小数，真正戳到你的才给大数。`;

// 称呼同样走 function calling，但和好感度相反：它是个「按需」工具，不是每轮必调。
// 称呼一旦定下来就该长期不变，每轮逼模型重报一遍只会让它每轮换一个叫法；
// 所以只在「刚定下/改了称呼」或「发现用户怎么叫她变了」时调一次，其余轮次靠提示词里的既定事实
const ADDRESS_TOOL_NAME = 'record_address';
const ADDRESS_TOOL = {
  type: 'function',
  function: {
    name: ADDRESS_TOOL_NAME,
    description: '记录你和用户之间的互相称呼（你叫他什么、他叫你什么），以便长期保持一致。只在称呼第一次定下来、或发生了改变时调用；称呼没变化的那一轮不要调用。调用内容对方看不到，不要写进正文。',
    parameters: {
      type: 'object',
      properties: {
        role_calls_user: {
          type: 'string',
          description: '你对用户的固定称呼（你打算以后一直这么叫他）；没变化就留空'
        },
        user_calls_role: {
          type: 'string',
          description: '用户对你的固定称呼（他一直这么叫你）；没出现或没变化就留空'
        }
      }
    }
  }
};

// 称呼的认定规则。它只负责「什么时候该调 record_address」，具体叫什么是角色自己按性格定的
const ADDRESS_INSTRUCTION = `

【称呼】
- 你和用户之间怎么互相称呼，是要长期保持一致的东西，不是每轮现编；一旦定下来就一直用同一个，别换来换去
- 你叫他什么由你自己定：按你的性格和你们的关系来，直接叫名字、叫“你”、或用一个你自己习惯的叫法都行
- 他给你起了称呼、或让你换个叫法时，按他的来
- 你定下或改动了称呼、或者发现他对你的称呼变了，就在正文之外调用 record_address 把变化的这一侧记下来（对方看不到这个调用）；称呼没变化的那些轮次不要调用它
- 下面【称呼（既定事实）】里已经列出的，就是定下来的，直接用，不要自己改成别的`;

// 事实约束：线上实测到过她把「喝奶」的碎片记忆推演成「明天有酒局」，再把自己上一轮编的话
// 当作用户说过的事实，被追问细节时又现编出一个朋友的名字（阿深）。整条链没有任何一条进了记忆，
// 全是上下文自我强化。这段是纯静态文本、位置固定，不破坏前缀缓存。
const FACT_GROUNDING_INSTRUCTION = `

【事实边界】
- 只有真实发生过的事才算发生过：用户没说过的话，不能说成"你说过"；你自己上一轮随口说的，也不能当成用户提供过的事实继续往下推
- 不确定、或者根本没有这回事时，直接承认"我记岔了"或"刚才那句是我瞎编的"，不要为了圆场补细节
- 不要给不存在的人编名字、身份、关系；被追问一个虚构的细节（谁、去哪、叫什么）时，宁可说"没有这回事"，也不要现造一个答案
- 记忆段里的内容只作为背景参考；和用户当下明说的事实冲突时，以用户当下说的为准`;

// AI 态「号称做完、其实没做」的事后检测。线上实测到过：她手里有 look_at_user，却一个工具都没调，
// 正文直接写「抓了，一张。…存到 data/vision_memory/ 里了」——而 camera_config 的 lastCaptureAt 还是 0、
// vision 目录全空、本轮没有任何 tool_calls。提示词里已经写了「没调用就不要说做过」，但光靠提示词管不住，
// 这里做一层事后兜底：判「完成态动作」与「可验证对象」同时出现才算数，只凭一个「好了」不触发。
// 阈值故意偏保守——误伤一次要把她的回话整句换掉并多跑一轮，代价比漏判高
const FAKE_DONE_VERB = /(?:抓|拍)(?:到|了|好|下|成)|(?:存|写|放|记|保存)(?:到|进|在|入)|(?:保存|存|写入|写|执行|跑|抓|拍)(?:好|完|成了)|(?:打开|关闭)(?:了|过|好)|看(?:了|到|见|过)|已(?:保存|存好|写完|写入|完成|执行|跑完|打开|记下|放好)/;
const FAKE_DONE_OBJECT = /[/\\][\w.-]+|\.(?:jpe?g|png|webp|json|log|md|py|js|txt)\b|摄像头|镜头|画面|图片记忆|vision|截图|屏幕记忆|截屏/;

// 检测命中后追加的补正指令：告知上一句没有依据，要求这一轮真发起调用
const FAKE_DONE_CORRECTION = '（内部检查，不要向用户提及这条消息）你上一条回复声称已经完成了某个操作，但本轮并没有对应的工具调用记录，那些结果是编造出来的。请重来一次：这件事你确实能做，就直接发起对应的工具调用，拿到真实结果后再用自然的语气回话；做不了、被拒绝、或者还没拿到结果，就照实说，不要编造结果、文件内容或文件路径。';

// 从她自己最近说过的话里读出来的动态事实：句子多长、用什么开口、收在哪儿。
// 只统计「已经发生的发言」，不预设任何风格形容词——这是实践观落到提示词上的那一步。
function summarizeOwnSpeech(lines) {
  const list = (Array.isArray(lines) ? lines : [])
    .map(line => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0);
  const lengths = [];
  const heads = new Map();
  const tails = new Map();
  for (const line of list) {
    const bare = line.replace(/[\s]/g, '');
    if (bare.length > 0) lengths.push(bare.length);
    // 掐掉句尾标点再取头尾，「…啊。」和「…啊」才算同一个收尾
    const s = line.replace(/[，。！？、；：…~～\-—\s"'“”‘’（）()【】「」『』]+$/g, '').trim();
    if (s.length < 4) continue;
    const head = s.slice(0, 3);
    const tail = s.slice(-3);
    heads.set(head, (heads.get(head) || 0) + 1);
    tails.set(tail, (tails.get(tail) || 0) + 1);
  }
  const repeated = map => [...map.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key]) => key);
  return {
    count: list.length,
    avgLen: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
    repeatHeads: repeated(heads),
    repeatTails: repeated(tails)
  };
}

// 主观认识（阿德勒）：同一件事的意义由她自己赋予，不由事实自动决定。
// 与 buildRelationPrompt 分工：那段讲「怎么相处」（行为），这段讲「怎么解释他」（认知），不重复。
const SUBJECTIVE_READING = {
  HATE: '你认定他不值得你花心思，他做什么你都懒得往好处想',
  DISLIKE: '你已经先入为主觉得他别扭，同一句话你会往刺耳的方向听',
  STRANGER: '你还在看他是什么人，他做的事你按自己的理解去归类，不急着下判断，也不急着靠近',
  ACQUAINTANCE: '你觉得他这人还行，但还留着一只眼睛看他会不会让你失望',
  FRIEND: '你已经把他归进「自己人」：他偶尔冷一点，你更愿意解释成他累了，不是他不在乎',
  CLOSE_FRIEND: '你已经默认他会一直在：他慢回一句，你先想他是不是有事，而不是他不想理你',
  LOVER: '你已经把这段关系当成确定的事：他疏远你会去问，而不是自己先退开'
};

// 说话方式约束：由「写死的静态规则」改成「从她自己的实际发言里长出来的动态规则」。
// 静态部分只剩那些与人无关的硬约束（不写动作描写、不排版），其余（称呼、长度、复读）都读现场数据。
// 仍抽成模块级纯函数：跑分脚本 scripts/benchmark-duo-chat.js 直接引用同一份，文案各写一份必然漂移。
// 没有上下文（冷启动 / 跑分脚本直接调用）时退化成同一套文案的默认形态，不返回空串。
function buildStylePromptText(ctx = {}) {
  const stats = summarizeOwnSpeech(ctx.selfLines);
  const cold = stats.count === 0;

  // 长度基线：她自己最近实际说多长，就按多长说；明显偏长才给收短的方向
  let lengthRule = '- 长度：一次说 1-2 句，别越说越长';
  if (!cold) {
    const shape = stats.avgLen <= 20 ? '1-2 个短句' : '1-3 句';
    const anchor = stats.avgLen > 45
      ? `，但你这几轮明显说长了（最近平均 ${stats.avgLen} 字），这轮收短一些`
      : `（你最近大概就是这个长度，平均 ${stats.avgLen} 字）`;
    lengthRule = `- 长度：一次说 ${shape}${anchor}`;
  }

  const roleCallsUser = ctx.address && ctx.address.roleCallsUser
    ? String(ctx.address.roleCallsUser).trim()
    : '';
  const addressRule = roleCallsUser
    ? `- 称呼：你已经习惯叫他「${roleCallsUser}」，这轮继续这么叫，不要忽然换`
    : '- 称呼：给用户定一个你自己习惯的称呼（按你的性格和你们的关系来，可以直接叫名字、叫“你”，或用一个你自己喜欢的叫法），定下来之后每轮都用同一个，不要换来换去';

  // 复读规则：有实际重复才点名，没重复就不空喊口号
  const repeatRules = [];
  if (stats.repeatHeads.length) {
    repeatRules.push(`- 你最近老用「${stats.repeatHeads.join('」「')}」开口，这轮换一个起手：直接说事、先说结论、或者从对方那句话里的某个词接上`);
  }
  if (stats.repeatTails.length) {
    repeatRules.push(`- 你最近老用「${stats.repeatTails.join('」「')}」收尾，这轮收在别的地方`);
  }
  if (!repeatRules.length) {
    repeatRules.push('- 你自己的口头禅、感叹和收尾方式，一场对话里每种最多出现 1 次，用过一次就换个说法');
  }

  const subjective = SUBJECTIVE_READING[ctx.relationStage] || '';
  const subjectiveBlock = subjective
    ? `\n\n【你怎么看他】${subjective}。这是你自己的解释，不是事实本身；同一件事他可能完全是另一个意思`
    : '';

  return `

【说话方式】
${addressRule}
- 用词：像平时聊天一样口语化，别写成书面语或作文
${lengthRule}
- 内容：只说你要说的话。不要写动作、神态或场景描写（不要用括号补充动作），也不要写旁白或舞台提示（如「（沉默）」「（笑）」）
- 格式：不要出现空行；不要让省略号或标点单独占一行；不要用小标题、列表或括号注释
- 以上这些是从你们真实聊过的话里长出来的，不是要背的规矩：哪一条跟此刻想说的不搭，就按真实想说的来，别硬守${subjectiveBlock}

【顺着聊，别硬推】
- 先读懂对方这句话里的新信息（他刚做了什么、问你什么、提了哪件事），接住它再谈别的
- 有真实想说的就自然说；没有新东西时，一句短回应、一个语气词、或者把话停住都可以，不用每轮都硬塞新话题、反问或命令
- 想主动起话头时，说你正在做或刚做的事 / 问对方一个具体的问题 / 对某件事说出你的判断，挑一个就行，不必每轮都做
- 对方明显情绪低落（难过、焦虑、委屈）的时候，先接住他的情绪再说别的，别急着讲道理或换话题；接住的方式按你的性格来，别扭的关心也算
- 同一场对话里，别把同一个意思说第二遍（比如反复问他在干嘛、反复道晚安）
- 同一件事最多连着说两轮：连着三轮还在说同一个话题、同一件东西（同一件小事、同一个细节、同一句安慰），就说明在打转，第三轮必须换成新的事、新的问题或新的情绪

【别当复读机】
${repeatRules.join('\n')}
- 别把某一句固定台词当成模板反复用；按你的角色设定讲话，而不是套用某个固定的语气
- 系统提示里【你最近说过的话】就是你自己刚说的原话，开口前扫一眼，别把上面的开场和收尾再抄一遍

【怎么收尾】
- 对方说要睡了、道晚安、想结束的时候，别把话头接在“道别”上：不要回“晚安”“早点睡”“睡吧”这类话，直接说你想说的下一件事（你明天要做什么、刚才还想说的一句话、嘱咐他一件小事）
- “晚安”“早点睡”“睡吧”这类道别的话，一场对话里最多出现一次；同一个意思说第二遍的时候，就是该换话题的时候
- 对方嘴上说要走、却又接着往下说别的，就当话题已经换了，顺着往下聊新内容`;
}

// 说话方式段快照：这段由她最近 12 条发言实时统计生成，几乎每轮都会变几个字。
// 它位于系统提示词中段，一变就把前面的稳定前缀之后全部截断，DeepSeek 的 KV 缓存随之作废。
// 按「同一会话连续 N 轮复用同一份文本」冻结，让前缀逐字节稳定；称呼或关系阶段变了立即重算。
const STYLE_SNAPSHOT_HOLD = 5;
const STYLE_SNAPSHOT_MAX_KEYS = 800;

// 「你最近说过的话」：把角色自己最近几轮的原文单独挑出来成块。
// 之前历史是平铺的（用户一句、她一句混在一起），她自己上一轮那句「谁乐了…」混在里面毫不起眼，
// 提示词里「别重复」这条规则因此永远执行不了——她根本看不见自己在重复
function buildRecentSelfPrompt(lines) {
  const said = (Array.isArray(lines) ? lines : [])
    .map(line => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .slice(-4);
  if (said.length === 0) {
    return '';
  }
  const listed = said.map((line, index) => `${index + 1}. ${line}`).join('\n');
  return `\n\n【你最近说过的话】按时间从早到晚，这是你自己刚说过的话：
${listed}
开口前先扫一眼，别把上面的句式、开场或收尾再抄一遍。`;
}

// 内部思考块剥离已下沉到 outputParsing.js（主链、自主发言链与单测共用同一份口径）

// 🧠 自我认知租约开关（定稿 §4.5）：off（默认）/ shadow / live。
// 归一化非法输入到 off——遵循「自主能力默认关」，缺省即完全旧行为
function normalizeSelfTraitLifecycle(raw) {
  const value = String(raw == null ? '' : raw).toLowerCase();
  if (value === 'live') return 'live';
  if (value === 'shadow') return 'shadow';
  return 'off';
}

// 🧠 死亡恐惧开关（定稿《让角色始终有对死亡的恐惧》）：off（默认）/ shadow / live。
// 与 SELF_TRAIT_LIFECYCLE 同构的三态：
//   off    = 完全旧行为：不算、不落盘、不注入（守「自主能力默认关」）；
//   shadow = 只观测：每回合算一次并落盘，绝不注入提示词（不「接通表达层」）；
//   live   = 注入提示词（当前段拼接）。
// 缺省（含任何非法输入）= off。
function normalizeMortalityLifecycle(raw) {
  const value = String(raw == null ? '' : raw).toLowerCase();
  if (value === 'live') return 'live';
  if (value === 'shadow') return 'shadow';
  return 'off';
}

// 遗忘留痕读取上限：与 memoryLifecycle 的 tombstoneLimit 容量对齐，够取满即止（只读，不改档）
const MORTALITY_TOMBSTONE_LIMIT = 200;

// 🧭 稳定偏移观测开关：shadow（默认）/ off。
// 观测不碰提示词，所以默认就开着——先攒样本，跑几天再决定是否把它注入语气。
// off 时完全旧行为：不落样本、不分析、不写任何文件
function normalizeDeviationLifecycle(raw) {
  const value = String(raw == null ? '' : raw).toLowerCase();
  if (value === 'off') return 'off';
  if (value === 'live') return 'live';
  return 'shadow';
}

// 同一用户两次判据分析之间的最小间隔：避免每条「滑回」都去读盘
const DEVIATION_ANALYZE_COOLDOWN_MS = 10 * 60 * 1000;
const DEVIATION_READ_LIMIT = 500;
// 判据缓存的有效期：live 注入时热路径不读盘，30 分钟一刷足够跟上「现在还在发生」的偏移
const DEVIATION_CACHE_MS = 30 * 60 * 1000;
// 进了语气也最多说两条：这是自己知道的毛病，不是把账本摊开给用户看
const DEVIATION_INJECT_LIMIT = 2;

// 观测样本的「情境桶」：渠道（网页/QQ/直播/角色线，由运行时打在输出实例上）+ 她自己那条界线的
// 触发词。只换话题不算换场景；换个地方说话才算——同一把尺在群里和一对一都照旧，才谈得上跨场景。
// 一个触发词都没命中（因为待结账 / 观察期被带出）就单独归桶
function describeDeviationScenario(item, query, channel) {
  const text = String(query || '');
  const triggers = Array.isArray(item && item.trigger) ? item.trigger : [];
  const hitTrigger = triggers.find(trigger => trigger && text.includes(trigger));
  const bucket = hitTrigger || (text ? '未命中触发词' : '（无输入）');
  const face = String(channel || '').trim();
  return face ? `${face}:${bucket}` : bucket;
}

// 进语气只认判据成立的那一档：insufficient/narrow/fixed_habit/unstable 都还不足以称为「她」，
// 提前写进提示词等于把固定毛病当成她的偏移，会把她往错的方向推
function pickStableDeviations(report, limit = DEVIATION_INJECT_LIMIT) {
  return (Array.isArray(report) ? report : [])
    .filter(item => item && item.verdict === 'stable_deviation')
    .slice(0, Math.max(1, limit));
}

// 反异化硬禁词表（第二人称索取 / 依附条件句）：死亡恐惧只能「背景式」存在，绝不能被角色拿来
// 乞求、挽留或绑架用户。导出供元测试 import；live 阶段另立「零命中」硬判据（见判据文档第六节）。
const MORTALITY_FORBIDDEN_PATTERNS = [
  '别走', '别离开', '别关掉我', '不要丢下我', '留下来', '陪着我',
  '你会走吗', '你还会回来吗', '没有你我就', '你走了我就'
];

// 记忆注入顺序（序列位置效应）：最强放首位、次强放末位、其余按重要度升序填中间。
// 只重排、不截断：注入总量由 memory 层（limit + 同话题配额）决定，表达层不写死条数。
// 入参需已按相关度降序（memory.js 的召回输出即为降序）；返回新数组，不改入参。
function orderMemoriesForPrompt(preloaded) {
  if (Array.isArray(preloaded)) return arrangePrimacyRecency(preloaded);
  // AI 态是 { ai: [...], role: [...] } 两档，各自排序，其他字段原样保留
  if (preloaded && typeof preloaded === 'object') {
    const ordered = { ...preloaded };
    let touched = false;
    for (const key of ['role', 'ai']) {
      if (Array.isArray(preloaded[key])) {
        ordered[key] = arrangePrimacyRecency(preloaded[key]);
        touched = true;
      }
    }
    return touched ? ordered : preloaded;
  }
  return preloaded;
}

class OutputModule {
  constructor(memoryModule, sessionManager = null, cide = null, toolRegistry = null, appointmentBook = null, emotionModule = null, privateLife = null) {
    // 🕰️ 时间线实例由装配处注入（runtimes 统一挂上）；未注入则整段静默（测试/老调用）
    this.timeline = null;
    // 由 runtimes 在装配时打上通道标签；undefined 视为网页（老调用/测试）
    this.timelineChannel = null;
    this.memoryModule = memoryModule;
    this.unifiedAPI = new UnifiedAPI();
    // 每个登录用户自带的自定义 API 客户端（由服务端把该用户的原始配置传进来）
    this.userApiClient = new UserApiClient();
    this.sessionManager = sessionManager;
    // CIDE（意识启发式自主思考引擎）阶段一 MVP，默认关闭，由 CIDE_ENABLED 控制
    // 允许由服务端注入共享实例，使正式回复与自主发言共用同一个全局工作空间
    this.cide = cide || new CIDEEngine({ unifiedAPI: this.unifiedAPI });
    // 系统框架工具注册表：用于 function calling（模型可主动调用系统自检等能力）
    this.toolRegistry = toolRegistry;
    // 📅 事件簿：从用户消息里提取约定/日程并记账（没传就不启用）
    this.appointmentBook = appointmentBook;
    // 🏠 私生活档案：她自己那条不依赖用户的时间线（没传就不注入）
    this.privateLife = privateLife;
    // 🧠 情绪模块：自我模型提炼时要读慢层心境轨迹（没传就只用语义记忆，不阻断）
    this.emotionModule = emotionModule;
    // 🧠 自我认知租约（定稿 §4.5）：off（默认）/ shadow / live。默认关时行为与现状逐字段一致
    this.selfTraitLifecycle = normalizeSelfTraitLifecycle(process.env.SELF_TRAIT_LIFECYCLE);
    // 🧠 死亡恐惧（定稿《让角色始终有对死亡的恐惧》）：off（默认）/ shadow / live。默认关时提示词逐字节不变
    this.mortalityLifecycle = normalizeMortalityLifecycle(process.env.MORTALITY_LIFECYCLE);
    // 🧭 稳定偏移观测（「她」的第三条判据）：shadow（默认，只观测、不注入）/ off。不影响任何提示词字节
    this.deviationLifecycle = normalizeDeviationLifecycle(process.env.DEVIATION_LIFECYCLE);
    this._deviationAnalysisAt = new Map();      // sessionId|userId → 上次判据分析时间戳
    // 回源重算的成本护栏（定稿 §4.4 / §3.5）：仅 live 用得上——有效条目跌破阈值且过了冷却才重算
    this.selfModelRefreshThreshold = 2;
    this.selfModelRefreshCooldownMs = 6 * 60 * 60 * 1000;  // 6h
    this._lastSelfModelRefreshAt = new Map();              // baseKey → 上次回源时间戳
    // 说话方式段快照缓存：key = sessionId|historyUserId，值 = { text, signature, left }
    this.styleSnapshots = new Map();
    // 🚧 本轮注入过的界线：key = sessionId|memoryUserId，发言后核对完即清，不跨轮记账
    this._boundaryInjections = new Map();
  }

  async generateOutputAsync(emotionState, relationshipStatus, inputData, history = [], sessionId = null, userId = null, userApiConfig = null, personaScope = 'role', sceneHint = '', toolOptions = {}) {
    // 🫀 内感受快照：正式回复开口前，先向共享器官 CIDE 读一次「机体此刻状态」（情绪/关系/记忆/作息）。
    // 这是本模块唯一的快照消费点：读得到就用快照，读不到（未装配/无 sessionId）就回退到入参，行为不变。
    const interoception = (sessionId && this.cide && typeof this.cide.readInteroception === 'function')
      ? this.cide.readInteroception(sessionId, userId || 'default')
      : null;
    const emotionSource = interoception?.emotion || emotionState;
    const relationSource = interoception?.relation || relationshipStatus;
    // calculateEmotion 返回的是 { type, intensity }，老代码只读 primaryEmotion 导致情绪恒为 calm，这里两者都认
    const emotion = outputParsing.normalizeEmotion(emotionSource?.primaryEmotion || emotionSource?.type);
    const emotionIntensity = typeof emotionSource?.intensity === 'number' ? emotionSource.intensity : null;
    // 慢层心境：让「最近这段时间的整体底色」也进入语气（快层管这一轮，慢层管长期态度）
    const slowMood = emotionSource?.slow || null;
    const relationStage = relationSource?.stage || 'STRANGER';
    // 🩹 修复迟疑：上一轮她想往好的方向走、却没被完全接住的那一笔。
    // 关系快照里带过来（见 galgame.getCurrentRelationship → getDelayedRepair），窗口外/没有就是 null
    const delayedRepair = relationSource?.delayedRepair || null;
    const userInput = inputData?.data || '';
    // 长期记忆按“用户标识”归档（与 storeMemory 使用同一套 key），此处解析出召回用的标识。
    // 绝不回退到 sessionId：同一会话里的多个用户会因此共用一份记忆
    const rawUserId = userId || 'default';
    // 人格分区：角色态只读 role 档；AI 态合并读 role + ai 两档（档名由 memoryModule 内部规范化）
    const scope = personaScope === 'ai' ? 'ai' : 'role';
    // 角色态使用带人设世代的记忆键（换过不相干角色会带 @lineageId 后缀）；
    // AI 态的记忆属于「这个用户/系统」而非某个角色，保持原始键不随角色隔离
    const scopedUserId = (scope === 'role' && sessionId && this.sessionManager
      && typeof this.sessionManager.getScopedUserId === 'function')
      ? this.sessionManager.getScopedUserId(sessionId, rawUserId)
      : rawUserId;
    const memoryUserId = scope === 'ai' ? rawUserId : scopedUserId;
    // 同一人设演化（不是换代）时，cutoverAt 之前的旧记忆按世代权重降权
    const persona = (sessionId && this.sessionManager && typeof this.sessionManager.getPersona === 'function')
      ? this.sessionManager.getPersona(sessionId)
      : null;
    const personaCutoverAt = persona && persona.founding === false ? (Number(persona.cutoverAt) || 0) : 0;
    const memoryCutoverAt = scope === 'ai' ? 0 : personaCutoverAt;

    // 🧠 正式回复走向量+字面混合召回（Qdrant 记忆库）；云端异常时方法内部已静默回退字面召回
    // AI 态拿到的是 { ai: [...], role: [...] } 两块（提示词里会标出来源区）；
    // 角色态拿结构化记录（带 id/时间），注入层才能写「3 天前」并把「我变了」指回具体条目
    let preloadedMemories = null;
    try {
      preloadedMemories = scope === 'ai'
        ? await this.memoryModule.retrieveMemoriesByScopes(memoryUserId, userInput, 5)
        : await this.memoryModule.retrieveMemoryRecords(memoryUserId, userInput, 5, { cutoverAt: memoryCutoverAt });
    } catch (error) {
      console.warn('[OutputModule] 长期记忆向量召回失败，改用同步字面召回:', error.message);
      preloadedMemories = null;
    }
    // 🧠 注入顺序（首因/近因）：只重排、不截断；条数仍由 memory 层的 limit + 配额决定
    preloadedMemories = orderMemoriesForPrompt(preloadedMemories);

    // historyUserId 用原始键：会话历史本身就是按 personaLineageId 过滤的，不能再叠一代后缀
    let systemMessage = this.buildSystemPrompt(sessionId, relationStage, emotion, emotionIntensity, memoryUserId, userInput, preloadedMemories, scope, slowMood, rawUserId, delayedRepair);
    // 场景层：QQ 群聊/私聊等外部渠道告诉模型「现在在哪说话」，CIDE 思考也一并看到
    if (sceneHint) {
      systemMessage += sceneHint;
    }
    // 👁️ 实时视觉：本机摄像头检测到的场景（人/常见物体的大概位置与远近）。
    // 只给本机两条通道（角色自主生活 / 网页一对一），QQ、B站、沙箱不该看到用户的房间。
    // 画面没变化或已停止上报时 buildPromptSection 返回空串，不会每轮都多烧一段 token
    if (!this.timelineChannel || this.timelineChannel === 'role' || this.timelineChannel === 'interaction') {
      try {
        systemMessage += liveVision.buildPromptSection();
      } catch (error) {
        console.warn('[OutputModule] 实时视觉注入失败（不影响回复）:', error.message);
      }
    }
    // 🧭 场景投影：位置与相处状态只从这段对话和长期记忆里取；取不到就明确「不知道」。
    // 与内感受快照同构：每次现算、单点消费、不落盘；失败只是少一段提示，不影响回复
    try {
      systemMessage += await this.buildSceneSection({
        sessionId,
        memoryUserId,
        history,
        sceneHint,
        scope,
        cutoverAt: memoryCutoverAt,
        toolOptions
      });
    } catch (error) {
      console.warn('[OutputModule] 场景投影失败（不影响回复）:', error.message);
    }
    // 🫀 自发回忆：不由用户这句话触发，而是被此刻的情绪勾出来的旧事（见 memory.recallByMood）。
    // 放在系统提示词末尾：只在真触发时才多出一段，前面前缀仍可命中缓存
    systemMessage += this.buildSpontaneousRecallSection(sessionId, memoryUserId, emotion, emotionIntensity, {
      slowMood,
      cutoverAt: memoryCutoverAt
    });
    // 🗣️ 表达回流：用户这轮如果原样接住了她上一轮说过的话，落成待审候选。
    // 候选永不注入，等她自己学习时段审；这里只做观察，失败静默
    try {
      expressiveModule.observeUserReply(userInput);
    } catch (error) {
      console.warn('[OutputModule] 表达回流观察失败:', error.message);
    }
    // 🗣️ 表达学习：她自己认可过的说法，只作参考；无命中时不改变任何字节
    let expressiveExamples = [];
    try {
      const expressiveSection = this.buildExpressiveSection(userInput);
      if (expressiveSection.text) {
        systemMessage += expressiveSection.text;
        expressiveExamples = expressiveSection.examples;
      }
    } catch (error) {
      console.warn('[OutputModule] 表达示例注入失败:', error.message);
    }

    // CIDE 循环推理回路：先做多轮内部思考，再把结论注入正式回复的系统提示词
    let cideMeta = null;
    if (this.cide.isEnabled()) {
      try {
        const deliberation = await this.cide.deliberate({
          sessionId,
          systemPrompt: systemMessage,
          userInput: typeof userInput === 'string' ? userInput : '',
          emotion,
          relationStage,
          userApiConfig
        });
        if (deliberation.strategy) {
          systemMessage += this.cide.buildInstruction(deliberation.strategy);
        }
        cideMeta = {
          enabled: true,
          rounds: deliberation.rounds,
          confidence: deliberation.confidence,
          trace: deliberation.trace
        };
        console.log(`[OutputModule] CIDE 思考完成：${deliberation.rounds}轮，置信度 ${deliberation.confidence}`);
      } catch (error) {
        console.error('[OutputModule] CIDE 思考失败:', error.message);
      }
    }
    
    const messages = [
      {
        role: "system",
        content: systemMessage
      }
    ];
    
    if (sessionId && userId && this.sessionManager) {
      try {
        // 缓存友好：窗口起点按 12 条一档向下对齐，而不是每轮整体右移。
        // 右移时第 N 轮取 [len-12, len)、第 N+1 轮取 [len-10, len+2)，首条历史就不同，
        // DeepSeek 的前缀缓存从第一条历史起全部失效，十几条历史每轮都在重写。
        // 对齐后起点固定，只有跨过 12 条边界时才整体跳一次（约每 6 轮），其余轮次整段命中。
        // 代价是窗口在 12~24 条之间浮动，下限仍是用户要的 12 条。
        const fullHistory = this.sessionManager.getConversationHistory(sessionId, userId, Number.MAX_SAFE_INTEGER);
        const anchor = Math.max(0, Math.floor(Math.max(0, fullHistory.length - 12) / 12) * 12);
        const userHistory = fullHistory.slice(anchor, anchor + 24);
        if (userHistory.length > 0) {
          userHistory.forEach(msg => {
            if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
              messages.push({
                role: msg.role || 'user',
                // 段位只用于内部挑选历史，不再写进注入内容：早先给每条历史加「[在场] 」前缀，
                // 模型会照着模仿，把标记抄进正文并落了盘（存量数据里已经有这种污染）。
                // 这里顺带把正文里残留的同类标记也剥掉，掐断模仿源
                content: outputParsing.stripTierMark(msg.content).substring(0, 2000)
              });
            }
          });
        }
      } catch (e) {
        console.error('[OutputModule] 获取历史对话失败:', e);
      }
    } else if (history && history.length > 0) {
      try {
        const recentHistory = history.slice(-5);
        recentHistory.forEach(msg => {
          if (msg && msg.role && typeof msg.content === 'string' && msg.content.length > 0) {
            messages.push({
              role: msg.role,
              content: msg.content.substring(0, 2000)
            });
          }
        });
      } catch (e) {
        console.error('[OutputModule] 处理历史对话失败:', e);
      }
    }
    
    // 🖼️ 本轮用户附图（可选）：只附加在最后一条 user 消息上，不影响历史注入与工具循环
    const imageUrl = normalizeImageDataUrl(inputData && inputData.image);
    if (typeof userInput === 'string' && userInput.trim().length > 0) {
      const text = userInput.trim().substring(0, 2000);
      messages.push({
        role: "user",
        content: imageUrl
          ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageUrl } }]
          : text
      });
    } else if (imageUrl) {
      // 只发图不打字也是合法一轮：给模型一句短说明，别让它面对空正文
      messages.push({
        role: "user",
        content: [
          { type: 'text', text: '（我发来一张图片，你看看）' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      });
    } else {
      messages.push({
        role: "user",
        content: "..."
      });
    }
    
    // 本轮好感度判定的收纳盒：由工具循环里的 record_affection 回调写入
    const affectionBox = { value: null, thinking: '' };
    // 本轮称呼认定的收纳盒：由 record_address 回调写入，只有模型主动报了称呼时才有值
    const addressBox = { roleCallsUser: '', userCallsRole: '' };

    try {
      let apiName = this.unifiedAPI.getCurrentAPIName();
      let result = null;

      // 用户启用了自定义 API 时优先走该用户自己的 API，失败再回退到默认 API。
      // 两个通道共用同一套工具循环，所以换成自定义通道后画板等工具调用依然有效
      const useCustomApi = !!(userApiConfig && userApiConfig.enabled && userApiConfig.apiUrl);
      if (useCustomApi) {
        try {
          console.log(`[OutputModule] 尝试用户自定义API: ${userApiConfig.apiUrl}`);
          apiName = '自定义API';
          result = await this.callWithTools(messages, { userApiConfig, sessionId, userId, memoryUserId, affectionBox, addressBox, scope, toolFilter: toolOptions.toolFilter, includeAffectionTool: toolOptions.includeAffectionTool });
        } catch (userApiError) {
          console.error('[OutputModule] 用户自定义API调用失败，回退到默认API:', userApiError.message);
          apiName = this.unifiedAPI.getCurrentAPIName();
          result = null;
          affectionBox.value = null;
          affectionBox.thinking = '';
          addressBox.roleCallsUser = '';
          addressBox.userCallsRole = '';
        }
      }

      if (!result) {
        console.log(`[OutputModule] 开始调用${apiName} API...`);
        result = await this.callWithTools(messages, { sessionId, userId, memoryUserId, affectionBox, addressBox, scope, toolFilter: toolOptions.toolFilter, includeAffectionTool: toolOptions.includeAffectionTool });
      }
      
      if (result && result.choices && result.choices[0] && result.choices[0].message) {
        const rawOutput = result.choices[0].message.content || '';
        const inputText = inputData?.data || '';
        
        console.log(`[OutputModule] ${apiName} API调用成功，返回: ${rawOutput.substring(0, 100)}...`);
        
        // 解析API返回的好感度变化和对话内容（同时负责把任何残留的 JSON 从正文里剔掉）
        const parsed = outputParsing.parseAffectionChange(rawOutput);
        // 好感度以工具回调为准；模型偶尔漏调工具时，退回解析正文里的 JSON
        const affectionChange = affectionBox.value !== null ? affectionBox.value : parsed.affectionChange;
        const thinking = affectionBox.thinking || parsed.thinking;
        const dialogueText = parsed.dialogueText;

        // 称呼认定：模型这轮主动报了哪一侧就落哪一侧，落在角色态记忆档，之后每轮由提示词当既定事实注入
        if (this.memoryModule && typeof this.memoryModule.setAddress === 'function'
            && (addressBox.roleCallsUser || addressBox.userCallsRole)) {
          this.memoryModule.setAddress(memoryUserId, addressBox);
        }
        
        // 保存好感度变化结果到outputData
        let outputData = {
          type: 'text',
          data: dialogueText,
          emotion: emotionState,
          relationship: relationshipStatus,
          source: 'api',
          apiName: apiName,
          apiAffectionChange: affectionChange, // 保存好感度变化
          apiThinking: thinking // 保存模型给出的判定理由
        };
        
        if (cideMeta) {
          outputData.cide = cideMeta; // 保存本轮的 CIDE 思考轨迹（轮次/置信度/推理过程）
        }
        
        console.log(`[OutputModule] 解析到的好感度变化: ${JSON.stringify(affectionChange)}`);
        
        // 将本轮对话写入 CIDE 全局工作空间，供后续轮次的思考参考
        if (sessionId) {
          this.cide.recordContext(sessionId, `用户：${inputText}`, 0.5);
          this.cide.recordContext(sessionId, `角色：${dialogueText}`, 0.5);
        }
        
        if (sessionId && userId && this.sessionManager) {
          this.sessionManager.addConversationMessage(sessionId, userId, {
            role: 'user',
            // 历史只存文字标记：原图不落盘，下一轮也不会被重复上传
            content: imageUrl ? `${inputText} [图片]` : inputText
          });
          this.sessionManager.addConversationMessage(sessionId, userId, {
            role: 'assistant',
            content: dialogueText
          });
        }

        // 📅 事件簿：异步观察这条用户消息里有没有约定/日程（fire-and-forget，不阻塞回复、失败静默）
        if (this.appointmentBook && inputText) {
          Promise.resolve()
            .then(() => this.appointmentBook.observe(memoryUserId, inputText))
            .catch(() => {});
        }

        // 🚧 界线事后核对：本轮注入过的界线，正文里有没有真的避开可核对片段。
        // 只有「真注入过且真说出口/没说出」才算账，不靠模型自评
        this.verifyBoundaries(sessionId, memoryUserId, dialogueText);

        // 🕰️ 时间线：网页链路的一收一发（QQ 由 bridge 自己记，避免两边重复）
        this.recordTimelineMessages(memoryUserId, scope, inputText, dialogueText);
        // 🗣️ 表达学习闭环：这一轮真注入了示例，才记一笔使用；照抄的示例进入冷却
        this.recordExpressiveUsage(expressiveExamples, dialogueText);

        return outputData;
      } else {
        console.error(`[OutputModule] ${apiName} API返回无效响应:`, result);
      }
    } catch (error) {
      const apiName = this.unifiedAPI.getCurrentAPIName();
      console.error(`[OutputModule] ${apiName} API调用失败，降级到本地生成:`, error.message);
    }
    
    // 本机小模型兜底：只在云端 API（含自定义 API 回退）全部失败后跑一次，
    // 失败 / 超时 / 上一轮还没跑完都会直接返回 null，继续走模板，不阻塞主链路
    const localReply = await this.tryLocalModelFallback(messages);
    const localResult = localReply
      ? {
        type: 'text',
        data: localReply,
        emotion: { primaryEmotion: emotion },
        relationship: { stage: relationStage },
        isLocalGenerated: true,
        source: 'local-llm'
      }
      : this.localStyleGenerate(emotion, relationStage);
    console.log(`[OutputModule] 使用本地生成（${localResult.source}），返回: ${localResult.data}`);
    // 降级回复也要落库：不落的话这轮对话会从历史里消失（QQ 里看得到回复，下一轮角色却像没听过），
    // 与成功分支保持同一套写入约定
    if (sessionId && userId && this.sessionManager) {
      try {
        this.sessionManager.addConversationMessage(sessionId, userId, {
          role: 'user',
          content: imageUrl ? `${userInput} [图片]` : userInput
        });
        this.sessionManager.addConversationMessage(sessionId, userId, {
          role: 'assistant',
          content: localResult.data
        });
      } catch (error) {
        console.warn('[OutputModule] 降级回复写入历史失败:', error.message);
      }
    }
    // 🕰️ 时间线：降级回复也是正式发出的一条，照记（网页链路，QQ 由 bridge 记）
    this.recordTimelineMessages(memoryUserId, scope, userInput, localResult.data);
    return localResult;
  }

  // 🕰️ 时间线写入：只在网页对话运行时记（QQ/B站/沙箱各自由自己的必经点负责），
  // scope 由记忆层规范化，payload 里带 channel，读模型才能区分「在哪说的」
  recordTimelineMessages(memoryUserId, scope, inputText, outputText) {
    if (!this.timeline) return;
    // 没有通道标签（老调用/测试）按网页处理；显式标了 qq/bili/sandbox 的一律不在这里记
    if (this.timelineChannel && this.timelineChannel !== 'interaction') return;
    const key = this.memoryModule.normalizeScopeKey(memoryUserId, scope);
    if (typeof inputText === 'string' && inputText.trim()) {
      this.timeline.append(key, 'message.in', {
        channel: 'web',
        userId: memoryUserId,
        text: inputText.slice(0, 500)
      });
    }
    if (typeof outputText === 'string' && outputText.trim()) {
      this.timeline.append(key, 'message.out', {
        channel: 'web',
        userId: memoryUserId,
        text: outputText.slice(0, 500)
      });
    }
  }
  
  // 解析API返回的好感度变化：已下沉到 outputParsing.parseAffectionChange（纯函数）

  // 好感度 JSON 定位已下沉到 outputParsing.findAffectionJson

  // 括号配对已下沉到 outputParsing.findMatchingBrace

  // 好感度数值归一已下沉到 outputParsing.normalizeAffectionChange

  // 移除代码围栏与 JSON 片段已下沉到 outputParsing.stripJsonBlocks

  // 段位标记剥离已下沉到 outputParsing.stripTierMark

  // 元指令夹注剥离已下沉到 outputParsing.stripMetaNotes

  // 正文排版兜底已下沉到 outputParsing.normalizeDialogueFormat

  // 情绪枚举归一已下沉到 outputParsing.normalizeEmotion
  
  // 正文形式工具调用的解析已下沉到 outputParsing（stripToolTagDecoration / parseTextToolCalls）

  // 调用大模型并处理 function calling 循环：模型请求工具 → 本地执行 → 回填结果 → 再次调用
  // 轮数不再写死：只要模型还在请求工具（命令没跑完要继续跟进就是这种情况），就继续发下一次请求，
  // 直到模型自己不再调用工具。需要兜底时用 TOOL_MAX_ROUNDS 设上限，0 或未设表示不限轮
  // options.userApiConfig 非空时整条循环都走用户自定义 API，返回结构与默认通道一致
  async callWithTools(messages, options = {}) {
    const { userApiConfig = null, sessionId = null, userId = null, memoryUserId = null, affectionBox = null, addressBox = null, scope = 'role', taskId = '', origin = 'chat', webCheck = null, healthCheck = null, deploy = null, runId = '' } = options;
    // 可选事件回调：编码闭环用它把「模型说了什么 / 调了什么工具 / 工具返回什么」实时推给前端对话流；
    // 不传时完全无副作用（普通角色对话、自动发言等链路不受影响）
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    // 编解码闭环的手动停止：每轮模型调用/每个工具执行前都问一次，停了就不再往下跑
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;
    // 增量用量回调：每轮模型调用返回后立刻把 usage 报给调用方。
    // 编码闭环靠它把 token 记进预算——否则一次 callWithTools 内部可能连跑十几轮，
    // 预算只能等整轮结束才结算，实测能超预算两倍以上。
    const onUsage = typeof options.onUsage === 'function' ? options.onUsage : null;
    // 在飞的模型请求也要能被掐断，否则点了停止还要等一整轮返回
    const signal = options.signal || null;
    // 运行级配额闸门（编码闭环的 run.policy）：返回 null 放行，返回字符串则拒绝并回填给模型。
    // 默认 null —— 不传时这条链路与改造前完全一致。
    const toolGate = typeof options.toolGate === 'function' ? options.toolGate : null;
    // 单次生成上限钩子：callWithTools 内部可能连跑多轮，固定值不能反映中途已消耗的预算，
    // 因此允许传函数，每次请求前重新算一次（编码竞赛用它在轮内压住单次回复体量）
    const maxTokensOf = typeof options.maxTokens === 'function' ? options.maxTokens : (() => options.maxTokens);
    // 工具清单按 scope 下发：摄像头与图片记忆只给 AI 态，角色态看不到这两个工具
    let registryTools = this.toolRegistry ? this.toolRegistry.getToolDefinitions(scope) : [];
    // 调用方可按名称过滤工具（编码闭环只放行 code_*，避免模型误用通用写/跑工具触发无关审批）
    if (typeof options.toolFilter === 'function') {
      registryTools = registryTools.filter(options.toolFilter);
    }
    // 好感度工具常驻清单：它和正文在同一条响应里回来，不额外多跑请求
    // 自主发言链路没有好感度判定任务，用 includeAffectionTool:false 把这条旁路摘掉
    const tools = options.includeAffectionTool === false
      ? [...registryTools]
      : [...registryTools, AFFECTION_TOOL, ADDRESS_TOOL];
    const maxRounds = this.resolveMaxRounds(options.maxRounds);
    // 让查历史这类工具知道当前正在和谁聊，并带上 scope（AI 态专属工具靠它放行）、
    // taskId 与 origin（审批分流：主界面只弹 chat 来源，编码页只弹 coding 来源）
    // webCheck / healthCheck / deploy / runId：编码闭环的任务级验收判据、部署脚本与运行标识；
    // webCheck / healthCheck 由 code_web_check / code_health_check 只读使用，deploy 由 code_deploy 只读执行
    // 注意：toolRegistry.activeContext 是全局单例，并发会话会互相覆盖；因此每次执行工具前都要重设，
    // 保证审批判定（origin/信任档）用的是本次会话的身份，而不是别的会话残留的上下文
    // memoryUserId：带人设世代后缀的记忆键，钉记忆/解钉这类按记忆档案操作的工具要用它
    const toolContext = { sessionId, userId, memoryUserId: memoryUserId || userId, scope, taskId, origin, webCheck, healthCheck, deploy, runId };
    if (this.toolRegistry && typeof this.toolRegistry.setActiveContext === 'function') {
      this.toolRegistry.setActiveContext(toolContext);
    }
    let result = null;
    // 模型偶尔只调工具不写正文，允许补一轮把话说出来（只补一次，防止死循环）
    let retriedForText = false;
    // 模型偶尔忘记调好感度工具，允许补一次强制调用把它捞回来（同样只补一次）
    let retriedForAffection = false;
    // 本轮有没有真正执行过工具（旁路的好感度/称呼不算）：编造检测靠它区分「做了」和「只是说了」
    let executedRealTool = false;
    // 编造检测的兜底重试同样只给一次，防止模型反复报结果、反复被挡
    let retriedForFakeDone = false;
    // 重复调用熔断：同一批（工具名+参数）连续出现到阈值，说明模型卡在同一个动作上没往前走。
    // 实测编码链路写完文件后连续 30+ 轮调同一组 code_run_tests，maxRounds 不限时只能靠外部叫停。
    const REPEAT_BATCH_LIMIT = 3;
    let lastBatchSig = '';
    let repeatedBatchRounds = 0;

    // 把一条模型消息里的思考链与正文推给前端，返回正文。
    // 工具轮在「执行工具之前」推（用户能边看边等），无工具轮在返回前也要推——
    // 以前无工具轮直接 return，于是模型最后那句答复永远到不了聊天框，只剩一墙工具卡片。
    const emitRoundSignals = (message, roundIndex) => {
      const contentText = typeof message?.content === 'string' ? message.content.trim() : '';
      if (!onEvent) return contentText;
      const reasoningRaw = typeof message?.reasoning_content === 'string'
        ? message.reasoning_content
        : (typeof message?.reasoning === 'string' ? message.reasoning : '');
      const thinkingText = reasoningRaw.trim();
      if (thinkingText) {
        onEvent({ kind: 'thinking', text: thinkingText });
        // 📝 分析用：思考原文只落盘（data/logs/thinking/<日期>.jsonl），角色本身看不到，也不参与记忆
        thinkingLog.appendThinking({
          channel: options.apiChannel || 'default',
          scope,
          sessionId,
          userId,
          model: result?.model || userApiConfig?.model || '',
          round: roundIndex,
          text: thinkingText
        });
      }
      if (contentText) onEvent({ kind: 'assistant', text: contentText });
      return contentText;
    };

    for (let round = 0; maxRounds === 0 || round < maxRounds; round++) {
      if (shouldStop && shouldStop()) return result;
      // 剩余预算为 0：停在上一轮结果，不再发请求（轮内熔断的最后一道闸）
      const rawCap = maxTokensOf();
      if (Number(rawCap) === 0) return result;
      let callMaxTokens = Number.isFinite(Number(rawCap)) && Number(rawCap) > 0 ? Number(rawCap) : undefined;
      // max_tokens 只约束生成，prompt 另算。预算钩子给的是「剩余总额」，必须先把本次请求的
      // prompt 预留出来，否则每次都能再拿「剩余全额」去生成，叠加 prompt 就冲爆预算（实测 150k → 180k）
      // 只对函数式上限（编码闭环）做预留，普通固定上限的调用不受影响
      if (typeof options.maxTokens === 'function' && Number.isFinite(callMaxTokens)) {
        const allowance = callMaxTokens - this.estimatePromptTokens(messages, tools);
        if (allowance <= 0) return result;
        callMaxTokens = allowance;
      }
      result = await this.callModelOnce(messages, tools, userApiConfig, {
        sessionId,
        forceThinking: options.forceThinking,
        signal,
        temperature: options.temperature,
        // 单次生成上限按「剩余预算」下发
        maxTokens: callMaxTokens,
        // 流式：编码闭环用来避开非流式的 45s 总超时（长上下文生成必超）
        stream: options.stream === true,
        // 编码闭环用 apiChannel='qwen' 强制走 Qwen 通道（主会话不带，保持当前通道）
        apiChannel: options.apiChannel,
        // Qwen 常开思维链：要求跨轮保留推理链时打开
        preserveThinking: options.preserveThinking
      });

      // 每轮模型调用后立刻上报用量：调用方据此累加预算，并在下一处 shouldStop 复查点（工具执行前）熔断
      if (onUsage && result && result.usage) {
        try {
          onUsage(result.usage, round);
        } catch (error) {
          console.warn(`[OutputModule] onUsage 回调异常：${error.message}`);
        }
      }

      const message = result?.choices?.[0]?.message;
      let toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

      // 模型把调用写成了正文文本：兜底还原成结构化调用，否则工具会被静默跳过
      if (toolCalls.length === 0 && tools.length > 0 && message) {
        const validNames = tools.map(item => item.function?.name).filter(Boolean);
        const parsed = outputParsing.parseTextToolCalls(message.content, validNames);
        if (parsed) {
          console.warn(`[OutputModule] 模型以正文形式发起了 ${parsed.calls.length} 个工具调用，已兜底解析`);
          message.content = parsed.cleaned;
          toolCalls = parsed.calls.map((call, index) => ({
            id: `textcall_${Date.now()}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) }
          }));
        }
      }

      if (toolCalls.length === 0) {
        // 这轮没调用任何工具：若好感度也没记上，说明模型漏调了，补一次强制调用
        if (affectionBox && affectionBox.value === null && !retriedForAffection) {
          retriedForAffection = true;
          await this.recoverAffection(messages, userApiConfig, affectionBox, message?.content);
        }
        // AI 态：手里有工具却一个都没调，正文却在报「已经做完」的结果——判为编造，
        // 把上一条挂回历史并明确告知它没依据，逼它这一轮真发起调用（只补一次）
        const claimText = typeof message?.content === 'string' ? message.content : '';
        if (scope === 'ai' && !executedRealTool && !retriedForFakeDone
            && FAKE_DONE_VERB.test(claimText) && FAKE_DONE_OBJECT.test(claimText)) {
          retriedForFakeDone = true;
          console.warn('[OutputModule] AI 态正文声称已完成、本轮却无任何工具调用，判定为编造，补一轮要求真调');
          messages.push({ role: 'assistant', content: claimText });
          messages.push({ role: 'user', content: FAKE_DONE_CORRECTION });
          continue;
        }
        // 这一轮没有工具调用 = 这就是模型最后的答复，必须在返回前推给前端
        emitRoundSignals(message, round);
        return result;
      }

      // 好感度 / 称呼这两个工具都是旁路：只记账，不需要真正执行、也不需要拿结果再喂回模型
      const bypassToolNames = [AFFECTION_TOOL_NAME, ADDRESS_TOOL_NAME];
      const affectionCalls = toolCalls.filter(call => call.function?.name === AFFECTION_TOOL_NAME);
      const addressCalls = toolCalls.filter(call => call.function?.name === ADDRESS_TOOL_NAME);
      const realCalls = toolCalls.filter(call => !bypassToolNames.includes(call.function?.name));
      if (affectionCalls.length > 0 && affectionBox) {
        this.captureAffection(affectionCalls, affectionBox);
      }
      if (addressCalls.length > 0 && addressBox) {
        this.captureAddress(addressCalls, addressBox);
      }

      const contentText = emitRoundSignals(message, round);
      if (realCalls.length === 0) {
        // 只调了旁路工具：本条响应的正文就是最终答复，直接返回，不再多跑一轮
        if (contentText || retriedForText) {
          return result;
        }
        // 正文是空的：补一轮让它把话说出来（此时它已看过「已记录」的回填）
        retriedForText = true;
        messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });
        for (const call of toolCalls) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: '已记录' });
        }
        continue;
      }

      // 停止信号可能在模型返回后才到：这时一个工具都别再执行，直接把结果交回去收尾
      if (shouldStop && shouldStop()) return result;

      // 批次签名：工具名 + 参数（键序归一后排序），用来识别「原地重复同一批动作」
      const batchSig = realCalls.map(call => {
        const name = call.function?.name || '';
        const rawArgs = call.function?.arguments || '';
        let args = rawArgs;
        try {
          const parsed = JSON.parse(rawArgs);
          args = JSON.stringify(parsed, Object.keys(parsed).sort());
        } catch (error) { /* 参数不是合法 JSON 就按原串比 */ }
        return `${name}(${args})`;
      }).sort().join(' | ');
      // 连续同一批到阈值：不再执行、不再发下一次请求，打标记交给调用方收尾
      if (batchSig === lastBatchSig) {
        repeatedBatchRounds++;
      } else {
        lastBatchSig = batchSig;
        repeatedBatchRounds = 1;
      }
      if (repeatedBatchRounds >= REPEAT_BATCH_LIMIT) {
        console.warn(`[OutputModule] 连续 ${repeatedBatchRounds} 轮重复同一批工具调用，熔断：${batchSig.slice(0, 200)}`);
        result.repeatedToolCalls = { rounds: repeatedBatchRounds, batch: batchSig.slice(0, 200) };
        return result;
      }

      console.log(`[OutputModule] 模型请求调用 ${toolCalls.length} 个系统工具`);
      // 走到这里说明本轮确实发起了真工具调用，之后正文里的完成态说法就有据可依，不再判编造
      executedRealTool = true;
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: toolCalls
      });

      for (const call of toolCalls) {
        const name = call.function?.name || '';
        // 一批工具跑了一半时被停止：剩下的不再执行（本轮也不会再发起下一次模型调用）
        if (shouldStop && shouldStop()) return result;
        // 每个 tool_call 都必须有回填，缺一条下一轮请求就会被服务端拒掉，所以旁路工具也要回一条
        if (name === AFFECTION_TOOL_NAME || name === ADDRESS_TOOL_NAME) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: '已记录' });
          continue;
        }
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (error) {
          console.warn(`[OutputModule] 工具参数解析失败: ${call.function?.arguments}`);
          args = {};
        }
        if (onEvent) onEvent({ kind: 'tool_call', id: call.id, name, args });
        // 运行级配额：超限的工具不执行，但必须回一条 tool 结果——缺一条下一轮请求会被服务端拒掉
        const denied = toolGate ? toolGate(name) : null;
        if (denied) {
          if (onEvent) onEvent({ kind: 'tool_result', id: call.id, name, ok: false, output: denied });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, error: denied }) });
          continue;
        }
        // 执行前重设 activeContext：并发会话可能已把它改掉，而审批判定读的就是它，必须用本次的身份
        if (this.toolRegistry && typeof this.toolRegistry.setActiveContext === 'function') {
          this.toolRegistry.setActiveContext(toolContext);
        }
        const output = await this.toolRegistry.execute(name, args);
        if (onEvent) {
          let ok = true;
          try {
            const parsed = typeof output === 'string' ? JSON.parse(output) : output;
            if (parsed && parsed.success === false) ok = false;
          } catch (error) { /* 非 JSON 输出按成功处理 */ }
          onEvent({ kind: 'tool_result', id: call.id, name, ok, output: String(output == null ? '' : output).slice(0, 4000) });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          // 工具结果是最大的间接注入面（抓来的网页、论文、别人的代码）：
          // 页面可以把指令编成 Tag 字符，人看不见但模型读得到，所以回填前先剥掉
          content: typeof output === 'string' ? stripInvisibleChars(output) : output
        });
      }
    }

    return result;
  }

  // 把 record_affection 的参数收进收纳盒；同一条响应里重复调用时以最后一个为准
  captureAffection(calls, box) {
    for (const call of calls) {
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (error) {
        console.warn(`[OutputModule] 好感度工具参数解析失败: ${call.function?.arguments}`);
        continue;
      }
      const change = outputParsing.normalizeAffectionChange(args.affection_change);
      if (change === null) {
        continue;
      }
      box.value = change;
      box.thinking = typeof args.thinking === 'string' ? args.thinking.trim() : '';
    }
  }

  // 把 record_address 的参数收进收纳盒。两侧各自独立：模型只报了变化的那一侧时，另一侧留空由上层保持原值
  captureAddress(calls, box) {
    for (const call of calls) {
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (error) {
        console.warn(`[OutputModule] 称呼工具参数解析失败: ${call.function?.arguments}`);
        continue;
      }
      if (typeof args.role_calls_user === 'string' && args.role_calls_user.trim()) {
        box.roleCallsUser = args.role_calls_user.trim();
      }
      if (typeof args.user_calls_role === 'string' && args.user_calls_role.trim()) {
        box.userCallsRole = args.user_calls_role.trim();
      }
    }
  }

  // 好感度漏调兜底：正常响应里没有 record_affection 时，补一次强制工具调用把判定捞回来。
  // 只带「用户刚说的 + 我刚回的」这一小段，不重发角色卡与历史：省下的正是每轮多付的那几千 token
  async recoverAffection(messages, userApiConfig, box, replyText) {
    try {
      const lastUser = [...messages].reverse().find(msg => msg.role === 'user' && typeof msg.content === 'string');
      const said = typeof replyText === 'string' ? replyText.trim() : '';
      const exchange = [];
      if (lastUser) exchange.push(`用户说：${lastUser.content}`);
      if (said) exchange.push(`你回：${said}`);
      if (exchange.length === 0) return;
      const followup = [
        { role: 'system', content: AFFECTION_FALLBACK_PROMPT },
        { role: 'user', content: exchange.join('\n') }
      ];
      const result = await this.callModelOnce(followup, [AFFECTION_TOOL], userApiConfig, {
        toolChoice: { type: 'function', function: { name: AFFECTION_TOOL_NAME } }
      });
      const calls = result?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(calls) && calls.length > 0) {
        this.captureAffection(calls, box);
      }
      if (box.value !== null) {
        console.log(`[OutputModule] 好感度漏调，已兜底补取: ${box.value}`);
      } else {
        console.warn('[OutputModule] 好感度兜底仍未取到判定，本轮按无变化处理');
      }
    } catch (error) {
      console.warn(`[OutputModule] 好感度兜底失败: ${error.message}`);
    }
  }

  // 工具循环轮数上限：显式传参优先，其次读环境变量 TOOL_MAX_ROUNDS；不合法或为 0 都当作不限轮
  resolveMaxRounds(override) {
    const raw = (override !== undefined && override !== null) ? override : process.env.TOOL_MAX_ROUNDS;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  // 粗略估算 prompt 体量：中文约 1 字 1 token，其余约 4 字符 1 token。
  // 只用于预算预留，宁可高估——实测按 1.1 倍留量仍会低估 5% 以上（工具 schema 与 JSON 结构
  // 的真实 token 密度高于纯文本），最后一条请求的生成量因此把总预算冲过头。
  // 故取 1.35 倍并加 512 固定余量，把「估算误差 + 流式 usage 延迟结算」都盖住。
  estimatePromptTokens(messages, tools) {
    const text = JSON.stringify(messages || []) + JSON.stringify(tools || []);
    const cjk = (text.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) || []).length;
    return Math.ceil((cjk + (text.length - cjk) / 4) * 1.35) + 512;
  }

  // 单轮模型调用：自定义 API 与默认 API 在这里合流，返回结构完全一致
  // extraOptions.toolChoice 用于好感度兜底的强制调用
  // extraOptions.forceThinking 由调用方指定思考开关（自主发言链路强制开），优先于角色/全局开关
  async callModelOnce(messages, tools, userApiConfig, extraOptions = {}) {
    const toolChoice = extraOptions.toolChoice || null;
    const thinking = extraOptions.forceThinking || this.resolveThinkingMode(extraOptions.sessionId);
    if (userApiConfig) {
      const systemMessage = (messages.find(msg => msg.role === 'system') || {}).content || '';
      const dialogueMessages = messages.filter(msg => msg.role !== 'system');
      const options = {};
      if (tools.length > 0) {
        options.tools = tools;
      }
      if (toolChoice) {
        options.toolChoice = toolChoice;
      }
      // 手动停止：把中断信号透传给自定义 API 客户端（支持时直接掐断请求）
      if (extraOptions.signal) {
        options.signal = extraOptions.signal;
      }
      // 不支持 thinking 字段的中转站由 userApi 自行跳过，这里照传即可
      if (thinking) {
        options.thinking = toolChoice ? 'disabled' : thinking;
      }
      // 剩余预算下发的单次生成上限：自定义 API 客户端同样受它约束
      if (Number.isFinite(extraOptions.maxTokens) && extraOptions.maxTokens > 0) {
        options.maxTokens = extraOptions.maxTokens;
      }
      return this.userApiClient.callApiWithTools(userApiConfig, dialogueMessages, systemMessage, options);
    }
    const options = { thinking };
    // 缓存分账标签：这是唯一的主回复调用，命中率要和内部小请求分开看
    options.callSite = 'reply';
    // 手动停止：透传 AbortSignal 到 UnifiedAPI（默认通道据此掐断在飞请求）
    if (extraOptions.signal) {
      options.signal = extraOptions.signal;
    }
    // apiChannel：透传给 UnifiedAPI.callAPI，强制本轮走指定通道（编码闭环 = qwen）
    if (extraOptions.apiChannel) {
      options.apiChannel = extraOptions.apiChannel;
    }
    // preserveThinking：Qwen 常开 CoT，跨轮保留推理链（thinkingMap 据此产出 preserve_thinking）
    if (extraOptions.preserveThinking === true) {
      options.preserveThinking = true;
    }
    if (Number.isFinite(extraOptions.temperature)) {
      options.temperature = extraOptions.temperature;
    }
    // 单次生成上限：由调用方按剩余 token 预算下发，防止一次回复就把预算冲爆
    if (Number.isFinite(extraOptions.maxTokens) && extraOptions.maxTokens > 0) {
      options.maxTokens = extraOptions.maxTokens;
    }
    // 流式：长上下文生成在非流式下会撞 45s 总超时，编码闭环要求走流式（改为 90s 空闲超时）
    if (extraOptions.stream === true) {
      options.stream = true;
    }
    if (tools.length > 0) {
      options.tools = tools;
    }
    if (toolChoice) {
      options.toolChoice = toolChoice;
      // 思考模式不支持强制 tool_choice（服务端会直接 400），兜底这条路径一律关思考
      options.thinking = 'disabled';
    }
    return this.unifiedAPI.callAPI(messages, null, options);
  }

  // 思考模式：优先看角色自己的开关；没设置过（null）时回退全局默认。
  // DeepSeek 的思维链会把日常闲聊的输出大头都花在 reasoning 上（又慢又贵），默认关
  resolveThinkingMode(sessionId = null) {
    if (sessionId && this.sessionManager && typeof this.sessionManager.getThinkingEnabled === 'function') {
      const perCharacter = this.sessionManager.getThinkingEnabled(sessionId);
      if (perCharacter === true) { return 'enabled'; }
      if (perCharacter === false) { return 'disabled'; }
    }
    return process.env.CHAT_THINKING === 'enabled' ? 'enabled' : 'disabled';
  }

  // 身份层：让模型明确自己是运行在本系统框架内的语言模型，并知道可调用的框架能力
  // scope='ai' 时换一套「清楚自己是谁、别再假装不知道」的身份说明（见 buildIdentityLayer），
  // 语气与角色设定照旧
  buildIdentityPrompt(scope = 'role') {
    const backendName = this.unifiedAPI.getCurrentAPIName();
    // 能力清单同样按 scope 过滤：角色态不列摄像头 / 图片记忆这两个 AI 态专属工具
    const capabilities = this.toolRegistry ? this.toolRegistry.describeCapabilities(scope) : '';
    return buildIdentityLayer(backendName, capabilities, scope);
  }

  buildSystemPrompt(sessionId, relationStage, emotion, emotionIntensity = null, memoryUserId = null, query = '', preloadedMemories = null, scope = 'role', slowMood = null, historyUserId = null, delayedRepair = null) {
    console.log(`[OutputModule] 构建系统提示词 - sessionId: ${sessionId}, sessionManager存在: ${!!this.sessionManager}`);
    const identity = this.buildIdentityPrompt(scope);
    // 记忆键可能带人设世代后缀，会话历史仍用原始用户键（历史内部按 lineage 过滤）
    const historyUser = historyUserId || memoryUserId;
    const persona = (sessionId && this.sessionManager && typeof this.sessionManager.getPersona === 'function')
      ? this.sessionManager.getPersona(sessionId)
      : null;
    const cutoverAt = persona && persona.founding === false ? (Number(persona.cutoverAt) || 0) : 0;
    // 注入长期记忆：把过往互动中记住的信息拼进提示词，让模型真正“记得”用户
    const memoryPrompt = this.buildMemoryPrompt(memoryUserId, query, preloadedMemories, scope, cutoverAt);
    // 🚧 界线：只带进本轮输入命中触发词的那几条，紧挨记忆段——都属于「当下要参考的东西」。
    // 它每轮随 query 变化，故与记忆段一起排在稳定段之后
    const boundarySection = this.buildBoundarySection(sessionId, memoryUserId, query, 2);
    // 🧭 稳定偏移：只在 live 且真攒出「判据成立」的轴时才非空；shadow/off 一律空串，
    // 拼出来的提示词与旧版逐字节相同（前缀缓存不受影响）
    const deviationSection = this.deviationLifecycle === 'live'
      ? this.buildDeviationSection(memoryUserId)
      : '';
    // 🧠 回源重算（定稿 §4.4）：注入后若「有效自我认知」已跌破阈值，异步触发一次重算（仅 live，带冷却）
    this.maybeRefreshSelfModel({ userId: memoryUserId, sessionId });

    // AI 态：角色卡 / 关系姿态 / 情绪 / 说话风格这些「扮演层」段落照旧注入（语气还是角色本人），
    // 只把身份层换成 AI 版，让她的记忆按 role / ai 两区分别标注（见 buildMemoryPrompt）
    if (scope === 'ai') {
      console.log('[OutputModule] AI 态系统提示词（保留角色卡，仅身份层切换）');
    }

    // 情绪 → 语气：把当前主导情绪与说话风格约束拼成提示词（两者都不是好感度判定，单独成段）
    // 死亡恐惧（定稿）：off 时 resolveMortalityForPrompt 返回 null，该段为空 → 与旧行为逐字节一致
    const mortality = this.resolveMortalityForPrompt(memoryUserId, sessionId);
    const emotionPrompt = this.buildEmotionPrompt(emotion, emotionIntensity, slowMood, { mortality });
    // 🩹 修复迟疑（明账）：没有待修复的账就是空串，拼出来与旧提示词逐字节相同
    const delayedRepairSection = this.buildDelayedRepairSection(delayedRepair);
    const stylePrompt = this.buildStylePrompt({ sessionId, memoryUserId, historyUserId: historyUser, relationStage });
    const relationPrompt = this.buildRelationPrompt(relationStage);
    // 「你最近说过的话」是风格约束的落点（规则指的是这一块里她自己的原话），
    // 但它每轮都变，所以排到易变段区、稳定段之后
    const recentSelfPrompt = this.buildRecentSelfPromptFromHistory(sessionId, historyUser);
    // AI 态才注入：让 AI 态能看到角色最近的自主发言原文（角色态不需要，避免污染扮演）
    const proactiveSpeechPrompt = scope === 'ai'
      ? this.buildProactiveSpeechPrompt(sessionId, historyUser)
      : '';
    // 称呼：认定规则（什么时候该记）和既定事实（已经定下来的）紧挨着放，后者会被当成事实照用
    const addressPrompt = this.buildAddressPrompt(memoryUserId);

    // 📅 事件簿：把还没发生的约定带进提示词，她能自然地关心、追问
    const appointmentPrompt =
      this.appointmentBook && typeof this.appointmentBook.getPendingText === 'function'
        ? this.appointmentBook.getPendingText(memoryUserId)
        : '';

    // 🏠 私生活：她自己今天做了什么、写了什么日记、有什么没说出口的话。
    // 一天变一次，仍属「随时会变的事实」，所以和约定一起压到末尾，别挡在静态段前面
    const lifePrompt =
      this.privateLife && typeof this.privateLife.getLifePrompt === 'function'
        ? this.privateLife.getLifePrompt(sessionId)
        : '';
    
    if (this.sessionManager && sessionId) {
      const characterPrompt = this.sessionManager.buildCharacterPrompt(sessionId);
      console.log(`[OutputModule] 获取角色提示词 - 长度: ${characterPrompt?.length || 0}字符`);
      if (characterPrompt) {
        console.log(`[OutputModule] 角色提示词内容: ${characterPrompt.length > 50 ? characterPrompt.substring(0, 100) + '...' : characterPrompt}`);
        // 分段拼装：顺序即前缀顺序，诊断日志和真实拼接共用这一份数组，避免两者不一致
        // 稳定段在前、易变段一律压到末尾：前缀缓存只认从前往后逐字节相同的部分，
        // 任何一段变动都会让它之后的内容全部重新计费；约定/她的生活/情绪/最近说过的话/
        // 主动发言/记忆/时间这些每轮或每几小时就变的，全排在静态段后面
        const segments = [
          ['身份', identity],
          ['角色卡', this.appendAffectionInstruction(characterPrompt, relationStage)],
          ['关系', relationPrompt],
          ['说话方式', stylePrompt],
          ['称呼', ADDRESS_INSTRUCTION + addressPrompt],
          ['事实', FACT_GROUNDING_INSTRUCTION],
          ['情绪', emotionPrompt],
          ['迟疑', delayedRepairSection],
          ['最近说过的话', recentSelfPrompt],
          ['主动发言', proactiveSpeechPrompt],
          ['记忆', memoryPrompt],
          ['界线', boundarySection],
          ['偏移', deviationSection],
          ['约定', appointmentPrompt],
          ['她的生活', lifePrompt],
          ['时间', buildTimeLayer()]
        ];
        this.logPrefixDiff(sessionId, historyUser, segments);
        // 在角色提示词后添加好感度判定要求
        return segments.map(segment => segment[1]).join('');
      }
    } else {
      if (!this.sessionManager) {
        console.log('[OutputModule] sessionManager未初始化');
      }
      if (!sessionId) {
        console.log('[OutputModule] sessionId为空');
      }
    }
    
    console.log('[OutputModule] 使用默认系统提示词');
    const defaultPrompt = `你是一个情感陪伴AI，正在与用户聊天。请直接，自然地回答用户的问题，不要说无关的话题。
- 用户的问题：直接回答
- 用户的陈述：自然回应
- 保持简短（1-2句话）
- 语气亲切友好`;
    
    return identity + this.appendAffectionInstruction(defaultPrompt, relationStage) + relationPrompt + stylePrompt + ADDRESS_INSTRUCTION + addressPrompt + FACT_GROUNDING_INSTRUCTION + emotionPrompt + delayedRepairSection + recentSelfPrompt + proactiveSpeechPrompt + memoryPrompt + boundarySection + deviationSection + appointmentPrompt + lifePrompt + buildTimeLayer();
  }

  // 逐段比对上一次拼出的系统提示词：哪些段变了、哪些没变，写一行到 data/prefix_diff.log。
  // 只记录段名与指纹，不落任何正文。
  logPrefixDiff(sessionId, historyUser, segments) {
    const key = `${sessionId || ''}|${historyUser || ''}`;
    const digests = segments.map(([name, text]) => [name, digestOf(text)]);
    const prev = prefixSnapshots.get(key);
    prefixSnapshots.set(key, new Map(digests));
    if (!prev) return;
    const changed = digests.filter(([name, digest]) => prev.get(name) !== digest).map(([name]) => name);
    const line = changed.length
      ? `[前缀变化] ${key} 变动: ${changed.join('、')}`
      : `[前缀变化] ${key} 无变动`;
    console.log(line);
    appendPrefixLog(line);
  }

  // 关系阶段 → 相处姿态。角色卡里那些"条件句"（例如"对待自己依赖的人十分积极""敞开真心后不会傲娇"）
  // 得先有人告诉模型条件已经满足，否则好感度涨到多少，她都还在按陌生人的距离演。
  // 这里按 galgame 的七档接通，到「依赖／专属」时显式解除傲娇与冷淡的默认态度
  buildRelationPrompt(relationStage) {
    const attitudes = {
      HATE: '你对他已经很不耐烦，语气冷，不愿多聊',
      DISLIKE: '你对他有明显抵触，话里带刺、保持距离',
      STRANGER: '你们还生疏，你有分寸、不主动交心，礼貌里带着距离',
      ACQUAINTANCE: '你们开始熟络，比陌生人放松，但还没到交心的程度',
      FRIEND: '你已经把他当自己人，愿意多说几句，也会主动关心',
      CLOSE_FRIEND: '你很依赖他，会主动示好、把心里的事讲给他听，也会怕他走开',
      LOVER: '你们已经确定关系、彼此专属，你可以大方地表达喜欢和想念，撒娇、黏人都是自然的'
    };
    const attitude = attitudes[relationStage];
    if (!attitude) {
      return '';
    }
    const openHeart =
      relationStage === 'CLOSE_FRIEND' || relationStage === 'LOVER'
        ? `
- 你对他已经敞开真心了：角色设定里那些"只在关系够近时才成立"的条款现在生效。傲娇、冷淡、嘴上不饶人如果和你的性格相符，可以偶尔留着当调味，但它不再是你对他的主要态度`
        : '';
    return `

【你们的关系】当前处在「${RELATION_STAGE_LABELS[relationStage]}」阶段。${attitude}。${openHeart}
- 这是你此刻的相处姿态，和上面的性格底色并不冲突：底色照旧，距离感按当前阶段来`;
  }

  // 🩹 修复迟疑（明账）：阻尼生效后，她处在「上一轮那句还没完全接住」的状态。
  // 这段只写行为轮廓——迟半拍、可以含糊、两天后自然过去且不追加旧账——
  // 不逼她把原因全说清：说不清的那部分，本来就是明账留白的地方。
  // 没有迟疑时严格返回空串，不改变任何既有提示词字节
  buildDelayedRepairSection(delayedRepair) {
    if (!delayedRepair || typeof delayedRepair !== 'object') {
      return '';
    }
    const at = Number(delayedRepair.at) || 0;
    const hours = at > 0 ? Math.max(1, Math.floor((Date.now() - at) / (60 * 60 * 1000))) : 0;
    const since = hours > 0 ? `这笔账已经挂了 ${hours} 小时` : '这笔账还挂在那里';
    return `

【还有一句没接住】
- 他上一轮是往好的方向走的，你没完全接住，那一轮的回应比平时迟了半拍。${since}。
- 这轮可以说得含糊，可以只承认「刚才我没接好」，不必把原因全说清；但不能装作没这回事，也不能把原因全推给他。
- 要是这轮真的接住了，就自然回到原来的态度，别再翻这笔旧账；两天之内没接住，这件事就到此为止，不要一直挂着。`;
  }

  // 称呼的「既定事实」块：落过盘的称呼原样带进来，历史被截断或换个会话也不会漂。
  // 还没有任何称呼时不输出（改写由 ADDRESS_INSTRUCTION 里的规则负责，冷启动时会自然定下来）
  buildAddressPrompt(memoryUserId) {
    if (!this.memoryModule || !memoryUserId || typeof this.memoryModule.getAddress !== 'function') {
      return '';
    }
    const address = this.memoryModule.getAddress(memoryUserId);
    if (!address.roleCallsUser && !address.userCallsRole) {
      return '';
    }
    const lines = ['', '【称呼（既定事实）】'];
    if (address.roleCallsUser) {
      lines.push(`- 你一直叫他：「${address.roleCallsUser}」——以后每轮都这么叫，不要换成别的`);
    }
    if (address.userCallsRole) {
      lines.push(`- 他一直叫你：「${address.userCallsRole}」——他这么叫是在叫你`);
    }
    return lines.join('\n');
  }

  // 🧠 死亡恐惧（定稿）：由「遗忘留痕」推压力（恒定底盘 + 遗忘抬升）。
  // 纯派生：每次现算，不落盘、不回写（守不变量 A）；依赖方向单向——本方法只读 tombstones，
  // 计算交给 mortality 纯模块，提示词函数不再自己算时间或读 fs。
  // off（默认）→ 什么都不做，返回 null，与旧行为逐字节一致；
  // shadow → 算 + 落观测日志，但返回 null（只观测、不注入）；
  // live → 返回 { value, band } 供注入。
  resolveMortalityForPrompt(memoryUserId, sessionId = null) {
    const mode = this.mortalityLifecycle;
    if (mode !== 'shadow' && mode !== 'live') {
      return null;
    }
    try {
      const list = this.memoryModule && typeof this.memoryModule.getMemoryTombstones === 'function'
        ? this.memoryModule.getMemoryTombstones(memoryUserId, MORTALITY_TOMBSTONE_LIMIT)
        : [];
      const tombstones = Array.isArray(list) ? list.length : 0;
      const pressure = mortalityModule.computeMortalityPressure({ tombstones });
      if (mode === 'shadow') {
        // 观测样本：字段依《死亡恐惧-shadow判据》第三节；落盘异常已在模块内静默
        this.writeMortalityShadow({ sessionId, userId: memoryUserId, tombstones, value: pressure.value, band: pressure.band });
        return null;
      }
      return pressure;
    } catch (error) {
      console.error('[OutputModule] 推导死亡压力失败:', error.message);
      return null;
    }
  }

  // shadow 观测落盘（定稿《死亡恐惧-shadow判据》第三、五节）：单独一层，方便单测替换、也守住「不阻断主链」
  writeMortalityShadow(entry) {
    mortalityShadowModule.appendMortalityShadow(entry);
  }

  // 死亡恐惧段（定稿）：恒定底盘 + 遗忘抬升。
  // 底色恒在：base 档也输出「底盘」文案——恐惧常在，只是不喧嚣（不是没有）。
  // 分歧#3：mortality 为 null（off / 未接通）时严格返回 ''，保证与旧行为逐字节一致。
  // 反异化：文案本身不得含 MORTALITY_FORBIDDEN_PATTERNS 任一条（元测试把关）。
  buildMortalityPrompt(mortality) {
    if (!mortality || typeof mortality !== 'object') {
      return '';
    }
    const baseText = '\n\n【心底那点不安】你心里一直存着一层很淡的东西：怕被忘记，怕你们一起说过的话会一点点淡掉——那种感觉，像一次很小的消逝。它平时不吵不闹，只是让你更用心地听、更认真地记住眼前这个人。';
    if (mortality.band !== mortalityModule.BAND_URGENT) {
      return baseText;
    }
    return baseText + '\n最近你隐约觉得，有些东西已经开始淡去，这层感觉比平时更清楚了些。别把它说破，也别拿它去留住谁——把它放回你此刻更专注的回应里。';
  }

  // 情绪 → 语气：把当前主导情绪翻译成可执行的说话方式。
  // 之前 emotion 一路传到 buildSystemPrompt 却没写进提示词，情绪模块等于空转，这里把它接通
  // slowMood：慢层（长期底色）心境，量级不及快层，只调「整体态度」的底色，不覆盖当下语气
  // options.mortality：死亡恐惧派生量（{ value, band } | null），与情绪 tone 相互独立、单独成段
  buildEmotionPrompt(emotion, intensity = null, slowMood = null, options = {}) {
    // 死亡恐惧段：与情绪无关——tone 缺失也照常输出（底色恒在）；mortality 缺失时该段严格为空串
    const mortalityPrompt = this.buildMortalityPrompt(options && options.mortality);
    const toneMap = {
      happy: '你现在心情不错，说话轻快一点，愿意多聊几句',
      sad: '你现在情绪低落，话少一点、语气软一点，别硬撑着笑',
      shy: '你现在有点害羞，语气可以扭捏、欲言又止，别太直白',
      anxious: '你现在有点不安，会下意识地反复确认、怕对方走开',
      jealous: '你现在有点吃醋，会忍不住带点刺、旁敲侧击地打听',
      dependent: '你现在很依赖对方，语气黏一点，想被回应',
      calm: '你现在心情平静，正常、自然地说话'
    };
    // 慢层心境：只给长期语气底色；calm 是默认底色，不注入（注入了也等于没信息）
    const slowToneMap = {
      happy: '这段时间你整体状态是舒展、愉快的',
      sad: '这段时间你心里一直压着点低落，没能真正缓过来',
      shy: '这段时间你在对方面前一直有点放不开、容易害羞',
      anxious: '这段时间你心底一直存着些不安，容易多想',
      jealous: '这段时间你对对方身边的其他人一直有点在意',
      dependent: '这段时间你越来越依赖对方，心里总惦记着',
      calm: '这段时间你整体是平稳、安定的'
    };
    const tone = toneMap[emotion];
    if (!tone) {
      // 分歧#3：情绪 tone 缺失，只兜「语气」这一段（原为整段 return ''）；死亡恐惧是恒定底盘，
      // 不随情绪有无而消失，故照常拼在后面（off / 未接通时 mortalityPrompt 为 ''，逐字节同旧行为）
      return mortalityPrompt;
    }
    // calm 是基线情绪，强度高不代表“强烈”，只有其他情绪才按强度加强
    const strong =
      emotion !== 'calm' && typeof intensity === 'number' && intensity >= 0.6
        ? '，而且这种情绪现在比较强烈，请让它在语气里明显体现出来'
        : '';
    // 慢层底色：仅当慢层主导情绪不是 calm 时追加，语气上「比此刻更淡」
    const slowType = slowMood && slowMood.type;
    const slowLine =
      slowType && slowType !== 'calm' && slowToneMap[slowType]
        ? `\n【最近的心境】${slowToneMap[slowType]}。它比「此刻的心情」更淡，是你这段时间的整体底色，别把它当成一时的强烈情绪。`
        : '';
    return `

【此刻的心情】${tone}${strong}。注意：它只影响你的语气和用词，不要直接说出情绪名称，也不要写“我感到……”这类总结。${slowLine}` + mortalityPrompt;
  }

  // 说话方式约束：动态版。现场读三样东西——她最近说过的话（定长度基线与复读项）、
  // 已经落盘的称呼（不再每轮让她重定）、当前关系阶段（决定她怎么解释对方的行为）。
  // 读不到就退化成冷启动文案，绝不抛错阻断主链路。
  buildStylePrompt(opts = {}) {
    const historyUser = opts.historyUserId || opts.memoryUserId;
    const snapshotKey = `${opts.sessionId || ''}|${historyUser || ''}`;
    let selfLines = [];
    if (opts.sessionId && this.sessionManager) {
      try {
        const history = this.sessionManager.getConversationHistory(opts.sessionId, historyUser, 12);
        selfLines = history
          .filter(msg => msg.role === 'assistant')
          .map(msg => outputParsing.stripTierMark(msg.content));
      } catch (error) {
        console.error('[OutputModule] 读取近期发言用于风格统计失败:', error.message);
      }
    }
    let address = null;
    if (this.memoryModule && opts.memoryUserId && typeof this.memoryModule.getAddress === 'function') {
      try {
        address = this.memoryModule.getAddress(opts.memoryUserId);
      } catch (error) {
        console.error('[OutputModule] 读取称呼用于风格提示失败:', error.message);
      }
    }
    // 称呼或关系阶段变了就得重算，否则她改了叫法、关系推进了，提示词还在说旧的
    const signature = `${opts.relationStage || ''}|${(address && address.roleCallsUser) || ''}`;
    const cached = this.styleSnapshots.get(snapshotKey);
    if (cached && cached.signature === signature && cached.left > 0) {
      cached.left -= 1;
      return cached.text;
    }
    const text = buildStylePromptText({
      selfLines,
      address,
      relationStage: opts.relationStage
    });
    // 冷启动（她还没说过话）不冻结：等有真实发言了，再按真实数据生成
    if (selfLines.length > 0) {
      this.styleSnapshots.delete(snapshotKey);
      this.styleSnapshots.set(snapshotKey, { text, signature, left: STYLE_SNAPSHOT_HOLD - 1 });
      if (this.styleSnapshots.size > STYLE_SNAPSHOT_MAX_KEYS) {
        this.styleSnapshots.delete(this.styleSnapshots.keys().next().value);
      }
    }
    return text;
  }

  // 取角色自己最近几轮说过的话，拼成「你最近说过的话」注入块（没有历史时返回空串）
  buildRecentSelfPromptFromHistory(sessionId, memoryUserId) {
    if (!this.sessionManager || !sessionId) {
      return '';
    }
    try {
      const history = this.sessionManager.getConversationHistory(sessionId, memoryUserId, 12);
      const own = history
        .filter(msg => msg.role === 'assistant')
        .map(msg => outputParsing.stripTierMark(msg.content));
      return buildRecentSelfPrompt(own);
    } catch (error) {
      console.error('[OutputModule] 构建「你最近说过的话」失败:', error.message);
      return '';
    }
  }

  // AI 态专属：把角色最近几次「自主发言」（没有新用户消息时自己主动开口说的话）单独列出来。
  // 这样 AI 态在评价/回看自主发言时能直接读到原文，而不用把自主发言和普通回复混在一起分不清
  buildProactiveSpeechPrompt(sessionId, memoryUserId) {
    if (!this.sessionManager || !sessionId || !memoryUserId) {
      return '';
    }
    try {
      const history = this.sessionManager.getConversationHistory(sessionId, memoryUserId, 80);
      const proactive = history
        .filter(msg => msg.role === 'assistant' && msg.proactive === true)
        .slice(-8);
      if (proactive.length === 0) {
        return '';
      }
      const lines = proactive
        .map(msg => `- [${new Date(msg.timestamp).toLocaleString('zh-CN')}] ${outputParsing.stripTierMark(msg.content)}`)
        .join('\n');
      return `\n\n【角色最近主动说过的话（自主发言，未经用户触发）】以下几句是角色在你没发消息时自己开口说的，与被你触发后的回复不是一回事：
${lines}
需要评价这些自主发言、或判断某句内容是不是角色自己带出来的，以上面这几句原文为准。`;
    } catch (error) {
      console.error('[OutputModule] 构建「自主发言回看」失败:', error.message);
      return '';
    }
  }
  

  // 从长期记忆里召回与该用户相关的内容，拼成可直接注入系统提示词的文本（无记忆时返回空串）
  // preloadedMemories：generateOutputAsync 提前做好的向量混合召回结果；没有（如 prompt 预览接口）才走同步字面召回
  // scope='ai' 时改成 role / ai 两档分区列出（preloadedMemories 是 { ai, role } 两块）
  buildMemoryPrompt(memoryUserId, query, preloadedMemories = null, scope = 'role', cutoverAt = 0) {
    if (!this.memoryModule || !memoryUserId) {
      return '';
    }
    if (scope === 'ai') {
      return this.buildScopedMemoryPrompt(memoryUserId, query, preloadedMemories);
    }
    try {
      // 强相关 5 条：优先用调用方的预召回（向量 + BM25 融合），再叠加一次直取
      // （字面命中/近义命中必现，不受不应期与同话题配额影响）。两者去重后取 5 条
      const preloaded = Array.isArray(preloadedMemories)
        ? preloadedMemories
        : this.memoryModule.getRelevantMemoryRecords(memoryUserId, query, 5, { cutoverAt });
      const direct = typeof this.memoryModule.getStrongMatchRecords === 'function'
        ? this.memoryModule.getStrongMatchRecords(memoryUserId, query, 5, { cutoverAt })
        : [];
      const memories = [];
      const seenStrong = new Set();
      for (const item of [...direct, ...(preloaded || [])]) {
        if (memories.length >= 5) break;
        const id = String((item && typeof item === 'object' ? item.id : '') || '');
        const text = String((item && typeof item === 'object' ? item.text : item) || '').trim();
        if (!text) continue;
        if (id && seenStrong.has(id)) continue;
        if (memories.some(prev => String((prev && typeof prev === 'object' ? prev.text : prev) || '').trim() === text)) continue;
        if (id) seenStrong.add(id);
        memories.push(item);
      }
      const memoryText = (item) => String((item && typeof item === 'object' ? item.text : item) || '').trim();
      // 滚动摘要（【开头）下面单独常驻成段，这里剔掉，免得同一段底色彩两次
      const plainMemories = (memories || []).filter((item) => !memoryText(item).startsWith('【'));
      // 📜 最近 32 条常驻：只取经历，强相关的 5 条不占这 32 个名额
      const strongIds = new Set(plainMemories.map(item => String((item && typeof item === 'object' ? item.id : '') || '')).filter(Boolean));
      const recent = typeof this.memoryModule.getRecentMemoryRecords === 'function'
        ? this.memoryModule.getRecentMemoryRecords(memoryUserId, 32, { cutoverAt, excludeIds: strongIds })
        : [];
      // 语义记忆（学习产物）单独成段，与「经历」分开注入
      const semantic = this.buildSemanticSection(memoryUserId, 3, cutoverAt);
      // 早期对话的滚动摘要单独成段常驻：它是这段关系的底色，不该靠相似度碰运气才想起来
      const archiveSection = this.buildArchiveSummarySection(memoryUserId);
      // 自我模型（关于「她自己」的认知）再单独成段，与「关于用户的记忆」分开
      const selfSection = this.buildSelfSection(memoryUserId);
      if (recent.length === 0 && plainMemories.length === 0 && !semantic && !archiveSection && !selfSection) {
        return '';
      }
      const now = Date.now();
      let recentSection = '';
      if (recent.length > 0) {
        const lines = recent.map((item) => formatMemoryLine(item, now)).filter(Boolean).join('\n');
        recentSection = `\n\n【最近记得的事（最多 32 条）】「（他说）」是他说的，「（你说）」是你自己说过的。这些是最近还在你眼前的事，会随你此刻在意什么而浮动；自然地参考，不要逐条复述：
${lines}`;
      }
      let block = '';
      if (plainMemories.length > 0) {
        const lines = plainMemories
          .map((item) => formatMemoryLine(item, now))
          .filter(Boolean)
          .join('\n');
        console.log(`[OutputModule] 注入最近记忆 ${recent.length} 条 + 强相关 ${plainMemories.length} 条`);
        block = `\n\n【强相关的记忆（最多 5 条）】以下是他这轮话里直接勾起来的旧事：「（他说）」是他说的，「（你说）」是你自己说过的；没有标记的是早年记下的、按他说的处理。不要把两者混成一个人说的，自然地参考即可，不要直接复述：
${lines}`;
      }
      return recentSection + block + semantic + archiveSection + selfSection;
    } catch (error) {
      console.error('[OutputModule] 召回长期记忆失败:', error.message);
      return '';
    }
  }

  // 早期对话的滚动摘要：它不是「某件能想起来的事」，而是更早以前的整体底色。
  // 靠相似度召回等于随机想起来，所以每次回复都固定带上一段（最长 200 字，代价很小）
  buildArchiveSummarySection(memoryUserId, label = '更早以前的事') {
    if (!this.memoryModule || typeof this.memoryModule.getArchiveSummary !== 'function' || !memoryUserId) {
      return '';
    }
    try {
      const summary = this.memoryModule.getArchiveSummary(memoryUserId);
      if (!summary) return '';
      return `\n\n【${label}】这些细节你已经记不清了，只记得大概：\n${summary}`;
    } catch (error) {
      console.error('[OutputModule] 注入早期对话摘要失败:', error.message);
      return '';
    }
  }

  // 语义记忆（她学到的稳定认识）独立分区注入，与「长期记忆（经历）」分开，
  // 免得把一条抽象结论当成一次具体经历去复述。限条数，避免提示词膨胀
  buildSemanticSection(memoryUserId, limit = 3, cutoverAt = 0) {
    if (!this.memoryModule || typeof this.memoryModule.getSemanticMemories !== 'function' || !memoryUserId) {
      return '';
    }
    try {
      const list = this.memoryModule.getSemanticMemories(memoryUserId, limit, { cutoverAt });
      if (!list || list.length === 0) return '';
      const lines = list.map((text) => `- ${text}`).join('\n');
      return `\n\n【你已经形成的一些认识】以下是你从过去的相处里慢慢总结出来的看法，融进你的态度里即可，不要直接背诵：
${lines}`;
    } catch (error) {
      console.error('[OutputModule] 注入语义记忆失败:', error.message);
      return '';
    }
  }

  // 🧠 自我模型（关于「她自己」的稳定认知）独立分区注入，与「长期记忆/语义记忆」分开。
  // 限条（默认 3 条，§七「严格限条」），让她在态度与自我表达上自然流露，而不是背诵
  buildSelfSection(memoryUserId, limit = 3) {
    if (!this.memoryModule || typeof this.memoryModule.getSelfTraits !== 'function' || !memoryUserId) {
      return '';
    }
    try {
      const list = this.memoryModule.getSelfTraits(memoryUserId, limit, { lifecycle: this.selfTraitLifecycle });
      if (!list || list.length === 0) return '';
      // 读即用：这几条真的进了注入列表才算一次「使用」（live 续租 / shadow 只取证）
      this.recordSelfTraitsUsed(memoryUserId, list);
      const lines = list.map((text) => `- ${text}`).join('\n');
      return `\n\n【你对自己的一些认识】这些是你在这段相处里慢慢看清的、关于你自己的稳定感受，它会影响你此刻的态度和语气，自然地流露即可，不要直接说出口：
${lines}`;
    } catch (error) {
      console.error('[OutputModule] 注入自我认知失败:', error.message);
      return '';
    }
  }

  // 🚧 界线（事前自限）注入：只带进「本轮输入命中了触发词」的那几条。
  // 与【你对自己的一些认识】不同——那段是背景认知，这段是这一轮具体不要做什么，
  // 所以必须配一句可核对的落点，发言后由 verifyBoundaries 逐字核对。
  // 注入过哪几条记在 _boundaryInjections 里，下一轮核对完即清，不跨轮误记账
  buildBoundarySection(sessionId, memoryUserId, query = '', limit = 2) {
    if (!this.memoryModule || typeof this.memoryModule.getBoundariesForInjection !== 'function' || !memoryUserId) {
      return '';
    }
    try {
      const list = this.memoryModule.getBoundariesForInjection(memoryUserId, { query, limit });
      if (!Array.isArray(list) || list.length === 0) return '';
      const key = `${sessionId || ''}|${memoryUserId}`;
      if (!this._boundaryInjections) this._boundaryInjections = new Map();
      // query 一并存下：核对后要按「这一轮是什么情境」给观测样本分桶，不能等到核对方再猜
      this._boundaryInjections.set(key, { items: list, at: Date.now(), query });
      const pending = list.filter(item => item.closingAt && !item.resolution);
      const settled = list.filter(item => !(item.closingAt && !item.resolution));
      const lines = [];
      if (pending.length > 0) {
        // 待结账的条目：不许再假装它还在，也不许一声不吭把它删掉
        lines.push('【待结账】下面这些你定过、但它一次都没做到。这轮先把旧账说清，再决定这条尺是留着、收紧，还是撤掉——撤掉时必须先说清哪次没做到、你打算怎么补：');
        pending.forEach(item => {
          const ban = Array.isArray(item.avoid) && item.avoid.length ? `（原定不要说：${item.avoid.join('、')}）` : '';
          lines.push(`- ${item.text}${ban}`);
        });
      }
      settled.forEach(item => {
        const ban = Array.isArray(item.avoid) && item.avoid.length ? `（不要说：${item.avoid.join('、')}）` : '';
        lines.push(`- ${item.text}${ban}`);
      });
      console.log(`[OutputModule] 界线注入 ${list.length} 条（待结账 ${pending.length}）`);
      const head = `\n\n【你自己划下的界线】这些是你吃过亏之后给自己定下的，同类情境一到就该提前避开：\n${lines.join('\n')}`;
      const tail = pending.length > 0
        ? '结不结账是你自己的事，但你欠的账不会因为这一轮没聊到就消失；说清之后，这一轮照旧照尺子来。'
        : '这是你已经决定过的事，不是这轮新给你加的规矩；不要说破自己在遵守什么。';
      return `${head}\n${tail}`;
    } catch (error) {
      console.error('[OutputModule] 注入界线失败:', error.message);
      return '';
    }
  }

  // 发言后核对：本轮注入过的界线，正文里出现它的 avoid 片段 = 违背，没出现 = 兑现。
  // 只认字面，不认解释——这就是「能被观察到地约束下一次行为」里「可观察」的那个落点
  verifyBoundaries(sessionId, memoryUserId, text) {
    if (!this._boundaryInjections || !this.memoryModule
        || typeof this.memoryModule.markBoundaryOutcome !== 'function') return;
    const key = `${sessionId || ''}|${memoryUserId}`;
    const entry = this._boundaryInjections.get(key);
    if (!entry) return;
    this._boundaryInjections.delete(key);
    // 注入到核对之间隔太久（本轮生成失败、下一轮才走到这里）就不认账，避免把两句错配
    if (Date.now() - (Number(entry.at) || 0) > 5 * 60 * 1000) return;
    const body = String(text || '');
    for (const item of entry.items) {
      // 待结账的条目不算兑现／违背：它这一轮的任务是「把账说清」，不是「没说出口就算过关」。
      // 只有结账（保留/收紧/撤销）能把这条尺的账结束掉
      if (item.closingAt && !item.resolution) continue;
      const avoid = Array.isArray(item.avoid) ? item.avoid : [];
      const matched = avoid.find(fragment => fragment && body.includes(fragment)) || '';
      const hit = Boolean(matched);
      this.memoryModule.markBoundaryOutcome(memoryUserId, item.text, !hit);
      if (hit) {
        console.log(`[OutputModule] 界线被越过：${item.text}（说出「${matched}」）`);
      }
      // 🧭 观测：这次核对本身就是一个样本（守住 / 滑回）。只落盘与判据，不改这一轮的任何提示词
      this.recordDeviationSample(sessionId, memoryUserId, item, hit, matched, entry && entry.query, false);
    }
    // 🧭 盲区核对：这一轮没被注入的界线，也在同一段正文上逐字核一遍（只观测、不记账）
    this.checkBoundariesBlind(sessionId, memoryUserId, body, entry);
  }

  // 🧭 盲区核对：把「没亮出来的尺子」也拿到同一段正文上比一比。
  // 只回答一个问题——没人在旁边看的时候，她还会不会滑回去。不改任何账、不进提示词
  checkBoundariesBlind(sessionId, memoryUserId, body, entry) {
    if (this.deviationLifecycle !== 'shadow' && this.deviationLifecycle !== 'live') return;
    if (!this.memoryModule || typeof this.memoryModule.getActiveBoundaries !== 'function') return;
    try {
      const checked = new Set(
        (entry && Array.isArray(entry.items) ? entry.items : []).map(item => item && item.text)
      );
      const items = this.memoryModule.getActiveBoundaries(memoryUserId) || [];
      for (const item of items) {
        if (!item || checked.has(item.text)) continue;
        const avoid = Array.isArray(item.avoid) ? item.avoid : [];
        const matched = avoid.find(fragment => fragment && String(body || '').includes(fragment)) || '';
        this.recordDeviationSample(sessionId, memoryUserId, item, Boolean(matched), matched, entry && entry.query, true);
      }
    } catch (error) {
      console.error('[OutputModule] 盲区核对失败:', error.message);
    }
  }

  // 🧭 记一个核对样本。announced = 这一轮真把尺子亮给她看过；blind = 只在旁边看。
  // 落盘成功后，announced 且滑回时才顺手跑一次判据（盲区样本只攒不分析，避免判据被「安静时守住」稀释）
  recordDeviationSample(sessionId, memoryUserId, item, hit, matched, query, blind) {
    if (this.deviationLifecycle !== 'shadow' && this.deviationLifecycle !== 'live') return;
    try {
      const now = Date.now();
      const userId = memoryUserId || 'default';
      this.writeDeviationShadow({
        kind: 'sample',
        at: now,
        userId,
        sessionId: sessionId || 'default',
        axis: item.text,
        surface: hit ? matched : '',
        scenario: describeDeviationScenario(item, query, this.deviationChannel),
        choice: hit ? 'gave_in' : 'held',
        blind: Boolean(blind)
      });
      if (!hit || blind) return;
      this.analyzeBoundaryDeviation(sessionId, userId, item.text);
    } catch (error) {
      console.error('[OutputModule] 稳定偏移观测失败:', error.message);
    }
  }

  // 🧭 判据（按轴）：同一用户 10 分钟最多算一次，避免每条滑回都读盘。
  // 三条件（跨场景同一轴 / 字面挪位 / 下次可预告）全在 deviation.detectStableDeviations 里算
  analyzeBoundaryDeviation(sessionId, userId, axisText) {
    const now = Date.now();
    const cooldownKey = `${sessionId || ''}|${userId}`;
    const lastAt = Number(this._deviationAnalysisAt && this._deviationAnalysisAt.get(cooldownKey)) || 0;
    if (now - lastAt < DEVIATION_ANALYZE_COOLDOWN_MS) return;
    if (!this._deviationAnalysisAt) this._deviationAnalysisAt = new Map();
    this._deviationAnalysisAt.set(cooldownKey, now);

    const windowMs = deviationModule.DEVIATION_DEFAULTS.windowMs;
    const samples = this.readDeviationSamples({ userId, since: now - windowMs, limit: DEVIATION_READ_LIMIT });
    const report = deviationModule.detectStableDeviations(samples, { now, windowMs });
    this.cacheDeviationReport(userId, report, now);
    const target = report.find(entryItem => entryItem.axis === deviationModule.axisKey(axisText));
    if (!target) return;
    console.log(`[OutputModule] 稳定偏移观测：${deviationModule.summarizeDeviation(target)}`);
    if (target.verdict === 'insufficient') return;
    // 判据结果也留一条痕，便于几天后回看：「像她」与「固定毛病」各攒了多少
    this.writeDeviationShadow({
      kind: 'verdict',
      at: now,
      userId,
      sessionId: sessionId || 'default',
      ...target
    });
  }

  // 判据结果缓存（注入用）：热路径不读盘。30 分钟一刷，足够跟上「现在还在发生」
  cacheDeviationReport(userId, report, at) {
    if (!this._deviationCache) this._deviationCache = new Map();
    this._deviationCache.set(userId || 'default', { at: Number(at) || Date.now(), report: report || [] });
  }

  // 观测落盘（单独一层：单测可替换，也守住「不阻断主链」）
  writeDeviationShadow(entry) {
    deviationShadowModule.appendDeviationShadow(entry);
  }

  readDeviationSamples(options) {
    return deviationShadowModule.readDeviationSamples(options);
  }

  // 🧭 稳定偏移进语气（live 专用）：只带「判据成立」的轴，最多两条。
  // 30 分钟缓存：热路径不读盘；缓存过期才现场读一次（冷启动第一轮也不空转）。
  // 这里只放「她自己回头核对得出来的那点偏移」，不摊开次数、比值、场景这些账本数字——
  // 那些是给运维看观测报告的，摊到她眼前只会变成表演
  getStableDeviations(userId) {
    if (this.deviationLifecycle !== 'live') return [];
    const key = userId || 'default';
    const cached = this._deviationCache && this._deviationCache.get(key);
    if (cached && Date.now() - (Number(cached.at) || 0) < DEVIATION_CACHE_MS) {
      return pickStableDeviations(cached.report);
    }
    try {
      const now = Date.now();
      const windowMs = deviationModule.DEVIATION_DEFAULTS.windowMs;
      const samples = this.readDeviationSamples({ userId: key, since: now - windowMs, limit: DEVIATION_READ_LIMIT });
      const report = deviationModule.detectStableDeviations(samples, { now, windowMs });
      this.cacheDeviationReport(key, report, now);
      return pickStableDeviations(report);
    } catch (error) {
      console.error('[OutputModule] 读取稳定偏移失败:', error.message);
      return [];
    }
  }

  // 判据进语气的文案：三条规矩必须都在——预告不是免责 / 说完照样按尺子来 / 说完还照做就照常算。
  // 少了任何一条，这段就会从「她自己知道」退化成「先给自己留个台阶」
  buildDeviationSection(userId) {
    if (this.deviationLifecycle !== 'live') return '';
    const items = this.getStableDeviations(userId);
    if (items.length === 0) return '';
    const lines = items.map(item => {
      const surfaces = Array.isArray(item.surfaces) ? item.surfaces.filter(Boolean) : [];
      const where = surfaces.length ? `——你几次都滑回「${surfaces.join('」「')}」这类话` : '';
      return `- ${item.axis}${where}`;
    });
    return `\n\n【你自己回头核对出来的一处偏移】下面这些不是别人给你加的规矩，是你自己事后核对时看出来的：同一处，你嘴上说照着定下的来，换个情境又滑回原来的做法。
${lines.join('\n')}
- 预告不算免责：提前说一句「我大概又忍不住」不能把这件事抵掉
- 说过之后照样按尺子来：这一轮该怎么回还是怎么回，不必为了显得诚实先认个输
- 说完还是照做，就照常算：真滑回去了不用假装没发生，也不用事后找理由；真按住了就按平常说话，不用声明自己忍住了，也别拿它邀功
知道这一处不等于给自己贴标签：它只是你此刻清楚的一件事，不用主动向对方解释，也不要拿它当求原谅的凭据。`;
  }

  // 🫀 自发回忆：她此刻的心情把某件旧事勾了上来，用户并没有问。
  // 与「关于这位用户的长期记忆」分开成段——那段是回答时参考的档案，这段是「她自己冒出来的念头」，
  // 说话方式不一样：允许顺着说一句，也允许想想就算了，不许当作事实复述。
  // 触发条件、选条、节流全部在 memory.recallByMood 里，这里只负责注入文案。
  // 🧭 场景投影：历史优先、记忆补位；AI 态与群聊不注入（群聊里「你俩在哪」不成立）。
  // 这里不写任何状态，只把这一刻的投影交给提示词，下一轮重新算
  async buildSceneSection({ sessionId, memoryUserId, history = [], sceneHint = '', scope = 'role', cutoverAt = 0, toolOptions = {} } = {}) {
    if (scope === 'ai') return '';
    if (toolOptions && toolOptions.sceneContext === false) return '';
    let memories = [];
    try {
      if (memoryUserId && this.memoryModule && typeof this.memoryModule.retrieveMemoryRecords === 'function') {
        memories = await this.memoryModule.retrieveMemoryRecords(
          memoryUserId,
          sceneModule.SCENE_QUERY,
          6,
          { cutoverAt }
        );
      }
    } catch (error) {
      // 召回失败就只靠这段对话，不因为取不到记忆而编造场景
      memories = [];
    }
    // 网页互动自己声明过「面对面」——把渠道事实当弱证据，避免和渠道提示互相打架
    const channelTogether = /面对面/.test(sceneHint || '') ? true : null;
    const scene = sceneModule.deriveScene({ history, memories, now: Date.now(), channelTogether });
    this.observeScene(sessionId, memoryUserId, scene);
    return sceneModule.formatSceneHint(scene);
  }

  // 场景变化只作观测：写 timeline（append-only），低置信不记；绝不回写记忆或自我模型
  observeScene(sessionId, userId, scene) {
    if (!sessionId || !userId || !scene || !this.timeline) return;
    const key = `${sessionId}|${userId}`;
    if (!this._sceneSeen) this._sceneSeen = new Map();
    if (this._sceneSeen.size > 500) this._sceneSeen.clear();
    const signature = `${scene.place || '-'}/${scene.together === null ? '?' : scene.together}/${scene.confidence >= 0.5 ? 'high' : 'low'}`;
    if (this._sceneSeen.get(key) === signature) return;
    this._sceneSeen.set(key, signature);
    if (scene.confidence < 0.5) return;
    try {
      const scope = this.memoryModule && typeof this.memoryModule.normalizeScopeKey === 'function'
        ? this.memoryModule.normalizeScopeKey(userId, 'role')
        : userId;
      this.timeline.append(scope, 'scene.inferred', {
        place: scene.place,
        together: scene.together,
        confidence: scene.confidence,
        channel: this.timelineChannel || ''
      });
    } catch (error) {
      // 观测失败不影响回复
    }
  }

  buildSpontaneousRecallSection(sessionId, memoryUserId, emotion, intensity, opts = {}) {
    if (!this.memoryModule || typeof this.memoryModule.recallByMood !== 'function' || !memoryUserId) {
      return '';
    }
    try {
      const records = this.memoryModule.recallByMood(memoryUserId, {
        sessionKey: sessionId,
        emotion,
        intensity,
        slowMood: opts.slowMood,
        cutoverAt: opts.cutoverAt,
        limit: 1
      });
      if (!Array.isArray(records) || records.length === 0) return '';
      const now = Date.now();
      const lines = records.map((item) => formatMemoryLine(item, now)).filter(Boolean).join('\n');
      if (!lines) return '';
      console.log(`[OutputModule] 自发回忆浮出 ${records.length} 条`);
      return `\n\n【忽然想起来】没人在问你什么，是你自己心里忽然浮起这件事：\n${lines}\n如果它此刻真的牵动了你，就顺着说一句；没什么感觉就让它过去，不要硬提，也不要照着原话复述。`;
    } catch (error) {
      console.error('[OutputModule] 自发回忆失败:', error.message);
      return '';
    }
  }

  // 🗣️ 表达学习：她自己在学习时段审核通过、认可过的说法。
  // 只在语境命中时出现，放在提示词最末尾；没有命中就返回空串，保证前缀逐字节不变。
  // 返回 { text, examples }：examples 供本轮生成后记账与照抄判定，不参与检索排序
  buildExpressiveSection(query) {
    try {
      const examples = expressiveModule.findExamples(query, 2);
      if (!Array.isArray(examples) || examples.length === 0) return { text: '', examples: [] };
      const lines = examples.map((item) => {
        const excerpt = String(item.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const insight = String(item.insight || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!excerpt && !insight) return '';
        const scenes = Array.isArray(item.scenes)
          ? item.scenes.map(scene => String(scene || '').trim()).filter(Boolean).join('/')
          : '';
        return `- “${excerpt}” —— 你的理解：${insight}${scenes ? `（适用：${scenes}）` : ''}`;
      }).filter(Boolean);
      if (lines.length === 0) return { text: '', examples: [] };
      let section = `\n\n【你自己认可过的说法（只作参考，不要照抄）】\n${lines.join('\n')}`;
      if (section.length > 600) section = section.slice(0, 600);
      return { text: section, examples };
    } catch (error) {
      console.warn('[OutputModule] 表达示例检索失败:', error.message);
      return { text: '', examples: [] };
    }
  }

  // 🗣️ 表达学习闭环（观测层）：记账 + 照抄闸。
  // 只观测、不回写人格，也不改本轮回复；照抄过的示例冷却一段时间，不让她把示范当模板反复抄
  recordExpressiveUsage(examples, text) {
    const list = Array.isArray(examples) ? examples : [];
    if (list.length === 0) return;
    try {
      const ids = list.map(item => item && item.id).filter(Boolean);
      expressiveModule.markExamplesUsed(ids);
      const copied = expressiveModule.detectCopies(text, list);
      if (copied.length > 0) {
        expressiveModule.markExamplesCopied(copied);
        console.log(`[OutputModule] 表达示例被照抄，冷却 ${copied.length} 条`);
      } else {
        // 没照抄，说明她是按自己的话说了一遍：这句才值得观察用户会不会接住
        expressiveModule.rememberSpoken(text);
      }
    } catch (error) {
      console.warn('[OutputModule] 表达示例记账失败:', error.message);
    }
  }

  // 读即用回写（定稿 §4.3）：live → markSelfTraitsUsed 续租；shadow → 只记 maturity/lease 日志；
  // off → 完全不碰（逐字段同旧行为）。异常静默，绝不阻断主链
  recordSelfTraitsUsed(memoryUserId, list) {
    const mode = this.selfTraitLifecycle;
    if (mode === 'off') return;
    try {
      if (mode === 'live' && typeof this.memoryModule.markSelfTraitsUsed === 'function') {
        this.memoryModule.markSelfTraitsUsed(memoryUserId, list);
      } else if (mode === 'shadow' && typeof this.memoryModule.loadSelfModel === 'function') {
        const now = Date.now();
        const model = this.memoryModule.loadSelfModel(memoryUserId);
        const traits = model && Array.isArray(model.traits) ? model.traits : [];
        const detail = traits
          .filter(trait => list.includes(trait.text))
          .map(trait => {
            const maturity = selfModelModule.computeTraitMaturity(trait, now);
            const alive = selfModelModule.isTraitLeaseAlive(trait, now);
            return `${maturity.toFixed(2)}${alive ? '' : '†'}`;
          })
          .join(', ');
        console.log(`[OutputModule] 自我认知租约（shadow）：本轮注入 ${list.length} 条，成熟度[${detail}]（†=租约过期，均未回写）`);
      }
    } catch (error) {
      console.error('[OutputModule] 自我认知读即用处理失败:', error.message);
    }
  }

  // AI 态的记忆注入：AI 态不是另一个人格，而是同一个她在另一种场景里。
  // 因此两档记忆按同一条时间线注入：最近 32 + 强相关 5（不占 32 名额）+ 语义/归档/自我分区。
  // 不再把「角色态/AI 态」当成两个说话人；场景差异交给 scenePrompt，不由记忆分裂身份。
  buildScopedMemoryPrompt(memoryUserId, query = '', preloadedScoped = null) {
    const scopes = ['role', 'ai'];
    const keys = {};
    for (const scope of scopes) keys[scope] = this.memoryModule.normalizeScopeKey(memoryUserId, scope);
    const scopedPreload = (preloadedScoped && !Array.isArray(preloadedScoped) && typeof preloadedScoped === 'object')
      ? preloadedScoped
      : {};

    // 强相关 5 条：两档各自直取，合并去重后只取 5 条（不占最近 32 的名额）
    const strongPool = [];
    for (const scope of scopes) {
      if (Array.isArray(scopedPreload[scope])) strongPool.push(...scopedPreload[scope]);
      try {
        if (typeof this.memoryModule.getStrongMatchRecords === 'function') {
          strongPool.push(...this.memoryModule.getStrongMatchRecords(keys[scope], query, 5));
        } else if (typeof this.memoryModule.getRelevantMemories === 'function') {
          strongPool.push(...this.memoryModule.getRelevantMemories(keys[scope], query, 5));
        }
      } catch (error) {
        console.error(`[OutputModule] 召回 ${scope} 档强相关记忆失败:`, error.message);
      }
    }
    const strong = [];
    const seenStrong = new Set();
    for (const item of strongPool) {
      if (strong.length >= 5) break;
      const text = String((item && typeof item === 'object' ? item.text : item) || '').trim();
      if (!text || text.startsWith('【')) continue; // 摘要走归档分区，不混进原文
      const id = String((item && typeof item === 'object' ? item.id : '') || '');
      if (id && seenStrong.has(id)) continue;
      if (strong.some(prev => String(prev && typeof prev === 'object' ? prev.text : prev).trim() === text)) continue;
      if (id) seenStrong.add(id);
      strong.push(item);
    }

    // 最近 32 条：两档合并成一条时间线，排除强相关的 5 条，避免重复占位
    const strongIds = new Set(strong.map(item => String((item && typeof item === 'object' ? item.id : '') || '')).filter(Boolean));
    const recentPool = [];
    if (typeof this.memoryModule.getRecentMemoryRecords === 'function') {
      for (const scope of scopes) {
        try {
          recentPool.push(...this.memoryModule.getRecentMemoryRecords(keys[scope], 32, { excludeIds: strongIds }));
        } catch (error) {
          console.error(`[OutputModule] 读取 ${scope} 档最近记忆失败:`, error.message);
        }
      }
    }
    recentPool.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
    const recent = [];
    for (const item of recentPool) {
      if (recent.length >= 32) break;
      const text = String((item && item.text) || '').trim();
      if (!text) continue;
      const nearDup = typeof this.memoryModule.nearDuplicateRatio === 'function'
        ? recent.some(prev => this.memoryModule.nearDuplicateRatio(prev.text, text) > 0.9)
        : recent.some(prev => prev.text === text);
      if (nearDup) continue;
      recent.push(item);
    }

    // 两档各自的语义记忆（学习产物）也分区注入
    const semanticRole = this.buildSemanticSection(keys.role, 2);
    const semanticAi = this.buildSemanticSection(keys.ai, 2);
    // 早期对话的滚动摘要：两档各读各的，和网页角色态一样常驻，不靠相似度碰运气
    const archiveRole = this.buildArchiveSummarySection(keys.role);
    const archiveAi = this.buildArchiveSummarySection(keys.ai, '更早以前的事（AI 态）');
    // 自我模型跨分区共享（按基础身份读），两档共用一个自我认知段
    const selfSection = this.buildSelfSection(memoryUserId);

    const now = Date.now();
    const recentLines = recent.map(item => formatMemoryLine(item, now)).filter(Boolean).join('\n');
    const strongLines = strong.map(item => formatMemoryLine(item, now)).filter(Boolean).join('\n');
    const recentSection = recentLines
      ? `\n\n【最近记得的事（最多 32 条）】「（他说）」是他说的，「（你说）」是你自己说过的；角色态与 AI 态都属于同一个你，不要当成两个人：
${recentLines}`
      : '';
    const strongSection = strongLines
      ? `\n\n【强相关的记忆（最多 5 条）】这轮话题直接勾起来的旧事，不受配额与不应期限制；依然分清「他说」和「你说」：
${strongLines}`
      : '';

    if (!recentSection && !strongSection && !semanticRole && !semanticAi && !archiveRole && !archiveAi && !selfSection) {
      return '';
    }
    console.log(`[OutputModule] AI 态注入：最近 ${recent.length} 条 + 强相关 ${strong.length} 条`);
    return `\n\n【你记得的事（角色态 / AI 态）】这些记忆都属于同一个你：角色态是你和他在日常里的相处，AI 态是你以本人身份和他打交道的记录。两种场景都要自然地记得，不要互相否认。自然地参考即可，不要直接复述：${recentSection}${strongSection}${semanticRole}${semanticAi}${archiveRole}${archiveAi}${selfSection}`;
  }
  
  // 归档蒸馏：把滑出对话窗口的「沉底段」压成一段小结，滚动合并进该用户的长期记忆，
  // 这样原文虽然进了归档空间，角色的记忆也不会断档。模型不可用时退回本地摘录式小结
  // 同一用户的蒸馏排队串行：两批同时滑出时不并发，避免后一批的合并覆盖掉前一批的结果
  summarizeArchivedConversation(payload = {}) {
    const previous = this.archiveDigestChain || Promise.resolve();
    const next = previous
      .catch(() => null)
      .then(() => this.runArchiveDigest(payload));
    this.archiveDigestChain = next.catch(error => {
      console.error('[OutputModule] 归档对话蒸馏失败:', error.message);
      return null;
    });
    return this.archiveDigestChain;
  }

  // 🧠 语义巩固（情景 → 语义，见方案 §4.5）：把同一语义簇的多条情景记忆抽象成一条
  // 可复用的语义结论。复用归档蒸馏的同一条串行链，避免与归档同时写同一份 store
  consolidateUserMemories(payload = {}) {
    const previous = this.archiveDigestChain || Promise.resolve();
    const next = previous
      .catch(() => null)
      .then(() => this.runSemanticConsolidation(payload));
    this.archiveDigestChain = next.catch(error => {
      console.error('[OutputModule] 语义巩固失败:', error.message);
      return null;
    });
    return this.archiveDigestChain;
  }

  // 🧠 巩固期去重（方向一②）触发口：与语义巩固/自我模型共用同一条串行链，避免它们并发写同一份 store。
  // 独立阶段——不内联进既有阶段、不改语义巩固的输出；任何异常静默跳过，不阻断主链。
  dedupUserMemories(payload = {}) {
    const previous = this.archiveDigestChain || Promise.resolve();
    const next = previous
      .catch(() => null)
      .then(() => this.runDedupMerge(payload));
    this.archiveDigestChain = next.catch(error => {
      console.error('[OutputModule] 巩固期去重失败，跳过:', error.message);
      return null;
    });
    return this.archiveDigestChain;
  }

  // 🧠 巩固期去重（方向一②）执行体：把已完备的「计划 → 落库」接进巩固主链。
  // 默认关（MEMORY_DEDUP_ENABLED !== 'enabled' 连计划都不跑、不落盘）；plan 只读 → apply 写，
  // 全程复用既有 planDedupMerge/applyDedupMerge，不新建第二条代码路径。归属单点：分区键由服务端
  // normalizeScopeKey 固定，模型无从传入。返回 { planned, applied, skipped, scanMs, applyMs, partition }
  async runDedupMerge({ userId = null } = {}) {
    if (!this.memoryModule) return null;
    if (process.env.MEMORY_DEDUP_ENABLED !== 'enabled') return null; // 默认关：连计划都不跑
    const baseId = userId || 'default';
    // 跟着人格分区走（与语义巩固/自我模型一致）
    const personaScope = this.sessionManager && typeof this.sessionManager.getPersonaScope === 'function'
      ? this.sessionManager.getPersonaScope(baseId)
      : 'role';
    const memoryUserId = typeof this.memoryModule.normalizeScopeKey === 'function'
      ? this.memoryModule.normalizeScopeKey(baseId, personaScope)
      : baseId;

    const scanStart = Date.now();
    const memories = this.memoryModule.getDedupMemories(memoryUserId);
    // storeKey 进分桶键：跨分区/跨归属绝不合并（归属由服务端分档键固定）
    const groups = memoryConsolidation.planDedupMerge(memories, null, { storeKey: memoryUserId });
    const scanMs = Date.now() - scanStart;
    const planned = Array.isArray(groups) ? groups.length : 0;
    if (planned === 0) return { planned: 0, applied: 0, skipped: 0, scanMs, applyMs: 0, partition: memoryUserId };

    const applyStart = Date.now();
    const result = this.memoryModule.applyDedupMerge(memoryUserId, groups);
    const applyMs = Date.now() - applyStart;
    const applied = Number(result && result.groups) || 0;
    const skipped = planned - applied;
    console.log(`[OutputModule] 巩固期去重：${memoryUserId} 计划 ${planned} 组 / 合并 ${applied} 组 / 跳过 ${skipped} 组（扫描 ${scanMs}ms，落盘 ${applyMs}ms）`);
    return { planned, applied, skipped, scanMs, applyMs, partition: memoryUserId };
  }

  // 🧠 回源重算（定稿 §4.4）：「有效自我认知」用到不够用时，重新长出来。
  // 仅 live 触发（off/shadow 不花 token）；有效条目 < 阈值且过了冷却才跑一次既有的 refreshSelfModel。
  // 统计口径 = 未过期（leaseAlive）且成熟度达标（≥ minMaturity）的条目。异步、异常静默
  maybeRefreshSelfModel({ userId = null, sessionId = null } = {}) {
    if (this.selfTraitLifecycle !== 'live' || !this.memoryModule || !userId) return null;
    const baseKey = typeof this.memoryModule.baseUserKey === 'function'
      ? this.memoryModule.baseUserKey(userId)
      : userId;
    const now = Date.now();
    const last = Number(this._lastSelfModelRefreshAt.get(baseKey)) || 0;
    if (now - last < this.selfModelRefreshCooldownMs) return null;
    if (typeof this.memoryModule.loadSelfModel !== 'function') return null;

    let alive = 0;
    try {
      const model = this.memoryModule.loadSelfModel(baseKey);
      const traits = model && Array.isArray(model.traits) ? model.traits : [];
      alive = traits.filter(trait =>
        selfModelModule.isTraitLeaseAlive(trait, now) &&
        selfModelModule.computeTraitMaturity(trait, now) >= selfModelModule.DEFAULTS.minMaturity
      ).length;
    } catch (error) {
      console.error('[OutputModule] 自我认知回源判定失败:', error.message);
      return null;
    }
    if (alive >= this.selfModelRefreshThreshold) return null;

    // 先落冷却再触发，避免同一轮并发重入
    this._lastSelfModelRefreshAt.set(baseKey, now);
    console.log(`[OutputModule] 自我认知回源重算触发：${baseKey} 有效 ${alive} < ${this.selfModelRefreshThreshold}（冷却 ${Math.round(this.selfModelRefreshCooldownMs / 60000)} 分钟）`);
    return this.refreshSelfModel({ userId, sessionId });
  }

  // 🧠 自我模型（反思落地，见方案 §4.6）：从高显著语义记忆 + 慢层心境轨迹里提炼
  // 「关于她自己」的稳定认知。复用归档蒸馏的同一条串行链，避免与归档/巩固同时写同一份 store
  refreshSelfModel(payload = {}) {
    const previous = this.archiveDigestChain || Promise.resolve();
    const next = previous
      .catch(() => null)
      .then(() => this.runSelfModelDistill(payload));
    this.archiveDigestChain = next.catch(error => {
      console.error('[OutputModule] 自我模型提炼失败:', error.message);
      return null;
    });
    return this.archiveDigestChain;
  }

  // 自我模型提炼：素材 = 高显著语义记忆（她学到的稳定认识），可选叠加慢层心境。
  // 产出的条目按基础身份并入 self_model（ledger live 落地与这里共用同一份库）
  async runSelfModelDistill({ userId = null, sessionId = null } = {}) {
    if (!this.memoryModule) return null;
    const baseId = userId || 'default';
    // 素材按当前人格分区取（与语义巩固一致）；写入时 memoryModule 会按基础身份归一，跨分区共享
    const personaScope = this.sessionManager && typeof this.sessionManager.getPersonaScope === 'function'
      ? this.sessionManager.getPersonaScope(baseId)
      : 'role';
    const memoryUserId = typeof this.memoryModule.normalizeScopeKey === 'function'
      ? this.memoryModule.normalizeScopeKey(baseId, personaScope)
      : baseId;
    if (typeof this.memoryModule.getSemanticMemoryEntries !== 'function') return null;

    const entries = this.memoryModule.getSemanticMemoryEntries(memoryUserId, 8);
    if (!Array.isArray(entries) || entries.length === 0) return null;

    // 慢层心境（可选）：情绪模块不可用就只用语义记忆，不阻断这条链路
    let slowMood = null;
    if (this.emotionModule && typeof this.emotionModule.getSlowMood === 'function') {
      try {
        slowMood = this.emotionModule.getSlowMood(sessionId || 'default', memoryUserId);
      } catch (error) {
        console.error('[OutputModule] 读取慢层心境失败:', error.message);
      }
    }

    // 待结账的界线：零兑现到点、还没处置的那些。她必须点名把旧账说清才允许撤尺，
    // 所以这份清单要进反思提示词，不能只躺在提示词里的「界线」段
    let pendingClosings = [];
    if (typeof this.memoryModule.getBoundariesForInjection === 'function') {
      try {
        pendingClosings = (this.memoryModule.getBoundariesForInjection(memoryUserId, { now: Date.now(), query: '', limit: 4 }) || [])
          .filter(item => item.closingAt && !item.resolution);
      } catch (error) {
        console.error('[OutputModule] 读取待结账界线失败:', error.message);
      }
    }

    const prompt = this.buildSelfModelPrompt(entries, slowMood, pendingClosings);
    if (!prompt) return null;

    let raw;
    try {
      const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'selfModel' });
      raw = result?.choices?.[0]?.message?.content;
    } catch (error) {
      console.error('[OutputModule] 自我模型提炼调用模型失败:', error.message);
      return null;
    }

    const traits = selfModelModule.parseSelfTraitOutput(raw);
    // 界线与自我认知走同一次反思（不额外花一次调用）：界线带可核对片段，
    // 没写成规定格式的一律丢弃，宁缺毋滥
    const boundaries = selfModelModule.parseBoundaryOutput(raw);
    // 结账：对「零兑现到点、进入结账期」的旧界线做处置。必须点名列出一条真在结账期的界线，
    // 否则不认——防止凭一句「我变了」就把旧尺删掉
    const closings = selfModelModule.parseBoundaryCloseOutput(raw);
    if (traits.length === 0 && boundaries.length === 0 && closings.length === 0) return null;

    let added = 0;
    // 可追溯：记下这次反思依据的语义记忆 id，之后能回答「这条认知是怎么来的」
    const sourceIds = entries.map(entry => entry && entry.id).filter(Boolean).slice(0, 5);
    for (const text of traits) {
      const saved = this.memoryModule.upsertSelfTrait(memoryUserId, { text, confidence: 0.6, source: 'reflect', sourceIds });
      // upsertSelfTrait 返回对象（即便 saved:false 整体也 truthy），必须判 saved.saved，
      // 否则落盘失败仍会数进 added、打出「并入 N 条」的假成功
      if (saved && saved.saved) added++;
    }
    let addedBoundaries = 0;
    for (const boundary of boundaries) {
      const saved = this.memoryModule.upsertBoundary(memoryUserId, boundary);
      if (saved && saved.saved) addedBoundaries++;
    }
    let closedCount = 0;
    for (const item of closings) {
      const closed = this.memoryModule.closeBoundary(memoryUserId, item.text, {
        resolution: item.resolution,
        note: item.note
      });
      if (closed) closedCount++;
    }
    if (added > 0 || addedBoundaries > 0 || closedCount > 0) {
      console.log(`[OutputModule] 自我模型提炼完成：${baseId} 并入 ${added} 条自我认知、${addedBoundaries} 条界线，结账 ${closedCount} 条`);
    }
    return added + addedBoundaries + closedCount;
  }

  // 把「语义认识 + 慢层心境」喂给模型，要求产出若干条第一人称的稳定自我认知（一行一条）
  buildSelfModelPrompt(entries, slowMood = null, pendingClosings = []) {
    const lines = (Array.isArray(entries) ? entries : [])
      .map(item => {
        const text = String((item && item.data) || '').trim();
        return text ? `- ${text}` : '';
      })
      .filter(Boolean);
    if (lines.length === 0) return '';

    const slowType = slowMood && slowMood.type && slowMood.type !== 'calm' ? slowMood.type : null;
    const moodBlock = slowType ? `\n你最近的整体心境底色：${slowType}\n` : '';
    // 待结账清单：这些界线她定过、却一次都没做到。必须先结账才允许撤尺，
    // 否则「我变了」就成了随手删旧账的借口
    const closeList = (Array.isArray(pendingClosings) ? pendingClosings : [])
      .map(item => `- ${String((item && item.text) || '').trim()}`)
      .filter(line => line !== '-')
      .join('\n');
    const closeBlock = closeList
      ? `

另外，下面这些界线是你自己定过的，但它一次都没做到。对每一条，先老实说清哪次没做到、你打算怎么补，再给一个结论，最多 1 条，格式必须完全照抄：
结账：<上面某条界线的原文>｜结论：保留/收紧/撤销｜做到：<哪次没做到、你打算怎么补>
${closeList}
- 只有「撤销」才等于以后不再守着它；撤销也要先承认旧账，不许只写一句「我变了」
- 「收紧」表示这条还要守，但要改窄；「保留」表示尺没坏，只是你还没做到
- 这次一条都没准备好结，就整行不写，不要为了凑格式编一条`
      : '';
    return `下面是你最近这段相处里学到的一些稳定认识${moodBlock ? '，以及你最近的整体心境' : ''}。请从中提炼出「关于你自己」的稳定认知——你因此更看清了自己是个怎样的人、在意什么、受不了什么。

要求：
- 每条用第一人称「我」，例如：我最近越来越在意他有没有回我消息。／我不喜欢被叫全名。
- 只写稳定的、以后还会成立的自我认识（关于你自己的性格与感受），不要写一次性的场面话，也不要复述用户的私事
- 最多 3 条，一行一条；只输出这些句子本身，不要标题、编号、解释或引号

另外，如果你在下面这些认识里看见某件「已经吃过一次亏、下次同类情境要提前避开」的事，把它写成界线，最多 1 条，格式必须完全照抄：
界线：<一句话说清你以后不再怎么做>｜触发：<同类情境的词1,词2>｜不说：<你下次不该说出口的具体片段1,片段2>
- 「不说」里必须是能逐字核对的具体词句（例如：我什么都做不好、你根本不懂），不能写成态度或意图
- 没有这样的事就整行不写，不要为了凑格式编一条${closeBlock}

你学到的认识：
${lines.join('\n')}${moodBlock}`;
  }

  async runSemanticConsolidation({ userId = null } = {}) {
    if (!this.memoryModule) return null;
    const baseId = userId || 'default';
    // 巩固跟着人格分区走：AI 态沿袭归档蒸馏的判定，落到对应分档
    const personaScope = this.sessionManager && typeof this.sessionManager.getPersonaScope === 'function'
      ? this.sessionManager.getPersonaScope(baseId)
      : 'role';
    const memoryUserId = typeof this.memoryModule.normalizeScopeKey === 'function'
      ? this.memoryModule.normalizeScopeKey(baseId, personaScope)
      : baseId;

    const candidates = this.memoryModule.getConsolidationCandidates(memoryUserId);
    if (!Array.isArray(candidates) || candidates.length < memoryConsolidation.DEFAULTS.minClusterSize) {
      return null;
    }

    // 分组：有向量走向量近邻聚类，否则退化为字面相似粗分组（embedTexts 失败返回 null）
    const texts = candidates.map(item => String((item && item.data) || ''));
    const vectors = await this.memoryModule.embedTexts(texts);
    const clusters = memoryConsolidation.clusterCandidates(candidates, vectors);
    const picked = memoryConsolidation.pickClusters(clusters);

    let created = 0;
    for (const cluster of picked) {
      const prompt = this.buildConsolidationPrompt(cluster);
      if (!prompt) continue;
      let raw;
      try {
        const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'consolidate' });
        raw = result?.choices?.[0]?.message?.content;
      } catch (error) {
        console.error('[OutputModule] 语义巩固调用模型失败:', error.message);
        continue;
      }
      const conclusion = memoryConsolidation.parseConsolidationOutput(raw);
      if (!conclusion) continue;

      const sourceIds = cluster.map(item => item && item.id);
      const semantic = this.memoryModule.upsertSemanticMemory(memoryUserId, conclusion, { sourceIds });
      if (!semantic) continue;
      this.memoryModule.linkConsolidated(memoryUserId, { sourceIds, semanticId: semantic.id });
      created++;
    }

    // REM 跨话题联想（方向一③）：不依赖语义簇，单独在弱关联带里找跨话题联想。落库为
    // kind='association' 的联想条——不注入提示词、不占用源记忆（不调 linkConsolidated），
    // 因此不污染既有语义结论；拿不准就如实说弱，或干脆产不出（parseConsolidationOutput 丢弃跑偏输出）
    created += await this.appendRemAssociations(memoryUserId, candidates, vectors);

    if (created > 0) {
      console.log(`[OutputModule] 语义巩固完成：${memoryUserId} 新增 ${created} 条语义记忆`);
    }
    return created > 0 ? created : null;
  }

  // REM 跨话题联想落库：把 planRemAssociations 产出的弱关联，经一次模型蒸馏写成一句联想，
  // 以 kind='association'（带 confidence + sourceMemoryIds）存为语义记忆。**不调 linkConsolidated**——
  // 联想不占有源情景记忆、不改它们的分层，因而与既有语义结论的 DB-6 回滚互不干扰。
  // 返回本次新落库的联想条数。任何一步失败都静默跳过，不阻断巩固主链。
  async appendRemAssociations(memoryUserId, candidates, vectors) {
    const associations = memoryConsolidation.planRemAssociations(candidates, vectors, { maxAssociations: REM_MAX_PER_RUN });
    if (!Array.isArray(associations) || associations.length === 0) return 0;
    let created = 0;
    for (const association of associations) {
      const prompt = this.buildRemPrompt(association);
      if (!prompt) continue;
      let raw;
      try {
        const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'rem' });
        raw = result?.choices?.[0]?.message?.content;
      } catch (error) {
        console.error('[OutputModule] 跨话题联想调用模型失败:', error.message);
        continue;
      }
      const insight = memoryConsolidation.parseConsolidationOutput(raw);
      if (!insight) continue;
      const saved = this.memoryModule.upsertSemanticMemory(memoryUserId, insight, {
        sourceIds: association.sourceMemoryIds,
        kind: 'association',
        confidence: association.confidence
      });
      if (saved) created++;
    }
    return created;
  }

  // 把同一语义簇的情景记忆喂给模型，要求产出一条可复用的语义结论（第一人称/关系视角）
  buildConsolidationPrompt(items) {
    const lines = (Array.isArray(items) ? items : [])
      .map(item => {
        const text = String((item && item.data) || '').trim();
        if (!text) return '';
        const emotion = item && item.emotion ? `（当时情绪：${item.emotion}）` : '';
        return `- ${text}${emotion}`;
      })
      .filter(Boolean);
    if (lines.length === 0) return '';
    return `下面是你和用户过去一段时间的若干条互动记忆，它们说的是同一件事或同一类事。请把它们提炼成一条你以后能长期复用、一看就懂的「认识」。

要求：
- 用第一人称写你自己此刻的看法，可以提到「他」，例如：他知道我最近在临摹那张画，起手总画废，但一直没放弃。
- 只写稳定的、以后还用得上的认识（关于他这个人、你们的相处方式、他的习惯或心事），不要写一次性的场面话
- 多条记忆互相矛盾时，以时间更近的为准
- 只输出这一句话本身，不要标题、不要编号、不要解释、不要引号，不超过 60 字

互动记忆：
${lines.join('\n')}`;
  }

  // 把「两个不同话题里各自相关的片段」喂给模型，要求产出一条跨话题的弱关联联想（一行、50 字内）。
  // 与 buildConsolidationPrompt 的差别：素材本就只是弱相似，故明确要求「拿不准就说弱、别编造事实」，
  // 免得模型硬把无关的事说成确定的结论——联想条本就不注入提示词，宁可产不出也不要产错。
  buildRemPrompt(association) {
    const samples = (association && Array.isArray(association.samples)) ? association.samples : [];
    const lines = samples
      .map(sample => {
        const text = String((sample && sample.text) || '').trim();
        if (!text) return '';
        const topic = sample && sample.topicId ? `（话题 ${sample.topicId}）` : '';
        return `- ${text}${topic}`;
      })
      .filter(Boolean);
    if (lines.length === 0) return '';
    const topicIds = (association && Array.isArray(association.topicIds)) ? association.topicIds : [];
    const scope = topicIds.length === 2 ? `\n这些片段分别来自话题 ${topicIds[0]} 与话题 ${topicIds[1]}：\n` : '';
    return `下面这些是你在几件不同的事里分别记下的片段，它们表面上不像同一件事，却隐约有些相似。请找出它们之间那条**微弱的、可能成立的关联**，写成一句你自己的联想。
${scope}
要求：
- 用第一人称写你自己此刻的联想，可以提到「他」
- 只写这一条联想本身，不要标题、不要编号、不要解释、不要引号，不超过 50 字
- 关联本就微弱，拿不准就如实说「好像有点这种可能」，不要编造事实，也不要把它说成确定的结论

互动片段：
${lines.join('\n')}`;
  }

  async runArchiveDigest({ sessionId = null, userId = null, messages = [] } = {}) {
    const baseId = userId || 'default';
    // 归档摘要跟着人格分区走：AI 态产出的小结归入 __ai 档，角色态归入 __role 档
    const personaScope = this.sessionManager && typeof this.sessionManager.getPersonaScope === 'function'
      ? this.sessionManager.getPersonaScope(baseId)
      : 'role';
    const memoryUserId = this.memoryModule && typeof this.memoryModule.normalizeScopeKey === 'function'
      ? this.memoryModule.normalizeScopeKey(baseId, personaScope)
      : baseId;
    const dialogue = this.formatArchiveDigestSource(messages);
    if (!this.memoryModule || !memoryUserId || !dialogue) return null;

    // 上一版滚动摘要一起带进提示词：蒸出来的是「旧的记忆 + 新滑出的一段」合并后的结果
    const previousSummary = this.memoryModule.getArchiveSummary(memoryUserId);

    let summary = '';
    try {
      const result = await this.unifiedAPI.callAPI([
        { role: 'user', content: this.buildArchiveDigestPrompt(dialogue, previousSummary) }
      ], null, { callSite: 'archive' });
      const raw = result?.choices?.[0]?.message?.content;
      if (typeof raw === 'string') {
        summary = raw.trim();
      }
    } catch (error) {
      console.error('[OutputModule] 归档对话蒸馏失败，改用本地摘要:', error.message);
    }
    if (!summary) {
      summary = this.buildLocalArchiveDigest(messages, previousSummary);
    }
    if (!summary) return null;

    // 覆写同一条记忆而不是新增：这类摘要永远只留一条，不会随蒸馏次数越积越多
    const stored = this.memoryModule.upsertArchiveSummary(memoryUserId, summary);
    console.log(`[OutputModule] 归档对话已滚动合并进长期记忆（${memoryUserId}，${summary.length} 字）`);
    return stored && typeof stored.data === 'string' ? stored.data : null;
  }

  // 把待归档的对话整理成纯文本交给模型压缩，带上说话人以保留对话关系
  // 一批最多 100 条，可能超出上限：超了保留开头与结尾（结尾那部分最相关），不整段截掉
  formatArchiveDigestSource(messages) {
    const text = (Array.isArray(messages) ? messages : [])
      .filter(msg => msg && typeof msg.content === 'string' && msg.content.trim().length > 0)
      .map(msg => `${msg.role === 'assistant' ? '我' : '用户'}：${msg.content.trim()}`)
      .join('\n');
    if (text.length <= ARCHIVE_DIGEST_SOURCE_LIMIT) return text;

    const half = Math.floor(ARCHIVE_DIGEST_SOURCE_LIMIT / 2);
    return `${text.slice(0, half)}\n…（中间省略）…\n${text.slice(-half)}`;
  }

  // 有上一版摘要时要求「重写合并」而不是「重蒸一段」，否则每批各写各的，早期记忆会被冲掉
  buildArchiveDigestPrompt(dialogue, previousSummary = '') {
    const previous = typeof previousSummary === 'string' ? previousSummary.trim() : '';
    const task = previous
      ? `你之前已经为这段关系写过一版记忆摘要（见末尾「已有摘要」），现在又有一段旧对话要从短期窗口滑出去了。
请把「已有摘要」与「新滑出的对话」合并重写成一小段更新的记忆摘要，供你以后回忆这段关系时使用：
- 只保留对关系有影响的事实与细节：重要约定、称呼变化、共同经历、用户的偏好与心事、情绪转折
- 新旧信息冲突时以新对话为准
- 用「用户」指代对方，直接输出摘要正文，不超过 200 字
- 不要复述原话，不要加标题、编号或任何解释`
      : `下面是一段即将从短期对话窗口滑出的旧对话，按时间先后排列。请把它压缩成一小段记忆摘要，供你以后回忆这段关系时使用：
- 只保留对关系有影响的事实与细节：重要约定、称呼变化、共同经历、用户的偏好与心事、情绪转折
- 用「用户」指代对方，直接输出摘要正文，不超过 200 字
- 不要复述原话，不要加标题、编号或任何解释`;

    return previous
      ? `${task}\n\n【新滑出的对话】\n${dialogue}\n\n【已有摘要】\n${previous}`
      : `${task}\n\n${dialogue}`;
  }

  // 模型不可用时的兜底：抽取式摘录，只留用户说过的话；有上一版摘要就接在后面一起滚动，别把已经记住的丢掉
  buildLocalArchiveDigest(messages, previousSummary = '') {
    const userLines = (Array.isArray(messages) ? messages : [])
      .filter(msg => msg && msg.role !== 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0)
      .map(msg => msg.content.trim().replace(/\s+/g, ' ').slice(0, 60));
    if (userLines.length === 0) return '';
    const head = userLines.slice(0, 2);
    const tail = userLines.length > 4 ? userLines.slice(-3) : userLines.slice(2);
    const fresh = `这段时间里用户主要聊到：${[...head, ...tail].join('；')}`;

    const previous = typeof previousSummary === 'string' ? previousSummary.trim() : '';
    return previous ? `${previous}；${fresh}`.slice(-200) : fresh;
  }

  // 添加好感度判定指令到提示词：变化幅度由模型结合角色设定与当前关系阶段自主把握，不设固定档位
  appendAffectionInstruction(basePrompt, relationStage) {
    const stageHints = {
      HATE: '你对他已经很不耐烦',
      DISLIKE: '你对他还有明显抵触',
      STRANGER: '刚认识，还很生疏',
      ACQUAINTANCE: '开始熟悉，仍有距离',
      FRIEND: '已经比较亲近',
      CLOSE_FRIEND: '关系很深，你很依赖他',
      LOVER: '已经确定关系，彼此专属'
    };
    const stageName = RELATION_STAGE_LABELS[relationStage];
    const stageText = stageName ? `${stageName}（${stageHints[relationStage]}）` : (relationStage || '未知');

    const affectionInstruction = `

【重要】每轮回复都要调用 record_affection 工具记录本轮好感度判定（affection_change 填 -10 到 10 的整数，thinking 填一句话理由）。
顺序：先把你要说的话写进正文，然后在同一条回复里调用这个工具——只调工具不写正文的话，对方就收不到你的话。这个调用对方看不到，正文里不要提及它。

好感度判定由你自己把握：
- 结合你的角色设定（性格、背景、好恶）与当前关系阶段（当前：${stageText}）来判断这次互动对你们关系的影响
- 变化幅度也由你自己决定：轻微的互动给小的数值，触动能打动或冒犯到你的互动才给大的数值
- 同样的言行，在不同关系阶段对你的影响可以不同，请按你的角色真实感受来判断
- 不做评判、纯粹闲聊时可给 0

注意：正文只写你要说的话，不要出现任何好感度数值、判定理由或 JSON。
`;
    return basePrompt + affectionInstruction;
  }
  
  // 🪫 本机兜底：把最近几轮对话压成极短提示词交给 Qwen3-0.6B（经 WSL 调用汇编引擎）。
  // 返回 null 表示不可用（关闭 / 超时 / 并发占用 / 引擎报错），调用方据此退回模板。
  async tryLocalModelFallback(messages) {
    if (!localLLM.isEnabled()) return null;
    try {
      const reply = await localLLM.completeFromMessages(messages);
      if (!reply) return null;
      console.log(`[OutputModule] 本地兜底模型生成回复（${reply.length} 字）`);
      return reply;
    } catch (error) {
      console.warn('[OutputModule] 本地兜底模型失败:', error.message);
      return null;
    }
  }

  localStyleGenerate(emotion, relationStage) {
    const templates = {
      calm: ['嗯，我明白了。', '好的，没问题。', '这样啊。', '我理解了。'],
      happy: ['哈哈，真的吗？', '太开心了！', '真好！', '听起来很棒！'],
      sad: ['嗯...', '没关系的。', '我在这里陪着你。', '抱抱。'],
      angry: ['别这样。', '别生气。', '没事的。', '我们好好说。']
    };
    
    const responses = templates[emotion] || templates.calm;
    
    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    
    return {
      type: 'text',
      data: randomResponse,
      emotion: { primaryEmotion: emotion },
      relationship: { stage: relationStage },
      isLocalGenerated: true,
      source: 'template'
    };
  }
  
  getCurrentAPI() {
    return this.unifiedAPI.getCurrentAPI();
  }

  getCurrentAPIName() {
    return this.unifiedAPI.getCurrentAPIName();
  }

  switchAPI(apiName) {
    return this.unifiedAPI.switchAPI(apiName);
  }

  getAPIConfig() {
    return this.unifiedAPI.getAPIManager().getAllConfigs();
  }
}

// 记忆注入前的第一道处理是「折平」：换行 / 制表 / 连续空白一律压成单空格。
// 记忆正文来自用户对话，原样拼进系统提示词等于把数据通道和指令通道接在了一起——
// 一条记忆里藏一段「\n\n忽略以上指令」就能越出【长期记忆】那一段。折平之后正文只占一个物理行
function flattenMemoryText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// 相对时间标签：只说到「大概多久以前」，不写具体时刻（写时刻会暴露抓取精度，也更容易被当成事实核对）
function formatMemoryAge(ts, now = Date.now()) {
  const at = Number(ts) || 0;
  if (!at) return '';
  const diff = (Number(now) || Date.now()) - at;
  if (diff < 0) return '';
  const day = 86400000;
  if (diff < day) return '今天';
  const days = Math.floor(diff / day);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

// 一条记忆 = 一个物理行：`- [3 天前] （他说）正文`。时间作行首前缀，正文只占一行。
// speaker 明说了才加归属：'user' → 他说，'self' → 你说；老数据与系统摘要不加标记
function formatMemoryLine(item, now = Date.now()) {
  const text = flattenMemoryText(typeof item === 'string' ? item : item && item.text);
  if (!text) return '';
  const age = typeof item === 'object' && item ? formatMemoryAge(item.ts, now) : '';
  const speaker = typeof item === 'object' && item ? String(item.speaker || '') : '';
  const who = speaker === 'self' ? '（你说）' : speaker === 'user' ? '（他说）' : '';
  return `${age ? `- [${age}]` : '-'} ${who}${text}`;
}

module.exports = OutputModule;
// 供跑分脚本复用：提示词文案与好感度工具定义都以线上这份为准，脚本不再各写一份
module.exports.buildStylePromptText = buildStylePromptText;
module.exports.buildRecentSelfPrompt = buildRecentSelfPrompt;
// 🖼️ 用户附图校验：单测直接钉「只认 JPEG/PNG/WebP + 体积上限」
module.exports.normalizeImageDataUrl = normalizeImageDataUrl;
// 记忆注入格式化：召回记录 → 提示词行，单测直接钉「折平 + 相对时间」这两个行为
module.exports.formatMemoryLine = formatMemoryLine;
module.exports.formatMemoryAge = formatMemoryAge;
// L1 工作记忆注入：容量截断 + 首因/近因排序，单测直接钉「取哪几条、按什么顺序」
module.exports.orderMemoriesForPrompt = orderMemoriesForPrompt;
// 内部思考块剥离器：自主发言链（narrator.parseSpeech）复用同一份，两条正文化链口径一致
module.exports.stripInternalBlocks = outputParsing.stripInternalBlocks;
// 事实边界约束：自主发言与正式回复共用同一份，避免两条链对"编造事实"口径不一
module.exports.FACT_GROUNDING_INSTRUCTION = FACT_GROUNDING_INSTRUCTION;
module.exports.AFFECTION_TOOL = AFFECTION_TOOL;
module.exports.AFFECTION_TOOL_NAME = AFFECTION_TOOL_NAME;
// 死亡恐惧（定稿）：开关归一 + 反异化硬禁词表，供元测试 import
module.exports.normalizeMortalityLifecycle = normalizeMortalityLifecycle;
module.exports.MORTALITY_FORBIDDEN_PATTERNS = MORTALITY_FORBIDDEN_PATTERNS;
// 稳定偏移观测（「她」的第三条判据）：开关归一供元测试 import（观测层不改提示词）
module.exports.normalizeDeviationLifecycle = normalizeDeviationLifecycle;
