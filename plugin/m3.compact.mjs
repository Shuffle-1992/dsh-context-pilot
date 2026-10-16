/**
 * M3 压缩域（R9 抽执行核心 / R10 搬入编排层）—— 压缩的**全部实现**。
 *
 * ## 分两层（R7 审计的划分，R10 起两层都在本模块）
 * - **执行核心**：`measureRatio`（测量读数收敛）+ `compactWithOwnRange`（自选范围执行 +
 *   `prevEnd` 回退 + 官方兜底）。依赖只有 `svc`/`tryOf`/`state`/range 取用口。
 * - **编排层**：`preStepCompaction`（轮内先压：意图消费 / 阈值门控 / 强制线收口 / 留痕）+
 *   `idleSweep`（idle 安全网）。它天然要碰 M2 教学（`clearBriefed`）、M5 HUD
 *   （`publishHud`/`recordHudAct`/`formatAct`）与报告（`schedule`）——R10 把这些**全部改成显式注入**，
 *   于是 M3 不再「隔着单例 state 与闭包去改别人的域」。
 *
 * ## 边界纪律（与前六把刀同构）
 * - 依赖**全部注入**，对宿主内部件零 import ⇒ 依赖图叶子。
 * - 由宿主 `import(\`./m3.compact.mjs?ts=${IMPL_TS}\`)` 加载（漏掉 `?ts=` 会像 P16 那样永久缓存）。
 * - **不抛错**：`preStepCompaction` / `idleSweep` 各自整体 try/catch 并留痕；
 *   `compactWithOwnRange` 只把**非校验类**异常上抛（外层要决定重试/上报，这是刻意的）。
 * - 宿主 `apply` 不是 async ⇒ 宿主侧一律「懒加载 + 空值降级」（见宿主注释）。
 *
 * ## 语义要点（全部是实证结论，搬迁时逐字保留）
 * - 保留比例是 **range 模块自己的常量**（= 引擎 `DEFAULT_RETAIN_RATIO` 0.16），不放进 M3 配置：
 *   M3 的语义是「用户可配项」（且有「M3 字段必须在 schema 中」的护栏），面板可调需 schema 字段 + 重启。
 * - 「没什么可压」且**未越强制线** ⇒ 就此收手（`source: 'none'`）。回退官方 = `retainTokens 0` = 把整段砍光。
 * - 末端边界不合法 ⇒ 沿 surface 回退一个节点重试（`prevEnd`）；该校验发生在 `compaction/start` 之前
 *   （引擎 lib:452 vs :469）⇒ **零副作用、零 LLM 成本**的纯读，所以敢循环。
 * - 强制线收口：自选范围后仍越线 ⇒ 追加官方 overflow（保住「越强制线必定压到线下」的旧承诺）。
 * - idle 与 pre-step 都钳到 `min(配置, 引擎阈值 − 5pp)` 之下（5pp 理由见 threshold.mjs）。
 */

/** R38（2026-10-16）：面板/记录行里的「压后占用」后缀——**三条路径共用一份**
 * （引擎/手动、pre-step 自选范围、idle 扫除），避免"同一物理量三处各写一遍"（本项目多次踩坑）。
 * `stale`（surface 比 provider 上报时缩水 >50%）⇒ 带「provider 待刷新，下次请求后会回落」：
 * 刚压完的表盘是**过渡值**（真机：12.6% → 13 分钟后 5%，见 R37 的账本算术）。 */
export function occupancyActSuffix(ratioAfter, stale) {
  if (!Number.isFinite(ratioAfter)) return '';
  return ` · 压后占用 ${(ratioAfter * 100).toFixed(1)}%${stale ? '（provider 待刷新，下次请求后会回落）' : ''}`;
}

/** R39（2026-10-16 用户实测后决定「让档位名副其实」）：保留预算的**真实口径折算**。
 * 起因：档位名（保留窗口 × 24%）按**启发式** token 算，而表盘真实值 ≈ 启发式 × 1.3–1.5
 * （6 个会话实测 1.31/1.32/1.38/1.43/1.46/1.51）⇒「浅压24%」压完表盘落在 ~40%，名不副实；
 * 而 DSH 原生 `/compact`（只留 3.9K 消息）能压到 5%。修：`budget / factor`。
 * ⚠️ factor **夹在 [1,2]** ⇒ **只减不增**（绝不让档位保留得比它承诺的更多）；
 * ⚠️ factor 只允许来自**非 stale** 的实测（stale 是"刚压完的过渡值"，用它会把预算压过头）。 */
export function scaleRetainBudget(budget, factor) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return budget;
  const f = Number.isFinite(factor) ? Math.min(Math.max(factor, 1), 2) : 1;
  return Math.max(1, Math.round(b / f));
}

