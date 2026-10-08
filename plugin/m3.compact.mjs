/**
 * M3 压缩**执行核心**（R9 解耦第二刀）——「测量读数」+「自选范围执行（含 walk-back 与官方兜底）」。
 *
 * ## 为什么先搬这两个函数（而不是整个 M3）
 * R7 审计把 M3 分成两层：
 *   - **执行核心**（本模块）：`measureRatio` / `compactWithOwnRange`。依赖只有
 *     `svc` / `tryOf` / `state` / range 模块 ⇒ 搬运零风险、语义完整。
 *   - **编排层**（仍在宿主）：`preStepCompaction` / `idleSweep`。它与 M2 注入（决策卡/一次性说明）、
 *     M5 HUD（publishHud/recordHudAct/formatAct）、M2 的 clearBriefed **交织最多**，
 *     需要先把这些回调做成显式注入才有意义 ⇒ 留到第三刀。
 * 先搬执行核心，宿主少掉 M3 里最大、最自包含的 ~180 行，且**调用点几乎不动**
 * （`measureRatio(...)` / `compactWithOwnRange(...)` 同名转发）。
 *
 * ## 边界纪律（与前四把刀同构）
 * - 依赖**全部注入**，对宿主内部件零 import ⇒ 依赖图叶子。
 * - 由宿主 `import(\`./m3.compact.mjs?ts=${IMPL_TS}\`)` 加载（漏掉 `?ts=` 会像 P16 那样永久缓存）。
 * - **不抛错**：异常一律降级 + 留痕（`compactWithOwnRange` 仍会把**非校验类**异常向上抛，
 *   那是刻意保留的——外层要决定「重试/上报」，但源头上它不制造新异常）。
 *
 * ## 语义要点（照搬时逐字保留，都是实证结论）
 * - 保留比例是 **range 模块自己的常量**（= 引擎 `DEFAULT_RETAIN_RATIO` 0.16），不放进 M3 配置：
 *   M3 的语义是「用户可配项」（且有「M3 字段必须在 schema 中」的护栏），面板可调需 schema 字段 + 重启。
 * - 「没什么可压」且**未越强制线** ⇒ 就此收手（`source: 'none'`）。
 *   回退官方 = `retainTokens 0` = 把整段砍光，与「本来就没多少可压」自相矛盾。
 * - 末端边界不合法 ⇒ 沿 surface 回退一个节点重试（`prevEnd`）。该校验发生在 `compaction/start`
 *   之前（引擎 lib:452 vs :469）⇒ 这一步是**零副作用、零 LLM 成本**的纯读，所以敢循环。
 * - 起点不合法 / 找不到 seq / 无 open turn ⇒ 重试无意义，转官方兜底。
 * - **非校验类**异常原样上抛（外层负责留痕与计数）。
 */

export function createM3Compaction({ svc, tryOf, state, awaitRange }) {
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
    const used = m.value.totalTokens ?? null;
    const surface = m.value.surfaceTokens ?? null;
    const window = pressureRec?.contextWindow ?? null;
    const ratio = window && used != null ? used / window : null;
    return { ok: true, used, surface, window, ratio, measure: m.value };
  };

  /**
   * 执行一次压缩：**优先自选保留范围**（近端原样保留、更早转摘要），失败则按语义退回官方策略。
   * @returns {Promise<{result:any, source:'own'|'official'|'none', skipWhy?:string|null,
   *   officialWhy?:string|null, retainBudget:number|null, walkBacks:number, range?:{start:number,end:number}}>}
   */
  const compactWithOwnRange = async (agent, compaction, ctx) => {
    const { forced, sig, sid, window, measure } = ctx;
    const official = async (why) => ({
      result: await compaction.service.compactIfNeeded(agent, 'context-overflow', sig),
      source: 'official',
      officialWhy: why ?? null,
      retainBudget: null,
      walkBacks: 0,
    });
    const api = await awaitRange();
    if (!api) return official('no-range-module');
    const ratioKept = api.RETAIN_RATIO;
    const budget = api.retainBudgetTokens(window, ratioKept);
    const sel = api.selectRange({ session: agent.session, measurement: measure, retainTokens: budget });
    /* 取证：无论成败都留一次范围读数（范围不对时这是唯一的现场） */
    state.m3.rangeProbe = {
      at: new Date().toISOString(),
      sessionId: sid,
      window,
      retainRatio: ratioKept,
      budget,
      ok: sel.ok === true,
      why: sel.why ?? null,
      surfaceNodes: sel.surfaceNodes ?? null,
      firstIdx: sel.firstIdx ?? null,
      start: sel.start ?? null,
      end: sel.end ?? null,
      retainedTokens: sel.retainedTokens ?? null,
      shadowTokens: sel.shadowTokens ?? null,
    };
    if (!sel.ok) {
      /* 「没什么可压」而占用又没越强制线 ⇒ **就此收手**（见文件头语义要点）。 */
      if (sel.why === 'nothing-to-compact' && !forced) {
        return { result: null, source: 'none', skipWhy: sel.why, retainBudget: budget, walkBacks: 0 };
      }
      return official(sel.why);
    }
    let end = sel.end;
    let endIdx = sel.endIdx;
    let walkBacks = 0;
    for (;;) {
      try {
        const result = await compaction.service.compactRegion(sel.start, end, agent, sig);
        return { result, source: 'own', retainBudget: budget, walkBacks, range: { start: sel.start, end } };
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

  return { measureRatio, compactWithOwnRange };
}
