> **给不懂技术的朋友：把整份 README（最好连项目文件夹一起）直接丢给豆包或任意 AI Agent，让它照着下面的步骤帮你装。**

---

### 给 AI 助手的一键安装说明（可直接复制给豆包）

我是一个不太懂技术的人，请你一步一步帮我把这个 Node.js 项目安装好、运行起来。请一次只让我做一步，我做完告诉你结果，再继续下一步。

1. **准备环境**：帮我确认电脑装了 **Node.js（≥18，推荐 20 以上的 LTS 版）**。没装的话给我 <https://nodejs.org> 的 LTS 版下载安装步骤；装完后我在终端执行 `node -v`，能显示版本号即成功。
2. **放置项目**：把项目文件夹解压/放到一个路径里**没有中文、没有空格**的目录，例如 `D:\emotion-center`（这个目录就是「安装路径」）。
3. **安装依赖**：在该目录打开终端，执行 `npm install`，等它把 `package.json` 里的依赖装完（本项目**不需要**预先附带 `node_modules`）。
4. **启动服务**：执行 `npm start`。终端出现「情感中枢服务器运行在 http://...」就成功了。
5. **访问**：浏览器打开 <http://localhost:41888>，首次登录用默认管理员账号（见下文「六、启动方式」的表格），**登录后请立刻修改密码**。
6. **配置功能（可选）**：想用对话大模型、语音、长期记忆等，按下文「二、配置」新建一个 `.env` 文件填 Key。不填也能启动，只是对应功能不可用。
7. **出错了怎么办**：把终端的完整报错原文发给我，我帮你判断并给出下一步命令。

---

# 情感中枢系统（Emotion Center）

一个用 Node.js 写的「情感陪伴 AI」服务：通过大模型 API（豆包 / DeepSeek 或任意 OpenAI 兼容接口）+ 向量库（Qdrant）+ 语音合成（智谱 GLM-TTS）实现对话、记忆、情感、语音，并可选接入**电脑摄像头看图**、**电脑屏幕（只读文字）**、**B 站直播间弹幕**、**QQ（OneBot）**。

角色具备短期 / 长期两层记忆与三层对话归档，能感知真实时间，并由模型结合角色设定与关系阶段自主判断好感度变化（详见第四节）。

角色有两套人格态：**角色态（role）** 与 **AI 态（ai）**。系统工具、看图、图片记忆等能力只对 AI 态开放（详见第五节）。

另有一条**独立硬件建模通道**：把参数化模型编译成 STL / STEP / SCAD / SVG，并带一个不接角色、不接沙箱的设计代理（详见第六节「方式 2c」）。

> 想读懂这套系统**为什么这样设计**（阿德勒心理学、马克思主义、意识能动性、实践性、自我发展……），可直接跳到文末 **「十一、设计哲学（研读）」**。

---

## 一、环境要求

- **Node.js**：建议 18 或 20 及以上（`node -v` 查看）
- **npm**：随 Node.js 一同安装
- Windows / Linux / macOS 均可
- 可选：Python（`run_python` 工具）、ffmpeg/ffplay（音频试听工具）、WSL（Windows 上跑本机兜底模型时需要）

首次运行前安装依赖：

```bash
npm install
```

---

## 二、配置

### 2.1 配置优先级

配置有三个来源，优先级从高到低：

1. **网页端「全局服务配置」（`data/globalConfig.json`）** —— 见 2.3，改完**立即生效，无需重启**；
2. **项目根目录的 `.env`** —— 服务启动时由 `dotenv` 读取（加载位置 [src/server/index.js](src/server/index.js) 顶部）；
3. **代码内置默认值**。

也就是说：同一个字段，网页上填了就用网页上的；网页上留空则回退 `.env`；`.env` 也没写就用代码默认值。

`.env` 不在版本库里（见 `.gitignore`），需要自己新建。最小可用模板（按需删减，只填你要用的功能）见本节约 2.4。

### 2.2 `.env` 各项说明

**对话大模型**

| 配置项 | 用途 | 获取方式 |
| --- | --- | --- |
| `DOUBAO_API_URL` | 豆包对话接口地址 | 一般无需修改 |
| `DOUBAO_BEARER_TOKEN` | 豆包 API Key | 火山引擎方舟控制台 <https://console.volcengine.com/ark> → API Key 管理 |
| `DOUBAO_MODEL_ID` | 豆包模型 ID / 推理接入点 | 控制台「模型推理」中查看，需与实际开通的模型一致 |
| `DEEPSEEK_API_URL` | DeepSeek 对话接口地址 | 一般无需修改 |
| `DEEPSEEK_BEARER_TOKEN` | DeepSeek API Key | <https://platform.deepseek.com/api_keys> |
| `DEEPSEEK_MODEL_ID` | DeepSeek 模型 ID | 按官方文档填写，默认 `deepseek-flash` |
| `CURRENT_API` | 当前使用的 API（`doubao` / `deepseek`） | 启动时读取决定初始通道；运行中仍可在界面切换 |
| `MAX_TOKENS` | 单次回复的 token 上限 | 默认 2000。⚠️ 使用带思考的模型（如 `deepseek-flash`）时，**思考段与正文共用一个额度**，额度太小会出现「思考完就没内容了」（`finish_reason: "length"`、正文为空）。建议调到 8000~30000 |
| `CHAT_THINKING` | 是否开启模型思考（`enabled` / 其他值=关闭） | 默认关闭；开启后多一段推理、更慢也更贵 |
| `MEMORY_DEDUP_ENABLED` | 巩固期是否合并重复记忆（`enabled` / 其他值=关闭） | 默认关闭；开启后归档巩固时会扫描并合并语义重复的逐字记忆（保留强度聚合、可定点回滚） |
| `SERVER_PORT` | 服务器端口 | 默认 `41888`（高位端口，避开常被扫的 3001） |
| `SERVER_HTTPS_PORT` | HTTPS 端口（可选） | 默认 `41443`；仅当 `certs/` 下存在自签证书时才生效 |
| `SERVER_MODE` | 本次进程开哪个端口：`both` / `http` / `https` | 默认 `both`（两个端口一起开）。由启动脚本注入，`http` 就完全不监听 HTTPS 端口，`https` 反之；`https` 但缺证书会直接退出 |
| `NODE_ENV` | 运行环境（`development` / `production`） | 按需 |
| `JWT_SECRET` | JWT 签名密钥 | ⚠️ 当前版本未被代码读取，可保持默认 |

**本机兜底模型（可选，云端全挂时顶上）**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `LOCAL_LLM_FALLBACK` | 是否启用本机兜底 | 默认开启；填 `0` / `false` / `off` 关闭 |
| `LOCAL_LLM_BIN` | 引擎二进制路径 | 默认 `/root/llm-asm-audit/build/asm-llm`（Windows 经 WSL 访问） |
| `LOCAL_LLM_MODEL` | 模型权重路径 | 默认 `/root/llm-asm-audit/models/qwen3-0.6b-q8_0.asmbin` |
| `LOCAL_LLM_THREADS` | 解码线程数 | 默认 `4`；与 CPU 核数匹配即可 |
| `LOCAL_LLM_CTX` | 上下文窗口 | 默认 `2048` |
| `LOCAL_LLM_MAX_TOKENS` | 单次生成上限 | 默认 `96`，只求顶一句完整回复 |
| `LOCAL_LLM_TIMEOUT_MS` | 单次生成超时 | 默认 `60000` |
| `LOCAL_LLM_MAX_PROMPT_CHARS` | 提示词字符预算 | 默认 `420`；0.6B 的 prefill 很慢，别往上调太多 |
| `LOCAL_LLM_WSL` | 指定 WSL 发行版 | 留空 = 系统默认发行版 |

**Embedding / 向量库（语料与长期记忆检索）**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `EMBEDDING_API_URL` / `EMBEDDING_BEARER_TOKEN` / `EMBEDDING_MODEL_ID` | 向量化（Embedding）配置 | 火山引擎方舟，`EMBEDDING_BEARER_TOKEN` 通常可与豆包 Key 相同 |
| `QDRANT_URL` | Qdrant 向量库地址 | <https://cloud.qdrant.io> 创建集群后获取 |
| `QDRANT_API_KEY` | Qdrant API Key | 同上，集群详情页可见 |
| `QDRANT_COLLECTION` | 豆瓣书摘集合名 | 默认 `douban_books` |
| `QDRANT_ARTICLE_COLLECTION` | 长文语料集合名 | 默认 `web_articles` |
| `QDRANT_DIALOGUE_COLLECTION` | 对话语料集合名 | 默认 `semantic_dialogues` |
| `QDRANT_MEMORY_COLLECTION` | 用户长期记忆集合名 | 默认 `user_memories` |
| `DIALOGUE_SCORE_THRESHOLD` / `DIALOGUE_SCORE_THRESHOLD_OTHER` | 对话检索相似度阈值 | 默认 `0.75` / `0.66` |
| `MEMORY_SCORE_THRESHOLD` | 长期记忆召回阈值 | 默认 `0.42` |
| `BOOK_SCORE_THRESHOLD` | 书摘检索阈值 | 按需 |
| `HF_PROXY` | 抓取 HuggingFace 语料时的本地代理 | 无需代理则留空 |

