const path = require('path');

// 研究平台工具：research_search / task_list / task_add / task_update / run / note_save / open_page。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；研究中心（host.research）
// 与脚本执行（host.runCommand / runScript）仍由 host 提供，这里只做编排。
class ResearchTools {
  constructor(host) {
    this.host = host;
  }

  async researchSearch(args = {}) {
    const source = String(args.source || 'papers').toLowerCase();
    if (source === 'news') {
      return this.host.research.searchNews(args.query, args.max);
    }
    return this.host.research.searchPapers(args.query, args.max);
  }

  researchTaskList(status) {
    return this.host.research.listTasks(status);
  }

  researchTaskAdd(args = {}) {
    return this.host.research.addTask(args);
  }

  researchTaskUpdate(args = {}) {
    return this.host.research.updateTask(String(args.id || ''), args);
  }

  async researchRun(args = {}) {
    const host = this.host;
    const resolved = host.research.resolveWorkspaceScript(args.name, args.language, args.code);
    if (!resolved.success) {
      return resolved;
    }
    // 免授权的代价是边界收紧：单次最长 10 分钟，跑完记账
    const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 600000);
    const result = await host.runScript(resolved.kind, {
      file: resolved.file,
      cwd: resolved.cwd,
      args: args.args,
      timeoutMs
    });
    host.research.logRun({
      time: new Date().toISOString(),
      script: path.basename(resolved.file),
      language: resolved.kind,
      exitCode: result.exitCode,
      success: !!result.success
    });
    return Object.assign({}, result, { workspace: resolved.cwd });
  }

  researchNoteSave(content) {
    return this.host.research.saveNote(content);
  }

  async researchOpenPage() {
    const port = process.env.SERVER_PORT || '41888';
    const url = `http://localhost:${port}/research.html`;
    // start 是 cmd 内建命令，runCommand 走 shell 正好能用
    const result = await this.host.runCommand(`start "" "${url}"`, undefined, 10000, { hostOnly: true });
    return Object.assign({}, result, { opened: url });
  }

  handlers() {
    return {
      research_search: (args) => this.researchSearch(args),
      research_task_list: (args) => this.researchTaskList(args.status),
      research_task_add: (args) => this.researchTaskAdd(args),
      research_task_update: (args) => this.researchTaskUpdate(args),
      research_run: (args) => this.researchRun(args),
      research_note_save: (args) => this.researchNoteSave(args.content),
      research_open_page: () => this.researchOpenPage()
    };
  }
}

module.exports = { ResearchTools };
