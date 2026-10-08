/**
 * M1 快照域（R13 解耦第五刀）—— 报告 history 的**产出侧**（快照 + 瘦身 + 事件探针）。
 *
 * ## 搬了什么
 * - `buildSnapshot(reason)`：服务可达性 + Session/Agent 枚举与测量 + m2/m3/m5 三域状态镜像。
 * - `slimSnapshot(snap)` + `SLIM_REASONS`：C3② 报告稳态瘦身（高频 reason 只留读数与状态）。
 * - `eventProbe` + `recordEvent(event, session)`：`session/event` 监听器的**只读形状探针**
 *   （`session/event` 是未文档化的内部事件面；探针只记类型计数与前 12 条样本，不做任何行为）。
 *
 * ## 为什么它是「聚合视图」而不是独立域
 * `buildSnapshot` 要同时镜像 m2（注入）/m3（压缩）/m5（HUD）三域状态，并现取
 * `resolveCompactionFor`（作用域压缩实例）与 `effEnabled()`（总开关现值）⇒ 跨域依赖全部注入。
 * 它仍是依赖图叶子（无 import），只是依赖面宽——与 M5 的 `buildHudResponse` 同类。
 *
 * ## 落盘不在这里
 * 报告写盘（`loadReportBase` / `writeReport` / 尾部对账 / `HISTORY_CAP` 淘汰）属于**报告管线**，
 * 留在宿主；本模块只负责「产出一条快照」。`refresh(reason)` 负责串起来。
 *
 * ## 边界纪律
 * - 依赖全部注入，对宿主内部件零 import。
 * - 由宿主 `import(\`./m1.snapshot.mjs?ts=${IMPL_TS}\`)` 加载（漏 `?ts=` ⇒ P16 永久缓存）。
 * - **不抛错**：`buildSnapshot` 内部各段都走 `tryOf`；读路径**不写盘**（探针只写内存计数）。
 * - ⚠️ 快照里的 `m3.eventProbe` / `m5.hudPoll` 是**取证字段**（只有报告与断言读），
 *   不要因为「没人读」而删——它们是「记录不显示」类问题的唯一现场。
 */

/** C3② 报告稳态瘦身：这些 reason 高频且信息量低 ⇒ 只留读数与状态，丢枚举明细。 */
const SLIM_REASONS = new Set([
  'heartbeat',     // 每 120s 一次，纯存活性
  'agent/status',  // 状态频繁翻转
  'm5-publish',    // 400ms 防抖高频
  'm2-inject',     // 每轮一次；注入文本已在 snap.m2.lastText 保留
  'session/created',
]);

