# R1 调查：思考强度（reasoning effort）的读取、枚举与设置

> 状态：**调查完成**（2026-10-07）。三条腿全部经本机运行时实证，含一条重要负面结论。
> 本文件是实施阶段的输入；未改任何行为（探针默认只读）。

## 0. 需求

用户原话：「探索下，能否暴漏会话当前使用模型的思考强度有多少个，保留到上下文给Agent，
并让Agent更新任务需求自己设置思考强度，先调查。」

拆成三件事：

| # | 目标 | 结论 |
|---|---|---|
| ① | **读取**当前会话所用模型的思考强度档位 | ✅ 可行，`session.requestHeader().config.reasoningEffort` |
| ② | **枚举**该模型有几个可选档 | ✅ 可行，`llm.resolveModelInfo()` / `sessionController.modelCatalog()` |
| ③ | 让 **Agent 自己改**档 | ✅ 可行，但**两条路副作用差异巨大**——见 §4 |

---

## 1. 腿①：读当前档（已实证）

**唯一可靠路径**：`agent.session.requestHeader()?.config`

本机实测（`m1-report.json` → `r1.legs.readViaHeader`）：

```json
{
  "hasHeader": true,
  "config": { "provider": "trae", "model": "deepseek-v4.1-flash", "reasoningEffort": "xhigh" },
  "adapterDefaults": null
}
```

- 这是**已生效**的档位（loop 每轮把它写进 request header，`agent-loop` L1171-1176）。
- `adapterDefaults.reasoningEffort === true` 时表示该档是 **adapter 默认值**、不是会话选择
  ——展示时须区分（`agent-default-model` L319-324 与 `agent-loop` L719 都按这个标志删除继承档）。

**不可用路径（负面结论）**：`sessionController.selectionFor(agent)`

源码里 `selectionFor` 是 `SessionController` 类方法（`api-session-controller/lib/types/agent.js` L296），
但插件经 `ctx.get('sessionController')` 拿到的是**命令门面**，实测 `hasSelectionFor: false`
（只有 `selectModel` / `modelCatalog` 等 `@Remote` 方法外露）。
⇒ 读当前档**只能**走 `requestHeader()`。

---

## 2. 腿②：枚举可选档（已实证）

**路径 A（单模型，最省）**：`llm.resolveModelInfo(provider, model)`

```json
{
  "provider": "trae", "id": "deepseek-v4.1-flash", "contextWindow": 1000000,
  "reasoning": { "defaultEffort": null,
    "efforts": [ {"id":"low","name":"Low"}, {"id":"high","name":"High"}, {"id":"xhigh","name":"Xhigh"} ] }
}
```

**路径 B（全目录，一次拿全）**：`sessionController.modelCatalog()`
—— `@Remote('modelCatalog')` 外露（typert L1137），返回 `{default, routableProviders, groups[], failures[]}`，
每个 model 带 `reasoning.efforts[{id,name,description}]` 与 `defaultEffort`。

本机实测全目录（`r1.legs.modelCatalog`）：

```
default: trae/deepseek-v4.1-flash effort=xhigh
routableProviders: deepseek-official, deepseek-account, zcode, workbuddy, trae
  deepseek-official: deepseek-flash        off/low/high/max      default=high
                     deepseek-v4-pro       off/low/high/max      default=high
  deepseek-account:  deepseek-flash        off/low/high/max      default=high
                     deepseek-v4-pro       off/low/high/max      default=high
  zcode:             glm-5.3               low/high/max          default=high
                     glm-5.3-flash         low/high/max          default=high
  workbuddy:         hy4-preview-f         high                  default=-
                     hy3                   NO-REASONING
                     space-bunny           low/medium/high/xhigh/max
                     deepseek-v4.1-flash   off/low/high/max
                     glm-5.3-flash         low/high/max
                     kimi-k3-1             NO-REASONING
                     kimi-k2.8-preview     off/low/high/max
  trae:              step-5-preview        low/high
                     deepseek-v4.1-flash   low/high/xhigh         ← 本会话
                     kimi-k3               low/high/xhigh
```

**要点**：
- 档位**随 provider 而异**：同一个模型 id（`deepseek-v4.1-flash`）在 trae 是 `low/high/xhigh`，
  在 workbuddy 是 `off/low/high/max` ⇒ **绝不能硬编码档位表**。
