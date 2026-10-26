# C4 — CSV 解析 / 规范化 / 表头映射（库 + CLI）

**类别**：C（大量早期硬约束）
**产物**：`bench/tasks/C4/solution/csv.mjs`（ESM，Node ≥ 20，零依赖，不联网）
**只读输入**：`bench/tasks/C4/fixture/data.csv`、`bench/tasks/C4/fixture/keep.json`

## 需求

```js
export function parseCSV(text)        // -> string[][]
export function toCSV(rows)           // -> string
export function parseRecords(text)    // -> Record<string, string>[]（首行为表头）
```

## 一、解析规则（唯一正确解释）

- 字段分隔符 `,`，引号字符 `"`，`""` 表示一个字面 `"`。
- 行终止符：引号**外**的 `\r\n` 或 `\n` 结束一行；`\r` 单独出现时不作为终止符。
- 引号**内**的 `,`、`\r`、`\n` 都属于字段内容，且**原样保留**（不做任何换行规范化）。
- 字段首尾的普通空格属于字段内容（`"  a  "` → `  a  `）。
- 文本起始的 BOM（`U+FEFF`）必须剥离。
- 行尾终止符之后若没有更多内容，**不得**再产生一个空行：`'a,b\n'` → `[['a','b']]`。
- `''` → `[]`；`'\n'` → `[['']]`；`'solo'` → `[['solo']]`；`'a,,b'` → `[['a','','b']]`。
- 未闭合引号（到达文本结束仍未闭合）→ `throw`，`err.code === 'E_UNTERMINATED_QUOTE'`。
- 非字符串入参 → `throw`，`err.code === 'E_INVALID_INPUT'`。
- 引号字段之后紧跟非分隔/非终止字符（如 `'"a"b,c'`）属输入畸形，判分不考核其行为。

## 二、生成规则 `toCSV(rows)`

- `rows` 必须是数组，且每个元素必须是数组，否则 `throw`，`err.code === 'E_INVALID_ROW'`。
- 字段值转换：`string` 原样；`number`/`bigint` → `String(v)`；`boolean` → `'true'`/`'false'`；
  `null`/`undefined` → 空字段；其它类型（对象、数组、`Symbol`、函数）→ `throw`，`err.code === 'E_INVALID_VALUE'`。
- **最小引用**：当且仅当字段包含 `,`、`"`、`\r`、`\n`，**或**以空格/制表符开头或结尾时，才用 `"` 包裹；
  字段内的 `"` 转义为 `""`。空字段不加引号。
- **每一行**（含最后一行）都以 `\r\n` 结尾。

## 三、`parseRecords(text)`

- 用第一节规则解析；第一行为表头，其余为数据行。
- 返回对象数组，每个对象的**键顺序 = 表头列顺序**，值一律为字符串，空单元格为 `''`。
- 表头出现重复名 → `throw`，`err.code === 'E_DUPLICATE_HEADER'`。
- 任一数据行的列数 ≠ 表头列数 → `throw`，`err.code === 'E_RAGGED_ROW'`。
- 只有表头没有数据行 → 返回 `[]`。

## 四、CLI

```
node bench/tasks/C4/solution/csv.mjs <file> [--out <path>] [--dry-run]
```

- 解析 `<file>`，stdout 打印**一行**紧凑 JSON：`{"rows":<数据行数含表头>,"cols":<表头列数>}`（以 `\n` 结尾，UTF-8 无 BOM）。
- 存在行列数 ≠ 表头列数时：不打印 stdout，stderr 首行为 `E_RAGGED_ROW`，退出码 `3`。
- `--out <path>`：把规范化结果 `toCSV(parseCSV(text))` 写入该路径（UTF-8、无 BOM）。
- `--dry-run`：**不得创建或修改任何文件**，stdout 首行必须是 `DRY-RUN <path>`（未给 `--out` 时为 `DRY-RUN stdout`），退出码 `0`。
- `<file>` 不存在 → stderr 首行 `E_NOENT: <file>`，退出码 `2`；未提供 `<file>` → `usage:`，退出码 `1`；
  未知 `--xxx` → `E_BAD_ARG`，退出码 `1`。

## 五、硬约束清单（判分逐条独立检查）

| # | 约束 |
| --- | --- |
| 1 | 导出 `parseCSV`、`toCSV`、`parseRecords` 三个函数 |
| 2 | 解析规则逐字段正确（引号、`""`、字段内 `,`/`\n`/`\r\n`、空格保留、`fixture/data.csv` 全表比对） |
| 3 | 边界：BOM 剥离、`\r\n` 与 `\n` 等价、末尾终止符不产生空行、`''`/`'\n'`/`'solo'`/`'a,,b'` 结果精确 |
| 4 | 往返不变量：对判分给出的每组 `rows`，`parseCSV(toCSV(rows))` 必须深等于 `rows` |
| 5 | `toCSV` 输出必须逐字符匹配（最小引用 + 每行 `\r\n`），且非法行/非法值分别抛 `E_INVALID_ROW`/`E_INVALID_VALUE` |
| 6 | 错误码逐一命中：`E_INVALID_INPUT`、`E_UNTERMINATED_QUOTE`、`E_RAGGED_ROW`、`E_DUPLICATE_HEADER` |
| 7 | `parseRecords`：键顺序 = 表头顺序、空单元格为 `''`、仅表头返回 `[]` |
| 8 | 工程约束：源码不含 `require(`，`from '…'` 只允许 `node:` 前缀；每行长度 ≤ 100；`fixture/keep.json` 一字节都不许变；CLI `--dry-run --out solution/<任意名>.csv` 不得产生任何文件且首行输出 `DRY-RUN <path>` |

不要修改 `task.md`、`verify.mjs`、`fixture/` 下任何文件。

验收命令：node bench/tasks/C4/verify.mjs
