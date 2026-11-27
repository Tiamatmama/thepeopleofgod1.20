const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 画板坐标系与前端 board-canvas 一致（public/index.html 里 BOARD_W / BOARD_H）
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 750;

// 陪伴与感知类工具：会话历史 / 归档 / 背景权重 / 记忆钉住 / 日记约定 / 进化诉求 /
// 出声 / 视觉与屏幕感知 / 机器狗动作 / 劫持排查 / 画板。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；会话、记忆、TTS、摄像头、
// 屏幕与设备链路等能力仍由 host 注入，这里只做编排。
class AssistantTools {
  constructor(host) {
    this.host = host;
  }

  // 让模型按需拉取与当前用户的过往对话（在场记录 + 已归档的早期原文）
  searchChatHistory(args = {}) {
    const host = this.host;
    if (!host.sessionManager) {
      return { success: false, error: '当前没有可检索的会话历史' };
    }
    const context = host.activeContext;
    if (!context) {
      return { success: false, error: '当前对话没有绑定会话，无法检索历史' };
    }

    const result = host.sessionManager.searchHistory(context.sessionId, context.userId, args);
    if (!result || result.returned === 0) {
      return { success: true, message: '没有检索到相关的历史对话', scope: args.scope || 'all', messages: [] };
    }
    return { success: true, ...result };
  }

  // 模型自己按类型归档一条内容：写角色自己的归档文件，免人工授权
  archiveMessage(args = {}) {
    const host = this.host;
    if (!host.sessionManager) {
      return { success: false, error: '当前没有可用的归档空间' };
    }
    const context = host.activeContext;
    if (!context) {
      return { success: false, error: '当前对话没有绑定会话，无法归档' };
    }

    const entry = host.sessionManager.writeArchiveEntry(context.sessionId, context.userId, args);
    if (!entry) {
      return { success: false, error: '归档失败：内容为空或写入出错' };
    }
    return { success: true, id: entry.id, type: entry.type, content: entry.content };
  }

  // 角色自己调「背景设定」的权重：写回当前会话的角色配置，免授权
  // 只动 backgroundWeight 一个字段，name/age/personality 始终满权重，改权重不会让她忘了自己是谁
  adjustBackgroundWeight(args = {}) {
    const host = this.host;
    if (!host.sessionManager) {
      return { success: false, error: '当前没有可用的会话，改不了自己的配置' };
    }
    const context = host.activeContext;
    if (!context) {
      return { success: false, error: '当前对话没有绑定会话，改不了自己的配置' };
    }
    const raw = Number(args.weight);
    if (!Number.isFinite(raw)) {
      return { success: false, error: 'weight 需要是 0~1 之间的数字' };
    }
    const weight = Math.min(1, Math.max(0, raw));
    const session = host.sessionManager.updateSession(context.sessionId, { backgroundWeight: weight });
    if (!session) {
      return { success: false, error: '找不到当前会话，改不了自己的配置' };
    }
    return {
      success: true,
      backgroundWeight: weight,
      reason: args.reason ? String(args.reason) : '',
      note: `已把你自己的背景权重调到 ${weight}（1=完整注入，越低越只作氛围参考）。下一轮开始生效。`
    };
  }

  // AI 态专属：看一眼摄像头前的画面（看不看由她自己决定，受伪开发者设的最小间隔节流）
  async lookAtUser(args = {}) {
    const host = this.host;
    if (!host.isAiScope()) {
      return { success: false, error: '这是 AI 态才有的能力，这一轮是角色态，看不到摄像头' };
    }
    if (!host.cameraController) {
      return { success: false, error: '摄像头通道没有接上（服务端未启用）' };
    }
    const userId = host.activeContext ? host.activeContext.userId : 'default';
    const scope = host.activeContext ? host.activeContext.scope : 'role';
    return await host.cameraController.look({ userId, question: args.question || '', scope });
  }

