# R51 自审报告 —— dsh-context-pilot（2026-10-17）

> **性质声明（重要）**：这份报告是**自审**（写代码的人审自己的代码），**不等价于独立审计**。
> 独立审计安排过两路，都没跑成：
> - **A 路**（`opencode` 免费 flash 模型，3 次尝试）：模型太弱，两次只回了「上次被中断、报告未产出」
>   就停止，第三次（`deepseek-v4.1-flash-free`）卡死 5 分钟零进展被终止；
> - **B 路**（`qoder/Qwen3.8-Flash`，用户指定的千问）：**在被用户删除前抓到了真缺陷 #1**（TDZ），
>   我用独立脚本复核确认后修复。
>
> ⇒ 下面按**可信度分级**标注来源：`独立`（外部审计者提出 + 我方复核）/ `自审`（只有我自己）。
> 自审的盲区是系统性的：我读代码时的"预期"本身就来自我写它时的推理。

## 0. 结论速览

| # | 缺陷 | 严重度 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| 1 | `official()` 兜底闭包的 **TDZ** ⇒ 「压了却报未执行」（假阴性 + 记录双丢） | **高** | 已修（v0.1.40） | **独立** |
| 2 | 5 处 `.data` 落盘**非原子** ⇒ 半截 JSON ⇒ 报告/记录整份丢失 | **中** | 已修（v0.1.41） | 自审 |
| 3 | `state.m3.ownCompact` 是**全局单槽** ⇒ 多会话压缩互相干扰（漏记/重复记录） | 低 | 已修（v0.1.41） | 自审 |
| 4 | `preStepOk` 在「无可压区间」时也 +1（成功计数语义偏差） | 极低 | **不改**（见 §4） | 自审 |
| — | 错误路径自抛（第三个实例）、恒真断言、无界增长 | — | **未发现** | 自审 |

验证：**780 断言全绿**（contract 628 / static 77 / report 54 / boot 21）；
本轮新增守卫 **变异 2/2 CAUGHT**（#2、#3 各一条）；#1 见 v0.1.40 记录（变异 2/2）。

---

## 1. 缺陷 #1（独立来源）：`official()` 闭包 TDZ

**位置**：`plugin/m3.compact.mjs#compactWithOwnRange`

**机制**：`official()` 是个闭包，内部对象字面量引用 `retainSource` / `useAnchor` / `tierInfo`，
而这三个 `const` 声明在闭包**之后**。`awaitRange()` 返回 null（`compact-range.mjs` 加载失败，
宿主 `rangeReady.catch` 返回 null）时，`official('no-range-module')` 被**立刻**调用 ⇒ 求值时抛
`ReferenceError: Cannot access 'retainSource' before initialization`（TDZ）。

**为什么比"报错"严重**：`compactIfNeeded` 在 `await` 里**已经真的执行了压缩**，随后才抛 ⇒
调用方 `catch` 写一条 `state:'not-executed'` 回执 ⇒ **模型看到"未执行"、实际已执行**（假阴性），
且 `preStepOk` 与 HUD 记录双双丢失 = 静默降级（本项目头号禁忌）。

**修法**：把不依赖 `api` 的 `anchorBudget`/`useAnchor`/`retainSource` 提到闭包之前；
`tierInfo` 先给安全默认 `{tier:'standard'}`、拿到 api 后覆盖 ⇒ 正常路径**逐字不变**。

**守卫**：行为级（`awaitRange→null` 不得抛且回报 `source:'official'` + 保留来源）+ 结构级
（三项声明必须在 `const official = async` 之前）。**变异 2/2 CAUGHT**。

---

## 2. 缺陷 #2（自审）：落盘非原子 ⇒ 半截 JSON

**位置**（5 处，全部 `writeFileSync(目标路径, ...)` 直写）：
`core.mjs`（`m1-report.json`）、`m5.hud.mjs`（`hud-acts.json`）、`session-facts.mjs`（`settle-drop.json`）、
`compact-tool.mjs`（档位/锚点表）、`effort.mjs`（换档统计）。

**机制**：`writeFileSync` 先截断再写 ⇒ 在写满之前，文件内容是**半截 JSON**。任何并发读者——
面板、报告工具、以及**插件自己下次启动**的 `loadReportBase` ——都会读到
`Unterminated string in JSON`。对报告读取路径而言，这不是"读失败就重试"那么简单：
`loadReportBase` 失败后**回退为空基线** ⇒ 整份历史被丢弃（R13 的"报告断档"就是同一形态）。

