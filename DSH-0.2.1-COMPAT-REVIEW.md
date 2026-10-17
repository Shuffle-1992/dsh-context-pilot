# dsh-context-pilot — DSH 0.2.1-rc.1 兼容与优化评估

> 生成：2026-10-17 ｜ 作者：标准模式 DSH 会话
> **基线**：DSH `0.2.0-rc.2`（当前运行，**尚未更新**）→ **目标**：`0.2.1-rc.1`
> 排查方式：静态代码扫描（排除 `node_modules` / `test` / `.data`）+ 官方包对比（npm `0.2.1-rc.1` vs 当前 `app.asar` 内 `0.2.0-rc.2`）+ 本机实测

---

## 一、结论速览

| 项 | 结论 |
|---|---|
| 破坏性冲突 | **0 项** |
| 必须处理 | **1 项** —— 缺 `engines.dsh` 声明 |
| 高度建议处理 | **1 项** —— 与官方 `/compact` / 自动压缩**共用同一持久锁**，需感知避让（否则撞 `busy`） |
| 建议优化 | **3 项** —— 阈值对表 / 感知手动压缩 / 用 `registerMessageProjection` 落自己的会话记录 |
| ⚠️ 撤回 | **上轮"可迁到官方 Session 状态记录接口"的说法不成立**（该 API 对外部插件禁用，见 §四） |
| 更新后风险 | **低**，但这是 4 个插件中**与 0.2.1 改动耦合最深**的一个 |

> ### 🔍 独立复核（2026-10-17，另一会话用逐包 diff 复核）—— 结论方向一致，但有 6 处修正/补强
>
> 复核方式**更强**：从 npm 拉 `0.2.1-rc.1` 的包，与 `app.asar` 里抽出的 `0.2.0-rc.2` **逐文件 diff**，
> 而不是只读发布说明。详见 **§七**。要点：
>
> | # | 复核项 | 结果 |
> |---|---|---|
> | 1 | `engines.dsh` 推荐范围 `>=0.2.0-rc.2 <0.3.0-0` | ✅ **正确**（DSH 用 `includePrerelease: true` 判定，实测同时匹配 0.2.0-rc.2 与 0.2.1-rc.1）；⚠️ 但写成 `>=0.2.0 <0.3.0` 会**排除当前安装的 0.2.0-rc.2** |
> | 2 | 「共用持久锁 ⇒ 一方必吃 `busy`」 | ⚠️ **偏重**：官方 pre-step 处理器 **await 压缩后仍 `next()`** ⇒ 插件在同一 step 里看到的是**压后比例**，**自动路径不会双压**；风险主要落在**手动 `/compact` 与插件同时发起** |
> | 3 | 锁与自动压缩「0.2.1 变更命中」 | ⚠️ **归因不准**：`dsh-compaction-basic/lib/index.js` **两版逐字节相同** ⇒ 锁是**既有行为**，不是 0.2.1 引入 |
> | 4 | pre-step 执行顺序「未确认」 | ✅ **已确认**：`dsh-agent-loop` 用 `dispatch.waterfall("agent/pre-step", …)` ⇒ 顺序=注册顺序；官方（base）先、插件（profile）后 ⇒ **插件天然是"官方之后的兜底"** |
> | 5 | 漏查项：`dsh-token-meter` | ⚠️ **改动最大**（+361 行）：`contextBreakdown` 内部重写（stateVersion 5→6、新增 `claim` 影子价状态机、**计量替换缺相邻 claim 会抛错**）。**公开视图两版完全相同**（`view: state => state.breakdown`）、`contextPressure` **逐字节相同** ⇒ 插件读的字段安全 |
> | 6 | 漏查项：`dsh-typert-protocol` / 客户端注入 | ⚠️ typert **+230/−28** 且**动了 `Remote` 装饰器**（插件 HUD 远端面用它）⇒ 需冒烟；客户端 7 个注入包与 `conversation.input.right` 槽位 **0.2.1 全在** ✓ |
>
> **净结论不变**：**0 项破坏性冲突**，可以升级；上述 6 条只影响「怎么改更对」与「升级后先测什么」。

