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
| **拆 M1 快照 / M5 HUD** | `buildSnapshot` 直接读 m2/m3/m5 三域 state；`onGetHud` 是**跨域聚合视图**（需 `criticalCapOf`(M3) + `measureRatio`(M3) + `effortApi.hudPayload`(effort)）⇒ 不是独立域。**M5 已于 R11 抽出**（跨域依赖全部注入）；**M1 待做** | 第 3 步（一半完成） |
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

---

## 12. R11 解耦第三刀：M5 HUD 域 + **补上缺失的验证层（宿主启动冒烟）**（2026-10-08）

### 12.1 抽出 `plugin/m5.hud.mjs`

搬走五块：存储（`hud-acts.json` 读写 cap 50 + 运行期去重 `recordHudAct`）、发布（`publishHud`）、
文案（`hudReasonLabel` / `formatAct`）、**聚合响应**（`buildHudResponse` ← 原 `onGetHud` 主体）、
**启动回填**（`republishFromReport` ← 原 `bfOnce` 主体）。宿主只剩接线 + 重试节奏 + face 注册。
`host.impl.mjs` **1550 → 1387 行**。

**顺序依据**（R10 搬完才发现的）：M3 的 deps 里出现了 M5 的三个回调 ⇒ **被依赖者必须先独立**。
M5 是「跨域聚合视图」——`getHud` 要同时回答压缩历史（本域）/ 占用（M3 的 `measureRatio`）/
生效上限（R8 的 `criticalCapOf`，client 据此**钳制并落盘**用户配置）/ 思考档位（effort 的 `hudPayload`）
⇒ 四条跨域依赖**全部注入**。它仍是依赖图叶子（只 `node:` 内置 import），只是依赖面宽。

**打破声明顺序环**：M3 需要 M5 的三个回调、M5 需要 M3 的 `measureRatio`，两个接线块谁在前都会 TDZ
⇒ 用**箭头包装**（运行时才取，两个 const 届时都已初始化）。这类环在「谁被依赖谁先独立」的顺序里
是必然会遇到的，记下来备用。

### 12.2 ⚠️ 搬模块时踩到结构性真 bug，并因此补上了本项目最大的验证盲区

接线块的插入点算错一位，把 `let m5Ctl … const m5Ready = import(…)` 一整块**插进了 `schedule()`
的函数体内部**（残留的 `};` 落到接线块之后——**语法完全合法**）。后果是**连锁静默失效**：

- M5 模块从未加载（弹窗无数据、启动回填不跑）；
- `publishHud` / `recordHudAct` / `formatAct` 对 M3 接线**不在作用域** ⇒ M3 模块加载失败
  ⇒ **压缩全链路静默失效**；
- `node --check` 通过、**423 条源断言全部通过**——它们只查文本模式，不执行代码。

真机证据：切换后 `m5.lastPublish` 恒 `null`、`hudLastAct` 恒空串（对照切换前是 `ok` + 有主行）。
定位手段是**读报告时间线**（不是猜）：04:26 正常 / 04:28 激活后全空。

⇒ **新增第四套测试 `test/boot.mjs`：宿主启动冒烟**。用桩 ctx 真跑
`apply(ctx, {}, {pluginDir, reportPath})`，然后：

| 断言 | 它证明什么 |
| --- | --- |
| HUD 面经 `ctx.provide` 注册成功 | 接线块在顶层、face 注册可达 |
| **真调 `getHud(null)` 必须 `ok:true`** | M5 模块构造完成；接线没被嵌进别的函数 |
| `criticalCap` 是 (0,1] 的数 | 阈值核心（R8）接线可达 |
| `occupancyRatio`/`occupancyWindow` 字段在 | 占用读数（M3 的 measureRatio）接线可达 |
| `effortEnabled` 是布尔 | effort HUD 载荷接线可达 |
| 四个监听器注册 + **真调 pre-step handler 不抛且放行** | M3/effort/compact-tool 三条接线可达 |
| 有历史时 `m5.lastPublish.step === 'ok'` | 启动回填**真的跑过**（原缺陷的精确现场） |
| 报告落盘且 history 非空 | 报告管线在本进程内可达 |

**变异验证（这一层的价值证明）**：把 `};` 移回去复现原缺陷 ⇒ **boot.mjs 报 6 条失败，
而 `node --check` 依然通过**——两层验证的差距被当场量化。
副作用边界：报告写**临时目录**，`hud-acts.json` **只读不写**（临时报告无 `m3-act` ⇒ 合并分支不触发）。

### 12.3 教训（与 R7 的 `d.ratio` 同类，但更深一层）

- R7 的教训是「`node --check` 看不见未定义标识符」；
- R11 的教训是「**源断言看不见「代码在不在正确的函数里」**」——一个插入点算错一位，
  就能让整条链路静默失效而所有静态检查全绿。
