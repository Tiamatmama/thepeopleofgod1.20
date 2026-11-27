'use strict';

// 独立硬件通道的命令行入口。不会被角色/沙箱加载，也不注册到工具表。

const fs = require('fs');
const path = require('path');
const { buildFromSpec } = require('./build');
const { createHardwareService, listSpecs, summarizeBuild } = require('./service');

function usage() {
  console.log('用法:');
  console.log('  node hardware/model/cli.js build <spec.json>');
  console.log('  node hardware/model/cli.js list');
  console.log('  node hardware/model/cli.js serve');
}

const [command, argument] = process.argv.slice(2);

if (command === 'build') {
  if (!argument) {
    usage();
    process.exitCode = 1;
  } else {
    try {
      const spec = JSON.parse(fs.readFileSync(path.resolve(argument), 'utf8'));
      console.log(JSON.stringify(summarizeBuild(buildFromSpec(spec)), null, 2));
    } catch (error) {
      console.error(`[硬件通道] 构建失败: ${error.message}`);
      process.exitCode = 1;
    }
  }
} else if (command === 'list') {
  console.log(JSON.stringify({ ok: true, parts: listSpecs() }, null, 2));
} else if (command === 'serve') {
  const port = Number(process.env.HARDWARE_MODEL_PORT) || 41900;
  const token = String(process.env.HARDWARE_MODEL_TOKEN || '').trim();
  const server = createHardwareService({ token });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[硬件通道] http://127.0.0.1:${port}  鉴权: ${token ? 'Bearer' : '关闭'}`);
    console.log('[硬件通道] 不接入角色、QQ、B 站或编程沙箱');
  });
} else {
  usage();
  process.exitCode = command ? 1 : 0;
}
