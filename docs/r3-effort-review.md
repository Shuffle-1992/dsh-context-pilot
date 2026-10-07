# R3 Review：智能思考（effort）全面审查 · 简化 · 优化 · 解耦

> 状态：**审查完成，待实施**（2026-10-08）。审查对象 = R1+R2 引入的全部 effort 相关代码。
> 结论：功能已闭环可用（E2E 实证 `applied:true`），但**结构与命名有明确的债**，且已因耦合
> 产生过一个真 bug（懒安装塞在 `step !== 1` 早退之后 ⇒ 工具接受却永不变档）。

---

## 1. 现状清单（代码分布）

### host.impl.mjs —— 散落 13 处、约 520 行

| # | 位置 | 内容 | 行数 |
|---|---|---|---|
| 1 | L62-65 | `M3_DEFAULTS.effortEnabled` | 4 |
| 2 | L281/285 | `mergeConfig` 读 effortEnabled | 2 |
| 3 | L613 | `state.m2.effortBriefings/briefReissues/effortSuffixes` | 1 |
| 4 | L633-641 | `state.m3.effort*` 九个取证字段 | 9 |
| 5 | L691-731 | `readEffort(agent)` 读当前档 + 异步枚举可选档 | 41 |
| 6 | L750-761 | 四个 Map + 冷却常量 | 12 |
| 7 | L773-880 | `installEffortRequestHook` agent/request 钩子 | **108** |
| 8 | L884-901 | `ensureEffortHooks` 懒安装 + 取证 | 18 |
| 9 | L903-1035 | `registerEffortTool` 工具定义 + execute | **133** |
| 10 | L1037-1049 | `loadDefineTool` 加载 + 注册 | 13 |
| 11 | L1610-1648 | `renderEffortBrief` + `renderEffortSuffix` | 39 |
| 12 | L1660-1700 | pre-step 注入接线 + 懒安装调用 | 41 |
| 13 | L~1750 | `getHud` effort 载荷 + cooldownUntil | 12 |

### 其他文件

| 文件 | 内容 |
|---|---|
| `wire.host.mjs` | getHud 签名里塞了 effort 结构（含 cooldownUntil） |
| `client.js` | FIELDS 一项 + 弹窗开关 + `EffortChip`（~120 行）+ CSS（~10 行） |
| `test/contract.mjs` | §6.9 / §6.10 / §6.12 / §6.13 共 ~60 断言 |
| 文档 | r1-effort-design / r1-reasoning-effort-investigation / r2-tool-switch-design |

**host.impl.mjs 总行数 2298，其中 effort 占约 23%。** 而 D1 模块切分的任务书早已就位。

---

## 2. 缺陷清单（按严重度）

### 🔴 S1 遗留命名混乱（R1 已废弃，名字却全留着）

**文本标记方案已在 R2 整体废弃**，但代码里到处是 R1 的名字：

| 现状 | 问题 |
|---|---|
| 日志 `R1 换档让位` / `R1 换档忽略` / `R1 换档应用` / `R1 安装...` | 实际是 R2 工具方案，日志前缀误导 |
| `schedule('r1-effort', 400)` | reason 名 `r1-effort`，功能已是 R2 |
| `state.m3.effortMarkerHits` | **已死字段**：标记解析已移除，永不自增（实测恒 0） |
| `state.m3.lastEffortMarker` | 名字误导：工具路径写入的其实是 tool 事件 |
| 注释混着 R1/R2 两套说明 | 读者无法判断哪条是现行契约 |

**⇒ 影响**：新读者（或未来的我）会以为还有文本标记机制，浪费排查时间。

### 🔴 S2 两个巨型函数（108 行 / 133 行）

`installEffortRequestHook`（108 行）一个函数内干了 7 件事：
sid 解析 → pending 查找 → foreign 判定 → 档位校验 → 应用 → 计数 → 取证/日志

`registerEffortTool`（133 行）把「工具定义（schema/description）」与
「执行逻辑（校验/冷却/写 pending）」混在一起。

**⇒ 影响**：S3 的重复逻辑就是从这里长出来的。

### 🟠 S3 三处重复逻辑（可各抽一个函数）

**① sid 解析重复 3 次**
```js
String(pick(agent.session?.id, agent.sessionId, agent.id, ''))     // hook
String(pick(agent.session?.id, agent.sessionId, agent.id, ''))     // tool execute
String(pick(agent.session.id, agent.sessionId, 'unknown'))         // pre-step 注入
```
→ 抽 `sidOf(agent, fallback)`

