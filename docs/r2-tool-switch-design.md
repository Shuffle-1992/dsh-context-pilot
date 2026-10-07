# R2 设计：换档改用「工具」而非「文本标记」

> 状态：**设计定稿**（2026-10-08）。用户指出 R1 标记方案的根本缺陷后重新设计。
> R1 的读档/枚举/注入/UI/冷却全部保留；**只有「触发方式」被替换**。

## 0. 用户指出的根本缺陷（原话）

> 「我发起问题，第一步思考时就获取到当前档位和可选档位和提示词，换档位，执行标记，
> 触发，重新进入思考（以新档位），继续干活，过程中如果有必要就继续换，完成任务结束。」
>
> 「需要我再发起才能触发标记。这个就失去意义了。」
>
> 「最好是无感换档执行的，不要像压缩标记那样重新自动拉起，
> **压缩标记的自动拉起本质是调用我的输入框发起新的内容拉起的**。」

**诊断完全正确**。R1 的标记方案有两个致命问题：

| 问题 | 说明 |
|---|---|
| **① 需要用户再发消息** | 标记写在回复末尾 → 本轮已结束 → 档位只在**下一轮**（用户下次说话）生效 |
| **② "自动拉起"是伪造用户输入** | 压缩标记的恢复走 `agent.followup()` → 往 `inbox.next-turn` 塞一条伪造用户消息，**等于替用户发言**。换档用这套是错的语义 |

## 1. 参考项目的真正原理：工具，不是标记

`HapyRain/dsh-router-laya` 的实现（`.data/ref/router-laya-index.js`）：
- 在 `agent/request` waterfall 里**直接改 config**（L886-975），
  任务文本从 `agent/inbox/claimed` 抓（L875），难度由本地小模型 `judgeTier` 判（L582）
- **它的换档发生在"请求组装时"**——即**每个 LLM 请求之前**，不需要用户任何输入

但它是"外部模型替你决定"，与用户要的"**Agent 自己决定**"不同。所以我们要的是：
**把"决定权"交给 Agent，把"生效时机"做成同轮内立即生效**。

## 2. 正确机制：工具调用让本轮继续

DSH 的 turn 循环（`dsh-agent-loop/lib/index.js`）：

```js
// L1152-1155
const toolCalls = message.content.filter((b) => b.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };   // 无工具 ⇒ 本轮结束
const { concluded } = await executeToolCalls(...);
return concluded ? { kind: "completed" } : null;            // 有工具 ⇒ null = 继续下一步

// L998-1006
if (turnEnds && this.inbox.nextStep.length === 0) { ... }    // turnEnds 为 null 时不 break
if (turnEnds && this.inbox.nextStep.length === 0) break;
target = "next-step";
```

**⇒ 模型调用任何工具，本轮就会继续到下一步**，而每一步都重新走
`prepareRequest` → `agent/request` waterfall（L1179）。

**所以：把换档做成一个工具，模型调用它 = 声明"我要换档"，工具返回后本轮继续，
下一步的请求就带新档位。零用户输入、零伪造消息、同轮内生效。**

### 时序对比

```
【R1 标记方案】（错）
用户提问 → step1(low) → 模型干活 → 回复末尾写 [cp:effort high] → 本轮结束
         → ⏸ 等用户再说话 → 下一轮才 high          ❌ 失去意义

【R2 工具方案】（对）
用户提问 → step1(low) → 模型判断"要深推理" → 调用 set_reasoning_effort("high")
         → 工具返回 {ok:true, effort:"high"} → 本轮继续（不是结束！）
         → step2(high) → 模型在高效档位下干活 → step3(high) → 完成  ✅ 全程无感
```

## 3. 工具定义（照官方 `dsh-tool-ask-user` 模板）

官方工具注册范式（`dsh-tool-ask-user/lib/index.js` L66、L216-223）：

```js
import { defineTool } from "@deepseek-ai/dsh-tools";
const inject = ["tools"];
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "...",
    description: "...",
    parameters: { /* JSON Schema 风格 */ },
    output: { schema: {...}, render: (args, value) => [{type:"text", text: JSON.stringify(value)}] },
    async execute(args, exec) { /* ... */ },
  }));
}
```

