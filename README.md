# dsh-context-pilot — DSH 上下文智能压缩 + 智能思考插件

DSH（DeepSeek Harness）宿主侧插件 `dsh-context-pilot`（面板名「上下文智能压缩」，曾用名「上下文领航」）：
**让长会话的上下文压力可见、可控，并把「何时压缩」的决策权交给模型**——用**工具调用**触发压缩，
压缩在你的**下一个步骤开始前**落地，**本轮不中断、不注入任何消息、不伪造任何用户发言**。
另含可选的**智能思考**：把当前模型的思考强度档位告知 Agent，由它按任务难度自主换档（同样是工具）。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-context-pilot

# 直接从 GitHub 仓库（pnpm 规格；未在本机实测，欢迎反馈）
dsh plugin --profile web add github:Shuffle-1992/dsh-context-pilot
```

安装后**重启 DSH** 生效（bundle 资格由本包 `package.json` 的 `dsh.bundle.patch` 声明，
patch 文件：`plugin/cordis.patch.public.yml`）。

<details>
<summary>本地开发挂载（本机已实测的路径）</summary>

profile `package.json` 三处都要改（以本机 `desktop` profile 为例）：

```jsonc
{
  "dependencies": { "dsh-context-pilot": "link:F:/My Code/dsh-context-pilot/plugin" },
  "dsh": { "profile": { "bundles": [ /* … 其它 bundle …, */ "dsh-context-pilot" ] } }
}
```

再手工 Junction（可免 pnpm install）：
`node_modules/dsh-context-pilot` → `<仓库>/plugin`。

> ⚠️ 插件 `package.json` **必须有 `dsh.bundle` 段**，否则 plugin-manager 报 `not-bundle` 并**静默跳过**
> （重启几次都不生效、host 无日志）——详见 [`docs/setup.md`](docs/setup.md) §2 坑 P1。
> 本地开发用 `dsh-context-pilot` + `plugin/cordis.patch.yml`；市场分发用根包名
> `dsh-context-pilot` + `plugin/cordis.patch.public.yml`（同一份代码，两个包名各配一个 patch）。

</details>

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `package.json`（根） | **可分发包清单**（name/version/license/repository/`dsh.bundle.patch`/`meta`）——市场按仓库根识别 |
| `plugin/` | 插件本体（`entry.mjs` / `client.js` / 域模块 / `icon.svg` / 两个 patch 文件）——也是本机 `link:` 挂载目标 |
| `test/` | 四套断言（contract / static / report / boot） |
| `docs/` | 设计与交接文档（含 `docs/setup.md` 部署矩阵、`docs/hub-publishing.md` 上架清单） |

> **交接说明**：本文是入口，读完 §1–§3 即可上手；深入内容在 [`docs/`](docs/)。
> 创建 2026-10-05 · 最后更新 2026-10-10

> **版本 v0.1.1**（2026-10-10）：**包名统一为 `dsh-context-pilot`**（去掉 `@local/` 前缀，符合 DSH Plugin Hub 上架基础项：
> 根清单可被市场识别、`dsh.bundle.patch` 声明、README 含安装命令、MIT LICENSE）。
> 本版另含 R16.13–R16.19 的修复：引擎压缩补记、教学分工去重、`set-tier` schema 类型事故、档位跨热换持久化、
> 档位落盘有界化、引擎 step 边界抢先（动态余量 + 取证）、**压缩记录跨会话根治**（权威会话 id 取自槽位 props）。
> 历史：v0.1.0（2026-10-08）首个 GitHub 发布。`plugin/package.json` 与根 `package.json` 的 `version` 即版本号。

---

## 1. 它做什么

```
每轮任务前 → 读上下文用量（tokenMeter.measure）→ 注入「窗口 / 已用 / 占比」到 prompt
           ｜ 压缩档位（R16）：light 深压 8% / standard 标准 16%（默认）/ heavy 浅压 24%
           ｜ —— Agent 调 compact_context(tier=…) 选档，会话级持续生效；不选 = standard
           → 占用达「智能压缩线」时附决策卡，模型自行判断是否压缩并选档
           → 模型【先在正文里说一句理由，再】调用工具 compact_context（可选 tier）
           → 下一步的 pre-step 执行压缩（按档位自算保留范围）→ 之后所有步骤跑在压缩后的上下文上
           → 占用达「强制压缩线」时插件在 pre-step 无条件发起压缩
              ｜ 档位同样由 Agent 事先选定的 tier 决定（Agent 选过 heavy 就按 24% 保留）；
              ｜ 没选过 = standard 兜底；只有自算失败/压完仍在线上，才落到 DSH 官方 overflow 收口

