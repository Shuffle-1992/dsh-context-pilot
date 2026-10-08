# R7：两大功能全面审查 + 强制性优化与解耦

> 用户要求（2026-10-08）：「对这两个功能进行全面审查。review，simplify，强制性优化，解耦。」
> 本文是**审查报告 + 本批实施记录 + 未实施项与理由**。
>
> 审查方法：**三路并行只读审计**（host.impl.mjs / client.js / 工具域三模块）+ 本机客观统计
> （逐字段引用计数、行数体积、测试锚点比对）。审计**未修改任何文件**；所有结论带
> `文件:行号` + 关键代码引文。本批修复由我逐条复核后实施。

---

## 0. 一句话结论

两个功能的**功能链路本身是健康的**（依赖图无环、模块确为叶子、工具不抛错、
`defineSchema` 合规、教学覆盖到位），但**退役遗留与静默降级**是主要债务：
一条已废弃的「marker 触发 + 自动恢复」通道仍在 host/client/schema/wire 四层留着一半尸体；
六个真缺陷里有四个的表现形式都是「**看起来成功了，其实什么都没发生**」——
这正是本项目反复吃亏的失效模式。本批已把退役通道**整体清零**、修掉 6 个真缺陷、
补上 8 类新护栏（396 断言 + 13/13 变异验证）。

---

## 1. 真缺陷（已全部修复）

| # | 缺陷 | 现场 | 后果 | 修复 |
| --- | --- | --- | --- | --- |
| **D1** | 档位**空数组被当成「可选集为空」** | `effort.mjs` `checkEffort` 用 `Array.isArray(eff.efforts)` 判定，而上游把缺失的 `efforts` 归一成 `[]` | `options.includes(want)` **恒假** ⇒ **一刀否决所有档位**，错误文案退化成「可选 」，与文件头「取不到不否决」的设计直接矛盾 | 判据改为 `length > 0`，与 `renderBrief` 同口径 |
| **F5** | 意图**先消费后判断能否执行** | `host.impl.mjs` pre-step：`takeIntent` 在 `resolveCompactionFor` 之前 | 服务解析不到就直接 return ⇒ **意图已丢**，而工具早已回 `scheduled:'next-step'` ⇒ 模型以为压过了、实际没压，**且不会重试** | 移到服务确认之后；服务不可用时**保留意图**待下次（TTL 兜底） |
| **F1** | idle 冷却**在发车前就记账** | `state.m3.sweeps[sid] = now` 在 `.compactNow` 之前 | 一次失败即消耗 `sweepMinIntervalMs`（默认 **10 分钟**）⇒ 该会话安全网静默失效 10 分钟 | 移到成功分支（`.then`） |
| **F2** | `sweepInFlight.add` 与 `.finally` 之间**有可抛语句** | `add` → 取冷却 → `log` → `compactNow` → `.finally` | 这段同步代码里任何抛错 ⇒ sid **永久驻留** ⇒ 该会话**永久失去 idle 安全网**，且无任何显式日志。（审计窗口内真实发生过：日志模板引用了已删变量 `d.ratio`） | 「可能抛的语句」全部前移到 `add` 之前，`add` 之后**紧贴** promise 链 |
| **C1/C2** | 意图表**没有全表清扫** | `compact-tool.mjs` `peekIntent` 只删「当前 sid」那一项 | 别的会话的过期意图**永不清理** ⇒ TTL 形同虚设、Map 无界增长；叠加「session id 会轮转」⇒ 意图登记在旧键、**压缩静默不发生**但工具已回成功 | 新增 `sweepExpired()`（登记/查询/消费三处触发）+ `pending()` 诊断出口 + host `compactIntentMiss` 留痕 |
| **E1/B1** | 弹窗「距智能压缩线」**永不显示** | host 一直在算并下发 `occupancyRatio/occupancyWindow`（wire 签名也声明了），client 的 `hudRemote` **从不搬这两个字段** | 该 UI 分支永远拿到 `undefined`；典型「host 算了 / wire 声明了 / client 不用」三端漂移 | client 补上两个字段 |

### 结构性教训（F2 的直接来源）

`node --check` **看不见未定义标识符**——本批实施中就真的踩了一次：
删掉局部 `const d` 改为 `mr` 之后，`idleSweep` 日志里漏了一处 `d.ratio`，
语法检查全绿、单测全绿，**运行时会 ReferenceError**。而它的后果（F2 永久锁）
正好是本项目已知的「静默降级」。⇒ 专门加了「被删局部变量不得残留」的绊线
（`\bd\.ratio\b` / `\bd\.ok\b` 仅在 host 范围内判定，避免误伤 client 里同名的无关字段）。

