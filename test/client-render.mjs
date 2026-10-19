#!/usr/bin/env node
/**
 * test/client-render.mjs —— **客户端配置卡真渲染冒烟**（R56b 新增；此前是明确的验证盲区）。
 *
 * ## 为什么必须有这一套
 * 用户连续两轮实测「插件详情页没有看到配置卡」。真因：`apply()` 里 `scope.getSnapshot` 的
 * **兜底分支写的是 `settingsScope.getSnapshot()`**，而下方 `settingsScope = scope` 又把它指回
 * 自己 ⇒ 命名空间未就绪时 `getSnapshot` **自我递归** ⇒ 渲染期
 * `RangeError: Maximum call stack size exceeded` ⇒ 被 `CardBoundary` 捕获 ⇒ `return null`
 * ⇒ **配置卡从来就没渲染过**（用户历次截图里那块空白）。
 *
 * ⚠️ 这类 bug 的共同形态：**渲染期异常被错误边界吞掉** ⇒ 页面"什么都没有"，只在控制台留一条
 * `console.warn`。而 `contract.mjs` / `static.mjs` 都是**源文本断言**，对「未定义标识符 / 自递归」
 * 完全无效（`node --check` 也只查语法）——本项目已经栽过四次（R54 F1/F3、§6.17 `PriceCalculator`、
 * R56 `pct1`、R56b 自递归）。⇒ 必须有**真把组件跑起来**的测试。这一套就是它。
 *
 * ## 它做什么
 * 把 `plugin/client.js` 装进 `vm` 沙箱（React 桩 + 宽松 DOM 桩），**真跑** `apply(ctx)`，
 * 拿到注册进 `plugins.bundle.config` 的组件，再**真调用**它的 render 体（`page` / `summary`），
 * 覆盖三种运行时：
 *   A `configForms` 不可用     ⇒ 只读占位必须渲染（不得抛）
 *   B `configForms` 就绪       ⇒ **必须渲染出配置网格 `dcp-grid` 与「本轮注入」区 `dcp-inj`**
 *   C 命名空间未列出           ⇒ 只读占位必须渲染（不得抛）
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

/* ── React 桩：够跑通函数组件的 render 体（hook 只需返回可用值，不需要真调度） ── */
const mkReact = () => ({
  createElement: (type, props, ...children) => ({ $$v: true, type, props: { ...(props ?? {}), children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: (init) => ({ current: init }),
  Fragment: 'Fragment',
  Component: class {
    constructor(props) { this.props = props ?? {}; this.state = {}; }
    setState(next) { Object.assign(this.state, typeof next === 'function' ? next(this.state) : next); }
  },
});
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

/** 只走 vnode（`$$v`）的遍历——绝不进 `props` 本体，否则会自环（写探针时真踩过）。 */
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

/** 装沙箱 → 跑 apply → 拿注册 → 真调 render 体。返回 { page, summary } 各自的结果。 */
function renderCard(ctxGet) {
  let captured = null;
  let registration = null;
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
    console: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp, Error, Symbol, Promise, Set, Map,
    isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'plugin/client.js' });

  const mod = captured.factory((name) => (name === 'react' ? mkReact() : anyProxy));
  const ctx = {
    get: ctxGet, on: () => {}, effect: () => {}, logger: console,
    slots: {
      inject: (name, factory) => { if (name === 'plugins.bundle.config') registration = factory(); return { dispose() {} }; },
      register: (cfg, comp) => ({ cfg, comp }),
      entries: () => [], subscribe: () => () => {},
    },
  };
  const api = mod.exports ?? mod;
  try { api.apply(ctx); } catch { /* apply 自身 try/catch，这里只保证测试继续 */ }

  const out = { registered: registration !== null, cfg: registration?.cfg ?? null };
  for (const view of ['page', 'summary']) {
    const r = { threw: null, failed: false, classes: [], root: null };
    try {
      const boundary = new registration.comp({ view });
      const vnode = boundary.render();
      if (boundary.state.failed) r.failed = true;
      else {
        const inner = vnode.type({ ...(vnode.props ?? {}), view });
        r.root = inner?.type ?? typeof inner;
        r.classes = classesOf(inner);
      }
    } catch (e) { r.threw = `${e.constructor.name}: ${e.message}`; }
    out[view] = r;
  }
  return out;
}

const A = renderCard(() => undefined);
const B = renderCard((key) => (key === 'configForms'
  ? mkForms([{ ns: 'dsh-context-pilot' }, { ns: 'bundle.dsh-context-pilot' }, { ns: 'dsh-context-pilot-client' }])
  : undefined));
const C = renderCard((key) => (key === 'configForms' ? mkForms([]) : undefined));

console.log('\n== R56b 客户端配置卡真渲染冒烟（plugins.bundle.config）==');

ok('三种运行时都能拿到 plugins.bundle.config 注册',
  A.registered && B.registered && C.registered,
  '注册没拿到 ⇒ 卡片不可能出现在插件详情页');
ok('注册 key = 包名 dsh-context-pilot（slot 契约：owner 按 pkg.name 派发）',
  B.cfg?.key === 'dsh-context-pilot',
  `实际 key=${B.cfg?.key} ⇒ 键写错则永不命中（页面空白）`);

/* A：命名空间未就绪 ⇒ 只读占位，**绝不能抛**（自递归事故的回归点） */
ok('A 命名空间未就绪 / page：渲染不抛（自递归回归护栏）',
  A.page.threw === null && !A.page.failed,
  `抛了 ${A.page.threw ?? 'CardBoundary failed'} ⇒ 整卡静默消失（用户实测事故）`);
ok('A / page：渲染出只读占位（dcp-summary + dcp-panel）',
  A.page.classes.includes('dcp-panel') && A.page.classes.includes('dcp-summary'),
  `实际 class=${A.page.classes.join(',') || '（空）'}`);
ok('A / summary：渲染出汇总行（dcp-summary），不抛',
  A.summary.threw === null && A.summary.classes.includes('dcp-summary'),
  `抛了 ${A.summary.threw ?? '无 dcp-summary'}`);

/* C：configForms 在但没列出本命名空间 ⇒ 同 A */
ok('C 命名空间未列出 / page：渲染不抛（同上回归点）',
  C.page.threw === null && !C.page.failed,
  `抛了 ${C.page.threw ?? 'CardBoundary failed'}`);
ok('C / page：渲染出只读占位', C.page.classes.includes('dcp-panel'), `class=${C.page.classes.join(',')}`);

/* B：就绪 ⇒ **用户要看的表单与注入区必须真渲染出来** */
ok('B 命名空间就绪 / page：渲染不抛',
  B.page.threw === null && !B.page.failed,
  `抛了 ${B.page.threw ?? 'CardBoundary failed'}`);
ok('B / page：**渲染出配置网格 dcp-grid**（用户要的表单本体）',
  B.page.classes.includes('dcp-grid'),
  `class=${B.page.classes.join(',')} ⇒ 只有占位说明命名空间没绑上`);
ok('B / page：**渲染出「本轮注入（只读）」区 dcp-inj**（R55 新增能力）',
  B.page.classes.includes('dcp-inj'),
  '注入原文区没渲染 ⇒ 用户看不到决策卡/提示词原文');
ok('B / page：配置行数量与 FIELDS 对得上（≥12 行 dcp-row）',
  B.page.classes.filter((c) => c === 'dcp-row').length >= 12,
  `实际 ${B.page.classes.filter((c) => c === 'dcp-row').length} 行`);
ok('B / page：带出保存/恢复按钮（dcp-actions 存在）',
  B.page.classes.some((c) => c.startsWith('dcp-action')) || B.page.classes.includes('dcp-actions'),
  `class=${B.page.classes.join(',')}`);
ok('B / summary：渲染出汇总行（dcp-summary），不抛',
  B.summary.threw === null && B.summary.classes.includes('dcp-summary'),
  `抛了 ${B.summary.threw ?? '无 dcp-summary'}`);

console.log(`\n${'='.repeat(52)}\n客户端渲染冒烟：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}\n${'='.repeat(52)}`);
process.exit(failures ? 1 : 0);
