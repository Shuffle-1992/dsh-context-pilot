# R1 设计文档：智能思考（reasoning effort 自主换档）

> 状态：**设计定稿待实施**（2026-10-07）。调查结论见 `docs/r1-reasoning-effort-investigation.md`。
> 本文件 = 用户确认后的实施方案，含 UI 改动与门控解耦要求。

## 0. 需求（用户原话汇总）

1. 暴露**会话当前模型的思考强度档位**，保留到上下文给 Agent。
2. 让 **Agent 按任务需求自己设置**思考强度。
3. **提示词要教用法**（不能只暴露数据——否则模型不会调用）。
4. 换档**全程允许**，**不得**与自动压缩的门控（`markerMinRatio`）耦合。
5. **UI**：
   - 弹窗里按钮**尺寸缩小**、高度与「启用」字体一致
   - **删除「启用」标签**
   - 按钮**移到智能压缩右侧**挨着（一定间距）
   - **右侧新增「智能思考」+ 开关**
   - 打开「智能思考」后，**输入框内模型左侧**显示「智能思考档位:XXX」，**实时反映当前轮次档位**
6. 参考 `dsh-router-laya` 的输入框显示位置。

---

## 1. 核心设计：三层解耦（用户指出的关键）

**问题**：现有 M2 注入是三部分拼接，各自门控不同：

```js
// host.impl.mjs L1127
const fullText = [r.text, card, brief].filter(Boolean).join('\n\n');
```

| 部分 | 时机 | 门控 |
|---|---|---|
| ① 用量行 `renderUsageText` | 每轮 step 1 | **无** |
| ② 决策卡 `renderPolicyCard` | 每轮 step 1 | **`ratio >= markerMinRatio`（当前 30%）** |
| ③ 一次性说明 `renderBrief` | 仅首次 | 无（但 `briefedBySid` 永不失效） |

**另有第二层「执行门控」（更隐蔽）**：

```js
// host.impl.mjs L1209（idle 扫除）
const markerShot = !!(armedMark && d.ratio >= M3.markerMinRatio);
```

⇒ 低占用时写 `[cp:compact]` **武装了但不执行**。思考强度标记**绝不能**共用这道门控。

### 定稿：三条通道各自独立

```
① 用量行（每轮，无门控）
   Context usage ... ｜ 思考强度 xhigh          ← 追加 7 tok 后缀

② 一次性教学（会话首次，无门控）
   【智能思考】... 用法说明 ...                  ← 独立段落，不进决策卡

③ 决策卡（≥markerMinRatio 才有）
   压缩决策卡 ...                               ← **一行不动**
```

**思考强度永不进入决策卡的门控路径。**

---

## 2. 数据通道（读）

| 项 | 来源 | 说明 |
|---|---|---|
| 当前档位 | `agent.session.requestHeader()?.config.reasoningEffort` | **唯一**可靠路径（`selectionFor` 不在命令门面上） |
| 是否 adapter 默认 | `requestHeader()?.adapterDefaults?.reasoningEffort === true` | 展示标注「(默认)」 |
| 可选档位 | `llm.resolveModelInfo(provider, model).reasoning.efforts[]` | **动态取，绝不硬编码** |
| 默认档 | `.reasoning.defaultEffort` | 可选 |
| 全目录 | `sessionController.modelCatalog()` | 备选（含 default/groups/failures） |

**实测样本**（本机）：`trae/deepseek-v4.1-flash` → 当前 `xhigh`，可选 `low/high/xhigh`。
**同一模型在不同 provider 档位不同**（workbuddy 的 `deepseek-v4.1-flash` 是 `off/low/high/max`）。

---

## 3. 写通道（Agent 改档）

**标记语法**（与现有 `[cp:compact]` 同构）：

```
[cp:effort high]
```

**执行 seam：`agent/request` waterfall（推荐，无副作用）**

```js
ctx.on('agent/request', async (payload, next) => {
  const config = await next();
  // 应用本会话待生效档位（含校验）
  return { ...config, reasoningEffort: target };
}, { global: false });
```

**为什么不走 `sessionController.selectModel`**：它内部还会
`agentDefaultModel.saveSelection()` → **写全局默认模型**（实测触发 profile 重写）。
Agent 自改档不应改掉新会话的默认档。

**必须的校验（否则请求直接抛错中断）**：

```js
// dsh-llm/index.js L2182
if (!reasoning.efforts.some((e) => e.id === effective))
  throw new LlmError(..., "UNSUPPORTED_REASONING_EFFORT");
```

⇒ 应用前必须在**当前模型的合法档位集合**内校验；不在则**忽略标记 + 留痕**，绝不硬送。

**借用 router-laya 的三条经验**：
1. `delete maxTokens` —— 换档时不要继承上个 adapter 的 cap
2. `isOurRoute` 语义 —— 区分「自己写的档」vs「他人显式指定」（否则自我锁死）
3. `usableRoute` —— 先 `llm.listProviders()` 校验 provider 真实注册

**冷却**：换档可能使前缀缓存失效（`call-config.js` 注明 effort 属 cache-affecting 状态）。
建议：同一会话每轮最多换一次 + 最短间隔（如 30s）。

---

## 4. 提示词文本（定稿）

### 4.1 一次性教学（合并进现有 `renderBrief`，现拼活值）

```
【智能思考】当前 {effort}（本模型可选 {efforts}）。任务需要更深推理（复杂设计、疑难排查、
长链规划）或更快响应（简单查询、机械修改）时，可在回复最后一行单独写 [cp:effort <档>] 切换：
下一步生效，上下文与任务不中断，用户无需操作。换档可能使前缀缓存失效，一次任务 1-2 次为宜。
```

