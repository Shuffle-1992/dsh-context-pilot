#!/usr/bin/env node
/**
 * test/client-render.mjs —— **客户端配置卡真渲染冒烟**（R56b 新增；此前是明确的验证盲区）。
 *
 * ## 为什么必须有这一套
 * 用户连续三轮实测「插件详情页没有看到配置卡」。前两轮真因：
 *   ① `scope.getSnapshot` 兜底分支写 `settingsScope.getSnapshot()` 而 `settingsScope = scope`
 *      指回自己 ⇒ 命名空间未就绪时**自我递归** ⇒ `RangeError`；
 *   ② `pct1` 定义在 `hintFor` 内部、却在 summary 分支外面调用 ⇒ `ReferenceError`。
 * 两者都被 `CardBoundary` 捕获 ⇒ 页面**一片空白**，只在控制台留一条 warn。
 *
 * ⚠️ 这类 bug 的共同形态：**渲染期/effect 期异常被错误边界吞掉**。`contract.mjs` / `static.mjs`
 * 都是**源文本断言**，对「未定义标识符 / 自递归 / Hook 顺序」完全无效（`node --check` 只查语法）。
 * 本项目已栽过四次（R54 F1/F3、§6.17 `PriceCalculator`、R56 `pct1`、R56b 自递归）
 * ⇒ 必须有**真把组件跑起来**的测试。
 *
 * ## 它做什么（尽量贴近真机，别只跑 render 体）
 * 把 `plugin/client.js` 装进 `vm` 沙箱（React 桩 + 宽松 DOM 桩），**真跑** `apply(ctx)`，
 * 拿到注册进 `plugins.bundle.config` 的组件，然后：
 *   - **真调用** render 体（`page` / `summary`）；
 *   - **真执行** `useEffect` 的回调（R56d 补：effect 里抛错同样会被边界吞掉，而旧版探针**不跑 effect** ⇒ 漏检）；
 *   - **校验 Hook 顺序**（同一 view 连渲两次，调用序列必须一致——React 的
 *     "Rendered fewer hooks than expected" 就是这么判的）；
 *   - **捕获沙箱 console.warn/error**（边界失败时会 warn ⇒ 断言"渲染全程零告警"是最直接的护栏）；
 *   - 断言失败时**卡片必须可见**（R56d：`CardBoundary` 不再 `return null`）。
 * 覆盖三种运行时：A `configForms` 不可用 / B 就绪 / C 命名空间未列出。
 *
 * 退出码：0 = 全通过；1 = 有失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
let failures = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) { console.log(`✅ ${name}`); return true; }
  failures++;
  console.log(`❌ ${name}`);
  if (detail) console.log(`   ↳ ${detail}`);
  return false;
};

const SRC = readFileSync(join(ROOT, 'plugin', 'client.js'), 'utf8');

/* 宽松 DOM 桩：只为不干扰「组件渲染体」这条路径（不是 DOM 测试） */
const anyProxy = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'toString' ? () => '[proxy]' : anyProxy),
  apply: () => anyProxy, set: () => true, has: () => true,
});

const READY_VALUE = {
  enabled: true, effortEnabled: false, effortCooldownMs: 30000, criticalRatio: 0.8, markerMinRatio: 0.3,
  sweepMinIntervalMs: 600000, engineCapMargin: 0.05, retainRatioLight: 0.08, retainRatioStandard: 0.16,
  retainRatioHeavy: 0.24, tplBrief: '', tplCard: '', hudLastAct: '',
};
const mkForms = (namespaces) => ({
  describe: () => ({ getSnapshot: () => ({ view: { namespaces } }), subscribe: () => () => {}, load: () => {} }),
  get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: READY_VALUE }), subscribe: () => () => {}, set: async () => true }),
});

/** 只走 vnode（`$$v`）的遍历——绝不进 `props` 本体，否则会自环；数组要显式展开（`FIELDS.map` 是嵌套数组）。 */
const classesOf = (root) => {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !node.$$v) return;
    if (typeof node.props?.className === 'string') out.push(node.props.className);
    const kids = node.props?.children;
    if (Array.isArray(kids)) kids.forEach(walk);
  };
  walk(root);
  return out;
};

