// 编程团队工具：team_discuss / team_review。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；团队实例（host.codingTeam）
// 由服务端注入，未注入时给明确回话而不是抛异常。
class TeamTools {
  constructor(host) {
    this.host = host;
  }

  async teamDiscuss(args = {}) {
    const host = this.host;
    if (!host.codingTeam) {
      return { success: false, error: '编程团队没接上（服务端未注入 CodingTeam）' };
    }
    try {
      return await host.codingTeam.discuss({
        topic: args.topic,
        context: args.context,
        personaIds: args.personaIds,
        rounds: args.rounds,
        sessionId: host.activeContext ? host.activeContext.sessionId : ''
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async teamReview(args = {}) {
    const host = this.host;
    if (!host.codingTeam) {
      return { success: false, error: '编程团队没接上（服务端未注入 CodingTeam）' };
    }
    try {
      return await host.codingTeam.review({
        target: args.target,
        kind: args.kind,
        personaIds: args.personaIds,
        sessionId: host.activeContext ? host.activeContext.sessionId : ''
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  handlers() {
    return {
      team_discuss: (args) => this.teamDiscuss(args),
      team_review: (args) => this.teamReview(args)
    };
  }
}

module.exports = { TeamTools };
