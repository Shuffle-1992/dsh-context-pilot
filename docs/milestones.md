# 里程碑档案（M1 → 现在）

> 从 README 拆出（2026-10-07）。README §3 保留**结论清单**，这里保存**完整过程**（含当时的术语、踩坑、实测数值）。
> ⚠️ 历史条目中的术语与字段名**保持原样不改写**（如「危险线」「决策卡」「policyCardMinRatio」），
> 它们记录了当时的真实状态；现行术语见 README §2.1。
> 文内 `§` 引用指向原 README 章节，拆分后对应：原 §2/§3 → [`api-notes.md`](api-notes.md)、
> 原 §4/§8/§9 → [`setup.md`](setup.md)、原 §7 → README §4 + [`cost-model.md`](cost-model.md)。

### M1 用量读取 + 激活验证
- 部署空插件（见 §8），确认激活日志可见；
- 解决关键未知：**如何拿到活动 Session 句柄**（`ctx.agents.list()`？`sessions`/`sessionQuery` 服务？——用 Inspect host Service 目录查 `sessions`/`sessionController`/`sessionQuery` 签名）；
- 对活动会话调 `tokenMeter.measure()`，把结果写日志验证。

**已实证（2026-10-05 编码时目录实证 + 2026-10-06 00:03 重启运行实测）：**
- 句柄双路径：`ctx.sessions.list(): Session[]`（内存会话 store）+ `ctx.agents.list(): Agent[]`。**实测 Agent 形状：`agent.id === agent.sessionId === session.id`，`agent.session` 持有 Session，`agent.status` idle⇄running**；`measure(agent.session)` 直接可用。
- 服务访问惯用法：`ctx.get('name')`；事件通道 `session/created`、`agent/status` 实测触发正常。
- **⚠️ 顶层 ctx 上 `compaction: absent`（实测）**——压缩服务确实按 agent 作用域隔离（§7.1 风险坐实），M3 必须解决作用域解析。
- **measure() 字段实况（修正探索报告）**：返回 `{ logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }`——`contextPressure/contextBreakdown` **不在 measure 结果上（为 null）**，拆分与压力经 `ctx.sessionProjections.stateOf(session, 'contextPressure' | 'contextBreakdown' | 'tokenUsage')` 读取；**`contextPressure.contextWindow` 直接给模型容量**（本机 1M 路由实测 1000000），M2/M3 分母首选此路径，`resolveModelInfo` 兜底。
- 读数实例：会话 total=117,991→118,073（本轮增长实时反映）；surface=101,303；nodes=131。
- M1 实现落点：`plugin/entry.mjs`（薄壳）+ `plugin/host.impl.mjs`（测量/监听/心跳/落盘 `.data/m1-report.json`，history 上限 120 条）。

### M2 每轮注入 —— ✅ 已实现上线（2026-10-06 00:10），待复述验证
- **实现路线改判**：探索报告原拟 `systemPrompt.variable()`，实际采用**官方 dsh-time-context 同款惯用法**（抽源码确认，asar 存档 `.data/asar-out2/`）：`agent/pre-step` waterfall → `await next()` 拿决策 → 追加一条 `createUserMessage({ content:[{type:'text',text}], source:{ kind:'context-pilot', form:'snapshot', sections:[{name,text}] } })`。该消息持久入日志、模型每轮可见（本项目 README 头部的 "Time sampled..." 块就是 time-context 注的，同一机制）。
- 注入门控：仅 `step === 1`（轮首一次，M2 语义）；异常/measure 失败/工厂未就绪一律放行原决策不注入（激活安全）。
- **官方包导入坑 P2**：第三方目录裸 import `@deepseek-ai/*` 必失败（无 @deepseek-ai 作用域可寻）；解法沿用 zcode-dispatch ZB-01：bare → env → `process.resourcesPath/app.asar` → 硬编码路径，×`import(pathToFileURL)`/`require` 候选链。**实测命中 `resourcesPath/app.asar|import`**。
- 文本形态：`Context usage before this turn (by context-pilot, estimate): window 1,000,000 ｜ used 169,892 (17.0%) ｜ surface 148,445 ｜ system ≈2,113 ｜ messages+tools ≈162,707 (heuristic).`
- **复述验证 ✅（2026-10-06 00:13）**：模型对注入三元组逐字复述，报告 `injections/lastText` 与会话内所见一致。
- **坑 P4（形状取证）**：`stateOf(session,'contextBreakdown')` 返回 `{ nodes: [{seq,heuristicTokens,system}…], breakdown: {systemTokens,messageTokens,toolsTokens} }`——聚合数在 `breakdown` 子对象，条目列表在 `nodes`（"三聚合数直读"不成立）。修复经一次 toggle 热换完成。
- 注入成本：每轮 ~50 token（持久入会话日志），M4 会加 config 开关与频率。

### M3 复杂度决策 + compactNow —— ✅ 实弹验证通过（2026-10-06 00:32），正常运行模式
- **v1 结论（inbox/inserted 方案被实测否决）**：消息进收件箱时 agent 已是 waking 状态，`compactNow` 抛 `ManualCompactionError("busy")`（报告 `actErrors.busy=2`）——"requires an idle agent with no waking queued work" 的语义比预想严格。
- **v2 设计（现行）**：挂 `agent/status` 翻到 **idle** 的瞬间（turn 刚结束、无排队工作）→ 纯比率决策 → `compactNow`（`agentPresets.serviceFor` 实例 + `AbortSignal.timeout(180s)` + `sourceCommandId='context-pilot'`）。语义转为"空闲扫除"：会话闲着且占用超线就腾空间，为下一个任务留最大余量。防重入：in-flight 集合 + 同会话 10min 最小间隔。
- inbox/inserted 降级为**纯审计**（decisions/wouldCompact/lastDecision），记录"该任务场景是否会想压"。
- **作用域解析已解（§7.1 关闭）**：`agent.ctx.get('compaction')` ✗ 不可达；**`agentPresets.serviceFor(agent, 'compaction')` ✓**（多次激活探针均命中）。
- 官方参照（compaction-basic 源码）：自动压缩走 pre-step `compactIfNeeded(agent, "pressure", signal)`（固定 80% 阈值，trigger 就是字符串）；手动 `compactNow` 首行 `signal.throwIfAborted()` 无守卫——**signal 必传**。
- 决策逻辑（启发式，M4 进 config）：`ratio ≥ 0.85` 无条件压；`ratio ≥ highRatio 且任务文本 ≤ 4000 字符` 压；高占用+重任务 → 保留全上下文不压（inbox 审计口径）。idle 扫除纯比率。
- 决策审计全落报告 `m3` 块：decisions / wouldCompact / acts / actOk / lastDecision / lastAct（shadowedNodes/shadowedTokens/range）/ actErrors / sweeps。
- **实弹结果（2026-10-06 00:32:47 触发，00:32:52 完成）**：turn 结束后 idle 翻转触发扫除 → 决策 `high-usage-light-task(21.0%, 2ch)` → `compactNow` 成功：**shadowedNodes 289 / shadowedTokens 181,327（seq 10–751）**，耗时 ~5s，`actErrors:{}`。下一条注入行 **used 195,622 (19.6%) → 31,352 (3.1%)**。实测保留语义比预估激进（近端保留不是 16 万整，实际总结后总占用仅 ~3.1 万）——符合"腾空间"目标，但 M4 起阈值按实测重校。验证后 highRatio 已回调 0.6 热换。
- 验证标准（全部达成）：报告 `m3.actOk ≥ 1` ✓ + `lastAct.shadowedNodes > 0` ✓ + 后续注入 used 明显回落 ✓。

### M3.5 三通道重构 —— 决策主体移交「模型语义判断 + 用户确认」（2026-10-06 00:50 上线）
- **动因（用户对照原始设想复盘）**：M3 的"占用驱动空闲扫除"只覆盖了时机（任务前），缺三块——①场景1"任务与远端关联小"是**语义判断**，字数启发式够不着；②场景2"重任务提前腾退"与 M3 原逻辑（重任务→不压）方向相反；③注入没告诉 agent 有压缩选项，agent 无从参与。
- **官方源码新证据**（`docs/reference/@deepseek-ai/dsh-compaction-basic/lib/index.js`，本仓库已提取）：
  - `compactIfNeeded(agent,"pressure",signal)` 就是官方 pre-step 自动压缩的原话调用（阈值走引擎自身 config，默认 80%，与本插件阈值无关）；
  - **`"context-overflow"` 触发绕过引擎阈值**：`selectCompactableRange(session, measure, 0)` → `compactRegion(..., owner:"current-turn")`，任意占用都能立即压——这是关键词通道低于 80% 仍能生效的合法路径；
  - `compactNow` 必须 idle（`runMaintenance` 包装），轮内不可用 → 只归 idle 安全网。
- **通道1（执行）pre-step 轮内先压**：在注入监听器内、`await next()` **之前**执行（先压再组消息 → 本步请求即用新表面）：
  - `ratio ≥ 0.85` → `compactIfNeeded(agent,"pressure",signal)`（必然越过引擎 80% 阈值而生效；引擎已压则返回 null，幂等）；
  - inbox 检测到消息以「**先压缩**」开头 → 置 `keywordArmed`（TTL 120s）→ pre-step 消费 → `compactIfNeeded(agent,"context-overflow",signal)`（占用 ≥0.2 才执行，否则纯浪费）。
- **通道2（告知）政策卡**：注入行占用 ≥30% 时追加 ~100 token 政策文——教会模型场景1（关联小→建议压缩）、场景2（重任务→建议腾退）、场景4（模型可预判任务体量）与否定场景（依赖远端细节→不建议），以及触发短语「先压缩」。模型建议 → 用户一个词确认 → 通道1 执行，闭环成立。
- **通道3（兜底）idle 扫除降级**：仅 `ratio ≥ 0.85` 才 `compactNow`（防 runaway），不再按 highRatio 主动清场（那是无任务语义的盲压，与"任务摄入时决策"相悖）。
- **保留启示（实测修正认知）**：pressure 路径 retain = messageBudget × retainRatio ≈ 16 万近端保留，压缩对"接下来要干的活"几乎无损；真正代价只是一次摘要调用（实测 ~5s）。故高占用下"先压"几乎总是划算，分歧只在"任务要不要远端细节"——恰是模型能判断而启发式不能的。
- **报告新字段**：`m3.preStepActs / preStepOk / lastPreStep{trigger,ratio,acted,shadowedTokens,range,ms} / preStepErrors / keywordHits / policyCards`。
- **待实弹验收**：① 占用 ≥30% 时注入行出现政策卡且模型正确解读（建议或不建议）；② 用户消息「先压缩 …」→ 报告 `lastPreStep.trigger='overflow'`、`acted:true`，本轮回复照常且注入行 used 回落；③ critical 兜底可在占用 ≥85% 的会话上观察。

