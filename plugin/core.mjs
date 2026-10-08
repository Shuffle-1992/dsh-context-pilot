/**
 * @local/dsh-context-pilot —— **core**（R14 解耦第六刀）：配置 / 状态 / 报告管线 / 工具函数。
 *
 * ## 为什么它必须由 entry 预加载后传进来（而不是像其它域那样在 apply 里动态 import）
 * `state` / `log` / `svc` / `schedule` / `addListener` 都在 `apply()` 期**同步**使用；
 * 而本项目的铁律是「相对模块必须用 `?ts=` 动态加载」（P16：静态相对导入会命中无参 URL 的进程缓存，
 * 改代码不生效）。两者只能靠**调用方先加载**来同时满足 ⇒ entry.mjs 用同一个 `?ts=` 先加载本模块，
 * 再作为第 4 个参数传给 `apply`。
 *
 * ## ⚠️ 部署约束（比其它刀都硬）
 * entry.mjs 属「改它必须重启 DSH」的薄壳（cordis loader 经 ESM 缓存加载入口，toggle 不换新）。
 * ⇒ **未重启前**，正在运行的旧 entry 不会传 core；宿主侧已做**降级不崩**（见 host.impl.mjs 顶部）。
 *
 * ## 它持有什么（按 R7 审计的「core 不可搬」清单）
 * 纯函数（msg/pick/kfmt/nfmt/errCodeOf/remember/compactMeasure/summarizeBreakdown/messageText/
 * extractEventText）、候选链加载器、`M3_DEFAULTS`、`state`、`mergeConfig`/`M3`/`effEnabled`、
 * 报告管线（loadReportBase / writeReport / refresh / schedule）、`addListener`、createUserMessage 解析。
 *
 * ## 报告管线的「快照来源」是**后置注入**的
 * `refresh` 需要产快照，而快照实现已抽进 plugin/m1.snapshot.mjs ⇒ 由宿主在 M1 接线完成后调
 * `attachSnapshot({buildSnapshot, slimSnapshot, isSlimReason})`。未注入时用**最小快照 + FULL 档位**
 * 兜底（宁可多写字段，也不要报告断档——R13 真事故就是这个形态）。
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
/* 压缩调用超时（pre-step 兜底信号 / idle compactNow 共用）。
 * ⚠️ 2026-10-08 R14 审计发现：它的**定义曾在 R11（M5 HUD 域搬迁）中被静默丢掉**（切块范围比预期宽），
 * 而 m3.compact.mjs 从 R10 起就在用它 ⇒ **从 R11 激活起 M3 域加载失败**：
 * 工具调用仍回 ok/scheduled，但 pre-step 里 m3Ctl 为 null ⇒ preStepCompaction 是 no-op
 * ⇒ 意图永不消费、压缩永不发生；同一原因让 measureRatio 失败 ⇒ M2 用量行/决策卡也一起消失。
 * 现在它住 core，由 host 解构后注入 M3；新增 boot 的「无模块加载失败」断言兜住这一类。 */
const COMPACT_TIMEOUT_MS = 180_000;
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

export function createCore({ ctx, config, pluginDir, reportPath }) {
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

  const pending = new Map(); // reason -> timer（防抖合并）
  /** M3.6 取证：session/event 全量形状探针（类型计数 + 前 N 条样本），落报告定位解析断点。 */
  
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
    /* R13：`SLIM_REASONS` 随 M1 域搬走了 ⇒ 判断口径也必须走模块（否则这里是 ReferenceError，
     * refresh 的 try/catch 会把它吞成「报告永不落盘」——**boot 冒烟当场抓到了这一条**）。
     * 模块未就绪时按 **FULL** 处理：宁可多写几个字段，也不要报告断档。 */
    writeReport(isSlimReason(reason) ? slimSnapshot(snap) : { ...snap, profile: 'full' });
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


  /* ---- 快照来源：后置注入（见文件头）。未注入时用最小快照 + FULL 档位兜底。 ---- */
  let buildSnapshot = (reason) => ({ at: new Date().toISOString(), reason, profile: 'full', services: {}, sessions: [], agents: [], totals: {} });
  let slimSnapshot = (snap) => ({ ...snap, profile: 'slim' });
  let isSlimReason = () => false;
  const attachSnapshot = (api) => {
    if (!api) return;
    buildSnapshot = api.buildSnapshot;
    slimSnapshot = api.slimSnapshot;
    isSlimReason = api.isSlimReason;
  };
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

  /** core 出口：宿主只解构使用，不直接改。 */
  return {
    state, log, msg, svc, tryOf, pick, kfmt, nfmt, errCodeOf, remember, SET_CAP,
    M3, mergeConfig, effEnabled, schedule, addListener, SOURCE_KIND, TAG,
    COMPACT_TIMEOUT_MS, HISTORY_CAP, HEARTBEAT_MS, SESSION_CAP,
    compactMeasure, summarizeBreakdown, messageText, messageTextLength, extractEventText,
    loadCreateUserMessage, loadDefineTool, getCreateUserMessage: () => createUserMessage,
    attachSnapshot, loadReportBase, refresh, writeReport,
  };
}
