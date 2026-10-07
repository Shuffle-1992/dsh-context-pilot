# 官方 API 实证笔记

> 从 README 拆出（2026-10-07）。全部结论经**运行时 Service 目录 + asar 源码**双重实证。
> ⚠️ 标注「已修正」的条目是**探索期的写法**，与最终实现不同——以标注为准。

### 3.1 读用量（可读 ✅）

```js
const m = ctx.tokenMeter.measure(session);
// m.totalTokens      请求+响应压力
// m.surfaceTokens    表面总量（= nodes[].tokens 之和）
// m.contextPressure / m.projectedTokens
// m.contextBreakdown { systemTokens, messageTokens, toolsTokens }
```
- 上限 W：从 LLM 适配器容量解析（`LlmModelContext.contextWindow`，`ctx.llm.listModels()` 同字段）。
- ⚠️ 精度：无 provider usage 时按 **4 字符/token 启发式，CJK 与 JSON Schema 低估**（官方 Dev Note 承认）。占比是估计值。

### 3.2 压缩（可手动触发 ✅）

```js
ctx.compaction.compactNow(agent)            // 立即压缩（等价 /compact）
ctx.compaction.compactIfNeeded(agent, trigger)
ctx.compaction.compactRegion(start, end, agent)  // 需要开放 turn
```

### 3.3 每轮 prompt 注入（官方挂点 ✅）

```js
ctx.systemPrompt.variable('ctxUsage', (ctx) => `上限 ${W} / 已用 ${used}（${pct}%）`);
ctx.systemPrompt.context(...)   // 或 section(...)
```
`systemPrompt` 服务就是"每轮模型步进前组装 prompt"的注册表。

### 3.4 自动压缩参数（可配 ✅，来自 `@deepseek-ai/dsh-compaction-basic`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `thresholdRatio` | 0.8 | 触发线 = `floor(min(W×ratio, W−O−headroom))`，O=输出预留，headroom 默认 65536 |
| `retainRatio` | 0.16 | 压缩后近端保留（可用 `retainTokens` 绝对值替代） |
| `modelPolicies[]` | [] | 按 provider+model 覆写 |
| `auto` | true | 自动压缩开关（false = 仅手动） |
| `summarizationProvider/Model` | 路由回退 | 压缩摘要可用便宜模型 |

---

## 修正记录（探索期写法 → 最终实现）

| 探索期写法 | 最终实现 | 原因 |
| --- | --- | --- |
| `ctx.compaction.compactNow(agent)`（顶层 ctx） | `agentPresets.serviceFor(agent, 'compaction')` | **顶层 ctx 的 compaction 实测 absent**（作用域隔离）；必须按 agent 作用域解析 |
| `ctx.tokenMeter.measure(session)` 直接读 `contextPressure`/`contextBreakdown` | 经 `sessionProjections.stateOf(session, 'contextPressure' \| 'contextBreakdown')` 读 | 这两个字段**不在 measure 返回值上**（实测为 null） |
| `systemPrompt.variable()` 注入 | `agent/pre-step` waterfall 追加 `createUserMessage` | 照抄官方 dsh-time-context 惯用法；systemPrompt 方案未采用 |
| `compactIfNeeded(agent, trigger)` 两参 | `compactIfNeeded(agent, trigger, signal)` **signal 必传** | 官方实现首行 `signal.throwIfAborted()`，缺参必抛 |
| `compactNow(agent)` 两参 | `compactNow(agent, AbortSignal.timeout(180_000), 'context-pilot')` | 同上；且**必须 idle**（runMaintenance 包装） |
