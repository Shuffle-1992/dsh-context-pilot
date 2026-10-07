# R4：自动压缩改「工具触发」——彻底删除伪造用户消息

> 状态：**已实施**（2026-10-08）。落袋计划来源：[`r2-tool-switch-design.md`](r2-tool-switch-design.md) §6
> 「追加问题：自动压缩能否也改成工具？」——本文是该节方案 A 的**升级版**，并给出为什么不能照原样实施。

## 1. 需求（用户原话）

> 「现在可以开始自动压缩优化内容了，前面好像有落袋计划内容。就是自动压缩时，
> **不用伪造一条我的信息**重新拉起会话。」

即：保留「压缩后任务继续」的能力，但**不允许**通过注入一条看起来来自用户的消息来实现。

## 2. 旧机制做了什么（为什么必须换）

`maybeResumeAfterMarker` → `resumeViaAnyChannel`，三条通道：

| 通道 | 调用 |
|---|---|
| A | `svc('sessionController').prompt(request, signal)` |
| B | `ctx.remote.session.prompt(request)` |
| C | `createUserMessage({content, source:{kind:'user', rpcId}})` + `agent.followup(message)` |

**三条通道的最终落点都是 `createUserMessage(… source.kind === 'user' …)`** —— 无论走哪条，
都是**替用户发言**：UI 上表现为一条用户消息，语义上等于用户重新下了一遍任务。
这与用户先前对「标记自动拉起」的判断完全一致：「压缩标记的自动拉起本质是调用我的输入框发起新的内容拉起的」。

## 3. 源码级事实（决定方案空间）

全部经 `docs/reference/tools/asar-query.cjs` 在 `app.asar` 上核对。

### 3.1 inbox 只有两个队列，且**载荷必然是消息**

```js
const inboxProjectionSchema = z.object({
  "next-turn": z.array(z.custom()).readonly(),
  "next-step": z.array(z.custom()).readonly(),
}).readonly();
// apply: event.type === "agent/inbox/spliced" → splice(target, start, removedCount, inserted)
```
官方事件 `agent/inbox/inserted` / `claimed` / `discarded` 的载荷类型统一为 **`UserMessage`**。
⇒ **往 inbox 塞东西 = 塞一条消息**。想「不伪造消息」，就必须**不经过 inbox**。

### 3.2 非用户消息确实存在，但**不唤醒 agent**

- `session.append("system/message", {turn, step, message}, intent)`（系统提示词更新）
- `session.append("developer/message", {…, message: createDeveloperMessage({source:{kind:"tool-registry"}, …})})`（工具表变更通知）

这些是**非用户**、模型可见的内容。但 `session.append` 只写对话，**不会让 agent 产生新的步骤** ⇒
单靠它无法「拉起」，故不采用。

### 3.3 `mode:"steer"` 仍是用户消息，且 idle 后不可用

```js
const placement = this.running ? (input.mode === "steer" ? "steering" : "queued") : "transcript";
if (request.action.kind === "steer" && (target !== "next-turn" || agent.status !== "running"))
  throw new RemoteError("session/steer-unavailable", "current turn no longer accepts steering");
```
`agent/turn-stopping` 的关闭条件也写着 "no live tool calls, **no fresh steering**"。
⇒ steer 能注入**当前回合**（不新开回合），但**内容仍是用户发言**，且要求 `status === "running"`
（idle 压缩之后 agent 已不 running）⇒ **不解决用户诉求**。

### 3.4 工具调用**必然**产生下一步 —— 这才是出路

模型调工具 ⇒ 必须把 tool result 回灌给模型 ⇒ **下一步必然存在**；
而 `agent/pre-step` 是 "Replace the messages that enter it" 的 waterfall，**在下一步请求之前**执行。
⇒ 在 pre-step 里做压缩，**压缩结果天然作用于下一步**，全程零消息。

### 3.5 轮内压缩的两条 trigger 语义（关键取舍）

`compaction-basic.compactIfNeeded(agent, trigger, signal)`：

```js
if (trigger === "context-overflow") {
  if (prune) { prune.pruneSession(session); measurement = meter.measure(session); }
  const range = selectCompactableRange(session, measurement, 0);   // ← retainTokens = 0
  if (range === null) return null;
  return this.compactRegion(range.start, range.end, agent, signal);
}
// pressure：先算 spec.thresholdTokens（引擎 config，默认 80%），未达线 return null（**不做任何 LLM 调用**）
```

- 官方注释原文：「overflow **bypasses the normal threshold and retained-tail policy** so it can force
  one useful balanced reduction.」
