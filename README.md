# dsh-context-pilot — DSH 上下文领航插件

> **交接文档**：新会话的 agent 读完本文 + `docs/` 即可接着开发，无需其他上下文。
> 创建：2026-10-05 · 状态：M1 已部署，`not-bundle` 坑已修复（**待再次重启验证**）· 探索结论全部经运行时/源码实证

## 1. 项目定位

DSH（DeepSeek Harness）宿主侧插件 `@local/dsh-context-pilot`：**上下文领航员**。

核心循环：

```
每轮任务前 → 读取上下文用量（tokenMeter）→ 注入"上限/已用/占比"进 prompt
          → AI 按任务复杂度自评 → 决定是否先压缩（compactNow）→ 再执行任务
```

要解决的问题：长会话上下文压力不可见、自动压缩时机（80%）与任务复杂度无关——重任务需要全上下文，轻任务其实可以先压缩腾空间。

## 2. 环境事实（本机，已核实）

| 项 | 值 |
| --- | --- |
| DSH Desktop | 0.2.0-rc.2（Electron 44 / Chromium 152 / Node 24） |
| DSH 进程模型 | 主进程 + **RUN_AS_NODE 纯 Node 插件宿主**（插件 host 摸不到 Electron API——已实证，勿尝试） |
| Profile | `C:\Users\Administrator\.dsh\profiles\desktop\` |
| composition 来源 | ① `package.json` 的 `dsh.profile.bundles`（首个 `@deepseek-ai/dsh-base` = 基础 composition，压缩挂载来自这里）② `cordis.patch.yml`（profile 补丁层）③ 根 `cordis.yml` 恒为 `[]` |
| 本地插件挂载 | profile `package.json` 的 `dependencies` 加 `"@local/xxx": "link:<项目>/plugin"` + `bundles` 加 `"@local/xxx"` + **插件 package.json 必须有 `dsh.bundle` 段**（否则 not-bundle 静默跳过，见 §4 P1）；手工 Junction 进 `node_modules\@local\` 可免 pnpm install（browser-kit/本项目均实证）。重启 DSH 生效 |
| Inspect 工具 | 会话里有 `cordis_inspect_list/query`（host Service/Event/Config 目录可直接查——本报告服务签名即来自它） |

## 3. 已验证的核心 API（全部经运行时 Service 目录 + asar 源码实证）

### 3.1 读用量（可读 ✅）

```js
const m = ctx.tokenMeter.measure(session);
// m.totalTokens      请求+响应压力
// m.surfaceTokens    表面总量（= nodes[].tokens 之和）
// m.contextPressure / m.projectedTokens
// m.contextBreakdown { systemTokens, messageTokens, toolsTokens }
```
- 上限 W：从 LLM 适配器容量解析（`LlmModelContext.contextWindow`，`ctx.llm.listModels()` 同字段）。
- ⚠️ 精度：无 provider usage 时按 **4 字符/token 启发式，CJK 与 JSON Schema 低估**（官方 Dev Note 承认）。占比是估计值。

### 3.2 压缩（可手动触发 ✅）

```js
ctx.compaction.compactNow(agent)            // 立即压缩（等价 /compact）
ctx.compaction.compactIfNeeded(agent, trigger)
ctx.compaction.compactRegion(start, end, agent)  // 需要开放 turn
```

### 3.3 每轮 prompt 注入（官方挂点 ✅）

```js
ctx.systemPrompt.variable('ctxUsage', (ctx) => `上限 ${W} / 已用 ${used}（${pct}%）`);
ctx.systemPrompt.context(...)   // 或 section(...)
```
`systemPrompt` 服务就是"每轮模型步进前组装 prompt"的注册表。

### 3.4 自动压缩参数（可配 ✅，来自 `@deepseek-ai/dsh-compaction-basic`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `thresholdRatio` | 0.8 | 触发线 = `floor(min(W×ratio, W−O−headroom))`，O=输出预留，headroom 默认 65536 |
| `retainRatio` | 0.16 | 压缩后近端保留（可用 `retainTokens` 绝对值替代） |
| `modelPolicies[]` | [] | 按 provider+model 覆写 |
| `auto` | true | 自动压缩开关（false = 仅手动） |
| `summarizationProvider/Model` | 路由回退 | 压缩摘要可用便宜模型 |

## 4. ⚠️ composition 的真相（本次实验踩坑复盘，重要）

- **根 `cordis.yml` 恒为 `[]`，头部注释明言 "Edit cordis.patch.yml, not this file"**。它会被 DSH 归一化重写——**永远不要编辑它**。
- **坑 P1（2026-10-05 实证）：手工 link + dependencies/bundles 手工登记 ≠ 能挂载。** bundle 资格判据 = 插件 package.json **必须有 `dsh.bundle` 段**（如 `"bundle": { "patch": "./cordis.patch.yml" }`；patch 文件用 `- insert: - {id, name}` 行声明挂载，照抄 browser-kit）。缺段时 plugin-manager 报 `error: {"code":"not-bundle"}`，composition **静默跳过该 bundle**——重启几次都不会生效，host 侧无日志可查。源码依据：dsh-plugin-manager/lib/index.js `if (manifest?.dsh?.bundle === void 0) throw new ManagementFailure("not-bundle")`。排查利器：会话工具 `plugin_manager` 的 `list_bundles`（error 字段直接给答案）；asar 检索脚本 `docs/reference/tools/asar-find-not-bundle.cjs`。
- 本次实验曾把 thresholdRatio: 0.6 写进 cordis.yml（一份 1565 行的陈旧全量快照），**从未生效**，随后被 DSH 重写回 `[]`。当前生效配置 = dsh-base 内置默认（thresholdRatio 0.8）。
- 正确的调参路径（按优先级）：
  1. `cordis.patch.yml` 加同名挂载/配置做 profile 级覆写（**覆写语义需实验验证**——同 id 是替换还是合并未确认，M1 顺手验证）；
  2. `configEditor` 服务 `edit(entry, change)`（走正常 Loader 重载）；
  3. 直接改 asar 内 dsh-base（不可取，升级即失）。
- 压缩参数改动需重启 DSH 生效；改任何 profile 文件前先备份（目录里有 `.bak-*` 先例）。

## 5. 当前状态

- [x] 探索与服务实证（本报告 + docs/reference 抽取源码）
- [x] thresholdRatio 实验复盘（见 §4——未生效，现已回默认 0.8，无需回滚）
- [x] M0 骨架 → 已升级为 entry 薄壳 + host.impl.mjs mtime 热换（照抄 browser-kit 模式，入口从此不改）
- [x] M1 编码 + 部署 + 复盘 not-bundle 坑（§4 P1）+ **重启验证通过（2026-10-06 00:03，实测见 §6 M1）**
- [x] M2 编码 + toggle 热换上线（2026-10-06 00:10，`m2-factory`：工厂经 `resourcesPath/app.asar|import` 解析成功）
- [x] **M2 复述验证通过（2026-10-06 00:13）**：模型逐字复述注入三元组 window 1,000,000 ｜ used 169,892 (17.0%) ｜ surface 148,445，报告 `injections:1`、`lastText` 与复述一致
- [x] M2 拆分修复（P4 形状取证：投影实为 `{nodes, breakdown:{systemTokens,…}}`，已聚合；报告实测 system≈2,113 / messages+tools≈162,707）
- [x] M3 编码 + 上线（2026-10-06 00:23：inbox/inserted 决策 + serviceFor 作用域解析 + compactNow 实弹模式，见 §6 M3）
- [x] **M3 实弹验证通过（2026-10-06 00:32）**：idle 扫除器在 turn 结束后 5 秒内执行 `compactNow`，`actOk:1`、影子化 **289 节点 / 181,327 token**（seq 10–751）；下一条注入行 used 195,622 → **31,352 (3.1%)**。验证后 highRatio 已回调 0.6 并热换
- [x] **M3.5 三通道重构上线（2026-10-06 00:50 热换，报告含 `preStepActs/keywordHits/policyCards`）**：对照用户原始设想（任务摄入时决策、场景1/2、agent 感知压缩选项）重定架构——决策主体移交「模型语义判断 + 用户关键词确认」，插件只做读数/选项/执行。见 §6 M3.5。**待实弹：① 政策卡出现且模型会解读；② 用户消息「先压缩 …」→ pre-step 轮内先压生效（`lastPreStep.acted:true`）**
- [x] **M3.6 标记闭环上线（2026-10-06 01:03 热换）**：用户设计的"模型建议、自动执行"通道——模型回复尾行 `[cp:compact]` → `session/event(assistant/message)` 解析武装 → idle 后立即 `compactNow`（≥20%，不受 10min 冷却）。**用户零输入**；竞态（消息事件晚于 idle 翻转）以武装时查 `agent.status` 兜住
- [x] **M3.6-a 形状取证 + 修复（2026-10-06 01:2x）**：首轮标记未武装（`markerHits:0`）→ 事件探针裁决：`session/event` 通、`assistant/message` 负载键 `[type,seq,time,data,surfaceOp]`，正文在 **`data.message.content`**（官方 `deriveEventMessage`，dsh-session lib/index.js:214；`user/message` 的 `data` 即消息本体——解释了为何用户消息提取到 47 字符而助手消息为 0）。`extractEventText` 已按官方形状重写
- [x] **关键词「先压缩」通道裁撤（2026-10-06，用户决定）**："要手动触发不如直接用压缩指令"。pre-step 回归纯 critical 兜底；标记通道成为唯一的"模型建议"路径
- [x] **M3.6 标记闭环验收通过（2026-10-06 01:17）**：模型回复尾行带 `[cp:compact]` → 报告 `markerHits:1`，探针样本 `textTail` 精确截到 `…进 M4。\n\n[cp:compact]`——事件→类型→官方形状提取→后缀匹配→武装全链通；扫除门 11.2% < 20% 正确拒绝（设计行为）
- [x] **M3.6 E2E 实弹通过（2026-10-06 02:18）**：占用 22.8%（227,659）回复尾行写标记 → idle 即压：`lastAct.reason='marker'`、影子化 **471 节点 / 181,485 token**（seq 761–1952），引擎事件 `compaction/start→summary→end` 全见；下轮注入 **used 17,214 (1.7%)**。**全程未结束/未重拉会话**——同 session id 贯穿、就地折叠，详见 §6 M3.6 实弹记录
- [x] **M4 Config 面编码完成（2026-10-06 01:2x）**：`plugin-config.schema.mjs`（schemastery 四级候选链，独立解析验证 OK）+ entry 静态 `export Config`（薄壳备案例外）+ impl `M3_DEFAULTS` 与 apply 内 config 字段级合并（类型守卫，异常落默认）+ 报告 `m3.eff` 生效参数快照。**待重启验证**：① 重启后详情页出现配置区；② 改 `policyCardMinRatio` 等字段 → 报告 `m3.eff` 随变
- [x] M4 重启验证通过（面板卡片渲染 ✓ / policyCardMinRatio 0.1 保存且 host 生效 ✓ / 决策卡在场 ✓）
- [x] **M4.6 上下文弹窗开关上线（2026-10-06 10:2x，用户截图验收）→ M4 全部收官**：v3 aria 定位（`div[role=dialog][aria-label=上下文已用]`，asar 源码取证）+ MutationObserver + 1.2s 轮询兜底；中文名「上下文领航（注入+压缩）」+ 滑动开关（主题 token 自适应）；写入 `enabled` + 回读校验，host 四路即时受控。诊断陷阱已拆
- [x] **M5 弹窗 HUD 上线（2026-10-06 11:0x，已重启生效）**：弹窗开关行下新增 HUD 行——「最近压缩 HH:MM · 原因 · 省 xxK」+「武装中/演习」徽章；~~通道 = `configEditor.edit()`~~ **通道改判（12:2x）：configEditor 推送结构性不可用（见 §6 M5 改判），改为内存 + client 5s 轮询 `getHud()`（wire.host.mjs）**。空态已验收（用户截图）
- [x] **M5.5 任务挂起-自动恢复（2026-10-06 11:3x 首测）**：闭环四环中三环通（标记捕获 ✓ / 插件压缩 ✓ / 待执行捕获 ✓），**恢复环静默失败**——prompt 未被调到且旧版退出路径 log-only。已改多通道（sessionController.prompt → ctx.remote 代理 → 直通 createUserMessage+followup）+ 全程落报告（state.m55.attempts），见 §6 M5.5。**二测通过（11:57，通道 C 投递，闭环全通）**；**三测复现通过（12:26，通道 C，HUD 记录链同步实证）**
- [x] **只读审查 + 落地（2026-10-06 14:1x–15:0x）**：外部审查员按 `review-brief.md` 出 23 条（`review-findings.md`），**批次 1/2/3 全部落地**（host 21 处 + client 10 处，单次 toggle 热换）——含 1 个真 bug 修复向（A1 心跳泄漏、A2 失败重武装、A5 signal 守卫、C4 订阅/轮询泄漏、C5 空串存 0、B4 wire 静态缓存）。**⚠️ 追加发现（重大）：心跳自项目起从未运行**——真因是 `ctx.effect` 语义误用（清理语句内联在 execute 体内 ⇒ apply 期误清理当场清掉心跳 + 真卸载时零清理），已修复并验收（新实例心跳精确 120s 触发、旧实例热换后静默 307s）。见 §6。**未实施（挂起）**：D1 模块切分、D2 样板共享、B5 脚本收敛、C2 无界上限、C3② 报告瘦身、A6 计数清零。**待用户操作**：刷新页面（client.js 生效）

## 6. 里程碑

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


## 7. 成本模型（缓存命中率与费用影响）—— 2026-10-06 官方单价 + 本机实测校准

> 结论先行：**插件降低缓存命中率（百分比），但降低绝对费用**；且**在 GLM Coding Plan 上的收益约为 DeepSeek API 的 3.8 倍**。
> 两家计费结构相同（命中 / 未命中 / 输出 三段），故只需一套模型；差别在**命中与未命中的价格比**。

### 7.1 官方单价（均为官方文档原文，2026-10-06 取证）

| 口径 | 缓存命中 | 未命中 | 输出 | 命中:未命中 |
| --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash`（非高峰，$/1M） | **0.003** | **0.15** | 0.6 | **1:50** |
| DeepSeek `deepseek-v4-pro`（非高峰） | 0.022 | 0.66 | 1.98 | 1:30 |
| GLM-5.3（积分，系数/10000） | **1.7** | **6.9** | 24 | **1:4.1** |
| GLM-5.3-Flash（含视觉 MCP） | 0.56 | 2.3 | 8 | 1:4.1 |

