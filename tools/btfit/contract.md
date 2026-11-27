# btfit

Bradley-Terry 强度拟合 CLI。零依赖，Python 3.10，可整目录复制。

来源（冻结副本，不回流）：

- `pairwise.py@60-63`：`logaddexp(a, b)`，逐行照搬。
- `pairwise.py@241-294`：`bt_fit`，MM(Zermelo) 迭代、L2 伪计数 + θ=0 幽灵对手、对数似然单调性校验、未收敛硬失败。
- `pairwise_report.json@487-503`：`fixtures/persona_W.json` 与 `fixtures/emotion_W.json` 的计数来源；`@225-236` 为历史 θ 期望值。

目标环境是 Python 3.10，因此副本必须保留本地 `logaddexp` 实现，禁止改用标准库中 3.11+ 才有的同名函数。

## 用法

```bash
python bt.py fit --input W.json [--l2 0.02] [--iters 5000] [--max-items 64]
python bt.py selftest
```

`--input` 必填，没有默认路径。`selftest` 跑 5 条合成回归，不读任何文件。

## 输入

UTF-8 JSON 对象，键是 `"A>B"`（A 胜 B），值是次数/权重：

```json
{ "new>old": 29, "old>new": 11 }
```

- 键必须恰好包含一个 `>`，两侧名字非空。名字本身含 `>` 无法表达（不做智能 split、不做模糊匹配）。
- 值必须是有限、非负的数值。`true/false` 冒充票数会被拒绝。
- 重复键会被拒绝（`object_pairs_hook` 在 JSON 解析阶段捕获，后值不会静默覆盖前值）。
- 权重是池化计数，不做 0/1 化、不做归一化。
- `{}` 是输入错误，不是「0 个 arm 的合法拟合」。

## 固定检查顺序

1. JSON 解析 + 重复键检测。
2. 从键推导名字集合与 `n`。
3. `--max-items` 检查（默认 64）。超限时矩阵尚未申请。
4. 建矩阵。
5. 键结构、自环、权重类型/有限性/非负校验。
6. 拟合。

顺序是契约的一部分：超大输入必须在分配 `n×n` 矩阵之前被拒绝。

## 失败路径

| 场景 | 退出码 | 输出 |
| --- | --- | --- |
| 缺 `--input` | 2 | argparse 用法 |
| 文件不存在 / 不可读 | 2 | `ERROR cannot read input: ...` |
| JSON 解析失败 | 2 | `ERROR JSON parse error: ...` |
| 重复键 | 2 | `ERROR duplicate key: ...` |
| 顶层不是对象 | 2 | `ERROR top-level JSON must be an object ...` |
| 空对象 | 2 | `ERROR empty input: 0 arms` |
| arm 数超过 `--max-items` | 2 | `ERROR too many arms: max_items=64 measured_n=...` |
| 键不是恰好一个 `>` / 有一侧为空 | 2 | `ERROR invalid key ...` |
| 自环 `A>A` | 2 | `ERROR self-loop not allowed ...` |
| 权重是 `bool` / 非数值 | 2 | `ERROR weight must be a number ...` |
| 权重为负 / 非有限 | 2 | `ERROR weight must be ...` |
| `--l2 <= 0` 或非有限 | 2 | `ERROR --l2 must be ...` |
| `--iters <= 0` 或超过硬上限 100000 | 2 | `ERROR --iters ...` |
| 合法输入但迭代未收敛 | 1 | `SUMMARY status=NO_CONVERGE ...` + stderr `ERROR ...` |
| 全部权重为 0 | 0 | `SUMMARY ... degenerate=1` + stderr 警告 |

未收敛一律退出 1，绝不输出未收敛的 θ。`-O` 下行为不变：所有校验都是显式分支，没有 `assert`。

## 退出码

- `0`：拟合完成（含 `degenerate=1` 的常量 0 向量）。
- `1`：输入合法，但下不了结论（未收敛 / MM 单调性被破坏）。
- `2`：输入错误，没有产出。

## SUMMARY

成功：

```
SUMMARY status=OK n=3 iters_cap=100000 iters_used=20 degenerate=0 theta=new:0.478608 theta=old:-0.273444 theta=old#dup:-0.205164
```

- 名字按 `sorted()` 分配下标并按名输出；测试按名断言，不按位置。
- `iters_used` 是实际迭代轮数；`iters_cap` 是硬上限常量。
- `degenerate=1` 只表示「没有任何比较」，不表示「各臂没有差异」。

## 数值语义（必须知道的边界）

- θ 是**相对量**，只在**同一次 fit、同一组 arm** 内可比。不同 fit、不同 arm 集合的 θ 不能直接相减。
- θ 的零点由 active arm 的均值锚定；增删 arm 会整体平移其余 arm 的 θ，但同一 fit 内的差值仍可解释。
- 平局按 0.5 处理；「全部平局」与「判官每对都掷硬币」在 W 上不可区分。
- W 没有完整性证明：缺失的对、漏记的对、只跑了一部分场景，都表现为权重偏小，工具不会替你发现。
- 名字不能含 `>`，因此无法表达名字本身带分隔符的 arm。
- L2 会压缩 θ 的尺度；比较不同 `--l2` 的绝对值没有意义，只能比较同 `--l2` 下的排序/差值。

## 真实回归口径

`fixtures/persona_W.json` / `fixtures/emotion_W.json` 的历史 θ 由 4 位小数报告给出（`old=-0.2725`、`new=0.477`、`old#dup=-0.2045`；emotion 同理）。

注意：历史报告对应的是 L2 伪计数 `eps=1.0`。在冻结公式 `eps = l2 * sum(W) / n` 下，这等价于 `--l2 0.025`；而冻结源码的默认值是 `0.02`（`eps=0.8`，persona 会得到 `new=0.478608`，与报告差约 `1.6e-3`）。因此：

- 默认值保持源码的 `0.02`；
- 报告回归测试显式传 `--l2 0.025`，按名断言容差 `1e-3`；
- 不要用默认 `--l2` 去对报告数字，也不要反过来改默认值迁就报告。

## 基准

n=64 全连通（每对随机 10–30 次），单次 fit：`iters_used=26`，壁钟约 `0.32s`（Windows / Python 3.10）。只记录这一行，不做自动 benchmark。

## 3 条命令自证

在空目录复制本目录后执行：

```bash
python bt.py selftest
python bt.py fit --input fixtures/persona_W.json --l2 0.025
python bt.py fit --input fixtures/dup_key.json; echo "exit=$?"
```

期望：第 1 条 `SUMMARY status=OK passed=5 total=5`；第 2 条 `status=OK` 且 `theta=new:0.476...`；第 3 条 stderr 报 `duplicate key`、`exit=2`。

完整门禁：`python tests/test_cli.py`（18 个用例，含 `-O` 未收敛与目录守卫扫描）。

## 测不到什么

- 测不到 W 是否来自真实盲测；工具只做拟合，不做数据来源审计。
- 测不到「未记录的对」是否存在，也测不到权重是否被上游重复累计。
- 测不到平局与判官异常的差别。
- 测不到 θ 的绝对水平；不同 arm 集合之间不可比。
- 测不到数值溢出边界之外的极端权重（未做任意精度）。
- 不做显著性检验、不做置信区间、不做模型选择。

## 来源冻结声明

`pairwise.py` 与 `pairwise_report.json` 是只读原件。本目录是副本，修复只发生在这里，不回流原件。fixture 每对合计 40 是原始采集的属性，不是 schema 要求；不得为了「整齐」把权重改成 0/1。
