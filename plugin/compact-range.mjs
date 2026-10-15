/**
 * 保留范围自选（R5）——压缩域的依赖图叶子：**纯函数，不做 IO、不读配置、不碰会话**。
 *
 * ## 为什么需要它
 * 引擎唯一的「绕过阈值强制压缩」通道是 `compactIfNeeded(agent, 'context-overflow')`，
 * 其源码写死 `selectCompactableRange(session, measurement, **0**)`（lib/index.js:932）⇒
 * `retainTokens = 0` ⇒ 只保留最后一个节点 + tool-pairing 回退。
 * 2026-10-07 真机 E2E 实测代价（报告自动记录，无需推测）：
 *   - 压缩前 `surfaceTokens 367,794`，`nodeCount **1117**`
 *   - 压缩后 `surfaceTokens 8,603`，`nodeCount **4**`
 * 即：**在只有 53% 占用时就把 1117 个 surface 节点砍到 4 个**（97.7% 影子化）。
 *
 * 引擎另有 `compactRegion(start, end, agent, signal)` 是**公开方法**（lib/index.js:971），
 * 范围由调用方给 ⇒ 我们可以用自己的保留预算算范围，把「保留多少近端细节」拿回手里。
 *
 * ## 为什么不用复刻引擎的配对算法
 * `selectCompactableRange` / `systemHead` / `validateSurfaceRegion` **都未导出**
 * （lib/index.js:1027 只导出 `BasicCompactionEngine`），`toolPairingBalancedBefore/After`
 * 虽由 `@deepseek-ai/dsh-compaction` 导出，但从插件里裸导入 DSH 内部包会引入版本耦合。
 * 因此本模块只做**能做对的两件事**，边界合法性交给引擎裁决：
 *   1. 起点：引擎 `systemHead(session, surfaceNodes[0])` 用的是 **`session.eventAt(seq).type`**
 *      （lib/index.js:396-398）——公开 session API，我们照用（`isSystemHead`）。
 *   2. 终点：按 token 预算从尾部回退得到候选 `end`，然后**调 `compactRegion` 让它校验**。
 *      校验发生在 `compaction/start` 之前（lib/index.js:452 vs 469）⇒ 边界被拒是
 *      **零副作用、零 LLM 成本**的纯读错误 ⇒ 可以安全地逐个节点回退重试（`prevEnd`）。
 *
 * ## 边界错误的判定
 * 只认 `validateSurfaceRegion` 抛出的、以 `compactRegion: ` 开头的**位置/配对**错误。
 * `ManualCompactionError("busy")`、`compactRegion: no open turn`、摘要 LLM 失败等
 * **不重试**（重试无意义，官方路径会同样失败）——由调用方决定是否回退官方。
 */

/** 引擎默认保留比例（lib/index.js:17 `const DEFAULT_RETAIN_RATIO = .16`）。 */
export const RETAIN_RATIO = 0.16;

/**
 * R16 压缩档位（用户要求 2026-10-08）：Agent 可在**3 个语义档位**里选一个，
 * 范围计算仍是本模块的确定性代码（档位只改「喂给 selectRange 的预算」）——
 * 把「不可靠的自由度」换成「有界的选择」，边界合法性仍由引擎裁决。
 *
 * | 展示说法 | id（兼容值） | 保留比例 | 1M 窗口 | 语义 |
 * | --- | --- | --- | --- | --- |
 * | **深压8%** | `light` | 8% | ~80k | 新子任务/要预留大量空间，近端细节不再需要 |
 * | **标准16%** | `standard` | 16% | ~160k | 默认（= 既有行为，已验证）；**未选档/非法值都落这里** |
 * | **浅压24%** | `heavy` | 24% | ~240k | 仍要频繁引用近端一大段（多文件联调/长推理链） |
 *
 * ⚠️ 2026-10-15 用户要求：**展示用中文说法（深压8%/标准16%/浅压24%）**，英文 id 退为内部/兼容值
 * （落盘文件与老会话里存的仍是 id ⇒ 不产生迁移问题）。展示文本由 `tierText(name)` 统一生成。
 */