- DeepSeek：高峰价为非高峰 2 倍（高峰 = 周一至周五 01:00–04:00 / 06:00–10:00 UTC）。
- 智谱积分公式（官方原文）：`积分 =（输入 Token × Input 系数 + 缓存命中 Token × Cached Input 系数 + 输出 Token × Output 系数）/ 10000`；
  非高峰（周一至周五 14:00–18:00 UTC+8 之外）按 **50%** 抵扣。
- **智谱的积分确为缓存感知**（原以为可能是一揽子费用——实测公式明确分段），故「DeepSeek API / 智谱积分」两类付费确实只需一套模型。

### 7.2 插件如何影响缓存命中率（三个作用点）

1. **每轮注入**（实测：`m1-report.json` 中 `m2.lastText`）
   变体三种：用量行 167–169 字符（纯 ASCII）／+决策卡 528 字符／+一次性说明 813 字符；约 **300–500 token/轮**。
   **不破坏前缀**：注入是**追加**在本轮 user 消息之后的新消息，历史消息一字节不改；DeepSeek 的前缀缓存要求「完整匹配缓存前缀单元」，而上一轮的 `[…, 注入_N]` 已持久化为单元 ⇒ 下轮命中。注入只是往尾部加少量未命中 token。
2. **压缩（核心功能）**：把旧消息重写为摘要 ⇒ **前缀整体变化** ⇒ 该轮上下文全部转为未命中。这是任何压缩（含官方 80% 阈值）都无法避免的一次性代价。
3. **净效果 = 命中率下降**（例：原生 80% 阈值 ⇒ 平均 415K 上下文、命中率约 96.9%；插件早压至 150K ⇒ 平均 90K、命中率约 85.6%）。
   **但命中率是分母游戏**——上下文越小，固定新增内容的占比天然越高。**只看命中率会得出错误结论，必须看绝对成本。**

