'use strict';

// 输出文本的解析与归一：纯字符串处理，不碰 fs、不碰网络。
// 从 output.js 抽出，主对话链、自主发言链与单测共用同一份口径。

// 内部思考块剥离：模型偶尔把「写给自己看的标签块」当正文吐出来（真实会话里漏出过
// <commentary>（本轮由我起话头）…</commentary>）。一旦漏进正文，就会被存进会话历史，
// 下一轮作为历史回灌给模型，它接着模仿——这种存储型污染不清就永远清不掉。
// 只认已知的少数几个内部标签，绝不写成 <[^>]+> 那样的泛化正则：那会误伤「买了个 <3」
// 「>_<」这类正常文本，而且剥错了不可逆。大小写不敏感；只有开标签没有闭标签（被截断）时，
// 从该标签起全丢（与 stripJsonBlocks 处理未闭合 JSON 的做法一致）。
// 两条正文化链路（主对话 parseAffectionChange / 自主发言 parseSpeech）共用这一份，避免各修各的。
const INTERNAL_TAG_NAMES = ['commentary', 'thinking', 'reasoning', 'analysis', 'reflection', 'thought', 'internal'];
function stripInternalBlocks(text) {
  let result = String(text == null ? '' : text);
  for (const name of INTERNAL_TAG_NAMES) {
    result = result
      .replace(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`, 'gi'), ' ')
      .replace(new RegExp(`<${name}>[\\s\\S]*$`, 'gi'), ' ')
      .replace(new RegExp(`<\\/${name}>`, 'gi'), ' ');
  }
  return result;
}

// 解析API返回的好感度变化
function parseAffectionChange(rawOutput) {
  const raw = typeof rawOutput === 'string' ? rawOutput : '';
  let affectionChange = null;
  let thinking = '';
  let dialogueText = raw;

  const matched = findAffectionJson(raw);
  if (matched) {
    affectionChange = normalizeAffectionChange(matched.parsed.affection_change);
    if (typeof matched.parsed.thinking === 'string') {
      thinking = matched.parsed.thinking.trim();
    }
    // 无论 JSON 出现在开头、中间还是结尾，都从对话文本中移除
    dialogueText = raw.slice(0, matched.start) + raw.slice(matched.end);
  }

  // 兜底：解析失败时也不能把 JSON/围栏原文返回给用户
  dialogueText = stripInternalBlocks(dialogueText);
  dialogueText = stripJsonBlocks(dialogueText);
  dialogueText = stripMetaNotes(dialogueText);
  // 剥掉正文开头的段位标记（[在场]/[余温]/[沉底]），防止泄漏给用户并被历史继续喂回去
  dialogueText = stripTierMark(dialogueText);
  dialogueText = normalizeDialogueFormat(dialogueText);
  if (!dialogueText) {
    dialogueText = '……';
  }

  return {
    affectionChange: affectionChange,
    thinking: thinking,
    dialogueText: dialogueText
  };
}

// 从回复中定位并解析好感度 JSON（支持嵌套、```json 围栏、JSON 不在开头的情况）
function findAffectionJson(rawOutput) {
  if (!rawOutput) {
    return null;
  }

  const candidates = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(rawOutput)) !== null) {
    candidates.push({
      text: fenceMatch[1],
      offset: fenceMatch.index + fenceMatch[0].indexOf(fenceMatch[1])
    });
  }
  candidates.push({ text: rawOutput, offset: 0 });

  for (const candidate of candidates) {
    const start = candidate.text.indexOf('{');
    if (start === -1) {
      continue;
    }
    const end = findMatchingBrace(candidate.text, start);
    if (end === -1) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate.text.slice(start, end + 1));
      if (parsed && parsed.affection_change !== undefined) {
        return {
          parsed: parsed,
          start: candidate.offset + start,
          end: candidate.offset + end + 1
        };
      }
    } catch (error) {
      // 当前候选不是合法 JSON，继续尝试下一个
    }
  }

  return null;
}

// 从起始左括号出发，返回配对右括号的下标（跳过字符串内的括号，支持嵌套）
function findMatchingBrace(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

// 类型校验 + 夹取到 -10~10 的整数，无法解析为数值时返回 null
function normalizeAffectionChange(value) {
  let num = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    num = value;
  } else if (typeof value === 'string' && /^[+-]?\d+(\.\d+)?$/.test(value.trim())) {
    num = Number(value.trim());
  }

  if (num === null) {
    return null;
  }
  return Math.max(-10, Math.min(10, Math.round(num)));
}

