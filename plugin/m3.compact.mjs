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

export function createM3Compaction(deps) {
  const {
    /* 只读依赖 */
    svc, tryOf, state, M3, effEnabled, criticalCapOf, resolveCompactionFor,
    /* 工具 */
    log, msg, pick, nfmt, errCodeOf, schedule,
    /* 跨域回调（R10：由宿主显式注入，不再靠闭包穿透） */
    publishHud, recordHudAct, formatAct, clearBriefed,
    /* 取用口（模块生命周期由宿主拥有） */
    awaitRange, getCompactTool,
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
      retainRatio: ratioKept,
      budget,
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
      const effCritical = Math.min(M3.criticalRatio, criticalCapOf(agent));
      if (!wanted && ratio < effCritical) return;
      const compaction = resolveCompactionFor(agent);
      if (!compaction.service) {
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
      log(
        'info',
        `M3.5 pre-step 先压开始：${wanted ? '模型主动请求' : '越强制线'}（占用 ${(ratio * 100).toFixed(1)}%，强制线 ${(effCritical * 100).toFixed(1)}%，via ${compaction.via}）`,
      );
      const out = await compactWithOwnRange(agent, compaction, { forced, sig, sid, window: mr.window, measure: mr.measure });
      let result = out.result;
      let rangeSource = out.source;
      let ratioAfter = null;
      /* 强制线收口：自选范围若保留过多、压完仍在线之上 ⇒ 追加官方 overflow 再压一次。
       * 保证「越强制线必定压到线下」这条旧承诺不因换了保留策略而丢失。 */
      if (forced && rangeSource === 'own' && result != null) {
        const mr2 = measureRatio(agent.session);
        ratioAfter = mr2.ok ? mr2.ratio : null;
        if (mr2.ok && mr2.ratio != null && mr2.ratio >= effCritical) {
          log('info', `M3.5 自选范围后占用仍 ${(mr2.ratio * 100).toFixed(1)}% ≥ 强制线 ${(effCritical * 100).toFixed(1)}% ⇒ 追加官方 overflow 收口`);
          const r2 = await compaction.service.compactIfNeeded(agent, 'context-overflow', sig);
          if (r2) {
            result = r2;
            rangeSource = 'own+official';
          }
        }
      }
      state.m3.preStepOk += 1;
      /* R5 取证口径：rangeSource 说明**实际用了哪条保留策略**（own=自选范围 / official=官方 overflow 兜底 /
       * own+official=自选后仍越线再收口 / none=判定无需压）。retainBudget 是自选预算（token）。 */
      const rangeInfo = {
        rangeSource,
        retainBudget: out.retainBudget ?? null,
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
        const __t = formatAct(trigger, result?.shadowedTokenCount);
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
          const __actText = formatAct(reason, result?.shadowedTokenCount);
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
        .finally(() => sweepInFlight.delete(sid));
    } catch (e) {
      log('warn', `M3 idle 扫除异常（吞）：${msg(e)}`);
    }
  };

  return { measureRatio, compactWithOwnRange, preStepCompaction, idleSweep };
}
