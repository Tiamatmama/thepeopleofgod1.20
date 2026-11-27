# src/learning 索引

向量检索与学习层：Qdrant 读写、本地向量索引、长期记忆向量索引、对话/知识检索、语料学习。

> 本文件说明同目录各文件的职责与测试入口，改动模块后请同步更新。

## 文件清单

| 文件 | 行 | 职责 | 主要导出 | 相关测试 |
|---|---:|---|---|---|
| `dialogueRetriever.js` | 131 | 对话检索：按「同类回应」召回招呼/道别等话术 | DialogueRetriever / classifyLine / SAME_TYPE_TYPES | learningRetrieval |
| `knowledgeRetriever.js` | 177 | 知识检索：豆瓣书摘库（douban_books） | KnowledgeRetriever | — |
| `localVectorStore.js` | 235 | 本地向量索引：进程内暴力余弦，接口与 Qdrant 版一致 | LocalVectorStore | localVectorStore |
| `memoryVectorStore.js` | 318 | 长期记忆向量索引（Qdrant user_memories） | MemoryVectorStore | learningRetrieval |
| `qdrantAgent.js` | 13 | Qdrant 专用 HTTPS agent（兼容 Node 22+ 握手） | httpsAgent | — |
| `vectorLearner.js` | 224 | 向量学习：语料 → 切分 → embedding → 入库 | VectorLearner | learningRetrieval |
| `vectorStore.js` | 26 | 向量后端选择：配了 Qdrant 走远端，否则本地 | createVectorStore / pickStore | localVectorStore |

## 约定

- `data/user_memories/*.json` 永远是真相源；`memoryVectorStore` / `localVectorStore` 只是可重建的索引。
- 后端选择统一走 `vectorStore.createVectorStore()`：配了 `QDRANT_URL` + `QDRANT_API_KEY` 用远端，否则本地索引落 `data/vector_index/<collection>/<userId>.json`。
- 本地索引换了 embedding 维度会自动重置（不同向量空间不能硬算距离），旧数据可由真相源重建。
- 所有 Qdrant 请求都要带 `qdrantAgent.httpsAgent`（Node 22+ 默认带混合后量子密钥交换，会握手失败）。
- 检索器对外只暴露「查」，不负责写；写入走 `vectorLearner`。
