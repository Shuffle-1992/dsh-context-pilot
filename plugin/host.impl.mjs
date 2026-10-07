/**
 * @local/dsh-context-pilot —— M1+M2 实现：用量读取验证 + 每轮注入。
 *
 * M1（已验证 2026-10-06）：sessions/agents 双句柄枚举 + tokenMeter.measure() 实测 + 事件监听 + 报告落盘。
 *  - 实测：Agent.session 持有 Session；measure(agent.session) 可用；投影 contextPressure 自带 contextWindow。
 *  - 实测：顶层 ctx 上 compaction absent（作用域隔离，M3 需解决）。
 * M2（已验证 2026-10-06 00:13）：镜像官方 dsh-time-context 惯用法——agent/pre-step waterfall 里往本步消息
 *  追加一条带 source.sections 的快照 user message，每轮 step 1 注入上下文用量三元组
 *  （window / used+pct / surface / system-message-tools 拆分）。
 * M3.5（2026-10-06）：决策主体 = 模型语义判断，插件负责读数/选项/执行。
 *  通道1 pre-step 轮内先压（next() 之前）：critical≥85% → compactIfNeeded("pressure")（官方同款）。
 *  通道2 政策卡：占用≥30% 时注入行追加政策文，教会模型场景1/2 与标记约定。
 *  通道3 idle 扫除双模式：safety-net 仅 critical 占用兜底（受 10min 冷却）；
 *        M3.6 marker 模式——模型回复尾行写 [cp:compact]（政策卡教会它），session/event 解析到即武装，
 *        idle 后立即 compactNow（≥20% 即执行，不受冷却）——用户零输入的"模型建议+自动执行"闭环。
 *  （关键词「先压缩」用户输入通道已裁撤：要手动触发不如直接用压缩指令。）
 *  官方依据：dsh-compaction-basic lib/index.js —— pressure 走引擎阈值（默认80%）的 pre-step 自动压缩；
 *  overflow 绕阈值（retain=0 → compactRegion，owner:"current-turn"）；compactNow 需 idle；
 *  session/event assistant/message 事件通道官方亦在用。
 *
 * 官方包导入（继承 zcode-dispatch ZB-01 结论）：第三方目录裸 import '@deepseek-ai/*' 必失败，
 * 走「bare → env → resourcesPath → 硬编码 asar 路径」×「import / require」候选链，全失败禁注入不报错。
 *
 * 纪律（README §7.5）：任何异常逐支吞掉只记录，绝不向上抛。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// B4（审查批次3）：wire 改为动态 import（见 M5 face 注册块）——静态相对导入解析回无参规范 URL
// 命中进程缓存（P16），face 逻辑被冻结在重启版本；动态加载后 wire 随 impl 同批热换。

const TAG = '[dsh-context-pilot]';
const HISTORY_CAP = 120; // 报告 history 上限（防长期运行膨胀）
const HEARTBEAT_MS = 120_000; // 心跳周期：跟踪会话出现与用量增长（回调内注册，见 apply 尾部注释）
const SESSION_CAP = 50; // 单次快照最多测量的 Session 数
const SOURCE_KIND = 'context-pilot'; // 注入消息的 source.kind（投影/归属标记）
const DSH_LLM_REL = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'];

/**
 * M3.5/M3.6 三通道默认参数（M4 起可被 bundle config 覆盖，apply 内合并）。设计原则（2026-10-06 用户澄清）：
 * 决策发生在任务摄入时，决策主体是「模型语义判断」——插件只提供
 * 读数（注入）、选项（政策卡）、执行（轮内先压/兜底）。场景映射：
 *  - 场景1 任务与远端关联小 / 场景2 重任务需腾退 → 政策卡教模型写标记 → idle 后自动压缩（用户零输入）
 *  - 场景3+ 中途/空闲越线 → criticalRatio 无条件兜底（pre-step pressure 路径 + idle compactNow）
 *
 * ⚠️ 默认值取舍 = 计费口径的函数（2026-10-06 官方文档 + 本机实测校准，模型详见 README §6「成本模型」）：
 *  - DeepSeek API：命中 $0.003/M vs 未命中 $0.15/M（1:50）。285K 上下文里「重读上下文」只占单请求成本 **45%**
 *    ⇒ 上下文规模化便宜，默认偏保守（少压、保信息，避免压缩导致返工）——markerMinRatio 0.30 偏高：
 *      3 倍价格差才能换回一次多余压缩的代价。
 *  - GLM Coding Plan：Cached 1.7 vs Input 6.9（1:4.1，**命中仍计费**）。同样 285K 下上下文占 **91%**
 *    ⇒ 上下文是持续失血，压早直接换额度——建议 markerMinRatio 0.15–0.20。
 *  - 阈值→成本弹性（实测增速 6.8K/段、压后回落 25K）：0.15→0.30 平均上下文 88K→163K，
 *    单请求成本 DS 仅 +18% 而 GLM +69%。**同一组阈值在 GLM 上的钱效约为 DeepSeek 的 3.8 倍**。
 *  ⚠️ 2026-10-07：决策卡门槛已并入 markerMinRatio（用户决定，消除「卡未教/标记不可达」死区），
 *    故下面注释只提单一门槛。面板备注（client.js FIELDS[].hint）与 schema description 须同步。
 */
const M3_DEFAULTS = {
  enabled: true,
  dryRun: false,
  criticalRatio: 0.85, // 强制压缩线：pre-step/idle 无条件压（官方 pressure 路径）；GLM 等 1:4 档可降 0.80
  markerMinRatio: 0.2, // 智能压缩线：模型标记生效门槛，**同时是决策卡注入门槛**（2026-10-07 起二者统一）
  armedTtlMs: 120_000, // 标记有效期（事件→idle 之间）
  marker: '[cp:compact]', // M3.6：模型回复尾部标记 → idle 后自动压缩（用户零输入，标记在回复里可见）
  // policyCardMinRatio / highRatio / lightTaskChars 已于 2026-10-07 退役（用户决定）：
  //   - 决策卡门槛 = markerMinRatio（消除「卡未教/标记不可达」死区）
  //   - highRatio/lightTaskChars 是「高风险+轻任务建议压缩」的旧审计参数，决策主体移交模型后已无触发作用
  sweepMinIntervalMs: 600_000, // 强制压缩冷却：两次兜底压缩的最小间隔（标记模式不受限）
};
// 注：关键词「先压缩」通道已按用户决定裁撤（2026-10-06）——"要写先压缩不如直接手动执行压缩指令"。

const msg = (e) => (e && e.message ? e.message : String(e));
const pick = (...vals) => {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
};
const kfmt = (n) =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.abs(n) >= 10000
      ? `${(n / 1000).toFixed(1)}k`
      : String(Math.round(n))
    : '–';
const nfmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?');

/** measure() 快照 → 紧凑读数（官方承诺 detached / deeply immutable，可安全序列化）。 */
function compactMeasure(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    totalTokens: m.totalTokens ?? null,
    surfaceTokens: m.surfaceTokens ?? null,
    contextPressure: m.contextPressure ?? null,
    projectedTokens: m.projectedTokens ?? null,
    contextBreakdown: m.contextBreakdown ?? null,
    nodeCount: Array.isArray(m.nodes) ? m.nodes.length : undefined,
    keys: Object.keys(m),
  };
}

/**
 * contextBreakdown 投影 → { system, rest } 聚合。
 * 实测形状（2026-10-06 报告取证）：`{ nodes: [...], breakdown: { systemTokens, messageTokens, toolsTokens } }`；
 * 兼容数组 / {entries} / {nodes} 等容器，留 sample 供形状取证。
 */
function summarizeBreakdown(bd) {
  if (!bd || typeof bd !== 'object') return null;
  const nodes = Array.isArray(bd.nodes) ? bd.nodes : null;
  const b = bd.breakdown;
  if (b && typeof b === 'object' && typeof b.systemTokens === 'number') {
    return {
      system: b.systemTokens,
      rest: (b.messageTokens ?? 0) + (b.toolsTokens ?? 0),
      count: nodes ? nodes.length : null,
      sample: nodes ? nodes[0] ?? null : null,
    };
  }
  const entries = Array.isArray(bd) ? bd : Array.isArray(bd.entries) ? bd.entries : nodes;
  if (entries) {
    let system = 0;
    let all = 0;
    for (const e of entries) {
      const t = typeof e?.heuristicTokens === 'number' ? e.heuristicTokens : 0;
      all += t;
      if (e?.system) system += t;
    }
    return { system, rest: all - system, count: entries.length, sample: entries[0] ?? null };
  }
  if (typeof bd.systemTokens === 'number') {
    return { system: bd.systemTokens, rest: (bd.messageTokens ?? 0) + (bd.toolsTokens ?? 0), count: null, sample: null };
  }
  return { unknown: true, keys: Object.keys(bd).slice(0, 20), sample: null };
}

/* ─────────── 官方 createUserMessage 解析（候选链：bare → env → resourcesPath → 硬编码，镜像 zcode-dispatch ZB-01） ─────────── */

