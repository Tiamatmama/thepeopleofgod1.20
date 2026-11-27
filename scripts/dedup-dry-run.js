// 🧪 巩固期去重合并 dry-run（方向一②）：读本地 data/user_memories/*.json，**只读不写**，
// 打印「若执行去重合并，哪些记忆会被合并成一条」的报告。
// 起步形态 exact：只合「归一化正文完全重复」的条目（经 4 设定人格 + 编程沙箱两轮评审确定）；
// 阈值型模糊合并暂时挂起。用于正式接入写路径前先看真实数据效果——本脚本不会改动任何记忆。
// 用法：node scripts/dedup-dry-run.js
const fs = require('fs');
const path = require('path');
const { planDedupMerge } = require('../src/core/memoryConsolidation');

const dir = path.join(__dirname, '..', 'data', 'user_memories');

// 载入所有用户记忆档（跳过 .bak/隔离文件——它们不以 .json 结尾）
function loadStores() {
  if (!fs.existsSync(dir)) return [];
  const stores = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json') || file.includes('.bak')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      stores.push({
        key: file.replace(/\.json$/, ''),
        memories: Array.isArray(data.memories) ? data.memories : []
      });
    } catch (error) {
      console.warn(`[skip] 解析失败 ${file}: ${error.message}`);
    }
  }
  return stores;
}

let totalMemories = 0;
let totalGroups = 0;
let totalMerged = 0;

console.log('=== 去重合并 dry-run（exact：归一化正文完全相同，只读不写）===');
for (const { key, memories } of loadStores()) {
  totalMemories += memories.length;
  if (memories.length === 0) continue;

  // 逐档调用：storeKey 进分桶键，保证跨档（跨用户/跨分区）绝不合并
  const groups = planDedupMerge(memories, null, { storeKey: key });

  console.log(`\n--- ${key}（${memories.length} 条记忆）---`);
  if (groups.length === 0) {
    console.log('  无「归一化正文完全重复」的条目，无需合并');
    continue;
  }
  totalGroups += groups.length;
  for (const group of groups) {
    totalMerged += group.mergeIds.length;
    const polarity = String(group.groupKey).split('\u0000')[1] || '';
    console.log(`  [exact·极性 ${polarity}] ${group.size} 条完全相同 → 保留 ${group.keepId}`
      + `（合并后 recallCount=${group.mergedWeight.recallCount}, salience=${group.mergedWeight.salience}）`);
    for (const sample of group.samples) {
      const mark = sample.id === group.keepId ? '留存' : '并入';
      console.log(`      ${mark}  ${sample.id}  ${sample.text}`);
    }
  }
}

console.log(`\n汇总：扫描 ${totalMemories} 条记忆，命中 ${totalGroups} 个可合并组，预期减少 ${totalMerged} 条（dry-run，未写入任何数据）`);
