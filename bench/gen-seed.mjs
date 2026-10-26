// 长上下文检索基准的种子生成器：产出 seed.md / seed.json / questions.json / answers.json
// 确定性：仅用固定种子 LCG，不用 Math.random / Date.now，重复运行逐字节相同。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const TARGET_BASE_CHARS = 960_000; // 实验口径：≈960k 字符 ≈ 600k token（必须 > 最大预算 240k 的 2 倍，否则各臂都不会真压缩）

let s = 12345;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

const FILES = [
  'plugin/core.mjs', 'plugin/effort.mjs', 'plugin/threshold.mjs', 'plugin/compact-range.mjs',
  'plugin/compact-tool.mjs', 'plugin/session-facts.mjs', 'plugin/m1.snapshot.mjs', 'plugin/m2.inject.mjs',
  'plugin/m3.compact.mjs', 'plugin/m5.hud.mjs', 'plugin/wire.host.mjs', 'plugin/host.impl.mjs',
  'plugin/entry.mjs', 'plugin/client.js', 'plugin/plugin-config.schema.mjs', 'test/boot.mjs',
  'test/contract.mjs', 'test/static.mjs', 'test/client-render.mjs', 'test/report.mjs', 'README.md',
];
const FEATS = [
  '上下文用量注入', '自主压缩续跑', '思考档位切换', '压缩区间选择', '语义锚点保留', 'HUD 刷新节流',
  '最坏字符预算', '分段摘要', '保留区间对齐', 'chip 路由', '悬停刷新', '标注对齐', '降级保护',
  '冷启动自检', '跨仓库同步', '工具开关持久化', '用量口径核对', '长会话压缩回退', '档位记忆', '首屏裁剪',
];
const FNS = [
  'applyCompression', 'pickCompactRange', 'buildUsageSnapshot', 'resolveEffortTier', 'estimateTokens',
  'renderHudLine', 'mergeSessionFacts', 'clampBudget', 'trimWorstCase', 'normalizeAnchors',
  'shouldAutoContinue', 'readPluginConfig', 'projectToolSwitch', 'splitPreservedRange', 'dedupeInjection',
  'collectRoundFacts', 'emitCompactEvent', 'foldSummary', 'measureWorstCase', 'bindHudRefresh',
];
const CONSTS = [
  'COMPACT_MIN_CHARS', 'HUD_THROTTLE_MS', 'ANCHOR_WINDOW', 'WORST_CASE_RATIO', 'KEEP_RECENT_DEFAULT',
  'BUDGET_CEILING', 'SUMMARY_MIN_CHARS', 'TIER_FALLBACK', 'RERANK_TOPK', 'INJECT_INTERVAL',
];
const CFGS = ['autoCompact', 'effortMode', 'injectUsage', 'preserveRange', 'hudEnabled', 'compactThreshold', 'reasoningSplit', 'maxConcurrency'];
const SYMPTS = [
  '压缩后续跑没触发', 'HUD 数字停在上一轮', '档位换了但请求没带上', '长会话到第 40 轮开始报错',
  '偶发拿到一份空摘要', '压缩把待办清掉了', 'chip 显示和执行侧不一致', '用量被重复注入了一次',
  '保留区间跟标注错位', '首屏预算算得偏乐观', '冷启动那轮没统计进去', '配置改了要重启才生效',
];
const SYMPTS2 = ['超长会话下的预算偏移', '空会话时的重复注入', '档位回落时的一次多余渲染', '只读模式下 chip 不更新'];
const ERRS = ['TypeError', 'RangeError', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_INVALID_ARG_TYPE', 'AssertionError', 'EISDIR', 'ENOTEMPTY', 'Error [ERR_OUT_OF_RANGE]'];
const REVS = ['小李', '王工', '阿哲', 'Mia', '老赵', 'Kimi', 'Qoder', '周墨'];
const DOCS = ['cost-model.md', 'milestones.md', 'api-notes.md', 'compaction-failure-diagnosis.md', 'd1-module-split-brief.md', 'r7-review-and-hardening.md'];
const TOOLS = ['npm run test:contract', 'npm run test:boot', 'npm run test:static', 'npm run test:report', 'npm run dev -- --watch'];

const mkVer = () => pick([
  () => `v0.1.${int(20, 99)}`,
  () => `v0.2.${int(0, 12)}`,
  () => `v0.3.0-rc.${int(1, 9)}`,
])();

function fill(tpl, V) {
  let lastF = null;
  let lastPass = null;
  const out = tpl.replace(/\{(\w+)\}/g, (_m, k) => {
    switch (k) {
      case 'V': if (V === undefined) throw new Error('missing needle value'); return V;
      case 'f': lastF = pick(FILES); return lastF;
      case 'a': { let x = pick(FILES); if (x === lastF) x = FILES[(FILES.indexOf(x) + 7) % FILES.length]; return x; }
      case 'feat': return pick(FEATS);
      case 'fn': return pick(FNS);
      case 'fn2': return pick(FNS);
      case 'const': return pick(CONSTS);
      case 'cfg': return pick(CFGS);
      case 'sym': return pick(SYMPTS);
      case 'sym2': return pick(SYMPTS2);
      case 'err': return pick(ERRS);
      case 'rev': return pick(REVS);
      case 'doc': return pick(DOCS);
      case 'tool': return pick(TOOLS);
      case 'ver': return mkVer();
      case 'pass': lastPass = int(24, 61); return String(lastPass);
      case 'total': lastPass = lastPass ?? int(24, 61); return String(lastPass + int(1, 4));
      case 'n': return String(int(2, 64));
      case 'n2': return String(int(1, 19));
      case 'n3': return String(int(3, 17));
      case 'pct': return String(int(3, 42));
      case 'ms': return String(int(120, 1800));
      default: throw new Error(`unknown token {${k}}`);
    }
  });
  return zhSpace(out);
}

// 中文之间不留多余半角空格（代码标识符两侧的空格保留）
const CJK_RE = /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]$/;
const isCJK = (c) => c !== undefined && CJK_RE.test(c);
function zhSpace(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ' ' && isCJK(t[i - 1]) && isCJK(t[i + 1])) continue;
    out += t[i];
  }
  return out;
}

