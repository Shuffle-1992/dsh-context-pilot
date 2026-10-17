# R51 独立对抗审计 · B 路（qwen38flash 版）

- 审计对象：`dsh-context-pilot`（DSH 插件），仓库根 `F:\My Code\dsh-context-pilot`
- 审计身份：**外部对抗审计人**（非作者）。作者文档（README / milestones / docs/reviews）只作**线索**，一律不作证据；每条结论均追溯到 `plugin/**` 代码 + 官方 DSH 源码（`docs/reference/asar-out`、`docs/reference/*.js`）。
- DSH 版本：0.2.1-rc.2
- 日期：2026-10-17
- 硬约束遵守情况：仅写本报告文件；未改任何 `plugin/**`/`test/**`/`docs/**`（只读）；未跑改仓库的命令；未写任何 CLI 记忆库；未动 `~/.qoder*`。临时复现脚本写在系统 `%TEMP%`（仓库外）。

---

## 1. 结论摘要

**总体判断：插件核心链路（压缩触发 / 占用口径 / 契约对官方源码 / 数值夹取 / 状态初始化 / .data 有界）质量很高，未发现会误压或压垮会话的缺陷。但在 `host.impl.mjs` 与 `client.js` 里存在 3 处「自由标识符（used-but-not-declared）」缺陷，全部属于本项目最怕的「静默降级」类，且现有测试护栏对其结构性免疫（780/780 绿但缺陷仍在）。**

最严重三项：

1. **【F2｜高，已运行时复现】`host.impl.mjs` 卸载清理块引用未声明的 `pending`** —— cordis 真正卸载/热换时，disposer 第一行即 `ReferenceError: pending is not defined`，在清心跳之前就抛出 ⇒ 心跳 interval / timers / disposers 全泄漏。讽刺点：这正是该文件头注释（host.impl.mjs:496、515）声称「本次修复要根治的」那个泄漏——修复用 `return () => {...}` 把清理挪进 disposer，却在 disposer 里引用了 core 私有、且**未导出**的 `pending`，把泄漏又引了回来。
2. **【F1｜高，静态确证 + 同类运行时复现】`host.impl.mjs:317` 引用未解构的 `lastUserText`** —— 换档提醒（effort nudge）在 `effortEnabled=true` 时**永远不出现**（异常被 m2 的吞式 try/catch 咽掉，无留痕）。
3. **【M1｜高，审计结论】三条"专为抓这类缺陷而写"的护栏抓不到 F1/F2/F3** —— 契约 R14 解构对账方向反了、boot 冒烟不触发 dispose/nudge、autoClamp 断言只数 `if(!alive)` 出现次数而不验 `alive` 是否声明。⇒ 给出的是"虚假绿灯"。

其余：F3（`client.js` 自动钳制里 `alive` 未声明，写成功但读回校验永不执行 + 未处理 rejection）、F4（m3 缺席窗口的"未执行"自检回执写进了没人读的字段）。契约漂移基本不成立（逐项对上官方源码）；typert 通道因协议包未提取，判为**未能验证**。

---

## 2. Findings 表

