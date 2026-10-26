# A4 — 命令行文本统计工具

**类别**：A（独立新任务）
**产物**：`bench/tasks/A4/solution/wordstat.mjs`（ESM CLI，Node ≥ 20，零依赖，不联网）

给定样例输入已放在 `bench/tasks/A4/fixture/`（只读，不要改动）：
`one.txt`、`two.txt`（CRLF）、`three.txt`（UTF-8 非 ASCII 内容）、`empty.txt`（0 字节）、`ünïcøde.txt`（非 ASCII 文件名）。

## 用法

```
node bench/tasks/A4/solution/wordstat.mjs [--json] <file> [<file>...]
```

参数顺序任意（`--json` 可出现在任意位置）。**只输出到 stdout，不写任何文件。**

## 统计口径（必须严格一致）

- **bytes**：文件原始**字节数**（用 `Buffer.length`，不是字符数）。
- **lines**：先按 `\n` 切分，得到若干段；**最后一个段若非空则计 1 行，为空则不计**；
  空文件（0 字节）计 `0` 行。例：`"a\nb\n"` → 2 行，`"a\nb"` → 2 行，`"a\n\n"` → 2 行。
- **words**：对每一行先去掉**行尾**的一个 `\r`（若存在），再按 `/[ \t]+/` 切分，
  丢弃空串后计数。因此空行计 0 个词；`" one\r\n"` → 1 个词。
- 不做其它规范化（不合并连续空格外的空白，不处理 BOM，不折叠大小写）。

## 输出格式

**默认（plain）模式**：每个文件一行，字段用 **TAB**(`\t`) 分隔，每行以 `\n` 结尾（含最后一行）：

```
<path>\tlines=<n>\twords=<n>\tbytes=<n>
```

最后追加总计行 `<TOTAL>\tlines=<sum>\twords=<sum>\tbytes=<sum>`。
`<path>` 必须**原样**回显命令行里给的路径字符串（不 resolve、不 normalize）。
重复路径只统计一次（保留首次出现的位置）；输出顺序 = 去重后的命令行顺序。

**`--json` 模式**：只打印**一行** JSON（UTF-8、无 BOM、以 `\n` 结尾），必须是紧凑形式
（`JSON.stringify(obj)` 默认输出，冒号/逗号后**无空格**），且键顺序必须固定为：

```json
{"files":[{"path":"...","lines":0,"words":0,"bytes":0}],"totals":{"files":0,"lines":0,"words":0,"bytes":0}}
```

## 错误处理

| 情形 | stderr | 退出码 |
| --- | --- | --- |
| 文件不存在或不可读 | 首行以 `E_NOENT: ` 开头，后接该路径原样字符串 | `2` |
| 未提供任何文件参数 | 首行以 `usage:` 开头（全小写） | `1` |
| 出现以 `--` 开头且非 `--json` 的参数 | 首行以 `E_BAD_ARG` 开头 | `1` |

多个缺失文件时，报告第一个（按命令行顺序）即可。

## 约束

- 只允许 `node:` 内置模块（`node:fs`、`node:process` 等）。
- 不要修改 `fixture/` 下任何文件，也不要修改 `task.md` / `verify.mjs`。

验收命令：node bench/tasks/A4/verify.mjs
