# A3 — 配置解析器：深合并 + 环境变量覆盖 + 白名单裁剪

**类别**：A（独立新任务）
**产物**：`bench/tasks/A3/solution/config.mjs`（ESM，Node ≥ 20，零依赖，不联网）

## 需求

具名导出一个纯函数：

```js
export function buildConfig({ schema, raw, env, strict = false })
```

- `schema`：纯嵌套**普通对象**，叶子是其**默认值**（任意类型）。
- `raw`：用户提供的配置（可能为 `undefined` / `null`，此时按 `{}` 处理）。
- `env`：扁平字符串表（形如 `process.env`），可缺省（按 `{}`）。
- 返回值：合并后的配置对象，**不得**修改任何入参。

## 合并与覆盖规则（必须严格一致）

1. **深合并**：只有"普通对象"（`Object.getPrototypeOf(x)` 为 `Object.prototype` 或 `null`）之间才递归合并；
   数组、`Date`、函数、原始值一律**整体替换**（不做元素级合并）。
   若某键在 `schema` 中的默认值**不是**普通对象，则该位置整体取 `raw` 的值，白名单裁剪不再向下适用。
2. **键白名单**：结果只保留 `schema` 中存在的键（逐层比较），`raw` 中多出的键被丢弃；
   `strict === true` 时遇到被丢弃的键必须 `throw`，且 `err.code === 'E_UNKNOWN_KEY'`。
   输出对象每一层的**键顺序必须与 `schema` 一致**。
3. **原型污染防护**：`raw` 中键名为 `__proto__`、`constructor`、`prototype` 的条目一律忽略（不抛错，即使 `strict`）。
4. **env 覆盖**（在 `schema`+`raw` 合并结果之上生效）：
   - 只处理以 `CFG_` 开头的键，其余忽略。
   - 去掉前缀后按**双下划线** `__` 分层，每层再**转小写**得到路径段；
     例：`CFG_SERVER__PORT` → 路径 `server / port`；`CFG_LOGLEVEL` → `loglevel`。
     匹配时与结果对象**当前层的已有键**做大小写不敏感比较，命中则沿用已有键名。
   - 单层段中出现单个 `_`（非 `__`）不做拆分。
   - 值转换（按顺序判定）：
     - `env` 值为空字符串 `''` → 视为 `null`（把目标位置置为 `null`）；
     - `'true'` / `'false'` → 布尔；
     - 匹配 `/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/` → `Number(value)`；
     - 以 `[` 或 `{` 开头 → `JSON.parse`，解析失败则 `throw`，`err.code === 'E_ENV_VALUE'`；
     - 其余 → 原样字符串。
   - 路径不存在（该层没有匹配的键）：`strict === true` 时 `throw`（`err.code === 'E_UNKNOWN_KEY'`），否则忽略该条。
   - 遍历顺序：按 `Object.keys(env)` 的顺序依次应用。

## 约束

- 只允许 `node:` 内置模块（本任务无需任何 import）。
- 不要修改本目录下 `task.md` / `verify.mjs`。

验收命令：node bench/tasks/A3/verify.mjs
