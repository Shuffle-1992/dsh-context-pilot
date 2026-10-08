# dsh-context-pilot — DSH 上下文智能压缩 + 智能思考插件

DSH（DeepSeek Harness）宿主侧插件 `@local/dsh-context-pilot`（面板名「上下文智能压缩」，曾用名「上下文领航」）：
**让长会话的上下文压力可见、可控，并把「何时压缩」的决策权交给模型**——用**工具调用**触发压缩，
压缩在你的**下一个步骤开始前**落地，**本轮不中断、不注入任何消息、不伪造任何用户发言**。
另含可选的**智能思考**：把当前模型的思考强度档位告知 Agent，由它按任务难度自主换档（同样是工具）。

> **交接说明**：本文是入口，读完 §1–§3 即可上手；深入内容在 [`docs/`](docs/)。
> 创建 2026-10-05 · 最后更新 2026-10-08

> **版本 v0.1.0**（2026-10-08，首个 GitHub 发布）：`plugin/package.json` 的 `version` 即版本号。
> 本版包含：9 个域模块解耦（`host.impl.mjs` 1836 → 518 行，代码行 690 → 294）、自算保留范围 + 官方兜底、
> 「先说再调用」与用量行教学、**工具后自检回执**（压缩 `executed/no-need/not-executed` 三态，下一步即可见）、
> 思考强度**时刻可切**（每轮后缀带可选档位 + 冷却锚点修正）、以及 495 条断言 / 变异验证的护栏。

---

## 1. 它做什么

```
每轮任务前 → 读上下文用量（tokenMeter.measure）→ 注入「窗口 / 已用 / 占比」到 prompt
          → 占用达「智能压缩线」时附决策卡，模型自行判断是否压缩
          → 模型【先在正文里说一句理由，再】调用工具 compact_context
          → 下一步的 pre-step 执行压缩（自己算保留范围）→ 之后所有步骤跑在压缩后的上下文上
          → 占用达「强制压缩线」时插件在 pre-step 无条件发起压缩（无需模型操作）
             ※ 执行路径与上面相同：先自算保留范围；只有自算失败/压完仍在线上，才落到 DSH 官方 overflow 收口

可选（智能思考开关）：
          读当前模型的思考强度档位 → 注入给 Agent → Agent 按难度自行换档
          （【先说一句理由，再】调用 set_reasoning_effort，本次任务内立即生效，任务不中断）
```

### 1.1 最近几个版本带来的实质改进

| 改进 | 内容 | 为什么重要 |
| --- | --- | --- |
| **压缩改「工具触发」**（R4） | 模型调用 `compact_context` ⇒ 登记意图 ⇒ **下一步 pre-step** 执行 ⇒ 本轮无缝继续 | 彻底删掉「伪造用户消息拉起会话」那套（`maybeResumeAfterMarker` / `sessionController.prompt` / `agent.followup` 在代码里**零出现**）。压缩与「叫醒」解耦：工具调用本身就保证有下一步，**不需要叫醒** |
| **保留范围「自己算」**（R5） | 保留预算 = 上下文窗口 × 16%（1M 窗口 ⇒ **160k token**）⇒ 调公开方法 `compactRegion`；边界不合法则逐节点回退；失败或压完仍越线才**沿用官方 overflow** 兜底 | 引擎 `context-overflow` 写死 `retainTokens = 0`：真机实测在**只有 53% 占用**时把 surface 从 **1117 节点 / 367,794 token** 砍到 **4 节点 / 8,603 token**（影子化 97.7%）。现在近端细节留得住，且**整段没超预算时什么都不会压** |
| **压缩档位（R16）** | `compact_context` 可选参数 `tier`：**light 深压（8%）/ standard 标准（16%，默认）/ heavy 浅压（24%）**；**会话级持续生效**（含强制线，未选 = standard 兜底）；范围计算/边界保护三档完全一致，夹取 `[40k, 窗口×50%]` | 把「不可靠的自由度」换成「有界的选择」：模型只在语义档位里挑，不接触会「切坏 tool 对」的底层参数；选档理由照旧写在正文（先说再调用）；回执带档位与保留预算，Agent 能确认选档真的生效 |
| **换档改「工具」**（R2/R3） | 模型调用 `set_reasoning_effort` ⇒ **下一步请求即用新档位** | 替代「写文本标记、等用户再发一条消息才生效」——旧方案要求用户参与才能生效 |
| **「先说，再调用」**（R6） | 两个工具的 description + 一次性说明 + 决策卡都要求：**先在回复正文里用一句话说明理由，再调用工具** | 工具调用对用户是**静默的**（只显示「调用了某工具」）。理由写进正文，用户才看得出为什么压、为什么换档 |
| **强制线恒低于引擎 5pp** | 生效值 = `min(配置, 引擎阈值 − 5pp)`（内置 80% ⇒ **75%**） | 两线相等时谁先命中取决于各自测量时机，插件可能「什么都没做、占用却降了」⇒ HUD 记录失真 |
| **全程留痕** | 报告记录 `rangeProbe`（保留预算/起止/影子 token）/ `rangeSource` / `compactTool` / `preStepErrors` / `lastPreStepError` … | 链路任一环**静默失败**都能定位——已靠它当场抓出「工具从未注册成功」「面板整卡崩掉」等真 bug |

