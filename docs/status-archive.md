# 状态存档（原 README §3，2026-10-08 迁出）

> 本文件是 README「当前状态」节的历史存档（迁出时点：v0.1.0 之后，R16.1 已实施）。
> 其中部分条目已被后续里程碑取代（如「D1 剩余部分待切」——R13/R14 已完成全部解耦），
> 权威进度请看 [`docs/milestones.md`](milestones.md)。

## 已完成（M1 → 现在，全部经实机验收）

- **M1** 用量读取：`tokenMeter.measure` + `sessionProjections.stateOf` 双路径，报告落盘取证
- **M2** 每轮注入：`agent/pre-step` 追加 usage 行（step 1 门控，异常放行不注入）
- **M2.5** 新会话自说明：首次注入追加插件说明（约 200 字），让 Agent 不靠外部文档就懂流程
- **M3.6** 标记闭环：尾行标记 → 武装 → idle 压缩 → **实弹 E2E 通过**（省 181K token / 节点 471）
- **M5** 弹窗 HUD：最近压缩记录、武装/待执行徽章、**按会话严格过滤（sid 精确匹配）**、悬停多条（含完整日期时间）
- **M5.5** 任务挂起-自动恢复：多通道投递（A sessionController → B remote → C direct-followup），
  **三测复现通过**，实际走通道 C
- **M5.7** 压缩历史持久化（`hud-acts.json`，cap 50）：跨重启/跨 toggle 存续
- **R1 智能思考**（2026-10-07，**已由 R2 取代触发方式**）：读档/枚举/写档三腿运行时实证；
  注入教学 + 每轮档位后缀；弹窗开关 + 输入框档位 chip（**响应式投影，零轮询**）；
  `agent/request` + **prepend 最外层应用**（R2 沿用）+ 合法性校验 + 30s 冷却 + 让位他人选择
- **R2 换档改工具**（2026-10-08，**已注册生效**）：`set_reasoning_effort` 工具取代文本标记。
  工具调用让本轮**继续到下一步**（源码实证）⇒ **本次任务内立即生效、零用户输入、零伪造消息**；
  顺带消除文本标记的「散文提及误触发」面。实测 `effortTool.ok=true, via=tools.register`
- **R3 智能思考解耦**（2026-10-08）：功能域抽成 `plugin/effort.mjs`（415 行，依赖图叶子节点），
  `host.impl.mjs` **2348 → 1563 行**；S1–S10 十项缺陷全消（命名统一 / 拆两个巨型函数 /
  `sidOf`·`checkEffort`·`bumpSkip` 单点 / `readEffort` 纯 async / 三 Map 合一 /
  **懒安装彻底移出 M2 注入分支** / 冷却可配 / 工具 output 收敛 / getHud 开关字段分离）；
  调查脚手架（`r1ProbeOnce` + 三个 `snap.*Probe`）清理，结论改为「留档断言」防丢
- **压缩失效定位**（2026-10-08）：压缩两条路径全 400 ⇒ 补错误正文取证后定位为 **workbuddy
  provider 对摘要请求的思考档位报 400**（非本插件）；切 `trae` 后同一路径一次成功
  （733.9K token / 95% → 1.9%）。**结论已锐化到 provider×model**：坏的是
  `workbuddy × deepseek-v4.1-flash` 组合（`workbuddy/glm-5.3-flash` 曾成功），
  且 `deepseek-account/deepseek-flash` 实测可用（省 217.8K）。全文见
  [`docs/compaction-failure-diagnosis.md`](compaction-failure-diagnosis.md)
- **配置面板首帧就绪门**（2026-10-08）：快照未解析前不再渲染 `field.def`
  （默认值与已存值不同：`criticalRatio` 0.85 vs 0.8、`markerMinRatio` 0.2 vs 0.3）
  ⇒ 消除「刚出现显示一个值、随后跳变」的那一帧
