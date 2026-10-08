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
  markerMinRatio: 0.2, // 智能压缩线：**决策卡注入门槛**（2026-10-07 起与「模型可自行决定压缩」统一）
  // policyCardMinRatio / highRatio / lightTaskChars 已于 2026-10-07 退役（用户决定）：
  //   - 决策卡门槛 = markerMinRatio（消除「卡未教/标记不可达」死区）
  //   - highRatio/lightTaskChars 是「高风险+轻任务建议压缩」的旧审计参数，决策主体移交模型后已无触发作用
  /* R7（2026-10-08）**marker 通道整体退役**：`marker`（回复尾行文本标记）与 `armedTtlMs`（标记有效期）
   * 随「工具触发压缩」（R4）一并删除——R4 起压缩由模型调用 `compact_context` 触发，
   * 标记既无教学（三处教学已改工具版）也无执行路径，留着只是永不命中的死通道 + 无界 Map。
   * ⚠️ `markerMinRatio` **必须保留**：它同时是决策卡注入门槛，与标记无关。 */
  sweepMinIntervalMs: 600_000, // 强制压缩冷却：两次兜底压缩的最小间隔
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

/** 错误码归一（D7 审查）：pre-step 与 idle 两条压缩路径原先各自分类，同一个失败会在
 *  `preStepErrors` / `actErrors` 里落成不同的键 ⇒ 收敛为一个口径（`code` → `name` → 'error'）。 */
const errCodeOf = (e) => e?.code ?? e?.name ?? 'error';

/** 有界 Set（C 类审查：`briefedBySid` / `effBriefedBySid` / `measuredFailedOnce` 原先无上限，
 *  键是 session id ⇒ 随会话数无界增长）。超限丢最旧的键；被淘汰的会话最多多讲一次说明，无害。 */