可选（智能思考开关）：
          读当前模型的思考强度档位 → 注入给 Agent → Agent 按难度自行换档
          （【先说一句理由，再】调用 set_reasoning_effort，本次任务内立即生效，任务不中断）
```

### 1.1 最近几个版本带来的实质改进

| 改进 | 内容 | 为什么重要 |
| --- | --- | --- |
| **压缩改「工具触发」**（R4） | 模型调用 `compact_context` ⇒ 登记意图 ⇒ **下一步 pre-step** 执行 ⇒ 本轮无缝继续 | 彻底删掉「伪造用户消息拉起会话」那套（`maybeResumeAfterMarker` / `sessionController.prompt` / `agent.followup` 在代码里**零出现**）。压缩与「叫醒」解耦：工具调用本身就保证有下一步，**不需要叫醒** |
| **保留范围「自己算」**（R5+R16） | 保留预算由**会话档位**决定（R16 三档，见下一行）⇒ 调公开方法 `compactRegion`；边界不合法则逐节点回退；失败或压完仍越线才**沿用官方 overflow** 兜底 | 引擎 `context-overflow` 写死 `retainTokens = 0`：真机实测在**只有 53% 占用**时把 surface 从 **1117 节点 / 367,794 token** 砍到 **4 节点 / 8,603 token**（影子化 97.7%）。现在近端细节留得住，且**整段没超预算时什么都不会压** |
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
| **智能压缩线** | `markerMinRatio` | 占用达此值时注入决策卡，**模型可自行决定压缩**（含选档，见 R16）并自动续跑 |
| **强制压缩线** | `criticalRatio` | 占用达此值**无条件发起压缩**（pre-step / idle 兜底；执行路径同上——先按**会话档位**自算保留范围，官方 overflow 只作兜底/收口；档位由 Agent 事先选定，未选 = standard）。**生效值 = min(配置, DSH 引擎阈值 − 5pp)**，即内置 80% ⇒ 上限 **75%** |

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
> 仍由既有 pre-step / idle 安全网自动发起压缩——**执行路径与工具触发完全相同**
> （不是切到 DSH 自带压缩）；**保留档位同样由 Agent 事先选定的 tier 决定**
> （R16：会话级持续生效，未选 = standard 兜底）；详见下一条。
>
> **保留多少近端内容**（R5+R16）：无论哪条触发，都先按**会话档位**自算范围 → 只压这一段。
> 三档：**light = 窗口 × 8%**（1M ⇒ ~80k，深压）/ **standard = 16%**（~160k，默认）/
> **heavy = 24%**（~240k，浅压）；预算被夹取在 `[40k, 窗口 × 50%]`。
> 边界不合法则逐节点回退；仍不行或压完还在强制线之上，才**沿用官方 overflow** 兜底；
> 整段对话未超预算时**什么都不会压**。这条规则已**教给 Agent**（R6/R16），
> 所以它知道压缩后还剩什么，不必靠猜。
> 详见 [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md) 与
> [`docs/milestones.md`](docs/milestones.md) 的 R16 节。
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
> ⚠️ **压缩档位是模块常量表 `TIERS`**（R16：light 0.08 / standard 0.16 = 引擎默认 / heavy 0.24），
> 由 **Agent 经 `compact_context(tier=…)` 选择**（会话级持续生效，含强制线；未选 = standard），
> 不在面板配置。要改成面板可调，需给 `plugin-config.schema.mjs` 加字段 + **重启 DSH**——未做，等用户确认。

详见 [`docs/setup.md`](docs/setup.md#4-部署矩阵)。

---

## 3. 当前状态

**已完成**：M1–M5（用量读取 / 每轮注入 / 会话自说明 / HUD 弹窗 / 历史持久化）、R1–R16.1
（智能思考 + 换档工具、压缩改工具触发、保留范围自算、全面审查加固、**压缩档位三选一**、
工具后自检回执、回执按会话隔离）。**9 个域模块 + core**，`host.impl.mjs` **1836 → 518 行**。
**测试**：contract 369 + static 61 + report 59 + boot 21 = **510 断言**全绿；关键回归均有变异验证。
逐里程碑台账（含踩坑与实测数值）：[`docs/milestones.md`](docs/milestones.md)；
早期进度历史存档：[`docs/status-archive.md`](docs/status-archive.md)。

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
| `contract.mjs` | 445 | face 方法表 ↔ client 描述符 ↔ TYPERT 三端对账；Config 字段在 FIELDS/schema/M3_DEFAULTS 三处齐全**且默认值值级一致**；退役字段未复活；`mergeConfig` 读取集 ↔ schema；**getHud 作用域契约**（防 ReferenceError 回归）；**弹窗/阈值行排版契约**（**状态提示独立成行**，防窄弹窗逐字断开）；**智能思考 UI 契约**（开关尺寸/右对齐/字段三端/chip 两态色 token）；**压缩工具化契约**（工具注册/意图 TTL/消费顺序/伪造恢复零残留）；**阈值余量契约**（引擎阈值 −5pp 三处同源 / **阈值核心已抽为叶子模块且 host 不再重复定义** / 未就绪时空值降级 / 面板自取上限 / 输入即时钳制 / 已存超限自动钳回保存 / 教学传生效值）；**组件作用域对账**（防跨组件引用面板 state ⇒ 整卡崩掉，`node --check` 的盲区）；**R5 保留范围契约**（`RETAIN_RATIO` 与引擎 `DEFAULT_RETAIN_RATIO` 同源 / 起点跳过 `system/message` / 走 `session.eventAt` 而非猜 / **真跑纯函数**验证预算-范围-影子量-一致性拒绝-回退上限 / 引擎错误文案逐字对账 + 边界错误分类 / 官方兜底与强制线收口接线 / 留痕）；**R6 教学契约**（**实例化两个模块真跑 `renderBrief`/`renderCard`**：先说再调用的「显著标注」与「具体做法」**分两半钉死** / 两个工具 description 也要求 / 参数说明也要求 / 「自己算范围」按活值渲染 / **拿不到活值时不编数字** / host 活值接线）；**R7 加固契约**（退役零残留 4 类 × 4 文件剥注释判定 / 保留项 `markerMinRatio` 未被误删 / 随会话增长的 Set 已**有界化** / 意图表**真跑 `runTool`**：登记→`pending()`→跨 sid 隔离→消费 / 全表 TTL 清扫 / 空可选集**不否决档位** / **顺序契约**（F1 冷却在成功分支 / F5 消费在服务确认之后 / F2 可抛语句前移）/ **真错误边界** / occupancy 搬运 / alive 守卫**计数**）；**R8/R9/R10 解耦契约**（阈值核心与 M3 压缩域（执行核心 + 编排层）已抽为叶子模块 / **宿主不得把 `api.RETAIN_RATIO`、`api.selectRange(`、`state.m3.lastPreStep`、`sweepInFlight` 抄回来**（查独有产物而非函数名，防改名躲过）/ 跨域回调（`publishHud`/`recordHudAct`/`formatAct`/`clearBriefed`/`schedule`）必须显式注入 / 未就绪时空值降级并留痕 / 模块对宿主内部件零 import）；**智能思考 8 条实证结论**（prepend 最外层 / pending 持久 / 冷却基准 / 计数语义 / 两侧校验 / agent.ctx / sid 现读 / 删 maxTokens） | **调用静默失败**（P29：三端漂移不报错、只是拿不到数据）；已实测抓过 7 个真 bug |
| `static.mjs` | 71 | 真实 `node --check`（含 `docs/reference/tools/*.cjs`）；client 自足（无外部 import，require 仅 react）；entry 薄壳（<40 行、有静态 Config、动态 import 带 `?ts=`）；模块依赖方向无环；热换纪律；**功能域叶子模块清单**（effort / compact-tool / compact-range / threshold / m3.compact / m5.hud / m2.inject）；调试残留扫描（tools 下的 `console.log` 属 CLI 正常输出，豁免）；**上架基础项**（根清单可被市场识别 / Bundle patch 指向存在的公开 patch / 包名↔patch name 一致 / 版本一致 / README 有安装命令 / LICENSE 与 license 字段一致） | 语法错误、破坏热换、client 引入依赖、循环依赖、`TODO`/`XXX`/`console.log` 残留、**上架基础项漂移**（改了清单名/schema 而 patch 或 README 没跟上） |
| `report.mjs` | 59 | 产出侧字段契约；`republishFromReport`（原 `bfOnce`）回填链依赖；C3② 关键事件必须走 full 档（含**满环优先淘汰 slim**，防 FULL 取证被高频事件挤出）；**getHud 作用域与 criticalCap 实参契约**；**调查结论留档**（探针退役后结论不得丢）；真实报告结构自洽（**无嵌套条件断言** ⇒ 断言数不得随数据漂移）；`hud-acts.json` 去重；dump 工具可跑 | 报告形状无声破坏（踩过 2 次：顶层读 m3/m5、脚本读已删字段）；**证据静默丢失**（120 条全 slim、FULL 被挤光而断言全绿） |
| `boot.mjs` | 17 | **宿主启动冒烟**：真跑 `apply(ctx, {}, {pluginDir, reportPath})`（桩 ctx）→ HUD 面注册 → **真调 `getHud(null)` 必须 `ok:true`** → `criticalCap`/occupancy/`effortEnabled` 三线 → 四个监听器 → **真调 pre-step handler**（abort 与 step=1 两次）→ **M2 注入路径留下记账**（`m2.skips` 有键或 injections>0）→ 有历史时 `m5.lastPublish==='ok'` → 报告落盘。副作用边界：报告写临时目录、`hud-acts.json` 只读不写 | **接线不可达**（R11 真事故：接线块被嵌进 `schedule()` 函数体、语法合法、423 条源断言全绿，**压缩与弹窗全链路静默失效**）——`node --check` 与源断言都看不见「代码在不在正确的函数里」 |

合计 **591 条断言**（四套：contract / static / report / **boot**）。

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

**结论**（推导与官方单价取证见 [`docs/cost-model.md`](docs/cost-model.md)）：缓存命中率会下降
（每轮注入约 300–500 token 未命中；压缩重置前缀），但**绝对费用两种计费口径都降**——
按量付费约 10–30%（收益来自避免超大上下文的天价 miss）、订阅套餐约 40–70%（命中仍计费，
压小直接换额度）。**「压得勤更贵」是错的**：摊销成本 ≈ 新增内容 × 未命中价，与阈值几乎无关。
同一组阈值在高缓存价档（1:4）的钱效约为 DeepSeek（1:50）的 **3.8 倍**。

## 6. 配置面速查

| 面板字段 | 配置键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 总开关 | `enabled` | true | 关闭后完全恢复原生 DSH（面板为开关滑块） |
| **智能思考** | `effortEnabled` | false | 开=暴露思考档位 + 注册 `set_reasoning_effort` 工具；关=提示词不注入、工具也不注册 |
| **换档冷却(秒)** | `effortCooldownMs` | 30 | 两次换档的最小间隔（存储为 ms）。**换档会使前缀缓存失效 ⇒ 计费敏感**，故可配（R3-S7） |
| **智能压缩线** | `markerMinRatio` | 0.2 | 占用达此值时注入决策卡，模型可自行决定压缩（**决策卡门槛**，与已退役的文本标记无关） |
| **强制压缩线** | `criticalRatio` | 0.85 | 占用达此值无条件**发起**压缩（先按**会话档位**自算保留范围，官方 overflow 兜底/收口）；**生效值 = min(配置, 引擎阈值 − 5pp)**（内置 80% ⇒ 75%） |
| 强制压缩冷却(秒) | `sweepMinIntervalMs` | 600 | 两次强制压缩的最小间隔（存储为 ms） |
| （无面板字段） | — | — | **压缩档位**（R16）：`tier` = light 8% / standard 16% / heavy 24%，**Agent 经工具选档、会话级持续生效**（含强制线），预算夹取 `[40k, 窗口×50%]`；取代引擎 `context-overflow` 的 `retainTokens = 0`（R5）；见 [`docs/r5-retention-range-design.md`](docs/r5-retention-range-design.md) 与 milestones 的 R16 节 |

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
| [`docs/setup.md`](docs/setup.md) | 环境事实、composition 真相（not-bundle 坑）、**部署与热换矩阵** |
| [`docs/milestones.md`](docs/milestones.md) | **逐里程碑台账**（M1 → 现在，含踩坑与实测数值） |
| [`docs/status-archive.md`](docs/status-archive.md) | 早期进度历史存档（原 README §3） |
| [`docs/cost-model.md`](docs/cost-model.md) | 成本模型全文（官方单价 / 缓存命中率 / 阈值弹性 / 计算器） |
| [`docs/api-notes.md`](docs/api-notes.md) | 已验证的官方 API + 修正记录 |
| [`docs/cross-repo-sync.md`](docs/cross-repo-sync.md) | 与 `dsh-browser-kit` 的同步清单 |
| [`docs/r1*`–`r7*.md`](docs/) | 各里程碑的设计/审查文档（R1 智能思考调查与设计、R2 换档改工具、R3 解耦、R4 压缩工具化、R5 保留范围、R7 审查加固） |
| [`docs/compaction-failure-diagnosis.md`](docs/compaction-failure-diagnosis.md) | 压缩全线失效定位（provider×model 锐化） |
| [`docs/d1-module-split-brief.md`](docs/d1-module-split-brief.md) | D1 模块切分任务书 |
| [`docs/reference/README.md`](docs/reference/README.md) | 第三方（DSH 官方）抽取材料来源与许可 + 统一取证工具 |
| [`review-brief.md`](review-brief.md) / [`review-findings.md`](review-findings.md) | 只读审查任务书与报告 |

**运行期取证**：`plugin/.data/m1-report.json`（全字段报告）、`plugin/.data/hud-acts.json`（压缩历史）。

```bash
node docs/reference/tools/dump-report.cjs                # 报告概览 / --tail N / --kind m3-act / --field m3.eff
node docs/reference/tools/asar-query.cjs grep --pattern compactIfNeeded --ext js --ctx 3
```

## 9. 验收标准

1. 每轮 prompt 含实时用量三元组（上限/已用/占比），模型可正确复述；
2. 占用达**智能压缩线**时，模型可调用 `compact_context` 触发压缩（**可选 tier 选档**），插件在下一步自动执行（用户零重发）；
3. 占用达**强制压缩线**时，插件在 pre-step / idle 无条件发起压缩——保留范围按**会话档位**自算
   （未选 = standard 兜底；官方 overflow 只作兜底/收口），压缩事件出现在会话日志；
4. 两条线可经 Config 配置（面板按秒/比率显示），改后**即时生效**（活读，无需重启）；
5. 插件任何异常不影响 DSH 主流程（激活安全零抛）。
6. **智能思考**（开启时）：注入当前档位 + 可选档；Agent 调用工具 `set_reasoning_effort`
   可自主换档，**本次任务内立即生效、任务不中断、无需用户操作**；关闭时提示词不注入、工具不注册。
