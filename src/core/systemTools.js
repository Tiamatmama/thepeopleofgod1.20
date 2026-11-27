// 系统运维与联网工具：自查 / 运行时状态 / 完整性 / 日志 / 服务启停 / 文件读写删 / 联网检索抓取。
// 从 ToolRegistry 拆出的执行体，host 为 ToolRegistry 实例；底层能力（codeIntegrity、
// processManager、readLogTail、webSearch 等）仍留在 host 上，这里只做编排。
class SystemTools {
  constructor(host) {
    this.host = host;
  }

  generateCodeSignature() {
    const data = this.host.codeIntegrity.generateSignature();
    return { success: true, totalFiles: data.totalFiles, created: data.created };
  }

  readSystemLog(lines) {
    return { log: this.host.readLogTail(lines) };
  }

  handlers() {
    const host = this.host;
    return {
      system_self_check: () => host.selfCheck(),
      get_runtime_status: () => host.getRuntimeStatus(),
      check_critical_files: () => host.codeIntegrity.checkCriticalFiles(),
      verify_code_integrity: () => host.verifyIntegritySummary(),
      generate_code_signature: () => this.generateCodeSignature(),
      read_system_log: (args) => this.readSystemLog(args.lines),
      start_service: () => host.processManager.startServer(),
      stop_service: () => host.processManager.stopServer(),
      write_file: (args) => host.writeFile(args.path, args.content),
      read_file: (args) => host.readFile(args.path),
      delete_file: (args) => host.deleteFile(args.path),
      web_search: (args) => host.webSearch(args.query, args.count),
      fetch_url: (args) => host.fetchUrl(args.url, args.maxChars)
    };
  }
}

module.exports = { SystemTools };
