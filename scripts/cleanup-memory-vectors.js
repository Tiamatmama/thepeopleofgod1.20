// 🧹 清理 user_memories 向量库里的短语气词条目（亲/喵/好了/爱你…，有效字符 < 4）
// 本地 data/user_memories/*.json 一个字不动，只删云端向量点；可安全重复运行
const axios = require('axios');
const MemoryVectorStore = require('../src/learning/memoryVectorStore');

const effectiveLen = (s) =>
    String(s || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;

(async () => {
    const store = new MemoryVectorStore();
    if (!store.isEnabled()) {
        console.log('向量库未配置');
        process.exit(1);
    }
    await store.ensureCollection();
    const conn = store.getConnection();
    const base = `${conn.qdrantUrl}/collections/${store.collection}`;

    let offset = null;
    let scanned = 0;
    let shortCount = 0;
    const trashIds = [];

    // scroll 全库（库里约千条，一次拉 256）
    do {
        const body = { limit: 256, with_payload: true, with_vector: false };
        if (offset) body.offset = offset;
        const res = await axios.post(`${base}/points/scroll`, body, {
            headers: store.headers(conn),
            timeout: 20000
        });
        const result = res.data && res.data.result;
        const points = (result && result.points) || [];
        offset = result && result.next_page_offset ? result.next_page_offset : null;

        points.forEach((p) => {
            scanned++;
            const text = String((p.payload || {}).text || '');
            if (effectiveLen(text) < 4) {
                shortCount++;
                trashIds.push(p.id);
                if (shortCount <= 15) console.log(`  待删: 「${text.slice(0, 20)}」`);
            }
        });
        process.stdout.write(`\r已扫描 ${scanned} 条，发现短条目 ${shortCount} 条`);
    } while (offset);

    console.log(`\n扫描完成：共 ${scanned} 条，短条目 ${shortCount} 条`);
    if (trashIds.length === 0) {
        console.log('没有需要清理的');
        process.exit(0);
    }

    // 分批删除（Qdrant 单批别太大）
    let deleted = 0;
    for (let i = 0; i < trashIds.length; i += 128) {
        const batch = trashIds.slice(i, i + 128);
        await axios.post(
            `${base}/points/delete?wait=true`,
            { points: batch },
            { headers: store.headers(conn), timeout: 30000 }
        );
        deleted += batch.length;
        process.stdout.write(`\r已删除 ${deleted}/${trashIds.length}`);
    }
    console.log(`\n✅ 云端清理完成，删除 ${deleted} 条短语气词向量（本地记忆未动）`);
    process.exit(0);
})().catch((e) => {
    console.error('清理异常:', e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
    process.exit(1);
});