function dshLlmCandidates() {
  const out = [];
  const env = process.env.DSH_CONTEXT_PILOT_DSH_LLM;
  if (typeof env === 'string' && env) out.push({ source: 'env', path: env });
  const res = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (res) {
    out.push({ source: 'resourcesPath/app.asar', path: join(res, 'app.asar', ...DSH_LLM_REL) });
    out.push({ source: 'resourcesPath/app.asar.unpacked', path: join(res, 'app.asar.unpacked', ...DSH_LLM_REL) });
  }
  out.push({ source: 'abs:D:/DeepSeek/resources/app.asar', path: join('D:/DeepSeek/resources/app.asar', ...DSH_LLM_REL) });
  out.push({ source: 'abs:D:/DeepSeek/resources/app.asar.unpacked', path: join('D:/DeepSeek/resources/app.asar.unpacked', ...DSH_LLM_REL) });
  return out;
}

async function loadCreateUserMessage() {
  const probe = [];
  const accept = (mod) => (mod && typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null);
  try {
    const fn = accept(await import('@deepseek-ai/dsh-llm'));
    if (fn) return { createUserMessage: fn, via: 'bare|import', probe };
    probe.push({ source: 'bare', ok: false, error: 'no createUserMessage export' });
  } catch (e) {
    probe.push({ source: 'bare', ok: false, error: msg(e) });
  }
  const require = createRequire(import.meta.url);
  for (const cand of dshLlmCandidates()) {
    try {
      const fn = accept(await import(pathToFileURL(cand.path).href));
      if (fn) return { createUserMessage: fn, via: `${cand.source}|import`, probe };
      probe.push({ source: cand.source, ok: false, path: cand.path, error: 'no createUserMessage export' });
    } catch (e) {
      probe.push({ source: cand.source, ok: false, path: cand.path, error: msg(e) });
    }
    try {
      const fn = accept(require(cand.path));
      if (fn) return { createUserMessage: fn, via: `${cand.source}|require`, probe };
      probe.push({ source: cand.source, ok: false, path: cand.path, error: 'no createUserMessage export' });
    } catch (e) {
      probe.push({ source: cand.source, ok: false, path: cand.path, error: msg(e) });
    }
  }
  return { createUserMessage: null, via: null, probe };
}

