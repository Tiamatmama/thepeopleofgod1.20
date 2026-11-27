'use strict';

// 通道装配层（Composition Root 的下一级）：
// 「在哪说话」各走各的运行时——角色 / 互动 / 沙箱 / QQ / B站，
// 每个运行时有自己的会话库、输出模块实例、场景提示与工具策略；
// 但情绪、记忆、好感度、CIDE 仍只有器官层那一份真值，运行时只读消费、不回写。
// 对应哲学：哲学设计-交接 §1「器官层唯一持有状态」+ §2 不变量一「只读派生优于回写」。
//
// 这条线解决的耦合：
//   1) QQ 原先在 bridge.js 里 require 阶段自建一套 SessionManager/OutputModule，装配藏在路由文件里；
//   2) 沙箱（codingLoop / 竞赛评委）与角色对话共用同一个 OutputModule 实例，工具上下文与快照缓存互相踩；
//   3) 网页「用户↔角色互动」没有自己的场景与工具策略，和角色自主生活共用一条出口。

const path = require('path');
const OutputModule = require('../core/output');
const SessionManager = require('../session/sessionManager');
const PrivateLife = require('../core/privateLife');
const { getTimeline } = require('../core/timeline');

// 运行时种类：只用于标识与日志，不参与权限判定
const RUNTIME_KIND = Object.freeze({
  ROLE: 'role',
  INTERACTION: 'interaction',
  SANDBOX: 'sandbox',
  QQ: 'qq',
  BILI: 'bili',
  CREATIVE: 'creative'
});

// 场景提示直接拼接在系统提示词末尾（output.generateOutputAsync 的 sceneHint）。
// 互动场景要说清「这是网页一对一」，否则角色会把网页当成 QQ 群或直播弹幕。
const SCENE_PROMPT = Object.freeze({
  interaction: '\n【当前场景】你正在网页上和对方一对一说话，同一块屏幕、面对面；不用报家门，也不用解释自己在用工具。'
});

// 建一个运行时描述对象：字段固定，路由只认字段不认实现
function createRuntime({
  kind,
  sessionManager,
  outputModule,
  privateLife = null,
  scenePrompt = '',
  scope = 'role',
  ownsSession = false
}) {
  // 🧭 稳定偏移观测的「场景」标签：每个运行时一套输出实例，实例上打上自己这条通道的名字。
  // 只有拿到这个标签，判据才分得清「同一处偏移是不是换了个地方也照旧」——这不是新能力，
  // 只是把已经存在的「在哪说话」补给它（观测层，默认不改提示词）
  // 🕰️ 时间线通道标签 + 实例：网页对话记 message.in/out，QQ/B站/沙箱由各自必经点决定记不记
  if (outputModule) {
    outputModule.timeline = getTimeline();
    if (kind) outputModule.timelineChannel = kind;
    if (kind) outputModule.deviationChannel = kind;
  }
  return {
    kind,
    sessionManager,
    outputModule,
    privateLife,
    scenePrompt,
    scope,
    // ownsSession=false 表示会话库与别的运行时共用（互动与角色共享同一份历史，才接得上话）
    ownsSession
  };
}

// 所有运行时共用同一批器官：这里只负责 new 输出层，不 new 器官
function buildOutputModule(deps, sessionManager, privateLife) {
  const { memoryModule, cideEngine, toolRegistry, appointmentBook, emotionModule } = deps;
  return new OutputModule(
    memoryModule,
    sessionManager,
    cideEngine,
    toolRegistry,
    appointmentBook,
    emotionModule,
    privateLife
  );
}

// 归档串行链：溢出旧对话 → 滚动摘要 → 语义巩固 → 巩固期去重 → 自我模型。
// 每个自带会话库的运行时都要挂一次，否则聊得越多归档越堆、关系不沉淀。
function wireArchivePipeline(sessionManager, outputModule) {
  sessionManager.setArchiveHandler((payload) => outputModule.summarizeArchivedConversation(payload)
    .then(() => outputModule.consolidateUserMemories({ userId: payload && payload.userId }))
    .then(() => outputModule.dedupUserMemories({ userId: payload && payload.userId }))
    .then(() => outputModule.refreshSelfModel({ userId: payload && payload.userId, sessionId: payload && payload.sessionId })));
}

// 角色运行时：角色自己的那条线（自主发言 / 私生活 / 日程 / 人设资产）
function createRoleRuntime(deps) {
  const { sessionManager, privateLife } = deps;
  return createRuntime({
    kind: RUNTIME_KIND.ROLE,
    sessionManager,
    outputModule: buildOutputModule(deps, sessionManager, privateLife),
    privateLife,
    ownsSession: true
  });
}

// 互动运行时：用户↔角色这一刻的对话。
// 与角色运行时共用会话库（历史才连得上），但输出模块实例、场景提示独立；
// 器官仍共享，所以这一轮的心情与记忆会自然影响角色自主开口，反之亦然。
function createInteractionRuntime(deps) {
  const { sessionManager, privateLife } = deps;
  return createRuntime({
    kind: RUNTIME_KIND.INTERACTION,
    sessionManager,
    outputModule: buildOutputModule(deps, sessionManager, privateLife),
    privateLife,
    scenePrompt: SCENE_PROMPT.interaction,
    ownsSession: false
  });
}

