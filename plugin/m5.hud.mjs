/**
 * M5 HUD 域（R11 解耦第三刀）—— 弹窗（client 每 5s `getHud`）的数据来源与压缩历史。
 *
 * ## 搬了什么
 * - **存储**：`hud-acts.json` 的读写（cap 50）+ 运行期去重记录（`recordHudAct`）。
 * - **发布**：`publishHud`（内存写 `state.m5.hud` + `schedule('m5-publish')` 落报告）。
 * - **文案**：`hudReasonLabel` / `formatAct`（`hh:mm · 原因 · 省 xK`，运行期与启动回填共用）。
 * - **聚合响应**：`buildHudResponse(sid)`（原 `onGetHud` 主体）。
 * - **启动回填**：`republishFromReport()`（原 `bfOnce` 主体）。
 *
 * ## 为什么把它放在「第三刀」的第一个（顺序依据）
 * R10 把 M3 的跨域回调显式化之后，M3 的 deps 里出现了 `publishHud` / `recordHudAct` / `formatAct`
 * 三项——**被依赖者必须先独立**。⇒ 顺序是 M5 → M2 → M1 → core。
 *
 * ## 它为什么是「跨域聚合视图」而不是纯独立域
 * `buildHudResponse` 要同时回答四件事：本会话压缩历史（本域）、占用读数（M3 的 `measureRatio`）、
 * 生效上限（R8 的 `criticalCapOf`，client 据此**钳制并落盘**用户配置）、思考档位（effort 的 `hudPayload`）
 * 与开关活读（M3 的 `M3.effortEnabled`）。R7 审计指出「它不是独立域」——这里的处理是
 * **把这四个跨域依赖全部注入**（`measureRatio` / `criticalCapOf` / `mergeConfig`+`M3` / `getEffortApi`），
 * 而不是让它去 import 别人的内部件。于是它仍是依赖图叶子，只是依赖面宽。
 *
 * ## 边界纪律
 * - 只允许 `node:` 内置 import（相对 import 会成环 / 破坏叶子约束；static.mjs 有断言）。
 * - 由宿主 `import(\`./m5.hud.mjs?ts=${IMPL_TS}\`)` 加载（漏 `?ts=` ⇒ P16 永久缓存）。
 * - **不抛错**：读写失败一律吞 + 留痕；**读路径不写盘**（`buildHudResponse` 只写 `state.m5.hudPollReq` 取证）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function createM5Hud(deps) {
  const {
    state, log, msg, schedule, pluginDir,
    /* 跨域注入（见文件头「跨域聚合视图」） */
    svc, pick, measureRatio, criticalCapOf, mergeConfig, M3, getEffortApi, getReportBase,
  } = deps;

  const hudActsPath = join(pluginDir, '.data', 'hud-acts.json');
  const HUD_ACTS_CAP = 50;

  /* R7：`'marker'` 分支随 marker 通道退役删除；并把 `context-overflow`（=**模型主动请求**）单列——
   * 原先它落进 `String(reason)` 默认分支，弹窗会直接显示内部枚举名。 */
  const hudReasonLabel = (reason) =>
    reason === 'context-overflow' ? '智能压缩'
      : reason === 'safety-net' ? '兜底'
        : reason === 'pressure' ? '强制压缩'
          : String(reason ?? '');

  /* B1（审查）：formatAct 统一「hh:mm · 原因 · 省 xK」模板——运行期（at 缺省=现在）与启动回填（at=记录时刻）共用 */
  const formatAct = (reason, tokens, at) => {
    const d = at != null ? new Date(at) : new Date();
    const hhmm = (Number.isNaN(d.getTime()) ? new Date() : d).toTimeString().slice(0, 5);
    const head = `${hhmm} · ${hudReasonLabel(reason)}`;
    return Number.isFinite(tokens) && tokens > 0 ? `${head} · 省 ${Math.round(tokens / 100) / 10}K` : head;
  };

  const publishHud = (patch) => {
    try {
      const clean = {};
      for (const [k, v] of Object.entries(patch ?? {})) if (typeof v !== 'undefined') clean[k] = v; // B3：_hudRetry 过滤已随 configEditor 通道判死一并退役
      Object.assign(state.m5.hud, clean);
      state.m5.lastPublish = { at: new Date().toISOString(), step: 'ok', channel: 'memory', patch: clean };
      schedule('m5-publish', 400);
    } catch (e) {
      try { state.m5.lastPublish = { at: new Date().toISOString(), step: 'exception', error: msg(e) }; } catch { /* 吞 */ }
    }
  };

  /* ═══════════ 压缩历史持久化（hud-acts.json，cap 50） ═══════════ */
  const loadHudActs = () => {
    try {
      const raw = readFileSync(hudActsPath, 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, '')); // 剥 BOM（外部工具写入可能带，JSON.parse 不容忍）
      if (j && Array.isArray(j.acts)) {
        return {
          acts: j.acts
            .filter((a) => a && typeof a.sid === 'string' && typeof a.text === 'string' && typeof a.at === 'string')
            .slice(0, HUD_ACTS_CAP),
        };
        /* 旧文件的 `lineage` 键**读入即忽略**（2026-10-08 血统链退役）。 */
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') log('warn', `hud-acts.json 读取失败（忽略，走报告回填）：${msg(e)}`);
    }
    return null; // 文件缺失/损坏 → null（调用方回退报告回填）
  };

  const saveHudActs = (acts) => {
    try {
      mkdirSync(dirname(hudActsPath), { recursive: true });
      writeFileSync(hudActsPath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), acts: acts.slice(0, HUD_ACTS_CAP) }, null, 2));
    } catch (e) {
      log('warn', `hud-acts.json 写入失败（吞）：${msg(e)}`);
    }
  };

  const recordHudAct = (sid, text) => {
    try {
      const at = new Date().toISOString();
      /* 去重：同一会话 + 同文本 + 1 秒内视为同一次压缩的重复上报。
       * 成因（2026-10-07 实测发现 hud-acts.json 出现 1ms 间隔的重复条目）：同一压缩成功回调可能
       * 被两个并存实例各记一次（热换窗口），或引擎事件重放；不加防护会污染历史与悬停列表。 */
      const dup = state.m5.acts.find(
        (a) => a.sid === String(sid ?? '') && a.text === text && Math.abs(new Date(a.at).getTime() - Date.now()) < 1000,
      );
      if (dup) return;
      state.m5.acts.unshift({ sid: String(sid ?? ''), text: String(text ?? ''), at });
      if (state.m5.acts.length > HUD_ACTS_CAP) state.m5.acts.length = HUD_ACTS_CAP;
      saveHudActs(state.m5.acts);
    } catch { /* 吞 */ }
  };

  /** 激活即恢复（原 `state.m5.acts = loadHudActs()?.acts ?? []`）。
   *  构造时调用 ⇒ 「跨重启显示历史」这条承诺不因搬模块而丢。 */
  const loadStoredActs = () => {
    const loaded = loadHudActs();
    state.m5.acts = loaded?.acts ?? [];
    return state.m5.acts;
  };

  /**
   * 聚合响应（原 `onGetHud` 主体）。**读路径**：只写 `state.m5.hudPollReq` 取证，不写盘。
   * @param sid 可选：传会话 id 则返回该会话的压缩记录；空=全局。
   */
  const buildHudResponse = async (sid) => {
    const list = Array.isArray(state.m5.acts) ? state.m5.acts : [];
    /* 会话过滤（2026-10-08 改为**严格按 sid 精确匹配**，用户实测反馈驱动）。
     * 原实现走 C-lineage 血统链（当前 sid + 沿 lineage 回溯的全部历史前身 id），
     * 其前提「DSH 压缩会轮转 session id」已被证伪；实测血统链反而**跨会话误连**：
     *   hud-acts.json lineage = { f4154f01→16616c07, cb8d115e→f4154f01,
     *                             16616c07→f4154f01（回边，成环）, 899bfaca→16616c07 }
     *   ⇒ 从 16616c07 回溯得 { 16616c07, f4154f01 }，命中 4/5 条，
     *     而 f4154f01 属 `keysion-dac-vue` workspace、cb8d115e 属 `zcode-dispatch`
     *     —— 都是**另一个对话**，只因 UI 的 NS.sid 漂移过一次就被连成一条链。
     * 这正是用户看到的「弹窗里显示全 DSH 的压缩记录」。故彻底改回精确匹配。 */
    const filtered = sid ? list.filter((a) => a.sid === sid) : list;
    /* ⚠️ 2026-10-07 真根因修复：agents/sess 必须提到本函数作用域。
     * 原实现在下方 occ IIFE 内部声明 agents，而 criticalCap 在 IIFE 外引用它
     * ⇒ 每次 getHud 抛 ReferenceError("agents is not defined") ⇒ client 永远拿不到数据，
     * 弹窗恒「本会话暂无压缩记录」。此前追的会话 id/血统链理论都在修一条走不到的路径。 */
    const agents = svc('agents')?.list?.() ?? [];
    const sess = svc('sessions')?.list?.() ?? [];
    /* R16.10（用户实测「最近切换/会话切换次数跨会话显示一样」）：
     * ⚠️ 原来 sid 传了但**匹配不到 agent 时回退 agents[0]**——agents[0] 是「第一个会话」，
     * 于是每个会话的 chip 都显示同一个会话的换档统计（跨会话串数据）。真机取证见
     * `state.m5.hudPollReq`：sid=session-70a55b1a… 时 matched=0，却拿到了 agents[0] 的统计。
     * 压缩记录没这问题，因为它直接 `list.filter(a => a.sid === sid)`（不经 agent 查表）。
     * 修：**只认请求的 sid**——匹配不到就给 null（宁缺勿错）；sid 为空（全局查询）也不回退首个
     * agent（那会让「sid 还没解析出来」的刷新帧闪出别的会话的统计）。统计本身走
     * hudPayload(agent, sid) 的 **sid 主键**，与 agent 查找解耦 ⇒ 没有 agent 也答得对。 */
    const targetAgent = sid
      ? (agents.find((x) => String(pick(x?.session?.id, x?.sessionId, x?.id)) === sid) ?? null)
      : null;
    const effOn = (() => { try { mergeConfig(); return M3.effortEnabled === true; } catch { return false; } })();
    /* 占用读数：让弹窗能显示「距智能压缩线还差多少」（client 侧可选消费，缺省不影响）。
     * 取目标会话的实时 measure —— sid 传了就测该会话，否则测最热的那个。 */
    const occ = (() => {
      try {
        const pickTarget = () => {
          if (sid) {
            const a = agents.find((x) => String(pick(x?.session?.id, x?.sessionId, x?.id)) === sid);
            if (a?.session) return a.session;
            return sess.find((s) => String(pick(s?.id, s?.header?.id)) === sid) ?? null;
          }
          return sess[0] ?? agents[0]?.session ?? null;
        };
        const target = pickTarget();
        if (!target) return { ratio: null, window: null };
        const r = measureRatio(target);
        if (!r.ok || r.ratio == null) return { ratio: null, window: null };
        return { ratio: r.ratio, window: r.window ?? null };
      } catch { return { ratio: null, window: null }; }
    })();
    const effApi = getEffortApi();
    const resp = {
      ok: true,
      ...state.m5.hud,
      hudLastAct: filtered[0]?.text || '',
      /* 本会话压缩记录明细（严格按 sid 过滤，新→旧，cap 8）：client 用 at 渲染
       * 完整日期时间「YYYY-MM-DD HH:MM:SS · 原因 · 省 xK」。
       * 2026-10-08：裸字符串 `acts` 被本字段取代；全局兜底 `actsGlobal` /
       * `hudLastActGlobal` 一并退役——它正是「弹窗混进别会话记录」的来源。 */
      actsDetail: filtered.slice(0, 8).map((a) => ({ at: a.at, text: a.text })),
      sessionMatched: filtered.length,
      occupancyRatio: occ.ratio,
      occupancyWindow: occ.window,
      criticalCap: criticalCapOf(targetAgent),
      /* 智能思考（effort）：供输入框 chip 显示「智能思考档位 <当前档>」+ 换档冷却。
       * ⚠️ R3-S9：**开关状态与数据分离**。原先 client 靠 `effort.ok` 推断「功能是否开启」，
       * 但 `effort.ok=false` 既可能是「开关关闭」也可能只是「读档失败」，两者语义不同。
       * 现显式返回 effortEnabled 布尔 + effort 数据（开关关闭时为 null）。
       * 冷却返回**绝对时间戳** cooldownUntil（而非剩余毫秒）：client 可本地倒计时，
       * 且 getHud 是低频调用（挂载 + 投影变化各一次），绝对值不会因调用间隔而过时。 */
      effortEnabled: effOn,
      effort: effOn && effApi ? await effApi.hudPayload(targetAgent, sid) : null,
      at: new Date().toISOString(),
    };
    /* getHud 取证（2026-10-07）：记录不显示时从报告直接看「client 传了什么 sid、host 回了什么」——
     * 这是本轮定位「按 id 过滤恒空」的关键手段，保留为常驻取证字段（只存摘要，不落全量）。 */
    try {
      state.m5.hudPollReq = {
        at: resp.at,
        sid: sid ? String(sid).slice(0, 24) : null,
        sessionMatched: filtered.length,
        actsCount: list.length,
        hudLastAct: resp.hudLastAct || null,
      };
    } catch { /* 吞 */ }
    return resp;
  };

  /**
   * 启动回填：报告最近压缩记录重发布到面板（弹窗不再空态）。
   * 2026-10-06 强化：激活时同步立即试一次（消「激活→回填」空窗，期间 getHud 会返回空串）。
   * 调用方（宿主）负责 1.2s/4s/10s 重试（幂等；报告读失败/竞态可自愈）。
   * @returns {{ ok:boolean, tried?:number, merged?:number }}
   */
  let bfTries = 0;
  const republishFromReport = () => {
    bfTries += 1;
    try {
      /* 主源 = hud-acts.json（激活时已加载进 state.m5.acts，跨重启存续）。
       * 报告降级为迁移/兜底源：合并去重（at+sid）导入，**不再覆盖式写 acts**
       * ——顺带修掉 C2 记录的「激活后 1.2-10s 内回填覆盖运行期记录」竞态。 */
      const prev = getReportBase(); // C3：直接读盘（回填最多 4 发；不占用 writeReport 的缓存/对账状态）
      const acts = (prev?.history ?? []).filter((e) => e?.reason === 'm3-act' && e?.m3?.lastAct);
      if (acts.length) {
        // 会话历史迁移（新→旧，最多 8 条）；B1：formatAct 复用（含记录时刻）
        const fromReport = acts.slice(-8).reverse().map((e) => {
          const a = e.m3.lastAct;
          return { sid: String(a.sessionId ?? ''), text: formatAct(a.reason, a.shadowedTokens, a.at), at: a.at };
        });
        const have = new Set(state.m5.acts.map((a) => `${a.at}|${a.sid}`));
        const merged = [...state.m5.acts];
        for (const a of fromReport) if (!have.has(`${a.at}|${a.sid}`)) merged.push(a);
        merged.sort((x, y) => (x.at < y.at ? 1 : -1)); // 新→旧
        if (merged.length > state.m5.acts.length) {
          state.m5.acts = merged.slice(0, HUD_ACTS_CAP);
          saveHudActs(state.m5.acts);
        }
      }
      const newest = state.m5.acts[0];
      if (newest) {
        publishHud({ hudLastAct: newest.text }); // 内存写入，无 HMR 问题；跨激活显示靠这里回填
        log('info', `M5 HUD 启动回填：${newest.at}（历史 ${state.m5.acts.length} 条，持久化 hud-acts.json）`);
      }
      return { ok: true, tried: bfTries, merged: state.m5.acts.length };
    } catch (e) {
      /* C1②（审查）：同步 + 3 次重试（共 4 发）全失败即终态留痕，不再永久静默 */
      if (bfTries >= 4) log('warn', `M5 HUD 回填 ${bfTries} 次尝试均失败（终态放弃）：${msg(e)}`);
      return { ok: false, tried: bfTries, error: msg(e) };
    }
  };

  /* 构造即装载（等价于原「激活即从 hud-acts.json 恢复历史」）。 */
  loadStoredActs();

  return { hudReasonLabel, formatAct, publishHud, recordHudAct, loadStoredActs, buildHudResponse, republishFromReport, HUD_ACTS_CAP, hudActsPath };
}