---

## 2. 退役遗留：marker 通道整体清零（本批最大简化）

### 背景

R4 只删掉了「**伪造用户消息自动拉起**」这条投递链，但 **marker 通道本体**留了下来：
`M3.marker` / `armedTtlMs` / `markerArmed` Map / `session/event` 标记解析 /
`pendingBySid` / `lastUserTextBySid` / `state.m55` / `hudArmed` / `hudPending` /
两个 UI 徽章 / 4 个配置字段。R6 之后**三处教学都已改工具版**，没有任何地方再教模型写标记
⇒ 这条通道**永远不会命中**，却仍在四层之间成对存在。

### 删除清单（跨 6 个层面）

| 层 | 删除内容 |
| --- | --- |
| host | `M3.marker` / `armedTtlMs` 及其读取集；`markerArmed` Map（**无界**）；`session/event` 里的标记解析整段；`agent/inbox/inserted` 审计监听器 + `decideCompaction` + `decisions`/`wouldCompact`/`lastDecision`；`pendingBySid` / `lastUserTextBySid` / `m55Attempt` / `state.m55`；`hudArmed`/`hudPending` 全部写入点；idle 双模式收敛为单一 safety-net；SLIM 的 3 个 reason |
| client | 「武装中」徽章、「待执行」徽章（含「压缩后自动恢复执行」这条**已失效的承诺文案**）、`chips` 容器、`chip()` 工厂、`marker`/`armedTtlMs` 两个面板字段、摘要行里的「标记」、`hudRemote` 的两个字段 |
| schema | `marker` / `armedTtlMs` / `hudArmed` / `hudPending` 四个字段 |
| wire | `getHud` 签名里的两个字段 + 说明 + JSDoc（并把字符串内的字面量改名，让绊线能严格判定） |
| tests | 3 个已过期锚点改钉新契约；新增「退役零残留」「退役字段未复活」「保留项未被误删」 |
| docs | 本文 + milestones + README |

**保留（易误删）**：`markerMinRatio` —— 它名字里带 marker，但**与标记无关**，
是**决策卡注入门槛**，host 仍在用（`renderCard` 实参）。专门加了绊线钉住它不被一起删。

---

## 3. 死代码与无界状态（已清理/有界化）

| 项 | 证据 | 处置 |
| --- | --- | --- |
| `probeService()` | 全仓库**零调用点**（职责早被 `snap.services[k] = svc(k)` 取代） | 删除 |
| `state.m3.probe` | 无任何写入 ⇒ 恒 null，只随 `...state.m3` 进报告 | 删除 |
| `decideCompaction()` | 审计监听器删掉后只剩 idleSweep 读 `ok`/`ratio`，其余产物全死、文档还停在「决策主体是模型标记」 | 删除，idleSweep 直接调 `measureRatio` |
| `briefedBySid` / `effBriefedBySid` / `measuredFailedOnce` | 键是 session id，**只增不删** ⇒ 无界 | `remember()` + `SET_CAP = 200`（淘汰最旧；被淘汰的会话最多多讲一次说明，无害） |
| `state.m3.sweeps` | 以 sid 为键、从不清理 | 成功记冷却时按 `SET_CAP` 淘汰 |
| `actErrors` / `preStepErrors` | 键来自任意错误码字符串 | 保留（错误码域本来就小），但口径统一为 `errCodeOf` |
| `effort.mjs` 的 `diag()` | 零调用 | 保留（`compact-tool` 的同名函数已**接入报告**用于意图诊断；effort 侧状态本就全程镜像进报告） |

---

## 4. 重复与漂移（已收敛 / 已加护栏）