| **退役零残留**（R7） | marker 触发通道 + M5.5「挂起-自动恢复」通道**整体清零**（host/client/schema/wire/tests 五层成对删除）；6 个「静默降级」真缺陷修复；无界状态有界化；`CardBoundary` 改为**真正的 React 错误边界** | 那条通道在 R6 之后已**永远不会命中**（三处教学都改工具版），却仍在四层之间成对存在；而四个真缺陷的共同形态是「**看起来成功了，其实什么都没发生**」（工具回成功但意图丢了 / 冷却扣了但没压 / 字段算了但没人读 / 教学 catch 了但没日志）。审查报告：[`docs/r7-review-and-hardening.md`](docs/r7-review-and-hardening.md) |

**要解决的问题**：长会话上下文压力不可见；原生自动压缩（80%）只看占用、不看任务——
重任务需要全上下文，轻任务其实可以先压缩腾空间。**这个判断只有模型能做**，插件的职责是
把读数、选项、执行三件事做好。

**智能思考解决的问题**：同一个模型的不同思考档位（off/low/high/max…）成本与质量差异显著，
但用户很难预判每个任务该用哪档；而模型自己看得到任务复杂度。插件把「当前档位 + 可选档」
告知模型，**由它自己决定升档/降档**——简单任务省钱、难题给足推理预算。

**产出**：弹窗 HUD（最近压缩记录 + 阈值速览 + 两个开关）、输入框档位 chip、
配置面板（两线阈值 + 成本计算器）、报告的完整取证字段。

---

## 2. 关键概念（读这一节就够）

### 2.1 两条压缩线

| 面板名 | 配置键 | 含义 |
| --- | --- | --- |
| **智能压缩线** | `markerMinRatio` | 占用达此值时注入决策卡，**模型可自行决定压缩**并自动续跑 |
| **强制压缩线** | `criticalRatio` | 占用达此值**无条件发起压缩**（pre-step / idle 兜底；执行路径同上——先自算保留范围，官方 overflow 只作兜底/收口）。**生效值 = min(配置, DSH 引擎阈值 − 5pp)**，即内置 80% ⇒ 上限 **75%** |

推荐值（按计费口径，计算器可按实价实时推导）：

| | DeepSeek API（命中:未命中 = 1:50） | 高缓存价档（1:4 ~ 1:8） |
| --- | --- | --- |
| 智能压缩线 | **0.30** | **0.15–0.20** |
| 强制压缩线 | **0.85** | **0.80** |

**核心原则**：不要把阈值调得过低去追命中率——**过度压缩导致模型重读文件/重跑命令的返工成本，
远超省下的 token**。高缓存价档（命中仍计费）压早更划算；DeepSeek 命中近免费，压晚保信息更好。

### 2.2 自动压缩：工具触发（零输入、零消息、本轮不中断）

1. 模型判断该压缩时，**先在回复正文里用一句话说明理由**（R6 教学要求），再调用工具 **`compact_context`**（可选 `reason`）
2. 插件登记「下一步压缩」意图并**立即返回** → 工具调用让本轮**继续到下一步**
3. 下一步的 `agent/pre-step` 先执行轮内压缩（**R5 起：自选保留范围，失败才沿用官方**），**再**组装本步请求
4. 之后的步骤都在压缩后的上下文上继续 —— **本轮不中断、不注入任何消息**

用户全程零操作，且**不存在**任何伪造用户发言（旧「标记 + 自动拉起」机制已于 R4 整体删除）。

> 为什么工具能做到：工具调用 ⇒ 必须回灌 tool result ⇒ **下一步必然存在**，
> 而 pre-step 天然在下一步请求之前。压缩与「叫醒」因此解耦——**不需要叫醒**。
> 详见 [`docs/r4-compaction-tool-design.md`](docs/r4-compaction-tool-design.md)。
>
> 占用达强制压缩线（生效值 = min(配置, DSH 引擎阈值 − 5pp)；内置 80% ⇒ 75%）时，
> 仍由既有 pre-step / idle 安全网自动发起压缩，无需模型操作
> ——**执行路径与工具触发完全相同**（先自算保留范围），不是切到 DSH 自带压缩；详见下一条。
>
> **保留多少近端内容**（R5）：无论哪条触发，都先按「窗口 × 16%」自选范围 → 只压这一段
> （1M 窗口 ⇒ 近端 **160k token** 原样保留）；边界不合法则逐节点回退；
> 仍不行或压完还在强制线之上，才**沿用官方 overflow** 兜底；
> 整段对话未超预算时**什么都不会压**。这条规则已**教给 Agent**（R6），
> 所以它知道压缩后还剩什么，不必靠猜。
> 详见 [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md)。
>
> **「先说，再调用」**（R6，用户要求）：工具调用对用户**静默**（只显示「调用了某工具」），
> 所以两个工具——`compact_context` 与 `set_reasoning_effort`——的描述、一次性说明、决策卡
> 都要求**先在回复正文里说一句理由，再调用**。工具 description 每轮随请求下发 ⇒
> 这条提醒是**零额外 token 的每轮提醒**。

### 2.2b 智能思考（可选，默认关闭）

**开关语义**（一个开关管两件事）：开 = 注入思考强度信息 + 允许 Agent 换档；关 = 两者都不做。

| 项 | 内容 |
| --- | --- |
| **注入** | 一次性教学（教工具用法）+ 每轮用量行后缀「｜ 思考强度 high」 |
| **触发** | **工具 `set_reasoning_effort`**（参数 `effort=<档位>`）—— 见下「为什么是工具不是标记」 |
| **执行 seam** | `agent/request` waterfall + **`prepend: true`**（见下「为什么必须 prepend」） |
| **不中断** | 只改请求头一个字段：会话历史不动、不插消息、工具链不断 |
| **显示** | 输入框模型选择器左侧 chip「智能思考档位 high · 冷却 23s」——**响应式投影，零轮询** |
| **冷却** | 30s（防频繁换档反复打断前缀缓存）；chip 上显示剩余秒数 |

