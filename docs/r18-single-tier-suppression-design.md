# R18 设计：单档模型下的「零注入 + 工具静默」（含开关联动）

> 状态：**设计定稿，待实现**（2026-10-13）。所有机制均有实测或源码证据，逐条标注来源。
> 取证：[`plugin/.data/r18-probe.json`](../plugin/.data/r18-probe.json)（只读观测）、
> [`plugin/.data/r18-restrict.json`](../plugin/.data/r18-restrict.json)（写探针，禁→验→立即回滚）。

## 0. 目标（用户原话）

> 「如果所选模式没有多个档位可行，并排除 Default 这个项目，比如只有一档 High，
> 就不往提示词内注入切换档位的相关内容，尽量少 token，并随时切换到有多个档位的模型时，
> 又能第一时间注入。」

三条硬目标：
1. **无可切档 ⇒ 文本零注入**（后缀 / 一次性教学 / 换档提醒 / 压缩回执里的换档提示，四处全静默）。
2. **无可切档 ⇒ 工具不下发**（省得最多的一笔，见 §1 成本表）。
3. **切到多档模型 ⇒ 当轮恢复**（不丢教学、不丢工具、不晚一轮）。

**非目标**：不做「自动选档」（那是 router-laya 的路线，用户未要）；不动 client chip；不新增配置项。

## 1. 成本结构（实测字符数，决定优先级）

| 层 | 成本 | 下发时机 |
| --- | --- | --- |
| **工具 schema**（`set_reasoning_effort`） | description **366** + 参数说明 **51** 字符 | **每一次请求**（`toolUpdate === undefined`，无 adapter 声明 ⇒ 全量重发） |
| 每轮后缀 | 60 字符（四档时） | 每轮 step 1 |
| 一次性教学 | 754 字符 | 会话首次（压缩后重讲） |
| 换档提醒 | 99 字符 | 有信号时（限量） |

⇒ 只压文本收益有限，**必须连工具一起收**。

## 2. 实证依据

| 事实 | 来源 |
| --- | --- |
| `agent.ctx.get('tools')` 可取到工具服务（走 `ctx.get` 成功） | 只读探针 `r18-probe.json` |
| `restrict({deny:[TOOL_NAME]})` 生效：`wireSchemas` **70→69**、`visible:false`、`resolveExecution → undefined`（模型直呼 ⇒ `UNKNOWN_TOOL`） | 写探针 `r18-restrict.json` |
| **只影响该 agent**：`view(undefined).visible` 仍含该工具（全局层不受影响） | 同上 |
| `disposer()` 后完全恢复：**69→70**、`get` 复位 | 同上 |
| 限制作用于 `visible`，不动 `restrictableNames` ⇒ **重复 restrict 不抛错**（幂等安全） | 同上 |
| `restrict()` 只能在 **agent.ctx** 作用域调用；只过滤「继承面」，自己层注册的工具豁免 | `dsh-tools` L2895-2910、L2944-2946 |
| 工具名必须已在**全局层**注册，否则 `restrict` 抛「unknown global tool」 | `dsh-tools` L2906-2908 |
| `register()` **返回精确 disposer**（当前代码把返回值扔了） | `dsh-tools` L2876-2887 |
| 模型可见的工具清单 = `wireSchemas(scope).schemas` | `dsh-tools` L2707 → `systemPrompt.tools(ctx => wireSchemas(ctx.scope))` |
| 两侧 `tools` **不是同一 JS 对象**（`sameInstance:false`）⇒ 幂等判断不能靠引用 | 只读探针 |

## 3. 设计

### 3.1 判据（单一真相，纯函数）

```js
// effort.mjs：canSwitch(eff) —— 文本出口与工具可见性都只读它
real = unique(eff.efforts 中 id 不等于 'default' / '默认'（忽略大小写）的项)
canSwitch = true   仅当 real.length >= 2
canSwitch = false  仅当 efforts 是**已知非空数组**且 real.length <= 1
其余（null / [] / 取不到 / resolveModelInfo 抛错）⇒ canSwitch = true（保守）
```

- **只剥 `default`/`默认`**：不剥 `auto` 之类——误剥会把真档位算没，代价是能力丢失。
- **未知 ≠ 没有**（R7 结论）：取不到可选项时**绝不抑制**；最坏多花 token，绝不锁死能力。

### 3.2 文本四出口（全部走同一判据，每轮现算、无状态）

| 出口 | 抑制时 |
| --- | --- |
| `renderSuffix`（每轮后缀） | 返回 `null` ⇒ 用量行只剩占用读数 |
| `renderBrief`（一次性教学） | 返回 `null`，**且不标记已讲**（现成逻辑：只在真注入时才 `remember`）⇒ 切多档后当轮重讲 |
| `renderNudge`（换档提醒） | 返回 `null` |
| **`m2.renderCompactReceipt` 的换档提示**（R16.8） | 整句去掉（这是最容易漏的一处：在 m2 不在 effort 域） |

### 3.3 工具可见性：`restrict` + **持久句柄** + **清扫**

```
每个 step： agent/pre-step（监听器最前面）
  ├─ reconcile(agent)：路由键未变 ⇒ 同步快速返回（零异步）
  │   变化时：read(agent) → canSwitch → 需要隐藏则 restrict，需要恢复则 dispose
  └─ （均在 assemble 之前 ⇒ 当步生效）
```

**热换残留陷阱（本方案最关键的一条）**：`restrict` 的 effect 挂在 **agent fiber** 上，
**插件 toggle 不会清掉它**。若新实例想恢复却拿不到旧 disposer ⇒ 工具永久隐藏 = 静默能力丢失。

