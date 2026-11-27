// 🚚 存量长期记忆迁移到 Qdrant（user_memories）
// 用法：node scripts/migrate-memories-to-qdrant.js [--user qq_123456789] [--limit 20]
//   不带参数 = 全量迁移；幂等可重跑（pointId 按 userId+mid 摊平，重复执行是覆盖不是重复）
//   --user  只迁某个用户文件（试跑用）
//   --limit 只处理前 N 条（试跑用）
//
// 省钱设计：embed 结果落 data/memory_embeddings_cache.json，中断重跑不重复为同一段文本付费。

const fs = require('fs');
const path = require('path');
require('../src/core/config');
const MemoryVectorStore = require('../src/learning/memoryVectorStore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEM_DIR = path.join(DATA_DIR, 'user_memories');
const CACHE_FILE = path.join(DATA_DIR, 'memory_embeddings_cache.json');
const BATCH = 16;

const args = process.argv.slice(2);
const onlyUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : '';
const limitN = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;

const store = new MemoryVectorStore();

// 磁盘向量缓存：迁移这种批量活必须能断点续传，不能中断一次就全重新付费
function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
        return {};
    }
}
function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

(async () => {
    if (!store.isEnabled()) {
        console.error('Qdrant / Embedding 未配置，先检查 .env');
        process.exit(1);
    }

    const files = fs.readdirSync(MEM_DIR)
        .filter((f) => f.endsWith('.json') && !f.includes('.bak'))
        .filter((f) => !onlyUser || f === `${onlyUser}.json`);

    // 数据源：user_memories/*.json 各文件 + 旧格式 data/memories.json（归属 default 用户）
    const entries = files.map((file) => ({
        userId: file.replace('.json', ''),
        file: path.join(MEM_DIR, file)
    }));
    const legacyFile = path.join(DATA_DIR, 'memories.json');
    if ((!onlyUser || onlyUser === 'default') && fs.existsSync(legacyFile)) {
        entries.push({ userId: 'default', file: legacyFile, legacy: true });
    }

    if (entries.length === 0) {
        console.log('没有匹配的记忆文件');
        return;
    }

    const cache = loadCache();
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const reachLimit = () => limitN > 0 && processed + failed >= limitN;

    for (const entry of entries) {
        if (reachLimit()) break;
        const userId = entry.userId;
        const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
        const memories = (raw.memories || []).filter((m) => m && typeof m.data === 'string' && m.data.trim());
        console.log(`\n=== ${userId}${entry.legacy ? '（旧格式 memories.json）' : ''}：${memories.length} 条待迁 ===`);

        let batch = [];
        const flush = async () => {
            if (batch.length === 0) return;
            const points = batch;
            batch = [];
            try {
                await store.upsertPoints(points);
                processed += points.length;
                process.stdout.write(`\r  已迁移 ${processed} 条`);
            } catch (error) {
                failed += points.length;
                console.error(`\n  批量写入失败(${points.length}条):`, error.message);
            }
        };

        for (const memory of memories) {
            if (reachLimit()) break;
            const text = memory.data.trim();
            const key = store.cacheKey(text);

            try {
                let vector = cache[key];
                if (!Array.isArray(vector)) {
                    vector = await store.embed(text);
                    cache[key] = vector;
                    // 每算完一条就落盘缓存，哪怕中途崩了也不白花钱
                    if ((processed + failed + skipped) % 10 === 0) saveCache(cache);
                }
                batch.push({
                    id: store.pointId(userId, memory.id),
                    vector,
                    payload: {
                        userId: String(userId),
                        mid: String(memory.id),
                        text: text.slice(0, 5000),
                        ts: memory.timestamp || Date.now()
                    }
                });
                if (batch.length >= BATCH) {
                    await flush();
                    saveCache(cache);
                }
            } catch (error) {
                failed++;
                console.error(`\n  单条失败(userId=${userId},mid=${memory.id}):`, error.message);
            }
        }
        await flush();
        saveCache(cache);
        console.log(`\n  ${userId} 完成`);
    }

    console.log(`\n迁移结束：成功 ${processed}，失败 ${failed}，缓存文件 ${CACHE_FILE}`);
    process.exit(failed > 0 ? 2 : 0);
})();
