/**
 * 会话事实账本（R50 解耦）——把「关于某个会话的**实测事实**」从 `m3.compact.mjs`（829 行、压缩决策
 * + 记账混在一起）抽成**叶子模块**。
 *
 * ## 为什么是这几样（而不是随便抽点代码）
 * 它们有共同形状：**由测量与事件喂养、只被读、不决定任何行为**——决定权留在 m3（压缩时机/范围）、
 * m2（回执措辞）、threshold（阈值钳制）。抽出来后：
 *   · m3 只剩「决策 + 执行」，事实口径只有一份实现；
 *   · 消费方（m2 的回执、threshold 的 modelPolicies 匹配）不再穿过 m3 去拿事实；
 *   · 落盘持久化（R50 新能力）只在这一处，不必在每个消费方重复。
 *
 * 四类事实：
 *   ① **折算因子** `retainFactor`（R39）：表盘真实口径 / 三行可见口径，夹 [1,2]。
 *   ② **稳定回落样本** `settleDrop`（R45）：压缩刚完成时的投影是**过渡值**（provider 未刷新），
 *      下一次**非 stale** 实测才量得出真实回落；存每会话中位数。**R50：落盘**（`.data/settle-drop.json`）
 *      ⇒ 跨重启/跨 toggle 仍在；并给出**跨会话中位数**（`settleDropAny`，明确标 `scope:'global'`，
 *      绝不冒充本会话实测）。
 *   ③ **压缩锁** `compactLock`（R49）：官方 `assertCompactionInactive` 规定「未匹配的 `compaction/start`
 *      即持久锁」，官方 `/compact` 与插件共用 ⇒ 插件发起前必须让路。带 TTL（陈旧锁不得永久让路）。
 *   ④ **当前模型路由** `route`（R49）：`model/selection` ⇒ 供 threshold 按 `modelPolicies` 精确匹配。
 *
 * ## 纪律
 * - **不抛错**：任何异常吞掉并返回安全默认（null / false / 1），绝不中断压缩链路。
 * - **有界化**：每类事实按会话数 ≤ `SID_CAP`，样本 ≤ `SETTLE_SAMPLES_CAP`。
 * - **落盘失败只警告**：照 `compact-tier.json` / `hud-acts.json` 的既有范式（吞错 + mkdirSync）。
 * - **只用已文档化的会话事件**（不去碰未公开的 `session.seq` / 反向扫日志）。
 * - 事实状态仍写在 `state.m3.*`（**刻意**）：消费方（threshold 读 route、m2 读样本）零改动，
 *   抽取是纯搬迁而非行为变更。将来若要让 m3 彻底不持有事实，把 `state.m3` 换成 `state.facts` 即可。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function createSessionFacts({ state, log, pick, svc, summarizeBreakdown, tryOf, pluginDir }) {
  const SID_CAP = 64;
  const SETTLE_SAMPLES_CAP = 8;
  /** 压缩锁 TTL：日志修复/崩溃后若永远没有 end 事件，插件不能永久让路（最坏 = 旧行为）。 */
  const COMPACT_LOCK_TTL_MS = 10 * 60_000;
  const settlePath = pluginDir ? join(pluginDir, '.data', 'settle-drop.json') : null;

  /** 事实统一挂在 `state.m3.*`（消费方零改动；state 缺失也不抛）。 */
  const M = () => (state.m3 = state.m3 ?? {});
  const boundMap = (m, cap) => {
    try {
      const ks = Object.keys(m);
      if (ks.length > cap) delete m[ks[0]];
    } catch { /* ignore */ }
  };
  /* R71（GLM #9）：原实现取**上中位**（偶数样本返回较大的那个）。settle-drop 样本常只有 1-2 条，
   * 2 条时上中位系统性偏大 ⇒「稳定后预计」占用偏低，与 R45/R50「不编数字」的诚实口径有细微偏差。
   * 改为真中位（偶数取两中值平均）。 */
  const median = (xs) => {
    const a = xs.slice().sort((x, y) => x - y);
    if (a.length === 0) return null;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };

  /* ═══════════ ① 折算因子（R39）═══════════ */
  const noteRetainFactor = (sid, mr, session) => {
    try {
      if (!sid || !mr?.ok || mr.stale) return null;
      /* ⚠️ R39.1（真机 bug）：三行组成**不在 `measure` 里**，而是 `stateOf(session,'contextBreakdown')`。
       * 第一版把整个 `measure` 传进去 ⇒ 按契约返回 null ⇒ 因子恒为 1（真机：retainBudgetHeur 240000 / factor 1）。 */
      const sp = svc?.('sessionProjections');
      const bv = summarizeBreakdown?.(tryOf(() => sp?.stateOf?.(session, 'contextBreakdown')).value ?? null)
        /* 兜底退回 `measure`，但**只接受三行齐全**的结果——`summarizeBreakdown(measure)` 只给 system 行，
         * 用它当分母会把 2,162 当总量 ⇒ factor 顶到上限 2 ⇒ 压过头。宁可不算（factor=1）。 */
        ?? summarizeBreakdown?.(mr.measure);
      const hasAllRows = bv && Number.isFinite(bv.tools) && Number.isFinite(bv.messages);
      const vis = hasAllRows ? (Number(bv.system) || 0) + bv.tools + bv.messages : null;
      if (!Number.isFinite(vis) || vis <= 0 || !Number.isFinite(mr.used)) return null;
      const factor = Math.min(Math.max(mr.used / vis, 1), 2);
      const bySid = M().retainFactor = M().retainFactor ?? {};
      bySid[sid] = { factor: +factor.toFixed(2), at: new Date().toISOString(), real: mr.used, visible: vis };
      boundMap(bySid, SID_CAP);
      return factor;
    } catch { return null; }
  };
  const retainFactorOf = (sid) => {
    try { const f = M().retainFactor?.[sid]?.factor; return Number.isFinite(f) ? f : 1; } catch { return 1; }
  };

  /* ═══════════ ② 稳定回落样本（R45 + R50 落盘）═══════════ */
  let settleLoaded = false;
  const loadSettle = () => {
    if (settleLoaded || !settlePath) return;
    settleLoaded = true;
    try {
      const j = JSON.parse(readFileSync(settlePath, 'utf8'));
      const by = j?.bySid && typeof j.bySid === 'object' ? j.bySid : {};
      const cur = M().settleDrop = M().settleDrop ?? {};
      for (const [k, arr] of Object.entries(by)) {
        if (!Array.isArray(arr)) continue;
        const ok = arr
          .filter((x) => Number.isFinite(Number(x?.drop)) && Number(x.drop) > 0)
          .map((x) => ({ drop: Math.round(Number(x.drop)), from: Number(x.from) || null, to: Number(x.to) || null, at: String(x.at ?? '') }))
          .slice(-SETTLE_SAMPLES_CAP);
        if (ok.length) cur[k] = ok;
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') log?.('warn', `settle-drop.json 读取失败（忽略，按无样本）：${e?.message ?? e}`);
    }
  };
  /* R53（自审发现 #2）：**原子落盘**（同目录 tmp + rename）——直写会留半截 JSON，
   * 读取侧（本模块自己的 loadSettle 与面板/工具）会读到 `Unterminated string in JSON` ⇒ 样本全丢。
   * ⚠️ 各域各留一份：本项目禁止域间 import（依赖由宿主注入）。 */
  const writeJsonAtomic = (p, obj) => {
    const body = JSON.stringify(obj, null, 2);
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, p);
      return true;
    } catch {
      try { unlinkSync(tmp); } catch { /* 吞 */ }
      writeFileSync(p, body);   // Windows 目标被占用 ⇒ rename EBUSY ⇒ 退化直写
      return true;
    }
  };
  const saveSettle = () => {
    if (!settlePath) return;
    try {
      mkdirSync(join(pluginDir, '.data'), { recursive: true });
      writeJsonAtomic(settlePath, { version: 1, savedAt: new Date().toISOString(), bySid: M().settleDrop ?? {} });
    } catch (e) { log?.('warn', `settle-drop.json 写入失败（吞）：${e?.message ?? e}`); }
  };
  /** 压缩完成时挂观察（只有 stale 才值得观察：非 stale 说明 provider 已刷新，没有"回落"可量）。 */
  const armSettleWatch = (sid, used, ratio) => {
    try {
      if (!sid || !Number.isFinite(used)) return null;
      const w = M().settleWatch = M().settleWatch ?? {};
      w[sid] = { at: Date.now(), used, ratio: Number.isFinite(ratio) ? ratio : null };
      boundMap(w, SID_CAP);
      return true;
    } catch { return null; }
  };
  const noteCompactSettle = (sid, mr) => {
    try {
      if (!sid || !mr?.ok || mr.stale || !Number.isFinite(mr.used)) return null;
      const w = M().settleWatch?.[sid];
      if (!w || !Number.isFinite(w.used)) return null;
      delete M().settleWatch[sid];
      const drop = w.used - mr.used;
      if (!(drop > 0)) return null;
      const bySid = M().settleDrop = M().settleDrop ?? {};
      const arr = bySid[sid] = bySid[sid] ?? [];
      arr.push({ drop: Math.round(drop), from: w.used, to: mr.used, at: new Date().toISOString() });
      while (arr.length > SETTLE_SAMPLES_CAP) arr.shift();
      boundMap(bySid, SID_CAP);
      saveSettle();   // R50：落盘（写失败只警告）
      return drop;
    } catch { return null; }
  };
  const settleDropOf = (sid) => {
    try {
      loadSettle();
      const arr = M().settleDrop?.[sid];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const ds = arr.map((x) => Number(x.drop)).filter((x) => Number.isFinite(x) && x > 0);
      if (ds.length === 0) return null;
      return { drop: median(ds), n: ds.length, last: Math.max(...ds) };   // 中位数
    } catch { return null; }
  };
  /**
   * R50：**跨会话参考**。本会话还没有样本时（典型：升级后第一次压缩、或刚换会话），
   * 用全局中位数给一个**明确标注来源**的估计——`scope:'global'` ⇒ 回执必须写「参考其他会话」，
   * 绝不冒充本会话实测（R45 的诚实原则：宁可说"暂无"，也不编数字）。
   */
  const settleDropAny = (sid) => {
    try {
      loadSettle();
      const own = settleDropOf(sid);
      if (own) return { ...own, scope: 'session' };
      const all = [];
      for (const arr of Object.values(M().settleDrop ?? {})) {
        if (!Array.isArray(arr)) continue;
        for (const x of arr) { const d = Number(x?.drop); if (Number.isFinite(d) && d > 0) all.push(d); }
      }
      if (all.length === 0) return null;
      return { drop: median(all), n: all.length, last: Math.max(...all), scope: 'global' };
    } catch { return null; }
  };

  /* ═══════════ ③④ 压缩锁 + 当前模型路由（R49）═══════════
   * 官方 `assertCompactionInactive`：未匹配的 `compaction/start`（其后没有更晚的 `session/end-seed`）
   * 即持久锁；官方 `/compact` 与插件共用，且 `/compact` 仅限空闲 ⇒ 同时发起必有一方吃 `busy`。
   * 官方 `resolveTargetPolicy`：`modelPolicies[]` 按 provider+model 精确匹配覆盖 `thresholdRatio`。 */
  const noteSessionEvent = (session, event) => {
    try {
      const t = event?.type;
      if (!t) return null;
      const sid = String(pick?.(session?.id, session?.header?.id, '') ?? '');
      if (!sid) return null;
      const m3s = M();
      if (t === 'compaction/start') {
        m3s.compactLock = m3s.compactLock ?? {};
        m3s.compactLock[sid] = { at: Date.now(), seq: event.seq ?? null, turn: event.data?.turn ?? null };
        boundMap(m3s.compactLock, SID_CAP);
        return 'lock-set';
      }
      if (t === 'compaction/end' || t === 'session/end-seed') {
        if (m3s.compactLock?.[sid]) { delete m3s.compactLock[sid]; return 'lock-cleared'; }
        return null;
      }
      if (t === 'model/selection') {
        m3s.route = m3s.route ?? {};
        m3s.route[sid] = { at: Date.now(), provider: event.data?.provider ?? null, model: event.data?.model ?? null };
        boundMap(m3s.route, SID_CAP);
        return 'route-set';
      }
      return null;
    } catch { return null; }
  };
  const compactionLockActive = (sid) => {
    try {
      const rec = M().compactLock?.[sid];
      if (!rec || !Number.isFinite(rec.at)) return false;
      if (Date.now() - rec.at > COMPACT_LOCK_TTL_MS) { delete M().compactLock[sid]; return false; }   // TTL 过期 ⇒ 不永久让路
      return true;
    } catch { return false; }
  };
  const currentRouteOf = (sid) => { try { return M().route?.[sid] ?? null; } catch { return null; } };

  return {
    noteRetainFactor, retainFactorOf,
    armSettleWatch, noteCompactSettle, settleDropOf, settleDropAny,
    noteSessionEvent, compactionLockActive, currentRouteOf,
  };
}
