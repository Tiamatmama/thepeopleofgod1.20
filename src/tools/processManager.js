const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 服务入口，用于判断「当前进程自己是不是那个服务」
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');

function isServerEntry(entry) {
  if (!entry) {
    return false;
  }
  return path.resolve(entry).toLowerCase() === path.resolve(SERVER_ENTRY).toLowerCase();
}

class ProcessManager {
  constructor() {
    this.serverProcess = null;
    this.logFile = path.join(__dirname, 'process.log');
  }

  // 启动服务器
  startServer() {
    return new Promise((resolve, reject) => {
      if (this.serverProcess) {
        return resolve({ success: true, message: '服务器已在运行' });
      }

      // 当前进程自己就是服务（手动 npm start 起的）：再 spawn 一个只会撞端口
      if (isServerEntry(process.argv[1])) {
        this.log('server', '服务已在本进程运行，跳过重复启动');
        return resolve({
          success: true,
          selfHosted: true,
          message: '服务器已在运行（当前进程就是服务，无需重复启动）'
        });
      }

      const serverPath = path.join(__dirname, '..', 'server', 'index.js');
      this.serverProcess = spawn('node', [serverPath], {
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      });

      this.serverProcess.stdout.on('data', (data) => {
        this.log('server', data.toString());
      });

      this.serverProcess.stderr.on('data', (data) => {
        this.log('server-error', data.toString());
      });

      this.serverProcess.on('close', (code) => {
        this.log('server', `服务器已退出，代码: ${code}`);
        this.serverProcess = null;
      });

      this.serverProcess.on('error', (error) => {
        this.log('server-error', `启动失败: ${error.message}`);
        this.serverProcess = null;
        reject({ success: false, message: `启动失败: ${error.message}` });
      });

      // 等待服务器启动
      setTimeout(() => {
        if (this.serverProcess) {
          this.log('server', '服务器启动成功');
          resolve({ success: true, message: '服务器启动成功' });
        }
      }, 2000);
    });
  }

  // 停止服务器
  stopServer() {
    return new Promise((resolve) => {
      if (!this.serverProcess) {
        // 当前进程自己就是服务：先把响应发回去，再延迟退出自己
        if (isServerEntry(process.argv[1])) {
          this.log('server', '当前进程即服务，准备退出');
          const timer = setTimeout(() => process.exit(0), 800);
          if (typeof timer.unref === 'function') {
            timer.unref();
          }
          return resolve({
            success: true,
            selfHosted: true,
            message: '服务器正在停止（当前进程即将退出）'
          });
        }
        return resolve({ success: true, message: '服务器未运行' });
      }

      this.serverProcess.kill();
      this.serverProcess = null;
      this.log('server', '服务器已停止');
      resolve({ success: true, message: '服务器已停止' });
    });
  }

  // 获取状态
  // 能执行到这里就说明服务是活的（本类只被服务进程自己 require）。
  // 旧实现只看 serverProcess，即「本类有没有亲手 spawn 子进程」，所以 npm start 手动起的服务
  // 永远报 serverRunning=false，角色就会误报「服务没在跑」。现在改为：
  // 当前进程就是服务入口（手动启动）或本类拉起过子进程，都算在跑。
  getStatus() {
    const selfHosted = isServerEntry(process.argv[1]);
    return {
      serverRunning: selfHosted || this.serverProcess !== null,
      selfHosted,
      childProcessManaged: this.serverProcess !== null
    };
  }

  // 日志记录
  log(prefix, message) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `[${timestamp}] [${prefix}] ${message}`;
    console.log(logEntry);
    
    try {
      fs.appendFileSync(this.logFile, logEntry + '\n');
    } catch (error) {
      console.error('写入日志失败:', error);
    }
  }

  // 停止所有进程
  stopAll() {
    return this.stopServer().then(() => ({ success: true, message: '所有进程已停止' }));
  }
}

module.exports = ProcessManager;