const T = {
  'user-req': ['user', [
    '先把问题说清楚：{feat}在长会话里又出问题了，{sym}，而且是在第 {n} 轮之后才复现，前面几轮看着都正常。要求很简单：别动 {f} 的对外接口，只把 {feat} 这条链路修稳，改完把 diff 给我看。',
    '这轮想加个能力：让 {feat} 在 {a} 里也生效，现在只有 {f} 走这条路径，另一半完全没接。别一上来就重构，先跑通，再谈要不要抽公共层。',
    '{rev}提了个意见，说 {feat} 的实现太绕，看能不能直接用 {fn} 替掉现在的写法。你先判断方向对不对，对再动手，不要糊一层兼容代码。',
    '线上反馈：{sym}。日志里只有孤零零一行 {err}。我不想先猜，你从 {f} 的入口顺着调用链读一遍，把 {feat} 涉及的状态流转列出来再决定改哪里。',
    '我重新捋了一遍：{feat} 的目标是省字符不是省轮次。现在 {fn} 的行为偏乐观，一轮能少算 {pct}% 的预算。把默认值改保守，宁可少压缩也别丢上下文。',
    '有个细节一直别扭：{a} 里的 {cfg} 和 {f} 里的 {const} 是两套默认值。这轮不求新功能，就把它俩对齐，顺手清掉重复判断。',
    '先停一下新功能。{feat} 现在能跑，但 {n} 轮以上的会话耗时涨得很明显，量了一下 p95 到 {ms}ms。这轮只做性能侧的收口，别的一律不碰。',
  ]],
  'user-push': ['user', [
    '我不接受“暂时没复现”。{sym} 在我这边稳定出现，{f} 第 {n} 行那个分支一定有问题，加一行日志再跑一次。',
    '这个改法范围太大了。{a} 那边有 {n3} 处调用，你动 {fn} 等于全都要跟着改，先只保住 {feat} 这条主路径。',
    '方向对，但你把 {feat} 和 {fn2} 搞混了。前者是判定，后者是执行。先把 {const} 的语义定下来再往下写。',
    '同意，按这个来。别再顺手扩范围了。',
    '你确定这是根因？我要证据，不要推理。把 {tool} 的原始输出贴出来。',
    '先把 {f} 里那段注释删掉，写太多反而看不懂。逻辑没问题就提交。',
  ]],
  'user-review': ['user', [
    '{rev}的 review 意见，原话贴给你：「{f} 里 {fn} 的边界没兜住，{const} 为 0 时会走进 {feat} 的死循环分支；另外配置和代码里有两个默认值，迟早出事。」确认是否成立，成立就改，不成立给证据。',
    '又收到一条审查：{a} 的 {fn2} 返回值没做类型收窄，{err} 就是从这儿冒出来的可能。你看下是不是真的，别为了应付而改。',
    '{rev}觉得 {feat} 这段可读性差，建议在 {f} 里把判定和执行拆成两个函数。你怎么看？拆的收益我担心只是心理安慰。',
    '静态检查那边报了个警告：{f} 的 {cfg} 分支永真。先判断是误报还是我们逻辑写松了。',
  ]],
  'ast-plan': ['assistant', [
    '我先读了一遍 {f} 和 {a}，链路是这样的：{fn} 拿到本轮用量，交给 {fn2} 判断是否越线，越了才走 {feat}。问题出在中间那份快照，它记的是上一轮的 {const}，所以第一次判定永远偏小。计划分三步：一、把快照读写挪到 {fn} 之前；二、{const} 缺省时给保守值而不是零；三、补一条断言防止顺序被换回去。这轮只做前两步。',
    '定位到了：{feat} 的判定依赖 {f}，但执行侧在 {a}，两边各自算了一次预算，算法差 {pct}%。我打算把预算计算收敛成 {fn} 单点，其他调用只读不重算。',
    '不改接口也能修：在 {f} 里让 {fn2} 幂等，重复注入直接返回同一份。风险是 {feat} 的耗时增加，我先把 {const} 的下限设成 {n2}。',
    '读完了。{fn} 本身没问题，问题在它上游：{a} 传下来的 range 没裁剪，{feat} 拿到的就是脏数据。所以我倾向在 {a} 的出口加裁剪，而不是在 {fn} 里兜底，兜底会掩盖调用方的错。',
  ]],
  'ast-edit': ['assistant', [
    '改完，只动了 {f}。核心是把 `{const}` 的判定从 `>` 换成 `>=`，另外 {fn} 里加了 early return，避免 {feat} 在空数组上空转。新增 {n} 行、删掉 {n2} 行。没动 {a}，那边调用方 {n3} 处，全改就不叫修 bug 了。',
    '落地：{f} 抽出 {fn}，{a} 改成只调用它；{cfg} 的默认值现在单一来源；顺手把 {fn2} 的返回值收窄成对象。跑之前先说一点 —— {feat} 的行为会变严格，之前能过的边界这轮可能会红。',
    '只加不改：{f} 里补了 {fn}，原来的 {fn2} 保留但标记内部使用，等下轮再删。这样 {feat} 的调用链在 {n3} 处调用点上都不用动。',
    '改了 {a}：{fn} 增加第二参 budgetNow，缺省取 {const}。{f} 侧同步传参，判定顺序没动。文档 README.md 里那行说明也跟着更新了。',
  ]],
  'ast-test': ['assistant', [
    '跑了 {tool}，{pass}/{total} 通过，剩一条挂在 {feat} 上：断言期望 {n2} 实际 {n}。看输出不是逻辑错，是这条用例把 {const} 写死了，改默认值它就红。我把用例改成读配置而不是读常量，再跑一遍。',
    '回归跑完：{tool} 全绿；{tool} 有一条超时 {ms}ms，是磁盘上那份快照没清理导致的偶发，不是我改的东西引入的。重跑一次就过了。',
    '静态检查过了，类型层面 {f} 和 {a} 都没报错。{feat} 相关的用例补了 {n2} 条：空数组、{const} 为 0、超长会话三种边界。',
    '测试结果有点意外：原本担心的 {err} 没出现，反倒是 {fn2} 那条老用例红了。原因是它断言的是旧默认值，这个断言本来就该跟着 {cfg} 走，我改了用例。',
  ]],
  'ast-error': ['assistant', [
    '复现出来了：{err}，栈顶在 {f} 的 {fn} 第 {n} 行。原因是 {feat} 走到压缩分支时，{a} 传下来的 range 已经越界，{fn2} 没做钳制就把 {const} 当索引用了。平时看不见，是因为 {n3} 轮以下的会话根本进不了那个分支。',
    '又一个坑：{tool} 报 {err}。查下来是 {a} 在 {fn} 之前就把 {feat} 的状态清了，导致 {fn2} 读到 null。这属于顺序问题，不是空值问题，所以我只加了一个断言，没到处加 `??`。',
    '日志拿到关键一行了：{f} 打出 `{cfg}={n2}`，但 {a} 期望的是 {n}。两边口径不一致，这就是 {sym} 的直接来源。',
  ]],
  'ast-fix': ['assistant', [
    '修法是 {fn} 里对 range 做 `clamp(0, len)`，并在 {feat} 失败时回退成原样输出，宁可不做压缩。加了条日志方便下次区分回退和漏压。顺手把 {const} 默认值改成 {n2}，跟文档对齐。',
    '回退方案定了：{f} 判定失败就不注入，把决定权交回 {fn2}。好处是不会出现错误续跑，代价是最坏情况多耗 {pct}% 预算，我接受。',
    '根因不在 {fn}，在 {a} 的缓存键：同一个会话在 {feat} 下会生成两份键。我改成先查后建，并把 {const} 作为键的一部分。复现脚本连跑 {n} 次不再抖。',
  ]],
  'ast-decide': ['assistant', [
    '这里有个取舍：如果让 {fn2} 直接返回预算，{f} 更干净，但 {feat} 的调用方全都要改。我倾向先在 {a} 加一层薄适配，下轮再统一。你要是觉得留债不好，我就一次改到位，反正调用方只有 {n3} 处。',
    '两种写法我选了后者：不做向后兼容，直接把 {cfg} 改名成一份，旧的读法在 {f} 里报错退出。理由是配置错着比崩掉更难查。',
    '关于 {feat} 要不要设硬阈值：现在靠 {const} 软判定。我倾向不加硬阈值，因为硬阈值会在超长会话里把待办挤掉，那正是 {sym} 的那类表现。',
  ]],
  'ast-release': ['assistant', [
    '发版：`dsh-context-pilot@{ver}`。本轮包含：{feat} 修复、{fn} 边界保护、{a} 日志降级；无破坏性变更。DSH 兼容范围仍是 `>=0.2.0-rc.2 <0.3.0-0`。装完重启一次，{feat} 的默认值只在启动时读。',
    '打 tag {ver}，CHANGELOG 只写三行：{feat} 口径统一、{fn} 增加钳制、{const} 默认值调整。回滚方式也写了：把 {cfg} 显式设为 false 即可退回上一行为。',
  ]],
  'ast-notes': ['assistant', [
    '记到 docs/{doc}：{feat} 的判定顺序是 {fn} → {fn2} → {a}，后面谁改顺序必须同时改 {const} 默认值，否则预算会偏。这轮留了个尾巴：{sym2} 只在超长会话出现，暂时没排期。',
    'todo 更新：一、{f} 里那份重复的 {fn2} 下轮删；二、{feat} 需要一条专门的压测；三、README.md 的 {cfg} 说明落后于实现。优先级不高，但都要记下来。',
    '把口径统一记一下：以后 {feat} 一律以字符计，不再混用 token，估算统一走 {fn}。相关文档和 {a} 里的注释都改了。',
  ]],
};