### M3.6 标记闭环 —— 模型建议、零输入自动执行（2026-10-06 01:03 上线）
- **用户提案**："模型建议压缩时在回复尾部写 `[cp:compact]`，后台完成后重新拉起会话触发压缩"。落地时简化：**无需结束/拉起会话**——回复结束瞬间 agent 自动翻 idle（M3 实弹已证即 `compactNow` 合法窗口），全事件驱动、零定时器。
- **事件链**：模型回复尾行 `[cp:compact]` → `ctx.on("session/event")`（`event.type==='assistant/message'`，compaction-basic 官方同款通道）解析武装 `markerArmed`（TTL 120s）→ `agent/status→idle` → 扫除器 **marker 模式**：`ratio ≥ 0.2` 即 `compactNow`，不受 critical 限制、不受 10min 冷却（显式请求不设防）。
- **竞态处理**：assistant/message 事件可能晚于 status→idle——武装时查 `agents.list()` 内该会话 agent 的 `status`，已 idle 则立即触发扫除。
- **政策卡同步改写**：模型被教导"值得压缩时在回复最后单独写 `[cp:compact]`"（主通道，用户零操作）+「先压缩」关键词（本任务执行前就要压缩时的快速路径）。
- **报告字段**：`m3.markerHits`；`lastAct.reason='marker'|'safety-net'` 区分两模式。
- **透明性**：标记写在回复正文里，用户看得见（相当于模型"公开提案"）；不想要可等 M4 把 `marker` 配成空串关闭。
- **实弹通过（2026-10-06 02:18:39，本插件模型自己按政策卡写标记触发）**：22.8%（used 227,659）回复自检（关键产物已落盘 README+报告）后尾行写 `[cp:compact]` → idle 翻转 → marker 扫除 → `lastAct{at:02:18:39, reason:'marker', shadowedNodes:471, shadowedTokens:181,485, range:seq 761–1952}`，官方引擎事件 `compaction/start→summary→end` 各 1 次全见，`acts:1 actOk:1 actErrors:{}`。占用轨迹 **227,659 (22.8%) → 52,205 (5.2%，摘要落定中) → 17,214 (1.7%)**；最终 measure：totalTokens 17,356 / nodeCount 10（压缩前 ~480 节点）。
- **用户疑问裁决（2026-10-06 02:2x）：「是不是要结束会话→重新拉起→拉起前压缩？」——不需要，实测证伪**。压缩前后 session id 同为 `session-16616c07…`（同一 Session 对象存活，无 `session/created`），插件宿主计数（markerHits/acts）跨事件连续（DSH 与插件宿主均未重启）。观察到的「结束/重新拉起」是两层渲染假象：① harness 对长对话自身的 checkpoint 摘要块（模型上下文管理，与本插件无关）；② 压缩后客户端把折叠上下文重新呈现。底层机制 = **存活会话内就地影子化 + 摘要**。时序上用户的直觉「拉起前已压完」成立：02:18:39 压完，02:20 用户下一条消息看到的已是压后读数。原方案（挂定时器+结束会话+重拉）也能通（武装态在插件宿主内存，比会话活得久），但纯多余且有真实代价：120s TTL 可能在拆/拉间隙过期、用户可见中断；idle 本身就是免费压缩窗口。

### M4 自身 Config 面 —— ✅ 编码完成 + 加载验证，配置卡片待重启验证（2026-10-06 01:3x）
- **三件套**：`plugin-config.schema.mjs`（schemastery 四级候选链，独立解析 OK）+ entry 静态 `export Config`（薄壳备案例外）+ impl `M3_DEFAULTS` 与 apply 内 config 字段级类型守卫合并（报告 `m3.eff` 落生效值）。
- **重启后验证（2026-10-06 01:21）**：`include:dsh-context-pilot` `fiberPhase:"active"`（JSON 字面量死法未发生）；报告 `m3.eff` 十字段=默认值，config 布线正确。
- **坑（实测）**：详情页配置区**不是 schema 自动出现的**——它是 client 半段注册的 `plugins.bundle.config` 插槽卡片（用户截图对照 browser-kit/zcode 后定位）。M4.5 补 client 半段 `client.js`（照抄 dsh-connect-zcode 实证结构）：ModuleLoader 信封 + `require("react")` + configForms 软探测命名空间重绑定（**inject 必须含 remote**，否则 configForms 恒 undefined、面板永久只读——zcode :459 血泪）+ 写后回读校验 + 主题 token 用 dsw-alias 真名（回退值主题无关）。package.json 加 `./client` 导出 + `dsh.client.inject` 七件套。**待重启**：卡片渲染 + 改 `policyCardMinRatio`→0.05 → 报告 `m3.eff` 随变。
- **坑 2（实测，2026-10-06 01:4x）**：schemastery 在插件宿主内解析失败（我的候选链只有 `import()`，asar 内嵌模块 ESM import 会失败；zcode 链有 `require(esm)` 兜底）→ Config=undefined → provider `absent` → **卡片注册成功但页面无落点**（一切正常唯独不出现的真凶）。修复 = **vendor**：schemastery+cosmokit 复制进 `plugin/node_modules`（裸导入从导入文件向上走 node_modules 必命中，不赌宿主魔法）；探针 `m3.m4Probe` 宿主内验证已绿。
- **坑 3（预防，zcode 实测移植）**：面板写入字段必须 `.volatile()`（DSH 写入门禁：条目无 volatile 字段 → 每次保存静默拒绝且 set() 照样 resolve）；host 端读 config 必须剥 `{get()}` 活引用，否则类型守卫跳过 → 面板改值 host 永远用默认。
- **M4.6 上下文弹窗总开关（2026-10-06 01:5x，用户需求）**："在上下文弹窗加开关，开=插件功能，关=恢复原生 DSH"。两半实现：① host `effEnabled()` 活读 volatile 活引用——注入/审计/pre-step/idle 四路全部即时受控（此前注入不看开关，已补）；② client `installPopupToggle()`——MutationObserver 找「上下文已用」文本叶 → 沿纯包裹祖先爬到浮层根 → 插入开关行，写 `settingsScope.set('enabled')` + 回读校验，P37 纪律（新 apply 断旧观察器）。妥协声明：弹窗是宿主内部组件无官方插槽，DOM 注入 DSH 升级可能失效（失效=开关不见，其他功能不受影响）。**状态（2026-10-06 02:1x）：v1（浅层 div/span 扫描）与 v2（文本节点 TreeWalker + open shadow root 穿透）均未命中——弹窗疑似在更深的 shadow 层或非 light 文本。诊断版已部署（2026-10-06 10:0x，仅刷新生效）：`attachShadow` 陷阱登记 closed root（`window.__DSH_CONTEXT_PILOT_CLOSED_ROOTS__`）+ `elementFromPoint` 指针采样（悬停即抓弹窗组合树 DOM 链，穿透 closed shadow）+ 宽松文本候选扫描；诊断出口为控制台 `__DSH_CONTEXT_PILOT_POPUP_DEBUG__.dump()`（client 侧无法写 host 报告，走控制台导出；定位成功后拆陷阱）。10:1x asar 全量探针取证命中：弹窗 = `dsh-client-ui-conversation` ContextMeter 面板——`createPortal(…, document.body)` 挂 body 直下、`role="dialog"`、`aria-label=context.used`（zh「上下文已用」/ en "of context used"；触发器 `button[aria-label="上下文已用 {percent}"]` 带百分号可区分）；**桌面壳有 DevTools：F12 → `openDevTools({mode:"detach"})`**（lib/main.js @377763 输入拦截 + @470873 菜单 accelerator，"没有浏览器控制台"问题解除）。定位器 v3 = aria 属性选择器 + 同源 iframe 兜底 + 1.2s 轮询防时序脱靶。10:2x **v3 验收通过**（用户截图：弹窗底部出现开关行）；v1/v2 未命中根因未单独归位（疑似旧 client 未随刷新生效/文本扫描脆弱），v3 属性定位 + 轮询双保险后稳定。按用户要求改名「上下文领航（注入+压缩）」并把勾选框换成滑动 switch（原生 checkbox 隐入底层保点击/键盘可达，dsw 主题 token 自适应深浅色）。诊断陷阱（attachShadow 补丁/指针采样/dump 户籍册）已拆除，client.js 回归干净版。其余 M4 链路已全通：面板渲染 ✓ / policyCardMinRatio 0.1 保存并 host 生效 ✓ / 决策卡 v2 文案在场 ✓。**M4.6 关闭 → M4 全部收官。**
- **M4.6 微调（2026-10-06 10:4x，用户反馈）**：① 开关行去掉写死的 `font-size:12px` 改继承弹窗面板字号（`.panel` 本身就是 12px）；② **左对齐最终方案（用户拍板：加图标对齐「对话消息」）**：结构复刻原生明细行——行 = `[8px 图标 + 6px 间距] + 文字`，行 `padding-left:0`（行左缘即面板色块列起点）→ 图标列对齐色块列、文字列对齐 dt 文字列，**零测量天然同轴**（此前 Range 校准两版都败在参照系：行在面板 content box 内自带 12px，以面板边界为原点恒多 12px，已弃）；图标 8×8 圆角 2px，填开关同款品牌蓝 `#4c7dff`；③ 开关配色改双主题自适应——`isDarkBg()` 沿面板祖先找第一个不透明背景按亮度判暗/亮（兜底 body 文字色反推）：开=品牌蓝 `#4c7dff`（两主题通用），关=轨道/旋钮按明暗反色（暗主题 `rgba(255,255,255,.22)`+浅灰旋钮 / 亮主题 `rgba(0,0,0,.24)`+白旋钮）。注：portal 面板挂 body 直下，`--dsw-alias-*` 变量不一定可达，故用字面量+探测而非 token。

