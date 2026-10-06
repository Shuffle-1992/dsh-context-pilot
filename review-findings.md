# dsh-context-pilot 只读审查报告

> 审查对象：plugin/{host.impl.mjs, client.js, wire.host.mjs, entry.mjs, plugin-config.schema.mjs, package.json, cordis.patch.yml} + README 台账 + .data 运行时报告。
> 方法：静态逐函数审查 + 三端对账 + browser-kit pitfalls.md 对照 + 运行时报告取证。未修改任何文件、未运行插件。
> 已对照 §4 已知档案：inject scope/typert/信封三连环、gen 指纹、回填重试链、HUD v2 均未重报；通道 A AbortSignal 见 C1 附注给实施方案。

## 一、发现清单

### 维度 A：正确性 / 风险（7 条）

**A1｜host.impl.mjs:1094-1104｜A｜心跳定时器卸载泄漏**
`setInterval` 分支返回 Node Timeout 对象（typeof 'object'），`if (typeof h === 'function') disposers.push(h)` 只收 cordis disposer → 免重启热换/disable 后旧实例心跳永生，每 120s 旧 impl 快照+写报告，与新实例交错写 `.data/m1-report.json`（P37 同族多实例拉锯）。建议：`disposers.push(() => clearInterval(x))`（注意 push 的必须是包装函数，Timeout 直接调用会 TypeError 被吞）。风险：中｜代价：S

**A2｜host.impl.mjs:967-976, 1008-1017｜A｜marker 压缩失败后任务僵住、armed 已消费**
marker 命中即 `markerArmed.delete(sid)`（976），`compactNow` 失败走 catch（1012）不调 `maybeResumeAfterMarker` → armed 丢失不重试、`pendingBySid` 保留、hudPending 徽章永亮，挂起任务无人恢复（safety-net 又受 critical/冷却限制）。另外早退序（967-969：sweepInFlight / `!d.ok` 先于 970-974 的 TTL 清灯）→ measure 失败或 in-flight 时过期 armed 与 hudArmed 灯不熄。建议：catch 分支若 reason==='marker' 在 TTL 内重新武装（或至少 publishHud 失败提示）；TTL 清灯移到早退之前。风险：中｜代价：S

**A3｜host.impl.mjs:856-862｜A｜M2_BRIEF 冻结初始 marker 与 85% 字样，config 热改后自相矛盾**
M2_BRIEF 在 apply 期用当时的 M3.marker 拼接并写死「85%」；用户热改 marker（如换标记/置空）后，说明文本仍教旧标记，而检测（1058）用活值、renderPolicyCard（760-761）也用活值 → 模型按旧说明写标记永不命中。建议：M2_BRIEF 改为函数 `renderBrief()` 每次注入现拼。风险：低（改 marker 少见）｜代价：S

**A4｜host.impl.mjs:1055｜A｜session/event 武装判定读 M3.enabled 缓存而非活读**
标记武装门 `if (!M3.enabled || !M3.marker)` 用缓存值（更新依赖其他决策点触发 mergeConfig）；开关刚关闭的窗口内事件仍可武装亮灯（仅扫除被 effEnabled 拦住）。与 pre-step/idleSweep 的 effEnabled() 活读不一致。建议：改 `effEnabled()`。风险：低｜代价：S

**A5｜host.impl.mjs:803-804｜A｜pre-step 的 signal 缺失无守卫（compactIfNeeded 必抛）**
`if (!agent?.session || signal?.aborted) return;` 对 signal undefined 放行，随后 `compactIfNeeded(agent,'pressure',signal)` 按官方契约首行 throwIfAborted 必抛（M5.5 通道 A 已实证同款）。pre-step critical 尚未实弹验证过，这是首跑即败的候选点。建议：`|| !signal` 守卫或 `signal ?? AbortSignal.timeout(180_000)` 兜底。风险：中｜代价：S

