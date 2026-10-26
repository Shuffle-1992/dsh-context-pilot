/**
 * M2 注入域（R12 解耦第四刀）—— 每轮用量行 + 决策卡 + 一次性说明 + 思考强度后缀。
 *
 * ## 搬了什么
 * - `renderUsageText`（用量三元组文本，纯信息）
 * - `retentionTeach` / `renderPolicyCard` / `renderBrief`（教学出口，教学文本本体在
 *   `compact-tool.mjs` / `effort.mjs`，这里只做「出口 + 活值」）
 * - `briefedBySid` / `effBriefedBySid` / `measuredFailedOnce`（三张随会话增长的集合，**有界化**）
 * - `clearBriefed`（压缩成功后让一次性说明重讲——**被 M3 域调用**，见「依赖方向」）
 * - `buildInjection(payload)`（注入主体：原 pre-step 回调里的那半段）
 *
 * ## 依赖方向（R10/R11 的结论沿用）
 * M3 需要 `clearBriefed`（压缩后重讲），M5 需要 `measureRatio`（占用读数），本域需要
 * `measureRatio`（用量行）+ `criticalCapOf`（生效强制线）+ `getEffortApi` + `getCompactToolApi`。
 * ⇒ 接线顺序：**M5 → M2 → M3**；跨域依赖一律注入，两侧谁在前都用**箭头包装**打破声明顺序环。
 *
 * ## 边界纪律
 * - 依赖全部注入，对宿主内部件零 import ⇒ 依赖图叶子（只允许 `node:` 内置 import）。
 * - 由宿主 `import(\`./m2.inject.mjs?ts=${IMPL_TS}\`)` 加载（漏 `?ts=` ⇒ P16 永久缓存）。
 * - **不抛错**：`buildInjection` 内部整体 try/catch，异常返回 `{ skip: 'error' }` 并留痕；
 *   宿主侧再兜一层（放行原决策）。
 * - ⚠️ `createUserMessage` 由宿主异步解析（官方包候选链）⇒ 经 `getCreateUserMessage()` 现取；
 *   未解析时按 `noFactory` 记账并**不注入**（绝不伪造消息结构）。
 *
 * ## 语义要点（实证结论，逐字保留）
 * - **决策卡门槛 = `markerMinRatio`**（2026-10-07 用户决定）：独立门槛会造出「能收卡区间」之外的
 *   死区（模型不知道标记 ⇒ 永不写 ⇒ 通道不可达）或反向错配（教了却不执行）。统一门槛 ⇒
 *   「能收到卡 = 该工具有效」，用户怎么填都不会出现死区。
 * - 教学/卡片必须传**生效强制线**（`min(配置, 引擎阈值 − 5pp)`）：传配置值会让模型以为 80% 触发
 *   （实际 75%）——2026-10-08 真 bug。
 * - 「自己算范围」的两个数都必须是**活值**（比例读 range 模块常量、token 按当前窗口现算）；
 *   模块未加载完时**返回 null 而非编造数字**。
 * - 智能思考的注入**独立门控**（`effortEnabled`）：低占用也必须能教学/换档，与压缩门槛解耦。
 */

