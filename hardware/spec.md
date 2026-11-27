# 桌面半身·硬件设计（无打印机版）

> 状态：方案 + 可跑的协议模拟器已就绪；打印件延后，等有打印机或打印服务再出正式件。
> 原则：先用标准件把「神经」接通，再让打印件只承担不可替代的转接。

## 1. 形态与自由度

第一版只做**桌面半身**：

- 手机当脸：屏幕 + 前摄 + 麦克风/扬声器（不自制屏幕，省掉最难的部分）
- 两个自由度：`pan`（左右，−90°~+90°）、`tilt`（俯仰，−30°~+60°）
- 一个灯：`led`（呼吸/情绪色），不参与运动判据
- 电源：舵机独立 5V，ESP32 单独供电，共地

暂不做：移动底盘、机械臂、触摸皮肤、电池包。这些都要等第一版动作闭环稳定后再加。

## 2. 不需要打印机的最小采购清单

| 件 | 规格 | 数量 | 用途 |
|---|---|---|---|
| 云台支架套件 | SG90/MG90S 通用二自由度 | 1 | 省掉颈部打印件 |
| 舵机 | MG90S 金属齿 | 2 | pan / tilt，塑料齿容易扫齿 |
| 主控 | ESP32-S3 DevKit（带 USB-C） | 1 | 跑 HTTP 服务 + PWM |
| 电源 | 5V/3A 适配器 + DC 分线 | 1 | 舵机独立供电 |
| 降压 | 5V→3.3V 或独立 USB 供电 | 1 | 主控供电，避免舵机拉垮 |
| 手机夹 | 弹簧夹，宽 60–90mm | 1 | 夹住手机 |
| 结构底板 | 亚克力/木板 150×150×5mm | 1 | 配重与走线，可手工开孔 |
| 紧固件 | M2.5/M3 螺丝与螺母 | 若干 | 装配 |

打印件只保留三件，等有打印机再做：手机托架、颈部转接、底板压线盖。

## 3. 接口契约（先定死，再做实物）

沿用主项目已有的 [deviceLinkClient.js](../src/core/deviceLinkClient.js) 协议，不自造一套：

- `GET /v1/capabilities` → `{ actions: [...], serial: { mode, battery, joints: { pan, tilt } } }`
- `POST /v1/actions` `{ "action": "nod" }` → `{ result: { success: true } }`
- `GET /v1/inbox?since=<cursor>` → `{ events: [...], cursor }`（事件字段与 `DeviceLinkClient` 的消费口径一致）
- `POST /v1/reply` → `{ success: true }`

动作名：`nod`、`look_left`、`look_right`、`center`、`set_led`。

约束：

- 动作执行期间 `mode` 必须为 `executing`，结束时回 `idle`；主项目靠这个判断「还在动」而不是「没动」。
- 关节角度必须是数字、单位度；不动就不要写。
- 4xx 表示平台拒绝该指令，不要用 5xx 冒充。
- 局域网监听必须带 token（`Authorization: Bearer`）。

## 4. 机械接口（打印前必须量的数）

打印件参数化前，用卡尺量这些值写进 `hardware/measurements.md`：

- 手机：宽、厚、摄像头模组位置与凸起高度
- 舵机：本体长宽高、输出轴中心到安装孔距离、舵盘直径
- 云台支架：底座孔距、立柱高度
- 底板：螺丝孔位、走线孔直径

公差基线（FDM）：孔 +0.25mm、槽 +0.3mm、热熔铜螺母按 M2.5 外径 −0.1mm。

## 5. 无打印机怎么验证

1. **协议先通**：`node hardware/mock-device/server.js` 起模拟设备（默认 7788），跑 `node hardware/mock-device/selftest.js`，确认 `refresh → observe → enqueue → 运动判据` 全链路。
2. **固件同契约**：ESP32 按第 3 节实现同样的四个接口，主项目不改代码即可接上。
3. **结构用纸板/亚克力试装**：手机夹 + 云台支架先手装，验证重心和视角，不再等打印。
4. **要打印时**：把 STL 交给打印服务，或等打印机到位后按第 4 节的实测值生成参数化模型。

### 5.1 3D 建模流程（参数 → SCAD / STL / SVG）

1. 写参数：`hardware/model/specs/*.json`（宽/深/高、底板、背板、前挡；单位 mm）。
2. 出模型：`node hardware/model/build.js [spec]`。只用 Node 标准库：轮廓耳切三角化 → 沿厚度拉伸 → 水密性校验，输出到 `hardware/model/out/`：
   - `<name>.scad`：参数化 OpenSCAD 源码，可继续手改；
   - `<name>.stl`：Z 向上，可直接切片或送打印；
   - `<name>.step`：AP214 `FACETED_BREP + POLY_LOOP`，Inventor 2027 实测按实体打开；
   - `<name>.svg`：等轴测着色预览，不依赖 CAD。