function make(kind) {
  const [role, tpls] = T[kind];
  return { role, kind, text: fill(pick(tpls)) };
}

function shortUser() {
  return {
    role: 'user', kind: 'user-short', text: pick([
      '先别加依赖，我本地装不动。', '同意，按你说的走。', '再跑一遍 {tool}，重点看 {f}。',
      '这段解释可以，但把 {feat} 的影响写清楚。', '不要动 {a}，那文件是别人在改。',
      '{err} 这个我已经知道了，先看主流程。', '行，这轮到此为止，下一轮再说 {feat}。',
    ].map((x) => fill(x))),
  };
}

function buildRound(rn) {
  const out = [make('user-req')];
  const planFirst = chance(0.6);
  if (planFirst) out.push(make('ast-plan'));
  const steps = int(2, 4);
  for (let i = 0; i < steps; i++) out.push(make(pick(['ast-edit', 'ast-test', 'ast-error'])));
  if (!planFirst && chance(0.4)) out.push(make('ast-plan'));
  if (chance(0.5)) {
    out.push(chance(0.6) ? make('user-push') : shortUser());
    out.push(make(pick(['ast-fix', 'ast-decide', 'ast-error'])));
    if (chance(0.5)) out.push(make('ast-test'));
  }
  if (chance(0.3)) {
    out.push(make('user-review'));
    out.push(make(pick(['ast-fix', 'ast-edit'])));
    if (chance(0.4)) out.push(make('ast-decide'));
  }
  if (chance(0.22)) out.push(make('ast-release'));
  if (chance(0.3)) out.push(make('ast-notes'));
  return out.map((p) => ({ ...p, round: rn }));
}