// 沙箱运行时：编程闭环 / 工人池 / Claude Code 执行器 / 竞赛评委。
// 只借器官读记忆与工具，不写情绪、不碰私生活、不下发好感度工具（由调用方 includeAffectionTool:false）。
function createSandboxRuntime(deps) {
  const { sessionManager } = deps;
  return createRuntime({
    kind: RUNTIME_KIND.SANDBOX,
    sessionManager,
    outputModule: buildOutputModule(deps, sessionManager, null),
    ownsSession: false
  });
}

// QQ 运行时：独立会话库（data/qq_sessions）+ 独立私生活 + 独立输出模块
function createQQRuntime(deps) {
  const dataRoot = deps.dataRoot || path.join(__dirname, '../../data');
  const sessionManager = new SessionManager({
    storagePath: path.join(dataRoot, 'qq_sessions'),
    archivePath: path.join(dataRoot, 'qq_archives'),
    // 同一个角色名对应多个 QQ，按名字去重会删掉别人的存档
    dedupeByName: false
  });
  const privateLife = new PrivateLife({
    timeline: getTimeline(),
    timelineScope: (userId) => deps.memoryModule.normalizeScopeKey(userId, 'role')
  });
  const outputModule = buildOutputModule(deps, sessionManager, privateLife);
  wireArchivePipeline(sessionManager, outputModule);
  return createRuntime({
    kind: RUNTIME_KIND.QQ,
    sessionManager,
    outputModule,
    privateLife,
    ownsSession: true
  });
}

// B 站直播运行时：每个观众一份独立会话（data/bili_sessions），与网页/QQ 存档分开
function createBiliRuntime(deps) {
  const dataRoot = deps.dataRoot || path.join(__dirname, '../../data');
  const sessionManager = new SessionManager({
    storagePath: path.join(dataRoot, 'bili_sessions'),
    archivePath: path.join(dataRoot, 'bili_archives'),
    dedupeByName: false
  });
  return createRuntime({
    kind: RUNTIME_KIND.BILI,
    sessionManager,
    outputModule: buildOutputModule(deps, sessionManager, null),
    ownsSession: true
  });
}

// 创意世界场景：进入界面时才拼进来的技能白名单。
// 三级渐进披露的本意是「常驻只放元数据」，所以这里只拼 name + description，
// 完整做法仍由 skill_load 按需取；白名单外的技能（debugging / security-audit 等）不进来，免得干扰。
const CREATIVE_SKILL_WHITELIST = Object.freeze(['brainstorming', 'innovation-team', 'api-design']);

function buildCreativeScenePrompt(skills) {
  const lines = [
    '\n【当前场景】你正在网页的「自由创意世界」里和对方一起搭东西：',
    '界面是一张 24×24 的等距棋盘，方块只用纯色加明暗两档表示，不追求贴图精度。',
    '用 world_place / world_remove 直接改世界，用 world_snapshot 看当前构图与评分。',
    '动手前先想清楚要表达什么，再一小块一小块地放；别一次糊满整片地，也别反复重建。'
  ];
  if (skills && typeof skills.list === 'function') {
    const list = (() => {
      try {
        return skills.list();
      } catch {
        return [];
      }
    })();
    const allowed = list.filter((item) => {
      const name = String(item.name || '').toLowerCase();
      const dirName = String(item.dirName || '').toLowerCase();
      return CREATIVE_SKILL_WHITELIST.includes(name) || CREATIVE_SKILL_WHITELIST.includes(dirName);
    });
    if (allowed.length) {
      lines.push('本场景预装的技能包（需要具体做法时用 skill_load 取完整指令）：');
      allowed.forEach((item) => lines.push(`  - ${item.name}：${item.description || ''}`));
    }
  }
  return lines.join('\n');
}

// 创意世界运行时：与沙箱一样只借器官，不写情绪、不碰私生活；
// 会话库与互动共用（打开界面聊的话能接上），技能清单在进界面时拼进场景提示。
function createCreativeRuntime(deps) {
  const { sessionManager, toolRegistry } = deps;
  return createRuntime({
    kind: RUNTIME_KIND.CREATIVE,
    sessionManager,
    outputModule: buildOutputModule(deps, sessionManager, null),
    scenePrompt: buildCreativeScenePrompt(toolRegistry && toolRegistry.skills),
    ownsSession: false
  });
}

module.exports = {
  RUNTIME_KIND,
  SCENE_PROMPT,
  CREATIVE_SKILL_WHITELIST,
  buildCreativeScenePrompt,
  createRoleRuntime,
  createInteractionRuntime,
  createSandboxRuntime,
  createCreativeRuntime,
  createQQRuntime,
  createBiliRuntime
};