本插件的工具定义（草）：

```js
ctx.tools.register(defineTool({
  name: "set_reasoning_effort",
  description:
    "调整本次任务的思考强度档位（下一步生效，任务不中断）。" +
    "当前档位与可选档位见每轮开头的用量行与首次注入的教学文本。" +
    "需要更深推理（复杂设计、疑难排查、长链规划）时升档；" +
    "简单查询、机械修改时降档可省额度。换档可能使前缀缓存失效，一次任务 1-2 次为宜。",
  parameters: {
    effort: {
      type: "string", required: true,
      description: "目标档位（必须在本模型可选集内；可选集见注入的教学文本）",
    },
  },
  output: { schema: { ... } },
  async execute(args, exec) {
    // ① 取 agent（exec.agent）
    // ② readEffort(agent) 拿可选集
    // ③ 校验 args.effort ∈ 可选集；不合法 ⇒ 返回 {ok:false, error, options}（**不抛错**，
    //    让模型看到原因并自行纠正——抛错会中断本轮）
    // ④ 合法 ⇒ 写 pendingEffortBySid（现成的持久 pending 机制）
    //    返回 {ok:true, effort, applied:"next-step"}
  },
}));
```

**关键**：工具**不抛错**（不像 `agent/request` 那样会中断请求），
非法档返回结构化错误让模型自己改——这是工具相比标记的又一优势。

## 4. 保留与废弃

| 组件 | 处置 |
|---|---|
| `readEffort()` 读档 | ✅ 保留 |
| `resolveModelInfo` 枚举可选档 | ✅ 保留 |
| 每轮用量行后缀「｜ 思考强度 xhigh」 | ✅ 保留（模型看当前档） |
| 一次性教学文本 | ✅ 保留，但**改写为教工具用法** |
| `agent/request` + `prepend` 应用 | ✅ **保留**（工具只写 pending，应用仍在此） |
| 输入框 chip（投影 + 冷却） | ✅ 保留 |
| 30s 冷却 | ✅ 保留（工具侧校验，冷却中返回 `{ok:false, cooling:true, remainSec}`） |
| `[cp:effort]` 文本标记解析 | ❌ **废弃**（用户明确不要标记方案） |
| `session/event` 里的标记正则 | ❌ 移除（连同 §6.13 的散文误触发防护断言） |

## 5. 前置验证（已实证，2026-10-08 17:12）

设计不能建立在假设上，故先加了一次性探针（`snap.r2Probe`，只读、不实际注册）。
实测结果（本机 DSH 0.2.0-rc.2）：

```json
{
  "toolsService": "object",
  "hasRegister": true,          ← 插件 ctx 上 tools.register 可调用
  "agentCount": 1,
  "agentHasCtxTools": true,     ← agent.ctx.tools 也可用（可做 agent 作用域注册）
  "agentCtxToolsType": "object"
}
```

⇒ **工具注册路径可达**，方案可行。注册位置待定：
- 插件 `ctx.tools.register`（全局，所有会话可见）
- `agent.ctx.tools.register`（agent 作用域，仅该会话）

**倾向全局注册**：`effortEnabled` 是全局配置，工具描述里说明用法即可；
但需确认全局工具在 `effortEnabled=false` 时是否应该存在（建议：**不注册**，
关闭即完全不介入——与用户定义一致）。

## 6. 追加问题：自动压缩能否也改成工具？（用户提问）

> 「自动压缩的那个能否也用工具实现，而不是现在的伪造一条信息拉起？」

### 6.1 结论：**技术上可行，但语义上不该做** —— 两个原因

**原因①：压缩工具无法"让模型继续干活"，因为它必须破坏当前 surface**

`compactIfNeeded(agent, "context-overflow", signal)` 走 `compactRegion`
（`owner:"current-turn"`，**不走 idle 检查**）——这是轮内可用的路径，
本项目的 `preStepCompaction` 已在用。**所以"轮内压缩"本身是可行的。**

