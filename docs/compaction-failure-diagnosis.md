# 压缩失效诊断：workbuddy provider 对摘要请求返回 400

> 状态：**已定位到 provider 侧，非本插件 bug**（2026-10-08）。待用户决定绕开方案。

## 1. 症状（严重）

```
preStepActs = 17 ｜ preStepOk = 0      ← pre-step 压缩：发起 17 次，成功 0 次
acts = 2         ｜ actOk = 0          ← idle 压缩：发起 2 次，成功 0 次
```

**两条压缩路径全部失败**，会话占用持续攀升至 **95%**。核心功能完全失效。

## 2. 取证能力（本轮补上）

此前 `preStepErrors` / `actErrors` **只记错误码、正文只进 log** ⇒ 报告里
`{INVALID_REQUEST: 17}` / `{summary: 2}` 无法定位。已补：

- `m3.lastPreStepError = {at, code, message, name, stack}`（最近一次 pre-step 失败详情）
- `m3.lastActError = {at, code, reason, message, name, stack}`（最近一次 idle 失败详情）

**这两条取证是本轮定位的关键**——加完立刻拿到了错误正文。

## 3. 根因证据

```json
{
  "code": "INVALID_REQUEST",
  "message": "400: {\"message\":\"workbuddy upstream client (http 400): 模型不支持该思考强度，请调整\"}",
  "name": "LlmError",
  "stack": "at finishError (compaction-basic lib/index.js:361:26) | at summarizeWithLlm (…:324:16)"
}
```

**栈明确指向 `summarizeWithLlm`** —— 即压缩的「调 LLM 做摘要」这一步被拒。

## 4. 排除法（两次实验，否定了两个假设）

| 假设 | 实验 | 结果 |
|---|---|---|
| ① 档位值错（`low` 不被支持） | 把档位设为 `high` | ❌ **仍然 400** ⇒ 排除 |
| ② 是我们的换档功能污染了摘要请求 | 时间线对照 | ❌ 压缩首败 17:45:25 **早于**换档 17:58:52 ⇒ 排除 |

**⇒ 400 与档位取值无关，且早于本插件的换档功能。**

## 5. 源码分析

`compaction-basic` 的 `summarizeWithLlm`（L292-322）：

```js
const latest = agent.session.requestHeader()?.config;      // 会话 header
const configured = config.summarizationProvider.length === 0 ? void 0 : {
  provider: config.summarizationProvider, model: config.summarizationModel
};
const target = configured ?? latest ?? agentTarget;
const options = { provider, model, messages, toolHistory, maxTokens, sessionId, purpose: "compaction", signal };
// ⚠️ options 里**没有 reasoningEffort**（compaction-basic 全文无该词）
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
```

**关键**：compaction 自己不传 `reasoningEffort`，但 workbuddy 的 upstream **主动报
「模型不支持该思考强度」** ⇒ 说明 **workbuddy 的 adapter 在发送时自己注入了档位**，
而它注入的值不被 upstream 接受。**这是 workbuddy provider 插件的缺陷。**

## 6. 绕开方案（源码支持）

`compaction-basic` **支持独立的摘要模型配置**（L294-302，`configured` 优先级最高）：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 独立摘要模型** | 给 `compaction-basic` 配 `summarizationProvider` + `summarizationModel`（如指向 `trae` 或 `deepseek-official`） | ✅ 彻底绕开 workbuddy；摘要用小模型更省钱；**推荐** |
| **B. 主力模型换回 trae** | 改 `agent-default-model`（需**开新会话**，当前会话 header 已固化） | ✅ 立即恢复，但放弃 workbuddy |
| C. 等 workbuddy 修 | — | ❌ 不可控 |

## 7. 待办

1. **用户决定 A / B**（我推荐 A：摘要用便宜且稳定的 provider）
2. 若选 A：需确认 `compaction-basic` 的 config 注入方式（profile patch 覆盖该 entry）
3. 无论选哪个，**已补的失败取证应保留**（下次同类问题直接可查）

## 8. 教训（与本项目既有教训一致）

**「错误码进报告、错误正文只进 log」是反模式。** 本轮若没有补上 `lastPreStepError`，
`{INVALID_REQUEST: 17}` 会让我们继续在错误方向上排查（我最初就误判为「换档污染」，
直到时间线对照才否定）。**取证的粒度必须到「人能据此行动」的程度。**