### 7.3 关键解析结论

**① 压缩的摊销成本 ≈ 新增内容 × 未命中单价，与阈值几乎无关。**
摘要调用要读完整上下文（∝ 阈值），但压缩间隔也 ∝ 阈值，两者相消：
DeepSeek `6767 × $0.15/1M ≈ $0.0010/段`；GLM-5.3 `6767 × 6.9/1e4 ≈ 4.7 积分/段`。
⇒ **「压得勤 ⇒ 摘要调用多 ⇒ 更贵」是错的**，摊销后近似持平。**全部收益来自上下文规模**。

**② 上下文规模对两家的杀伤力差 2 倍以上**（本机实测增速 6.8K token/段）：

| 上下文 | DS flash $/请求 | GLM-5.3 积分/请求 | 相对 90K：DS | 相对 90K：GLM |
| --- | --- | --- | --- | --- |
| 30K | 0.00108 | 8.6 | 0.86 | 0.46 |
| 90K | 0.00126 | 18.8 | 1.00 | 1.00 |
| 285K（本会话） | 0.00185 | 52.0 | **1.46** | **2.76** |
| 600K | 0.00279 | 105.5 | 2.21 | 5.61 |
| 850K | 0.00354 | 148.0 | 2.80 | 7.87 |

**结构占比（285K 上下文）**：DS「重读上下文」仅占单请求成本 **45%**；GLM 占 **91%**。
⇒ GLM 上上下文是**持续失血**，DeepSeek 上则相当便宜——这就是两家最优阈值不同的根因。