但关键在 `validateSurfaceRegion`（L549-558）：

```js
if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw ...  // 不能切断 tool-call/result 配对
if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw ...     // 不能切断正在进行的 step
```

**压缩会重写 surface**（把旧节点换成摘要 checkpoint）。而工具调用正处在
"tool-call 已发出、result 未回"的**未闭合 step** 里。压缩要选范围，
必然要避开当前 step —— 于是**压不到最该压的近期内容**（它们正是当前任务的一部分）。

对比：idle 压缩（`compactNow`）之所以安全，正是因为**没有进行中的 step**，
整个 surface 都是闭合的。

**原因②：压缩的语义是"腾空间"，而工具调用的语义是"我还能继续"**

| | 工具方案（换档） | 工具方案（压缩） |
|---|---|---|
| 模型调用后的预期 | "我继续干活，用新档位" | "我继续干活，但上下文变小了" |
| 现实 | ✅ 成立（surface 不变，只改请求头） | ❌ 当前 step 的 tool-call 可能被卷入 |
| 需要用户输入 | 不需要 | 不需要 |
| 是否伪造消息 | 否 | 否 |

**换档只改请求头一个字段，surface 完全不动** ⇒ 工具方案完美。
**压缩改的是 surface 本身** ⇒ 工具方案与"我正在执行"这件事天然冲突。

### 6.2 但用户的诉求（不伪造消息）**可以满足** —— 三种方案

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 工具 + 轮末执行**（推荐） | 模型调 `compact_context` → 工具**只标记意图**并立即返回 → 本轮正常结束 → **idle 时插件执行 compactNow**（不再需要伪造恢复消息，因为本轮是自然结束的） | ✅ 消除伪造消息 ✅ 压缩在 idle 安全执行 ✅ 语义诚实（工具返回"已安排，本轮结束后执行"） |
| B. 工具 + 轮内执行 | 工具直接 `compactIfNeeded(agent,"context-overflow")` | ⚠️ 可行但压不到当前 step（见原因①），且 surface 变动可能影响正在进行的工具结果 |
| C. 维持现状（标记 + 伪造恢复） | 现有实现 | ❌ 用户明确否决（伪造输入） |

**方案 A 的关键洞察**：现在的"伪造消息"之所以必要，是因为**压缩发生在 idle**、
而模型已经"停"了——需要重新叫醒它继续任务。
但如果**压缩意图来自工具调用**，那么：
1. 模型调用工具 ⇒ 本轮**自然继续**（工具返回后模型还能说话）
2. 模型在工具返回后**可以继续干当前 step 的活**
3. 本轮自然结束 → idle → **执行压缩**（安全，无进行中 step）
4. **压缩后不需要伪造恢复消息**——因为任务是否已完成由模型在步骤 3 前自己判断：
   若还需要继续，模型**自己会继续调用工具**（本轮不结束）；若已完成，压缩就是收尾动作

⇒ **方案 A 彻底消除"伪造用户消息"**，且压缩仍在安全的 idle 窗口执行。

### 6.3 建议

**R2 先做换档工具（`set_reasoning_effort`），压缩改造列为 R3 单独评估。**
理由：
- 换档工具是**纯收益**（消除等待、消除伪造、消除误触发）
- 压缩改造涉及 surface 语义，需要单独设计与真机验证（尤其"模型调用工具后本轮是否真的结束"这一时序假设）

用户已确认：**不保留文本标记** + **工具名 `set_reasoning_effort`**。

## 7. 待确认点

1. **工具名**：`set_reasoning_effort`？还是中文友好的 `switch_thinking_level`？
2. **是否保留文本标记作为兼容**？（建议**不保留**——两套机制会互相干扰，
   且标记的散文误触发风险已证明真实）
3. **冷却中调用**：返回错误让模型知道等多久（推荐），还是静默忽略？
4. **注入文本改写**：教学文本要教「调用工具」而非「写标记」，需重写 §2.2b 与 renderEffortBrief。