**② 档位校验重复 2 次**
```js
const opts = Array.isArray(eff?.efforts) ? eff.efforts : null;
if (opts && !opts.includes(pend.effort)) { ...invalid... }   // hook
if (opts && !opts.includes(want)) { ...invalid... }          // tool
```
→ 抽 `checkEffort(eff, want)` 返回 `{ok, reason}`

**③ 跳过计数重复 5 次**
```js
state.m3.effortSkips = state.m3.effortSkips ?? {};
state.m3.effortSkips.X = (state.m3.effortSkips.X ?? 0) + 1;
```
→ 抽 `bumpSkip(kind)`

### 🟠 S4 懒安装耦合进 M2 注入分支（**已因此产生真 bug**）

```js
// 现状：两件事挤在同一个 pre-step 分支里
if (M3.effortEnabled === true) {
  ensureEffortHooks();   // ← 曾放在 step!==1 早退之后 ⇒ 钩子永不安装
  registerEffortTool();  // ← 同上
}
if (step !== 1) return decision;   // ← 每轮只有 step 1 能过
```

**实测故障**：一轮首步就调工具 ⇒ 后续 pre-step 的 `step` 恒 > 1 ⇒ 钩子永远装不上
⇒ `effortToolCalls=1` 而 `effortSwitches=0`（工具接受成功却永不变档）。

**已临时修复**（把懒安装上移到早退之前），但**结构性问题仍在**：
「effort 的安装」与「M2 的每轮注入」本无关系，却共用一个分支 ⇒ 日后任何
早退条件改动都可能再次静默破坏 effort。

### 🟡 S5 `readEffort` 返回类型不一致（同步对象 / Promise 混用）

```js
if (!cfg?.provider) return { ok:false, error:'no-route' };   // 同步返回
...
return Promise.resolve(p.value).then(...)                     // 异步返回
```
调用方必须 `await`，但**读代码时看不出它可能是 Promise**；若某处漏 await，
会拿到 Promise 当对象用（`eff.ok` 恒 undefined）⇒ 静默失效。

→ 改为 `async function readEffort()`，全路径 `return`。

### 🟡 S6 状态分散在三张 Map + 语义相关却分离

```js
pendingEffortBySid    // 期望档位（持久）
effortSwitchAtBySid   // 冷却基准时间
appliedEffortBySid    // 我们上次写入的档（区分 foreign）
```
三者都按 sid 索引、生命周期一致，却各自维护、各自 delete（漏删会留孤儿）。
→ 合并为 `effortStateBySid: Map<sid, {want, switchedAt, applied}>`。

### 🟡 S7 冷却时长硬编码

`const EFFORT_SWITCH_MIN_MS = 30_000;` —— 用户此前问过「要不要放进面板」，
当前无法配置。作为「会实际影响计费（缓存失效）」的参数，应当可配。

### 🟢 S8 工具 output schema 过宽（7 字段）

`ok/effort/applied/error/options/cooling/remainSec` —— 字段多且语义重叠
（`cooling` + `remainSec` 其实可并进 `error` 文本；`applied` 只有两个取值）。
→ 收敛为 `{ok, effort?, error?, options?}`，把冷却剩余写进 error 文案。

### 🟢 S9 客户端开关状态与应用状态混在同一字段

client 靠 `getHud.effort.ok` 推断「智能思考是否开启」——但 `effort.ok=false`
既可能是「开关关闭」（host 返回 null）也可能是「读档失败」。
→ host 显式返回 `effortEnabled` 布尔，与 `effort` 数据分离。

### 🟢 S10 取证字段冗余

`effortEnsure`（calls/enabled/lastAgents/lastResults/at）—— 5 字段仅用于一次性排查。
`effortHookError`（5 字段）同理。
→ 可合并进一个 `effortDiag` 对象，或降级为日志（保留最后一发即可）。

---

## 3. 解耦方案（核心建议）

### 3.1 抽成独立模块 `plugin/effort.mjs`（推荐，与 D1 切分同向）

智能思考是一个**内聚的功能域**：配置 + 状态 + 读取 + 钩子 + 工具 + 注入文本 + HUD 载荷。
它与其他模块（M2 注入、M3 压缩、M5 HUD）的耦合点**只有 4 个**：