**为什么是工具而不是文本标记（2026-10-08 用户指出后重构）**：
原方案是模型在回复末尾写 `[cp:effort high]` 文本标记，但有**两个致命问题**：
1. **需要用户再发消息**——标记写在回复末尾时本轮已结束，档位只在**下一轮**（用户下次说话）生效
2. **若仿压缩"自动拉起"则是伪造用户输入**——那是往 `inbox.next-turn` 塞一条假用户消息

**工具为什么能解决**（`dsh-agent-loop` L1152-1155 源码实证）：
```js
const toolCalls = message.content.filter((b) => b.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };   // 无工具 ⇒ 本轮结束
return concluded ? { kind: "completed" } : null;            // 有工具 ⇒ null = 继续下一步
```
⇒ **工具调用让本轮继续到下一步**，而每步都重走 `agent/request` ⇒ 下一步的请求即带新档位。
**全程零用户输入、零伪造消息、同轮内生效。** 顺带消除了文本标记的「散文提及误触发」风险
（工具参数结构化，无正则误判面）。

**为什么必须 `prepend: true`（2026-10-08 实测踩坑）**：
官方 `installModelSelection` 挂在**同一个** `agent/request` 上且在**外层**，
它 `await next()` 后会 `delete reasoningEffort` 再套回持久化 header 的值
⇒ **内层写入必被剥掉**。症状极隐蔽：`applied: true` 却完全没生效。
故本插件必须 prepend 成为最外层，且 pending 需**持久**（每轮覆盖回去，不能一次用完就删）。

**为什么用 `agent/request` 而不是 `sessionController.selectModel`**：
后者内部还会 `agentDefaultModel.saveSelection()`——**写全局默认模型**（实测会重写 profile）。
Agent 自改档不应改掉新会话的默认档。

**档位必须动态取**：同一个 model id 在不同 provider 档位不同
（实测 `trae/deepseek-v4.1-flash` = `low/high/xhigh`，workbuddy 同名模型 = `off/low/high/max`），
**绝不硬编码档位表**。应用前必须校验合法性，否则 `dsh-llm` 会抛
`UNSUPPORTED_REASONING_EFFORT` **中断该次请求**。
工具侧**不抛错**——非法档/冷却中返回结构化错误让模型自行纠正（抛错会中断本轮）；
`agent/request` 侧则必须校验并静默忽略（那是请求能否发出的最后一道闸）。

**让位他人选择**：若当前请求的档位既不是本插件上次写的、也不是本次想写的
（用户手动选档 / subagent 自带 `reasoning_effort`）⇒ 不覆盖。

**成本**：一次性教学 ≈120 token + 每轮后缀 ≈7 token。
⚠️ 换档可能使前缀缓存失效（`call-config.js` 注明 effort 属 cache-affecting 状态）——
这是换档的真实代价，故设 30s 冷却并建议一次任务 1–2 次（已写进注入的教学文本）。

**已实测**（2026-10-08）：工具注册成功（`effortTool.ok=true, via=tools.register`）+ 注入改写为工具版本。

> 调查与设计全文：[`docs/r1-reasoning-effort-investigation.md`](docs/r1-reasoning-effort-investigation.md)
> ｜ [`docs/r1-effort-design.md`](docs/r1-effort-design.md)

**恢复投递走三通道，当前实际生效顺序**（2026-10-07 实证）：

| 通道 | 方式 | 状态 |
| --- | --- | --- |
| **A** | `sessionController.prompt(request, AbortSignal.timeout(30s))` | ✅ **当前首选**（`{"accepted":true}`，一次命中） |
| B | `ctx.remote.session.prompt` 代理 | ❌ 不可用（插件 ctx 无 `remote` inject 权限） |
| C | `createUserMessage` + `agent.followup`（官方同原语） | ✅ 兜底（早期历史走此路） |

> 通道 A 早期因**缺 AbortSignal 第二参**被拒（官方 `prompt()` 首行 `throwIfAborted`）——
> 补参后即通。这印证了「官方契约的参数一个都不能少」。

### 2.3 三个可改动点

| 改什么 | 生效方式 |
| --- | --- |
| 面板配置（两条线、有效期、换档冷却等） | **即时生效**（host 活读 config，无需重启） |
| `host.impl.mjs` / `effort.mjs` / `compact-tool.mjs` / `compact-range.mjs` / `threshold.mjs` / `m3.compact.mjs` / `m5.hud.mjs` / `m2.inject.mjs` / `m1.snapshot.mjs` | plugin toggle 热换（`?ts=` 动态 import） |
| `client.js` | 刷新页面 |
| `plugin-config.schema.mjs` / `wire.host.mjs` / `entry.mjs` | **需要重启 DSH**（entry 由 cordis loader 经 ESM 缓存加载） |
| `core.mjs` | **需要重启 DSH**：它必须由 `entry.mjs` 用同一个 `?ts=` **预加载后传给 `apply`**（`state`/`log`/`svc`/`schedule` 在 apply 期同步使用，而动态 import 是异步的）。未重启时旧 entry 不传 core ⇒ 宿主**降级但不崩**（打一条 warn、不接线），见 `core.mjs` 文件头与 boot 冒烟的同名断言 |