- ⇒ 从现在起，**任何「搬出去」的改动，都必须由 boot.mjs 这类真执行测试兜底**；
  源断言只负责钉「实现长什么样」，不负责「它到底跑不跑得到」。

### 12.4 验证

contract **313** + static 51 + report 59 + boot **14** = **437 断言**全绿；
M5 域变异 **6/6 被捕获**；真机复核：`m5.lastPublish ok` + 主行由 `hud-acts.json` 回填成功。

---

## 13. R12 解耦第四刀：M2 注入域（2026-10-08）

### 13.1 抽出 `plugin/m2.inject.mjs`

| 搬走的 | 说明 |
| --- | --- |
| `renderUsageText` | 用量三元组文本（纯信息，无行为指令） |
| `retentionTeach` / `renderPolicyCard` / `renderBrief` | 三个教学出口；**教学文本本体仍在** compact-tool / effort（这里只做出口 + 活值） |
| `briefedBySid` / `effBriefedBySid` / `measuredFailedOnce` | 三张随会话增长的集合（均已**有界化**） |
| `clearBriefed` | **被 M3 调用**的跨域回调（压缩成功后让一次性说明重讲） |
| `buildInjection(payload)` | 原 pre-step 回调里的 M2 半段 |

宿主只剩三行语义：`if (!m2Ctl) return decision;` → `await m2Ctl.buildInjection(payload)` →
把消息并进决策。`host.impl.mjs` **1387 → 1262 行**。

### 13.2 「为何不注入」用返回值表达，而不是用早退散落各处

`buildInjection` 返回 `{skip:'aborted'|'not-step-1'|'noFactory'|'noSession'|'measureFail'|'error'}`
或 `{message,text,card}`。宿主只判「有没有 message」。好处：

- 注入路径的**每一种失败都不会影响原决策**（宿主 `return decision` 放行）；
- 每种 skip 原因都能被**计数/断言**（`state.m2.skips`），而不是散落在一堆 `return decision` 里；
- 测试可以在**不启动真实 DSH** 的情况下把注入路径跑到某个确定分支（见 §13.3）。

`createUserMessage` 仍由宿主异步解析（官方包候选链）⇒ 经 getter 现取；未解析时按 `noFactory`
记账并**不注入**——**绝不伪造消息结构**（本项目已因伪造用户消息返工过一次）。

### 13.3 把「接线可达」变成可观测的运行时事实（boot 扩展）

R11 的教训是「源断言看不见代码在不在正确的函数里」。R12 把这层验证**推进了一步**：
boot.mjs 里加一次**非 abort、step=1** 的 pre-step 真调用，判据用**记账痕迹**——

- 模块未加载：宿主在 `if (!m2Ctl) return decision;` 直接放行，**不会留下任何 `m2.skips`**；
- 模块已加载：`buildInjection` 必然走到某个分支并记账（本桩环境落在 `noFactory`/`measureFail`）。

⇒ 「M2 接线是否可达」从「读源码猜」变成了「跑起来看有没有记账」。这类判据可以复用到
其余域（M3 的 `rangeProbe`、M5 的 `lastPublish` 都是同款思路）。

### 13.4 验证

contract **317** + static 54 + report 59 + boot 17 = **447 断言**全绿；**变异 6/6 被捕获**。
真机：`m2.registered=true`、`via=resourcesPath/app.asar|import`、`injections=6`、`briefings=2`、
`skips={}`、`lastText` 为真实用量行。

**一处自纠（值得记）**：新绊线首版把 `const clearBriefed = (sid) => {` 一律判为「宿主重复实现」，
而宿主**合法**保留一个薄转发（M3 依赖它）⇒ 断言在未变异的代码上就失败。
⇒ 教训：**「宿主不得实现 X」的判据必须写在「X 的实现特征」上，而不是「X 的函数名」上**；
否则连合法的转发都会被误判。

### 13.5 进度

| 步骤 | 状态 | 产出 |
| --- | --- | --- |
| ①阈值核心 | ✅ R8 | `threshold.mjs` |
| ②M3 压缩域 | ✅ R9+R10 | `m3.compact.mjs`（执行核心 + 编排层） |
| ③M5 HUD 域 | ✅ R11 | `m5.hud.mjs` |
| ③M2 注入域 | ✅ R12 | `m2.inject.mjs` |
| ③M1 快照域 | ✅ R13 | `m1.snapshot.mjs` |
| ④core 收尾 | ✅ R14 | `core.mjs`（+ entry 预加载） ⇒ 宿主 **518 行**（代码 294） |

`host.impl.mjs`：**1836 → 518 行**（−72%；代码行 690 → 294，注释行保留 199）。

---

## 14. R13/R14 收尾 + **一次真机静默失效的完整取证**（2026-10-08）

