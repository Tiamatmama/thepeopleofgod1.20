// 统一的 .env 加载入口：全项目只在仓库根目录放一份 .env，
// 各模块（含 scripts/ 与 src/ 下若干子模块）改为 require 本文件，避免
// 到处重复写 require('dotenv').config({ path: ... }) 引起的路径漂移。
// dotenv 默认不覆盖已存在的环境变量，且重复调用幂等，因此这里在模块首次
// 被 require 时执行一次即可，后续 require 命中缓存不会重复加载。
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