**现场证据（不是我编的）**：`test/report.mjs` 曾因读到插件**正好写到一半**的
`m1-report.json` 而报 `SyntaxError: Unterminated string in JSON`，当时的处理是给测试加
`readJsonRetry`（重试 6 次 ×200ms）绕开 —— **绕开的是症状，缺陷一直在**。

**修法**：每个域各留一份 `writeJsonAtomic(p, obj)`：先写同目录 `<p>.<pid>.<ts>.tmp`，
再 `renameSync(tmp, p)`。同目录 rename ⇒ 读者要么看到**旧的完整内容**、要么看到**新的完整内容**。
Windows 上目标被别的进程以不共享方式打开时 rename 会 `EBUSY` ⇒ 退化为直写（宁可非原子，
也别让这一次落盘丢失）并清掉 tmp。
⚠️ helper 在 5 个域各复制一份是**刻意的**：本项目禁止域间 import（依赖必须由宿主注入），
复制 8 行比引入耦合安全（与「叶子模块」纪律一致）。

**守卫**：结构级 —— 五个写入点都必须出现 `writeJsonAtomic(<目标>,`、不得出现
`writeFileSync(<目标>,`，且 helper 实现必须是 tmp+rename（防"改名了但行为还是直写"）。
**变异 1/1 CAUGHT**。

**局限（诚实说明）**：原子性只能**跨进程**观察，单进程测试无法复现"读到半截"。故用结构守卫 +
实现形状断言，而不是行为测试。这个守卫能抓住"改回去"，但抓不住"用一种新的非原子写法绕过"。

---

## 3. 缺陷 #3（自审）：`ownCompact` 全局单槽

**位置**：`plugin/m3.compact.mjs`（`markOwnCompaction` / `clearOwnCompaction` / `isCompactionInFlight`）

**机制**：`state.m3.ownCompact` 是**一个对象**（全局单槽），用于标记"我们自己的压缩正在进行"，
让 `compaction/end` 的补记逻辑跳过自家事件。多会话并发时：
- **漏记**：A 会话压缩期间，B 会话的引擎自动压缩走到 `isCompactionInFlight()` ⇒ 全局为真 ⇒
  被当成"自己的"而**不补记**（B 的压缩在面板/报告里彻底消失）；
- **重复记录**：A 的 `finally` 清槽后，B 自己的 `compactRegion` 事件不再被跳过 ⇒ 被**再补记一条**。

两种都是"记录失真"，不会影响压缩本身（所以定低危），但它正好违背本项目"面板/报告是唯一取证面"
的定位：用户看到的是**错的**。

**修法**：按 sid 分槽（`{ <sid>: {at, until} }`，`SET_CAP` 有界化）；`clearOwnCompaction(sid)` 只清自己；
`isCompactionInFlight(sid)` 只看该会话，**不传 sid 仍是"任一在飞"**（旧调用点语义不变）。
`noteEngineCompaction` 里把 `sidE` 的计算**提前**到在飞判定之前。
兼容热换：旧的单槽形状（带 `until`、无 sid 键）读到时直接丢弃重建。

**守卫**：行为级 —— ①「别的会话在飞 ⇒ 本会话引擎压缩照常补记」（旧实现**必红**）；
②「`isCompactionInFlight(sid)` 按会话隔离，无参时仍是任一」。**变异 1/1 CAUGHT**。

---

## 4. 缺陷 #4（自审，**决定不改**）：`preStepOk` 语义偏差

`preStepCompaction` 在 `result == null`（"引擎判定无需压" / `source:'none'`）时也会 `preStepOk += 1`。
严格说这是"路径走通"而非"压成功"，会让报告里 `preStepOk` 略偏高。
**不改的理由**：① 实际压缩量另有 `shadowedTokens`/`lastPreStep.acted` 两个字段精确表达，
`preStepOk` 只是"pre-step 正常完成"的计数，语义上能自圆其说；② 改它会让历史报告的
`preStepOk` 前后不可比（用户已经在用这个数做对比）；③ 零用户可见影响。
**记录在此**是为了以后有人问"为什么 preStepOk 比实际压缩次数多"时能查到答案。

---

## 5. 九条对抗性假设的逐条结论