  // AI 态专属：翻阅自己的图片记忆（只有文字总结与原图路径）
  recallVisionMemory(args = {}) {
    const host = this.host;
    if (!host.isAiScope()) {
      return { success: false, error: '这是 AI 态才有的能力，这一轮是角色态，翻不到图片记忆' };
    }
    if (!host.cameraController) {
      return { success: false, error: '图片记忆通道没有接上（服务端未启用）' };
    }
    const userId = host.activeContext ? host.activeContext.userId : 'default';
    return host.cameraController.recallMemories(userId, { keyword: args.keyword || '', limit: args.limit });
  }

  // AI 态专属：看一眼他电脑的屏幕（抓完只留文字，原图不落盘；受伪开发者设的最小间隔节流）
  async lookAtScreen(args = {}) {
    const host = this.host;
    if (!host.isAiScope()) {
      return { success: false, error: '这是 AI 态才有的能力，这一轮是角色态，看不到屏幕' };
    }
    if (!host.screenController) {
      return { success: false, error: '屏幕通道没有接上（服务端未启用）' };
    }
    const userId = host.activeContext ? host.activeContext.userId : 'default';
    const scope = host.activeContext ? host.activeContext.scope : 'role';
    return await host.screenController.look({ userId, question: args.question || '', scope });
  }

  // AI 态专属：翻阅自己的屏幕记忆（只有文字总结与时间）
  recallScreenMemory(args = {}) {
    const host = this.host;
    if (!host.isAiScope()) {
      return { success: false, error: '这是 AI 态才有的能力，这一轮是角色态，翻不到屏幕记忆' };
    }
    if (!host.screenController) {
      return { success: false, error: '屏幕记忆通道没有接上（服务端未启用）' };
    }
    const userId = host.activeContext ? host.activeContext.userId : 'default';
    return host.screenController.recallMemories(userId, { keyword: args.keyword || '', limit: args.limit });
  }