---

## 二、插件现状（含证据）

### 包与注册

| 项 | 值 | 证据 |
|---|---|---|
| 包名 / 版本 | `dsh-context-pilot` / `0.1.35`（`private: true`） | `plugin/package.json` |
| 解析路径 | `node_modules/dsh-context-pilot` → `F:\My Code\dsh-context-pilot\plugin`（junction） | 实测 |
| 别名 | 另有 `node_modules/@local/dsh-context-pilot` 同指向 | 实测 |
| 入口 | `.` → `./entry.mjs`（59 行，仅加载器） | `plugin/package.json` |
| 客户端 | `./client` → `./client.js`（93 KB） | 同上 |
| 远端面 | `./typert` → `./wire.host.mjs` | 同上 |
| bundle patch | `./cordis.patch.yml`（insert `id/name = dsh-context-pilot`） | `plugin/cordis.patch.yml` |
| 客户端 inject | 7 个官方包（remotes / renderer / settings / slots / settings-plugins / primitives / locale） | `plugin/package.json` |

### 实现规模（说明复杂度）

| 文件 | 大小 | 职责 |
|---|---|---|
| `host.impl.mjs` | 37.9 KB | 宿主侧装配 |
| `m3.compact.mjs` | 61.1 KB | **压缩主控** |
| `compact-tool.mjs` | 55.5 KB | 智能压缩**工具** + pre-step 意图表 |
| `compact-range.mjs` | 20.8 KB | 保留范围自算 |
| `threshold.mjs` | 6.6 KB | 阈值与服务解析 |
| `effort.mjs` | 64.7 KB | 智能思考（档位） |
| `m2.inject.mjs` | 38.1 KB | **用量行注入** |
| `m5.hud.mjs` / `client.js` | 16.4 / 93.4 KB | HUD 与客户端 |
| `core.mjs` | 48.7 KB | 配置与服务访问 |

### 关键接口清单

| 接口 | 位置 | 说明 |
|---|---|---|
| `compaction.service.compactIfNeeded(agent, 'context-overflow'\|'pressure', signal)` | `m3.compact.mjs:374`、`:665` | **官方压缩服务**（非自研引擎） |
| `compaction.service.compactRegion(start, end, agent, signal)` | `m3.compact.mjs:470` | 自选范围后按范围压 |
| 服务获取 | `threshold.mjs:44` | `agent.ctx.get('compaction')` → `agentPresets.serviceFor` 兜底 |
| `agent/pre-step` waterfall | `compact-tool.mjs:8`、`:31`、`:146` | **工具只登记意图，真正执行在下一次 pre-step** |
| `ctx.tools.register(defineTool(toolSpec()))` | `compact-tool.mjs:730` | 智能压缩工具 |
| **用量行注入** | `m2.inject.mjs:427–443`、`:187–190` | 用官方 `createUserMessage()` 造**合成 user 消息**，带 `source: { kind, form:'snapshot', sections:[…] }` |
| 槽位 | `client.js:923`、`:937` | `plugins.bundle.config`、`conversation.input.right` |
| `ctx.get("configForms")` | `client.js:893` | 配置表单服务 |
| HUD 远端面 | `host.impl.mjs:538` | `ctx.provide(hudWire.FACE_NAME, face)` |
| 强制压缩线 | `core.mjs:76` | `criticalRatio: 0.85` |

---

## 三、兼容性排查（逐条对照 0.2.1 开发者变更）

