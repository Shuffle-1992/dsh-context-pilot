# dsh-context-pilot 项目审查任务书（只读审查 · 不写代码）

> 交给任意审查 agent 的完整任务书。读完本文件即可开工，无需其他上下文。
> 铁律：**只审查、不修改任何文件、不运行插件、不执行部署动作。** 产出 = 一份审查报告文件 + 简短总结。实施由主会话（台账持有者）后续统一进行。

## 1. 审查对象

`F:\My Code\dsh-context-pilot` —— DSH Desktop 0.2.0-rc.2 的宿主侧插件 `@local/dsh-context-pilot`（上下文导航仪：逐轮测量上下文占用 → 注入用量行/决策卡 → 模型决定挂起（回复尾行 `[cp:compact]`）→ 插件自动压缩 → 自动拉起新一轮续跑原任务，用户零重发）。

| 文件 | 规模 | 角色 |
|---|---|---|
| `plugin/host.impl.mjs` | ~1180 行 | 业务主体：M1 报告 / M2 注入+自说明 / M3 决策+压缩 / M5 HUD / M5.5 挂起-恢复 |
| `plugin/client.js` | ~560 行 | GUI 页脚本：配置卡片、上下文弹窗注入（开关行+HUD 行）、remote 轮询面 |
| `plugin/wire.host.mjs` | ~116 行 | face/TYPERT 协议面（getHud，client↔host 对账契约） |
| `plugin/entry.mjs` | ~56 行 | 薄壳入口（静态 Config 导出 + `?ts=mtime-seq` 动态 import 热换） |
| `plugin/plugin-config.schema.mjs` | 小 | schemastery 配置 schema |
| `plugin/cordis.patch.yml` / `plugin/package.json` | 小 | 插入条目 / exports+bundle 声明 |
| `README.md` | ~250 行 | 台账（全部设计决策与实测记录，审查前必读 §5–§7） |
| `plugin/.data/m1-report.json` | 运行时 | 验证报告（120 条环形缓冲，只读参考） |

## 2. 铁约束（公开契约，不可建议破坏性改动）

1. **entry.mjs 薄壳机制**：静态导出 `Config`（loader 只认入口模块静态导出）+ `./host.impl.mjs?ts=mtime-seq` 动态 import 热换。不可建议改成静态 import、不可建议合并进 impl。
2. **client.js 单文件**：GUI 页经 `window.__ModuleLoader__.load` 加载的普通脚本，无模块系统，**不能拆文件、不能用 import/export**。提取逻辑只能建议「同文件内函数化」。
3. **三端逐字对账**：`wire.host.mjs FACE_METHOD_TABLE` ↔ `client.js REMOTE_CONTRIBUTION.descriptors` ↔ `TYPERT.invocations`（id/service/namespace/method/parameters/optionals 逐字段）。任何方法签名建议必须三端一起给。
4. **已判死通道不得复活**：host→configEditor 推送（`HMR transactions cannot be nested` 结构性拒绝，README §6「M5 HUD 通道改判」）。
5. **恢复通道现状**：C（createUserMessage+agent.followup 直通）是唯一实证可用通道；A（sessionController.prompt）缺 AbortSignal 已知待修（低优先）；B（ctx.remote）无 inject 权限不可用。`M5_RESUME_MAX=2` 防循环上限。
6. **压缩调用契约**：`agentPresets.serviceFor(agent,'compaction')`，必须传 AbortSignal，agent 必须 idle（README §7）。
7. **每激活一份内存态是有意设计**：`briefedBySid`/`pendingBySid`/`markerArmed`/`state.m5.acts` 随激活重置（重启后重讲/重填靠启动回填），不建议改成跨激活持久——如认为必须持久，需给出README §6 实测证据支撑的论证。
8. **remote 代理 {ok,value} 信封**：client 侧必须 unwrapEnv（browser-kit client.js:2098 同款坑）；`ctx.inject` 回调参数是 scope（服务在 `scope.remote.<名>`）；inject 声明必须含 `typert`（$mount 硬依赖）。这三条是 12:4x 三连环排障的结论，修复代码已在，可审质量，不要当新发现报。

## 3. 审查维度与必查清单

