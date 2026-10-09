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
    getRangeApi, getCompactToolApi, getEffortApi, getCreateUserMessage, SOURCE_KIND, takeCompactVerify,
    getLastUserText,
  } = deps;

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

  /** 组装注入文本（纯信息，无行为指令）。 */
  const renderUsageText = (session) => {
    const mr = measureRatio(session); // B2：读取收敛
    if (!mr.ok) return { error: mr.error };
    const { used, surface, window } = mr;

    const breakdown = tryOf(() => svc('sessionProjections')?.stateOf?.(session, 'contextBreakdown'));

    const pct = window && used != null ? `${((used / window) * 100).toFixed(1)}%` : null;

    const seg = [];
    seg.push(`window ${window != null ? nfmt(window) : '?'}`);
    seg.push(`used ${used != null ? nfmt(used) : '?'}${pct ? ` (${pct})` : ''}`);
    seg.push(`surface ${surface != null ? nfmt(surface) : '?'}`);
    const bsum = summarizeBreakdown(breakdown.error ? null : breakdown.value ?? null);
    if (bsum) {
      seg.push(`system ≈${nfmt(bsum.system)} ｜ messages+tools ≈${nfmt(bsum.rest)} (heuristic)`);
    }
    return {
      text: `Context usage before this turn (by context-pilot, estimate): ${seg.join(' ｜ ')}.`,
      used,
      window,
      ratio: window && used != null ? used / window : null,
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

  /** M3.5 通道2：政策卡——教会模型「何时值得压缩、如何触发」。
   *  ⚠️ 2026-10-07 用户决定：**决策卡门槛 = 标记最低占用**（`markerMinRatio`，不再独立配置）。
   *  原设计缺陷（用户发现）：`policyCardMinRatio` 独立时，markerMinRatio < 卡门槛 的区间是死区——
   *  模型收不到卡 ⇒ 不知道标记 ⇒ 永远不写标记 ⇒ 该区间内标记通道完全不可达；
   *  且若 markerMinRatio > 卡门槛则反向错配（教了却不执行）。现统一为同一门槛。
   *  ⚠️ 门槛名里的 `marker` 是**历史遗留**：文本标记通道已退役，这个字段现在只是「决策卡注入门槛」。 */
  const renderPolicyCard = (ratio, effCrit, win) => {
    try {
      const api = getCompactToolApi();
      if (!api) { warnTeachOnce('压缩教学模块未就绪：决策卡与一次性说明本次为空（模型将看不到压缩工具的用法）'); return null; }
      const crit = Number.isFinite(effCrit) ? effCrit : M3.criticalRatio;
      return api.renderCard({ ratio, minRatio: M3.markerMinRatio, criticalRatio: crit, ...retentionTeach(win) });
    } catch (e) { warnTeachOnce(`决策卡渲染异常：${msg(e)}`); return null; }
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
   * R16：带档位与保留预算 ⇒ 模型能确认「自己选的档位真的生效了」。 */
  const renderCompactReceipt = (v) => {
    try {
      if (!v) return null;
      const parts = [];
      if (v.tier) parts.push(`${v.tier} 档`);
      if (Number.isFinite(v.retainBudget) && v.retainBudget > 0) parts.push(`保留 ~${Math.round(v.retainBudget / 1000)}k`);
      const head = parts.length ? `（${parts.join('，')}）` : '';
      if (v.state === 'executed') {
        const k = Number.isFinite(v.shadowedTokens) ? `省 ~${(v.shadowedTokens / 1000).toFixed(1)}K token` : '已执行';
        /* R16.8（用户提出的时机逻辑）：压缩已重置前缀缓存 ⇒ 同一轮里顺带换档，
         * 缓存重建只付一次——这是换档的**最佳时机**（提升给更难的任务 / 降低省额度）。 */
        return `【压缩自检】你上次请求的压缩**已执行**${head}：${k}（保留策略 ${v.rangeSource ?? '?'}，${v.ms ?? '?'}ms）。`
          + `**压缩已重置前缀缓存——这正是换档的最佳时机**（换档同样会使缓存失效，现在换只付一次重建成本）：`
          + `若接下来的任务更难可顺带升档、进入机械阶段可降档省额度——调用 set_reasoning_effort 即可（可选，不需要则忽略本句）。`;
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
        const receiptMid = renderCompactReceipt(takeCompactReceipt(sidEarly));
        if (!receiptMid) return { skip: 'not-step-1' };
        const msgMid = getCreateUserMessage()({
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
      const effCrit = Math.min(M3.criticalRatio, criticalCapOf(agent));
      const card = renderPolicyCard(r.ratio, effCrit, r.window); // M3.5 通道2：政策卡（相关占用以上才出现）
      const sid = String(pick(agent.session.id, agent.sessionId, 'unknown'));
      /* 智能思考：**独立门控**（effortEnabled），与压缩的 markerMinRatio 完全解耦——
       * 用户明确要求「全程允许」：低占用也必须能注入/换档（压缩的卡在低占用时是不注入的）。 */
      const effortApi = getEffortApi();
      let eff = null;
      try {
        if (M3.effortEnabled === true && effortApi) eff = await effortApi.read(agent);
      } catch { /* 读档失败 ⇒ 不注入（绝不因新功能影响主流程） */ }
      const effSuffix = effortApi?.renderSuffix(eff) ?? null;
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
      const effBrief = eff && !effBriefedBySid.has(sid) ? (effortApi?.renderBrief(eff) ?? null) : null;
      if (effBrief) {
        remember(effBriefedBySid, sid); // C 类审查：有界化（原先无上限）
        state.m2.effortBriefings = (state.m2.effortBriefings ?? 0) + 1;
      }
      if (brief) {
        remember(briefedBySid, sid); // C 类审查：有界化（原先无上限）
        state.m2.briefings = (state.m2.briefings ?? 0) + 1;
      }
      const fullText = [baseText, effNudge, card, brief, effBrief, renderCompactReceipt(takeCompactReceipt(sidEarly))].filter(Boolean).join('\n\n');
      const message = createUserMessage({
        content: [{ type: 'text', text: fullText }],
        source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: fullText }] },
      });
      state.m2.injections += 1;
      if (card) state.m3.policyCards += 1;
      state.m2.lastText = fullText;
      state.m2.lastAt = new Date().toISOString();
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

  return { renderUsageText, retentionTeach, renderPolicyCard, renderBrief, clearBriefed, buildInjection, diag };
}
