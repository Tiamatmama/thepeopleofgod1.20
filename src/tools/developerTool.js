const fs = require('fs');
const path = require('path');

class DeveloperTool {
  constructor() {
    this.logFile = path.join(__dirname, 'developer.log');
    this.lastOutputTime = Date.now();
    this.initializeLog();
  }

  // 初始化日志文件
  initializeLog() {
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, '情感中枢系统 - 开发者日志\n\n');
    }
  }

  // 记录发送的内容
  logSendData(data) {
    const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleString() : '未提供';
    const logEntry = `[${new Date().toLocaleString()}] 发送数据:\n` +
                    `类型: ${data.type}\n` +
                    `内容: ${data.data}\n` +
                    `时间戳: ${timestamp}\n\n`;
    
    fs.appendFileSync(this.logFile, logEntry);
    console.log(`[开发者工具] 记录发送数据: ${data.data.substring(0, 50)}...`);
  }

  // 记录接收的内容
  logReceiveData(data) {
    this.lastOutputTime = Date.now();
    const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleString() : '未提供';
    const logEntry = `[${new Date().toLocaleString()}] 接收数据:\n` +
                    `类型: ${data.type}\n` +
                    `内容: ${data.data || JSON.stringify(data)}\n` +
                    `情绪: ${JSON.stringify(data.emotion)}\n` +
                    `关系: ${JSON.stringify(data.relationship)}\n` +
                    `时间戳: ${timestamp}\n\n`;
    
    fs.appendFileSync(this.logFile, logEntry);
    console.log(`[开发者工具] 记录接收数据`);
  }
  
  // 获取上次输出时间
  getLastOutputTime() {
    return this.lastOutputTime;
  }

  // 查看日志
  viewLog() {
    if (fs.existsSync(this.logFile)) {
      const content = fs.readFileSync(this.logFile, 'utf8');
      console.log('=== 开发者日志 ===');
      console.log(content);
      console.log('=== 日志结束 ===');
    } else {
      console.log('日志文件不存在');
    }
  }

  // 清空日志
  clearLog() {
    fs.writeFileSync(this.logFile, '情感中枢系统 - 开发者日志\n\n');
    console.log('日志已清空');
  }

  // 获取日志大小
  getLogSize() {
    if (fs.existsSync(this.logFile)) {
      const stats = fs.statSync(this.logFile);
      return stats.size;
    }
    return 0;
  }
}

// 导出模块
module.exports = DeveloperTool;

// 如果直接运行此文件
if (require.main === module) {
  const devTool = new DeveloperTool();
  
  // 查看日志
  devTool.viewLog();
  
  // 示例：记录发送数据
  // devTool.logSendData({
  //   type: 'text',
  //   data: '你好，很高兴认识你',
  //   timestamp: Date.now()
  // });
  
  // 示例：记录接收数据
  // devTool.logReceiveData({
  //   emotion: { type: 'happy', intensity: 0.8 },
  //   relationship: { stage: 'STRANGER', score: 0 },
  //   timestamp: Date.now()
  // });
}