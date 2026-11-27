// 编程任务板工具：coding_task_list / coding_task_add / coding_task_update。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；任务板（host.coding）
// 仍由 host 提供，这里只做编排。
class CodingTaskTools {
  constructor(host) {
    this.host = host;
  }

  codingTaskList(args = {}) {
    return this.host.coding.listTasks(args.status);
  }

  codingTaskAdd(args = {}) {
    return this.host.coding.addTask(args);
  }

  codingTaskUpdate(args = {}) {
    return this.host.coding.updateTask(String(args.id || ''), args);
  }

  handlers() {
    return {
      coding_task_list: (args) => this.codingTaskList(args),
      coding_task_add: (args) => this.codingTaskAdd(args),
      coding_task_update: (args) => this.codingTaskUpdate(args)
    };
  }
}

module.exports = { CodingTaskTools };