```
effort.mjs 对外接口（窄接口，4 个）
  ├─ createEffort({ svc, log, tryOf, pick, msg, state, readConfig })   ← 依赖注入
  ├─ readEffort(agent)            → {ok, provider, model, current, efforts, adapterDefault}
  ├─ ensure(agent)                → 幂等安装钩子 + 注册工具（**不再由 pre-step 分支决定时机**）
  ├─ renderBrief(eff) / renderSuffix(eff)  → 注入文本（纯函数）
  └─ hudPayload(agent)            → getHud 的 effort 字段（含 cooldownUntil）
```

**收益**：
- host.impl.mjs 立即减 ~500 行（2298 → ~1800）
- S4 的结构性耦合消失：`ensure()` 由**激活时**调用一次 + pre-step 兜底，与注入分支解耦
- S1/S2/S3 在同一文件内顺手清理
- 与 D1（模块切分）方向一致，是这个大文件的第一刀

### 3.2 若暂不抽模块（保守替代）

至少做三件事：
1. **把 `ensureEffortHooks` 从 M2 注入分支彻底移出** → 改在 `apply()` 激活时调度一次
   （`schedule('effort-init', 0)`），pre-step 只保留「注入文本」职责
2. 抽 `sidOf` / `checkEffort` / `bumpSkip` 三个小函数（消 S3）
3. 命名统一：全部 `R1` → `R2`（或去版本号，用 `effort.` 前缀），删 `effortMarkerHits`

---

## 4. 实施顺序（建议）

| # | 动作 | 风险 | 可独立验证 |
|---|---|---|---|
| 1 | 命名统一 + 删死字段（S1/S10） | 极低 | ✅ 测试 + 报告 |
| 2 | 抽 `sidOf`/`checkEffort`/`bumpSkip`（S3） | 低 | ✅ 测试 |
| 3 | `readEffort` 改纯 async（S5） | 低 | ✅ 测试 |
| 4 | 三 Map 合并为单状态对象（S6） | 中 | ✅ 测试 + E2E |
| 5 | 懒安装移出注入分支（S4） | 中 | ✅ E2E（这次是修结构，不是修 bug） |
| 6 | 拆两个巨型函数（S2） | 中 | ✅ 测试 |
| 7 | **抽 `effort.mjs` 模块（3.1）** | 中高 | ✅ 全套测试 + E2E |
| 8 | 冷却可配（S7）/ output 收敛（S8）/ 开关字段分离（S9） | 低 | ✅ |

**每一步都保持测试全绿 + 可单独提交**（本项目纪律：断言先行、绊线实测有效）。

---

## 5. 必须保留的「来之不易」结论（重构时勿丢）

重构最容易把这些**实证结论**当冗余删掉——它们每一条都是踩坑换来的：

1. **`prepend: true` 必须保留**：官方 `installModelSelection` 在**同 seam 外层**，
   会 `delete reasoningEffort` 再套回持久化值 ⇒ 非最外层必被剥掉（实测 `applied:true` 却无效）
2. **pending 必须持久**（不能一次用完就删）：正因每轮都被内层打回，才需每轮覆盖
3. **冷却基准只在真变化时更新**：否则每轮刷新 ⇒ 冷却永远「刚换过」⇒ 后续换档全被挡
4. **`effortSwitches` 只在真变化时自增**：否则变成「请求次数」，失去取证意义
5. **工具不抛错**（非法档/冷却返回结构化错误）：抛错会中断本轮
6. **`agent/request` 侧必须校验**：非法档会让 llm 抛 `UNSUPPORTED_REASONING_EFFORT` 中断请求
7. **`agent.ctx` 注册**（不是插件 global）：`agent/request` payload 里**没有 agent**
8. **档位动态取**：同 model id 不同 provider 档位不同（trae=`low/high/xhigh`，workbuddy=`off/low/high/max`）
9. **懒安装必须早于 `step !== 1` 早退**（或彻底移出该分支）——已因违反此条产生真 bug
10. **删除 `maxTokens`**：不把上个 adapter 的 cap 钉到新档

---

## 6. 待用户确认

1. **是否现在抽 `effort.mjs` 模块**（方案 3.1，中高风险但收益最大）？还是先做 3.2 保守版？
2. **冷却时长是否放进面板**（S7）？
3. 重构是**一轮做完**（1-8），还是**分两批**（1-4 结构清理 → 5-8 模块抽取）？

我的建议：**先做 1-5（结构清理，低风险、可独立验证），再做 6-8**。
`effort.mjs` 抽取放到最后，因为它与 D1 是同一件事，可以合并成一刀。
