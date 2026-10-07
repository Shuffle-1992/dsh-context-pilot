# 压缩失效诊断：workbuddy provider 对摘要请求返回 400

> 状态：**已定位到 provider 侧，非本插件 bug；绕开路径已实测验证**（2026-10-08）。
> 结论已由会话存盘的第一手证据**锐化**：不是「workbuddy 整体不可用」，而是
> **`workbuddy × deepseek-v4.1-flash` 这一组合**不可用（见 §6）。

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

另注意 `options.maxTokens`：实测**每次摘要都是 `65536`**，与我们换档时
「必须 `delete maxTokens`」的结论同源（档位留给 upstream 自行推导上限）。

## 6. 决定性证据：会话存盘里的摘要归属

> 本节把结论从「workbuddy 不可用」**锐化为「workbuddy × deepseek-v4.1-flash 不可用」**，
> 并首次把「谁做的摘要」变成**可直接读出的字段**，而非靠时间线推断。

### 6.1 取证位置与方法

DSH 会话存盘（第一手、比报告更全）：

```
C:\Users\Administrator\.dsh\sessions\<workspace-slug>\<sessionId>\session.v4.jsonl.zstd
```

格式是**多帧 zstd 拼接的 JSONL**（本会话 8752 帧 / 15.9 MB）。注意两个坑：

1. `zstdDecompressSync(buf)` 只解**第一帧**（否则只得到 210 字节）；
2. **一帧内可能有多条 JSON 记录** ⇒ 必须「逐帧解压 + 逐行 `JSON.parse`」，
   只取 `split('\n')[0]` 会漏掉约 1/3 的记录。

哨兵扫描帧头魔数 `28 B5 2F FD` 逐帧解压即可（Node ≥ 24 自带 `zlib.zstdDecompressSync`）。

### 6.2 全量压缩史（本会话 10 次成功，全部带 provider/model）

`compaction/summary` 记录自带 `provider` / `model` / `maxTokens` / `usage` / `shadowedRange`：

| # | 时间 | provider / model | 压掉 tokens | 发起方 |
|---|---|---|---|---|
| 1 | 10-05 16:32 | `zcode/glm-5.3-flash` | 181,327 | context-pilot |
| 2 | 10-05 18:18 | `zcode/glm-5.3-flash` | 181,485 | context-pilot |
| 3 | 10-06 03:35 | `zcode/glm-5.3-flash` | 213,476 | context-pilot |
| 4 | 10-06 03:57 | `zcode/glm-5.3-flash` | 112,255 | context-pilot |
| 5 | 10-06 04:26 | `zcode/glm-5.3-flash` | 91,543 | context-pilot |
| 6 | 10-06 06:08 | `zcode/glm-5.3-flash` | 110,052 | context-pilot |
| 7 | 10-07 09:38 | **`workbuddy/glm-5.3-flash`** ✅ | 433,684 | 自动 |
| 8 | 10-07 12:51 | `trae/deepseek-v4.1-flash` | 350,454 | context-pilot |
| 9 | 10-07 18:25 | `trae/deepseek-v4.1-flash` | 733,850 | context-pilot |
| 10 | **10-07 18:45** | **`deepseek-account/deepseek-flash`** ✅ | 217,768 | context-pilot |

### 6.3 结论（两处锐化）

1. **workbuddy 不是全废** —— 第 7 次 `workbuddy/glm-5.3-flash` **成功**。
   失败面是 **`workbuddy × deepseek-v4.1-flash`** 这个 provider×model 组合
   （与之呼应：`reasoning.efforts` 声明随 provider 变——
   `trae/deepseek-v4.1-flash = low/high/xhigh`，`workbuddy/deepseek-v4.1-flash = off/low/high/max`，
   **声明 ≠ 实现**，upstream 仍拒）。
2. **`deepseek-account` 摘要可用** —— 第 10 次即本轮标记压缩，`provider: "deepseek-account"`、
   `model: "deepseek-flash"`、`shadowedTokenCount: 217768`、
   `usage: {inputTokens: 468, outputTokens: 6244, cacheReadTokens: 323072}`。

### 6.4 失败总量与时间线

从会话存盘逐条统计（比报告口径更全）：

```
compaction/start = 322 ｜ compaction/end = 322 ｜ 其中带 400 error = 312
最后一条 400：2026-10-07T18:23:14.228Z (seq 14719, turn 150)   ← 切换 deepseek-account 之前
切换之后 (seq > 14795) 的 400 条数 = 0
```

**成功链条完整可验**（seq 相邻三条即闭环）：

```
15506  18:45:39.506  compaction/summary   sourceCommandId:"context-pilot"  provider:deepseek-account
15508  18:45:39.508  compaction/end       （无 error 字段）
15509  18:45:41.593  agent/inbox/spliced  target:"next-turn"  ←「（context-pilot 自动恢复）」
```

⇒ 标记路径 **发起 → 摘要成功 → 收口 → 自动拉起**，四步全部有据；占用由 ~31% 降至 **11.1%**。

## 7. 绕开方案（源码支持）

`compaction-basic` **支持独立的摘要模型配置**（L294-302，`configured` 优先级最高）：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 独立摘要模型** | 给 `compaction-basic` 配 `summarizationProvider` + `summarizationModel`（如指向 `deepseek-account`） | ✅ **纵深防御**：摘要链路从此与主力模型解耦，主力随便换都不会再拖垮压缩；摘要用小模型更省钱。**推荐** |
| **B. 主力模型避开坏组合** | 不用 `workbuddy × deepseek-v4.1-flash` | ✅ 已实测可行（本会话当前状态）；但只是「这次躲开」，下次换 provider 仍可能踩 |
| C. 等 workbuddy 修 | — | ❌ 不可控 |

**状态更新**：本会话已在方案 B 下**恢复正常**（`deepseek-account` 摘要可用），
故 A 已不是「救火」而是**纵深防御**——优先级从「最高」降为「建议」。

## 8. 待办

1. **方案 A 的落地前提**：先定位 `compaction-basic` 的 config 注入点。
   注意 Inspect 的 `Config.listConfigs` 把该条目报为 `status: "inactive"`（顶层条目），
   而运行时 `m3.lastAct.via = "agentPresets.serviceFor"` ⇒ **服务由 agent preset 提供**，
   配置大概率要写到 **agent preset** 而非顶层 entry。
2. 需要在 profile patch 里覆盖该 entry（**改 `~/.dsh` 需用户同意 + 重启 DSH**）。
3. 无论选哪个，**已补的失败取证应保留**（下次同类问题直接可查）。
4. 可选增强：把「摘要失败」直接暴露到 HUD——本轮 312 次失败用户全程无感，
   是插件可观测性的真实缺口。

## 9. 教训（与本项目既有教训一致）

1. **「错误码进报告、错误正文只进 log」是反模式。** 本轮若没有补上 `lastPreStepError`，
   `{INVALID_REQUEST: 17}` 会让我们继续在错误方向上排查（我最初就误判为「换档污染」，
   直到时间线对照才否定）。**取证的粒度必须到「人能据此行动」的程度。**
2. **「provider 不可用」这种整体性判断，必须让数据把粒度切到 provider×model。**
   若止步于 §4，结论会是「workbuddy 坏了」——而第 7 次成功证明它没坏。
3. **报告是二手证据，会话存盘是一手证据。** 报告只保留我们**想到要记**的字段；
   本次决定性的 `provider`/`model` 是 DSH 自己写的，我们从没记过。
   排查到底时，**回到原始日志**。
