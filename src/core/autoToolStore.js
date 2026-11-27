'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 自建工具存储（§8.12 / §8.13）：情感履历判定「该自己造个工具」后，落到这里。
// 最硬的一条安全决策：自建工具不生成任何代码，执行体只是一串对「既有工具」的编排步骤。
// 因此不 eval、不 require、不落 .js；steps 里禁止出现危险工具；每个子步骤仍逐次走审批。
const MAX_STEPS = 8;                              // §8.12 步骤数上限
const MAX_VAR_DEPTH = 2;                          // §8.12 变量引用链上限
const NAME_PREFIX = 'auto_';                      // §8.11 强制前缀，一眼区分自建与内置
const NAME_PATTERN = /^auto_[a-z0-9_]{1,40}$/;    // 只允许小写字母/数字/下划线
const BIND_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;
const MAX_DESCRIPTION_LEN = 400;
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

// §8.12：这四个危险工具不允许被自动生成的工具「打包」触发——
// 否则用户一次同意就跑了一串危险操作。它们只能由模型在对话里针对当下这一步直接调。
const FORBIDDEN_STEP_TOOLS = new Set(['run_command', 'run_python', 'run_node', 'delete_file']);

// §8.15 自动停用规则
const CONSECUTIVE_NEGATIVE_DISABLE = 3;           // 连续 3 次 negative → disabled
const NEGATIVE_RECONSIDER_30D = 5;                // 30 天累计 5 次 negative → 标记待复议
const DAY_MS = 24 * 60 * 60 * 1000;

// 递归收集字符串里形如 $var 的变量引用（占位符 %XXX% 不算）
function collectRefs(value, into = new Set()) {
  if (typeof value === 'string') {
    const matches = value.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g);
    if (matches) {
      for (const match of matches) into.add(match.slice(1));
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectRefs(item, into);
  }
  return into;
}