| 项 | 证据 | 处置 |
| --- | --- | --- |
| **默认值三处硬编码且无值级对账** | 面板 `def` / schema `.default()` / `M3_DEFAULTS` 三份；原对账**只比键名** | 新增 §6b **值级**对账（布尔按串、数值按下划线归一），并断言每个面板字段都能解析到默认值 |
| `180_000` 魔法数字两处 | pre-step 兜底信号 / idle `compactNow` 超时 | `COMPACT_TIMEOUT_MS` 单点 |
| 错误码分类两套口径 | pre-step `code→name→'error'`；idle 额外特判 `ManualCompactionError` | `errCodeOf(e)` 单点 |
| `hudReasonLabel` 缺分支 | `context-overflow`（=模型主动请求）落进默认分支 ⇒ 弹窗显示内部枚举名；且 HUD 文案把工具触发的压缩写成「强制压缩」 | 补 `context-overflow → 智能压缩`；HUD 文案改用真实 `trigger` |
| 引擎阈值探针**读路径写状态** | `engineThreshold()` 每次都重写 `engineCapProbe`，而 `getHud` 每 5s 经 `criticalCapOf` 进来 | 只在「无探针 / 值变了 / via 变了」时写 |
| 比率可被填 0 ⇒ 行为瘫痪 | `mergeConfig` 原先 `>= 0`；schema 无 `.min()`；面板只拦空串 | host 侧改 `> 0`（非法值保持上一次有效值） |
| 教学出口静默返回 null | `renderPolicyCard`/`renderBrief` `catch { return null }` 无日志 ⇒ 「模型永远不知道有工具」 | 加 `warnTeachOnce()`（只报一次） |

---

## 5. 客户端结构性问题（已修）

| # | 问题 | 处置 |
| --- | --- | --- |
| D5 | `CardBoundary` 只是 `try/catch` 包装**函数** ⇒ 只挡渲染期同步异常；effect / 事件回调 / 异步 setState 的异常仍会打崩整个插件详情页（本项目已出过一次「面板整卡消失」真事故） | 改为**真正的 React 错误边界**（`class extends react.Component` + `getDerivedStateFromError` + `componentDidCatch`），隔离粒度 = 单张卡 |
| E6 | `autoClamped` 异步分支缺 `alive` 守卫 ⇒ 组件卸载后仍继续写配置（越权副作用） | 写入后 + 错误分支各加一处守卫（绊线**计数**两处） |
| A4/D9 | 退役承诺仍在文案里（「压缩后自动恢复执行」「…并自动续跑」） | 随退役一并删除 |

---

## 6. 验证

| 层次 | 内容 | 结果 |
| --- | --- | --- |
| 单元/契约 | contract **298** + static 42 + report 56 = **396 断言** | 全绿 |
| R7 新护栏 | 退役零残留（4 类正则 × 4 文件，剥注释判定）/ 退役字段未复活 / 保留项未被误删 / 有界化 / 意图表行为（真跑 `runTool`：登记→`pending()`→隔离→消费）/ 全表 TTL 清扫 / 空数组不否决 / 值与键双向对账 / **顺序契约**（F1 冷却在成功分支、F5 消费在服务确认之后、F2 可抛语句前移）/ 真错误边界 / occupancy 搬运 / alive 守卫计数 | 全绿 |
| **变异验证** | 13 个针对性回归（复活退役字段 / 复活 hudArmed / 默认值漂移 / 去有界化 / 去全表清扫 / 空数组否决 / 两种意图消费顺序回退 / 冷却回退 / 报告镜像移除 / 错误边界回退 / occupancy 移除 / 去 alive 守卫） | **13/13 被捕获，0 逃逸** |

### 两次逃逸都记入教训

1. **「去掉 autoClamped 的 alive 守卫」第一次逃逸**：块内有**两处** `if (!alive) return;`，
   断言只写「存在一处」⇒ 删掉任一处照样通过。已改为**计数 = 2 + 位置**。
2. 同一断言的第二个坑：`[\s\S]{0,120}` 窗口太小（实际间隔 146 字符）⇒ 断言恒假。
   **正则窗口也是断言的一部分**，必须按实际代码量核对。

---

## 7. 未实施（明确挂起，含理由与建议顺序）

按审计 E 类的结构分析，**解耦的瓶颈不是「文件太长」，而是三处共享**：
① 单例 `state`；② `schedule` / `publishHud` / `clearBriefed` 三个跨域回调；
③ `criticalCapOf` 被 M1/M2/M3/M5 **四处**复用。