/** 收集 vnode 节点本身（判 textarea 的 rows / button 的文案要用）。 */
const nodesOf = (root) => {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object" || !node.$$v) return;
    out.push(node);
    const kids = node.props?.children;
    if (Array.isArray(kids)) kids.forEach(walk);
  };
  walk(root);
  return out;
};

/** 装沙箱 → 跑 apply → 拿注册 → 真渲两遍 + 真跑 effect。 */
function renderCard(ctxGet) {
  let captured = null;
  let registration = null;
  const warnings = [];
  const hookLog = [];
  const effects = [];

  const mkReact = () => ({
    createElement: (type, props, ...children) => ({ $$v: true, type, props: { ...(props ?? {}), children } }),
    useState: (init) => { hookLog.push('useState'); return [typeof init === 'function' ? init() : init, () => {}]; },
    useEffect: (fn) => { hookLog.push('useEffect'); effects.push(fn); },
    useCallback: (fn) => { hookLog.push('useCallback'); return fn; },
    useMemo: (fn) => { hookLog.push('useMemo'); return fn(); },
    useRef: (init) => { hookLog.push('useRef'); return { current: init }; },
    Fragment: 'Fragment',
    Component: class {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
      setState(next) { Object.assign(this.state, typeof next === 'function' ? next(this.state) : next); }
    },
  });

  const sandboxConsole = {
    info: () => {}, log: () => {},
    warn: (...a) => warnings.push(['warn', ...a].map(String).join(' ')),
    error: (...a) => warnings.push(['error', ...a].map(String).join(' ')),
  };
  const win = {
    __ModuleLoader__: { load: (def) => { captured = def; } },
    __DSH_CONTEXT_PILOT__: {}, addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: { writeText: () => {} } },
  };
  const sandbox = {
    window: win, document: anyProxy, navigator: win.navigator, localStorage: win.localStorage,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval,
    console: sandboxConsole,
    JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp, Error, Symbol, Promise, Set, Map,
    isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'plugin/client.js' });

  const mod = captured.factory((name) => (name === 'react' ? mkReact() : anyProxy));
  /* R56f：卡片可能为**多个 key** 各注册一格（规范名 + profile 旧别名），这里收全部，
   * 只保留最后一次给渲染用例用（组件相同）。 */
  const bundleRegs = [];
  const ctx = {
    get: ctxGet, on: () => {}, effect: () => {}, logger: sandboxConsole,
    slots: {
      inject: (name, factory) => {
        if (name === 'plugins.bundle.config') { const reg = factory(); bundleRegs.push(reg); registration = reg; }
        return { dispose() {} };
      },
      register: (cfg, comp) => ({ cfg, comp }),
      entries: () => [], subscribe: () => () => {},
    },
  };
  const api = mod.exports ?? mod;
  try { api.apply(ctx); } catch { /* apply 自身 try/catch，这里只保证测试继续 */ }

  const out = {
    registered: registration !== null,
    cfg: registration?.cfg ?? null,
    bundleKeys: bundleRegs.map((reg) => reg?.cfg?.key).filter((k) => typeof k === 'string'),
    warnings,
  };
  const firstOrder = {};
  for (const view of ['page', 'summary']) {
    const r = { threw: null, failed: false, classes: [], root: null, hookOrderChanged: false, effectThrew: null };
    for (const pass of [1, 2]) {
      hookLog.length = 0;
      effects.length = 0;
      try {
        const boundary = new registration.comp({ view });
        const vnode = boundary.render();
        if (boundary.state.failed) {
          /* R56d：失败时边界必须渲染**可见**诊断，而不是 null（否则页面一片空白、无从排查） */
          r.failed = true;
          r.classes = classesOf(vnode);
          r.root = vnode?.type ?? null;
        } else {
          const inner = vnode.type({ ...(vnode.props ?? {}), view });
          r.root = inner?.type ?? typeof inner;
          r.classes = classesOf(inner);
          r.nodes = nodesOf(inner);
        }
      } catch (e) { r.threw = `${e.constructor.name}: ${e.message}`; }
      const order = hookLog.join(',');
      if (pass === 1) firstOrder[view] = order;
      else if (order !== firstOrder[view]) r.hookOrderChanged = true;
      /* 真跑 effect（只跑第一遍的，模拟挂载）；effect 抛错同样会被错误边界吞掉 ⇒ 必须检 */
      if (pass === 1) {
        for (const fn of effects) {
          try { const ret = fn(); if (ret && typeof ret.then === 'function') ret.catch(() => {}); }
          catch (e) { r.effectThrew = `${e.constructor.name}: ${e.message}`; }
        }
      }
    }
    out[view] = r;
  }
  return out;
}

