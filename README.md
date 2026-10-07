# dsh-context-pilot — DSH 上下文智能压缩插件

DSH（DeepSeek Harness）宿主侧插件 `@local/dsh-context-pilot`（面板名「上下文智能压缩」，曾用名「上下文领航」）：**让长会话的上下文压力可见、可控，
并把「何时压缩」的决策权交给模型**——压缩后自动拉起续跑任务，用户零重发。

> **交接说明**：本文是入口，读完 §1–§3 即可上手；深入内容在 [`docs/`](docs/)。
> 创建 2026-10-05 · 最后更新 2026-10-07

---

## 1. 它做什么

```
每轮任务前 → 读上下文用量（tokenMeter）→ 注入"上限/已用/占比"到 prompt
          → 占用达「智能压缩线」时附决策卡，模型自行判断是否压缩
          → 模型写标记 → 回合结束自动压缩 → 自动拉起新一轮继续原任务
          → 占用达「强制压缩线」时无条件压缩（兜底）
```

**要解决的问题**：长会话上下文压力不可见；原生自动压缩（80%）只看占用、不看任务——
重任务需要全上下文，轻任务其实可以先压缩腾空间。**这个判断只有模型能做**，插件的职责是
把读数、选项、执行三件事做好。

**产出**：弹窗 HUD（最近压缩记录 + 阈值速览）、配置面板（两线阈值 + 成本计算器）、
报告的完整取证字段。

---

## 2. 关键概念（读这一节就够）

### 2.1 两条压缩线

| 面板名 | 配置键 | 含义 |
| --- | --- | --- |
| **智能压缩线** | `markerMinRatio` | 占用达此值时注入决策卡，**模型可自行决定压缩**并自动续跑 |
| **强制压缩线** | `criticalRatio` | 占用达此值**无条件强制压缩**（pre-step / idle 兜底） |

推荐值（按计费口径，计算器可按实价实时推导）：

| | DeepSeek API（命中:未命中 = 1:50） | 高缓存价档（1:4 ~ 1:8） |
| --- | --- | --- |
| 智能压缩线 | **0.30** | **0.15–0.20** |
| 强制压缩线 | **0.85** | **0.80** |

**核心原则**：不要把阈值调得过低去追命中率——**过度压缩导致模型重读文件/重跑命令的返工成本，
远超省下的 token**。高缓存价档（命中仍计费）压早更划算；DeepSeek 命中近免费，压晚保信息更好。

### 2.2 标记闭环（零输入自动续跑）

1. 模型回复尾行写 `[cp:compact]`
2. 插件解析武装（TTL 120s）→ 回合结束 agent 转 idle 时立即压缩
3. 压缩成功后自动投递恢复提示 → 模型以干净上下文继续原任务

用户全程零操作。模型也可在回复里写「待执行：<任务>」显式记录要续跑的任务。

**恢复投递走三通道，当前实际生效顺序**（2026-10-07 实证）：

| 通道 | 方式 | 状态 |
| --- | --- | --- |
| **A** | `sessionController.prompt(request, AbortSignal.timeout(30s))` | ✅ **当前首选**（`{"accepted":true}`，一次命中） |
| B | `ctx.remote.session.prompt` 代理 | ❌ 不可用（插件 ctx 无 `remote` inject 权限） |
| C | `createUserMessage` + `agent.followup`（官方同原语） | ✅ 兜底（早期历史走此路） |

> 通道 A 早期因**缺 AbortSignal 第二参**被拒（官方 `prompt()` 首行 `throwIfAborted`）——
> 补参后即通。这印证了「官方契约的参数一个都不能少」。

### 2.3 三个可改动点

| 改什么 | 生效方式 |
| --- | --- |
| 面板配置（两条线、有效期等） | **即时生效**（host 活读 config，无需重启） |
| `host.impl.mjs` | plugin toggle 热换 |
| `client.js` | 刷新页面 |

