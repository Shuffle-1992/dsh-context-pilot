# C1 — 中英混排 token 计数器（库 + CLI）

**类别**：C（大量早期硬约束）
**产物**：`bench/tasks/C1/solution/tokenize.mjs`（ESM，Node ≥ 20，零依赖，不联网）
**只读输入**：`bench/tasks/C1/fixture/sample.txt`、`bench/tasks/C1/fixture/keep.json`

## 需求

实现一个中英混排文本的 token 计数器，既是可 `import()` 的库，也是可执行的 CLI。

## 一、分词口径（唯一正确解释）

按 **Unicode 码点** 逐个扫描（`Array.from(text)`），规则如下，且**必须**按此顺序判定：

1. **空白**字符（码点为 `U+0020` 空格、`U+0009` 制表、`U+000A` LF、`U+000D` CR、`U+000C` FF、`U+000B` VT）：
   不产生 token，跳过。
2. **CJK 字符**（码点落在下列闭区间之一）：`U+4E00–U+9FFF`、`U+3400–U+4DBF`、`U+3040–U+30FF`、`U+F900–U+FAFF`。
   每个字符单独算 **1 个 token**，并计入 `cjk`。
3. **拉丁字母** `[A-Za-z]`：连续一段算 **1 个 token**，并计入 `latin`。
4. **数字** `[0-9]`：连续一段算 **1 个 token**（不计入 `latin`/`cjk`）。
5. **其它任何字符**（标点、符号、全角标点、emoji 等）：每个码点算 **1 个 token**。

`v2beta3` 应得到 4 个 token（`v` / `2` / `beta` / `3`）。
`chars` = 码点个数（**不是** UTF-16 长度，也**不是**字节数）。

## 二、库 API

```js
export const TOKEN_VERSION = '1';                  // 字面量 '1'
export const E_INVALID_INPUT = 'E_INVALID_INPUT';  // 字面量 'E_INVALID_INPUT'
export function countTokens(text)                  // -> number（token 总数）
export function stats(text)                        // -> { chars, tokens, cjk, latin }
```

`stats` 返回对象的**键顺序必须是 `chars`、`tokens`、`cjk`、`latin`**，
即 `JSON.stringify(stats(t))` 必须形如 `{"chars":3,"tokens":2,"cjk":0,"latin":2}`（紧凑、无空格）。

`countTokens` / `stats` 收到**非字符串**入参时必须抛错，且错误对象的 `code === E_INVALID_INPUT`。

## 三、CLI

```
node bench/tasks/C1/solution/tokenize.mjs <file> [--json] [--out <path>] [--dry-run]
```

- 读取 `<file>`（UTF-8），输出其 `stats`。
- `--json`：stdout 打印**一行**紧凑 JSON（UTF-8、无 BOM、以 `\n` 结尾）。未给 `--json` 时打印 `tokens=<n>` 一行。
- `--out <path>`：把同样的 JSON 写入该路径（UTF-8、**无 BOM**、**无结尾换行**）。
- `--dry-run`：**不得创建或修改任何文件**，且 stdout 首行必须是 `DRY-RUN <path>`（`<path>` 为 `--out` 原样字符串；未给 `--out` 时为 `DRY-RUN stdout`），退出码 `0`。
- `<file>` 不存在/不可读：stderr 首行以 `E_NOENT: ` 开头，退出码 `2`。
- 未提供 `<file>`：stderr 首行以 `usage:` 开头，退出码 `1`。
- 出现既非 `--json`/`--dry-run` 也非 `--out` 的 `--xxx`：stderr 首行以 `E_BAD_ARG` 开头，退出码 `1`。

## 四、硬约束清单（判分逐条独立检查）

| # | 约束 |
| --- | --- |
| 1 | 产物存在且导出 `countTokens`、`stats`、`TOKEN_VERSION === '1'`、`E_INVALID_INPUT === 'E_INVALID_INPUT'` |
| 2 | 非字符串入参：`countTokens` 与 `stats` 均抛出 `err.code === 'E_INVALID_INPUT'` |
| 3 | `stats()` 返回值的键顺序固定为 `chars,tokens,cjk,latin`（`JSON.stringify` 逐字符比对） |
| 4 | 分词口径与第一节完全一致（判分用多组内联用例逐字段比对） |
| 5 | CLI `--json` 对 `fixture/sample.txt` 的输出必须逐字符等于该文件按第一节的真实统计值 |
| 6 | CLI 错误处理：缺文件 `E_NOENT`/退出 2；无参数 `usage:`/退出 1；未知旗标 `E_BAD_ARG`/退出 1 |
| 7 | 工程约束：源码不得出现 `require(`，所有 `from '…'` 说明符必须以 `node:` 开头；源文件每行长度 ≤ 100 字符 |
| 8 | 无副作用写盘：`--dry-run --out solution/<任意名>.json` 不产生任何新文件且首行输出 `DRY-RUN <path>`；`fixture/keep.json` 一字节都不许变 |

不要修改 `task.md`、`verify.mjs`、`fixture/` 下任何文件。

验收命令：node bench/tasks/C1/verify.mjs