### M5 弹窗 HUD —— ✅ 编码完成，待重启验证（2026-10-06 11:0x，用户定址：「上下文领航」下面）
- **形态改判（用户拍板）**：不做独立浮层，直接在上下文弹窗的开关行下面加一行 HUD——复用 M4.6 注入点，零新插槽。
- **host→client 状态通道（核心）**：`configEditor` 服务（Inspect Service 目录取证：`entries()/configuration()/edit(entry, change)`，自述 "Persist complete raw configs and apply them through the normal Loader path"）——host 在压缩/武装事件时 `edit()` 写两个 volatile 字段：`hudLastAct`（"HH:MM · 标记/兜底/危险线 · 省 xxK"）、`hudArmed`（"armed"/""）。与面板保存同款路径（实测不重跑 apply、client 配置镜像活更新）；**且 configEditor 持久化 → 重启后上次记录仍在，白赚跨重启显示**。
- **写点（全事件驱动，无轮询）**：idle 扫除成功（写 hudLastAct + 熄武装灯）、pre-step 危险线先压成功（同）、标记武装（亮灯）、武装 TTL 过期随扫除清灯。发布器 `publishHud`：首次 `entries()` 按 JSON 含 "context-pilot" 匹配缓存 Entry，in-flight 合并排队，写失败只留痕绝不碍主流程。
- **client 渲染**：HUD 行（padding-left 26px 文字轴同轴）：左「最近压缩 …」/「本会话暂无压缩记录」，右 chips「武装中」（品牌蓝描边）/「演习」（灰）；settingsScope.subscribe 活更新。
- **待验证**：重启 DSH（schema 新增字段，Config 静态导入必须重启）→ 弹窗出现 HUD 行；下次压缩后字段实时更新；报告留 `M5 HUD 已发布` 日志线。

### M5 HUD 通道改判 —— configEditor 推送判死 → 内存 + client 轮询 getHud（2026-10-06 12:0x–12:2x）
- **三层排查实证**：① `entry-not-found` 根因 = 纯 `JSON.stringify(e)` 匹配——entry 携带 schemastery schema（循环引用）stringify 抛错→所有条目一律 miss；改 id/patchId/name 字段匹配后直达 `editor.edit()`。② 随即 `HMR transactions cannot be nested`：2.5s→30s→60s→120s 退避全被拒（**激活后 3 分半仍未关**）⇒ 非暂态窗口，是**结构性拒绝**——插件上下文的 service 调用被包在 apply/HMR scope 里；面板保存能成（patch.yml 11:55:47 落账）恰因 client→remote 不经该 scope。③ 结论：**host→configEditor 推送通道判死**。
- **新通道**（browser-kit/zcode 同款已验证形态）：新增 `wire.host.mjs`（exports["./typert"]，face=`dshContextPilot`，方法 `getHud()`）+ host `ctx.provide` 注册（报告 `m5.hudFace='provided'` 实证）+ client `$mount(REMOTE_CONTRIBUTION)`/`ctx.inject(['remote.dshContextPilot'])` 捕获句柄 → **HUD 行每 5s 轮询**；host `publishHud` 改写内存 `state.m5.hud`（原 5 个调用点不变）；跨重启显示由启动回填（读报告最近 m3-act，激活 +1.2s）补齐——回填已实证（`11:57 · 标记 · 省 112.3K`）。
- **Client 半需页面刷新生效**（client.js 无 dev watcher 不热换）；configEditor 字段（hudLastAct 等）留作面板可见兜底，不再依赖。
- **HUD v2：按会话过滤 + 最近多条（2026-10-06 13:2x，用户点名两升一级）**：getHud 加可选参 `sid`（wire 方法表/TYPERT/client 描述符三端同步，可选项 acceptsUndefined）；host `state.m5.acts`（新→旧 cap 8，{sid,text,at}）——动作时 `recordHudAct(sid,text)`（marker/pressure 两发布点）、启动回填从报告 m3-act 重建最近 5 条（含 sessionId）；getHud(sid) 返回该会话 `hudLastAct`（最新）+ `acts`（最多 5 条）。client 捕获会话 id：钩 `window.fetch` 抓任意 API URL 的 `sessionId=`（+resource timing 一次性补捞），存 `window.__DSH_CONTEXT_PILOT_SID__`，会话切换 5s 内跟随；弹窗主行=本会话最新，悬停=本会话列表+gen/sid 指纹；带参被拒自动退回无参全局查询（协议未热载时优雅降级）。**部署注意：wire.host.mjs 无 query 不热换 + typert 注册驻留 ⇒ 本轮协议变更需重启一次 DSH**（重启前刷新=旧行为，不炸）。
- **首测空态根因（12:3x–13:0x，重启+刷新后弹窗仍「暂无压缩记录」）**：三连环，逐一实证——① client `ctx.inject` 回调**参数签名错**：参数是 scope，服务在 `scope.remote.dshContextPilot`（browser-kit client.js:579 同款）；旧码把 scope 当服务存 ⇒ `getHud` 非函数 ⇒ pullHud 每 5s 静默 return。② **inject 声明缺 `typert`**（console 实锤：`$mount 失败: cannot get property "typert" without inject`）——browser-kit client.js:504 注释明写「typert 是 $mount 的硬依赖」，其声明 `['slots','remote','typert']`。③ **remote 代理 {ok,value} 信封未拆**（gen 指纹排除僵尸面后定位）：face 代理把返回值包成 `{ok,value}`，`r.ok` 恒 true（信封层）、`r.hudLastAct` 恒 undefined ⇒ 永远空态；browser-kit client.js:2098 注释原话「face 代理返回 {ok,value} 信封——必须 unwrap（漏了 = 永远显示「—」，实测踩坑）」——P29 对账教训延伸：**两端清单要连消费端一起对**。已修：unwrapEnv 拆包（兼容无信封直连）。宿主全程无辜（报告/面状态始终满值）。附带强化：HUD 启动回填改「激活同步立即一次 + 1.2s/4s/10s 幂等重试」消激活空窗；state.m5.hud 加 gen 实例指纹（client debug/悬停可验 face 归属）。

### M2.5 新会话 Agent 自说明 —— 一次性插件说明注入（2026-10-06 12:2x）
- **需求**（用户）：插件压缩流程/用法要让**新会话的 Agent 完全明白**并在实际使用中会用，不依赖外部文档。机制：`briefedBySid`（每激活每会话一次）——`agent/pre-step` 注入时，该会话首次注入额外追加 `M2_BRIEF` 段（~200 字）：说明 Context usage 行、决策卡触发、「待执行：<任务>」+ 尾行标记协议、自动压缩+自动拉起（`(context-pilot 自动恢复)` 开头）、85% 危险线、勿连续写标记。落账 `m2.briefings`。
- **Agent 可见的三层提示词**：① 每轮 usage 行（测量）；② 占用≥阈值决策卡（行动指令，v3 全本）；③ 新会话一次性 M2_BRIEF（插件自说明）；④ 恢复轮开头 `(context-pilot 自动恢复)` 提示（续任务指令）。四层覆盖「测量→建议→教学→续跑」。

### M5.5 任务挂起-自动恢复 —— 首测：压缩环 ✅ / 恢复环 ❌ 静默黑洞 → 已改多通道+全程取证（2026-10-06 11:5x）
- **用户定义的目标流程**：任务进来 → 条件满足时模型分析后本轮**先不执行** → 回复中写「待执行：<任务>」+ 尾行标记 → 结束回复 → idle 自动压缩 → **系统自动拉起新一轮（压缩后的干净上下文）→ 继续执行原任务**，用户零重发。
- **首测 E2E（2026-10-06 11:33–11:38）**：标记捕获 ✓（`marker=1`，待执行行同源捕获）→ 插件压缩 ✓（`lastAct.reason='marker'`，shadow 303 节点 / 213,476 tok，used 263,713→52,582，报告 `m3-act` 实证）→ **恢复环无任何动作**（用户观察「没有拉起新会话」）。铁证：代码里 `prompt()` 无论成功/被拒都会排 `m5.5-resume` 报告条目——**一条都没有** ⇒ 执行流在调用前静默退出，且旧版所有退出路径只写 `ctx.logger`（宿主日志无处可查）= log-only 黑洞。
- **根因排查（11:4x）**：`sessionController` 服务从插件 ctx 实测**可达**（快照 `services.sessionController: "object"`，Inspect 目录同证：`@Remote('prompt') prompt(SessionPromptRequest)`，服务名确为 `sessionController`）⇒ 剩余嫌疑收敛为「`ctrl.prompt` 属性访问/调用在包装对象上抛错或非函数」（旧代码该分支 log-only 不落报告）。官方实现取证（asar 提取 `dsh-api-session-controller`）：`prompt()` = 校验 → `createUserMessage({content, source:{kind:'user',rpcId,clientTimeZone}})` → `agent.followup(message)`（queue 模式）→ `{accepted:true}`；`followup` = `send(input,"next-turn",true)`（agent-loop 实证）。
- **修复（11:5x，已热换部署）**：① **多通道恢复** `resumeViaAnyChannel`——A `sessionController.prompt`（请求体 `mode:'queue'` + `{type:'text',text}` content，契约以 asar 为准不再猜）→ B `ctx.remote.session.prompt` 代理 → C **直通入队**（与官方同原语：`createUserMessage` + `agent.followup`，M2 已实证工厂可用；投递后 `inbox.nextTurn.some(rpcId)` 确认）；② **全程落报告**：`state.m55 = {armed（捕获详情）, attempts[]（每通道每相位）, channelProbe（ctor/ownKeys/protoKeys/toStringTag/promptAccessError）}`，`Promise.resolve().then()` 包裹使同步抛错走 rejection，setTimeout 回调兜底；③ 服务可达性清单加 `sessionController/typertGateway`；④ `publishHud` 同步留痕 `state.m5.lastPublish`（11:33/11:35 两次 HUD 发布 cordis mtime 未动 = 也在静默失败，entry-not-found/edit-rejected 从此可辨）。
- **首测占用背景**：压缩由插件 marker 通道执行（非 harness 检查点），harness 侧另有独立上下文检查点机制，二者勿混。防循环：`resumeCountBySid` 上限 2 次；HUD：挂起亮琥珀「待执行」徽章，投递后熄灭。

