# 测试与取证

四套断言（contract / static / report / boot + client-render）与取证工具：怎么跑、跑出什么、以及"压缩到底有没有真的发生"该如何逐帧核对。

### 测试（`npm test`，<1 秒）

```bash
npm test              # 跑全部四个套件
npm run test:contract # 只跑契约对账
npm run test:static   # 只跑静态约束
npm run test:report   # 只跑报告形状
```

| 套件 | 断言数 | 查什么 | 能抓到什么 |
| --- | --- | --- | --- |
| `contract.mjs` | 629 | face 方法表 ↔ client 描述符 ↔ TYPERT 三端对账；Config 字段在 FIELDS/schema/M3_DEFAULTS 三处齐全**且默认值值级一致**；退役字段未复活；`mergeConfig` 读取集 ↔ schema；**getHud 作用域契约**（防 ReferenceError 回归）；**弹窗/阈值行排版契约**（**状态提示独立成行**，防窄弹窗逐字断开）；**智能思考 UI 契约**（开关尺寸/右对齐/字段三端/chip 两态色 token）；**压缩工具化契约**（工具注册/意图 TTL/消费顺序/伪造恢复零残留）；**阈值余量契约**（引擎阈值 −5pp 三处同源 / **阈值核心已抽为叶子模块且 host 不再重复定义** / 未就绪时空值降级 / 面板自取上限 / 输入即时钳制 / 已存超限自动钳回保存 / 教学传生效值）；**组件作用域对账**（防跨组件引用面板 state ⇒ 整卡崩掉，`node --check` 的盲区）；**R5 保留范围契约**（`RETAIN_RATIO` 与引擎 `DEFAULT_RETAIN_RATIO` 同源 / 起点跳过 `system/message` / 走 `session.eventAt` 而非猜 / **真跑纯函数**验证预算-范围-影子量-一致性拒绝-回退上限 / 引擎错误文案逐字对账 + 边界错误分类 / 官方兜底与强制线收口接线 / 留痕）；**R6 教学契约**（**实例化两个模块真跑 `renderBrief`/`renderCard`**：先说再调用的「显著标注」与「具体做法」**分两半钉死** / 两个工具 description 也要求 / 参数说明也要求 / 「自己算范围」按活值渲染 / **拿不到活值时不编数字** / host 活值接线）；**R7 加固契约**（退役零残留 4 类 × 4 文件剥注释判定 / 保留项 `markerMinRatio` 未被误删 / 随会话增长的 Set 已**有界化** / 意图表**真跑 `runTool`**：登记→`pending()`→跨 sid 隔离→消费 / 全表 TTL 清扫 / 空可选集**不否决档位** / **顺序契约**（F1 冷却在成功分支 / F5 消费在服务确认之后 / F2 可抛语句前移）/ **真错误边界** / occupancy 搬运 / alive 守卫**计数**）；**R8/R9/R10 解耦契约**（阈值核心与 M3 压缩域（执行核心 + 编排层）已抽为叶子模块 / **宿主不得把 `api.RETAIN_RATIO`、`api.selectRange(`、`state.m3.lastPreStep`、`sweepInFlight` 抄回来**（查独有产物而非函数名，防改名躲过）/ 跨域回调（`publishHud`/`recordHudAct`/`formatAct`/`clearBriefed`/`schedule`）必须显式注入 / 未就绪时空值降级并留痕 / 模块对宿主内部件零 import）；**智能思考 8 条实证结论**（prepend 最外层 / pending 持久 / 冷却基准 / 计数语义 / 两侧校验 / agent.ctx / sid 现读 / 删 maxTokens）；**R17 用户手动改档的「轮首知情」**（读 `modelSelection` 投影的 pending，而非上一次请求的 header；行为级覆盖改档/降级/兜底五条路径） | **调用静默失败**（P29：三端漂移不报错、只是拿不到数据）；已实测抓过 7 个真 bug |
| `static.mjs` | 77 | 真实 `node --check`（含 `docs/reference/tools/*.cjs`）；client 自足（无外部 import，require 仅 react）；entry 薄壳（<40 行、有静态 Config、动态 import 带 `?ts=`）；模块依赖方向无环；热换纪律；**功能域叶子模块清单**（effort / compact-tool / compact-range / threshold / m3.compact / m5.hud / m2.inject）；调试残留扫描（tools 下的 `console.log` 属 CLI 正常输出，豁免）；**上架基础项**（根清单可被市场识别 / Bundle patch 指向存在的公开 patch / 包名↔patch name 一致 / 版本一致 / README 有安装命令 / LICENSE 与 license 字段一致） | 语法错误、破坏热换、client 引入依赖、循环依赖、`TODO`/`XXX`/`console.log` 残留、**上架基础项漂移**（改了清单名/schema 而 patch 或 README 没跟上） |
| `report.mjs` | 54 | 产出侧字段契约；`republishFromReport`（原 `bfOnce`）回填链依赖；C3② 关键事件必须走 full 档（含**满环优先淘汰 slim**，防 FULL 取证被高频事件挤出）；**getHud 作用域与 criticalCap 实参契约**；**调查结论留档**（探针退役后结论不得丢）；真实报告结构自洽（**无嵌套条件断言** ⇒ 断言数不得随数据漂移）；`hud-acts.json` 去重；dump 工具可跑 | 报告形状无声破坏（踩过 2 次：顶层读 m3/m5、脚本读已删字段）；**证据静默丢失**（120 条全 slim、FULL 被挤光而断言全绿） |
| `boot.mjs` | 21 | **宿主启动冒烟**：真跑 `apply(ctx, {}, {pluginDir, reportPath})`（桩 ctx）→ HUD 面注册 → **真调 `getHud(null)` 必须 `ok:true`** → `criticalCap`/occupancy/`effortEnabled` 三线 → 四个监听器 → **真调 pre-step handler**（abort 与 step=1 两次）→ **M2 注入路径留下记账**（`m2.skips` 有键或 injections>0）→ 有历史时 `m5.lastPublish==='ok'` → 报告落盘。副作用边界：报告写临时目录、`hud-acts.json` 只读不写 | **接线不可达**（R11 真事故：接线块被嵌进 `schedule()` 函数体、语法合法、423 条源断言全绿，**压缩与弹窗全链路静默失效**）——`node --check` 与源断言都看不见「代码在不在正确的函数里」 |