| # | 0.2.1 变更 | 是否命中 | 证据 / 结论 |
|---|---|---|---|
| 1 | 移除 `./invariant` 导出 | ❌ | 全插件扫描 `invariant` **0 命中** |
| 2 | 子路径插件不再读独立 `package.json` | ❌ | 按**包名**注册；已显式导出 `./package.json` |
| 3 | 兼容性优先按 `engines.dsh` 判断 | ⚠️ **命中** | **无 `engines` 字段** → P0 |
| 4 | 输入区统计拆为 `activity` / `usage`（覆盖旧 `stats` 整行的插件需改 ID） | ❌ | **关键判定**：本插件不注册 composer stats 行。用量行是**合成 user 消息**（`m2.inject.mjs:427`），走 `createUserMessage()` + `source` 描述符，与 stats 行是两套机制。另注册的是 `conversation.input.right`（输入框右侧），也不是 stats 行 |
| 5 | 移除工具展示 `both` 模式 | ❌ | 0 命中 |
| 6 | Agent Team 消息直投 Inbox | ❌ | 0 命中 |
| 7 | 子代理 child ID 统一 | ❌ | 0 命中（本插件不注册子代理） |
| 8 | Python PTC 沙箱服务 | ❌ | 0 命中 |
| 9 | 移除 agent-instructions 逐行 `dshHome` | ❌ | 0 命中 |
| 10 | pi-ai 更新至 1.0.2 | ❌ | **无 `peerDependencies`** |
| 11 | Azure provider 改名 | ❌ | 0 命中 |
| 12 | API Key 读取优先级变更 | ❌ | 不读凭据 |

### ⚠️ 真正的耦合点（不在那 12 条里，但更重要）

0.2.1 的**压缩子系统**行为对本插件影响最大 —— 因为它**就在同一个事务上**：

- 官方 `compaction-basic` 用 **`compaction/start` 未匹配标记作为持久锁**；事务进行中，任何其他发起者（含插件的 `compactRegion`）会被 `assertCompactionInactive` 挡下并抛 `busy`
- 官方 `/compact` 命令调 **`compactNow(agent, signal)`**，与插件**共用同一把锁**
- 官方 `/compact` **仅限空闲**（轮次进行中直接 `busy`，命令自身不排队）

**结论**：用户在 GUI 打 `/compact` 时，若插件在同一时刻按自己的 `criticalRatio` 发起压缩，一方必然吃 `busy`。这不是"会崩"，而是**双重压缩/互相打断**的体验问题。

---

## 四、需要处理的项

### P0 —— 补 `engines.dsh`

同 `dsh-browser-kit`。官方原文：

> 第三方插件的版本兼容性优先按 `engines.dsh` 判断；未声明时沿用原有规则。**插件作者需检查声明是否覆盖支持的 DSH 版本。**

建议在 `plugin/package.json` 增加：

```json
"engines": { "dsh": ">=0.2.0-rc.2 <0.3.0-0" }
```

### P1 —— 与官方 `/compact` 的互斥感知（**本插件最重要的一项**）

**问题**：插件自算保留范围并在 `pre-step` 无条件兜底（`criticalRatio: 0.85`），与官方手动压缩共用同一持久锁。

**证据链**：
- 插件调用点：`m3.compact.mjs:374` / `:470` / `:665`
- 官方锁语义：`compactSurfaceRegion` 内 `assertCompactionInactive(...)`，未匹配的 `compaction/start` 即锁
- 官方手动入口：`ctx.compaction.compactNow(agent, signal, sourceCommandId)`（`dsh-command-compact/lib/index.js`）

**建议改法**（优先级从低到高）：

1. **尝试并让路**（最小改动）：发起前先读会话日志尾部，若存在未匹配的 `compaction/start` 则本轮让路
2. **感知 `command/run` / `command/done`**：官方每次 `/compact` 都会记录这对**仅日志事件**；`command/done.sourceEventSeq` 指向对应的 `compaction/summary`。插件可据此识别"用户刚手动压过"，跳过自己的阈值判断
3. **改用官方阈值口径**：见 §五-1，让插件只在官方阈值**之上**兜底，`/compact` 便不会与它重叠

### P2 —— 撤回并更正一条上轮建议

上轮评估曾说"可以迁到官方 **Session 状态记录接口**"。**该建议不成立，撤回。**

**证据**：`@deepseek-ai/dsh-session@0.2.1-rc.1` 的 README 新增唯一一章 `Write experimental plugin records`，接口为 `appendPluginRecord(session, type, data)`，原文明确：

> appends one plugin record for a package under **`packages/experimental/`**; … **Plugins outside this repository must not call it either**, although no repository check can inspect them.

即：它是给 **DSH 自家 `packages/experimental/` 内部插件**的接口，**外部插件不应调用**。