3. 自检：脚本拒绝过厚背板/过高前挡，并检查每条无向边恰好被两个三角面使用；`node --test test/hardwareModel.test.js` 复跑。
4. 已生成示例：`phone-stand` 80×60×70 mm，28 个三角面，66 cm³；`gear-blank` 18 齿、74 个平面、284 个三角面；`stand-with-gear` 组合件，2 个独立实体（10 + 74 个面）；`hydrant-hollow` 隐式镂空消防栓，单一实体，内腔 + 6 个穿墙窗口 + 2 个接口内孔，1.8 mm 网格下 33,020 个三角面（`cell` 调大可减面）；`impeller-hollow` 隐式镂空离心叶轮，空心轮毂 + 8 片径向叶片 + 底盘窗口，单一实体。

## 6. 接线与固件仿真（Wokwi）

### 6.1 接线表

| 信号 | ESP32-S3 | 对端 | 线色 |
|---|---|---|---|
| pan PWM | GPIO4 | pan 舵机 PWM | 绿 |
| tilt PWM | GPIO5 | tilt 舵机 PWM | 绿 |
| 舵机电源 | **独立 5V/3A 适配器** | 两舵机 V+ | 红 |
| 地 | 公共地（适配器 GND ↔ 开发板 GND） | 两舵机 GND | 黑 |
| 状态灯 | GPIO15 → 220Ω | LED 阳极；阴极接 GND | 黄/黑 |

- 仿真图里舵机 V+ 接 `esp:5V` 只是 Wokwi 占位；实机不要从开发板 5V 引脚取电，两个 MG90S 堵转峰值会拉垮主控。
- 逻辑角度以 0 为居中：`pan -60..60`、`tilt -30..60`，固件内夹紧，不依赖模型侧约束。

### 6.2 仿真工程

- `hardware/sim/wokwi/diagram.json`：ESP32-S3 DevKitC-1 + 双舵机 + 状态灯。
- `hardware/sim/wokwi/main.py`：MicroPython 固件逻辑（PWM 映射、限位、上电回中、空闲 3 秒回中、串口命令）。
- 运行方式：wokwi.com → New Project → ESP32-S3 → **MicroPython 模板**（标签页必须是 `main.py`，不是 `sketch.ino`）→ 粘贴两份文件 → Start Simulation。
- 串口命令：`pan <角度>`、`tilt <角度>`、`nod`、`left`、`right`、`center`、`demo`、`state`、`help`。
- 本地逻辑自检（不需要 Wokwi）：`python hardware/sim/wokwi/selftest.py`。

## 7. 独立硬件建模通道（不接角色 / 沙箱）

- **边界**：不注册到 `toolRegistry`；角色、QQ、B 站、编程沙箱都没有调用入口。独立进程只 `require` `hardware/model/`，不读 `src/`、不碰记忆与沙箱工作区。
- **命令**：
  ```powershell
  npm run hw:list
  npm run hw:build -- hardware/model/specs/hydrant-hollow.json
  npm run hw:serve
  ```
- **界面入口**：主控台菜单「硬件建模」→ `http://localhost:41888/hardware.html`；可列模型、构建、下载 STEP/STL/SVG。
- **启动脚本**：Windows `scripts\windows\start_hardware.bat`，`start_server.bat` 会自动拉起（41900 已监听则跳过）；Linux `bash scripts/linux/start.sh` 会后台启动。
- **独立设计代理**：`npm run hw:design -- "设计一个镂空的消防栓" --rounds 4`；叶轮用 `--type impeller`。
  - 只读 `.env` 的模型配置（`DESIGN_API_CHANNEL` 或 `CURRENT_API`），不加载角色、记忆、工具表或沙箱。
  - 自己出参数 → 调 `41900 /v1/build` → 按回执迭代；通过后写入 `hardware/model/designs/`，不自动进 `specs/`。
- **HTTP**（默认只监听 `127.0.0.1:41900`）：
  - `GET /health`：存活检查，不需要鉴权
  - `GET /v1/parts`：列出 `specs/*.json`
  - `POST /v1/build`：body `{ "spec": { ... } }` 或 `{ "file": "xxx.json" }`，返回包围盒、体积、面数、文件名
  - `GET /v1/files/<name>`：下载 `out/` 下的文件（仅限 step/stl/svg/scad，需鉴权）
- **鉴权**：设置 `HARDWARE_MODEL_TOKEN` 后，`/v1/parts` 与 `/v1/build` 需要 `Authorization: Bearer <token>`；不设置则仅本机可访问。
- **安全**：只接受内联 spec 或 `specs/` 下的文件名，不接受任意路径；请求体上限 64 KB；构建串行，忙时返回 429；所有错误走 400，不暴露堆栈。

## 8. 安全

- 舵机限位写进固件（软件限位 + 机械挡块），不依赖模型侧约束。
- 上电回中；断线 3 秒无指令回中。
- 堵转保护：单次动作超过 2 秒或电流异常即停。
- HTTP 只监听可信网段，必须 token；不接受任意 URL 动作。

## 9. 验收

- [ ] 模拟器与客户端闭环通过（motion verdict = `moved`）
- [ ] ESP32 实机实现同一契约，`check_body` 能读到 pan/tilt
- [ ] 说「点头」时实物动作，延迟可测且 < 1s
- [ ] 断网/断电后回中，不出现持续堵转
