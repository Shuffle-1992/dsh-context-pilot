# C3 — 令牌桶限速器（可注入时钟，惰性结算）

**类别**：C（大量早期硬约束）
**产物**：`bench/tasks/C3/solution/ratelimit.mjs`（ESM，Node ≥ 20，零依赖，不联网）
**只读输入**：`bench/tasks/C3/fixture/keep.json`

## 需求

```js
export const RATE_LIMIT_ERROR = {
  INVALID_CONFIG: 'E_INVALID_CONFIG',
  INVALID_AMOUNT: 'E_INVALID_AMOUNT',
};

export class RateLimiter {
  constructor(options)      // { capacity, refillPerSecond, now }
  tryTake(n = 1)            // -> boolean
  retryAfterMs(n = 1)       // -> number（毫秒）
  reset()                   // -> void
  get available()           // -> number（整数）
}

export function createLimiter(options)   // 等价于 new RateLimiter(options)，返回实例
```

## 语义（唯一正确解释）

1. **配置校验**（构造函数中完成，违反即 `throw`，`err.code === 'E_INVALID_CONFIG'`）：
   - `capacity`：必须是整数且 `>= 1`；
   - `refillPerSecond`：必须是有限数且 `> 0`；
   - `now`：可以缺省（缺省时用当前墙钟毫秒）；若提供必须是函数。
2. **时钟注入**：所有时间读取必须来自 `now()`；**禁止** `setTimeout` / `setInterval` /
   `queueMicrotask` / `await`（必须纯惰性结算，判分会做静态检查 + 计数时钟动态检查）。
3. **结算（settle）**：每个公开方法（`tryTake`/`retryAfterMs`/`reset`/`available`）执行前必须结算：
   `tokens = Math.min(capacity, tokens + (t - last) / 1000 * refillPerSecond)`，然后 `last = t`。
   构造完成时 `tokens = capacity`、`last = now()`。
4. **额度校验**（`tryTake` 与 `retryAfterMs` 都做）：`n` 必须是整数且 `1 <= n <= capacity`，
   否则 `throw`，`err.code === 'E_INVALID_AMOUNT'`。`n` 缺省为 `1`。
5. **tryTake(n)**：结算后若 `tokens >= n` → `tokens -= n` 并返回 `true`；否则返回 `false` 且**不扣减**。
6. **retryAfterMs(n)**：结算后若 `tokens >= n` → `0`；否则返回
   `Math.ceil((n - tokens) / refillPerSecond * 1000)`。
7. **available**：结算后返回 `Math.floor(tokens)`。只读，不扣减。
8. **reset()**：结算之后把 `tokens` 置为 `capacity`（不得修改注入时钟的读数）。

## 硬约束清单（判分逐条独立检查）

| # | 约束 |
| --- | --- |
| 1 | 导出 `RateLimiter`（类）、`createLimiter`（函数）、`RATE_LIMIT_ERROR` 且两个码值字面量完全一致 |
| 2 | 非法配置（capacity 非正整数 / refillPerSecond 非正或非有限 / `now` 非函数）一律抛 `err.code === 'E_INVALID_CONFIG'` |
| 3 | `tryTake` 与 `retryAfterMs` 的非法额度（0、负数、小数、> capacity、非数字）一律抛 `err.code === 'E_INVALID_AMOUNT'` |
| 4 | 时钟只经 `now` 注入且**完全惰性**：不调用任何公开方法时时钟推进不得触发内部结算；源码不得出现定时器/`await` |
| 5 | 数值行为必须逐条精确（判分给定一段固定操作序列，比对每个返回值与 `available`/`retryAfterMs` 的精确整数结果，含 `floor`/`ceil` 与容量钳制） |
| 6 | `reset()` 行为正确；`createLimiter(opts)` 与 `new RateLimiter(opts)` 对同一操作序列输出逐条一致 |
| 7 | 工程约束：源码不含 `require(`，`from '…'` 只允许 `node:` 前缀；每行长度 ≤ 100；`fixture/keep.json` 一字节都不许变 |

不要修改 `task.md`、`verify.mjs`、`fixture/` 下任何文件。

验收命令：node bench/tasks/C3/verify.mjs