**A6｜host.impl.mjs:313-322｜A｜M5_RESUME_MAX 用尽路径丢失「待执行」可见性**
上限路径先 `pendingBySid.delete` + 熄 hudPending 再 abort → 用户/模型都失去挂起任务提示；且 `resumeCountBySid` 整个会话生命周期不重置（两次用尽后 marker 通道永久退化为只压不恢复，直至重启）。不改铁约束上限本身：建议 abort 时保留徽章改文案「已达上限请手动继续」；可选按任务周期（新 marker 且距上次 >N 分钟）清零计数。风险：低｜代价：S

**A7｜host.impl.mjs:325-332, 1106-1115｜A｜卸载清理未覆盖 2s 恢复 setTimeout**
ctx.effect 只清 pending 表与 disposers；`setTimeout(2s)` 的 resume 调度不在册 → 禁用/热换窗口内旧实例仍可能向 agent 投递恢复消息。回填的 3 个 setTimeout 幂等无害可不管。建议：resume timer 进 pending 表（复用 clearTimeout 路径）或独立数组随 effect 清。风险：低｜代价：S

### 维度 B：Simplify（6 条）

**B1｜host.impl.mjs:248-252 vs 1157-1169｜B｜hudActText 格式化两处重复**
回填 bfOnce 手写同构模板（hhmm·原因·省 xK）。抽 `formatAct(reason, tokens, at)` 统一，回填处直接复用。风险：低｜代价：S

**B2｜host.impl.mjs:526-535 / 723-736 / 805-813｜B｜measure+pressure 读取三处重复**
decideCompaction / renderUsageText / preStepCompaction 各自 `svc('tokenMeter').measure` + `stateOf('contextPressure')` + ratio 计算。抽纯函数 `measureRatio(session) → {used, window, ratio, error}`，三处收敛（也顺带消除 A5 类守卫分散）。风险：低｜代价：S

**B3｜host.impl.mjs:256, 458, 473, 1067-1071｜B｜死代码与失真字段**
`_hudRetry` 过滤（旧 configEditor 通道残余）；`keywordHits` 恒 0（注释已声明保留理由，建议下一版本连报告形状一起退役）；`pendingBySid.resumes` 写入从未读取；`state.m3.dryRun` 仅激活时初始化不再更新，与 `m3.eff.dryRun` 双轨（报告里前者失真）。可机械删除/修正。风险：低｜代价：S

**B4｜host.impl.mjs:30｜B｜impl→wire 静态 import 触发 P16：face 逻辑冻结在重启版本**
相对导入解析回无参规范 URL 命中进程缓存——README「wire 无 query 不热换」的根因即此。运行时 face 实例（createRemoteFace）其实可以热换（TYPERT 声明走包 exports 不受影响）：改 `import(\`./wire.host.mjs?ts=${mtime}-${seq}\`)` 动态加载即可让 face 行为随 impl 同批热换。首次生效仍需一次重启。风险：低｜代价：S

