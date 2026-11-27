# 路线图：A → B → C

> 约定：每完成一项就改这里的状态与日期，不攒着一起改。状态只有 `未开始 / 进行中 / 已完成 / 搁置`。

## 状态总览

| 阶段 | 内容 | 状态 | 更新时间 |
|---|---|---|---|
| A | 酒馆活起来（角色自主作息与经营循环） | 已完成 | 2026-11-25 |
| B | 桌面伴侣（托盘常驻 / 自启 / 快捷键唤起） | 已完成 | 2026-11-25 |
| C | 记忆星图（记忆·关系·情绪可视化，要炫酷） | 已完成 | 2026-11-25 |
| D | 实时视觉（浏览器端检测 + 实时场景注入） | 进行中 | 2026-11-26 |
| E | 安全模块（父本溯源 / 投毒与危险命令 / 网络劫持发现与恢复） | 已完成 | 2026-11-27 |

---

## A. 酒馆活起来

**目标**：现在的角色是摆件。让 AI 角色按作息在馆内走动、点单、付钱，客人按时段上门，用户当老板接待；对话受记忆与关系影响。

**复用（不要重写）**
- `src/core/creativeWorld.js`：世界方块表、palette、characters（含 wallet / say）、score、原子落盘
- `src/core/schedule.js`：`HH:MM` + 星期的时间表
- `src/core/privateLife.js`：私生活节律，可作为"角色此刻在哪、在干嘛"的状态源
- `src/core/memory.js` / `galgame.js`：关系阶段影响台词与折扣
- `public/creative.html`（2.5D）与 `public/creative-fp.html`（第一人称）：角色位置渲染已就绪
- `public/creative-models.js`：家具几何（桌/凳/吧台/椅），点位可直接用格子坐标

**做法（建议顺序）**
1. 角色站位表：在 creativeWorld 增加 `ROUTES`，把吧台内、桌边、门口、酒桶旁等点位写成格子坐标
2. 作息引擎：新增 `src/core/tavernClock.js`（纯逻辑优先），输入时间与角色，输出当前位置与动作（站着 / 走动 / 坐下 / 打烊）
3. 服务端定时推进：每分钟 tick 一次，改角色坐标并落盘；前端轮询 `/api/creative/world` 已有，无需新协议
4. 点单→付款闭环：客人进店 → 走到吧台 → `pay({from:customer,to:you})` → 角色 `say()`
5. 你接待：侧边输入框已能对话，把"谁在店里、刚才点了什么"注入提示词

**验收**
- 不同时段打开页面，角色在不同点位（不是原地不动）
- 走到吧台后出现付款与台词，钱包数字与金币块同步变化
- 你说话时，AI 的回应里能带出"刚才谁点了什么"

**落地（2026-11-25）**
- `creativeWorld.js` 增加 `ROUTES` 七个点位；角色位置可用 `setPose` 只改内存，事件去重记在 `tavern.events`
- 新增 `src/core/tavernClock.js`：作息表 → 点位/动作（纯逻辑）、每 10 分钟轮换巡场、朝目标缓步、点单窗口、场景提示
- 服务端每 3 秒推进一次，位置落盘节流 30 秒；点单在 11:30 / 18:30 各一次，钱不够只说话不扣钱
- 创意对话的 system prompt 注入「此刻谁在哪、刚说了什么」，前端角色标签显示当前动作
- 单测 `test/tavernClock.test.js` 9 项

---

## B. 桌面伴侣

**目标**：从"开浏览器看"变成"住在电脑里"：托盘常驻、开机自启、全局快捷键唤起、关窗口不退出。

**先决策（三条路，优先最小可行）**
| 方案 | 代价 | 适用 |
|---|---|---|
| Tauri | 需 Rust 工具链，包小、原生托盘 | 想长期做产品 |
| Electron | 依赖重（数百 MB），纯 JS 上手快 | 只求能用 |
| PWA + 启动脚本 + 托盘小工具 | 零新依赖，能力受限 | 最少改动 |

倾向：先做 PWA + 启动脚本，跑通"自启 + 托盘 + 快捷键唤起浏览器窗口"；确认体验后再评估 Tauri。

**验收**
- 开机后无需手动开终端，服务与页面自动就绪
- 托盘有菜单（打开 / 重启服务 / 退出）
- 快捷键能一键把窗口叫到前台