| 项 | 为什么挂起 | 建议顺序 |
| --- | --- | --- |
| ~~抽「阈值核心」为只读服务~~ **✅ 已实施（R8）** | —— | ~~第 1 步~~ **已完成** |
| ~~拆 M3 压缩域~~ **✅ 已完成（R9 + R10）** | R9 抽执行核心、R10 搬编排层并把五个跨域回调显式注入（见 §10/§11） | ~~第 2 步~~ **已完成** |
| **拆 M1 快照 / M5 HUD** | `buildSnapshot` 直接读 m2/m3/m5 三域 state；`onGetHud` 是**跨域聚合视图**（需 `criticalCapOf`(M3) + `measureRatio`(M3) + `effortApi.hudPayload`(effort)）⇒ 不是独立域 | 第 3 步 |
| **`host.impl.mjs` 拆分到 ≤250 行** | 上述三步做完才可能；本批已顺手把 1 个域内死函数与 1 个跨域审计块清掉（净减约 40 行，同时新增了 6 处缺陷修复的注释） | D1 任务书 |
| **报告尾部对账的全量读放大** | 检测到「他方写入」后每次写都全量读写 MB 级报告；仅在**僵尸实例共存**时触发。修它需要改多写入者协议（写入者标识 + 分段追加），风险高于收益 | 观察 |
| **DOM 注入的三处脆弱性**（中文 aria-label / CSS-module 哈希类名 / 5s 轮询兜底） | 宿主无官方插槽，这是**结构性代价**，不是本插件的 bug；改宿主文案或升级即失效，只能靠多重回退兜底（已有多重） | 接受 |
| **`sessionMatched` / `at` 三端漂移** | wire 声明、host 下发、client 不读（诊断用元数据，无害） | 低价值 |
| **`effort.mjs` 的 `bySid` 无回收** | 设计如此（「pending 持久」是刻意的，文件头结论②）；正常换档过的会话条目永存 ⇒ 有界化需要先确认「pending 持久」的边界 | 需设计确认 |
| **注入时钟（`now`）** | 两个工具模块的冷却/TTL 全走裸 `Date.now()` ⇒ 状态机与错误路径**系统性测不到**（本批只补到「登记→pending→消费」这一步） | 与状态机测试一起做 |

---

## 8. 本批的自我评价

- **做得好的**：先并行三路只读审计拿到完整清单，再逐条复核后动手；每个真缺陷都配了**行为级或顺序级**绊线，并做 13 项变异验证；两次逃逸都当场定位到断言本身的缺陷（不是"再跑一遍就过了"）。
- **做得不好的**：实施 R7 时先改代码后补测试，中间出现过 6 个测试锚点过期待修的窗口；`d.ratio` 那个运行时错误也是自己引入的——说明**大批量删除后的第一件事必须是跑测试 + 逐个消费失败**，而不是继续删。
- **最该带走的结论**：这个插件的头号风险不是「功能不工作」，而是**「看起来工作了，其实什么都没发生」**（工具回成功但意图丢了、冷却扣了但没压、字段算了但没人读、教学 catch 了但没日志）。四个真缺陷全部属于这一类。

---

## 9. R8 续做：解耦第一刀 + 审查引出的一处取证静默丢失（2026-10-08）

### 9.1 抽「阈值核心」为叶子模块（§7 表里的第 1 步）

新增 `plugin/threshold.mjs`（DI 注入 `svc/tryOf/state/log`，对宿主内部件**零 import**），
把 `engineThreshold` / `criticalCapOf` / `resolveCompactionFor` 及 `DEFAULT_ENGINE_THRESHOLD` /
`ENGINE_CAP_MARGIN` 整体搬出 host。host 只留**懒加载 + 三个同名转发**。

**搬迁过程中撞到的一个结构性事实**（值得记）：宿主 `apply` **不是 async**
（`export function apply(ctx, config, …)`），而这些函数被 `getHud`（RPC 面）、报告快照、
两条压缩路径**同步**调用 ⇒ **不能**在 apply 里 `await` 模块。最终用与
`effortApi`/`compactToolApi`/`rangeApi` **同款**的「懒加载 + 空值降级」：模块未就绪时
`criticalCapOf` 返回 `1`（不做上限钳制）并留一条痕 —— 关键是**降级路径不引入任何重复常量**，
否则就又把「两套真相」请回来了。

### 9.2 审查引出的真问题：报告里 FULL 条目被挤光（取证静默丢失）

修 R8 时顺手核对报告，发现 **120 条 history 全是 slim、full 0 条**：
高频 slim 事件（heartbeat 120s / agent/status / m5-publish 400ms 防抖 / m2-inject）
把 FULL 条目（`activation+2s` / `m3-act` / `m4-probe` / `boot+10s`）**挤出环形缓冲**
——而 FULL 恰是「压缩到底成没成」的唯一留档位。