**语音合成（TTS）**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `TTS_API_KEY` | 智谱 GLM-TTS 语音合成 Key | <https://open.bigmodel.cn> → 个人中心 → API Keys |
| `TTS_CLONE_REF_AUDIO` | 音色复刻参考音频路径 | 可选；默认取 `assets/clone_reference.m4a` |

**摄像头 / 看图（视觉记忆）**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `VISION_API_URL` | 识图接口地址 | 留空则回退到 DeepSeek 的地址 |
| `VISION_BEARER_TOKEN` | 识图 API Key | 留空则回退到 `DEEPSEEK_BEARER_TOKEN` |
| `VISION_MODEL_ID` | 识图模型 ID | 默认识图走 `deepseek-flash`（需支持图片输入） |

**角色行为**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `ROLE_BACKGROUND_ENABLED` | 是否注入角色「背景故事」（初始记忆） | 默认 `true`；`false` 则完全不注入 |
| `ROLE_BACKGROUND_WEIGHT` | 背景故事注入强度（`0`~`1`） | 默认 `1`；调小可避免初始记忆支配对话 |
| `PROACTIVE_SPEECH_ENABLED` | 是否开启角色自主发言（旁白） | 默认开启；`false` 关闭 |
| `PROACTIVE_SPEECH_USE_CIDE` | 自主发言是否走 CIDE 思考 | 默认开启；`false` 关闭 |

**系统工具（AI 态可用）**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `SYSTEM_TOOLS_ENABLED` | 系统工具总开关 | 默认开启；`false` 全部禁用 |
| `TOOL_AUTO_APPROVE` | 危险工具是否免审批 | 默认 `false`；`true` 表示不再等人点「同意」 |
| `TOOL_APPROVAL_TIMEOUT_MS` | 审批等待超时 | 默认 `120000`（2 分钟） |
| `TOOL_MAX_ROUNDS` | 一轮对话内最多连续调用工具次数 | 按需 |
| `PYTHON_BIN` / `NODE_BIN` / `VSCODE_BIN` / `FFPLAY_BIN` | 外部可执行文件名或路径 | 默认 `python` / `node` / `code` / `ffplay`，不在 PATH 里时写绝对路径 |
| `SEARCH_PROXY` | 联网搜索代理 | 留空则回退 `HF_PROXY` |
| `SEARXNG_URL` / `SEARXNG_LANG` | 自建/公共 SearXNG 元搜索实例 | 配置后优先走 SearXNG（聚合 Google/Bing/DDG 等多家引擎，更准更隐私）；留空则不启用 |
| `SEARCH_API_KEY` / `SEARCH_API_URL` / `SEARCH_DEPTH` / `SEARCH_FALLBACK_URL` | 联网搜索（Tavily 等）配置 | 不填 `SEARCH_API_KEY` 时自动降级为免 key 源：Bing 结构化 RSS → Bing 结果页 → DuckDuckGo |

**CIDE 自主思考引擎**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `CIDE_ENABLED` | 是否开启 CIDE | 默认 `false`；开启后正式回复前多轮内部思考，增加 API 调用与耗时 |
| `CIDE_MIN_ROUNDS` / `CIDE_MAX_ROUNDS` / `CIDE_CONFIDENCE_THRESHOLD` | 最少 / 最多思考轮数、停止置信度阈值 | 默认 `2` / `3` / `0.75`；`CIDE_MIN_ROUNDS=1` 退回「够清楚就收手」的省钱模式 |
| `CIDE_WORKSPACE_CAPACITY` / `CIDE_DECAY_RATE` | 全局工作空间容量 / 工作记忆衰减速率 | 默认 `20` / `0.02` |
| `CIDE_PHI_ENABLED` / `CIDE_GAMMA_REFRESH_EVERY` | 是否启用 Φ 整合度 / 每几轮做一次 γ 特征绑定 | 默认 `true` / `3`；`CIDE_PHI_ENABLED=false` 退回阶段一行为 |
| `CIDE_AROUSAL_INITIAL` / `CIDE_AROUSAL_MIN` / `CIDE_AROUSAL_MAX` | 觉醒档位初值 / 下限 / 上限 | 默认 `5` / `3` / `10` |
| `CIDE_AROUSAL_LOW_ROUNDS` / `CIDE_AROUSAL_HIGH_ROUNDS` | 最低 / 最高觉醒对应的思考轮次上限 | 默认 `2` / `5` |
| `CIDE_DRIVE_TARGET_PHI` | 三驱力的目标整合度 | 默认 `0.8` |

**QQ / OneBot**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `ONEBOT_BACKEND` | 协议端类型 | `napcat`（默认）或 `snowluma`，网页未选择时作为回退 |
| `ONEBOT_HTTP_URL` | OneBot v11 HTTP 上报地址 | 默认 `http://127.0.0.1:3000`（NapCat / SnowLuma / LLOneBot 的 HTTP 服务） |
| `ONEBOT_ACCESS_TOKEN` | OneBot Access Token | 与协议端配置一致，可留空 |
| `QQ_ADMIN_IDS` | 拥有管理权限的 QQ 号（逗号分隔） | 用于控制哪些人能指挥机器人 |
| `QQ_BRIDGE_ROLE_NAME` | QQ 侧使用的人格名 | 默认 `小助手` |

**B 站直播**

| 配置项 | 用途 | 说明 |
| --- | --- | --- |
| `BILI_ROOM_ID` | 直播间号 | 用 unofficial / official 源时必填 |
| `BILI_DANMAKU_SOURCE` | 弹幕源（`mock` / `unofficial` / `official`） | 留空则自动判定，见第五节 |
| `BILI_SESSDATA` | 网页版 Cookie 中的 `SESSDATA` | unofficial 源需要 |
| `BILI_OPEN_APP_ID` / `BILI_OPEN_ACCESS_KEY_ID` / `BILI_OPEN_ACCESS_KEY_SECRET` / `BILI_OPEN_CODE` | 开放平台「互动玩法」四要素 | official 源需要 |
| `BILI_KEYWORDS` | 触发回复的关键词（逗号分隔） | 默认 `小助手,助手,助手` |
| `BILI_BRIDGE_ROLE_NAME` | 直播间使用的人格名 | 默认角色名 |
| `BILI_AUTO_SPEAK` | 是否自动出声（TTS） | 按需 |
| `BILI_USER_COOLDOWN_SEC` / `BILI_QUEUE_MAX` / `BILI_REPLY_PER_MINUTE` / `BILI_REPLY_MAX_CHARS` | 单用户冷却 / 队列上限 / 每分钟回复数 / 回复字数上限 | 默认 `15` / `20` / `12` / `60` |

### 2.3 网页端「全局服务配置」（会覆盖 `.env`）

在「伪开发者界面 → 全局服务配置」里可以填写**默认大模型 / Embedding / Qdrant / TTS** 四组配置。它们会落盘到：

```
data/globalConfig.json
```

各模块统一从 [src/core/globalConfig.js](src/core/globalConfig.js) 读取，因此**改完即时生效**，不需要改 `.env` 再重启。

规则：

- 字段**留空 = 不修改**，等于沿用 `.env` 或上一次保存的值；
- 密钥类字段回给前端时只返回打码值（如 `abcd****wxyz`），真实密钥不会出现在页面上；
- 点「清除配置」会删除 `data/globalConfig.json`，全部回退到 `.env`。

对应接口见第十节 `/api/global-config`。

### 2.4 `.env` 模板