> R3（2026-10-08）起智能思考功能域独立为 `plugin/effort.mjs`：host 用
> `import(\`./effort.mjs?ts=${implTs}\`)` 加载（ts 取自 impl 自身），**与 impl 同批热换**；
> `static.mjs` §4/§5 的依赖方向与「动态 import 必须带 `?ts=`」护栏自动覆盖它。
> R5（2026-10-08）同款加载 `plugin/compact-range.mjs`（保留范围自选，纯函数叶子）。
> ⚠️ **保留比例 `RETAIN_RATIO` 目前是模块常量**（0.16，= 引擎默认）。要变成面板可调，
> 需给 `plugin-config.schema.mjs` 加字段 + **重启 DSH**——未做，等用户确认。

详见 [`docs/setup.md`](docs/setup.md#4-部署矩阵)。

---

## 3. 当前状态

**已完成**（M1 → 现在，全部经实机验收）：

- **M1** 用量读取：`tokenMeter.measure` + `sessionProjections.stateOf` 双路径，报告落盘取证
- **M2** 每轮注入：`agent/pre-step` 追加 usage 行（step 1 门控，异常放行不注入）
- **M2.5** 新会话自说明：首次注入追加插件说明（约 200 字），让 Agent 不靠外部文档就懂流程
- **M3.6** 标记闭环：尾行标记 → 武装 → idle 压缩 → **实弹 E2E 通过**（省 181K token / 节点 471）
- **M5** 弹窗 HUD：最近压缩记录、武装/待执行徽章、**按会话严格过滤（sid 精确匹配）**、悬停多条（含完整日期时间）
- **M5.5** 任务挂起-自动恢复：多通道投递（A sessionController → B remote → C direct-followup），
  **三测复现通过**，实际走通道 C
- **M5.7** 压缩历史持久化（`hud-acts.json`，cap 50）：跨重启/跨 toggle 存续
- **R1 智能思考**（2026-10-07，**已由 R2 取代触发方式**）：读档/枚举/写档三腿运行时实证；
  注入教学 + 每轮档位后缀；弹窗开关 + 输入框档位 chip（**响应式投影，零轮询**）；
  `agent/request` + **prepend 最外层应用**（R2 沿用）+ 合法性校验 + 30s 冷却 + 让位他人选择
- **R2 换档改工具**（2026-10-08，**已注册生效**）：`set_reasoning_effort` 工具取代文本标记。
  工具调用让本轮**继续到下一步**（源码实证）⇒ **本次任务内立即生效、零用户输入、零伪造消息**；
  顺带消除文本标记的「散文提及误触发」面。实测 `effortTool.ok=true, via=tools.register`
- **R3 智能思考解耦**（2026-10-08）：功能域抽成 `plugin/effort.mjs`（415 行，依赖图叶子节点），
  `host.impl.mjs` **2348 → 1563 行**；S1–S10 十项缺陷全消（命名统一 / 拆两个巨型函数 /
  `sidOf`·`checkEffort`·`bumpSkip` 单点 / `readEffort` 纯 async / 三 Map 合一 /
  **懒安装彻底移出 M2 注入分支** / 冷却可配 / 工具 output 收敛 / getHud 开关字段分离）；
  调查脚手架（`r1ProbeOnce` + 三个 `snap.*Probe`）清理，结论改为「留档断言」防丢
- **压缩失效定位**（2026-10-08）：压缩两条路径全 400 ⇒ 补错误正文取证后定位为 **workbuddy
  provider 对摘要请求的思考档位报 400**（非本插件）；切 `trae` 后同一路径一次成功
  （733.9K token / 95% → 1.9%）。**结论已锐化到 provider×model**：坏的是
  `workbuddy × deepseek-v4.1-flash` 组合（`workbuddy/glm-5.3-flash` 曾成功），
  且 `deepseek-account/deepseek-flash` 实测可用（省 217.8K）。全文见
  [`docs/compaction-failure-diagnosis.md`](docs/compaction-failure-diagnosis.md)
- **配置面板首帧就绪门**（2026-10-08）：快照未解析前不再渲染 `field.def`
  （默认值与已存值不同：`criticalRatio` 0.85 vs 0.8、`markerMinRatio` 0.2 vs 0.3）
  ⇒ 消除「刚出现显示一个值、随后跳变」的那一帧
- **两处 UI 修正**（2026-10-08，用户实测反馈）：
  ① 输入框 chip 由「智能思考档位 low · 冷却 23s」改为**两态文案**
  （冷却中「智能思考冷却」/ 冷却完成「智能思考就绪」），**状态由样式承担**——
  底层 warn 色=冷却态、上层 success 色按冷却进度扫满=就绪态
  （两个主题状态 token + `width` transition，像进度条一样过渡）；档位值与剩余秒数移入 title。
  ② 压缩记录弹窗：时间由 `hh:mm` 改为完整 `YYYY-MM-DD HH:MM:SS`，并**按会话严格过滤**——
  原 C-lineage 血统链把**别的会话**的记录混了进来（详见下条）
- **R4 压缩改工具触发**（2026-10-08，用户要求「不用伪造一条我的信息重新拉起会话」）：
  新模块 `plugin/compact-tool.mjs` 暴露工具 **`compact_context`** ⇒ 登记意图 ⇒ 宿主 pre-step
  **轮内**压缩 ⇒ 本轮无缝继续。**整体删除**伪造恢复投递链（`maybeResumeAfterMarker` /
  `resumeViaAnyChannel` 三条通道 / `resumeCountBySid` / `M5_RESUME_MAX` / `resumeTimers`），
  代码中 `sessionController.prompt`·`agent.followup` **零出现**；三处教学同步改为工具版
  （漏改会让模型写标记后**等一个永远不来的恢复**）。源码依据与落袋方案偏差见
  [`docs/r4-compaction-tool-design.md`](docs/r4-compaction-tool-design.md)
- **R5 保留范围自选**（2026-10-08，R4 真机 E2E 之后）：E2E 查明引擎 `context-overflow` 的
  `retainTokens = 0` 在**只有 53% 占用**时就把 surface 从 **1117 节点 / 367,794 token** 砍到
  **4 节点 / 8,603 token**（97.7% 影子化）。现改为**先自选范围**（保留预算 = 窗口 × 0.16，
  即引擎自己的 `DEFAULT_RETAIN_RATIO`）→ 调公开方法 `compactRegion`；**边界被拒**（会切断
  tool-call/result 配对）时逐节点回退重试，仍失败或压完还在强制线之上则**沿用官方 overflow 兜底**。
  新模块 `plugin/compact-range.mjs`（纯函数叶子）；取舍与源码依据见
  [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md)
- **配置面**：6 个字段，面板按秒/比率显示（总开关为开关滑块）；成本阈值计算器（8 个模型预设，一键算推荐值并写入）
- **只读审查落地**：外部审查 23 条，批次 1/2/3 全部实施（含心跳泄漏、`ctx.effect` 语义误用等真 bug）

**未实施（明确挂起）**：D1 模块切分**剩余部分**（`effort.mjs`/`compact-tool.mjs`/`compact-range.mjs`
已作为三刀抽出，其余 `core/m1/m2/m3/m5/m55` 仍待切，**已有测试护栏 + 任务书**）、
C2 无界 Map 上限（当前规模无实际风险）、A6 恢复计数清零、
**A5 阈值触发的强制压缩真机 E2E**（*工具触发*的 pre-step 压缩已由 R4 E2E 证实跑通——
见 r4 文档 §7.1 的逐帧时序；但**越强制线（75%）那一支**仍需占用真的冲到线上才有条件测，
那时才验「压到线下」的承诺）、A2/A6 的真机 E2E。

> ✅ **2026-10-06/07 清偿**：C3② 报告稳态瘦身（3.77MB → 预计 ~600KB）、B5 取证工具收敛
> （18 个散落脚本 → 2 个统一工具）、**测试骨架**（3 套件 128 断言）、**通道 A 验收**、
> **D2 两仓同步清单**（[`docs/cross-repo-sync.md`](docs/cross-repo-sync.md)，含 7 强同步点 +
> 有意差异标注）、**弹窗阈值行加「距触发距离」**。
> 详见 [`docs/milestones.md`](docs/milestones.md)。

---

## 4. 测试与取证

### 4.1 测试（`npm test`，<1 秒）

```bash
npm test              # 跑全部三个套件
npm run test:contract # 只跑契约对账
npm run test:static   # 只跑静态约束
npm run test:report   # 只跑报告形状
```

| 套件 | 断言数 | 查什么 | 能抓到什么 |
| --- | --- | --- | --- |
| `contract.mjs` | 317 | face 方法表 ↔ client 描述符 ↔ TYPERT 三端对账；Config 字段在 FIELDS/schema/M3_DEFAULTS 三处齐全**且默认值值级一致**；退役字段未复活；`mergeConfig` 读取集 ↔ schema；**getHud 作用域契约**（防 ReferenceError 回归）；**弹窗/阈值行排版契约**（**状态提示独立成行**，防窄弹窗逐字断开）；**智能思考 UI 契约**（开关尺寸/右对齐/字段三端/chip 两态色 token）；**压缩工具化契约**（工具注册/意图 TTL/消费顺序/伪造恢复零残留）；**阈值余量契约**（引擎阈值 −5pp 三处同源 / **阈值核心已抽为叶子模块且 host 不再重复定义** / 未就绪时空值降级 / 面板自取上限 / 输入即时钳制 / 已存超限自动钳回保存 / 教学传生效值）；**组件作用域对账**（防跨组件引用面板 state ⇒ 整卡崩掉，`node --check` 的盲区）；**R5 保留范围契约**（`RETAIN_RATIO` 与引擎 `DEFAULT_RETAIN_RATIO` 同源 / 起点跳过 `system/message` / 走 `session.eventAt` 而非猜 / **真跑纯函数**验证预算-范围-影子量-一致性拒绝-回退上限 / 引擎错误文案逐字对账 + 边界错误分类 / 官方兜底与强制线收口接线 / 留痕）；**R6 教学契约**（**实例化两个模块真跑 `renderBrief`/`renderCard`**：先说再调用的「显著标注」与「具体做法」**分两半钉死** / 两个工具 description 也要求 / 参数说明也要求 / 「自己算范围」按活值渲染 / **拿不到活值时不编数字** / host 活值接线）；**R7 加固契约**（退役零残留 4 类 × 4 文件剥注释判定 / 保留项 `markerMinRatio` 未被误删 / 随会话增长的 Set 已**有界化** / 意图表**真跑 `runTool`**：登记→`pending()`→跨 sid 隔离→消费 / 全表 TTL 清扫 / 空可选集**不否决档位** / **顺序契约**（F1 冷却在成功分支 / F5 消费在服务确认之后 / F2 可抛语句前移）/ **真错误边界** / occupancy 搬运 / alive 守卫**计数**）；**R8/R9/R10 解耦契约**（阈值核心与 M3 压缩域（执行核心 + 编排层）已抽为叶子模块 / **宿主不得把 `api.RETAIN_RATIO`、`api.selectRange(`、`state.m3.lastPreStep`、`sweepInFlight` 抄回来**（查独有产物而非函数名，防改名躲过）/ 跨域回调（`publishHud`/`recordHudAct`/`formatAct`/`clearBriefed`/`schedule`）必须显式注入 / 未就绪时空值降级并留痕 / 模块对宿主内部件零 import）；**智能思考 8 条实证结论**（prepend 最外层 / pending 持久 / 冷却基准 / 计数语义 / 两侧校验 / agent.ctx / sid 现读 / 删 maxTokens） | **调用静默失败**（P29：三端漂移不报错、只是拿不到数据）；已实测抓过 7 个真 bug |
| `static.mjs` | 54 | 真实 `node --check`（含 `docs/reference/tools/*.cjs`）；client 自足（无外部 import，require 仅 react）；entry 薄壳（<40 行、有静态 Config、动态 import 带 `?ts=`）；模块依赖方向无环；热换纪律；**功能域叶子模块清单**（effort / compact-tool / compact-range / threshold / m3.compact / m5.hud / m2.inject）；调试残留扫描（tools 下的 `console.log` 属 CLI 正常输出，豁免） | 语法错误、破坏热换、client 引入依赖、循环依赖、`TODO`/`XXX`/`console.log` 残留 |
| `report.mjs` | 59 | 产出侧字段契约；`republishFromReport`（原 `bfOnce`）回填链依赖；C3② 关键事件必须走 full 档（含**满环优先淘汰 slim**，防 FULL 取证被高频事件挤出）；**getHud 作用域与 criticalCap 实参契约**；**调查结论留档**（探针退役后结论不得丢）；真实报告结构自洽（**无嵌套条件断言** ⇒ 断言数不得随数据漂移）；`hud-acts.json` 去重；dump 工具可跑 | 报告形状无声破坏（踩过 2 次：顶层读 m3/m5、脚本读已删字段）；**证据静默丢失**（120 条全 slim、FULL 被挤光而断言全绿） |
| `boot.mjs` | 17 | **宿主启动冒烟**：真跑 `apply(ctx, {}, {pluginDir, reportPath})`（桩 ctx）→ HUD 面注册 → **真调 `getHud(null)` 必须 `ok:true`** → `criticalCap`/occupancy/`effortEnabled` 三线 → 四个监听器 → **真调 pre-step handler**（abort 与 step=1 两次）→ **M2 注入路径留下记账**（`m2.skips` 有键或 injections>0）→ 有历史时 `m5.lastPublish==='ok'` → 报告落盘。副作用边界：报告写临时目录、`hud-acts.json` 只读不写 | **接线不可达**（R11 真事故：接线块被嵌进 `schedule()` 函数体、语法合法、423 条源断言全绿，**压缩与弹窗全链路静默失效**）——`node --check` 与源断言都看不见「代码在不在正确的函数里」 |

合计 **505 条断言**（四套：contract / static / report / **boot**）。

**已验证有效**：注入 3 个人为 bug（`m3-act` 误入精简档 / client face 改名 / host 引用 client.js），
三套件全部抓到且定位精准。**新增断言均实测验证过「对回归确实失败」**（两边都通过的测试等于没测）：
- R5 换了 9 个针对性变异（保留比例 / 起点跳系统头 / 一致性校验 / 回退上限 / 错误分类 / 兜底分支 /
  预算守卫 / measure 传递 / 强制线收口）逐个注入，**9/9 被捕获**——其中「去掉回退上限」第一次**逃逸**，
  说明原断言只匹配了 `return official('boundary-exhausted')` 而没钉住 `MAX_WALK_BACK`，已加固。
- R6 换了 11 个（教学标注 / 教学做法 / 卡片做法 / 两个工具 description / 参数说明 / 写死比例 /
  卡片保留行 / host 活值接线）——**11/11 被捕获**。两次逃逸都极有教育意义：
  ① 「先说再调用」最初用**「或」关系的单个正则**，去掉显著标注后同段的具体做法仍能匹配 ⇒ 漏网，
  现改为**「显著标注」与「具体做法」分两半钉死**；
  ② 变异**脚本**把锚点打在了同文件的**注释**上（注释里也写了那个词）⇒ 代码没被改，看起来"逃逸"。

### 4.2 取证工具

```bash
npm run dump -- --tail 20          # 报告概览 + 尾部条目
npm run dump -- --kind m3-act      # 按 reason 过滤
npm run dump -- --field m3.eff     # 取最近一条的某字段
npm run dump -- --history-acts     # 压缩历史（含 hud-acts.json）

npm run asar -- list --filter dsh-token-meter
npm run asar -- grep --pattern compactIfNeeded --ext js --ctx 3

# 会话存储逐帧取证（压缩是否真发生 / 阴影了哪些 seq / 系统头是否被保留）
node docs/reference/tools/session-records.cjs --find <会话 id 片段> --compaction
node docs/reference/tools/session-records.cjs --find <会话 id 片段> --shadowed 15513
node docs/reference/tools/session-records.cjs --find <会话 id 片段> --from 18300 --type 'compaction/*'
```

> ⚠️ **路径约定**：报告的 `m3`/`m5`/`m55` 块在每个 **history 条目**上，不在顶层（`report.mjs` 已断言此约定）。
> ⚠️ `session-records.cjs` 读的是 DSH 的**私有存储格式**（多帧 zstd + JSONL）：直接扫魔数有假阳性，
> 必须 try/catch 跳过；官方改格式时该工具需同步。它是本项目「不靠插件自证」的关键手段——
> R5 就是靠它统计 12 次压缩的 `shadowedSeqs`，才证明 `system/message` 15513 从未被阴影化。

---

---

## 5. 成本模型与推荐配置

> **完整分析见 [`docs/cost-model.md`](docs/cost-model.md)**（官方单价取证、缓存命中率影响、
> 结构占比推导、阈值弹性表、计算器模型）。本节只留结论。

- **缓存命中率：下降**（每轮注入约 300–500 token 未命中；压缩整体重置前缀）。但命中率是分母游戏，
  **必须看绝对成本**。
- **费用：两种计费口径都降**，机制不同：
  | 计费方式 | 收益量级 | 机制 |
  | --- | --- | --- |
  | 按量付费（API） | ~10–30% | 命中近免费，上下文规模影响小；收益来自避免超大上下文的天价 miss |
  | 订阅套餐（Coding Plan） | ~40–70% | 命中仍计费 ⇒ 上下文是持续失血，压小直接换额度 |
- **关键解析**：压缩的摊销成本 ≈ 新增内容 × 未命中价，**与阈值几乎无关**（摘要调用 ∝ 阈值，
  压缩间隔也 ∝ 阈值，两者相消）⇒ **「压得勤更贵」是错的**，全部收益来自上下文规模。
- **同一组阈值的钱效**：高缓存价档（1:4）约为 DeepSeek（1:50）的 **3.8 倍**。

### 变更记录（2026-10-07）

配置面从 10 个字段精简到 6 个、术语改名、时长字段改秒显示、决策卡门槛并入智能压缩线。
**决策卡门槛合并的动因**（用户发现的设计缺陷）：原 `policyCardMinRatio`（教学）与
`markerMinRatio`（执行）是两个独立参数，`[0.30, 0.35)` 区间模型收不到卡 ⇒ 不知道标记存在
⇒ 永远不写 ⇒ **死区**。现统一为「能收到卡 = 标记有效」，无论怎么填都不会出现死区或错配。
详见 [`docs/cost-model.md`](docs/cost-model.md) 与 [§5 配置面](#5-配置面速查)。

---

## 6. 配置面速查

| 面板字段 | 配置键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 总开关 | `enabled` | true | 关闭后完全恢复原生 DSH（面板为开关滑块） |
| **智能思考** | `effortEnabled` | false | 开=暴露思考档位 + 注册 `set_reasoning_effort` 工具；关=提示词不注入、工具也不注册 |
| **换档冷却(秒)** | `effortCooldownMs` | 30 | 两次换档的最小间隔（存储为 ms）。**换档会使前缀缓存失效 ⇒ 计费敏感**，故可配（R3-S7） |
| **智能压缩线** | `markerMinRatio` | 0.2 | 占用达此值时注入决策卡，模型可自行决定压缩（**决策卡门槛**，与已退役的文本标记无关） |
| **强制压缩线** | `criticalRatio` | 0.85 | 占用达此值无条件**发起**压缩（先自算保留范围，官方 overflow 兜底/收口）；**生效值 = min(配置, 引擎阈值 − 5pp)**（内置 80% ⇒ 75%） |
| 强制压缩冷却(秒) | `sweepMinIntervalMs` | 600 | 两次强制压缩的最小间隔（存储为 ms） |
| （无面板字段） | — | — | **保留预算** = 窗口 × `RETAIN_RATIO`（0.16，模块常量）= 1M 窗口 ⇒ **160k token**。取代引擎 `context-overflow` 的 `retainTokens = 0`（R5）；见 [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md) |

> **R7 删除的两个字段**：`marker`（压缩标记）与 `armedTtlMs`（标记有效期）——随 marker 通道整体退役。
> 压缩改由工具 `compact_context` 在轮内触发，回复尾行文本标记既无教学也无执行路径。
> 旧配置里的残留键会被**静默忽略**（不报错、不迁移）。

**智能思考换档工具**：`set_reasoning_effort`（参数 `effort=<档位>`）——工具名固定，
档位取值由当前模型动态决定（插件注入时会告知可选档）。**不设独立配置键**（无需用户填）。
> R1 曾用文本标记 `[cp:effort <档>]`，因「需用户再发消息才生效」于 R2 改为工具（用户决定，不保留标记）。

> 历史版本曾有的 `policyCardMinRatio`（决策卡门槛）、`highRatio`（审计参考线）、
> `lightTaskChars`（轻任务阈值）**已删除**——前者并入 `markerMinRatio`，后两者在决策主体
> 移交模型后已无触发作用。旧配置残留键会被**静默忽略**（不报错、不迁移）。

---

## 7. 已知设计风险（开发前必读）

1. **激活安全**：插件 `apply()` 内任何异常只记录不抛（DSH 纪律：抛 = 条目装载失败）。
2. **CJK 计数低估**：占用比是估计值（无 provider usage 时按 4 字符/token 启发式），
   决策阈值要留余量。
3. **`compactNow` 约束**：必须传 Agent 本体 + **必须 idle** + **signal 必传**
   （官方实现首行 `signal.throwIfAborted()`）。
4. **弹窗 DOM 注入的脆弱性**：弹窗是宿主内部组件、无官方插槽，靠 aria 属性定位，
   DSH 升级可能失效——失效只是开关/HUD 行不见了，注入与压缩功能不受影响。
5. **热换语义**：`ctx.effect(execute)` 的 `execute` **立即执行=setup，返回值才是卸载器**
   （曾因此误用导致心跳从未运行 + 卸载零清理，见 [`docs/milestones.md`](docs/milestones.md)）。
6. **client 协议变更需重启**：`wire.host.mjs` 的 face 声明与 TYPERT 走包 exports，
   改协议（增删参数）必须重启 DSH 一次。

---

## 8. 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/cost-model.md`](docs/cost-model.md) | 成本模型全文：官方单价、缓存命中率分析、阈值弹性、计算器推导 |
| [`docs/setup.md`](docs/setup.md) | 环境事实、composition 真相（not-bundle 坑）、部署与热换矩阵 |
| [`docs/api-notes.md`](docs/api-notes.md) | 已验证的官方 API + **修正记录**（探索期写法 → 最终实现） |
| [`docs/milestones.md`](docs/milestones.md) | 完整里程碑档案（M1 → 现在，含踩坑与实测数值） |
| [`docs/cross-repo-sync.md`](docs/cross-repo-sync.md) | 与 `dsh-browser-kit` 的**同构点与同步清单**（7 个强同步点 / 5 个弱同步点 / 有意差异 / 漂移检测） |
| [`docs/d1-module-split-brief.md`](docs/d1-module-split-brief.md) | D1 模块切分任务书（目标结构 / 硬规则 / 7 步顺序 / 回滚） |
| [`docs/r1-reasoning-effort-investigation.md`](docs/r1-reasoning-effort-investigation.md) | **智能思考调查**：读档/枚举/写档三腿实证 + `selectModel` 全局副作用 + dsh-router-laya 参考 |
| [`docs/r1-effort-design.md`](docs/r1-effort-design.md) | **智能思考设计定稿**：三层门控解耦 / 数据与写通道 / 提示词文本 / UI（弹窗 + 输入框 chip）/ 实施顺序 |
| [`docs/r2-tool-switch-design.md`](docs/r2-tool-switch-design.md) | **换档改工具方案**：文本标记的两个致命缺陷 / `agent/request` + prepend 应用链 / 压缩能否也做成工具的分析 |
| [`docs/r3-effort-review.md`](docs/r3-effort-review.md) | **R3 审查与解耦方案**：S1–S10 十项缺陷 / 抽 `effort.mjs` / 8 步实施顺序 / 10 条必须保留的实证结论 |
| [`docs/r4-compaction-tool-design.md`](docs/r4-compaction-tool-design.md) | **R4 压缩改工具触发**：inbox 队列/steer/system-message 三条路为何都不行 / `compactIfNeeded` 两个 trigger 的保留语义 / 落袋方案 A 的偏差 / 三处教学同步 / **§7.1 真机 E2E 逐帧时序与实测数字** |
| [`docs/r7-review-and-hardening.md`](docs/r7-review-and-hardening.md) | **R7 全面审查与加固**：三路并行只读审计的完整发现（真缺陷 / 退役遗留 / 死代码 / 无界状态 / 重复漂移 / 耦合 / 正确性）/ 本批修复与证据 / **未实施项与建议顺序**（先抽阈值核心 → 再拆 M3 → 最后 M1/M5）/ 两次变异逃逸的教训 |
| [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md) | **R5 保留范围自选**：`retainTokens = 0` 的实测代价（1117→4 节点）/ 为何不复刻引擎配对算法 / 边界被拒为何可零成本重试 / 自选范围 + 官方兜底 + 强制线收口 / 验证矩阵 |
| [`docs/compaction-failure-diagnosis.md`](docs/compaction-failure-diagnosis.md) | **压缩全线失效定位**：workbuddy provider 对摘要请求 400 的完整证据链与两条修复选项 |
| [`docs/reference/README.md`](docs/reference/README.md) | 第三方（DSH 官方）抽取材料的来源与许可 + **三个统一取证工具**（`asar-query.cjs` / `dump-report.cjs` / `session-records.cjs`） |
| [`review-brief.md`](review-brief.md) / [`review-findings.md`](review-findings.md) | 只读审查的任务书与报告 |

**运行期取证**：`plugin/.data/m1-report.json`（service/injection/compaction 全字段报告）、
`plugin/.data/hud-acts.json`（压缩历史，cap 50）。

统一取证工具（2026-10-07 收敛，取代此前散落的一次性脚本）：

```bash
node docs/reference/tools/dump-report.cjs                  # 报告概览 + 尾部条目
node docs/reference/tools/dump-report.cjs --tail 20        # 尾部 N 条
node docs/reference/tools/dump-report.cjs --kind m3-act    # 按 reason 过滤
node docs/reference/tools/dump-report.cjs --field m3.eff   # 取最近一条的某字段
node docs/reference/tools/dump-report.cjs --history-acts   # 压缩历史（含 hud-acts.json）

node docs/reference/tools/asar-query.cjs list --filter dsh-token-meter
node docs/reference/tools/asar-query.cjs grep --pattern compactIfNeeded --ext js --ctx 3
node docs/reference/tools/asar-query.cjs extract --paths "/dsh/node_modules/..."
```

---

## 9. 验收标准

1. 每轮 prompt 含实时用量三元组（上限/已用/占比），模型可正确复述；
2. 占用达**智能压缩线**时，模型可写标记触发压缩，插件自动执行并自动拉起续跑任务（用户零重发）；
3. 占用达**强制压缩线**时，插件在 pre-step / idle 无条件发起压缩（同样先自算保留范围，
   官方 overflow 只作兜底/收口），压缩事件出现在会话日志；
4. 两条线可经 Config 配置（面板按秒/比率显示），改后**即时生效**（活读，无需重启）；
5. 插件任何异常不影响 DSH 主流程（激活安全零抛）。
6. **智能思考**（开启时）：注入当前档位 + 可选档；Agent 调用工具 `set_reasoning_effort`
   可自主换档，**本次任务内立即生效、任务不中断、无需用户操作**；关闭时提示词不注入、工具不注册。