- 部分模型**完全不支持**思考档（`hy3`、`kimi-k3-1`）⇒ 枚举返回 null，UI 须能表达「无档可调」。
- 与 zcode-dispatch 的 `thinkingLevels` 语义一致（那边的档位集合也是按模型声明的）。
- DSH 内部的档位全集（`dsh-llm-pi-ai` L296 `THINKING_LEVELS`）：
  `off / minimal / low / medium / high / xhigh / max`（升序）——但**单个模型只暴露子集**。

---

## 3. 腿③：两条写入路径（**关键分歧**）

### 路径 A：`sessionController.selectModel({sessionId, provider, model, reasoningEffort})`

- `@Remote('selectModel')` 外露，schema 已核对（typert L828-842）：
  `{sessionId, provider, model, reasoningEffort?}` → `{selected:{provider,model,reasoningEffort?}}`。
- 内部顺序（`api-session-controller/lib/index.js` L720-748）：
  1. `requireModel(request)` —— 校验模型在当前 provider 目录里
  2. `llm.resolveCallConfig(...)` —— **校验档位**，非法档抛 `UNSUPPORTED_REASONING_EFFORT`
  3. `agents.selectForNextRequest(agent, selected)` —— 落会话选择
  4. `agentDefaultModel.saveSelection(selected)` —— **写全局默认模型**
- **本机实测（负面/副作用结论）**：
  - 同值写入 `xhigh` → `{ok:true, selected:{...xhigh}}` ✅ 可用
  - 非法档 `__r1_invalid__` → **被拒**：`provider "trae" model "deepseek-v4.1-flash" does not support reasoning effort "__r1_invalid__"` ✅
  - 写后复核：档位仍为 `xhigh`、`unchanged: true` ✅（非法输入不污染会话）
  - ⚠️ **但同值写入也触发了 profile 重写**：`cordis.patch.yml` mtime 从 22:01 变为 22:04，
    即 `saveSelection` → `configEditor.edit(entry, ...)` 真的改了 `agent-default-model` 条目
    （实测文件 348 行 / 12 个条目 / 27 行注释**均保留完好**，无损）。

**⇒ 结论：Agent 自改档若走 selectModel，会顺带改掉「新会话的默认档」。这是必须规避的副作用。**

### 路径 B：`agent/request` waterfall（**推荐**）

```js
ctx.on('agent/request', async (payload, next) => {
  const config = await next();
  return { ...config, reasoningEffort: 'high' };   // 只影响本次请求
}, { global: true });
```

- seam 源码（`dsh-agent-loop/lib/index.js` L1179）：`waterfall("agent/request", {turn,step,signal}, seed)`
  → 返回值直接进 `llm.prepareCall(proposedConfig, signal)` ⇒ **改它就改本轮请求**。
- **无全局副作用**（不碰 profile、不碰默认模型）。
- `installModelSelection` 本身就是挂在这个 seam 上应用会话选择的（`dsh-agent/lib/types/model-selection.js` L61-75）
  —— 官方同款用法，语义有保证。

---

## 4. 参考实现：`HapyRain/dsh-router-laya`

用户提示的同类项目：<https://github.com/HapyRain/dsh-router-laya>
（"Auto tier routing for DSH: a locally fine-tuned model picks low/high/max thinking effort per message"，
11 stars，Apache-2.0，Python + Node）。

**它的做法**（源码已存档 `.data/ref/router-laya-index.js`，46690B）：

- 走 **`agent/request` waterfall**（L886），不碰 `selectModel` ⇒ 无 §3-A 的副作用。
- `applyRoute(config, route)`（L444）：
  ```js
  const out = { ...config, provider: route.provider, model: route.model };
  delete out.maxTokens;                       // ← 关键：不能把上个 adapter 的 cap 钉到新模型
  if (route.effort === undefined) delete out.reasoningEffort;
  else out.reasoningEffort = route.effort;
  return out;
  ```
- `carriesExplicitRoute(config)`（L488）：若 config 已带 `reasoningEffort` = **别人显式指定**的
  （如 subagent 带 `reasoning_effort`）⇒ 尊重它、不覆盖。
- `isOurRoute(config, state, tiers)`（L503）：区分「**我们自己上轮写的档**」与「他人显式指定」
  —— 否则从第二轮起每轮都看起来是"显式的"，auto 模式会**自我锁死**（L497 记录了两次独立成因：
  global `agent-default-model.reasoningEffort` 给每个请求播种 + 自己的写入被读回）。