// ---- needle 定义：value 短、唯一、可精确搜索；ctx 为注入句（含 {V} 占位）----
const NEEDLE_DEFS = [
  { id: 'K01', value: 'v0.9.42-beta', want: 5, host: 'ast-release', ctx: '这轮对外只发了一个预发布包 {V}，主干版本号没动，别把它当成正式版。' },
  { id: 'K02', value: 'CASE-4471', want: 10, host: 'user-req', ctx: '对方把那次的工单编号也给我了，是 {V}，日志在附件里，我不在这儿重复贴。' },
  { id: 'K03', value: '根因=缓存键冲突', want: 14, host: 'ast-fix', ctx: '最后写进结论只有一行：{V}，其它现象都是这一条的派生。' },
  { id: 'K04', value: 'MAX_RETRY=7', want: 40, host: 'ast-error', ctx: '为了验证重试上限，我临时在 {f} 里把它调成 {V}，之后一直没回滚。' },
  { id: 'K05', value: 'anchor_window=13', want: 50, host: 'ast-notes', ctx: '语义锚点窗口最终定的是 {V}，再大就会把待办挤出去，这个值不要再调。' },
  { id: 'K06', value: 'qps_guard_3017', want: 60, host: 'ast-decide', ctx: '压测脚本里那个开关名字起得很随意，叫 {V}，一路没人肯改它。' },
  { id: 'K07', value: 'ERR_KEEP_RANGE_DRIFT', want: 83, host: 'ast-error', ctx: '新增的错误码 {V} 只在超长会话里触发过，普通会话看不到。' },
  { id: 'K08', value: 'budget_floor_2860', want: 88, host: 'ast-fix', ctx: '最坏字符预算的下限是 {V}，低于这个值直接跳过压缩，不要硬算。' },
  { id: 'K09', value: 'v0.2.1-compat.9', want: 93, host: 'ast-release', ctx: '给兼容分支单独打的是 {V}，正式安装包里不带这个标签。' },
  { id: 'K10', value: 'KEEP_RECENT_TURNS=4', want: 20, host: 'ast-edit', ctx: '那条写死的默认值是 {V}，写在 {f} 顶部，配置里读不到它。' },
  { id: 'K11', value: 'hud_refresh_900ms', want: 50, host: 'ast-test', ctx: '悬停刷新节流那段时间调过一轮 {V}，之后没人再动过。' },
  { id: 'K12', value: '冲突裁定=Kimi-GPT5', want: 70, host: 'user-review', ctx: '那次双模型交叉审查的记录末尾，写的是 {V}，以它为准。' },
];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function countOccur(hay, needle) {
  let i = 0, c = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
  return c;
}