### 14.1 R13：M1 快照域

`m1.snapshot.mjs`（`buildSnapshot` / `slimSnapshot` + `SLIM_REASONS` / `eventProbe` + `recordEvent`）。
搬迁时把 `SLIM_REASONS` 一起搬走、而宿主 `refresh` 仍直接引用它 ⇒ ReferenceError 被 refresh 的
try/catch 吞掉 ⇒ **报告永不落盘**。**boot 冒烟当场抓住**（源断言只报一条形式问题）。
修法是把判定口径也交给模块（M1 暴露 `isSlim(reason)`），未就绪时按 FULL 处理。

### 14.2 R14：core 收尾 + entry 预加载

见 milestones 的 R14 条目。要点：`state`/`log`/`svc`/`schedule`/`addListener` 在 apply 期**同步**使用，
而 `?ts=` 动态 import 是异步的 ⇒ 只能由 **entry 预加载 core 再传给 apply**；entry 属「改它必须重启」
的薄壳，故宿主对「拿不到 core」做了**降级不崩**（有 boot 断言钉住）。

### 14.3 🔴 用户在真机上看到的现象与完整因果链

**现象**：会话中途我调用 `compact_context`，工具返回 `{"ok":true,"scheduled":"next-step"}`，
但**压缩并没有发生**。

**取证链（全部来自权威源，不是推断）**：

| 时间(UTC) | 事实 | 证据来源 |
| --- | --- | --- |
| 04:22:42 | **最后一次真正成功的压缩** | 会话存储 `compaction/summary range={20897,19955}` |
| 04:30:13 | R11 激活 —— **从这一刻起 M3 域加载失败** | `git show 6bbc751`：`const COMPACT_TIMEOUT_MS = 180_000;` 被这一提交**删除**（不是搬走） |
| **04:31:06** | 用户截图里的那次 `compact_context`：工具登记成功、意图进入内存表 | 报告 `reason='compact-tool'` 条目 |
| 04:31:06 之后 | 每个 step 的 pre-step 都调 `preStepCompaction`，但 `m3Ctl === null` ⇒ **直接 no-op**（连 `preStepActs` 都不加） | 此后所有条目 `preStepActs=0` / `compactIntents=0` / 无 `rangeProbe` |
| 04:22 之后 | 会话存储**再无** `compaction/summary` | 权威源 |
| 04:54:15 | 新一轮首步出现 `m2.skips.measureFail = 1` | 报告 —— 因为 M2 的用量行也依赖 M3 的 `measureRatio` |

**因果链**：R11 的搬迁脚本切块范围比预期宽 ⇒ 顺手删掉了 `COMPACT_TIMEOUT_MS` 的**定义**（而
`m3.compact.mjs` 从 R10 起就在用它）⇒ M3 模块的 deps 构造抛 ReferenceError ⇒ 被 `.catch` 吞成一条 warn
⇒ `m3Ctl` 恒为 null ⇒ ① `preStepCompaction` 变成 no-op（**工具回 ok、意图登记成功、但没人消费它**）；
② `measureRatio` 失败 ⇒ **M2 用量行与决策卡一起消失**；③ M5 的占用读数与 idle 安全网同时失效。
每一层都有空值降级 ⇒ 没有任何一处抛到用户眼前。

**这正是 R7 审查里 F5 那条缺陷的同款形态**（「工具回 scheduled 但压缩永不发生」）——
F5 修的是「服务不可用时意图被提前消费」，而这次是「**消费者整个模块没加载**」，属于更深一层。

### 14.4 教训（两条，都写进了验证层）

1. **「异常逐支吞掉只记录」的纪律有一个盲区**：域模块加载失败 = 该域静默不工作，而源断言与行为断言
   都看不见。⇒ boot 冒烟新增**收集宿主吞掉的 warn** 并断言「没有任何域模块加载失败 / 未定义标识符」。
2. **搬迁手术必须逐块自检**：切块范围比预期宽 ⇒ 顺手删掉别的东西，而 `node --check` 与源断言都合法。
   ⇒ 新增静态对账「宿主从 core 解构的每个名字都在 core 出口里」，并在每次搬迁后用
   `git log -S<被搬走的定义>` 复核它是否只是**换了位置**而不是**消失**。

### 14.5 一次自我纠错（关于归因）

R14 首次定位时我写「R12 丢的」，依据是一张逐提交核对表——而那张表**漏了 R11 那一行**
（`6bbc751` 不在我列的 sha 里），于是把「R10 还在、R12 已不在」误判成 R12 删除。
改用 `git log -S'const COMPACT_TIMEOUT_MS'` 后立刻暴露真相：**R11 才是删除点**。
⇒ 教训：**列证据表时必须核对是否覆盖全部候选**——漏一行就会把因果链指错一个提交，
而「谁引入的」正是后续排查的起点。