const A = renderCard(() => undefined);
const B = renderCard((key) => (key === 'configForms'
  ? mkForms([{ ns: 'dsh-context-pilot' }, { ns: 'bundle.dsh-context-pilot' }, { ns: 'dsh-context-pilot-client' }])
  : undefined));
const C = renderCard((key) => (key === 'configForms' ? mkForms([]) : undefined));

console.log('\n== R56b/d 客户端配置卡真渲染冒烟（plugins.bundle.config）==');

ok('三种运行时都能拿到 plugins.bundle.config 注册',
  A.registered && B.registered && C.registered,
  '注册没拿到 ⇒ 卡片不可能出现在插件详情页');
ok('注册 key 覆盖 profile 可能用到的两个名字（规范名 + @local 旧别名；slot 契约：owner 按 pkg.name 派发）',
  ['dsh-context-pilot', '@local/dsh-context-pilot'].every((k) => (B.bundleKeys ?? []).includes(k)),
  `实际 keys=[${(B.bundleKeys ?? []).join(', ')}] ⇒ 缺哪个，profile 用那个名字时卡片就静默空白（R56f 真机事故）`);

/* ── 三场景 × 两视图的**硬门槛**：不抛、不 failed、effect 不抛、Hook 顺序稳定、零告警 ── */
for (const [label, R] of [['A 未就绪', A], ['B 就绪', B], ['C 命名空间未列出', C]]) {
  for (const view of ['page', 'summary']) {
    const r = R[view];
    ok(`${label} / ${view}：渲染不抛、边界未失败、effect 不抛`,
      r.threw === null && !r.failed && r.effectThrew === null,
      `render=${r.threw ?? 'ok'} boundary=${r.failed ? 'failed（卡片被摘掉）' : 'ok'} effect=${r.effectThrew ?? 'ok'}`);
    ok(`${label} / ${view}：Hook 顺序两次渲染一致（React 会判 Rendered fewer hooks）`,
      r.hookOrderChanged === false,
      'Hook 顺序变化 ⇒ React 抛错 ⇒ 整卡消失');
  }
}
ok('三种运行时渲染全程**零 console 告警**（边界失败必 warn ⇒ 这是最直接的护栏）',
  A.warnings.length === 0 && B.warnings.length === 0 && C.warnings.length === 0,
  `告警：${[...A.warnings, ...B.warnings, ...C.warnings].slice(0, 2).join(' | ')}`);

/* ── 具体形态 ── */
ok('A / page：渲染出只读占位（dcp-panel + dcp-summary）',
  A.page.classes.includes('dcp-panel') && A.page.classes.includes('dcp-summary'),
  `实际 class=${A.page.classes.join(',') || '（空）'}`);
ok('C / page：渲染出只读占位', C.page.classes.includes('dcp-panel'), `class=${C.page.classes.join(',')}`);
ok('B / page：**渲染出配置网格 dcp-grid**（用户要的表单本体）',
  B.page.classes.includes('dcp-grid'),
  `class=${B.page.classes.join(',')} ⇒ 只有占位说明命名空间没绑上`);