export const TIERS = {
  light: 0.08,
  standard: RETAIN_RATIO,
  heavy: 0.24,
};

/** 档位名的规范集合（工具 schema enum 与防御性校验共用）。 */
export const TIER_NAMES = Object.keys(TIERS);

/* ═══════════ 档位的中文说法（2026-10-15 用户要求） ═══════════
 * 用户原话：「改成『深压8%/标准16%/浅压24%』的说法。」
 *
 * 口径：**展示一律用中文（标签 + 紧跟百分比），英文 id 只作内部/兼容值**。
 *   · 展示：`深压8%` / `标准16%` / `浅压24%`（百分比由 TIERS 推导，**不写死**——
 *     本项目已有「写死 16% 与常量漂移」的教训）；
 *   · 兼容：工具参数、落盘文件（compact-tier.json）、老会话里存的仍是 `light/standard/heavy`，
 *     且 `canonicalTier` 同时接受中文标签与英文 id ⇒ 改名不产生迁移问题。 */
export const TIER_LABELS = {
  light: '深压',
  standard: '标准',
  heavy: '浅压',
};

/** 中文标签（未知名字原样返回，绝不编造）。 */
export function tierLabel(name) {
  return TIER_LABELS[name] ?? String(name ?? '');
}

/** 保留比例 → 展示用百分比整数（未知档位返回 null）。 */
export function tierPct(name) {
  const r = TIERS[name];
  return Number.isFinite(r) ? Math.round(r * 100) : null;
}

/** 统一展示口径：`深压8%` / `标准16%` / `浅压24%`（拿不到比例时退化为纯标签）。 */
export function tierText(name) {
  const p = tierPct(name);
  return p == null ? tierLabel(name) : `${tierLabel(name)}${p}%`;
}

/** 中文标签 → 英文 id（兼容用户在正文/参数里写中文）。 */
const TIER_ALIASES = { 深压: 'light', 标准: 'standard', 浅压: 'heavy' };

/**
 * 把「id 或中文标签」规范化成 id。
 * @returns `{ tier, via: 'id'|'alias', known: boolean }`；未知值返回 `known:false` 且 tier 原样（由调用方兜底）。
 */
export function canonicalTier(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (Object.prototype.hasOwnProperty.call(TIERS, raw)) return { tier: raw, via: 'id', known: true };
  const exact = TIER_ALIASES[raw];
  if (exact) return { tier: exact, via: 'alias', known: true };
  /* R22（用户要求：行动/回执一律中文档位名）：卡片、回执、工具返回值用的都是**带百分比的完整说法**
   * （「深压8%」「标准16%」「浅压24%」）⇒ 模型极可能原样回填 `tier`。只支持两字词干会让这种回填
   * 落到 `known:false` ⇒ **静默退回 standard**（最坏形态：模型以为选了浅压24%，实际按标准16% 压）。
   * 故补一条**前缀匹配**：以中文档位词开头即视为该档。 */
  for (const [label, id] of Object.entries(TIER_ALIASES)) {
    if (raw.startsWith(label)) return { tier: id, via: 'alias', known: true };
  }
  return { tier: raw, via: 'unknown', known: false };
}

/** 保留预算下限（token）：小窗口下 light 只有 ~10k，保留太少没法干活 ⇒ 抬到 40k。 */
export const MIN_RETAIN_TOKENS = 40_000;

/** 保留预算上限（比例）：保留超过窗口一半就失去压缩意义，且逼近引擎阈值。 */
export const MAX_RETAIN_RATIO = 0.5;