| ID | 严重度 | 位置 | 触发条件 | 证据（可复现性） | 影响 | 最小修复建议 | 置信 |
|---|---|---|---|---|---|---|---|
| **F2** | 高 | `plugin/host.impl.mjs:520-521` | 插件被**真正卸载/停用**（toggle off、profile 切换、热换旧实例回收）时，cordis 调用 `ctx.effect` 返回的 disposer | **运行时复现**：以桩 ctx 真跑 `apply()`，捕获 `effect` 返回的卸载器并调用 → 抛 `ReferenceError: pending is not defined`（见 §5）。`pending` 在 host.impl 全文无声明（`grep -nw`），在 core 里是私有 `const pending = new Map()`（core.mjs:362）且**不在 core 出口**（core.mjs:819 附近无 `pending`） | disposer 在 :520 抛错，**永远走不到 :522** 的 `for (const d of disposers) d?.()` ⇒ 心跳 disposer（:503 入册）不被调用 ⇒ 心跳/定时器跨 toggle 泄漏（僵尸 interval） | 二选一：① host.impl 自持 `schedule` 用到的 timer 集合（core 已把 `schedule` 注入，但把在飞 timer 表也一并注入，如 `scheduleTimers`）；或②把清理块对 `pending` 的引用改成 core 注入的 `cancelAllScheduled()` 之类函数。**绝不在 host 裸引用 core 私有 `pending`** | 高（复现）|
| **F1** | 高 | `plugin/host.impl.mjs:317`（被 `plugin/m2.inject.mjs:513` 消费） | `effortEnabled=true`（默认 false）**且**该轮进入 nudge 判定（eff 有效 + 冷却外 + 命中信号） | **静态确证**：`lastUserText` 在 host.impl 仅 1 处代码出现（:317 的调用 `lastUserText(agent?.session)`），无任何声明；core **声明**(:594) 且 **导出**(:819) 了它，但 host 的解构清单（:38-44）**漏了** `lastUserText`。同类机制（自由标识符）已在 F2 运行时复现。m2.inject.mjs:513 用 `getLastUserText?.(agent)` 调它，异常被 :515 `catch { /* 提醒失败绝不影响注入 */ }` 吞掉 | 换档提醒文本**永不注入**（静默）：模型拿不到"该升/降档"提示，而 UI/回执仍显示智能思考已开 ⇒ 承诺与行为不符。**无崩溃**（被吞） | 把 `lastUserText` 加进 host.impl:38-44 的解构（core 已导出，零成本）；并建议 m2:515 的吞异常路径落一条 `state.m2.nudgeError` 痕（否则这类失效不可诊断）| 高（静态）/ 中（现场可达，需 effortEnabled+门槛）|
| **F3** | 中 | `plugin/client.js:340` 与 `:350` | 配置面板进入**自动钳制**分支：`ready && writable && engineCap!=null && 已存 criticalRatio > engineCap`（用户曾存高值、随后上限收紧，如 0.8→0.75） | **静态判定**：`alive` 仅在**别的** effect 闭包声明（client.js:304 的 pullCap、:713 的 EffortChip），autoClamp effect（:327-354）**无声明**；块内 `alive` 出现 3 次、声明 0 次（复现脚本 `clientFree` 输出）。因 client 是浏览器 React 半，本地 harness 跑不了 ⇒ 未做浏览器现场复现 | `writeField` 写成功后，:340 `if (!alive) return;` 抛 ReferenceError ⇒ 落进 :345 catch ⇒ :350 同一 `alive` **再次抛错** ⇒ async IIFE 未捕获 ⇒ **未处理 Promise rejection**；且 :341-342 的**读回校验永不执行**（钳制值已落盘但没有回读确认、没有成功/失败提示）。功能面：钳制仍生效，但面板静默无反馈 | 在 autoClamp effect 体内 `let alive = true;` 并 `return () => { alive = false; }`（与 pullCap effect 同款），或直接删掉这两处 `alive` 守卫 | 高（JS 作用域语义）/ 中（触发频度）|
| **F4** | 中 | 写：`plugin/host.impl.mjs:380`；读：`plugin/host.impl.mjs:311` + `plugin/m3.compact.mjs:307-311` | m3 域模块**尚未加载**（懒加载窗口/加载失败），但 m2 已加载、且工具已登记压缩意图（`peekIntent` 命中） | **静态判定（读写不同源）**：:380 把"未执行"回执写进 `state.m3.lastCompactVerify`（全局镜像）；但消费侧 `takeCompactVerify` 只读 `state.m3.verifyBySid[key]`（m3:310），而宿主包装 :311 在 `m3Ctl==null` 时**直接返回 null**（不读 `lastCompactVerify`）。⇒ m2.inject.mjs:297 拿 null ⇒ 无回执 | m3 缺席窗口里，模型调 `compact_context` 回了 `ok/scheduled`、实际没压，而**本应告知模型"未执行"的自检回执到不了模型**——恰是 R15 为堵"工具回 ok 却没压"专门加的能力，在目标场景失效 | :380 应写进与消费侧同一字段：改为写 `verifyBySid`（或让宿主 `takeCompactVerify` 在 `m3Ctl==null` 时回落读 `state.m3.lastCompactVerify`）| 中-高（读写路径可静态闭合验证）|

