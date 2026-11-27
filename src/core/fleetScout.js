'use strict';

// 只读侦察员（FleetScout）：集群里 12 个不落盘的槽位。
// 它复用编码闭环同一条 callWithTools 工具循环，但工具白名单只留读工具——
// 没有 code_write / code_apply_patch / code_run，模型就算想写也拿不到工具。

const READ_TOOLS = new Set([
  'code_read',
  'code_read_range',
  'code_list_dir',
  'code_search',
  'code_find_symbol',
  'code_find_refs',
  'code_repo_map',
  'code_diagnose',
  'web_search',
  'fetch_url'
]);

function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total)) return total;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  return prompt + completion;
}

function buildMessages(manifest) {
  const reads = (manifest.reads || []).length ? manifest.reads.join('\n- ') : '（未声明，按目标自行选择只读文件）';
  return [
    {
      role: 'system',
      content: [
        '你是编程沙箱集群里的只读侦察员。',
        '你只能读代码与联网查资料，不能写文件、不能跑命令、不能提交。',
        '你的输出会被中枢汇总给写手。只给事实与可执行建议，不要客套。',
        '输出格式：',
        '1) 关键发现（最多 5 条，带文件路径）',
        '2) 风险（最多 3 条）',
        '3) 给写手的建议（最多 3 条）',
        '总长不超过 300 字。'
      ].join('\n')
    },
    {
      role: 'user',
      content: `集群目标：${manifest.goal}\n可读路径：\n- ${reads}`
    }
  ];
}

class FleetScout {
  constructor(options = {}) {
    this.outputModule = options.outputModule;
    this.apiChannel = String(options.apiChannel || 'deepseek');
    this.maxRounds = Math.max(1, Math.min(parseInt(options.maxRounds, 10) || 3, 6));
    this.runs = new Map();
  }

  // manifest.taskId 是槽位 id；真正读的是基座工作区，所以工具上下文用 baseTaskId。
  async run(manifest, options = {}) {
    if (!this.outputModule || typeof this.outputModule.callWithTools !== 'function') {
      return { ok: false, taskId: manifest.taskId, error: 'outputModule 不可用', status: 'failed' };
    }
    const userId = String(options.userId || '').trim();
    const baseTaskId = String(options.baseTaskId || '').trim();
    if (!userId || !baseTaskId) {
      return { ok: false, taskId: manifest.taskId, error: '缺少 userId 或 baseTaskId', status: 'failed' };
    }
    const controller = new AbortController();
    this.runs.set(manifest.taskId, controller);
    let used = 0;
    const budget = Math.max(0, Number(manifest.tokenBudget) || 0);
    const onUsage = (usage) => {
      used += usageTotal(usage);
      if (typeof options.onUsage === 'function') {
        try { options.onUsage(used, usage); } catch { /* 用量回调异常不影响侦察 */ }
      }
    };
    const shouldStop = () => {
      if (controller.signal.aborted) return true;
      if (typeof options.shouldStop === 'function' && options.shouldStop()) return true;
      return budget > 0 && used >= budget;
    };
    try {
      const result = await this.outputModule.callWithTools(buildMessages(manifest), {
        sessionId: `coding_${userId}_${manifest.taskId}`,
        userId,
        taskId: baseTaskId,
        origin: 'coding',
        scope: 'ai',
        toolFilter: (def) => READ_TOOLS.has(String((def && def.function && def.function.name) || '')),
        includeAffectionTool: false,
        apiChannel: this.apiChannel,
        forceThinking: 'disabled',
        temperature: 0.2,
        stream: true,
        maxRounds: this.maxRounds,
        maxTokens: () => (budget > 0 ? Math.max(0, budget - used) : undefined),
        onUsage,
        shouldStop,
        signal: controller.signal,
        onEvent: typeof options.onEvent === 'function' ? options.onEvent : undefined
      });
      const findings = String(result?.choices?.[0]?.message?.content || '').trim();
      if (!findings) {
        return { ok: false, taskId: manifest.taskId, error: '侦察没有返回正文', usage: used, status: 'failed' };
      }
      return {
        ok: true,
        taskId: manifest.taskId,
        agentId: manifest.agentId,
        status: 'done',
        findings,
        usage: used
      };
    } catch (error) {
      return { ok: false, taskId: manifest.taskId, error: error.message, usage: used, status: 'failed' };
    } finally {
      this.runs.delete(manifest.taskId);
    }
  }

  stop(taskId) {
    const controller = this.runs.get(String(taskId || ''));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  stopAll() {
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
  }
}

module.exports = { FleetScout, READ_TOOLS, usageTotal };
