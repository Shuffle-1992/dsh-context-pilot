# DSH 上下文上限/已用/压缩 探索报告

> 日期：2026-10-05 · 方法：Cordis Inspect 运行时服务目录 + app.asar 源码抽取（dsh-compaction / dsh-token-meter 官方 README 与类型）
> 结论先行：**全部可读、压缩参数全部可配、每轮前注入有官方挂点**。

## 1. 三个核心服务（运行时实测确认存在）

| 服务 | 关键 API | 作用 |
| --- | --- | --- |
| `ctx.tokenMeter` | `measure(session)` → `{ totalTokens, surfaceTokens, contextPressure, projectedTokens, contextBreakdown{system/message/tools}, nodes[] }`；`estimateMessage(msg)` | 上下文用量测量（回放会话日志，零模型调用，确定性） |
| `ctx.compaction`（抽象） | `compactIfNeeded(agent, trigger)` / `compactNow(agent)` / `compactRegion(start, end, agent)` | 压缩执行：自动触发 / 手动立即 / 指定区间 |
| `ctx.systemPrompt` | `section(s)` / `context(fn)` / `variable(name, fn)` / `assemble()` | **每轮模型步进前的 prompt 组装注册表**（注入点！） |

辅助：`configEditor.edit(entry, change)` 程序化改配置；`/compact` 人工命令（dsh-command-compact）。

## 2. 逐条回答

### 上下文上限（W）——可读 ✅
模型容量从 LLM 适配器解析（`LlmModelContext.contextWindow`，模型发现元数据同字段）。插件经 `measure()` + 路由容量即可算出占用比（DSH 的 occupancy UI 就是这么算的）。

### 已使用——可读 ✅
`measure()` 的 `totalTokens`（请求+响应压力）/ `surfaceTokens`（表面总量）/ `contextBreakdown`（system/message/tools 三类拆分）。
⚠️ 精度注意：无 provider 精确 usage 时用 **4 字符/token 启发式，CJK 与 JSON Schema 明显低估**（官方 Dev Note 承认）。

### 自动压缩百分比——可改 ✅
`@deepseek-ai/dsh-compaction-basic` 配置面（全部可选）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `thresholdRatio` | **0.8** | 触发线 = `floor(min(W × ratio, W − O − headroom))`，headroom 默认 65536 |
| `retainRatio` | 0.16 | 压缩后近端保留比例（相对 W − O）；可用 `retainTokens` 绝对值替代 |
| `headroomTokens` | 65536 | 额外压力余量 |
| `modelPolicies[]` | [] | 按 provider+model 精确覆写以上参数 |
| `auto` | true | 自动压缩开关（false = 仅手动） |
| `summarizationProvider/Model` | 路由回退 | 压缩摘要用哪个模型（可指定便宜模型！） |
| `maxTokens` / `compactionRetries` / `maxOverflowRetries` | 65536 / 1 / 1 | 摘要输出上限 / 重试 |

### 修改的落点（本机实测）
- `C:\Users\Administrator\.dsh\profiles\desktop\cordis.yml`：
  - **顶层全局挂载（263-268 行）`compaction-basic` 与 `command-compact` 均 `disabled: true`**；
  - 实际生效的是三个嵌套作用域组（712 / 894 / 1158 行，`isolate: {compaction: true}` 的 cordis:group——对应不同 agent 作用域），组内 `compaction-basic` **无 config 段 = 全默认值**；
  - 改法：在目标组的挂载下加 `config: { thresholdRatio: 0.6, retainRatio: 0.2, ... }`；改 cordis.yml 需重启 DSH（composition 启动装载）。程序化路径：`configEditor` 服务（同样走 Loader 重载）。

## 3. 「每轮前注入 + AI 决策压缩」的落地方案（用户设想 → 官方架构对齐）

```
用户下达任务
  ↓ agent/pre-step 监听（compaction-basic 自动触发就是这个机制——官方先例）
插件读 tokenMeter.measure() → { used, limit, ratio }
  ↓ 注入 systemPrompt.variable('ctxUsage')："上限 128k / 已用 61% "
AI 看到任务 + 占用 → 复杂度自评（重任务要全上下文 / 轻任务可先压缩）
  ↓ 判定"先压缩"
调 ctx.compaction.compactNow()（官方 API，等价 /compact）→ 再执行任务
```

- 复杂度判定可以是一次轻量模型调用（`summarizationProvider/Model` 思路同款：指定便宜模型）；
- 也可以纯启发式：任务文本长度 + 占用 > 阈值 → 建议压缩（零成本）。

## 4. 现成能力速查（不用写代码就能用的）

- `/compact`：手动立即压缩（本机全局禁用，但作用域组内启用着——具体可用性取决于当前会话作用域）；
- 改 `thresholdRatio` 即"自动设置上下文限制"；
- `auto: false` + 定期手动压缩 = 完全手动模式。

## 5. 风险与边界

- token 计数启发式对 CJK 低估 → 占比是估计值；
- thresholdRatio 改动影响该作用域**所有会话**；
- cordis.yml 手改需重启；语法错误会导致 profile 装载失败（有 .bak 先例，改前备份）；
- `compactRegion` 需要开放 turn（全关会话报 "no open turn"）。