---

## 3. 逐条对抗性假设的判定

> 每条给出：判定（成立/不成立/未能验证）+ 我如何试图**证伪**它。

**假设①｜catch 块自抛：try 作用域内 const/let 被 catch 引用——还有残留吗？**
判定：**成立**。除历史已修的 R49.1（`sid` 挪出 try）与 R52（`official()` TDZ）外，我找到同类残留：F2（disposer 体内引用 core 私有 `pending`）、F3（**字面就是** catch 块自身 `if(!alive)` 引用作用域外的 `alive` 而自抛，且 catch 内二次抛未捕获）、F1（被调闭包体内引用未解构的 `lastUserText`）。证伪手段：对 host.impl 全文 `grep -nw pending` / `grep -n lastUserText` 找声明点（均无）+ 比对 :38-44 解构清单 + F2 运行时直接触发抛错。

**假设②｜静默降级：子系统坏了却报成功（懒加载窗口 / 所有 `setCompactVerify` 分支 / `preStepErrors`·`actErrors` 覆盖）**
判定：**成立**（两处）。F1（m2:515 吞异常不留痕，nudge 静默消失）与 F4（"未执行"回执写到没人读的字段 ⇒ 自检到不了模型）都是"坏了但看起来没事"。反向：`setCompactVerify` 的其余分支（m3:612/723/826）都写 `verifyBySid`，被 m2 正常消费；`preStepErrors`/`actErrors` 的常规留痕路径健全（boot ⑥ 会抓 logger.warn 里的"未定义/加载失败"）。证伪手段：逐分支核对写键 ↔ 读键是否同源；F4 的 :380 是**唯一**写到 `lastCompactVerify` 而消费侧不读该键的分支。

**假设③｜未防护的嵌套状态 `state.m2/m3/m5.*`（首启 / 热换 / 多会话）**
判定：**不成立**。core 在 `createCore` 里显式初始化 `listeners:{}`(494)、`m2:{...}`(495)、`m3:{...}`(498)、`m5:{...}`(553)；每次激活 core 为**新建**（entry 传 `core`），热换=新实例=新 state，不存在"半初始化"。易缺字段处一律 `state.m3.x = state.m3.x ?? {...}`（如 `verifyBySid ?? {}`、`ratioHist ?? {}`、`ownCompact`）后才写。证伪手段：搜 `state.m?.[某键] =` 是否有裸 `.内部对象` 直接下标；未发现未初始化即写入者。

**假设④｜异步竞态（`sweepInFlight` / `isCompactionInFlight` 时间窗 / `awaitRange`·懒加载窗口 / 同会话 pre-step vs idle / 多会话并发压缩）**
判定：**未能验证**（未构造出有害竞态，但确认若干竞态已被显式缓解）。R53 已把 `ownCompact` 由全局单槽改**按 sid 分槽**（m3:154-192，解决跨会话漏记/重复补记）；F5（意图"确能执行才消费"，m3:619）；R49.1（sid 移出 try）；R49（官方事务锁 `lockSkip` 在消费意图**之前**，:606）。这些都在代码里，且 boot 冒烟多会话桩未见抛错。我**没有**能证明仍存活的有害竞态现场，故诚实标"未能验证"而非"成立"。懒加载空窗本身真实存在（F1/F4 就落在这类窗口里），但属"降级/留痕"问题（归 ②），非数据竞争。