### M5.5 二测 ✅ 闭环全通 —— 通道 C（direct-followup）投递（2026-10-06 11:56–11:58）
- **E2E 全链**（`markerMinRatio` 临时降到 0.1）：11:56:32 `m3.6-marker` 武装（`via='reply-defer-line'`，待执行 146 字符完整捕获）→ 11:57:19.7 `m3-act` 压缩（used 139,856→**30,231**，节点 132→3）→ 11:57:21.2 2s 后三通道依次尝试 → 11:57:21.8 agent running、`m2-inject` 第二轮注入 → 模型零重发继续执行原任务。**用户观察与报告取证一致。**
- **通道裁定**（`state.m55.attempts` + `channelProbe`）：A `sessionController.prompt` **rejected**——`Cannot read properties of undefined (reading 'throwIfAborted')`，即官方 `prompt(request, signal)` 第二参不可缺省，请求体没带 AbortSignal（可修：补 `AbortSignal` 或改走 remote 方法）；B `ctx.remote` 探针 `cannot get property "remote" without inject`——插件 ctx 无 inject 权限，不可用；**C `direct-followup` delivered**（`createUserMessage`+`agent.followup`，与官方 prompt 同原语），agentProbe `{status:'idle', hasFollowup:true}`，4ms 内接跑。channelProbe 实证 `SessionController` 形状（ctor/ownKeys/protoKeys 含 `prompt`）与 asar 取证吻合。
- **占用对照**：二轮 used 30,231（3.0%）/ surface 5,249 / nodes 6 vs 一轮基线 138,868（13.9%）/ 114,215 / 129 ⇒ 省 ~108.6k tok（-78%）。
- **遗留**：① ~~HUD 发布仍 `entry-not-found`~~ **已终判+换通道**（见 §6「M5 HUD 通道改判」：configEditor 判死，内存+轮询已上线）；② 通道 A 补 signal 后可作首选通道（当前 C 已可靠，优先级低）；③ **面板「标记最低占用」需改回 0.2**（现为 0.1，仅为二测放宽）。

### M5.5 三测 ✅ 复现稳定 + HUD 记录链实证（2026-10-06 12:24–12:26）
- **E2E 全链**（HUD 通道改判 + M2.5 自说明上线后首测）：12:24:33 决策卡+一次性插件说明注入（`m2.briefings=1`）→ 12:24:46 `reply-defer-line` 武装（待执行 174 字符）→ 12:26:10.9 `m3-act` 压缩（reason=`marker`，shadow **196 节点 / 91,543 tok**）→ 12:26:12.9 三通道：A `sessionController.prompt` rejected（同款 `throwIfAborted`，符合预期）→ **C `direct-followup` delivered**（4ms，agentProbe `{status:'idle', hasFollowup:true, hasSteer:true}`）→ 12:26:13 `m2-inject` 第二轮（仅用量行，说明不重复 ✓）→ 模型零重发续跑。**二连通过，通道 C 复现稳定。**
- **占用对照**：基线 used **125,656（12.6%）** / surface 93,433 → 压缩后 **37,951（3.8%）** / surface 5,262 / nodes 3 ⇒ **省 87.7k tok（-70%）**（HUD 省 91.5K = shadowedTokens 口径，实际净省含压缩摘要+恢复消息开销）。
- **HUD 记录链（本轮新证）**：压缩即时发布 `lastPublish={step:'ok', channel:'memory'}`，`hudLastAct='12:26 · 标记 · 省 91.5K'`，armed/pending 徽章正确清空，`hudFace='provided'`——内存发布+5s 轮询+重启回填三层全实证；弹窗侧待用户刷新页面后目视确认。
- **M2.5 复核**：injections 2 / briefings 1——首轮带说明、恢复轮只带用量行，会话内恰好一次 ✓；dump 脚本被清理后已重建 `.data/dump-m55-fields.cjs`。
- **HUD v2 实证（13:3x，用户截图）**：主行「最近压缩 12:26 · 标记 · 省 91.5K」✓、悬停列表+指纹（gen=新实例 muw8q34m、sid=本会话前 13 位）✓、会话过滤 ✓、信封拆包 ✓。悬停仅 1 条 = 报告 120 条环形缓冲已剪掉 11:33/11:57 的 m3-act（预期；可选 hud-acts.json 持久化未排期）。
- **遗留清账**：~~markerMinRatio 改回 0.2~~ → **用户 13:3x 面板改为 0.15，后续按 0.15 走**；通道 A AbortSignal 补参（低优先）。

### 只读审查（review-findings.md，23 条）—— ✅ 批次 1/2/3 全部落地（2026-10-06 14:1x–14:3x，单次 toggle 热换）
- **依据**：`review-brief.md`（任务书 + §2 铁约束）→ `review-findings.md`（外部审查员，23 条：A7 / B6 / C6 / D3 + C1 附注）。全条已对照 §4 已知档案去重（无重复项）。
- **部署**：host.impl.mjs 21 处 + client.js 10 处，改完 `node --check` 双通过 → 单次 `set_plugin include:dsh-context-pilot` false→true 热换（entry/wire/protocol 未动，无需重启 DSH）；client.js 侧待用户刷新页面生效。
- **批次 1（机械执行，零行为变更）**：
  - **B3** 死代码退役：`publishHud` 的 `_hudRetry` 过滤删（configEditor 通道残留）、`state.m3.keywordHits` 恒 0 字段删、`state.m3.dryRun` 静态镜像删（双轨失真，真值看 `m3.eff.dryRun`）、`pendingBySid.resumes` 写入删（从未读取）。**报告形状变化**：新条目不含 `m3.keywordHits`/`m3.dryRun`（历史条目原样保留，dump 脚本不受影响）。
  - **B1** `hudActText` → `formatAct(reason, tokens, at?)`：运行期（at 缺省=现在）与启动回填（at=记录时刻）共用一套「hh:mm · 原因 · 省 xK」模板，消除两处手写同构。
  - **B2** 抽 `measureRatio(session) → {ok,used,surface,window,ratio}`：`decideCompaction`/`renderUsageText`/`preStepCompaction` 三处重复的 measure+pressure+ratio 计算收敛到一处。
  - **A4** 事件武装门 `!M3.enabled` → `effEnabled()` 活读（与 pre-step/idleSweep 口径一致，堵住「开关刚关事件仍武装亮灯」窗口）。
  - **A3** `M2_BRIEF` 冻结常量 → `renderBrief()` 函数：每次注入现拼 `M3.marker` 与 `criticalRatio`（原实现写死初始 marker 与「85%」，config 热改后说明文本与活值检测自相矛盾）。
  - **A7** 2s 恢复 `setTimeout` 入 `resumeTimers` 表，随 `ctx.effect` 卸载清理（防禁用/热换窗口内旧实例仍向 agent 投递恢复消息）。
- **批次 2（行为修正，报告/日志可证）**：
  - **A1** 心跳 disposer 修复（`host.impl.mjs` 原 `if (typeof h === 'function')` 只收 cordis disposer；`setInterval` 分支返回 Timeout 对象被漏 ⇒ 热换后旧实例心跳永生、与新实例交错写报告）→ 改 `else if (h && typeof h.unref === 'function') disposers.push(() => clearInterval(h))`。**该项在实施中扩展为三层根因（见下「追加发现」）**。
  - **A2** ① TTL 清灯前移到 `sweepInFlight`/measure 早退之前（原顺序：早退 ⇒ 过期 armed 与 hudArmed 灯不熄）；② **压缩失败重武装**：`reason==='marker'` 且仍在原 TTL 窗口内 → `markerArmed.set(sid,{at:armedAt})` + `hudArmed='armed'` + `m55Attempt{phase:'act-failed-rearm'}`，下次 idle 自动重试（原实现 catch 直吞，armed 已消费 ⇒ 挂起任务无人恢复、徽章永亮）。
  - **A5** pre-step signal 缺失守卫：`signal ?? AbortSignal.timeout(180_000)` 兜底 + `sig.aborted` 早退（官方契约 `compactIfNeeded(agent,trigger,signal)` 首行 `throwIfAborted`，undefined 放行=首跑即败；M5.5 通道 A 同款已实证）。**该项待 pre-step critical 实弹 E2E。**
  - **A6** `M5_RESUME_MAX` 用尽路径改为**上限判定前置**：不删 pending、不熄灯，徽章改文案「(自动恢复已达上限 N/2，请手动继续)」（原实现先删 pending+熄灯再 abort ⇒ 用户/模型都失去挂起提示）。计数清零（可选子项）未实施。
  - **C1** catch 分级补痕：① `mergeConfig` 异常一次性 warn（原静默 ⇒ 面板改值不生效无从排查）；② bfOnce 4 发（同步+3 重试）全败终态 warn；③ 报告基线读取失败/形状异常 warn（原「首写」分支会静默覆盖损坏文件）。**C1 附注**：通道 A `sessionController.prompt(request, AbortSignal.timeout(30_000))` 补官方契约第二参（原缺参 ⇒ 必被 `throwIfAborted` 拒；M5.5 三测实证）。**通道 A 首次实际投递行为待 E2E 观察**（可能改变 A/C 通道胜负序）。
  - **C3** 报告写入缓存化：基线 apply 期读一次（`loadReportBase`），后续内存追加 —— 原实现每次写入全量 `readFileSync`（**实测 1.46MB×每次**，触发点含 400-500ms 防抖高频 reason）。bfOnce 回填也改用同一读盘路径。**补丁（实施中发现）**：缓存基线在**多写入者共存**时会互相覆盖，`writeReport` 增加**尾部对账**（详见下文 C3 附带缺陷）。**稳态瘦身（keys/probe 采样裁剪）未实施**（改报告形状会牵连取证脚本，留待 D1 切分批次一并评估）。
  - **C4** client 泄漏面：① 订阅登记 `liveRows` + `sweepRows()`（每次 tryInject 先退订已离开 DOM 的行）——原实现每次弹窗重开都 `subscribe` 且不持 off，死回调随 notify 空转累积；② 5s `pullHud` 加「曾连过又断开」自停（`everConnected` + `stopPolling()` 所有权校验，防旧行误清新行计时器）。**实施中发现并修掉一个自伤 bug**：首拉时 row 尚未 append（`isConnected=false`）会误判为已关窗 ⇒ 首帧数据丢失，故用 `everConnected` 门。
  - **C6** client 降级补齐：① face 就绪回调里立即 `NS.pullHud()` 一次（首帧不再干等 5s tick）；② `$mount` 失败退避重试（3s/10s，共 3 次尝试）。
- **批次 3（静态改，首次生效需重启；本次已随 toggle 热换）**：
  - **B4** `host.impl.mjs` 顶部 `import * as hudWire from './wire.host.mjs'` → 动态 `import(\`./wire.host.mjs?ts=${seq}-${ts}\`)`（face 注册块）。根因 P16：相对导入解析回**无参规范 URL**，命中进程缓存 ⇒ face 逻辑冻结在重启版本。改后 wire 随 impl 同批热换（`TYPERT` 声明走包 exports 不受影响；wire 模块纯导出、无顶层副作用，已逐行核对）。**热换后实证**：`m5.hudFace='provided'` ✓（新 face 已注册）。