export function createM3Compaction(deps) {
  const {
    /* 只读依赖 */
    svc, tryOf, state, M3, effEnabled, criticalCapOf, engineThreshold, resolveCompactionFor,
    /* R25：占用口径单源（core.mjs 注入；m1 报告账本用同一份） */
    projectedFromPressure,
    /* R39：可见组成（系统+工具+消息）单源 —— 真实口径折算要用它 */
    summarizeBreakdown,
    /* 工具 */
    log, msg, pick, nfmt, errCodeOf, schedule,
    /* 跨域回调（R10：由宿主显式注入，不再靠闭包穿透） */
    publishHud, recordHudAct, formatAct, clearBriefed,
    /* 取用口（模块生命周期由宿主拥有） */
    awaitRange, getCompactTool, extractEventText,
    /* 常量 */
    COMPACT_TIMEOUT_MS, SET_CAP,
  } = deps;

  /**
   * B2（审查）：measure + pressure 读取**收敛为单一来源**——
   * `renderUsageText`（每轮注入的用量行）/ `preStepCompaction` / `idleSweep` 三处共用。
   * 返回 `measure` 本体（`nodes = {seq,tokens,heuristicTokens}[]`，官方承诺 deeply immutable
   * ⇒ 持有引用安全）：自选范围需要它；报告侧仍走 `compactMeasure` 的白名单，不会因此膨胀。
   */
  const measureRatio = (session) => {
    const tm = svc('tokenMeter');
    const m = tryOf(() => tm?.measure?.(session));
    if (m.error || !m.value) return { ok: false, error: m.error ?? 'no measure' };
    const sp = svc('sessionProjections');
    const pressure = tryOf(() => sp?.stateOf?.(session, 'contextPressure'));
    const pressureRec = pressure.error ? null : pressure.value ?? null;
    const total = m.value.totalTokens ?? null;
    const surface = m.value.surfaceTokens ?? null;
    const window = pressureRec?.contextWindow ?? null;
    /* ═══ R24（2026-10-15 用户实测「插件说 24%、DSH 显示 41%」）：占用口径**对齐 DSH 表盘** ═══
     * DSH 源码 `ContextMeter.js`：`contextOccupancy(p)` 用 `p?.projectedTokens ?? p?.pressureTokens`
     *   —— 依次为「**下一请求的 prompt 预计大小**」→「**最新一次 provider 实报的 prompt 大小**」。
     * DSH 文档（tokenMeter）：`contextBreakdown`（系统/工具/对话三行）是**启发式组成**，
     *   「`messageTokens` includes every other visible node, **including superseded prompts**」，
     *   且三个数都用固定启发式，「**not route image pricing or file-handle projection**」。
     * 我们此前用 `measure().totalTokens`（同一份启发式节点总和）⇒ 与用户看到的表盘**不是同一个口径**，
     * 真机后果：我方按 75.1% 判定越线并压掉 243K，而 DSH 口径当时只有约 41%（**提前压缩 = 白压**）。
     * 现 `used` = DSH 口径（触发判定 + 显示都用它）；`total`/`surface` 保留供取证。 */
    /* ⚠️ R24.1/R25：**不要在这里重写公式** —— `projectedTokens` 只存在于 token-meter 的 wire.view，
     * 投影 state 只有 `surfaceTokens / pressureTokens / sampledSurfaceTokens`，直接退回 `pressureTokens`
     * 会拿到**过期的** provider 实报值（真机压缩后仍是 748,806/74.9%，而表盘已是 51%→40%）。
     * 公式的唯一一份实现在 `core.mjs#projectedFromPressure`（由宿主同 ts 注入，m1 报告账本共用）。 */
    if (typeof projectedFromPressure !== 'function') return { ok: false, error: 'projected-from-pressure-missing' };
    const proj = projectedFromPressure(pressureRec);
    const projected = proj.projected;
    const reported = proj.reported;
    const used = proj.used ?? total;   // 连 provider 数据都没有 ⇒ 退化为本地启发式（并标明退化）
    const basis = proj.used != null ? proj.basis : '本地启发式(退化)';
    /* ═══ R29（2026-10-15 真机：手动 `/compact` 后表盘 13.1%，而 surface 只剩 6.2K ≈ 2.4%）═══
     * 投影公式 `provider实报 + (当前 surface − 上报时 surface)` **假设"非 surface 开销"不变**；
     * 大压缩后 surface 骤降、而那份旧开销（本例 350,476 − 225,221 = 125,255）仍在分子里
     * ⇒ 投影**系统性偏高**，要等 provider 实报新 prompt 才回落。此处只**标注**（`stale`），
     * 供显示层加一句「provider 待刷新」；⚠️ 不参与判定（方向偏高 = 保守）。 */
    const stale = proj.reported != null && proj.sampled != null && proj.surface != null
      && proj.sampled > 0 && proj.surface < proj.sampled * 0.5;
    const ratio = window && used != null ? used / window : null;
    return { ok: true, used, total, surface, window, ratio, basis, projected, reported, sampled: proj.sampled, stale, measure: m.value };
  };

  /* ═══ R16.18：比例历史（动态余量的输入） ═══
   * 每次 pre-step 测量都记一条 ⇒ 用「单步最大增量」估计一步能涨多少（决定余量）。
   * 有界化：每会话 ≤ RATIO_HIST_CAP 条、会话数 ≤ RATIO_SID_CAP（防长期累积，同 tierBySid 先例）。 */
  const RATIO_HIST_CAP = 12;
  const RATIO_SID_CAP = 64;
  const recordRatioSample = (sid, ratio, mr) => {
    try {
      state.m3.ratioHist = state.m3.ratioHist ?? {};
      const hist = state.m3.ratioHist[sid] ?? [];
      hist.push({ at: Date.now(), ratio, used: mr?.used ?? null });
      while (hist.length > RATIO_HIST_CAP) hist.shift();
      state.m3.ratioHist[sid] = hist;
      const keys = Object.keys(state.m3.ratioHist);
      if (keys.length > RATIO_SID_CAP) {
        const oldest = keys.reduce((a, b) => {
          const ta = state.m3.ratioHist[a]?.[state.m3.ratioHist[a].length - 1]?.at ?? 0;
          const tb = state.m3.ratioHist[b]?.[state.m3.ratioHist[b].length - 1]?.at ?? 0;
          return ta <= tb ? a : b;
        });
        if (oldest !== sid) delete state.m3.ratioHist[oldest];
      }
    } catch { /* 吞 */ }
  };

  /* ═══ R16.13：我们自己的压缩「在飞标记」（区分事件流里的自己 vs 引擎）═══
   * 起因（用户实测）：另一个会话中途被**引擎自动压缩**两次，插件面板里一条记录都没有。
   * 取证：会话日志 `compaction/start {turn:29, src:engine}` 而 hud-acts 里该 sid 只有旧记录。
   * 机制：插件的 pre-step 走 `compactRegion(start, end, agent, signal)`（引擎签名**无**
   * sourceCommandId）⇒ 其事件与引擎自动压缩在事件流里**无法区分**；故用时间窗把
   * 「我自己的压缩」圈出来，供 session/event 监听器跳过补记（只有引擎/手动压缩才补记）。
   * TTL 兜底：某条路径异常未清（await 抛错等）时，窗口过期即失效，不会永久吞掉引擎事件。 */
  const OWN_COMPACT_TTL_MS = 90000;
  const markOwnCompaction = (sid) => {
    try { state.m3.ownCompact = { at: new Date().toISOString(), sessionId: String(sid ?? ''), until: Date.now() + OWN_COMPACT_TTL_MS }; } catch { /* 吞 */ }
  };
  const clearOwnCompaction = () => { try { state.m3.ownCompact = null; } catch { /* 吞 */ } };
  /** 是否有「我们自己的压缩」正在进行（事件监听器据此跳过补记）。 */
  const isCompactionInFlight = () => {
    try {
      const o = state.m3.ownCompact;
      return !!(o && Number(o.until) > Date.now());
    } catch { return false; }
  };

  /* ═══ R28（2026-10-15 真机：同一会话连试 3 次 `/compact` 全失败）═══
   * 缺口：记录只知道「失败」，**不知道失败原因**；而原因只存在于内存态 `lastEngineCompact.error`
   * ⇒ 面板那行（用户可见、且落盘 `hud-acts.json`）写着「失败」，事后无法回答"为什么压不动"。
   * 修：把 DSH 的失败码翻成中文短语写进**面板行**与记录。
   * `compaction/end.error?: string`（DSH 事件 schema 原文）；已知码来自 dsh-compaction 的
   * `ManualCompactionErrorCode`（闭集）：summary / changed / busy / cancelled / commit / persistence。
   * ⚠️ 认不出码 ⇒ **截断原文照抄**，绝不编造原因。 */
  const COMPACT_FAIL_LABELS = {
    summary: '摘要无法生成', changed: '选中历史已变化', busy: '有压缩在跑或会话非空闲',
    cancelled: '已取消', commit: '提交未干净完成', persistence: '会话保存失败',
  };
  const failWhy = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return '原因未提供';
    const low = s.toLowerCase();
    const hit = Object.keys(COMPACT_FAIL_LABELS).find((k) => low.includes(k));
    if (hit) return COMPACT_FAIL_LABELS[hit];
    return s.length > 48 ? `${s.slice(0, 48)}…` : s;
  };

  /* ═══ R16.13：补记「非插件发起」的压缩（引擎自动 / `/compact` 命令）═══
   * 起因（用户实测）：另一会话中途被引擎自动压缩两次，插件面板/报告里一条记录都没有。
   * 取证：会话日志有 `compaction/start {turn:29, src:engine}`，而 hud-acts 里该 sid 只有旧记录。
   * 机制：插件只在**自己**的 pre-step / idle 路径写记录；引擎自动压缩（context-overflow 恢复 /
   * 引擎阈值）与命令压缩全程绕过插件 ⇒ 无记录。现由 session/event 的 `compaction/end` 补记。
   * 去重：① sourceCommandId=context-pilot（插件 idle 路径自带标记）跳过；
   *       ② isCompactionInFlight()（插件 pre-step 的 compactRegion 无标记，用时间窗圈定）跳过。
   * 只在 **end** 记（start 未完成就报成功会误导）；失败也记（否则「压了但失败」同样无痕）。 */
  const noteEngineCompaction = (event, session) => {
    try {
      const d = event?.data ?? {};
      const src = d.sourceCommandId;
      if (src === 'context-pilot') return null; // 插件 idle 路径（已在 idle 里记过）
      if (isCompactionInFlight()) return null;  // 插件 pre-step 路径（在飞窗口内）
      const sidE = String(pick(session?.id, session?.header?.id, ''));
      if (!sidE) return null;
      const kind = typeof src === 'string' && src.startsWith('cmd') ? 'manual' : 'engine';
      const mr = measureRatio(session);
      const ratioAfter = mr?.ok && Number.isFinite(mr.ratio) ? mr.ratio : null;
      /* R16.14（评审建议 7）：把「系统代你决策」显性化——若本会话**从未申报档位**，
       * 这次强制压缩用的是兜底 standard，而模型很可能以为「我没选=系统会按需要选」。
       * 标出来才有动机在低占用时提前用 `action:'set-tier'` 声明档位。 */
      const declared = (() => { try { return getCompactTool()?.hasTier?.(sidE) === true; } catch { return false; } })();
      /* R16.18：把「引擎为什么抢先」写进记录——真机问题是「上一轮 67% 说不压，新一轮却自动压了」，
       * 根因是引擎在 **step 边界** 按自己的阈值判定、且排在插件 pre-step 之前。
       * 附上**我方上一次估计**与**我方当时的线**，一眼可判「是不是被抢先」。 */
      const lastSeen = (() => {
        try {
          const hist = state.m3.ratioHist?.[sidE];
          const v = Array.isArray(hist) && hist.length ? hist[hist.length - 1].ratio : null;
          return Number.isFinite(v) ? v : null;
        } catch { return null; }
      })();
      const ourLine = (() => { try { const c = criticalCapOf({ session: { id: sidE } }); return Number.isFinite(c) ? c : null; } catch { return null; } })();
      /* R29（2026-10-15 真机误报）：`preempted` 只对**引擎自动**压缩成立——手动 `/compact` 是用户
       * 主动压的，标「引擎抢先」纯属误报（19:54 那条：手动压缩却被写成"引擎抢先…排在插件之前"）。 */
      const preempted = kind === 'engine' && Number.isFinite(lastSeen) && Number.isFinite(ourLine) && lastSeen < ourLine;
      const base = formatAct(kind === 'manual' ? 'engine-manual' : 'engine-auto', null);
      /* R19：展示统一中文档位说法（这条 text 会进弹窗 tooltip ⇒ 属用户可见面）。
       * R22：兜底也**不许回英文 id**（旧写法 `?? 'standard'` 在工具域未加载时会把 id 写进 tooltip）
       * ⇒ 退成中性的中文说法，宁可少给数值也不给英文。 */
      const stdText = (() => { try { return getCompactTool()?.tierText?.('standard') ?? '默认档'; } catch { return '默认档'; } })();
      /* R37/R38（2026-10-16 真机）：压缩刚完成时表盘是**过渡值**——`providerReported` 还是压缩前的旧实报，
       * 只按 surface 增量修正（真机：387,168 + 8,194 − 269,183 = 126,179 = 12.6%，而真实值 5%）。
       * 面板那行必须带 `stale` 提示（后缀由 occupancyActSuffix 单源提供，三条路径共用）。 */
      const text = base
        + (declared ? '' : ` · 系统代压（本会话未申报档位 ⇒ 按兜底 ${stdText}）`)
        + (preempted ? ` · 引擎抢先：我方上次估计 ${(Number(lastSeen) * 100).toFixed(1)}% ＜ 我方线 ${(Number(ourLine) * 100).toFixed(0)}%（引擎在 step 边界判定，排在插件之前）` : '')
        + (d.error ? ` · 失败（${failWhy(d.error)}）` : occupancyActSuffix(ratioAfter, mr?.stale));
      recordHudAct(sidE, text);
      publishHud({ hudLastAct: text });
      state.m3.engineCompacts = (state.m3.engineCompacts ?? 0) + 1;
      /* R28：失败/成功都**立刻落一次报告快照**——原来这里没有 schedule ⇒ 引擎压缩（尤其失败）
       * 可能长时间不进报告（真机：hud-acts 有 3 条失败，报告里一条都没有）。 */
      schedule('engine-compact', 300);
      state.m3.lastEngineCompact = {
        at: new Date().toISOString(), sessionId: sidE, kind,
        sourceCommandId: src ?? null, ok: !d.error,
        error: d.error ? String(d.error).slice(0, 200) : null,
        reason: d.error ? failWhy(d.error) : null,   // R28：中文短语（与面板行同源）
        ratioAfter, tierDeclared: declared, preempted: !!preempted,
        ourLastRatio: Number.isFinite(lastSeen) ? +(Number(lastSeen) * 100).toFixed(1) : null,
        ourLine: Number.isFinite(ourLine) ? +(Number(ourLine) * 100).toFixed(0) : null,
        recorded: text,
      };
      log('info', `M3.13 补记非插件压缩（${kind}${d.error ? '，失败' : ''}）：${text}`);
      return text;
    } catch (e) {
      log('warn', `M3.13 补记异常（吞）：${msg(e)}`);
      return null;
    }
  };

  /* ═══ R16.1：压缩自检回执按 sid 存 ═══
   * 多会话并发压缩时，全局单槽 `lastCompactVerify` 会被后完成的会话覆盖 ⇒ 另一个会话的
   * Agent 看不到自己的回执（压缩本身不受影响，但「工具完成后自检」在那条会话失效）。
   * `verifyBySid`：每会话一份（有界化：SET_CAP，超出淘汰最旧）；
   * `lastCompactVerify`：保留为「最近一次」的全局镜像（HUD/报告口径不变，兼容旧取证习惯）。 */
  const setCompactVerify = (sid, v) => {
    try {
      const key = String(sid ?? 'unknown');
      state.m3.verifyBySid = state.m3.verifyBySid ?? {};
      state.m3.verifyBySid[key] = v;
      const keys = Object.keys(state.m3.verifyBySid);
      if (keys.length > SET_CAP) {
        const oldest = keys.reduce((a, b) => ((state.m3.verifyBySid[a]?.at ?? '') <= (state.m3.verifyBySid[b]?.at ?? '') ? a : b));
        if (oldest !== key) delete state.m3.verifyBySid[oldest];
      }
      state.m3.lastCompactVerify = v;
    } catch { /* 吞（留痕失败不影响压缩本身） */ }
  };
  /** M2 域消费回执：取**本会话**的未读回执，读到即置 read（一次性）。 */
  const takeCompactVerify = (sid) => {
    try {
      const key = String(sid ?? 'unknown');
      const v = state.m3.verifyBySid?.[key];
      if (!v || v.read) return null;
      v.read = true;
      return v;
    } catch { return null; }
  };

  /* ═══ R39：真实口径折算因子（每会话一份；**只用非 stale 的实测**更新）═══
   * `visible` = 系统 + 工具 + 消息（`summarizeBreakdown` 单源）——即"三行组成"；
   * `factor = 表盘真实 / visible`，夹在 [1,2]。stale（刚压完的过渡值）时**不更新**：
   * 过渡值里 provider 旧报还扛着压缩前的大数，用它折算会把预算压过头。 */
  const noteRetainFactor = (sid, mr) => {
    try {
      if (!sid || !mr?.ok || mr.stale) return null;
      const bv = summarizeBreakdown?.(mr.measure);
      const vis = bv ? (Number(bv.system) || 0) + (Number(bv.tools) || 0) + (Number(bv.messages) || 0) : null;
      if (!Number.isFinite(vis) || vis <= 0 || !Number.isFinite(mr.used)) return null;
      const factor = Math.min(Math.max(mr.used / vis, 1), 2);
      const bySid = state.m3.retainFactor = state.m3.retainFactor ?? {};
      bySid[sid] = { factor: +factor.toFixed(2), at: new Date().toISOString(), real: mr.used, visible: vis };
      const keys = Object.keys(bySid);
      if (keys.length > 64) delete bySid[keys[0]];   // 有界化
      return factor;
    } catch { return null; }
  };
  const retainFactorOf = (sid) => {
    try { const f = state.m3.retainFactor?.[sid]?.factor; return Number.isFinite(f) ? f : 1; } catch { return 1; }
  };

  /**
   * 执行一次压缩：**优先自选保留范围**（近端原样保留、更早转摘要），失败则按语义退回官方策略。
   * R16：保留预算按**会话档位**（Agent 经工具选择的 tier，会话级持久）解析；未选/非法 ⇒ standard。
   * @returns {Promise<{result:any, source:'own'|'official'|'none', skipWhy?:string|null,
   *   officialWhy?:string|null, retainBudget:number|null, walkBacks:number, tier?:string,
   *   range?:{start:number,end:number}}>}
   */
  const compactWithOwnRange = async (agent, compaction, ctx) => {
    const { forced, sig, sid, window, measure, tierName, retainOverride, anchorSeq, anchorFailReason } = ctx;
    const official = async (why) => {
      markOwnCompaction(sid);
      try {
        return {
          result: await compaction.service.compactIfNeeded(agent, 'context-overflow', sig),
          source: 'official',
          officialWhy: why ?? null,
          retainBudget: null,
          /* R21.2（真机发现）：官方兜底路径**也必须带上保留来源与锚点失败原因**——
           * 否则回执里「锚点未命中⇒已按档位兜底」这句话会丢（静默降级 = 本项目大忌）。 */
          retainSource,
          anchorFailReason: useAnchor ? null : (anchorFailReason ?? null),
          tier: tierInfo.tier,
          walkBacks: 0,
        };
      } finally { clearOwnCompaction(); }
    };
    const api = await awaitRange();
    if (!api) return official('no-range-module');
    /* R16：档位 → 保留预算。resolveTier 内含夹取（下限 40k、上限窗口 50%）与未知档位回落；
     * 调用方负责从会话档位偏好里解析 tierName（强制线/idle/工具触发三路同源）。 */
    const tierInfo = typeof api.resolveTier === 'function'
      ? api.resolveTier(tierName ?? 'standard', window)
      : { tier: 'standard', ratio: api.RETAIN_RATIO, budget: api.retainBudgetTokens(window, api.RETAIN_RATIO), clamped: false, fallback: false };
    const ratioKept = tierInfo.ratio;
    const tierBudget = tierInfo.budget > 0 ? tierInfo.budget : api.retainBudgetTokens(window, ratioKept);
    /* R21：语义锚点优先（`retainOverride` 由调用方在**压缩这一刻**解析好）——
     * 解析成功 ⇒ 预算 = 锚点→末尾 token + 余量；解析失败/未登记 ⇒ 原样用档位预算（就是兜底三档）。
     * 无论走哪条都要留痕：`retainSource` 会进 rangeProbe 与回执（静默降级是本项目大忌）。 */
    const anchorBudget = Number(retainOverride?.budget);
    const useAnchor = Number.isFinite(anchorBudget) && anchorBudget > 0;
    /* R39：档位预算按**真实口径**折算（因子来自非 stale 实测；只减不增，夹在 [1,2]）。
     * `tierBudget` 保持"档位承诺"（回执/报告报它，真实口径）；交给范围选择的是折算后的启发式预算。 */
    noteRetainFactor(sid, measureRatio(agent.session));
    const retainFactor = retainFactorOf(sid);
    const tierBudgetHeur = scaleRetainBudget(tierBudget, retainFactor);
    const budget = useAnchor ? anchorBudget : tierBudgetHeur;
    const retainSource = useAnchor ? String(retainOverride?.source ?? 'anchor') : 'tier';
    const sel = api.selectRange({ session: agent.session, measurement: measure, retainTokens: budget, keepFromSeq: useAnchor ? anchorSeq : null });
    /* 取证：无论成败都留一次范围读数（范围不对时这是唯一的现场）。
     * ⚠️ **必须同时记 surface 位置（startIdx/endIdx）**：seq 是全局事件序号，**在 surface 上并不单调**——
     * 每次压缩都会在**表头**插入一条 `source.kind='compact-checkpoint'` 的 user/message，其 seq
     * 比所保留的旧尾部**更大**。于是真机会出现 `rangeProbe = {start: 20897, end: 19958}` 这种
     * 「起点 seq > 终点 seq」的记录：位置是 `1 → 640`（合法且有序），只是 seq 看起来倒序。
     * 引擎同样按**位置**校验（错误文案：`start seq N (position P) is after end seq M (position Q)`）。
     * 2026-10-08 实测：没有位置字段时，这条记录让我白查了一轮。 */
    state.m3.rangeProbe = {
      at: new Date().toISOString(),
      sessionId: sid,
      window,
      tier: tierInfo.tier,
      tierClamped: tierInfo.clamped || null,
      tierFallback: tierInfo.fallback || null,
      retainRatio: ratioKept,
      budget,
      /* R21：保留来源与锚点现场（`tier` = 按三档兜底；`anchor:*` = 语义锚点生效）。 */
      retainSource,
      anchorSeq: useAnchor ? anchorSeq ?? null : null,
      anchorIdx: sel.anchorIdx ?? null,
      anchorFailReason: !useAnchor && anchorFailReason ? String(anchorFailReason) : null,
      ok: sel.ok === true,
      why: sel.why ?? null,
      surfaceNodes: sel.surfaceNodes ?? null,
      firstIdx: sel.firstIdx ?? null,
      start: sel.start ?? null,
      end: sel.end ?? null,
      startIdx: sel.startIdx ?? null,
      endIdx: sel.endIdx ?? null,
      retainedTokens: sel.retainedTokens ?? null,
      shadowTokens: sel.shadowTokens ?? null,
    };
    if (!sel.ok) {
      /* 「没什么可压」而占用又没越强制线 ⇒ **就此收手**（见文件头语义要点）。 */
      if (sel.why === 'nothing-to-compact' && !forced) {
        /* R21.2（真机发现）：「无需压缩」这条提前 return 曾漏掉 retainSource / anchorFailReason ⇒
         * ① verify 里的 retainSource 靠 `?? 'tier'` 猜出来（值碰巧对，但**语义是猜的**）；
         * ② 锚点失败原因变 null ⇒ 回执无法显示「锚点未命中（text:not-found）⇒ 已按档位兜底」。
         * 真机实测：只给 text 锚点（未命中）时，回执只剩「已执行但判定无需压缩」，**降级痕迹丢失**。 */
        return {
          result: null, source: 'none', skipWhy: sel.why, retainBudget: budget, walkBacks: 0,
          retainSource,
          anchorFailReason: useAnchor ? null : (anchorFailReason ?? null),
          tier: tierInfo.tier,
        };
      }
      return official(sel.why);
    }
    let end = sel.end;
    let endIdx = sel.endIdx;
    let walkBacks = 0;
    for (;;) {
      try {
        /* R16.13：本条 `compactRegion` **不带 sourceCommandId**（引擎签名无此参数）
         * ⇒ 它产生的 compaction/start|end 事件与「引擎自动压缩」在事件流里**无法区分**。
         * 故用「在飞标记」把窗口圈出来：事件监听器据此判定「这是我自己的压缩」并跳过补记。 */
        markOwnCompaction(sid);
        let result;
        try {
          result = await compaction.service.compactRegion(sel.start, end, agent, sig);
        } finally { clearOwnCompaction(); }
        /* R39：`retainBudget` 报**档位承诺**（真实口径，回执用它）；实际交给范围选择的是折算后的
         * `retainBudgetHeur`（启发式口径），两者都留痕（否则"为什么保留量比档位小"无从解释）。 */
        return { result, source: 'own', retainBudget: tierBudget, retainBudgetHeur: tierBudgetHeur, retainFactor, retainSource, anchorSeq: useAnchor ? anchorSeq ?? null : null, anchorFailReason: useAnchor ? null : (anchorFailReason ?? null), walkBacks, tier: tierInfo.tier, range: { start: sel.start, end } };
      } catch (e) {
        /* 末端不合法 ⇒ 回退一个 surface 节点重试（零副作用、零 LLM 成本，见文件头）。 */
        if (api.isEndBoundaryError(e)) {
          const prev = api.prevEnd(agent.session?.surface?.nodes, sel.firstIdx, endIdx);
          if (!prev || walkBacks + 1 > api.MAX_WALK_BACK) return official('boundary-exhausted');
          walkBacks += 1;
          end = prev.end;
          endIdx = prev.endIdx;
          continue;
        }
        /* 起点不合法 / 找不到 seq / 无 open turn 等：重试无意义 ⇒ 官方兜底。 */
        if (api.isValidationError(e)) return official('invalid-boundary');
        throw e;
      }
    }
  };

  /**
   * pre-step 轮内先压（M3.5 通道 1）。**绝不上抛**（失败只留痕，本轮照常继续）。
   * 触发来源两类：① 模型调用 `compact_context` 登记的意图（`wanted`）；② 占用越过生效强制线（`forced`）。
   */
  const preStepCompaction = async (payload) => {
    try {
      if (!effEnabled()) return; // 总开关活读（演习模式已随 2026-10-07 面板精简退役：压缩路径无影子模式）
      const { agent, signal } = payload ?? {};
      if (!agent?.session) return;
      /* A5（审查）：signal 缺失守卫——compactIfNeeded 契约首行 throwIfAborted(signal)，undefined 放行=首跑即败
       * （M5.5 通道 A 已实证同款）。payload 未带 signal 时兜底 180s 超时信号（与 idle compactNow 同参）。 */
      const sig = signal && typeof signal === 'object' ? signal : AbortSignal.timeout(COMPACT_TIMEOUT_MS);
      if (sig.aborted) return;
      const sid = String(pick(agent.session.id, agent.sessionId, agent.id, 'unknown'));
      const mr = measureRatio(agent.session); // B2：读取收敛
      if (!mr.ok || mr.ratio == null) return;
      const ratio = mr.ratio;
      /* ═══ R16.18：**动态余量**——修「引擎在 step 边界抢先压缩」 ═══
       * 真机取证（session-70a55b1a turn 47）：用户在 67% 时按卡决定不压，但新一轮里
       * 05:15:14 `step/end s14` 之后 48ms，**引擎**就触发了压缩（`compaction/start turn=47 src=engine`），
       * 而我们的 pre-step 要到 `step/start s15`（05:15:39）才轮到 ⇒ 我们那一步看到的仍是 <75%。
       * 机制（引擎源码 `resolveCompactSpec`）：引擎在**每个 step 边界**按 `min(窗口×80%, 预算)` 判定，
       * 且在同一 seam 里**排在我们的 pre-step 之前** ⇒ 只要**单个 step 的增量**把占用从「低于我方线」
       * 推到 ≥80%，我们必然输掉这场比赛（实测该会话单步可加 6pp+）。
       * 修法：用**实测的单步最大增量**把我们的线提前：margin = clamp(5pp, 20pp, 单步最大增量)。
       * 这样我们总在「引擎可能到线的那一步之前」触发，档位/范围由我们说了算（而非引擎兜底 standard）。 */
      recordRatioSample(sid, ratio, mr);
      /* R39：**每轮都刷新折算因子**（非 stale 才更新）——否则本会话首次压缩仍用 factor=1，
       * 「档位名副其实」要等到第二次压缩才生效。 */
      noteRetainFactor(sid, mr);
      /* ═══ R4（2026-10-08）：模型主动登记「下一步压缩」意图 ⇒ 轮内执行，本轮无缝继续 ═══
       * 这是替代「marker + 伪造恢复消息」的核心：工具调用必然产生下一步 ⇒ 下一步的 pre-step
       * 就在这里执行压缩 ⇒ 之后的步骤都在压缩后的上下文上继续，**不需要任何消息**。
       * ⚠️ F5（R7 审查修）：意图**只能在「确实能执行」时才消费**。原实现在 `resolveCompactionFor`
       *    之前就 takeIntent，服务解析不到就直接 return ⇒ 意图已丢、工具却早已回 `scheduled:'next-step'`
       *    ⇒ **模型以为压过了、实际没压，而且不会重试**（最典型的静默降级）。
       *    现在：服务不可用 ⇒ 意图保留（下一步会再试；TTL 到期由模块清扫）。 */
      const tool = getCompactTool();
      const intent = tool ? tool.peekIntent(sid) : null;
      const wanted = !!intent;
      /* 诊断：本 sid 无意图、但表里还有**别的 sid** 的未过期意图 ⇒ 很可能是 session id 轮转导致
       * 意图登记在旧键上（工具已回 scheduled，压缩却不会发生）。只留痕，**不跨会话执行**——
       * 在别的 agent 上执行压缩比不压更糟。 */
      if (!intent && tool?.pending) {
        const others = tool.pending();
        if (others.length) state.m3.compactIntentMiss = { at: new Date().toISOString(), sessionId: sid, pending: others };
      }
      /* C-own：生效强制线 = min(用户配置, 引擎阈值 − 5pp)——插件线必须**确定性地先行**，
       * 引擎只是插件关闭/卸载后的安全网。 */
      /* R16.18：**动态余量**——把我们的线提前到「引擎可能到线的那一步之前」。
       * 引擎在 step 边界按 engineThreshold(=窗口×80%) 判定且排在我们的 pre-step 之前，
       * 单步增量一大我们就输（真机：s14→s15 之间引擎抢先压）。margin = clamp(5pp, 20pp, 单步最大增量)。 */
      const effCritical = (() => {
        const cap = criticalCapOf(agent);
        try {
          const eth = typeof engineThreshold === 'function' ? engineThreshold(agent) : null;
          if (!Number.isFinite(eth)) return Math.min(M3.criticalRatio, cap);
          const hist = state.m3.ratioHist?.[sid];
          let maxStep = 0;
          if (Array.isArray(hist)) {
            for (let i = 1; i < hist.length; i += 1) {
              const d = hist[i].ratio - hist[i - 1].ratio;
              if (d > maxStep) maxStep = d;
            }
          }
          const margin = Math.min(0.20, Math.max(0.05, maxStep));
          return Math.min(M3.criticalRatio, cap, Math.max(0, eth - margin));
        } catch { return Math.min(M3.criticalRatio, cap); }
      })();
      if (!wanted && ratio < effCritical) return;
      const compaction = resolveCompactionFor(agent);
      if (!compaction.service) {
        /* R15：**未执行**也要留回执——这是模型自检的唯一依据。
         * R16.1：回执按 sid 存（`verifyBySid`），多会话并发压缩时各自有各自的回执；
         * `lastCompactVerify` 保留为「最近一次」的全局镜像（HUD/报告口径不变）。 */
        setCompactVerify(sid, {
          at: new Date().toISOString(), sessionId: sid, state: 'not-executed',
          why: 'no-compaction-service', trigger: wanted ? 'context-overflow' : 'pressure', read: false,
        });
        log('warn', `M3.5 pre-step 先压：解析不到作用域 compaction，跳过（意图保留待下次）`);
        return;
      }
      if (wanted) tool.takeIntent(sid); // F5：确能执行才消费
      state.m3.preStepActs += 1;
      const t0 = Date.now();
      /* R5：trigger 现在只表达**触发原因**；实际执行策略（自选范围/官方兜底）记在 rangeSource。
       *   - 模型主动请求（wanted）⇒ overflow 语义（原本就是「轮内强制压一次」）
       *   - 越强制线（forced）  ⇒ pressure 语义（原本就是「无条件兜底压」） */
      const forced = ratio >= effCritical;
      const trigger = wanted ? 'context-overflow' : 'pressure';
      /* R16：档位是**会话级持久偏好**——智能压缩线（工具）与强制线都读同一个偏好；
       * 未选/未知 ⇒ standard（16%）。这满足用户要求「两线都要有 Agent 参与选档，未选 16% 兜底」。 */
      const tierName = tool?.getTier?.(sid) ?? 'standard';
      /* ═══ R21：语义锚点在**此刻**解析（surface 已是最终态）═══
       * 降级链：text 锚点 → recentUser 锚点 → 失败退 tier（三档兜底）。
       * 工具侧只登记声明、不解析——因为锚点会随新消息移动，只有压缩这一刻的位置才算数。 */
      const anchorWant = (() => { try { return tool?.getAnchor?.(sid) ?? null; } catch { return null; } })();
      /* R23（用户要求「显示一律中文」）：锚点的**中文**描述——回执里显示
       * 「语义锚点（从最近第 1 条你的消息起）」/「语义锚点（按文本「…」定位）」。
       * ⚠️ 旧写法直接 slice `anchor:` 后的内部 token（`recent-user`/`text`）⇒ 模型可见文本里露出英文。 */
      const anchorLabelOf = (want) => {
        try {
          if (!want || typeof want !== 'object') return null;
          if (want.text) return `按文本「${String(want.text).slice(0, 12)}」定位`;
          if (want.recentUser) return `从最近第 ${Number(want.recentUser)} 条你的消息起`;
          return '你指定的位置';
        } catch { return null; }
      };
      let anchorInfo = null;
      if (anchorWant) {
        try {
          const rApi = await awaitRange();
          anchorInfo = typeof rApi?.resolveAnchorBudget === 'function'
            ? rApi.resolveAnchorBudget({
              session: agent.session, measurement: mr.measure, want: anchorWant,
              window: mr.window, textOf: extractEventText,
            })
            : { ok: false, reason: 'no-range-module' };
        } catch (e) { anchorInfo = { ok: false, reason: `anchor-error:${msg(e)}` }; }
      }
      /* 无论成败都留痕（静默降级是本项目大忌）：未登记锚点 ⇒ 不写痕（那是常态）。 */
      if (anchorWant) {
        state.m3.anchorProbe = {
          at: new Date().toISOString(),
          sessionId: sid,
          want: anchorWant,
          ok: anchorInfo?.ok === true,
          via: anchorInfo?.via ?? null,
          seq: anchorInfo?.seq ?? null,
          tokens: anchorInfo?.tokens ?? null,
          margin: anchorInfo?.margin ?? null,
          budget: anchorInfo?.budget ?? null,
          clamped: anchorInfo?.clamped || null,
          tried: anchorInfo?.tried ?? null,
          reason: anchorInfo?.ok === true ? null : (anchorInfo?.reason ?? 'unknown'),
        };
      }
      log(
        'info',
        `M3.5 pre-step 先压开始：${wanted ? '模型主动请求' : '越强制线'}（占用 ${(ratio * 100).toFixed(1)}%，强制线 ${(effCritical * 100).toFixed(1)}%，档位 ${tool?.tierText?.(tierName) ?? tierName}${anchorWant ? `，锚点 ${anchorInfo?.ok ? `生效(${anchorInfo.via}, 保留 ${anchorInfo.budget})` : `未命中(${anchorInfo?.reason ?? '?'}) ⇒ 退档位`}` : ''}，via ${compaction.via}）`,
      );
      const out = await compactWithOwnRange(agent, compaction, {
        forced, sig, sid, window: mr.window, measure: mr.measure, tierName,
        retainOverride: anchorInfo?.ok ? { budget: anchorInfo.budget, source: `anchor:${anchorInfo.via}` } : null,
        anchorSeq: anchorInfo?.ok ? anchorInfo.seq : null,
        anchorFailReason: anchorWant && !anchorInfo?.ok ? (anchorInfo?.reason ?? 'unknown') : null,
      });
      let result = out.result;
      let rangeSource = out.source;
      let ratioAfter = null;
      let usedAfter = null;
      let staleAfter = false;   // R38：刚压完 ⇒ provider 还没刷新（面板行要带提示）
      /* R24：压缩后的占用**在每条路径上都取值**（原先只在 own 分支取，且没进回执）——
       * 不报这个数时模型只能拿档位名/保留预算自己猜：真机把「保留 ~240k」读成「回到 24%」，
       * 而 DSH 表盘当时是 40%（`projectedTokens`）。口径见 measureRatio 的 R24 注释。 */
      {
        const mrA = result != null ? measureRatio(agent.session) : mr;
        if (mrA?.ok) { ratioAfter = mrA.ratio; usedAfter = mrA.used; staleAfter = mrA.stale === true; }
      }
      /* 强制线收口（R16 泛化）：**无论档位/触发**，自算压完仍在线之上 ⇒ 追加官方 overflow 再压一次。
       * 保证「越强制线必定压到线下」这条旧承诺不因换了保留策略（哪怕 Agent 选了 heavy 浅压）而丢失。 */
      if (rangeSource === 'own' && result != null) {
        const mr2 = measureRatio(agent.session);
        if (mr2.ok && mr2.ratio != null && mr2.ratio >= effCritical) {
          log('info', `M3.5 自选范围（档位 ${tool?.tierText?.(out.tier ?? tierName) ?? (out.tier ?? tierName)}）后占用仍 ${(mr2.ratio * 100).toFixed(1)}% ≥ 强制线 ${(effCritical * 100).toFixed(1)}% ⇒ 追加官方 overflow 收口`);
          const r2 = await compaction.service.compactIfNeeded(agent, 'context-overflow', sig);
          if (r2) {
            result = r2;
            rangeSource = 'own+official';
            /* 收口后**再测一次**：否则回执报的是收口前的数（用户就是靠这个数判断「压到哪了」）。 */
            const mr3 = measureRatio(agent.session);
            if (mr3?.ok) { ratioAfter = mr3.ratio; usedAfter = mr3.used; }
          }
        }
      }
      state.m3.preStepOk += 1;
      /* R15（用户要求「工具完成后进行检查，起码 agent 自己过一遍」）：
       * 工具只登记、执行在这里 ⇒ **回执由这里产出**，M2 域在下一次注入时把它送给模型。
       * 这是把「工具回 ok 但实际没执行」变成**模型可见**的唯一手段（2026-10-08 真机踩过：
       * M3 域加载失败两版，工具一直回 ok/scheduled，压缩一次都没发生，而模型毫无察觉）。 */
      setCompactVerify(sid, {
        at: new Date().toISOString(),
        sessionId: sid,
        state: result != null ? 'executed' : 'no-need',
        trigger,
        tier: out.tier ?? tierName,
        retainBudget: out.retainBudget ?? null,
        /* R21：保留来源（anchor:* = 语义锚点生效；tier = 三档兜底）+ 锚点失败原因（写了才有痕）。
         * R23：`anchorLabel` = 锚点的中文描述（回执直接用它，不再显示 `recent-user`/`text` 这类内部 token）。
         * R39：`retainBudgetHeur` = 折算后真正交给范围选择的启发式预算；`retainFactor` = 折算因子。 */
        retainBudgetHeur: out.retainBudgetHeur ?? null,
        retainFactor: out.retainFactor ?? 1,
        retainSource: out.retainSource ?? (out.retainBudget != null ? 'tier' : null),
        anchorLabel: out.retainSource && String(out.retainSource).startsWith('anchor:') ? anchorLabelOf(anchorWant) : null,
        anchorFailReason: out.anchorFailReason ?? null,
        rangeSource,
        shadowedTokens: result?.shadowedTokenCount ?? null,
        /* R24：压缩后占用（DSH 表盘口径 = projectedTokens ?? pressureTokens）——回执要念给模型听。 */
        ratioAfter: ratioAfter != null ? ratioAfter : null,
        usedAfter,
        basis: mr.ok ? mr.basis : null,
        skipWhy: out.skipWhy ?? null,
        officialWhy: out.officialWhy ?? null,
        ms: Date.now() - t0,
        read: false, // M2 域读到后置 true（一次性回执）
      });
      /* R5 取证口径：rangeSource 说明**实际用了哪条保留策略**（own=自选范围 / official=官方 overflow 兜底 /
       * own+official=自选后仍越线再收口 / none=判定无需压）。retainBudget 是自选预算（token）。 */
      const rangeInfo = {
        rangeSource,
        tier: out.tier ?? tierName,
        retainBudget: out.retainBudget ?? null,
        retainBudgetHeur: out.retainBudgetHeur ?? null,   // R39：折算后（启发式口径）
        retainFactor: out.retainFactor ?? 1,             // R39：真实口径折算因子
        retainSource: out.retainSource ?? null,
        anchorFailReason: out.anchorFailReason ?? null,
        walkBacks: out.walkBacks ?? 0,
        skipWhy: out.skipWhy ?? null,
        officialWhy: out.officialWhy ?? null,
        ratioAfter: ratioAfter != null ? +(ratioAfter * 100).toFixed(1) : null,
        ownRange: out.range ?? null,
      };
      if (wanted) {
        state.m3.compactIntents += 1;
        state.m3.lastCompactIntent = {
          at: new Date().toISOString(),
          sessionId: sid,
          reason: intent?.reason || null,
          ratio: +(ratio * 100).toFixed(1),
          trigger,
          acted: result != null,
          shadowedTokens: result?.shadowedTokenCount ?? null,
          ms: Date.now() - t0,
          ...rangeInfo,
        };
      }
      state.m3.lastPreStep = {
        at: new Date().toISOString(),
        sessionId: sid,
        trigger,
        ratio: +(ratio * 100).toFixed(1),
        acted: result != null,
        shadowedTokens: result?.shadowedTokenCount ?? null,
        range: result?.shadowedRange ?? null,
        ms: Date.now() - t0,
        ...rangeInfo,
      };
      if (result) {
        /* D8/F13（R7 审查修）：HUD 文案必须用**真实触发原因**——原先写死 `'pressure'`，
         * 于是「模型主动请求压缩」在弹窗与 hud-acts 里被标成「强制压缩」，与实际动机不符
         * （而 `lastPreStep.trigger` 记的是真值 ⇒ 同一件事两个说法）。 */
        const __t = formatAct(trigger, result?.shadowedTokenCount) + occupancyActSuffix(ratioAfter, staleAfter);
        publishHud({ hudLastAct: __t }); // M5
        recordHudAct(sid, __t);
        clearBriefed(sid); // R1：同 idle 路径——压缩后一次性说明需重讲
      }
      log(
        'info',
        `M3.5 pre-step 先压完成（${Date.now() - t0}ms）：${
          result ? `shadowed ~${nfmt(result.shadowedTokenCount ?? 0)} tokens（seq ${result.shadowedRange?.start ?? '?'}-${result.shadowedRange?.end ?? '?'}）` : '引擎判定无需压（null）'
        }`,
      );
      schedule('m3.5-prestep', 500);
    } catch (e) {
      const code = errCodeOf(e);
      state.m3.preStepErrors[code] = (state.m3.preStepErrors[code] ?? 0) + 1;
      /* R15：失败同样留回执（模型要能看见「未执行 + 原因」）。 */
      setCompactVerify(sid, { at: new Date().toISOString(), sessionId: sid, state: 'not-executed', why: code, trigger: 'pressure', read: false });
      /* ⚠️ 2026-10-08：此前**只记错误码、错误正文只进 log**——压缩全线失败（preStepOk=0）
       * 时报告里看不到原因，无法定位。现保留最近一次失败的完整信息。 */
      state.m3.lastPreStepError = {
        at: new Date().toISOString(),
        code,
        message: String(msg(e)).slice(0, 400),
        name: e?.name ?? null,
        stack: String(e?.stack ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 400),
      };
      log('warn', `M3.5 pre-step 先压失败（吞掉，本轮照常继续）：${msg(e)}`);
      schedule('m3.5-prestep', 500);
    }
  };

  /* ═══════════ M3-b：idle 安全网（R7 起**只剩一种模式**） ═══════════
   * 会话被撂在高占用（≥ 生效强制线）→ idle 时兜底清场，受 sweepMinIntervalMs 冷却。
   * ⚠️ 原来的第二模式 `marker`（模型回复尾行标记 → idle 立即压缩）已随 marker 通道整体退役：
   *    压缩现在由模型调用工具 `compact_context` 在**轮内**完成，idle 路径不再承担「模型请求」职责。 */
  const sweepInFlight = new Set();
  const idleSweep = (agent) => {
    try {
      if (!effEnabled()) return; // 总开关活读（演习模式已随 2026-10-07 面板精简退役：压缩路径无影子模式）
      const sid = String(pick(agent?.session?.id, agent?.id, 'unknown'));
      if (sweepInFlight.has(sid)) return;
      const mr = measureRatio(agent?.session); // idle：只看占用比，任务文本无关
      if (!mr.ok || mr.ratio == null) return;
      const now = Date.now();
      /* C-own：safety-net 同样钳到「引擎阈值 − 5pp」之下（同 pre-step，理由见 threshold.mjs） */
      if (mr.ratio < Math.min(M3.criticalRatio, criticalCapOf(agent))) return; // 仅越强制线才兜底
      if (now - (state.m3.sweeps[sid] ?? 0) < M3.sweepMinIntervalMs) return; // 兜底受冷却限制
      const reason = 'safety-net';
      const compaction = resolveCompactionFor(agent);
      if (!compaction.service) {
        log('warn', `M3 idle 扫除：解析不到作用域 compaction（${JSON.stringify(compaction.probe)}）`);
        return;
      }
      state.m3.acts += 1;
      log('info', `M3 idle 扫除（${reason}）：compactNow（ratio ${(mr.ratio * 100).toFixed(1)}%，via ${compaction.via}）`);
      /* ⚠️ F2（R7 审查修）：`add` 必须**紧贴** promise 链。原顺序是 add → 取冷却 → log → compactNow，
       * 这段同步代码里任何抛错（审计窗口内真的发生过：日志模板引用了已删变量）都会让 sid 永久驻留
       * `sweepInFlight` ⇒ 该会话**永久失去 idle 安全网**，而且没有任何显式日志。
       * 现在：「可能抛的语句」全在 add 之前，add 之后立即注册 `.finally` ⇒ 结构上不存在这个窗口。
       * ⚠️ F1（同批修）：冷却 `state.m3.sweeps[sid]` 改为**只在成功分支**记录——原实现发起前就记，
       * 一次失败即消耗掉 `sweepMinIntervalMs`（默认 10 分钟）安全网。 */
      sweepInFlight.add(sid);
      markOwnCompaction(sid);
      compaction.service
        .compactNow(agent, AbortSignal.timeout(COMPACT_TIMEOUT_MS), 'context-pilot')
        .then((result) => {
          state.m3.sweeps[sid] = Date.now(); // F1：成功才记冷却
          /* C4（审查）：`sweeps` 以 sid 为键且从不清理 ⇒ 有界化（只用于冷却判定，淘汰无害）。 */
          const sweepKeys = Object.keys(state.m3.sweeps);
          if (sweepKeys.length > SET_CAP) {
            const oldest = sweepKeys.reduce((a, b) => (state.m3.sweeps[a] <= state.m3.sweeps[b] ? a : b));
            if (oldest !== sid) delete state.m3.sweeps[oldest];
          }
          state.m3.actOk += 1;
          state.m3.lastAct = {
            at: new Date().toISOString(),
            sessionId: sid,
            reason,
            via: compaction.via,
            shadowedNodes: result?.shadowedSeqs?.length ?? null,
            shadowedTokens: result?.shadowedTokenCount ?? null,
            range: result?.shadowedRange ?? null,
          };
          const mrI = measureRatio(agent.session);   // R38：idle 路径同样报「压后占用」（带 stale 提示）
          const __actText = formatAct(reason, result?.shadowedTokenCount) + occupancyActSuffix(mrI?.ok ? mrI.ratio : null, mrI?.stale);
          publishHud({ hudLastAct: __actText }); // M5
          recordHudAct(sid, __actText);
          /* R1：压缩成功 ⇒ 一次性说明（压缩流程 + 智能思考教学）已随旧对话被收走，
           * 清除「已讲」标记让下一轮重讲一次（否则模型永久失去用法说明）。 */
          clearBriefed(sid);
          /* ❌ R4（2026-10-08）**已删除伪造恢复消息**（用户明确要求：「自动压缩时，不用伪造一条
           * 我的信息重新拉起会话」）。原实现 `maybeResumeAfterMarker` → `resumeViaAnyChannel`
           * 会走 `sessionController.prompt(...)`，其内部是
           * `createUserMessage({content, source:{kind:'user'}})` + `agent.followup` ⇒
           * 等于**替用户发言**。
           * 现在改由工具 `compact_context` 在轮内完成压缩（见 preStepCompaction），
           * 本轮自然继续，**不需要任何消息**；若模型没有主动请求，idle 压缩就只是收尾动作
           * （占用已降，用户下一轮直接继续即可）。 */
          log('info', `M3 idle 扫除完成：${result ? `shadowed ${result.shadowedSeqs?.length ?? '?'} nodes / ~${result.shadowedTokenCount ?? '?'} tokens` : 'null（无可压区间）'}`);
          schedule('m3-act', 500);
        })
        .catch((e) => {
          const code = errCodeOf(e);
          state.m3.actErrors[code] = (state.m3.actErrors[code] ?? 0) + 1;
          /* ⚠️ 2026-10-08：同 pre-step——错误正文此前只进 log，报告只见错误码
           * （实测 actErrors={summary:2} 而 actOk=0，无从定位）。现保留最近一次失败详情。 */
          state.m3.lastActError = {
            at: new Date().toISOString(),
            code,
            reason,
            message: String(msg(e)).slice(0, 400),
            name: e?.name ?? null,
            stack: String(e?.stack ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 400),
          };
          log('warn', `M3 idle 扫除失败（${code}）：${msg(e)}`);
          schedule('m3-act', 500);
        })
        .finally(() => { clearOwnCompaction(); sweepInFlight.delete(sid); });
    } catch (e) {
      log('warn', `M3 idle 扫除异常（吞）：${msg(e)}`);
    }
  };

  return { measureRatio, compactWithOwnRange, preStepCompaction, idleSweep, setCompactVerify, takeCompactVerify, isCompactionInFlight, noteEngineCompaction, noteRetainFactor, retainFactorOf };
}