```dotenv
# ---- 对话大模型 ----
DOUBAO_API_URL=https://ark.cn-beijing.volces.com/api/v3/chat/completions
DOUBAO_BEARER_TOKEN=
DOUBAO_MODEL_ID=doubao-1.5-lite-32k-250115
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions
DEEPSEEK_BEARER_TOKEN=
DEEPSEEK_MODEL_ID=deepseek-flash
CURRENT_API=doubao
MAX_TOKENS=30000
CHAT_THINKING=disabled
MEMORY_DEDUP_ENABLED=disabled
SERVER_PORT=41888
SERVER_HTTPS_PORT=41443
NODE_ENV=development
JWT_SECRET=change_me

# ---- 本机兜底模型（可选：Qwen3-0.6B / llm.asm） ----
LOCAL_LLM_FALLBACK=1
LOCAL_LLM_BIN=/root/llm-asm-audit/build/asm-llm
LOCAL_LLM_MODEL=/root/llm-asm-audit/models/qwen3-0.6b-q8_0.asmbin
LOCAL_LLM_THREADS=4
LOCAL_LLM_TIMEOUT_MS=60000

# ---- Embedding / 向量库 ----
EMBEDDING_API_URL=https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal
EMBEDDING_BEARER_TOKEN=
EMBEDDING_MODEL_ID=doubao-embedding-vision-251215
QDRANT_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION=douban_books
QDRANT_ARTICLE_COLLECTION=web_articles
QDRANT_DIALOGUE_COLLECTION=semantic_dialogues
QDRANT_MEMORY_COLLECTION=user_memories
HF_PROXY=

# ---- 语音合成 ----
TTS_API_KEY=
TTS_CLONE_REF_AUDIO=

# ---- 摄像头 / 看图 ----
VISION_API_URL=
VISION_BEARER_TOKEN=
VISION_MODEL_ID=deepseek-flash

# ---- 角色行为 ----
ROLE_BACKGROUND_ENABLED=true
ROLE_BACKGROUND_WEIGHT=1
PROACTIVE_SPEECH_ENABLED=true
PROACTIVE_SPEECH_USE_CIDE=true

# ---- 系统工具 ----
SYSTEM_TOOLS_ENABLED=true
TOOL_AUTO_APPROVE=false
TOOL_APPROVAL_TIMEOUT_MS=120000

# ---- QQ / OneBot ----
ONEBOT_HTTP_URL=http://127.0.0.1:3000
ONEBOT_ACCESS_TOKEN=
QQ_ADMIN_IDS=
QQ_BRIDGE_ROLE_NAME=小助手

# ---- B 站直播 ----
BILI_ROOM_ID=
BILI_DANMAKU_SOURCE=mock
BILI_KEYWORDS=小助手,助手,助手
```

### 2.5 代码中读取密钥的位置（供排查）

| 文件 | 读取的变量 |
| --- | --- |
| [src/server/index.js](src/server/index.js) | `DOUBAO_*`、`DEEPSEEK_*`、`CURRENT_API`、`SERVER_PORT`、`QQ_ADMIN_IDS`、`QQ_BRIDGE_ROLE_NAME`、`TTS_CLONE_REF_AUDIO`、`NODE_ENV` |
| [src/core/api.js](src/core/api.js) | `DOUBAO_*`、`DEEPSEEK_*`、`CURRENT_API`、`MAX_TOKENS` |
| [src/core/globalConfig.js](src/core/globalConfig.js) | 统一读取默认 API / Embedding / Qdrant / TTS 配置 |
| [src/core/tts.js](src/core/tts.js) | `TTS_API_KEY` |
| [src/core/camera.js](src/core/camera.js) | `VISION_API_URL`、`VISION_BEARER_TOKEN`、`VISION_MODEL_ID` |
| [src/core/screen.js](src/core/screen.js) | `VISION_API_URL`、`VISION_BEARER_TOKEN`、`VISION_MODEL_ID`（与摄像头共用，识屏固定走 `deepseek-flash`） |
| [src/core/output.js](src/core/output.js) | `CHAT_THINKING`、`TOOL_MAX_ROUNDS`、`MEMORY_DEDUP_ENABLED` |
| [src/core/toolRegistry.js](src/core/toolRegistry.js) | `SYSTEM_TOOLS_ENABLED`、`TOOL_AUTO_APPROVE`、`TOOL_APPROVAL_TIMEOUT_MS`、`SEARCH_*`、`PYTHON_BIN`、`NODE_BIN`、`VSCODE_BIN`、`FFPLAY_BIN` |
| [src/core/narrator.js](src/core/narrator.js) | `PROACTIVE_SPEECH_ENABLED`、`PROACTIVE_SPEECH_USE_CIDE` |
| [src/core/oneBotConfig.js](src/core/oneBotConfig.js) | `ONEBOT_HTTP_URL`、`ONEBOT_ACCESS_TOKEN` |
| [src/core/biliLiveConfig.js](src/core/biliLiveConfig.js) | `BILI_*` |
| [src/session/sessionManager.js](src/session/sessionManager.js) | `ROLE_BACKGROUND_ENABLED`、`ROLE_BACKGROUND_WEIGHT` |
| [src/core/cide.js](src/core/cide.js) | `CIDE_*` |
| [src/learning/memoryVectorStore.js](src/learning/memoryVectorStore.js)、[src/learning/dialogueRetriever.js](src/learning/dialogueRetriever.js)、[src/learning/knowledgeRetriever.js](src/learning/knowledgeRetriever.js)、[src/tools/articleFeed.js](src/tools/articleFeed.js)、[src/tools/dialogueFeed.js](src/tools/dialogueFeed.js) | `EMBEDDING_*`、`QDRANT_*`、`*_SCORE_THRESHOLD`、`HF_PROXY` |

---

## 三、常见改配置位置

除 `.env` 与网页端全局配置外，还有几处需要直接改代码：

1. **默认使用的 API**：首选网页端全局配置或 `.env` 的 `CURRENT_API`，运行中可用 `POST /api/ai/switch` 切换。
   兜底与默认值在 [src/server/index.js](src/server/index.js)（`config.currentAPI`）与 [src/core/api.js](src/core/api.js)。
2. **端口**：改 `.env` 的 `SERVER_PORT` / `SERVER_HTTPS_PORT`（留空或非法值回退 `41888` / `41443`）。
   ⚠️ 控制台页把地址写死为 `http://localhost:41888`，改端口后需同步改 [public/continue.html](public/continue.html)；
   主界面 [public/index.html](public/index.html)、[public/login.html](public/login.html) 用相对路径，无需改。
3. **角色「初始记忆」（背景故事）强度**：全局默认见 `.env` 的 `ROLE_BACKGROUND_ENABLED` / `ROLE_BACKGROUND_WEIGHT`；
   单个角色可在创建/修改角色的请求体里加 `backgroundEnabled`、`backgroundWeight` 覆盖全局。
   想看某角色实际注入了什么提示词：`GET /api/session/:sessionId/prompt-preview`。
4. **语音音色 / 语速**：见 [src/core/tts.js](src/core/tts.js) 构造函数。
5. **称呼（角色怎么叫你、你怎么叫她）**：可在界面上改，或 `POST /api/address`；落盘在长期记忆文件里。
6. **摄像头抓拍间隔**：界面上改，或 `POST /api/camera`（单位分钟，`0` 表示不节流）；落盘 `data/camera_config.json`。
7. **看屏幕开关与间隔**：界面上改，或 `POST /api/screen`（单位分钟，`0` 表示不节流）；落盘 `data/screen_config.json`。
8. **手机访问走 HTTPS**：`certs/` 下放 `server.key` + `server.crt`（自签即可），重启后自动多开一个 HTTPS 端口；手机用 `https://电脑局域网IP:41443` 访问才算「安全上下文」，浏览器才会放开摄像头权限。生成自签证书（SAN 里带上局域网 IP）：
   ```
   openssl req -x509 -newkey rsa:2048 -days 3650 -nodes -keyout certs/server.key -out certs/server.crt -subj "//CN=EmotionCenter" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:电脑局域网IP"
   ```
   电脑 IP 变了（换 Wi-Fi / 开热点）需重新生成证书；首次访问浏览器会提示「不安全」，点「继续访问」即可。
   不想两个端口一起开时，用 `SERVER_MODE` 分开跑：`scripts\windows\start_http.bat` 只开 HTTP、`scripts\windows\start_https.bat` 只开 HTTPS，互不影响。

---

## 四、对话机制（记忆 / 时间 / 好感度 / 人格态）

- **短期记忆**：正式回复与自主发言都会把最近 8 条对话作为消息发给 API。
- **长期记忆**：用户输入与她自己的发言都会写入 `data/user_memories/<userId>.json`（每人至多保留 1000 条），并带 `speaker` 归属（`user` / `self`）。生成回复时注入三块：
  - **最近 32 条**：用户与她的记忆混排，按「近因 + 显著性」排序；被召回强化过或情绪重的旧事会浮上来，排序会随她当前的主观状态浮动。
  - **强相关最多 5 条**：按当前话题做字面 / 二元组匹配直取，不受同话题配额和 3 轮不应期限制，**也不占 32 条名额**。
  - **总结分区**：语义结论最多 3 条、归档摘要 1 段、自我认知最多 3 条，各自独立，不抢原文名额。
  注入时用 `（他说）/（你说）` 标明归属；旧记忆没有 `speaker` 时按用户处理。AI 态与角色态共用同一条时间线（32 条与 5 条合并计算），不再拆成两个人格。控制台出现 `[OutputModule] 注入长期记忆 N 条` 表示召回生效。