/**
 * 把档位名解析成「保留比例 + 生效预算」。
 * @param tierName - 档位名；`undefined/null/''` ⇒ standard（未选兜底）；未知名字也落 standard。
 * @param window - 上下文窗口（token），用于夹取计算；非法窗口时 ratio 仍返回，预算为 0。
 * @returns `{ tier, ratio, budget, clamped, fallback }`
 *  - `fallback: true` 表示入参非法（未知档位）被兜到 standard（取证用）；
 *  - `clamped: true` 表示预算被 MIN/MAX 夹取过（取证用）。
 */
export function resolveTier(tierName, window) {
  const name = typeof tierName === 'string' && tierName.trim() ? tierName.trim() : 'standard';
  const fallback = !Object.prototype.hasOwnProperty.call(TIERS, name);
  const tier = fallback ? 'standard' : name;
  let ratio = TIERS[tier];
  let clamped = false;
  if (Number.isFinite(window) && window > 0) {
    let budget = Math.floor(window * ratio);
    const min = Math.min(MIN_RETAIN_TOKENS, Math.floor(window * MAX_RETAIN_RATIO));
    if (budget < min) { budget = min; clamped = true; }
    const max = Math.floor(window * MAX_RETAIN_RATIO);
    if (budget > max) { budget = max; clamped = true; }
    return { tier, ratio, budget, clamped, fallback };
  }
  return { tier, ratio, budget: 0, clamped: false, fallback };
}

/** 边界回退最大次数（每次都是零成本纯读；64 远超任何真实尾部长度）。 */
export const MAX_WALK_BACK = 64;

/* ═══════════ R21：语义锚点保留（A/B 两形态 + 降级链） ═══════════
 * 用户场景（2026-10-15）：「上下文 600k 里含新旧两个需求，最新需求只在最后 6% ⇒ 选深压8% 收益最大：
 * 新需求几乎全保留、又腾出空间、还避免旧需求带来的降智。**Agent 能知道新旧 2 个需求的节点在哪么？**」
 *
 * 结论：**语义边界只有模型知道**（它刚读过那些消息），**物理节点只有插件知道**（seq / token）。
 * 本模块负责把两者接起来（纯函数：session / measurement / textOf 全部由调用方注入，自身零 IO）：
 *   · A：`{recentUser:N}` —— 最近第 N 条**真用户消息**（跳过插件自己注入的 user/message）；
 *   · B：`{text:'前缀片段'}` —— 按文本定位那条消息（更精确：可指向更早，或同条消息内的需求起点）；
 *   · **降级链：text → recentUser → tier → 标准16%**，每一跳都带回 `reason`（调用方必须留痕，
 *     否则模型会以为锚点生效了——这正是本项目最怕的静默降级）。
 * 保留语义：**锚点之后的内容一律原样保留**（宁可多留，绝不丢新需求）。由两件事共同保证：
 *   ① 预算 = 锚点→末尾 token + 余量；② `selectRange` 的 `keepFromSeq` 护栏（范围绝不越过锚点）。 */
export const ANCHOR_MARGIN = { min: 8_000, max: 32_000, factor: 2, ratio: 0.1 };

/** 锚点声明限值（工具侧校验与文案共用；单一真相）。 */
export const ANCHOR_LIMITS = { maxRecentUser: 3, maxText: 60 };

/** 真用户消息（`source.kind` 缺省或 'user'）；插件注入的 `context-pilot` 等一律跳过。 */
const isRealUserEvent = (ev) => ev?.type === 'user/message'
  && (ev?.data?.source?.kind === undefined || ev?.data?.source?.kind === null || ev?.data?.source?.kind === 'user');

/** surface 与 measurement 同序同长的一致性校验（与 selectRange 同款；不一致一律不猜）。 */
function alignedSurface(session, measurement) {
  const surface = session?.surface?.nodes;
  const nodes = measurement?.nodes;
  if (!Array.isArray(surface) || !Array.isArray(nodes) || nodes.length === 0) return null;
  if (surface.length !== nodes.length) return null;
  for (let i = 0; i < surface.length; i += 1) if (surface[i] !== nodes[i]?.seq) return null;
  return { surface, nodes };
}