更值得记的是**为什么测试没发现**：`report.mjs` 的 `mustFull` 断言只检查那些 reason
**不在 SLIM 名单里**，从不检查它们**真的还在历史里** ⇒ 断言全绿、证据已丢。
⇒ R8 两处一起修：
1. 满环时**优先淘汰最旧的 slim 条目**（没有 slim 可淘汰才退化为砍最旧）；
2. 新增**代码级**绊线（`slimIdx = next.findIndex(profile==='slim')` + 禁止 `slice(-HISTORY_CAP)`）；
   数据侧只打印诊断而**不做断言**——报告是运行期数据，拿修复前的旧数据跑测试会假红。

**真机验证**：修复前 `{slim:120}` → 修复后 `{slim:116, full:4}`，FULL 条目为
`m2-factory / m4-probe / activation+2s / boot+10s`。

### 9.3 顺带修掉一个测试设计缺陷

同一次核对发现 `report.mjs` 有两条**条件断言**（`if (full.length)` / `if (slimLast)`）
⇒ 断言总数随报告数据在 **55/56/57 之间漂移**。已改为无条件（缺数据即失败），
并把「档位分布」打印出来。**断言数不稳定 = 护栏会静默少跑**。

### 9.4 弹窗折行（用户截图）

截图里「智能压缩线 30% · 强制压缩线 75% · 已过智能压缩线（距强制线 305K）」被显示成
「…· 已过智」/「能压缩线（距强制线 305K）」。根因：状态提示被拼进**同一个文本节点**，
而弹窗宽仅 ~230px —— 40+ 汉字在 11px 下不可能一行放下（字号还是用户要求放大过的）。
⇒ 改为**状态提示独立成行**：断点落在自然边界，不再切断「智能压缩线」这个词。

### 9.5 验证

contract **303** + static 45 + report 57 = **405 断言**全绿；**变异验证 5/5 被捕获**
（host 重复定义常量 / 模块丢 `?ts=` / 去掉空值降级 / 满环退回无差别淘汰 / 弹窗提示拼回同一串）。

---

## 10. R9 解耦第二刀：M3 **执行核心**抽出 + 首次真机观测到边界回退（2026-10-08）

### 10.1 抽了什么

新增 `plugin/m3.compact.mjs`（第六个叶子模块），搬出 M3 里最大、最自包含的一块：
`measureRatio`（测量读数收敛）+ `compactWithOwnRange`（自选范围执行 + `prevEnd` 回退 + 官方兜底 + 留痕）。
宿主只留懒加载 + 两个同名转发；`range` 模块的生命周期仍由宿主拥有，通过 `awaitRange()` 注入给核心模块。

**为什么只搬这两个**（而 `preStepCompaction` / `idleSweep` 留着）：编排层同时触碰
M2 注入（决策卡/一次性说明）、M5 HUD（`publishHud`/`recordHudAct`/`formatAct`）、
M2 的 `clearBriefed`、报告 `schedule` —— 这些回调必须先做成**显式注入**才有意义。
先搬执行核心的好处是：宿主直接少掉 ~180 行，而**调用点几乎不动**（同名转发），风险最低。
⇒ 解耦第 2 步**完成一半**（编排层待第三刀）。

### 10.2 真机 E2E：一次完整的自选范围压缩（顺带补上一个诚实缺口）

抽取部署后，模型恰好发起了一次压缩（`compact_context`，即「轮内工具触发」路径），
执行全程走新模块。报告与**会话存储**双向吻合：

| 观测 | 值 |
| --- | --- |
| `lastPreStep.trigger` / `acted` | `context-overflow` / `true` |
| `rangeSource` / `retainBudget` | `own` / `160000`（= 1M × 0.16） |
| `rangeProbe.ownRange` | `{start: 18990, end: 19504 → 回退 → 19501}`，surfaceNodes 997，retained 160,902 |
| `lastPreStep.shadowedTokens` / `ms` | 175,827 / 28,403ms |
| **`walkBacks`** | **1** 🔥 |
| `preStepErrors` / `lastPreStepError` | `{}` / `null` |
| 会话存储（权威源） | `compaction/summary range={"start":18990,"end":19501}` **逐字一致** |
| `m2.skips`（旁证 `measureRatio` 正常） | `{}`，而 `m2.injections > 0` 且用量行正常渲染 |