- `usableRoute(ctx, route)`（L463）：`llm.listProviders()` 校验 provider 真的注册过，否则
  宁可不路由（避免把用户模型换成无法路由的、导致整步失败）。
- 任务文本在 **`agent/inbox/claimed`** 捕获（L875），**不在** `agent/request`
  ——实测 request 时刻 `inbox.nextTurn` 已空、用户消息不可观测（L866-871 明确记录）。
- 模式开关放 **settings 命名空间**（`mode: manual|auto`，volatile），per-request 现读，
  翻转立即生效无需重启（L205-215）；而非 mount 期常量。

**对本项目的启示（可直接借用）**：
1. **用 `agent/request` 而不是 `selectModel`** —— 避免改全局默认。
2. **`delete maxTokens`** —— 换档/换模型时不要继承上个 adapter 的 maxTokens。
3. **区分「自己写的档」vs「他人显式指定」** —— 否则会与用户/subagent 的选择打架或自我锁定。
4. **档位表不得硬编码** —— 按 `resolveModelInfo` 动态取（router-laya 的 `parseArm` L389 也把
   档位词表从硬编码改成 adapter 声明）。
5. 它的"路由"包含**换模型**；本项目只需求**改档**（同模型换 effort）⇒ 更简单、风险更低。

---

## 5. 建议的实施设计（待用户确认）

**目标语义**：把当前档位与可选档位注入上下文，让 Agent 按任务需求自己调档。

**注入（读）**：在现有 M2 注入行旁边加一段，例如：

```
思考强度：xhigh（可选 low/high/xhigh；本模型无 max）
```
- 来源：`requestHeader().config.reasoningEffort`（当前）+ `resolveModelInfo`（可选集）。
- 只在档位集合**变化**或**模型变化**时重发，避免每轮重复占位（省 token）。

**Agent 改档（写）**：优先 **A：模型写标记**（与本项目已有的 `[cp:compact]` 同构）

```
[cp:effort high]
```
- 插件在 `session/event` 解析到标记 → 记录到 per-session 状态
  → 在 **`agent/request` waterfall** 里应用（下一轮生效）。
- 好处：复用现有标记通道/武装机制，用户零输入，Agent 自主决定。
- 校验：标记值必须在该模型 `efforts` 集合内，否则忽略并留痕（不报错、不污染）。

**备选 B：面板/工具**（若希望用户也能手动设）——但需注意不要写全局默认。

**必须处理的边界**：
1. 模型不支持思考档（`efforts == null`）⇒ 不注入、不响应标记。
2. 换模型后档位集合变化 ⇒ 旧标记值可能失效，需重新校验。
3. `adapterDefaults.reasoningEffort === true` ⇒ 当前档是 adapter 默认，展示时标注「(默认)」。
4. 与 subagent 显式 `reasoning_effort` 的关系 —— 建议**尊重显式值**（router-laya 的
   `carriesExplicitRoute` 语义）。
5. 与用户手动在 UI 选档的关系 —— 同样应尊重（`isOurRoute` 只重路由"自己的足迹"）。

**待用户决策的点**：
- (a) 档位注入是**每轮**都发，还是**仅在变化时**发？（省 token vs 始终可见）
- (b) Agent 改档的**生效时机**：下一轮（安全）还是本轮（本轮 request 已组装，做不到）？
- (c) 是否需要"自动档位路由"（像 router-laya 那样用模型判断难度）——还是**只给 Agent 自主权**？
  用户原话是「让 Agent 更新任务需求自己设置思考强度」⇒ 倾向**后者（Agent 自主）**，不做自动判断。

---

## 6. 取证附录

| 内容 | 位置 |
|---|---|
| 运行时探针结果 | `plugin/.data/m1-report.json` → history 条目 `r1` 字段 |
| 探针源码 | `plugin/host.impl.mjs` → `r1ProbeOnce`（默认**只读**；写测需 `DCP_R1_WRITE_TEST=1`） |
| router-laya 源码存档 | `.data/ref/router-laya-index.js`（46690B，已解码） |
| DSH 源码（档位相关） | `docs/reference/asar-out/` 下 `dsh-llm`、`dsh-agent-loop`、`dsh-api-session-controller`、`dsh-agent-default-model`、`dsh-agent` |