/** 第 N 条真用户消息的 seq（从末尾往前数；找不到返回 null）。 */
export function recentUserSeq(session, n = 1) {
  try {
    const surface = session?.surface?.nodes;
    if (!Array.isArray(surface) || typeof session?.eventAt !== 'function') return null;
    const want = Number.isInteger(n) && n >= 1 ? n : 1;
    let seen = 0;
    for (let i = surface.length - 1; i >= 0; i -= 1) {
      const ev = session.eventAt(surface[i]);
      if (!isRealUserEvent(ev)) continue;
      seen += 1;
      if (seen === want) return surface[i];
    }
  } catch { /* 吞：读不到即无锚点，由调用方退档位 */ }
  return null;
}

/**
 * 按文本片段定位真用户消息：**先比前缀（最精确），再退化为包含匹配**，都取**最近**一条。
 * @param textOf 事件文本提取器（由调用方注入 core 的 `extractEventText`，保持单一真相）。
 * @returns `{ seq, via:'text-prefix'|'text-contains' }` 或 null。
 */
export function findUserSeqByText(session, text, textOf) {
  try {
    const surface = session?.surface?.nodes;
    if (!Array.isArray(surface) || typeof session?.eventAt !== 'function' || typeof textOf !== 'function') return null;
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const frag = norm(text);
    if (!frag) return null;
    let containsHit = null;
    for (let i = surface.length - 1; i >= 0; i -= 1) {
      const ev = session.eventAt(surface[i]);
      if (!isRealUserEvent(ev)) continue;
      const t = norm(textOf(ev));
      if (!t) continue;
      if (t.startsWith(frag)) return { seq: surface[i], via: 'text-prefix' };
      if (containsHit === null && t.includes(frag)) containsHit = { seq: surface[i], via: 'text-contains' };
    }
    return containsHit;
  } catch { return null; }
}

/** 锚点 seq → 末尾 的 token 量（含锚点自身那条消息）。surface 不一致一律返回 null。 */
export function tokensFromSeq(session, measurement, seq) {
  const al = alignedSurface(session, measurement);
  if (!al) return null;
  const idx = al.surface.indexOf(seq);
  if (idx < 0) return null;
  let acc = 0;
  for (let i = idx; i < al.nodes.length; i += 1) acc += Number(al.nodes[i]?.tokens) || 0;
  return acc;
}

/**
 * 把「模型的锚点声明」解析成保留预算（A/B 两形态 + 降级链）。
 * @param want `{ recentUser?:1|2|3, text?:string }`（text 优先，失败退 recentUser）
 * @returns `{ok:true, seq, via, tokens, margin, budget, clamped}` 或
 *          `{ok:false, reason, tried:string[]}`（调用方据此退 tier 并留痕）
 */