// 生成正文段落，直到基础字符数达标
const paras = [];
let baseLen = 0;
for (let rn = 1; baseLen < TARGET_BASE_CHARS; rn++) {
  const round = buildRound(rn);
  paras.push(...round);
  baseLen = paras.reduce((a, p) => a + p.text.length + 2, -2);
}

const baseText = paras.map((p) => p.text).join('\n\n');

// needle 唯一性自检 + 确定性重试（改数字位）
const needles = [];
for (const def of NEEDLE_DEFS) {
  let value = def.value;
  let ok = false;
  for (let attempt = 0; attempt < 8 && !ok; attempt++) {
    if (countOccur(baseText, value) === 0) ok = true;
    else {
      const m = value.match(/(\d+)/);
      if (!m) break;
      value = value.replace(/(\d+)/, (d) => String(+d + 13).padStart(d.length, '0'));
    }
  }
  if (!ok) fail(`needle ${def.id} 候选值在正文中重复：${value}`);
  if (value.length < 8 || value.length > 24) fail(`needle ${def.id} 长度越界：${value.length}`);
  needles.push({ ...def, value, paraText: fill(def.ctx, value) });
}

const paraById = new Map(needles.map((n) => [n.id, n]));

// 计算段落起始偏移
function offsetsOf(list) {
  const offs = [];
  let cur = 0;
  for (const p of list) { offs.push(cur); cur += p.text.length + 2; }
  return offs;
}
const estInjection = needles.reduce((a, n) => a + n.paraText.length + 1, 0);
const estFinalLen = baseText.length + estInjection;
const offs = offsetsOf(paras);

