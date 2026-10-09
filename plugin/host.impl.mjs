/**
 * @local/dsh-context-pilot —— M1+M2 实现：用量读取验证 + 每轮注入。
 *
 * M1（已验证 2026-10-06）：sessions/agents 双句柄枚举 + tokenMeter.measure() 实测 + 事件监听 + 报告落盘。
 *  - 实测：Agent.session 持有 Session；measure(agent.session) 可用；投影 contextPressure 自带 contextWindow。
 *  - 实测：顶层 ctx 上 compaction absent（作用域隔离，M3 需解决）。
 * M2（已验证 2026-10-06 00:13）：镜像官方 dsh-time-context 惯用法——agent/pre-step waterfall 里往本步消息
 *  追加一条带 source.sections 的快照 user message，每轮 step 1 注入上下文用量三元组
 *  （window / used+pct / surface / system-message-tools 拆分）。
 * M3.5（2026-10-06）：决策主体 = 模型语义判断，插件负责读数/选项/执行。
 *  通道1 pre-step 轮内先压（next() 之前）：critical≥85% → compactIfNeeded("pressure")（官方同款）。
 *  通道2 政策卡：占用≥30% 时注入行追加政策文，教会模型场景1/2 与标记约定。
 *  通道3 idle 扫除双模式：safety-net 仅 critical 占用兜底（受 10min 冷却）；
 *        M3.6 marker 模式——模型回复尾行写 [cp:compact]（政策卡教会它），session/event 解析到即武装，
 *        idle 后立即 compactNow（≥20% 即执行，不受冷却）——用户零输入的"模型建议+自动执行"闭环。
 *  （关键词「先压缩」用户输入通道已裁撤：要手动触发不如直接用压缩指令。）
 *  官方依据：dsh-compaction-basic lib/index.js —— pressure 走引擎阈值（默认80%）的 pre-step 自动压缩；
 *  overflow 绕阈值（retain=0 → compactRegion，owner:"current-turn"）；compactNow 需 idle；
 *  session/event assistant/message 事件通道官方亦在用。
 *
 * 官方包导入（继承 zcode-dispatch ZB-01 结论）：第三方目录裸 import '@deepseek-ai/*' 必失败，
 * 走「bare → env → resourcesPath → 硬编码 asar 路径」×「import / require」候选链，全失败禁注入不报错。
 *
 * 纪律（README §7.5）：任何异常逐支吞掉只记录，绝不向上抛。
 */
