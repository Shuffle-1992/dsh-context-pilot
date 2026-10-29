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
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function createM5Hud(deps) {
  const {
    state, log, msg, schedule, pluginDir,
    /* 跨域注入（见文件头「跨域聚合视图」） */
    svc, pick, measureRatio, criticalCapOf, mergeConfig, M3, getEffortApi, getReportBase,
  } = deps;

  /* R92（用户 2026-10-29 要求）：压缩记录改为**按会话分文件**存 `.data/acts/<sid>.json`，
   * 每会话上限 **100 条**。动机：
   * - 原先所有会话共用 `hud-acts.json` + **全局 cap 50** ⇒ 活跃会话的历史会被别的会话挤掉；
   * - 多会话写同一文件虽是原子写（不会半截），但语义上仍是共享可变状态（热换/重放时更容易互相覆盖）。
   * 兼容：旧共享文件在首次加载时**一次性迁移**到 per-sid 文件，随后改名为 `.migrated` 留档（不删）。 */
  const hudActsDir = join(pluginDir, '.data', 'acts');
  const hudActsPath = join(pluginDir, '.data', 'hud-acts.json');   // 旧共享文件：仅迁移用 + 兼容导出
  const HUD_ACTS_CAP = 100;     // R92：**每会话**上限（原为全局 50）
  const HUD_SID_MEM_CAP = 64;   // 内存里最多缓存多少个会话的记录（磁盘不受此限）

  /** sid → 安全文件名（只留 [A-Za-z0-9._-]；空/异常 ⇒ `_unknown`）。 */
  const sidSafe = (sid) => {
    const s = String(sid ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    return s || '_unknown';
  };
  const actsFileOf = (sid) => join(hudActsDir, sidSafe(sid) + '.json');
  /** 内存缓存：sid → acts[]（新→旧）。按插入顺序淘汰最旧（Map 保序）。 */
  const actsBySid = new Map();
  const rememberActs = (sid, acts) => {
    const k = sidSafe(sid);
    actsBySid.set(k, acts);
    while (actsBySid.size > HUD_SID_MEM_CAP) {
      const k0 = actsBySid.keys().next().value;
      if (k0 === k) break;
      actsBySid.delete(k0);
    }
  };

  /* R7：`'marker'` 分支随 marker 通道退役删除；并把 `context-overflow`（=**模型主动请求**）单列——
   * 原先它落进 `String(reason)` 默认分支，弹窗会直接显示内部枚举名。 */
  const hudReasonLabel = (reason) =>
    reason === 'context-overflow' ? '智能压缩'
      : reason === 'safety-net' ? '兜底'
        : reason === 'pressure' ? '强制压缩'
          /* R16.13：非插件发起的压缩（引擎自动 / `/compact` 命令）——来源必须与插件自己的
           * 「强制压缩 / 智能压缩」区分开，否则用户会以为插件压了却没记录。 */
          : reason === 'engine-auto' ? '引擎自动压缩'
            : reason === 'engine-manual' ? '手动压缩（/compact）'
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

  /* ═══════════ 压缩历史持久化（per-session：`.data/acts/<sid>.json`，每会话 cap 100） ═══════════ */
  const validAct = (a) => a && typeof a.sid === 'string' && typeof a.text === 'string' && typeof a.at === 'string';
  /** 读单个文件（返回 acts[] 或 null）。旧文件的 `lineage` 键读入即忽略（2026-10-08 血统链退役）。 */
  const loadActsFile = (p) => {
    try {
      const raw = readFileSync(p, 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, '')); // 剥 BOM（外部工具写入可能带，JSON.parse 不容忍）
      if (j && Array.isArray(j.acts)) return j.acts.filter(validAct).slice(0, HUD_ACTS_CAP);
    } catch (e) {
      if (e?.code !== 'ENOENT') log('warn', `压缩记录读取失败（忽略）：${p} · ${msg(e)}`);
    }
    return null;
  };
  /** 某会话的记录（内存优先；未命中则读盘并缓存）。空 sid ⇒ 空数组（不返回全局）。 */
  const loadActsFor = (sid) => {
    if (!sid) return [];
    const k = sidSafe(sid);
    if (actsBySid.has(k)) return actsBySid.get(k);
    const loaded = loadActsFile(actsFileOf(sid)) ?? [];
    rememberActs(k, loaded);
    return loaded;
  };

  /* R53（自审发现 #2，2026-10-17）：**原子落盘**（同目录 tmp + rename）。
   * 直写会在写入中途留下**半截 JSON** ⇒ 并发读者（面板/工具/下次启动的 load）读到
   * `Unterminated string in JSON`，记录整份丢失。语义：读者只见旧完整或新完整内容。
   * ⚠️ 各域各留一份：本项目禁止域间 import（依赖由宿主注入）⇒ 复制 8 行比引入耦合安全。 */
  const writeJsonAtomic = (p, obj) => {
    const body = JSON.stringify(obj, null, 2);
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, p);   // 同目录 rename：要么旧文件、要么新文件，永无半截
      return true;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* 吞 */ }
      writeFileSync(p, body);   // Windows 目标被占用 ⇒ rename EBUSY ⇒ 退化直写（宁可非原子，也别丢这次）
      /* R74（审查 C7）：**非原子**路径必须留痕——半截 JSON 的风险在这里回来了，且发生了也无从取证。 */
      try { log('warn', `原子写降级为直写（rename 失败：${String(e?.message ?? e)}）：${p}`); } catch { /* 吞 */ }
      return true;
    }
  };

  const saveActsFor = (sid, acts) => {
    try {
      mkdirSync(hudActsDir, { recursive: true });
      writeJsonAtomic(actsFileOf(sid), {
        version: 2,
        savedAt: new Date().toISOString(),
        sid: String(sid ?? ''),
        acts: acts.filter(validAct).slice(0, HUD_ACTS_CAP),
      });
    } catch (e) {
      log('warn', `压缩记录写入失败（吞）：${sidSafe(sid)} · ${msg(e)}`);
    }
  };

  const recordHudAct = (sid, text) => {
    try {
      const at = new Date().toISOString();
      const key = String(sid ?? '');
      if (!key) return;   // R92：没有会话 id 不落盘（宁缺勿错；旧全局池已退役）
      const list = loadActsFor(key);
      /* 去重：同一会话 + 同文本 + 1 秒内视为同一次压缩的重复上报。
       * 成因（2026-10-07 实测发现 1ms 间隔的重复条目）：同一压缩成功回调可能被两个并存实例各记一次
       * （热换窗口）或引擎事件重放；不加防护会污染历史与悬停列表。 */
      const dup = list.find((a) => a.text === text && Math.abs(new Date(a.at).getTime() - Date.now()) < 1000);
      if (dup) return;
      list.unshift({ sid: key, text: String(text ?? ''), at });
      if (list.length > HUD_ACTS_CAP) list.length = HUD_ACTS_CAP;
      rememberActs(key, list);
      saveActsFor(key, list);
    } catch { /* 吞 */ }
  };

  /** 激活即恢复 + **一次性迁移**旧共享文件（R92）。
   *  构造时调用 ⇒ 「跨重启显示历史」这条承诺不因搬模块而丢；
   *  旧 `hud-acts.json` 里各会话的条目被拆到各自文件，旧文件改名 `.migrated` 留档（不删，便于回滚核对）。 */
  const loadStoredActs = () => {
    try {
      /* ① 迁移旧共享文件（只做一次：迁移后改名为 .migrated） */
      const legacy = loadActsFile(hudActsPath);
      if (legacy) {
        const bySid = new Map();
        for (const a of legacy) {
          const k = String(a.sid ?? '');
          if (!k) continue;
          if (!bySid.has(k)) bySid.set(k, loadActsFile(actsFileOf(k)) ?? []);
          bySid.get(k).push(a);
        }
        for (const [k, arr] of bySid) {
          const seen = new Set();
          const merged = arr
            .filter((a) => (seen.has(`${a.at}`) ? false : (seen.add(`${a.at}`), true)))
            .sort((x, y) => (x.at < y.at ? 1 : -1))
            .slice(0, HUD_ACTS_CAP);
          rememberActs(k, merged);
          saveActsFor(k, merged);
        }
        try { renameSync(hudActsPath, hudActsPath + '.migrated'); } catch { /* 改名失败就留着（下次再试，幂等） */ }
        log('info', `M5：旧共享记录已迁移到 .data/acts/（${bySid.size} 个会话），旧文件改名 .migrated`);
      }
    } catch (e) {
      log('warn', `M5：旧记录迁移失败（吞，不影响新存储）：${msg(e)}`);
    }
    /* ③ R92：预载已有 per-session 文件（按文件修改时间新→旧，最多 HUD_SID_MEM_CAP 个）——
     * 启动回填（republishFromReport）需要有东西可发布；否则弹窗在首次 getHud 前是空态。 */
    try {
      const files = readdirSync(hudActsDir).filter((f) => f.endsWith('.json'));
      const rows = files.map((f) => {
        const p = join(hudActsDir, f);
        try { return { p, m: statSync(p).mtimeMs }; } catch { return { p, m: 0 }; }
      }).sort((x, y) => y.m - x.m).slice(0, HUD_SID_MEM_CAP);
      for (const r of rows) {
        const acts = loadActsFile(r.p);
        if (!acts || !acts.length) continue;
        const sid = acts[0]?.sid;
        if (sid) rememberActs(sid, acts);
      }
    } catch { /* 目录不存在/读失败 ⇒ 忽略（懒加载仍可用） */ }
    return actsBySid.size;
  };

  /**
   * 聚合响应（原 `onGetHud` 主体）。**读路径**：只写 `state.m5.hudPollReq` 取证，不写盘。
   * @param sid 可选：传会话 id 则返回该会话的压缩记录；空=全局。
   */
  const buildHudResponse = async (sid) => {
    /* R92：**只读该会话自己的文件**（空 sid ⇒ 空列表，不返回全局；宁缺勿错）。 */
    const list = sid ? loadActsFor(sid) : [];
    /* 会话过滤（2026-10-08 改为**严格按 sid 精确匹配**，用户实测反馈驱动）。
     * 原实现走 C-lineage 血统链（当前 sid + 沿 lineage 回溯的全部历史前身 id），
     * 其前提「DSH 压缩会轮转 session id」已被证伪；实测血统链反而**跨会话误连**：
     *   hud-acts.json lineage = { f4154f01→16616c07, cb8d115e→f4154f01,
     *                             16616c07→f4154f01（回边，成环）, 899bfaca→16616c07 }
     *   ⇒ 从 16616c07 回溯得 { 16616c07, f4154f01 }，命中 4/5 条，
     *     而 f4154f01 属 `keysion-dac-vue` workspace、cb8d115e 属 `zcode-dispatch`
     *     —— 都是**另一个对话**，只因 UI 的 NS.sid 漂移过一次就被连成一条链。
     * 这正是用户看到的「弹窗里显示全 DSH 的压缩记录」。故彻底改回精确匹配。
     * R16.11（2026-10-10 用户复现「新会话只压了一次却显示很多条」）：**空 sid 也不再返回全量**——
     * 原 `sid ? filter : list` 里 `list` 是**全局**：只要 client 那一刻没解析出 sid（新窗口首帧、
     * 或 sid 被抢成别的会话），面板就会列出所有会话的记录。UI 里这份列表**永远是会话内的**，
     * 全局视图没有消费者 ⇒ 空 sid 视为「无会话上下文」：不返回任何记录（宁缺勿错），
     * 全量只在 `actsTotal` 里留一个计数供取证。 */
    const filtered = sid ? list.filter((a) => a.sid === sid) : [];
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
      /* R16.11：全量计数（取证用，UI 不消费）——空 sid 时不返回任何记录，
       * 但保留总数便于判断「是不是没解析出 sid」。 */
      actsTotal: list.length,
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
      /* ═══ R55（2026-10-19 用户要求：「决策卡/提示词/用量行暴露到面板，方便设置」）═══
       * `injected` = 本轮实际注入的**逐段原文**（M2 落档，只留最近一轮）⇒ 面板可逐字核对。
       * `config` = **生效配置快照**（先 mergeConfig() 再取 M3，与决策点同源）⇒ 面板上
       * 「我在设置里改的值到底生效没」一眼可查；`tplFallback` 让"模板写坏了被回退"可见
       * （静默降级是大忌）；`engineCapProbe` 让"5pp 余量扣在哪、按哪条 modelPolicies 钳的"可见。 */
      injected: state.m2?.lastInjection ?? null,
      config: (() => {
        try {
          mergeConfig();
          return {
            enabled: M3.enabled, effortEnabled: M3.effortEnabled,
            criticalRatio: M3.criticalRatio, markerMinRatio: M3.markerMinRatio,
            sweepMinIntervalMs: M3.sweepMinIntervalMs, effortCooldownMs: M3.effortCooldownMs,
            engineCapMargin: M3.engineCapMargin,
            retainRatioLight: M3.retainRatioLight, retainRatioStandard: M3.retainRatioStandard, retainRatioHeavy: M3.retainRatioHeavy,
            tplBrief: M3.tplBrief, tplCard: M3.tplCard, tplEffBrief: M3.tplEffBrief,
            /* R62（用户实测「查看内置按钮点击显示空的」）：面板「查看内置文案」不该等首轮注入 ⇒
             * 这里给一份**随时可读**的内置原文：brief/card 来自 compact-tool 落档（ensure 期已按
             * 当前配置预渲染），effBrief 来自 m2 最近一次注入（effort 域产出，本域拿不到原文）。 */
            builtins: { ...(state.m3?.lastBuiltin ?? {}), effBrief: state.m2?.lastEffBriefBuiltin ?? null },
            tplFallback: state.m3?.tplFallback ?? null, tplFallbacks: state.m3?.tplFallbacks ?? 0,
            engineCapProbe: state.m3?.engineCapProbe ?? null,
          };
        } catch { return null; }
      })(),
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
        /* R92：按 sid 分组合并进各自文件（去重键 = at；新→旧；每会话 cap 100）。 */
        const bySid = new Map();
        for (const a of fromReport) {
          const k = String(a.sid ?? '');
          if (!k) continue;
          if (!bySid.has(k)) bySid.set(k, loadActsFor(k));
          bySid.get(k).push(a);
        }
        let mergedCount = 0;
        for (const [k, arr] of bySid) {
          const seen = new Set();
          const merged = arr
            .filter((a) => (seen.has(a.at) ? false : (seen.add(a.at), true)))
            .sort((x, y) => (x.at < y.at ? 1 : -1))
            .slice(0, HUD_ACTS_CAP);
          if (merged.length > (loadActsFor(k)?.length ?? 0) - bySid.get(k).length + bySid.get(k).length) { /* 恒真，保持结构 */ }
          rememberActs(k, merged);
          saveActsFor(k, merged);
          mergedCount += merged.length;
        }
        if (mergedCount) log('info', `M5 HUD 启动回填：报告补 ${fromReport.length} 条 → ${bySid.size} 个会话文件`);
      }
      const newest = (() => {
        let best = null;
        for (const arr of actsBySid.values()) if (arr[0] && (!best || arr[0].at > best.at)) best = arr[0];
        return best;
      })();
      if (newest) {
        publishHud({ hudLastAct: newest.text }); // 内存写入，无 HMR 问题；跨激活显示靠这里回填
        log('info', `M5 HUD 启动回填：${newest.at}（内存 ${actsBySid.size} 个会话，持久化 .data/acts/）`);
      }
      return { ok: true, tried: bfTries, merged: actsBySid.size };
    } catch (e) {
      /* C1②（审查）：同步 + 3 次重试（共 4 发）全失败即终态留痕，不再永久静默 */
      if (bfTries >= 4) log('warn', `M5 HUD 回填 ${bfTries} 次尝试均失败（终态放弃）：${msg(e)}`);
      return { ok: false, tried: bfTries, error: msg(e) };
    }
  };

  /* 构造即装载（等价于原「激活即从 hud-acts.json 恢复历史」）。 */
  loadStoredActs();

  return { hudReasonLabel, formatAct, publishHud, recordHudAct, loadStoredActs, buildHudResponse, republishFromReport, HUD_ACTS_CAP, hudActsPath, hudActsDir, actsFileOf, loadActsFor };
}
