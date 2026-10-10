/**
 * compact-tool.mjs —— 自动压缩的「工具触发」域（R4，2026-10-08）。
 *
 * 目标（用户要求）：**自动压缩不再伪造用户消息重新拉起会话**。
 *
 * ── 为什么能做到（源码实证，全部经 asar 查询工具核对） ───────────────────────
 * ① **工具调用必然产生下一步**：模型调工具 ⇒ 必须回灌 tool result 给模型 ⇒ 下一步必然存在。
 *    下一步开始前会走 `agent/pre-step` waterfall（"Replace the frozen call configuration"），
 *    宿主正是在这里执行压缩 ⇒ **压缩落在下一步请求之前，本轮无缝继续**，全程零消息。
 *    （与 set_reasoning_effort 同源机制：那支已实证「工具接受 → 下一步生效」。）
 * ② **压缩必须走轮内通道**：`compactNow` 要求 idle（`runMaintenance` 包装）；
 *    轮内可用的是 `compactIfNeeded(agent, trigger, signal)`：
 *      - `"pressure"`：**受引擎阈值管**（默认 80%）。低于阈值直接 return null，不做任何 LLM 调用。
 *      - `"context-overflow"`：源码注释原文「**bypasses the normal threshold and retained-tail
 *        policy so it can force one useful balanced reduction**」——唯一能低于阈值强制压缩的通道。
 *        ⚠️ 代价：它内部走 `selectCompactableRange(session, measurement, 0)`（retainTokens=0），
 *        保留近端 ≈0（只留最后一个节点并按 tool-pairing 回退），比引擎默认 retainRatio 激进。
 *        ⇒ 故宿主策略：**先试 pressure（≥阈值时用引擎正常保留），为 null 再退 overflow 强制**。
 * ③ **inbox 只有 `next-turn` / `next-step` 两个队列**，且写入体是 message（官方事件
 *    `agent/inbox/inserted` 的载荷类型就是 `UserMessage`）⇒ 往 inbox 塞东西**必然是「消息」**。
 *    这正是「伪造用户消息」的根，也是为何要改走工具而非改投递方式。
 * ④ `session.append("system/message" | "developer/message")` 能写入**非用户**消息
 *    （如官方自己用 `developer/message` + `source:{kind:"tool-registry"}` 通知工具变更），
 *    但**它只写对话、不唤醒 agent** ⇒ 单靠它无法「拉起」，故不作为方案。
 * ⑤ `sessionController.prompt` 支持 `mode:"steer"`（agent running 时注入**当前回合**，
 *    `turn-stopping` 的关闭条件含 "no fresh steering"）——但它仍是**用户消息**，
 *    且 idle 后 agent 不再 running 用不了 ⇒ 不解决用户诉求。
 *
 * ── 因此本模块只做一件事 ────────────────────────────────────────────────
 * 暴露工具 `compact_context`：模型调用 ⇒ 登记「下一步压缩」意图（**立即返回、不阻塞**）
 * ⇒ 宿主 pre-step 消费意图并执行轮内压缩 ⇒ 本轮继续。
 * 不注入任何消息，不需要恢复，不产生伪造输入。
 *
 * 依赖全部注入（svc / tryOf / pick / msg / log / schedule / state / readCfg / getDefineTool），
 * 不 import 任何内部模块 —— 依赖图叶子节点（static.mjs §4 护栏覆盖）。
 */

/** 工具名（模型可见；与注入教学文本必须同源，见 contract §6.15）。 */
export const TOOL_NAME = 'compact_context';

/** 意图存活期：登记后超过此时长仍未被 pre-step 消费则作废（防陈旧意图在下一次任务里突然触发）。 */
export const INTENT_TTL_MS = 120_000;