const SET_CAP = 200;
const remember = (set, key) => {
  try {
    set.add(key);
    if (set.size > SET_CAP) set.delete(set.values().next().value);
  } catch { /* 吞：有界化不影响主流程 */ }
};

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
      /* R7：`marker` / `armedTtlMs` 已随 marker 通道退役移出读取集——
       * 读取集必须与 M3_DEFAULTS 保持同一集合，否则「面板改了不生效」会重演。 */
      for (const k of ['enabled', 'effortEnabled', 'criticalRatio', 'markerMinRatio', 'sweepMinIntervalMs', 'effortCooldownMs']) {
        raw[k] = live(config[k]);
      }
      if (typeof raw.enabled === 'boolean') M3.enabled = raw.enabled;
      if (typeof raw.effortEnabled === 'boolean') M3.effortEnabled = raw.effortEnabled;
      /* F10（审查）：比率必须 **> 0**（原先是 `>= 0`）。填 0 不是「关闭」而是**瘫痪**：
       * `criticalRatio: 0` ⇒ 每个 pre-step 都判「越强制线」；`markerMinRatio: 0` ⇒ 决策卡恒注入。
       * schema 无 `.min()`、面板只拦空串 ⇒ 这里必须挡住（非法值保持上一次的有效值）。 */
      for (const k of ['criticalRatio', 'markerMinRatio']) {
        if (typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k] > 0 && raw[k] <= 1) M3[k] = raw[k];
      }
      for (const k of ['sweepMinIntervalMs', 'effortCooldownMs']) {
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
  /* C-lineage 会话血统链 —— ❌ 2026-10-08 已整体移除（连同 noteSessionId / state.m5.lineage /
   * state.m5.lastSid / hud-acts.json 的 lineage 键 / m5.hudPoll.lineageSize）。
   *
   * 移除依据（两条独立证据，均来自一手会话存盘）：
   * ① **前提被证伪**：血统链的前提是「DSH 压缩会轮转 session id」。但本会话
   *    12:51、18:25、18:45 三次压缩**全部**记录在同一个 sid（session-16616c07…）下
   *    ⇒ 压缩并不换 id，「按当前 id 过滤永远匹配不上」是误判。
   * ② **它自己制造 bug**：链的建立规则是「sid 一变就连一条边」，而多对话下 UI 的
   *    `NS.sid` 会漂移到别的会话 ⇒ 生成跨会话假边，实测已成环：
   *      { f4154f01→16616c07, cb8d115e→f4154f01, 16616c07→f4154f01（回边）, 899bfaca→16616c07 }
   *    从 16616c07 回溯得 { 16616c07, f4154f01 } ⇒ 命中 4/5 条，把 `keysion-dac-vue`
   *    workspace 里**另一个对话**的压缩记录显示进了本会话弹窗（用户实测反馈）。
   *
   * 教训：用「启发式推断的关联」去补「以为丢了的记录」，会把别的对象的数据当成自己的。
   * 现在 getHud 严格按 sid 精确匹配；匹配不到就如实显示「本会话暂无压缩记录」。 */

  /* ---- M5.5「任务挂起-自动恢复」**已整体退役**（R4 删投递链，R7 删剩余残留）----
   *  旧闭环：任务进来 → 模型判断需先压缩 → 本轮不执行、回复写「待执行：<任务>」+ 标记 →
   *  idle 自动压缩 → host 用 `sessionController.prompt()` 直发一条**用户消息**拉起会话 →
   *  agent 以压缩后上下文继续执行原任务。
   *  ⚠️ 用户否决了其中「伪造一条我的信息重新拉起会话」这一步（R4）；
   *  而**投递链一断，整个闭环就没有存在意义**——压缩不再需要「拉起」，因为工具调用
   *  （`compact_context`）本身就保证有下一步、本轮自然继续。
   *  ⇒ R7 把最后三块残留一并删除：`lastUserTextBySid`（挂起任务的兜底文本来源）、
   *     `pendingBySid`（挂起任务表，R4 后**读点为零**）、`m55Attempt` / `state.m55`（只为旧
   *     恢复相位留痕）。保留 `clearBriefed` 与 `briefedBySid`（与压缩重讲逻辑有关，与 M5.5 无关）。 */
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
  /* `resumeCountBySid` / `M5_RESUME_MAX` / `resumeTimers` 已随伪造恢复投递链一并删除（R4）；
   * `m55Attempt` / `state.m55` 已随 M5.5 收官残留删除（R7，见上方说明）。 */
  /* R7：`probeService`（服务可达性 + 原型方法名探针）已删除——**全仓库零调用点**。
   * 它的职责先是服务在位枚举，后被 `snap.services[k] = svc(k) ? typeof svc(k) : 'absent'` 取代，
   * 之后一直没人调用（连带 `state.m3.probe` 恒为 null，一并删除）。 */
  /* ❌❌ M5.5「压制后伪造恢复」投递链 —— **2026-10-08 R4 整体删除** ❌❌
   *
   * 删除位置：`maybeResumeAfterMarker`（2s 定时调度 + 上限计数 + 待执行徽章）
   *          `resumeViaAnyChannel`（通道 A `sessionController.prompt` → B `ctx.remote.session.prompt`
   *           → C `createUserMessage` + `agent.followup("next-turn")`）。
   *
   * 删除依据（用户明确要求）：「自动压缩时，**不用伪造一条我的信息**重新拉起会话」。
   * 三个通道的最终落点都是 `createUserMessage({ content, source: { kind: 'user', … } })`
   * ⇒ 无论走哪条，都是**替用户发言**：UI 上表现为一条用户消息，语义上等于用户重新下了任务。
   *
   * 替代方案：模型主动调工具 `compact_context` ⇒ 下一步 pre-step 轮内压缩 ⇒ 本轮无缝继续，
   * **零消息**（不注入、不投递、不恢复）。源码依据与「为什么不能只改投递方式」见
   * plugin/compact-tool.mjs 文件头（inbox 只有 next-turn/next-step 两个队列且载荷类型是
   * UserMessage；system/developer 消息只写对话不唤醒 agent；steer 仍是用户消息且 idle 后不可用）。
   *
   * R7：**marker 通道已一并退役** ⇒ `state.m55` / `m55Attempt` / `markerArmed` / `pendingBySid` /
   *     `lastUserTextBySid` 全部删除（投递链一断，整个「挂起-恢复」闭环就没有存在意义）。
   *     `resumeTimers` 的卸载清理（空集合无害）保留。 */

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
      acts: 0,
      actOk: 0,
      lastAct: null,
      actErrors: {},
      /* ⚠️ 2026-10-08：压缩失败的错误**正文**（此前只记错误码，报告无法定位——
       * 实测 actErrors={summary:2} / preStepErrors={INVALID_REQUEST:17} 而两条路径成功均为 0） */
      lastActError: null,
      lastPreStepError: null,
      sweeps: {},
      // M3.5 三通道
      preStepActs: 0,
      preStepOk: 0,
      lastPreStep: null,
      preStepErrors: {},
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
      /* 智能压缩「工具触发」（R4）取证 —— 替代旧 marker + 伪造恢复链路。
       * 意图登记（工具侧）与消费（pre-step 侧）都必须留痕：这条链路一旦静默，
       * 就会重演「工具接受成功却永不生效」那类无从定位的故障。 */
      compactTool: null, // 工具注册结果
      compactToolDiag: { calls: 0, at: null, enabled: false, installed: false, intents: 0, error: null },
      compactToolCalls: 0,
      lastCompactTool: null, // 最近一次工具登记（sid/reason/repeated）
      compactIntents: 0, // pre-step 消费意图次数
      compactIntentExpired: 0, // 意图过期作废次数（登记后未被消费）
      /* R7/F5 诊断：本 sid 查不到意图、但表里还有**别的 sid** 的未过期意图时落痕
       * （session id 轮转 ⇒ 意图登记在旧键 ⇒ 工具回了 scheduled 但压缩永不发生）。 */
      compactIntentMiss: null,
      lastCompactIntent: null, // 最近一次消费详情（trigger/ratio/acted/shadowedTokens/ms + R5 rangeSource）
      /* R5：最近一次**自选范围**读数（预算/起点/终点/保留·影子 token/失败原因）。
       * 范围算错时这是唯一现场：报告里没有它就只剩「压了个奇怪的东西」这一句现象。 */
      rangeProbe: null,
    },
    // M5 HUD 发布取证（entry 查找/edit 结果全程留痕——弹窗侧空态无法区分静默失败）
    // hud.gen = 实例指纹：客户端取到的 gen 应与本实例一致；不一致 = RPC 打到了旧激活的僵尸面
    // acts = 最近压缩记录（按会话可过滤，新→旧，cap 8）：主行显示最新，悬停展开列表
    // R7：`hudArmed` / `hudPending` 已随 marker 通道退役——它们是「武装灯/待执行徽章」的数据源，
    //     两个徽章删掉后这两条链**写而无人读**（host 6 处写 → client 0 处读）。
    m5: { lastPublish: null, hud: { hudLastAct: '', gen: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }, hudFace: 'absent', acts: [] },
  };
  /* R8 解耦第一刀：`engineThreshold` / `criticalCapOf` / `resolveCompactionFor` 及其常量
   * （`DEFAULT_ENGINE_THRESHOLD` / `ENGINE_CAP_MARGIN`）**已整体搬进 plugin/threshold.mjs**。
   * 搬迁理由与「为何先抽这一个」见该文件头；`criticalCapOf` 被 M1/M2/M3/M5 四处复用的局面
   * 由此收敛为一个叶子模块。宿主只保留**懒加载 + 三个同名转发**（见下方 IMPL_TS 之后）。 */

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

  /* ═══════════ 阈值核心（R8 解耦第一刀）═══════════
   * `engineThreshold` / `criticalCapOf` / `resolveCompactionFor` 的**实现**已搬进
   * plugin/threshold.mjs（为何先抽这一个、搬迁顺序见该文件头）。
   * ⚠️ 这里**不能 `await`**：宿主 `apply` 不是 async，而 `criticalCapOf` 被 getHud（RPC 面）、
   *    报告快照、两条压缩路径**同步**调用 ⇒ 用与 effort/compact-tool 同款的「懒加载 + 空值降级」。
   * 降级语义（模块未就绪，实测只在激活后头几个微任务内）：**不做上限钳制**（上限返回 1），
   * 于是生效线 = 用户配置值（等价于 R5 之前的行为），并留一条痕。绝不中断激活。 */
  let thresholdCtl = null;
  const thresholdReady = import(`./threshold.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      thresholdCtl = m.createThreshold({ svc, tryOf, state, log });
      return thresholdCtl;
    })
    .catch((e) => {
      log('warn', `阈值核心模块加载失败（吞，压缩线退化为「不做 5pp 钳制」）：${msg(e)}`);
      return null;
    });
  const NO_CAP = 1; // 降级时的「无上限」：min(配置, 1) = 配置
  const criticalCapOf = (agent) => (thresholdCtl ? thresholdCtl.criticalCapOf(agent) : NO_CAP);
  const engineThreshold = (agent) => (thresholdCtl ? thresholdCtl.engineThreshold(agent) : NO_CAP);
  const resolveCompactionFor = (agent) =>
    (thresholdCtl
      ? thresholdCtl.resolveCompactionFor(agent)
      : { service: null, via: 'threshold-module-pending', probe: {} });

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

  /* ═══════════ 智能压缩「工具触发」（R4，2026-10-08）═══════════
   * 目的：**自动压缩不再伪造用户消息重新拉起会话**（用户明确要求）。
   * 机制：模型调 compact_context ⇒ 登记「下一步压缩」意图 ⇒ 宿主 pre-step 消费并执行轮内压缩
   *       ⇒ 本轮无缝继续。全程零消息（不注入、不投递、不恢复）。
   * 源码依据与替代方案取舍见 plugin/compact-tool.mjs 文件头。 */
  let compactToolApi = null;
  const compactToolReady = import(`./compact-tool.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      compactToolApi = m.createCompactTool({
        svc, tryOf, pick, msg, log, state,
        schedule: (reason, delay) => schedule(reason, delay), // 同 effort：避免 const TDZ
        readCfg: () => ({ enabled: M3.enabled === true }),
        getDefineTool: () => defineToolFn,
      });
      return compactToolApi;
    })
    .catch((e) => {
      log('warn', `智能压缩模块加载失败（吞，该功能不可用，主流程不受影响）：${msg(e)}`);
      return null;
    });

  /* ═══════════ 保留范围自选（R5，2026-10-07 E2E 之后）═══════════
   * 动机（真机实测，非推测）：E2E 查明 `context-overflow` 的 `retainTokens = 0` 在 **53% 占用**时
   * 就把 surface 从 **1117 节点 / 367,794 token** 砍到 **4 节点 / 8,603 token**。
   * 引擎另有公开方法 `compactRegion(start, end, agent, signal)` ⇒ 范围可由我们给。
   * 取舍、边界重试为何安全、为何不复刻内部配对函数：见 plugin/compact-range.mjs 文件头。
   * 同款 ?ts= 热替换约定（漏掉会在 ESM 里按无参 URL 永久缓存）。 */
  let rangeApi = null;
  const rangeReady = import(`./compact-range.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      rangeApi = m;
      return m;
    })
    .catch((e) => {
      log('warn', `保留范围模块加载失败（吞，回退官方保留策略）：${msg(e)}`);
      return null;
    });

  /** 智能压缩工具懒安装入口（由 pre-step 最前面调用；幂等；总开关关闭时内部直接返回）。 */
  const ensureCompactTool = async () => {
    try {
      mergeConfig();
      if (M3.enabled !== true) return false;
      const api = await compactToolReady;
      return api ? api.ensure() : false;
    } catch (e) {
      log('warn', `智能压缩懒安装异常（吞）：${msg(e)}`);
      return false;
    }
  };

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

  /* 官方 defineTool 异步解析；就绪后若开关已开则补注册（开关关闭时不注册——完全不介入）。
   * ⚠️ 本块必须放在 effortReady / compactToolReady **之后**：回调里引用这两个 const。
   *    微任务语义下「晚于同步求值」本就不会真 TDZ，但把声明排在引用之前才不依赖这个巧合。 */
  loadDefineTool()
    .then(({ defineTool: fn, via, probe }) => {
      defineToolFn = fn;
      state.m3.effortToolLoader = { at: new Date().toISOString(), via, ok: !!fn, probe: probe.slice(-4) };
      if (!fn) {
        log('warn', 'defineTool 不可达 ⇒ 换档/压缩工具均不注册（主流程不受影响）');
        return;
      }
      try { mergeConfig(); } catch { /* 吞 */ }
      if (M3.effortEnabled === true) effortReady.then((api) => api?.ensure());
      if (M3.enabled === true) compactToolReady.then((api) => api?.ensure());
    })
    .catch((e) => log('warn', `defineTool 解析异常（吞）：${msg(e)}`));

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

  /* R7：`decideCompaction` 已删除。
   * 它原本服务三个调用点（inbox 审计 / idle 兜底 / pre-step），但审计监听器与决策主体都已退役，
   * 只剩下 idleSweep 读它的 `ok`/`ratio`——其余产物（`compact`/`reason`/`used`/`window`）全部无消费者，
   * 且文档还停在「决策主体是模型标记」的旧语义。现在 idleSweep 直接调 `measureRatio`，
   * **少一层间接、少一套会漂移的语义**。 */

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
      /* R8 修（审查发现的**取证静默丢失**）：满环时优先淘汰**最旧的 slim 条目**，而不是无差别砍最旧的。
       * 现场：报告 120 条**全是 slim、full 0 条** —— heartbeat(120s) / agent/status / m5-publish(400ms 防抖) /
       * m2-inject 这些高频 slim 事件把 FULL 条目（activation / m3-act / m4-probe / boot+10s）
       * **挤出环形缓冲**，而 FULL 档位恰是「压缩到底成没成」的唯一留档位置。
       * 而 report.mjs 的 `mustFull` 断言只检查那些 reason**不在 SLIM 名单里**，
       * 从不检查它们**真的还在历史里** ⇒ 断言全绿、证据已丢。两处一起修。 */
      const next = [...(data.history || []), entry];
      while (next.length > HISTORY_CAP) {
        const slimIdx = next.findIndex((e) => e?.profile === 'slim');
        next.splice(slimIdx === -1 ? 0 : slimIdx, 1); // 没有 slim 可淘汰时退化为「砍最旧」
      }
      data.history = next;
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
        lastAct: state.m3.lastAct ? { ...state.m3.lastAct } : null,
        lastPreStep: state.m3.lastPreStep ? { ...state.m3.lastPreStep } : null,
        compactIntentMiss: state.m3.compactIntentMiss ? { ...state.m3.compactIntentMiss } : null,
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
        /* getHud 链路运行时取证：记录不显示时从这里定位断点
         * （acts 是否加载 / 首个 agent 的 sid 是什么 / 精确匹配命中几条）。
         * 2026-10-08：血统链退役后，匹配口径与 getHud 完全一致 = **按 sid 精确相等**。 */
        const asid = String(pick(a?.session?.id, a?.sessionId, a?.id, ''));
        snap.m5.hudPoll = {
          at: new Date().toISOString(),
          actsCount: state.m5.acts.length,
          agentSid: asid.slice(0, 24) || null,
          matched: state.m5.acts.filter((x) => x.sid === asid).length,
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

  /* ═══ R11 解耦第三刀：M5 HUD 域（存储 / 发布 / 文案 / 聚合响应 / 回填）已搬进 plugin/m5.hud.mjs ═══
   * 顺序依据：R10 之后 M3 的 deps 里出现了 publishHud / recordHudAct / formatAct 三项
   * ⇒ **被依赖者必须先独立**（顺序 M5 → M2 → M1 → core）。
   * 模块是「跨域聚合视图」（getHud 要同时回答压缩历史 / 占用 / 生效上限 / 思考档位），
   * 故四条跨域依赖全部注入：criticalCapOf（R8 阈值）、mergeConfig+M3（M3 配置）、getEffortApi、
   * 以及 measureRatio —— 它的宿主委托在下方 M3 接线处才声明，为**打破声明顺序环**这里用箭头包装
   * （M3 需要 M5 的三个回调、M5 需要 M3 的 measureRatio，两个接线块谁在前都会 TDZ；
   *  箭头延迟到运行时取，两个 const 届时都已初始化）。
   * 懒加载 + 空值降级：未就绪时三个发布口静默 no-op（几微秒窗口），getHud 返回明确错误。
   * ⚠️ `pluginDir` 由 entry 注入 ⇒ hud-acts.json 仍落 plugin/.data/（路径未变，历史不丢）。 */
  let m5Ctl = null;
  const m5Ready = import(`./m5.hud.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      m5Ctl = m.createM5Hud({
        state, log, msg, schedule, pluginDir,
        svc, pick, criticalCapOf, mergeConfig, M3,
        measureRatio: (session) => (m3Ctl ? m3Ctl.measureRatio(session) : { ok: false, error: 'm3-module-pending' }),
        getEffortApi: () => effortApi,
        getReportBase: () => loadReportBase(),
      });
      return m5Ctl;
    })
    .catch((e) => {
      log('warn', `M5 HUD 模块加载失败（吞，弹窗将无数据）：${msg(e)}`);
      return null;
    });
  const formatAct = (reason, tokens, at) => (m5Ctl ? m5Ctl.formatAct(reason, tokens, at) : '');
  const publishHud = (patch) => { if (m5Ctl) m5Ctl.publishHud(patch); };
  const recordHudAct = (sid, text) => { if (m5Ctl) m5Ctl.recordHudAct(sid, text); };
  const buildHudResponse = async (sid) => (m5Ctl ? m5Ctl.buildHudResponse(sid) : { ok: false, error: 'm5-module-pending' });
  const republishFromReport = () => (m5Ctl ? m5Ctl.republishFromReport() : undefined);

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
  /* F7（审查）：教学出口的异常**必须有痕**——`renderCard`/`renderBrief` 静默返回 null 等价于
   * 「模型永远不知道有 compact_context 这个工具」，是本机制最怕的静默降级。只报一次防刷屏。 */
  let teachWarned = false;
  const warnTeachOnce = (what) => {
    if (teachWarned) return;
    teachWarned = true;
    log('warn', `${what}（同类问题仅报一次）`);
  };

  /* R5+（2026-10-08 用户要求）：「自己算范围」必须教给 Agent——否则它不知道压缩后还剩什么。
   * ⚠️ 两个数都是**活值**：比例读 compact-range.mjs 的常量，token 数按**当前窗口**现算。
   *    写死「16% / 160k」会在常量或窗口变化后与真实行为自相矛盾（本项目已因此踩过坑）。
   * 模块未加载完时返回 null ⇒ 教学退化为「按窗口固定比例」的说法，**绝不编造数字**。 */
  const retentionTeach = (win) => {
    const ratio = rangeApi?.RETAIN_RATIO ?? null;
    if (!Number.isFinite(ratio) || ratio <= 0) return { retainRatio: null, retainTokens: null };
    const w = Number(win);
    return { retainRatio: ratio, retainTokens: Number.isFinite(w) && w > 0 ? Math.floor(w * ratio) : null };
  };

  const renderPolicyCard = (ratio, effCrit, win) => {
    /* 教学文本本体在 compact-tool.mjs（压缩域自持，与 effort 同构）——此处只做出口。
     * 门槛仍是 markerMinRatio（2026-10-07 用户决定：决策卡门槛 = 该值，消除「教了却不执行」的死区）。
     * ⚠️ 文本已随 R4 改写为**工具版**：旧卡教的是「本轮先不执行任务 + 写标记」，
     *    那正是会被伪造恢复消息拉起的那套；新卡要求「调用后直接继续，不要停下」。
     * ⚠️ 2026-10-08 真 bug：这里原先传 `M3.criticalRatio`（**配置值**），于是卡面写「占用达 80%」
     *    而实际生效线是 75%（= min(配置, 引擎阈值 − 5pp)）⇒ 教了个不会触发的数。
     *    现由调用方传入**生效值** effCrit。
     * ⚠️ R5+：同时传入「保留多少」的活值（见 retentionTeach）。 */
    try {
      const api = compactToolApi;
      /* F7（审查）：教学/卡片静默为 null = 模型**永远不知道有工具**——这正是 R4 机制最怕的
       * 静默降级。模块未就绪时留一条痕（只报一次，防刷屏）。 */
      if (!api) { warnTeachOnce('压缩教学模块未就绪：决策卡与一次性说明本次为空（模型将看不到压缩工具的用法）'); return null; }
      const crit = Number.isFinite(effCrit) ? effCrit : M3.criticalRatio;
      return api.renderCard({ ratio, minRatio: M3.markerMinRatio, criticalRatio: crit, ...retentionTeach(win) });
    } catch (e) { warnTeachOnce(`决策卡渲染异常：${msg(e)}`); return null; }
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
   *  - "context-overflow" 触发**绕过引擎阈值**：源码原文「bypasses the normal threshold and
   *    retained-tail policy so it can force one useful balanced reduction」，内部走
   *    selectCompactableRange(session, measurement, **0**) ⇒ 保留近端≈0（只留最后一个节点 + tool-pairing 回退）。
   *    ⚠️ 代价明确：这是唯一能低于阈值强制压缩的通道，但保留策略比引擎默认（retainRatio 0.16）激进得多。
   *  - compactNow 必须 idle（runMaintenance），轮内不可用——那是 idle 安全网专用。
   *  - ⚠️ R5（2026-10-08）：上面这条「overflow 保留近端≈0」不再是本函数的默认行为——现在**先自选范围**
   *    （保留预算 = 窗口 × M3.retainRatio），失败才沿用官方 overflow 兜底。见 compactWithOwnRange。 */

  /* ═══ R5：自选保留范围 + 官方兜底 ═══
   * 返回值：`{ result, source, skipWhy, retainBudget, walkBacks }`
   *   source ∈ 'own'（自选范围成功）| 'official'（沿用官方 overflow）| 'none'（判定无需压缩）
   * 异常语义：**非校验类错误一律上抛**（由 preStepCompaction 的 catch 统一记录）——
   *   摘要 LLM 失败、`busy`、abort 等重试/兜底都无意义（官方路径会同样失败）。 */
  /* ═══ R9/R10 解耦第二刀：M3 压缩域（执行核心 + 编排层）已整体搬进 plugin/m3.compact.mjs ═══
   * 跨域回调（`publishHud` / `recordHudAct` / `formatAct` / `clearBriefed`）与 `schedule`
   * 由宿主**显式注入**——R7 审计列的第二个解耦障碍（「靠闭包穿透别人的域」）就此消除。
   * ⚠️ 接线必须放在这里（而非文件前部的模块区）：`schedule` 在下方才定义，deps 对象是**立即构造**的，
   *    放前面会 TDZ。而 `measureRatio` 虽在更早的 `renderUsageText` 里被引用，但只要**调用发生在初始化之后**
   *    就不受 TDZ 约束（const 的 TDZ 只看运行时求值时刻）。
   * 依赖同样是「懒加载 + 空值降级」（宿主 apply 不是 async，不能 await）：
   * 未就绪时 `measureRatio` 返回 `{ok:false}` ⇒ 本轮不压（安全侧）；`compactWithOwnRange` 返回
   * `source:'none'`；两个编排入口直接 no-op 并留痕。实测窗口只在激活后头几个微任务内。 */
  let m3Ctl = null;
  const m3Ready = import(`./m3.compact.mjs?ts=${IMPL_TS}`)
    .then((m) => {
      m3Ctl = m.createM3Compaction({
        svc, tryOf, state, M3, effEnabled, criticalCapOf, resolveCompactionFor,
        log, msg, pick, nfmt, errCodeOf, schedule,
        publishHud, recordHudAct, formatAct, clearBriefed,
        /* range 模块与压缩工具的生命周期都由宿主拥有 ⇒ 交给模块 async 取用口。 */
        awaitRange: async () => rangeApi ?? (await rangeReady),
        getCompactTool: () => compactToolApi,
        COMPACT_TIMEOUT_MS, SET_CAP,
      });
      return m3Ctl;
    })
    .catch((e) => {
      log('warn', `M3 压缩域模块加载失败（吞，本轮不压）：${msg(e)}`);
      return null;
    });
  const measureRatio = (session) => (m3Ctl ? m3Ctl.measureRatio(session) : { ok: false, error: 'm3-module-pending' });
  const compactWithOwnRange = async (agent, compaction, ctx) =>
    (m3Ctl
      ? m3Ctl.compactWithOwnRange(agent, compaction, ctx)
      : { result: null, source: 'none', skipWhy: 'm3-module-pending', retainBudget: null, walkBacks: 0 });
  /** pre-step 轮内先压（M3.5 通道 1）：模块未就绪时 no-op 并留痕（绝不上抛）。 */
  const preStepCompaction = async (payload) => {
    if (!m3Ctl) { log('warn', 'M3 pre-step 先压：压缩域模块未就绪，本轮跳过'); return; }
    return m3Ctl.preStepCompaction(payload);
  };
  /** idle 安全网（M3-b）：模块未就绪时 no-op（下次状态翻转会再来）。 */
  const idleSweep = (agent) => {
    if (!m3Ctl) return;
    return m3Ctl.idleSweep(agent);
  };

  /* ---- M2.5 新会话一次性插件说明：让任何新会话的 Agent 不靠外部文档就明白压缩流程与用法 ----
   * A3（审查）：由冻结常量改为函数——原实现 apply 期拼死 M3.marker 与「85%」字样，config 热改后
   * 说明文本与活值检测（事件解析/政策卡）自相矛盾；现每次注入现拼活值。
   * ⚠️ R4（2026-10-08）：文本已改为**工具版**，且本体搬进 plugin/compact-tool.mjs（压缩域自持，
   *    与 effort.mjs 同构）。旧文本教的是「本轮挂起 + 写标记 + 压缩后自动拉起」——那条链路已被
   *    用户否决（伪造用户消息）；此处只做出口，漏改会导致模型**等一个永远不来的恢复**。 */
  const renderBrief = (effCrit, win) => {
    try {
      const api = compactToolApi;
      if (!api) { warnTeachOnce('压缩教学模块未就绪：一次性说明本次为空'); return null; }
      /* 同 renderPolicyCard：必须传**生效值**，否则一次性说明会教一个不会触发的数字；
       * 另传「保留多少」活值（R5+）。 */
      const crit = Number.isFinite(effCrit) ? effCrit : M3.criticalRatio;
      return api.renderBrief({ criticalRatio: crit, ...retentionTeach(win) });
    } catch (e) { warnTeachOnce(`一次性说明渲染异常：${msg(e)}`); return null; }
  };

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
      /* 智能压缩工具（R4）：同款懒安装——同样必须在早退之前，否则「工具接受了却没有人消费意图」
       * 会重演 R3 那个真 bug（工具成功、永不生效）。 */
      await ensureCompactTool();
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
            remember(measuredFailedOnce, key);
            log('warn', `M2 measure 失败跳过注入（${key}）：${r.error}`);
          }
          state.m2.skips.measureFail = (state.m2.skips.measureFail ?? 0) + 1;
          return decision;
        }
        /* 强制压缩线的**生效值**（= min(配置, 引擎阈值 − 5pp)）——教学与决策卡都必须教这个数，
         * 教配置值会让模型以为 80% 才触发（实际 75%）。与 pre-step/idle 门控同源。 */
        const effCrit = Math.min(M3.criticalRatio, criticalCapOf(agent));
        const card = renderPolicyCard(r.ratio, effCrit, r.window); // M3.5 通道2：政策卡（相关占用以上才出现）
        const sid = String(pick(agent.session.id, agent.sessionId, 'unknown'));
        /* 智能思考：**独立门控**（effortEnabled），与压缩的 markerMinRatio 完全解耦——
         * 用户明确要求「全程允许」：低占用也必须能注入/换档（压缩的卡在低占用时是不注入的）。 */
        let eff = null;
        try {
          if (M3.effortEnabled === true && effortApi) eff = await effortApi.read(agent);
        } catch { /* 读档失败 ⇒ 不注入（绝不因新功能影响主流程） */ }
        const effSuffix = effortApi?.renderSuffix(eff) ?? null;
        const baseText = effSuffix ? `${r.text} ｜ ${effSuffix}` : r.text;
        if (effSuffix) state.m2.effortSuffixes = (state.m2.effortSuffixes ?? 0) + 1;
        const brief = briefedBySid.has(sid) ? null : renderBrief(effCrit, r.window); // M2.5+A3：现拼活值（含生效强制线 + 保留范围）
        /* 思考强度教学与「插件说明」同一时机（会话首次）——合并进同一条消息，
         * 不额外增加消息结构开销（role 框架/JSON 包装各一次）。 */
        const effBrief = eff && !effBriefedBySid.has(sid) ? (effortApi?.renderBrief(eff) ?? null) : null;
        if (effBrief) {
          remember(effBriefedBySid, sid); // C 类审查：有界化（原先无上限）
          state.m2.effortBriefings = (state.m2.effortBriefings ?? 0) + 1;
        }
        if (brief) {
          remember(briefedBySid, sid); // C 类审查：有界化（原先无上限）
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
  /* ═══════════ M3-a：turn 前审计 —— **已于 R7 整体删除** ═══════════
   * 这块挂的是 `agent/inbox/inserted`，只做两件事：
   *   ① 「该任务场景是否会想压」的**纯审计**（decisions / wouldCompact / lastDecision）——
   *      v1 实弹结论（2026-10-06）已证明此处 agent 是 waking 状态、compactNow 必 busy，
   *      所以它**从不执行压缩**，只写报告；决策主体移交模型后这些计数再无消费者；
   *   ② 关键词「先压缩」武装 —— 该通道已于 2026-10-06 按用户决定裁撤。
   * ⇒ 监听器连同 `decideCompaction` 的审计出口一起删除。**压缩触发只剩两条**：
   *   pre-step 轮内（工具意图 / 越强制线）与 idle 安全网（sweepBelow）。 */

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

  /* ---- 事件形状探针（**唯一职责**：记录到达的 session/event，供协议取证）----
   * R7 起本监听器**不再有任何业务逻辑**：它原来还负责「模型回复尾部标记 → idle 自动压缩」，
   * 那条通道已随 marker 整体退役（压缩改由工具在轮内完成）。
   * 保留探针的理由：本插件依赖多个**未文档化**的内部事件（`session/event` 的形状、
   * `agent/inbox/*`、`step/*`），M1 阶段正是靠它一次性摸清了事件形状；
   * 成本仅为一次类型计数 + 至多 12 条样本（slim 报告档位会丢弃），换的是下次 API 变动时能立刻看见。
   * ⚠️ 探针**纯只读**：不得在此监听器里加入任何会改状态或触发压缩的逻辑（那正是 R7 删掉的东西）。 */
  state.listeners['session/event'] = addListener('session/event', (session, event) => {
    try {
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
        /* R11：getHud 聚合响应主体已搬进 plugin/m5.hud.mjs（跨域聚合视图，四条数据线全部注入）。
         * sid 可选：传会话 id 则返回该会话的压缩记录；空=全局。模块未就绪时返回明确错误（client 有兜底）。 */
        onGetHud: async (sid) => buildHudResponse(sid),
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
   * R11：主体已搬进 plugin/m5.hud.mjs（republishFromReport）；宿主只留**重试节奏**
   * （激活时同步 1 发 + 1.2s/4s/10s 各 1 发；幂等，报告读失败/竞态可自愈）。 ---- */
  const bfOnce = () => republishFromReport();
  try {
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