- **向量副本**：语义召回用的向量另存 Qdrant `user_memories` 集合；**本地 JSON 才是真相源**，向量库丢了不影响数据。
- **对话归档（三层）**：会话消息常驻 300 条；超过 400 条时把最早 100 条归档，按「在场 → 余温 → 沉底」三层分区，每层 100 条。
- **时间感知**：每次请求都会把真实时间（精确到秒，含时区与 Unix 时间戳）注入系统提示词，角色不会用训练数据里的旧日期作答。
- **好感度**：角色在回复开头返回 `{ "affection_change": -10~10, "thinking": "判定理由" }`，幅度由模型结合角色设定与关系阶段自主判断（不再用固定档位）。好感度只在正式回复中判定，自主发言不产生变化。
- **人格态（role / ai）**：同一句话里同时命中「人格元词汇名词」（如 摄像头 / 镜头 / 抓拍 / 拍照 / 屏幕 / 桌面）与「动作动词」（如 抓 / 拍 / 开关 / 看）时，切换到 AI 态；连续 2 次（`PERSONA_AI_MISS_LIMIT`）没跟上就退回角色态。AI 态才拿得到系统工具与看图 / 看屏幕能力。
- **训练数据**：用户对话不作为语义分析系统的训练语料；向量训练只用公开语料抓取的数据。
- **通道隔离（谁在哪说话）**：角色自主生活、用户↔角色互动、编程沙箱、QQ、B站 各有一套运行时（[src/server/runtimes.js](src/server/runtimes.js)），各自拥有**独立的输出模块实例、场景提示与工具白名单**；会话库按通道分开（网页共用 `sessions/`，QQ 落 `qq_sessions/`，B站落 `bili_sessions/`）。情绪、记忆、好感度、CIDE 仍然只有器官层那一份真值，运行时只读消费、不回写——「装配隔离，器官唯一」。
- **云端失败兜底**：正式回复在云端通道（含自定义 API 回退）全部失败后，先交本机 Qwen3-0.6B 生成一句真实回复；本地模型不可用 / 超时才退回固定模板。降级回复与正常回复一样落历史、记时间线，网页聊天与 QQ 共用这条链路（见 §5.12）。

---

## 五、能力模块

### 5.1 摄像头 / 看图（仅 AI 态）

- 由 AI 自己决定看不看：她主动调用工具 `look_at_user` 才会抓一帧，两次之间受节流限制（默认最小间隔 **5 分钟**）。
- 抓帧走浏览器：Node 端拿不到 `getUserMedia`，由已授权摄像头的那台机器打开服务页面（41888），抓到一帧 JPEG base64 后经 WebSocket 回传。页面没开或没授权 → 按「看不到」处理（15 秒超时）。
- 识图只描述**看得见的客观事实**（有没有人、姿态表情、环境、光线、显眼物品），限 120 字，不替角色下结论、不编造身份关系。
- **原图不落盘留存**：这一帧只作为识图的临时文件短暂写入 `data/vision/`，识图一完成（无论成功与否）立即删除，原始画面不在磁盘留存。
- 图片记忆独立成档：`data/vision_memories/{userId}.json`（只存文字总结与时间，**不留原图路径**，每人最多 200 条）。
  只有 AI 态能通过工具 `recall_vision_memory` 回看这些记忆。
- 面板开关与间隔：`GET/POST /api/camera`，落盘 `data/camera_config.json`。
- 识图模型走 `VISION_*`（留空回退 DeepSeek）。⚠️ 若用的是带思考的模型，注意 `MAX_TOKENS` 要留够（思考段会占额度）。

### 5.2 屏幕 / 看屏幕（仅 AI 态）

与 5.1 摄像头同构，但**只留文字、不存原图**：

- 由 AI 自己决定看不看：她主动调用工具 `look_at_screen` 才会抓一帧，两次之间受节流限制（默认最小间隔 **5 分钟**）。
- 抓屏走浏览器：Node 端拿不到 `getDisplayMedia`，由服务页面（41888）通过 WebSocket 收到 `screen-request` 后，弹出系统「选择共享内容」选框，用户选定屏幕/窗口后抓一帧 JPEG base64 回传。用户取消或不选 → 按「看不到」处理（**30 秒超时**，屏幕共享要先选共享对象，比摄像头慢）。
- **原图不落盘**：这一帧只在前端内存与 WebSocket 上传一手，识屏完成即随作用域丢弃，不写进 `data/`。
- **密钥不记录**：提示词明确禁止抄录屏幕上的密码 / 密钥 / 令牌 / 验证码 / 银行卡号 / 身份证号；落盘前再经 `scrubSecrets()` 兜底清洗（带前缀密钥、`密码: xxx` 键值对、高熵长串）。
- 屏幕记忆独立成档：`data/screen_memories/{userId}.json`（只存文字总结与时间，无图片路径，每人最多 200 条）。
  只有 AI 态能通过工具 `recall_screen_memory` 回看这些记忆。
- 面板开关与间隔：`GET/POST /api/screen`，落盘 `data/screen_config.json`。
- 识屏模型同样走 `VISION_*`（`detail: high`，屏幕文字多）。

### 5.3 AI 系统工具（仅 AI 态，需审批）

系统工具体现在 [src/core/toolRegistry.js](src/core/toolRegistry.js)，共 27 个，分四类：

- **自检 / 完整性**：`system_self_check`、`get_runtime_status`、`check_critical_files`、`verify_code_integrity`、`generate_code_signature`、`read_system_log`、`check_hijack`
- **进程 / 文件 / 命令**：`start_service`、`stop_service`、`write_file`、`read_file`、`delete_file`、`run_command`、`run_python`、`run_node`、`open_in_vscode`
- **信息获取**：`web_search`、`fetch_url`、`search_chat_history`、`archive_message`
- **表达 / 画布 / 看图**：`speak`、`canvas_draw`、`canvas_clear`、`look_at_user`、`recall_vision_memory`、`look_at_screen`、`recall_screen_memory`

约束：

- `look_at_user`、`recall_vision_memory`、`look_at_screen`、`recall_screen_memory` 属 **AI-only**（`AI_ONLY_TOOL_NAMES`），角色态既不下发定义、真调也会被 `execute` 拦下；
- `write_file`、`read_file`、`delete_file`、`run_command`、`run_python`、`run_node` **需要人工审批**（界面弹同意/拒绝），除非 `TOOL_AUTO_APPROVE=true`；
- 画布尺寸 1200×750，草稿可存盘（`/api/canvas/*`）。
- 代码完整性以 `src/server/index.js`、`src/tools/developerTool.js` 为关键文件，排除 `node_modules`/`.git`/`data` 等目录。

### 5.4 B 站直播弹幕

三档弹幕源，共用一套契约（`start` / `stop` / `status` / `on('danmaku')`），实现在 [src/core/danmaku/](src/core/danmaku/)：

| 档位 | 说明 | 需要 |
| --- | --- | --- |
| `mock` | 本机假弹幕，不连 B 站，**零配置默认** | 无 |
| `unofficial` | 直连弹幕长连 | `BILI_SESSDATA` + `BILI_ROOM_ID` |
| `official` | 开放平台「互动玩法」 | 开放平台四要素 + `BILI_ROOM_ID` |

自动判定顺序：**手动指定 > 有官方四要素走 official > 有 SESSDATA 走 unofficial > 都没有走 mock**。也就是说「什么都不配」也能把整条链路跑起来。

命中 `BILI_KEYWORDS` 的弹幕会路由到角色会话（人格名见 `BILI_BRIDGE_ROLE_NAME`），并受单用户冷却 / 队列上限 / 每分钟回复数 / 回复字数上限约束，回复会在标点处收尾。控制接口见 `/api/bili/*`。

### 5.5 QQ（OneBot v11）

