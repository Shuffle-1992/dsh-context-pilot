# 任务：对 DSH 插件 `dsh-context-pilot` 做**独立对抗性审计**（R51）

## 你的立场
你是**外部审计者**，不是作者。仓库里的文档（`README.md` / `docs/milestones.md` /
`DSH-0.2.1-COMPAT-REVIEW.md` / `docs/reviews/*`）都是**作者自述**——只能当线索，
**绝不能当结论依据**。任何结论都必须回到**代码本身**和**官方 DSH 源码**。

## 目标（只做这一件事）
找出插件里**真实的缺陷**，给出**可复现的证据**与**最小修法建议**。

## 范围
- `plugin/**`：`entry.mjs`、`host.impl.mjs`、`core.mjs`、`m1.snapshot.mjs`、`m2.inject.mjs`、
  `m3.compact.mjs`、`m5.hud.mjs`、`threshold.mjs`、`effort.mjs`、`compact-tool.mjs`、
  `compact-range.mjs`、`session-facts.mjs`、`wire.host.mjs`、`client.js`、`plugin-config.schema.mjs`
- `test/**`：四个套件（`run.mjs` / `contract.mjs` / `static.mjs` / `report.mjs` / `boot.mjs`）
- 契约面：`docs/reference/dsh-contract.json`（快照）＋ 安装的 DSH 源码

## 环境事实（别自己瞎找）
- 仓库根（工作目录）：`F:\My Code\dsh-context-pilot`
- 部署：`~/.dsh/profiles/desktop/node_modules/@local/dsh-context-pilot` 是指向 `plugin/` 的 junction
- DSH 版本：**0.2.1-rc.2**。实现源码在 `D:\DeepSeek\resources\app.asar\dsh\`（asar 内）。
  提取方式见仓库内 `docs/reference/tools/make-contract.cjs`（带 `--asar` 参数）；也可直接读该工具产出的快照
- 跑测试：`node test/run.mjs`（**只读**，勿改；当前 774 断言全绿）
- 插件运行时数据：`plugin/.data/*.json`（已 gitignore；勿手改）

## 必须逐条给结论的对抗性假设（成立 / 不成立 / 未能验证）
1. **错误路径自抛**：某个 `catch` 引用了 `try` 块内声明的 `const`/`let`（真机出现过一例，作者已修）。
   **还有没有别的？** 逐模块检查每个 `catch` 里引用的标识符是否在其作用域内可达。
2. **静默降级**：有没有"子系统失败、但对外仍报成功"的路径（工具回 `ok` / 回执说已执行 / 面板显示正常）？
   重点：模块懒加载窗口、`setCompactVerify` 的全部分支、`preStepErrors`/`actErrors` 的覆盖面。
3. **未防 undefined 的嵌套状态**：`state.m2/m3/m5.*` 的索引访问、`.length`、缺失的 `?.`——
   在「首次运行 / 热换后 state 重置 / 多会话并发」三种情形下会不会抛错或写坏数据。
4. **异步竞态**：`sweepInFlight`、`isCompactionInFlight` 的时间窗、`awaitRange`/懒加载模块就绪窗口、
   同会话 pre-step 与 idle 并发、多会话同时压缩——能否绕过互斥、重复压缩、或丢回执。
5. **契约漂移**：插件用到的服务/钩子/会话事件是否**真的存在**且形状一致？用官方源码核对：
   `sessionProjections.stateOf` 的键名与返回形状、`compaction` 服务的 `compactNow/compactRegion/compactIfNeeded`、
   `llm.resolveModelInfo`、typert HUD 通道（`remote-methods` + `typertRemote` 约定）。
6. **数值与口径**：占用/预算/回落/折算因子的计算有没有边界错误（窗口为 0、负值、NaN、窗口变化、
   provider 实报缺失、`sampled=0`）？哪一种会导致**压过头**（丢新需求）或**压了等于没压**？
7. **测试有效性（元审计）**：找出**不可能失败**的断言（恒真/自证）、只在特定桩下才成立的断言、
   以及"改了实现照样绿"的断言；给出**变异清单**（把 X 改成 Y，应当有几条红线）。
8. **资源与边界**：`.data/` 落盘（体积增长、并发写、JSON 损坏、路径处理）、
   每会话表的容量上限是否真的生效、有无无界增长。
9. **你自己新增的两个假设**（自由发挥，必须写清动机与验证方法）。

## 明确不要做
- **不要修改任何产品代码或测试代码**（`plugin/**`、`test/**`、`docs/**` 只读）；
  唯一允许写的是下面的报告文件。
- 不要把作者的文档/结论当证据。
- 不要提"命名/注释/风格"类意见（除非它直接导致真实缺陷）。

## 交付物（唯一允许写的文件）
报告写到：`F:\My Code\dsh-context-pilot\docs\reviews\r51-independent-audit.md`（中文、UTF-8）。
结构固定如下：
1. **结论摘要**（3–6 行：整体判断 + 最严重的 3 条）
2. **Findings 表**：`ID / 严重度(阻断·高·中·低) / 位置(file:line) / 触发条件 / 证据(代码片段＋命令输出) /
   影响 / 最小修法建议 / 置信度(已复现·静态推断)`
3. 上面 **9 条假设的逐条结论**（含"我是怎么试图证伪的"）
4. **实际跑过的命令与关键输出**（原样贴）
5. **没能验证的清单**（诚实，含原因）
6. **自证**：未修改产品/测试代码（附 `git status --porcelain` 输出）

## 验收标准
- 每条 finding 必须**可复现**（给触发步骤/命令），否则必须标 `静态推断` 并说明为何无法复现。
- 9 条假设**必须逐条**给结论；**不许全判"不成立"**——若确实没发现问题，要给出你**试图证伪**的过程证据。
- 无证据的"我认为/可能是"条目 ⇒ 视为不合格。
- 不要跑会改仓库的命令（`git commit/push`、写 `plugin/**`、`npm/pnpm install`）。
