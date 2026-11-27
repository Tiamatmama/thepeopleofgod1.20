// 🧹 巩固期去重合并 执行器（方向一②）：把「归一化正文完全相同」的情景记忆合并成一条。
// 默认只读——不打 --yes 时只打印「将合并哪些」，零写入；确认无误后加 --yes 才动盘，且写前逐档备份。
// 起步形态 exact（contentHash）：只合完全重复的条目，极性相反/跨归属/pinned/系统条目一律不碰。
//
// 用法：
//   node scripts/dedup-apply.js                       # dry-run，全库只读看计划
//   node scripts/dedup-apply.js --scope <key> --yes   # 定点一个分区正式执行（写前备份 <key>.bak-<YYYY-MM-DD>.json）
//   node scripts/dedup-apply.js --all --yes           # 全部区正式执行（需显式 --all，避免误改全库）
//   node scripts/dedup-apply.js --scope <key> --rollback <keepId>   # 回滚某次合并
//
// ⚠️ 写盘前必须【先停服】：server 用「内存快照 + 节流 flush」整档覆盖写，与脚本并发会 lost-update。
const fs = require('fs');
const path = require('path');
const MemoryModule = require('../src/core/memory');
const { planDedupMerge } = require('../src/core/memoryConsolidation');
const { isServerRunning } = require('../src/storage/writeLock');

const args = process.argv.slice(2);
const APPLY = args.includes('--yes');
const ALL = args.includes('--all');
const scopeIdx = args.indexOf('--scope');
const SCOPE = scopeIdx >= 0 ? args[scopeIdx + 1] : null;
const rollbackIdx = args.indexOf('--rollback');
const ROLLBACK_ID = rollbackIdx >= 0 ? args[rollbackIdx + 1] : null;
const WRITES = APPLY || !!ROLLBACK_ID;

function today() {
  return new Date().toISOString().slice(0, 10);
}

const memory = new MemoryModule();
const userMemDir = path.join(memory.storagePath, 'user_memories');
const allStoreKeys = Object.keys(memory.userMemories);
const targetKeys = SCOPE ? [memory.normalizeScopeKey(SCOPE)] : allStoreKeys;

// 守卫一：写盘必须显式指定目标分区，避免「默认全库」误伤
if (APPLY && !SCOPE && !ALL) {
  console.error('[拒绝] 写盘（--yes）必须显式指定目标分区：--scope <key> 或 --all');
  console.error('  先用 dry-run 看清计划：node scripts/dedup-apply.js');
  process.exit(1);
}

// 守卫二：服务在跑就拒绝——server 内存快照会在下次 flush 把改动整档盖回去（lost-update）
if (WRITES) {
  const srv = isServerRunning(memory.storagePath);
  if (srv.running) {
    console.error(`[拒绝] 检测到情感中枢服务正在运行（pid=${srv.pid}），写盘会被其内存快照覆盖（lost-update）。`);
    console.error('  请先停止服务（面板「关闭服务器」或 Ctrl+C）后再执行。');
    process.exit(1);
  }
}

// --scope 指向不存在的分区：明确告知，别让它去建一个空档
if (SCOPE && !allStoreKeys.includes(targetKeys[0])) {
  console.warn(`[提示] 分区 ${targetKeys[0]} 不存在（当前共 ${allStoreKeys.length} 个分区），无事可做`);
  process.exit(0);
}

if (ROLLBACK_ID) {
  // 回滚：先扫出承载该 keep 的分区（保留条本身，或被并入条的 mergedInto 指向它），再定点复原
  let found = false;
  for (const key of targetKeys) {
    const store = memory.getUserMemoryStore(key);
    const hasKeep = store.memories.some(m => m && (
      String(m.id) === String(ROLLBACK_ID)
      || (Array.isArray(m.mergedIds) && m.mergedIds.map(String).includes(String(ROLLBACK_ID)))
    ));
    if (!hasKeep) continue;
    found = true;
    const result = memory.rollbackDedupMerge(key, ROLLBACK_ID);
    console.log(`[rollback] ${key}: 复原 ${result.restored} 条，保留条存在=${result.kept}`);
  }
  if (!found) console.warn(`[rollback] 未找到 keepId=${ROLLBACK_ID} 对应的分区，无事发生`);
} else {
  console.log(`=== 去重合并 ${APPLY ? '执行（写盘）' : 'dry-run（只读）'}：exact——归一化正文完全相同 ===`);

  let touchedStores = 0;
  let totalGroups = 0;
  let totalMerged = 0;

  for (const key of targetKeys) {
    const store = memory.getUserMemoryStore(key);
    const memories = store.memories;
    if (!Array.isArray(memories) || memories.length === 0) continue;

    // 逐档调用：storeKey 进分桶键，保证跨档（跨用户/跨分区）绝不合并
    const groups = planDedupMerge(memories, null, { storeKey: key });
    if (groups.length === 0) continue;

    const mergedCount = groups.reduce((sum, g) => sum + g.mergeIds.length, 0);
    touchedStores++;
    totalGroups += groups.length;
    totalMerged += mergedCount;

    console.log(`\n--- ${key}（${memories.length} 条记忆，命中 ${groups.length} 组 / 并入 ${mergedCount} 条）---`);
    for (const group of groups) {
      const polarity = String(group.groupKey).split('\u0000')[1] || '';
      console.log(`  [exact·极性 ${polarity}] ${group.size} 条完全相同 → 保留 ${group.keepId}`
        + `（合并后 recallCount=${group.mergedWeight.recallCount}, salience=${group.mergedWeight.salience}）`);
      for (const sample of group.samples) {
        const mark = sample.id === group.keepId ? '留存' : '并入';
        console.log(`      ${mark}  ${sample.id}  ${sample.text}`);
      }
    }

    if (!APPLY) continue;

    // 写前备份该档：<key>.bak-<YYYY-MM-DD>.json（含 .bak，所有加载器都会跳过）
    const src = path.join(userMemDir, `${key}.json`);
    const bak = path.join(userMemDir, `${key}.bak-${today()}.json`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, bak);
      console.log(`  [backup] ${path.basename(src)} → ${path.basename(bak)}`);
    } else {
      console.warn(`  [backup] 源文件不存在，跳过备份：${src}`);
    }

    const result = memory.applyDedupMerge(key, groups);
    console.log(`  [applied] 合并 ${result.groups} 组 / 归档 ${result.merged} 条`);
  }

  console.log(`\n汇总：${APPLY ? '已执行' : 'dry-run'}，涉及 ${touchedStores} 个分区，命中 ${totalGroups} 组，`
    + `${APPLY ? '已归档' : '预期减少'} ${totalMerged} 条`);
  if (!APPLY) {
    console.log('（未写入任何数据；确认无误后加 --scope <key> --yes 或 --all --yes 正式执行，写前会自动备份 .bak-<date>.json）');
  }
}