- **client 侧另外**：**B6** `let react`→`const`；6 个散挂全局名收敛为单命名空间 **`window.__DSH_CONTEXT_PILOT__`**（`sidHook/sid/hudDebug/popupObserver/popupTimer/hudTimer/pullHud`）。**控制台取证路径已变更**：`__DSH_CONTEXT_PILOT__.sid`、`__DSH_CONTEXT_PILOT__.hudDebug`。**C5** `parseInput` 空串拦为 `null`（原 `Number('')=0` ⇒ 清空「标记武装有效期」保存即 0、标记通道废）。**D3** `tryInject` 拆 `installToggleRow`/`installHudRow` 独立守卫（原实现开关行已挂时连坐跳过 HUD 行）。
- **热换后报告取证**（14:22:5x 条目）：`m5.hudFace='provided'`、`hudLastAct='14:08 · 标记 · 省 110.1K'`（回填链 ✓）、`gen=muwakxuc-sqnn`（新实例）、`m3.eff.markerMinRatio=0.15` / `policyCardMinRatio=0.15`（面板值保留）、`m3.keywordHits`/`m3.dryRun` 已消失（B3 生效）、`services.compaction='absent'`（顶层作用域隔离，符合 §7.1）。
- **未实施（明确挂起）**：**D1** 按 M 切分模块（风险中/代价 M-L，动骨架，报告自列批次 4 —— 建议单独一轮 + 静态契约断言脚本）、**D2** wire 样板共享（优先级低于 D1，建议先在两仓 README 互链同步清单）、**B5** dump 脚本收敛到 `docs/reference/tools/`（3 处散落）、**C2** 无界 Map/Set 统一 LRU 上限（当前规模无实际风险）、**C3②** 报告稳态瘦身、**A6** 恢复计数按任务周期清零、**A2/A5/A6 的真机 E2E 验收**（挂起→压缩→恢复全链，按 §6 M5.5 流程复跑）。
- **M5.7 压缩历史持久化（hud-acts.json）—— ✅ 2026-10-06 16:0x（用户反馈：重启丢历史 + 只显示 1 条）**
  - **根因**：历史只存内存（`state.m5.acts` cap 8）；重启后回填源 = 报告 120 条环形缓冲，被心跳/状态等高频事件快速剪掉 `m3-act`（实测 15:0x 报告内 m3-act 已 **0 条**）⇒ 回填无源；且每次 toggle/重启/页面刷新（重激活）都重置内存。本会话 4 次部署 toggle 正是截图「暂无压缩记录」的直接原因。
  - **修法**：专文件 `plugin/.data/hud-acts.json`（cap 50，`{version,savedAt,acts:[{sid,text,at}]}`）——`recordHudAct` 压缩时同步落盘；激活即 `loadHudActs()` 恢复；报告**降级为迁移/兜底源**（bfOnce 合并去重 `at+sid` 导入，**不再覆盖式写 acts**——顺带修掉 C2 记录的「回填覆盖运行期记录」竞态）；`getHud` 悬停条数 5 → **8**（内存 cap 8 → 50）。
  - **E2E 验收**：① 写入带 BOM 的测试文件 → 加载失败安全回退（暴露并修掉 **BOM 坑**：`JSON.parse` 不容忍 `\uFEFF`，已剥）；② 剥 BOM 后 toggle → 报告 `hudLastAct` 恢复文件最新条 ✅；③ 删文件 + toggle → 干净基线（无残留）✅。**写入路径**待下次真实压缩验证（文件将以真实数据重建）。
  - **诚实声明**：修复前的历史（11:56 / 12:26 / 14:08 / 15:29 四次压缩）已被报告环形缓冲剪掉，**无法找回**；从下次压缩起历史跨重启累积（cap 50）。
- **⚠️ 实施中的追加发现：心跳自项目起从未运行（超出审查 A1 范围）——根因是 `ctx.effect` 语义误用（重大，已修复并验收）**。
  - **表层**：`const every = t?.interval ?? ctx?.interval` 取**未绑定方法引用** ⇒ 丢 `this` 必抛 ⇒ 被 catch 吞（`timer.interval` 实现首行即 `this.ctx.effect(...)`）。
  - **真因（决定性，cordis `lib/index.js:1142` 源码实证）**：`ctx.effect(execute)` 语义 = **execute 立即执行（=setup），其返回值才是卸载器**。而「卸载清理」块把清理语句**内联写在 execute 体内** ⇒ ① 清理在 **apply 期**被立刻执行，此时 `disposers` 里已含刚入册的心跳 timer ⇒ **心跳当场被 `clearInterval` 掉**（这解释了为何修好 `this` 绑定、换 setTimeout 链、换 setInterval、去 unref 全部「注册成功却零触发」）；② 真正的卸载时**反而毫无清理**（`pending`/`resumeTimers`/心跳全部泄漏）——A1 僵尸 interval 之所以能扛过每一次 toggle，正因它的 disposer 在清理块跑完之后才入册、永不被调用。
  - **证伪过程（记录以免重蹈）**：曾误判为「apply 同步体内注册的长定时器被宿主丢弃」——该结论**错误**，是上述 apply 期误清理造成的假象；所谓「回调内注册才成功」的判别实验，也因那次探针**恰好没把自己的 disposer 入册**而失真。
  - **修法**：清理块改为 `ctx.effect(() => () => { … })`（execute 返回卸载器，与官方 TimerService 同款）；心跳回到 apply 内同步注册，disposer 现在只在真正卸载时调用。
  - **验收（2026-10-06 15:0x，toggle 热换实测）**：① 新实例 `muwbw280-35g3` 注册 06:59:29 → **首条 heartbeat 07:01:29（精确 120s）**，随后持续触发；② 热换前实例 `muwbszjo-1z5c` 末次写入恰在热换时刻 06:59:06，此后**静默 307s（>2 个心跳周期）** ⇒ **A1 disposer 清理面成立**（对比：此前僵尸实例扛过 5 次 toggle）。
- **🔬 A1 泄漏的野外实证（副产品）**：判别实验留下的探针实例 `muwbcv25-wjtp` 未把 interval 登记 disposer → **连续多次 toggle 都没能杀掉它**，仍以 15s 周期往报告写（P37 同族交错写）。已由 DSH 重启清除（末次写入 06:52:22；重启后无新写）。
- **⚠️ C3 附带缺陷（由僵尸暴露，已补丁）**：C3 的「apply 期读一次缓存基线」在**多写入者共存**时会互相覆盖——僵尸用自己的旧基线整段写回，**抹掉新实例在它之后写入的条目**。补丁：`writeReport` 每次写入前做**尾部对账**（磁盘尾条目 ≠ 本实例上次写入 ⇒ 判为他人写入 ⇒ 以磁盘为准重新接续），正确性优先、仍避免无条件全量解析。
- **重启后复验结论（2026-10-06 14:53–15:04）**：僵尸清除 ✅、B4 动态 import 生效 ✅（`hudFace='provided'`）、B3 字段退役 ✅（`keywordHits` 已消失）、`markerMinRatio=0.15` 保留 ✅、**心跳真实运行 ✅**、**A1 disposer 生效 ✅**。

### C3② 报告稳态瘦身 + B5 取证工具收敛 —— ✅ 2026-10-07（挂起项清偿）

**C3② 报告瘦身**（审查遗留，实测触目）：
- **动因**：报告 **3.77MB**、history 满 120 条、**单条均值 16KB**。构成——`heartbeat` 52 条占 888KB、
  `agent/status` 20 条占 330KB、`m3-decision` 13 条占 214KB。体积主体是 `buildSnapshot` 的
  **全量 sessions/agents 枚举**（每会话 `keys[40]` + measure + pressureProjection + breakdownSummary）。
- **安全性调研（关键）**：history 的全量内容**只被一处读取**——启动回填 `bfOnce`（筛 `reason==='m3-act'`
  取 `m3.lastAct`）。其余字段纯取证、不进任何逻辑分支 ⇒ 分级瘦身安全。
- **实现**：`SLIM_REASONS` 集合（heartbeat / agent/status / m5-publish / m2-inject / m3-decision /
  m3.6-marker / m5.5-resume / session/created）+ `slimSnapshot()`。精简档保留：读数（用量最高 2 会话）、
  `m2`（含 `lastText`/`injections`/`skips`）、`m3`（决策/压缩/错误/`eff`/`heartbeat`，仅丢 `eventProbe`）、
  `m5`/`m55`、`services`、`totals`；丢：全量枚举明细、`llmProviders`、`compactionProbe`。
  每条带 `profile: 'slim'|'full'` 标记，dump 可直接区分。
- **实测效果**：slim 单条 **2.06KB** vs full **13.99KB** ⇒ **降 85%**（预估 -84%，吻合）。
  history 满 120 条时预计 **1936KB → ~308KB**，报告文件 3.77MB → **约 600KB**。
- **`m3-act` / `m4-probe` / `activation` / `boot` 等关键事件保持全量**（回填与取证不受影响），
  已专项校验。

**B5 取证工具收敛**（审查遗留）：
- **清理前**：3 处散落共 **18 个**一次性脚本（根 `.data/` 9 个、`plugin/.data/` 4 个、
  `docs/reference/tools/` 5 个），其中 `dump-m55-fields.cjs` **存在两份内容不同的副本**。
- **收敛为 2 个统一工具**（`docs/reference/tools/`）：
  - `dump-report.cjs` —— `--tail N` / `--kind` / `--field` / `--history-acts` / `--full` / `--report`，
    取代 dump-m55-fields / dump-hud-tail / dump-report-tail / dump-m55 四个
  - `asar-query.cjs` —— `list` / `extract` / `grep` / `pkg` 四个子命令，取代 asar-extract ×3 /
    asar-find ×2 / asar-probe
- **顺带修掉两个脚本 bug**：① 旧 `dump-m55-fields.cjs` 按**报告顶层**读 `m3`/`m5`（实际在
  **每个 history 条目上**）⇒ 恒为 null；② 旧 `dump-report-tail.cjs` 仍读已删除的 `keywordHits` 字段。
  统一工具按正确路径读，并在文档里写明该约定（防再踩）。
- **目录语义恢复**：`plugin/.data/` 现在只剩**运行时数据**（`m1-report.json` + `hud-acts.json`），
  取证脚本归 `docs/reference/tools/`。

### 测试骨架 + 通道 A 验收 —— ✅ 2026-10-07

