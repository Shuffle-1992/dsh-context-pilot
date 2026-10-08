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
 * | 档位 | 保留比例 | 1M 窗口 | 语义 |
 * | --- | --- | --- | --- |
 * | light | 8% | ~80k | 深压：新子任务/要预留大量空间，近端细节不再需要 |
 * | standard | 16% | ~160k | 默认（= 既有行为，已验证）；**未选档/非法值都落这里** |
 * | heavy | 24% | ~240k | 浅压：仍要频繁引用近端一大段（多文件联调/长推理链） |
 */
export const TIERS = {
  light: 0.08,
  standard: RETAIN_RATIO,
  heavy: 0.24,
};

/** 档位名的规范集合（工具 schema enum 与防御性校验共用）。 */
export const TIER_NAMES = Object.keys(TIERS);

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
 * @returns
 *  - `{ ok:true, start, end, startIdx, endIdx, retainedTokens, shadowTokens, firstIdx }`
 *  - `{ ok:false, why:'no-nodes'|'surface-mismatch'|'nothing-to-compact', ... }`
 */
export function selectRange({ session, measurement, retainTokens }) {
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
  if (keepFromIdx <= firstIdx) {
    return { ok: false, why: 'nothing-to-compact', firstIdx, retainedTokens: acc, budget, surfaceNodes: nodes.length };
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
    retainedTokens: acc,
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
