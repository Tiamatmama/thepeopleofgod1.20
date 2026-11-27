// 学习任务与技能包工具：learn_request / learn_run / skill_list / skill_load / skill_resource。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；学习中心（host.learning）
// 与技能库（host.skills）仍由 host 提供，这里只做编排。
class LearningTools {
  constructor(host) {
    this.host = host;
  }

  learnRequest(args = {}) {
    return this.host.learning.create(args);
  }

  async learnRun(args = {}) {
    return this.host.learning.run(args.taskId, {
      heavy: args.heavy !== false
    });
  }

  skillList() {
    return { success: true, skills: this.host.skills.list() };
  }

  skillLoad(name) {
    return this.host.skills.load(name);
  }

  skillResource(name, resourcePath) {
    return this.host.skills.readResource(name, resourcePath);
  }

  handlers() {
    return {
      learn_request: (args) => this.learnRequest(args),
      learn_run: (args) => this.learnRun(args),
      skill_list: () => this.skillList(),
      skill_load: (args) => this.skillLoad(args.name),
      skill_resource: (args) => this.skillResource(args.name, args.path)
    };
  }
}

module.exports = { LearningTools };