三层对策：
1. **持久登记**：disposer 存进进程级注册表
   `globalThis[Symbol.for('dsh-context-pilot/effort-restrict')] = new WeakMap()`（键 = agent）。
   跨热换存活；WeakMap 随 agent 回收，不泄漏。
2. **自愈清扫**：**激活期**与**关闭功能时**遍历 `agents`，释放注册表里的全部残留 disposer（幂等）。
3. **失败极性铁律**：拿不到可持久化的回滚句柄（登记失败 / 对象异常 / restrict 抛错）⇒ **不隐藏**。
   宁可多花 417 字符/请求，绝不制造不可逆的隐藏。

### 3.4 与两个开关的联动（**本轮新查出的缺口，纳入 R18**）

**现状（实测代码路径）**：

| 开关 | 行为面是否生效 | 工具面 |
| --- | --- | --- |
| 智能压缩 `enabled` | ✅ 注入（host 早退）、压缩（`m3.compact.mjs` L298/L502）、工具执行（返回「未开启」） | ❌ **关闭后 `compact_context` 仍在工具清单里**（`registerTool` 只注册、永不撤回；`tools.register` 的 disposer 被丢弃） |
| 智能思考 `effortEnabled` | ✅ 注入（m2 判据）、换档应用（`applyTo` 首行 `enabled()`）、工具执行（返回「未开启」） | ❌ 同上：`set_reasoning_effort` 若曾被注册，关闭后**仍在下发** |

⇒ 与开关自己的承诺冲突（「关 = 两者都不做」/「关闭后完全恢复原生 DSH」），且**每请求白付 schema 成本**。

**R18 要做的事**：
- 捕获 `tools.register()` 的返回 disposer（现在被丢弃）；
- 开关关闭 ⇒ **dispose 全局注册** + **清扫所有 agent 的 restrict**；开关打开 ⇒ 重新注册（幂等）；
- reconcile 的键要含 **开关状态**（否则翻转开关不会触发重评）。

**顺带修一处顺序缺陷**：host pre-step 里 `mergeConfig()` 发生在 `ensureEffort()` **之后**
（`effEnabled()` 才调 merge）⇒ 开关翻转后的**第一步**，`ensure()` 读到的是旧值（工具/钩子晚一步生效）。
修法：pre-step 最前面显式 `mergeConfig()`。

### 3.5 时序与一致性保证

- reconcile 挂在**现成的** `ensure()`（每步调用、幂等），不新增监听器；
  只要在 pre-step 阶段内完成，就早于 `system-prompt/assemble`，与「排第几」无关。
- **快路径**：以 `provider|model|enabled` 为键，未变即同步返回；只有变化时才走异步 `resolveModelInfo`。
- **与 R17 协同（目标③的关键）**：`read()` 已优先读投影 `pending`，所以「UI 换模型、header 未更新」的
  **第一轮**判据看到的已是新模型 ⇒ 文本与工具**当轮**恢复。⚠️ 实现时**不得回归 R17**。
- **判据一致性**：同一轮里工具可见性与文本出口必须同源；不一致（判据说可切但 `view` 无工具，
  例如外来 restrict）⇒ 记一条痕，便于一眼定位。

### 3.6 留痕（静默失效必须可诊断）

`state.m3.effortGate = {at, sid, model, efforts, real, canSwitch, why}`；
计数 `effortRestrict` / `effortRestore` / `effortSweep` / `effortRestrictError`。

## 4. 测试计划（静态 + 行为级 + 变异）

**行为级**（真跑模块，桩 llm/tools）：
1. `['high']` ⇒ 文本四处全静默；
2. `['off','low','high','max']` ⇒ 四处输出与今天**逐字一致**（零回归，最重要）；
3. `efforts` 为 `null` / `[]` / 抛错 ⇒ **不抑制**；
4. `['default']`、`['default','high']` ⇒ 抑制；`['default','low','high']` ⇒ 不抑制；
5. reconcile 幂等：同键不二次 restrict；路由变化 ⇒ dispose **恰好一次**；
6. restrict 抛错 ⇒ 工具保持可见 + 留痕 + 可重试；
7. **自愈**：注册表预置「上一实例残留」⇒ 激活/关闭时清扫；
8. **开关联动**：`effortEnabled=false` ⇒ 工具注册被 dispose；开回 ⇒ 重新注册且只注册一次；
9. **R17 协同**：pending 多档 + header 单档 ⇒ 判据按多档（当轮恢复）。

**变异**（每条必须 CAUGHT）：判据边界 `>=2`→`>=1`、未知改判抑制、去掉回执门控、
持久注册表换成模块内 WeakMap、去掉路由快路径（二次 restrict）、去掉「无句柄不隐藏」兜底、去掉开关联动。

**真机 E2E**：当前四档模型 ⇒ 零变化；切单档模型（如 `workbuddy/hy4-preview-f`）⇒ 后缀消失 + 70→69；
切回四档 ⇒ 当轮恢复；单档状态下 toggle 插件 ⇒ 自愈；关闭智能思考 ⇒ 工具退出清单。

## 5. 部署与回滚

- 改动：`effort.mjs`、`m2.inject.mjs`、`host.impl.mjs`（+ compact-tool 的开关联动，若采纳 §6-③）；
- 生效：**toggle 热换**（entry 不动，无需重启/刷新）；
- 回滚：单次 commit 可整体 revert；无持久化格式变更（注册表是内存态）。

## 6. 待用户拍板

1. **compact_context 是否一并做开关联动**（同一个 disposer 机制，改动很小；不做则「关闭智能压缩」仍白付它的 schema）。
2. **面板是否加「当前模型无档可切（已静默）」提示**（需改 client.js ⇒ **要刷新页面**；不改则用户可能疑惑「开关开着为什么不提档位」）。
3. **版本**：作为 **v0.1.3**（R18）发版并打 tag？
