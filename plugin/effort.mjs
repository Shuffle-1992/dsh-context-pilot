/**
 * @local/dsh-context-pilot —— 智能思考（reasoning effort）功能域（R3 解耦，2026-10-08）。
 *
 * 为什么独立成模块（docs/r3-effort-review.md §3.1）：
 *   本功能域自带配置、状态、读取、钩子、工具、注入文本、HUD 载荷，是一个**内聚的功能域**；
 *   它与宿主其余部分（M2 注入 / M3 压缩 / M5 HUD）的耦合点**只有两处**——「注入文本」与「HUD 载荷」。
 *   R2 曾把懒安装塞进 M2 的注入分支，直接产出一个真 bug（工具接受成功却永不变档）：
 *   该分支里 `step !== 1` 早退使钩子永不安装。物理分离后，此类耦合在结构上不可能再发生。
 *
 * 对外接口（窄接口 = 宿主唯一可依赖的面）：
 *   createEffort(deps) → {
 *     read(agent)                   读当前档 + 动态枚举可选档   → Promise<EffortInfo>
 *     ensure()                      幂等：装 agent/request 钩子 + 注册工具（宿主每步兜底调用）
 *     renderBrief(eff) / renderSuffix(eff)   注入文本（纯函数，缺信息返回 null）
 *     hudPayload(agent, sidHint)    getHud 的 effort 字段（含冷却绝对时间戳）
 *     TOOL_NAME                     工具名常量
 *   }
 * 依赖全部注入（svc / tryOf / pick / msg / log / schedule / state / readCfg / getDefineTool），
 * 模块本身不 import 任何宿主内部件 ⇒ 依赖图为叶子节点（test/static.mjs §4 护栏）。
 *
 * ⚠️ 十条「来之不易」的实证结论 —— 每一条都由一次真失败换来，重构/优化时**不得删除**：
 *   ①  agent/request 钩子必须 `{ prepend: true }`：官方 installModelSelection 挂在**同一** seam
 *       且在内层（它 `await next()` 后 `delete reasoningEffort` 再套回持久化 header 值）
 *       ⇒ 非最外层必被剥掉（实测症状：`applied:true` 却毫无效果）。
 *   ②  pending 必须**持久**（每轮覆盖），不能一次用完就删 —— 正因每轮都被内层打回才需每轮覆盖。
 *   ③  冷却基准只在**真变化**时更新，否则每轮刷新 ⇒ 冷却永远「刚换过」⇒ 后续换档全被挡。
 *   ④  `effortSwitches` 只在**真变化**时自增，否则变成「请求次数」，失去取证意义。
 *   ⑤  **工具不抛错**：非法档/冷却中返回结构化结果让模型自己纠正（抛错会中断本轮）。
 *   ⑥  agent/request 侧**必须**校验：非法档会让 dsh-llm 抛 UNSUPPORTED_REASONING_EFFORT 中断请求。
 *   ⑦  钩子注册在 **agent.ctx**（agent/request 的 payload 里**没有 agent**，只有 {turn,step,signal}）。
 *   ⑧  可选档**动态取**：同一 model id 在不同 provider 档位不同（实测 trae/deepseek-v4.1-flash =
 *       low/high/xhigh；workbuddy 同名模型 = off/low/high/max；workbuddy/hy4-preview-f 仅 high）。
 *   ⑨  sid **现读**优先、安装期值兜底：本项目实测 session id 会轮转（压缩后 / 多会话交错）
 *       ⇒ 只在安装期捕获会查不到 pending（换档静默失效）。
 *   ⑩  应用时 `delete maxTokens`：不把上个 adapter 的输出上限钉到新档（router-laya applyRoute 同款）。
 *
 * 另：档位属于**影响计费**的参数（换档会使前缀缓存失效，见 dsh-llm call-config.js 注释），
 *     故冷却默认 30s 且可由面板配置（R3-S7）。
 *
 * 读档路径的负面结论（实测，勿再试）：`sessionController.selectionFor(agent)` 是内部类方法，
 * 不进命令门面（hasSelectionFor=false）⇒ 不可用；唯一可靠路径是
 * `agent.session.requestHeader().config`（**已生效值**）。
 * 写档路径的负面结论：`sessionController.selectModel` 内部会 `agentDefaultModel.saveSelection()`
 * ⇒ **顺带改掉新会话的默认模型**（实测会重写 profile 的 agent-default-model）⇒ 绝不用它，
 * 一律走 agent/request waterfall（无全局副作用）。详见 docs/r1-reasoning-effort-investigation.md。
 */

/** 换档工具名（用户 2026-10-08 指定；取代 R1 的文本标记方案）。 */
export const TOOL_NAME = 'set_reasoning_effort';

/* R16.7：换档统计持久化需要 fs/path。m5.hud.mjs 已有同款先例（hud-acts.json），
 * static 护栏只查「模块存在」不限制叶子模块的 node 内建 import ⇒ 合法。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 默认冷却（毫秒）：防频繁换档反复打断前缀缓存。可被 config 覆盖。 */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** 兜底默认冷却（config 值非法时使用）。 */
const FALLBACK_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;