export function apply(ctx, config, { pluginDir, reportPath, core } = {}) {
  /* ═══ R14 解耦第六刀：core（配置 / 状态 / 报告管线 / 工具函数）已搬进 plugin/core.mjs ═══
   * 它由 **entry.mjs 用同一个 ?ts= 预加载后传进来**——因为 `state`/`log`/`svc`/`schedule`/`addListener`
   * 都在 apply 期**同步**使用，而 `?ts=` 动态 import 是异步的；只有让调用方先加载才能同时满足
   * 「热换」（P16）与「同步可用」。
   * ⚠️ entry.mjs 属「改它必须重启 DSH」的薄壳 ⇒ **未重启时这里拿不到 core**：
   *    此时**降级但不崩**（留一条可诊断的痕并空转），重启后即为完整形态。 */
  if (!core) {
    const why = 'core.mjs 未注入 ⇒ entry.mjs 尚未更新（它需要重启 DSH 才生效）；本次激活降级为空转';
    try { (ctx && ctx.logger && ctx.logger.warn ? ctx.logger.warn : console.warn)(`[dsh-context-pilot] ${why}`); } catch { /* 吞 */ }
    return { reportPath, degraded: 'core-missing-need-restart', why };
  }
  const {
    state, log, msg, svc, tryOf, pick, kfmt, nfmt, M3, mergeConfig, effEnabled,
    schedule, addListener, remember, SET_CAP, SOURCE_KIND, SESSION_CAP, HEARTBEAT_MS, TAG,
    COMPACT_TIMEOUT_MS, HISTORY_CAP,
    compactMeasure, summarizeBreakdown, extractEventText, messageText, errCodeOf,
    getCreateUserMessage, attachSnapshot, loadDefineTool, loadReportBase,
  } = core;
/**
 * @local/dsh-context-pilot —— M1+M2 实现：用量读取验证 + 每轮注入。
 *
 * M1（已验证 2026-10-06）：sessions/agents 双句柄枚举 + tokenMeter.measure() 实测 + 事件监听 + 报告落盘。
 *  - 实测：Agent.session 持有 Session；measure(agent.session) 可用；投影 contextPressure 自带 contextWindow。
 *  - 实测：顶层 ctx 上 compaction absent（作用域隔离，M3 需解决）。
 * M2（已验证 2026-10-06 00:13）：镜像官方 dsh-time-context 惯用法——agent/pre-step waterfall 里往本步消息
 *  追加一条带 source.sections 的快照 user message，每轮 step 1 注入上下文用量三元组
 *  （window / used+pct / surface / system-message-tools 拆分）。
 * M3.5（2026-10-06）：决策主体 = 模型语义判断，插件负责读数/选项/执行。
 *  通道1 pre-step 轮内先压（next() 之前）：critical≥85% → compactIfNeeded("pressure")（官方同款）。
 *  通道2 政策卡：占用≥30% 时注入行追加政策文，教会模型场景1/2 与标记约定。
 *  通道3 idle 扫除双模式：safety-net 仅 critical 占用兜底（受 10min 冷却）；
 *        M3.6 marker 模式——模型回复尾行写 [cp:compact]（政策卡教会它），session/event 解析到即武装，
 *        idle 后立即 compactNow（≥20% 即执行，不受冷却）——用户零输入的"模型建议+自动执行"闭环。
 *  （关键词「先压缩」用户输入通道已裁撤：要手动触发不如直接用压缩指令。）
 *  官方依据：dsh-compaction-basic lib/index.js —— pressure 走引擎阈值（默认80%）的 pre-step 自动压缩；
 *  overflow 绕阈值（retain=0 → compactRegion，owner:"current-turn"）；compactNow 需 idle；
 *  session/event assistant/message 事件通道官方亦在用。
 *
 * 官方包导入（继承 zcode-dispatch ZB-01 结论）：第三方目录裸 import '@deepseek-ai/*' 必失败，
 * 走「bare → env → resourcesPath → 硬编码 asar 路径」×「import / require」候选链，全失败禁注入不报错。
 *
 * 纪律（README §7.5）：任何异常逐支吞掉只记录，绝不向上抛。
 */
  const IMPL_TS = (() => {
    try { return new URL(import.meta.url).searchParams.get('ts') || String(Date.now()); } catch { return String(Date.now()); }
  })();

  /* ═══════════ 阈值核心（R8 解耦第一刀）═══════════
   * `engineThreshold` / `criticalCapOf` / `resolveCompactionFor` 的**实现**已搬进
   * plugin/threshold.mjs（为何先抽这一个、搬迁顺序见该文件头）。
   * ⚠️ 这里**不能 `await`**：宿主 `apply` 不是 async，而 `criticalCapOf` 被 getHud（RPC 面）、
   *    报告快照、两条压缩路径**同步**调用 ⇒ 用与 effort/compact-tool 同款的「懒加载 + 空值降级」。
   * 降级语义（模块未就绪，实测只在激活后头几个微任务内）：**不做上限钳制**（上限返回 1），
   * 于是生效线 = 用户配置值（等价于 R5 之前的行为），并留一条痕。绝不中断激活。 */
  let thresholdCtl = null;
  const thresholdReady = import(`./threshold.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      thresholdCtl = m.createThreshold({ svc, tryOf, state, log });
      return thresholdCtl;
    })
    .catch((e) => {
      log('warn', `阈值核心模块加载失败（吞，压缩线退化为「不做 5pp 钳制」）：${msg(e)}`);
      return null;
    });
  const NO_CAP = 1; // 降级时的「无上限」：min(配置, 1) = 配置
  const criticalCapOf = (agent) => (thresholdCtl ? thresholdCtl.criticalCapOf(agent) : NO_CAP);
  const engineThreshold = (agent) => (thresholdCtl ? thresholdCtl.engineThreshold(agent) : NO_CAP);
  const resolveCompactionFor = (agent) =>
    (thresholdCtl
      ? thresholdCtl.resolveCompactionFor(agent)
      : { service: null, via: 'threshold-module-pending', probe: {} });

  let defineToolFn = null; // 官方 defineTool（工具定义器），由 loadDefineTool 异步填充
  let effortApi = null; // effort.mjs 实例（异步就绪）
  const effortReady = import(`./effort.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      effortApi = m.createEffort({
        svc, tryOf, pick, msg, log, state,
        /* schedule 用箭头包装：该 const 在当前位置仍处 TDZ，直接取引用会在建对象时抛
         * ReferenceError；调用时机晚于 apply，包装后安全。 */
        schedule: (reason, delay) => schedule(reason, delay),
        readCfg: () => ({ enabled: M3.effortEnabled === true, cooldownMs: M3.effortCooldownMs }),
        getDefineTool: () => defineToolFn,
        /* R16.7：换档统计落盘（plugin/.data/effort-stats.json）——内存态随 toggle/重启清零，
         * 用户要求「会话切换次数」跨重启累计。pluginDir 由 entry 注入 apply overrides。 */
        pluginDir,
      });
      return effortApi;
    })
    .catch((e) => {
      log('warn', `智能思考模块加载失败（吞，该功能不可用，主流程不受影响）：${msg(e)}`);
      return null;
    });

  /* ═══════════ 智能压缩「工具触发」（R4，2026-10-08）═══════════
   * 目的：**自动压缩不再伪造用户消息重新拉起会话**（用户明确要求）。
   * 机制：模型调 compact_context ⇒ 登记「下一步压缩」意图 ⇒ 宿主 pre-step 消费并执行轮内压缩
   *       ⇒ 本轮无缝继续。全程零消息（不注入、不投递、不恢复）。
   * 源码依据与替代方案取舍见 plugin/compact-tool.mjs 文件头。 */
  let compactToolApi = null;
  const compactToolReady = import(`./compact-tool.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      compactToolApi = m.createCompactTool({
        svc, tryOf, pick, msg, log, state,
        schedule: (reason, delay) => schedule(reason, delay), // 同 effort：避免 const TDZ
        readCfg: () => ({ enabled: M3.enabled === true }),
        getDefineTool: () => defineToolFn,
        /* R16：档位名集合与解析函数都在 compact-range.mjs（依赖图叶子不 import 内部模块）。
         * ⚠️ 箭头包装：rangeApi 是异步就绪的 const，直接取引用会在建对象时抓到 null。 */
        getRangeApi: () => rangeApi ?? null,
      });
      return compactToolApi;
    })
    .catch((e) => {
      log('warn', `智能压缩模块加载失败（吞，该功能不可用，主流程不受影响）：${msg(e)}`);
      return null;
    });

  /* ═══════════ 保留范围自选（R5，2026-10-07 E2E 之后）═══════════
   * 动机（真机实测，非推测）：E2E 查明 `context-overflow` 的 `retainTokens = 0` 在 **53% 占用**时
   * 就把 surface 从 **1117 节点 / 367,794 token** 砍到 **4 节点 / 8,603 token**。
   * 引擎另有公开方法 `compactRegion(start, end, agent, signal)` ⇒ 范围可由我们给。
   * 取舍、边界重试为何安全、为何不复刻内部配对函数：见 plugin/compact-range.mjs 文件头。
   * 同款 ?ts= 热替换约定（漏掉会在 ESM 里按无参 URL 永久缓存）。 */
  let rangeApi = null;
  const rangeReady = import(`./compact-range.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      rangeApi = m;
      return m;
    })
    .catch((e) => {
      log('warn', `保留范围模块加载失败（吞，回退官方保留策略）：${msg(e)}`);
      return null;
    });

  /** 智能压缩工具懒安装入口（由 pre-step 最前面调用；幂等；总开关关闭时内部直接返回）。 */
  const ensureCompactTool = async () => {
    try {
      mergeConfig();
      if (M3.enabled !== true) return false;
      const api = await compactToolReady;
      return api ? api.ensure() : false;
    } catch (e) {
      log('warn', `智能压缩懒安装异常（吞）：${msg(e)}`);
      return false;
    }
  };

  /**
   * 智能思考懒安装入口 —— **独立于 M2 注入分支**（R3-S4 的结构性修复）。
   * 由 pre-step 的**最前面**调用（新建会话时另由 session/created 兜底）：幂等、无副作用，
   * 开关关闭时内部直接返回。
   * ⚠️ 历史真 bug：该调用曾塞在 M2 注入分支内、且在 `step !== 1` 早退**之后** ⇒
   *    一轮首步就调工具时，后续 pre-step 的 step 恒 > 1 ⇒ 钩子永远装不上
   *    ⇒ 工具接受成功却永不变档（实测 effortToolCalls=1、effortSwitches=0、effortHooks 从未赋值）。
   */
  const ensureEffort = async () => {
    try {
      mergeConfig();
      if (M3.effortEnabled !== true) return false;
      const api = await effortReady;
      return api ? api.ensure() : false;
    } catch (e) {
      log('warn', `智能思考懒安装异常（吞）：${msg(e)}`);
      return false;
    }
  };

  /* 官方 defineTool 异步解析；就绪后若开关已开则补注册（开关关闭时不注册——完全不介入）。
   * ⚠️ 本块必须放在 effortReady / compactToolReady **之后**：回调里引用这两个 const。
   *    微任务语义下「晚于同步求值」本就不会真 TDZ，但把声明排在引用之前才不依赖这个巧合。 */
  loadDefineTool()
    .then(({ defineTool: fn, via, probe }) => {
      defineToolFn = fn;
      state.m3.effortToolLoader = { at: new Date().toISOString(), via, ok: !!fn, probe: probe.slice(-4) };
      if (!fn) {
        log('warn', 'defineTool 不可达 ⇒ 换档/压缩工具均不注册（主流程不受影响）');
        return;
      }
      try { mergeConfig(); } catch { /* 吞 */ }
      if (M3.effortEnabled === true) effortReady.then((api) => api?.ensure());
      if (M3.enabled === true) compactToolReady.then((api) => api?.ensure());
    })
    .catch((e) => log('warn', `defineTool 解析异常（吞）：${msg(e)}`));

  /** 提取一条消息的可见文本（复杂度启发 + 关键词检测共用）。 */
  /* ═══ R13 解耦第五刀：M1 快照域（快照 / 瘦身 / 事件探针）已搬进 plugin/m1.snapshot.mjs ═══
   * `buildSnapshot` 要同时镜像 m2/m3/m5 三域状态并现取 `resolveCompactionFor` 与 `effEnabled()`
   * ⇒ 属「跨域聚合视图」（与 M5 的 buildHudResponse 同类）：跨域依赖全部注入。
   * 落盘**不在这里**——报告管线（loadReportBase / writeReport / 尾部对账 / HISTORY_CAP 淘汰）留在宿主，
   * 本域只负责「产出一条快照」。
   * 懒加载 + 空值降级：未就绪时 buildSnapshot 返回一条**最小可用快照**（含 at/reason/profile），
   * 让 refresh 仍能落盘（宁可少字段，也不要报告断档）——实测窗口只在激活后头几个微任务内。 */
  let m1Ctl = null;

  const m1Ready = import(`./m1.snapshot.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      m1Ctl = m.createM1Snapshot({
        state, log, msg, svc, tryOf, pick, M3, effEnabled, resolveCompactionFor,
        compactMeasure, summarizeBreakdown, extractEventText, SESSION_CAP,
      });
      return m1Ctl;
    })
    .catch((e) => {
      log('warn', `M1 快照模块加载失败（吞，报告降级为最小快照）：${msg(e)}`);
      return null;
    });
  /* R14：把「快照来源」交给 core——`refresh`/`writeReport` 已搬进 core，它按后置注入的
   * `buildSnapshot`/`slimSnapshot`/`isSlimReason` 取快照。**不注入**时 core 用最小快照 + FULL 档位兜底
   * （宁可多写字段，也不要报告断档——R13 真事故就是那个形态）。 */
  m1Ready.then((api) => {
    if (!api) return;
    attachSnapshot({ buildSnapshot: (r) => api.buildSnapshot(r), slimSnapshot: (s) => api.slimSnapshot(s), isSlimReason: (r) => api.isSlim(r) });
  });
  /** 卸载清理用的一次性动作（心跳 timer 等）——宿主自己持有。 */
  const disposers = [];
  const recordSessionEvent = (event, session) => { if (m1Ctl) m1Ctl.recordEvent(event, session); };
  /* ---- 刷新：打一条紧凑摘要 + 落盘 ---- */
  /* ═══ R11 解耦第三刀：M5 HUD 域（存储 / 发布 / 文案 / 聚合响应 / 回填）已搬进 plugin/m5.hud.mjs ═══
   * 顺序依据：R10 之后 M3 的 deps 里出现了 publishHud / recordHudAct / formatAct 三项
   * ⇒ **被依赖者必须先独立**（顺序 M5 → M2 → M1 → core）。
   * 模块是「跨域聚合视图」（getHud 要同时回答压缩历史 / 占用 / 生效上限 / 思考档位），
   * 故四条跨域依赖全部注入：criticalCapOf（R8 阈值）、mergeConfig+M3（M3 配置）、getEffortApi、
   * 以及 measureRatio —— 它的宿主委托在下方 M3 接线处才声明，为**打破声明顺序环**这里用箭头包装
   * （M3 需要 M5 的三个回调、M5 需要 M3 的 measureRatio，两个接线块谁在前都会 TDZ；
   *  箭头延迟到运行时取，两个 const 届时都已初始化）。
   * 懒加载 + 空值降级：未就绪时三个发布口静默 no-op（几微秒窗口），getHud 返回明确错误。
   * ⚠️ `pluginDir` 由 entry 注入 ⇒ hud-acts.json 仍落 plugin/.data/（路径未变，历史不丢）。 */
  let m5Ctl = null;

  const m5Ready = import(`./m5.hud.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      m5Ctl = m.createM5Hud({
        state, log, msg, schedule, pluginDir,
        svc, pick, criticalCapOf, mergeConfig, M3,
        measureRatio: (session) => (m3Ctl ? m3Ctl.measureRatio(session) : { ok: false, error: 'm3-module-pending' }),
        getEffortApi: () => effortApi,
        getReportBase: () => loadReportBase(),
      });
      return m5Ctl;
    })
    .catch((e) => {
      log('warn', `M5 HUD 模块加载失败（吞，弹窗将无数据）：${msg(e)}`);
      return null;
    });
  const formatAct = (reason, tokens, at) => (m5Ctl ? m5Ctl.formatAct(reason, tokens, at) : '');
  const publishHud = (patch) => { if (m5Ctl) m5Ctl.publishHud(patch); };
  const recordHudAct = (sid, text) => { if (m5Ctl) m5Ctl.recordHudAct(sid, text); };
  const buildHudResponse = async (sid) => (m5Ctl ? m5Ctl.buildHudResponse(sid) : { ok: false, error: 'm5-module-pending' });
  const republishFromReport = () => (m5Ctl ? m5Ctl.republishFromReport() : undefined);

  /* ═══ R12 解耦第四刀：M2 注入域（用量行 / 决策卡 / 一次性说明 / 思考后缀 / 注入主体）
   * 已搬进 plugin/m2.inject.mjs ═══
   * 接线顺序 M5 → M2 → M3：M2 提供 `clearBriefed` 给 M3（压缩后重讲），M3 提供 `measureRatio` 给
   * M2/M5 ⇒ 两侧跨域依赖一律注入；**同一个声明顺序环**用箭头包装打破（谁在前都 TDZ）。
   * 懒加载 + 空值降级：未就绪时宿主直接放行（不注入、不阻塞），`clearBriefed` no-op。
   * ⚠️ `createUserMessage` 由宿主异步解析（官方包候选链）⇒ 经 getter 现取；未解析时模块按
   *    `noFactory` 记账并**不注入**（绝不伪造消息结构）。实测窗口只在激活后头几个微任务内。 */
  let m2Ctl = null;
  const m2Ready = import(`./m2.inject.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      m2Ctl = m.createM2Injection({
        state, log, msg, pick, schedule, svc, tryOf, nfmt, summarizeBreakdown, remember,
        M3, effEnabled, criticalCapOf,
        /* measureRatio 的宿主委托在下方 M3 接线处才声明 ⇒ 箭头包装（同上打破 TDZ）。 */
        measureRatio: (session) => (m3Ctl ? m3Ctl.measureRatio(session) : { ok: false, error: 'm3-module-pending' }),
        /* R16.1：压缩自检回执按 sid 存（M3 域内）；M2 消费**本会话**的那份。 */
        takeCompactVerify: (sid) => (m3Ctl ? m3Ctl.takeCompactVerify(sid) : null),
        getRangeApi: () => rangeApi,
        getCompactToolApi: () => compactToolApi,
        getEffortApi: () => effortApi,
        /* R16.12：换档提醒的**外部触发**输入——最近一条真人用户消息文本
         * （实现在 core.lastUserText：只读 surface 尾部并跳过插件自己的注入行）。 */
        getLastUserText: (agent) => lastUserText(agent?.session),
        getCreateUserMessage,
        SOURCE_KIND,
      });
      return m2Ctl;
    })
    .catch((e) => {
      log('warn', `M2 注入模块加载失败（吞，本轮起不注入用量行）：${msg(e)}`);
      return null;
    });
  /** 一次性说明的「已讲」标记清除由 M2 域持有；M3 压缩成功后经此调用（跨域回调，显式注入）。 */
  const clearBriefed = (sid) => { if (m2Ctl) m2Ctl.clearBriefed(sid); };
  log('info', `impl 激活（M1+M2+M3.5 三通道）seq=${++state.seq} @ ${state.implLoadedAt}；报告 → ${reportPath}`);

  /* ═══════════ M2：agent/pre-step 每轮注入用量三元组（镜像 dsh-time-context 惯用法） ═══════════ */

  /** 单会话 measure 失败只告警一次（防日志刷屏）。 */
  /* 官方工厂异步解析；就绪前监听器直接放行（不注入、不阻塞）。 */
  /* ═══ R9/R10 解耦第二刀：M3 压缩域（执行核心 + 编排层）已整体搬进 plugin/m3.compact.mjs ═══
   * 跨域回调（`publishHud` / `recordHudAct` / `formatAct` / `clearBriefed`）与 `schedule`
   * 由宿主**显式注入**——R7 审计列的第二个解耦障碍（「靠闭包穿透别人的域」）就此消除。
   * ⚠️ 接线必须放在这里（而非文件前部的模块区）：`schedule` 在下方才定义，deps 对象是**立即构造**的，
   *    放前面会 TDZ。而 `measureRatio` 虽在更早的 `renderUsageText` 里被引用，但只要**调用发生在初始化之后**
   *    就不受 TDZ 约束（const 的 TDZ 只看运行时求值时刻）。
   * 依赖同样是「懒加载 + 空值降级」（宿主 apply 不是 async，不能 await）：
   * 未就绪时 `measureRatio` 返回 `{ok:false}` ⇒ 本轮不压（安全侧）；`compactWithOwnRange` 返回
   * `source:'none'`；两个编排入口直接 no-op 并留痕。实测窗口只在激活后头几个微任务内。 */
  let m3Ctl = null;

  const m3Ready = import(`./m3.compact.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      m3Ctl = m.createM3Compaction({
        svc, tryOf, state, M3, effEnabled, criticalCapOf, resolveCompactionFor,
        log, msg, pick, nfmt, errCodeOf, schedule,
        publishHud, recordHudAct, formatAct, clearBriefed,
        /* range 模块与压缩工具的生命周期都由宿主拥有 ⇒ 交给模块 async 取用口。 */
        awaitRange: async () => rangeApi ?? (await rangeReady),
        getCompactTool: () => compactToolApi,
        COMPACT_TIMEOUT_MS, SET_CAP,
      });
      return m3Ctl;
    })
    .catch((e) => {
      log('warn', `M3 压缩域模块加载失败（吞，本轮不压）：${msg(e)}`);
      return null;
    });
  const measureRatio = (session) => (m3Ctl ? m3Ctl.measureRatio(session) : { ok: false, error: 'm3-module-pending' });
  const compactWithOwnRange = async (agent, compaction, ctx) =>
    (m3Ctl
      ? m3Ctl.compactWithOwnRange(agent, compaction, ctx)
      : { result: null, source: 'none', skipWhy: 'm3-module-pending', retainBudget: null, walkBacks: 0 });
  /** pre-step 轮内先压（M3.5 通道 1）：模块未就绪时 no-op 并留痕（绝不上抛）。
   *  R15：**仅当有人登记了压缩意图**时补一条「未执行」自检回执——这正是 R11–R13 真机失效的形态
   *  （工具回 `ok/scheduled`，而消费者模块不在），必须让模型看得见。 */
  const preStepCompaction = async (payload) => {
    if (!m3Ctl) {
      try {
        const sid = String(pick(payload?.agent?.session?.id, payload?.agent?.sessionId, payload?.agent?.id, 'unknown'));
        if (compactToolApi?.peekIntent?.(sid)) {
          state.m3.lastCompactVerify = {
            at: new Date().toISOString(), sessionId: sid, state: 'not-executed',
            why: 'm3-module-missing', read: false,
          };
        }
      } catch { /* 吞 */ }
      log('warn', 'M3 pre-step 先压：压缩域模块未就绪，本轮跳过');
      return;
    }
    return m3Ctl.preStepCompaction(payload);
  };
  /** idle 安全网（M3-b）：模块未就绪时 no-op（下次状态翻转会再来）。 */
  const idleSweep = (agent) => {
    if (!m3Ctl) return;
    return m3Ctl.idleSweep(agent);
  };

  /* ---- M2.5 新会话一次性插件说明：让任何新会话的 Agent 不靠外部文档就明白压缩流程与用法 ----
   * A3（审查）：由冻结常量改为函数——原实现 apply 期拼死 M3.marker 与「85%」字样，config 热改后
   * 说明文本与活值检测（事件解析/政策卡）自相矛盾；现每次注入现拼活值。
   * ⚠️ R4（2026-10-08）：文本已改为**工具版**，且本体搬进 plugin/compact-tool.mjs（压缩域自持，
   *    与 effort.mjs 同构）。旧文本教的是「本轮挂起 + 写标记 + 压缩后自动拉起」——那条链路已被
   *    用户否决（伪造用户消息）；此处只做出口，漏改会导致模型**等一个永远不来的恢复**。 */
  state.listeners['agent/pre-step'] = addListener(
    'agent/pre-step',
    async (payload, next) => {
      /* 智能思考：懒安装**先于一切**（R3-S4：与 M2 注入分支彻底解耦，任何早退都影响不到它）。
       * 幂等 + 开关关闭时内部直接返回 ⇒ 放在最前面零成本。 */
      await ensureEffort();
      /* 智能压缩工具（R4）：同款懒安装——同样必须在早退之前，否则「工具接受了却没有人消费意图」
       * 会重演 R3 那个真 bug（工具成功、永不生效）。 */
      await ensureCompactTool();
      await preStepCompaction(payload); // M3.5 通道1：轮内先压（绝不上抛）
      const decision = await next();
      if (!decision || decision.kind === 'reject') return decision;
      if (!effEnabled()) return decision; // 总开关关闭：完全恢复原生 DSH（不注入）
      try {
        /* R12：注入主体已搬进 plugin/m2.inject.mjs（buildInjection）。
         * 宿主只做两件事：**决定放行** + 把模块给的消息并进决策。
         * 模块未就绪时直接放行（不注入、不阻塞）——与其它域同款懒加载降级。 */
        if (!m2Ctl) return decision;
        const injected = await m2Ctl.buildInjection(payload);
        if (!injected || injected.skip) return decision;
        return { ...decision, messages: [...(decision.messages ?? []), injected.message] };
      } catch (e) {
        log('warn', `M2 注入异常（放行原决策）：${msg(e)}`);
        return decision;
      }
    },
    { prepend: false },
  );

  /* ═══════════ M1：会话/事件盘点 ═══════════ */

  state.listeners['session/created'] = addListener('session/created', (session) => {
    log('info', `session/created id=${pick(session?.id, session?.header?.id)} → 安排重测`);
    /* 智能思考：新会话的 agent/request 钩子必须补装（新会话自动覆盖）。此处只是提前一发，
     * 真正的保证在 pre-step 最前面 —— 那条路径不可能被任何早退绕过。 */
    ensureEffort().catch(() => {});
    schedule('session/created', 1500);
  });
  /* ═══════════ M3-a：turn 前审计 —— **已于 R7 整体删除** ═══════════
   * 这块挂的是 `agent/inbox/inserted`，只做两件事：
   *   ① 「该任务场景是否会想压」的**纯审计**（decisions / wouldCompact / lastDecision）——
   *      v1 实弹结论（2026-10-06）已证明此处 agent 是 waking 状态、compactNow 必 busy，
   *      所以它**从不执行压缩**，只写报告；决策主体移交模型后这些计数再无消费者；
   *   ② 关键词「先压缩」武装 —— 该通道已于 2026-10-06 按用户决定裁撤。
   * ⇒ 监听器连同 `decideCompaction` 的审计出口一起删除。**压缩触发只剩两条**：
   *   pre-step 轮内（工具意图 / 越强制线）与 idle 安全网（sweepBelow）。 */

  state.listeners['agent/status'] = addListener('agent/status', (payload) => {
    try {
      const { agent, status } = payload ?? {};
      const st = status ?? payload;
      log('info', `agent/status → ${typeof st === 'object' ? JSON.stringify(st) : String(st)}`);
      if (agent && (status === 'idle' || st === 'idle')) idleSweep(agent);
    } catch (e) {
      log('warn', `agent/status 处理异常（吞）：${msg(e)}`);
    }
    schedule('agent/status', 1500);
  });

  /* ---- 事件形状探针（**唯一职责**：记录到达的 session/event，供协议取证）----
   * R7 起本监听器**不再有任何业务逻辑**：它原来还负责「模型回复尾部标记 → idle 自动压缩」，
   * 那条通道已随 marker 整体退役（压缩改由工具在轮内完成）。
   * 保留探针的理由：本插件依赖多个**未文档化**的内部事件（`session/event` 的形状、
   * `agent/inbox/*`、`step/*`），M1 阶段正是靠它一次性摸清了事件形状；
   * 成本仅为一次类型计数 + 至多 12 条样本（slim 报告档位会丢弃），换的是下次 API 变动时能立刻看见。
   * ⚠️ 探针**纯只读**：不得在此监听器里加入任何会改状态或触发压缩的逻辑（那正是 R7 删掉的东西）。 */
  state.listeners['session/event'] = addListener('session/event', (session, event) => {
    try {
      /* R13：探针实现已搬进 plugin/m1.snapshot.mjs（recordEvent）——只读形状探针。 */
      recordSessionEvent(event, session);
    } catch (e) {
      log('warn', `M3.6 标记处理异常（吞）：${msg(e)}`);
    }
  });
  log('info', `事件监听：${JSON.stringify(state.listeners)}`);

  /* ---- 心跳：低频跟踪（每次 refresh → 报告） ----
   * 2026-10-06 14:2x–14:5x 实证结论（本项超出审查 A1 范围，是实施中发现的**新事实**，已修正两个错误假设）：
   *  ① 原写法 `const every = t?.interval ?? ctx?.interval` 取**未绑定方法引用** ⇒ 丢 this 必抛 ⇒ 被 catch 吞
   *     （timer.interval 实现首行即 `this.ctx.effect(...)`）——心跳连注册都没成功过。
   *  ② 但绑定修好、注册成功（返回 disposer）后**仍零触发**；改用 setTimeout 链 / setInterval / 去 unref 皆然
   *     （`ticks` 恒 0、探针日志从未创建），而同一 apply 体内的 `activation+2s`/`boot+10s` 全部准时。
   *  ③ **真因（cordis 语义，lib/index.js:1142 实证）**：`ctx.effect(execute)` 的 execute **立即执行=setup，
   *     其返回值才是卸载器**。而「卸载清理」块把清理语句**内联写在 execute 体内** ⇒ ① 清理在 **apply 期**
   *     就被执行，此时 disposers 里已含刚入册的心跳 timer ⇒ **心跳被当场 clearTimeout/clearInterval 掉**；
   *     ② 真正的卸载时**反而毫无清理**（pending/resumeTimers/心跳全泄漏）——这也解释了 A1 僵尸 interval
   *     为何能扛过每一次 toggle（它的 disposer 在清理块跑完之后才入册，永不被调用）。
   *  修法：清理块 execute 体内 `return () => {...}`（与官方 TimerService 同款）；心跳直接同步注册，
   *     其 disposer 现在只会在真正卸载时被调用。 */
  try {
    const h = setInterval(() => { try { schedule('heartbeat', 0); } catch { /* 吞 */ } }, HEARTBEAT_MS);
    h.unref?.();
    disposers.push(() => { try { clearInterval(h); } catch { /* 吞 */ } });
    state.heartbeat = { via: 'setInterval+unref(apply 内注册)', type: typeof h, at: new Date().toISOString(), ms: HEARTBEAT_MS };
    log('info', `心跳已注册（${state.heartbeat.via}，每 ${HEARTBEAT_MS / 1000}s）`);
  } catch (e) {
    state.heartbeat = { via: null, error: msg(e), at: new Date().toISOString() };
    log('warn', `心跳注册失败（不影响主流程）：${msg(e)}`);
  }

  /* ---- 卸载清理 ----
   * ⚠️ 2026-10-06 14:5x 修正（关键，A7 的「timer 入表」因此才真正成立）：
   * cordis `ctx.effect(execute)` 语义 = **execute 立即执行（setup），返回值才是卸载器**
   * （lib/index.js:1142 `const effect = runner.execute.call(this); if (typeof effect === 'function') return runner.collect(effect)`）。
   * 原实现把清理语句内联在 execute 体内 ⇒ 清理在 apply 期被误执行（当场清掉刚注册的心跳、pending 里的
   * 启动刷新），而真正的卸载时无任何清理。**必须 return 一个函数**（同官方 TimerService 写法）。 */
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        for (const t of pending.values()) { try { clearTimeout(t); } catch { /* 吞 */ } }
        pending.clear();
        for (const d of disposers) { try { d?.(); } catch { /* 吞 */ } }
      }, 'context-pilot:cleanup');
    }
  } catch { /* 清理注册失败不致命 */ }

  /* ---- M5 HUD 轮询面注册（client 每 5s getHud；typert-loader 自动发现 + ctx.provide 兜底） ----
   * B4（审查批次3）：wire 动态 import（带 ?ts=）——静态相对导入解析回无参 URL 命中进程缓存（P16），
   * face 逻辑被冻结在重启版本；动态加载后 wire 随 impl 同批热换（TYPERT 声明走包 exports，不受影响；
   * wire 模块纯导出无顶层副作用，已核对）。动态 import 异步 ⇒ 注册晚一拍（client inject 回调/5s 轮询天然容忍）。 */
  import(`./wire.host.mjs?ts=${state.seq}-${Date.now().toString(36)}`)
    .then((hudWire) => {
      const face = hudWire.createRemoteFace({
        /** sid 可选：传会话 id 则返回该会话（含血统链）的最近压缩；空=全局。
         *  **同时**返回全局最近记录（actsGlobal/hudLastActGlobal）作兜底——实测多会话交错/ id 摆动时
         *  按 id 过滤会空（用户「记录经常丢失」的最终根因），client 侧按「本会话优先、全局兜底」显示并标注。 */
        /* R11：getHud 聚合响应主体已搬进 plugin/m5.hud.mjs（跨域聚合视图，四条数据线全部注入）。
         * sid 可选：传会话 id 则返回该会话的压缩记录；空=全局。模块未就绪时返回明确错误（client 有兜底）。 */
        onGetHud: async (sid) => buildHudResponse(sid),
      });
      if (typeof ctx?.provide === 'function') {
        ctx.provide(hudWire.FACE_NAME, face);
        state.m5.hudFace = 'provided';
        log('info', `HUD 轮询面 ${hudWire.FACE_NAME} 已注册（ctx.provide，B4 动态热换）`);
      } else {
        state.m5.hudFace = 'no-provide';
        log('warn', 'ctx.provide 不可用：HUD 轮询面未注册（HUD 行将无数据，不影响主流程）');
      }
    })
    .catch((e) => {
      state.m5.hudFace = 'error';
      log('warn', `HUD 轮询面注册失败（吞）：${msg(e)}`);
    });

  /* ---- M5 HUD 启动回填：报告最近压缩记录重发布到面板（弹窗不再空态）。
   * R11：主体已搬进 plugin/m5.hud.mjs（republishFromReport）；宿主只留**重试节奏**
   * （激活时同步 1 发 + 1.2s/4s/10s 各 1 发；幂等，报告读失败/竞态可自愈）。 ---- */
  const bfOnce = () => republishFromReport();
  try {
    bfOnce();
    for (const ms of [1200, 4000, 10000]) {
      const bt = setTimeout(bfOnce, ms);
      bt.unref?.();
    }
  } catch { /* 吞 */ }
  /* ---- 启动快照：激活后 2s 一发，10s 再一发（捕捉晚到的会话重水化） ---- */
  schedule('activation+2s', 2000);
  schedule('boot+10s', 10000);

  return { reportPath };
}