**落地（2026-11-25，走 PWA 最小方案）**
- 可安装外壳：[manifest.webmanifest](../public/manifest.webmanifest) + [sw.js](../public/sw.js) + 图标；主页注册 Service Worker，网络优先，只缓存同源静态资源，接口不缓存
- 托盘：[desktop.ps1](../scripts/windows/desktop.ps1)：打开酒馆 / 重启服务 / 查看日志 / 退出（保留服务）/ 停止服务并退出；5 秒探活，掉线自动拉起；单实例，二次启动只开页面
- 无窗口启动：[start_desktop.vbs](../scripts/windows/start_desktop.vbs)
- 安装 / 卸载：[install_desktop.ps1](../scripts/windows/install_desktop.ps1)：启动文件夹自启 + 桌面快捷方式（Ctrl+Alt+T）
- 用法：`powershell -ExecutionPolicy Bypass -File scripts\windows\install_desktop.ps1 -StartNow`；卸载加 `-Uninstall`

---

## C. 记忆星图

**目标**：把记忆、关系阶段、情绪做成可交互的星空/时间线，而不是列表。**要求做炫酷**。

**炫酷的具体标准（不是形容词）**
- 深色底 + 辉光粒子，节点按记忆强度做大小与亮度，淡忘的变暗下沉
- 力导向布局 + 平滑过渡；缩放、拖拽、点节点展开摘要
- 关系阶段用轨道/光带区分；同一天的记忆聚成星团
- 情绪用色温渐变，时间轴可回放"最近 30 天"
- 60fps 目标；数据一次拉取，前端本地布局

**数据来源**
- `data/user_memories`、`data/coding`、`src/core/memory.js` 的摘要
- `galgame.js` 的关系阶段、`emotion.js` 的情绪快照
- 新增只读路由 `/api/memory/graph`，不改现有写入链路

**验收**
- 打开页面 1 秒内出现星图，节点可点、可缩放
- 抽取一条真实记忆，能在图上定位到它所属的日期与情绪
- 无脚本报错，渲染耗时（非 FPS）可接受

**落地（2026-11-25）**
- 纯逻辑：[memoryGraph.js](../src/core/memoryGraph.js)：窗口过滤（置顶豁免）/ 节点上限（置顶优先）/ 强度合成（显著度 × 时间衰减 + 唤起 + 置顶 + 分档）/ 淡忘标记 / 情绪色温 / 话题链与日期链去重 / 每日概览；单测 `test/memoryGraph.test.js` 9 项
- 只读接口：`GET /api/memory/graph?days=30&limit=420`（[routes/memory.js](../src/server/routes/memory.js)）：scope 只取登录会话，读内存里已加载的记忆档，不写任何文件；关系阶段复用 `galgame` 的分数阈值与阶段名，当前情绪取 `emotionModule`
- 页面：[memory-galaxy.html](../public/memory-galaxy.html)：Canvas 2D 零依赖。深空星云 + 漂移星尘、辉光贴图预渲染、力导向 + 锚点星团（最近 30 天按日聚团，越旧越靠外）、关系五轨（当前阶段轨道点亮）、情绪色相由冷到暖、淡忘星变暗下沉、滚轮缩放 / 拖拽平移 / 点星看摘要、底部 30 天时间轴回放（播放时扫过的星冒火花）
- 实测最大记忆档：420 节点 / 474 边 / 18 个日期簇，JSON 约 171KB，折叠耗时 3ms；页面一次取数后本地布局
- 入口：`/memory-galaxy.html`（记忆管理页头部也有「记忆星图」链接）
- 来源切换（2026-11-25 补）：网页账号与 QQ 档是两套键，页面左上角新增来源下拉；`GET /api/memory/graph/scopes` 列出可看档位，管理员可见本机全部 QQ 档（按记忆条数排序），普通账号只看自己；`graph?source=` 会校验来源在白名单内，自己的档为空时默认落到记忆最多的 QQ 档

---

## D. 实时视觉（像人一样的余光）

**目标**：快照只能「她主动看一眼」，满足不了持续在场感。把「现实物体的坐标」持续转换成语义场景，像人的余光一样知道：有没有人在、大概多远、正在靠近还是离开。

**硬约束**
- 检测跑在浏览器端，**原图不出本机**；服务端只收结构化 track（标签 / 置信度 / 归一化框）
- 10fps 检测；坐标归一化到 0~1，深度只用框高反推相对远近，不做厘米级标定
- 只有变化才注入提示词，避免每轮重复描述烧 token

