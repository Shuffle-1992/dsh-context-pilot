# R5：压缩保留范围自选（自己算范围 + 沿用官方兜底）

> 触发自 R4 真机 E2E 的**实测数字**（不是推测）：引擎唯一的「低于阈值强制压缩」通道
> `context-overflow` 用 `retainTokens = 0`，在**只有 53% 占用**时就把 surface 从
> **1117 节点 / 367,794 token** 砍到 **4 节点 / 8,603 token**（影子化 97.7%）。
>
> 本文记录：实测证据 → 源码事实 → 取舍 → 实现 → 验证矩阵 → 待办。

---

## 1. 实测证据（R4 E2E，2026-10-07，session `16616c07` turn 167）

调用 `compact_context` 时占用 52.5%，触发 `context-overflow`。三处独立证据互相印证：

| 来源 | 压缩前 | 压缩后 |
| --- | --- | --- |
| 报告 `sessions[].measure`（`tokenMeter.measure`） | `surfaceTokens 367,794`，`nodeCount **1117**` | `surfaceTokens 8,603`，`nodeCount **4**` |
| 报告 `m3.lastPreStep` | `ratio 53.2` | `shadowedTokens 361,769`，`range {15507, 18296}` |
| 会话存储 `compaction/summary` | — | `shadowedRange {15507,18296}`，`shadowedTokenCount 361,769`，`provider deepseek-account` |

> 报告时点：`20:02:29.300Z`（压缩前，1117 节点）→ `20:02:58.223Z`（压缩后，4 节点）。
> 压缩前后只差一步（step 6 → step 7），所以这 1113 个节点的消失**全部**由这一次压缩造成。

**保留的 4 个节点**：`shadowedRange.end = 18296` ⇒ 保留尾部 = seq `18297..18302`
（最后一步的 6 条**记录**，其中 surface 节点 4 个）+ 官方 `compact-checkpoint` 消息。

结论：`retainTokens = 0` 的语义是「只保留最后一个节点 + tool-pairing 回退」，
在**低占用**场景下代价过大——用户只是想让出空间，却几乎丢掉了全部近端细节。

---

## 2. 源码事实（`@deepseek-ai/dsh-compaction-basic/lib/index.js`，本地副本见 `docs/reference/`）

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| `DEFAULT_THRESHOLD_RATIO = .8` / `DEFAULT_RETAIN_RATIO = .16` | :15 / :17 | 保留比例取 0.16 即**与引擎同源** |
| `selectCompactableRange(session, measurement, retainTokens)` | :410 | 按 token 预算从尾部回退 + 配对回退；**第三参 = 保留 token 预算** |
| `context-overflow` ⇒ `selectCompactableRange(session, measurement, **0**)` | :932 | 这就是「保留≈0」的根源 |
| `pressure` ⇒ `selectCompactableRange(..., spec.retainTokens)`（= 预算 × 0.16） | :949 | 引擎正常路径的保留策略 |
| `async compactRegion(start, end, agent, signal)` **是公开方法** | :971 | ⇒ 范围**可以由调用方给** |
| `validateSurfaceRegion` 抛错 → 之后才有 `compaction/start` | :452 vs :469 | ⇒ **边界被拒是零副作用、零 LLM 成本的纯读错误，可安全重试** |
| `systemHead(session, headSeq)` = `session.eventAt(headSeq).type === 'system/message'` | :396-398 | ⇒ 节点类型用**公开 session API** 就能读到，不必猜 |
| `selectCompactableRange` / `systemHead` / `validateSurfaceRegion` **均未导出** | :1027 只导出 `BasicCompactionEngine` | ⇒ 不能直接复用，只能自己算 |
| `resolveTargetPolicy` 的 `modelPolicies` 来自**引擎构造配置** | :94-109 | ⇒ 无法按次覆盖保留预算（改它要动 DSH 全局预设 + 配置写入，不可接受） |

---

## 3. 取舍

### 3.1 为什么「自己算范围」而不是改引擎配置
`compactIfNeeded(agent,'pressure',signal)` 的保留预算来自 `resolveCompactSpec(policy, …)`，
而 `policy` 来自引擎构造时的 `config.modelPolicies`。要改变它必须写 DSH 的预设/配置
——**全局、持久、影响所有会话**，且插件无权替用户做这件事。唯一干净的入口是
`compactRegion`（公开、按次、只影响本次）。