**③ 一次真实压缩的收益**（07:29 实测：285,059 → 23,659，省 261,400 token / -92%）：
- 此后**每个请求**省：DS `$0.00078`；GLM-5.3 `44.4 积分`；GLM-Flash `14.6 积分`
- 按 R=5 请求/轮、约 39 轮回填到压缩前水平：累计省 DS `$0.153`、GLM `8,665 积分`
  （**≈ Pro 套餐 12,000 积分/5h 的 72%** —— 一次压缩就换回大半个额度窗口）

**④ 还有一个放大因子（未计入上表）**：agentic 会话里**每轮用户输入触发多次 LLM 请求**（工具调用循环），每次都重读整个上下文。故实际收益需乘 R（本机估计 R≈5，视任务而定）。

### 7.4 阈值 → 成本弹性（实测校准）

| 阈值 | 平均上下文 | DS $/请求 | 相对 0.15 | GLM-5.3 积分/请求 | 相对 0.15 |
| --- | --- | --- | --- | --- | --- |
| 0.15 | 88K | 0.00126 | 1.00 | 18.4 | 1.00 |
| 0.20 | 113K | 0.00133 | 1.06 | 22.6 | 1.23 |
| 0.30 | 163K | 0.00148 | 1.18 | 31.1 | 1.69 |
| 0.50 | 263K | 0.00178 | 1.42 | 48.1 | 2.62 |
| 0.80 | 413K | 0.00223 | 1.78 | 73.6 | 4.00 |