**假设⑤｜契约漂移：对官方源码核对 `sessionProjections.stateOf` / `compaction` / `llm.resolveModelInfo` / typert HUD 通道**
判定：**基本不成立（逐项 MATCHES）；typert 判 未能验证**。委托 Explore 对提取出的官方源码逐项核对（文件+行+引用见 §5 结论）：
- `compactIfNeeded(agent,trigger,signal)`（含 `"pressure"`/`"context-overflow"`，后者走 `selectCompactableRange(...,0)`）、`compactRegion(start,end,agent,signal)` 公有 4 参、`compactNow` 需 idle（非空闲抛 `ManualCompactionError("busy")`）——**MATCHES**；
- `validateSurfaceRegion` 抛错前缀 `compactRegion: `、末端不合法文案 `compactRegion: end seq N is not a balanced boundary...`——与 `compact-range.mjs` 的正则 **MATCHES**；`DEFAULT_RETAIN_RATIO=.16`、`systemHead` 用 `eventAt().type`、只导出 `BasicCompactionEngine`——**MATCHES**；
- `sessionProjections.stateOf(handle,key)` 与 `modelSelection`/`contextPressure`/`contextBreakdown` 三键、形状（`{lastUsed,pending}` 各 `{provider,model,reasoningEffort}`）——**MATCHES**；关键细节：`projectedTokens` **不在** state、只在 wire.view，插件**自算**（core.mjs:191-205 `projectedFromPressure`）⇒ 无漂移；
- `llm.resolveModelInfo(provider,model,signal)` 返 `{reasoning:{efforts:[{id}],defaultEffort}}`、可 await——**MATCHES**；`tokenMeter.measure` 返 `{nodes:[{seq,tokens}],surfaceTokens,totalTokens}`——**MATCHES**；
- `session.surface.nodes` / `eventAt(seq)` / `append(...)`——**MATCHES**；
- typert：`@deepseek-ai/dsh-typert-protocol/remote-methods` 描述符串与 face `dshContextPilot`/`getHud` **系插件自定义约定**，协议包**未提取** ⇒ 无法对官方源码核对，判 **未能验证**（内部自洽，`TypertRemoteService` 字段形状与 `typertRemote` 一致，但精确键不可证）。

**假设⑥｜数值/尺度边界（window=0 / 负 / NaN / provider 未报 / sampled=0；是否导致过压或"压=没压"）**
判定：**不成立**。占用判定路径有硬守卫：`measureRatio` 里 `ratio = window && used!=null ? used/window : null`（m3:118）——window 为 0/NaN/null 时 ratio=null；pre-step `if (!mr.ok || mr.ratio == null) return;`（m3:546）在**进入范围计算之前**就拦下 ⇒ 无 window 不可能喂进 `selectRange`，杜绝了"budget=0→保留≈1 节点→灾难性过压（历史上 1117→4）"。`resolveTier`/`retainBudgetTokens` 夹取 MIN 40k、MAX 50%（compact-range）；`retainFactor` 折夹 [1,2]、只减不增。sampled=0 只在自算口径里参与减法，非判定量。证伪手段：专门追"wanted=true 但 window=null"能否绕过守卫——结论是不能（:546 与 :543 abort 守卫在前）。

**假设⑦｜测试元审计：不可能失败的断言 / 只测桩不测接线的断言 / 变异清单**
判定：**成立**（这是本次最有价值的横向发现，记为 M1）。见 §2 与下方专段。核心：三处"本应抓自由标识符"的护栏，其断言**方向/口径**恰好抓不到 F1/F2/F3。