/**
 * 创建智能思考功能域实例（每个插件激活一份）。
 * @param {object} deps 宿主注入的依赖
 * @param {(key: string) => any} deps.svc 服务查找
 * @param {(fn: () => any) => {value?: any, error?: string}} deps.tryOf 吞异常取值
 * @param {(...vals: any[]) => any} deps.pick 取首个非空值
 * @param {(e: any) => string} deps.msg 错误取文
 * @param {(level: string, text: string) => void} deps.log 日志
 * @param {(reason: string, delay?: number) => void} deps.schedule 落报告（取证）
 * @param {object} deps.state 宿主状态对象（取证字段挂在 state.m3.*）
 * @param {() => {enabled?: boolean, cooldownMs?: number}} deps.readCfg 现读配置（面板改值即生效）
 * @param {() => any} deps.getDefineTool 取官方 defineTool（异步加载，故用 getter）
 */
export function createEffort(deps) {
  const { svc, tryOf, pick, msg, log, schedule, state, readCfg, getDefineTool, pluginDir } = deps;

  /* ═══════════ R16.7 换档统计持久化（plugin/.data/effort-stats.json） ═══════════
   * 内存态（bySid）随 toggle/重启清零 ⇒ 「会话切换次数」归零（用户实测 0 次）。
   * 落盘：每 sid 的 switchCount + lastSwitch（**不含** want/switchedAt 等瞬态——
   * 那些属于运行期会话语义，重启后本就该重新开始）。
   * 读写模式照 m5 的 hud-acts.json（readFileSync/writeFileSync + 吞错 + mkdirSync）。 */
  const statsPath = pluginDir ? join(pluginDir, '.data', 'effort-stats.json') : null;
  const loadStats = () => {
    try {
      if (!statsPath) return {};
      const raw = readFileSync(statsPath, 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return j && typeof j === 'object' && j.bySid && typeof j.bySid === 'object' ? j.bySid : {};
    } catch (e) {
      if (e?.code !== 'ENOENT') log('warn', `effort-stats.json 读取失败（忽略，从 0 计数）：${msg(e)}`);
      return {};
    }
  };
  const savedStats = loadStats();
  const saveStats = () => {
    try {
      if (!statsPath) return;
      mkdirSync(dirname(statsPath), { recursive: true });
      const out = {};
      for (const [sid, s] of bySid) {
        if (s.switchCount > 0 || s.lastSwitch) out[sid] = { switchCount: s.switchCount || 0, lastSwitch: s.lastSwitch ?? null };
      }
      writeFileSync(statsPath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), bySid: out }, null, 2));
    } catch (e) {
      log('warn', `effort-stats.json 写入失败（吞）：${msg(e)}`);
    }
  };

  /* ═══════════ 状态：按 sid 单对象（R3-S6：原先三张 Map 各自 delete，漏删即留孤儿） ═══════════
   * 原先拆成 pendingEffortBySid / effortSwitchAtBySid / appliedEffortBySid —— 三者同键同生命周期，
   * 合并后只有一个删除点（dropSid），孤儿在结构上不可能出现。 */
  /** @type {Map<string, {want: string|null, wantAt: number, switchedAt: number, applied: string|undefined,
   *   lastSwitch: {from: string|null, to: string, at: number}|null, switchCount: number}>} */
  const bySid = new Map();
  const slot = (sid) => {
    let s = bySid.get(sid);
    if (!s) {
      /* R16.6：lastSwitch/switchCount —— chip tooltip 的「最近切换 / 会话切换次数」数据源
       * （按会话记，全局计数在多会话下没有意义）。只记**真变化**（与 effortSwitches 同判据）。
       * R16.7：创建时**合并落盘的历史**（跨 toggle/重启累计）。 */
      const saved = savedStats[sid];
      s = {
        want: null, wantAt: 0, switchedAt: 0, applied: undefined,
        lastSwitch: saved?.lastSwitch ?? null, switchCount: saved?.switchCount ?? 0,
      };
      bySid.set(sid, s);
    }
    return s;
  };
  const dropSid = (sid) => bySid.delete(sid);

  const cfgNow = () => {
    try { return readCfg() ?? {}; } catch { return {}; }
  };
  const enabled = () => cfgNow().enabled === true;
  const cooldownMs = () => {
    const v = cfgNow().cooldownMs;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : FALLBACK_COOLDOWN_MS;
  };

  /* ---- R3-S3：三个被反复内联的小逻辑抽成单点 ---- */

  /** sid 解析（原先在钩子/工具/pre-step 三处各写一遍，写法还不一致）。 */
  const sidOf = (agent, fallback = '') =>
    String(pick(agent?.session?.id, agent?.sessionId, agent?.id, fallback) ?? '');

  /** 跳过计数（原先 5 处重复 `state.m3.effortSkips.X = (… ?? 0) + 1`）。 */
  const bumpSkip = (kind) => {
    state.m3.effortSkips[kind] = (state.m3.effortSkips[kind] ?? 0) + 1;
  };

  /** 档位合法性校验（原先钩子与工具各写一遍）。
   *  ⚠️ 可选集取不到（null）时**不否决**：部分 provider 不暴露 efforts，但档位值仍可能有效；
   *     真正的兜底是 llm 侧的 UNSUPPORTED_REASONING_EFFORT（故仍需 try/catch 吞）。
   *  ⚠️⚠️ R7 修一个**真缺陷**：`efforts` 缺失时上游归一成 `[]`（而非 null），而这里原先用
   *     `Array.isArray` 判定 ⇒ 空数组为真 ⇒ `options.includes(want)` **恒假** ⇒ **一刀否决所有档位**，
   *     错误文案还退化成「可选 」。判据必须与 `renderBrief` 的 `eff.efforts.length` 口径一致：
   *     **空数组 = 取不到 = 不否决**。 */
  const checkEffort = (eff, want) => {
    const options = Array.isArray(eff?.efforts) && eff.efforts.length > 0 ? eff.efforts : null;
    if (options && !options.includes(want)) {
      /* ⚠️ 这里的 `reason` 是**内部**字段名，由工具层映射成已声明的 `error`（见 runTool：`error: chk.reason`）。
       * R15.3 记一笔：把它「顺手统一」成 `error` 会让工具返回 `error: undefined` —— 错误信息静默丢失，
       * 而 output.schema 校验照样通过（我的变异脚本正是这样逃逸的）⇒ 内部字段名 ≠ 声明字段名。 */
      return { ok: false, options, reason: `档位不在当前模型的可选集内（可选 ${options.join('/')}）` };
    }
    return { ok: true, options };
  };

  /* ═══════════ 读：当前档 + 动态枚举可选档（R3-S5：全程 async，不再同步/异步混用） ═══════════ */
  /**
   * 读当前会话的思考强度信息（全路径 async；任何异常都降级为 { ok:false }，绝不抛出）。
   * @returns {Promise<{ok: boolean, error?: string, provider?: string, model?: string,
   *   current?: string|null, adapterDefault?: boolean, efforts?: string[]|null, defaultEffort?: string|null}>}
   */
  async function read(agent) {
    try {
      const hdr = tryOf(() => agent?.session?.requestHeader?.()).value ?? null;
      const c = hdr?.config ?? null;
      if (!c?.provider || !c?.model) return { ok: false, error: 'no-route' };
      /** adapterDefault=true 表示该档位来自 adapter 默认，而非会话显式选择（UI 据此标注「(默认)」）。 */
      const base = {
        ok: true,
        provider: c.provider,
        model: c.model,
        current: typeof c.reasoningEffort === 'string' && c.reasoningEffort ? c.reasoningEffort : null,
        adapterDefault: hdr?.adapterDefaults?.reasoningEffort === true,
        efforts: null,
        defaultEffort: null,
      };
      const llm = svc('llm');
      const p = tryOf(() => llm?.resolveModelInfo?.(c.provider, c.model));
      if (p.error || !p.value) return base;
      const mi = await Promise.resolve(p.value).catch(() => null);
      if (!mi) return base;
      return {
        ...base,
        efforts: mi?.reasoning ? (mi.reasoning.efforts ?? []).map((e) => e.id) : null,
        defaultEffort: mi?.reasoning?.defaultEffort ?? null,
      };
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  /* ═══════════ 执行：把一个请求的 config 按期望档位改写（R3-S2：从 108 行钩子里拆出） ═══════════ */
  /**
   * 决策主体（纯函数式：只读写本模块状态与取证字段，返回改写后的 config）。
   * 任何异常/校验失败都**原样返回入参 config** —— 新功能绝不影响请求本身。
   * @param {object} config agent/request 内层产出的请求配置
   * @param {object} agent 该请求所属 agent
   * @param {string} sidAtInstall 安装钩子时捕获的 sid（仅作兜底，见结论⑨）
   */
  async function applyTo(config, agent, sidAtInstall) {
    if (!enabled()) return config;
    /* 结论⑨：sid 现读优先，安装期值兜底；用**实际命中的 key** 做删除/记忆（避免孤儿 pending）。 */
    const sidNow = sidOf(agent);
    const hitNow = bySid.get(sidNow);
    const sidKey = hitNow ? sidNow : (sidAtInstall && bySid.has(sidAtInstall) ? sidAtInstall : sidNow);
    const s = bySid.get(sidKey);
    const want = s?.want;
    if (!want) return config;
    /* 尊重「他人显式指定」：当前档既不是我们上次写的、也不是我们本次想写的 ⇒ 让位
     * （router-laya carriesExplicitRoute 语义）。必须同时排除 want：本钩子每轮都跑（pending 持久），
     * 而官方内层会把 config 设为持久化 header 值 —— 只比 applied 会漏判。 */
    if (config?.reasoningEffort !== undefined && s.applied !== undefined
        && config.reasoningEffort !== s.applied && config.reasoningEffort !== want) {
      dropSid(sidKey);
      bumpSkip('foreign');
      log('info', `智能思考 让位：当前请求档位 ${config.reasoningEffort} 非本插件所写（他人显式指定）`);
      return config;
    }
    /* 结论⑥：必须校验 —— 非法档会让 dsh-llm 抛 UNSUPPORTED_REASONING_EFFORT 中断请求。 */
    const eff = await read(agent);
    if (!eff?.ok) {
      dropSid(sidKey);
      bumpSkip('noRoute');
      return config;
    }
    const chk = checkEffort(eff, want);
    if (!chk.ok) {
      dropSid(sidKey);
      bumpSkip('invalid');
      state.m3.lastEffortApply = {
        at: new Date().toISOString(), sessionId: sidKey, want, applied: false, error: chk.reason,
      };
      log('warn', `智能思考 忽略：${want} —— ${chk.reason}`);
      schedule('effort', 400);
      return config;
    }
    /* 结论⑩：删 maxTokens。结论②：**不删 pending**（每轮都要覆盖，见文件头）。 */
    const out = { ...config, reasoningEffort: want };
    delete out.maxTokens;
    s.applied = want;
    const changed = config?.reasoningEffort !== want; // 结论③④
    if (changed) {
      /* R15.1：锚点优先取**工具接受时刻**（已在上面的 accept 分支写好）。apply 与接受只差一次请求，
       * 但客户端那一次 getHud 恰好夹在中间 ⇒ 若在这里无条件重锚，chip 就永远看不到冷却（真机实测）。 */
      if (!s.switchedAt) s.switchedAt = Date.now();
      state.m3.effortSwitches += 1;
      /* R16.6：按会话记「最近切换 / 次数」（chip tooltip 数据源）。
       * from 取**会话上一档**（config.reasoningEffort 是请求头里的旧值，等价）。
       * R16.7：立即落盘（切换是低频动作，写一次文件无压力）。 */
      s.lastSwitch = { from: config?.reasoningEffort ?? null, to: want, at: Date.now() };
      s.switchCount += 1;
      saveStats();
      state.m3.lastEffortApply = {
        at: new Date().toISOString(), sessionId: sidKey, want,
        from: config?.reasoningEffort ?? null, applied: true,
        provider: eff.provider, model: eff.model, options: chk.options,
        sidNow, sidAtInstall,
      };
      log('info', `智能思考 应用：${config?.reasoningEffort ?? '(默认)'} → ${want}（${eff.provider}/${eff.model}，下一步生效）`);
      schedule('effort', 400);
    } else {
      /* 已一致：每轮覆盖仍在做（防被内层打回），但不计入换档次数 —— 否则计数变成「请求次数」。 */
      state.m3.effortReasserts += 1;
    }
    return out;
  }

  /* ═══════════ 安装：agent/request waterfall（R3-S2：从 108 行里拆出的薄壳） ═══════════ */
  /** 已安装钩子的 agent（结论⑦：按 agent 安装；WeakSet 去重防 waterfall 回调叠加）。 */
  const hookInstalled = new WeakSet();

  function installHook(agent) {
    try {
      if (!agent?.ctx || typeof agent.ctx.on !== 'function') {
        state.m3.effortDiag.hookError = {
          at: new Date().toISOString(),
          reason: !agent?.ctx ? 'agent.ctx 缺失' : 'agent.ctx.on 非函数',
          ctxType: typeof agent?.ctx,
          onType: typeof agent?.ctx?.on,
        };
        return false;
      }
      if (hookInstalled.has(agent)) return true;
      const sidAtInstall = sidOf(agent);
      if (!sidAtInstall) return false;
      hookInstalled.add(agent);
      agent.ctx.on('agent/request', async (_payload, next) => {
        const config = await next();
        try {
          return await applyTo(config, agent, sidAtInstall);
        } catch (e) {
          log('warn', `智能思考 应用异常（吞，原样放行）：${msg(e)}`);
          return config;
        }
      }, { prepend: true }); // 结论①
      state.m3.effortHooks += 1;
      return true;
    } catch (e) {
      log('warn', `智能思考 安装 agent/request 钩子失败（吞）：${msg(e)}`);
      return false;
    }
  }

  /* ═══════════ 工具：set_reasoning_effort（R3-S2：定义与执行分离；R3-S8：output 收敛为 4 字段） ═══════════ */
  let toolRegistered = false;

  /**
   * 工具执行体。
   * ⚠️ 结论⑤：**绝不抛错**。非法档/冷却中一律返回结构化结果让模型自己纠正——
   * 抛错对模型是可见的失败且会中断本轮，而这里只想要「告知 + 不换」。
   * ⚠️ 与 agent/request 侧的校验是**两层不同的保护**：那边是防 llm 抛错中断请求。
   */
  async function runTool(args, exec) {
    try {
      if (!enabled()) return { ok: false, error: '智能思考未开启（用户在设置里关闭了该功能）。' };
      const agent = exec?.agent;
      if (!agent) return { ok: false, error: '无 agent 作用域，无法换档。' };
      const want = String(args?.effort ?? '').trim();
      if (!want) return { ok: false, error: 'effort 参数为空。' };
      const sid = sidOf(agent);
      if (!sid) return { ok: false, error: '无法解析会话 id。' };
      const eff = await read(agent);
      if (!eff?.ok) return { ok: false, error: `无法读取当前模型档位信息（${eff?.error ?? '未知'}）。` };
      const chk = checkEffort(eff, want);
      if (!chk.ok) {
        bumpSkip('invalid');
        state.m3.lastEffortApply = {
          at: new Date().toISOString(), sessionId: sid, want, applied: false, via: 'tool', error: chk.reason,
        };
        log('warn', `智能思考 工具拒绝：${chk.reason}`);
        schedule('effort', 400);
        return { ok: false, error: `档位 "${want}" 不在当前模型的可选集内。`, options: chk.options };
      }
      /* 幂等：与期望档位相同 ⇒ 直接成功（不消耗冷却） */
      if (bySid.get(sid)?.want === want) {
        bumpSkip('sameValue');
        /* R15：回读 + 自检契约（同 accepted 分支，理由见那里）。 */
        return {
          ok: true,
          effort: want,
          applied: 'already',
          verify: '该会话已是此档位；下一步的用量行后缀会显示当前实际档位，可据此自检。',
        };
      }
      const cap = cooldownMs();
      const s = bySid.get(sid);
      const since = Date.now() - (s?.switchedAt ?? 0);
      if (s?.switchedAt && since < cap) {
        const remainSec = Math.ceil((cap - since) / 1000);
        bumpSkip('cooldown');
        log('info', `智能思考 工具被冷却拒绝（还剩 ${remainSec}s）`);
        schedule('effort', 400);
        return {
          ok: false, options: chk.options ?? undefined,
          error: `换档冷却中，还需 ${remainSec} 秒。冷却用于避免频繁换档反复打断前缀缓存。`,
        };
      }
      /* 接受：写持久 pending（agent/request 最外层每步覆盖，见结论①②） */
      const st = slot(sid);
      st.want = want;
      st.wantAt = Date.now();
      /* R15.1（用户实测反馈：「切换到 Max 时 chip 没有进入冷却状态」）：
       * **冷却锚点必须落在「接受时刻」**，而不是 apply 时刻。
       * 实测时序：工具接受（05:02:08.696）→ 插件在**下一次请求**时 apply（.719）→ 客户端投影随之变化
       * → chip 才去 getHud。可那次轮询就发生在同一秒、且**之后再无轮询**（投影不再变）⇒ chip 拿到的
       * 是「还没进冷却」的那一帧，于是永远显示「就绪」。
       * 语义上也更对：Cooldown 约束的是「两次换档请求之间的最小间隔」，从请求被接受起算即可。 */
      st.switchedAt = Date.now();
      state.m3.effortToolCalls += 1;
      state.m3.lastEffortTool = { at: new Date().toISOString(), sessionId: sid, want };
      log('info', `智能思考 工具接受：${eff.current ?? '(默认)'} → ${want}（${eff.provider}/${eff.model}）→ 下一步生效`);
      schedule('effort', 400);
      /* R15（用户要求「工具完成后进行检查」）：换档的实际生效点在**下一次请求**（写的是会话级
       * pending，由 agent/request 最外层每步覆盖）。工具当场**读不回来**（requestHeader 仍是旧档），
       * 所以这里给的是「下一步的用量行后缀」——那是模型能直接看到的、唯一的执行回执。
       * ⚠️ 2026-10-08 教训：此前结果只有 `{ok:true, effort}` ⇒ 模型无法自检，
       *    与压缩那个「回 ok 但没执行」是同一类盲区。 */
      return {
        ok: true,
        effort: want,
        applied: 'next-request',
        verify: `下一次请求起生效为 ${want}；下一步的用量行后缀会显示当前实际档位——若仍显示旧档位，说明未生效，请告知用户。`,
      };
    } catch (e) {
      log('warn', `智能思考 工具执行异常（吞）：${msg(e)}`);
      return { ok: false, error: `内部错误：${msg(e)}` };
    }
  }

  /** 工具定义（schema / description / render），照官方 dsh-tool-ask-user 范式。 */
  function toolSpec() {
    return {
      name: TOOL_NAME,
      description:
        '调整本次任务的思考强度档位（下一步生效，任务不中断）。'
        /* 2026-10-08 用户要求：「先说，再调用」。
         * 工具**描述本身就是每轮都随请求下发的文本** ⇒ 把它放这里 = 零额外 token 的每轮提醒。 */
        + '**调用本工具前，先在回复正文里用一句话说明你为什么要换档**（用户看不到工具调用的理由，只说一句用户才知道你为什么换），然后再调用。'
        + '当前档位与**可选档位**见每轮开头的用量行后缀与首次注入的说明。'
        + '需要更深推理（复杂设计、疑难排查、长链规划）时升档；'
        + '简单查询、机械修改时降档可省额度。'
        + '**任务阶段变化时重新判断一次**（读代码查因 → 动手改多文件 → 写文档…）；长任务按实际需求可以切多次，'
        + '唯一硬约束是换档冷却（默认 30 秒）。切换后下一步的用量行后缀会显示新档位，可据此自检。'
        + '**换档最佳时机提示（R16.8）**：换档会使前缀缓存失效——若刚压缩过上下文（缓存已被重置），'
        + '此时换档只付一次重建成本 ⇒ 压缩的同一条消息里顺带换档是最优时机（压缩自检回执里也会提醒）。',
      parameters: {
        effort: {
          type: 'string',
          required: true,
          description: '目标档位。必须在该模型的可选集内（可选集见首次注入的说明或当前用量行）；换档理由请同时写在回复正文里。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: '是否已接受换档。' },
            effort: { type: 'string', description: '已接受的档位（下一步请求即生效）。' },
            /* R15.3（2026-10-08 真机事故）：宿主**按 output.schema 校验工具返回值**
             * （additionalProperties:false ⇒ 多一个字段就整条工具调用失败：
             * `"value.applied" is not a declared property`）⇒ 加返回字段必须同时在这里声明。 */
            applied: {
              type: 'string',
              description: '生效时机：next-request（下一次请求起生效）或 already（该会话已是此档）。',
            },
            verify: {
              type: 'string',
              description: '自检契约：下一步的用量行后缀会显示当前实际档位，可据此确认是否生效。',
            },
            error: { type: 'string', description: '未接受时的原因（含冷却剩余秒数）。' },
            options: { type: 'array', items: { type: 'string' }, description: '该模型的可选档位。' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: runTool,
    };
  }

  function registerTool() {
    try {
      if (toolRegistered) return true;
      const defineTool = getDefineTool();
      if (typeof defineTool !== 'function') return false;
      const tools = svc('tools');
      if (!tools || typeof tools.register !== 'function') {
        state.m3.effortTool = { at: new Date().toISOString(), ok: false, error: 'tools.register 不可用' };
        return false;
      }
      tools.register(defineTool(toolSpec()));
      toolRegistered = true;
      state.m3.effortTool = { at: new Date().toISOString(), ok: true, name: TOOL_NAME, via: 'tools.register' };
      log('info', `智能思考 工具已注册：${TOOL_NAME}`);
      return true;
    } catch (e) {
      state.m3.effortTool = { at: new Date().toISOString(), ok: false, error: msg(e) };
      log('warn', `智能思考 工具注册失败（吞）：${msg(e)}`);
      return false;
    }
  }

  /* ═══════════ 懒安装入口（R3-S4：**与 M2 注入分支彻底解耦**） ═══════════
   * 曾是注入分支里的一行 ⇒ 该分支的 `step !== 1` 早退让钩子永不安装（真 bug）。
   * 现在由宿主的 pre-step **最前面**调用（也在激活期/会话创建时兜底），幂等、无副作用。 */
  function ensure() {
    try {
      const d = state.m3.effortDiag;
      d.calls += 1;
      d.at = new Date().toISOString();
      d.enabled = enabled();
      if (!d.enabled) return false;
      const list = svc('agents')?.list?.() ?? [];
      const arr = Array.isArray(list) ? list : [];
      d.agents = Array.isArray(list) ? arr.length : 'not-array';
      let ok = 0;
      let failed = 0;
      for (const a of arr) {
        if (installHook(a)) ok += 1;
        else failed += 1;
      }
      d.installed = ok;
      d.failed = failed;
      /* 工具懒注册：覆盖「会话中途打开开关」——加载期只注册一次是不够的。 */
      registerTool();
      return true;
    } catch (e) {
      state.m3.effortDiag.error = msg(e);
      state.m3.effortDiag.at = new Date().toISOString();
      return false;
    }
  }

  /* ═══════════ 注入文本（纯函数；宿主 M2 注入消费） ═══════════ */

  /**
   * 一次性教学文本。为什么必须教：本项目已踩过同类坑——
   * 「暴露了能力但不教怎么用 = 功能等于不存在」，模型不知道有工具就永远不会调。
   * 覆盖度必须 6/6：① 当前值 ② 可选档 ③ 工具名+调用方式 ④ 何时该用 ⑤ 生效时机+不中断 ⑥ 代价提醒。
   * +⑦（2026-10-08 用户要求）**先说，再调用**：工具调用对用户静默，理由必须写在回复正文里。
   * 档位**现拼活值**（写死会在模型/配置变化后自相矛盾）。无档可调时返回 null ⇒ 不注入、不打扰。
   */
  function renderBrief(eff) {
    try {
      if (!eff?.ok || !eff.current) return null;
      const opts = Array.isArray(eff.efforts) && eff.efforts.length ? eff.efforts.join('/') : null;
      /* R16.12（用户反馈「Agent 切换档位的意愿不高」）：原教学只有**自指式**判据
       * （「需要更深推理时升档」）——「需不需要」交给模型自己判 ⇒ 等于没有触发条件；
       * 而压缩那条教学有**外部可观测**触发（占用 % + 强制线），所以它被调用得多。
       * 现补三件东西，逐条对治实测到的低意愿成因：
       *   ① **可判定的触发表**（升/降/不变各自给可核对的场景），并**显式允许「不变」**——
       *      不写这句时，「没切」会被当成失职，模型索性不提；
       *   ② **成本澄清**：只打断一次前缀缓存（与压缩同轮更省）、冷却拒绝不影响任务 ——
       *      旧文本只强调「唯一硬约束是冷却」，读起来像劝退；
       *   ③ 保留用户要求的「先说再调用」与自检回执两条。 */
      return [
        '【智能思考（本会话仅此一次）】当前思考强度档位：' + eff.current + (opts ? '（本模型可选 ' + opts + '）' : '（可选档位未取到）') + '。',
        '**先说，再调用**：切换前先在回复正文里用一句话说明理由'
          + '（用户看不到工具调用的理由），然后调 ' + TOOL_NAME + '（参数 effort=<档位>）——本次任务内立即生效，任务与上下文不中断。',
        '**什么时候该切（命中任一条就当场评估一次，别默认不动）**：',
        '· **升档**：跨文件因果排查 / 需要反复试错才能定位 / 要做设计取舍或方案对比 / 用户明确要求「彻底、根因、严谨、评估、全面」；',
        '· **降档**：连续机械改动（改名、格式化、加断言、照抄改动、只跑命令看结果）/ 简单查询 / 用户明确要求「快点、只要、简单、省点」；',
        '· **不变**：正常编码推进（当前档位通常够用）——**不确定就不切，「不变」也是合法结论**。',
        '**任务阶段变化时重新评估一次**（读代码查因 → 动手改多文件 → 写文档…）；**长任务按实际需求可以切多次**'
          + '（次数没有限制，唯一硬约束是换档冷却：默认 30 秒，冷却中调用会返回剩余秒数）。',
        /* R16.14（评审建议 3，与压缩侧同款）：**「不切」也要留一行**——评审原文：
         * 「只有例外路径（调用）才需要理由。『不压』零成本、零证据 ⇒ 沉默稳定胜出。」
         * 把沉默变成可检查产物，正是这两项功能共同缺的那一环。 */
        '**阶段变化时留一行档位决策**（含「不变」）：`档位决策：保持 high｜理由…` 或 `档位决策：降 low｜理由…`——'
          + '「不变」是合法结论，但**要写出来**，否则用户无法区分「评估后决定不切」与「根本没看」。',
        '**成本很低，别怕动它**：换档只打断一次前缀缓存（若刚压缩过上下文，缓存已重置 ⇒ 与压缩同轮切只付一次）；'
          + '被冷却拒绝**不影响任务**，按返回的剩余秒数稍后重试即可。',
        '每次切换后**下一步的用量行后缀**会显示当前实际档位（例：`思考强度 max`）——那就是你的自检回执；'
          + '若下次请求后仍显示旧档位，说明未生效，请在正文里说明并告知用户。',
      ].join('');
    } catch {
      return null;
    }
  }

  /**
   * 每轮用量行后缀 —— 让模型知道**当前实际生效**档位（它只知道自己请求过什么，
   * 不知道插件是否应用成功，例如档位非法被忽略时）。短后缀 ≈7 token/轮。
   */
  function renderSuffix(eff) {
    try {
      if (!eff?.ok || !eff.current) return null;
      /* R15（用户要求「时刻可以进行思考强度切换」）：后缀必须**带上可选项**。
       * 实证：2026-10-08 用户问「整个过程没切换过档位，是暴露信息不够吗」——查下来确实不够：
       * 可选项只出现在**会话最早那段一次性教学**里（以及工具 description），
       * 而一次性教学在长会话/压缩之后早已不在近端；每轮后缀只报当前档 ⇒ 模型每轮看不到「有哪些选择」。
       * 成本：约 +8 token/轮；换来的是「每一轮都能当场决定要不要切」。
       * 取不到可选集时不编造（保持纯档位后缀）。 */
      const opts = Array.isArray(eff.efforts) && eff.efforts.length ? eff.efforts.join('/') : null;
      return '思考强度 ' + eff.current + (eff.adapterDefault ? '(默认)' : '')
        + (opts ? '（可选 ' + opts + '，需要时先说再调用 ' + TOOL_NAME + '）' : '');
    } catch {
      return null;
    }
  }

  /* ═══════════ R16.12 换档提醒（renderNudge） ═══════════
   * 为什么需要（实测证据）：报告里部署以来的 `effortToolCalls/switches` 长期为 0
   * （历史峰值 4/4，全是开发期自测切出来的）。归因**不是**「模型觉得不需要」，而是
   * **决策时刻没有任何信号**：
   *   · 一次性教学出现在会话开头（那时还不知道要做什么），压缩后虽会重讲但不挑时机；
   *   · 每轮后缀只有「需要时先说再调用」——「需要」是自指判据，且每轮同文（习惯化）；
   *   · 不切档**没有任何可见代价**（压缩有 75% 硬线）⇒ 两种动作的激励完全不对称。
   * 因此给三类**可观测**触发，并严格限量（只在真有信号时出现，避免噪声与习惯化）：
   *   ① 用户本轮明确要求深入 → 提示可升档；
   *   ② 用户本轮明确要求快速 / 只需机械改动 → 提示可降档；
   *   ③ 本会话已跑 ≥8 轮且**从未换过档** → 提醒评估一次（间隔 ≥10 轮）。
   * 冷却中一律不提示（避免「让你切、但工具必然拒绝」的无效往返）。 */

  /** 用户意图关键词（保守：宁可漏报，不可误报成噪声）。 */
  const WANT_DEEP_RE = /(排查|根因|为什么|彻底|仔细|严谨|评估|权衡|架构|设计|深入|全面|复杂|难点)/;
  const WANT_FAST_RE = /(快点|快些|尽快|简单|只要|仅需|直接改|格式化|改名|重命名|机械|省点|别啰嗦|别废话)/;
  const NUDGE_MIN_GAP = 4;    // 任意两次提醒的最小间隔（轮）
  const NUDGE_IDLE_TURNS = 8; // 「从未换档」提醒的起始轮次
  const NUDGE_IDLE_GAP = 10;  // 「从未换档」提醒的最小间隔（轮）

  /**
   * 生成一条换档提醒；无信号返回 null（不注入、不占 token）。
   * @param {object} eff `read(agent)` 的结果（含 current/efforts）
   * @param {{agent?: object, turn?: number, userText?: string}} ctx 注入上下文
   */
  function renderNudge(eff, ctx) {
    try {
      if (!eff?.ok || !eff.current) return null;
      const sid = sidOf(ctx?.agent) || '';
      if (!sid) return null;
      const s = slot(sid);
      /* 冷却中不提示：此时工具必然拒绝，提示只会制造无效往返。 */
      const cap = cooldownMs();
      if (s.switchedAt && Date.now() - s.switchedAt < cap) return null;
      const turn = Number(ctx?.turn) || 0;
      /* ⚠️「从未提醒过」必须与「上次提醒在第 0 轮」区分开：用 null 兜底，
       * 否则会话前几轮会被最小间隔规则误挡（用户第 3 轮就说「排查根因」也不提示）。 */
      const last = s.nudgeAtTurn ?? null;
      const gap = last === null ? Infinity : turn - last;
      const opts = Array.isArray(eff.efforts) && eff.efforts.length ? eff.efforts.join('/') : '';
      const tail = '（当前 ' + eff.current + (opts ? '，可选 ' + opts : '')
        + '；先说一句理由再调 ' + TOOL_NAME + '，不需要则忽略）';
      const text = String(ctx?.userText ?? '');
      /* ①② 用户意图（间隔 NUDGE_MIN_GAP 轮，防每轮重复）。 */
      if (gap >= NUDGE_MIN_GAP && text) {
        const up = WANT_DEEP_RE.exec(text);
        if (up) {
          s.nudgeAtTurn = turn;
          return '【换档提示】用户本轮要求深入（命中「' + up[1] + '」）——可考虑**升档**' + tail;
        }
        const down = WANT_FAST_RE.exec(text);
        if (down) {
          s.nudgeAtTurn = turn;
          return '【换档提示】用户本轮要求快速／只需机械改动（命中「' + down[1] + '」）——可考虑**降档**省额度' + tail;
        }
      }
      /* ③ 会话内从未换档：把「没切过」这件事直接摆到眼前（对治「意愿不高」）。 */
      if (turn >= NUDGE_IDLE_TURNS && (s.switchCount ?? 0) === 0 && gap >= NUDGE_IDLE_GAP) {
        s.nudgeAtTurn = turn;
        return '【换档提示】本会话已 ' + turn + ' 轮、**尚未换过档**——近端若是机械编辑可降档、任务变难可升档；'
          + '一句话理由即可' + tail;
      }
      return null;
    } catch {
      return null;
    }
  }

  /* ═══════════ HUD 载荷（宿主 getHud 消费） ═══════════ */
  /**
   * effort 字段（含**换档冷却绝对时间戳**）。
   * 返回绝对时刻而非剩余毫秒：client 可本地倒计时，且 getHud 是低频调用（挂载 + 投影变化各一次），
   * 绝对值不会因调用间隔而过时。
   * ⚠️ 开关状态**不放在这里**（R3-S9：`eff.ok=false` 无法区分「开关关闭」与「读档失败」）——
   * 宿主另行返回 effortEnabled 布尔，二者分离。
   */
  async function hudPayload(agent, sidHint) {
    const eff = await read(agent);
    /* R16.10（用户实测「最近切换/会话切换次数跨会话显示一样」）：统计必须**严格按请求的 sid**。
     * 原实现 `sidOf(agent) || sidHint` —— agent 优先 ⇒ 一旦宿主回退到「第一个 agent」
     * （m5 此前在 sid 匹配不到时会 `agents[0]`），就取到**另一个会话**的统计（跨会话串数据）。
     * 现改为 **sidHint 优先**（调用方明确问哪个会话就答哪个），agent 再作为兜底。
     * ⚠️ 无 agent / 读档失败时**仍返回该会话的统计**（只查内存+落盘，不需要 agent）——
     * 否则匹配不到 agent 的会话会连统计一起消失（宁缺勿错的另一半：有 sid 就该有统计）。 */
    const requested = String(sidHint ?? '').trim();
    const sid = requested || sidOf(agent) || '';
    const s = sid ? slot(sid) : null;
    const cap = cooldownMs();
    const base = s?.switchedAt ?? 0;
    const until = base ? base + cap : 0;
    /* R16.6：chip tooltip 的「最近切换 / 会话切换次数」。
     * 时间用 toLocaleTimeString（本地短时），与用户在 DSH 界面看到的时间口径一致。 */
    const ls = s?.lastSwitch ?? null;
    const stats = {
      cooldownUntil: until > Date.now() ? until : 0,
      cooldownTotalMs: cap,
      lastSwitch: ls ? {
        from: ls.from ?? '(默认)', to: ls.to,
        at: new Date(ls.at).toLocaleTimeString('zh-CN', { hour12: false }),
      } : null,
      switchCount: s?.switchCount ?? 0,
    };
    if (!eff?.ok) return { ...(eff ?? {}), ...stats };
    return { ...eff, ...stats };
  }

  /** 取证快照（宿主报告用；只读，不暴露内部 Map）。 */
  function diag() {
    const sids = [...bySid.entries()].map(([sid, s]) => ({
      sid: String(sid).slice(0, 24), want: s.want, applied: s.applied ?? null, switchedAt: s.switchedAt || null,
    }));
    return { sids: sids.slice(0, 8), tracked: bySid.size, toolRegistered };
  }

  /** R16.7b：**仅测试用**注入口——向落盘写一条换档记录（构造「重启后恢复」场景，
   * 而不必真跑一遍 agent/request waterfall）。生产路径不经过这里。 */
  function setPersistForTest(sid, lastSwitch) {
    const s = slot(sid);
    s.lastSwitch = { ...lastSwitch };
    s.switchCount = (s.switchCount || 0) + 1;
    saveStats();
  }

  return { TOOL_NAME, read, ensure, renderBrief, renderSuffix, renderNudge, hudPayload, diag, setPersistForTest };
}
