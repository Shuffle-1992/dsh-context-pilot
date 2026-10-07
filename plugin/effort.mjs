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
  const { svc, tryOf, pick, msg, log, schedule, state, readCfg, getDefineTool } = deps;

  /* ═══════════ 状态：按 sid 单对象（R3-S6：原先三张 Map 各自 delete，漏删即留孤儿） ═══════════
   * 原先拆成 pendingEffortBySid / effortSwitchAtBySid / appliedEffortBySid —— 三者同键同生命周期，
   * 合并后只有一个删除点（dropSid），孤儿在结构上不可能出现。 */
  /** @type {Map<string, {want: string|null, wantAt: number, switchedAt: number, applied: string|undefined}>} */
  const bySid = new Map();
  const slot = (sid) => {
    let s = bySid.get(sid);
    if (!s) {
      s = { want: null, wantAt: 0, switchedAt: 0, applied: undefined };
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
      s.switchedAt = Date.now();
      state.m3.effortSwitches += 1;
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
        return { ok: true, effort: want };
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
      state.m3.effortToolCalls += 1;
      state.m3.lastEffortTool = { at: new Date().toISOString(), sessionId: sid, want };
      log('info', `智能思考 工具接受：${eff.current ?? '(默认)'} → ${want}（${eff.provider}/${eff.model}）→ 下一步生效`);
      schedule('effort', 400);
      return { ok: true, effort: want };
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
        + '当前档位与可选档位见每轮开头的用量行与首次注入的说明。'
        + '需要更深推理（复杂设计、疑难排查、长链规划）时升档；'
        + '简单查询、机械修改时降档可省额度。'
        + '换档可能使前缀缓存失效，一次任务 1-2 次为宜。',
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
      return [
        '【智能思考（本会话仅此一次）】当前思考强度档位：' + eff.current + (opts ? '（本模型可选 ' + opts + '）' : '（可选档位未取到）') + '。',
        '需要更深推理（复杂设计、疑难排查、长链规划）或更快响应（简单查询、机械修改）时，调用工具 '
          + TOOL_NAME + '（参数 effort=<档位>）切换：',
        '**先说，再调用**：工具调用对用户是**静默的**——用户在对话里只看到「调用了某个工具」，看不到你的理由。'
          + '所以请**先在回复正文里用一句话说明**（例：「这个排查需要更深推理，我升到 max」），**然后**再调用 ' + TOOL_NAME + '。',
        '它会在**本次任务内立即生效**（下一步请求即用新档位），任务与上下文不中断，用户无需操作。',
        '换档可能使前缀缓存失效，一次任务 1-2 次为宜；档位非法或处于冷却时工具会返回原因，按提示处理即可。',
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
      return '思考强度 ' + eff.current + (eff.adapterDefault ? '(默认)' : '');
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
    if (!eff?.ok) return eff;
    const sid = sidOf(agent) || String(sidHint ?? '');
    const s = bySid.get(sid);
    const cap = cooldownMs();
    const base = s?.switchedAt ?? 0;
    const until = base ? base + cap : 0;
    return { ...eff, cooldownUntil: until > Date.now() ? until : 0, cooldownTotalMs: cap };
  }

  /** 取证快照（宿主报告用；只读，不暴露内部 Map）。 */
  function diag() {
    const sids = [...bySid.entries()].map(([sid, s]) => ({
      sid: String(sid).slice(0, 24), want: s.want, applied: s.applied ?? null, switchedAt: s.switchedAt || null,
    }));
    return { sids: sids.slice(0, 8), tracked: bySid.size, toolRegistered };
  }

  return { TOOL_NAME, read, ensure, renderBrief, renderSuffix, hudPayload, diag };
}
