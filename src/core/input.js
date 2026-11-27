const { UnifiedAPI } = require('./api');
const UserApiClient = require('./userApi');

class InputModule {
  constructor() {
    this.unifiedAPI = new UnifiedAPI();
    // 用户自带的自定义 API：语义分析也优先走用户自己的 API
    this.userApiClient = new UserApiClient();
    this.currentAPI = 'doubao';
  }

  async process(data, history = [], userApiConfig = null) {
    const text = data?.data || '';
    return await this.processText(text, history, userApiConfig);
  }

  async processText(text, history = [], userApiConfig = null) {
    let result;
    try {
      result = await this.analyzeWithAPI(text, history, userApiConfig);
      console.log("✅ 语义分析API调用成功");
    } catch (err) {
      console.error("❌ 语义分析API调用失败，降级到本地语义分析:", err.message);
      result = this.localSemanticAnalysis(text);
    }
    result.value = this.deriveSentimentValue(result);
    // 情绪信号：按语义类型原始映射，供情绪状态层驱动对应的 7 维情感（不被压成标量）
    result.signals = this.deriveEmotionSignals(result);
    return result;
  }

  // 由情绪类型与强度推导情绪倾向值（-1~1），供 emotion / galgame / memory 模块使用
  deriveSentimentValue(semantic) {
    const type = semantic?.emotion?.type;
    const rawIntensity = Number(semantic?.emotion?.intensity);
    const intensity = Number.isFinite(rawIntensity)
      ? Math.max(0, Math.min(1, rawIntensity))
      : 0.5;

    switch (type) {
      case 'happy':
        return intensity;
      case 'sad':
      case 'angry':
        return -intensity;
      default:
        return 0;
    }
  }

  // 由语义分析结果提取「情绪信号」列表（type+intensity），供情绪状态层按类型驱动 7 维情感。
  // 优先用模型返回的多标签 emotions；缺失时回退到单个 emotion，保证链路始终有信号可用。
  // angry 必须放行：情绪层 SIGNAL_TARGET_MAP 会把它映射成 sad+anxious，这里丢掉会导致
  // 辱骂/攻击类消息完全没有负面信号（实测毒舌型用户 sad 检出率仅 3%）。
  deriveEmotionSignals(result) {
    const VALID = new Set(['happy', 'sad', 'angry', 'shy', 'anxious', 'jealous', 'dependent', 'calm']);
    const normalize = (item) => {
      const type = typeof item?.type === 'string' ? item.type.trim().toLowerCase() : '';
      if (!VALID.has(type)) return null;
      const raw = Number(item.intensity);
      const intensity = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
      return { type, intensity };
    };

    const list = Array.isArray(result?.emotions) ? result.emotions : [];
    const signals = list.map(normalize).filter(Boolean);
    if (signals.length === 0) {
      const single = normalize(result?.emotion);
      if (single) signals.push(single);
    }
    return signals;
  }

  async analyzeWithAPI(text, history = [], userApiConfig = null) {
    const systemPrompt = `你是一个语义分析器，根据用户输入的文本（包含历史对话上下文），严格按以下JSON格式返回结果：
        {
          "emotion": {"type": "主情绪类型", "intensity": 0-1的浮点数},
          "emotions": [{"type": "情绪类型", "intensity": 0-1的浮点数}],
          "relation": {"stage": "关系阶段", "score": 0-100的整数},
          "scene": "场景总结，一句话描述"
        }
        情绪类型可选：calm/happy/sad/angry/anxious/shy/jealous/dependent。
        emotion 填最能概括此刻的单一主情绪；emotions 列出本次文本实际触发的全部情绪（可多个），无明确情绪时才给 [{"type":"calm","intensity":0.5}]。
        参考：被夸/不好意思→shy；吃醋/竞争/情敌→jealous；依赖/离不开/粘人→dependent；紧张/担忧/害怕→anxious；生气/被冒犯→angry。
        注意：文本带明确情绪时禁止输出 calm。辱骂/嘲讽/贬低/阴阳怪气/人身攻击必须输出 angry（可叠加 sad 或 anxious），哪怕语气是玩笑式的刻薄。
        强度标尺：轻微带过 0.3-0.5；情绪明显 0.6-0.8；激烈强烈（骂人/暴怒/大哭/狂喜/强烈告白）0.8-1.0。
        关系阶段可选：STRANGER/ACQUAINTANCE/FRIEND/CLOSE。
        只返回JSON，不要额外文字。`;
    
    const messages = [
      {
        role: "system",
        content: systemPrompt
      }
    ];
    
    const recentHistory = history.slice(-10);
    messages.push(...recentHistory);
    messages.push({ role: "user", content: text });
    
    let content;
    if (userApiConfig && userApiConfig.enabled && userApiConfig.apiUrl) {
      // 用户启用了自定义API，语义分析也走该用户的API
      content = await this.userApiClient.callApi(
        userApiConfig,
        messages.filter((msg) => msg.role !== 'system'),
        systemPrompt
      );
    } else {
      const result = await this.unifiedAPI.callAPI(messages, null, { callSite: 'semanticParse' });
      content = result?.choices?.[0]?.message?.content;
    }
    return this.parseJsonResponse(content);
  }

  // 解析模型返回的 JSON，兼容 ```json 围栏及前后夹带文字的情况
  parseJsonResponse(content) {
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('语义分析返回内容为空');
    }

    let text = content.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        return JSON.parse(text.slice(start, end + 1));
      }
      throw err;
    }
  }

  localSemanticAnalysis(text) {
    const input = typeof text === 'string' ? text : '';

    const rules = [
      { type: 'happy', intensity: 0.8, pattern: /开心|高兴|快乐|喜欢|太棒|真棒|很棒/ },
      { type: 'sad', intensity: 0.7, pattern: /难过|伤心|痛苦|哭|低落/ },
      { type: 'angry', intensity: 0.6, pattern: /生气|愤怒|讨厌|烦人|好烦|烦躁|可恶/ },
      { type: 'jealous', intensity: 0.7, pattern: /嫉妒|吃醋|情敌|竞争者|眼红|抢走/ },
      { type: 'dependent', intensity: 0.7, pattern: /依赖|离不开|只有你|别走|陪我|黏/ },
      { type: 'shy', intensity: 0.6, pattern: /害羞|脸红|不好意思|羞|尴尬/ },
      { type: 'anxious', intensity: 0.6, pattern: /紧张|担心|害怕|不安|焦虑|忐忑/ }
    ];

    // 收集本次命中的全部情绪（保留多标签），首个命中者作为主情绪
    const matched = [];
    for (const rule of rules) {
      const match = rule.pattern.exec(input);
      if (!match) {
        continue;
      }
      // 否定词检测：命中词前 2 个字内出现否定词（如"不开心""别生气""不讨厌"）则不判定为该情绪
      const before = input.slice(Math.max(0, match.index - 2), match.index);
      if (/[不别没无莫勿]/.test(before)) {
        continue;
      }
      matched.push({ type: rule.type, intensity: rule.intensity });
    }

    const primary = matched.length > 0 ? matched[0] : { type: 'calm', intensity: 0.5 };

    const normalized = input.replace(/\s+/g, ' ').trim();
    const scene = normalized.length > 30 ? `${normalized.slice(0, 30)}…` : normalized;

    return {
      emotion: { type: primary.type, intensity: primary.intensity },
      emotions: (matched.length > 0 ? matched : [primary]).map((e) => ({ type: e.type, intensity: e.intensity })),
      relation: { stage: 'FRIEND', score: 50 },
      scene: scene
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

module.exports = InputModule;