合计 **999 条断言**（四套：contract / static / report / **boot**）。

**已验证有效**：注入 3 个人为 bug（`m3-act` 误入精简档 / client face 改名 / host 引用 client.js），
三套件全部抓到且定位精准。**新增断言均实测验证过「对回归确实失败」**（两边都通过的测试等于没测）：
- R5 换了 9 个针对性变异（保留比例 / 起点跳系统头 / 一致性校验 / 回退上限 / 错误分类 / 兜底分支 /
  预算守卫 / measure 传递 / 强制线收口）逐个注入，**9/9 被捕获**——其中「去掉回退上限」第一次**逃逸**，
  说明原断言只匹配了 `return official('boundary-exhausted')` 而没钉住 `MAX_WALK_BACK`，已加固。
- R6 换了 11 个（教学标注 / 教学做法 / 卡片做法 / 两个工具 description / 参数说明 / 写死比例 /
  卡片保留行 / host 活值接线）——**11/11 被捕获**。两次逃逸都极有教育意义：
  ① 「先说再调用」最初用**「或」关系的单个正则**，去掉显著标注后同段的具体做法仍能匹配 ⇒ 漏网，
  现改为**「显著标注」与「具体做法」分两半钉死**；
  ② 变异**脚本**把锚点打在了同文件的**注释**上（注释里也写了那个词）⇒ 代码没被改，看起来"逃逸"。

### 取证工具

```bash
npm run dump -- --tail 20          # 报告概览 + 尾部条目
npm run dump -- --kind m3-act      # 按 reason 过滤
npm run dump -- --field m3.eff     # 取最近一条的某字段
npm run dump -- --history-acts     # 压缩历史（含 hud-acts.json）

npm run asar -- list --filter dsh-token-meter
npm run asar -- grep --pattern compactIfNeeded --ext js --ctx 3

## 会话存储逐帧取证（压缩是否真发生 / 阴影了哪些 seq / 系统头是否被保留）
node docs/reference/tools/session-records.cjs --find <会话 id 片段> --compaction
node docs/reference/tools/session-records.cjs --find <会话 id 片段> --shadowed 15513
node docs/reference/tools/session-records.cjs --find <会话 id 片段> --from 18300 --type 'compaction/*'
```

> ⚠️ **路径约定**：报告的 `m3`/`m5`/`m55` 块在每个 **history 条目**上，不在顶层（`report.mjs` 已断言此约定）。
> ⚠️ `session-records.cjs` 读的是 DSH 的**私有存储格式**（多帧 zstd + JSONL）：直接扫魔数有假阳性，
> 必须 try/catch 跳过；官方改格式时该工具需同步。它是本项目「不靠插件自证」的关键手段——
> R5 就是靠它统计 12 次压缩的 `shadowedSeqs`，才证明 `system/message` 15513 从未被阴影化。

---

---