（假设：压缩在阈值触发、压后回落至约 25K；平均上下文取两者中值。）
⇒ 阈值 0.15 → 0.30 时 **DS 仅涨 18%，GLM 涨 69%**。**同一组阈值，GLM 上的钱效约为 DS 的 3.8 倍。**

### 7.5 推荐配置（面板备注已写入两套值，见 `client.js FIELDS[].hint` / `plugin-config.schema.mjs`）

| 字段 | DeepSeek API | GLM Coding Plan | 理由 |
| --- | --- | --- | --- |
| `criticalRatio` 危险线 | **0.85** | **0.80** | 命中便宜 ⇒ DS 可晚压；GLM 早压省额度 |
| `markerMinRatio` 标记最低占用<br>（**同时是决策卡门槛**） | **0.30** | **0.15–0.20** | DS 需 3 倍价差才抵一次多余压缩的信息损失；GLM 压早直接换额度 |
| `sweepMinIntervalMs` 兜底间隔 | 600000 | 600000 | 与口径无关 |
| `armedTtlMs` 武装有效期 | 120000 | 120000 | 与口径无关 |

**共同原则**：不要把阈值调得过低去追命中率——**过度压缩导致模型重读文件/重跑命令的返工成本，远超省下的 token**。
本插件把决策交给模型（政策卡教它判断「任务是否还依赖早期细节」）而非无条件自动压缩，正是为此。