**测试骨架**（`test/`，项目此前**完全没有测试**）：
- 3 套件 / **127 项断言** / <1 秒，`npm test` 一键跑：
  - `contract.mjs`（55）——**三端契约对账**：face 方法表 ↔ client 描述符 ↔ TYPERT（FACE_NAME／方法集／
    参数名／可选项标记）；Config 字段在 FIELDS ↔ schema ↔ M3_DEFAULTS 三处齐全且互相可达；
    退役字段（policyCardMinRatio/highRatio/lightTaskChars）防复活；`mergeConfig` 读取集 ⊆ schema 键
  - `static.mjs`（29）——真实 `node --check`；**client 自足性**（无 import、require 仅 react）；
    **entry 薄壳**（有效代码 <40 行、静态 Config、动态 import 带 `?ts=`、不在顶层 import impl）；
    模块依赖方向（无循环、host 不引用 client）；热换纪律；无调试残留
  - `report.mjs`（43）——产出侧字段契约（13 项 m3/m5/m55/m2 关键字段）；**bfOnce 回填链依赖**
    （必须按 `reason==='m3-act'` + `e.m3.lastAct` 读）；C3② 关键事件必须走 full 档；
    真实报告结构自洽（含「m3/m5/m55 不在顶层」断言）；`hud-acts.json` 去重；dump 工具自检
- **有效性验证**（关键）：注入 3 个人为 bug——`m3-act` 误入精简档 / client `HUD_FACE` 改名 /
  host 代码引用 client.js——**三套件全部抓到且定位精准**，随后还原。
- **发现并修掉测试自身的 3 处误报**：① 用括号配平启发式校验 ESM 会误判（改用真实
  `node --check`，client.js 信封按 CJS 校验）；② `host 引用 client.js` 把**注释里的提及**也算了
  （改为剥注释后再查）；③ 依赖图漏掉**模板字符串形式的动态 import**（补了 `import(\`./x.mjs?` 模式，
  修正后正确显示 `host.impl.mjs → wire.host.mjs`）。
- **对 D1 的价值**：模块依赖图与「无循环」断言就位，切分时可直接验证；`entry` 薄壳约束、
  动态 import 纪律也有断言——**D1 现在有安全网了**。

**通道 A 验收**（此前 README 记「实际走通道 C」，需更正）：
- 历史 `m55.attempts` 取证：唯一一次真实投递 = **`sessionController.prompt` → `{"accepted":true}`**
  （05:58:34），**一次命中、零 rejected**（补 AbortSignal 后直接成功，未回退到 B/C）。
- `channelProbe` 佐证：`sessionController.found=true`、`hasPrompt=true`、`ctor=SessionController`；
  通道 B `ctx.remote` 报 `cannot get property "remote" without inject`（插件 ctx 无该权限）⇒ 结构性不可用。
- **结论**：恢复投递当前首选**通道 A**，通道 C 作兜底。README §2.2 已更新三通道状态表。
- **附带澄清一个误判**：`m55.attempts` 是**累积数组**（每次刷新把当前全部 `slice(-10)` 写进各条目），
  故同一次尝试会在连续多个报告条目里各出现一次——排查时曾误读为「重复执行 23 次」，实为展示放大。

### D2 两仓同步清单 —— ✅ 2026-10-07

**背景**：`dsh-context-pilot` 与 `dsh-browser-kit` 共享同一套「入口薄壳 + mtime 热换 + remote face 轮询」
机制，但各自独立部署、无共享构建 ⇒ 样板只能复制。审查建议「至少在两仓 README 互链同步清单」。

**做法**：不写空泛的「改一处同步另一处」，而是**逐文件对照实测**后分类（`docs/cross-repo-sync.md`）：
- **7 个强同步点**（漂移 ⇒ 静默失败）：`REMOTE_METHOD_DESCRIPTOR` 常量值、`FACE_METHOD_TABLE` 四元组结构、
  TYPERT 三处派生关系、entry 薄壳四要素、`dsh.bundle.patch`、`exports` 三个键、
  **client→host 消费三连环**（scope 参数 / 信封 unwrap / inject 含 typert）
- **5 个弱同步点**（结构对齐、内容独立）：目录布局、`apply` 签名、报告落盘形态、
  schemastery 四级候选链、`cordis.patch.yml` 挂载形态
- **6 处有意差异**（**明确标注不要强行同步**）——依据实测证据，其中最值得注意的一条：
  **`volatile()` 只有本仓用**（browser-kit 0 次，本仓全字段用）。本仓依据是「DSH 设置写入门禁要求
  条目存在 volatile 字段，否则保存被静默拒绝」（zcode 实测）；browser-kit 未触发该问题。
  ⇒ 结论：**按各自实测，勿盲目抄**（这条如果没有实测对照，很容易被写成「必须都加 volatile」的错误规则）
- **漂移检测**：给了手动对比脚本；并说明「跨仓自动断言」属可选增强——
  会引入跨仓路径依赖，两仓不同步时反而误报，故本仓 `test/contract.mjs` 只做**仓内三端对账**

### 方案 C 引擎上限 + 滑块/精简 —— ✅ 2026-10-07

**方案 C（插件线钳制到引擎阈值之下，用户两轮讨论定稿）**：
- **需求**：插件开启时插件强制线生效、引擎 80% 不抢跑；插件关闭/卸载后引擎 80% 自动恢复。
  静态改法（patch 写 `auto:false`）无法满足第二条——被用户正确否决。
- **实现**：`engineThreshold(agent)` 动态读引擎实例 `config.thresholdRatio`
  （源码实证：compaction-basic L826 `this.config = resolveConfig(config)`，deepFreeze 公开属性）；
  生效强制线 = `min(用户配置, 引擎阈值)`，三处同源钳制（pre-step / idle sweep / getHud 下发
  `criticalCap` → client persist 收敛 + HUD 显示「（上限 80%）」+ 面板备注动态标注 + 计算器推荐行收敛显示）。
- **取证**：`m3.engineCapProbe {at,via,ratio,fallback}` —— 实测 `ratio:0.8, fallback:false`（真实实例属性）。
- **参数**：用户强制线 0.8 → **0.7**（profile patch + toggle）；顺带清理 patch 里已退役的
  `policyCardMinRatio` 残留键。生效线 = min(0.7, 0.8) = 0.7。
- **边界**：引擎服务不可达 → fallback 0.8（同官方默认）；client 未拿到 cap → 不钳（host min() 兜底）。
- **A5 附带解锁**：把线临时设低于当前占用即可真机验证 pre-step pressure 路径（不再被引擎 0.8 挡）。

**面板滑块 + 演习模式退役（用户截图需求）**：
- 总开关（bool 字段）改**开关滑块**（纯 CSS `.dcp-switch`，无依赖；label 包裹 input+slider，点击即切换）
- **演习模式（dryRun）完全退役**：面板行 / schema / M3_DEFAULTS / mergeConfig / 两个压缩门控
  （`!effEnabled() || M3.dryRun` → `!effEnabled()`）全链路删除；contract 退役清单 +1。
  语义说明：压缩路径不再有影子模式——观察注入可用 dryRun 之外的手段（报告即全量取证）。
- 面板字段 **7 → 6**。

### 压缩记录「丢失」终极定位与修复 —— ✅ 2026-10-07

**症状**：弹窗常显示「本会话暂无压缩记录」，但用户确知本会话压缩过、且**曾经显示过**。
持久化（hud-acts.json）与回填（bfOnce）各修过一轮，仍复现。

**排查链（三次修正假设，最终靠运行时取证定案）**：
1. 假设①「记录没落盘」→ 否：文件有记录、报告 `m3.lastAct` 曾正常。
2. 假设②「DSH 压缩轮转 session id，线性血统链可修」→ **部分成立但模型错误**：
   报告确实出现 3 个 sessionId（16616c07 / cb8d115e / f4154f01），据此实现 C-lineage 并
   回填 2 条种子边，离线模拟命中 ✅——**但线上仍不显示**。
3. **运行时取证定案**（新增 `m5.hudPoll` 快照字段，把 getHud 链路逐状态落盘）：
   ```
   actsCount=1 ✅   lineageSize=3   agentSid=16616c07   chainSize=3   matched=1（首 agent 可命中）
   运行时又抓到第 3 条边：f4154f01 ← 16616c07（**双向摆动**）
   lastSid=cb8d115e ≠ agentSid=16616c07 ⇒ 宿主在**同时处理多个会话**的事件
   ```
   ⇒ **真相：不是单会话 id 轮转，而是多会话交错活跃**。插件 XHR 钩子拿到的 `NS.sid` 是
   「UI 最后请求的那个会话」，多对话场景下会漂移 ⇒ 按 id 过滤必然间歇性为空。
   线性血统链模型不成立（回填的 2 条种子边属错误假设，已清除）。

**修复（最终方案：本会话优先 + 全局兜底并标注）**：
- host `getHud` 同时返回：本会话（血统链过滤）`hudLastAct`/`acts`/`sessionMatched`，
  以及全局 `hudLastActGlobal`/`actsGlobal`
- client：本会话有记录 → 原样显示；为空但全局有 → 显示「最近压缩 X（**其他会话**）」，
  悬停注明「本会话无匹配记录，显示全局最近压缩」⇒ **记录永不消失，且不谎报会话归属**
- C-lineage 机制保留（若真出现单会话轮转仍能命中），运行时按真实观察积累边
- 新增 `m5.hudPoll` 取证字段（actsCount/lineageSize/lastSid/agentSid/chainSize/matched）
  ——同类问题下次直接定位断点，不必再猜

### 阈值速览行截断修复 + 强制线生效实证 —— ✅ 2026-10-07

**用户反馈**：「上限 80% 没显示完整」+「压缩已经生效」。

**① 截断根因（排版层，非数据层）**：阈值行原为 `font-size:10px` + `white-space:nowrap` +
`text-overflow:ellipsis`。窄弹窗下 `nowrap` 使行宽超出容器，`ellipsis` 把尾部「（上限 80%）」
裁成「（上限 80...」——**信息静默丢失**（比折行更糟：用户以为上限没配置）。
- 修复：`9px` + `white-space:normal` + 去掉 ellipsis（宁可折两行，绝不吞信息）；
  分隔符全角「｜」→ 半角「·」（全角竖线占一个汉字宽，三个分隔符吃掉 ≈27px，是挤掉尾部的直接原因）；
  「（上限 80%）」→「· 上限 80%」省一对全角括号。