- **两处 UI 修正**（2026-10-08，用户实测反馈）：
  ① 输入框 chip 由「智能思考档位 low · 冷却 23s」改为**两态文案**
  （冷却中「智能思考冷却」/ 冷却完成「智能思考就绪」），**状态由样式承担**——
  底层 warn 色=冷却态、上层 success 色按冷却进度扫满=就绪态
  （两个主题状态 token + `width` transition，像进度条一样过渡）；档位值与剩余秒数移入 title。
  ② 压缩记录弹窗：时间由 `hh:mm` 改为完整 `YYYY-MM-DD HH:MM:SS`，并**按会话严格过滤**——
  原 C-lineage 血统链把**别的会话**的记录混了进来（详见下条）
- **R4 压缩改工具触发**（2026-10-08，用户要求「不用伪造一条我的信息重新拉起会话」）：
  新模块 `plugin/compact-tool.mjs` 暴露工具 **`compact_context`** ⇒ 登记意图 ⇒ 宿主 pre-step
  **轮内**压缩 ⇒ 本轮无缝继续。**整体删除**伪造恢复投递链（`maybeResumeAfterMarker` /
  `resumeViaAnyChannel` 三条通道 / `resumeCountBySid` / `M5_RESUME_MAX` / `resumeTimers`），
  代码中 `sessionController.prompt`·`agent.followup` **零出现**；三处教学同步改为工具版
  （漏改会让模型写标记后**等一个永远不来的恢复**）。源码依据与落袋方案偏差见
  [`docs/r4-compaction-tool-design.md`](r4-compaction-tool-design.md)
- **R5 保留范围自选**（2026-10-08，R4 真机 E2E 之后）：E2E 查明引擎 `context-overflow` 的
  `retainTokens = 0` 在**只有 53% 占用**时就把 surface 从 **1117 节点 / 367,794 token** 砍到
  **4 节点 / 8,603 token**（97.7% 影子化）。现改为**先自选范围**（保留预算 = 窗口 × 0.16，
  即引擎自己的 `DEFAULT_RETAIN_RATIO`）→ 调公开方法 `compactRegion`；**边界被拒**（会切断
  tool-call/result 配对）时逐节点回退重试，仍失败或压完还在强制线之上则**沿用官方 overflow 兜底**。
  新模块 `plugin/compact-range.mjs`（纯函数叶子）；取舍与源码依据见
  [`docs/r5-retention-range-design.md`](r5-retention-range-design.md)
- **配置面**：6 个字段，面板按秒/比率显示（总开关为开关滑块）；成本阈值计算器（8 个模型预设，一键算推荐值并写入）
- **只读审查落地**：外部审查 23 条，批次 1/2/3 全部实施（含心跳泄漏、`ctx.effect` 语义误用等真 bug）

## 未实施（迁出时点快照，部分已清偿）

- D1 模块切分**剩余部分**（迁出时注：**R13/R14 已全部完成**——`m3/m5/m2/m1/core` 五刀切完，
  `host.impl.mjs` 1836 → 518 行）
- C2 无界 Map 上限（当前规模无实际风险；**部分已做**——`sweeps`/`verifyBySid` 有界化）
- A6 恢复计数清零（**已随 R4 退役**——伪造恢复链整体删除）
- **A5 阈值触发的强制压缩真机 E2E**（工具触发的 pre-step 压缩已由 R4 E2E 证实；
  越强制线那一支 2026-10-08 已真机触发过——cb8d115e 会话「兜底 · 省 494.4K」）
- A2/A6 的真机 E2E（随 R4 退役）

## 2026-10-06/07 清偿记录

C3② 报告稳态瘦身（3.77MB → 预计 ~600KB）、B5 取证工具收敛（18 个散落脚本 → 2 个统一工具）、
**测试骨架**（3 套件 128 断言）、**通道 A 验收**、**D2 两仓同步清单**
（[`docs/cross-repo-sync.md`](cross-repo-sync.md)，含 7 强同步点 + 有意差异标注）、
**弹窗阈值行加「距触发距离」**。详见 [`docs/milestones.md`](milestones.md)。
