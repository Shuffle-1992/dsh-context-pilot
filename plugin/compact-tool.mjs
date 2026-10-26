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
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const TOOL_NAME = 'compact_context';

/** 意图存活期：登记后超过此时长仍未被 pre-step 消费则作废（防陈旧意图在下一次任务里突然触发）。 */
export const INTENT_TTL_MS = 120_000;

/** R16.17（第三轮评审的剩余轻量项）：档位落盘的**会话数上限**。
 * 评审原文：「compact-tier.json 无 TTL/无清理 ⇒ 长期累积（每个见过的会话一条）。
 * 你们已有 `lastUsedBySid` 保留最近 64 条的先例 ⇒ 复用即可。」
 * 采用**按 at 保留最近 N 条**（而非按时间老化）——档位是会话级长期偏好，
 * 一个久未压缩的老会话不该因为「几天没动」就丢掉已声明的档位。 */
export const TIER_SID_CAP = 64;

export function createCompactTool(deps) {
  const { svc, tryOf, pick, msg, log, schedule, state, M3, readCfg, getDefineTool, getRangeApi, pluginDir } = deps;

  /* ═══ R16.16：档位**落盘**（评审实测：toggle 热换=新实例 ⇒ Map 清空 ⇒ 已声明档位静默消失）═══
   * 另一会话实测：它明明用 tier:'heavy' 压过（回执确认），但热换后卡片显示
   * 「standard（兜底，本会话从未登记）」；触发条件恰好是本插件的部署方式（toggle）。
   * 与 effort 的 effort-stats.json 同款（读/写吞错 + mkdirSync），键=sid，值={tier, at}。 */
  const tierPath = pluginDir ? join(pluginDir, '.data', 'compact-tier.json') : null;
  /* ⚠️ R16.17：用**显式单调序号**而不是「Map 里的位置」判断新旧——
   * 每次 prune 都会重排 Map，位置语义随即失效（实测：间歇性地把旧会话留下、丢掉新会话）。 */
  let tierSeq = 0;
  /* R16.17：**有界化**——只保留最近 TIER_SID_CAP 个会话（按 at），防长期累积。
   * 返回被淘汰的条数（>0 时调用方决定是否立刻回写收敛文件）。 */
  const pruneTiers = (map) => {
    try {
      if (map.size <= TIER_SID_CAP) return 0;
      /* ⚠️ R16.17：`at` 只有毫秒精度，同一毫秒内连续登记（真机/测试都可能）会让「保留最新」
       * 退化成「保留最早」（Array.sort 稳定 ⇒ 等键按插入序）。故显式加**插入序断链**：
       * 同 at 时后插入者视为更新 ⇒ 结果确定且符合语义。 */
      const sorted = [...map.entries()]
        .map(([k, v]) => ({ k, v }))
        .sort((a, b) => ((Number(b.v?.at) || 0) - (Number(a.v?.at) || 0)) || ((Number(b.v?.seq) || 0) - (Number(a.v?.seq) || 0)));
      const keep = sorted.slice(0, TIER_SID_CAP);
      map.clear();
      for (const { k, v } of keep) map.set(k, v);
      return sorted.length - keep.length;
    } catch { return 0; }
  };
  const loadTiers = () => {
    const out = new Map();
    try {
      if (!tierPath) return out;
      const raw = readFileSync(tierPath, 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (j && typeof j === 'object' && j.bySid && typeof j.bySid === 'object') {
        for (const [sid, v] of Object.entries(j.bySid)) {
          if (v && typeof v.tier === 'string') {
            /* R21：锚点随档位一起落盘（会话级；`keepFrom` 缺省的那次调用会清掉它）。 */
            const a = v.anchor && typeof v.anchor === 'object'
              ? {
                ...(Number.isInteger(v.anchor.recentUser) ? { recentUser: Number(v.anchor.recentUser) } : {}),
                ...(typeof v.anchor.text === 'string' && v.anchor.text ? { text: v.anchor.text } : {}),
              }
              : null;
            out.set(sid, {
              tier: v.tier, at: Number(v.at) || 0, seq: Number(v.seq) || 0, restored: true,
              ...(a && Object.keys(a).length ? { anchor: a } : {}),
            });
            if (Number(v.seq) > tierSeq) tierSeq = Number(v.seq); // 续号，避免与历史序号撞车
          }
        }
      }
      /* 载入即收敛（老文件可能已经超限）；被淘汰条数留痕供报告核查。 */
      const dropped = pruneTiers(out);
      if (dropped > 0) {
        try { state.m3.tierPruned = { at: new Date().toISOString(), dropped, loaded: out.size }; } catch { /* 吞 */ }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') log('warn', `compact-tier.json 读取失败（忽略，按未登记）：${msg(e)}`);
    }
    return out;
  };
  /* R53（自审发现 #2）：**原子落盘**（同目录 tmp + rename）——直写会留半截 JSON，
   * 下次启动读档会整份丢弃（档位/锚点静默消失）。⚠️ 各域各留一份：禁止域间 import。 */
  const writeJsonAtomic = (p, obj) => {
    const body = JSON.stringify(obj, null, 2);
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, p);
      return true;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* 吞 */ }
      writeFileSync(p, body);
      /* R74（审查 C7）：**非原子**路径必须留痕——半截 JSON 的风险在这里回来了，且发生了也无从取证。 */
      try { log('warn', `原子写降级为直写（rename 失败：${String(e?.message ?? e)}）：${p}`); } catch { /* 吞 */ }
      return true;
    }
  };
  const saveTiers = () => {
    try {
      if (!tierPath) return;
      mkdirSync(dirname(tierPath), { recursive: true });
      const bySidOut = {};
      for (const [sid, v] of tierBySid) bySidOut[sid] = { tier: v.tier, at: v.at ?? 0, seq: v.seq ?? 0, anchor: v.anchor ?? null };
      writeJsonAtomic(tierPath, { version: 1, savedAt: new Date().toISOString(), bySid: bySidOut });
    } catch (e) {
      log('warn', `compact-tier.json 写入失败（吞）：${msg(e)}`);
    }
  };

  /** sid -> { at, reason }。单一状态表：登记点与消费点同键，只有一个删除点（消费/过期）。 */
  const bySid = new Map();
  /** sid -> { tier, at, restored? }。**会话级档位偏好**（无 TTL——它是长期选择，不是一次性意图）。
   * R16.16：创建时由落盘恢复（`restored:true`），setTier 时覆盖并回写。 */
  const tierBySid = loadTiers();
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

  /** R75（审查 E3）：执行**失败**后重新登记意图（最多 1 次，防失败循环）。
   * 背景：`takeIntent` 在真正执行**之前**就消费；若执行抛错（busy/摘要失败/abort），
   * 意图已没了 ⇒ 模型收到「未执行」后只能靠自己记得再调一次。重挂让重试变成系统行为。 */
  const INTENT_REARM_MAX = 1;
  /* ⚠️ 重挂计数必须**独立于意图条目**：意图会被 takeIntent 删掉，若把 retry 存在条目上，
   * 删了之后计数归零 ⇒ 上限形同虚设（行为级测试当场抓住过一次）。 */
  const rearmBySid = new Map();
  function rearmIntent(sid, reason) {
    try {
      const key = String(sid ?? '');
      if (!key || !enabled()) return false;
      const used = rearmBySid.get(key) ?? 0;
      if (used >= INTENT_REARM_MAX) {
        state.m3.compactIntentRearmCapped = (state.m3.compactIntentRearmCapped ?? 0) + 1;
        return false;
      }
      rearmBySid.set(key, used + 1);
      if (rearmBySid.size > 64) { // 有界化（与 intent 表同量级）
        const k0 = rearmBySid.keys().next().value;
        if (k0 !== key) rearmBySid.delete(k0);
      }
      const prev = bySid.get(key);
      bySid.set(key, { at: Date.now(), reason: reason ?? prev?.reason ?? '', retry: used + 1 });
      state.m3.compactIntentRearmed = (state.m3.compactIntentRearmed ?? 0) + 1;
      return true;
    } catch { return false; }
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

  /** 登记/更新会话档位（入参已由 normTier 规范化）。R16.16：**同时落盘**（跨 toggle/重启有效）。
   * R16.17：写入前有界化（只保留最近 TIER_SID_CAP 个会话）。
   * R21：锚点随档位一起存（`anchor` 缺省即不带 ⇒ **清除**旧锚点，见 normAnchor 的语义说明）。 */
  function setTier(sid, tier, anchor, explicit) {
    const key = String(sid ?? '');
    if (!key) return;
    tierSeq += 1;
    /* R73（审查 C5）：`explicit` 标记本次是**模型真的指定了档位**（tierGiven），还是仅"沿用当前值"
     * 的 carry 路径。carry 也写表（为了带上锚点），但**不算申报**，否则：未登记会话会被标成
     * 「已申报 standard」⇒「系统代压」提示消失；落盘恢复的 restored:true 也会被覆盖成 set。 */
    const next = { tier, at: Date.now(), seq: tierSeq, restored: false, explicit: explicit === true };
    if (anchor && typeof anchor === 'object' && Object.keys(anchor).length) next.anchor = { ...anchor };
    tierBySid.set(key, next);
    const dropped = pruneTiers(tierBySid);
    if (dropped > 0) {
      try { state.m3.tierPrunedAtSave = { at: new Date().toISOString(), dropped, size: tierBySid.size }; } catch { /* 吞 */ }
    }
    saveTiers();
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
    try {
      const it = tierBySid.get(String(sid ?? ''));
      return it != null && it.explicit !== false; // R73（C5）：carry 登记不算「申报过」
    } catch { return false; }
  }

  /** R16.16：档位来源（评审实测：热换后 Map 清空 ⇒ 已声明档位静默消失，文案却称「持久」）。
   * 返回 'set'（本次登记）/ 'restored'（本次实例由落盘恢复）/ 'none'（从未登记）。 */
  function tierState(sid) {
    try {
      const it = tierBySid.get(String(sid ?? ''));
      if (!it) return 'none';
      if (it.explicit === false) return 'none'; // R73（C5）：仅 carry 写过 ⇒ 视同从未登记
      return it.restored === true ? 'restored' : 'set';
    } catch { return 'none'; }
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
  /* R19（2026-10-15 用户要求）：档位展示统一为中文说法 `深压8%/标准16%/浅压24%`。
   * 展示文本全部由 compact-range.mjs 推导（叶子模块是唯一真相），此处只做**取用 + 兜底**。
   * 兜底只在模块未就绪时生效（宁可显示旧口径，也不让工具/卡片渲染失败）。 */
  const rangeApi = () => { try { return getRangeApi?.() ?? null; } catch { return null; } };
  /* R22（用户要求：行动/回执一律中文档位名）：范围域未加载时的**静态兜底**。
   * ⚠️ 与 compact-range 的 `TIER_LABELS`/`TIERS` 是**两份真值** ⇒ contract 有一条「单源守卫」断言
   * 逐项钉死二者相等（改一处漏一处当场红）。旧兜底是 `String(t)` ⇒ 异常路径会把 `standard16%`
   * 这种"英文 id + 百分比"混进模型可见文本（真机审计抓到过）。 */
  const TIER_FALLBACK = { light: { label: '深压', pct: 8 }, standard: { label: '标准', pct: 16 }, heavy: { label: '浅压', pct: 24 } };
  const labelOf = (t) => {
    try { return rangeApi()?.tierLabel?.(t) ?? TIER_FALLBACK[t]?.label ?? '档位'; }
    catch { return TIER_FALLBACK[t]?.label ?? '档位'; }
  };
  const pctOf = (t) => {
    try { const p = rangeApi()?.tierPct?.(t); if (Number.isFinite(p)) return p; } catch { /* 吞 */ }
    return TIER_FALLBACK[t]?.pct ?? 16;
  };
  const textOf = (t) => { try { return rangeApi()?.tierText?.(t) ?? `${labelOf(t)}${pctOf(t)}%`; } catch { return `${labelOf(t)}${pctOf(t)}%`; } };

  /* ═══ R55③（2026-10-19 用户要求「提示词/卡片文本暴露到面板，方便设置」）═══
   * 设计取舍：**只开放「覆盖」，不开放「拼接」**——内置文案是教学协议的一部分（工具名、档位说法、
   * 「先说再调用」、回执怎么看），全量替换有把协议教坏的风险，故设两道护栏：
   *   ① 模板里**必须含 `{tool}`**（否则模型不知道调哪个工具）⇒ 缺了就**回退内置并留痕**（绝不注入半截）；
   *   ② 模板只包在**内置文案产出之后**（`*Builtin` 返回什么就交给模板处理什么）⇒ 内置的所有分支
   *      语义完全不变，尤其 `renderCard` 的 `ratio < minRatio ⇒ null` 不会被模板「凭空造出一张卡」。
   * 可用占位符（**未提供的原样保留**，便于用户一眼看出自己写错了哪个名字，而不是被静默吃掉）：
   *   {tool} {builtin} {critical} {minRatio} {ratio} {retainRatio} {retainTokens} {used} {window}
   *   {tiers} {keepFromHint}
   * 留痕走 state.m3（面板「本轮注入」区可见）——本项目纪律：**静默降级是大忌**。 */
  const syncTiers = () => {
    try {
      getRangeApi?.()?.setTierRatios?.({ light: M3?.retainRatioLight, standard: M3?.retainRatioStandard, heavy: M3?.retainRatioHeavy });
    } catch { /* 吞：range 域未就绪时保持现值（不因此影响注入） */ }
  };
  const tokFmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)) : '');
  const tplVars = (args = {}, builtin = '') => {
    const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '');
    const share = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${(v * 100).toFixed(0)}%` : '');
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    return {
      '{tool}': TOOL_NAME,
      '{builtin}': builtin,
      '{critical}': pct(n(args.criticalRatio)),
      '{minRatio}': pct(n(args.minRatio)),
      '{ratio}': share(n(args.ratio)),
      '{retainRatio}': pct(n(args.retainRatio)),
      '{retainTokens}': tokFmt(n(args.retainTokens)),
      '{used}': tokFmt(n(args.usedTokens)),
      '{window}': tokFmt(n(args.windowTokens ?? args.window)),
      '{tiers}': ['light', 'standard', 'heavy'].map((t) => textOf(t)).join(' / '),
      '{keepFromHint}': "`keepFrom:{recentUser:1}` / `keepFrom:{text:'开头十来字'}`",
    };
  };
  const applyTpl = (tpl, vars, which) => {
    const raw = typeof tpl === 'string' ? tpl.trim() : '';
    if (!raw) return null; // 未配置 ⇒ 用内置文案
    if (!raw.includes('{tool}')) {
      try {
        state.m3.tplFallback = { at: new Date().toISOString(), which, why: 'missing-{tool}', len: raw.length };
        state.m3.tplFallbacks = (state.m3.tplFallbacks ?? 0) + 1;
      } catch { /* 吞 */ }
      log('warn', `文案模板（${which}）缺必需占位符 {tool} ⇒ 回退内置文案（否则模型不知道调哪个工具）`);
      return null;
    }
    let out = raw;
    for (const k of Object.keys(vars)) out = out.split(k).join(String(vars[k]));
    /* R73（审查 E2）：`desc+brief+card ≤ 3000` 原先只是**内置文案**的回归断言，用户模板可把它推到
     * 任意长度且静默放行（而注释口径称"硬约束"）。这里**留痕不截断**：截断可能正好截掉 {tool}，
     * 让模型不知道调哪个工具，比多花 token 更糟。 */
    if (out.length > 3000) {
      try {
        state.m3.tplOversize = { at: new Date().toISOString(), which, len: out.length };
        state.m3.tplOversizes = (state.m3.tplOversizes ?? 0) + 1;
      } catch { /* 吞 */ }
      log('warn', `文案模板（${which}）超预算：${out.length} > 3000 字符（不截断，避免截掉 {tool}）`);
    }
    return out;
  };
  /**
   * R60（2026-10-19 用户要求「还缺一个思考强度教学的输入框」）：给**由别的域渲染**的文案套模板。
   * 「思考强度教学」原文由 effort.mjs 产出（m2 调 `effortApi.renderBrief(eff)`），compact-tool
   * 只负责套壳。规则与 brief/card **完全一致**：必须含 `{tool}`，否则回退内置并留痕（tplFallback）——
   * 否则模型会不知道调哪个工具。`{builtin}` 就是 effort 域的原文，模板可在其前后自由增补。
   */
  const renderTemplated = (which, text, extraVars = {}) => {
    if (text == null) return text;
    try {
      /* R72（真 GLM-5.3 审查 H4）：`tplVars` 产出的键**带花括号**（'{tool}' 固定为压缩工具名），
       * 而 `extraVars` 是**裸键**（tool/current/tiers）⇒ 原先 `{...tplVars, ...extraVars}` 根本覆盖
       * 不掉 '{tool}'，于是「思考强度教学」模板会把换档工具写成 `compact_context`
       * （教错工具，模型照着调会**真的触发一次压缩**）。现统一折成 '{k}' 键再覆盖，且不再写入裸键
       * （裸键会在替换阶段误伤正文里出现的同名字样）。 */
      const vars = tplVars(extraVars, String(text));
      for (const [k, v] of Object.entries(extraVars)) {
        vars[k.startsWith('{') && k.endsWith('}') ? k : '{' + k + '}'] = v;
      }
      return applyTpl(M3?.[which], vars, which) ?? text;
    } catch { return text; }
  };
  /** R55③：渲染前同步档位比例（配置活读 ⇒ 卡片/说明/工具描述三处同时跟上，不存在写死百分比漂移）。 */
  /** R57（2026-10-19 用户要求「内置文案改成一个按钮，点击查看」）：把**内置原文**留档。
   *  面板的「查看内置文案」按钮要显示"模板留空时插件实际会用的原文"，而 client 半拿不到渲染器
   *  ⇒ 只能由 host 落档、随 HUD 的 injected 一起下发（避免在 client 复制一份而漂移）。
   *  取**最近一次**渲染的原文即可：值都来自同一轮活值（occupancy/阈值/档位）。 */
  const keepBuiltin = (which, b) => { try { if (state?.m3) state.m3.lastBuiltin = { ...(state.m3.lastBuiltin ?? {}), [which]: b ?? null }; } catch { /* 留档失败不影响渲染 */ } };
  const renderBrief = (args = {}) => {
    syncTiers();
    const b = renderBriefBuiltin(args);
    keepBuiltin('brief', b);
    return b == null ? b : (applyTpl(M3?.tplBrief, tplVars(args, b), 'brief') ?? b);
  };
  const renderCard = (args = {}) => {
    syncTiers();
    const b = renderCardBuiltin(args);
    keepBuiltin('card', b);
    return b == null ? b : (applyTpl(M3?.tplCard, tplVars(args, b), 'card') ?? b);
  };
  /* ═══ R21：语义锚点（A: recentUser 1..3 / B: text 片段）═══
   * 语义边界只有模型知道、物理节点只有插件知道 ⇒ 工具只**登记声明**，**解析放到压缩那一刻**
   * （锚点会随新消息移动；只有到压缩时才拿得到最终 surface）。
   * ⚠️ 缺省即**清除**已存锚点：这次没说锚点就按档位——"忘记重申"必须退化为安全兜底，而不是沿用旧锚点。 */
  const anchorLimits = () => { try { return rangeApi()?.ANCHOR_LIMITS ?? { maxRecentUser: 3, maxText: 60 }; } catch { return { maxRecentUser: 3, maxText: 60 }; } };
  const normAnchor = (keepFrom) => {
    try {
      const lim = anchorLimits();
      if (keepFrom === undefined || keepFrom === null) return { anchor: null, cleared: true, invalid: false };
      if (typeof keepFrom !== 'object' || Array.isArray(keepFrom)) return { anchor: null, cleared: false, invalid: true };
      const out = {};
      const n = Number(keepFrom.recentUser);
      if (Number.isInteger(n) && n >= 1 && n <= lim.maxRecentUser) out.recentUser = n;
      const t = typeof keepFrom.text === 'string' ? keepFrom.text.replace(/\s+/g, ' ').trim().slice(0, lim.maxText) : '';
      if (t) out.text = t;
      const has = Object.keys(out).length > 0;
      return { anchor: has ? out : null, cleared: !has, invalid: !has };
    } catch { return { anchor: null, cleared: false, invalid: true }; }
  };
  /** 本会话已登记的锚点（压缩点读取；未登记 ⇒ null）。 */
  function getAnchor(sid) {
    try {
      const it = tierBySid.get(String(sid ?? ''));
      const a = it?.anchor;
      return a && typeof a === 'object' ? { ...a } : null;
    } catch { return null; }
  }
  /** R19：`tier` 入参规范化——**同时接受中文标签与英文 id**（用户可能写「浅压24%」或 `heavy`）。 */
  const normTier = (tierName) => {
    try {
      const c = rangeApi()?.canonicalTier?.(tierName);
      if (c && c.known) return { tier: c.tier, fallback: false, via: c.via };
    } catch { /* 吞：退回下面的内联实现 */ }
    const t = typeof tierName === 'string' && tierName.trim() ? tierName.trim() : 'standard';
    return tierNames().includes(t) ? { tier: t, fallback: false, via: 'id' } : { tier: 'standard', fallback: true, via: 'unknown' };
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
      /* R72（真 GLM-5.3 审查 H5）：action 原先只有「=== 'set-tier' ? … : 'compact'」的二分，
       * 于是 `set_tier` / `Set-Tier` / 任何打错字的值都会**静默落到真压缩**（副作用在危险侧：
       * 摘要掉近端），而模型以为自己只是登记了档位。现在：值不合法 ⇒ 可见失败、要求重试。
       * 参数校验的失败对模型是**可纠正**的，比静默误压便宜得多。 */
      const actionRaw = args?.action;
      const actionNorm = typeof actionRaw === 'string' ? actionRaw.trim() : actionRaw;
      if (actionNorm != null && actionNorm !== '' && actionNorm !== 'compact' && actionNorm !== 'set-tier') {
        return {
          ok: false,
          error: `action 只能是 compact 或 set-tier（收到「${String(actionRaw).slice(0, 40)}」）。`
            + '若要「只登记档位、本次不压缩」，请传 action:\'set-tier\'。',
        };
      }
      const action = actionNorm === 'set-tier' ? 'set-tier' : 'compact';
      /* R16：档位是**会话级持久偏好**（智能压缩线与强制线都读它）；未选/非法 ⇒ standard 兜底。
       * ⚠️ R21.2（2026-10-15 真机事故）：**「未选」必须与「非法」分开**——
       * 旧实现把 `args.tier == null` 也丢进 normTier ⇒ 返回 standard ⇒ **每次只传 keepFrom 的调用
       * 都会把会话档位重置成标准16%**（真机实测：落盘文件里 heavy → standard，静默发生，
       * 而卡片上明明写着「不传 tier = 沿用已登记档位（不是重置）」）。 */
      const tierGiven = args?.tier != null && String(args.tier).trim() !== '';
      const { tier, fallback, via } = tierGiven
        ? normTier(args.tier)
        : { tier: getTier(sid), fallback: false, via: 'carry' };
      /* R21：语义锚点（可选）。缺省 ⇒ 清除旧锚点（"忘记重申"退化为按档位 = 安全方向）。 */
      const anchorNorm = normAnchor(args?.keepFrom);
      setTier(sid, tier, anchorNorm.anchor, tierGiven); // R73（C5）：只有真的传了 tier 才算申报
      const at = Date.now();
      const prev = bySid.get(sid);
      sweepExpired(); // R73（审查 E10）：登记路径原先不扫过期 ⇒ TTL 只靠「宿主每 pre-step peek」兜底
      if (action === 'compact') bySid.set(sid, { at, reason });
      if (action === 'compact') rearmBySid.delete(sid); // R75（E3）：新意图登记 ⇒ 重挂预算重置
      state.m3.compactToolCalls = (state.m3.compactToolCalls ?? 0) + 1;
      state.m3.lastCompactTool = {
        at: new Date().toISOString(),
        sessionId: sid,
        action,
        reason: reason || null,
        tier,
        tierLabel: textOf(tier),
        tierVia: via || null,
        tierFallback: fallback || null,
        /* R21：锚点取证（`keepFrom` 若给了但形状非法 ⇒ anchorInvalid，压缩点会退档位）。 */
        anchor: anchorNorm.anchor,
        anchorInvalid: anchorNorm.invalid || null,
        anchorCleared: anchorNorm.cleared || null,
        /* 连续调用（<5s）多半是模型重复触发；记下来供报告核查，但**不拒绝**——
         * 拒绝会让模型以为自己没调成功而反复重试；意图是幂等的（覆盖写）。 */
        repeated: !!prev && at - prev.at < 5000,
      };
      log('info', `智能压缩 工具已登记：${action === 'set-tier' ? '仅档位（不压缩）' : '下一步开始前执行'}（sid ${sid.slice(0, 8)}…，档位 ${textOf(tier)}${via === 'alias' ? '（中文标签）' : ''}${fallback ? '（非法值兜底）' : ''}${anchorNorm.anchor ? `，锚点 ${anchorNorm.anchor.text ? 'text=' + anchorNorm.anchor.text : 'recentUser=' + anchorNorm.anchor.recentUser}` : ''}${reason ? '，理由：' + reason : ''}）`);
      schedule('compact-tool', 400);
      /* R15（用户要求「工具完成后进行检查，起码 agent 自己过一遍」）：
       * 工具只能**登记**，真正的执行在下一步的 pre-step ⇒ 必须给出**自检契约**，否则
       * 「回了 ok 但实际没执行」对模型完全不可见（2026-10-08 真机踩过：M3 域加载失败两版，
       * 工具一直回 ok/scheduled，压缩一次都没发生）。回执由插件在下一步开头注入。 */
      const pctNow = pctOf(tier);
      /* R21：锚点回执。**必须把「压缩时才解析」说清**——否则模型会以为锚点已生效；
       * 失败路径（形状非法）也要当场告知，而不是等压缩点静默退档位。 */
      const anchorNote = anchorNorm.anchor
        ? (anchorNorm.anchor.text
          ? `；**语义锚点已登记**：按文本「${anchorNorm.anchor.text}」定位那条消息（压缩时解析，失败自动退档位）`
          : `；**语义锚点已登记**：从最近第 ${anchorNorm.anchor.recentUser} 条你的消息起全部保留（压缩时解析，失败自动退档位）`)
        : (anchorNorm.invalid ? '；⚠️ `keepFrom` 形状非法，已忽略（本次按档位）' : '');
      if (action === 'set-tier') {
        /* ⚠️ R16.16（另一会话实测事故，高）：这里曾写 `scheduled: false`（**boolean**），
         * 而 `output.schema` 声明 `type:'string'` ⇒ 宿主按 schema 校验**整条调用被拒**：
         *   `tool "compact_context" returned invalid output: "value.scheduled" must be a string`
         * ——新加的最大杠杆功能在生产上等于不可用。
         * 契约正解：set-tier **省略** `scheduled`（可选字段）；`compact` 仍回 'next-step'。
         * 教训（已入测试）：断言必须校验**返回值 ↔ output.schema 的类型契约**，
         * 只断言实现值（false）会给出虚假信心。 */
        return {
          ok: true,
          action: 'set-tier',
          /* R22（用户要求：行动/回执一律中文）：返回值也必须是**中文标签**——工具结果是模型直接读到的东西，
           * 回英文 id 等于给模型"复述英文"的原料（真机审计发现过 `{"tier":"heavy"}`）。 */
          tier: textOf(tier),
          verify: `${via === 'carry' ? `档位沿用「${textOf(tier)}」` : `档位已登记为「${textOf(tier)}」`}（保留窗口 × ${pctNow}%）${anchorNote}——**本次不压缩**。`
            + '该档位此后对本会话的压缩（包括系统在强制线代替你执行的那次）持续生效，直到再次改选。'
            + '想在低占用时提前锁定档位，就用这条路径（零压缩成本）。',
        };
      }
      return {
        ok: true,
        action: 'compact',
        scheduled: 'next-step',
        tier: textOf(tier),
        verify: `已登记，${via === 'carry' ? `档位沿用「${textOf(tier)}」` : `档位「${textOf(tier)}」`}（保留窗口 × ${pctNow}%）${anchorNote}——该档位此后对本会话的压缩（含强制线）持续生效，直到再次改选。下一步开头会有一条「压缩自检」回执；若显示「未执行」，请再调用一次 compact_context，或直接告知用户。`,
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
      return `**保留多少**（**按默认档位 ${textOf('standard')} 计**——若你已登记其它档位，以每轮决策卡上的活值为准）：`
        + `压缩按「上下文窗口 × ${Math.round(r * 100)}%」自选保留范围，当前窗口下**近端约 ${kfmt(t)} token 原样保留**，`
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
  function renderBriefBuiltin({ criticalRatio, retainRatio, retainTokens } = {}) {
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
        /* R16：三档只是**保留预算**不同；范围计算/边界保护/摘要策略完全一致。
         * R19（2026-10-15 用户要求）：展示统一为中文说法 `深压8%/标准16%/浅压24%`，
         * 百分比与 1M 窗口折算值**全部由 TIERS 推导**（写死会与常量漂移）。 */
        `**压缩档位（3 选 1）**：`
          + `**${textOf('light')}**=保留窗口 × ${pctOf('light')}%（1M 窗口 ≈ ${kfmt(Math.round(1e6 * pctOf('light') / 100))}）——全新子任务/要预留大量空间；`
          + `**${textOf('standard')}**=× ${pctOf('standard')}%（≈${kfmt(Math.round(1e6 * pctOf('standard') / 100))}）——默认；`
          + `**${textOf('heavy')}**=× ${pctOf('heavy')}%（≈${kfmt(Math.round(1e6 * pctOf('heavy') / 100))}）——接下来仍要频繁引用近端一大段。`
          + `**登记方式**：调 ${TOOL_NAME} 时带 \`tier\`（**用中文档位名**，「浅压24%」这种完整写法也认）；**只想提前锁定档位、现在不压** ⇒ 加 \`action:'set-tier'\`（零压缩成本）。`
          + `**不传 tier = 沿用已登记档位；从未登记过才按 ${textOf('standard')}**（不是重置）。`,
        /* R21：把「语义锚点」教出去**必须与档位同段**——它是同一件事的更精确形态：
         * 模型知道新旧需求的边界，插件知道 token ⇒ 分工是「模型指位置、插件算预算」。
         * ⚠️ 措辞要短：三处教学合计有 ≤3000 字符的预算断言（desc+brief+card）。 */
        `**语义锚点（比比例更准）**：旧需求占地方、新需求只在近端时，按比例选档会白留旧内容——`
          + `传 \`keepFrom:{recentUser:1}\`（从最近第 1 条你的消息起全保留，可 1/2/3）`
          + `或 \`keepFrom:{text:'开头十来字'}\`（按文本定位）。text 优先、失败退 recentUser、再失败退档位；`
          + `**锚点之后原样保留**。不传 = 清除锚点。`,
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
  function renderCardBuiltin({ ratio, minRatio, criticalRatio, retainRatio, retainTokens, usedTokens, deltaTokens, deltaSamples, turnsToLine, resetByCompaction, tierName, tierDeclared, tierState, tierBudget, tierRatio, anchorLabel, anchorBudget, anchorFail } = {}) {
    try {
      if (ratio == null || ratio < minRatio) return null;
      const pct = `${(ratio * 100).toFixed(0)}%`;
      const crit = `${Math.round((Number(criticalRatio) || 0.8) * 100)}%`;
      /* R78：预算一律以**档位预算**为准（tierBudget 缺省才回落 retainTokens）——
       * 否则会出现「策略行说 240k、损失行说 160k」的自相矛盾（正是调查报告 §5.1 那类问题）。 */
      const tb0 = Number(tierBudget ?? retainTokens);
      const tr0 = Number(tierRatio ?? retainRatio);
      const r = Number.isFinite(tr0) && tr0 > 0 ? tr0 : Number(retainRatio);
      const t = Number.isFinite(tb0) && tb0 > 0 ? tb0 : Number(retainTokens);
      /* ═══ R81（本轮全面自查发现的真缺陷）═══
       * 锚点模式下**实际保留**是锚点预算（40k 级，不折算），而损失行原先用**档位预算** t
       * ⇒ 锚点 40k、档位 240k、占用 570k 时，卡上说"会摘要掉 ~330k"，实际会摘要 ~530k
       * —— **低估损失 200k，直接误导"现在压划不划算"的决策**。
       * 现按"此刻真正会执行的策略"取预算：锚点已解析 ⇒ 用锚点预算；否则档位预算。 */
      const anchorB81 = Number(anchorBudget);
      const execBudget = Number.isFinite(anchorB81) && anchorB81 > 0 ? anchorB81 : t;
      const execLabel = Number.isFinite(anchorB81) && anchorB81 > 0 ? '锚点预计保留预算' : '本档位保留预算';
      /* R16：档位行按**当前窗口**折算三档的近似保留量；拿不到时给比例不给 token 数。
       * R19：① 展示用中文说法；② 预算按**真实窗口**折算（win = 当前档位预算 ÷ 当前档位比例），
       * 不再用 0.5×/1.5× 的倍数魔法——那只是「8/16/24 恰好成倍数」时的巧合，常量一改就错。 */
      const win = (Number.isFinite(t) && t > 0 && Number.isFinite(r) && r > 0) ? t / r : null;
      const budgetOf = (name) => (win == null ? null : Math.round(win * pctOf(name) / 100));
      const bLight = budgetOf('light');
      const bStd = budgetOf('standard');
      const bHeavy = budgetOf('heavy');
      /* R78（调查报告 §4.1）：三档描述改为**中性判据**、并去掉卡片里的 token 折叠数
       * （brief 已给过数字；卡片每轮都出现，省下的是每请求成本）。
       * 原文案把浅压写成"接下来仍要频繁引用近端一大段（多文件联调/长推理链）"——
       * 一般开发任务很容易符合，而深压的"近端细节不再需要"很难被模型确信 ⇒ 单向偏向 24%。
       * 现改为「按**信息需求**选，不按任务难度选」，并把"选浅压要说明保留什么"写进决策顺序行。 */
      const tierLine = `**${textOf('light')}**（最省：边界清晰、旧资料可从文件重读）；`
        + `**${textOf('standard')}**（默认：边界拿不准）；`
        + `**${textOf('heavy')}**（保留最多原始细节：跨文件联调/复杂排错，证据不能过早只剩摘要）。`;
      /* R81（review）：原 `keep` 变量已无消费者（R78 删掉「现行生效」句后遗留）⇒ 删除，避免死代码。 */
      /* R16.14（评审建议 6）：把「压了会丢什么」变成**数字**，而不是让模型猜。
       * 判据：当前上下文总量 ≈ ratio × window；与当前档位的保留预算比较。 */
      const used = Number.isFinite(Number(usedTokens)) && Number(usedTokens) > 0
        ? Number(usedTokens)
        : (Number.isFinite(Number(ratio)) ? Math.round(Number(ratio) * (Number(retainTokens) / (Number(retainRatio) || 0.16))) : null);
      let loss = '';
      if (used != null && Number.isFinite(execBudget) && execBudget > 0) {
        loss = used <= execBudget
          ? `**当前上下文 ≈${kfmt(used)} token ≤ ${execLabel} ${kfmt(execBudget)} ⇒ 现在压，近端一点都不丢**（只会把更早的转摘要）。`
          : `**当前上下文 ≈${kfmt(used)} token > ${execLabel} ${kfmt(execBudget)} ⇒ 现在压会摘要掉 ~${kfmt(used - execBudget)} token 近端内容**。`;
      }
      /* R16.14（评审建议 2）：把「若预计会推高」从预测题变成算术题（用实测的每轮增量）。 */
      const delta = Number(deltaTokens);
      const samples = Number(deltaSamples);
      /* R70：单轮增量外推易被贴图/大 diff 拉偏 ⇒ 改为**最近 N 轮均值**，并明确标出样本数；
       * 刚压缩过时基线已重置，本轮**不给外推**（否则会拿"压缩前的巨量增量"误导模型）。 */
      const trend = resetByCompaction === true
        ? `**趋势**：刚刚压缩过（上下文骤降）⇒ 基线已重置，**下一轮起重新累计**（本轮不给外推）。`
        : Number.isFinite(delta) && delta > 0
          ? `**趋势（近 ${Number.isFinite(samples) && samples > 0 ? samples : 1} 轮均值粗估）**：每轮 +${kfmt(delta)} token`
            + (Number.isFinite(Number(turnsToLine)) && Number(turnsToLine) > 0 ? `，约 **${Number(turnsToLine)} 轮**触 ${crit} 强制线` : '')
            + `——轮数很小时就是**声明档位的窗口期**。`
          : '';
      /* R16.15（评审建议 3/8）：决策行里的「tier 保持 X」原先无处可查（卡只给保留 token 数）
       * ⇒ 明确渲染**当前档位名**（含是否已登记），并把「现行生效」的语义限定为保留预算。 */
      /* ═══ R78（调查报告 §5.1：已复现的信息错误）═══
       * 原实现把「现行生效预算」固定在默认比例（0.16），而执行侧按**会话档位** resolveTier
       * ⇒ 同一张卡里出现「当前档位 24%」与「现行 160k/16%」并存（真实运行报告里出现过）。
       * 现在预算由 m2 按本会话**实际策略**派生（档位预算或已登记锚点），这里只负责如实渲染：
       *   · 锚点模式 ⇒ 模式 + 锚点描述 + 预计预算（解析不到就说"压缩时解析"，不编造）+ 回退目标
       *   · 档位模式 ⇒ 档位 + 其**真实预算**（与 m3 执行侧同一函数 resolveTier 的结果）
       * 同时满足 §8.1「预算与总占用分开呈现」：这里说的是**近端保留预算**，占用在上面的趋势/损失行。 */
      const cur = typeof tierName === 'string' && tierName ? tierName : null;
      /* R78 兼容：直连调用（测试/旧接线）只给 retainRatio/retainTokens 时，把它们当作档位预算——
       * 这样「预算=档位预算」的语义在两种调用下都成立，不会出现"卡片没有数字"的空档。 */
      const tb = t;
      const tr = r;
      const tbTxt = Number.isFinite(tb) && tb > 0
        ? ` ≈${kfmt(tb)} token` + (Number.isFinite(tr) && tr > 0 ? `（窗口 × ${Math.round(tr * 100)}%）` : '')
        : '';
      const tierStateTxt = tierState === 'restored' ? '（已登记；本次由**落盘恢复**）'
        : tierState === 'set' ? '（已登记）'
          : tierDeclared === true ? '（已登记）' : '（**兜底**：未登记档位）';
      const tierNow = cur == null
        ? (Number.isFinite(tb) && tb > 0 ? `**近端保留预算**${tbTxt}（不是压后总占用）。` : '')
        : (anchorLabel
          ? `**当前策略：锚点（按位置）**——${anchorLabel}`
          + (Number.isFinite(Number(anchorBudget)) && Number(anchorBudget) > 0
            ? `，预计保留 ≈${kfmt(Number(anchorBudget))} token（锚点预算不折算）`
            : '，预算在压缩时按实际边界解析（不折算）')
          /* R81：这是**本次**解析的结果（卡片每轮现算），不是"上次"——措辞如实。 */
          + (anchorFail ? `；锚点本次未能定位（${String(anchorFail).slice(0, 40)}）` : '')
          + `。锚点未命中会自动回退到**${textOf(cur)}**${tbTxt}。`
          : `**当前策略：档位 ${textOf(cur)}**${tbTxt}${tierStateTxt}——这是**近端保留预算**（不是压后总占用）。`);
      /* R20（用户要求「卡片对称化」）：**多留与少留两个方向都变数字**。
       * 原实现只在 used > 当前预算 时给一句「若先声明浅压24% 少丢多少」——**只量化了多留的好处**，
       * 从不说多留的代价（压后占用更高 ⇒ 更早再压一次，而每次压缩都要付摘要 LLM + 缓存重置）。
       * 用户观察到的「Agent 都爱用浅压24%」正是这个单向偏差 + 激励不对称的产物
       * （与 R16.12「不切档没有可见代价」同型，方向相反：这里是「多留没有可见代价」）。 */
      const critR = Number(criticalRatio) || 0.8;
      const trendExists = trend !== '';
      const afterOf = (b) => {
        if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(win) || win <= 0) return null;
        const pctAfter = b / win;
        const leftTokens = Math.max(0, (critR - pctAfter) * win);
        const turns = (Number.isFinite(delta) && delta > 0) ? Math.max(1, Math.round(leftTokens / delta)) : null; // R70：与 turnsToLine 同口径取整
        return { pctAfter, turns };
      };
      const dirLine = (used != null && Number.isFinite(t) && t > 0 && used > t
        && Number.isFinite(bHeavy) && Number.isFinite(bLight)) ? (() => {
        const seg = (label, budget, tail) => {
          const a = afterOf(budget);
          return `${label}（留 ${kfmt(budget)}）⇒ 丢 ~${kfmt(Math.max(0, used - budget))}`
            + (a ? `、压后占用 ≈${(a.pctAfter * 100).toFixed(0)}%${a.turns != null ? `（距 ${crit} ≈${a.turns} 轮）` : ''}` : '')
            + (tail ? `，${tail}` : '');
        };
        /* R81：锚点模式下这两个方向是"若改按档位"的对比，必须标明，否则会被读成当前计划。 */
        return `${anchorLabel ? '**两个方向（若改按档位）**' : '**两个方向（选一个）**'}：${seg(textOf('heavy'), bHeavy, '近端保真最好')}；`
          + `${seg(textOf('light'), bLight, `余量最大，但近端只剩 ${kfmt(bLight)}`)}。`
          + `多留 ⇒ 压后高、下次压缩更早；少留 ⇒ 余量大、摘要更早。`;
      })() : '';
      /* R20（用户要求「越线反向建议」）：越线场景**必须建议更深的档**——
       * 原实现只说「立刻声明档位」而不说选哪档，模型顺手选浅压24% ⇒ 压完仍在线上
       * ⇒ 走「追加官方 overflow 收口」再压一次（m3 里确有这条路径）= 白多压一轮。 */
      const overLine = ratio >= critR
        ? `**当前占用 ${pct} 已越强制线 ⇒ 立刻用 \`action:'set-tier'\` 声明「${textOf('light')}」或「${textOf('standard')}」**`
          + `——越线时选「${textOf('heavy')}」往往**压了等于没压**（压完仍在线之上 ⇒ 还会触发一次官方 overflow 收口 = 白多压一轮）。`
        : (trendExists
          ? `**当前占用 ${pct} 尚在强制线之下**——**按上方趋势行判断**是否现在声明档位（越线时按它执行）。`
          : `**当前占用 ${pct} 尚在强制线之下**——若预计任务会推高占用，趁还在 ${crit} 强制线之下时选定档位，越线那一刻的自动压缩就按它执行。`);
      return [
        `压缩决策卡（context-pilot，当前占用 ${pct}）：先判断接下来的任务是否还依赖本轮之前的对话细节——`,
        /* R16.15（评审建议 2）：决策行只在**本卡出现时**要求——卡不出现的轮次没有提醒位，
         * 那些轮次要写决策行是「事实上不可执行」的要求（评审原文）。 */
        `• **本轮开头先落一行决策**：**一轮只写一次**；中途真的改了决定（压缩/升或降档）再补一行，其余步骤不要重复。`
          + `写法：正文里写`
          + `\`压缩决策：压｜占用 ${pct}｜理由…\` 或 \`压缩决策：不压｜占用 ${pct}｜理由…｜tier 保持 <档位>\`（档位名见下方，**正文写中文名**）。`,
        tierNow,
        `• 不依赖（换了话题/新子任务/上一阶段已收尾），或任务繁重需要预留空间：`
          + `**先在回复正文里用一句话说明你要压缩的理由**，**再**调用 ${TOOL_NAME}。`
          + `它在**下一步开始前**执行、本轮不中断；`
          + `调用后请**直接继续当前任务**——不要为了压缩而停下、不要结束回合。`,
        `• 档位（3 选 1）：${tierLine}`
          + `**只想登记档位、现在不压** ⇒ 加 \`action:'set-tier'\`。`
          + `${overLine}`,
        /* R43（用户 2026-10-16）：**两种模式必须写清优先级与差别**——此前只在句尾顺带提了一句
         * `keepFrom`，既没说"锚点优先"，也没说两种口径不同（按比例 vs 按位置）。要求全中文。 */
        /* R78（调查报告 §8.3 / §4.1）：把选档决策收敛为**两步**，并纠正对 24% 的单向偏向——
         * 原先把「按比例」列在①、「按位置」列在②，示例还写 `tier 浅压24%` ⇒ 示例偏向 + 锚点认知成本高。
         * 现在：先问"能否锁定任务起点"（能 ⇒ 锚点），不能再选档；并要求选浅压时说明保留什么。 */
        `• **决策顺序（两步，锚点优先）**：①**按位置**：能锁定「当前任务从哪条消息开始」⇒ 用 \`keepFrom:{recentUser:N}\` 或 \`{text:'开头十来字'}\`——该处起**原样保留、不折算**，能压掉更早的无关历史（最省无关上下文）；②锁定不了才**按比例**选档（默认），选浅压时**说明要保留什么**。锚点未命中自动退回档位。`,
        `• **省略语义不对称**：不传 \`tier\` = **沿用**已登记档位（不是重置）；不传 \`keepFrom\` = **清除**锚点——要持续用锚点就必须每次都带。`,
        loss,
        dirLine,
        trend,
        /* R16.14/15（评审建议 4）：讲清代压代价，替代原先那句替不作为背书的「无需操作」。 */
        `• 依赖（要引用之前的路径/结论/报错现场/长推理链）：不要调用（或改用 ${textOf('heavy')}）。`
          + `**但「不压」的代价不是零**：占用达 ${crit} 时**系统会代替你压缩**——时机由系统选、按**那一刻**生效的档位执行、`
          + `摘要会把**当时已过期的事实**（旧版本号/旧结论）写进概要。`,
        `• 调用前自检：本轮关键产物（文件路径、决策、未落盘的结论）先落盘或写进正文，再调用。`,
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
        /* 用户要求（2026-10-08）的「先说，再调用」——description 每请求下发，是零额外成本的提醒位。
         * R22（用户要求：行动前一律中文档位名）：这里明确"档位写中文名"，否则模型会在正文里
         * 复述工具返回值里的英文 id（真机审计发现过 `{"tier":"heavy"}` 这种形态）。 */
        + '**调用本工具前，先在回复正文里用一句话说明你要压缩的理由**（用户看不到工具调用的理由；'
        + '档位一律**写中文名**，如「浅压24%」），然后再调用。'
        + '压缩在**你的下一个步骤开始前**执行，本轮不中断，调用后请直接继续当前任务、不要停下等它。'
        + '参数：`action`（默认 compact=登记并压缩；**set-tier=只登记档位、本次不压缩**）、'
        + '`tier`（三选一：深压8% / 标准16% / 浅压24%，**不传 = 沿用已登记档位**）、'
        + '`keepFrom`（可选，语义锚点：从你指定的那条需求起保留，比比例更准）、`reason`。'
        + '档位是**会话级持久选择**（含强制线那次）。'
        + '**策略、当前档位与本轮数据（损失/趋势）见每轮注入的压缩决策卡**——按卡上的数字判断，不要凭空预测占用。'
        + '工具返回后会给出自检契约。',
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
          description: '（可选）压缩档位：深压8%（只保留窗口 × 8%）/ 标准16%（默认）/ 浅压24%（保留最多）。'
            + '**用中文档位名**（「浅压24%」这种完整写法也认）；英文 id 仅作兼容，**别写进给用户看的正文**。'
            + '选档理由写在回复正文里；档位对本会话后续所有压缩持续生效。',
        },
        /* R21：语义锚点（用户场景：600k 里含新旧两个需求，新需求只在最后 6% ⇒ 按比例选档会白留旧内容）。
         * 语义边界只有模型知道、物理节点只有插件知道 ⇒ 模型**指位置**，插件**算预算**。 */
        /* ⚠️ R21.1（2026-10-15 真机事故）：`type:'object'` 的参数**必须显式声明
         * `additionalProperties`**（true/false 都要写），否则 defineTool 直接拒绝：
         *   `unsupported JSON schema: parameters.keepFrom.additionalProperties must be explicitly true or false`
         * ⇒ **整个工具静默不注册**（模型看不到它、调不了），而教学/卡片仍在喊"调用 compact_context"。
         * 影响面：v0.1.8 上线后约 1.5 小时内，**模型自主压缩全线失效**（只剩强制线自动兜底）。
         * 与 R16.16 那条（`required: false` 被拒）**同型**；两条都靠 m3.compactTool 取证字段才定位得到。
         * 教训：测试桩 `getDefineTool: (sp)=>sp` 会**绕过 schema 校验** ⇒ 必须补一条结构化断言
         * （见 contract 的「工具 spec 自检」：object 参数必须有 additionalProperties）。 */
        keepFrom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recentUser: { type: 'number', description: '（可选）最近第 N 条**真人用户消息**（1/2/3；跳过插件自己注入的用量行）。' },
            text: { type: 'string', description: '（可选）那条消息的**开头十来个字**（前缀匹配优先，退化为包含匹配）。' },
          },
          description: '（可选）**语义锚点**：把保留范围精确到你指定的那条"新需求"，比三档比例更准。'
            + '`{recentUser: 1}` = 从最近第 1 条你的消息起全部保留（1/2/3）；'
            + '`{text: "那条消息开头十来个字"}` = 按文本定位（更精确，可指向更早或同条内的起点）。'
            + '两者都给 ⇒ text 优先、失败退 recentUser、再失败退 tier。**锚点之后一律原样保留**（绝不丢新需求）。'
            + '不传 = 清除本会话已登记的锚点（按档位）。',
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
            tier: { type: 'string', description: '本次生效的压缩档位，**中文标签**（如「浅压24%」）。' },
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

  /** R18：注册的**可撤销句柄**（与 effort 同款）——开关关闭时必须撤回，
   * 否则「关闭智能压缩」只是停了行为，工具仍每请求下发、白付 schema。 */
  let toolDisposer = null;

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
      const d = tools.register(defineTool(toolSpec()));
      toolDisposer = typeof d === 'function' ? d : null;
      toolRegistered = true;
      state.m3.compactTool = {
        at: new Date().toISOString(), ok: true, name: TOOL_NAME, via: 'tools.register',
        revocable: !!toolDisposer,
      };
      log('info', `智能压缩 工具已注册：${TOOL_NAME}（可撤回=${!!toolDisposer}）`);
      return true;
    } catch (e) {
      state.m3.compactTool = { at: new Date().toISOString(), ok: false, error: msg(e) };
      log('warn', `智能压缩 工具注册失败（吞）：${msg(e)}`);
      return false;
    }
  }

  /** R18：撤回全局注册（开关关闭时）。拿不到 disposer 时不假装成功，留痕。 */
  function retractTool(reason) {
    try {
      if (!toolRegistered) return false;
      toolRegistered = false;
      const d = toolDisposer;
      toolDisposer = null;
      if (typeof d === 'function') {
        try { d(); } catch (e) { log('warn', `智能压缩 工具撤回失败（吞）：${msg(e)}`); }
        state.m3.compactTool = {
          at: new Date().toISOString(), ok: true, name: TOOL_NAME, via: 'tools.register',
          retracted: reason ?? 'switch-off',
        };
        log('info', `智能压缩 工具已撤回（${reason ?? 'switch-off'}）`);
        schedule('compact-tool', 400); // R18.2：撤回落报告（与 effort 侧对称）
        return true;
      }
      state.m3.compactRevokeGap = { at: new Date().toISOString(), why: 'no-disposer', reason: reason ?? 'switch-off' };
      log('warn', '智能压缩 工具撤回：register() 未返回 disposer（本 DSH 版本不支持），保持现状');
      schedule('compact-tool', 400); // R18.2：降级同样留痕
      return false;
    } catch { return false; }
  }

  /** 懒安装入口：宿主由 pre-step **最前面**调用（幂等、无副作用）。
   * ⚠️ R18：宿主不再按开关早退 ⇒ 关闭时也会进来（要撤回工具）。 */
  function ensure() {
    try {
      const d = state.m3.compactToolDiag;
      d.calls += 1;
      d.at = new Date().toISOString();
      const on = enabled();
      d.enabled = on;
      d.intents = bySid.size;
      if (!on) {
        retractTool('switch-off');
        return false;
      }
      const ok = registerTool();
      d.installed = ok;
      /* R62（用户实测「查看内置按钮点击显示空的」）：lastBuiltin 原先只在**模板渲染时**落档 ⇒
       * 首轮注入之前面板点开永远是空的。这里在注册期先按**当前配置**预渲染一份内置文案，
       * 面板随时可看；注入发生后会被真实活值版本覆盖（keepBuiltin 每次都写最新）。 */
      try {
        if (!state.m3.lastBuiltin || (!state.m3.lastBuiltin.brief && !state.m3.lastBuiltin.card)) {
          syncTiers();
          keepBuiltin('brief', renderBriefBuiltin({ criticalRatio: M3?.criticalRatio, retainRatio: M3?.retainRatioStandard, retainTokens: null }));
          /* R72（真 GLM-5.3 审查 C1）：`renderCardBuiltin` 首行守卫 `ratio == null ⇒ null`，而这里传的是
           * `ratio: null` ⇒ 预渲染**恒为 null** ⇒ 首轮注入之前，面板「查看内置文案」对决策卡永远是空的
           * （R62 只想让 brief/card 都能随时可看，card 这条一直没达成）。改传一个**演示值**（刚好越过
           * markerMinRatio，让卡片完整渲染出趋势/两个方向等段落）；它只是文案预览，不是真实读数。 */
          keepBuiltin('card', renderCardBuiltin({
            ratio: Math.min(0.9, (Number(M3?.markerMinRatio) || 0.3) + 0.08),
            minRatio: M3?.markerMinRatio, criticalRatio: M3?.criticalRatio, retainRatio: M3?.retainRatioStandard,
            usedTokens: null, deltaTokens: null, turnsToLine: null, tierName: null, tierState: 'unset',
            demo: true,
          }));
        }
      } catch { /* 预览失败不影响工具注册 */ }
      return ok;
    } catch (e) {
      state.m3.compactToolDiag.error = msg(e);
      state.m3.compactToolDiag.at = new Date().toISOString();
      return false;
    }
  }

  /** 取证快照（宿主报告用；只读，不暴露内部 Map）。
   *  ⚠️ R73（审查 S2）：原注释称「宿主 buildSnapshot 会调它」——**不实**，m1.snapshot 并无此调用，
   *  意图表实际**不进报告**（只在 compactIntentMiss/计数里留间接痕迹）。此处改为如实描述；
   *  若将来要在报告里看到「登记了但没消费」的现场，需要真的接线（见 R72 遗留 S2）。 */
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

  return { TOOL_NAME, ensure, peekIntent, takeIntent, rearmIntent, pending, getTier, hasTier, setTier, tierState, renderBrief, renderCard, renderTemplated, diag, tierText: (t) => textOf(t), getAnchor, normAnchor, TIER_DISPLAY_FALLBACK: TIER_FALLBACK };
}
