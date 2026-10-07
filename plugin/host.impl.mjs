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
/** R2：dsh-tools 的 defineTool（工具定义器）——与 dsh-llm 同款候选链加载。 */
const DSH_TOOLS_REL = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'];

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
  /* 智能思考总门（2026-10-07 引入，R2 换工具方案，R3 移入 effort.mjs）。
   * 开 = 向 Agent 注入思考强度信息 + 注册 set_reasoning_effort 工具允许其自主换档；
   * 关 = 提示词不注入、工具不注册（用户定义：一个开关管两件事，不做只读/只写拆分）。
   * 默认 false：新功能默认不介入，避免未确认行为改变既有会话（用户可随时在弹窗开启）。 */
  effortEnabled: false,
  /* 换档冷却（2026-10-08 起可配，R3-S7）：两次换档的最小间隔。
   * 换档会使前缀缓存失效（dsh-llm call-config.js 标注 effort 属缓存敏感参数）⇒
   * 这是**会实际影响计费**的参数，故开放配置；默认 30s 是实测「够用且不误挡」的折中。 */
  effortCooldownMs: 30_000,
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

/* ─────────── R2：官方 defineTool 解析（同款候选链） ───────────
 * 依据：官方工具包 @deepseek-ai/dsh-tool-ask-user 的范式
 *   import { defineTool } from "@deepseek-ai/dsh-tools";
 *   ctx.tools.register(defineTool({ name, description, parameters, output, execute }));
 * 与 createUserMessage 一样走「bare → env → resourcesPath → 硬编码」候选链，
 * 全失败 ⇒ 不注册工具（换档退化为不可用，但主流程绝不受影响）。 */
function dshToolsCandidates() {
  const out = [];
  const env = process.env.DSH_CONTEXT_PILOT_DSH_TOOLS;
  if (typeof env === 'string' && env) out.push({ source: 'env', path: env });
  const res = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (res) {
    out.push({ source: 'resourcesPath/app.asar', path: join(res, 'app.asar', ...DSH_TOOLS_REL) });
    out.push({ source: 'resourcesPath/app.asar.unpacked', path: join(res, 'app.asar.unpacked', ...DSH_TOOLS_REL) });
  }
  out.push({ source: 'abs:D:/DeepSeek/resources/app.asar', path: join('D:/DeepSeek/resources/app.asar', ...DSH_TOOLS_REL) });
  out.push({ source: 'abs:D:/DeepSeek/resources/app.asar.unpacked', path: join('D:/DeepSeek/resources/app.asar.unpacked', ...DSH_TOOLS_REL) });
  return out;
}

