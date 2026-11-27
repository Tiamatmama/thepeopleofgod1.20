'use strict';

// 自由创意世界工具：world_place / world_remove / world_snapshot / world_clear / world_open_page。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；世界状态（host.creativeWorld）
// 与打开浏览器（host.runCommand）仍由 host 提供，这里只做编排。

class CreativeTools {
  constructor(host) {
    this.host = host;
  }

  world() {
    const world = this.host.creativeWorld;
    if (!world) {
      return { success: false, error: '创意世界未装配' };
    }
    return world;
  }

  worldPlace(args = {}) {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.place(args);
  }

  worldRemove(args = {}) {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.remove(args);
  }

  worldSnapshot() {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.snapshot();
  }

  worldClear() {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.clear();
  }

  worldMoveCharacter(args = {}) {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.moveCharacter(args);
  }

  worldSay(args = {}) {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.say(args);
  }

  worldPay(args = {}) {
    const world = this.world();
    if (!world.snapshot) return world;
    return world.pay(args);
  }

  async worldOpenPage() {
    const port = process.env.SERVER_PORT || '41888';
    const url = `http://localhost:${port}/creative.html`;
    // start 是 cmd 内建命令，runCommand 走 shell 正好能用
    const result = await this.host.runCommand(`start "" "${url}"`, undefined, 10000, { hostOnly: true });
    return Object.assign({}, result, { opened: url });
  }

  handlers() {
    return {
      world_place: (args) => this.worldPlace(args),
      world_remove: (args) => this.worldRemove(args),
      world_snapshot: () => this.worldSnapshot(),
      world_clear: () => this.worldClear(),
      world_move_character: (args) => this.worldMoveCharacter(args),
      world_say: (args) => this.worldSay(args),
      world_pay: (args) => this.worldPay(args),
      world_open_page: () => this.worldOpenPage()
    };
  }
}

module.exports = { CreativeTools };