### 3.2 为什么不复刻引擎的配对算法
`toolPairingBalancedBefore/After` 虽由 `@deepseek-ai/dsh-compaction` 导出，但从插件里
**裸导入 DSH 内部包**会引入版本耦合（插件当前只经 `svc()` / `agentPresets` 这样的服务面交互）。
`selectCompactableRange` 等更是完全未导出。而复刻一份配对算法意味着**两套真相**，
引擎一改就会悄悄漂移。

**采用的办法**：只做「起点按引擎规则取、终点按 token 预算回退」，
**边界合法性交给引擎裁决**——被拒就回退一个节点重试。因为校验发生在
`compaction/start` 与 LLM 调用**之前**（§2 倒数第 4 行），这一次重试不写日志、不调模型、
不改会话，是纯粹的本地读操作。

### 3.3 「没什么可压」时**不硬压**
如果整个 surface 都装得下保留预算，说明本来就不需要压。此时：
- 非强制线路径（模型主动请求）⇒ **收手**（`rangeSource: 'none'`）。
  回退官方 overflow 会把整段砍光，与「没什么可压」自相矛盾。
- 强制线路径（占用 ≥ 生效强制线）⇒ 仍走官方兜底，**强制承诺优先于保留偏好**。

---

## 4. 实现

### 4.1 `plugin/compact-range.mjs`（纯函数叶子，无 IO）
| 导出 | 作用 |
| --- | --- |
| `RETAIN_RATIO = 0.16` | = 引擎 `DEFAULT_RETAIN_RATIO`（contract 测试与引擎源码对账） |
| `MAX_WALK_BACK = 64` | 边界回退上限（每次都是零成本纯读，64 远超任何真实尾部） |
| `retainBudgetTokens(window, ratio)` | `floor(window × min(ratio,1))`；非法输入一律 0 |
| `isSystemHead(session, seq)` | `session.eventAt(seq)?.type === 'system/message'`；读不到一律 false |
| `selectRange({session, measurement, retainTokens})` | 复刻引擎起点规则 + token 预算回退；校验 `measurement.nodes` 与 `session.surface.nodes` 一致 |
| `prevEnd(surface, firstIdx, endIdx)` | 末端回退一个节点（引擎 while 回退同款语义） |
| `isEndBoundaryError(e)` / `isValidationError(e)` | 区分「末端不合法（可重试）」与「其他校验错误（直接兜底）」/「非校验错误（上抛）」 |

### 4.2 `host.impl.mjs` 接线
```
preStepCompaction
  ├─ forced = ratio >= effCritical        ← 生效强制线 = min(配置, 引擎阈值 − 5pp)
  └─ compactWithOwnRange(agent, compaction, {forced, sig, sid, window, measure})
       ├─ 模块不可用 ──────────────────────────────► official('no-range-module')
       ├─ selectRange → {ok:false, why}
       │    ├─ why='nothing-to-compact' 且 !forced ─► source:'none'（收手，不压）
       │    └─ 其他 ────────────────────────────────► official(why)
       └─ compactRegion(start, end)  ← 自选范围
            ├─ 成功 ────────────────────────────────► source:'own'
            ├─ isEndBoundaryError → prevEnd 回退重试（≤ MAX_WALK_BACK）
            │    └─ 回退耗尽 ───────────────────────► official('boundary-exhausted')
            ├─ isValidationError（起点不合法/找不到/无 turn）─► official('invalid-boundary')
            └─ 其他（摘要失败/busy/abort）──────────► 上抛，由外层 catch 记录
  └─ 强制线收口：source='own' 且压完仍 ≥ effCritical ⇒ 追加 official overflow → 'own+official'
```

`trigger` 字段现在只表达**触发原因**（`wanted` ⇒ `context-overflow`，越线 ⇒ `pressure`）；
**实际用了哪条保留策略**记在 `rangeSource`。`rangeProbe` 留最后一次范围读数
（窗口 / 比例 / 预算 / 起止 / 保留·影子 token / 失败原因）。

---

## 5. 验证矩阵