**假设⑧｜资源/边界：`.data/` 写入、按会话表上限、无界增长**
判定：**不成立**（有界）。所有按会话表均有上限并即时收敛：`TIER_SID_CAP=64`（compact-tool，pruneTiers）、`RATIO_HIST_CAP=12`+`RATIO_SID_CAP=64`（m3:125-144）、`verifyBySid`/`ownCompact` 到 `SET_CAP` 淘汰（m3:167/300）、`HUD_ACTS_CAP=50`（m5）、报告 `HISTORY_CAP=120` 且写盘前 `while(next.length>HISTORY_CAP)` trim（core.mjs:673）。落盘一律原子（tmp+rename，R53；m5/effort/compact-tool 各留一份）。观察（非缺陷）：本机 `m1-report.json` 已达 2.36MB，由 cap 有界但单条快照偏大；`.data/` 内还散落一批**手工调试**残留（`chain38fe.cjs`、`check-sessions.cjs`、`find-sid-*.cjs`、`r14-plan.md`、`r18-restrict.json` 115KB 等）——这些**非产品写入者**产生、且 `.data` 已 gitignore（`git check-ignore` 证实），不影响发布卫生（static.mjs §发布卫生禁把 `.data` 打进包）。

**假设⑨｜我自己补的两条（含动机 + 验证）**
- **⑨-A 系统性作用域漏洞（自由标识符）——成立**（即 F1/F2/F3 同根）。动机：本项目历史上反复栽在"名字对不上"（R49.1 sid-in-try、R52 official TDZ、R16 schedule 包裹、client PriceCalculator `engineCap` 崩卡——见 client.js:588-590 注释）。这三条是同一未闭合的类：**用了但没进作用域**。验证：`grep -nw`（声明点=0）+ 比对 :38-44 解构 + F2 运行时抛错 + `clientFree` 静态计数（3 用 0 声明）。
- **⑨-B "为防静默失败而造的自检"自身在目标失效场景不可达——成立**（即 F4）。动机：一个防护机制只在它要防的场景里失效，比没有防护更危险（给出虚假安全感）。验证：把 :380 的**写键**（`lastCompactVerify`）与 :311/m3:310 的**读键**（`verifyBySid`）逐字对账，确认在 `m3Ctl==null` 分支二者不相交。

**M1（测试元审计专段）** —— 为什么 780/780 全绿仍漏 F1/F2/F3：
- `test/contract.mjs:519`：`ok('R16.12 接线…', /getLastUserText: \(agent\) => lastUserText\(agent\?\.session\)/.test(host))`。它用**正则匹配那段有 bug 的源码文本**——不但抓不到"未解构"，反而**把 F1 的错误写法钉成了契约**（若作者去解构 `lastUserText` 并改写调用，此断言反而会红）。典型"只测文本、不测可达"。
- `test/contract.mjs:1570-1572`：`(autoClampBlock.match(/if \(!alive\) return;/g)??[]).length === 2`。它断言"`if(!alive)` 出现 2 次"（写入后 + 错误分支），验的是**守卫的存在**，从不验 `alive` **有没有被声明**。⇒ 对 F3 不可能失败。且其自身注释（:1567-1568）强调"必须计数、否则删一处仍通过"——计数做对了，但计数的是错误的东西。
- `test/contract.mjs:2220`（R14 解构对账）：断言是 `[...hostDestructured].every(n => coreExports.has(n))`，即"凡被解构的名字，core 必须导出"。它的**注释（:2206-2208）声称**这条能抓"忘了从 core 解构 ⇒ 调用即 ReferenceError"——**方向反了**：漏解构只会让该名字**不在** `hostDestructured` 里，`every` 对其**平凡为真** ⇒ 抓不到 F1/F2。真正能抓的是"解构了但 core 没导出"（如 loadReportBase 从 core 出口删掉）。缺的是**反向**对账："凡 host 里当作 core 助手续调用的自由名字，必须在解构清单中"。
- `test/boot.mjs` ⑥（:224-229）：只扫 `logger.warn` 文本里的 `is not defined/加载失败`。但：① boot 的桩 `effect:(setup)=>setup?.()` 跑了 setup、**从不调用返回的 disposer** ⇒ F2 所在清理块永不执行；② boot `config:{}` ⇒ `effortEnabled` 非真 ⇒ F1 的 nudge 分支不进（且即便进，m2:515 吞异常**不打日志**，⑥ 也看不见）。⇒ F1/F2 对 boot 结构性不可见。
- 变异清单：contract.mjs 自带多处"变异验证"痕迹（:314、:1155、:1190、:1365、:1516、:1815、:2524、:2792、:2820、:3112 等，注明"弱版断言曾逃逸"）。值得肯定的是它**持续在做变异加固**，但加固集中在**行为/口径**断言，**作用域/可达性**仍是盲区（boot 头注 :11-13 已自省"源断言无法证明接线可达"，却仍大量使用源断言去做作用域对账）。