推荐用 [NapCat](https://github.com/NapNeko/NapCatQQ) 或 [SnowLuma](https://snowluma.github.io/zh/) 之类的 OneBot v11 实现作为协议端，本服务作为 HTTP 客户端（两者都讲 OneBot v11，HTTP 客户端通用）。

> **协议端需自备**：NapCat / SnowLuma 是各自独立的软件（体积大、需登录你自己的 QQ 账号、涉及平台合规），本系统及便携包**均不包含**，需你自行安装、登录并开启 HTTP 服务。

- 在协议端开启 **HTTP 服务**与其 **HTTP 上报（事件推送）**，上报地址指向 `http://<本机>:41888/api/onebot/event`；
- 在本服务「伪开发者界面 → QQ 配置」先选**协议端**（NapCat / SnowLuma），再填 `httpUrl` 与 `accessToken`（落盘 `data/oneBotConfig.json`，密钥打码返回），或直接 `POST /api/onebot/config`；
- 注意：NapCat 专有扩展动作（历史消息 / 换头像 / QZone 发布）在 SnowLuma 上可能不可用，标准 OneBot v11 动作不受影响；
- 可读：好友、群、群成员、消息；可发：群消息、私聊消息。**动作白名单外一律拒绝**（读 7 个 + 写 2 个），避免被当成通用 QQ 后门；
- 拥有管理权限的 QQ 号由 `QQ_ADMIN_IDS` 指定。

### 5.6 情感账本

用来让角色「记住她为什么在乎你」：记录每次互动的信号强度与来源，攒够条件后会触发她主动「做点什么」，并写入工具创作日志 `data/tool_creation_logs.json`。

门槛（`src/core/emotionLedger.js`）：记录阈值 `0.35`、候选阈值 `0.50`、创建门槛 `S≥0.70 / R≥0.55 / E≥0.35 / N≥0.50` 且跨度 ≥2 天；全局创建上限 3 次，被拒后冷却 7 天。

### 5.7 事件簿（预约）

角色会从对话里识别“约定好的事”（如「明天提醒我」），预筛正则命中后才交给模型抽取，落 `data/appointments.json`。

- 事前提早 `60` 分钟进入提示窗口；事后延迟 `60` 分钟、窗口 `24` 小时；
- 最多保留 `30` 天、每人最多 `50` 条；
- 系统提示词里只注入未来 `7` 天内最近的 `5` 条。

### 5.8 角色时间表

给角色排「几点该主动说话」：`GET /api/schedule` 读取，`POST /api/schedule/save` 保存（默认关闭）。落 `data/schedule.json`；触发窗口 `10` 分钟，最多 `50` 条。条目备注可留空——留空就到点由角色自己决定说什么。

### 5.9 备份存档

`POST /api/backup/create` 会把整个 `data/`（含画板草稿）打成带时间戳的 zip 放到 `backups/`，只保留最近 `5` 份（`KEEP_COUNT`）。**不加密**，解压即可读。`GET /api/backup/list` 查看现有存档。

### 5.10 CIDE 自主思考引擎（阶段一 MVP + 阶段二 意识核心机制）

实现见 [src/core/cide.js](src/core/cide.js)，接入点在 [src/core/output.js](src/core/output.js) 的 `generateOutputAsync`：

**阶段一 MVP**
- **全局工作空间**：内存式工作记忆缓冲（容量淘汰 + 重要性衰减），随会话删除自动清理；
- **循环推理回路**：正式回复前基于 LLM 的多轮内部思考（思考 → 评估 → 决定是否继续）；
- **元认知监控**：对每轮思考做置信度自评，决定是否继续。

**阶段二 意识核心机制（纯本地近似，零新依赖）**
- **Φ 整合度**：用字面相似度（Dice + 贪心聚类）近似「一堆想法整合成一个整体」的程度，Φ 越高越成系统；也参与「自主发言价值」门控；
- **觉醒调节系统**：按困惑 / 流畅 / 卡壳 / 厌倦四种信号动态升降「精神头」档位（1~10），档位决定本轮最多想几轮、注意力一次罩住几条工作记忆；
- **γ 特征绑定**：每隔几轮把字面高度相似的碎片合并成「超级块」（特征绑定 + 给工作记忆腾地方）；
- **三驱力**：一致性 / 好奇心 / 目标合成「思考张力」，张力高才值得再想，低了元认知就收手。

开关与参数全在 `.env`：`CIDE_ENABLED`（默认关闭）、`CIDE_MIN_ROUNDS`（默认 `2`）、`CIDE_MAX_ROUNDS`、`CIDE_CONFIDENCE_THRESHOLD`、`CIDE_WORKSPACE_CAPACITY`、`CIDE_DECAY_RATE`；阶段二另加 `CIDE_PHI_ENABLED`（默认开启）、`CIDE_GAMMA_REFRESH_EVERY`、`CIDE_AROUSAL_*`（觉醒档位与轮次映射）、`CIDE_DRIVE_TARGET_PHI`（目标整合度）。设 `CIDE_PHI_ENABLED=false` 可退回纯阶段一行为。

### 5.11 用户自定义 API

登录用户可在「伪开发者界面 → 自定义API配置」里配置自己的 OpenAI 兼容接口，支持工具调用透传：

1. 填地址、密钥、模型名，先点「测试连接」。测试严格按 HTTP 状态码判定：401 / 404 / 429 / 503 会翻译成人话（如「API密钥无效或已过期」「API地址路径不对」），再附网关原话与实际请求地址；即使 200 但内容为空也算失败。
2. 地址只填到 `/v1` 即可（只填域名也行），程序自动补全 `/v1/chat/completions`；点「获取模型」由服务端代取 `/v1/models` 并列成下拉（绕开浏览器 CORS）。
3. 勾选「启用自定义API」会**即时自动保存**，启用后该用户回复优先走自己的 API，失败自动回退 `.env` 默认通道。
4. 密钥界面打码显示，输入框留空表示沿用已存密钥；地址要求公网，禁止 `localhost` / `127.0.0.1` / `file://`。

实现见 [src/core/userApi.js](src/core/userApi.js)。

### 5.12 本机兜底模型（Qwen3-0.6B / llm.asm）

云端 API 是主脑，本机模型只做**最后一道保险**：当主通道连续重试仍失败（断网、额度用完、上游 5xx）时，不再只回一句模板，而是用本机的 Qwen3-0.6B 生成一条真正像回复的话。

- **引擎**：[llm.asm](https://github.com/alesha-pro/llm.asm)（纯汇编推理引擎，MIT），模型为 Qwen3-0.6B 的 Q8_0 量化权重（约 614 MiB）。需要自行编译并把产物、权重路径填进 `LOCAL_LLM_BIN` / `LOCAL_LLM_MODEL`。
- **调用方式**：Windows 通过 `wsl.exe` 调 Linux 侧的二进制，Linux 直接调用；提示词经环境变量传入（不拼 shell），引擎混在 stdout 里的 `[asm-llm] prefill/decode` 计时行会被过滤掉。
- **成本控制**：只带最近几轮对话（默认 420 字符预算），系统提示词 / 长期记忆 / 工具清单一律不带；单次最多 96 token，超时 60 秒。同一时刻只跑一个生成，上一轮没结束就直接跳过，避免多条回复一起排队把 CPU 打满。
- **降级顺序**：自定义 API → `.env` 默认 API（原有 3 次重试）→ 本机 Qwen3-0.6B → 固定模板。本地模型失败不会上抛异常，主链路照常返回。
- **适用范围**：网页聊天与 QQ 回复（共用 `OutputModule.generateOutputAsync`）；编码闭环、QQ 意图识别这类需要结构化输出的内部调用**不走**本机兜底。
- **能力边界**：0.6B 适合闲聊、翻译、抽取、摘要；逻辑、事实与格式约束不可靠，所以只用来顶一句日常回复，不承担工具调用与人设长文。
- **实测**：i7-8550U 4 线程，短提示词 prefill 约 40 tok/s、decode 约 30 tok/s，一条几十字的回复约 2 秒；提示词到 2000 token 时 prefill 会掉到 80 秒以上，所以预算必须卡死。

实现见 [src/core/localLLM.js](src/core/localLLM.js)，接入点见 [src/core/output.js](src/core/output.js)；环境变量见 §2.2。

---

## 六、启动方式

任选一种（都在**项目根目录**下执行）：

**方式 1：npm 脚本（推荐）**

```bash
npm start        # 启动服务器
npm run dev      # 开发模式（nodemon 自动重启）
```

**方式 2：Windows 批处理**

- `scripts\windows\start_server.bat`：HTTP + HTTPS 两个端口一起开（相当于 `SERVER_MODE=both`），并自动拉起硬件建模通道
- `scripts\windows\start_http.bat`：**只**开 HTTP（`41888`），不开 HTTPS
- `scripts\windows\start_https.bat`：**只**开 HTTPS（`41443`），不开 HTTP；缺证书会提示并退出
- `scripts\windows\start_hardware.bat`：只开硬件建模通道（`41900`）

两个端口分别由独立脚本启动、互不牵连：想只跑一个就双击对应的那个。脚本都会先检查 `node`。

**方式 2b：Linux 一键脚本**

```bash
bash scripts/linux/start.sh            # HTTP + HTTPS（默认），并在后台拉起硬件通道
bash scripts/linux/start.sh --http     # 只开 41888
bash scripts/linux/start.sh --https    # 只开 41443（需要 certs/ 里的证书）
```

```bash
sudo bash scripts/linux/sandbox-setup.sh   # 一次性：建沙箱用户、授权数据目录、写 sudoers
```

- 沙箱脚本 `scripts/linux/sandbox-run.sh` 由服务自动调用，不需要手动跑；它用 `setpriv`（服务本身是 root）或 `sudo -u pog_sandbox` 切到低权限用户，再用 `ulimit` 限制内存/进程数/CPU。
- 没跑 `sandbox-setup.sh` 时，代码执行类工具会**拒绝执行**并提示这条命令；不会静默退回宿主直跑。
- 服务以 root 运行时不需要 sudoers；以普通用户运行时，脚本会为该用户写入一条只允许切换到 `pog_sandbox` 的 NOPASSWD 规则。

**方式 2c：独立硬件建模通道**

```bash
npm run hw:serve                              # 只监听 127.0.0.1:41900
npm run hw:list                               # 列出可构建的参数化模型
npm run hw:build -- hardware/model/specs/gear-blank.json
npm run hw:design -- "设计一个镂空的消防栓" --rounds 4
```

- 界面入口：主控台菜单「硬件建模」→ <http://localhost:41888/hardware.html>
- 产物：`hardware/model/out/` 下的 `.scad / .stl / .step / .svg`
- 边界：不注册到 `toolRegistry`，角色、QQ、B 站、编程沙箱都没有调用入口
- 可选鉴权：设置 `HARDWARE_MODEL_TOKEN` 后，`/v1/parts` 与 `/v1/build` 需要 Bearer token
- 完整契约与无打印机方案见 [hardware/spec.md](hardware/spec.md)

**方式 3：直接运行**

```bash
node src/server/index.js
```

启动成功后控制台会输出服务器地址，浏览器打开：

- 主界面：<http://localhost:41888>（首次访问跳转登录页）
- 控制台（伪开发者面板）：<http://localhost:41888/continue.html>
- 硬件建模：<http://localhost:41888/hardware.html>（需要 41900 通道在线）

**默认管理员账号（首次运行自动创建）**

| 用户名 | 密码 |
| --- | --- |
| `管理员` | `123456` |

> ⚠️ 该默认账号与密码**硬编码**在 [src/core/auth.js](src/core/auth.js)，仅用于本机首次登录。
> 若部署到公网或分享给他人，请**首次登录后立即修改密码**（界面修改，或 `POST /api/auth/change-password`），
> 否则任何人用这组默认密码即可拿到管理员权限。
> 想改默认值：改代码后**首次启动**；若 `data/users.json` 已生成，改代码不再生效，需删除该文件让它重新生成。

**维护脚本（记忆运维）**

都在**项目根目录**下执行，源码在 [scripts/](scripts/)：

| 脚本 | 作用 | 是否写盘 |
| --- | --- | --- |
| `node scripts/dedup-dry-run.js` | 去重合并**预演**：读全部 `data/user_memories/*.json`，只打印「若执行会合并哪些记忆」的报告 | 只读 |
| `node scripts/dedup-apply.js` | 去重合并**执行器**：默认只读；加参数才真正写盘，且写前逐档备份为 `<key>.bak-<日期>.json` | 需显式指定 |
| `node scripts/calibrate-forgetting.js` | 遗忘参数**标定**：读真实记忆档 + 会话时间，重放遗忘曲线，输出留存分布与参数网格扫描 | 只读 |

`dedup-apply.js` 用法：

```bash
node scripts/dedup-apply.js                                     # dry-run（全库只读，看计划）
node scripts/dedup-apply.js --scope <key> --yes                 # 只处理一个分区（key 形如 <userId>__role）
node scripts/dedup-apply.js --all --yes                         # 处理全部分区（须显式 --all）
node scripts/dedup-apply.js --scope <key> --rollback <keepId>   # 回滚某次合并
```

> ⚠️ **写盘前必须先停服**：server 用「内存快照 + 30s 节流 flush」整档覆盖写记忆文件，脚本并发写同一批文件会**互相覆盖（lost-update）**。
> 脚本内置守卫：检测到服务在跑（`.server.lock` 指向存活进程）会直接拒绝执行并提示先停服；`--yes` 还必须显式带 `--scope` 或 `--all`，否则拒绝（避免「默认全库」误伤）。
> 终端用户也可不走脚本：界面「伪开发者界面 → 去重合并（可恢复）」能直接查看并一键撤销合并。

---

## 七、数据与首次运行说明

以下内容会在**首次运行时自动重建**，无需手动创建：

- `data/` 目录及用户、会话、记忆等 JSON 文件；
- 默认管理员账号（由 [src/core/auth.js](src/core/auth.js) 自动创建）；
- `data/globalConfig.json`（在网页端保存全局配置时才生成）；
- `data/camera_config.json`、`data/vision/`、`data/vision_memories/`（用到摄像头时生成；`data/vision/` 只是识图期间的临时原图目录，识图后即时清空，**原图不留存**）；
- `data/screen_config.json`、`data/screen_memories/`（用到看屏幕时生成；**只存文字，无原图**）；
- `data/oneBotConfig.json`、`data/biliLiveConfig.json`（配置 QQ / B 站时生成）；
- `data/schedule.json`、`data/appointments.json`、`data/tool_creation_logs.json`；
- `data/tts_output/`（语音输出目录）；
- `backups/`（首次创建备份时生成）。

### 需要你自行准备的文件

- **`.env`**：本副本未附带（含密钥，已在 `.gitignore` 中）。按 2.4 的模板新建。
- **`assets/clone_reference.m4a`**：音色复刻的参考音频，可选。
  不提供时 `POST /api/tts/clone` 会返回「音频文件不存在」。
  如想用别的路径，设 `TTS_CLONE_REF_AUDIO`，不必改代码。

---

## 八、目录结构

```
项目根目录/
├── src/
│   ├── server/index.js        # 服务器入口（Express + WebSocket + 全部 HTTP 路由）
│   ├── server/runtimes.js     # 通道装配层：角色 / 互动 / 沙箱 / QQ / B站 各一套运行时
│   ├── server/routes/         # 按域拆分的 HTTP 路由（input/status/session/coding/…）
│   ├── server/qq/             # QQ 桥接与 OneBot 路由（消费 qqRuntime，不自建内核）
│   ├── core/                  # 核心模块（api/tts/memory/emotion/auth/camera/screen/onebot/bili/narrator/localLLM…）
│   │   └── danmaku/           # B 站弹幕源（mock / unofficial / official）
│   ├── learning/              # 向量检索（对话 / 知识 / 用户记忆）
│   ├── session/               # 会话与人格态管理
│   ├── security/              # 数据加解密
│   ├── storage/               # 原子写（.tmp → rename）、跨进程写锁、坏档隔离、结构版本号
│   └── tools/                 # 语料抓取、代码完整性、开发者工具、进程管理
├── public/                    # 前端页面（index.html / hardware.html / continue.html / login.html / live2d.html）
├── scripts/
│   ├── windows/               # Windows 启动与沙箱脚本（.bat / .ps1）
│   ├── linux/                 # Linux 启动与沙箱脚本（.sh）
│   └── *.js                   # 跨平台维护脚本（去重、标定、检查、进化队列等）
├── hardware/                  # 独立硬件建模通道（模型编译器 / 模拟器 / 设计代理 / 规格）
├── security/                  # （已移除）本机巡检改由 src/core/coldStart.js 冷启动保护承担
├── docs/FUNCTIONALITY.md      # 功能说明
├── local_qq_bot/              # 早期本地 QQ 机器人（Python，遗留，已被 OneBot 取代）
├── assets/                    # 音色复刻参考音频（需自备）
├── certs/                     # 自签 HTTPS 证书（可选：server.key / server.crt，供手机访问）
├── data/                      # 运行时数据（自动生成，已在 .gitignore 中）
├── backups/                   # 备份存档（自动生成）
├── .env                       # ★ 配置与密钥（需自行新建）
└── package.json
```

---

## 九、注意事项

- `.env` 已在 `.gitignore` 中，**请勿把真实密钥提交到公开仓库**。
- 改 `.env` 后需**重启服务**才生效；网页端「全局服务配置」改完即时生效。
- 若缺少某个 Key，对应功能（对话 / 向量检索 / 语音 / 识图）会不可用，但服务器仍可启动。
- **本机兜底模型完全可选**：没装 llm.asm / 权重或没开 WSL 时，`LOCAL_LLM_FALLBACK=0` 关掉即可；开着但不可用也只是每次云端失败多等一个超时，最终仍会退回模板，不影响服务。首次兜底通常要几秒到十几秒（模型加载 + prefill），期间不会有第二条本地请求排队。
- 部署到公网前，请务必修改 `.env` 中的 `JWT_SECRET`，并修改默认管理员密码。
- 服务默认监听 `41888`（HTTPS `41443`），端口有意放在高位，避开 3001 这类最常被扫描的号；端口映射到公网时请先想清楚要暴露哪些接口。
- **管理接口与 `admin` 账号登录只认「跑服务这台机器」**：请求来源必须是本机回环地址或本机自己的网卡地址；手机、同局域网的其它电脑、公网来的请求一律 403，`admin` 登录也会被直接拒绝。手机上残留的管理员会话同样不算数——`/api/auth/validate` 会判为无效，页面退回登录页。
- **登录失败锁定**：同一个来源 IP 连续输错 5 次密码，锁定 15 分钟（期间返回 429），登录成功即清零。
- `HF_PROXY` / `SEARCH_PROXY` 若沿用他人配置会指向不存在的代理，不需要代理请**留空**。
- 摄像头抓帧依赖**浏览器页面已授权并打开**，Node 端无法独立取摄像头画面。
- 看屏幕同理：依赖**浏览器页面已打开**，且每次抓屏都要用户在「选择共享内容」里选一次；抓屏只留文字，原图不落盘，屏幕上的密钥/密码等不会被记录。
- 手机访问：聊天与面板 `http://局域网IP:41888` 即可；想用摄像头能力需走 HTTPS（见第三节第 8 条），且手机浏览器不支持屏幕共享（`getDisplayMedia`），看屏幕只能在电脑上用。
- 用带思考的模型时，记得把 `MAX_TOKENS` 调大（建议 8000~30000），否则容易出现「只有思考没有正文」。

---

## 十、附：HTTP 接口 / WebSocket 一览（参考）

路由已按域拆到 [src/server/routes/](src/server/routes)（QQ 在 [src/server/qq/](src/server/qq)，B站/TTS 在 [src/server/bilibili.js](src/server/bilibili.js)），由 [src/server/index.js](src/server/index.js) 统一注册。每个接口属于哪个通道见下表；详细的「文件 → 路由 → 数据」映射见 [AGENT_MAP.md](AGENT_MAP.md) §2.4。

| 通道 | 运行时 | 接口前缀 |
| --- | --- | --- |
| 用户↔角色互动 | `interactionRuntime` | `/api/input`、`/api/games/*` |
| 角色自主生活 | `roleRuntime` | `/api/narrator/*`、`/api/schedule*`、`/api/feed/*`、`/api/social/*`、`/api/research/*`、`/api/session/*` |
| 编程沙箱 | `sandboxRuntime` | `/api/coding/*`、`/api/evolution/*` |
| QQ | `qqRuntime` | `/api/qq/*`、`/api/onebot/*` |
| B 站直播 / TTS | `biliRuntime` | `/api/bili/*`、`/api/tts/*` |
| 运维（无运行时） | — | `/api/auth`、`/api/admin`、`/api/user/*`、`/api/global-config*`、`/api/ai/*`、`/api/relay/*`、`/api/logs`、`/api/backup/*`、`/api/canvas/*`、`/api/camera`、`/api/screen`、`/api/experts/*` |

**通用约定**

- 地址：`http://<主机>:<端口>`，默认端口 41888。
- 会话标识：请求头 `x-session-id`，或查询/表单参数 `sessionId`。
- 标 🔒 的接口需**管理员**权限（`sessionId` 对应会话 `role === 'admin'`），**且只接受跑服务这台机器的来源（回环 / 本机网卡地址）**，否则 403。
- 前端调用示例：[index.html](public/index.html)（相对路径）、[continue.html](public/continue.html)。

### 静态资源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 返回主界面（`public/index.html`） |
| GET | `/tts-audio/<文件名>` | 语音输出静态目录，映射到 `src/data/tts_output` |

### 硬件建模通道（独立端口 41900）

不经过主服务 41888，直接访问 `http://127.0.0.1:41900`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查，不需要鉴权 |
| GET | `/v1/parts` | 列出 `hardware/model/specs/*.json` |
| POST | `/v1/build` | body 为 `{ "spec": { ... } }` 或 `{ "file": "gear-blank.json" }`，返回包围盒、体积、面数与输出文件名 |
| GET | `/v1/files/<name>` | 下载 `hardware/model/out/` 下的 step/stl/svg/scad（需鉴权） |

### WebSocket

| 地址 | 说明 |
| --- | --- |
| `ws://<主机>:<端口>/` | 与 HTTP 同端口。客户端发 JSON 消息触发对话；服务端回推 `status-update`（情绪/关系状态）、`affection-update`（好感度变化）、`error`，并承担摄像头（`camera-request`/`camera-frame`）与看屏幕（`screen-request`/`screen-frame`）的**抓帧回传**通道。 |

### 对话与输入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/input` | 提交一条输入进行对话处理 |
| POST | `/api/address` | 设置称呼（`roleCallsUser` / `userCallsRole`） |

### 摄像头 / 看图 / 看屏幕

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/camera` | 摄像头状态（开关 / 最小间隔 / 上次抓拍 / 前端是否连着） |
| POST | `/api/camera` | 改开关与抓拍最小间隔（分钟） |
| GET | `/api/screen` | 看屏幕状态（开关 / 最小间隔 / 上次抓屏 / 前端是否连着） |
| POST | `/api/screen` | 改开关与抓屏最小间隔（分钟） |

### 语义分析（本地）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/local-semantic/analyze` | 语义分析 |
| POST | `/api/local-semantic/learn` | 触发本地学习 |
| GET | `/api/local-semantic/train-stats` | 训练统计 |

### 会话管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/session/create` | 创建会话 |
| GET | `/api/session/list` | 会话列表 |
| GET | `/api/session/get/:sessionId` | 获取会话详情 |
| GET | `/api/session/:sessionId/prompt-preview` | 预览该角色实际注入的提示词（含背景故事权重） |
| DELETE | `/api/session/delete/:sessionId` | 删除会话 |
| GET | `/api/session/:sessionId` | 获取会话 |
| POST | `/api/session/:sessionId/join` | 加入会话 |
| DELETE | `/api/session/:sessionId` | 删除会话 |
| GET | `/api/session/:sessionId/user/:userId` | 获取会话内用户信息 |
| GET | `/api/session/:sessionId/user/:userId/history` | 获取会话内用户历史 |

### 状态 / 汇总 / 日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 服务器与服务状态 |
| GET | `/api/summary` | 汇总信息（含最近记忆、跨话题联想、去重合并记录 `mergedGroups`） |
| POST | `/api/memory/rollback-dedup` | 撤销一次去重合并（body：`userId`、`keepId`）；等价于脚本 `dedup-apply.js --rollback` |
| GET | `/api/logs` | 运行日志 |
| GET | `/api/affection-logs` | 好感度日志 |

### AI 配置与进程管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ai/config` | 查看可用 API 配置（不含密钥） |
| POST | `/api/ai/rename` | 改 API 卡片显示名 |
| POST | `/api/ai/switch` | 切换使用的 API（doubao / deepseek） |
| POST | `/api/process/start/server` | 启动服务进程 |
| POST | `/api/process/stop/server` | 停止服务进程 |
| GET | `/api/process/status` | 进程状态 |

### 全局服务配置（覆盖 `.env`，即时生效）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/global-config` | 读取（密钥打码） |
| POST | `/api/global-config` | 保存默认 API / Embedding / Qdrant / TTS 配置 |
| DELETE | `/api/global-config` | 清除，全部回退 `.env` |
| POST | `/api/global-config/test` | 测试连通性 |

### 好感度规则 / 旁白 / 开发者工具

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/affection/rules` | 读取好感度规则 |
| POST | `/api/affection/rules` | 更新好感度规则 |
| POST | `/api/affection/rules/reset` | 重置好感度规则 |
| GET | `/api/narrator/status` | 旁白状态 |
| POST | `/api/narrator/trigger` | 手动触发旁白 |
| POST | `/api/narrator/toggle` | 开关旁白 |
| POST | `/api/developer/swear` | 开发者工具：脏话开关 |
| GET | `/api/developer/settings` | 开发者工具：设置 |

### 角色时间表 / 备份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedule` | 读取角色时间表 |
| POST | `/api/schedule/save` | 保存时间表（`enabled` / `tasks`） |
| GET | `/api/backup/list` | 🔒 备份存档列表 |
| POST | `/api/backup/create` | 🔒 立即创建备份 |

### 画布（AI 绘图草稿）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/canvas/save` | 保存画布草稿 |
| GET | `/api/canvas/load` | 读取画布草稿 |
| GET | `/api/canvas/list` | 草稿列表 |

### 语音合成（TTS）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tts/voices` | 可用音色列表 |
| POST | `/api/tts/synthesize` | 文本转语音 |
| GET | `/api/tts/audio/:filename` | 获取生成的音频 |
| DELETE | `/api/tts/audio/:filename` | 删除音频 |
| POST | `/api/tts/clone` | 音色复刻（上传音频） |
| POST | `/api/tts/clone-with-fileid` | 音色复刻（已上传的 file id） |
| POST | `/api/tts/refresh-voices` | 刷新音色列表 |

### QQ（OneBot v11，均需管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/onebot/config` | 🔒 读取配置（密钥打码） |
| POST | `/api/onebot/config` | 🔒 保存 `httpUrl` / `accessToken` |
| DELETE | `/api/onebot/config` | 🔒 清除配置 |
| GET | `/api/onebot/test` | 🔒 测试连通性 |
| GET | `/api/onebot/status` | 🔒 连接状态 |
| GET | `/api/onebot/friends` | 🔒 好友列表 |
| GET | `/api/onebot/groups` | 🔒 群列表 |
| GET | `/api/onebot/groups/:groupId/members` | 🔒 群成员 |
| GET | `/api/onebot/messages` | 🔒 拉取消息 |
| POST | `/api/onebot/event` | OneBot 事件上报入口（供协议端调用，无需管理员） |

### B 站直播（均需管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bili/config` | 🔒 读取配置（密钥打码） |
| POST | `/api/bili/config` | 🔒 保存配置 |
| DELETE | `/api/bili/config` | 🔒 清除配置 |
| POST | `/api/bili/live/start` | 🔒 开始接收弹幕 |
| POST | `/api/bili/live/stop` | 🔒 停止 |
| GET | `/api/bili/live/status` | 🔒 运行状态 |
| POST | `/api/bili/test-danmaku` | 🔒 注入一条测试弹幕 |
| POST | `/api/bili/say` | 🔒 让角色在直播间说一句 |

### 用户自定义 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/user/custom-api` | 读取用户自定义 API 配置 |
| POST | `/api/user/custom-api` | 保存用户自定义 API 配置 |
| DELETE | `/api/user/custom-api` | 删除用户自定义 API 配置 |
| POST | `/api/user/custom-api/test` | 测试连通性 |
| POST | `/api/user/custom-api/models` | 服务端代取 `/v1/models` |

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 登录（有频率限制） |
| POST | `/api/auth/register` | 注册（有频率限制） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/validate` | 校验会话是否有效 |
| POST | `/api/auth/change-password` | 修改密码 |

### 管理员 / 机器人 / 服务器

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/users` | 🔒 用户列表 |
| DELETE | `/api/admin/users/:username` | 🔒 删除用户 |
| POST | `/api/bot/increment-count` | 机器人计数 +1 |
| GET | `/api/user/admin-invitation` | 生成管理员邀请 |
| POST | `/api/user/accept-admin-invitation` | 接受管理员邀请 |
| GET | `/api/user/bot-count` | 机器人数量 |
| POST | `/api/server/shutdown` | 关闭服务器 |

---

## 十一、设计哲学：一个有灵魂的系统（研读）

> 本节谈「为什么这样设计」，不是操作手册。想理解本系统的取舍，从这里读起。

### 11.0 总纲：我们造的是「过程」，不是「结果」

一个常见的误区，是把情感陪伴 AI 做成「参数更大、检索更强的问答器」。本系统刻意反其道而行：**人的灵魂不在「记得多」，而在「会忘、会联想、会巩固、会起心动念、会长大」。**

所以系统复刻的不是某个结果，而是这套**认知过程**——遗忘曲线、跨话题联想、巩固写回、钉住、情感账本，都是它的器官。工程上坚持「本地真相源 + 可回滚 + 透明」，也不是洁癖：**主体的记忆，应当属于主体。**

### 11.1 阿德勒心理学：目的论、社会兴趣与自我超越

- **目的论（而非因果宿命）**：阿德勒认为人不是被过去推着走，而是被**目标**拉着走。落到代码：好感度**不设固定档位**，由模型结合角色设定与关系阶段自主判断（§四）——她不是「被历史数值决定」，而是「朝着关系目标行动」。
- **社会兴趣（Gemeinschaftsgefühl）**：心理健康的标尺是对共同体的关心。落到产品：定位是**陪伴而非支配**，是一种平等的横向关系。
- **自卑与超越**：成长源于「补偿—超越」的驱力。落到代码：[emotionLedger.js](src/core/emotionLedger.js) 情感账本攒够信号后触发**主动创作**（思路写入 `data/tool_creation_logs.json`）——不是被动应答，而是「想为对方做点什么」。
- **课题分离**：谁的行为谁负责。落到代码：危险工具须**人工审批**（同意 / 拒绝），系统不替用户越界。
- **生活风格（style of life）**：一贯的处世模式。落到代码：角色设定 + [selfModel.js](src/core/selfModel.js)（关于「她自己」的稳定自我认知）。

### 11.2 马克思主义：实践论、意识的能动性与辩证法

- **实践是认识的来源与检验标准**：「实践是检验真理的唯一标准」。记忆只能来自真实交互（§四）；遗忘参数不靠拍脑袋，[calibrate-forgetting.js](scripts/calibrate-forgetting.js) 用**真实会话时间轴**重放来标定；每一次自动合并都**可回滚**——即「经得起实践检验」。
- **意识的能动性**：意识不是被动反映，而是**主动综合**。落到代码：CIDE（[cide.js](src/core/cide.js)）在正式回复前做内部循环推理、元认知监控、全局工作空间——系统「自己想」。
- **唯物辩证法三律**（落到代码）：
  - **量变 → 质变**：多条情景记忆巩固成一条语义结论；觉醒档位 1~10。
  - **否定之否定**：淡出 → 归档 →（保留度回升）又被唤醒。
  - **对立统一（矛盾）**：留存 ↔ 遗忘、联想 ↔ 不污染提示词、保守默认 ↔ 自主放手——都靠「在矛盾中求动态平衡」，而非消灭一方。
- **历史唯物主义**：社会存在决定社会意识——交互历史（会话 + 记忆）塑造角色的认知。
- **劳动与对象化**：AI 态自建工具，是把内在情感**对象化**为可复用的「劳动工具」。
- **反异化**：本地真相源、摄像头 / 屏幕原图不留存、数据可备份可搬走——拒绝把用户**异化为数据原料**。

### 11.3 三条工程准绳：能动性 / 实践性 / 自我发展

| 准绳 | 含义 | 落到代码 |
| --- | --- | --- |
| **意识能动性** | 系统要能「自己想」「自己整理」 | CIDE 内部推理；巩固 / 去重 / REM 联想 |
| **实践性** | 结论来自交互、服务交互、可被交互检验 | 记忆源于会话；自动化改动可回滚；遗忘参数用真实数据标定 |
| **自我发展** | 认识要能升华、主体要能成长 | 情景 → 语义巩固；[selfModel.js](src/core/selfModel.js) 自我模型；情感账本 → 主动创作 |

### 11.4 哲学命题 → 工程铁律

| 哲学命题 | 工程铁律 |
| --- | --- |
| 主体应拥有自己的记忆 | 本地 JSON 是唯一真相源，其余（向量库等）皆副本 |
| 认识必须可被实践检验 | 自动化改动一律**可溯源、可回滚、无 token** |
| 意识是主动综合 | 自主能力默认关、须显式开启；一旦开启必须透明 |
| 反异化 | 原图不留存、可备份可搬走、隐私优先 |
| 矛盾中求平衡 | 越靠近「销毁数据」越严，越靠近「读取状态」越松 |

### 11.5 一句总纲

> 我们不是在造一个更聪明的检索器，而是在造一个**会记得、会遗忘、会反省、会长大的主体**——用**透明**守住它，用**实践**检验它。