async function loadDefineTool() {
  const probe = [];
  const accept = (mod) => (mod && typeof mod.defineTool === 'function' ? mod.defineTool : null);
  try {
    const fn = accept(await import('@deepseek-ai/dsh-tools'));
    if (fn) return { defineTool: fn, via: 'bare|import', probe };
    probe.push({ source: 'bare', ok: false, error: 'no defineTool export' });
  } catch (e) {
    probe.push({ source: 'bare', ok: false, error: msg(e) });
  }
  const require = createRequire(import.meta.url);
  for (const cand of dshToolsCandidates()) {
    try {
      const fn = accept(await import(pathToFileURL(cand.path).href));
      if (fn) return { defineTool: fn, via: `${cand.source}|import`, probe };
      probe.push({ source: cand.source, ok: false, path: cand.path, error: 'no defineTool export' });
    } catch (e) {
      probe.push({ source: cand.source, ok: false, path: cand.path, error: msg(e) });
    }
    try {
      const fn = accept(require(cand.path));
      if (fn) return { defineTool: fn, via: `${cand.source}|require`, probe };
      probe.push({ source: cand.source, ok: false, path: cand.path, error: 'no defineTool export' });
    } catch (e) {
      probe.push({ source: cand.source, ok: false, path: cand.path, error: msg(e) });
    }
  }
  return { defineTool: null, via: null, probe };
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
      for (const k of ['enabled', 'effortEnabled', 'criticalRatio', 'marker', 'markerMinRatio', 'armedTtlMs', 'sweepMinIntervalMs', 'effortCooldownMs']) {
        raw[k] = live(config[k]);
      }
      if (typeof raw.enabled === 'boolean') M3.enabled = raw.enabled;
      if (typeof raw.effortEnabled === 'boolean') M3.effortEnabled = raw.effortEnabled;
      if (typeof raw.marker === 'string') M3.marker = raw.marker;
      for (const k of ['criticalRatio', 'markerMinRatio']) {
        if (typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k] >= 0 && raw[k] <= 1) M3[k] = raw[k];
      }
      for (const k of ['armedTtlMs', 'sweepMinIntervalMs', 'effortCooldownMs']) {
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
        return {
          acts: j.acts
            .filter((a) => a && typeof a.sid === 'string' && typeof a.text === 'string' && typeof a.at === 'string')
            .slice(0, HUD_ACTS_CAP),
          lineage: j.lineage && typeof j.lineage === 'object' ? j.lineage : {}, // C-lineage：会话血统链
        };
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') log('warn', `hud-acts.json 读取失败（忽略，走报告回填）：${msg(e)}`);
    }
    return null; // 文件缺失/损坏 → null（调用方回退报告回填）
  };
  const saveHudActs = (acts) => {
    try {
      mkdirSync(dirname(hudActsPath), { recursive: true });
      writeFileSync(hudActsPath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), acts: acts.slice(0, HUD_ACTS_CAP), lineage: state.m5.lineage ?? {} }, null, 2));
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
  /** C-lineage（2026-10-07）：会话 id 轮转链——DSH 压缩会分叉出新 session id（实测本会话连换 3 个 id），
   *  压缩记录按「当时的 id」存 ⇒ getHud 按当前 id 过滤永远匹配不上（用户实测「记录经常丢失」的根因）。
   *  本助手记录 newSid ← prevSid 的血统边（随 hud-acts.json 持久化）；getHud 沿链回溯即可命中
   *  「同一条会话」的全部历史记录。局限：多会话并发时按最近活跃推断，可能误连（单窗口使用无碍）。 */
  const noteSessionId = (sid) => {
    try {
      if (!sid) return;
      if (state.m5.lastSid && sid !== state.m5.lastSid && state.m5.lineage[sid] === undefined) {
        state.m5.lineage[sid] = state.m5.lastSid;
        saveHudActs(state.m5.acts);
        log('info', `M5 会话血统：${String(sid).slice(0, 13)}… ← ${String(state.m5.lastSid).slice(0, 13)}…`);
      }
      state.m5.lastSid = sid;
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
  /* R1：智能思考教学的一次性标记（与压缩说明分开——两者开关独立，可能只开一个）。
   * ⚠️ 与 briefedBySid 一样，**压缩成功后必须清除**（见 clearBriefed 的注释）。 */
  const effBriefedBySid = new Set();
  /* 一次性说明的「已讲」标记必须在**压缩成功后清除**（真 bug 修复，2026-10-07）。
   * 原实现 briefedBySid 只有 add、全文无 delete/clear ⇒ 压缩后那条说明被收进摘要，
   * 而插件认为「讲过了」永不再讲；摘要由模型生成、**不保证保留该段** ⇒ 模型可能永久
   * 失去用法说明（压缩标记怎么写、智能思考怎么换档都不知道）。
   * 实测佐证：m2.briefings=2 而 m2.injections=5（本会话跨热换只讲过 2 次）。
   * 压缩 = 新开始 ⇒ 正好重讲一次；成本仍是一次性量级（压缩是低频事件）。 */
  const clearBriefed = (sid) => {
    try {
      briefedBySid.delete(sid);
      effBriefedBySid.delete(sid);
      state.m2.briefReissues = (state.m2.briefReissues ?? 0) + 1;
    } catch { /* 吞 */ }
  };
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
    m2: { registered: false, injections: 0, briefings: 0, lastText: null, lastAt: null, via: null, skips: {},
      // 智能思考注入取证（教学次数 / 压缩后重讲次数 / 每轮后缀次数）
      effortBriefings: 0, briefReissues: 0, effortSuffixes: 0 },
    m3: {
      decisions: 0,
      wouldCompact: 0,
      acts: 0,
      actOk: 0,
      lastDecision: null,
      lastAct: null,
      actErrors: {},
      /* ⚠️ 2026-10-08：压缩失败的错误**正文**（此前只记错误码，报告无法定位——
       * 实测 actErrors={summary:2} / preStepErrors={INVALID_REQUEST:17} 而两条路径成功均为 0） */
      lastActError: null,
      lastPreStepError: null,
      probe: null,
      sweeps: {},
      // M3.5 三通道
      preStepActs: 0,
      preStepOk: 0,
      lastPreStep: null,
      preStepErrors: {},
      markerHits: 0, // B3：keywordHits 恒 0 字段已随审查退役（历史报告条目保持原样，不受影响）
      policyCards: 0,
      engineCapProbe: null, // C-own：引擎阈值探测留痕（via/ratio/fallback），取证「钳制用的是哪个值」
      /* 智能思考（effort）取证 —— R3 收敛（原先 12 个散字段 + 两处 `?? 0` 隐式初始化）。
       * `effortMarkerHits`（文本标记时代，永不自增）与 `lastEffortMarker`（实为工具路径写入）
       * 已删除：前者是死字段，后者名字误导。 */
      effortSwitches: 0, // 真换档次数（只在档位实际变化时自增，见 effort.mjs 结论④）
      effortReasserts: 0, // 每轮重复覆盖次数（防被官方内层打回，不计入换档）
      effortSkips: {}, // 跳过原因计数：foreign|noRoute|invalid|sameValue|cooldown
      effortToolCalls: 0,
      lastEffortApply: null, // 最近一次应用决策（含 from/provider/model/options/失败原因）
      lastEffortTool: null, // 最近一次工具接受（want + sid）
      effortTool: null, // 工具注册结果
      effortToolLoader: null, // defineTool 加载链探测
      effortHooks: 0, // 已安装的 agent/request 钩子数
      /** 懒安装诊断（R3-S10：原先 effortEnsure + effortHookError 两个对象，现合一）。
       *  ⚠️ 曾因该函数**全静默**导致「工具接受成功却永不变档」无从定位（effortToolCalls=1、
       *  effortSwitches=0、effortHooks 从未赋值）⇒ 必须留痕。 */
      effortDiag: { calls: 0, at: null, enabled: false, agents: null, installed: 0, failed: 0, error: null, hookError: null },
    },
    // M5 HUD 发布取证（entry 查找/edit 结果全程留痕——弹窗侧空态无法区分静默失败）
    // hud.gen = 实例指纹：客户端取到的 gen 应与本实例一致；不一致 = RPC 打到了旧激活的僵尸面
    // acts = 最近压缩记录（按会话可过滤，新→旧，cap 8）：主行显示最新，悬停展开列表
    m5: { lastPublish: null, hud: { hudLastAct: '', hudArmed: '', hudPending: '', gen: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }, hudFace: 'absent', acts: [], lastSid: null, lineage: {} },
    // M5.5 恢复通道取证（每次尝试逐相位落报告，杜绝 log-only 黑洞）
    m55: { armed: null, attempts: [], channelProbe: null },
  };
  /* 激活即从 hud-acts.json 恢复压缩历史（跨重启/跨 toggle 存续）；
   * 报告回填降级为迁移/兜底源（bfOnce 内合并去重，不再覆盖式写 acts）。 */
  const hudLoaded = loadHudActs();
  state.m5.acts = hudLoaded?.acts ?? [];
  state.m5.lineage = hudLoaded?.lineage ?? {}; // C-lineage：历史血统边随文件恢复

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

  /** C-own（2026-10-07，方案 C）：读引擎（compaction-basic）的自动压缩阈值——插件强制线的**动态上限**。
   *  依据（源码实证）：服务实例公开属性 `config`（resolveConfig 产出的 deepFreeze 对象，含
   *  thresholdRatio / auto / modelPolicies），见 dsh-compaction-basic lib/index.js L826/L75。
   *  语义（用户需求）：插件开启时插件线先行（必须 ≤ 引擎线），插件关闭/卸载后引擎 80% 自然恢复——
   *  故**不改引擎配置**，只在插件侧钳制：生效强制线 = min(用户配置, 引擎阈值)。
   *  拿不到（服务未解析/旧版本无该属性）时回退官方默认 0.8；每次现取不缓存（配置可能被改）。 */
  const DEFAULT_ENGINE_THRESHOLD = 0.8;
  const engineThreshold = (agent) => {
    const r = resolveCompactionFor(agent);
    const t = tryOf(() => r.service?.config?.thresholdRatio);
    const v = t.value;
    const ok = typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
    state.m3.engineCapProbe = { at: new Date().toISOString(), via: r.via, ratio: ok ? v : null, fallback: !ok };
    return ok ? v : DEFAULT_ENGINE_THRESHOLD;
  };

  /* ═══════════ 智能思考（reasoning effort）：模块接线（R3 解耦，2026-10-08）═══════════
   * 实现全部搬进 plugin/effort.mjs（配置/状态/读取/钩子/工具/注入文本/HUD 载荷）；
   * 此处只留四件事：① 依赖注入；② 幂等懒安装入口；③ 注入文本出口；④ HUD 载荷出口。
   * 审查与解耦方案：docs/r3-effort-review.md；十条「来之不易」的实证结论见 effort.mjs 文件头。
   *
   * ⚠️ 动态 import 必须带 ?ts=（沿用 impl 自身的 ts）：静态相对于 ESM 会按**无参 URL**
   *    永久缓存（P16 实测踩过），改 effort.mjs 后将无法随插件 toggle 热换。
   *    impl 的 ts 由 entry.mjs 按「mtime + 激活序号」构造 ⇒ 每次 toggle 必变 ⇒ effort 同批换新。 */
  const IMPL_TS = (() => {
    try { return new URL(import.meta.url).searchParams.get('ts') || String(Date.now()); } catch { return String(Date.now()); }
  })();
  let defineToolFn = null; // 官方 defineTool（工具定义器），由 loadDefineTool 异步填充
  let effortApi = null; // effort.mjs 实例（异步就绪）
  const effortReady = import(`./effort.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      effortApi = m.createEffort({
        svc, tryOf, pick, msg, log, state,
        /* schedule 用箭头包装：该 const 在当前位置仍处 TDZ，直接取引用会在建对象时抛
         * ReferenceError；调用时机晚于 apply，包装后安全。 */
        schedule: (reason, delay) => schedule(reason, delay),
        readCfg: () => ({ enabled: M3.effortEnabled === true, cooldownMs: M3.effortCooldownMs }),
        getDefineTool: () => defineToolFn,
      });
      return effortApi;
    })
    .catch((e) => {
      log('warn', `智能思考模块加载失败（吞，该功能不可用，主流程不受影响）：${msg(e)}`);
      return null;
    });

  /* 官方 defineTool 异步解析；就绪后若开关已开则补注册（开关关闭时不注册——完全不介入）。 */
  loadDefineTool()
    .then(({ defineTool: fn, via, probe }) => {
      defineToolFn = fn;
      state.m3.effortToolLoader = { at: new Date().toISOString(), via, ok: !!fn, probe: probe.slice(-4) };
      if (!fn) {
        log('warn', '智能思考 defineTool 不可达 ⇒ 换档工具不注册（主流程不受影响）');
        return;
      }
      try { mergeConfig(); } catch { /* 吞 */ }
      if (M3.effortEnabled === true) effortReady.then((api) => api?.ensure());
    })
    .catch((e) => log('warn', `智能思考 defineTool 解析异常（吞）：${msg(e)}`));

  /**
   * 智能思考懒安装入口 —— **独立于 M2 注入分支**（R3-S4 的结构性修复）。
   * 由 pre-step 的**最前面**调用（新建会话时另由 session/created 兜底）：幂等、无副作用，
   * 开关关闭时内部直接返回。
   * ⚠️ 历史真 bug：该调用曾塞在 M2 注入分支内、且在 `step !== 1` 早退**之后** ⇒
   *    一轮首步就调工具时，后续 pre-step 的 step 恒 > 1 ⇒ 钩子永远装不上
   *    ⇒ 工具接受成功却永不变档（实测 effortToolCalls=1、effortSwitches=0、effortHooks 从未赋值）。
   */
  const ensureEffort = async () => {
    try {
      mergeConfig();
      if (M3.effortEnabled !== true) return false;
      const api = await effortReady;
      return api ? api.ensure() : false;
    } catch (e) {
      log('warn', `智能思考懒安装异常（吞）：${msg(e)}`);
      return false;
    }
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
        hudPollReq: state.m5.hudPollReq ? { ...state.m5.hudPollReq } : null, // getHud 最近一次请求/响应摘要（取证）
      },
      m55: {
        armed: state.m55.armed ? { ...state.m55.armed } : null,
        attempts: state.m55.attempts.slice(-10).map((a) => ({ ...a })),
        channelProbe: state.m55.channelProbe ? { ...state.m55.channelProbe } : null,
      },
    };

    for (const k of ['tokenMeter', 'sessions', 'agents', 'systemPrompt', 'compaction', 'llm', 'sessionProjections', 'sessionQuery', 'configEditor', 'sessionController', 'typertGateway',
      // 智能思考：换档工具的注册面——tools 服务必须可达且 register 可调用
      'tools']) {
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
      if (!snap.m5.hudPoll) {
        /* C-lineage 运行时取证：getHud 同款链路逐状态落盘——记录不显示时从这里定位断点
         * （acts 是否加载 / 血统链多大 / 首 agent 的 sid 是否在链上 / 过滤命中几条）。 */
        const asid = String(pick(a?.session?.id, a?.sessionId, a?.id, ''));
        const chain = new Set();
        let cur = asid;
        let g = 0;
        while (cur && !chain.has(cur) && g < 16) { chain.add(cur); cur = state.m5.lineage?.[cur]; g++; }
        snap.m5.hudPoll = {
          at: new Date().toISOString(),
          lastSid: state.m5.lastSid ? String(state.m5.lastSid).slice(0, 24) : null,
          lineageSize: Object.keys(state.m5.lineage ?? {}).length,
          actsCount: state.m5.acts.length,
          agentSid: asid.slice(0, 24) || null,
          chainSize: chain.size,
          chainHeads: [...chain].slice(0, 4).map((x) => x.slice(8, 24)),
          matched: state.m5.acts.filter((x) => chain.has(x.sid)).length,
        };
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
      if (!effEnabled()) return; // 总开关活读（演习模式已随 2026-10-07 面板精简退役：压缩路径无影子模式）
      const { agent, signal } = payload ?? {};
      if (!agent?.session) return;
      /* A5（审查）：signal 缺失守卫——compactIfNeeded 契约首行 throwIfAborted(signal)，undefined 放行=首跑即败
       * （M5.5 通道 A 已实证同款）。payload 未带 signal 时兜底 180s 超时信号（与 idle compactNow 同参）。 */
      const sig = signal && typeof signal === 'object' ? signal : AbortSignal.timeout(180_000);
      if (sig.aborted) return;
      const sid = String(pick(agent.session.id, agent.sessionId, agent.id, 'unknown'));
      noteSessionId(sid); // C-lineage：轮转边记录（pre-step 每轮必经）
      const mr = measureRatio(agent.session); // B2：读取收敛
      if (!mr.ok || mr.ratio == null) return;
      const ratio = mr.ratio;
      /* C-own：生效强制线 = min(用户配置, 引擎阈值)——插件线必须先行，引擎只作卸载后的安全网 */
      const effCritical = Math.min(M3.criticalRatio, engineThreshold(agent));
      if (ratio < effCritical) return; // 关键词通道已裁撤（用户决定）：pre-step 仅剩 critical 兜底
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
      const code = e?.code ?? e?.name ?? 'error';
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

  /* ---- M2.5 新会话一次性插件说明：让任何新会话的 Agent 不靠外部文档就明白压缩流程与用法 ----
   * A3（审查）：由冻结常量改为函数——原实现 apply 期拼死 M3.marker 与「85%」字样，config 热改后
   * 说明文本与活值检测（事件解析/政策卡）自相矛盾；现每次注入现拼活值。 */
  const renderBrief = () => [
    '【context-pilot 插件说明（本会话仅此一次）】每轮开头的「Context usage」行就是本插件在测量上下文占用。',
    '占用达到阈值时，该行下方会附「压缩决策卡」：若接下来的任务不依赖更早的对话细节，可本轮挂起——写一行「待执行：<任务>」，并在回复最后一行单独写 ' + M3.marker + '；',
    '回合结束后插件自动压缩上下文（旧对话收为摘要），并自动拉起新一轮让你继续该任务（以「(context-pilot 自动恢复)」开头），用户无需重发。',
    '若任务依赖细节则照常执行、勿写标记；占用达 ' + Math.round(M3.criticalRatio * 100) + '% 强制压缩线时系统自动压缩。标记不要连续多轮写（压缩后占用需重新累积）。',
  ].join('');

  /* 智能思考的**注入文本**（一次性教学 / 每轮后缀）已随功能域搬入 plugin/effort.mjs：
   *   renderBrief(eff)  —— 一次性教学，覆盖度 6/6（当前值/可选档/工具名+用法/何时该用/生效时机/代价）
   *   renderSuffix(eff) —— 每轮用量行后缀「思考强度 <当前实际档>」（≈7 token/轮）
   * 两者都是纯函数，缺信息时返回 null ⇒ 不注入、不打扰。此处只做出口引用（见下方注入主体）。 */

  state.listeners['agent/pre-step'] = addListener(
    'agent/pre-step',
    async (payload, next) => {
      /* 智能思考：懒安装**先于一切**（R3-S4：与 M2 注入分支彻底解耦，任何早退都影响不到它）。
       * 幂等 + 开关关闭时内部直接返回 ⇒ 放在最前面零成本。 */
      await ensureEffort();
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
        noteSessionId(sid); // C-lineage
        /* 智能思考：**独立门控**（effortEnabled），与压缩的 markerMinRatio 完全解耦——
         * 用户明确要求「全程允许」：低占用也必须能注入/换档（压缩的卡在低占用时是不注入的）。 */
        let eff = null;
        try {
          if (M3.effortEnabled === true && effortApi) eff = await effortApi.read(agent);
        } catch { /* 读档失败 ⇒ 不注入（绝不因新功能影响主流程） */ }
        const effSuffix = effortApi?.renderSuffix(eff) ?? null;
        const baseText = effSuffix ? `${r.text} ｜ ${effSuffix}` : r.text;
        if (effSuffix) state.m2.effortSuffixes = (state.m2.effortSuffixes ?? 0) + 1;
        const brief = briefedBySid.has(sid) ? null : renderBrief(); // M2.5+A3：现拼活值
        /* 思考强度教学与「插件说明」同一时机（会话首次）——合并进同一条消息，
         * 不额外增加消息结构开销（role 框架/JSON 包装各一次）。 */
        const effBrief = eff && !effBriefedBySid.has(sid) ? (effortApi?.renderBrief(eff) ?? null) : null;
        if (effBrief) {
          effBriefedBySid.add(sid);
          state.m2.effortBriefings = (state.m2.effortBriefings ?? 0) + 1;
        }
        if (brief) {
          briefedBySid.add(sid);
          state.m2.briefings = (state.m2.briefings ?? 0) + 1;
        }
        const fullText = [baseText, card, brief, effBrief].filter(Boolean).join('\n\n');
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
    /* 智能思考：新会话的 agent/request 钩子必须补装（新会话自动覆盖）。此处只是提前一发，
     * 真正的保证在 pre-step 最前面 —— 那条路径不可能被任何早退绕过。 */
    ensureEffort().catch(() => {});
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
      noteSessionId(sid0); // C-lineage
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
      if (!effEnabled()) return; // 总开关活读（演习模式已随 2026-10-07 面板精简退役：压缩路径无影子模式）
      const sid = String(pick(agent?.session?.id, agent?.id, 'unknown'));
      noteSessionId(sid); // C-lineage
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
        /* C-own：safety-net 同样钳到引擎阈值之下（同 pre-step，理由见 engineThreshold） */
        if (d.ratio < Math.min(M3.criticalRatio, engineThreshold(agent))) return; // safety-net：仅 critical
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
          /* R1：压缩成功 ⇒ 一次性说明（压缩流程 + 智能思考教学）已随旧对话被收走，
           * 清除「已讲」标记让下一轮重讲一次（否则模型永久失去用法说明）。 */
          clearBriefed(sid);
          maybeResumeAfterMarker(sid, reason); // M5.5：标记压缩成功 → 自动投递恢复提示
          log('info', `M3 idle 扫除完成：${result ? `shadowed ${result.shadowedSeqs?.length ?? '?'} nodes / ~${result.shadowedTokenCount ?? '?'} tokens` : 'null（无可压区间）'}`);
          schedule('m3-act', 500);
        })
        .catch((e) => {
          const code = e?.code ?? (e?.name === 'ManualCompactionError' ? 'ManualCompactionError' : 'error');
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

  /* ---- M3.6：模型回复尾部标记 → idle 自动压缩 ═══════════
   * 事件通道 compaction-basic 官方同款（ctx.on("session/event")，event.type==='assistant/message'）。
   * 解析到标记即武装；竞态处理：消息事件可能晚于 status→idle，武装时查 agent.status，
   * 已 idle 则直接触发扫除。用户零输入——标记本身在回复里可见（透明）。 */
  state.listeners['session/event'] = addListener('session/event', (session, event) => {
    try {
      /* 此处**不再**解析任何换档文本标记——换档已改为工具 set_reasoning_effort
       * （实现见 plugin/effort.mjs，设计见 docs/r2-tool-switch-design.md）。
       * 移除标记方案的理由（用户 2026-10-08 决定）：① 标记写在回复末尾 ⇒ 本轮已结束
       * ⇒ 档位要等用户下次说话才生效（「需要我再发起才能触发，这个就失去意义了」）；
       * ② 工具方案同轮生效，且参数结构化、无「散文提及误触发」风险。 */
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
        /** sid 可选：传会话 id 则返回该会话（含血统链）的最近压缩；空=全局。
         *  **同时**返回全局最近记录（actsGlobal/hudLastActGlobal）作兜底——实测多会话交错/ id 摆动时
         *  按 id 过滤会空（用户「记录经常丢失」的最终根因），client 侧按「本会话优先、全局兜底」显示并标注。 */
        onGetHud: async (sid) => {
          const list = Array.isArray(state.m5.acts) ? state.m5.acts : [];
          /* C-lineage：按会话血统链匹配——当前 sid + 沿 lineage 回溯的全部历史前身 id。
           * 仅按当前 id 过滤会在压缩轮转后误判「无记录」。 */
          const chain = new Set();
          let cur = sid;
          let guard = 0;
          while (cur && !chain.has(cur) && guard < 16) { chain.add(cur); cur = state.m5.lineage?.[cur]; guard++; }
          const filtered = sid ? list.filter((a) => chain.has(a.sid)) : list;
          /* ⚠️ 2026-10-07 真根因修复：agents/sess 必须提到 onGetHud 作用域。
           * 原实现在下方 occ IIFE 内部声明 agents，而 criticalCap 在 IIFE 外引用它
           * ⇒ 每次 getHud 抛 ReferenceError("agents is not defined") ⇒ client 永远拿不到数据，
           * 弹窗恒「本会话暂无压缩记录」。此前追的会话 id/血统链理论都在修一条走不到的路径。 */
          const agents = svc('agents')?.list?.() ?? [];
          const sess = svc('sessions')?.list?.() ?? [];
          /* R1：思考强度的目标 Agent（有 sid 用该会话，否则首个）+ 开关活读（关闭则不返回，UI 不显示） */
          const targetAgent = (sid && agents.find((x) => String(pick(x?.session?.id, x?.sessionId, x?.id)) === sid)) || agents[0] || null;
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
          const resp = {
            ok: true,
            ...state.m5.hud,
            hudLastAct: filtered[0]?.text || '',
            acts: filtered.slice(0, 8).map((a) => a.text),
            /* 全局兜底（client 按「本会话优先」消费；仅当本会话过滤为空时回退显示并标注） */
            hudLastActGlobal: list[0]?.text || '',
            actsGlobal: list.slice(0, 8).map((a) => a.text),
            sessionMatched: filtered.length,
            occupancyRatio: occ.ratio,
            occupancyWindow: occ.window,
            /* C-own：生效强制线上限（用户配置与引擎阈值取小）——client 保存时钳制用。
             * 引擎阈值与具体会话无关（服务实例级配置），但解析需一个 agent 作用域 ⇒ 有 sid 用该会话，否则用首个 agent。
             * ⚠️ 2026-10-07 修：这里必须传 **Agent 本体**，不能传 `agent.session`——resolveCompactionFor
             * 走 `agent.ctx.get('compaction')` / `agentPresets.serviceFor(agent,'compaction')`，
             * 传 Session 两者都不认 ⇒ 返回 unresolved ⇒ criticalCap 恒为 fallback 0.8。
             * 实测证据：getHud（5s 轮询）写入的 engineCapProbe 全部 `via:unresolved, fallback:true`
             * （时间戳与 hudPollReq 逐次吻合），而 pre-step/快照（传 Agent）全部
             * `via:agentPresets.serviceFor, ratio:0.8, fallback:false`。当前引擎阈值恰为 0.8
             * 故无可见差异，但引擎阈值被改时 client 会拿到错误的 cap。 */
            criticalCap: engineThreshold(targetAgent),
            /* 智能思考（effort）：供输入框 chip 显示「智能思考档位 <当前档>」+ 换档冷却。
             * ⚠️ R3-S9：**开关状态与数据分离**。原先 client 靠 `effort.ok` 推断「功能是否开启」，
             * 但 `effort.ok=false` 既可能是「开关关闭」也可能只是「读档失败」，两者语义不同。
             * 现显式返回 effortEnabled 布尔 + effort 数据（开关关闭时为 null）。
             * 冷却返回**绝对时间戳** cooldownUntil（而非剩余毫秒）：client 可本地倒计时，
             * 且 getHud 是低频调用（挂载 + 投影变化各一次），绝对值不会因调用间隔而过时。 */
            effortEnabled: effOn,
            effort: effOn && effortApi ? await effortApi.hudPayload(targetAgent, sid) : null,
            at: new Date().toISOString(),
          };
          /* getHud 取证（2026-10-07）：记录不显示时从报告直接看「client 传了什么 sid、host 回了什么」——
           * 这是本轮定位「按 id 过滤恒空」的关键手段，保留为常驻取证字段（只存摘要，不落全量）。 */
          try {
            state.m5.hudPollReq = {
              at: resp.at,
              sid: sid ? String(sid).slice(0, 24) : null,
              chainSize: chain.size,
              sessionMatched: filtered.length,
              actsCount: list.length,
              hudLastAct: resp.hudLastAct || null,
              hudLastActGlobal: resp.hudLastActGlobal || null,
            };
          } catch { /* 吞 */ }
          return resp;
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