- **过程中自查修正**：第一版用 `word-break:keep-all` 想「只在分隔符处断行」——但 keep-all
  **禁止汉字间断行**，对无空格中文串等于完全不能折行 ⇒ 反而更容易溢出。已改 `word-break:normal`
  + `overflow-wrap:anywhere`，并把该坑写进 `contract.mjs` §6.6 断言（含 6 条防回归）。
- 断言：`contract.mjs` §6.6 —— 不得用 ellipsis / 必须 normal 换行 / 不得 keep-all /
  字号 ≤9px / 分隔符必须是半角 ·（**同类「静默截断」以后跑测试就拦住**）。

**② 强制压缩线生效实证（用户设 0.5，本轮结案）**：
- `m3.lastPreStep 12:50:06`：`ratio 50.7%`、`trigger pressure` ⇒ **越线**；
- `m3.lastAct 12:51:11`：`reason safety-net`、`shadowedTokens 350454`（省 350K）、
  sessionId 16616c07 —— idle 兜底路径真实执行；
- 下一轮用量行 **51% → 16%** ⇒ 压缩确实生效。
- **关键旁证**：若生效线仍是引擎 0.8，50.7% 的 `safety-net` 会被 `if (d.ratio < min(...)) return;`
  直接跳过、不会有这次压缩 ⇒ 反证 `min(0.5, 0.8) = 0.5` 的钳制链路真实生效。
- 后续观察：用户已在面板把线改到 **0.8**（`markerMin` 同步 0.15→0.3，心跳 13:10:51 起
  `crit/markerMin = 0.8/0.3`）——即 0.8 恰为引擎上限，钳制在此值上**不产生差异**（符合预期）。
  记录：`crit` 历史轨迹 0.7 → 0.5 → 0.75 → 0.5 → 0.7 → 0.8（面板写入实时到达 host，
  `mergeConfig` 活引用现读机制再次被验证）。

### 方案 C 潜伏缺陷：getHud 传 Session 而非 Agent —— ✅ 2026-10-07

**发现方式**（在上一轮验证「阈值行截断」时顺带核对报告，非用户报障）：
`m3.engineCapProbe` 按事件分组统计后出现**两类互斥结果**：
```
35 x m3.5-prestep  -> agentPresets.serviceFor ratio=0.8 fallback=false
24 x heartbeat     -> agentPresets.serviceFor ratio=0.8 fallback=false
 4 x heartbeat     -> unresolved            ratio=null fallback=true
 1 x m5-publish    -> unresolved            ratio=null fallback=true
```
`unresolved` 的时间戳与 `m5.hudPollReq`（13:18:50.660Z）**逐次吻合** ⇒ 锁定唯一嫌疑路径：
getHud（client 5s 轮询）。

**根因**：`criticalCap: engineThreshold(...?.session || agents[0]?.session || ...)` 传了
**Session 本体**，而 `resolveCompactionFor(agent)` 的解析链是
`agent.ctx.get('compaction')` / `agentPresets.serviceFor(agent,'compaction')` —— 两者都只认
**Agent**，传 Session 全部落空 ⇒ 返回 `unresolved` ⇒ `engineThreshold` 走兜底
`DEFAULT_ENGINE_THRESHOLD = 0.8`。

**影响评估（诚实结论：当前无可见症状，但机制是坏的）**：
- 引擎阈值恰为 0.8（官方默认），与兜底值相同 ⇒ **此刻 cap 恰好正确**，用户看不到任何异常；
- 但方案 C 的**全部价值就在「动态跟随引擎阈值」**：一旦 DSH 改 `thresholdRatio`
  （或未来换 provider/policy 导致阈值变化），client 拿到的 cap 会**静默停留在 0.8**，
  钳制失效——即"看起来在工作、实际已失效"的典型潜伏故障。
- 这正是我上一轮刚修完 `agents is not defined` 的同一函数里的**第二个作用域/实参错误**：
  两个 bug 都藏在 getHud 里，且都被"恰好正确"的兜底值掩盖。

**修复**：传 Agent 本体（`agents.find(...) || agents[0]`），删掉 `?.session` 两处。
**防回归**：`report.mjs` §3.5 新增 2 条断言（解析 criticalCap 实参 + 断言不含 `.session`），
并**实测验证断言是有效绊线**——对旧代码 `flaggedBad=true`（失败），对新代码通过；
「两边都通过的测试等于没测」。

### 阈值行：删除「上限」+ 字号改大 —— ✅ 2026-10-07

**用户要求**：「智能压缩线 30% · 强制压缩线 80% · 上限 80%，删除上限。然后字体改大一些。」

**背景**：上一轮为修「上限 80% 没显示完整」把字号压到 9px + 折行。用户现在改主意——
不要这个信息，且嫌字小。

**改动**：
- **删除「上限 NN%」**：引擎阈值（`criticalCap`）是**内部钳制细节**，用户不需要在弹窗里看；
  面板备注（`hintFor` 动态追加）与计算器推荐行仍会说明该约束 ⇒ 信息没有丢失，只是移出了 HUD。
  client 侧 `capTxt` 变量随之删除（`NS.engineCap` 仍保留——**保存路径的钳制逻辑不变**，
  只是不再显示）。
- **字号 9px → 11px**：删掉上限后行变短，11px 仍能一行放下（`智能压缩线 30% · 强制压缩线 80%`
  ≈ 22 字符），不再需要靠缩小字号换空间。opacity .6 → .68 同步提亮。
- 保留 `word-break:normal` + `overflow-wrap:anywhere` 作为窄容器兜底（**不是** keep-all：
  keep-all 禁止汉字断行，反而更易溢出——这个坑记在上一节）；仍不用 ellipsis。

**防回归**（`contract.mjs` §6.6 改为 8 条，含 2 条新增 + 1 条反转）：
- 字号断言由「≤9px」**反转为「≥11px」**（用户要求改大，旧断言会误报）
- 新增「阈值行已删除『上限』」（同时断言 `capTxt` 变量不复存在）
- 保留：不得 ellipsis / 必须 normal 换行 / 不得 keep-all / 分隔符半角 ·
- **三条绊线均实测验证有效**（字号缩回 9px、上限复活、ellipsis 复活 → 全部 FIRES）

**取证分离（测试细节）**：样式与文本此前从同一段源码取；本轮新增断言需要**单独取
`thr.textContent` 的模板串**（文本在 renderHud 内，样式在 thr 定义处，相距较远）——
故 `thrCss` 与 `thrText` 分别正则提取。

### R1 智能思考：注入落地 + `briefedBySid` 真 bug 修复 —— ✅ 2026-10-07

**用户要求**：「相关提示词也要增加吧，让 Agent 明白这个功能的使用方法是基础逻辑。
不然可能暴漏了，模型不会去调用。」+「开关打开后 Agent 就能收到提示词注入和直接开，
关闭的话，提示词也不注入也无法改。」

**① 教学文本（`renderEffortBrief`）——覆盖度必须 6/6**
沿用本项目已踩过的教训（`policyCardMinRatio` 注释）：**「暴露能力但不教用法 = 功能等于不存在」**。

| 要素 | 文本 |
| --- | --- |
| ① 当前值 | `当前思考强度档位：xhigh` |
| ② 可选档 | `（本模型可选 low/high/xhigh）` |
| ③ 标记语法 | `[cp:effort <档>]` |
| ④ 何时该用 | `更深推理（复杂设计、疑难排查、长链规划）或更快响应（简单查询、机械修改）` |
| ⑤ 生效时机+不中断 | `下一步生效，上下文与任务不中断，用户无需操作` |
| ⑥ 代价提醒 | `换档可能使前缀缓存失效，一次任务 1-2 次为宜` |

档位**现拼活值**（沿用 `renderBrief` 的 A3 教训）；无档可调时返回 `null` ⇒ 不注入不打扰。

**② 每轮后缀（`renderEffortSuffix`）**：用量行追加 `｜ 思考强度 xhigh`（≈7 token/轮）。
作用：模型知道**当前实际生效值**——它只知道自己请求过什么，不知道插件是否应用成功
（例如档位非法被忽略时）。`adapterDefault` 时标注「(默认)」。

**③ 门控解耦（用户强调的「全程允许」）**：effort 走**独立门控 `effortEnabled`**，
与压缩的 `markerMinRatio` 完全无关——低占用也必须能注入/换档（压缩的卡在低占用时不注入）。
断言用**剥注释后**的源码检查（注释里说明「与 markerMinRatio 解耦」是正常文字，
第一版断言被自己的注释绊倒，已修）。

**④ 真 bug 修复：`briefedBySid` 永不失效**
原实现只有 `add`、全文无 `delete`/`clear` ⇒ 压缩把一次性说明收进摘要后，插件认为
「讲过了」**永不再讲**；摘要由模型生成、**不保证保留该段** ⇒ 模型可能永久失去用法说明。
实测佐证：`m2.briefings=2` 而 `m2.injections=5`。
修复：新增 `clearBriefed(sid)`，**两条压缩路径**（pre-step 与 idle）成功后均调用，
同时清 `briefedBySid` 与 `effBriefedBySid` 两个集合。

**防回归**（`contract.mjs` §6.10/§6.11，共 19 条）：
门控必须独立、教学 6 要素逐条断言、无档不注入、`clearBriefed` 存在且清两个集合、
两条路径都调用、声明早于调用（防 const TDZ）。**5 条绊线均实测验证有效**。

### R1 换档通道：agent.ctx 作用域 + 标记独占一行 —— ✅ 2026-10-07

**① 执行 seam 的关键发现（差点埋雷）**
源码实证：`waterfall("agent/request", {turn, step, signal}, seed)`
（`dsh-agent-loop` L1179）——**payload 里没有 agent**，只有 turn/step/signal。

⇒ 第一版实现用 `payload.agent.session.id` 找会话，**per-session 查找会恒不命中**、
换档**静默失效**（不报错、只是永远不生效——最难查的一类故障）。

官方 `installModelSelection` 的做法（`dsh-agent/lib/types/model-selection.js` L45/L61，
调用方 `api-session-controller` L310 传 `agent.ctx`）：**注册在 agent.ctx 上**。
本插件同款：按 agent **懒安装** + WeakSet 去重，sid 由闭包捕获；
`ensureEffortHooks()` 在每次 pre-step 调用（新会话自动覆盖）。

**② 标记正则必须独占一行（E2E 前自查发现的真风险）**
宽松正则 `/\[cp:effort\s+(\w+)\s*\]/g` 会误触发**散文提及**：
本插件注入的教学文本本身就含「在回复最后一行单独写 [cp:effort <档>]」，
模型引用/复述它（「你可以写 [cp:effort high] 来换档」）时会被当成指令 ⇒ **非预期换档**。
压缩标记用 `text.trimEnd().endsWith(M3.marker)` 天然规避（要求结尾），
effort 标记因位置自由才暴露该问题。