export function createM2Injection(deps) {
  const {
    state, log, msg, pick, schedule, svc, tryOf, nfmt, summarizeBreakdown, remember,
    M3, effEnabled, criticalCapOf, measureRatio,
    /* R75（审查 E1）：m3 的**生效强制线**（含 5–20pp 动态余量）——教学必须与它同源。 */
    effectiveCriticalOf: effectiveCriticalInjected,
    getRangeApi, getCompactToolApi, getEffortApi, getCreateUserMessage, SOURCE_KIND, takeCompactVerify, extractEventText,
    getLastUserText,
    /* R35：把"持续重复"上报到面板（复用 m3 已有的 HUD 出口；文本进 acts 行，用户可直接复制） */
    recordHudAct, publishHud,
  } = deps;

  /* ═══ R75（审查 E1）：教学线的**单一来源** ═══
   * 原先 m2 自己算 `min(配置, 引擎阈值 − 余量)`，而 m3 实际触发用的还多扣了 5–20pp 动态余量
   * （`eth − clamp(5pp,20pp,单步最大增量)`）⇒ 单步增量大时**实际线更低**，卡片上的
   * 「约 N 轮触线」系统性偏晚（用户两次反馈过趋势不准，这是同一根源的第二个面）。
   * 依赖未接（旧宿主/测试桩）⇒ 退回静态口径：行为与 R72 之前**逐字一致**，绝不因此少注入。 */
  const effectiveCriticalOf = (agent) => {
    try {
      if (typeof effectiveCriticalInjected === 'function') {
        const v = effectiveCriticalInjected(agent);
        if (Number.isFinite(v)) return v;
      }
    } catch { /* 吞：m3 未就绪 */ }
    return Math.min(M3.criticalRatio, criticalCapOf(agent));
  };

  /* ═══════════ 一次性说明的「已讲」标记（R1：压缩后必须重讲） ═══════════
   * 原实现只有 add、无 delete ⇒ 压缩把说明收进摘要后，插件认为「讲过了」永不再讲；
   * 而摘要由模型生成、不保证保留该段 ⇒ 模型永久失去用法说明。 */
  const briefedBySid = new Set(); // M2.5：新会话一次性插件说明（每激活一份，重活后重讲一次无妨）
  const effBriefedBySid = new Set(); // 思考强度一次性教学（同一时机合并进同一条消息）

  /* 一次性说明的「已讲」标记必须在**压缩成功后清除**（真 bug 修复，2026-10-07）。
   * 原实现 briefedBySid 只有 add、全文无 delete/clear ⇒ 压缩后那条说明被收进摘要，
   * 而插件认为「讲过了」永不再讲；摘要由模型生成、**不保证保留该段** ⇒ 模型可能永久
   * 失去用法说明（压缩工具怎么用、智能思考怎么换档都不知道）。
   * 实测佐证：m2.briefings=2 而 m2.injections=5（本会话跨热换只讲过 2 次）。
   * 压缩 = 新开始 ⇒ 正好重讲一次；成本仍是一次性量级（压缩是低频事件）。 */
  const clearBriefed = (sid) => {
    try {
      briefedBySid.delete(sid);
      effBriefedBySid.delete(sid);
      state.m2.briefReissues = (state.m2.briefReissues ?? 0) + 1;
    } catch { /* 吞 */ }
  };

  /* measure 失败只报一次/会话（原先每次都 log，实测刷屏） */
  const measuredFailedOnce = new Set();

  /* ═══════ R31（2026-10-15 用户要求）：**检测到重复才注入**反重复备注 ═══════
   * R30 用固定节拍（step 2/5/8…）压"模型每步重复写决策行"——有效，但**打扰守规矩的会话**：
   * 只要本轮发过卡，即使模型只写了一次也会收到备注。用户要求改成「**监测到反复写才注入**」。
   * 检测数据来自会话事件（DSH 事件每个都自带 `data.turn` / `data.step`，真机实测）：
   *   `assistant/message` 的 `data.message.content` 里 **`type:'text'` 块** = 模型正文；
   *   **不数 `reasoning` 块**（思考里提到"压缩决策："不算重复写）、不数 tool-call。
   * 判定：同一轮内累计 **≥2 条** ⇒ 认定"重复"；只写 1 条 ⇒ **完全不打扰**。
   * 频率：首次重复投一条；此后**再写满 NUDGE_REARM_DELTA 条**才再提醒；每轮上限 NUDGE_PER_TURN_CAP。
   * 安全性沿用 R15.4：中步插入时上一步的 tool/result 已在 surface 里，不拆散 tool_use / tool_result。 */
  const NUDGE_REARM_DELTA = 3;
  /* R35（用户要求）：每轮备注上限 **4 → 1**（备注已证明压不住模型，留一个提示位即可，别白烧 token）。 */
  const NUDGE_PER_TURN_CAP = 1;
  /* R35：达到这个条数才算"**持续重复**"（≥6 条/轮）⇒ 上报到面板并给出**可复制的纠正文案**。 */
  const REPEAT_REPORT_AT = 6;
  const REPEAT_NUDGE_TEXT = '（系统备注：本轮决策行**只需写一次**——后续步骤不必重复贴；'
    + '仅在真的改变决定（决定压缩 / 升或降档）时补一行。）';
  /** R35：**可直接粘贴给 Agent 的纠正文案**（用户要求"一条可复制粘贴的内容"）。 */
  const REPEAT_FIX_TEXT = '请停止在每个步骤重复写决策行：每轮开头写一次即可（含「保持 / 不压」），'
    + '中途真的改变决定时再补一行，其余步骤不要再重复。';
  const DECISION_RE = /压缩决策：|档位决策：/g;
  /** R32：**动作背书的决策行不算重复** —— R27 的规矩是「中途真的改了决定（压缩/升或降档）再补一行」，
   * 那第二条是**合法**的；若一律按"同轮 ≥2 条"判重复，会把守规矩的会话误判成重复（用户追问点）。
   * 判据：该条消息里是否含指向压缩/换档工具的 tool-call（工具名从各自 api 取，**不硬编码**）。 */
  const actionToolNames = () => {
    const out = new Set();
    try { const t = getCompactToolApi()?.TOOL_NAME; if (t) out.add(String(t)); } catch { /* 未加载 */ }
    try { const e = getEffortApi()?.TOOL_NAME; if (e) out.add(String(e)); } catch { /* 未加载 */ }
    return out;
  };
  const countDecisionLines = (event) => {
    const c = event?.data?.message?.content;
    if (!Array.isArray(c)) return 0;
    const acts = actionToolNames();
    /* ⚠️ 工具名集合为空（模块未加载）时**保守计数**（宁可误判为重复，也不漏掉真重复）。 */
    if (acts.size && c.some((b) => b?.type === 'tool-call' && acts.has(String(b.name ?? '')))) return 0;
    const txt = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    return (txt.match(DECISION_RE) ?? []).length;
  };
  /** 事件入口（宿主转发 `session/event`）：统计"本轮写了多少条**无动作背书**的决策行"。**只读**。 */
  const noteSessionEvent = (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return null;
      const d = event.data ?? {};
      const sid = String(pick(session?.id, session?.header?.id, d.sessionId, ''));
      if (!sid) return null;
      const n = countDecisionLines(event);
      if (!n) return null;
      const bySid = state.m2.decisionRepeat = state.m2.decisionRepeat ?? {};
      const rec = bySid[sid] ?? { turn: null, count: 0, lastStep: null };
      /* 只在事件**确实带轮号**时才按轮重置（真机事件都带 `data.turn`；缺字段时保守累计，不清零）。 */
      if (Number.isFinite(d.turn) && rec.turn !== d.turn) { rec.turn = d.turn; rec.count = 0; }
      rec.count += n;
      rec.lastStep = Number.isFinite(d.step) ? d.step : rec.lastStep;
      bySid[sid] = rec;
      const keys = Object.keys(bySid);
      if (keys.length > 64) delete bySid[keys[0]];   // 有界化（防长期累积）
      return rec;
    } catch { return null; }
  };
  /** R35：把"持续重复"**上报给用户**（面板 acts 行，用户可直接复制纠正文案）——不再反复跟模型较劲。
   * 文案两段：① 现状（重复 N 次/轮）；② **可直接粘贴给 Agent 的纠正句**。每轮最多一次。 */
  const reportRepeat = (sid, count) => {
    try {
      /* R71（GLM #7）：这两处写的是**落盘持久**记录 ⇒ 不能依赖 locale（分隔符/顺序跨环境不一致）。
       * 与 R69 对 effort.mjs 的修法同款：自己拼 HH:MM 并补零。 */
      const dNow = new Date();
      const hhmm = `${String(dNow.getHours()).padStart(2, '0')}:${String(dNow.getMinutes()).padStart(2, '0')}`;
      const text = `${hhmm} · 决策行重复 ${count} 次/轮 · 建议手动纠正；可直接复制：${REPEAT_FIX_TEXT}`;
      state.m2.repeatFixText = REPEAT_FIX_TEXT;
      state.m2.repeatReports = (state.m2.repeatReports ?? 0) + 1;
      try { recordHudAct?.(sid, text); publishHud?.({ hudLastAct: text }); } catch { /* HUD 出口失败不影响注入 */ }
      log('info', `M2 上报决策行重复（${count} 次/轮，sid=${sid}）`);
      return text;
    } catch { return null; }
  };
  /** 是否该投反重复备注：**只在检测到重复之后**（同轮 ≥2 条），带退避与每轮上限。 */
  const repeatNudge = (sid, turn) => {
    try {
      const rec = state.m2.decisionRepeat?.[sid];
      if (!rec || rec.turn !== turn) return null;          // 本轮没检测到决策行
      if ((rec.count ?? 0) < 2) return null;               // 只写一次 = 守规矩 ⇒ 不打扰
      const bySid = state.m2.nudged = state.m2.nudged ?? {};
      /* R71：与同文件 decisionRepeat（上方 64 键上限）对齐——本表原先是唯一无界的那张。 */
      const nudgeKeys = Object.keys(bySid);
      if (nudgeKeys.length > 64 && !(sid in bySid)) delete bySid[nudgeKeys[0]];
      const nd = bySid[sid] ?? { turn: null, count: 0, n: 0, reportedTurn: null };
      if (nd.turn !== turn) { nd.turn = turn; nd.count = 0; nd.n = 0; nd.reportedTurn = null; }
      bySid[sid] = nd;                                     // 先存：下面两个分支都可能直接 return
      /* R35：持续重复 ⇒ 上报给用户（每轮一次；用户可复制面板那行去纠正 Agent）。 */
      if (rec.count >= REPEAT_REPORT_AT && nd.reportedTurn !== turn) {
        nd.reportedTurn = turn;
        reportRepeat(sid, rec.count);
      }
      if (nd.n >= NUDGE_PER_TURN_CAP) return null;
      if (nd.n > 0 && rec.count - nd.count < NUDGE_REARM_DELTA) return null;
      nd.count = rec.count; nd.n += 1;
      return REPEAT_NUDGE_TEXT;
    } catch { return null; }
  };

  /** 组装注入文本（纯信息，无行为指令）。 */
  const renderUsageText = (session) => {
    const mr = measureRatio(session); // B2：读取收敛
    if (!mr.ok) return { error: mr.error };
    const { used, surface, total, window, basis } = mr;

    const breakdown = tryOf(() => svc('sessionProjections')?.stateOf?.(session, 'contextBreakdown'));

    const pct = window && used != null ? `${((used / window) * 100).toFixed(1)}%` : null;

    const seg = [];
    seg.push(`window ${window != null ? nfmt(window) : '?'}`);
    /* R24：`used` 现为 **DSH 表盘口径**（projectedTokens ?? pressureTokens，见 m3.measureRatio 注释），
     * 并在括号里点明它来自哪一档 —— 用户/模型不会再看到「插件 24% vs DSH 40%」这种自相矛盾。
     * 启发式节点总和（totalTokens）与 provider 口径**按设计不同**，差得明显时才附上（避免噪声）。
     * R29：大压缩后投影会**系统性偏高**（旧 provider 报撑着的"非 surface 开销"没同步缩小，
     * 真机 13.1% vs 真实约 2.4%）⇒ 这种时候附一句「provider 待刷新」，免得把 13% 当"现在有多大"。 */
    seg.push(`used ${used != null ? nfmt(used) : '?'}${pct ? ` (${pct}${basis ? `, ${basis}` : ''}${mr.stale ? '，provider 待刷新' : ''})` : ''}`);
    if (surface != null) seg.push(`surface ${nfmt(surface)}`);
    if (total != null && used != null && Math.abs(total - used) / Math.max(used, 1) >= 0.05) {
      seg.push(`heuristic total ${nfmt(total)}`);
    }
    const bsum = summarizeBreakdown(breakdown.error ? null : breakdown.value ?? null);
    if (bsum) {
      seg.push(`system ≈${nfmt(bsum.system)} ｜ messages+tools ≈${nfmt(bsum.rest)} (heuristic)`);
    }
    return {
      text: `Context usage before this turn (by context-pilot, estimate): ${seg.join(' ｜ ')}.`,
      used,
      window,
      ratio: window && used != null ? used / window : null,
      measure: mr.measure ?? null, // R78：策略派生（锚点预算）需要它
    };
  };

  /* F7（审查）：教学出口的异常**必须有痕**——`renderCard`/`renderBrief` 静默返回 null 等价于
   * 「模型永远不知道有 compact_context 这个工具」，是本机制最怕的静默降级。只报一次防刷屏。 */
  let teachWarned = false;
  const warnTeachOnce = (what) => {
    if (teachWarned) return;
    teachWarned = true;
    log('warn', `${what}（同类问题仅报一次）`);
  };

  /* R5+（2026-10-08 用户要求）：「自己算范围」必须教给 Agent——否则它不知道压缩后还剩什么。
   * ⚠️ 两个数都是**活值**：比例读 compact-range.mjs 的常量，token 数按**当前窗口**现算。
   *    写死「16% / 160k」会在常量或窗口变化后与真实行为自相矛盾（本项目已因此踩过坑）。
   * 模块未加载完时返回 null ⇒ 教学退化为「按窗口固定比例」的说法，**绝不编造数字**。 */
  const retentionTeach = (win) => {
    const ratio = getRangeApi()?.RETAIN_RATIO ?? null;
    if (!Number.isFinite(ratio) || ratio <= 0) return { retainRatio: null, retainTokens: null };
    const w = Number(win);
    return { retainRatio: ratio, retainTokens: Number.isFinite(w) && w > 0 ? Math.floor(w * ratio) : null };
  };

  /* ═══ R78（调查报告 §5 已复现 bug）：卡片的「现行预算」必须从**本会话实际策略**派生 ═══
   * 原实现固定读 `RETAIN_RATIO`（0.16）⇒ 同一张卡里「当前档位 24%」与「现行 160k/16%」并存，
   * 而执行侧走的是 resolveTier(会话档位) ⇒ 卡片在预算/损失等数字上不可信。
   * 现在两种模式都按实际情况算：
   *   · 档位模式 ⇒ 用 `resolveTier(tier, window)`（**与 m3 执行侧同一函数**）；
   *   · 锚点模式 ⇒ 用 `resolveAnchorBudget(...)` 预算（含余量/下限/夹取），解析不到就明说
   *     「压缩时按实际边界解析」——**绝不编造数字**（本项目纪律）。
   * 失败一律退回档位口径，保证卡片永远有可信数字。 */
  const anchorLabelOf = (want) => {
    try {
      if (!want || typeof want !== 'object') return null;
      if (want.text) return `按文本「${String(want.text).slice(0, 12)}」定位`;
      if (want.recentUser) return `从最近第 ${Number(want.recentUser)} 条你的消息起`;
      return '你指定的位置';
    } catch { return null; }
  };
  const strategyOf = (win, sid, measure, session) => {
    const range = getRangeApi();
    const tool = getCompactToolApi();
    const w = Number(win);
    const tierName = (tool && sid) ? (tool.getTier?.(sid) ?? 'standard') : 'standard';
    let tierRatio = null;
    let tierBudget = null;
    try {
      const t = range?.resolveTier?.(tierName, w);
      if (t && Number.isFinite(t.budget) && t.budget > 0) { tierBudget = t.budget; tierRatio = Number.isFinite(t.ratio) ? t.ratio : null; }
    } catch { /* 吞：明细在卡片里退回比例口径 */ }
    if (tierBudget == null) {
      const ratio = range?.RETAIN_RATIO ?? null;
      if (Number.isFinite(ratio) && ratio > 0 && Number.isFinite(w) && w > 0) { tierRatio = ratio; tierBudget = Math.floor(w * ratio); }
    }
    let anchorLabel = null;
    let anchorBudget = null;
    let anchorFail = null;
    try {
      const want = (tool && sid) ? (tool.getAnchor?.(sid) ?? null) : null;
      if (want) {
        anchorLabel = anchorLabelOf(want) ?? '你指定的位置';
        if (range?.resolveAnchorBudget && measure && session && typeof extractEventText === 'function') {
          const a = range.resolveAnchorBudget({ session, measurement: measure, want, window: w, textOf: extractEventText });
          if (a?.ok === true && Number.isFinite(a.budget) && a.budget > 0) anchorBudget = a.budget;
          else anchorFail = a?.reason ?? 'unknown';
        }
      }
    } catch (e) { anchorFail = `anchor-error:${msg(e)}`; }
    return {
      retainRatio: tierRatio, retainTokens: tierBudget,
      tierName, tierBudget, tierRatio,
      tierDeclared: tool && sid ? tool.hasTier?.(sid) : undefined,
      tierState: tool && sid ? tool.tierState?.(sid) : undefined,
      anchorLabel, anchorBudget, anchorFail,
    };
  };

  /** M3.5 通道2：政策卡——教会模型「何时值得压缩、如何触发」。
   *  ⚠️ 2026-10-07 用户决定：**决策卡门槛 = 标记最低占用**（`markerMinRatio`，不再独立配置）。
   *  原设计缺陷（用户发现）：`policyCardMinRatio` 独立时，markerMinRatio < 卡门槛 的区间是死区——
   *  模型收不到卡 ⇒ 不知道标记 ⇒ 永远不写标记 ⇒ 该区间内标记通道完全不可达；
   *  且若 markerMinRatio > 卡门槛则反向错配（教了却不执行）。现统一为同一门槛。
   *  ⚠️ 门槛名里的 `marker` 是**历史遗留**：文本标记通道已退役，这个字段现在只是「决策卡注入门槛」。 */
  const renderPolicyCard = (ratio, effCrit, win, trend, actx = {}) => {
    try {
      const api = getCompactToolApi();
      if (!api) { warnTeachOnce('压缩教学模块未就绪：决策卡与一次性说明本次为空（模型将看不到压缩工具的用法）'); return null; }
      const crit = Number.isFinite(effCrit) ? effCrit : M3.criticalRatio;
      /* R16.15（评审建议 3/8）：把**当前档位名**（含是否已登记）交给卡片——
       * 决策行要求写 `tier 保持 X`，而 X 原先在卡上无处可查（卡只给保留 token 数）。 */
      /* R78：预算/档位/锚点**全部来自本会话实际策略**（此前固定 16%，与实际执行矛盾）。 */
      const strat = strategyOf(win, trend?.sid ?? null, actx.measure ?? null, actx.session ?? null);
      return api.renderCard({
        ratio, minRatio: M3.markerMinRatio, criticalRatio: crit, ...strat, ...(trend ?? {}),
      });
    } catch (e) { warnTeachOnce(`决策卡渲染异常：${msg(e)}`); return null; }
  };

  /* R16.14（另一会话评审建议 2）：把「若预计会推高」从**预测题**变成**算术题**——
   * 记录每会话上一轮的上下文总量，算出「本轮增量」与「按此速度还有几轮触强制线」。
   * 评审原文：「我无法估算后面几步会产生多少 token，每轮的占用百分比都是事后给的。
   * 这个条件在我这里从未成立。」⇒ 用实测增量替代预测。 */
  /* ═══ R70（2026-10-21 用户实测「这个趋势计算好像不太准确」）═══
   * 旧实现只看**上一轮单轮增量**（used − prevUsed），两个硬伤：
   *   ① 单轮噪声极大：一轮贴图/大 diff 就能把「还有几轮」算成 1 轮；
   *   ② **压缩后基线不重置**：上下文骤降 ⇒ 增量变负 ⇒ 趋势行直接消失（或下次算出离谱值）。
   * 现在：增量取**最近 N 轮正增量的均值**（抗尖峰）；检测到上下文骤降即视为「刚压缩」⇒
   * 清空样本、重置基线（本轮不外推）；轮数取整与卡片其余处统一（Math.round，且至少 1）。
   * 仍然标注「粗估」：增量本身波动很大，任何外推都只是量级参考。 */
  const TREND_SAMPLES = 4;        // 均值窗口（轮）
  const TREND_RESET_MIN_RATIO = 0.02;   // 骤降判据：> 2% 窗口
  const TREND_RESET_MIN_TOKENS = 2000; // 或 > 2000 token（小窗口下避免误判）
  const trendHistory = new Map(); // sid -> { used: number|null, deltas: number[] }
  const trendOf = (sid, ratio, win, crit) => {
    try {
      if (!Number.isFinite(ratio) || !Number.isFinite(win) || win <= 0) return {};
      const used = Math.round(ratio * win);
      const rec = trendHistory.get(sid) ?? { used: null, deltas: [] };
      const prev = rec.used;
      const resetByCompaction = prev != null
        && (prev - used) > Math.max(TREND_RESET_MIN_RATIO * win, TREND_RESET_MIN_TOKENS);
      if (resetByCompaction) {
        rec.deltas = []; // 压缩改写了上下文 ⇒ 历史增量样本作废
      } else if (prev != null && used > prev) {
        rec.deltas.push(used - prev);
        if (rec.deltas.length > TREND_SAMPLES) rec.deltas.shift();
      }
      const samples = rec.deltas.length;
      const deltaTokens = samples > 0
        ? Math.round(rec.deltas.reduce((a, b) => a + b, 0) / samples)
        : null;
      rec.used = used;
      trendHistory.set(sid, rec);
      if (trendHistory.size > 64) { // 有界化：只保留最近 64 个会话
        const oldest = trendHistory.keys().next().value;
        if (oldest !== sid) trendHistory.delete(oldest);
      }
      const turnsToLine = Number.isFinite(deltaTokens) && deltaTokens > 0
        && Number.isFinite(crit) && ratio < crit
        ? Math.max(1, Math.round(((crit - ratio) * win) / deltaTokens))
        : null;
      return { sid, usedTokens: used, deltaTokens, deltaSamples: samples, turnsToLine, resetByCompaction };
    } catch { return {}; }
  };

  /* ---- 一次性插件说明：让任何新会话的 Agent 不靠外部文档就明白压缩流程与用法 ----
   * A3（审查）：由冻结常量改为函数——原实现 apply 期拼死 M3.marker 与「85%」字样，config 热改后
   * 说明文本与活值检测（事件解析/政策卡）自相矛盾；现每次注入现拼活值。
   * ⚠️ R4（2026-10-08）：文本已改为**工具版**，且本体搬进 plugin/compact-tool.mjs（压缩域自持，
   *    与 effort.mjs 同构）。旧文本教的是「本轮挂起 + 写标记 + 压缩后自动拉起」——那条链路已被
   *    用户否决（伪造用户消息）；此处只做出口，漏改会导致模型**等一个永远不来的恢复**。 */
  const renderBrief = (effCrit, win) => {
    try {
      const api = getCompactToolApi();
      if (!api) { warnTeachOnce('压缩教学模块未就绪：一次性说明本次为空'); return null; }
      /* 同 renderPolicyCard：必须传**生效值**，否则一次性说明会教一个不会触发的数字；
       * 另传「保留多少」活值（R5+）。 */
      const crit = Number.isFinite(effCrit) ? effCrit : M3.criticalRatio;
      return api.renderBrief({ criticalRatio: crit, ...retentionTeach(win) });
    } catch (e) { warnTeachOnce(`一次性说明渲染异常：${msg(e)}`); return null; }
  };

  /**
   * 组装本轮的注入消息（原 pre-step 回调里的 M2 半段）。
   * @returns {Promise<{message:any, text:string, card:boolean}|{skip:string}>}
   *  `skip` 取值：`aborted` / `not-step-1` / `noFactory` / `noSession` / `measureFail` / `error`
   *  —— 每一种都**不注入且不影响原决策**（调用方直接放行）。
   */
  /**
   * R15→R16.1：取**本会话**的「压缩自检」回执（一次性——读过即置 `read`，避免每轮重复）。
   * 回执由 M3 域产生（工具只登记、执行在 pre-step）⇒ 这是「工具回 ok 但实际没执行」的唯一可见通道。
   * R16.1：回执按 sid 存（M3 域 `verifyBySid`，经宿主注入 `takeCompactVerify(sid)` 消费）——
   * 多会话并发压缩时各自有各自的回执，不会被后完成的会话覆盖（此前是全局单槽）。
   */
  const takeCompactReceipt = (sid) => {
    try {
      const v = typeof takeCompactVerify === 'function' ? takeCompactVerify(sid) : null;
      return v ?? null;
    } catch { return null; }
  };

  /** 把回执渲染成一行给模型看的话（含「要不要重试」的明确指引）。
   * R16：带档位与保留预算 ⇒ 模型能确认「自己选的档位真的生效了」。
   * R18：`allowSwitch=false`（本模型无可切档）时**去掉换档那两句**——工具已被隐藏，
   * 再劝它调用就是自相矛盾（这是四处换档文本里最容易漏的一处：它在 m2 而不在 effort 域）。 */
  const renderCompactReceipt = (v, allowSwitch = true) => {
    try {
      if (!v) return null;
      const parts = [];
      /* R19（2026-10-15 用户要求）：档位说法统一为中文（深压8%/标准16%/浅压24%）——回执里不再出现英文 id。
       * R22：**连兜底也不许回英文 id**——工具域没加载时改问范围域；两边都拿不到就**不显示档位段**
       * （真机审计发现旧写法 `?? v.tier` 会在异常路径把 `heavy` 这类 id 送进模型可见文本）。 */
      if (v.tier) {
        const label = (() => {
          try {
            return getCompactToolApi?.()?.tierText?.(v.tier)
              ?? getRangeApi?.()?.tierText?.(v.tier) ?? null;
          } catch { return null; }
        })();
        if (label) parts.push(`${label} 档`);
      }
      /* R39/R40/R41：预算的**口径必须随来源标注**——
       * · 档位路径：报档位承诺（真实口径），折算过就点明「真实口径 ×N」；
       * · 锚点路径：锚点是**位置承诺**（之后原样保留），**不折算**（折算会越过锚点）；
       *   但要把**真实口径落点**算出来给用户看（R41 用户追问）——否则"锚中 24% 的位置"实际落在 40%，
       *   用户无法按表盘挑锚点。等价规则：想表盘 24%，锚点要选在**启发式约 16%** 的位置。 */
      const isAnchorSrc = typeof v.retainSource === 'string' && v.retainSource.startsWith('anchor:');
      if (Number.isFinite(v.retainBudget) && v.retainBudget > 0) {
        const f = Number.isFinite(v.retainFactor) && v.retainFactor > 1.05 ? v.retainFactor : null;
        const k = Math.round(v.retainBudget / 1000);
        if (isAnchorSrc) {
          const realK = f ? Math.round((v.retainBudget * f) / 1000) : null;
          /* R44（真机发现）：锚点预算常被 **MIN 下限**抬起——真机 `recentUser:1` 的锚点段只有 1.4k
           * 启发式，预算被 `MIN_RETAIN_TOKENS=40k` 抬到 40k。此时若只说"锚点之后原样保留 ~40k"，
           * 会被读成"那段就有 40k" ⇒ 必须把「下限保护」说清（否则用户按这个数估落点会高估）。 */
          const aTok = Number(v.anchorTokens);
          const aK = Number.isFinite(aTok) && aTok > 0
            ? (aTok >= 10_000 ? `${Math.round(aTok / 1000)}k` : `${(aTok / 1000).toFixed(1)}k`)
            : null;
          const clampNote = (v.anchorClamped === true && aK)
            ? `；**下限保护**：锚点段实际只有 ~${aK}，为防丢新需求抬到 ~${k}k`
            : '';
          parts.push(`锚点之后原样保留 ~${k}k（启发式口径${clampNote}${realK ? `；**表盘 ≈ ${realK}k**（×${f}）` : ''}）`);
        } else {
          parts.push(`保留预算 ~${k}k${f ? `（真实口径 ×${f}）` : ''}`);
        }
      }
      /* R21：语义锚点的**实际结果必须在回执里可见**——否则模型以为锚点生效了、其实已退回档位
       * （静默降级是本项目大忌）。生效说来源，未命中说原因。
       * R23：来源用**中文描述**（`anchorLabel`，如「从最近第 1 条你的消息起」）——
       * 旧写法 slice 出内部 token `recent-user`/`text` ⇒ 模型可见文本里露英文。 */
      if (typeof v.retainSource === 'string' && v.retainSource.startsWith('anchor:')) {
        parts.push(`保留来源：语义锚点（${v.anchorLabel || '你指定的位置'}）`);
      } else if (v.anchorFailReason) {
        parts.push(`锚点未命中（${String(v.anchorFailReason)}）⇒ 已按档位兜底`);
      }
      const head = parts.length ? `（${parts.join('，')}）` : '';
      /* R24/R26（用户实测「插件说回到 ~24%、DSH 显示 40%」+ 追问「下次会不会又误读成 24%」）：
       * 把**压缩后的真实占用**念出来，并且**显式消歧**——因为同一句里还带着「浅压24% 档」「保留预算 ~240k」
       * 两个含 24 的数字，模型当初就是从这儿挑走"24%"的。两个数同时出现时必须写清"谁是谁"。
       * 口径与 DSH 表盘一致（见 core.mjs#projectedFromPressure / m3.measureRatio 的 R24 注释）；
       * 该数是**压缩那一刻**的 provider 锚定投影 ⇒ provider 下次实报后**会回落**（真机 51% → 40%，
       * R45 又实测一次 19% → 10%）——所以这里必须**给出"稳定后预计"**，否则模型/用户会把中间值当结果。
       * R45（用户实测观察）：回落量按**本会话已观测样本**（中位数）折算；没有样本时如实说"暂无实测值"。 */
      const settledPct = Number.isFinite(v.settledRatio) ? Math.round(v.settledRatio * 100) : null;
      const settledK = Number.isFinite(v.settledUsed) ? Math.round(v.settledUsed / 1000) : null;
      /* R50：样本来源必须写清——本会话实测 vs **跨会话参考**（持久化后升级首压/换会话也有依据，
       * 但不能冒充"本会话量到的"）。R45 的诚实原则不变：宁可说"暂无"，也不编数字。 */
      const settleBasis = v.settleScope === 'global' ? '，**参考其他会话**实测回落' : '';
      const after = Number.isFinite(v.ratioAfter)
        ? `**压缩后占用 ≈${Math.round(v.ratioAfter * 100)}%${Number.isFinite(v.usedAfter) ? `（${Math.round(v.usedAfter / 1000)}k）` : ''}**`
          + (settledPct != null
            ? `（provider 未刷新）⇒ **稳定后预计 ≈${settledPct}%${settledK != null ? `（${settledK}k）` : ''}**${settleBasis}`
            : '（provider 未刷新，下次请求后会回落；本会话暂无实测回落值）')
          + '——档位名里的百分比是**保留预算比例、不是占用**'
        : null;
      if (v.state === 'executed') {
        const k = Number.isFinite(v.shadowedTokens) ? `省 ~${(v.shadowedTokens / 1000).toFixed(1)}K token` : '已执行';
        /* R16.8（用户提出的时机逻辑）：压缩已重置前缀缓存 ⇒ 同一轮里顺带换档，
         * 缓存重建只付一次——这是换档的**最佳时机**（提升给更难的任务 / 降低省额度）。 */
        const switchHint = allowSwitch
          ? `**压缩已重置前缀缓存——这正是换档的最佳时机**（换档同样会使缓存失效，现在换只付一次重建成本）：`
            + `若接下来的任务更难可顺带升档、进入机械阶段可降档省额度——调用 set_reasoning_effort 即可（可选，不需要则忽略本句）。`
          : '';
        return `【压缩自检】你上次请求的压缩**已执行**${head}：${k}${after ? `，${after}` : ''}（保留策略 ${v.rangeSource ?? '?'}，${v.ms ?? '?'}ms）。`
          + switchHint;
      }
      if (v.state === 'no-need') {
        return `【压缩自检】你上次请求的压缩**已执行但判定无需压缩**${head}（${v.skipWhy ?? 'nothing-to-compact'}）`
          + '——当前保留预算内没有可压区间，直接继续即可。';
      }
      const why = v.why === 'm3-module-missing' || v.why === 'm3-module-pending'
        ? '压缩域模块未加载（插件内部问题，与用户无关）'
        : String(v.why ?? '未知原因');
      return `【压缩自检】你上次请求的压缩**未执行**${head}（${why}）。`
        + '如果上下文压力仍需要压缩，请**再调用一次** compact_context；否则忽略本行继续即可——'
        + '并请在回复正文里说明这次压缩没有生效。';
    } catch { return null; }
  };

  const buildInjection = async (payload) => {
    try {
      const { agent, turn, step, signal } = payload ?? {};
      /* R16.1：回执按 sid 消费 ⇒ sid 必须在**所有**回执路径之前解析
       * （原先它在用量行分支里才算，非首步回执路径引用它会踩 TDZ ⇒ 外层 catch ⇒ 整条注入静默丢失）。 */
      const sidEarly = String(pick(agent?.session?.id, agent?.sessionId, agent?.id, 'unknown'));
      if (signal?.aborted) return { skip: 'aborted' };
      if (step !== 1) {
        /* R15.4（用户原始诉求：「工具完成后进行检查…起码 agent 自己过一遍」）：
         * 注入本身仍只在轮首（每轮一次），但**待读的压缩自检回执例外**——
         * 否则「调用工具 → 自检」的回路要等到**下一轮**才闭合，中途压缩完的 Agent 当轮看不到结果，
         * 而「工具回 ok 但没执行」正是这样长期不被察觉的。
         * 安全性：非首步插入 user 消息时，上一步的 tool/result 已落在 surface 里
         * ⇒ 不会把 tool_use 与它的 tool_result 分开（那才是 `INVALID_REQUEST` 的成因）。
         * 回执一次性 ⇒ 最多多注入一步，不会刷屏。 */
        /* R18：中步回执同样要按判据门控（否则单档模型会被劝去调用一个**已隐藏**的工具）。 */
        let allowMid = true;
        try {
          const apiMid = getEffortApi();
          if (M3.effortEnabled === true && apiMid?.canSwitch) {
            const gMid = apiMid.canSwitch(await apiMid.read(agent));
            allowMid = !gMid || gMid.canSwitch;
          }
        } catch { /* 判据不可用 ⇒ 保守允许提及（宁多一句话，也不误删教学） */ }
        /* R71（R72 补正：真 GLM-5.3 审查 H3）——**顺序错了**：工厂判定必须放在
         * `takeCompactReceipt` **之前**。原因：`takeCompactReceipt` 取出时立刻把该条标 `read=true`
         * （一次性回执），之后才 skip 就永远取不回来了 ⇒ 仍是「回执被吃掉却永不送达」。
         * 现改为：先判工厂，拿不到就 skip（回执原样留给下一步）。 */
        const midFactory = getCreateUserMessage();
        if (!midFactory) {
          state.m2.skips.noFactory = (state.m2.skips.noFactory ?? 0) + 1;
          return { skip: 'noFactory' };
        }
        const receiptMid = renderCompactReceipt(takeCompactReceipt(sidEarly), allowMid);        if (!receiptMid) {
          const nudgeMid = repeatNudge(sidEarly, turn);
          if (!nudgeMid) return { skip: 'not-step-1' };
          const msgNudge = midFactory({
            content: [{ type: 'text', text: nudgeMid }],
            source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: nudgeMid }] },
          });
          state.m2.injections += 1;
          state.m2.repeatNudges = (state.m2.repeatNudges ?? 0) + 1;
          state.m2.lastText = nudgeMid;
          state.m2.lastAt = new Date().toISOString();
          log('info', `M2 反重复备注（轮 ${turn} 步 ${step}）：本轮已发卡且模型习惯每步贴决策行`);
          schedule('m2-inject', 500);
          return { message: msgNudge, text: nudgeMid, card: false, midStep: true, repeatNudge: true };
        }
        const msgMid = midFactory({
          content: [{ type: 'text', text: receiptMid }],
          source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: receiptMid }] },
        });
        state.m2.injections += 1;
        state.m2.receiptMidStep = (state.m2.receiptMidStep ?? 0) + 1;
        state.m2.lastText = receiptMid;
        state.m2.lastAt = new Date().toISOString();
        log('info', `M2 压缩自检回执（非首步注入，步 ${step}）：${receiptMid}`);
        schedule('m2-inject', 500);
        return { message: msgMid, text: receiptMid, card: false, receiptOnly: true, midStep: true };
      }
      const createUserMessage = getCreateUserMessage();
      if (!createUserMessage || !agent?.session) {
        const key = !createUserMessage ? 'noFactory' : 'noSession';
        state.m2.skips[key] = (state.m2.skips[key] ?? 0) + 1;
        return { skip: key };
      }
      const r = renderUsageText(agent.session);
      if (r.error || !r.text) {
        /* R15：量测失败**不再一律静默跳过**——若手里有一条待读的压缩自检回执，就只注入回执。
         * 理由（真机教训）：量测本身依赖 M3 域；M3 域挂掉时「压缩没执行」这条最要紧的信息
         * 会跟着一起消失（2026-10-08 就是这么静默了两版）。宁可这一条没有用量行，也不能没有它。 */
        const receiptOnly = renderCompactReceipt(takeCompactReceipt(sidEarly));
        if (receiptOnly) {
          const message = createUserMessage({
            content: [{ type: 'text', text: receiptOnly }],
            source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: receiptOnly }] },
          });
          state.m2.injections += 1;
          state.m2.lastText = receiptOnly;
          state.m2.lastAt = new Date().toISOString();
          /* R55：量测失败只注入回执这条路径也要留档，否则面板「本轮注入」会显示上一轮的旧内容
           * （比"看不到"更坏：用户会以为本轮注入的是那份旧文本）。 */
          state.m2.lastInjection = {
            at: state.m2.lastAt, sid: String(pick(agent.session.id, agent.sessionId, 'unknown')), fullText: receiptOnly,
            usageText: null, effSuffix: null, nudgeText: null, cardText: null,
            briefText: null, effBriefText: null, receiptText: receiptOnly,
            /* R57：内置原文（模板留空时就是最终文案）⇒ 面板「查看内置文案」按钮用 */
            builtinBrief: state.m3?.lastBuiltin?.brief ?? null, builtinCard: state.m3?.lastBuiltin?.card ?? null,
            builtinEffBrief: null, // R60：本路径（仅回执）没有 effBrief，恒为 null
            values: { ratio: null, window: null, effCrit: null, minRatio: M3.markerMinRatio, retainRatio: M3.retainRatioStandard, engineCapMargin: M3.engineCapMargin },
            tpl: { brief: !!(M3.tplBrief || '').trim(), card: !!(M3.tplCard || '').trim(), effBrief: !!(M3.tplEffBrief || '').trim() },
            tier: null, receiptOnly: true,
          };
          log('warn', `M2 量测失败，但仍有压缩自检回执 ⇒ 只注入回执：${receiptOnly}`);
          schedule('m2-inject', 500);
          return { message, text: receiptOnly, card: false, receiptOnly: true };
        }
        const key = 'measure:' + String(pick(agent.session.id, agent.sessionId, 'unknown'));
        if (!measuredFailedOnce.has(key)) {
          remember(measuredFailedOnce, key);
          log('warn', `M2 measure 失败跳过注入（${key}）：${r.error}`);
        }
        state.m2.skips.measureFail = (state.m2.skips.measureFail ?? 0) + 1;
        return { skip: 'measureFail' };
      }
      /* 强制压缩线的**生效值**（= min(配置, 引擎阈值 − 5pp)）——教学与决策卡都必须教这个数，
       * 教配置值会让模型以为 80% 才触发（实际 75%）。与 pre-step/idle 门控同源。 */
      const effCrit = effectiveCriticalOf(agent); // R75（E1）：与 m3 实际触发同一份计算
      const sid = String(pick(agent.session.id, agent.sessionId, 'unknown'));
      /* R16.14：先用**实测的每轮增量**算趋势，再渲染卡片（评审建议 2：把预测题变算术题）。
       * R27（用户口径）：卡**照旧每轮一张**——它是「每轮开头落一次决策」的提醒位；
       * 要改的是**决策行的作用域**（每轮开头一次 + 中途变更再一次），不是卡的频率（见卡内文案）。 */
      const card = renderPolicyCard(r.ratio, effCrit, r.window, trendOf(sid, r.ratio, r.window, effCrit), { session: agent.session, measure: r.measure }); // M3.5 通道2：政策卡（相关占用以上才出现）
      /* 智能思考：**独立门控**（effortEnabled），与压缩的 markerMinRatio 完全解耦——
       * 用户明确要求「全程允许」：低占用也必须能注入/换档（压缩的卡在低占用时是不注入的）。 */
      const effortApi = getEffortApi();
      let eff = null;
      try {
        if (M3.effortEnabled === true && effortApi) eff = await effortApi.read(agent);
      } catch { /* 读档失败 ⇒ 不注入（绝不因新功能影响主流程） */ }
      const effSuffix = effortApi?.renderSuffix(eff) ?? null;
      /* R18：判据**算一次**，供后缀/教学/回执共用 —— 保证同一轮内「工具可见性」与「文本」同源，
       * 绝不出现「工具已隐藏、文本却还在教你调用它」。判据不可用（无 eff）⇒ 保守允许提及。 */
      const effGate = eff ? (effortApi?.canSwitch?.(eff) ?? null) : null;
      const allowSwitchTalk = !effGate || effGate.canSwitch;
      const baseText = effSuffix ? `${r.text} ｜ ${effSuffix}` : r.text;
      if (effSuffix) state.m2.effortSuffixes = (state.m2.effortSuffixes ?? 0) + 1;
      /* R16.12：换档提醒——**只在真有信号时出现**（用户意图关键词 / 本会话从未换档），
       * 由 effort 域判定与限量（冷却中不提示、两次间隔 ≥4 轮）。无信号 ⇒ null ⇒ 零 token。 */
      let effNudge = null;
      try {
        effNudge = eff && effortApi?.renderNudge
          ? (effortApi.renderNudge(eff, { agent, turn, userText: getLastUserText?.(agent) ?? '' }) ?? null)
          : null;
      } catch { /* 提醒失败绝不影响注入 */ }
      if (effNudge) state.m2.effortNudges = (state.m2.effortNudges ?? 0) + 1;
      const brief = briefedBySid.has(sid) ? null : renderBrief(effCrit, r.window); // M2.5+A3：现拼活值（含生效强制线 + 保留范围）
      /* 思考强度教学与「插件说明」同一时机（会话首次）——合并进同一条消息，
       * 不额外增加消息结构开销（role 框架/JSON 包装各一次）。 */
      /* R60（2026-10-19 用户要求「还缺一个思考强度教学的输入框」）：原文由 effort 域产出，
       * 这里再套用户模板（compact-tool.renderTemplated）。规则与 brief/card 完全一致：
       * 必须含 `{tool}`，缺则回退内置并在面板留痕。`{tool}` 在此语境 = `set_reasoning_effort`。 */
      const effBriefBuiltin = eff && !effBriefedBySid.has(sid) ? (effortApi?.renderBrief(eff) ?? null) : null;
      const effBrief = effBriefBuiltin == null ? null
        : (getCompactToolApi?.()?.renderTemplated?.('tplEffBrief', effBriefBuiltin,
          { tool: effortApi?.TOOL_NAME ?? 'set_reasoning_effort', current: eff?.current ?? '', tiers: eff?.tiers ?? '' }) ?? effBriefBuiltin); // R71：工具名从 api 取（同文件 actionToolNames 纪律）
      /* R62：思考强度教学的**内置原文**再长期留一份在 m2 —— HUD 的 config.builtins 要读它
       * （面板「查看内置文案」在还没等到下一轮注入时也能显示，而不是空着）。 */
      if (effBriefBuiltin != null) state.m2.lastEffBriefBuiltin = effBriefBuiltin;
      if (effBrief) {
        remember(effBriefedBySid, sid); // C 类审查：有界化（原先无上限）
        state.m2.effortBriefings = (state.m2.effortBriefings ?? 0) + 1;
      }
      if (brief) {
        remember(briefedBySid, sid); // C 类审查：有界化（原先无上限）
        state.m2.briefings = (state.m2.briefings ?? 0) + 1;
      }
      const receiptText = renderCompactReceipt(takeCompactReceipt(sidEarly), allowSwitchTalk);
      const fullText = [baseText, effNudge, card, brief, effBrief, receiptText].filter(Boolean).join('\n\n');
      const message = createUserMessage({
        content: [{ type: 'text', text: fullText }],
        source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: fullText }] },
      });
      state.m2.injections += 1;
      if (card) state.m3.policyCards += 1;
      state.m2.lastText = fullText;
      state.m2.lastAt = new Date().toISOString();
      /* ═══ R55（2026-10-19 用户要求：「决策卡/提示词/用量行暴露到面板，方便设置」）═══
       * 把本轮注入的**逐段原文**留档，供面板「本轮注入」区逐字核对（用户能亲眼看到插件到底往
       * 上下文里塞了什么，而不是只能相信描述）。只留**最近一轮**（单个对象 ⇒ 无界增长风险为零），
       * 且 `fullText` 与真正注入的那条消息**同源**（就是上面拼出来的那个字符串）。 */
      state.m2.lastInjection = {
        at: state.m2.lastAt, sid, fullText,
        usageText: r.text, effSuffix, nudgeText: effNudge, cardText: card,
        briefText: brief, effBriefText: effBrief, receiptText,
        /* R57：内置原文（模板留空时就是最终文案）⇒ 面板「查看内置文案」按钮用 */
        builtinBrief: state.m3?.lastBuiltin?.brief ?? null, builtinCard: state.m3?.lastBuiltin?.card ?? null,
        builtinEffBrief: effBriefBuiltin, // R60：思考强度教学的内置原文（effort 域产出，未经模板）
        values: {
          ratio: r.ratio, window: r.window ?? null, effCrit,
          minRatio: M3.markerMinRatio, retainRatio: M3.retainRatioStandard, engineCapMargin: M3.engineCapMargin,
        },
        tpl: { brief: !!(M3.tplBrief || '').trim(), card: !!(M3.tplCard || '').trim(), effBrief: !!(M3.tplEffBrief || '').trim() },
        tier: (() => { try { return getCompactToolApi?.()?.getTier?.(sid) ?? null; } catch { return null; } })(),
      };
      log('info', `M2 注入 turn=${turn} step=${step}${card ? ' ＋政策卡' : ''}${effNudge ? ' ＋换档提示' : ''}：${r.text}`);
      schedule('m2-inject', 500);
      return { message, text: fullText, card: !!card };
    } catch (e) {
      log('warn', `M2 注入异常（放行原决策）：${msg(e)}`);
      return { skip: 'error' };
    }
  };

  /** 取证出口（宿主报告/调试用）：一次性说明的两张「已讲」表规模。 */
  const diag = () => ({ briefed: briefedBySid.size, effBriefed: effBriefedBySid.size, teachWarned });

  return { renderUsageText, retentionTeach, renderPolicyCard, renderBrief, clearBriefed, buildInjection, diag, noteSessionEvent };
}