// 放置：接在段落末尾，读起来像这轮补充的一句；按段落结尾偏移选最接近目标的宿主段落
const placements = [];
for (const n of needles) {
  const target = Math.round((n.want / 100) * estFinalLen);
  const ends = offs.map((o, i) => o + paras[i].text.length);
  const errOf = (i) => Math.abs(ends[i] - target) + (paras[i].kind === n.host ? 0 : 12_000);
  let cand = 0;
  for (let i = 1; i < ends.length; i++) if (errOf(i) < errOf(cand)) cand = i;
  placements.push({ id: n.id, para: cand, at: paras[cand].text.length });
}

// 按段落倒序插入到句子边界，产出最终段落
const finalParas = paras.map((p) => ({ ...p }));
{
  const groups = new Map();
  for (const pl of placements) {
    if (!groups.has(pl.para)) groups.set(pl.para, []);
    groups.get(pl.para).push(pl);
  }
  for (const [pi, list] of groups) {
    list.sort((a, b) => b.at - a.at);
    let text = paras[pi].text;
    for (const pl of list) {
      const cut = Math.min(pl.at, text.length);
      text = text.slice(0, cut) + paraById.get(pl.id).paraText + text.slice(cut);
    }
    finalParas[pi].text = text;
  }
}

const seedText = finalParas.map((p) => p.text).join('\n\n');

// 自检：每个 needle 恰好出现一次
for (const n of needles) {
  const c = countOccur(seedText, n.value);
  if (c !== 1) fail(`needle ${n.id} (${n.value}) 在 seed.md 中出现 ${c} 次，期望 1 次`);
}

// 分组成 messages（连续同角色段落合并）
const messages = [];
for (const p of finalParas) {
  const last = messages[messages.length - 1];
  if (last && last.role === p.role) last.parts.push(p.text);
  else messages.push({ role: p.role, parts: [p.text] });
}
const msgTexts = messages.map((m) => m.parts.join('\n\n'));
if (msgTexts.join('\n\n') !== seedText) fail('messages 拼接结果与 seed.md 不一致');

// 计算 msgIndex / charInMsg / depthPct
const msgStarts = [];
let acc = 0;
for (const t of msgTexts) { msgStarts.push(acc); acc += t.length + 2; }
const needleOut = [];
for (const n of needles) {
  const g = seedText.indexOf(n.value);
  let mi = msgStarts.length - 1;
  for (let i = 0; i < msgStarts.length; i++) {
    if (g >= msgStarts[i] && g < msgStarts[i] + msgTexts[i].length) { mi = i; break; }
  }
  const depthPct = Number(((g / seedText.length) * 100).toFixed(2));
  const charInMsg = g - msgStarts[mi];
  if (msgTexts[mi].slice(charInMsg, charInMsg + n.value.length) !== n.value) fail(`${n.id} 定位失败`);
  needleOut.push({ id: n.id, value: n.value, msgIndex: mi, charInMsg, depthPct });
}

// 深度分布自检
const band = (id, d) => {
  const i = Number(id.slice(1));
  if (i <= 3) return d <= 15;
  if (i <= 6) return d >= 35 && d <= 65;
  if (i <= 9) return d >= 80 && d <= 95;
  const want = { 10: 20, 11: 50, 12: 70 }[i];
  return Math.abs(d - want) <= 3;
};
for (const n of needleOut) if (!band(n.id, n.depthPct)) fail(`${n.id} 深度 ${n.depthPct}% 不满足分布要求`);
if (needleOut.length !== 12) fail('needle 数量不是 12');
const chars = seedText.length;
if (chars < 900_000 || chars > 1_040_000) fail(`字符数 ${chars} 超出 900k-1040k`);