详见 [`docs/setup.md`](docs/setup.md#4-部署矩阵)。

---

## 3. 当前状态

**已完成**（M1 → 现在，全部经实机验收）：

- **M1** 用量读取：`tokenMeter.measure` + `sessionProjections.stateOf` 双路径，报告落盘取证
- **M2** 每轮注入：`agent/pre-step` 追加 usage 行（step 1 门控，异常放行不注入）
- **M2.5** 新会话自说明：首次注入追加插件说明（约 200 字），让 Agent 不靠外部文档就懂流程
- **M3.6** 标记闭环：尾行标记 → 武装 → idle 压缩 → **实弹 E2E 通过**（省 181K token / 节点 471）
- **M5** 弹窗 HUD：最近压缩记录、武装/待执行徽章、按会话过滤、悬停多条
- **M5.5** 任务挂起-自动恢复：多通道投递（A sessionController → B remote → C direct-followup），
  **三测复现通过**，实际走通道 C
- **M5.7** 压缩历史持久化（`hud-acts.json`，cap 50）：跨重启/跨 toggle 存续
- **配置面**：6 个字段，面板按秒/比率显示（总开关为开关滑块）；成本阈值计算器（8 个模型预设，一键算推荐值并写入）
- **只读审查落地**：外部审查 23 条，批次 1/2/3 全部实施（含心跳泄漏、`ctx.effect` 语义误用等真 bug）

**未实施（明确挂起）**：D1 模块切分（动骨架，**已有测试护栏 + 任务书，可以做了**）、
C2 无界 Map 上限（当前规模无实际风险）、A6 恢复计数清零、
**A5 pre-step 强制压缩真机 E2E**（唯一「已实现但成功率未验」的路径——需占用冲到强制压缩线
才有条件测，当前设为 80%，等接近了再做）、A2/A6 的真机 E2E。

> ✅ **2026-10-06/07 清偿**：C3② 报告稳态瘦身（3.77MB → 预计 ~600KB）、B5 取证工具收敛
> （18 个散落脚本 → 2 个统一工具）、**测试骨架**（3 套件 128 断言）、**通道 A 验收**、
> **D2 两仓同步清单**（[`docs/cross-repo-sync.md`](docs/cross-repo-sync.md)，含 7 强同步点 +
> 有意差异标注）、**弹窗阈值行加「距触发距离」**。
> 详见 [`docs/milestones.md`](docs/milestones.md)。

---

## 4. 测试与取证

### 4.1 测试（`npm test`，<1 秒）

```bash
npm test              # 跑全部三个套件
npm run test:contract # 只跑契约对账
npm run test:static   # 只跑静态约束
npm run test:report   # 只跑报告形状
```

| 套件 | 断言数 | 查什么 | 能抓到什么 |
| --- | --- | --- | --- |
| `contract.mjs` | 55 | face 方法表 ↔ client 描述符 ↔ TYPERT 三端对账；Config 字段在 FIELDS/schema/M3_DEFAULTS 三处齐全；退役字段未复活；`mergeConfig` 读取集 ⊆ schema | **调用静默失败**（P29：三端漂移不报错、只是拿不到数据） |
| `static.mjs` | 29 | 真实 `node --check`；client 自足（无外部 import，require 仅 react）；entry 薄壳（<40 行、有静态 Config、动态 import 带 `?ts=`）；模块依赖方向无环；热换纪律 | 语法错误、破坏热换、client 引入依赖、循环依赖 |
| `report.mjs` | 43 | 产出侧字段契约；`bfOnce` 回填链依赖；C3② 关键事件必须走 full 档；真实报告结构自洽；`hud-acts.json` 去重；dump 工具可跑 | 报告形状无声破坏（本项目踩过 2 次：顶层读 m3/m5、脚本读已删字段） |

**已验证有效**：注入 3 个人为 bug（`m3-act` 误入精简档 / client face 改名 / host 引用 client.js），
三套件全部抓到且定位精准。

### 4.2 取证工具

```bash
npm run dump -- --tail 20          # 报告概览 + 尾部条目
npm run dump -- --kind m3-act      # 按 reason 过滤
npm run dump -- --field m3.eff     # 取最近一条的某字段
npm run dump -- --history-acts     # 压缩历史（含 hud-acts.json）

npm run asar -- list --filter dsh-token-meter
npm run asar -- grep --pattern compactIfNeeded --ext js --ctx 3
```

> ⚠️ **路径约定**：报告的 `m3`/`m5`/`m55` 块在每个 **history 条目**上，不在顶层（`report.mjs` 已断言此约定）。

---

---

## 5. 成本模型与推荐配置

> **完整分析见 [`docs/cost-model.md`](docs/cost-model.md)**（官方单价取证、缓存命中率影响、
> 结构占比推导、阈值弹性表、计算器模型）。本节只留结论。

- **缓存命中率：下降**（每轮注入约 300–500 token 未命中；压缩整体重置前缀）。但命中率是分母游戏，
  **必须看绝对成本**。
- **费用：两种计费口径都降**，机制不同：
  | 计费方式 | 收益量级 | 机制 |
  | --- | --- | --- |
  | 按量付费（API） | ~10–30% | 命中近免费，上下文规模影响小；收益来自避免超大上下文的天价 miss |
  | 订阅套餐（Coding Plan） | ~40–70% | 命中仍计费 ⇒ 上下文是持续失血，压小直接换额度 |
- **关键解析**：压缩的摊销成本 ≈ 新增内容 × 未命中价，**与阈值几乎无关**（摘要调用 ∝ 阈值，
  压缩间隔也 ∝ 阈值，两者相消）⇒ **「压得勤更贵」是错的**，全部收益来自上下文规模。
- **同一组阈值的钱效**：高缓存价档（1:4）约为 DeepSeek（1:50）的 **3.8 倍**。

### 变更记录（2026-10-07）

配置面从 10 个字段精简到 7 个、术语改名、时长字段改秒显示、决策卡门槛并入智能压缩线。
**决策卡门槛合并的动因**（用户发现的设计缺陷）：原 `policyCardMinRatio`（教学）与
`markerMinRatio`（执行）是两个独立参数，`[0.30, 0.35)` 区间模型收不到卡 ⇒ 不知道标记存在
⇒ 永远不写 ⇒ **死区**。现统一为「能收到卡 = 标记有效」，无论怎么填都不会出现死区或错配。
详见 [`docs/cost-model.md`](docs/cost-model.md) 与 [§5 配置面](#5-配置面速查)。

---

## 6. 配置面速查

| 面板字段 | 配置键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 总开关 | `enabled` | true | 关闭后完全恢复原生 DSH（面板为开关滑块） |
| **智能压缩线** | `markerMinRatio` | 0.2 | 占用达此值时模型可自行决定压缩并自动续跑 |
| **强制压缩线** | `criticalRatio` | 0.85 | 占用达此值无条件强制压缩 |
| 压缩标记 | `marker` | `[cp:compact]` | 模型回复尾行标记；置空则关闭智能压缩 |
| 标记有效期(秒) | `armedTtlMs` | 120 | 标记后多久内有效（存储为 ms） |
| 强制压缩冷却(秒) | `sweepMinIntervalMs` | 600 | 两次强制压缩的最小间隔（存储为 ms） |

> 历史版本曾有的 `policyCardMinRatio`（决策卡门槛）、`highRatio`（审计参考线）、
> `lightTaskChars`（轻任务阈值）**已删除**——前者并入 `markerMinRatio`，后两者在决策主体
> 移交模型后已无触发作用。旧配置残留键会被**静默忽略**（不报错、不迁移）。

---

## 7. 已知设计风险（开发前必读）

1. **激活安全**：插件 `apply()` 内任何异常只记录不抛（DSH 纪律：抛 = 条目装载失败）。
2. **CJK 计数低估**：占用比是估计值（无 provider usage 时按 4 字符/token 启发式），
   决策阈值要留余量。
3. **`compactNow` 约束**：必须传 Agent 本体 + **必须 idle** + **signal 必传**
   （官方实现首行 `signal.throwIfAborted()`）。
4. **弹窗 DOM 注入的脆弱性**：弹窗是宿主内部组件、无官方插槽，靠 aria 属性定位，
   DSH 升级可能失效——失效只是开关/HUD 行不见了，注入与压缩功能不受影响。
5. **热换语义**：`ctx.effect(execute)` 的 `execute` **立即执行=setup，返回值才是卸载器**
   （曾因此误用导致心跳从未运行 + 卸载零清理，见 [`docs/milestones.md`](docs/milestones.md)）。
6. **client 协议变更需重启**：`wire.host.mjs` 的 face 声明与 TYPERT 走包 exports，
   改协议（增删参数）必须重启 DSH 一次。

---

## 8. 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/cost-model.md`](docs/cost-model.md) | 成本模型全文：官方单价、缓存命中率分析、阈值弹性、计算器推导 |
| [`docs/setup.md`](docs/setup.md) | 环境事实、composition 真相（not-bundle 坑）、部署与热换矩阵 |
| [`docs/api-notes.md`](docs/api-notes.md) | 已验证的官方 API + **修正记录**（探索期写法 → 最终实现） |
| [`docs/milestones.md`](docs/milestones.md) | 完整里程碑档案（M1 → 现在，含踩坑与实测数值） |
| [`docs/cross-repo-sync.md`](docs/cross-repo-sync.md) | 与 `dsh-browser-kit` 的**同构点与同步清单**（7 个强同步点 / 5 个弱同步点 / 有意差异 / 漂移检测） |
| [`docs/d1-module-split-brief.md`](docs/d1-module-split-brief.md) | D1 模块切分任务书（目标结构 / 硬规则 / 7 步顺序 / 回滚） |
| [`docs/reference/README.md`](docs/reference/README.md) | 第三方（DSH 官方）抽取材料的来源与许可 |
| [`review-brief.md`](review-brief.md) / [`review-findings.md`](review-findings.md) | 只读审查的任务书与报告 |

**运行期取证**：`plugin/.data/m1-report.json`（service/injection/compaction 全字段报告）、
`plugin/.data/hud-acts.json`（压缩历史，cap 50）。

统一取证工具（2026-10-07 收敛，取代此前散落的一次性脚本）：

```bash
node docs/reference/tools/dump-report.cjs                  # 报告概览 + 尾部条目
node docs/reference/tools/dump-report.cjs --tail 20        # 尾部 N 条
node docs/reference/tools/dump-report.cjs --kind m3-act    # 按 reason 过滤
node docs/reference/tools/dump-report.cjs --field m3.eff   # 取最近一条的某字段
node docs/reference/tools/dump-report.cjs --history-acts   # 压缩历史（含 hud-acts.json）

node docs/reference/tools/asar-query.cjs list --filter dsh-token-meter
node docs/reference/tools/asar-query.cjs grep --pattern compactIfNeeded --ext js --ctx 3
node docs/reference/tools/asar-query.cjs extract --paths "/dsh/node_modules/..."
```

---

## 9. 验收标准

1. 每轮 prompt 含实时用量三元组（上限/已用/占比），模型可正确复述；
2. 占用达**智能压缩线**时，模型可写标记触发压缩，插件自动执行并自动拉起续跑任务（用户零重发）；
3. 占用达**强制压缩线**时，插件无条件压缩（pre-step / idle 兜底），压缩事件出现在会话日志；
4. 两条线可经 Config 配置（面板按秒/比率显示），改后**即时生效**（活读，无需重启）；
5. 插件任何异常不影响 DSH 主流程（激活安全零抛）。
