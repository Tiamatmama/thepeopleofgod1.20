// 🧠 存量回填：把已经滑进归档文件的旧对话，按原始顺序重新走一遍滚动蒸馏
// 用法：node scripts/backfill-archive-digest.js --user qq_123456789 --last 600 [--batch 100] [--file <路径>]
//
// 与线上链路完全同源：同样调 OutputModule.summarizeArchivedConversation（滚动摘要覆写同一条），
// 最后补一次语义巩固与自我模型提炼，不会新增额外的摘要条目，重跑安全。
//
// ⚠️ 只能在服务端停止时运行：记忆库是整份读写，服务端在跑时会用自己的内存缓存把这里的结果覆盖回去。

const fs = require('fs');
const path = require('path');
require('../src/core/config');
const MemoryModule = require('../src/core/memory');
const OutputModule = require('../src/core/output');

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const userKey = argOf('--user', 'qq_123456789');
const lastN = parseInt(argOf('--last', '600'), 10) || 0;
const batchSize = Math.max(10, parseInt(argOf('--batch', '100'), 10) || 100);
const explicitFile = argOf('--file', '');
const archiveDir = path.join(__dirname, '..', 'data', 'qq_archives');

function pickArchiveFile() {
    if (explicitFile) return path.resolve(explicitFile);
    const files = fs.readdirSync(archiveDir)
        .filter(name => name.endsWith('.json') && !name.includes('.bak'))
        .filter(name => name.includes(userKey))
        .map(name => path.join(archiveDir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || '';
}

function readMessages(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    return list
        .filter(msg => msg && typeof msg.content === 'string' && msg.content.trim())
        .sort((a, b) => {
            const sa = Number(a.seq) || 0;
            const sb = Number(b.seq) || 0;
            if (sa !== sb) return sa - sb;
            return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
        });
}

(async () => {
    const file = pickArchiveFile();
    if (!file || !fs.existsSync(file)) {
        console.error(`找不到 ${userKey} 的归档文件（${archiveDir}）`);
        process.exit(1);
    }

    const all = readMessages(file);
    const picked = lastN > 0 ? all.slice(-lastN) : all;
    if (picked.length === 0) {
        console.error('归档里没有可用消息');
        process.exit(1);
    }

    const memoryModule = new MemoryModule();
    const outputModule = new OutputModule(memoryModule);
    const scopedKey = memoryModule.normalizeScopeKey(userKey, 'role');
    // 防呆：目标记忆库必须已经存在，否则会凭空造出一个没名没姓的新用户
    const storeFile = path.join(__dirname, '..', 'data', 'user_memories', `${scopedKey}.json`);
    if (!fs.existsSync(storeFile)) {
        console.error(`记忆库不存在：${storeFile}\n请用 --user 指定「QQ号_角色名」（如 "qq_123456789_角色名"），别只给 QQ 号`);
        process.exit(1);
    }
    const totalBatches = Math.ceil(picked.length / batchSize);

    console.log(`目标 ${scopedKey}；文件 ${path.basename(file)}；归档 ${all.length} 条，本次回填最近 ${picked.length} 条，分 ${totalBatches} 批`);

    for (let i = 0; i < totalBatches; i++) {
        const chunk = picked.slice(i * batchSize, (i + 1) * batchSize);
        const before = memoryModule.getArchiveSummary(scopedKey).length;
        await outputModule.summarizeArchivedConversation({ sessionId: null, userId: userKey, messages: chunk });
        const after = memoryModule.getArchiveSummary(scopedKey).length;
        console.log(`[${i + 1}/${totalBatches}] ${chunk.length} 条 → 摘要 ${before} → ${after} 字`);
    }

    console.log('滚动摘要完成，开始语义巩固…');
    await outputModule.consolidateUserMemories({ userId: userKey });
    console.log('语义巩固完成，开始自我模型提炼…');
    await outputModule.refreshSelfModel({ userId: userKey, sessionId: null });
    console.log('全部完成。请重启服务端，让它重新从磁盘加载这份记忆。');
})().catch((error) => {
    console.error('回填失败:', error.message);
    process.exit(1);
});