export function resolveAnchorBudget({ session, measurement, want, window, textOf, deltaTokens } = {}) {
  const tried = [];
  const ok = (hit) => {
    const tokens = tokensFromSeq(session, measurement, hit.seq);
    if (!Number.isFinite(tokens) || tokens <= 0) { tried.push(`${hit.via}:budget-invalid`); return null; }
    if (!Number.isFinite(window) || window <= 0) { tried.push(`${hit.via}:no-window`); return null; }
    const d = Number(deltaTokens);
    const marginRaw = Number.isFinite(d) && d > 0
      ? Math.round(d * ANCHOR_MARGIN.factor)
      : Math.round(tokens * ANCHOR_MARGIN.ratio);
    const margin = Math.min(ANCHOR_MARGIN.max, Math.max(ANCHOR_MARGIN.min, marginRaw));
    const min = Math.min(MIN_RETAIN_TOKENS, Math.floor(window * MAX_RETAIN_RATIO));
    const max = Math.floor(window * MAX_RETAIN_RATIO);
    let budget = tokens + margin;
    let clamped = false;
    if (budget < min) { budget = min; clamped = true; }
    if (budget > max) { budget = max; clamped = true; }
    return { ok: true, seq: hit.seq, via: hit.via, tokens, margin, budget, clamped, tried };
  };
  if (typeof want?.text === 'string' && want.text.trim()) {
    const hit = findUserSeqByText(session, want.text, textOf);
    if (hit) { const r = ok(hit); if (r) return r; }
    else tried.push('text:not-found');
  }
  if (Number.isInteger(want?.recentUser) && want.recentUser >= 1) {
    const seq = recentUserSeq(session, want.recentUser);
    if (seq !== null) { const r = ok({ seq, via: 'recent-user' }); if (r) return r; }
    else tried.push('recent-user:not-found');
  }
  return { ok: false, reason: tried.length ? tried.join('|') : 'no-anchor', tried };
}

/**
 * 保留预算（token）= 上下文窗口 × 比例。
 * 引擎口径是 `floor((contextWindow - reservedCompletionTokens) * retainRatio)`；
 * 我们拿不到 reserved（内部函数），故**不扣减** ⇒ 保留得比引擎默认更多 = 更保守（少丢近端细节）。
 * @param window - 上下文窗口（token）；非正/非数则返回 0。
 * @param ratio - 保留比例，默认 RETAIN_RATIO。
 */
export function retainBudgetTokens(window, ratio = RETAIN_RATIO) {
  const w = Number(window);
  const r = Number(ratio);
  if (!Number.isFinite(w) || w <= 0) return 0;
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.floor(w * Math.min(r, 1));
}

/**
 * surface 节点 0 是否为 `system/message`（引擎 `systemHead` 同款判定）。
 * 引擎明确「surface 节点 0 的 system/message 永不进范围」，故此时起点取节点 1。
 * @returns true=是系统消息（起点用 index 1）；读不到一律 false（起点用 index 0，与引擎无系统头时一致）。
 */
export function isSystemHead(session, seq) {
  try {
    return session?.eventAt?.(seq)?.type === 'system/message';
  } catch {
    return false;
  }
}

/**
 * 按保留预算自选范围——`selectCompactableRange` 的语义复刻（起点规则一致，终点不做配对回退）。
 * 引擎的配对回退（`while (!toolPairingBalancedBefore(...)) keepFromIdx -= 1`）由调用方
 * 通过「调 compactRegion → 被拒则 prevEnd」完成，避免复刻内部函数。
 *
 * @param session - 持有 `surface.nodes`（seq 数组）的会话。
 * @param measurement - `tokenMeter.measure(session)` 的返回值；用其 `nodes`（`{seq,tokens}[]`）。
 * @param retainTokens - 保留预算（token）。
 * @param keepFromSeq - （可选，R21）语义锚点 seq：**范围绝不越过它**（宁可多留，绝不丢新需求）。
 * @returns
 *  - `{ ok:true, start, end, startIdx, endIdx, retainedTokens, shadowTokens, firstIdx, anchorIdx? }`
 *  - `{ ok:false, why:'no-nodes'|'surface-mismatch'|'nothing-to-compact', ... }`
 */