// 移除文本中的代码围栏与 JSON 片段
function stripJsonBlocks(text) {
  let result = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\{[\s\S]*\}/g, ' ');

  // 处理被截断、未闭合的 JSON 片段：从首个未配对的左括号起全部丢弃
  const openCount = (result.match(/\{/g) || []).length;
  const closeCount = (result.match(/\}/g) || []).length;
  if (openCount > closeCount) {
    result = result.slice(0, result.indexOf('{'));
  }

  return result
    .replace(/```/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 剥掉正文里的段位标记（在场/余温/沉底）。存量会话里已经被模型抄进正文的那些，
// 若不处理会作为历史继续喂回去，模型接着模仿，污染就永远清不掉。
// 模型可能连抄多个（实测出现过「[在场] [在场] 正文」），所以全部剥掉而不只剥开头一个
function stripTierMark(text) {
  return String(text)
    .replace(/\[(?:在场|余温|沉底)\]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+/, '');
}

// 模型偶尔把「写给自己看的元指令」当括号夹注漏进正文，跑分里实测到过
// 「（Actually, need a final line. Keep 1-3 sentences, new thing.）」——判官直接判出戏。
// 这类夹注的特征是整段含 ASCII 字母（中文对白的括号夹注不会整句英文），连括号一起剥掉；
// 不跨行匹配，避免括号不配对时误吞大段正文
function stripMetaNotes(text) {
  return String(text)
    .replace(/（[^（）\n]*[A-Za-z][^（）\n]*）/g, '')
    .replace(/\([^()\n]*[A-Za-z][^()\n]*\)/g, '');
}

// 正文排版兜底：提示词层压不住的抖动在代码侧收一次，只动排版不动内容
function normalizeDialogueFormat(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    // 空行压成单换行
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    // 整行只有句读符号的（空行抖动带出来的「。单独一行」），直接剥掉
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return !/^[。，、；：！？…\.\,\;\:\!\?～～]+$/.test(trimmed);
    })
    .join('\n')
    .trim();
}

// 统一情绪枚举：neutral 与缺失值均归一为 calm（与 emotion/input 模块保持一致）
function normalizeEmotion(emotion) {
  if (!emotion || emotion === 'neutral') {
    return 'calm';
  }
  return emotion;
}

// 部分模型（豆包某些版本即是）不走结构化 tool_calls，而是把调用当成正文文本输出，
// 并用私有标记装饰标签名，形如 <｜｜｜DSML｜｜｜invoke name="run_python">…</｜｜｜DSML｜｜｜invoke>。
// 这里先把装饰前缀剥回标准标签形态；只有出现全角竖线（私有标记的特征，正常行文不会有）才动手，避免误伤正文
function stripToolTagDecoration(text) {
  return String(text).replace(
    /<(\/?)[^<>\n]*?\uff5c[^<>\n]*?(?=(?:invoke|parameter|tool_calls)\b)/g,
    '<$1'
  );
}

// 兜底解析：把上面那类正文形式的调用还原成结构化调用，并顺带从正文里剔除标记，避免标记流到聊天气泡里
function parseTextToolCalls(content, validNames) {
  if (typeof content !== 'string' || !content.trim()) return null;

  // 只有出现全角竖线（私有标记的特征）才需要剥装饰
  const normalized = content.indexOf('\uff5c') === -1 ? content : stripToolTagDecoration(content);
  const calls = [];
  const invokeRe = /<invoke\s+name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/invoke>|(?=<invoke\b)|$)/g;
  let match;
  while ((match = invokeRe.exec(normalized)) !== null) {
    const name = match[1];
    if (validNames.length > 0 && !validNames.includes(name)) continue;
    const args = {};
    const paramRe = /<parameter\s+name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/parameter>|(?=<parameter\b)|$)/g;
    let param;
    while ((param = paramRe.exec(match[2])) !== null) {
      const raw = param[2].trim();
      args[param[1]] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    calls.push({ name, args });
  }

  // 另一种写法：拿工具名本身当标签，参数用 <parameter name="x"> 铺在中间
  // 形如 <record_affection><parameter name="affection_change" string="false">2</parameter></record_affection>
  // 不处理的话整段标签会原样流到聊天窗口里（群里已经出现过「露思考」的现象）
  let leaked = normalized;
  if (validNames.length > 0) {
    const blockRe = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    const spans = [];
    let block;
    while ((block = blockRe.exec(normalized)) !== null) {
      const name = block[1];
      const body = block[2];
      if (!validNames.includes(name) || !/<parameter\b/.test(body)) continue;
      const args = {};
      const paramRe = /<parameter\s+name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/parameter>/g;
      let param;
      while ((param = paramRe.exec(body)) !== null) {
        const raw = param[2].trim();
        args[param[1]] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      }
      calls.push({ name, args });
      spans.push(block[0]);
    }
    spans.forEach(span => { leaked = leaked.split(span).join(''); });
  }

  if (calls.length === 0) return null;

  const cleaned = leaked
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/g, '')
    .replace(/<\/?tool_calls\b[^>]*>/g, '')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/g, '')
    .trim();

  return { calls, cleaned };
}

module.exports = {
  INTERNAL_TAG_NAMES,
  stripInternalBlocks,
  parseAffectionChange,
  findAffectionJson,
  findMatchingBrace,
  normalizeAffectionChange,
  stripJsonBlocks,
  stripTierMark,
  stripMetaNotes,
  normalizeDialogueFormat,
  normalizeEmotion,
  stripToolTagDecoration,
  parseTextToolCalls
};