export function apply(ctx, config, { pluginDir, reportPath }) {
  const log = (level, text) => {
    try {
      const logger = ctx && ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level](`${TAG} ${text}`);
      else console[level === 'info' ? 'log' : level === 'warn' ? 'warn' : 'error'](`${TAG} ${text}`);
    } catch { /* 静默 */ }
  };

  /** 服务访问：ctx.get('name') 为主（本机验证惯用法），ctx[name] 属性访问兜底。 */
  const svc = (key) => {
    try {
      if (ctx && typeof ctx.get === 'function') {
        const v = ctx.get(key);
        if (v) return v;
      }
    } catch { /* fallthrough */ }
    try {
      const v = ctx ? ctx[key] : undefined;
      if (v) return v;
    } catch { /* absent */ }
    return undefined;
  };

  /** 吞异常调用：返回 { value } 或 { error }，永不抛。 */
  const tryOf = (fn) => {
    try { return { value: fn() }; } catch (e) { return { error: msg(e) }; }
  };

  const disposers = [];
  const pending = new Map(); // reason -> timer（防抖合并）
  const markerArmed = new Map(); // sid -> {at}：模型回复尾部标记武装，idle 扫除消费（M3.6）
  /** M3.6 取证：session/event 全量形状探针（类型计数 + 前 N 条样本），落报告定位解析断点。 */
  const eventProbe = { counts: {}, samples: [], cap: 12 };

  /* ---- M4：生效参数 = bundle config 覆盖默认值（字段级类型守卫，异常全落默认）。
   *  ⚠️ volatile 字段经 settings 写入后以 {get()} 活引用到达（zcode unwrapLive 同款），
   *  不剥引用会被类型守卫跳过 → 面板改了值 host 永远用默认。
   *  ⚠️ 面板保存不会自动重跑 apply（2026-10-06 实测：保存 0.1 后 eff 仍 0.3）——
   *  所以 mergeConfig 在每个决策点现调（effEnabled 入口统一调），活引用现读即最新值。 ---- */
  const M3 = { ...M3_DEFAULTS };
  let cfgErrLogged = false; // C1①：config 读取异常只报一次（防刷屏）
  const mergeConfig = () => {
    try {
      const live = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v);
      if (!config || typeof config !== 'object') return;
      const raw = {};
      for (const k of ['enabled', 'dryRun', 'criticalRatio', 'marker', 'markerMinRatio', 'armedTtlMs', 'sweepMinIntervalMs']) {
        raw[k] = live(config[k]);
      }
      if (typeof raw.enabled === 'boolean') M3.enabled = raw.enabled;
      if (typeof raw.dryRun === 'boolean') M3.dryRun = raw.dryRun;
      if (typeof raw.marker === 'string') M3.marker = raw.marker;
      for (const k of ['criticalRatio', 'markerMinRatio']) {
        if (typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k] >= 0 && raw[k] <= 1) M3[k] = raw[k];
      }
      for (const k of ['armedTtlMs', 'sweepMinIntervalMs']) {
        if (typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k] >= 0) M3[k] = raw[k];
      }
    } catch (e) {
      /* C1①（审查）：config 读取异常保持现值——留一句痕（仅一次），防「面板改值不生效」无从排查 */
      if (!cfgErrLogged) {
        cfgErrLogged = true;
        log('warn', `config 读取异常（保持现值，仅报一次）：${msg(e)}`);
      }
    }
  };
  mergeConfig();

  /** 总开关活读：入口统一先 mergeConfig()（面板保存不改跑 apply，决策点现读即最新值）。
   *  关闭语义 = 完全恢复原生 DSH：不注入、不决策、不压缩。 */
  const effEnabled = () => {
    try {
      mergeConfig();
      const v = config?.enabled;
      const x = v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v;
      return x !== false;
    } catch {
      return true;
    }
  };

  /* ---- M5：HUD 状态发布（内存通道 + client 5s 轮询 getHud）----
   *  2026-10-06 实证：host→configEditor.edit 恒被「HMR transactions cannot be nested」拒绝
   *  （面板保存能成是因为 client→remote 不经插件 apply scope）⇒ 旧推送通道结构性不可用。
   *  现改为：压缩/武装事件写 state.m5.hud，client 半经 wire.host.mjs 的 getHud() 每 5s 拉取；
   *  跨重启显示由启动回填（读报告最近一次 m3-act）补齐。 */
  const hudReasonLabel = (reason) => (reason === 'marker' ? '智能压缩' : reason === 'safety-net' ? '兜底' : reason === 'pressure' ? '强制压缩' : String(reason ?? ''));
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
  /** 记录一条压缩历史（新→旧；带 sessionId 供按会话过滤）。
   *  ⚠️ 2026-10-06：改为 **hud-acts.json 持久化**（用户反馈：重启丢历史 + 只显示 1 条）。
   *  根因：历史只存内存（cap 8），重启后回填源 = 报告 120 条环形缓冲，被心跳/状态等高频事件
   *  快速剪掉 m3-act ⇒ 回填无源（实测 15:0x 报告内 m3-act 已 0 条）；且每次 toggle/重启都重置内存。
   *  专文件 cap 50，压缩时同步落盘（压缩低频，写放大可忽略）。 */
  const hudActsPath = join(pluginDir, '.data', 'hud-acts.json');
  const HUD_ACTS_CAP = 50;
  const loadHudActs = () => {
    try {
      const raw = readFileSync(hudActsPath, 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, '')); // 剥 BOM（外部工具写入可能带，JSON.parse 不容忍）
      if (j && Array.isArray(j.acts)) {
        return j.acts
          .filter((a) => a && typeof a.sid === 'string' && typeof a.text === 'string' && typeof a.at === 'string')
          .slice(0, HUD_ACTS_CAP);
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

  /* ---- M5.5 任务挂起-自动恢复（用户定义的完整闭环）----
   *  任务进来 → 模型判断需先压缩 → 本轮不执行、回复写「待执行：<任务>」+ 标记 → idle 自动压缩 →
   *  压缩成功后 sessionController.prompt() 自动投递恢复提示（host 直发用户消息的官方通道，
   *  "Admit one prompt after explicitly resuming its Session"）→ agent 以压缩后上下文拉起，继续执行原任务。
   *  防循环：自动恢复最多 2 次，超限留给用户手动。 */
  const lastUserTextBySid = new Map(); // sid -> 最近一条用户消息文本（恢复兜底）
  const pendingBySid = new Map(); // sid -> { task, at }（B3：resumes 字段写入从未读取，已随审查退役）
  const resumeTimers = new Set(); // A7（审查）：2s 恢复 setTimeout 在册，卸载时统一清（防禁用/热换窗口内旧实例投递）
  const briefedBySid = new Set(); // M2.5：新会话一次性插件说明（每激活一份，重活后重讲一次无妨）
  const resumeCountBySid = new Map(); // sid -> 已自动恢复次数
  const M5_RESUME_MAX = 2;
  /** M5.5 取证：尝试记录（同时排一份报告）。 */
  const m55Attempt = (rec) => {
    try {
      state.m55.attempts.push({ at: new Date().toISOString(), ...rec });
      if (state.m55.attempts.length > 20) state.m55.attempts.splice(0, state.m55.attempts.length - 20);
    } catch { /* 吞 */ }
    schedule('m5.5-resume', 400);
  };
  /** 服务探针：可达性 + 原型方法名（类方法不在自有键上）。全部 tryOf——属性访问本身也可能抛。 */
  const probeService = (key) => {
    const r = tryOf(() => svc(key));
    if (r.error) return { found: false, error: r.error };
    const v = r.value;
    if (!v) return { found: false, error: 'absent' };
    const base = {
      found: true,
      type: typeof v,
      ctor: tryOf(() => (v?.constructor?.name ?? null)).value ?? null,
      ownKeys: tryOf(() => Object.keys(v).slice(0, 24)).value ?? null,
      protoKeys: tryOf(() => Object.getOwnPropertyNames(Object.getPrototypeOf(v) ?? Object.prototype).slice(0, 48)).value ?? null,
      toStringTag: tryOf(() => String(Object.prototype.toString.call(v))).value ?? null,
    };
    const hp = tryOf(() => typeof v?.prompt);
    base.hasPrompt = hp.value === 'function';
    if (hp.error) base.promptAccessError = hp.error;
    return base;
  };
  const maybeResumeAfterMarker = (sid, reason) => {
    try {
      if (reason !== 'marker') return; // 仅显式标记触发恢复（兜底/强制压缩是无人值守场景，无挂起任务）
      /* A6（审查）：上限判定前置——不先删 pending/熄灯，保留「待执行」可见性，徽章改文案请用户手动接管 */
      const done = resumeCountBySid.get(sid) ?? 0;
      if (done >= M5_RESUME_MAX) {
        const pend = pendingBySid.get(sid);
        publishHud({ hudPending: JSON.stringify({ task: `${pend?.task ? String(pend.task).slice(0, 100) + ' ' : ''}(自动恢复已达上限 ${done}/${M5_RESUME_MAX}，请手动继续)` }) });
        m55Attempt({ phase: 'abort', detail: `已达上限 ${done}/${M5_RESUME_MAX}，请用户手动继续`, sid: sid.slice(0, 8) });
        return;
      }
      const pending = pendingBySid.get(sid);
      pendingBySid.delete(sid);
      publishHud({ hudPending: '' });
      if (!pending) {
        m55Attempt({ phase: 'abort', detail: '无挂起任务（pending 缺失）', sid: sid.slice(0, 8) });
        return;
      }
      const resumeText = `（context-pilot 自动恢复）上下文压缩已完成。请继续执行压缩前收到的任务：${pending.task}\n这是压缩后自动拉起的执行轮；除非占用仍然吃紧，不要再写压缩标记，直接执行任务。`;
      const rt = setTimeout(() => {
        resumeTimers.delete(rt);
        try {
          resumeViaAnyChannel(sid, resumeText, done);
        } catch (e) {
          m55Attempt({ phase: 'dispatch-error', error: msg(e) });
          log('warn', `M5.5 恢复调度异常（吞）：${msg(e)}`);
        }
      }, 2000); // 等摘要落定/表面重建后再拉起
      rt.unref?.();
      resumeTimers.add(rt); // A7：在册，卸载时 clearTimeout
      m55Attempt({ phase: 'scheduled', sid: sid.slice(0, 8), taskLen: pending.task.length, resumeInMs: 2000 });
    } catch (e) {
      m55Attempt({ phase: 'schedule-error', error: msg(e) });
    }
  };
  /** 多通道恢复：A sessionController.prompt → B ctx.remote.session 代理 → C 直通入队（官方同原语）。 */
  const resumeViaAnyChannel = (sid, resumeText, doneCount) => {
    const scProbe = probeService('sessionController');
    const remoteProbe = tryOf(() => {
      const r = ctx?.remote?.session;
      return r ? { present: true, hasPrompt: typeof r.prompt === 'function' } : { present: false };
    });
    state.m55.channelProbe = {
      at: new Date().toISOString(),
      sessionController: scProbe,
      ctxRemote: remoteProbe.error ? { error: remoteProbe.error } : remoteProbe.value,
    };
    schedule('m5.5-resume', 100);

    const requestId = `context-pilot-resume-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const request = {
      requestId,
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: resumeText }],
      clientTimeZone: 'Asia/Shanghai',
    };

    /* 通道 C：与官方 prompt() 相同的原语（createUserMessage + agent.followup("next-turn")）直通入队。 */
    const tryDirectAdmission = () => {
      try {
        const factoryReady = typeof createUserMessage === 'function';
        const agent = tryOf(() => svc('agents')?.get?.(sid)).value;
        const agentProbe = agent
          ? {
              status: pick(agent?.status) ?? null,
              hasFollowup: typeof agent.followup === 'function',
              hasSteer: typeof agent.steer === 'function',
            }
          : null;
        if (!factoryReady || !agent || typeof agent.followup !== 'function') {
          m55Attempt({ phase: 'failed', channel: 'direct-followup', detail: `factory=${factoryReady} agent=${!!agent}`, agentProbe });
          log('warn', 'M5.5 恢复：所有通道不可达，任务保留在「待执行」中');
          return;
        }
        const message = createUserMessage({
          content: [{ type: 'text', text: resumeText }],
          source: { kind: 'user', rpcId: requestId, clientTimeZone: 'Asia/Shanghai' },
        });
        agent.followup(message);
        const queued = tryOf(() => agent.inbox?.nextTurn?.some?.((m) => m?.source?.rpcId === requestId)).value;
        resumeCountBySid.set(sid, doneCount + 1);
        m55Attempt({
          phase: 'delivered',
          channel: 'direct-followup',
          agentProbe,
          queued: queued === true ? 'confirmed' : queued === false ? 'not-in-inbox(可能已开跑)' : 'probe-skipped',
        });
        log('info', `M5.5 恢复提示已投递（direct followup，第 ${doneCount + 1} 次）→ agent 以压缩后上下文继续执行原任务`);
      } catch (e) {
        m55Attempt({ phase: 'failed', channel: 'direct-followup', error: msg(e) });
        log('warn', `M5.5 恢复直通失败（吞）：${msg(e)}`);
      }
    };

    /* 通道 A/B：远程面 prompt。Promise.resolve().then 包裹——同步抛错也走 rejection 分支。 */
    const remoteCandidates = [];
    if (scProbe.found && scProbe.hasPrompt) {
      // C1 附注（审查）：官方契约 prompt(request, signal)——缺 signal 时内部 throwIfAborted 必拒（M5.5 首测实证）；30s 超时防挂
      remoteCandidates.push({ name: 'sessionController.prompt', call: () => svc('sessionController').prompt(request, AbortSignal.timeout(30_000)) });
    }
    if (remoteProbe.value?.present && remoteProbe.value?.hasPrompt) {
      remoteCandidates.push({ name: 'ctx.remote.session.prompt', call: () => ctx.remote.session.prompt(request) });
    }
    const tryRemote = (i) => {
      if (i >= remoteCandidates.length) return tryDirectAdmission();
      const c = remoteCandidates[i];
      Promise.resolve()
        .then(c.call)
        .then((result) => {
          if (result && typeof result === 'object' && result.accepted === false) {
            throw new Error(`accepted:false ${tryOf(() => JSON.stringify(result)).value?.slice(0, 200) ?? ''}`);
          }
          resumeCountBySid.set(sid, doneCount + 1);
          m55Attempt({
            phase: 'delivered',
            channel: c.name,
            result: tryOf(() => JSON.stringify(result)).value?.slice(0, 200) ?? null,
          });
          log('info', `M5.5 恢复提示已投递（${c.name}，第 ${doneCount + 1} 次）→ agent 以压缩后上下文继续执行原任务`);
        })
        .catch((e) => {
          m55Attempt({ phase: 'rejected', channel: c.name, error: msg(e) });
          log('warn', `M5.5 恢复投递被拒（${c.name}，吞）：${msg(e)}`);
          tryRemote(i + 1);
        });
    };
    tryRemote(0);
  };

  /* ---- M4.5 诊断：宿主内 Config schema 解析状态（与 entry 静态导出同一模块，独立重解析）。 ---- */
  try {
    const schemaUrl = pathToFileURL(join(pluginDir, 'plugin-config.schema.mjs')).href;
    import(`${schemaUrl}?probe=${Date.now()}`)
      .then((m) => {
        state.m4Probe = {
          at: new Date().toISOString(),
          schemaSource: m.DSH_CONTEXT_PILOT_SCHEMA_SOURCE ?? null,
          configType: m.DSH_CONTEXT_PILOT_CONFIG_SCHEMA ? typeof m.DSH_CONTEXT_PILOT_CONFIG_SCHEMA : 'undefined',
        };
        log('info', `M4 探针：schema=${state.m4Probe.schemaSource} config=${state.m4Probe.configType}`);
        schedule('m4-probe', 300);
      })
      .catch((e) => {
        state.m4Probe = { at: new Date().toISOString(), error: msg(e) };
        log('warn', `M4 探针失败：${msg(e)}`);
        schedule('m4-probe', 300);
      });
  } catch { /* 探针不致命 */ }

  const state = {
    seq: 0,
    implLoadedAt: new Date().toISOString(),
    listeners: {},
    m2: { registered: false, injections: 0, briefings: 0, lastText: null, lastAt: null, via: null, skips: {} },
    m3: {
      // B3：state.m3.dryRun 静态镜像已退役（激活后不再更新、与 m3.eff.dryRun 双轨失真）；真值看快照 eff
      decisions: 0,
      wouldCompact: 0,
      acts: 0,
      actOk: 0,
      lastDecision: null,
      lastAct: null,
      actErrors: {},
      probe: null,
      sweeps: {},
      // M3.5 三通道
      preStepActs: 0,
      preStepOk: 0,
      lastPreStep: null,
      preStepErrors: {},
      markerHits: 0, // B3：keywordHits 恒 0 字段已随审查退役（历史报告条目保持原样，不受影响）
      policyCards: 0,
    },
    // M5 HUD 发布取证（entry 查找/edit 结果全程留痕——弹窗侧空态无法区分静默失败）
    // hud.gen = 实例指纹：客户端取到的 gen 应与本实例一致；不一致 = RPC 打到了旧激活的僵尸面
    // acts = 最近压缩记录（按会话可过滤，新→旧，cap 8）：主行显示最新，悬停展开列表
    m5: { lastPublish: null, hud: { hudLastAct: '', hudArmed: '', hudPending: '', gen: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }, hudFace: 'absent', acts: [] },
    // M5.5 恢复通道取证（每次尝试逐相位落报告，杜绝 log-only 黑洞）
    m55: { armed: null, attempts: [], channelProbe: null },
  };
  /* 激活即从 hud-acts.json 恢复压缩历史（跨重启/跨 toggle 存续）；
   * 报告回填降级为迁移/兜底源（bfOnce 内合并去重，不再覆盖式写 acts）。 */
  state.m5.acts = loadHudActs() ?? [];

  /** 解析某 agent 作用域的 compaction 服务实例（顶层 ctx 实测 absent，必须走 agent 上下文）。 */
  const resolveCompactionFor = (agent) => {
    const viaCtx = tryOf(() => agent?.ctx?.get?.('compaction') ?? agent?.ctx?.compaction);
    if (viaCtx.value && typeof viaCtx.value.compactNow === 'function') {
      return { service: viaCtx.value, via: 'agent.ctx', probe: { ctxType: typeof viaCtx.value } };
    }
    const viaPresets = tryOf(() => svc('agentPresets')?.serviceFor?.(agent, 'compaction'));
    if (viaPresets.value && typeof viaPresets.value.compactNow === 'function') {
      return { service: viaPresets.value, via: 'agentPresets.serviceFor', probe: { presetsType: typeof viaPresets.value } };
    }
    return {
      service: null,
      via: 'unresolved',
      probe: { ctxError: viaCtx.error ?? null, ctxType: viaCtx.value ? typeof viaCtx.value : null, presetsError: viaPresets.error ?? null },
    };
  };

  /** 提取一条消息的可见文本（复杂度启发 + 关键词检测共用）。 */
  const messageText = (message) => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const b of content) {
      if (typeof b === 'string') out += b;
      else if (b?.type === 'text' && typeof b.text === 'string') out += b.text;
    }
    return out;
  };
  const messageTextLength = (message) => messageText(message).length;

  /** assistant/message 事件文本提取——镜像官方 deriveEventMessage（dsh-session lib/index.js:214）：
   * user/message 的 data 即消息本体；assistant/message、tool/result 在 data.message。 */
  const extractEventText = (event) => {
    if (!event) return '';
    const m = event.type === 'user/message' ? event.data : event.data?.message;
    return messageText(m);
  };

  /* B2（审查）：measure+pressure 读取收敛——decideCompaction / renderUsageText / preStepCompaction 三处共用 */
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
    return { ok: true, used, surface, window, ratio };
  };

  /** M3 决策：仅剩强制压缩线（决策主体是模型标记，此函数供 pre-step/idle 兜底与审计）。 */
  const decideCompaction = (agent) => {
    const mr = measureRatio(agent?.session);
    if (!mr.ok) return { ok: false, error: mr.error };
    const { used, window, ratio } = mr;
    if (ratio == null) return { ok: false, error: 'no window/ratio' };

    // 2026-10-07：highRatio/lightTaskChars 审计分支已删除（决策主体移交模型后无触发作用）
    if (ratio >= M3.criticalRatio) {
      return { ok: true, compact: true, reason: `critical-usage(${(ratio * 100).toFixed(1)}%)`, ratio, used, window };
    }
    return { ok: true, compact: false, reason: 'no', ratio, used, window };
  };

  /* ---- 报告落盘（追加式 history，重启取证入口） ----
   * C3（审查）：基线 apply 期读一次缓存、后续内存追加——原实现每次写入全量 readFileSync（实测 1.2MB×每次，
   * 触发点含 400-500ms 防抖高频 reason）。C1③：读失败/形状异常不再静默「首写覆盖」，留一句痕。
   * ⚠️ 2026-10-06 14:4x 实测补丁：缓存基线在**多写入者共存**时会互相覆盖（A1 泄漏的僵尸实例每 15s 用
   * 自己的旧基线整段写回 ⇒ 抹掉新实例条目）。现每次写入先「按本实例已写入的条数做尾部对账」：
   * 磁盘 history 尾部若与本实例最后一次写入不一致（=有他人追加），则以磁盘为准重新接续——正确性优先，
   * 仍避免全量解析（只在检测到他人写入时重读）。 */
  let reportBase = null; // 缓存的报告数据（history 随写随追加，卸载即弃）
  let reportBaseLoaded = false;
  let lastWrittenAt = null; // 本实例最后一次写入条目的 at（尾部对账锚点）
  const loadReportBase = () => {
    try {
      const prev = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (prev && Array.isArray(prev.history)) return { ...prev };
      log('warn', '报告基线形状异常（无 history 数组）→ 将按首写覆盖（C1③ 留痕）');
    } catch (e) {
      if (e?.code !== 'ENOENT') log('warn', `报告基线读取失败（按首写覆盖，原内容不保留）：${msg(e)}`); // ENOENT=首写属正常
    }
    return null;
  };
  const writeReport = (entry) => {
    try {
      let data;
      if (!reportBaseLoaded) {
        reportBaseLoaded = true;
        data = loadReportBase();
      } else {
        /* 尾部对账：磁盘最后一条不是本实例刚写的那条 ⇒ 有他人写入 ⇒ 以磁盘为准重新接续（防互相覆盖） */
        let diskTailAt = null;
        try {
          const onDisk = JSON.parse(readFileSync(reportPath, 'utf8'));
          const dHist = Array.isArray(onDisk?.history) ? onDisk.history : [];
          diskTailAt = dHist.length ? dHist[dHist.length - 1]?.at ?? null : null;
          if (diskTailAt !== lastWrittenAt) {
            data = onDisk;
            log('info', `报告尾部对账：检测到他方写入（磁盘尾 ${diskTailAt} ≠ 本实例 ${lastWrittenAt}）→ 重读接续`);
          }
        } catch { /* 读失败则沿用缓存基线 */ }
        if (!data) data = reportBase;
      }
      data = data ?? {
        plugin: '@local/dsh-context-pilot',
        purpose: 'M1 用量读取验证 + M2 注入报告',
        updated: entry.at,
        history: [],
      };
      reportBase = data;
      data.updated = entry.at;
      data.history = [...(data.history || []), entry].slice(-HISTORY_CAP);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(data, null, 2));
      lastWrittenAt = entry.at;
    } catch (e) {
      log('warn', `报告写入失败：${msg(e)}`);
    }
  };

  /* ---- C3② 报告稳态瘦身（2026-10-07）----
   * 动因（本机实测）：报告文件 **3.77MB**（pretty 后），history 满 120 条、单条均值 **16KB**，
   * 其中 heartbeat 52 条就占 888KB、agent/status 20 条占 330KB。体积主体是 buildSnapshot 的
   * **全量 sessions/agents 枚举**（每会话 keys[40] + measure + pressureProjection + breakdownSummary）。
   *
   * 消费侧调研（决定瘦身安全性）：history 的全量内容**只被一处读取**——启动回填 bfOnce
   * （筛 `reason==='m3-act'` 取 `m3.lastAct`）。其余字段纯为取证，不进任何逻辑分支。
   *
   * 策略：按 reason 分级——
   *  - **SLIM**（高频、信息量低）：只留「读数 + 状态」，丢明细（keys/headerKeys/breakdown/probe 样本/LLM 拓扑）
   *  - **FULL**（其余，含 m3-act/m4-probe/activation 等关键事件）：完整快照，取证不受影响
   * 用 `profile` 字段显式标记，dump 时可直接区分。 */
  const SLIM_REASONS = new Set([
    'heartbeat',     // 每 120s 一次，纯存活性
    'agent/status',  // 状态频繁翻转
    'm5-publish',    // 400ms 防抖高频
    'm2-inject',     // 每轮一次；注入文本已在 snap.m2.lastText 保留
    'm3-decision',   // 每任务一次；决策已在 snap.m3.lastDecision 保留
    'm3.6-marker',   // 标记命中；detail 在 m3.markerHits
    'm5.5-resume',   // 恢复相位；detail 在 m55.attempts
    'session/created',
  ]);
  /** 精简快照：保留读数与状态，丢枚举明细。 */
  const slimSnapshot = (snap) => {
    const num = (v) => (typeof v === 'number' ? v : null);
    // sessions：只留用量最高的 2 条（读数），丢 keys/headerKeys/breakdown 明细
    const topSessions = (snap.sessions || [])
      .filter((r) => typeof r.measure?.totalTokens === 'number')
      .sort((a, b) => b.measure.totalTokens - a.measure.totalTokens)
      .slice(0, 2)
      .map((r) => ({
        id: r.id,
        measure: { totalTokens: num(r.measure?.totalTokens), surfaceTokens: num(r.measure?.surfaceTokens) },
        window: r.pressureProjection?.contextWindow ?? null,
      }));
    const topAgents = (snap.agents || []).slice(0, 2).map((r) => ({ id: r.id, sessionId: r.sessionId, status: r.status }));
    return {
      at: snap.at,
      reason: snap.reason,
      profile: 'slim',
      services: snap.services,
      totals: snap.totals,
      sessions: topSessions,
      agents: topAgents,
      sessionsError: snap.sessionsError,
      agentsError: snap.agentsError,
      m2: snap.m2, // 含 lastText/injections/skips——注入取证要留
      m3: {
        // 只丢体积大且仅取证用的 eventProbe；其余（决策/压缩/错误/eff）全留
        ...snap.m3,
        eventProbe: undefined,
      },
      m5: snap.m5,
      m55: snap.m55,
      // llmProviders / compactionProbe 仅在 FULL 条目保留
    };
  };

  /* ---- 快照：服务在位 + Session/Agent 枚举与测量 + M2 状态 ---- */
  const buildSnapshot = (reason) => {
    const snap = {
      at: new Date().toISOString(),
      reason,
      services: {},
      sessions: [],
      agents: [],
      totals: {},
      m2: { ...state.m2, skips: { ...state.m2.skips } },
      m3: {
        ...state.m3,
        lastDecision: state.m3.lastDecision ? { ...state.m3.lastDecision } : null,
        lastAct: state.m3.lastAct ? { ...state.m3.lastAct } : null,
        lastPreStep: state.m3.lastPreStep ? { ...state.m3.lastPreStep } : null,
        actErrors: { ...state.m3.actErrors },
        preStepErrors: { ...state.m3.preStepErrors },
        sweeps: { ...state.m3.sweeps },
        listeners: { ...state.listeners },
        heartbeat: state.heartbeat ? { ...state.heartbeat } : null, // 心跳取证：via/type（A1 + 实施中发现的新事实）
        eventProbe: { counts: { ...eventProbe.counts }, samples: eventProbe.samples.map((s) => ({ ...s })) },
        eff: { ...M3 }, // M4：生效参数（config 覆盖后的实际值）
        liveEnabled: effEnabled(), // 总开关现值（快照时点）
        m4Probe: state.m4Probe ? { ...state.m4Probe } : null,
      },
      m5: {
        lastPublish: state.m5.lastPublish ? { ...state.m5.lastPublish } : null,
        hud: { ...(state.m5.hud ?? {}) },
        hudFace: state.m5.hudFace ?? 'absent',
      },
      m55: {
        armed: state.m55.armed ? { ...state.m55.armed } : null,
        attempts: state.m55.attempts.slice(-10).map((a) => ({ ...a })),
        channelProbe: state.m55.channelProbe ? { ...state.m55.channelProbe } : null,
      },
    };

    for (const k of ['tokenMeter', 'sessions', 'agents', 'systemPrompt', 'compaction', 'llm', 'sessionProjections', 'sessionQuery', 'configEditor', 'sessionController', 'typertGateway']) {
      const s = svc(k);
      snap.services[k] = s ? typeof s : 'absent';
    }

    const tm = svc('tokenMeter');
    const sp = svc('sessionProjections');
    const canMeasure = !!(tm && typeof tm.measure === 'function');

    /* -- Session 枚举（句柄主路径） -- */
    const sList = tryOf(() => svc('sessions')?.list?.() ?? []);
    if (sList.error) snap.sessionsError = sList.error;
    for (const s of (sList.value ?? []).slice(0, SESSION_CAP)) {
      const row = {
        id: pick(s?.id, s?.header?.id),
        headerKeys: tryOf(() => (s?.header ? Object.keys(s.header) : undefined)).value,
        keys: tryOf(() => Object.keys(s).slice(0, 40)).value,
      };
      if (canMeasure) {
        const m = tryOf(() => tm.measure(s));
        if (m.error) row.measureError = m.error;
        else row.measure = compactMeasure(m.value);
      }
      if (sp && typeof sp.stateOf === 'function') {
        const p = tryOf(() => sp.stateOf(s, 'contextPressure'));
        row.pressureProjection = p.error ? { error: p.error } : p.value ?? null;
        const b = tryOf(() => sp.stateOf(s, 'contextBreakdown'));
        row.breakdownSummary = b.error ? { error: b.error } : summarizeBreakdown(b.value ?? null); // 形状取证（不落全量条目）
      }
      snap.sessions.push(row);
    }
    snap.totals.sessions = (sList.value ?? []).length;

    /* -- Agent 枚举（句柄对照路径） -- */
    const aList = tryOf(() => svc('agents')?.list?.() ?? []);
    if (aList.error) snap.agentsError = aList.error;
    for (const a of (aList.value ?? []).slice(0, SESSION_CAP)) {
      const row = {
        id: pick(a?.id, a?.sessionId),
        sessionId: pick(a?.sessionId, a?.session?.id),
        status: pick(a?.status),
        keys: tryOf(() => Object.keys(a).slice(0, 40)).value,
      };
      if (canMeasure) {
        const target = a?.session ?? a; // 实测 Agent.session 持有 Session
        const m = tryOf(() => tm.measure(target));
        if (m.error) row.measureError = m.error;
        else row.measure = compactMeasure(m.value);
      }
      if (!snap.compactionProbe) {
        const r = resolveCompactionFor(a); // 首个 agent 即取证：作用域压缩实例可达性
        snap.compactionProbe = { via: r.via, probe: r.probe };
      }
      snap.agents.push(row);
    }
    snap.totals.agents = (aList.value ?? []).length;

    /* -- LLM 适配器拓扑 -- */
    const provs = tryOf(() => svc('llm')?.listProviders?.());
    snap.llmProviders = provs.error
      ? { error: provs.error }
      : Array.isArray(provs.value)
        ? provs.value.map((p) =>
            typeof p === 'string' ? p : { id: pick(p?.id, p?.name), keys: Object.keys(p ?? {}).slice(0, 20) },
          )
        : undefined;

    return snap;
  };

  /* ---- 刷新：打一条紧凑摘要 + 落盘 ---- */
  const refresh = (reason) => {
    let snap;
    try {
      snap = buildSnapshot(reason);
    } catch (e) {
      log('warn', `快照构建异常（${reason}）：${msg(e)}`);
      return;
    }
    const s = snap.sessions ?? [];
    const top = s
      .filter((x) => typeof x.measure?.totalTokens === 'number')
      .sort((x, y) => y.measure.totalTokens - x.measure.totalTokens)[0];
    log(
      'info',
      `[${reason}] sessions=${snap.totals.sessions} agents=${snap.totals.agents}` +
        (top ? ` ｜ 最热会话 id=${String(top.id).slice(0, 8)}… total=${kfmt(top.measure.totalTokens)}` : '') +
        ` ｜ m2 注入=${snap.m2?.injections ?? 0}`,
    );
    // C3②：高频 reason 落精简档（体积降一个量级），关键事件保留全量
    writeReport(SLIM_REASONS.has(reason) ? slimSnapshot(snap) : { ...snap, profile: 'full' });
  };

  /** 防抖刷新：同 reason 的多次触发合并为最后一次。 */
  const schedule = (reason, delay = 1000) => {
    try {
      const prev = pending.get(reason);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        pending.delete(reason);
        try { refresh(reason); } catch { /* 吞 */ }
      }, delay);
      t.unref?.();
      pending.set(reason, t);
    } catch { /* 吞 */ }
  };

  log('info', `impl 激活（M1+M2+M3.5 三通道）seq=${++state.seq} @ ${state.implLoadedAt}；报告 → ${reportPath}`);

  /* ═══════════ M2：agent/pre-step 每轮注入用量三元组（镜像 dsh-time-context 惯用法） ═══════════ */

  /** 单会话 measure 失败只告警一次（防日志刷屏）。 */
  const measuredFailedOnce = new Set();

  /** 组装注入文本（纯信息，无行为指令）。 */
  const renderUsageText = (session) => {
    const mr = measureRatio(session); // B2：读取收敛
    if (!mr.ok) return { error: mr.error };
    const { used, surface, window } = mr;

    const breakdown = tryOf(() => svc('sessionProjections')?.stateOf?.(session, 'contextBreakdown'));

    const pct = window && used != null ? `${((used / window) * 100).toFixed(1)}%` : null;

    const seg = [];
    seg.push(`window ${window != null ? nfmt(window) : '?'}`);
    seg.push(`used ${used != null ? nfmt(used) : '?'}${pct ? ` (${pct})` : ''}`);
    seg.push(`surface ${surface != null ? nfmt(surface) : '?'}`);
    const bsum = summarizeBreakdown(breakdown.error ? null : breakdown.value ?? null);
    if (bsum) {
      seg.push(`system ≈${nfmt(bsum.system)} ｜ messages+tools ≈${nfmt(bsum.rest)} (heuristic)`);
    }
    return {
      text: `Context usage before this turn (by context-pilot, estimate): ${seg.join(' ｜ ')}.`,
      used,
      window,
      ratio: window && used != null ? used / window : null,
    };
  };

  /** M3.5 通道2：政策卡——教会模型「何时值得压缩、如何触发」。
   *  ⚠️ 2026-10-07 用户决定：**决策卡门槛 = 标记最低占用**（不再独立配置）。
   *  原设计缺陷（用户发现）：`policyCardMinRatio` 独立时，markerMinRatio < 卡门槛 的区间是死区——
   *  模型收不到卡 ⇒ 不知道标记 ⇒ 永远不写标记 ⇒ 该区间内标记通道完全不可达；
   *  且若 markerMinRatio > 卡门槛则反向错配（教了却不执行）。现统一为同一门槛，
   *  语义：「能收到卡 = 标记有效」，无论用户怎么填都不会出现死区或错配。 */
  const renderPolicyCard = (ratio) => {
    if (ratio == null || ratio < M3.markerMinRatio) return null;
    const pct = `${(ratio * 100).toFixed(0)}%`;
    return [
      `压缩决策卡（context-pilot，当前占用 ${pct}）：先判断接下来的任务是否还依赖本轮之前的对话细节——`,
      `• 不依赖（换了话题/新子任务/上一阶段已收尾），或任务繁重需要预留空间：本轮先不执行任务——回复中先用一行「待执行：<任务简述>」记下用户任务，然后在最后一行单独写 ${M3.marker}。本轮结束后自动压缩，压缩完成后系统会自动拉起新一轮（压缩后的干净上下文），你继续执行该任务，用户无需重发。`,
      `• 依赖（要引用之前给出的文件路径/结论/报错现场/长推理链中间量）：不写标记。占用达 ${Math.round(M3.criticalRatio * 100)}% 时系统会强制压缩（同样保留摘要+近期消息），无需任何操作。`,
      `• 写标记前自检：本轮关键产物（文件路径、决策、未落盘的结论）已写入文件或本回复正文，再写标记；不要连续多轮写——压缩后占用需重新累积。`,
    ].join('\n');
  };

  /* 官方工厂异步解析；就绪前监听器直接放行（不注入、不阻塞）。 */
  const factoryPromise = loadCreateUserMessage();
  let createUserMessage = null;
  factoryPromise
    .then(({ createUserMessage: fn, via, probe }) => {
      createUserMessage = fn;
      state.m2.via = via;
      if (fn) {
        state.m2.registered = true;
        log('info', `M2 createUserMessage 已解析（${via}）；每轮 step1 注入用量三元组`);
      } else {
        log('warn', `M2 createUserMessage 全候选失败，注入禁用（非致命）：${JSON.stringify(probe).slice(0, 400)}`);
      }
      schedule('m2-factory', 0);
    })
    .catch((e) => log('warn', `M2 工厂解析异常（禁用注入）：${msg(e)}`));

  const addListener = (name, handler, opts) => {
    try {
      if (typeof ctx?.on !== 'function') return 'ctx.on 不可用';
      ctx.on(name, handler, opts);
      return 'ok';
    } catch (e) {
      return `err: ${msg(e)}`;
    }
  };

  /* ═══════════ M3.5 通道1：pre-step 轮内先压（在 next() 之前执行 → 影响本步请求） ═══════════
   * 官方源码实证（docs/reference @deepseek-ai/dsh-compaction-basic lib/index.js）：
   *  - compactIfNeeded(agent,"pressure",signal) 即官方 pre-step 自动压缩的原话调用（阈值走引擎自身 config，默认 80%——
   *    因此本函数的 critical 兜底在 ≥85% 时必然越过引擎阈值而生效；引擎自身监听若已压过则返回 null，幂等安全）；
   *  - "context-overflow" 触发**绕过引擎阈值**（selectCompactableRange retain=0 → compactRegion，owner:"current-turn"）——
   *    关键词「先压缩」在 20%~85% 区间也能立即生效的合法通道；
   *  - compactNow 必须 idle（runMaintenance），轮内不可用——那是 idle 安全网专用。 */
  const preStepCompaction = async (payload) => {
    try {
      if (!effEnabled() || M3.dryRun) return; // 总开关活读 + 演习模式
      const { agent, signal } = payload ?? {};
      if (!agent?.session) return;
      /* A5（审查）：signal 缺失守卫——compactIfNeeded 契约首行 throwIfAborted(signal)，undefined 放行=首跑即败
       * （M5.5 通道 A 已实证同款）。payload 未带 signal 时兜底 180s 超时信号（与 idle compactNow 同参）。 */
      const sig = signal && typeof signal === 'object' ? signal : AbortSignal.timeout(180_000);
      if (sig.aborted) return;
      const sid = String(pick(agent.session.id, agent.sessionId, agent.id, 'unknown'));
      const mr = measureRatio(agent.session); // B2：读取收敛
      if (!mr.ok || mr.ratio == null) return;
      const ratio = mr.ratio;
      if (ratio < M3.criticalRatio) return; // 关键词通道已裁撤（用户决定）：pre-step 仅剩 critical 兜底
      const trigger = 'pressure';
      const compaction = resolveCompactionFor(agent);
      if (!compaction.service) {
        log('warn', `M3.5 pre-step 先压：解析不到作用域 compaction，跳过`);
        return;
      }
      state.m3.preStepActs += 1;
      const t0 = Date.now();
      log('info', `M3.5 pre-step 先压开始：trigger=${trigger}（危险占用 ${(ratio * 100).toFixed(1)}%，via ${compaction.via}）`);
      const result = await compaction.service.compactIfNeeded(agent, trigger, sig);
      state.m3.preStepOk += 1;
      state.m3.lastPreStep = {
        at: new Date().toISOString(),
        sessionId: sid,
        trigger,
        ratio: +(ratio * 100).toFixed(1),
        acted: result != null,
        shadowedTokens: result?.shadowedTokenCount ?? null,
        range: result?.shadowedRange ?? null,
        ms: Date.now() - t0,
      };
      if (result) {
        const __t = formatAct('pressure', result?.shadowedTokenCount);
        publishHud({ hudLastAct: __t, hudArmed: '' }); // M5
        recordHudAct(sid, __t);
      }
      log(
        'info',
        `M3.5 pre-step 先压完成（${Date.now() - t0}ms）：${
          result ? `shadowed ~${nfmt(result.shadowedTokenCount ?? 0)} tokens（seq ${result.shadowedRange?.start ?? '?'}-${result.shadowedRange?.end ?? '?'}）` : '引擎判定无需压（null）'
        }`,
      );
      schedule('m3.5-prestep', 500);
    } catch (e) {
      const code = e?.code ?? e?.name ?? 'error';
      state.m3.preStepErrors[code] = (state.m3.preStepErrors[code] ?? 0) + 1;
      log('warn', `M3.5 pre-step 先压失败（吞掉，本轮照常继续）：${msg(e)}`);
      schedule('m3.5-prestep', 500);
    }
  };

  /* ---- M2.5 新会话一次性插件说明：让任何新会话的 Agent 不靠外部文档就明白压缩流程与用法 ----
   * A3（审查）：由冻结常量改为函数——原实现 apply 期拼死 M3.marker 与「85%」字样，config 热改后
   * 说明文本与活值检测（事件解析/政策卡）自相矛盾；现每次注入现拼活值。 */
  const renderBrief = () => [
    '【context-pilot 插件说明（本会话仅此一次）】每轮开头的「Context usage」行就是本插件在测量上下文占用。',
    '占用达到阈值时，该行下方会附「压缩决策卡」：若接下来的任务不依赖更早的对话细节，可本轮挂起——写一行「待执行：<任务>」，并在回复最后一行单独写 ' + M3.marker + '；',
    '回合结束后插件自动压缩上下文（旧对话收为摘要），并自动拉起新一轮让你继续该任务（以「(context-pilot 自动恢复)」开头），用户无需重发。',
    '若任务依赖细节则照常执行、勿写标记；占用达 ' + Math.round(M3.criticalRatio * 100) + '% 强制压缩线时系统自动压缩。标记不要连续多轮写（压缩后占用需重新累积）。',
  ].join('');

  state.listeners['agent/pre-step'] = addListener(
    'agent/pre-step',
    async (payload, next) => {
      await preStepCompaction(payload); // M3.5 通道1：轮内先压（绝不上抛）
      const decision = await next();
      if (!decision || decision.kind === 'reject') return decision;
      if (!effEnabled()) return decision; // 总开关关闭：完全恢复原生 DSH（不注入）
      try {
        const { agent, turn, step, signal } = payload ?? {};
        if (signal?.aborted) return decision;
        if (step !== 1) return decision; // 每轮只注一次（轮首快照）
        if (!createUserMessage || !agent?.session) {
          const key = !createUserMessage ? 'noFactory' : 'noSession';
          state.m2.skips[key] = (state.m2.skips[key] ?? 0) + 1;
          return decision;
        }
        const r = renderUsageText(agent.session);
        if (r.error || !r.text) {
          const key = 'measure:' + String(pick(agent.session.id, agent.sessionId, 'unknown'));
          if (!measuredFailedOnce.has(key)) {
            measuredFailedOnce.add(key);
            log('warn', `M2 measure 失败跳过注入（${key}）：${r.error}`);
          }
          state.m2.skips.measureFail = (state.m2.skips.measureFail ?? 0) + 1;
          return decision;
        }
        const card = renderPolicyCard(r.ratio); // M3.5 通道2：政策卡（相关占用以上才出现）
        const sid = String(pick(agent.session.id, agent.sessionId, 'unknown'));
        const brief = briefedBySid.has(sid) ? null : renderBrief(); // M2.5+A3：现拼活值
        if (brief) {
          briefedBySid.add(sid);
          state.m2.briefings = (state.m2.briefings ?? 0) + 1;
        }
        const fullText = [r.text, card, brief].filter(Boolean).join('\n\n');
        const message = createUserMessage({
          content: [{ type: 'text', text: fullText }],
          source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: fullText }] },
        });
        state.m2.injections += 1;
        if (card) state.m3.policyCards += 1;
        state.m2.lastText = fullText;
        state.m2.lastAt = new Date().toISOString();
        log('info', `M2 注入 turn=${turn} step=${step}${card ? ' ＋政策卡' : ''}：${r.text}`);
        schedule('m2-inject', 500);
        return { ...decision, messages: [...(decision.messages ?? []), message] };
      } catch (e) {
        log('warn', `M2 注入异常（放行原决策）：${msg(e)}`);
        return decision;
      }
    },
    { prepend: false },
  );

  /* ═══════════ M1：会话/事件盘点 ═══════════ */

  state.listeners['session/created'] = addListener('session/created', (session) => {
    log('info', `session/created id=${pick(session?.id, session?.header?.id)} → 安排重测`);
    schedule('session/created', 1500);
  });
  /* ═══════════ M3-a：turn 前审计 + 关键词武装（inbox/inserted） ═══════════
   * v1 实弹结论（2026-10-06）：此处 agent 已是 waking 状态，compactNow 必 busy（actErrors.busy=2）——此处不执行压缩。
   * M3.5 职责：① 决策审计（记录"该任务场景是否会想压"）；② 关键词「先压缩」武装——
   * 消息文本以此开头时置 armed 标记，由 pre-step（M3.5 通道1）在轮内合法执行。 */
  state.listeners['agent/inbox/inserted'] = addListener('agent/inbox/inserted', (payload) => {
    try {
      if (!effEnabled()) return; // 总开关活读
      const { agent, message } = payload ?? {};
      if (!agent?.session) return;
      const text = messageText(message);
      const sid0 = String(pick(agent.session.id, agent.sessionId, 'unknown'));
      if (text) lastUserTextBySid.set(sid0, text.slice(0, 500)); // M5.5：记住最近任务文本（恢复兜底）
      const taskChars = text.length;
      const d = decideCompaction(agent);
      state.m3.decisions += 1;
      state.m3.lastDecision = {
        at: new Date().toISOString(),
        sessionId: pick(agent.session.id, agent.sessionId),
        taskChars,
        ratio: d.ratio != null ? +(d.ratio * 100).toFixed(1) + '%' : null,
        compact: d.ok ? d.compact : null,
        reason: d.error ?? d.reason,
      };
      if (d.ok && d.compact) {
        state.m3.wouldCompact += 1;
        log('info', `M3 [审计] 该任务场景会想先压缩（${d.reason}）；由 idle 扫除器负责执行`);
      } else if (d.ok) {
        log('info', `M3 决策：不压缩（${d.reason}）`);
      }
      schedule('m3-decision', 500);
    } catch (e) {
      log('warn', `M3 决策异常（吞）：${msg(e)}`);
    }
  });

  /* ═══════════ M3-b：idle 扫除器（双模式：safety-net 兜底 + M3.6 marker 模型建议通道） ═══════════
   * safety-net：会话被撂在危险占用（≥critical）→ 兜底清场，受 10min 冷却。
   * marker（M3.6）：模型回复尾部写了 M3.marker → idle 后立即压缩（≥markerMinRatio 即可，
   *   不受 critical 限制、不受 10min 冷却——显式请求不设防）。用户无需任何输入。 */
  const sweepInFlight = new Set();
  const idleSweep = (agent) => {
    try {
      if (!effEnabled() || M3.dryRun) return; // 总开关活读 + 演习模式
      const sid = String(pick(agent?.session?.id, agent?.id, 'unknown'));
      /* A2（审查）：TTL 清灯前移到一切早退之前——measure 失败/in-flight 早退也要熄过期武装灯，防 hudArmed 永亮 */
      const armedMark = markerArmed.get(sid);
      if (armedMark && Date.now() - armedMark.at > M3.armedTtlMs) {
        markerArmed.delete(sid);
        publishHud({ hudArmed: '' }); // M5：武装过期即熄灯
      }
      if (sweepInFlight.has(sid)) return;
      const d = decideCompaction(agent); // idle，无任务文本
      if (!d.ok || d.ratio == null) return;
      const armedAt = armedMark?.at ?? null; // A2：失败重武装保原始时刻（TTL 自然封顶重试窗口）
      const markerShot = !!(armedMark && d.ratio >= M3.markerMinRatio); // 过期项已被上面清除，无需再比 TTL
      if (markerShot) markerArmed.delete(sid);
      const now = Date.now();
      if (!markerShot) {
        if (d.ratio < M3.criticalRatio) return; // safety-net：仅 critical
        if (now - (state.m3.sweeps[sid] ?? 0) < M3.sweepMinIntervalMs) return; // 兜底受冷却限制
      }
      const reason = markerShot ? 'marker' : 'safety-net';
      const compaction = resolveCompactionFor(agent);
      if (!compaction.service) {
        log('warn', `M3 idle 扫除：解析不到作用域 compaction（${JSON.stringify(compaction.probe)}）`);
        return;
      }
      sweepInFlight.add(sid);
      state.m3.sweeps[sid] = now;
      state.m3.acts += 1;
      log('info', `M3 idle 扫除（${reason}）：compactNow（ratio ${(d.ratio * 100).toFixed(1)}%，via ${compaction.via}）`);
      compaction.service
        .compactNow(agent, AbortSignal.timeout(180_000), 'context-pilot')
        .then((result) => {
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
          publishHud({ hudLastAct: __actText, hudArmed: '' }); // M5
          recordHudAct(sid, __actText);
          maybeResumeAfterMarker(sid, reason); // M5.5：标记压缩成功 → 自动投递恢复提示
          log('info', `M3 idle 扫除完成：${result ? `shadowed ${result.shadowedSeqs?.length ?? '?'} nodes / ~${result.shadowedTokenCount ?? '?'} tokens` : 'null（无可压区间）'}`);
          schedule('m3-act', 500);
        })
        .catch((e) => {
          const code = e?.code ?? (e?.name === 'ManualCompactionError' ? 'ManualCompactionError' : 'error');
          state.m3.actErrors[code] = (state.m3.actErrors[code] ?? 0) + 1;
          log('warn', `M3 idle 扫除失败（${code}）：${msg(e)}`);
          /* A2（审查）：marker 压缩失败不能吞掉武装——原始 TTL 窗口内重武装（armedAt 保原时刻，重试自然封顶），
           * 下次 idle 自动重试；hudArmed 保持亮灯，任务徽章不熄，用户看得到还有事没做完。 */
          if (reason === 'marker' && armedAt && Date.now() - armedAt < M3.armedTtlMs) {
            markerArmed.set(sid, { at: armedAt });
            publishHud({ hudArmed: 'armed' });
            m55Attempt({ phase: 'act-failed-rearm', code, sid: sid.slice(0, 8), msLeft: M3.armedTtlMs - (Date.now() - armedAt) });
            log('info', `M3.6 压缩失败（${code}）→ 武装保留（TTL 内），下次 idle 重试`);
          }
          schedule('m3-act', 500);
        })
        .finally(() => sweepInFlight.delete(sid));
    } catch (e) {
      log('warn', `M3 idle 扫除异常（吞）：${msg(e)}`);
    }
  };

  state.listeners['agent/status'] = addListener('agent/status', (payload) => {
    try {
      const { agent, status } = payload ?? {};
      const st = status ?? payload;
      log('info', `agent/status → ${typeof st === 'object' ? JSON.stringify(st) : String(st)}`);
      if (agent && (status === 'idle' || st === 'idle')) idleSweep(agent);
    } catch (e) {
      log('warn', `agent/status 处理异常（吞）：${msg(e)}`);
    }
    schedule('agent/status', 1500);
  });

  /* ═══════════ M3.6：模型回复尾部标记 → idle 自动压缩 ═══════════
   * 事件通道 compaction-basic 官方同款（ctx.on("session/event")，event.type==='assistant/message'）。
   * 解析到标记即武装；竞态处理：消息事件可能晚于 status→idle，武装时查 agent.status，
   * 已 idle 则直接触发扫除。用户零输入——标记本身在回复里可见（透明）。 */
  state.listeners['session/event'] = addListener('session/event', (session, event) => {
    try {
      /* 形状探针先行：无论后续逻辑如何，先记录到达的事件（类型计数 + 前 N 条样本） */
      const probeType = event?.type ?? '(no-type)';
      eventProbe.counts[probeType] = (eventProbe.counts[probeType] ?? 0) + 1;
      if (eventProbe.samples.length < eventProbe.cap) {
        const t = extractEventText(event);
        eventProbe.samples.push({
          type: probeType,
          topKeys: tryOf(() => Object.keys(event ?? {})).value?.slice(0, 12) ?? null,
          textLen: t.length,
          textTail: t ? t.slice(-60) : '',
          session: String(pick(session?.id, session?.header?.id, '?')).slice(0, 8),
        });
      }
      if (!M3.enabled || !M3.marker) return;
      if (event?.type !== 'assistant/message') return;
      const text = extractEventText(event);
      if (!text || !text.trimEnd().endsWith(M3.marker)) return;
      const sid = String(pick(session?.id, session?.header?.id, 'unknown'));
      markerArmed.set(sid, { at: Date.now() });
      state.m3.markerHits += 1;
      publishHud({ hudArmed: 'armed' }); // M5：标记武装，弹窗亮「武装中」
      /* M5.5：捕获挂起任务——优先回复里的「待执行：<任务>」行，兜底最近一条用户消息 */
      const deferMatch = [...text.matchAll(/待执行[：:]\s*(.+)/g)].pop();
      const pendingTask = (deferMatch ? deferMatch[1] : lastUserTextBySid.get(sid) ?? '').trim().slice(0, 400);
      pendingBySid.set(sid, {
        task: pendingTask || '(未捕获任务文本，恢复时请从上方摘要自查)',
        at: Date.now(),
      });
      publishHud({ hudPending: JSON.stringify({ task: (pendingTask || '…').slice(0, 120) }) });
      state.m55.armed = {
        at: new Date().toISOString(),
        sid: sid.slice(0, 8),
        via: deferMatch ? 'reply-defer-line' : 'last-user-text',
        taskLen: pendingTask.length,
        taskHead: (pendingTask || '').slice(0, 60),
      };
      log('info', `M3.6 标记 ${M3.marker} 命中（session ${sid.slice(0, 8)}…）→ 武装；idle 后自动压缩`);
      const aList = tryOf(() => svc('agents')?.list?.() ?? []);
      const agent = (aList.value ?? []).find((a) => String(pick(a?.session?.id, a?.sessionId, a?.id)) === sid);
      if (agent && agent.status === 'idle') {
        log('info', `M3.6 agent 已 idle（消息事件晚于状态翻转）→ 立即触发扫除`);
        idleSweep(agent);
      }
      schedule('m3.6-marker', 500);
    } catch (e) {
      log('warn', `M3.6 标记处理异常（吞）：${msg(e)}`);
    }
  });
  log('info', `事件监听：${JSON.stringify(state.listeners)}`);

  /* ---- 心跳：低频跟踪（每次 refresh → 报告） ----
   * 2026-10-06 14:2x–14:5x 实证结论（本项超出审查 A1 范围，是实施中发现的**新事实**，已修正两个错误假设）：
   *  ① 原写法 `const every = t?.interval ?? ctx?.interval` 取**未绑定方法引用** ⇒ 丢 this 必抛 ⇒ 被 catch 吞
   *     （timer.interval 实现首行即 `this.ctx.effect(...)`）——心跳连注册都没成功过。
   *  ② 但绑定修好、注册成功（返回 disposer）后**仍零触发**；改用 setTimeout 链 / setInterval / 去 unref 皆然
   *     （`ticks` 恒 0、探针日志从未创建），而同一 apply 体内的 `activation+2s`/`boot+10s` 全部准时。
   *  ③ **真因（cordis 语义，lib/index.js:1142 实证）**：`ctx.effect(execute)` 的 execute **立即执行=setup，
   *     其返回值才是卸载器**。而「卸载清理」块把清理语句**内联写在 execute 体内** ⇒ ① 清理在 **apply 期**
   *     就被执行，此时 disposers 里已含刚入册的心跳 timer ⇒ **心跳被当场 clearTimeout/clearInterval 掉**；
   *     ② 真正的卸载时**反而毫无清理**（pending/resumeTimers/心跳全泄漏）——这也解释了 A1 僵尸 interval
   *     为何能扛过每一次 toggle（它的 disposer 在清理块跑完之后才入册，永不被调用）。
   *  修法：清理块 execute 体内 `return () => {...}`（与官方 TimerService 同款）；心跳直接同步注册，
   *     其 disposer 现在只会在真正卸载时被调用。 */
  try {
    const h = setInterval(() => { try { schedule('heartbeat', 0); } catch { /* 吞 */ } }, HEARTBEAT_MS);
    h.unref?.();
    disposers.push(() => { try { clearInterval(h); } catch { /* 吞 */ } });
    state.heartbeat = { via: 'setInterval+unref(apply 内注册)', type: typeof h, at: new Date().toISOString(), ms: HEARTBEAT_MS };
    log('info', `心跳已注册（${state.heartbeat.via}，每 ${HEARTBEAT_MS / 1000}s）`);
  } catch (e) {
    state.heartbeat = { via: null, error: msg(e), at: new Date().toISOString() };
    log('warn', `心跳注册失败（不影响主流程）：${msg(e)}`);
  }

  /* ---- 卸载清理 ----
   * ⚠️ 2026-10-06 14:5x 修正（关键，A7 的「timer 入表」因此才真正成立）：
   * cordis `ctx.effect(execute)` 语义 = **execute 立即执行（setup），返回值才是卸载器**
   * （lib/index.js:1142 `const effect = runner.execute.call(this); if (typeof effect === 'function') return runner.collect(effect)`）。
   * 原实现把清理语句内联在 execute 体内 ⇒ 清理在 apply 期被误执行（当场清掉刚注册的心跳、pending 里的
   * 启动刷新），而真正的卸载时无任何清理。**必须 return 一个函数**（同官方 TimerService 写法）。 */
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        for (const t of pending.values()) { try { clearTimeout(t); } catch { /* 吞 */ } }
        pending.clear();
        for (const t of resumeTimers) { try { clearTimeout(t); } catch { /* 吞 */ } } // A7：2s 恢复调度随卸载清
        resumeTimers.clear();
        for (const d of disposers) { try { d?.(); } catch { /* 吞 */ } }
      }, 'context-pilot:cleanup');
    }
  } catch { /* 清理注册失败不致命 */ }

  /* ---- M5 HUD 轮询面注册（client 每 5s getHud；typert-loader 自动发现 + ctx.provide 兜底） ----
   * B4（审查批次3）：wire 动态 import（带 ?ts=）——静态相对导入解析回无参 URL 命中进程缓存（P16），
   * face 逻辑被冻结在重启版本；动态加载后 wire 随 impl 同批热换（TYPERT 声明走包 exports，不受影响；
   * wire 模块纯导出无顶层副作用，已核对）。动态 import 异步 ⇒ 注册晚一拍（client inject 回调/5s 轮询天然容忍）。 */
  import(`./wire.host.mjs?ts=${state.seq}-${Date.now().toString(36)}`)
    .then((hudWire) => {
      const face = hudWire.createRemoteFace({
        /** sid 可选：传会话 id 则只返回该会话的最近压缩（主行=该会话最新，acts=该会话列表）；空=全局。 */
        onGetHud: (sid) => {
          const list = Array.isArray(state.m5.acts) ? state.m5.acts : [];
          const filtered = sid ? list.filter((a) => a.sid === sid) : list;
          return {
            ok: true,
            ...state.m5.hud,
            hudLastAct: filtered[0]?.text || '',
            acts: filtered.slice(0, 8).map((a) => a.text),
            at: new Date().toISOString(),
          };
        },
      });
      if (typeof ctx?.provide === 'function') {
        ctx.provide(hudWire.FACE_NAME, face);
        state.m5.hudFace = 'provided';
        log('info', `HUD 轮询面 ${hudWire.FACE_NAME} 已注册（ctx.provide，B4 动态热换）`);
      } else {
        state.m5.hudFace = 'no-provide';
        log('warn', 'ctx.provide 不可用：HUD 轮询面未注册（HUD 行将无数据，不影响主流程）');
      }
    })
    .catch((e) => {
      state.m5.hudFace = 'error';
      log('warn', `HUD 轮询面注册失败（吞）：${msg(e)}`);
    });

  /* ---- 启动快照：激活后 2s 一发，10s 再一发（捕捉晚到的会话重水化） ---- */
  /* ---- M5 HUD 启动回填：报告最近压缩记录重发布到面板（弹窗不再空态）。
   * 2026-10-06 强化：激活时同步立即试一次（消「激活→回填」空窗，期间 getHud 会返回空串），
   * 再按 1.2s/4s/10s 重试（幂等；报告读失败/竞态可自愈）。 ---- */
  try {
    let bfTries = 0;
    const bfOnce = () => {
      bfTries += 1;
      try {
        /* 主源 = hud-acts.json（激活时已加载进 state.m5.acts，跨重启存续）。
         * 报告降级为迁移/兜底源：合并去重（at+sid）导入，**不再覆盖式写 acts**
         * ——顺带修掉 C2 记录的「激活后 1.2-10s 内回填覆盖运行期记录」竞态。 */
        const prev = loadReportBase(); // C3：直接读盘（回填最多 4 发；不占用 writeReport 的缓存/对账状态）
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
          publishHud({ hudLastAct: newest.text, hudArmed: '' }); // 内存写入，无 HMR 问题；跨激活显示靠这里回填
          log('info', `M5 HUD 启动回填：${newest.at}（历史 ${state.m5.acts.length} 条，持久化 hud-acts.json）`);
        }
      } catch (e) {
        /* C1②（审查）：同步 + 3 次重试（共 4 发）全失败即终态留痕，不再永久静默 */
        if (bfTries >= 4) log('warn', `M5 HUD 回填 ${bfTries} 次尝试均失败（终态放弃）：${msg(e)}`);
      }
    };
    bfOnce();
    for (const ms of [1200, 4000, 10000]) {
      const bt = setTimeout(bfOnce, ms);
      bt.unref?.();
    }
  } catch { /* 吞 */ }
  /* ---- 启动快照：激活后 2s 一发，10s 再一发（捕捉晚到的会话重水化） ---- */
  schedule('activation+2s', 2000);
  schedule('boot+10s', 10000);

  return { reportPath };
}
