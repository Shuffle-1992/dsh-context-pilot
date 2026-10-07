# dsh-context-pilot — DSH 上下文智能压缩 + 智能思考插件

DSH（DeepSeek Harness）宿主侧插件 `@local/dsh-context-pilot`（面板名「上下文智能压缩」，曾用名「上下文领航」）：
**让长会话的上下文压力可见、可控，并把「何时压缩」的决策权交给模型**——压缩后自动拉起续跑任务，用户零重发。
另含可选的**智能思考**：把当前模型的思考强度档位告知 Agent，由它按任务难度自主换档。

> **交接说明**：本文是入口，读完 §1–§3 即可上手；深入内容在 [`docs/`](docs/)。
> 创建 2026-10-05 · 最后更新 2026-10-07

---

## 1. 它做什么

```
每轮任务前 → 读上下文用量（tokenMeter）→ 注入"上限/已用/占比"到 prompt
          → 占用达「智能压缩线」时附决策卡，模型自行判断是否压缩
          → 模型写标记 → 回合结束自动压缩 → 自动拉起新一轮继续原任务
          → 占用达「强制压缩线」时无条件压缩（兜底）

可选（智能思考开关）：
          读当前模型的思考强度档位 → 注入给 Agent → Agent 按任务难度自行换档
          （调用工具 set_reasoning_effort，**本次任务内立即生效**，任务不中断）
```

**要解决的问题**：长会话上下文压力不可见；原生自动压缩（80%）只看占用、不看任务——
重任务需要全上下文，轻任务其实可以先压缩腾空间。**这个判断只有模型能做**，插件的职责是
把读数、选项、执行三件事做好。

**智能思考解决的问题**：同一个模型的不同思考档位（low/high/max…）成本与质量差异显著，
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
| **强制压缩线** | `criticalRatio` | 占用达此值**无条件强制压缩**（pre-step / idle 兜底） |

推荐值（按计费口径，计算器可按实价实时推导）：

| | DeepSeek API（命中:未命中 = 1:50） | 高缓存价档（1:4 ~ 1:8） |
| --- | --- | --- |
| 智能压缩线 | **0.30** | **0.15–0.20** |
| 强制压缩线 | **0.85** | **0.80** |

**核心原则**：不要把阈值调得过低去追命中率——**过度压缩导致模型重读文件/重跑命令的返工成本，
远超省下的 token**。高缓存价档（命中仍计费）压早更划算；DeepSeek 命中近免费，压晚保信息更好。

### 2.2 标记闭环（零输入自动续跑）

1. 模型回复尾行写 `[cp:compact]`
2. 插件解析武装（TTL 120s）→ 回合结束 agent 转 idle 时立即压缩
3. 压缩成功后自动投递恢复提示 → 模型以干净上下文继续原任务

用户全程零操作。模型也可在回复里写「待执行：<任务>」显式记录要续跑的任务。

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
| 面板配置（两条线、有效期等） | **即时生效**（host 活读 config，无需重启） |
| `host.impl.mjs` | plugin toggle 热换 |
| `client.js` | 刷新页面 |