export function createM1Snapshot(deps) {
  const {
    state, log, msg, svc, tryOf, pick, M3, effEnabled, resolveCompactionFor,
    compactMeasure, summarizeBreakdown, extractEventText, SESSION_CAP,
  } = deps;

  /* ---- B2（审查）：`session/event` 是未文档化的内部事件面 ----
   * 该监听器**只做形状探针**：记类型计数 + 前 N 条样本（键名/文本长度/文本尾部）。
   * 它不做任何行为（不触发压缩、不投递消息）——R7 退役 marker 通道后这是它唯一职责。 */
  const eventProbe = { counts: {}, samples: [], cap: 12 };
  const recordEvent = (event, session) => {
    try {
      const probeType = event?.type ?? '(no-type)';
      eventProbe.counts[probeType] = (eventProbe.counts[probeType] ?? 0) + 1;
      if (eventProbe.samples.length < eventProbe.cap) {
        const t = extractEventText(event);
        eventProbe.samples.push({
          type: probeType,
          topKeys: tryOf(() => Object.keys(event ?? {})).value?.slice(0, 12) ?? null,
          textLen: t.length,
          textTail: t ? t.slice(-60) : '',
          session: String(pick(session?.id, session?.header?.id, '?')).slice(0, 8),
        });
      }
    } catch (e) {
      log('warn', `session/event 探针异常（吞）：${msg(e)}`);
    }
  };

  /** 精简快照：保留读数与状态，丢枚举明细。 */
  const slimSnapshot = (snap) => {
    const num = (v) => (typeof v === 'number' ? v : null);
    // sessions：只留用量最高的 2 条（读数），丢 keys/headerKeys/breakdown 明细
    const topSessions = (snap.sessions || [])
      .filter((r) => typeof r.measure?.totalTokens === 'number')
      .sort((a, b) => b.measure.totalTokens - a.measure.totalTokens)
      .slice(0, 2)
      .map((r) => ({
        id: r.id,
        measure: { totalTokens: num(r.measure?.totalTokens), surfaceTokens: num(r.measure?.surfaceTokens) },
        window: r.pressureProjection?.contextWindow ?? null,
      }));
    const topAgents = (snap.agents || []).slice(0, 2).map((r) => ({ id: r.id, sessionId: r.sessionId, status: r.status }));
    return {
      at: snap.at,
      reason: snap.reason,
      profile: 'slim',
      services: snap.services,
      totals: snap.totals,
      sessions: topSessions,
      agents: topAgents,
      sessionsError: snap.sessionsError,
      agentsError: snap.agentsError,
      m2: snap.m2, // 含 lastText/injections/skips——注入取证要留
      m3: {
        // 只丢体积大且仅取证用的 eventProbe；其余（决策/压缩/错误/eff）全留
        ...snap.m3,
        eventProbe: undefined,
      },
      m5: snap.m5,
      // llmProviders / compactionProbe 仅在 FULL 条目保留
    };
  };

  /* ---- 快照：服务在位 + Session/Agent 枚举与测量 + M2 状态 ---- */
  const buildSnapshot = (reason) => {
    const snap = {
      at: new Date().toISOString(),
      reason,
      services: {},
      sessions: [],
      agents: [],
      totals: {},
      m2: { ...state.m2, skips: { ...state.m2.skips } },
      m3: {
        ...state.m3,
        lastAct: state.m3.lastAct ? { ...state.m3.lastAct } : null,
        lastPreStep: state.m3.lastPreStep ? { ...state.m3.lastPreStep } : null,
        compactIntentMiss: state.m3.compactIntentMiss ? { ...state.m3.compactIntentMiss } : null,
        actErrors: { ...state.m3.actErrors },
        preStepErrors: { ...state.m3.preStepErrors },
        sweeps: { ...state.m3.sweeps },
        listeners: { ...state.listeners },
        heartbeat: state.heartbeat ? { ...state.heartbeat } : null, // 心跳取证：via/type（A1 + 实施中发现的新事实）
        eventProbe: { counts: { ...eventProbe.counts }, samples: eventProbe.samples.map((s) => ({ ...s })) },
        eff: { ...M3 }, // M4：生效参数（config 覆盖后的实际值）
        liveEnabled: effEnabled(), // 总开关现值（快照时点）
        m4Probe: state.m4Probe ? { ...state.m4Probe } : null,
      },
      m5: {
        lastPublish: state.m5.lastPublish ? { ...state.m5.lastPublish } : null,
        hud: { ...(state.m5.hud ?? {}) },
        hudFace: state.m5.hudFace ?? 'absent',
        hudPollReq: state.m5.hudPollReq ? { ...state.m5.hudPollReq } : null, // getHud 最近一次请求/响应摘要（取证）
      },
    };

    for (const k of ['tokenMeter', 'sessions', 'agents', 'systemPrompt', 'compaction', 'llm', 'sessionProjections', 'sessionQuery', 'configEditor', 'sessionController', 'typertGateway',
      // 智能思考：换档工具的注册面——tools 服务必须可达且 register 可调用
      'tools']) {
      const s = svc(k);
      snap.services[k] = s ? typeof s : 'absent';
    }

    const tm = svc('tokenMeter');
    const sp = svc('sessionProjections');
    const canMeasure = !!(tm && typeof tm.measure === 'function');

    /* -- Session 枚举（句柄主路径） -- */
    const sList = tryOf(() => svc('sessions')?.list?.() ?? []);
    if (sList.error) snap.sessionsError = sList.error;
    for (const s of (sList.value ?? []).slice(0, SESSION_CAP)) {
      const row = {
        id: pick(s?.id, s?.header?.id),
        headerKeys: tryOf(() => (s?.header ? Object.keys(s.header) : undefined)).value,
        keys: tryOf(() => Object.keys(s).slice(0, 40)).value,
      };
      if (canMeasure) {
        const m = tryOf(() => tm.measure(s));
        if (m.error) row.measureError = m.error;
        else row.measure = compactMeasure(m.value);
      }
      if (sp && typeof sp.stateOf === 'function') {
        const p = tryOf(() => sp.stateOf(s, 'contextPressure'));
        row.pressureProjection = p.error ? { error: p.error } : p.value ?? null;
        const b = tryOf(() => sp.stateOf(s, 'contextBreakdown'));
        row.breakdownSummary = b.error ? { error: b.error } : summarizeBreakdown(b.value ?? null); // 形状取证（不落全量条目）
      }
      snap.sessions.push(row);
    }
    snap.totals.sessions = (sList.value ?? []).length;

    /* -- Agent 枚举（句柄对照路径） -- */
    const aList = tryOf(() => svc('agents')?.list?.() ?? []);
    if (aList.error) snap.agentsError = aList.error;
    for (const a of (aList.value ?? []).slice(0, SESSION_CAP)) {
      const row = {
        id: pick(a?.id, a?.sessionId),
        sessionId: pick(a?.sessionId, a?.session?.id),
        status: pick(a?.status),
        keys: tryOf(() => Object.keys(a).slice(0, 40)).value,
      };
      if (canMeasure) {
        const target = a?.session ?? a; // 实测 Agent.session 持有 Session
        const m = tryOf(() => tm.measure(target));
        if (m.error) row.measureError = m.error;
        else row.measure = compactMeasure(m.value);
      }
      if (!snap.compactionProbe) {
        const r = resolveCompactionFor(a); // 首个 agent 即取证：作用域压缩实例可达性
        snap.compactionProbe = { via: r.via, probe: r.probe };
      }
      if (!snap.m5.hudPoll) {
        /* getHud 链路运行时取证：记录不显示时从这里定位断点
         * （acts 是否加载 / 首个 agent 的 sid 是什么 / 精确匹配命中几条）。
         * 2026-10-08：血统链退役后，匹配口径与 getHud 完全一致 = **按 sid 精确相等**。 */
        const asid = String(pick(a?.session?.id, a?.sessionId, a?.id, ''));
        snap.m5.hudPoll = {
          at: new Date().toISOString(),
          actsCount: state.m5.acts.length,
          agentSid: asid.slice(0, 24) || null,
          matched: state.m5.acts.filter((x) => x.sid === asid).length,
        };
      }
      snap.agents.push(row);
    }
    snap.totals.agents = (aList.value ?? []).length;

    /* -- LLM 适配器拓扑 -- */
    const provs = tryOf(() => svc('llm')?.listProviders?.());
    snap.llmProviders = provs.error
      ? { error: provs.error }
      : Array.isArray(provs.value)
        ? provs.value.map((p) =>
            typeof p === 'string' ? p : { id: pick(p?.id, p?.name), keys: Object.keys(p ?? {}).slice(0, 20) },
          )
        : undefined;

    return snap;
  };

  /** 该 reason 是否走精简档（宿主 `refresh` 判定口径的**单一来源**；搬模块前它是宿主直接读的
   *  `SLIM_REASONS.has(reason)`——R13 搬迁时漏改这一处，导致 `refresh` ReferenceError、
   *  **报告永不落盘**，由 boot 冒烟当场抓住）。 */
  const isSlim = (reason) => SLIM_REASONS.has(reason);

  return { buildSnapshot, slimSnapshot, recordEvent, eventProbe, SLIM_REASONS, isSlim };
}