- 成本：**80 tok**（一次性，$0.000012）
- 覆盖度 **6/6**：当前值 / 可选档 / 语法 / 何时用 / 生效时机 / 代价
- 档位列表**现拼活值**（沿用 `renderBrief` 的 A3 教训：写死会在模型/config 变化后自相矛盾）

### 4.2 每轮状态后缀（追加到用量行）

```
 ｜ 思考强度 xhigh
```

- 成本：**7 tok/轮**（20 轮共 140 tok ≈ $0.000021）
- 作用：模型知道**当前实际生效值**（它只知道自己请求过什么，不知道插件是否应用成功——
  例如档位非法被忽略时）

**两处合计 20 轮 ≈ 220 tok ≈ $0.000033**（相对现有用量行总量 23%）。

---

## 5. UI 改动

### 5.1 弹窗行（`buildRow`）

现状：`row = [icon][label「智能压缩」flex:1][wrap: 启用 → switch]`

目标：

```
[icon] 智能压缩           [switch] [智能思考] [switch]
                            ↑缩小      ↑新增
```

- 删除「启用」文字标签
- 第一个 switch **尺寸缩小**，高度与「启用」字体一致（原 `36×20` → 约 `28×16`）
- 第一个 switch 移到「智能压缩」右侧紧邻（固定间距，如 8px）
- 右侧新增「智能思考」文字 + 第二个 switch
- 新开关写独立配置字段（`effortEnabled`），**不得**复用 `enabled`（总开关）

### 5.2 输入框 chip（**核心新增**）

**seam（源码实证）**：`conversation.input.right` —— session 作用域 list slot

```js
// dsh-client-ui-conversation/lib/client.js L17532
renderSlot("conversation.input.right", {})
// 紧邻 renderSlot("conversation.input.model", ...) ⇒ 正是模型选择器左侧
```

**注册方式**（router-laya 实证，`.data/ref/router-laya-client.js` L423）：

```js
ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
  { name: "conversation.input.right", id: "context-pilot-effort", order: 5 },
  (slotProps) => React.createElement(Chip, { sessionId: slotProps?.sessionId }),
));
```

**可用 props**（官方 contract 列出）：`sessionId` / `useSession` / `useProjection` / `useInput` / `useConversation` …

**显示内容**：`智能思考档位: XXX`（XXX = 当前实际生效档位，实时）

**实时性**：chip 需轮询/订阅档位。参考 router-laya 的 `startPolling()` 模式（其 chip 每 N 秒拉一次 host）。
本插件已有 HUD 5s 轮询面（`getHud`）——**扩展其返回字段**（如 `effort`）即可复用，无需新通道。

**样式**：router-laya 的做法值得抄——
- 读邻居（模型选择器）的 `computedStyle` 复制 `borderRadius`/`height`/`fontSize`（L235 `copyNeighbourShape`）
- 用 `measureGap()` 测量实际间距并对齐 8px（L219，因为行内 gap 不固定）
- 本插件已有 DSH Switch 的 CSS 复刻经验（`corner-shape: round`），chip 同样需要处理 DSH 全局 superellipse

---

## 6. 必须一并修的既有缺陷

### 6.1 `briefedBySid` 永不失效（**真 bug**）

```js
const briefedBySid = new Set();                    // L354
const brief = briefedBySid.has(sid) ? null : renderBrief();  // L1122
briefedBySid.add(sid);
// 全文无 delete / clear
```

**后果**：会话压缩后，一次性说明被收进摘要；插件认为"讲过了"**永不再讲**。
若摘要未保留该段（模型生成，不保证），**模型永久失去用法说明**。

实测佐证：`m2.briefings = 2` 而 `injections = 5`。

**修复**：压缩成功后清 `briefedBySid.delete(sid)`（压缩 = 新开始，正好重讲一次）。
成本仍是一次性量级（压缩是低频事件）。

### 6.2 低占用死区（用户指出）

思考强度的显示与执行**都不得**引用 `M3.markerMinRatio`。

---

## 7. 实施顺序（建议）

| # | 内容 | 风险 | 可独立验证 |
|---|---|---|---|
| 1 | 修 `briefedBySid` 永不失效 | 低 | ✅ 压缩后重讲 |
| 2 | 读档 + 枚举 + 每轮后缀 + 一次性教学（**只读**） | 低 | ✅ 看注入文本 |
| 3 | `effortEnabled` 配置字段 + 弹窗 UI 改造 | 低 | ✅ 截图 |
| 4 | `[cp:effort]` 标记通道 + `agent/request` 应用 + 校验 | **中** | ✅ 真机换档 |
| 5 | 输入框 chip（`conversation.input.right`） | 中 | ✅ 截图 |
| 6 | 真机 E2E（换档不中断、低占用可换、压缩后重讲） | — | ✅ |

---

## 8. 取证附录

| 内容 | 位置 |
|---|---|
| 调查结论 | `docs/r1-reasoning-effort-investigation.md` |
| router-laya 插件源码 | `.data/ref/router-laya-index.js`（46690B） |
| router-laya client 源码 | `.data/ref/router-laya-client.js`（18924B） |
| slot 契约（官方） | `docs/reference/asar-out/…dsh-cordis-client-runner…client.js` L3278-3321 |
| slot 渲染点 | `docs/reference/asar-out/…dsh-client-ui-conversation…client.js` L17532 |
| 换档校验源码 | `docs/reference/asar-out/…dsh-llm…index.js` L2182 |