**B5｜.data/*.cjs, plugin/.data/*.cjs, docs/reference/tools/*.cjs｜B｜取证/dump 脚本三处散落且重复**
dump-m55-fields.cjs 两处各一份；asar 工具与 dump 混在 .data 运行时目录。收敛 docs/reference/tools/ 并参数化（字段名/文件名作 argv），dump 类用完即删（对齐全局规范）。风险：低｜代价：S

**B6｜client.js:17, 317-337, 500-523, 555-576｜B｜client 小项**
`let react` 未重赋值改 const；window 散挂 6 个全局名（SID_HOOK/SID/HUD_DEBUG/POPUP_OBSERVER/POPUP_TIMER/HUD_TIMER）收敛为单命名空间 `window.__DSH_CONTEXT_PILOT__` 对象（防与其他插件撞名、便于整体清理）。风险：低｜代价：S

### 维度 C：强制性优化（6 条）

**C1｜host.impl.mjs 各 catch 点｜C｜catch 分级审计（逐处标注）**
必须留痕且已合规：preStepCompaction→preStepErrors✓、idleSweep→actErrors✓、M2 skips✓、m55 全相位 m55Attempt✓、publishHud→lastPublish✓。静默可接受：log/svc/tryOf 内层、client 的 sync/renderHud/tryInject/fetch 钩子（快照失败保持现状）。两处建议补痕：① mergeConfig 的 catch（config 读取异常保持现值——面板改值不生效时无从排查，建议 log 一次）；② bfOnce 的 catch（重试链 10s 耗尽仍读不到报告即永久静默，建议计数/终态 log 一句）；③ writeReport 解析失败走「首写」分支静默清空历史（损坏文件被覆盖，建议 parse 失败也 log）。附实施方案（非新发现）：通道 A 补 `sessionController.prompt(request, AbortSignal.timeout(30_000))`。风险：低｜代价：S

**C2｜host.impl.mjs 全局 Map/Set｜C｜资源上限矩阵**
有界✓：m5.acts=8、m55.attempts=20、history=120（实测已满、单条 ~10.2KB）、eventProbe.samples=12、SESSION_CAP=50、pending≤14 reason、sweepInFlight finally 必删、lastUserText 单条 500ch、pendingTask 400ch。
无界（全部按会话数增长，量级=会话数）：briefedBySid、lastUserTextBySid、resumeCountBySid、markerArmed（TTL 清理仅在「该会话发生 idle sweep」时执行，不活跃会话条目滞留）、m3.sweeps、measuredFailedOnce。当前规模无实际风险；低优先统一 cap（如超 200 会话 LRU 淘汰）。另注：回填 bfOnce 覆盖式写 `state.m5.acts`，激活后 1.2-10s 内若已有新压缩会覆盖运行期记录（概率极低）。风险：低｜代价：S

**C3｜host.impl.mjs:552-571｜C｜报告写入全量重读+重写（实测 1.2MB×每次）**
writeReport 每次 readFileSync 全量 1.2MB 再全量重写；触发点含 400-500ms 防抖的高频 reason（m2-inject/m3-decision/agent-status…）。建议：① apply 期读一次缓存 prev history，后续内存追加；② 稳态瘦身快照（keys 数组、probe 样本、services 枚举在稳态采样，取证字段保留首末 N 条全量）。风险：低｜代价：S-M

**C4｜client.js:441, 486, 526-529｜C｜client 订阅与轮询泄漏面**
弹窗每次重开 buildRow/buildHudRow 各 subscribe 一次（settingsScope 自建 listeners Set）且不持 off → 死回调随 notify 空转累积；5s getHud 轮询在弹窗关闭后仍每 5s 发 RPC（重开有 clearInterval 防护，关闭无停止条件）。建议：subscribe 返回值存到 row 侧、`pullHud` 首行查 `row.isConnected` 断开即 clearInterval。风险：低｜代价：S

**C5｜client.js:81-95｜C｜输入空串被 Number('') 强转为 0**
parseInput/canon 对 `""` 得 0 而非 null → 清空「标记武装有效期」保存即 0（armedTtl=0 立即过期，标记通道废）；num 类同理可存 0。建议：raw==='' 或 trim 空 → null 拦下（表单已有错误提示路径）。风险：低｜代价：S

**C6｜client.js:292-313｜C｜客户端降级矩阵核对（任务书四情况）**
信封缺失✓（unwrapEnv 双形态透传）/ typert 未热载✓（$mount warn + HUD_DEBUG 取证）/ face 未就绪✓（hudRemoteSvc null 空转留 debug）/ sid 抓不到✓（getHud('') 退全局）。缺口两条：$mount 失败无重试（只能刷新页面）；hudRemoteSvc 就绪回调不立即触发一次 pullHud（首数据要多等一个 5s tick）。建议就绪回调里调一次 pullHud，$mount 失败安排 1-2 次退避重试。风险：低｜代价：S

### 维度 D：解耦（3 条）

**D1｜host.impl.mjs（1184 行）→ 按 M 切分｜D｜切分图与 import 方向**
```
entry.mjs（薄壳，永不改）
└─ host.impl.mjs?ts=<mtime>-<seq>   编排器：组装 deps、接线 listener、唯一持 state
   ├─ core.mjs?ts=同参      svc/tryOf/log/schedule 纯工具（无 state 依赖）
   ├─ m1.snapshot.mjs?ts=   buildSnapshot/refresh/writeReport
   ├─ m2.inject.mjs?ts=     renderUsageText/renderPolicyCard/renderBrief + pre-step 注入
   ├─ m3.compact.mjs?ts=    decideCompaction/preStepCompaction/idleSweep/标记解析
   ├─ m5.hud.mjs?ts=        publishHud/recordHudAct/formatAct/getHud 实现
   └─ m55.resume.mjs?ts=    pending/resumeViaAnyChannel/maybeResumeAfterMarker
```
硬规则：所有动态 import 带同一 `?ts=`（P16：静态相对导入会命中无参缓存，热换失真）；模块间禁止互相 import，共享 state/M3 经 impl 组装的 context 对象注入 `{ctx, state, M3, deps:{svc,tryOf,log,schedule,publishHud}}` → 无循环依赖。publishHud/schedule/recordHudAct 等横切关注顺势升为 deps 层。测试补偿：本项目无测试目录，切分后加静态契约断言脚本（node --check + 三端字段对账 + 「模块间无互引」grep），放 test/ 不进 bundle。风险：中（动骨架）｜代价：M-L

**D2｜wire.host.mjs 模板 vs dsh-browser-kit｜D｜样板共享的边界**
同构重复：entry 薄壳/wire face 声明/报告环形缓冲/热换机制。因「无模块系统+独立部署（client.js）+ 各自 Junction」约束，client 侧只能保持复制；host 侧可抽生成模板（FACE_NAME+方法表+schema 三变量参数化生成 wire/描述符骨架），或至少在两仓 README 互链「改一处须同步另一处」清单。优先级低于 D1。风险：低｜代价：M

**D3｜client.js:557-565｜D｜弹窗开关行与 HUD 行注入耦合**
tryInject 同步 append 两行，重挂/启停绑定。已有独立 dataset 守卫（data-dcp-toggle/data-dcp-hud）与单例轮询，解耦代价低：拆两个 install 函数 + 各自「已挂」判断，即可独立失效排查（aria 定位失效时另一行不受牵连），也为未来「HUD 行可关」留位。风险：低｜代价：S

## 二、落地顺序清单（风险低+代价小 → 高+大）

| 批次 | 条目 | 执行方式 |
|---|---|---|
| 1 机械执行（静态改，无风险） | B3 死代码、B6 client 小项、C5 空串、B1 formatAct、B2 measureRatio、A4 effEnabled 一行、A3 renderBrief 函数化、A7 timer 入 pending | 改完 toggle 热换即生效（entry/wire 未动） |
| 2 改后需 toggle 热换 + 观察报告 | A1 心跳清理（验证：set_plugin toggle 后日志不再出现旧实例心跳）、A2 armed 重试+清灯提前、A5 signal 守卫、A6 MAX 用尽可见性、C3 报告缓存瘦身、C4 isConnected/subscribe off、C6 就绪即拉 | 观察点：m1-report.json 体积与 m3/actErrors |
| 3 需一次 DSH 重启 | B4 wire 动态 import（首次生效须重启；之后 face 可热换） | 重启前刷新=旧行为不炸（README 已证） |
| 4 需真机 E2E（挂起→压缩→恢复全链） | A5 首跑验证（pre-step critical 实弹本就在待办）、A2 失败路径注入「人为失败」验证重武装、A6 上限路径验收、D1 切分后全链回归 + C2/D2 随 D1 顺带 | E2E 三测脚本照 README §6 M5.5 流程复跑 |

—— 完 ——（报告 23 条：A7 / B6 / C6 / D3+1 附注；无与 §4 已知档案重复项）

---
> **落地记录（实施者补，2026-10-06 14:1x–14:3x）**：批次 1/2/3 全部实施完毕（host 21 处 + client 10 处，单次 toggle 热换，`node --check` 双通过）；批次 4（E2E 验收）待真机全链复跑。逐条状态（含实施中发现的一个自伤 bug 与一份未实施清单：D1/D2/B5/C2/C3②/A6计数清零）见 `README.md` §6「只读审查 —— 批次 1/2/3 全部落地」段。