### A. Review（正确性/风险）
- 逐函数找：空值/越界、竞态（setTimeout 链、`pending` 定时器表、`sweepInFlight`、`briefedBySid` 判定与注入之间的窗口）、异常吞噬过度（`catch {}` 是否掩盖了应留痕的失败——对照 `state.m2.skips`/`actErrors` 的留痕纪律）、事件监听/MutationObserver/setInterval 的清理完备性（重挂防护是否覆盖所有入口）。
- 边界：报告 JSON 解析失败/文件被占用、`prev.history` 为空、`sessionId` 缺失、`state.m5.acts` 为空/超限、信封缺失（直连形态）、`renderPolicyCard` 阈值边界（0.15 现行值）、`M5_RESUME_MAX` 用尽路径。
- 安全/健壮：fetch 钩子（client）对宿主页的影响面、正则提取 sessionId 的误配可能、`row.title`/tooltip 注入面（文本均为内部生成，验证无外部输入进入 DOM）。

### B. Simplify（精简）
- 重复逻辑：`hudActText` 格式化在回填与动作两处、报告 dump 类脚本（.data/*.cjs）、M2/M3/M5 各自的 log 模板、client 侧 chip/title 构造。
- 死代码：`keywordHits`（已注释为废弃但保留）、`_hudRetry` 残留、旧 configEditor 通道残余、不可达分支。
- 超长函数（>80 行）：给出可安全提取的纯函数清单——**注意** impl 可拆函数但 client.js 只能文件内重组；提取后说明测试补偿（本项目无测试目录，建议静态契约断言落点）。
- 状态瘦身：`state` 顶层对象 m1/m2/m3/m5/m55 的字段是否有从未读取者（对照报告消费路径）。

### C. 强制性优化（硬性加固，给出「必须做」清单）
- 所有 `catch {}` 分级：静默可 / 必须 `skips` 留痕 / 必须 schedule 报告，给出逐处标注。
- 资源上限审计：`state.m5.acts`（cap 8）、`m55.attempts`、`sweeps`（按 sid 无上限？）、`m1-report.json` 环形缓冲（120）——给 overflow 行为矩阵。
- 时序加固：启动回填重试链（同步+1.2s/4s/10s）是否覆盖报告写竞态；`schedule()` 400/500ms 延迟报告的丢失窗口；轮询定时器在弹窗重开时的泄漏面。
- 客户端降级矩阵：信封缺失/typert 未热载/face 未就绪/sid 抓不到 四种情况的现状与缺口。

### D. 解耦（结构）
- `host.impl.mjs` 单文件 1180 行按 M1/M2/M3/M5/M5.5 切分的可行性（保持 `?ts=` 热换与单 state 的前提；给出切分图与 import 方向，禁止循环依赖）。
- `state` 单例的读写点收敛： publishHud/schedule 报告等横切关注是否应提为独立层。
- 与 `F:\My Code\dsh-browser-kit` 的模式重复（wire/薄壳/报告/热换样板）：哪些可提为共享模板，哪些因「无模块系统/独立部署」必须保持复制。
- client.js 弹窗注入（v3 aria 定位+轮询兜底）与 HUD 轮询面的耦合：can they be独立开关/独立重挂。

## 4. 已知问题档案（勿作为新发现重复报告；可审修复质量）

三连环空态根因（inject scope 签名 / typert 硬依赖 / {ok,value} 信封）均已修复并有 README §6 记录；gen 指纹、启动同步回填+1.2s/4s/10s 重试、`recordHudAct` 会话历史、HUD v2 按会话过滤均为 13:0x–13:3x 新增。channel A AbortSignal、`hud-acts.json` 持久化已在遗留清单，不必重报，可直接给实施方案。

## 5. 输出要求

- 写一份报告文件：`F:\My Code\dsh-context-pilot\review-findings.md`（这是你唯一允许写的文件）。
- 每条发现：【编号】【文件:行号区间】【维度 A/B/C/D】【类型】【说明】【建议（可含关键代码思路，不落盘改代码）】【风险 低/中/高（改动引发回归的可能性）】【实施代价 S/M/L】。
- 末尾给「落地顺序清单」：按 风险低+代价小 → 风险高+代价大 排序，标注哪些可机械执行、哪些需 DSH 重启验证、哪些需真机 E2E（挂起→压缩→恢复全链）。
- 总报告 ≤ 200 行，只列有实际收益的发现，不凑数；与 §4 已知档案重复的发现视为无效。
- 最终回复：≤30 行总结（各维度条数 + Top5 必修项）。

## 6. 审查方法提示

- 先读 README.md §5–§7（台账：所有设计决策与实测证据都在那里，很多「看起来像问题」的写法是实测约束下的有意选择）。
- 可对照 `F:\My Code\dsh-browser-kit`（同构插件的成熟参照，其 pitfalls.md 是坑清单）。
- 不可运行 DSH/插件/测试（本项目无测试目录）；静态分析 + 交叉对账为主。
