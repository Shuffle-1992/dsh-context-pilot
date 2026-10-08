/**
 * 阈值核心（R8 解耦第一刀）——「作用域 compaction 服务 / 引擎阈值 / 生效强制线上限」的**单一来源**。
 *
 * ## 为什么先抽这一个（而不是先拆 M3）
 * R7 审查的结构分析结论：`host.impl.mjs` 拆不动的瓶颈**不是文件长度**，而是三处跨域共享——
 *   ① 单例 `state`；
 *   ② `schedule` / `publishHud` / `clearBriefed` 三个跨域回调；
 *   ③ **`criticalCapOf` 被四个域复用**：
 *      M1 报告快照、M2 教学（决策卡 / 一次性说明）、M3（pre-step 门控 + idle 兜底）、
 *      M5（`getHud` 下发 `criticalCap`，client 据此**钳制并落盘**用户配置）。
 * 三者里 ③ 语义最纯（读引擎配置 → 算一个数）、调用面最窄（一个函数），所以**先把它变成叶子**。
 * ⇒ 之后拆 M3 时只需把本控制器注入，不必再穿过 M1/M2/M5；`RETAIN_RATIO` 那种「刻意不进 M3」的
 *   绕行（M3 有「字段必须在 schema 中」护栏）也不再需要。
 *
 * ## 边界纪律（与 effort / compact-tool / compact-range 三把刀同构）
 * - 依赖**全部注入**（`svc` / `tryOf` / `state` / `log`），对宿主内部件**零 import** ⇒ 依赖图叶子。
 * - 由宿主用 `import(\`./threshold.mjs?ts=${IMPL_TS}\`)` 加载（static.mjs §5 硬护栏；
 *   漏掉 `?ts=` 会像 P16 那样按无参 URL 永久缓存，改本文件将不随 toggle 生效）。
 * - **不抛错**：任何异常都降级为「拿不到引擎阈值」并留痕，绝不中断调用方。
 *
 * ## 为什么宿主不能 `await` 它（本模块为何要能被同步调用）
 * 宿主 `apply` **不是 async**（`export function apply(ctx, config, …)`），而 `criticalCapOf` 被
 * `getHud`（RPC 面）、报告快照、两条压缩路径**同步**调用。故宿主用与 effort/compact-tool 同款的
 * 「懒加载 + 空值降级」：模块就绪前 `thresholdCtl` 为 null，宿主退回**不做上限钳制**（`1`）并留痕。
 * 实测该窗口只在激活后的头几个微任务内存在，远早于任何 listener 触发。
 */

export function createThreshold({ svc, tryOf, state, log }) {
  /** 拿不到引擎配置时的官方默认阈值（compaction-basic lib/index.js:15 `DEFAULT_THRESHOLD_RATIO = .8`）。 */
  const DEFAULT_ENGINE_THRESHOLD = 0.8;

  /**
   * 用户要求（2026-10-08）：插件强制线**始终比 DSH 内置阈值低 5 个百分点**（内置 80% ⇒ 上限 75%）。
   * 理由：两线相等时谁先命中取决于**各自的测量时机**——引擎也在 step 边界自己 measure 一次，
   * 插件可能「什么都没做、占用却已经降了」，于是 HUD 的压缩记录与原因都会失真。
   * 5pp 同时吸收两边测量的抖动，并留出足够提前量让插件线**确定性先行**。
   * ⚠️ 首版曾按 0.5pp 实现，用户随即更正为 5pp（余量必须够大才谈得上「确定性」）。
   */
  const ENGINE_CAP_MARGIN = 0.05;

  /**
   * 解析某 agent 作用域的 compaction 服务实例。
   * 顶层 ctx 上 `compaction` 实测 **absent**（服务按 agent 作用域隔离）⇒ 必须走 agent 上下文；
   * 两条候选路径按可用性依次尝试（`agent.ctx.get('compaction')` → `agentPresets.serviceFor`）。
   */
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

  /**
   * 读引擎（compaction-basic）的自动压缩阈值 —— 插件强制线的**动态上限**。
   * 依据（源码实证）：服务实例公开属性 `config`（`resolveConfig` 产出的 deepFreeze 对象，
   * 含 `thresholdRatio` / `auto` / `modelPolicies`），见 lib/index.js L826 / L75。
   * 语义：插件开启时插件线先行（必须 ≤ 引擎线）；插件关闭/卸载后引擎 80% 自然恢复
   * ⇒ **不改引擎配置**，只在插件侧钳制：生效强制线 = `min(用户配置, 引擎阈值 − 5pp)`。
   * 拿不到时回退官方默认 0.8（并记 `fallback: true`）；每次现取不缓存（配置可能被改）。
   *
   * ⚠️ F6（R7 审查修）：这是**读路径**——`getHud` 每 5s 经 `criticalCapOf` 进来一次。
   *    原先每次都重写探针 ⇒ RPC 面非幂等、报告字段被轮询不断刷成同一份新时间戳。
   *    现在只在「还没有探针 / 探到的值变了 / 解析路径变了」时写 ⇒ 读操作不再产生写。
   */
  const engineThreshold = (agent) => {
    const r = resolveCompactionFor(agent);
    const t = tryOf(() => r.service?.config?.thresholdRatio);
    const v = t.value;
    const ok = typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
    const raw = ok ? v : DEFAULT_ENGINE_THRESHOLD;
    /* 取证同时记**原始引擎阈值**与**减去余量后的生效上限**，否则报告里看不出 5pp 被扣在哪。 */
    const prev = state?.m3?.engineCapProbe;
    const ratio = ok ? v : null;
    if (!prev || prev.ratio !== ratio || prev.fallback !== !ok || prev.via !== r.via) {
      if (state?.m3) {
        state.m3.engineCapProbe = {
          at: new Date().toISOString(),
          via: r.via,
          ratio,
          fallback: !ok,
          cap: +Math.max(0, raw - ENGINE_CAP_MARGIN).toFixed(4),
          margin: ENGINE_CAP_MARGIN,
        };
      }
      if (log) log('info', `引擎阈值探取：ratio=${ratio ?? '(fallback)'} via=${r.via} cap=${Math.max(0, raw - ENGINE_CAP_MARGIN).toFixed(4)}`);
    }
    return raw;
  };

  /** 生效强制线上限 = 引擎阈值 − 5pp（下限 0，防引擎阈值被配成极小值后出现负数）。 */
  const criticalCapOf = (agent) => Math.max(0, engineThreshold(agent) - ENGINE_CAP_MARGIN);

  return { DEFAULT_ENGINE_THRESHOLD, ENGINE_CAP_MARGIN, resolveCompactionFor, engineThreshold, criticalCapOf };
}