| # | 假设 | 结论 | 依据 |
| --- | --- | --- | --- |
| H1 | **错误路径自抛**：某 `catch` 引用了 `try` 内声明的 `const`/`let` | **部分成立** | 已知两例：R49.1 的 `sid`（已修）、本轮 #1 的 TDZ（已修）。逐函数复核 `preStepCompaction`/`idleSweep`/`compactWithOwnRange`/`noteEngineCompaction`/`takeCompactVerify` 的 catch 块后**未再发现第三例**；但这是"抽查+测试覆盖"级别的保证，不是形式证明 |
| H2 | **静默降级**：子系统失败但对外仍报成功 | **成立（即 #1、#2）** | #1 = 压了报"未执行"；#2 = 落盘半截导致读取方整份丢弃。另查：工具 `runTool` 的 `scheduled` 路径有 `setCompactVerify` 兜底回执（`not-executed` + 原因），`preStepErrors`/`actErrors` 覆盖面完整 |
| H3 | **嵌套状态未防 undefined**（首次运行/热换重置/多会话） | **不成立** | `state.m1/m2/m3/m5` 的深层访问全部落在 core 初始化过的结构上（`acts`/`sweeps`/`preStepErrors`/`skips`/`effortDiag`/`compactToolDiag`）；热换保留同一 `state` 单例；除 #3 的单槽问题外未发现崩溃路径 |
| H4 | **异步竞态**（互斥被绕过 / 重复压缩 / 丢回执） | **部分成立（即 #3）** | `sweepInFlight` 的 add 紧跟 `.finally`（F2 已修，结构上无泄漏窗口）；`compactLock` 有 TTL 兜底；`markOwnCompaction`/`clearOwnCompaction` 的配对在所有路径上成立（3 处 `finally`）。唯一真实干扰是 #3 的全局单槽（记录层面，非行为层面） |
| H5 | **契约漂移** | **不成立（沿用 R48 结论 + 本轮抽查）** | `compaction` 服务的 `compactNow`/`compactRegion`/`compactIfNeeded`、`sessionProjections.stateOf('contextBreakdown')`、`tokenMeter.measure`、`llm.resolveModelInfo`、`session/event` 的 `compaction/start|end` 与 `assistant/message` 形状，均与 R48 的逐包 diff 结论一致；本轮未改契约面代码 |
| H6 | **数值边界**（除零/NaN/空窗口） | **不成立** | `measureRatio` 对 `window<=0`/非有限值统一返回 `ok:false`；`settledRatio` 有 `window>0` 守卫；`scaleRetainBudget` 有 `[1,2]` 夹取；`Math.round` 前均有 `Number.isFinite` |
| H7 | **测试元审计**（恒真断言） | **不成立** | `ok(<expr>, true, ...)` 形式 0 处；本轮新加的守卫都已用**变异**验证真的会红（共 4 条，2/2 + 2/2 CAUGHT）。另：R16.13 的旧夹具在 #3 修复后确实**红了**（它编码的是旧语义）—— 这反过来证明它们是有效断言 |
| H8 | **资源无界增长** | **不成立** | `verifyBySid`/`sweeps`/`ratioHist`/`settleDrop`/`tierBySid`/`ownCompact`(修后) 全部有 `SET_CAP`/`SID_CAP` 上限；`history` 有 120 环形上限且淘汰策略优先砍 slim；`hud-acts` 有 `HUD_ACTS_CAP`；`.data/*.json` 都是小对象（settle 每会话 8 样本） |
| H9 | **自选**：落盘原子性（原假设单里没有） | **成立（即 #2）** | 见 §2 |

### 另外两条自选假设（H10/H11）
| # | 假设 | 结论 |
| --- | --- | --- |
| H10 | 「工具回 `ok` 但永不压缩」的静默失效 | **不成立（R50.1 已修）**：事实账本与 m3 各自独立 catch；m3 加载失败会让工具走 `state:'not-executed'` 回执并可被模型看出 |
| H11 | 面板/回执/报告三处对**同一个数**给出不同说法 | **不成立**：`settledRatio`/`occupancyActSuffix` 均为单源（m3 计算 → m2 回执 / m5 面板共用） |

---

## 6. 局限与未做的事

1. **自审盲区**：我没能发现的，多半是"我写它时就理解错"的那类——独立审计的价值正在这里。
   B 路那条 TDZ 就是例证：它在我反复读过的那段代码里，我从未触发该路径。
2. **没有跑真机故障注入**：`awaitRange→null`、`rename EBUSY` 这类路径只有单元/结构级证据。
3. **契约面只做抽查**：完整的逐包 diff 在 R48 做过，本轮没有重新全量跑（DSH 未升级，前提没变）。
4. **`test/report.mjs` 的 `readJsonRetry` 保留**：它现在只是防御性重试（原子写之后理论上不再需要），
   但删掉它没有收益、反而少了对抗未来回归的一道保险。