**落地（2026-11-26）**
- 纯逻辑：[liveVision.js](../src/core/liveVision.js)：track 生命周期（IoU + 中心距匹配、稳定 id、速度、进入/离开确认窗口）、事件（进入/离开/靠近/走远/横向移动/人数变化）、紧凑中文场景摘要、按变化消费的提示词段；单测 `test/liveVision.test.js` 9 项
- 路由：[routes/vision.js](../src/server/routes/vision.js)：`POST /api/vision/tracks`（批量上报）、`GET /api/vision/scene`、`POST /api/vision/off`、`POST /api/vision/toggle`；只在内存，不落盘
- 页面：[live-vision.html](../public/live-vision.html) + [live-vision.js](../public/live-vision.js)：getUserMedia 640×480 → MediaPipe ObjectDetector（EfficientDet-Lite0，约 10fps）→ 画框 → 每 120ms 批量上报；页面隐藏即停摄像头并清空服务端场景
- 提示词：`output.js` 在场景提示之后注入「【实时画面】」，只对 role / interaction 两条本机通道生效；`narrator.js` 在自主发言的提示词里也注入同一段（仅 web 通道）；画面超过 8 秒没更新不注入，没变化时 20 秒才补一次
- 姿态识别（2026-11-27）：页面额外加载 Pose Landmarker（5fps，本地模型），用手腕与肩膀的相对位置判断「举手」，用 1.2 秒内手腕横向来回判断「挥手」；挥手单独走 60 秒冷却触发主动开口。姿态模型缺失时自动退回纯物体检测，不影响主流程
- 表情、视线与细手势（2026-11-27）：Face Landmarker（3fps，blendshapes）判断微笑/大笑/皱眉/惊讶/张嘴与「看你/看别处/看左右上下」，并统计 60 秒眨眼次数、挑眉、嘴角不对称；Hand Landmarker（3fps）数手指，识别 OK/竖拇指/张开手掌/握拳/数字1-4。全部只进场景摘要，不单独记事件，避免刷屏
- 朝向与姿势（2026-11-27）：复用姿态关键点补一层——鼻尖相对双肩/双眼中点的位置判断「面向/侧身/背对」与「正对/侧头」，手腕相对髋部/胸口/脸判断「叉腰/抱胸/托腮」；不新增模型与下载体积
- 动作识别（2026-11-27）：只靠框的运动学推断人体动作——靠近 / 走远 / 走动 / 坐着 / 站着，坐下与站起来会各记一次事件
- 交互（2026-11-27）：人进入/离开画面时产出一次「主动开口」由头，10 分钟冷却；用户 3 分钟内说过话就不插嘴，交给正常回复；由 `notifyVisionEvent` 走现有自主发言链路（含征询与主题饱和闸门），不另造通道
- 本地资源：模型 `public/models/efficientdet_lite0.tflite`（7.2MB）、`pose_landmarker_full.task`（9.4MB）、`face_landmarker.task`（3.8MB）、`hand_landmarker.task`（7.8MB），WASM 与 ESM 包 `public/vendor/mediapipe/`（约 30MB）；依赖 `@mediapipe/tasks-vision`；CSP 增加 `'wasm-unsafe-eval'`。表情/手势/姿态任一模型缺失都会自动降级，不影响其他能力

**验收**
- 打开 `/live-vision.html` 授权摄像头后，预览画面出现检测框，右上角帧率约 10fps
- 人走进画面，对话里能被自然带出（「你过来了」这类），且不会每轮重复同一句
- 关页面后场景清空，后续对话不再提画面

**待办**
- 真机验证（不同光线 / 摄像头角度下确认误检率与 CPU 占用，尤其是 5fps 姿态推理的额外开销）
- 本地姿态模型来自 HuggingFace 镜像 `DeveloperDobby/mediapipe-pose-landmarker-full`（9.4MB），后续可换 lite 版降 CPU

---

## E. 安全模块

**目标（三件事，按用户口径）**
1. 暴露「可能的病毒父本」位置：任何写入/执行/安装/导入都留痕，能从一个可疑文件反查到是谁、何时、从哪来
2. 检查开源投毒与危险命令：系统崩溃级、破坏硬件级动作拦截；依赖供应链的可疑变更可见
3. 网络层流量劫持的发现与「反制」：定位原因、尽量恢复、暴露对端 IP；**不攻击对方**

**边界**：只管经过本系统工具层（run_command / run_python / run_node / 编码沙箱写入）的动作，管不了系统其它程序与内核层劫持；内核级只能发现迹象（见 coldStart 流量体检），无法在用户态还原。