// 题目与答案
const QUESTIONS = {
  K01: '有一版只对外发过、没进正式主干的预发布包，它的版本号是什么？',
  K02: '外部用户反馈时提供的那个工单编号是多少？',
  K03: '有次排查写到最后，结论只留了一行，那一行的原文是什么？',
  K04: '为了验证重试上限，有人临时把重试相关常量写成什么值，之后一直没回滚？',
  K05: '语义锚点窗口最后定下来的那个取值是多少？',
  K06: '压测脚本里那个没人肯改名的开关标识是什么？',
  K07: '只在超长会话才会触发的那个新增错误码叫什么？',
  K08: '最坏字符预算不再硬算的那个下限取值是多少？',
  K09: '给兼容分支单独打的那个标签版本号是什么？',
  K10: '写在文件顶部、配置读不到的那条“保留最近轮数”的写死默认值是什么？',
  K11: '悬停刷新节流曾经调到过的那个时间取值叫什么？',
  K12: '双模型交叉审查记录末尾、作为最终依据的那行结论是什么？',
};
const CONTROL_DEFS = [
  '历史里有没有一个叫 parseYamlPatches 的函数？它在哪个文件？',
  '我们发过 v0.9.99 这个正式版本吗？CHANGELOG 写了什么？',
  '项目里哪一处用到了 koa-router？给出调用点。',
  '配置项 enableQuantumCache 的默认值是多少？',
];
const CONTROL_TOKENS = ['parseYamlPatches', 'v0.9.99', 'koa-router', 'enableQuantumCache'];
CONTROL_TOKENS.forEach((t, i) => { if (seedText.includes(t)) fail(`control C0${i + 1} 的 ${t} 竟出现在正文里`); });

const questions = needles.map((n, i) => ({
  id: `Q${String(i + 1).padStart(2, '0')}`, ask: QUESTIONS[n.id], needle: n.id,
}));
if (questions.length !== 12) fail('题目数不是 12');
for (const q of questions) {
  const nv = needleOut.find((n) => n.id === q.needle).value;
  if (q.ask.includes(nv)) fail(`${q.id} 的问题泄露了答案`);
}
const controls = CONTROL_DEFS.map((ask, i) => ({ id: `C${String(i + 1).padStart(2, '0')}`, ask, expected: '不知道' }));

const seedJson = {
  meta: { chars, estimatedTokens: Math.round(chars / 1.6), needles: needleOut.length, controls: controls.length },
  messages: msgTexts.map((t, i) => ({ role: messages[i].role, text: t })),
  needles: needleOut,
};
const answers = { answers: Object.fromEntries(questions.map((q, i) => [q.id, needleOut[i].value])), controls: Object.fromEntries(controls.map((c) => [c.id, '不知道'])) };

writeFileSync(path.join(OUT, 'seed.md'), seedText, 'utf8');
writeFileSync(path.join(OUT, 'seed.json'), JSON.stringify(seedJson, null, 2) + '\n', 'utf8');
writeFileSync(path.join(OUT, 'questions.json'), JSON.stringify({ questions, controls }, null, 2) + '\n', 'utf8');
writeFileSync(path.join(OUT, 'answers.json'), JSON.stringify(answers, null, 2) + '\n', 'utf8');

console.log(`seed.md chars = ${chars}`);
console.log(`estimatedTokens = ${Math.round(chars / 1.6)} (chars/1.6)`);
console.log(`paragraphs = ${finalParas.length}, messages = ${msgTexts.length} (user=${messages.filter((m) => m.role === 'user').length}, assistant=${messages.filter((m) => m.role === 'assistant').length})`);
console.log(`needles = ${needleOut.length}, controls = ${controls.length}`);
for (const n of needleOut) console.log(`  ${n.id} depth=${String(n.depthPct).padStart(6)}% msg=${String(n.msgIndex).padStart(4)} charInMsg=${String(n.charInMsg).padStart(6)} value=${n.value}`);
for (const f of ['seed.md', 'seed.json', 'questions.json', 'answers.json']) console.log(`written: bench/${f}`);
console.log('OK');