export function selectRange({ session, measurement, retainTokens, keepFromSeq }) {
  const nodes = measurement?.nodes;
  const surface = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, why: 'no-nodes' };
  if (!Array.isArray(surface) || surface.length !== nodes.length) return { ok: false, why: 'surface-mismatch' };
  for (let i = 0; i < surface.length; i += 1) {
    if (surface[i] !== nodes[i]?.seq) return { ok: false, why: 'surface-mismatch', at: i };
  }
  const firstIdx = isSystemHead(session, surface[0]) ? 1 : 0;
  const budget = Number.isFinite(retainTokens) && retainTokens > 0 ? retainTokens : 0;
  let acc = 0;
  let keepFromIdx = nodes.length;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    acc += Number(nodes[i]?.tokens) || 0;
    keepFromIdx = i;
    if (acc >= budget) break;
  }
  /* R21（锚点护栏）：范围**绝不越过锚点**——预算是估算（含余量、夹取），而「锚点之后原样保留」
   * 是模型的**语义声明**，不能用估算去覆盖它。宁可多留一点（少压），绝不丢新需求。 */
  let anchorIdx = null;
  if (Number.isInteger(keepFromSeq)) {
    const ai = surface.indexOf(keepFromSeq);
    if (ai >= firstIdx && ai < keepFromIdx) { anchorIdx = ai; keepFromIdx = ai; }
    else if (ai >= firstIdx) anchorIdx = ai;
  }
  if (keepFromIdx <= firstIdx) {
    return { ok: false, why: 'nothing-to-compact', firstIdx, retainedTokens: acc, budget, surfaceNodes: nodes.length, anchorIdx };
  }
  /* 护栏生效时（范围被拉到锚点）**必须重算保留量**：`acc` 是"按预算回退"的累加值，
   * 此刻已不是真实边界对应的量 ⇒ 不重算就会在回执/报告里报一个偏小的「保留 ~X」。 */
  let retainedTokens = acc;
  if (anchorIdx !== null && keepFromIdx === anchorIdx) {
    retainedTokens = 0;
    for (let i = keepFromIdx; i < nodes.length; i += 1) retainedTokens += Number(nodes[i]?.tokens) || 0;
  }
  let shadowTokens = 0;
  for (let i = firstIdx; i < keepFromIdx; i += 1) shadowTokens += Number(nodes[i]?.tokens) || 0;
  return {
    ok: true,
    start: surface[firstIdx],
    end: surface[keepFromIdx - 1],
    startIdx: firstIdx,
    endIdx: keepFromIdx - 1,
    firstIdx,
    anchorIdx,
    retainedTokens,
    shadowTokens,
    budget,
    surfaceNodes: nodes.length,
  };
}

/**
 * 把范围末端回退一个 surface 节点（引擎 while 回退的同款语义）。
 * @returns `{ end, endIdx }`，或 null（已回退到起点之前 ⇒ 放弃）。
 */
export function prevEnd(surface, firstIdx, endIdx) {
  if (!Array.isArray(surface)) return null;
  const nextIdx = endIdx - 1;
  if (!Number.isInteger(nextIdx) || nextIdx < firstIdx) return null;
  const end = surface[nextIdx];
  if (end === undefined) return null;
  return { end, endIdx: nextIdx };
}

/** 引擎 `validateSurfaceRegion` 抛出的错误一律以 `compactRegion: ` 开头（lib/index.js:554-558, 460）。 */
const VALIDATION_ERROR = /^compactRegion: /;

/** **末端**不合法（可安全回退末端重试；发生在 `compaction/start` 之前 ⇒ 零副作用零成本）。 */
const END_BOUNDARY_ERROR = /^compactRegion: end seq \d+ is not a balanced boundary/;

/** 是否校验类错误（非边界）/ 是否末端不合法（应回退重试）。 */
export function isValidationError(e) {
  return VALIDATION_ERROR.test(String(e?.message ?? ''));
}

export function isEndBoundaryError(e) {
  return END_BOUNDARY_ERROR.test(String(e?.message ?? ''));
}

/** 范围读数 → 单行日志文本（pre-step 日志与报告共用同一口径）。 */
export function fmtRange(sel) {
  if (!sel || sel.ok !== true) return `no-range(${sel?.why ?? 'null'})`;
  return `seq ${sel.start}-${sel.end}（起点 index ${sel.startIdx}，保留 ~${sel.retainedTokens}，影子 ~${sel.shadowTokens} token）`;
}