修复：`/^[ \t]*\[cp:effort[ \t]+([A-Za-z0-9_-]+)[ \t]*\][ \t]*$/gm`（锚定行首行尾 + m 标志）。
实测 8 个用例：散文/文档/引用教学全部不再误触发；正常独占一行、带空格、与 compact 共存均正常。
**残余风险（诚实标注）**：代码块内独占一行仍会触发——正则无法识别 markdown 上下文，
但该场景远少于散文提及，可接受。

**③ 四道必备防护**
1. **档位合法性校验**：`dsh-llm resolveCallWithInfo` L2182 对非法档**直接抛错**
   （`UNSUPPORTED_REASONING_EFFORT`）⇒ 会中断该次请求。不在可选集内 ⇒ 忽略 + 留痕（不硬送）。
2. **冷却 30s**：换档可能使前缀缓存失效（`call-config.js` 注明 effort 属 cache-affecting 状态）。
3. **让位他人显式指定**：当前 config 带 effort 且**不是本插件上次写的**（用户手动选档 /
   subagent 自带 `reasoning_effort`）⇒ 不覆盖（router-laya `carriesExplicitRoute` 语义）。
   用 `appliedEffortBySid` 区分「自己的足迹」与「他人选择」——否则第二轮起每轮都看似显式，会自我锁死。
4. **删除 maxTokens**：换档不应把上个 adapter 的 cap 钉到新档（router-laya `applyRoute` 同款教训）。

**④ 声明顺序修复**：R1 块（`EFFORT_MARKER_RE` / `installEffortRequestHook` /
`ensureEffortHooks`）原在 pre-step 之后，而 const 无提升 ⇒ **TDZ 抛 ReferenceError**。
已整体前移到 `readEffort` 之后，并加断言锁死三者「声明早于使用」。

**取证字段**：`m3.effortMarkerHits / effortSwitches / effortSkips{cooldown,invalid,foreign,noRoute}
/ effortHooks / lastEffortMarker / lastEffortApply`（含 from→want、options、applied:false+error）。

**防回归**：`contract.mjs` §6.12（15 条）+ §6.13（7 条，含**行为验证**——用真实正则跑
误触发用例），总计 219 断言。标记正则绊线实测有效（结构检查 + 行为检查双 FIRES）。

### R1 收尾：prepend 真根因 + 零轮询显示 + 冷却可见 —— ✅ 2026-10-08

**① 用户一问挖出的真 bug：换档「报成功」但实际未生效**
用户看到 chip 一直 `xhigh`，怀疑「5s 轮询不智能」。取证发现远比显示严重：
`lastEffortApply.applied = true`（xhigh→low），但**之后每一轮注入后缀仍是 xhigh**。

根因：官方 `installModelSelection` 挂在**同一个** `agent/request` waterfall 上，
且在**外层**（`dsh-agent/lib/types/model-selection.js` L61-75）：
```js
const resolved = await next();
const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
return { ...withoutInheritedEffort,        // ← 内层写的 effort 在这里被 delete
         ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort } };
                                           // ← 再套回持久化 header 的值（xhigh）
```
⇒ 内层写入必被剥掉。**先剥内层、再套自己的**——waterfall 组合语义。

修复三点（联动，缺一不可）：
1. **`prepend: true`** —— 本插件成为最外层，每轮最后覆盖
2. **pending 改持久态** —— 不再「用一次就删」：既然每轮都被剥，就得每轮都覆盖回去
3. **冷却基准只在档位真变化时更新** —— 第 2 点引入的副作用：pending 持久后每轮都跑，
   若每轮刷新冷却，**模型后续的新标记会被全部挡掉**
配套：让位判断补 `pend.effort` 比较；`effortSwitches` 只在真变化时自增（否则变「请求次数」）；
同值标记幂等短路（不消耗冷却，`effortSkips.sameValue`）。

**验证**：修复后注入行实测变为「｜ 思考强度 low」⇒ **端到端闭环成立**。

**② 去掉 5s 轮询（用户要求「不要5S轮询」）**
改用**官方响应式投影**：`props.useProjection("modelSelection")`
- `useProjection` 是 `conversation.input.right` slot 的**标准 prop**（官方 contract 列表实证）
- 官方 UI 同款：`dsh-client-ui-conversation` L17240 `useProjection("plan")`
- 投影由**会话事件驱动**（`applyModelSelectionProjection` L2072-2088：
  `model/selection`→pending、`request/header`→lastUsed）⇒ 换档落库即重渲染，**零轮询**
- **pending 优先显示** + 「· 下一步」小字 ⇒ 已选待生效的状态也能提前看到

**③ 冷却显示（用户要求「把 30 秒冷却加到档位后面显示」）**
- host 返回**绝对时间戳** `cooldownUntil` + `cooldownTotalMs`（低频调用不会过时）
- chip 显示「· 冷却 23s」，**仅冷却时占位**，结束自动消失
- 本地 1s tick **只在 cooling 时启用**，结束即 `clearInterval`（非常驻定时器）
- host 信息在**投影变化时重问**（依赖 `[effort, pendingNow]`）⇒ 换档即刷新冷却状态

**④ 一个自我修正（断言过严）**
上一轮加的「chip 内不得出现 setInterval」过严——倒计时需要定时器。
改为精确判据：定时器回调**不得含 `getHud`/`pullOnce`**（那才是被禁的「定期问 host」）；
且**必须按 `cooling` 启停**（否则是变相常驻轮询）。

**防回归**：`contract.mjs` §6.9/§6.12 共 15 条相关断言，总计 **233 断言**。
**6 条绊线均实测有效**：恢复 5s 轮询 / 倒计时不按 cooling 启停 / 冷却不显示在档位后 /
去掉 cooling 判断 / 加回 setInterval / 去掉 useProjection → 全部 FIRES。

### R2：换档改「工具」——用户指出标记方案的根本缺陷 —— ✅ 2026-10-08

**用户诊断（完全正确）**：
> 「我发起问题，第一步思考时就获取到当前档位和可选档位和提示词，换档位，执行标记，触发，
> 重新进入思考（以新档位），继续干活，过程中如果有必要就继续换，完成任务结束。」
> 「需要我再发起才能触发标记。这个就失去意义了。」
> 「最好是无感换档执行的，不要像压缩标记那样重新自动拉起——
> **压缩标记的自动拉起本质是调用我的输入框发起新的内容拉起的**。」

**R1 标记方案的两个致命缺陷**：
1. 标记写在回复末尾 ⇒ 本轮已结束 ⇒ 档位只在**下一轮**（用户下次说话）生效
2. 若仿压缩用 `agent.followup()` 自动拉起 ⇒ 往 `inbox.next-turn` **伪造一条用户消息**（替用户发言）

**正确的机制（源码实证）**：`dsh-agent-loop` L1152-1155
```js
const toolCalls = message.content.filter((b) => b.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };   // 无工具 ⇒ 本轮结束
return concluded ? { kind: "completed" } : null;            // 有工具 ⇒ null = 继续下一步
```
⇒ **工具调用让本轮继续**（turnEnds 保持 null ⇒ L1005 不 break ⇒ `target="next-step"`），
而每步都重走 `prepareRequest` → `agent/request` waterfall（L1179）
⇒ **下一步的请求即带新档位**。零用户输入、零伪造消息、同轮内生效。

**对比**：

| 方案 | 生效时机 | 需用户输入 | 模型知道结果 | 误触发风险 |
| --- | --- | --- | --- | --- |
| 文本标记 | 回复末尾 → 本轮结束 | ❌ **需要** | ❌ 不知道 | ❌ 散文提及会误触发 |
| **工具调用** | **同轮下一步** | ✅ 不需要 | ✅ 有返回值 | ✅ 无（结构化参数） |

**参考项目原理（补充分析）**：`dsh-router-laya` 在 `agent/request` 里直接改 config
（L886-975），任务文本从 `agent/inbox/claimed` 抓（L875），难度由本地小模型判（L582）——
**换档发生在「请求组装时」，无需用户输入**。但它"外部模型替你决定"，
与用户要的"Agent 自己决定"不同 ⇒ 取它的「生效时机」，决定权仍交 Agent。

**前置验证（不建立在假设上）**：先加一次性只读探针 `snap.r2Probe` 实测：
`toolsService: "object" | hasRegister: true | agentHasCtxTools: true` ⇒ 注册路径可达。

**实现**（照官方 `dsh-tool-ask-user` 范式）：
- `loadDefineTool()`：与 `createUserMessage` 同款候选链（bare → env → resourcesPath → 硬编码）。
  实测 `via: "resourcesPath/app.asar|import"`（bare import 第三方目录必失败——本项目已有教训）
- `registerEffortTool()`：`defineTool({ name, description, parameters, output, execute })`
  + `tools.register(def)`
- **工具不抛错**：非法档/冷却中返回结构化结果（`{ok:false, error, options}` /
  `{ok:false, cooling:true, remainSec}`）让模型自行纠正——抛错会中断本轮。
  这与 `agent/request` 侧必须校验（否则 llm 抛 `UNSUPPORTED_REASONING_EFFORT` 中断请求）
  是**两层不同的保护**
- `effortEnabled` 关闭时**不注册**（完全不介入）；会话中途打开开关则懒注册
- 教学文本改写为教工具用法（6/6 覆盖度，③ 由「标记语法」→「工具名+调用方式」，
  ⑤ 由「下一步生效」→「本次任务内立即生效」）
- **移除**：`EFFORT_MARKER_RE` 正则、`session/event` 里的标记解析、§6.13 散文误触发断言
  （工具方案无正则误判面，该断言随之退役）

**取证字段**：`m3.effortTool`（注册结果）、`m3.effortToolLoader`（加载链）、`m3.effortToolCalls`。

**实测**：`effortTool = {ok:true, name:"set_reasoning_effort", via:"tools.register"}` ✅
注入文本已变为工具版本（本轮上下文可见）。

**防回归**：`contract.mjs` §6.13 重写为 16 条工具契约断言（标记已移除 / 工具名 /
官方 defineTool / tools.register / 候选链 / 关闭不注册 / 懒注册 / 不抛错 / 冷却返回 remainSec /
写持久 pending / 参数与 output schema / 异常吞 / 取证字段），总计 **242 断言全通过**。
