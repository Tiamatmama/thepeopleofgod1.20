未经真实数据验证（synthetic fixture only）

# blindstats 契约

## 来源

- 来源类型：`method-ref`。方法参考自一个已废弃的盲测实验，仅保留统计口径，不继承其代码、数据或硬编码。
- 不是 `derived-from`：本工具是全新实现，不得与任何历史聚合脚本（包括废弃实验中的 `blind_aggregate.py`）对数字。
- 本目录内所有 fixture 均为合成数据，臂名固定为 `arm1..arm5`，不代表任何真实模型、产品线或评分人。

## 用法

    python blindstats.py --input DIR --out FILE [--arms a,b,...] [--floor a,b]

- `--input`：必填，目录；只读取该目录下直接子级的 `*.jsonl`，不递归。
- `--out`：必填，输出 JSON 路径；先写 `FILE.tmp` 再原子替换，失败时清理临时文件。
- `--arms`：可选白名单。默认臂集合由数据推导；传入后白名单外的臂视为输入错误。
- `--floor`：可选噪声地板对照臂对，必须恰好两个且不同。工具只做配对符号检验，不判断这对臂是否真的是同一配置的重复。

## 投票记录格式

一行一票，UTF-8，空行忽略：

    {"rater": "r1", "q": "q1", "arm": "arm1"}

- 三个字段均必填，必须是非空字符串。
- 一个 `.jsonl` 文件只能属于一个 `rater`；文件内出现第二个 `rater` 即失败。
- 不同文件不得使用相同 `rater`。
- 空文件（去掉空行后零条记录）失败，不当作零票。
- 未知字段忽略。
- 坏 JSON、非对象行、缺字段/空字段、白名单外臂，全部硬拒。

## 校验顺序（固定）

1. 参数解析：缺 `--input`/`--out`、`--arms` 空名或重名、`--floor` 非两臂或同名。
2. 输入/输出路径：输入必须是目录；输出父目录必须存在；输出不能是目录；输出父目录不得与输入目录相同。
3. 文件枚举：只收 `*.jsonl`；拒绝符号链接、真实路径逃逸输入目录、非普通文件。报错只打印文件 basename。
4. 无可读投票文件：退出 1，`SUMMARY status=NO_DATA`。
5. 逐行扫描：坏 JSON、非对象、字段缺失/非法、白名单外臂、文件内混合 rater、跨文件重名 rater、空文件。
6. 总票数为 0：退出 1。
7. `--floor` 指定的臂不在数据中：退出 2。
8. 平衡性：各 rater 总票数必须相等；每个 q 下各 rater 票数也必须相等。不等则退出 1 并打印差额。
9. 聚合：至少 2 个臂、至少 1 个 rater、每个 q 有票、各臂 share 之和为 1。

## 失败路径

| 场景 | 退出码 | 关键输出 |
| --- | --- | --- |
| 缺 `--input` 或 `--out` | 2 | argparse usage |
| `--arms` 空名/重名 | 2 | `ERROR --arms ...` |
| `--floor` 不是两臂或两臂同名 | 2 | `ERROR --floor ...` |
| 输入不是目录 | 2 | `ERROR input is not a directory` |
| 输出父目录不存在 / 输出是目录 | 2 | `ERROR output ...` |
| 输出父目录与输入目录相同 | 2 | `ERROR output directory must differ` |
| 符号链接 / 路径逃逸 / 非普通文件 | 2 | `ERROR symlink not allowed` 等，仅 basename |
| 没有任何 `*.jsonl` | 1 | `SUMMARY status=NO_DATA` |
| 坏 JSON / 非对象 / 缺字段 | 2 | `ERROR bad JSON ...` / `ERROR bad record ...` |
| 文件内混合 rater | 2 | `ERROR mixed raters in <file>` |
| 跨文件重名 rater | 2 | `ERROR duplicate rater ... in <file1> and <file2>` |
| 空投票文件 | 2 | `ERROR empty votes file: <file>` |
| 白名单外未知臂 | 2 | `ERROR unknown arm '...' at <file>:<line>` |
| 总票数为 0 | 1 | `SUMMARY status=NO_DATA` |
| `--floor` 臂不在数据 | 2 | `ERROR --floor arm not in data: ...` |
| rater 总票数或每 q 票数不齐 | 1 | `ERROR unequal ... diff=N` + `SUMMARY status=NO_DATA` |
| 少于 2 个臂 / 无 rater / 某 q 无票 | 1 | `ERROR ...` + `SUMMARY status=NO_DATA` |
| 输出写入失败 | 2 | `ERROR cannot write output` |

所有输入校验使用显式分支与 `sys.exit`，代码中没有 `assert`，`python -O` 下行为不变。

## 退出码语义（冻结）

- `0`：输入合法，结论已产出并写盘。
- `1`：输入合法，但数据不足以产出结论（无数据、票数不齐、臂数不足等）。
- `2`：输入错误（参数、路径、记录格式、白名单、floor 引用）。

## SUMMARY

只保留两个值：

    SUMMARY status=OK qs=N raters=N arms=N votes=N
    SUMMARY status=NO_DATA

`SUMMARY` 不承载交付等级、显著性判断或质量评价。

## 输出 JSON

    {
      "raters": [...],
      "arms": [...],
      "qs": [...],
      "q": {
        "q1": {
          "N": 30,
          "p0": 0.2,
          "counts": {"arm1": 10, ...},
          "share": {"arm1": 0.333..., ...},
          "z": {"arm1": 1.83, ...},
          "p": {"arm1": 0.068, ...},
          "floor": null
        }
      },
      "warnings": ["R<6: sign test is reference only"]
    }

- `N`、臂集合、q 集合、rater 集合全部由数据推导，没有写死的数量。
- `z = (count - p0*N) / sqrt(N*p0*(1-p0))`，`p0 = 1/臂数`，`p` 为双侧正态近似。
- `--floor` 时 `floor` 含：`pair`、`abs_share_gap`、`mean_vote_diff`、`positive_raters`、`negative_raters`、`sign_p`。
- `sign_p` 为精确双侧符号检验；无非零配对时取 1.0。

## 测不到什么

- 无法证明 `rater` 背后是不同的人，也无法证明是真人；重名只按字符串判重。
- 无法识别刷票、串谋、复制粘贴或同一人多账号。
- 平局/弃权没有单独编码；不投票不会进入数据，只能体现为票数不齐并被拒绝。
- `--floor` 传错臂对时，噪声地板失去意义，工具不会警告；它只检查臂存在。
- rater 少于 6 时符号检验只作参考，工具只输出 warning，不改变退出码。
- 正态近似在 `N` 很小或 share 接近 0/1 时不可靠；`p` 不是精确检验。
- `--arms` 只是可选白名单，不是统计参数，不影响 `p0` 之外的任何计算。
- `share` 的置信区间、多重比较校正、序贯检验均未实现。
- 平衡性校验是刻意严格：缺票直接拒绝，不做缺失值插补，也不按现有票数重新归一化。

## 3 条命令自证

    python blindstats.py --input fixtures/normal_synthetic --out out.json
    python blindstats.py --input fixtures/count_mismatch_synthetic --out out.json
    python blindstats.py --input fixtures/empty_dir_synthetic --out out.json

依次应得到退出码 `0`、`1`、`1`；第一条输出 `SUMMARY status=OK qs=3 raters=3 arms=5 votes=90`，后两条输出 `SUMMARY status=NO_DATA`。

测试：

    python -m unittest discover -s tests -p "test_*.py"
