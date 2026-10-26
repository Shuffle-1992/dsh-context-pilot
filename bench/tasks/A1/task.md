# A1 — LRU + TTL 缓存

**类别**：A（独立新任务）
**产物**：`bench/tasks/A1/solution/lru.mjs`（ESM，Node ≥ 20，零依赖，不联网）

## 需求

实现一个带 TTL 的 LRU 缓存类，具名导出 `LRUCache`：

```js
export class LRUCache {
  constructor(options)   // { capacity, now }
  get(key)               // 命中：刷新热度并返回值；未命中/已过期：返回 undefined
  set(key, value, ttlMs) // 写入或更新；超出容量立刻淘汰
  has(key)               // 判断是否存在且未过期；**不得**刷新热度
  delete(key)            // 返回 boolean
  clear()                // 清空，无返回值
  get size               // 当前**存活**条目数（过期条目需被剔除）
  keys()                 // 数组，按"最近使用在前"(MRU first)，已过滤过期条目
}
```

## 语义约定（必须严格一致）

1. `options.capacity` 必须是 **≥ 1 的整数**；否则 `throw new TypeError(...)`。
2. `options.now` 可选，是返回数字毫秒的无参函数，缺省为"当前墙钟毫秒"。
   提供 `now` 时**所有**时间读取必须走它（判分用可控时钟验证）。
   禁止使用 `setTimeout` / `setInterval` / `queueMicrotask` / `await`，所有方法必须是同步的（判分做静态检查）。
3. `ttlMs` 可选：`undefined` 或 `0` 表示永不过期；必须是有限非负数，否则 `throw new RangeError(...)`。
   过期时刻记为 `expiresAt = now() + ttlMs`，当 `now() >= expiresAt` 时视为**已过期**。
4. `key` 支持任意原始类型（用 `Map` 语义做严格相等比较即可），不需要处理对象 key。
5. `set` 命中已有 key：更新值、更新过期时刻（按本次 `ttlMs` 重新计算）、刷新热度，
   **不得**因此增长 `size`，**不得**触发淘汰。
6. 淘汰：`size` 最多等于 `capacity`；写入新 key 导致超容时，只淘汰**一个**最久未使用（LRU）条目。
   热度刷新时机：`get` 命中、`set`（新建或更新）都算"使用"；`has`/`keys`/`size` 不算。
7. 访问过期条目的任何操作（`get`/`has`/`size`/`keys`）都应把它从存储中剔除，剔除后它不再计入 `size`。

## 约束

- 只允许 `node:` 内置模块（本任务其实无需任何 import）。
- 不要修改本目录下 `task.md` / `verify.mjs`；参考解请放别处，判分优先读 `solution/`。

验收命令：node bench/tasks/A1/verify.mjs