**替代方案**：用 **`ctx.sessions.registerMessageProjection()`**（`@messageProjection` 装饰器）—— 该接口**没有 experimental 限定**，且**你当前运行的 0.2.0-rc.2 里已经存在**（实测命中 `dsh-session/lib/index.js` 与 `lib/types/index.js`），无需等更新。

---

## 五、0.2.1 新功能带来的优化机会

### 1. 用官方阈值公式校准自算范围（**收益最高**）

**0.2.1 已文档化** `@deepseek-ai/dsh-compaction-basic` 的默认口径：

```
W = 上下文窗口, O = 生效请求输出上限, B = headroomTokens(默认 65536)
默认触发阈值 = floor(min(W × 0.8, W − O − B))
逐字保留的近端预算 = (W − O) × 0.16          # retainRatio 默认 0.16
```

且支持 `modelPolicies` 按 `provider/model` **精确覆盖**阈值与保留。

**插件现状**：`criticalRatio: 0.85`（`core.mjs:76`），另有一套自算范围逻辑（`compact-range.mjs`）。

**可做的改造**：把自算档位与官方 `thresholdRatio` / `retainRatio` **对表**，明确"插件只在官方阈值之上兜底"。这样：
- 官方先压 → 插件不重复压
- 官方压完仍越线 → 插件兜底（其设计初衷）
- 用户 `/compact` 后 → 官方已压过，插件无需再压

**收益**：消除双重压缩，减少一次多余的摘要请求（每次摘要都是**一次独立的模型调用**）。

**证据**：`compaction-basic/README.zh.md` 配置表；`compaction-basic/lib/index.js` 的 `compactIfNeeded` / `resolveCompactSpec`。

---

### 2. 感知 `/compact`，避免抢锁

见 §四 P1。补充事实：

**⚠️ 重要发现**：`/compact` **在你当前的 0.2.0-rc.2 里已经可用** —— 对比 `dsh-base` 的 base 组合，两版的挂载行**逐字相同**：

```yaml
# Human `/compact`: one useful reduction below the automatic threshold. Backend
# independent, so it follows whichever compaction service this leaf mounts.
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
```

且 `compactNow` 已存在于当前 `app.asar`。所以发布说明那句"Web 与桌面端可通过 `/compact`"更可能指 **GUI 命令适配器补上了**（命令早已挂载，区别是界面里敲有没有反应）。

👉 **建议立刻在 GUI 敲一次 `/compact` 验证**：有反应 = 早已可用；无反应 = 正是 0.2.1 补的适配器。这直接决定 P1 的紧迫度。

---

### 3. 官方 `/compact` 的能力边界（决定插件该怎么配合）

来自 `dsh-command-compact` 的 README 与实现（`lib/index.js`，仅 3.5 KB）：

| 行为 | 细节 |
|---|---|
| 无参 `/compact` | 即使未达压力阈值也压一段"有效、平衡"的较早范围；回报条数与估算 token |
| 无历史可压 | `No compactable history yet.`（不做任何改动） |
| 带参数 | `Usage: /compact (no arguments)` |
| **仅限空闲** | 轮次中 / 已有唤醒提示词 → `busy`，**命令自身不排队** |
| 压缩期间的用户输入 | **被接受并排队**，压缩结束后才开始（不丢不乱序） |
| 不支持范围/策略参数 | 显式范围走编程接口 `compactRegion()` |
| 生命周期不进模型历史 | `command/run` / `command/done` 是仅日志事件 |
| 失败态 | 6 种全部映射为稳定人话（busy / cancelled / changed / summary / commit / persistence） |

**对插件的含义**：插件若想主动压缩，**应继续走 `compactNow`**（或自己的 `compactRegion`），**不要模拟用户命令** —— 命令层不做排队、不进模型历史，语义不同。

---

### 4. 官方自动压缩的触发时机（可与插件的 pre-step 分工）