export function createCompactTool(deps) {
  const { svc, tryOf, pick, msg, log, schedule, state, readCfg, getDefineTool, getRangeApi } = deps;

  /** sid -> { at, reason }。单一状态表：登记点与消费点同键，只有一个删除点（消费/过期）。 */
  const bySid = new Map();
  /** R16：sid -> { tier, at }。**会话级档位偏好**（无 TTL——它是长期选择，不是一次性意图）。 */
  const tierBySid = new Map();
  let toolRegistered = false;

  const cfgNow = () => {
    try { return readCfg() ?? {}; } catch { return {}; }
  };
  /** 总开关关闭 ⇒ 工具不注册、意图不登记（与「关闭即完全不介入」一致）。 */
  const enabled = () => cfgNow().enabled === true;

  const sidOf = (agent, fallback = '') => {
    try { return String(pick(agent?.session?.id, agent?.sessionId, agent?.id, fallback) ?? fallback); }
    catch { return fallback; }
  };

  /* ═══════════ 意图表（宿主 pre-step 消费） ═══════════ */

  /**
   * 惰性清扫：**所有 sid** 的过期项一律删除。
   * ⚠️ 2026-10-08 R7 修：原实现只在 `peekIntent(当前 sid)` 里顺带删自己那一项 ⇒
   * **别的会话的过期意图永远不被清理**（TTL 形同虚设、Map 无界增长、
   * `compactIntentExpired` 也只统计到「自己查自己」的那部分）。
   * 触发点是登记/查询/消费三处，因此表规模恒为「最近 TTL 窗口内的登记数」，不需要定时器。
   */
  function sweepExpired(now = Date.now()) {
    let removed = 0;
    for (const [k, it] of bySid) {
      if (now - (it?.at ?? 0) > INTENT_TTL_MS) {
        bySid.delete(k);
        removed += 1;
      }
    }
    if (removed) state.m3.compactIntentExpired = (state.m3.compactIntentExpired ?? 0) + removed;
    return removed;
  }

  /** 读取未过期的意图。返回 null 表示「无意图」。 */
  function peekIntent(sid) {
    try {
      const key = String(sid ?? '');
      if (!key) return null;
      sweepExpired();
      const it = bySid.get(key);
      if (!it) return null;
      if (Date.now() - it.at > INTENT_TTL_MS) {
        /* 理论不可达（刚 sweep 过）；留作防御——时钟回拨或并发写入时仍能自愈。 */
        bySid.delete(key);
        state.m3.compactIntentExpired = (state.m3.compactIntentExpired ?? 0) + 1;
        return null;
      }
      return it;
    } catch { return null; }
  }

  /** 消费意图（宿主决定执行时调用）。返回被消费的意图或 null。 */
  function takeIntent(sid) {
    const it = peekIntent(sid);
    if (it) bySid.delete(String(sid ?? ''));
    return it;
  }

  /* ═══════════ R16 档位选择（会话级持久偏好，无 TTL） ═══════════
   * 用户要求（2026-10-08）：智能压缩线与强制压缩线都要有 Agent 参与选档；
   * 未选 ⇒ standard（16%）兜底。⇒ 档位是**会话级持久选择**：登记后一直生效，
   * 直到 Agent 再次改选。与「意图」（一次性、有 TTL）分开存。 */

  /** 登记/更新会话档位（入参已由 normTier 规范化）。 */
  function setTier(sid, tier) {
    const key = String(sid ?? '');
    if (!key) return;
    tierBySid.set(key, { tier, at: Date.now() });
  }

  /** 读会话档位（未登记 ⇒ standard）。宿主的强制线/idle/工具触发统一走这里。 */
  function getTier(sid) {
    try {
      const it = tierBySid.get(String(sid ?? ''));
      return it?.tier ?? 'standard';
    } catch { return 'standard'; }
  }

  /** R16.14：本会话**是否申报过**档位（未申报=强制压缩走兜底 standard，UI/记录要标「系统代压」）。 */
  function hasTier(sid) {
    try { return tierBySid.has(String(sid ?? '')); } catch { return false; }
  }

  /**
   * 未过期的意图清单（**诊断出口**）。
   * 用途：宿主在本 sid 查不到意图、但表里还有**别的 sid** 的意图时落痕——
   * 那正是「session id 轮转 ⇒ 意图登记在旧键 ⇒ 工具回了 scheduled 但压缩永不发生」的现场。
   * 宿主**不得**据此跨会话执行压缩（会在错误的 agent 上动手，比不压更糟），只留痕。
   */
  function pending() {
    try {
      sweepExpired();
      const now = Date.now();
      return [...bySid.entries()].map(([sid, it]) => ({ sid: String(sid).slice(0, 24), ageMs: now - (it?.at ?? 0) }));
    } catch { return []; }
  }

  /* ═══════════ 工具 ═══════════ */

  /**
   * R16：规范档位名（未知/缺省 ⇒ standard 并标 fallback）。
   * 名字集合来自 compact-range.mjs 的 TIER_NAMES（经宿主注入，避免叶子模块 import 内部模块）。
   */
  const tierNames = () => {
    try { const n = getRangeApi?.()?.TIER_NAMES; return Array.isArray(n) && n.length ? n : ['light', 'standard', 'heavy']; }
    catch { return ['light', 'standard', 'heavy']; }
  };
  const normTier = (tierName) => {
    const t = typeof tierName === 'string' && tierName.trim() ? tierName.trim() : 'standard';
    return tierNames().includes(t) ? { tier: t, fallback: false } : { tier: 'standard', fallback: true };
  };

  /**
   * 工具执行体。
   * ⚠️ 结论⑤（沿用智能思考）：**绝不抛错**——抛错对模型是可见失败且会中断本轮，
   * 而这里只想要「登记成功/失败」。任何异常都吞成结构化结果。
   * ⚠️ sid 必须从 `exec.agent` 取并用同一个 `sidOf` 口径——登记到错的会话会让压缩
   *    在**别的会话**的 pre-step 里触发（本插件是多会话并存，这个错误很贵）。
   */
  async function runTool(args, exec) {
    try {
      if (!enabled()) return { ok: false, error: '智能压缩未开启（用户在设置里关闭了该功能）。' };
      const agent = exec?.agent;
      if (!agent) return { ok: false, error: '无 agent 作用域，无法登记压缩。' };
      const sid = sidOf(agent);
      if (!sid) return { ok: false, error: '无法解析会话 id。' };
      const reason = String(args?.reason ?? '').trim().slice(0, 200);
      /* R16.14（另一会话的评审意见，最高杠杆项）：把「档位登记」与「立即压缩」**解耦**。
       * 评审原文：「`compact_context` 一调用就当场压，而档位只是它的参数 ⇒ 想『先登记 heavy、
       * 暂不压』在工具面上做不到；于是理性选择就是别碰它。」这正是「Agent 从不主动声明档位」的
       * 结构性原因——**唯一的低成本动作不存在**。现加 `action`：
       *   · 'compact'（默认）——登记意图并压缩（原行为，向后兼容）；
       *   · 'set-tier'——**只登记档位，不登记压缩意图**（不压、不丢近端、零缓存成本）。 */
      const action = args?.action === 'set-tier' ? 'set-tier' : 'compact';
      /* R16：档位是**会话级持久偏好**（智能压缩线与强制线都读它）；未选/非法 ⇒ standard 兜底。 */
      const { tier, fallback } = normTier(args?.tier);
      setTier(sid, tier);
      const at = Date.now();
      const prev = bySid.get(sid);
      if (action === 'compact') bySid.set(sid, { at, reason });
      state.m3.compactToolCalls = (state.m3.compactToolCalls ?? 0) + 1;
      state.m3.lastCompactTool = {
        at: new Date().toISOString(),
        sessionId: sid,
        action,
        reason: reason || null,
        tier,
        tierFallback: fallback || null,
        /* 连续调用（<5s）多半是模型重复触发；记下来供报告核查，但**不拒绝**——
         * 拒绝会让模型以为自己没调成功而反复重试；意图是幂等的（覆盖写）。 */
        repeated: !!prev && at - prev.at < 5000,
      };
      log('info', `智能压缩 工具已登记：${action === 'set-tier' ? '仅档位（不压缩）' : '下一步开始前执行'}（sid ${sid.slice(0, 8)}…，档位 ${tier}${fallback ? '（非法值兜底）' : ''}${reason ? '，理由：' + reason : ''}）`);
      schedule('compact-tool', 400);
      /* R15（用户要求「工具完成后进行检查，起码 agent 自己过一遍」）：
       * 工具只能**登记**，真正的执行在下一步的 pre-step ⇒ 必须给出**自检契约**，否则
       * 「回了 ok 但实际没执行」对模型完全不可见（2026-10-08 真机踩过：M3 域加载失败两版，
       * 工具一直回 ok/scheduled，压缩一次都没发生）。回执由插件在下一步开头注入。 */
      const pctOf = (t2) => (t2 === 'light' ? 8 : t2 === 'heavy' ? 24 : 16);
      if (action === 'set-tier') {
        return {
          ok: true,
          action: 'set-tier',
          scheduled: false, // 明确：**没有**安排压缩
          tier,
          verify: `档位已登记为 ${tier}（保留窗口 × ${pctOf(tier)}%）——**本次不压缩**。`
            + '该档位此后对本会话的压缩（包括系统在强制线代替你执行的那次）持续生效，直到再次改选。'
            + '想在低占用时提前锁定档位，就用这条路径（零压缩成本）。',
        };
      }
      return {
        ok: true,
        action: 'compact',
        scheduled: 'next-step',
        tier,
        verify: `已登记，档位 ${tier}（保留窗口 × ${pctOf(tier)}%）——该档位此后对本会话的压缩（含强制线）持续生效，直到再次改选。下一步开头会有一条「压缩自检」回执；若显示「未执行」，请再调用一次 compact_context，或直接告知用户。`,
      };
    } catch (e) {
      log('warn', `智能压缩 工具执行异常（吞）：${msg(e)}`);
      return { ok: false, error: `内部错误：${msg(e)}` };
    }
  }

  /* ═══════════ 注入教学（新会话一次性说明 / 决策卡） ═══════════ */

  const kfmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

  /**
   * R5（2026-10-08 用户要求）：「自己算范围」必须**教给 Agent**——
   * 否则它不知道压缩后还剩什么，只能靠猜（要么不敢压，要么以为会被砍光）。
   * ⚠️ 比例与 token 数都是**活值**（host 从 compact-range.mjs 的常量 + 当前窗口算出后传入）：
   *    写死「16%」会在常量调整后与真实行为自相矛盾（本项目已因此踩过坑）。
   */
  function retentionClause(retainRatio, retainTokens) {
    const r = Number(retainRatio);
    const t = Number(retainTokens);
    if (Number.isFinite(r) && r > 0 && Number.isFinite(t) && t > 0) {
      return `**保留多少**：压缩按「上下文窗口 × ${Math.round(r * 100)}%」自选保留范围，当前窗口下**近端约 ${kfmt(t)} token 原样保留**，`
        + '更早的内容才转成摘要（摘要里仍含文件路径与结论要点）；若整段对话还没超出这个预算，则**什么都不会压**。';
    }
    return '**保留多少**：压缩按「上下文窗口的固定比例」自选保留范围——**近端内容原样保留**，只有更早的内容转为摘要；'
      + '若整段对话还没超出这个预算，则**什么都不会压**。';
  }

  /**
   * 新会话一次性说明（M2.5 注入）。
   * ⚠️ 必须与旧文本**明显不同**：旧文本教的是「本轮挂起 + 写标记 + 压缩后自动拉起」——
   * 那条链路已被用户否决（伪造用户消息）。若不同步改写，模型会继续写标记并**等一个永远不来的恢复**；
   * 故这里额外强调「没有自动拉起动作」，专门掐断那个预期。
   * ⚠️ R5+（2026-10-08 用户要求）：加入「**先说，再调用**」与「自己算范围」两条教学。
   */
  function renderBrief({ criticalRatio, retainRatio, retainTokens } = {}) {
    try {
      const crit = `${Math.round((Number(criticalRatio) || 0.8) * 100)}%`;
      /* R16.15（评审建议 1，分工去重）：brief 只留**固定事实**（保留多少 / 三档定义 / 回执 /
       * 无自动拉起 / set-tier 存在）。「每轮决策行」「不压代价」等**策略**移交每轮决策卡，
       * 避免同一段文字在三处重复（评审实测每请求白烧 ≈1.5–2k token，且权威不明）。 */
      return [
        '【context-pilot 插件说明（本会话仅此一次）】每轮开头的「Context usage」行是本插件在测量占用；'
          + '**占用达标时下方会附「压缩决策卡」——策略、当前档位与本轮数字都在卡上，以卡为准**。',
        '**先说，再调用**：工具调用对用户是**静默的**（用户只看到「调用了某个工具」），'
          + '所以请**先在回复正文里用一句话说明理由**，然后再调用工具。',
        `压缩在**你的下一个步骤开始前**执行，本轮不中断：调用后请**直接继续当前任务**——`
          + '**不要为了压缩而停下**、不要结束回合；之后的步骤都在压缩后的上下文上继续。'
          + '**不需要**任何「待执行」占位，也**没有**任何自动拉起动作。',
        retentionClause(retainRatio, retainTokens),
        /* R16：三档只是**保留预算**不同；范围计算/边界保护/摘要策略完全一致。 */
        `**压缩档位（tier，3 选 1）**：`
          + '`light` 深压=保留窗口 × 8%（1M 窗口 ≈ 80k）——全新子任务/要预留大量空间；'
          + '`standard` 标准=× 16%（≈160k）——默认；'
          + '`heavy` 浅压=× 24%（≈240k）——接下来仍要频繁引用近端一大段。'
          + `**登记方式**：调 ${TOOL_NAME} 时带 \`tier\`；**只想提前锁定档位、现在不压** ⇒ 加 \`action:'set-tier'\`（零压缩成本）。`
          + `**不传 tier = 沿用已登记档位；从未登记过才按 standard**（不是重置）。`,
        `**档位是会话级持久选择**：登记后对本会话之后的所有压缩（含 ${crit} 强制线那次）持续生效，直到再次改选。`
          + `**若预计任务会推高占用，趁占用还在 ${crit} 强制线之下时选定档位**——越线那一刻的自动压缩就按它执行；`
          + '越线之后才改档，管不上正在发生的那次（下一轮起才生效）。',
        /* R15：教会模型**看回执**（工具只登记、执行在下一步 ⇒「回了 ok 但没执行」必须有可见通道）。 */
        `**调用后请看回执**：下一步开头会有一条「压缩自检」——显示「已执行」即完成；`
          + `显示「未执行」（附原因）就**再调用一次** ${TOOL_NAME}，或直接在正文里告知用户这次压缩没生效。`,
      ].join('');
    } catch {
      return null;
    }
  }

  /**
   * 压缩决策卡 —— 教会模型**何时**调工具、**先说再调用**、以及**调用后不要停**。
   * ⚠️ 关键差异（相对旧的文本标记）：旧机制要求模型「本轮先不执行任务」并停下，
   * 才由 idle 压缩 + 伪造消息拉起；新机制**不要停**——工具返回后继续干活即可，
   * 压缩会在下一步开始前落地。教学若没写清这点，模型会退回「停下等压缩」的旧习惯。
   * ⚠️ 卡片每轮（占用达标时）都出现 ⇒ 比一次性说明更该承担「先说再调用」的提醒职责。
   */
  function renderCard({ ratio, minRatio, criticalRatio, retainRatio, retainTokens, usedTokens, deltaTokens, turnsToLine, tierName, tierDeclared } = {}) {
    try {
      if (ratio == null || ratio < minRatio) return null;
      const pct = `${(ratio * 100).toFixed(0)}%`;
      const crit = `${Math.round((Number(criticalRatio) || 0.8) * 100)}%`;
      const r = Number(retainRatio);
      const t = Number(retainTokens);
      /* R16：档位行按**当前窗口**折算三档的近似保留量；拿不到时给比例不给 token 数。 */
      const tierLine = Number.isFinite(t) && t > 0
        ? `**light** 深压=保留窗口 × 8%（当前 ≈${kfmt(t * 0.5)} token）——近端细节不再需要/要预留大量空间时用；`
          + `**standard** 标准=× 16%（≈${kfmt(t)}）——默认，拿不准就用它；`
          + `**heavy** 浅压=× 24%（≈${kfmt(t * 1.5)}）——接下来仍要频繁引用近端一大段（多文件联调/长推理链）时用。`
        : `**light** 深压=窗口 × 8%；**standard** 标准=× 16%（默认）；**heavy** 浅压=× 24%。`;
      const keep = Number.isFinite(r) && r > 0 && Number.isFinite(t) && t > 0
        ? `近端约 ${kfmt(t)} token 原样保留（窗口 × ${Math.round(r * 100)}%），更早的转摘要；未超预算则什么都不压`
        : '近端内容原样保留，更早的转摘要；未超预算则什么都不压';
      /* R16.14（评审建议 6）：把「压了会丢什么」变成**数字**，而不是让模型猜。
       * 判据：当前上下文总量 ≈ ratio × window；与当前档位的保留预算比较。 */
      const used = Number.isFinite(Number(usedTokens)) && Number(usedTokens) > 0
        ? Number(usedTokens)
        : (Number.isFinite(Number(ratio)) ? Math.round(Number(ratio) * (Number(retainTokens) / (Number(retainRatio) || 0.16))) : null);
      let loss = '';
      if (used != null && Number.isFinite(t) && t > 0) {
        loss = used <= t
          ? `**当前上下文 ≈${kfmt(used)} token ≤ 本档位保留预算 ${kfmt(t)} ⇒ 现在压，近端一点都不丢**（只会把更早的转摘要）。`
          : `**当前上下文 ≈${kfmt(used)} token > 本档位保留预算 ${kfmt(t)} ⇒ 现在压会摘要掉较早的 ~${kfmt(used - t)} token 近端内容**。`;
      }
      /* R16.14（评审建议 2）：把「若预计会推高」从预测题变成算术题（用实测的每轮增量）。 */
      const delta = Number(deltaTokens);
      /* R16.15（评审建议 7）：单轮增量外推易被贴图/大 diff 拉偏 ⇒ 明确标注是**粗估**。 */
      const trend = Number.isFinite(delta) && delta > 0
        ? `**趋势（按最近一轮增量粗估）**：本轮 +${kfmt(delta)} token${Number.isFinite(Number(turnsToLine)) && Number(turnsToLine) > 0 ? `，约 **${Number(turnsToLine)} 轮**触 ${crit} 强制线` : ''}`
          + `——若这个轮数很小，现在就是**声明档位的窗口期**（尤其当你后续仍要频繁引用近端细节）。`
        : '';
      /* R16.15（评审建议 3/8）：决策行里的「tier 保持 X」原先无处可查（卡只给保留 token 数）
       * ⇒ 明确渲染**当前档位名**（含是否已登记），并把「现行生效」的语义限定为保留预算。 */
      const cur = typeof tierName === 'string' && tierName ? tierName : null;
      const tierNow = cur
        ? `**当前档位：${cur}${tierDeclared === true ? '（已登记）' : '（兜底，本会话从未登记）'}`
          + `——目录里的「现行生效」说的是**保留 token 数**，不是档位名。**`
        : '';
      const overLine = ratio >= (Number(criticalRatio) || 0.8)
        ? `**当前占用 ${pct} 已越强制线 ⇒ 立刻用 \`action:'set-tier'\` 声明档位**，避免下一次强制压缩仍按兜底档执行。`
        : `**当前占用 ${pct} 尚在强制线之下**——若预计任务会推高占用，趁还在 ${crit} 强制线之下时选定档位，越线那一刻的自动压缩就按它执行。`;
      return [
        `压缩决策卡（context-pilot，当前占用 ${pct}）：先判断接下来的任务是否还依赖本轮之前的对话细节——`,
        /* R16.15（评审建议 2）：决策行只在**本卡出现时**要求——卡不出现的轮次没有提醒位，
         * 那些轮次要写决策行是「事实上不可执行」的要求（评审原文）。 */
        `• **本卡出现时，先落一行决策**（把「不动」也变成可检查的产物）：在回复正文里写`
          + `\`压缩决策：压｜占用 ${pct}｜理由…\` 或 \`压缩决策：不压｜占用 ${pct}｜理由…｜tier 保持 <档位>\`（档位名见下方）。`,
        tierNow,
        `• 不依赖（换了话题/新子任务/上一阶段已收尾），或任务繁重需要预留空间：`
          + `**先在回复正文里用一句话说明你要压缩的理由**，**再**调用 ${TOOL_NAME}（可选 reason）。`
          + `它在**你的下一个步骤开始前**执行、**本轮不中断**；`
          + `调用后请**直接继续当前任务**——不要为了压缩而停下、不要结束回合。`,
        `• 档位（3 选 1）：${tierLine}`
          + `**只想登记档位、现在不压** ⇒ 加 \`action:'set-tier'\`（零压缩成本）。`
          + `**不传 tier = 沿用已登记档位**（不是重置）。${overLine}`
          + `（现行生效：${keep}。）`,
        loss,
        trend,
        /* R16.14/15（评审建议 4）：讲清代压代价，替代原先那句替不作为背书的「无需操作」。 */
        `• 依赖（要引用之前的路径/结论/报错现场/长推理链）：不要调用（或改用 heavy）。`
          + `**但「不压」的代价不是零**：占用达 ${crit} 时**系统会代替你压缩**——时机由系统选、按**那一刻**生效的档位执行、`
          + `摘要会把**当时已过期的事实**（旧版本号/旧结论）写进概要。`,
        `• 调用前自检：本轮关键产物（文件路径、决策、未落盘的结论）先写入文件或本回复正文，再调用。`,
        `• 顺带换档（可选，缓存最优时机）：压缩会重置前缀缓存，换档也会使缓存失效——`
          + `**同一条消息里顺带调用 set_reasoning_effort 换档，缓存重建只付一次**。不需要则忽略本条。`,
      ].filter(Boolean).join('\n');
    } catch {
      return null;
    }
  }

  /* ═══════════ 注册 ═══════════ */

  /** 工具定义（schema / description / render），照官方 defineTool 范式。 */
  function toolSpec() {
    return {
      name: TOOL_NAME,
      /* R16.15（评审建议 1）：**分工去重**——description 只留「怎么调 + 一次调用后的行为」；
       * 档位定义/保留多少/策略与代压代价交给 **brief（会话一次性）** 与 **card（每轮）**。
       * 评审原文：三处（description + brief + card）各写一遍档位表/先说再调用/代压代价，
       * 每请求白烧 ≈1.5–2k token，且「哪份是权威」不明。此处压缩后不再重复长策略段。 */
      description:
        '请求压缩上下文以腾出空间。'
        /* 用户要求（2026-10-08）的「先说，再调用」——description 每请求下发，是零额外成本的提醒位。 */
        + '**调用本工具前，先在回复正文里用一句话说明你要压缩的理由**（用户看不到工具调用的理由），然后再调用。'
        + '压缩在**你的下一个步骤开始前**执行，本轮不中断，调用后请直接继续当前任务、不要停下等它。'
        + '参数：`action`（默认 compact=登记并压缩；**set-tier=只登记档位、本次不压缩**）、'
        + '`tier`（light/standard/heavy 三选一，**不传 = 沿用已登记档位**，从未登记则为 standard）、`reason`。'
        + '档位是**会话级持久选择**：登记后对本会话之后的所有压缩（含强制线那次）持续生效，直到再次改选。'
        + '**策略、当前档位与本轮数据（损失/趋势）见每轮注入的压缩决策卡**——按卡上的数字判断，不要凭空预测占用。'
        + '工具返回后会给出自检契约；下一步开头的「压缩自检」回执可确认是否真的执行了。',
      parameters: {
        /* ⚠️ 可选参数必须**省略** `required`——写成 `required: false` 会被 defineTool 拒绝：
         * 实测 `unsupported JSON schema: parameters.reason.required must be true when present`
         * ⇒ 工具**静默不注册**、模型看不到它。此坑由 m3.compactTool 取证字段当场暴露
         * （若无该字段，现象只是「模型从不用这个工具」，无从定位）。 */
        /* R16.14（评审最大杠杆项）：`action` 把「登记档位」从「立即压缩」里解耦出来——
         * `action:'set-tier'` **只登记不压缩**，让「趁低位提前声明档位」变成一个真实的低成本动作。 */
        action: {
          type: 'string',
          description: '（可选，默认 compact）动作：compact=登记并在下一步开始前压缩；'
            + 'set-tier=**只登记档位、本次不压缩**（零压缩成本）——想在低占用时提前锁定档位、或不希望现在丢近端时用。',
        },
        reason: {
          type: 'string',
          description: '（可选）为什么现在压缩——**同一句话也要写在你的回复正文里**，便于用户当场看到决策依据。',
        },
        /* R16：压缩档位（3 选 1，可选）。范围计算仍在插件（确定性代码）⇒ 模型只选语义档位，
         * 不接触会「切坏 tool 对」的底层参数。 */
        tier: {
          type: 'string',
          description: '（可选）压缩档位：light=深压（保留 8%）/ standard=标准（16%，默认）/ heavy=浅压（24%）。'
            + '选档理由写在回复正文里；档位对本会话后续所有压缩持续生效。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: '是否已登记压缩。' },
            scheduled: { type: 'string', description: '执行时机：next-step（下一步开始前压缩）；set-tier 时为空（本次不压缩）。' },
            /* R15.3（2026-10-08 真机事故）：宿主**按 output.schema 校验工具返回值**
             * （additionalProperties:false ⇒ 多一个字段就整条工具调用失败：
             * `"value.verify" is not a declared property`）⇒ 加返回字段必须同时在这里声明。 */
            action: { type: 'string', description: '本次动作：compact（登记并压缩）或 set-tier（只登记档位，不压缩）。' },
            tier: { type: 'string', description: '本次登记并持续生效的压缩档位（light/standard/heavy）。' },
            verify: {
              type: 'string',
              description: '自检契约：next-step 压缩会有「压缩自检」回执；显示未执行就再调用一次或告知用户。',
            },
            error: { type: 'string', description: '未登记时的原因。' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: runTool,
    };
  }

  function registerTool() {
    try {
      if (toolRegistered) return true;
      const defineTool = getDefineTool();
      if (typeof defineTool !== 'function') return false;
      const tools = svc('tools');
      if (!tools || typeof tools.register !== 'function') {
        state.m3.compactTool = { at: new Date().toISOString(), ok: false, error: 'tools.register 不可用' };
        return false;
      }
      tools.register(defineTool(toolSpec()));
      toolRegistered = true;
      state.m3.compactTool = { at: new Date().toISOString(), ok: true, name: TOOL_NAME, via: 'tools.register' };
      log('info', `智能压缩 工具已注册：${TOOL_NAME}`);
      return true;
    } catch (e) {
      state.m3.compactTool = { at: new Date().toISOString(), ok: false, error: msg(e) };
      log('warn', `智能压缩 工具注册失败（吞）：${msg(e)}`);
      return false;
    }
  }

  /** 懒安装入口：宿主由 pre-step **最前面**调用（幂等、无副作用）。 */
  function ensure() {
    try {
      const d = state.m3.compactToolDiag;
      d.calls += 1;
      d.at = new Date().toISOString();
      d.enabled = enabled();
      d.intents = bySid.size;
      if (!d.enabled) return false;
      const ok = registerTool();
      d.installed = ok;
      return ok;
    } catch (e) {
      state.m3.compactToolDiag.error = msg(e);
      state.m3.compactToolDiag.at = new Date().toISOString();
      return false;
    }
  }

  /** 取证快照（宿主报告用；只读，不暴露内部 Map）。
   *  宿主 `buildSnapshot` 会调它把**意图表**落进报告——这是「意图登记了但没被消费」的唯一现场。 */
  function diag() {
    return {
      tracked: bySid.size,
      toolRegistered,
      pending: pending(),
      sids: [...bySid.entries()].slice(0, 8).map(([sid, it]) => ({
        sid: String(sid).slice(0, 24),
        at: new Date(it.at).toISOString(),
        ageMs: Date.now() - it.at,
      })),
    };
  }

  return { TOOL_NAME, ensure, peekIntent, takeIntent, pending, getTier, hasTier, setTier, renderBrief, renderCard, diag };
}