ok('B / page：**渲染出「本轮注入（只读）」区 dcp-inj**（R55 新增能力）',
  B.page.classes.includes('dcp-inj'),
  '注入原文区没渲染 ⇒ 用户看不到决策卡/提示词原文');
ok('B / page：配置行数量与 FIELDS 对得上（≥12 行 dcp-row）',
  B.page.classes.filter((c) => c === 'dcp-row').length >= 12,
  `实际 ${B.page.classes.filter((c) => c === 'dcp-row').length} 行`);
ok('B / page：带出保存/恢复按钮',
  B.page.classes.some((c) => c.startsWith('dcp-action')) || B.page.classes.includes('dcp-actions'),
  `class=${B.page.classes.join(',')}`);
ok('B / summary：渲染出汇总行（dcp-summary），不抛',
  B.summary.threw === null && B.summary.classes.includes('dcp-summary'),
  `抛了 ${B.summary.threw ?? '无 dcp-summary'}`);

/* ── R57：模板输入框放大 + 「查看内置文案」按钮（用户 2026-10-19 要求）── */
const tplAreas = B.page.nodes.filter((n) => n.type === "textarea");
ok('R57b：空模板必须显示**空白**（不是 0）—— Number("") === 0 的老坑',
  tplAreas.length >= 2 && tplAreas.every((n) => n.props.value === ""),
  `实际 value=${JSON.stringify(tplAreas.map((n) => n.props.value))} ⇒ 显示 0 会让用户以为模板该填数字（用户实测反馈）`);
ok('R57：模板输入框放大（rows ≥ 8 + 独立 class dcp-tpl，不再与只读 pre 共用小样式）',
  tplAreas.length >= 2 && tplAreas.every((n) => n.props.rows >= 8 && n.props.className === "dcp-tpl"),
  `实际 ${tplAreas.length} 个 textarea：${tplAreas.map((n) => `${n.props.className}/rows=${n.props.rows}`).join(', ')}`);
ok('R57：每个模板框**旁边**有「查看内置文案」按钮',
  B.page.nodes.filter((n) => n.type === "button" && String(n.props.children ?? "").includes("查看内置文案")).length >= 2,
  '按钮缺失 ⇒ 用户无法查看内置原文（需求原话：改成一个按钮，点击查看，放在输入框旁边）');
ok('R57：内置文案来自 host 下发的 inj.builtinBrief/builtinCard（不在 client 复制一份）',
  /inj\?\.builtinBrief/.test(SRC) && /inj\?\.builtinCard/.test(SRC),
  'client 自持一份内置文案 ⇒ 与 host 漂移（改一处忘另一处）');

/* ── R60（2026-10-19 用户实测）：① 缺「思考强度教学」输入框 ② 六段原文要点按钮才展开 ── */
ok('R60：模板输入框有**三个**（新增「思考强度教学模板」——用户要求补的）',
  tplAreas.length >= 3,
  `实际 ${tplAreas.length} 个 textarea ⇒ 思考强度教学仍缺输入框（用户实测反馈）`);
