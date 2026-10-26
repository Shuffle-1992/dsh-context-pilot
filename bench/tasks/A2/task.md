# A2 — 最小行级 diff 与回填

**类别**：A（独立新任务）
**产物**：`bench/tasks/A2/solution/diff.mjs`（ESM，Node ≥ 20，零依赖，不联网）

## 需求

实现纯函数式的行级 diff，具名导出三个函数：

```js
export function diffLines(oldText, newText)   // -> Op[]
export function applyDiff(oldText, ops)       // -> string
export function diffStats(ops)                // -> { added, removed, equal }
```

`Op` 形如 `{ op: 'equal' | 'add' | 'del', line: string }`。

## 语义约定

1. **分行规则**：`text.split('\n')`，不做任何裁剪或规范化（不处理 `\r`，不丢弃尾部空行）。
   因此 `'a\n'` 分行结果是 `['a', '']`，与 `'a'`（`['a']`）**不同**。
2. `diffLines` 必须给出**最小编辑脚本**：`equal` 的行数等于两序列的 LCS 长度，
   `removed = len(oldLines) - lcs`，`added = len(newLines) - lcs`（判分用独立 DP 校验）。
3. 输出顺序：按文本从上到下交织；同一位置的替换必须先输出全部 `del` 再输出对应 `add`；
   即过滤 `op !== 'add'` 得到的行序列必须严格等于 `oldLines`，过滤 `op !== 'del'` 必须严格等于 `newLines`。
4. `applyDiff(oldText, ops)` 依次消费 ops：`equal`/`add` 输出该行，`del` 跳过；
   用 `\n` join，必须满足 `applyDiff(oldText, diffLines(oldText, newText)) === newText`。
5. `diffStats(ops)` 统计三种 op 的条数，键顺序固定为 `{ added, removed, equal }`。
6. 入参必须都是字符串，否则 `throw new TypeError(...)`；`ops` 中出现未知 `op` 也必须 `throw new TypeError(...)`。
7. 不得修改入参，不得有随机性；对相同输入重复调用输出完全一致。

## 约束

- 零依赖：只允许 `node:` 内置模块（本任务无需任何 import）。
- 长度上限不考核，但算法必须是 LCS（贪心公共前缀/后缀也算实现手段，结果仍需最小）。
- 不要修改本目录下 `task.md` / `verify.mjs`。

验收命令：node bench/tasks/A2/verify.mjs