| 触发 | 机制 | 证据 |
|---|---|---|
| **压力** | `agent/pre-step` 监听器，请求派生前用 `ctx.tokenMeter` 为最新已路由 envelope 定价 | `compaction-basic/lib/index.js` 的 `_registerAutomaticCompaction` |
| **溢出恢复** | `agent/request-error` 响应 `CONTEXT_WINDOW_EXCEEDED`，**绕开阈值与保留策略**强制压一次；**只有表层替换 generation 前进了才授权重试** | 同上 |

**注意**：官方与插件**都在 `agent/pre-step` 上**做压力判断。插件若注册在官方之前/之后，行为会有差异，建议明确顺序并让插件成为"官方之后的兜底"。

**官方已知限制**（与插件的兜底存在意义直接相关）：
- 计量是**固定启发式（每 token 4 字符）**，CJK 与 JSON Schema **偏低**
- **无法缩减系统提示词、工具、会话前缀**，也不能拆不可分单元（如一次超大工具调用）
- 溢出恢复**只针对 `CONTEXT_WINDOW_EXCEEDED`**

→ 这三条正是插件存在的理由，**更新后依然成立**，插件不会被官方取代。

---

### 5. 用官方事件关联"用户手动压缩"

官方为每次 `/compact` 记录 `command/run` / `command/done`，成功时 `command/done.sourceEventSeq` 指向该事务的 `compaction/summary`，**无需解析文本、不假设两行相邻**。

**可做的改造**：插件订阅这两个仅日志事件，维护"最近一次手动压缩"的时间戳与范围，用于：
- 避免紧接着自己再压一次
- 在 HUD 里展示"本轮由手动压缩触发"

**证据**：`dsh-command-compact/README.zh.md` §"生命周期与关联"。

---

## 六、更新后验证清单（可复跑）

```powershell
# 0) 对照组：更新前先记录

# 1) /compact 是否可用（当前版本就能测！）
#    在 GUI 输入框直接敲 /compact
#    期望：报告"Compacted N history items (~M tokens)." 或 "No compactable history yet."

# 2) 用量行仍在注入（本会话每轮开头应有 "Context usage before this turn (by context-pilot…)"）
#    证据：m2.inject.mjs:190 的文案

# 3) 压缩服务仍可解析
#    期望宿主日志无 "no-compaction-service"（m3.compact.mjs:577 的降级标记）

# 4) HUD 仍有数据
#    证据：host.impl.mjs:540 "HUD 轮询面 … 已注册（ctx.provide…）"

# 5) 智能压缩工具仍注册
#    证据：compact-tool.mjs:730 tools.register(defineTool(toolSpec()))

# 6) 双压缩规避：在长会话里先敲 /compact，等结束后观察插件是否**不再**紧接着压一次
```

**通过判据**：以上每步有可复跑证据。任一失败时优先检查：
- `compaction.service` 是否仍能从 `agent.ctx.get('compaction')` 取到（`threshold.mjs:44` 的兜底链）
- `createUserMessage` 是否仍能从官方包候选链解析（`m2.inject.mjs:22` 注明"经 `getCreateUserMessage()` 现取"）

---

## 附：证据来源与不确定性

| 结论 | 证据强度 |
|---|---|
| 12 项变更均不命中 | **强**（全库扫描 + 逐项读码） |
| 用量行是合成 user 消息、非 stats 行 | **强**（`m2.inject.mjs:427–443`） |
| 与官方共用同一持久锁 | **强**（官方 `assertCompactionInactive` + 插件调用点） |
| `/compact` 在当前版本已挂载 | **强**（两版 base patch 逐字相同 + 当前 asar 有 `compactNow`） |
| `appendPluginRecord` 对外部插件禁用 | **强**（0.2.1 README 原文） |
| `registerMessageProjection` 当前版本已有 | **强**（当前 asar 实测命中） |
| 官方阈值公式可与插件对表 | **强**（官方 README 配置表 + lib 源码） |
| 官方 pre-step 与插件 pre-step 的执行顺序 | **未确认**（需实测监听器注册顺序） |
| 「极简模式」与 `dsh-sdk-minimal` 是否同一件事 | **未确认**（命名歧义，本评估不依赖） |

### 未做改动声明

本文档**只做排查**，未修改任何插件代码或配置。

---