**P1 危险命令闸门 + 父本账本（已完成 2026-11-27）**
- 纯逻辑：[commandGuard.js](../src/core/securityGuard/commandGuard.js)：`check()` 返回 `ok / confirm / block`；BLOCK（分区/裸盘写/引导配置/卷影删除/根目录删除/wipe/刷固件/调硬件/改系统注册表/fork 炸弹）直接拒，CONFIRM（关机重启/删注册表/编码混淆 shell/管道喂 shell/强推/改根属主）只记账交给上层审批
- 账本：[provenance.js](../src/core/securityGuard/provenance.js)：JSONL 落 `data/security/provenance.jsonl`，字段含 action / source / path / command / sha256 / actor；超 4MB 轮转保留最近 3000 行；`explain(path)` 支持文件与目录前缀双向匹配
- 接线：[codeExecTools.js](../src/core/codeExecTools.js) 的 `runCommand` 先过闸门（拦截即留痕且不进沙箱），`runScript` 记一次 write；`securityGuard` 可注入，便于测试
- 只读接口：[routes/security.js](../src/server/routes/security.js)：`GET /api/security/events`、`GET /api/security/explain?path=`、`GET /api/security/rules`；刻意不提供放行与删记录入口
- 测试：`test/securityGuard.test.js`（拦截 / 审批 / 放行 / 账本 / 执行链留痕）

**P2 开源投毒检查（已完成 2026-11-27）**
- 脚本：[scripts/dependency-audit.js](../scripts/dependency-audit.js)，零新增依赖；`npm run security:deps`，支持 `--json` 与 `--update-baseline`
- 对比基线：与 `data/security/dependency-baseline.json` 逐包比较——同版本但 integrity 变了直接报高（偷换包）、版本变化报中、官方源被换成 git/file/裸 http 报高、缺 integrity 报中
- 安装期脚本：项目的 `preinstall/install/postinstall` 与 node_modules 顶层依赖的同类脚本；基线允许名单之外新出现的报高
- typosquat：直接依赖名与 80 个常见包名做带换位的编辑距离比对（`axois`→`axios`、`expres`→`express`）
- 基线现状：199 个包、0 个安装期脚本，首次运行 0 命中；测试 `test/dependencyAudit.test.js` 8 项
- 未做：`npm ci` 实际 tarball 校验（要下载包，暂不跑网络）；间接依赖的安装脚本（只扫顶层，避免噪音）

**P3 网络基线（未开始）**
**P3 网络基线（已完成 2026-11-27）**
- 脚本：[scripts/network-baseline.js](../scripts/network-baseline.js)，零新增依赖；`npm run security:net`，支持 `--json`、`--update-baseline`、`--no-doh`
- 根证书：枚举 `LocalMachine\Root` 与 `CurrentUser\Root`，与基线比指纹；新增普通 CA 报中，命中抓包工具名单（Fiddler/Charles/mitmproxy/Clash…）报高，并给出 `certutil -delstore` 删除命令
- 代理 / PAC：注册表 `Internet Settings` 的 ProxyServer、AutoConfigURL、开关状态相对基线的变化
- DNS：系统解析 vs DoH（doh.pub / 阿里 223.5.5.5）交叉比对；解析到内网/回环直接报高并列出对端 IP，普通不一致只作低优先提示（CDN 分流会天然不同）
- 网关：默认路由 + 邻居表取网关 MAC，MAC 漂移报高（疑似 ARP 欺骗）并输出对端 IP/MAC；首次记录报低
- 复用 coldStart 的启动面体检：hosts 改指、TLS 校验被关、会话密钥落盘等仍报高
- 基线落 `data/security/network-baseline.json`；首次运行实测：根证书 54 张、网关 10.15.0.1、系统代理 127.0.0.1:7897，复检 0 高 0 中
- 测试 `test/networkBaseline.test.js` 7 项（纯逻辑，不跑 PowerShell、不联网）
- 边界：内核层劫持与驱动级篡改仍无法在用户态还原；DNS 比对受 CDN 影响，只把「解析到内网」定为高

---

## 通用约定

- 优先零新增依赖；必须加时先说明理由
- 代码注释、文档、提交说明一律中文
- 改动后同步 `src/core/index.md`（职责 / 导出 / 测试列）与 `docs/FUNCTIONALITY.md`
- 测试用 `node --test`，新增逻辑配单测；安全演练不跑网络依赖
- 当前服务进程需重启才加载新代码；测试用临时端口，测完关闭