- 即：**只有 `context-overflow` 能低于阈值强制压缩**；代价是 `retainTokens = 0`。
- `selectCompactableRange` 的第三参是**保留 token 预算**：`0` ⇒ 只保留最后一个节点
  （再按 `toolPairingBalancedBefore` 回退到配对平衡处）⇒ **保留近端 ≈0**，比引擎默认
  `retainRatio 0.16` 激进得多。

## 4. 落袋计划的偏差（为什么不能照抄方案 A）

R2 §6 方案 A 的推理是：

> 「模型调工具 → 本轮**正常结束** → idle 时执行 compactNow → **不需要伪造恢复消息**，
>  因为任务是否已完成由模型自己判断（若还需继续，模型自己会继续调用工具，本轮不结束）」

**这条推理在「压缩是为了腾出空间继续干活」这个主用例上不成立**：若把压缩推迟到**轮末**，
而模型正是因为**没空间了**才请求压缩，那么压缩就等于「活干完了再收拾」——
本轮内不腾空间，功能退化。且轮末压缩与既有 idle safety-net 几乎重合，工具形同虚设。

**修正**：压缩落在**下一步开始前**（§3.4），而不是轮末。这使工具严格支配原方案：

| | 落袋方案 A（轮末） | 本方案（下一步） |
|---|---|---|
| 本轮内腾出空间 | ❌ 不能 | ✅ 能 |
| 模型需不需要停 | 不需要（但也没收益） | 不需要 |
| 伪造消息 | 无 | 无 |
| 压缩是否一定发生 | 取决于本轮是否结束 | ✅ 必然（tool result 后必有下一步） |

## 5. 实施方案

### 5.1 新模块 `plugin/compact-tool.mjs`（依赖图叶子）

- 导出 `TOOL_NAME = 'compact_context'`、`INTENT_TTL_MS = 120_000`、`createCompactTool(deps)`。
- 工具 `compact_context`（可选参数 `reason`）：**只登记意图并立即返回**
  `{ok:true, scheduled:"next-step"}`，绝不阻塞、绝不抛错。
- 意图表 `Map<sid, {at, reason}>`：`peekIntent` / `takeIntent`，TTL 过期自动作废。
- 注入教学本体也在此模块：`renderBrief`（新会话一次性说明）+ `renderCard`（决策卡）。

### 5.2 host 侧消费（`preStepCompaction`）

```js
const intent = compactToolApi ? compactToolApi.peekIntent(sid) : null;
const wanted = !!intent;
if (wanted) compactToolApi.takeIntent(sid);          // 先消费：失败也不逐步重试
const effCritical = Math.min(M3.criticalRatio, engineThreshold(agent));
if (!wanted && ratio < effCritical) return;          // 意图门在 critical 门**之前**
…
if (wanted) {
  result = await svc.compactIfNeeded(agent, 'pressure', sig);        // ≥阈值：用引擎正常保留策略
  if (result == null) result = await svc.compactIfNeeded(agent, 'context-overflow', sig); // <阈值：强制
}
```

> `pressure` 在未达阈值时于**任何 LLM 调用之前**返回 null（源码先比 `spec.thresholdTokens`），
> 因此这次试探几乎零成本，**不是「多压一次」**。

### 5.3 教学同步改写（最易漏的一处）

三处教学**全部**改为工具版，否则模型会写标记并**等一个永远不来的恢复**（静默失效）：

1. `compact-tool.mjs` `renderBrief`（新会话一次性说明）
2. `compact-tool.mjs` `renderCard`（占用达线后的决策卡）
3. `compact-tool.mjs` `toolSpec().description`（工具自描述）

三者都明确「调用后**直接继续**，不要为了压缩而停下」，并**反向澄清**「没有任何自动拉起动作」。

### 5.4 删除

- `maybeResumeAfterMarker`、`resumeViaAnyChannel`（整函数删除，含三条通道）
- `resumeCountBySid` / `M5_RESUME_MAX` / `resumeTimers`（及其卸载清理）
- 断言层面：`maybeResumeAfterMarker` / `resumeViaAnyChannel` / `sessionController.prompt` /
  `agent.followup` 在代码中**零出现**（不是「不调用」，是「不存在」——留着重接上的地雷更危险）

> 仍在但已不参与伪造的：`pendingBySid` / `lastUserTextBySid` / `m55Attempt` / `state.m55`
> ——它们服务于**旧的 marker 通道**（标记解析 + 武装灯 + 「待执行」徽章）。
> marker 通道的彻底退役（连同 `M3.marker` / `armedTtlMs` / 面板字段）列为下一步，见 §7。