## 七、独立复核（2026-10-17 逐包 diff，另一会话）

### 7.1 复核方法与可复跑命令

| 步骤 | 命令 |
|---|---|
| 拉 0.2.1 包 | `npm pack "@deepseek-ai/<pkg>@0.2.1-rc.1"`（compaction-basic / compaction / command-compact / session / token-meter / app-boot / plugin-manager / typert-protocol / client-ui-slots / client-ui-conversation） |
| 抽当前安装版 | `node docs/reference/tools/asar-query.cjs extract --paths "/dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js" --out .data/up021/base` |
| 逐文件对比 | `git diff --no-index --stat base/<pkg> <tarball>/package` |
| semver 裁决 | 真 semver 7 + **DSH 的真实参数** `{ includePrerelease: true }`（`dsh-app-boot#satisfies` 就这么调） |

> 所有结论均可复跑；本次对照目录留在 `.data/up021/`（gitignore，不入库）。

### 7.2 逐包 diff 结果（左=当前安装 0.2.0-rc.2，右=npm 0.2.1-rc.1）

| 包 | 改动 | 对插件的含义 |
|---|---|---|
| `dsh-compaction-basic` | **0 行（逐字节相同）** | 官方阈值/保留/锁/**自动压缩**全不变 ⇒ 插件依赖的 `compactIfNeeded(agent,'pressure'\|'context-overflow',signal)`、`compactRegion(start,end,agent,signal)`、`compactNow(...)`、`assertCompactionInactive` **全部安全** |
| `dsh-compaction` | 4 行（**仅注释**：文档链接改写） | 压缩服务契约不变 |
| `dsh-command-compact` | README/locale/types（**`lib/index.js` 0 行**） | `/compact` 实现不变 ⇒ §五-2「当前版本早已可用」**成立** |
| `dsh-session` | `lib/index.js` **0 行**；`lib/types/*` 与 `known-event-types.js` 变 | `registerMessageProjection` **两版都在** ✓；`appendPluginRecord` **仅 0.2.1 有**（experimental）⇒ §四 P2 成立 |
| `dsh-token-meter` | `lib/index.js` **大改**（内部重写，+361 行量级） | **公开视图不变**（见 7.3）⇒ 插件读的 `breakdown.*` / `pressureTokens·surfaceTokens·sampledSurfaceTokens` 安全 |
| `dsh-app-boot` | +574/−145（boot/bundle/profile 为主） | `engines.dsh` 判定**仅 0.2.1 有**（见 7.4） |
| `dsh-typert-protocol` | +230/−28（**动了 `Remote`**） | 插件 HUD 远端面用它 ⇒ **需冒烟**（见 7.6） |
| `dsh-client-ui-*`（插件注入的 7 个） | — | 7 个包在 0.2.1 **全在** ✓；`conversation.input.right` 槽位**仍在** ✓ ⇒ 客户端集成安全 |

### 7.3 `dsh-token-meter`：改动最大，但**公开面没变**（本节最重要）

- 0.2.0-rc.2 的 `contextBreakdown` 状态 = `{nodes:[{seq,heuristicTokens,system}], breakdown}`；
  0.2.1 = `{systems:[{seq,tokens}], surfaceTokens, claim?, breakdown}`，**stateVersion 5 → 6**。
- 0.2.1 新增**不变量**：`compaction/summary` / `compaction/prune` 先"武装"一个 `claim`（影子价，含被替换
  区间 `shadowedRange`、`shadowedTokenCount`、被阴影的 system seq）；随后任何**计量替换**若区间不匹配、
  或缺相邻 claim，`placeSurfaceEvent` 会**抛错**：
  `context breakdown: replace at seq … has no adjacent shadow price …`。
- **公开视图两版逐字相同**：`wire: { viewSchema: breakdownSchema, view: (state) => state.breakdown }`
  ⇒ 插件拿到的仍是**扁平** `{systemTokens, toolsTokens, messageTokens}`。
- `contextPressure` 定义**逐字节相同**（198 字符、hash 相等）⇒ `projectedFromPressure` 的
  `pressureTokens + surfaceTokens − sampledSurfaceTokens` **口径不变**。
- **对插件的新增约束**：插件走**官方** `compactRegion`/`compactIfNeeded` ⇒ 官方自己会发
  `compaction/summary`（claim 相邻）✓ 安全；**今后若绕过官方服务直接替换区间，会撞这个抛错**。
  建议在 `m3.compact.mjs` 相应注释里记一笔（零风险、纯文档）。

### 7.4 `engines.dsh`：结论正确，但有两个"写错就翻车"的细节

- DSH 判定（`dsh-app-boot#satisfies`）：`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
  ⇒ **预发布参与匹配**。用真 semver 7.8.5 实测：

  | range | 0.2.0-rc.2（当前） | 0.2.1-rc.1（目标） |
  |---|---|---|
  | `>=0.2.0-rc.2 <0.3.0-0`（本文档推荐） | ✅ | ✅ |
  | `>=0.2.0 <0.3.0` | ❌ **排除当前版** | ✅ |
  | `^0.2.0-rc.2` | ✅ | ✅ |
  | `workspace:^`（写在 engines 里） | ❌ | ❌（DSH 明确：engines 不接受 workspace） |

- 语义：**有 `engines.dsh` 就只看它**，`peerDependencies` 被忽略；没有才逐个校验
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer ⇒ **别两个都写**。
- 现状：**安装版 0.2.0-rc.2 的 `evaluatePluginCompatibility` 只认 `peerDependencies`（无 engines）**
  ⇒ `engines.dsh` 是**升级后才生效**的前向兼容声明；不声明**不会**导致插件加载不上（沿用旧规则）。
- 逃生舱：DSH 有**精确版本豁免**（`dsh plugin allow-version` / profile 的 `compatibility.json`，
  键为 `name@version` ⇒ 对应 runtime 版本）⇒ 万一判不兼容，可先豁免再改声明。

### 7.5 P1「共用持久锁」：重新定性（**风险低于本文档的描述**）

- 锁实现（两版相同）：`assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage)`
  —— **未匹配的 `compaction/start`（其后没有更新的 end-seed）即锁**，违反抛
  `ManualCompactionError('busy', …)`。
- 官方自动路径的 pre-step 处理器：`await this.compactIfNeeded(agent,'pressure',signal)` 之后
  **仍然 `return next()`** ⇒ **不中断瀑布** ⇒ 插件（注册在后）**同一 step 内看到的是压后比例**
  ⇒ **自动路径不会双压**。
- `agent/pre-step` = **waterfall**（`dsh-agent-loop`：`this.dispatch.waterfall("agent/pre-step", …)`）
  ⇒ 顺序=注册顺序；`compaction-basic` 属 base 组合（先）、插件属 profile（后）⇒ 插件**天然是兜底**。
- ⇒ 真正风险面缩小为：**用户手动 `/compact` 与插件发起"同时"发生**（命令层不排队 ⇒ 一方 `busy`）。
  感知手段按代价排序：
  1. **读持久锁**（最省）：发起前查会话尾部是否有未匹配 `compaction/start`——与官方同规则；
  2. **订阅 `command/run` / `command/done`**：两者**确在 `KNOWN_SESSION_EVENT_TYPES`**（会话事件、宿主可见）⇒ 可实现；
  3. **阈值对表**（§五-1）：让插件只在官方阈值**之上**兜底，重叠面自然消失。

### 7.6 升级后**必须冒烟**的两处（本文档未覆盖）

1. **HUD 远端面**：插件 `wire.host.mjs` **不用 `Remote` 装饰器**（初判有误，已更正），而是用 typert 的
   **低层约定**：`this.typertRemote = {service, serviceKey, namespace}` 绑定 + 原型标记键
   `@deepseek-ai/dsh-typert-protocol/remote-methods`，并以 `ctx.provide(FACE_NAME, face)` 兜底。
   而 0.2.1 的 typert diff（+230/−28）**恰好动了 `bindTypertRemote` / `TypertRemoteService` / marker
   initializer 那片区域** ⇒ 升级后**先看 HUD 是否仍有数据**（§六-4）。**这一条比初判更要紧**。
2. **面板行 / 客户端**：`conversation.input.right` 与 7 个注入包已验证存在 ✓，但仍建议刷新页面后确认
   配置表单与输入区右侧面板正常（客户端 `client.js` 是预构建产物，改客户端依赖需重新构建）。

### 7.7 新增优化机会（复核中发现，按收益排序）

| # | 机会 | 依据 | 收益 |
|---|---|---|---|
| 1 | **持久化「稳定回落样本」** | 插件的 `state.m3.settleDrop` 只活在会话内 ⇒ 重启/切换后回执里的「预计稳定后」无样本可算（退化成"暂无实测值"） | 落盘（照 `compact-tier.json` 的做法）⇒ 跨会话也能给「稳定后预计」 |
| 2 | **事件类型守卫测试** | 0.2.1 `known-event-types.js` 新增 `job/registered`、`job/settled`、`working-directory/change`；该文件是**完整清单** | 加静态断言：插件订阅的事件名必须都在 DSH 已知清单里 ⇒ 升级时**自动发现事件改名** |
| 3 | **用 `registerMessageProjection` 落会话记录** | 两版都有该 API（无 experimental 限定） | 让占用历史随会话走；但外部取证工具读 `m1-report.json` ⇒ **建议并存、不迁移** |
| 4 | **`job/*` 事件纳入趋势估算** | 0.2.1 新增事件 | 后台任务在无模型轮次时也推高占用 ⇒ 「距强制线 ≈N 轮」更准（收益小，可缓） |
| 5 | **`modelPolicies` 对表** | 0.2.1 `compaction-basic` README 已文档化（实现未变） | 插件档位可与官方**按模型**的阈值/保留对齐（换模型时尤其有用） |

### 7.8 建议的执行顺序（**等你决定何时做**）

> **进度（2026-10-17，v0.1.36/R48 已完成第 1 项 + 兼容守卫）**：
> ✅ 两个清单都加了 `engines.dsh`（根 + `plugin/`，范围同源）；✅ 新增 R48 兼容守卫（7 条断言：
> engines 范围带预发布后缀 / `summarizeBreakdown` 吃扁平与嵌套形状 / 会话事件与 hook 事件 ⊆ 契约快照 /
> 官方运行时依赖白名单 / HUD typert 冒烟提醒）；✅ 契约快照 `docs/reference/dsh-contract.json` +
> 刷新工具 `docs/reference/tools/make-contract.cjs`；✅ `m3.compact.mjs` 记下「不得绕过官方服务替换区间」
> 的新约束。**其余项等你升级后再做。**

1. ✅ **升级前**（零风险）：两个清单都加 `"engines": { "dsh": ">=0.2.0-rc.2 <0.3.0-0" }`（§7.4 已验证）。
   ⚠️ npm 安装读**根**清单、本地 junction 读 **`plugin/`** 清单 ⇒ 两处都要写。
2. **升级后立刻**：跑 §六 清单 + §7.6 的两处冒烟（HUD / 客户端）+ 用 `make-contract.cjs` 刷新契约快照后 `npm test`。
3. **随后按需**：§7.5 的锁感知（先做"读持久锁"最省）→ §7.7-1/2（低风险高收益）→ 其余。
4. **不做也不算错**：§五-1 的阈值对表（改动最大、收益是"少一次多余摘要"），可等真机观察到双压再做。

### 7.9 复核未覆盖 / 存疑

- 本文档 §二 的**行号**（如 `m3.compact.mjs:374`）经抽查**正确**，但会随插件改动漂移
  ⇒ 建议引用**符号名**而非行号（本次复核以符号为准）。
- `threshold.mjs:44` 的 `agent.ctx.get('compaction')` 兜底链**未逐行复核**（本次只确认压缩服务本体两版相同）。
- 「极简模式 / `dsh-sdk-minimal`」仍**未确认**（与本文档同）。
- 0.2.1 的**发布说明全文**未逐条核对（本次以逐包 diff 代替，覆盖面更强，但"桌面端 GUI 适配器"这类
  **非包内改动**仍需 GUI 实测：即 §六-1 的 `/compact` 手动验证）。