### 7.7 决策卡门槛并入 `markerMinRatio`（2026-10-07，用户发现的设计缺陷）

**缺陷**：原先 `policyCardMinRatio`（教学门槛）与 `markerMinRatio`（执行门槛）是两个独立参数，产生不可达区间：

| 区间 | 有卡？（教写标记） | 能执行？ | 结果 |
| --- | --- | --- | --- |
| `[0, policyCardMinRatio)` | ❌ | ✅（若 ≥ markerMin） | **模型不知道标记存在 ⇒ 永远不写 ⇒ 死区** |
| `[markerMinRatio, policyCardMinRatio)`（marker < card 时） | ❌ | ✅ | **同上：区间完全不可达** |
| `> policyCardMinRatio` 且 `> markerMinRatio` | ✅ | ✅ | 正常 |

即推荐值 `marker 0.30 / card 0.35` 里，`[0.30, 0.35)` 是**永远不会有任何行为**的死区；
反之若 `marker > card` 则错配（教了却不执行）。

**修法**（用户决定）：**删除 `policyCardMinRatio` 配置项，代码统一走 `决策卡门槛 = markerMinRatio`**。
语义变成「**能收到卡 = 标记有效**」，无论用户怎么填都不会出现死区或错配。
- host：`renderPolicyCard` 改读 `M3.markerMinRatio`；`mergeConfig` 不再读取该键（旧 config 残留键静默忽略）
- client：`FIELDS` 删除该行；`recommendFromPrice` 不再产出 `card`；「一键填入」只写 2 项
- schema：`plugin-config.schema.mjs` 删除该字段定义
- 弹窗阈值速览行改为「标记最低占用(含决策卡) X% ｜ 危险线 Y%」

> 校验（07:54 热换后）：`m3.eff` 已无 `policyCardMinRatio` 键，`markerMinRatio=0.15` 保留。

### 7.6 面板内置计算器（2026-10-06 新增，`client.js` PriceCalculator）

配置区**下方**新增「成本阈值计算器」——把手算变成随单价实时推导：

- **预设按钮**（官方单价一键填入）：DeepSeek flash/v4-pro、GLM-5.3/5.3-Flash、Kimi K3、千问 3.8-Max/3.8-Flash、阶跃 step-5（全 ¥ 口径，GLM 为积分）
- **三个输入**：缓存命中价、未命中价、输出价（手改即退出预设高亮）
- **诊断行**：命中:未命中比值、上下文项占单请求成本 %、估算单请求成本
- **推荐行**：`markerMinRatio`（含决策卡）/ `criticalRatio` + 判语
- **「一键填入并保存」按钮**：写入推荐字段（走与上方表单完全相同的 `persist → writeField` 路径，
  含命名空间 `set` + **回读校验**；未变化的字段自动跳过）。失败提示（未就绪/未持久化）与手工保存一致。

**推导模型**（与 §7.3/§7.5 同一套，锚点取**实测** ctxShare 而非理想值，故能复现上表）：

```
ctxShare       = (上下文 - 新增)·命中价 / [(上下文 - 新增)·命中价 + 新增·未命中价]     // 参考占用 35%，新增 6.8K
markerMinRatio = lerp(ctxShare, 0.50→0.93, 0.30→0.15)    夹逼 [0.12, 0.40]
cardMinRatio   = markerMinRatio + 0.05                    夹逼 [0.15, 0.50]
criticalRatio  = lerp(ctxShare, 0.50→0.93, 0.85→0.80)    夹逼 [0.75, 0.90]
```

| 预设 | ctxShare | 计算器输出（marker / card / crit） | 对照 §7.5 |
| --- | --- | --- | --- |
| DeepSeek flash | 50% | 0.30 / 0.35 / 0.85 | ✅ 一致 |
| DeepSeek v4-pro | 63% | 0.26 / 0.31 / 0.84 | 新增 |
| GLM-5.3 | 93% | 0.15 / 0.20 / 0.80 | ✅ 一致 |
| GLM-5.3-Flash | 92% | 0.15 / 0.20 / 0.80 | 新增 |