ok('R61：六段注入原文**默认收起**，且**整段一个**开关（用户反馈「查看按钮重复了」）',
  /const \[injAll, setInjAll\] = react\.useState\(false\)/.test(SRC)
  && /injAll \? el\("pre"/.test(SRC)
  && /"收起全部原文" : "展开全部原文"/.test(SRC)
  && !/setInjOpen/.test(SRC),
  '仍每行一个「查看」⇒ 6 个重复按钮（用户实测反馈）；或未默认收起 ⇒ 一屏上千行');

ok('R58/R62：内置文案缺席时给出**可操作**提示（点「刷新注入数据」+ toggle 加载新版 host）',
  /toggle 插件/.test(SRC) && /刷新注入数据/.test(SRC),
  '只说"暂无" ⇒ 用户不知道该怎么办（PANEL-HOWTO §0：host 改动要 toggle 或重启）');

/* ── R62（2026-10-19 用户实测三条）：板块放进卡片 / 按钮有反应 / 内置文案不空 ── */
const iGrid = SRC.indexOf('className: "dcp-grid"');
const iInjSec = SRC.indexOf("injSec,");
const iActions = SRC.indexOf('className: "dcp-actions"', iGrid);
ok('R62：本轮注入板块已**放进带边框的卡片**（.dcp-grid 内、强制压缩冷却之后）',
  iGrid > 0 && iInjSec > iGrid && iActions > 0 && iInjSec < iActions,
  'injSec 仍是 .dcp-grid 的兄弟节点 ⇒ 板块落在卡片外面（用户实测「现在没包含进去」）');
ok('R62：刷新按钮有**可见反馈**，且无注入时展开按钮禁用（用户反馈「2 个按钮点击没什么反应」）',
  /refreshInj/.test(SRC) && /已刷新注入数据/.test(SRC)
  && /disabled: inj === null/.test(SRC) && /本轮还没有注入记录，没有原文可展开/.test(SRC),
  '点了没任何反馈 / 无内容时展开按钮仍可点 ⇒ 用户以为按钮坏了');

/* ── R59：本轮活值 / 生效配置必须并进板块标题行（用户要求「移到板块里面」）──
 * ⚠️ 渲染层断不到「活值」文本：它来自 `inj`，而 `inj` 由 `hudRemoteSvc.getHud()` 填充
 * （句柄经 `ctx.inject` 注入）——沙箱不桩这条远端链路 ⇒ `inj` 恒 null。故本条用**源码形状**断言
 * （精确限定在 `className: "dcp-inj-h"` 块内），渲染层只断言标题行本身存在且能折行。 */
const injHdrBlock = (() => {
  const i = SRC.indexOf('className: "dcp-inj-h"');
  if (i < 0) return "";
  const j = SRC.indexOf('className: "dcp-inj-n" }, "插件实际写进上下文', i);
  return SRC.slice(i, j < 0 ? i + 3000 : j);
})();
ok('R59：本轮活值 + 生效配置已并入「本轮注入」板块**标题行**（不再散落在板块底部）',
  /本轮活值/.test(injHdrBlock) && /生效配置/.test(injHdrBlock),
  '标题行块（dcp-inj-h）里没有活值/生效配置 ⇒ 又跑回板块底部了');
ok('R59：板块底部不再残留活值/生效配置（防"两处都渲染"的重复）',
  !/className: "dcp-inj-n", key: "vals"/.test(SRC),
  '底部仍保留 key:"vals" 那行 ⇒ 同一信息渲染两次');
const injHdrRendered = B.page.nodes.find((n) => n.props?.className === "dcp-inj-h");
ok('R59：标题行确实渲染出来（含板块名 + 刷新按钮）',
  injHdrRendered !== undefined && /刷新/.test(JSON.stringify(injHdrRendered?.props?.children ?? null)),
  '标题行没渲染或缺刷新按钮');
ok('R59：标题行是可换行的 flex 行（并进来后一行放不下，必须能折行）',
  /\.dcp-inj-h\{display:flex;flex-wrap:wrap/.test(SRC),
  '标题行不是 flex-wrap ⇒ 内容溢出或挤成一团');

/* ── R56d：失败必须可见（结构 + 行为）── */
const src = SRC;
ok('R56d：CardBoundary 失败时**不再 return null**（渲染可见诊断块）',
  /if \(this\.state\.failed\) \{[\s\S]{0,400}?className: "dcp-panel"/.test(src) &&
  !/if \(this\.state\.failed\) return null;/.test(src),
  '失败即 return null ⇒ 页面一片空白、用户无任何线索（三轮排查都栽在这里）');
ok('R56d：诊断块里带**错误消息**（用户截图即可定位，不必开 F12）',
  /错误：\$\{this\.state\.message\}/.test(src) && /getDerivedStateFromError\(error\)/.test(src),
  '只显示"失败"而不显示原因 ⇒ 仍要用户开 F12 才能定位');

console.log(`\n${'='.repeat(52)}\n客户端渲染冒烟：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}\n${'='.repeat(52)}`);
process.exit(failures ? 1 : 0);