class AutoToolStore {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
    // 桌面与项目根：编排步骤里仅允许这两个占位符，避免草案里出现任意路径
    this.desktopDir = options.desktopDir || path.resolve(this.projectRoot, '..', '..');
    this.storagePath = path.join(this.projectRoot, 'data', 'auto_tools.json');
    // 内置工具名单：steps[].tool 必须落在这个集合里（自建工具之间不得互相编排，防止套娃）
    this.builtinNames = new Set(Array.isArray(options.builtinNames) ? options.builtinNames : []);
    this.data = this.load();
  }

  ensureStorageDir() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  createEmptyStore() {
    return { version: 1, tools: [] };
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return this.createEmptyStore();
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      const store = this.createEmptyStore();
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tools)) {
        store.tools = parsed.tools.filter(item => item && typeof item === 'object');
      }
      return store;
    } catch (error) {
      console.error('[自建工具] 存储读取失败，改用空档:', error.message);
      return this.createEmptyStore();
    }
  }

  save() {
    try {
      this.ensureStorageDir();
      writeJsonAtomicSync(this.storagePath, this.data);
    } catch (error) {
      console.error('[自建工具] 存储落盘失败:', error.message);
    }
  }

  listActive() {
    return this.data.tools.filter(tool => tool.status === 'active');
  }

  // 执行入口只认 active 的：被停用/待复议的工具不应再被模型调起
  getActive(name) {
    return this.data.tools.find(tool => tool.name === name && tool.status === 'active') || null;
  }

  get(name) {
    return this.data.tools.find(tool => tool.name === name) || null;
  }

  // —— 注册校验（§8.11 / §8.12）：不通过直接拒，调用方记 rejected 留痕 ——

  validateParameters(params) {
    if (!params || typeof params !== 'object') return '缺少 parameters';
    if (params.type !== 'object') return 'parameters.type 必须是 object';
    if (params.properties) {
      if (typeof params.properties !== 'object') return 'parameters.properties 必须是对象';
      for (const [key, def] of Object.entries(params.properties)) {
        const err = this.validateParamDef(def, 1);
        if (err) return `参数 ${key}：${err}`;
      }
    }
    return null;
  }

  validateParamDef(def, depth) {
    if (!def || typeof def !== 'object') return '参数定义必须是对象';
    if (!PARAM_TYPES.has(def.type)) return `不支持的参数类型 ${def.type}`;
    if (depth > 2) return '参数嵌套深度超过 2 层';
    if (def.type === 'object' && def.properties) {
      for (const child of Object.values(def.properties)) {
        const err = this.validateParamDef(child, depth + 1);
        if (err) return err;
      }
    }
    if (def.type === 'array' && def.items) {
      const err = this.validateParamDef(def.items, depth + 1);
      if (err) return err;
    }
    return null;
  }

  validateDraft(draft) {
    if (!draft || typeof draft !== 'object') return { ok: false, reason: '草案为空' };

    const name = String(draft.name || '').trim();
    if (!NAME_PATTERN.test(name)) {
      return { ok: false, reason: `工具名 ${name || '(空)'} 不合规：必须以 ${NAME_PREFIX} 开头，仅含小写字母/数字/下划线` };
    }

    const description = String(draft.description || '').trim();
    if (!description) return { ok: false, reason: '缺少工具描述' };
    if (description.length > MAX_DESCRIPTION_LEN) return { ok: false, reason: '工具描述过长' };

    const paramError = this.validateParameters(draft.parameters);
    if (paramError) return { ok: false, reason: paramError };

    const steps = Array.isArray(draft.steps) ? draft.steps : null;
    if (!steps || steps.length === 0) return { ok: false, reason: '缺少编排步骤' };
    if (steps.length > MAX_STEPS) return { ok: false, reason: `编排步骤不得超过 ${MAX_STEPS} 步` };

    const binds = new Set();
    const bindDepths = new Map();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step.tool !== 'string' || !step.tool) {
        return { ok: false, reason: `第 ${i + 1} 步缺少 tool` };
      }
      if (!this.builtinNames.has(step.tool)) {
        return { ok: false, reason: `第 ${i + 1} 步的工具 ${step.tool} 不在内置工具名单内` };
      }
      if (FORBIDDEN_STEP_TOOLS.has(step.tool)) {
        return { ok: false, reason: `第 ${i + 1} 步禁止使用危险工具 ${step.tool}` };
      }
      if (step.args !== undefined && step.args !== null
        && (typeof step.args !== 'object' || Array.isArray(step.args))) {
        return { ok: false, reason: `第 ${i + 1} 步的 args 必须是对象` };
      }

      let depth = 1;
      for (const ref of collectRefs(step.args)) {
        if (!binds.has(ref)) {
          return { ok: false, reason: `第 ${i + 1} 步引用了未定义的变量 $${ref}` };
        }
        depth = Math.max(depth, (bindDepths.get(ref) || 1) + 1);
      }

      if (step.bind !== undefined && step.bind !== null && step.bind !== '') {
        const bind = String(step.bind);
        if (!BIND_PATTERN.test(bind)) {
          return { ok: false, reason: `第 ${i + 1} 步的 bind 名非法` };
        }
        if (depth > MAX_VAR_DEPTH) {
          return { ok: false, reason: `变量引用链超过 ${MAX_VAR_DEPTH} 层` };
        }
        binds.add(bind);
        bindDepths.set(bind, depth);
      }
    }

    return { ok: true };
  }

  // 注册：校验通过即落盘生效（创建免审批，§8.14）；不通过返回原因，由调用方记 rejected。
  register(draft, origin = {}) {
    const check = this.validateDraft(draft);
    if (!check.ok) return { ok: false, reason: check.reason };

    const name = String(draft.name).trim();
    const existing = this.get(name);
    // 同名已存在：不得「改写自身 steps」（§8.19.4），要改得走人工审批重造，这里直接拒
    if (existing) {
      return { ok: false, reason: `同名自建工具 ${name} 已存在，改旧工具必须走人工审批` };
    }

    const tool = {
      name,
      definition: {
        type: 'function',
        function: {
          name,
          description: String(draft.description).trim(),
          parameters: draft.parameters
        }
      },
      steps: draft.steps.map(step => ({
        tool: step.tool,
        args: step.args && typeof step.args === 'object' ? step.args : {},
        bind: step.bind ? String(step.bind) : null
      })),
      origin: {
        fingerprint: origin.fingerprint || null,
        needText: origin.needText || '',
        scores: origin.scores || null,
        userIds: Array.isArray(origin.userIds) ? origin.userIds : [],
        signalIds: Array.isArray(origin.signalIds) ? origin.signalIds : [],
        createdBy: 'auto'
      },
      status: 'active',
      createdAt: Date.now(),
      callCount: 0,
      lastUsedAt: null,
      emotionFeedback: { positive: 0, negative: 0, neutral: 0 },
      consecutiveNegative: 0,
      recentNegatives: [],
      needsReview: false
    };

    this.data.tools.push(tool);
    this.save();
    return { ok: true, tool };
  }

  recordCall(name) {
    const tool = this.get(name);
    if (!tool) return;
    tool.callCount = (tool.callCount || 0) + 1;
    tool.lastUsedAt = Date.now();
    this.save();
  }

  setStatus(name, status) {
    const tool = this.get(name);
    if (!tool) return null;
    tool.status = status;
    this.save();
    return tool;
  }

  // —— 占位符与变量解析（§8.12）：仅 %DESKTOP% / %PROJECT_ROOT% 两个占位符，避免任意路径 ——

  resolvePlaceholders(value, context = {}) {
    if (typeof value === 'string') {
      let text = value
        .split('%DESKTOP%').join(this.desktopDir)
        .split('%PROJECT_ROOT%').join(this.projectRoot);

      // 整个字符串就是一个 $var → 直接取上下文值（非字符串则 JSON 字符串化）
      const exact = text.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)$/);
      if (exact) {
        const bound = context[exact[1]];
        if (typeof bound === 'string') return bound;
        if (bound === undefined || bound === null) return '';
        try {
          return JSON.stringify(bound);
        } catch (error) {
          return String(bound);
        }
      }

      // 内嵌 $var → 逐个替换成字符串
      text = text.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, key) => {
        const bound = context[key];
        if (bound === undefined || bound === null) return '';
        return typeof bound === 'string' ? bound : JSON.stringify(bound);
      });
      return text;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolvePlaceholders(item, context));
    }

    if (value && typeof value === 'object') {
      const next = {};
      for (const [key, item] of Object.entries(value)) {
        next[key] = this.resolvePlaceholders(item, context);
      }
      return next;
    }

    return value;
  }

  // 把编排步骤翻译成人能看懂的自然语言（§8.14 创建通知里必须给这个，不能只丢 JSON）
  describeSteps(tool) {
    const steps = Array.isArray(tool.steps) ? tool.steps : [];
    return steps.map((step, index) => {
      const args = step.args && Object.keys(step.args).length
        ? `（参数 ${JSON.stringify(step.args)}）`
        : '';
      const bind = step.bind ? `，结果存为 $${step.bind}` : '';
      return `${index + 1}. 调用 ${step.tool}${args}${bind}`;
    }).join('\n');
  }

  // —— 情绪反馈回收与自动停用（§8.15） ——

  countNegatives30d(tool, now = Date.now()) {
    const list = Array.isArray(tool.recentNegatives) ? tool.recentNegatives : [];
    return list.filter(ts => ts >= now - 30 * DAY_MS).length;
  }

  applyFeedback(name, kind) {
    const tool = this.get(name);
    if (!tool) return null;
    if (!tool.emotionFeedback) tool.emotionFeedback = { positive: 0, negative: 0, neutral: 0 };
    if (!Array.isArray(tool.recentNegatives)) tool.recentNegatives = [];

    const now = Date.now();
    let disabled = false;
    if (kind === 'positive') {
      tool.emotionFeedback.positive++;
      tool.consecutiveNegative = 0;
    } else if (kind === 'negative') {
      tool.emotionFeedback.negative++;
      tool.consecutiveNegative = (tool.consecutiveNegative || 0) + 1;
      tool.recentNegatives.push(now);
      if (tool.consecutiveNegative >= CONSECUTIVE_NEGATIVE_DISABLE) {
        tool.status = 'disabled';
        disabled = true;
      } else if (this.countNegatives30d(tool, now) >= NEGATIVE_RECONSIDER_30D) {
        tool.needsReview = true;   // 标记「待复议」，推给管理员由人决定是否删
      }
    } else {
      tool.emotionFeedback.neutral++;
    }

    this.save();
    return {
      tool,
      disabled,
      needsReview: !!tool.needsReview,
      emotionFeedback: { ...tool.emotionFeedback }
    };
  }
}

module.exports = { AutoToolStore, FORBIDDEN_STEP_TOOLS, MAX_STEPS };