**边界已校验**：`0`/负数/缺失 → 提示「请输入有效的正数价格」不写入；极端比值（1:1e6）夹逼到上下限；
推荐值恒落在 host `mergeConfig` 的范围守卫内（比率类 [0,1]）。计算器单元测试（判据从 client.js 抽取）覆盖
「未变跳过」⇒ 已应用时 `written=0`。

> 说明：上表「每请求成本」由**官方单价 + 本机实测注入量/增速**建模；R（每轮请求数）为估计值。
> **方向性结论（命中率降、绝对成本降、GLM 收益远大于 DS）对参数不敏感。**

## 8. 已知设计风险（开发前必读）

1. ~~**`isolate: { compaction: true }` 作用域**~~ **已解决（2026-10-06）**：顶层 ctx 无 compaction（实测 absent），但 `agentPresets.serviceFor(agent, 'compaction')` 可达目标 agent 作用域实例（运行时探针实证）。
2. ~~**Session 句柄**~~ **已解决（M1）**：`ctx.sessions.list()` / `agents.list()`；`agent.session` 持 Session。
3. **compactNow 需要 agent 上下文**：已明确——就传 Agent 本体；但**必须 idle** + **signal 必传**（见 §6 M3）。
4. **CJK 计数低估**：占用比是估计值，决策阈值要留余量。
5. **激活安全**：插件 apply() 内任何异常只记录不抛（DSH 纪律：抛 = 条目装载失败）。参考 browser-kit 的 entry 薄壳 + impl mtime 热换模式（`F:\My Code\dsh-browser-kit\plugin\entry.mjs`）。

## 9. 部署（M1 第一步）—— 2026-10-05 已做两轮，第二轮补齐 bundle 资格

```powershell
# 已做：profile package.json dependencies/bundles 均加 @local/dsh-context-pilot
#       （改前备份：package.json.bak-20261005-m1-context-pilot）
# 已做：node_modules\@local\dsh-context-pilot Junction → F:\My Code\dsh-context-pilot\plugin
#       （与 browser-kit 同款手工 Junction，未跑 pnpm install）
# 第一轮重启结果：not-bundle 静默跳过（见 §4 P1）
# 已补：plugin/package.json 加 dsh.bundle 段 + plugin/cordis.patch.yml（insert 行）
# 第二轮重启：✅ 挂载成功，list_bundles 无 error，M1 验证通过
# 免重启热换（P3，2026-10-06 实证）：改 host.impl.mjs 后用会话工具 plugin_manager
#   set_plugin target="include:dsh-context-pilot"（⚠️ 必须 entry id 形式；bundle 名报 unknown-plugin）
#   先 enabled:false 再 enabled:true → apply 重跑 → mtime URL 换新 impl。
```

## 10. 参考资料索引

- `docs/context-control-exploration.md` —— 探索报告全文
- `docs/reference/*` —— 从 app.asar 抽取的官方包（compaction-basic README 含全部配置字段与压缩机制；token-meter README 含测量语义）
- `docs/reference/tools/asar-extract.cjs` —— asar 文件抽取脚本（改 WANT 列表即可抽任意源码；asar 路径 `D:\DeepSeek\resources\app.asar`）
- 运行时查询：会话工具 `cordis_inspect_list` / `cordis_inspect_query`（host Service 目录）
- 相关经验：`F:\My Code\dsh-browser-kit\pitfalls.md`（P30/P37/P38 等）；浏览器增强插件本体 `F:\My Code\dsh-browser-kit\`

## 11. 验收标准（项目完成定义）

1. 每轮 prompt 含实时用量三元组（上限/已用/占比），模型可正确复述；
2. 高占用 + 轻任务场景下，插件自动先压缩再执行，压缩事件出现在会话日志；
3. 低占用或重任务场景不误触发压缩；
4. 自身阈值可经 Config 配置，改后重启生效；
5. 插件任何异常不影响 DSH 主流程（激活安全零抛）。