---

## 4. 交叉验证（B 路专属）

**A 路报告（`docs/reviews/r51-independent-audit.md`）不存在**（实测 `ls docs/reviews/` 仅 `r51-audit-self.md`、`r51-brief-a.md`、`r51-brief-b.md`）⇒ **本次未能交叉验证**。

待 A 路生成后，我将按此逐条核验（供交叉验证阶段执行）：
1. 对 A 路每条 finding，要求给出 `文件:行` + 我可用同一命令复现的证据；我用本报告 §5 的复现脚本（尤其 F2 的 disposer 触发）判定 **同意/不同意/无法判定**。
2. 重点交叉点（两路独立最可能撞车的结论）：F2（`pending`）与 F1（`lastUserText`）是否被 A 路同样抓到、是否给出同源/异源修复。若 A 路未抓到 `pending`，用我的运行时复现反证其漏检。
3. 若 A 路报出我判"不成立"的项（尤其 ⑤ 契约漂移、⑥ 数值边界、③ 状态未初始化），我按官方源码逐字复核；能证其真则改判并注明是我漏检。
4. 若 A 路与我一致，合并严重度定级；分歧项挂"无法判定"并写清各自证据链，不强求折中。

**假阳性自查（我差点上报、但被证伪的候选）**：
- **`compactWithOwnRange` 在 window=null 时 budget=0 → 保留≈1 节点 → 过压**：证伪——pre-step 在调用它之前有 `mr.ratio==null` 守卫（m3:546），而 ratio=null ⟺ window 非真值，故拿不到 null window 进范围计算（见 §3-⑥）。
- **`effort.mjs` `saveStats` 在 `bySid`（const）声明行之前定义 ⇒ TDZ**：证伪——`saveStats` 是闭包捕获，仅在运行期（apply 完成、`bySid` 已初始化后）被调；闭包引用后续 const 不触发 TDZ，除非在声明前同步调用。未发现同步调用点。（与 R52 真 TDZ 的区别：那是在声明前**同步**执行了。）
- **`m1-report.json` 2.36MB ⇒ 无界增长**：证伪——写盘前 `while(next.length>HISTORY_CAP) trim`（core.mjs:673），条数有界；体积由条数×单条快照决定，非无界。
- **boot 桩 `get:()=>null` ⇒ measureRatio/criticalCapOf 抛错**：证伪——这些都有 `m3Ctl?…:{ok:false}` 降级；boot ⑥ 断言"无加载失败 warn"通过（实测 boot 21/21 绿）。

---

## 5. 实际执行过的命令 + 关键输出

