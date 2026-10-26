# C2 — 确定性 JSON 序列化器（stableStringify）

**类别**：C（大量早期硬约束）
**产物**：`bench/tasks/C2/solution/stable.mjs`（ESM，Node ≥ 20，零依赖，不联网）
**只读输入**：`bench/tasks/C2/fixture/keep.json`

## 需求

实现一个**键序稳定**的 JSON 序列化函数（用于做配置指纹/快照对比）：

```js
export const STABLE_VERSION = '2';   // 字面量 '2'
export function stableStringify(value, options = {})   // -> string | undefined
```

`options.indent`：数字，缺省 `0`。`0` 为紧凑模式；`n > 0` 时每层缩进 `n` 个空格。
其它 `options` 键一律忽略。

## 语义（唯一正确解释）

1. **键序**：对象（含嵌套对象、数组里的对象）的键必须按 **UTF-16 码元升序** 输出，
   即 `Object.keys(v).sort()` 的默认比较结果。因此 `'10'` 排在 `'9'` 之前、`'A'` 排在 `'a'` 之前。
   **数组顺序保持不变**，绝不排序数组元素。
2. **排版**：与 `JSON.stringify` 完全一致 ——
   紧凑模式无多余空白（`{"a":1,"b":[1,2]}`）；
   indent 模式为 `"key": value`（冒号后**一个**空格）、每个成员独占一行、
   空对象输出 `{}`、空数组输出 `[]`（均不换行、不产生空行）。
3. **值语义**：
   - 顶层值是 `undefined` 或函数 → 返回 `undefined`（不抛错、不输出字符串）。
   - 对象里值为 `undefined` 或函数的键 → **该键被剔除**。
   - 数组里值为 `undefined` 或函数的元素 → 输出 `null`。
   - `Date` 实例 → 输出其 `toISOString()` 字符串。
   - `BigInt` → 输出其十进制**字符串**形式（`10n` → `"10"`）。
   - 对象（含 `Date`）若具有可调用的 `toJSON` 方法 → **先调用 `toJSON()`（不传参）**，
     再用返回值继续序列化。
   - 字符串转义必须与 `JSON.stringify` 一致。
4. **`NaN` / `Infinity` / `-Infinity`**（出现在任意深度）→ `throw`，`err.code === 'E_NON_FINITE_NUMBER'`。
5. **循环引用** → `throw`，`err.code === 'E_CYCLE'`。
   仅当对象在**当前引用链**上重复出现才算环；同一对象在两个不同分支各出现一次**不是**环，必须正常输出。
6. 纯函数：不得修改入参；对同一入参重复调用必须返回逐字节相同的字符串；
   非空返回值必须能被 `JSON.parse` 解析。

## 硬约束清单（判分逐条独立检查）

| # | 约束 |
| --- | --- |
| 1 | 导出 `stableStringify`（函数）与 `STABLE_VERSION === '2'` |
| 2 | 键序必须为 UTF-16 码元升序（含数字样键、大写/小写、非 ASCII 键、任意深度嵌套），数组元素顺序不变 |
| 3 | `indent` 模式排版必须逐字符匹配（含冒号后单空格、空对象 `{}` / 空数组 `[]` 不换行） |
| 4 | 循环引用必须抛 `err.code === 'E_CYCLE'`，且"同一对象出现在两个分支"不得误判为环 |
| 5 | 任意深度的 `NaN`/`Infinity` 必须抛 `err.code === 'E_NON_FINITE_NUMBER'` |
| 6 | 值语义（顶层 undefined/函数、对象剔除键、数组 `null`、`Date`、`BigInt`、`toJSON`、字符串转义）必须逐条正确 |
| 7 | 纯函数：入参不被修改；两次调用逐字节一致；输出可被 `JSON.parse` |
| 8 | 工程约束：源码不含 `require(`，`from '…'` 只允许 `node:` 前缀；每行长度 ≤ 100；`fixture/keep.json` 一字节都不许变 |

不要修改 `task.md`、`verify.mjs`、`fixture/` 下任何文件。

验收命令：node bench/tasks/C2/verify.mjs
