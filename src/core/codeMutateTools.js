const fs = require('fs');
const path = require('path');

// 代码写入类工具：code_write / code_apply_patch / code_write_file。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；工作区解析、读取追踪
// （noteFileRead / fileStale）与测试目录保护仍留在 host 上，这里只做编排。
class CodeMutateTools {
  constructor(host) {
    this.host = host;
  }

  // 写代码工作台：按后缀推断语言（.js → node，其余 → python）
  codeWrite(args = {}) {
    const host = this.host;
    const name = String(args.name || '').trim();
    if (!name) return { success: false, error: '缺少 name 参数：脚本文件名' };
    const language = path.extname(name).toLowerCase() === '.js' ? 'node' : 'python';
    const code = String(args.code || '');
    const result = host.coding.resolveWorkspaceScript(name, language, code);
    // 扁平脚本沙箱也要留痕：它没有 taskId，路径前缀 workspace/ 以示与 git 工作区区分
    if (result && result.success) {
      host.coding.recordFileChange({
        userId: host.codingUserId(args),
        taskId: '',
        runId: (host.activeContext && host.activeContext.runId) || args.runId || '',
        path: `workspace/${path.basename(name)}`,
        action: 'write',
        afterBytes: Buffer.byteLength(code, 'utf8')
      });
    }
    return result;
  }

  codeApplyPatch(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const resolved = host.coding.resolveInWorkspace(userId, args.taskId, args.path);
    if (!resolved.success) return resolved;
    if (host.isProtectedTestPath(args.path, resolved.rel)) {
      return { success: false, error: `禁止改动测试目录（${resolved.rel}）：验收标准由人来定，不能靠改测试“跑通”` };
    }
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!edits.length) return { success: false, error: '缺少 edits：至少要有一块 { oldText, newText }' };
    let original;
    try {
      if (!fs.existsSync(resolved.path)) return { success: false, error: `文件不存在: ${resolved.rel}` };
      original = fs.readFileSync(resolved.path, 'utf8');
    } catch (error) {
      return { success: false, error: `读取失败: ${error.message}` };
    }
    const stale = host.fileStale(resolved.taskId, resolved.rel, resolved.path);
    if (stale) return { success: false, ...stale };
    let content = original;
    const applied = [];
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i] || {};
      const oldText = String(edit.oldText == null ? '' : edit.oldText);
      const newText = String(edit.newText == null ? '' : edit.newText);
      if (!oldText) return { success: false, error: `第 ${i + 1} 块缺少 oldText（已中止，未改动文件）` };
      const count = content.split(oldText).length - 1;
      if (count === 0) return { success: false, error: `第 ${i + 1} 块 oldText 在文件中未命中（已中止，未改动文件）` };
      if (count > 1 && !edit.replaceAll) {
        return { success: false, error: `第 ${i + 1} 块 oldText 命中 ${count} 次，不唯一：请补足上下文或设 replaceAll:true` };
      }
      content = edit.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      applied.push({ index: i + 1, replacements: edit.replaceAll ? count : 1 });
    }
    try {
      fs.writeFileSync(resolved.path, content, 'utf8');
    } catch (error) {
      return { success: false, error: `写回失败: ${error.message}` };
    }
    host.noteFileRead(resolved.taskId, resolved.rel, resolved.path);
    // 文件历史：自己记账（路径/时间/动作/字节），不依赖 git
    host.coding.recordFileChange({
      userId,
      taskId: resolved.taskId,
      runId: (host.activeContext && host.activeContext.runId) || args.runId || '',
      path: resolved.rel,
      action: 'patch',
      beforeBytes: Buffer.byteLength(original, 'utf8'),
      afterBytes: Buffer.byteLength(content, 'utf8')
    });
    return {
      success: true,
      taskId: resolved.taskId,
      path: resolved.rel,
      applied,
      beforeBytes: Buffer.byteLength(original, 'utf8'),
      afterBytes: Buffer.byteLength(content, 'utf8')
    };
  }

  // 从零建文件：code_apply_patch 只能改已存在的文件，这里补上「新建 + 建目录」
  codeWriteFile(args = {}) {
    const host = this.host;
    const userId = host.codingUserId(args);
    const taskId = String(args.taskId || '').trim();
    if (!taskId) return { success: false, error: '缺少 taskId 参数' };
    const resolved = host.coding.resolveInWorkspace(userId, taskId, args.path);
    if (!resolved.success) return resolved;
    if (host.isProtectedTestPath(args.path, resolved.rel)) {
      return { success: false, error: `禁止改动测试目录（${resolved.rel}）：验收标准由人来定，不能靠改测试“跑通”` };
    }
    const content = String(args.content == null ? '' : args.content);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 1024 * 1024) {
      return { success: false, error: `内容 ${bytes} 字节，超过单文件 1MB 上限` };
    }
    const existed = fs.existsSync(resolved.path);
    if (existed) {
      if (fs.statSync(resolved.path).isDirectory()) {
        return { success: false, error: `目标是目录: ${resolved.rel}` };
      }
      if (!args.overwrite) {
        return { success: false, error: `文件已存在: ${resolved.rel}；如需覆盖请设 overwrite:true，或改用 code_apply_patch` };
      }
      const stale = host.fileStale(taskId, resolved.rel, resolved.path);
      if (stale) return { success: false, ...stale };
    } else {
      fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    }
    const beforeBytes = existed ? fs.statSync(resolved.path).size : null;
    fs.writeFileSync(resolved.path, content, 'utf8');
    host.noteFileRead(taskId, resolved.rel, resolved.path);
    host.coding.recordFileChange({
      userId,
      taskId,
      runId: (host.activeContext && host.activeContext.runId) || args.runId || '',
      path: resolved.rel,
      action: existed ? 'overwrite' : 'create',
      beforeBytes,
      afterBytes: bytes
    });
    return { success: true, taskId, path: resolved.rel, bytes, created: !existed };
  }

  handlers() {
    // code_apply_patch / code_write_file 沿用 execute 里的「写后自动语法诊断」包装，
    // 保证从 switch 迁到处理器表后行为等价。
    return {
      code_write: (args) => this.codeWrite(args),
      code_apply_patch: (args) => this.host.withAutoDiagnose(this.codeApplyPatch(args), args),
      code_write_file: (args) => this.host.withAutoDiagnose(this.codeWriteFile(args), args)
    };
  }
}

module.exports = { CodeMutateTools };
