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
  const { svc, tryOf, pick, msg, log, schedule, state, readCfg, getDefineTool } = deps;

  /** sid -> { at, reason }。单一状态表：登记点与消费点同键，只有一个删除点（消费/过期）。 */
  const bySid = new Map();
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
      const at = Date.now();
      const prev = bySid.get(sid);
      bySid.set(sid, { at, reason });
      state.m3.compactToolCalls = (state.m3.compactToolCalls ?? 0) + 1;
      state.m3.lastCompactTool = {
        at: new Date().toISOString(),
        sessionId: sid,
        reason: reason || null,
        /* 连续调用（<5s）多半是模型重复触发；记下来供报告核查，但**不拒绝**——
         * 拒绝会让模型以为自己没调成功而反复重试；意图是幂等的（覆盖写）。 */
        repeated: !!prev && at - prev.at < 5000,
      };
      log('info', `智能压缩 工具已登记：下一步开始前执行（sid ${sid.slice(0, 8)}…${reason ? '，理由：' + reason : ''}）`);
      schedule('compact-tool', 400);
      return { ok: true, scheduled: 'next-step' };
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
      return [
        '【context-pilot 插件说明（本会话仅此一次）】每轮开头的「Context usage」行就是本插件在测量上下文占用；'
          + '占用达到阈值时，该行下方会附「压缩决策卡」。',
        '**先说，再调用**：工具调用对用户是**静默的**——用户在对话里只看到「调用了某个工具」，看不到你的理由。'
          + '所以请**先在回复正文里用一句话说明**（例：「占用已到 52%，接下来是新子任务、不依赖更早细节，我先压缩再继续」），'
          + `**然后**再调用工具 ${TOOL_NAME}；换档工具同理（见另一段说明）。`,
        `压缩在**你的下一个步骤开始前**执行，本轮不中断：调用后请**直接继续当前任务**——不要为了压缩而停下、不要结束回合；`
          + '之后的步骤都在压缩后的上下文上继续。**不需要**任何「待执行」占位，也**没有**任何自动拉起动作。',
        retentionClause(retainRatio, retainTokens),
        '若接下来的任务依赖更早的细节（要引用之前的文件路径/结论/报错现场/长推理链中间量）则先不要调用；'
          + `占用达 ${crit} 强制压缩线时系统会自动压缩（同样保留摘要+近期消息）。`,
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
  function renderCard({ ratio, minRatio, criticalRatio, retainRatio, retainTokens } = {}) {
    try {
      if (ratio == null || ratio < minRatio) return null;
      const pct = `${(ratio * 100).toFixed(0)}%`;
      const crit = `${Math.round((Number(criticalRatio) || 0.8) * 100)}%`;
      const r = Number(retainRatio);
      const t = Number(retainTokens);
      const keep = Number.isFinite(r) && r > 0 && Number.isFinite(t) && t > 0
        ? `近端约 ${kfmt(t)} token 原样保留（窗口 × ${Math.round(r * 100)}%），更早的转摘要；未超预算则什么都不压`
        : '近端内容原样保留，更早的转摘要；未超预算则什么都不压';
      return [
        `压缩决策卡（context-pilot，当前占用 ${pct}）：先判断接下来的任务是否还依赖本轮之前的对话细节——`,
        `• 不依赖（换了话题/新子任务/上一阶段已收尾），或任务繁重需要预留空间：**先在回复正文里用一句话说明你要压缩的理由**`
          + `（例：「占用 ${pct}，接下来是新子任务，我先压缩再继续」），**再**调用工具 ${TOOL_NAME}（可选 reason 说明理由）。`
          + `它会让压缩在**你的下一个步骤开始前**执行，**本轮不中断**。`
          + `调用后请**直接继续当前任务**——不要为了压缩而停下、不要结束回合；之后的所有步骤都在压缩后的上下文上继续。`,
        `• 保留多少：自选保留范围——${keep}。`,
        `• 依赖（要引用之前给出的文件路径/结论/报错现场/长推理链中间量）：不要调用。占用达 ${crit} 时系统会强制压缩（同样保留摘要+近期消息），无需任何操作。`,
        `• 调用前自检：本轮关键产物（文件路径、决策、未落盘的结论）先写入文件或本回复正文，再调用压缩。`,
      ].join('\n');
    } catch {
      return null;
    }
  }

  /* ═══════════ 注册 ═══════════ */

  /** 工具定义（schema / description / render），照官方 defineTool 范式。 */
  function toolSpec() {
    return {
      name: TOOL_NAME,
      description:
        '请求压缩上下文以腾出空间。'
        /* 2026-10-08 用户要求：「先说，再调用」。
         * 工具**描述本身就是每轮都随请求下发的文本**——把这条要求放这里，等于零额外 token 的每轮提醒。 */
        + '**调用本工具前，先在回复正文里用一句话说明你要压缩的理由**（用户看不到工具调用的理由，只说一句用户才知道你为什么压），然后再调用。'
        + '压缩会在**你的下一个步骤开始前**执行，本轮不中断；它按「上下文窗口的固定比例」自选保留范围——近端内容原样保留，更早的转摘要。'
        + '调用后请直接继续当前任务——不要为了压缩而停下、不要结束回合：'
        + '之后的步骤都在压缩后的上下文上继续，无需任何恢复动作。'
        + '占用偏高、或接下来的任务繁重需要预留空间、且不再依赖更早的对话细节时使用；'
        + '若仍需引用之前的文件路径/结论/报错现场/长推理链中间量，先不要调用。',
      parameters: {
        /* ⚠️ 可选参数必须**省略** `required`——写成 `required: false` 会被 defineTool 拒绝：
         * 实测 `unsupported JSON schema: parameters.reason.required must be true when present`
         * ⇒ 工具**静默不注册**、模型看不到它。此坑由 m3.compactTool 取证字段当场暴露
         * （若无该字段，现象只是「模型从不用这个工具」，无从定位）。 */
        reason: {
          type: 'string',
          description: '（可选）为什么现在压缩——**同一句话也要写在你的回复正文里**，便于用户当场看到决策依据。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: '是否已登记压缩。' },
            scheduled: { type: 'string', description: '执行时机，固定为 next-step（下一步开始前）。' },
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

  return { TOOL_NAME, ensure, peekIntent, takeIntent, pending, renderBrief, renderCard, diag };
}