详见 [`docs/setup.md`](docs/setup.md#4-部署矩阵)。

---

## 3. 当前状态

**已完成**（M1 → 现在，全部经实机验收）：

- **M1** 用量读取：`tokenMeter.measure` + `sessionProjections.stateOf` 双路径，报告落盘取证
- **M2** 每轮注入：`agent/pre-step` 追加 usage 行（step 1 门控，异常放行不注入）
- **M2.5** 新会话自说明：首次注入追加插件说明（约 200 字），让 Agent 不靠外部文档就懂流程
- **M3.6** 标记闭环：尾行标记 → 武装 → idle 压缩 → **实弹 E2E 通过**（省 181K token / 节点 471）
- **M5** 弹窗 HUD：最近压缩记录、武装/待执行徽章、按会话过滤、悬停多条
- **M5.5** 任务挂起-自动恢复：多通道投递（A sessionController → B remote → C direct-followup），
  **三测复现通过**，实际走通道 C
- **M5.7** 压缩历史持久化（`hud-acts.json`，cap 50）：跨重启/跨 toggle 存续
- **R1 智能思考**（2026-10-07，**已由 R2 取代触发方式**）：读档/枚举/写档三腿运行时实证；
  注入教学 + 每轮档位后缀；弹窗开关 + 输入框档位 chip（**响应式投影，零轮询**）；
  `agent/request` + **prepend 最外层应用**（R2 沿用）+ 合法性校验 + 30s 冷却 + 让位他人选择
- **R2 换档改工具**（2026-10-08，**已注册生效**）：`set_reasoning_effort` 工具取代文本标记。
  工具调用让本轮**继续到下一步**（源码实证）⇒ **本次任务内立即生效、零用户输入、零伪造消息**；
  顺带消除文本标记的「散文提及误触发」面。实测 `effortTool.ok=true, via=tools.register`
- **配置面**：7 个字段，面板按秒/比率显示（总开关为开关滑块）；成本阈值计算器（8 个模型预设，一键算推荐值并写入）
- **只读审查落地**：外部审查 23 条，批次 1/2/3 全部实施（含心跳泄漏、`ctx.effect` 语义误用等真 bug）

**未实施（明确挂起）**：D1 模块切分（动骨架，**已有测试护栏 + 任务书，可以做了**）、
C2 无界 Map 上限（当前规模无实际风险）、A6 恢复计数清零、
**A5 pre-step 强制压缩真机 E2E**（唯一「已实现但成功率未验」的路径——需占用冲到强制压缩线
才有条件测，当前设为 80%，等接近了再做）、A2/A6 的真机 E2E。

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
| `contract.mjs` | 82 | face 方法表 ↔ client 描述符 ↔ TYPERT 三端对账；Config 字段在 FIELDS/schema/M3_DEFAULTS 三处齐全；退役字段未复活；`mergeConfig` 读取集 ⊆ schema；**getHud 作用域契约**（防 ReferenceError 回归）；**弹窗/阈值行排版契约**；**智能思考 UI 契约**（开关尺寸/右对齐/字段三端） | **调用静默失败**（P29：三端漂移不报错、只是拿不到数据）；已实测抓过 3 个真 bug |
| `static.mjs` | 30 | 真实 `node --check`；client 自足（无外部 import，require 仅 react）；entry 薄壳（<40 行、有静态 Config、动态 import 带 `?ts=`）；模块依赖方向无环；热换纪律；调试残留扫描 | 语法错误、破坏热换、client 引入依赖、循环依赖、`TODO`/`XXX`/`console.log` 残留 |
| `report.mjs` | 58 | 产出侧字段契约；`bfOnce` 回填链依赖；C3② 关键事件必须走 full 档；**getHud 作用域与 criticalCap 实参契约**；真实报告结构自洽；`hud-acts.json` 去重；dump 工具可跑 | 报告形状无声破坏（本项目踩过 2 次：顶层读 m3/m5、脚本读已删字段） |

**已验证有效**：注入 3 个人为 bug（`m3-act` 误入精简档 / client face 改名 / host 引用 client.js），
三套件全部抓到且定位精准。**新增断言均实测验证过「对回归确实失败」**（两边都通过的测试等于没测）。

### 4.2 取证工具

```bash
npm run dump -- --tail 20          # 报告概览 + 尾部条目
npm run dump -- --kind m3-act      # 按 reason 过滤
npm run dump -- --field m3.eff     # 取最近一条的某字段
npm run dump -- --history-acts     # 压缩历史（含 hud-acts.json）

npm run asar -- list --filter dsh-token-meter
npm run asar -- grep --pattern compactIfNeeded --ext js --ctx 3
```

> ⚠️ **路径约定**：报告的 `m3`/`m5`/`m55` 块在每个 **history 条目**上，不在顶层（`report.mjs` 已断言此约定）。

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

配置面从 10 个字段精简到 7 个、术语改名、时长字段改秒显示、决策卡门槛并入智能压缩线。
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
| **智能压缩线** | `markerMinRatio` | 0.2 | 占用达此值时模型可自行决定压缩并自动续跑 |
| **强制压缩线** | `criticalRatio` | 0.85 | 占用达此值无条件强制压缩 |
| 压缩标记 | `marker` | `[cp:compact]` | 模型回复尾行标记；置空则关闭智能压缩 |
| 标记有效期(秒) | `armedTtlMs` | 120 | 标记后多久内有效（存储为 ms） |
| 强制压缩冷却(秒) | `sweepMinIntervalMs` | 600 | 两次强制压缩的最小间隔（存储为 ms） |

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
| [`docs/reference/README.md`](docs/reference/README.md) | 第三方（DSH 官方）抽取材料的来源与许可 |
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
3. 占用达**强制压缩线**时，插件无条件压缩（pre-step / idle 兜底），压缩事件出现在会话日志；
4. 两条线可经 Config 配置（面板按秒/比率显示），改后**即时生效**（活读，无需重启）；
5. 插件任何异常不影响 DSH 主流程（激活安全零抛）。
6. **智能思考**（开启时）：注入当前档位 + 可选档；Agent 调用工具 `set_reasoning_effort`
   可自主换档，**本次任务内立即生效、任务不中断、无需用户操作**；关闭时提示词不注入、工具不注册。
