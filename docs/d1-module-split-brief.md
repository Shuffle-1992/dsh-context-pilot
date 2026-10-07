# D1 任务书：`host.impl.mjs` 模块切分

> **来源**：`review-findings.md` 的 D1 条目（外部审查，2026-10-06）。
> **状态**：未实施，方案已定稿（2026-10-07 落盘）。**建议在占用较低时单独一轮执行**——
> 这是**骨架级重构**（动 1392 行文件的模块结构），出错会全功能失效。
> **前置条件**：`npm test` 全绿（当前 3 套件 127 断言全通过，含依赖方向与薄壳约束断言）。

---

## 1. 为什么要切

`plugin/host.impl.mjs` 当前 **1392 行**，单文件内混了 M1~M5.7 六代逻辑，全部状态共享一个
`apply()` 闭包里的 `state` 对象。具体痛点：

| 痛点 | 表现 |
| --- | --- |
| 定位成本高 | 改一处要通读全文确认副作用（`state` 被 18 个段落共享） |
| 职责不清 | 快照/注入/压缩/HUD/恢复五套逻辑交织，无边界 |
| 审查困难 | 审查员报告里 21 处修改点散布全文件，无法按模块评审 |
| 测试无法隔离 | 只能做静态解析断言（无模块边界就无法做单元级测试） |

**切分后目标**：`host.impl.mjs` 降至约 **200 行纯编排**（组装 deps、接线 listener、持有 state）。

---

## 2. 目标结构

```
entry.mjs（薄壳，永不改）
└─ host.impl.mjs?ts=<mtime>-<seq>         编排器：组装 deps、接线 listener、唯一持 state
   ├─ core.mjs?ts=同参                     svc / tryOf / log / schedule / msg / pick / kfmt / nfmt
   ├─ m1.snapshot.mjs?ts=                  buildSnapshot / slimSnapshot / refresh / writeReport
   ├─ m2.inject.mjs?ts=                    renderUsageText / renderPolicyCard / renderBrief + pre-step 注入
   ├─ m3.compact.mjs?ts=                   decideCompaction / preStepCompaction / idleSweep / 标记解析
   ├─ m5.hud.mjs?ts=                       publishHud / recordHudAct / formatAct / loadHudActs / saveHudActs
   └─ m55.resume.mjs?ts=                   pendingBySid / resumeTimers / resumeViaAnyChannel / maybeResumeAfterMarker
```

### 硬规则（违反即破坏运行时）

1. **所有动态 import 必须带同一 `?ts=` 参数**
   根因 P16：静态相对导入解析回**无参规范 URL**，命中 Node ESM 进程缓存 ⇒ 热换失真
   （文件改了但跑的还是旧模块）。`static.mjs` 已加断言守护。

2. **模块间禁止互相 import**
   共享 `state` / `M3` / 工具函数经 **impl 组装的 context 对象注入**：
   ```js
   const deps = { ctx, state, M3, svc, tryOf, log, schedule, publishHud, recordHudAct, formatAct };
   m2.register(deps);   // 各模块导出 register(deps) 或 createXxx(deps) 工厂
   ```
   这样保证**无循环依赖**，`static.mjs` 的依赖图断言可直接验证。

3. **横向关注升为 deps 层**
   `publishHud` / `schedule` / `recordHudAct` / `formatAct` 被多模块使用（HUD 发布、报告防抖、
   压缩记录），必须先抽到 `core.mjs` 或由 impl 传入，避免出现「m2 要调 m5 的函数」这种交叉。

4. **entry.mjs 保持不动**
   它是薄壳（28 行有效代码），`static.mjs` 断言 `<40 行` + 静态 Config + 不在顶层 import impl。

---

## 3. 切分顺序（每步跑一次测试，全绿才继续）

> ⚠️ 每步结束后：`npm test` 必须全绿 + `node --check` + **toggle 热换后确认报告仍写入**
> （`dump-report.cjs --tail 3` 看 `gen` 变化与 `m3.eff` 正常）。

| 步骤 | 内容 | 验证点 |
| --- | --- | --- |
| **0** | 备份 `host.impl.mjs`；确认 `npm test` 全绿 | 3 套件 127 断言通过 |
| **1** | 抽 `core.mjs`（纯工具函数，无 state 依赖） | 依赖图新增 `host.impl → core`；无循环 |
| **2** | 抽 `m1.snapshot.mjs`（buildSnapshot/slimSnapshot/writeReport） | `report.mjs` 全绿（产出侧形状契约不变） |
| **3** | 抽 `m5.hud.mjs`（publishHud/recordHudAct/formatAct/hud-acts 持久化） | `hudFace='provided'`；`hud-acts.json` 仍写入 |
| **4** | 抽 `m2.inject.mjs`（renderUsageText/renderPolicyCard/renderBrief） | 注入文本出现（`m2.injections` 增长） |
| **5** | 抽 `m3.compact.mjs`（决策/扫除/标记解析） | `m3.lastDecision`/`lastAct` 仍写报告 |
| **6** | 抽 `m55.resume.mjs`（恢复多通道） | `m55.attempts` 结构不变 |
| **7** | 收尾：`host.impl.mjs` 只剩编排 + 注释 | 行数 ≤ 250；`npm test` 全绿 |

**渐进式原则**：每步只动一个模块，且**保持行为完全不变**（纯搬迁，不顺手改逻辑）。
任何行为改动都应另开一轮——否则出问题无法区分「搬迁错」还是「逻辑改错」。

---

## 4. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 模块边界找错（共享状态过多） | 步骤 1 先抽 `core.mjs` 验证 deps 注入模式可行，再逐步推进 |
| 动态 import 漏带 `?ts=` | `static.mjs` 有断言；且 toggle 后看报告 `gen` 是否变化 |
| 循环依赖 | `static.mjs` 有 DFS 环检测；有环直接失败 |
| 热换后行为异常 | **备份原文件**；`cp host.impl.mjs.bak host.impl.mjs` + toggle 即回滚 |
| 报告形状被破坏 | `report.mjs` 的产出侧契约断言会立刻发现 |

**回滚**：保留 `host.impl.mjs.bak-<date>`，出问题直接覆盖回去 + toggle。

---

## 5. 配套增强（可选，随 D1 做）

- **`test/modules.mjs`**：切分后加「模块边界断言」——每个模块的导出集是否与预期一致、
  `register(deps)` 是否只读 deps 不写全局
- **C3② 报告瘦身范围扩展**：切分后 `m1.snapshot.mjs` 独立，可更清晰地做「取证字段首末全量 + 中间采样」
- **D2 wire 样板共享**：切分稳定后再考虑（跨仓库耦合，优先级更低）

---

## 6. 明确不做的事

- ❌ **不改 `entry.mjs`**（改它需要 DSH 重启，且薄壳是热换能力的根基）
- ❌ **不改 `wire.host.mjs` 的方法表**（协议变更需重启 + 三端对账，属另一议题）
- ❌ **不顺手改逻辑/删死代码**（纯搬迁；发现的问题记录到台账，另开轮次处理）
- ❌ **不引入构建步骤**（项目约定：无构建，源码直接跑）