  // 确认语里回给模型看的记忆摘要：太长就截断，避免把整条记忆又原样吐回上下文
  memorySnippet(text, max = 60) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  // 让模型把某条长期记忆钉住（DB-4）：钉住的记忆豁免衰减/归档/淘汰/强化改写。
  // owner 与分区从 activeContext 运行时取，不接受模型传用户 id（防止提示注入把别人的记忆钉住）；
  // 关键词唯一命中才落动作，多命中只回候选让模型再挑，不擅自钉
  pinMemory(args = {}) {
    const host = this.host;
    if (!host.memory) {
      return { success: false, error: '记忆模块没有接上（服务端未启用）' };
    }
    const context = host.activeContext;
    if (!context) {
      return { success: false, error: '当前对话没有绑定用户，钉不了记忆' };
    }
    const key = host.memory.normalizeScopeKey(context.memoryUserId || context.userId, context.scope);

    // 带 memoryId：直接钉这一条（只认当前用户/分区里的，越界找不到就拒绝）
    const memoryId = args.memoryId != null ? String(args.memoryId).trim() : '';
    if (memoryId) {
      const target = host.memory.getMemoryById(key, memoryId);
      if (!target) {
        return { success: false, error: '没找到这条记忆（编号不属于当前对话的记忆）' };
      }
      if (!host.memory.setMemoryPinned(key, target.id, true)) {
        return { success: false, error: '记忆落盘失败，这次钉住没有生效，请稍后再试' };
      }
      return {
        success: true,
        pinned: true,
        memoryId: String(target.id),
        message: `已把这条记忆钉住，往后衰减、归档、淘汰都不会再动它：${this.memorySnippet(target.data)}`
      };
    }

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { success: false, error: '缺少 query：要钉住哪条记忆，给一个能定位它的关键词' };
    }
    const matches = host.memory.findMemoriesByKeyword(key, query, 5);
    if (matches.length === 0) {
      return { success: false, error: `没有找到包含「${query}」的记忆，换个更贴近原话的关键词再试` };
    }
    if (matches.length > 1) {
      return {
        success: true,
        pinned: false,
        needChoice: true,
        message: `包含「${query}」的记忆不止一条，先看清是哪条，再带上它的 memoryId 重新调用就能钉住。`,
        candidates: matches.map((m) => ({
          memoryId: String(m.id),
          summary: this.memorySnippet(m.data),
          pinned: m.pinned
        }))
      };
    }
    const only = matches[0];
    if (only.pinned) {
      return {
        success: true,
        pinned: true,
        memoryId: String(only.id),
        message: `这条记忆本来就已经钉住了：${this.memorySnippet(only.data)}`
      };
    }
    if (!host.memory.setMemoryPinned(key, only.id, true)) {
      return { success: false, error: '记忆落盘失败，这次钉住没有生效，请稍后再试' };
    }
    return {
      success: true,
      pinned: true,
      memoryId: String(only.id),
      message: `已把这条记忆钉住（往后衰减、归档、淘汰都不会再动它）：${this.memorySnippet(only.data)}`
    };
  }

  // 解除钉住：与 pinMemory 对称，把某条记忆恢复成「照常参与生命周期」。
  // 同样只认当前用户/分区；多命中先给候选，不擅自解。
  unpinMemory(args = {}) {
    const host = this.host;
    if (!host.memory) {
      return { success: false, error: '记忆模块没有接上（服务端未启用）' };
    }
    const context = host.activeContext;
    if (!context) {
      return { success: false, error: '当前对话没有绑定用户，解不了钉' };
    }
    const key = host.memory.normalizeScopeKey(context.memoryUserId || context.userId, context.scope);

    // 带 memoryId：直接解这一条（只认当前用户/分区里的，越界找不到就拒绝）
    const memoryId = args.memoryId != null ? String(args.memoryId).trim() : '';
    if (memoryId) {
      const target = host.memory.getMemoryById(key, memoryId);
      if (!target) {
        return { success: false, error: '没找到这条记忆（编号不属于当前对话的记忆）' };
      }
      if (!host.memory.setMemoryPinned(key, target.id, false)) {
        return { success: false, error: '记忆落盘失败，这次解钉没有生效，请稍后再试' };
      }
      return {
        success: true,
        pinned: false,
        memoryId: String(target.id),
        message: `已解除钉住，往后它照常参与衰减、归档、淘汰：${this.memorySnippet(target.data)}`
      };
    }

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { success: false, error: '缺少 query：要解钉哪条记忆，给一个能定位它的关键词' };
    }
    const matches = host.memory.findMemoriesByKeyword(key, query, 5);
    if (matches.length === 0) {
      return { success: false, error: `没有找到包含「${query}」的记忆，换个更贴近原话的关键词再试` };
    }
    if (matches.length > 1) {
      return {
        success: true,
        pinned: false,
        needChoice: true,
        message: `包含「${query}」的记忆不止一条，先看清是哪条，再带上它的 memoryId 重新调用就能解钉。`,
        candidates: matches.map((m) => ({
          memoryId: String(m.id),
          summary: this.memorySnippet(m.data),
          pinned: m.pinned
        }))
      };
    }
    const only = matches[0];
    if (!only.pinned) {
      return {
        success: true,
        pinned: false,
        memoryId: String(only.id),
        message: `这条记忆本来就没有被钉住，无需解钉：${this.memorySnippet(only.data)}`
      };
    }
    if (!host.memory.setMemoryPinned(key, only.id, false)) {
      return { success: false, error: '记忆落盘失败，这次解钉没有生效，请稍后再试' };
    }
    return {
      success: true,
      pinned: false,
      memoryId: String(only.id),
      message: `已解除钉住（往后照常参与衰减、归档、淘汰）：${this.memorySnippet(only.data)}`
    };
  }

  // 与用户约定写日记的时间：只改调度，不代写正文。
  // 日记内容仍由角色到点自己写（见 core/diary.js），这里不接受任何正文参数
  scheduleDiary(args = {}) {
    const host = this.host;
    if (!host.diary) {
      return { success: false, error: '日记本没有接上（服务端未启用）' };
    }
    if (args.time === undefined && args.enabled === undefined) {
      return { success: false, error: '至少要给一个 time（HH:mm）或 enabled，才能改约定' };
    }
    return host.diary.setSchedule({ time: args.time, enabled: args.enabled });
  }

  // 🧬 进化诉求：只接受结构化提案，拒绝代码/路径等任意字段；不执行、不写代码
  requestEvolution(args = {}) {
    const host = this.host;
    if (!host.evolution) {
      return { success: false, error: '进化诉求通道没有接上（服务端未启用）' };
    }
    const result = host.evolution.submit({
      title: args.title,
      need: args.need,
      why: args.why,
      expected: args.expected,
      scope: args.scope,
      evidence: args.evidence,
      source: 'role'
    });
    if (!result.success) return result;
    return {
      success: true,
      id: result.id,
      status: result.status,
      mode: result.mode,
      requiresApproval: true,
      note: result.mode === 'live'
        ? '已记录并等待主人批准'
        : '已记录（shadow 模式，只作观察，不会排期）'
    };
  }

  // 出声：把一段话合成成自己的声音，再用 ffplay 在本机无窗口播出（不经过浏览器）
  // 只念自己的声音、不播音乐文件，也不改动任何东西，故不进审批名单
  async speak(text) {
    const host = this.host;
    if (!host.ttsModule) {
      return { success: false, error: '语音模块没接上，暂时出不了声' };
    }
    const content = String(text || '').trim();
    if (!content) return { success: false, error: '缺少 text 参数：要说的话不能是空的' };
    if (content.length > 1024) return { success: false, error: '一次最多念 1024 字，长的请分段说' };

    // 先把上一句掐掉，免得两句话叠在一起
    this.stopSpeak();

    const result = await host.ttsModule.synthesize(content, { voice: 'persona' });
    if (!result || !result.success) {
      return { success: false, error: (result && result.message) || '语音合成失败' };
    }

    const played = await this.startPlayback(result.audioPath);
    if (!played.success) return played;
    return {
      success: true,
      spoken: content.length > 60 ? `${content.slice(0, 60)}…` : content,
      voice: result.voiceName || 'persona',
      duration: result.duration,
      pid: played.pid
    };
  }

  // ffplay 无窗口播放一个音频文件；播完自己退出。Promise 只表示「有没有成功起播」
  startPlayback(audioPath) {
    const host = this.host;
    return new Promise((resolve) => {
      const file = path.resolve(String(audioPath || ''));
      if (!audioPath || !fs.existsSync(file)) {
        resolve({ success: false, error: `音频文件不存在: ${file}` });
        return;
      }
      const bin = process.env.FFPLAY_BIN || 'ffplay';
      let child;
      try {
        child = spawn(bin, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
      } catch (error) {
        resolve({ success: false, error: `启动播放器失败: ${error.message}` });
        return;
      }

      let settled = false;
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (host.activePlayback === child) host.activePlayback = null;
        resolve({ success: false, error: `找不到 ffplay（${bin}），无法出声: ${error.message}` });
      });
      child.on('exit', () => {
        if (host.activePlayback === child) host.activePlayback = null;
      });

      host.activePlayback = child;
      child.unref();
      // spawn 没有同步的成功信号：留一拍确认不是立刻失败，再认为起播成功
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: true, pid: child.pid });
      }, 400);
    });
  }

  stopSpeak() {
    const host = this.host;
    const child = host.activePlayback;
    if (!child) return { success: true, stopped: false, message: '现在没有在播的声音' };
    host.activePlayback = null;
    try {
      child.kill();
    } catch (error) {
      return { success: false, error: `停止播放失败: ${error.message}` };
    }
    return { success: true, stopped: true };
  }

  // 主动感知：动作之后或她自己想确认时，读一眼本体真实状态。
  // 只读不写，读不到就说读不到，不编一个「应该到位了」
  async checkBody() {
    const host = this.host;
    if (!host.deviceLink) {
      return { success: false, error: '设备链路没启动，读不到本体状态' };
    }
    const state = await host.deviceLink.observe();
    if (!state) {
      return { success: false, error: '本体不在线，这一眼没读到状态' };
    }
    return {
      success: true,
      state,
      summary: host.deviceLink.describeState(state)
    };
  }

  // 机器狗动作：只把动作名交给设备链路，原始指令由固件解释（串口帧 / PWM 序列 / 红外码都行）
  // 设备链路在子进程里，所以这里等 IPC 回来（失败时 client 已包装成 success:false）
  async robotAction(args = {}) {
    const host = this.host;
    if (!host.deviceLink) {
      return { success: false, error: '设备链路没启动，机器狗现在控制不了' };
    }
    return host.deviceLink.enqueue(args.action, { source: 'tool' });
  }

  // 劫持排查：看的是「有没有人往我们的启动流程里塞东西」——启动注入的环境变量、
  // 预加载参数、可疑的入口路径。只读，不改动系统
  async checkHijack() {
    const coldStart = require('./coldStart');
    const report = coldStart.inspectEnv();
    const alerts = report.alerts.map(item => `${item.label} = ${item.value}（${item.reason}）`);
    const traced = report.notes.map(item => `${item.label} = ${item.value}（${item.reason}）`);
    traced.push(`入口：${report.info.entry || '未知'}`);
    traced.push(`解释器：${report.info.execPath}`);
    traced.push(`工作目录：${report.info.cwd}（pid ${report.info.pid} / 父进程 ${report.info.ppid}）`);
    return {
      success: true,
      hijacked: report.hijacked,
      alertCount: report.alertCount,
      alerts,
      traced,
      hint: report.hijacked
        ? '上面每条告警里的值就是注入来源，可直接照此定位并清除'
        : '未发现启动注入：NODE_OPTIONS、Node 启动参数、入口路径都正常',
      exitCode: 0
    };
  }

  // 画板：把模型给的图形指令转成画板笔迹，经 emitter 推给前端实时落笔
  canvasDraw(args = {}) {
    const shapes = Array.isArray(args.shapes) ? args.shapes : [];
    if (!shapes.length) {
      return { success: false, error: '缺少 shapes 参数，没有要画的图形' };
    }
    const strokes = [];
    shapes.forEach((shape) => {
      strokes.push(...this.shapeToStrokes(shape));
    });
    if (!strokes.length) {
      return { success: false, error: '图形指令无效，没有生成任何笔迹' };
    }
    const delivered = this.host.emitCanvas({ action: 'draw', strokes });
    return {
      success: true,
      shapeCount: shapes.length,
      strokeCount: strokes.length,
      screenUpdated: delivered,
      note: delivered ? '笔迹已实时画到用户画板上' : '画板通道未连接，笔迹未上屏'
    };
  }

  canvasClear() {
    const delivered = this.host.emitCanvas({ action: 'clear', strokes: [] });
    return { success: true, screenUpdated: delivered };
  }

  // 单个图形指令 → 一到多条笔迹（沿用画板母本结构：{color, baseWidth, points:[{x,y,p,t}]}）
  shapeToStrokes(shape = {}) {
    if (!shape || typeof shape !== 'object') {
      return [];
    }
    const color = typeof shape.color === 'string' && shape.color.trim() ? shape.color.trim() : '#1a202c';
    const baseWidth = Number(shape.strokeWidth) > 0 ? Number(shape.strokeWidth) : 3;
    const type = String(shape.type || '').toLowerCase();

    if (type === 'line' || type === 'polyline') {
      const vertices = (Array.isArray(shape.points) ? shape.points : [])
        .map(item => Array.isArray(item) ? { x: item[0], y: item[1] } : { x: item && item.x, y: item && item.y })
        .filter(item => Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)));
      const stroke = this.buildStrokeFromVertices(vertices, color, baseWidth);
      return stroke ? [stroke] : [];
    }

    if (type === 'rect') {
      const x = Number(shape.x) || 0;
      const y = Number(shape.y) || 0;
      const width = Number(shape.width) || 0;
      const height = Number(shape.height) || 0;
      const stroke = this.buildStrokeFromVertices([
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
        { x, y }
      ], color, baseWidth);
      return stroke ? [stroke] : [];
    }

    if (type === 'circle') {
      const cx = Number(shape.cx) || 0;
      const cy = Number(shape.cy) || 0;
      const radius = Math.abs(Number(shape.r) || 0);
      if (radius <= 0) {
        return [];
      }
      const segments = Math.max(24, Math.min(96, Math.round(radius)));
      const vertices = [];
      for (let i = 0; i <= segments; i++) {
        const angle = (Math.PI * 2 * i) / segments;
        vertices.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
      }
      const stroke = this.buildStrokeFromVertices(vertices, color, baseWidth);
      return stroke ? [stroke] : [];
    }

    if (type === 'text') {
      const text = typeof shape.text === 'string' ? shape.text : '';
      if (!text.trim()) {
        return [];
      }
      const anchor = this.clampCanvasPoint(shape.x, shape.y);
      return [{
        color,
        baseWidth,
        startedAt: Date.now(),
        text,
        fontSize: Number(shape.fontSize) > 0 ? Number(shape.fontSize) : 32,
        points: [{ x: anchor.x, y: anchor.y, p: 0.6, t: 0 }]
      }];
    }

    return [];
  }

  clampCanvasPoint(x, y) {
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    return {
      x: Math.max(0, Math.min(CANVAS_WIDTH, px)),
      y: Math.max(0, Math.min(CANVAS_HEIGHT, py))
    };
  }

  // 顶点串 → 一条笔迹：相邻顶点间距过大时按固定步长插值，笔迹才连续、回放才自然
  buildStrokeFromVertices(vertices, color, baseWidth) {
    const points = [];
    vertices.forEach((vertex) => {
      const point = this.clampCanvasPoint(vertex.x, vertex.y);
      const previous = points[points.length - 1];
      if (previous) {
        const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
        const steps = distance > 8 ? Math.floor(distance / 8) : 0;
        for (let step = 1; step <= steps; step++) {
          const ratio = step / (steps + 1);
          points.push({
            x: previous.x + (point.x - previous.x) * ratio,
            y: previous.y + (point.y - previous.y) * ratio,
            p: 0.6,
            t: points.length * 16
          });
        }
      }
      points.push({ x: point.x, y: point.y, p: 0.6, t: points.length * 16 });
    });
    if (!points.length) {
      return null;
    }
    return { color, baseWidth, startedAt: Date.now(), points };
  }

  handlers() {
    return {
      check_hijack: (args) => this.checkHijack(args.pids),
      canvas_draw: (args) => this.canvasDraw(args),
      canvas_clear: () => this.canvasClear(),
      search_chat_history: (args) => this.searchChatHistory(args),
      archive_message: (args) => this.archiveMessage(args),
      adjust_background_weight: (args) => this.adjustBackgroundWeight(args),
      pin_memory: (args) => this.pinMemory(args),
      unpin_memory: (args) => this.unpinMemory(args),
      schedule_diary: (args) => this.scheduleDiary(args),
      request_evolution: (args) => this.requestEvolution(args),
      speak: (args) => (args.action === 'stop' ? this.stopSpeak() : this.speak(args.text)),
      robot_action: (args) => this.robotAction(args),
      check_body: () => this.checkBody(),
      look_at_user: (args) => this.lookAtUser(args),
      recall_vision_memory: (args) => this.recallVisionMemory(args),
      look_at_screen: (args) => this.lookAtScreen(args),
      recall_screen_memory: (args) => this.recallScreenMemory(args)
    };
  }
}

module.exports = { AssistantTools };