```
node test/run.mjs   （只读；全绿）
  ✅ contract.mjs   628/628
  ✅ static.mjs      77/77
  ✅ report.mjs      54/54
  ✅ boot.mjs        21/21
  ✅ 全部 4 套件通过
  合计 780/780（注：任务书称"774"，本机实测 780——以实测为准）

# 运行时复现 F2（disposer 抛错）+ 静态计数 F3，脚本写在 %TEMP%（仓库外），报告指向不存在的 .data 文件（未落盘）：
  DISPOSE_THROWS = ReferenceError: pending is not defined
  alive@autoClampBlock = {"declaresAlive":false,"usesAlive":3}

# 自由标识符权威对账（grep）：
  host.impl 全文 lastUserText 代码点：仅 :317（调用）；声明：NONE
  host.impl 全文 pending 代码点：:520/:521（.values()/.clear()）；声明：NONE
  core.mjs：const lastUserText = (:594) 且已导出 (:819)   → F1 = host 漏解构
  core.mjs：const pending = new Map() (:362)，不在出口      → F2 = host 裸引 core 私有、core 未导出
  host.impl 解构 :38-44：含 projectedFromPressure/contextLedgerOf/loadReportBase…，**不含 lastUserText/pending**

# 读写不同源核对 F4（grep setCompactVerify|takeCompactVerify|verifyBySid|lastCompactVerify）：
  写 :380 = state.m3.lastCompactVerify（m3 缺席分支）
  读 m3 :310 = verifyBySid[key]；宿主 :311 = m3Ctl? takeCompactVerify : null
  → m3Ctl==null 时回执写入的键无人读（F4）

# m2 吞异常现场：plugin/m2.inject.mjs:513 调用 + :515 catch {}（无日志）
# client.js alive 声明点：仅 :304 / :713（别的 effect 闭包）；:340/:350 所在 autoClamp effect 无声明

# A 路存在性：ls docs/reviews/ → r51-audit-self.md / r51-brief-a.md / r51-brief-b.md（无 r51-independent-audit.md）

# 契约漂移（委托 Explore 对 docs/reference/asar-out 官方源码逐项核对，结论见 §3-⑤；两份 compaction-basic 副本 diff 一致）

# git 自检：见 §7
```

---

## 6. 未能验证清单（诚实）

1. **F1/F3 的现场复现**：`lastUserText` 抛错需 `effortEnabled=true` 且命中 nudge 门槛；`alive` 抛错在浏览器 React 半（`client.js`），本 node harness 无法驱动真实 UI/DOM。二者机制由同类（F2）运行时抛错 + 严格静态作用域分析确证，但**未**给出各自独立的现场触发复现。
2. **typert HUD 通道（⑤-5）**：`@deepseek-ai/dsh-typert-protocol` 协议包未提取到 `asar-out`，插件的 remote-methods 描述符串/face 命名**无法对官方源码**核验，仅确认内部自洽。
3. **F2 的"心跳泄漏"端到端后果**：抛错已复现（清理块确实在 :520 中断）；但"泄漏后僵尸 interval 实际造成多少次误触发"未做长时间观测（需真实 toggle 反复热换 + 观察 `schedule('heartbeat')` 计数）。
4. **多会话并发有害竞态（④）**：审查了缓解措施，但**未**构造出能复现的负向时序（漏记/双记/跨会话误压），故 ④ 判"未能验证"而非任何定性。
5. **`compactRegion` 边界回退（prevEnd/MAX_WALK_BACK）在真实尾部的收敛性**：正则与官方抛错串对上了，但未在真机会话里跑完一段回退序列验证最坏 walk-back 成本。
6. **报告口径 gapVsBreakdown 的绝对数值**：只作取证不参与判定，未逐条核对其与 provider 计费口径的一致性（超出本审计必要范围）。

---

## 7. 自证（仓库未被改动）

```
$ git status --porcelain
（空输出 ⇒ 无被跟踪文件改动）

$ git check-ignore plugin/.data/m1-report.json
plugin/.data/m1-report.json        （.data 为 gitignore 的运行数据，非我改动）
```

- 说明：本次仅**读取**了 `plugin/**`、`test/**`、`docs/**`；唯一**写入**是本报告文件 `docs/reviews/r51-independent-audit-qwen38flash.md`。
- 复现脚本写在系统 `%TEMP%\dcp-r51-repro.mjs`（仓库外），报告路径指向不存在的 `.data/__r51_nonexistent__.json`；实测该文件**未被创建**（`apply()` 同步返回、落盘 debounce 未及触发、心跳 `unref`），`git status` 亦佐证无残留。
- 注意（按任务书提示）：仓库配置了 git content filters，porcelain 为空**不绝对等价**于逐字节工作树干净；但它确证"无任何被跟踪内容被本次审计改写"。