| 层次 | 内容 | 结果 |
| --- | --- | --- |
| 静态对账 | 模块按 `?ts=` 动态加载；`RETAIN_RATIO` 与引擎 `DEFAULT_RETAIN_RATIO` 同源；起点走 `session.eventAt`；host 把 `measure` 本体带下去；常量不进 `M3`；留痕齐备；强制线收口接线 | contract 全过 |
| **行为（真跑纯函数）** | 预算 300 / 10×100 token ⇒ 保留末 3 节点、影子前 7；`retainTokens=0` **精确复现**引擎 overflow 语义（只留最后 1 节点）；节点 0 是 `system/message` ⇒ 起点后移；预算 > surface ⇒ `nothing-to-compact`；`measurement`/`surface` 不一致 ⇒ 拒绝；`prevEnd` 回退边界；预算非法输入 ⇒ 0；`isSystemHead` 异常/缺失 ⇒ false | contract 全过 |
| 错误分类 | 引擎 5 种校验文案逐字对账 + 分类（末端可重试 / 起点与无 turn 直接兜底 / busy 与摘要失败**不算**校验错误） | contract 全过 |
| **变异验证** | 9 个针对性回归：保留比例改错 / 起点不跳系统头 / 去一致性校验 / **去回退上限** / 分类放宽 / 去兜底分支 / 去预算守卫 / 断 `measure` 传递 / 摘掉强制线收口 | **9/9 被捕获，0 逃逸** |
| 真机 E2E | 见 §6 | 见 §6 |

> **变异验证抓出一条弱断言**：最初只断言 `return official('boundary-exhausted')`，
> 于是「去掉 `MAX_WALK_BACK` 判断」的回归**逃逸**了——文本仍在，上限没了。
> 已改为连 `walkBacks + 1 > api.MAX_WALK_BACK` 一起钉死。
> 这正是本项目「两边都通过的测试等于没测」纪律的价值。

---

## 6. 真机 E2E

### 6.1 收手分支（`nothing-to-compact`）
见本文末尾「实测补记」。

### 6.2 `own` 分支的触发条件
保留预算 = 1M × 0.16 = **160,000 token**。只有当 surface **超过** 160k 时自选范围才非空；
否则按 §3.3 收手（这本身是正确行为，不是失败）。
⇒ 真机上 `rangeSource` 会随占用自然出现 `'none'`（低占用）→ `'own'`（中等占用）
→ `'official'`（自选不可用/回退耗尽）→ `'own+official'`（压完仍越线）。

---

## 7. 待办

1. **保留比例面板可调**：目前 `RETAIN_RATIO` 是模块常量。要变成面板字段需给
   `plugin-config.schema.mjs` 加 `retainRatio` + **重启 DSH**（未做，等用户确认）。
   代码侧已就绪：host 只从 `api.RETAIN_RATIO` 取值，改读配置是一行。
2. **idle 安全网仍是官方 `retainTokens = 0`**：`compactNow(agent, signal, sourceCommandId)`
   要求 **idle**（内部 `runMaintenance`），而 `compactRegion` 要求**有打开的 turn**
   （源码 :460 `no open turn`）⇒ 空闲路径**无法**用 `compactRegion`。故 idle 兜底沿用官方策略。
   若将来要统一，需要一个新的「idle 可用的按范围压缩」入口（官方未提供）。
3. **`RETAIN_RATIO` 与 `retainRatio` 的语义差**：引擎口径是
   `floor((window − reservedCompletionTokens) × ratio)`，我们拿不到 `reserved`（内部函数）
   ⇒ **不扣减**，即保留得**比引擎默认更多**（更保守、少丢近端细节）。这是有意为之。

---

## 8. 教训

1. **「能压」和「该压多少」是两个问题**。R4 解决了「怎么触发」（工具、零消息、不中断），
   R5 才解决「压完还剩什么」。触发方式再优雅，保留策略一刀切，用户体验一样是灾难。
2. **一次真机 E2E 的价值高于十次源码推理**。R4 落袋时我在文档里写的是「保留近端 ≈0」，
   但**真实代价是 1117→4 节点**——直到报告把 `nodeCount` 记下来才看见量级。
   ⇒ 结论要带**数字**，别只带形容词。
3. **公开方法与未导出内部函数的边界要摸清**。`compactRegion` 公开、`selectCompactableRange`
   未导出，这一个事实就决定了「自选范围」可行而「复用引擎选择器」不可行。
4. **校验发生在副作用之前 = 免费的重试机会**。读懂 `validateSurfaceRegion`（:452）与
   `compaction/start`（:469）的先后，才能把「复刻配对算法」换成「让引擎替我判、被拒就回退」。
5. **弱断言要靠变异验证暴露**。§5 的逃逸案例说明：断言「某行文本存在」远远不够，
   要断言**那个行为的完整条件**。