## 6. 验收

- **321 断言全绿**（contract 227 + static 37 + report 57）。
- **14 项变异全部被抓住**：
  门控接错开关 / 工具名字面量散落 / 工具改为抛错 / TTL 失效 / 懒安装排在消费之后 /
  意图门被 critical 门吞掉 / 直接走 overflow / 意图不消费 / **伪造恢复被重新接上** /
  教学丢掉「不要停下」/ 消费不留痕 / 说明退回旧文案 / 说明出口内联 / 说明不做反向澄清。
- 真机待验：模型调 `compact_context` → 下一步 pre-step 压缩 → 本轮继续（见 §7）。

## 7. 待办

1. **真机 E2E**：让模型调用 `compact_context` —— 见下方 §7.1 验收清单。
2. **marker 通道彻底退役**：删 `M3.marker` / `armedTtlMs` / `agent/inbox/inserted` 的标记解析 /
   武装灯 / 「待执行」徽章 / `pendingBySid` / `lastUserTextBySid` / `state.m55` / 面板两个字段。
   （`markerMinRatio` 需保留——它同时是**决策卡注入门槛**。）
3. **保留策略可选（用户已确认要做）**：`context-overflow` 的 `retainTokens = 0` 较激进
   （只保留最后一个节点）。E2E 通过后改为「**自己算范围 + 沿用官方兜底**」：
   - 自己算：按引擎 `retainRatio`（默认 0.16）算出保留预算，从尾部回退选范围，调
     `compactRegion(start, end, agent, signal)`；
   - 兜底：自选范围若被引擎校验拒绝（**切断 tool-call/result 配对**是最可能的失败模式，
     `validateSurfaceRegion` 会抛），则 `catch` 后回退 `compactIfNeeded(agent, 'context-overflow', signal)`；
   - 这样在「保留近端细节」与「低占用强制压缩」之间取得可控性，同时不依赖复刻引擎的
     `toolPairingBalancedBefore`（内部函数，不导出）。

### 7.1 E2E 验收清单（调用 `compact_context` 后**从报告核对**）

模型侧动作：调用一次 `compact_context`（可带 `reason`），**然后直接继续干活，不要停**。
下一步的 `agent/pre-step` 应当执行压缩，之后所有步骤跑在压缩后的上下文上。

| 核对项 | 期望 | 失败含义 |
|---|---|---|
| `m3.compactToolCalls` | **+1** | 工具没被执行（注册/作用域问题） |
| `m3.compactIntents` | **+1** | 意图登记了但 pre-step 没消费（懒安装顺序 / sid 不一致） |
| `m3.lastCompactIntent.trigger` | `pressure` 或 `context-overflow` | 走了别的路径 |
| `m3.lastCompactIntent.acted` | **true** | 压缩未真正发生 |
| `m3.lastCompactIntent.shadowedTokens` | > 0 | 压了个空 |
| `m3.preStepActs` / `preStepOk` | 各 **+1** | pre-step 路径没跑到 |
| `m3.lastPreStepError` | `null` | 有错误 → 立即看 stack |
| **本轮是否中断** | **否**——工具返回后模型继续到下一步 | 若中断，说明「工具调用保持本轮」的假设不成立 |
| **是否有消息注入** | **无**（`agent/inbox/inserted` 事件不应因恢复而产生） | 有 ⇒ 伪造恢复残留 |

⚠️ 压缩会走 `context-overflow`（当前占用 < 80%，`pressure` 会返回 null）⇒ 保留近端 ≈0，
本次对话会被大幅收掉。**验收所需的全部信息都在 host 侧报告里**，模型侧上下文丢了不影响核对。

## 8. 教训

1. **「改投递方式」解决不了「伪造发言」**：inbox 的队列名（next-turn / next-step）看着像
   「时机」选项，但载荷类型写死 `UserMessage` ⇒ 时机不是问题，**通道**才是问题。
   真正干净的解法是**不让压缩需要任何消息**。
2. **要把「压缩」和「恢复」拆开看**：压缩是 surface 操作，恢复是对话操作。
   旧设计把两者捆在一起（压缩完必须有人叫醒），于是不得不伪造发言；
   把压缩挪到 pre-step 之后，「叫醒」这一步就不存在了。
3. **教学的漏改是静默失效**：机制换了但文案没换，模型会照旧写标记、然后等一个不会来的恢复——
   没有任何报错，只是「功能好像不灵了」。故三处教学全部纳入断言。