**`walkBacks = 1` 是本项目第一次在真机观测到 `prevEnd` 边界回退**：首次末端 seq 19504 被判为
不合法（切在 step/tool 配对中间）⇒ 回退一个 surface 节点重试 ⇒ 成功。
这正好补上 `docs/r5-retention-range-design.md` §6.4 第 1 条诚实缺口——
那条曾经写着「不可控，只能等自然出现」，现在**真机 + 单测 + 变异**三层齐备。

### 10.3 变异验证

**5/5 被捕获**。其中一次逃逸值得记：我最初的 M1 变异写成「在宿主插入 `const ratioKept2 = 0.16;`」，
而断言查的是 `const ratioKept = api.RETAIN_RATIO;` —— **逃逸的是变异脚本、不是断言太弱**。
两处都改了：变异改成忠实复现「宿主导回范围执行」（`api.RETAIN_RATIO` + `api.selectRange`），
断言也加强为「宿主不得再出现 `api.RETAIN_RATIO` / `api.selectRange(`」。
⇒ 教训：**变异必须忠实于断言的语义**，否则你验证的是自己的手误。

### 10.4 验证

contract **306** + static 48 + report 59 = **413 断言**全绿。

---

## 11. R10 解耦第二刀（续）：M3 编排层搬出宿主 —— 第二个障碍显式化（2026-10-08）

### 11.1 搬了什么

`preStepCompaction`（轮内先压：意图消费 / 阈值门控 / 强制线收口 / 留痕）与
`sweepInFlight` + `idleSweep`（idle 安全网 + 冷却 + 有界化）**整体搬进 `m3.compact.mjs`**。
宿主只剩**四个薄转发**（`measureRatio` / `compactWithOwnRange` / `preStepCompaction` / `idleSweep`）。
⇒ M3 域的「执行核心 + 编排层」现在都在同一个模块里，`host.impl.mjs` **1765 → 1551 行**。

### 11.2 关键：第二个解耦障碍被显式化

R7 审计指出 M3 拆不动的第二个原因是「靠闭包穿透别人的域」。这次把五个跨域依赖
**全部改成 deps 注入**，并在模块里直接可见：

| 注入项 | 原本的穿透方式 | 现在 |
| --- | --- | --- |
| `publishHud` / `recordHudAct` / `formatAct` | M5 HUD 域（闭包） | deps 字段 |
| `clearBriefed` | M2 教学域（闭包） | deps 字段 |
| `schedule` | 报告域（闭包） | deps 字段 |
| `criticalCapOf` / `resolveCompactionFor` | R8 的阈值叶子（闭包转发） | deps 字段 |
| `getCompactTool` / `awaitRange` | 另两个模块的单例（闭包 + 变量） | deps **取用口**（模块生命周期仍归宿主） |

**搬出来才发现的一个真问题**：M3 模块现在的依赖清单里出现了
`publishHud`/`recordHudAct`/`formatAct`/`clearBriefed` 四项——**这说明 M5 与 M2 必须先于 M3 稳定**。
下一步的顺序因此明确了：**先抽 M5 HUD（谁被依赖谁先独立），再 M2 注入，最后 M1 快照 + core 收尾**。

### 11.3 接线位置的一个 TDZ 陷阱（值得记）

R9 时接线块在文件前部（`IMPL_TS` 之后）；R10 起必须**下移到 `preStepCompaction` 原来的位置**
——因为 deps 对象是**立即构造**的，而 `schedule` 在文件更后面才定义，放前面直接 TDZ 崩激活。
`measureRatio` 虽在更早的 `renderUsageText`（第 ~1067 行）里被引用，但只要**调用发生在初始化之后**
就不受 TDZ 约束（const 的 TDZ 只看运行时求值时刻）——两者容易混淆，已在宿主注释里写明。

### 11.4 验证

- contract **308** + static 48 + report 59 = **415 断言**全绿。
- **变异 6/6 被捕获**：宿主又抄回编排实现 / 去掉 `getCompactTool` 注入 / 去掉 `clearBriefed` 注入 /
  模块里退掉 `sweepInFlight` 释放 / 冷却退回发车前记录 / 模块丢 `?ts=`。
- 新绊线刻意**不查函数名**（改名就能躲过），而是查「编排层的独有产物是否回流宿主」：
  `state.m3.lastPreStep = {`、`sweepInFlight`、`M3.sweepMinIntervalMs`、`state.m3.actErrors[code]`。
