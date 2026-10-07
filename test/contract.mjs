#!/usr/bin/env node
/**
 * test/contract.mjs —— 三端契约对账（face 方法表 ↔ client 描述符 ↔ TYPERT）。
 *
 * 为什么需要（P29 教训，本项目已踩坑）：face 的协议契约散在三处——
 *   ① host `wire.host.mjs` 的 FACE_METHOD_TABLE（运行时 face 实例 + TYPERT 声明）
 *   ② client `client.js` 的 REMOTE_CONTRIBUTION.descriptors（$mount 时声明给宿主）
 *   ③ TYPERT（同一文件派生，供 typert-loader 自动发现）
 * 三者漂移 = **调用静默失败**（不报错、只是拿不到数据）。本脚本用**源码静态解析**对账，
 * 不启动 DSH、不依赖运行时——可随时跑。
 *
 * 用法：node test/contract.mjs
 * 退出码：0 = 全通过；1 = 有漂移
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');

let failures = 0;
let checks = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`);
  }
};

const read = (f) => readFileSync(join(PLUGIN, f), 'utf8');

/* ═══════════ 1. FACE_NAME 三处一致 ═══════════ */
console.log('\n== 1. FACE_NAME 一致性（wire ↔ client）==');
const wire = read('wire.host.mjs');
const client = read('client.js');

const wireFace = /export const FACE_NAME = ['"]([^'"]+)['"]/.exec(wire)?.[1];
const clientFace = /const HUD_FACE = ["']([^"']+)["']/.exec(client)?.[1];
ok('wire.host.mjs 导出 FACE_NAME', !!wireFace, '未找到 `export const FACE_NAME = ...`');
ok('client.js 声明 HUD_FACE', !!clientFace, '未找到 `const HUD_FACE = ...`');
ok(`FACE_NAME 一致（${wireFace}）`, wireFace && wireFace === clientFace,
  `wire=${wireFace} client=${clientFace}`);

/* ═══════════ 2. 方法集与参数表对账 ═══════════ */
console.log('\n== 2. 方法集与参数表（FACE_METHOD_TABLE ↔ REMOTE_CONTRIBUTION）==');

// wire：FACE_METHOD_TABLE = [['getHud', ['sid'], '签名', ['sid']], ...]
const tableBlock = /const FACE_METHOD_TABLE = \[([\s\S]*?)\n\];/.exec(wire)?.[1] ?? '';
const wireMethods = [...tableBlock.matchAll(/\[\s*'([^']+)'\s*,\s*\[([^\]]*)\]/g)].map((m) => ({
  method: m[1],
  params: m[2].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean),
}));

// client：descriptors 里 method + parameters[].name
const descBlock = /descriptors:\s*\[([\s\S]*?)\n\t\t\t\],/.exec(client)?.[1] ?? client;
const clientMethods = [...descBlock.matchAll(/method:\s*"([^"]+)"[\s\S]*?parameters:\s*\[([\s\S]*?)\]/g)].map((m) => ({
  method: m[1],
  params: [...m[2].matchAll(/name:\s*"([^"]+)"/g)].map((x) => x[1]),
}));

ok('wire 方法表非空', wireMethods.length > 0, 'FACE_METHOD_TABLE 解析为空（格式变了？）');
ok('client 描述符非空', clientMethods.length > 0, 'REMOTE_CONTRIBUTION 解析为空（格式变了？）');

for (const wm of wireMethods) {
  const cm = clientMethods.find((m) => m.method === wm.method);
  ok(`方法 ${wm.method} 在 client 描述符中存在`, !!cm, `client 端未声明 ${wm.method}`);
  if (!cm) continue;
  ok(`  ${wm.method} 参数名一致（[${wm.params.join(', ')}]）`,
    JSON.stringify(wm.params) === JSON.stringify(cm.params),
    `wire=[${wm.params}] client=[${cm.params}]`);
}

for (const cm of clientMethods) {
  ok(`client 方法 ${cm.method} 在 wire 方法表中存在`, wireMethods.some((m) => m.method === cm.method),
    `wire 端未声明 ${cm.method}`);
}

/* ═══════════ 3. TYPERT 声明与 FACE_METHOD_TABLE 同源 ═══════════ */
console.log('\n== 3. TYPERT 派生自 FACE_METHOD_TABLE（不重复定义）==');
ok('TYPERT.service 使用 FACE_NAME', /export const TYPERT = \{[\s\S]*?service:\s*FACE_NAME/.test(wire),
  'TYPERT.service 未引用 FACE_NAME（硬编码会导致改名漏改）');
ok('TYPERT.invocations 派生自 FACE_METHOD_TABLE', /invocations:\s*FACE_METHOD_TABLE\.map/.test(wire),
  'TYPERT.invocations 未从 FACE_METHOD_TABLE 派生（会出现第二份清单）');
ok('TYPERT.model.members 派生自 FACE_METHOD_TABLE', /members:\s*FACE_METHOD_TABLE\.map/.test(wire),
  'TYPERT.model.members 未从 FACE_METHOD_TABLE 派生');

const wireService = /service:\s*FACE_NAME/.test(wire);
ok('TYPERT.namespace 使用 FACE_NAME', /namespace:\s*FACE_NAME/.test(wire), 'namespace 未引用 FACE_NAME');

/* ═══════════ 4. 可选项标记一致（acceptsUndefined）═══════════ */
console.log('\n== 4. 可选项标记（wire optionals ↔ client acceptsUndefined）==');
const optionalNames = new Set(
  [...tableBlock.matchAll(/,\s*\[([^\]]*)\]\s*\]/g)].flatMap((m) =>
    m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)),
);
for (const p of optionalNames) {
  ok(`可选项 ${p} 在 client 端标了 acceptsUndefined`,
    new RegExp(`name:\\s*"${p}"[\\s\\S]{0,120}?acceptsUndefined:\\s*true`).test(client),
    'wire 声明为可选，client 未标 acceptsUndefined（$mount 可能拒绝）');
}

/* ═══════════ 5. Config 字段三处对账 ═══════════ */
console.log('\n== 5. Config 字段（FIELDS ↔ schema ↔ M3_DEFAULTS）==');
const schema = read('plugin-config.schema.mjs');
const host = read('host.impl.mjs');
/* R3（2026-10-08）：智能思考功能域已抽成独立模块（plugin/effort.mjs），
 * 相关断言随之改指向模块——「实现住哪里」变了，「契约是什么」没变。 */
const effort = read('effort.mjs');

const fieldsKeys = [...(/const FIELDS = \[([\s\S]*?)\n\t\t\];/.exec(client)?.[1] ?? '').matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
// schema 里非 volatile 状态的 Config 键（排除 hud* 状态字段）
const schemaKeys = [...schema.matchAll(/^\s{6}(\w+):\s*z\./gm)].map((m) => m[1]).filter((k) => !k.startsWith('hud'));
const hostDefaults = [...(/const M3_DEFAULTS = \{([\s\S]*?)\n\};/.exec(host)?.[1] ?? '').matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

ok('client FIELDS 非空', fieldsKeys.length > 0);
ok('schema Config 键非空', schemaKeys.length > 0);
ok('host M3_DEFAULTS 非空', hostDefaults.length > 0);

for (const k of fieldsKeys) {
  ok(`字段 ${k} 在 schema 中定义`, schemaKeys.includes(k), `schema 缺 ${k}`);
  ok(`字段 ${k} 在 M3_DEFAULTS 中定义`, hostDefaults.includes(k), `host 缺 ${k}`);
}
for (const k of schemaKeys) {
  ok(`schema 字段 ${k} 在面板 FIELDS 中可编辑`, fieldsKeys.includes(k), `面板未提供 ${k}（schema 里有但用户改不到）`);
}
for (const k of hostDefaults) {
  ok(`M3_DEFAULTS 字段 ${k} 在 schema 中`, schemaKeys.includes(k), `schema 缺 ${k}（host 读了但面板/校验没有）`);
}

/* ═══════════ 6. 已删字段不应复活 ═══════════ */
console.log('\n== 6. 已退役字段（防复活）==');
for (const dead of ['policyCardMinRatio', 'highRatio', 'lightTaskChars', 'dryRun']) {
  const inFields = fieldsKeys.includes(dead);
  const inSchema = schemaKeys.includes(dead);
  const inDefaults = hostDefaults.includes(dead);
  ok(`退役字段 ${dead} 未复活`, !inFields && !inSchema && !inDefaults,
    `出现于：${[inFields && 'FIELDS', inSchema && 'schema', inDefaults && 'M3_DEFAULTS'].filter(Boolean).join(', ')}`);
}

/* ═══════════ 6.5 client 渲染契约（bool 显示回归防护）═══════════ */
console.log('\n== 6.5 client 渲染契约（两处总开关显示一致性）==');
// 实测回归（2026-10-07）：toUi 把布尔 Number 化（true→1），面板 `checked: valueOf() === true`
// 恒假 ⇒ 面板总开关恒显示关、弹窗开关（读原始值）显示开——两处不一致且前者为假象。
ok('toUi 布尔直通（不经 Number 化）',
  /function toUi\([^)]*\)\s*\{[\s\S]{0,200}?if \(field\.type === "bool"\)\s*return base === true/.test(client),
  'toUi 缺 bool 直通分支 ⇒ 面板 bool 字段显示恒 false（1 === true 假阴回归）');
ok('面板 bool 选中判定用 === true（严格布尔比较）', /checked:\s*valueOf\(field\)\s*===\s*true/.test(client));
ok('弹窗开关写 settingsScope.set("enabled")（与面板同存储）', /settingsScope\.set\("enabled",\s*next\)/.test(client),
  '弹窗开关未写 enabled 配置 ⇒ 与面板开关不同源');
ok('面板写路径走 writeField(settingsScope)（同一 settingsScope）', /await writeField\(settingsScope,\s*field,\s*parsed\)/.test(client),
  '面板写路径改道 ⇒ 与弹窗开关可能不同源');
/* 用户要求（2026-10-08）：「智能思考前面也添加一个方块色块」——与「智能压缩」行同款
 * （8px / 圆角 2px / #4c7dff），两行视觉成对。缺色块不会报错，只是两行看起来不成对。 */
ok('弹窗「智能思考」行也有色块（与「智能压缩」同款）',
  /const iconE = document\.createElement\("span"\);/.test(client)
  && /iconE\.style\.cssText = "display:inline-block;width:8px;height:8px;border-radius:2px;background:#4c7dff;flex:none;"/.test(client)
  && /wrapE\.appendChild\(iconE\);/.test(client),
  '智能思考行缺色块（或尺寸/颜色与智能压缩行不一致）⇒ 两行视觉不成对');

/* ═══════════ 6.6 阈值速览行排版（防截断回归）═══════════ */
console.log('\n== 6.6 阈值速览行排版（排版不截断 + 已删「上限」+ 字号 11px）==');
// 实测回归（2026-10-07 用户截图）：阈值行 `font-size:10px` + `white-space:nowrap` + `text-overflow:ellipsis`
// 在窄弹窗里必然截掉行尾 ⇒「（上限 80%）」显示成「（上限 80...」——**信息静默丢失**（比换行更糟）。
// 用户后续决定：**删除「上限」**（引擎阈值属内部钳制细节，面板备注/计算器已说明）+ **字号改大**。
const thrCss = /const thr = document\.createElement\("div"\);([\s\S]{0,900}?)thr\.style\.cssText = "([^"]+)"/.exec(client)?.[2] ?? '';
/* 阈值行**文本拼接**源码（与样式分开取：样式在 thr 定义处，文本在 renderHud 内） */
const thrText = /thr\.textContent = `([^`]*)`/.exec(client)?.[1] ?? '';
ok('解析出 thr 样式', thrCss.length > 0, '未匹配到 thr.style.cssText（改名了？）');
ok('阈值行不用 ellipsis（宁可折行不静默截断）', !/text-overflow:\s*ellipsis/.test(thrCss),
  '阈值行又用上 ellipsis ⇒ 尾部信息会被吃掉');
ok('阈值行允许换行（white-space:normal）', /white-space:\s*normal/.test(thrCss),
  '阈值行 nowrap ⇒ 窄弹窗下尾部信息被裁');
ok('阈值行不禁止汉字断行（不得用 word-break:keep-all）', !/word-break:\s*keep-all/.test(thrCss),
  'keep-all 会禁止无空格中文折行 ⇒ 反而更容易溢出');
// 用户要求「字体改大一些」⇒ 11px（曾因截断缩到 9px，删上限后行变短，可放大）
ok('阈值行字号 ≥ 11px（用户要求改大）', /font-size:\s*(1[1-9]|[2-9]\d)px/.test(thrCss), `实际：${thrCss}`);
ok('阈值行已删除「上限」（用户要求）', !/上限/.test(thrText) && !/capTxt/.test(client),
  '仍拼「上限 NN%」⇒ 用户要求删除');
ok('阈值分隔符用半角 ·（全角 ｜ 占一个汉字宽）',
  /智能压缩线 \$\{pct\(v\.markerMinRatio[^`]*· 强制压缩线/.test(client),
  '阈值行仍用全角 ｜ 分隔');

/* ═══════════ 6.7 R1 智能思考 UI 契约（弹窗行改造）═══════════ */
console.log('\n== 6.7 智能思考 UI（弹窗行：开关缩小/删「启用」/新增智能思考）==');
// 用户要求（2026-10-07）：① 开关缩小、高度与「启用」字体一致；② 删除「启用」标签；
// ③ 开关移到「智能压缩」右侧紧邻；④ 右侧新增「智能思考」+ 开关。
ok('弹窗行不再有「启用」文字标签', !/createTextNode\("启用"\)/.test(client),
  '仍存在「启用」文字 ⇒ 用户要求删除');
ok('新增智能思考开关（读 effortEnabled）', /value\?\.effortEnabled/.test(client),
  '未读 effortEnabled ⇒ 智能思考开关无状态来源');
ok('智能思考开关写 effortEnabled（独立字段，不复用 enabled）',
  /settingsScope\.set\("effortEnabled",\s*next\)/.test(client),
  '未写 effortEnabled ⇒ 与总开关耦合');
ok('智能思考开关写后有回读校验', /set\("effortEnabled"[\s\S]{0,200}?effortEnabled;\s*$/m.test(client) || /backRaw\s*!==\s*next/.test(client),
  '缺回读校验（set() resolve ≠ 真持久化）');
// 小号开关：独立类，不改 .dcp-switch 本体（配置面板仍在用大号）
const smCss = /\.dcp-switch-sm\{([^}]*)\}/.exec(client)?.[1] ?? '';
ok('小号开关类 .dcp-switch-sm 存在', smCss.length > 0, '缺小号变体 ⇒ 无法满足「开关缩小」');
// 用户二次反馈「高度还是有点高」⇒ 24×14（第一版 28×16 被否）
ok('小号轨道尺寸 24×14（用户二次要求再小）', /width:24px/.test(smCss) && /height:14px/.test(smCss), `实际：${smCss}`);
ok('小号滑块 10×10 且位移 10px（比例与官方一致：轨道高-4）',
  /\.dcp-switch-sm \.dcp-slider\{width:10px;height:10px\}/.test(client) &&
  /\.dcp-switch-sm input:checked \+ \.dcp-slider\{transform:translateX\(10px\)\}/.test(client),
  '小号滑块尺寸/位移不匹配 ⇒ 视觉错位（滑块须 = 轨道高 - padding×2）');
ok('大号 .dcp-switch 本体未被改小（面板仍用大号）',
  /\.dcp-switch\{position:relative;display:inline-block;width:36px;height:20px/.test(client),
  '.dcp-switch 本体被改 ⇒ 配置面板开关尺寸受影响');
ok('「智能压缩」标签去掉 flex:1（开关才能挨着它）', /label\.textContent = "智能压缩"/.test(client) &&
  /label\.style\.cssText = "opacity:\.85;white-space:nowrap;flex:none;"/.test(client),
  'label 仍有 flex:1 ⇒ 开关被顶到行最右，与「挨着」矛盾');
ok('智能思考组右对齐（margin-left:auto）', /wrapE\.style\.cssText = "[^"]*margin-left:auto/.test(client),
  '智能思考组未右对齐 ⇒ 用户要求「智能思考+开关右对齐」未满足');
ok('智能思考标签文本存在', /labE\.textContent = "智能思考"/.test(client));

/* ═══════════ 6.7b 配置面板「就绪门」（用户实测：先显示默认值再跳变）═══════════ */
console.log('\n== 6.7b 配置面板就绪门（防「先显示一个值再跳变」）==');
// 用户实测（2026-10-08）：新增「换档冷却(秒)」行后，面板出现「刚出现显示 600s，随后变成 30s」。
// 取证结论：**不是该行读错值**——`stored` 按字段键索引（持久化文件与 FIELDS 键逐一对应），
// 实测 600s 是**紧邻的「强制压缩冷却(秒)」的 schema 默认值**（未持久化 ⇒ 恒为 600）。
// 真正的缺陷是：**快照未就绪时每行都退回 `field.def`**——criticalRatio 默认 0.85 vs 已存 0.8、
// markerMinRatio 默认 0.2 vs 已存 0.3 ⇒ 第一帧显示默认值、快照到达才跳成真实值。
// 新增行让这一帧最扎眼，故表现为「刚出现显示 X 再变 Y」。
const panelSrc = /function PilotPanelCard\(\{ view \}\) \{([\s\S]*?)\n\t\t\tif \(view === "summary"\)/.exec(client)?.[1] ?? '';
ok('解析出 PilotPanelCard 主体', panelSrc.length > 0, '未找到面板组件');
ok('就绪门判据 = 快照 value 已定义（而非用 writable 近似）',
  /const ready = snapshot\.value !== void 0 && snapshot\.value !== null;/.test(panelSrc),
  '未就绪时会渲染 field.def 冒充已存值 ⇒ 第一帧显示默认值随后跳变');
ok('未就绪时不渲染字段表（page 视图渲染占位）',
  /if \(!ready\) \{[\s\S]{0,400}?dcp-panel/.test(client),
  '未就绪仍渲染字段 ⇒ 用户实测现象（刚出现显示一个值、随后变成真实值）复现');
ok('summary 视图同样过就绪门',
  /if \(view === "summary"\) \{\s*\n\s*if \(!ready\)/.test(client),
  'summary 视图未过门 ⇒ 详情页顶部仍先显示默认值');
ok('就绪门声明早于使用（无 const TDZ）',
  client.indexOf('const ready = snapshot.value') < client.indexOf('if (!ready) {'),
  'ready 声明在渲染之后 ⇒ 运行时 TDZ 抛 ReferenceError');

/* ═══════════ 6.9 输入框档位 chip（conversation.input.right）═══════════ */
console.log('\n== 6.9 输入框档位 chip（位置/显示条件/文本形态）==');
// 用户要求（2026-10-07）：输入框模型左侧显示「智能思考档位:XXX」，后改为**不用冒号、用间距**。
ok('chip 注册到 conversation.input.right（模型选择器左侧）',
  /ctx\.slots\.inject\("conversation\.input\.right"/.test(client),
  '未注册到 conversation.input.right ⇒ 位置不对（源码实证该 slot 紧邻 conversation.input.model）');
ok('chip 注册 id 独立（不与官方条目撞车）', /id:\s*"context-pilot-effort"/.test(client),
  '未用自有 id ⇒ 可能替换官方条目');
ok('chip 仅在 effortEnabled 开启时显示',
  /if \(!hostInfo \|\| !hostInfo\.on \|\| !effort\) return null;/.test(client),
  '缺少显示条件 ⇒ 开关关闭时仍显示');
/* R3-S9：host 显式返回 effortEnabled 布尔 —— 开关状态与档位数据**分离**。
 * 原先 chip 靠 `effort.ok` 推断开关，而 `effort.ok=false` 既可能是「开关关闭」
 * 也可能是「读档失败」，两种语义混在一个字段里。 */
ok('chip 读 host 的 effortEnabled 布尔（开关状态与数据分离，S9）',
  /env\.effortEnabled === true/.test(client),
  'chip 仍用 effort.ok 推断开关 ⇒ 无法区分「开关关闭」与「读档失败」');
ok('host getHud 独立返回 effortEnabled（与 effort 数据分离）',
  /effortEnabled: effOn,/.test(host),
  'getHud 未独立返回开关状态 ⇒ S9 未落地');
ok('wire 的方法签名声明了 effortEnabled（三端一致）',
  /effortEnabled:boolean/.test(wire),
  'wire 签名缺 effortEnabled ⇒ 与 host 实际返回漂移');
/* setInterval 只允许用于**冷却倒计时**（本地 1s tick，且冷却结束即停）；
 * 不得用于「定期问 host 要档位」——那正是用户要去掉的 5s 轮询。
 * 判据：定时器回调里只能有 setNow，不得出现 getHud/pullOnce。
 * ⚠️ chipBody 必须**先声明**再被下面的断言使用（否则 const TDZ 直接抛，整份套件 0 通过）。 */
const chipBody = /function EffortChip\([\s\S]*?\n\t\t\}/.exec(client)?.[0] ?? '';
ok('解析出 EffortChip 函数体', chipBody.length > 0, '未找到 EffortChip');
/* 2026-10-08 用户要求重做 chip：**删除内联的档位值与冷却秒数**、文案固定「智能思考就绪」、
 * 状态改由**两个样式 + 进度条式过渡**承担（底层 warn=冷却，上层 success 按冷却进度扫满=就绪）。 */
ok('chip 标签不再用「智能思考档位」',
  !/el\("span", \{ style: \{ opacity: "\.75" \} \}, "智能思考档位"\)/.test(client),
  '仍是旧的「智能思考档位」标签 span ⇒ 用户已要求改成「智能思考就绪」');
/* 判据必须与样式**同源**（都用 cooling）。缺少 `!` 锚定会让 `!cooling ? …` 这类
 * 「文案与颜色相反」的回归从子串匹配漏过去（变异实测：加锚定前该变异未被抓住）。 */
ok('chip 文案两态（冷却=「智能思考冷却」/ 就绪=「智能思考就绪」）',
  /cooling \? "智能思考冷却" : "智能思考就绪"/.test(chipBody) &&
  !/!\s*cooling\s*\?/.test(chipBody),
  '未按 cooling 切换文案，或判据被取反 ⇒ 冷却时显示「就绪」（与样式相反）');
ok('chip 不再把档位值渲染成子节点（用户要求删除）',
  !/\}, effort\)/.test(chipBody),
  '仍把 effort 值当子节点渲染 ⇒ 用户要求删除内联档位显示');
/* ⚠️ 用户明确要求「不要 5S 轮询」（2026-10-07）。档位必须走**响应式投影**：
 * `useProjection("modelSelection")`（官方 UI 同款，dsh-client-ui-conversation L17240 同形），
 * 投影由会话事件驱动（model/selection、request/header）⇒ 换档落库即重渲染，零轮询。
 * 开关状态 + 冷却走 getHud，但只在**挂载时 + 投影变化时**各一次（事件驱动，非定时器）。 */
ok('档位走响应式投影 useProjection（不是轮询）',
  /up\("modelSelection"\)/.test(client) && /props && props\.useProjection/.test(client),
  '未用 useProjection("modelSelection") ⇒ 又退化成轮询/静态值');
ok('chip 不用定时器轮询 host（用户明确要求去掉 5s 轮询）',
  !/setInterval\([^)]*(?:getHud|pullOnce)/.test(chipBody),
  'EffortChip 内用 setInterval 定期拉 host ⇒ 违反「不要 5S 轮询」');
ok('chip 的定时器仅用于冷却倒计时且冷却结束即停',
  /if \(!cooling\) return undefined;/.test(chipBody) && /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/.test(chipBody),
  '倒计时未按 cooling 条件启停 ⇒ 常驻定时器（变相轮询）');
ok('chip 不再内联显示冷却秒数（用户要求删除）',
  !/冷却 \$\{coolLeft\}s/.test(chipBody) && !/fontVariantNumeric/.test(chipBody),
  '仍内联显示「· 冷却 Ns」⇒ 用户要求删除');
ok('chip 两态用 data-state 标记（cooling / ready）',
  /"data-state": cooling \? "cooling" : "ready"/.test(chipBody),
  '缺 data-state ⇒ 两态不可区分（也失去可测锚点）');
ok('chip 两态用主题 token（冷却=warn / 就绪=品牌蓝）',
  /--dsw-alias-state-warn-primary/.test(chipBody) && /--dsw-alias-brand-primary/.test(chipBody),
  '未用主题状态 token ⇒ 两态颜色不跟随主题');
/* 用户要求（2026-10-08）：「智能思考就绪的绿色改成蓝色，参考输入框的发送按钮」。
 * 发送按钮是主操作色 = --dsw-alias-brand-primary；本仓既有回退值 rgba(76,125,255,.9)=#4c7dff
 * 正好与弹窗行内色块同源（见 client.css 的 .dcp-switch:has(input:checked)），故回退取同值。 */
ok('chip 就绪色是品牌蓝而非绿色（用户要求对齐发送按钮）',
  !/--dsw-alias-state-success-primary/.test(chipBody) && !/#34c759/.test(chipBody),
  '仍是绿色 success token ⇒ 用户要求改成输入框发送按钮的蓝色');
ok('chip 进度条宽度由冷却进度驱动',
  /const progress = cooling \? Math\.min\(1, Math\.max\(0, \(totalMs - remainMs\) \/ totalMs\)\) : 1;/.test(chipBody) &&
  /width: `\$\{progress \* 100\}%`/.test(chipBody),
  '冷却进度未接到进度条宽度 ⇒ 用户要的「像进度条一样过渡」未实现');
ok('chip 冷却结束与进度扫满同一时刻（cooling=false ⇒ progress=1）',
  /: 1;/.test(chipBody) && /const cooling = until > now;/.test(chipBody),
  'progress 未在冷却结束时取 1 ⇒ 出现「样式已就绪但条没满」');
ok('chip 进度条有 CSS transition 补帧（1s tick 仍平滑）',
  /transition: "width 1s linear, opacity \.3s linear"/.test(chipBody),
  '缺 transition ⇒ 1s tick 呈跳变而非平滑过渡');
ok('chip 的档位/冷却信息移入 title 提示（未丢失）',
  /当前档位：\$\{effort\}/.test(chipBody) && /换档冷却中：还剩 \$\{coolLeft\}s/.test(chipBody),
  '信息被直接删掉而非移入 title ⇒ 用户失去查看途径');
ok('投影 pending 优先显示（已选待生效提前可见）',
  /sel\.pending \|\| sel\.lastUsed/.test(client),
  '未优先取 pending ⇒ 换档后要等下一轮才显示');
ok('host 信息在投影变化时重问（事件驱动，非定时器）',
  /settingsScope\.subscribe\?\.\(\(\) => \{ pullOnce\(\); \}\)/.test(client) &&
  /\}, \[effort, pendingNow\]\);/.test(client),
  '未按投影变化重问 ⇒ 换档后冷却状态不更新');

/* ═══════════ 6.14 压缩记录弹窗：严格会话过滤 + 完整日期时间 ═══════════ */
console.log('\n== 6.14 压缩记录弹窗（会话过滤 / 完整时间 / 血统链退役）==');
/* 用户实测反馈（2026-10-08）：弹窗里出现了**别的会话**的压缩记录，且时间只有 hh:mm。
 * 取证：hud-acts.json 含 3 个 sid，lineage 链 16616c07 → f4154f01（已成环）使 4/5 条被
 * 「本会话」命中，其中 f4154f01 属 `keysion-dac-vue` workspace ⇒ 这就是串会话的机制。 */
const hostNoComment = host.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('getHud 按 sid 精确过滤（不再走血统链）',
  /const filtered = sid \? list\.filter\(\(a\) => a\.sid === sid\) : list;/.test(host),
  '过滤仍走 lineage 链 ⇒ 会命中别的会话的记录');
ok('血统链机制已整体退役（noteSessionId / state.m5.lineage / lastSid）',
  !/noteSessionId/.test(hostNoComment) && !/state\.m5\.lineage/.test(hostNoComment) && !/state\.m5\.lastSid/.test(hostNoComment),
  '血统链残留 ⇒ 跨会话误连可复活');
ok('hud-acts.json 不再持久化 lineage 键', !/lineage: state\.m5\.lineage/.test(host),
  '仍写 lineage ⇒ 假边继续累积');
ok('getHud 返回结构化明细 actsDetail（带 at 供完整时间渲染）',
  /actsDetail: filtered\.slice\(0, 8\)\.map\(\(a\) => \(\{ at: a\.at, text: a\.text \}\)\)/.test(host),
  '缺 actsDetail ⇒ client 无法渲染完整日期时间');
ok('全局兜底字段已退役（actsGlobal / hudLastActGlobal 三端清零）',
  !/actsGlobal/.test(hostNoComment) && !/hudLastActGlobal/.test(hostNoComment) &&
  !/actsGlobal/.test(client) && !/hudLastActGlobal/.test(client),
  '全局兜底残留（代码层，非注释）⇒ 会把全部会话的记录灌进弹窗');
ok('client 渲染完整日期时间（YYYY-MM-DD HH:MM:SS）',
  /const fmtFullTime = \(iso\) => \{/.test(client) && /padStart\(2, "0"\)/.test(client) &&
  /fmtFullTime\(x && x\.at\)/.test(client),
  '未渲染完整日期时间 ⇒ 用户要求「显示完整的日期时间」');
ok('client 剥掉 host 文本里的前导 hh:mm（避免两个时间）',
  /const stripHhmm = \(text\) =>/.test(client) && /stripHhmm\(x && x\.text\)/.test(client),
  '未剥前导 hh:mm ⇒ 同一行出现两个时间');
ok('client 删除了「带参失败退回无参全局查询」的回退',
  !/getHud\(""\)/.test(client),
  '仍回退无参查询 ⇒ 协议不匹配时显示全 DSH 记录');
/* wire 的**类型声明**不得再含全局兜底字段（签名里的散文可以叙述其退役，故只查声明形态）。 */
ok('wire 签名与 host 返回一致（actsDetail / 无全局兜底声明）',
  /actsDetail:\{at:string,text:string\}\[\]/.test(wire) &&
  !/actsGlobal:string\[\]/.test(wire) && !/hudLastActGlobal:string/.test(wire),
  'wire 签名仍声明全局兜底字段 ⇒ 三端漂移');
ok('m5.hudPoll 取证口径与 getHud 一致（按 sid 精确匹配）',
  /matched: state\.m5\.acts\.filter\(\(x\) => x\.sid === asid\)\.length,/.test(host),
  '取证口径仍走链 ⇒ 排查时看到的命中数与真实显示不一致');

/* ═══════════ 6.15 压缩改「工具触发」（R4：不再伪造用户消息）═══════════ */
console.log('\n== 6.15 自动压缩工具触发（替代 marker + 伪造恢复）==');
/* 用户明确要求（2026-10-08）：「自动压缩时，**不用伪造一条我的信息**重新拉起会话」。
 * 证据链与方案取舍见 docs/r4-compaction-tool-design.md；本段把该结论固化成绊线。 */
const ct = read('compact-tool.mjs');
/* 说明性文字（文件头会把旧机制当反例写出来）不能参与「未出现某字符串」的判定 ⇒ 剥注释后再查。
 * 踩过的坑：`!/本轮先不执行任务/.test(ct)` 被**文件头里描述旧机制的那句话**判失败。 */
const ctNoComment = ct.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('compact-tool.mjs 按热换纪律动态加载（带 ?ts=）',
  /import\(`\.\/compact-tool\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host),
  '未带 ?ts= ⇒ 改模块后不随 toggle 生效（P16 教训）');
ok('工具名 compact_context 单一来源（模块导出，host 不重复字面量）',
  /export const TOOL_NAME = 'compact_context';/.test(ct) && !/compact_context/.test(hostNoComment),
  '工具名散落多端 ⇒ 改名必漏改');
ok('工具走官方 defineTool + tools.register',
  /defineTool\(toolSpec\(\)\)/.test(ct) && /tools\.register\(defineTool/.test(ct),
  '未走官方注册路径 ⇒ 模型看不到该工具');
ok('工具门控接总开关 enabled（不是 effortEnabled）',
  /readCfg: \(\) => \(\{ enabled: M3\.enabled === true \}\)/.test(host) && /if \(!d\.enabled\) return false;/.test(ct),
  '门控接错开关 ⇒ 压缩工具的存在性跟随智能思考开关');
ok('工具执行体绝不抛错（异常吞成结构化结果）',
  /catch \(e\) \{\s*log\('warn', `智能压缩 工具执行异常（吞）[\s\S]{0,160}?return \{ ok: false, error: `内部错误/.test(ct),
  '工具会抛错 ⇒ 中断本轮（智能思考同款教训：抛错对模型是可见失败）');
ok('工具 output schema 三字段且 additionalProperties:false',
  /additionalProperties: false/.test(ct) && /ok: \{ type: 'boolean', required: true/.test(ct)
  && /scheduled: \{ type: 'string'/.test(ct) && /error: \{ type: 'string'/.test(ct),
  'output schema 与实现漂移');
/* ⚠️ 真机踩过的坑（2026-10-08，部署后由 m3.compactTool 当场暴露）：
 * 可选参数写 `required: false` 会被 defineTool 拒绝——
 * `unsupported JSON schema: parameters.reason.required must be true when present`
 * ⇒ 工具**静默不注册**，现象只是「模型从不用它」。可选参数必须**省略** required。 */
ok('可选参数不写 required:false（defineTool 会拒收 ⇒ 工具静默不注册）',
  !/required: false/.test(ctNoComment),
  'parameters 里出现 required:false ⇒ defineTool 报 unsupported JSON schema，工具注册失败');
ok('意图有 TTL（防陈旧意图在下一轮任务里突然触发）',
  /export const INTENT_TTL_MS = 120_000;/.test(ct) && /Date\.now\(\) - it\.at > INTENT_TTL_MS/.test(ct),
  '意图永不过期 ⇒ 登记后隔很久仍会触发压缩');
ok('工具返回 scheduled=next-step（模型据此知道「可以继续干活」）',
  /return \{ ok: true, scheduled: 'next-step' \};/.test(ct),
  '未告知执行时机 ⇒ 模型会退回「停下等压缩」的旧习惯');

const ctPreStep = /const preStepCompaction = async \(payload\) => \{([\s\S]*?)\n  \};/.exec(host)?.[1] ?? '';
ok('解析出 preStepCompaction 函数体', ctPreStep.length > 0, '未找到 preStepCompaction');
ok('pre-step 先装工具、再消费意图（与 R3 那个真 bug 同款护栏）',
  /await ensureCompactTool\(\);\s*\n\s*await preStepCompaction\(payload\);/.test(host),
  '懒安装排在消费之后 ⇒ 「工具接受了却没人消费意图」重演 R3 真 bug');
ok('意图门在 critical 门之前（低占用也能按模型请求压缩）',
  /const intent = compactToolApi \? compactToolApi\.peekIntent\(sid\) : null;/.test(ctPreStep)
  && /const wanted = !!intent;/.test(ctPreStep)
  && /if \(wanted\) compactToolApi\.takeIntent\(sid\);/.test(ctPreStep)
  && /if \(!wanted && ratio < effCritical\) return;/.test(ctPreStep),
  '顺序错 ⇒ 模型主动请求在低于强制线时被静默丢弃');
ok('意图先消费后执行（防每个 step 反复重试）',
  (() => {
    /* 必须比**调用点**而非首次出现：函数体注释里也写了 compactIfNeeded（signal 守卫那条）。
     * 踩过的坑：直接 indexOf 拿到的是注释位置，断言永远为假。 */
    const code = ctPreStep.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const t = code.indexOf('.takeIntent(sid)');
    const c = code.indexOf('.compactIfNeeded(');
    return t > -1 && c > -1 && t < c;
  })(),
  'takeIntent 晚于执行 ⇒ 失败后逐步重试，污染报告且浪费额度');
ok('主动请求时先试 pressure、为 null 才退 overflow（保留策略优先）',
  /result = await compaction\.service\.compactIfNeeded\(agent, 'pressure', sig\);/.test(ctPreStep)
  && /result = await compaction\.service\.compactIfNeeded\(agent, 'context-overflow', sig\);/.test(ctPreStep)
  && ctPreStep.indexOf("'pressure', sig") < ctPreStep.indexOf("'context-overflow', sig"),
  '直接走 overflow ⇒ 丢掉引擎正常保留策略（overflow 的 retain=0 过于激进）');
ok('意图消费全程留痕（compactIntents / lastCompactIntent）',
  /state\.m3\.compactIntents \+= 1;/.test(ctPreStep) && /state\.m3\.lastCompactIntent = \{/.test(ctPreStep),
  '消费无留痕 ⇒ 失败时无从定位（重演「工具接受成功却永不生效」）');

/* 伪造恢复必须**彻底消失**（不是「不调用」而是「不存在」——留着重接上的地雷更危险） */
for (const gone of ['maybeResumeAfterMarker', 'resumeViaAnyChannel', 'sessionController.prompt', 'agent.followup']) {
  ok(`伪造恢复链路已整体删除：${gone}`,
    !hostNoComment.includes(gone),
    `仍存在于代码（非注释）⇒ 一行即可把它重新接上，伪造消息会复活`);
}
ok('恢复计数/上限机制随之退役',
  !/resumeCountBySid|M5_RESUME_MAX/.test(hostNoComment),
  '恢复计数仍在 ⇒ 投递链未真正退役');
ok('教学改为工具版，且明确要求「不要为了压缩而停下」',
  /调用后请\*\*直接继续当前任务\*\*——不要为了压缩而停下、不要结束回合/.test(ct),
  '教学未写「不要停下」⇒ 模型会退回「停下等压缩」的旧行为');
ok('教学不再教「本轮先不执行任务 + 写标记」（旧机制已废）',
  !/本轮先不执行任务/.test(ctNoComment) && !/M3\.marker/.test(ctNoComment),
  '旧教学残留 ⇒ 模型仍被引导去写标记，而标记路径已不再恢复');
/* 一次性插件说明（M2.5）是最容易漏改的一处：它同样在教模型怎么用压缩。
 * 漏改的后果不是报错，而是模型**写标记后等一个永远不来的自动恢复**（静默失效）。 */
ok('新会话一次性说明本体已搬进模块（host 只做出口）',
  /function renderBrief\(\{ criticalRatio \} = \{\}\) \{/.test(ct)
  && /return api\.renderBrief\(\{ criticalRatio: M3\.criticalRatio \}\);/.test(host),
  '说明文本仍散在 host ⇒ 与工具名/文案两处漂移');
ok('一次性说明不再承诺「自动拉起」（已无该机制）',
  !/自动拉起|自动恢复/.test(ct) || /没有\*\*任何自动拉起动作|不需要\*\*任何「待执行」占位/.test(ct),
  '说明仍在承诺自动拉起 ⇒ 模型会等一个永远不会到来的恢复');
ok('一次性说明明确「没有自动拉起动作」这一反向澄清',
  /没有\*\*任何自动拉起动作/.test(ct),
  '未做反向澄清 ⇒ 模型可能保留旧预期（写标记等恢复）');

/* ═══════════ 6.8 R1 智能思考字段三端对账 ═══════════ */
console.log('\n== 6.8 智能思考字段（FIELDS ↔ schema ↔ M3_DEFAULTS）==');
ok('FIELDS 含 effortEnabled', fieldsKeys.includes('effortEnabled'), '面板缺该字段');
ok('schema 含 effortEnabled', schemaKeys.includes('effortEnabled'), 'schema 缺该字段 ⇒ 面板保存被拒');
ok('M3_DEFAULTS 含 effortEnabled', hostDefaults.includes('effortEnabled'), 'host 缺该字段 ⇒ 读不到');
ok('mergeConfig 读取 effortEnabled', /for \(const k of \[[\s\S]{0,120}'effortEnabled'/.test(host),
  'mergeConfig 未读 ⇒ 面板改值不生效');
ok('effortEnabled 默认关闭（新功能默认不介入）', /effortEnabled:\s*false/.test(host),
  '默认开启 ⇒ 未确认就改变既有会话行为');
/* R3-S7：换档冷却可配（换档会使前缀缓存失效 ⇒ 计费敏感参数，必须能让用户按口径调）。 */
ok('FIELDS 含 effortCooldownMs（冷却可配，S7）', fieldsKeys.includes('effortCooldownMs'), '面板缺该字段 ⇒ 用户改不到冷却');
ok('schema 含 effortCooldownMs', schemaKeys.includes('effortCooldownMs'), 'schema 缺该字段 ⇒ 面板保存被拒');
ok('M3_DEFAULTS 含 effortCooldownMs', hostDefaults.includes('effortCooldownMs'), 'host 缺该字段 ⇒ 读不到');
ok('mergeConfig 读取后按数值校验（防 NaN 污染）',
  /for \(const k of \['armedTtlMs', 'sweepMinIntervalMs', 'effortCooldownMs'\]\)/.test(host),
  'effortCooldownMs 未走数值校验 ⇒ 非法值会被写进 M3');
ok('effort 模块从 config 现读冷却（面板改值即生效）',
  /readCfg: \(\) => \(\{ enabled: M3\.effortEnabled === true, cooldownMs: M3\.effortCooldownMs \}\)/.test(host) &&
  /const cooldownMs = \(\) => \{/.test(effort),
  '冷却未走现读 ⇒ 面板改值后仍用启动时的旧值');

/* ═══════════ 6.10 智能思考注入（门控解耦 + 教学覆盖度）═══════════ */
console.log('\n== 6.10 智能思考注入（门控必须与压缩解耦）==');
// 用户要求「全程允许」——注入与换档**不得**引用压缩的 markerMinRatio 门控。
// 现有 M2 注入三部分门控不同：用量行无门控 / 决策卡 ratio>=markerMinRatio / 一次性说明首次。
// 思考强度必须是**第四条独立通道**：门控 = effortEnabled，与占用无关。
const injectBody = (() => {
  const m = /const card = renderPolicyCard\(r\.ratio\);([\s\S]*?)return \{ \.\.\.decision, messages:/.exec(host);
  return m ? m[1] : '';
})();
ok('解析出 M2 注入主体', injectBody.length > 0, '未匹配到注入主体（改名了？）');
/* 只截取 **effort 相关**的那几行（从注释「智能思考：**独立门控**」到 fullText 拼装）——
 * 不能截整个注入主体：它包含 renderPolicyCard 行，而卡本身合法引用 markerMinRatio。 */
const effInject = (() => {
  const s = host.indexOf('/* 智能思考：**独立门控**');
  if (s < 0) return '';
  const e = host.indexOf('const fullText =', s);
  return e > s ? host.slice(s, e) : '';
})();
ok('解析出 effort 注入段', effInject.length > 0, '未找到 effort 注入段');
ok('智能思考注入用独立门控 effortEnabled（不共用 markerMinRatio）',
  /if \(M3\.effortEnabled === true && effortApi\) eff = await effortApi\.read\(agent\)/.test(effInject),
  'effort 注入未走 effortEnabled 独立门控 ⇒ 低占用时被压缩门控挡掉（用户要求全程允许）');
/* ⚠️ R3-S4（2026-10-08 结构性修复）：懒安装必须**彻底移出** M2 注入分支。
 * R2 曾因把它留在该分支内（且只在 `step!==1` 早退之后）而产出真 bug：
 * 一轮首步就调工具 ⇒ 后续 pre-step 的 step 恒 >1 ⇒ 钩子永装不上
 * ⇒ 工具接受成功却永不变档（实测 effortToolCalls=1、effortSwitches=0、effortHooks 从未赋值）。
 * 现在的判据比「早于早退」更强：**必须先于 pre-step 里的任何其它动作**（连压缩检查都排在它后面），
 * 且注入分支内不得再出现任何 ensure/注册调用。 */
ok('懒安装先于 pre-step 的一切其它动作（R3-S4 结构性解耦）',
  (() => {
    const s = host.indexOf('await ensureEffort();');
    const p = host.indexOf('await preStepCompaction(payload);');
    return s > 0 && p > 0 && s < p;
  })(),
  'ensureEffort 未放在 pre-step 最前面 ⇒ 仍可能被某条早退绕过');
ok('懒安装不受 step 门控约束（先于 step!==1 早退）',
  (() => {
    const s = host.indexOf('await ensureEffort();');
    const g = host.indexOf('if (step !== 1) return decision;');
    return s > 0 && g > 0 && s < g;
  })(),
  '懒安装仍在 step!==1 早退之后 ⇒ 首步即调工具时钩子永不安装');
ok('注入分支内不再有任何 effort 安装/注册调用（耦合已断）',
  !/ensureEffort\(\)|effortApi\.ensure|registerTool\(\)/.test(effInject),
  '注入分支内仍做 effort 安装 ⇒ 早退条件一改就会再次静默破坏 effort');
/* 剥注释后再查：注释里说明「与 markerMinRatio 解耦」是正常文字，代码里引用才是耦合。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('effort 注入段不引用 markerMinRatio（剥注释后）', !/markerMinRatio/.test(stripComments(effInject)),
  'effort 注入段**代码**引用了 markerMinRatio ⇒ 与压缩门控耦合');
ok('读档失败不阻断注入（try/catch 吞）',
  /catch \{ \/\* 读档失败 ⇒ 不注入/.test(host),
  '读档异常未吞 ⇒ 新功能可打崩主注入流程');
ok('思考强度教学与插件说明同时机（会话首次）',
  /!effBriefedBySid\.has\(sid\)/.test(injectBody),
  '教学未按会话一次性 ⇒ 每轮重复占 token');
ok('用量行后缀拼装（每轮告知当前实际档位）',
  /effSuffix \? `\$\{r\.text\} ｜ \$\{effSuffix\}` : r\.text/.test(injectBody),
  '未拼后缀 ⇒ 模型不知道当前**实际生效**档位');
ok('注入文本出口走模块（host 不再内联文案）',
  /effortApi\?\.renderSuffix\(eff\)/.test(injectBody) && /effortApi\?\.renderBrief\(eff\)/.test(injectBody),
  'host 仍内联 effort 文案 ⇒ 与模块两份实现会漂移');
// 教学文本覆盖度 6/6（用户指出「暴露了但不会调用」——必须教）
// ③ 由「标记语法」改为「**工具名 + 调用方式**」；⑤ 由「下一步生效」改为「本次任务内立即生效」
// R3：教学文本住 plugin/effort.mjs（功能域整体搬入），断言随之改指向模块。
const effBrief = /function renderBrief\(eff\) \{([\s\S]*?)\n  \}/.exec(effort)?.[1] ?? '';
ok('解析出 renderBrief（教学文本函数）', effBrief.length > 0, '未找到教学文本函数');
for (const [name, re] of [
  ['① 当前值', /当前思考强度档位：' \+ eff\.current/],
  ['② 可选档', /本模型可选 ' \+ opts/],
  ['③ 工具名+调用方式', /TOOL_NAME \+ '（参数 effort=<档位>）切换：'/],
  ['④ 何时该用', /更深推理|更快响应/],
  ['⑤ 生效时机+不中断', /本次任务内立即生效|任务与上下文不中断/],
  ['⑥ 代价提醒', /缓存失效|1-2 次/],
]) {
  ok(`教学覆盖 ${name}`, re.test(effBrief), `教学文本缺 ${name} ⇒ 模型无法自主调用`);
}
ok('教学不再提文本标记（用户要求不保留）', !/\[cp:effort/.test(effBrief),
  '教学仍教 [cp:effort] 标记 ⇒ 与「不保留文本标记」的决定矛盾');
ok('无档可调时不注入（返回 null）', /if \(!eff\?\.ok \|\| !eff\.current\) return null;/.test(effBrief),
  '模型不支持思考档时仍注入 ⇒ 打扰且误导');

/* ═══════════ 6.11 一次性说明在压缩后必须重讲（真 bug 修复）═══════════ */
console.log('\n== 6.11 压缩后一次性说明重讲（briefedBySid 永不失效的真 bug）==');
// 原实现只有 add、无 delete/clear ⇒ 压缩把说明收进摘要后，插件认为「讲过了」永不再讲；
// 摘要由模型生成、不保证保留该段 ⇒ 模型永久失去用法说明。
ok('存在 clearBriefed 清除函数', /const clearBriefed = \(sid\) => \{/.test(host),
  '无清除函数 ⇒ 压缩后不再重讲（原 bug）');
ok('clearBriefed 同时清两个集合（压缩说明 + 智能思考教学）',
  /briefedBySid\.delete\(sid\)[\s\S]{0,120}?effBriefedBySid\.delete\(sid\)/.test(host),
  '只清一个 ⇒ 另一个仍永不重讲');
const clearCalls = (host.match(/clearBriefed\(sid\)/g) || []).length;
ok(`clearBriefed 在两条压缩路径都被调用（实际 ${clearCalls} 处）`, clearCalls >= 2,
  '只在一条路径清除 ⇒ 另一条压缩路径后说明仍丢失');
ok('clearBriefed 声明早于调用点（无 TDZ 风险）',
  host.indexOf('const clearBriefed = ') < host.indexOf('clearBriefed(sid)'),
  'clearBriefed 声明在调用之后 ⇒ const TDZ 会抛 ReferenceError');

/* ═══════════ 6.12 换档执行通道（agent.ctx 作用域，非 global）═══════════ */
console.log('\n== 6.12 换档执行通道（实现已抽 plugin/effort.mjs）==');
// 源码实证（2026-10-07）：`waterfall("agent/request", {turn,step,signal}, seed)` 的 payload
// **只有 turn/step/signal，没有 agent** ⇒ 不能用 payload 找会话（第一版实现踩了这个坑，
// 会导致 per-session 查找恒不命中、换档静默失效）。
// 官方 installModelSelection 的做法：注册在 **agent.ctx**（dsh-agent/lib/types/model-selection.js L45/L61，
// 调用方 api-session-controller L310 传 agent.ctx）。本插件同款：按 agent 懒安装 + WeakSet 去重。
ok('R3-S7：effort 实现已抽独立模块（host 只做接线 + 带 ?ts= 热换）',
  /import\(`\.\/effort\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host) && /let effortApi = null/.test(host) &&
  !/pendingEffortBySid|effortHookInstalled|readEffort = \(agent\)/.test(host),
  'host 仍内联 effort 实现 ⇒ R3-S7 未落地（或动态 import 漏了 ?ts= 会命中无参缓存）');
ok('换档钩子装在 agent.ctx（不是插件 ctx 的 global）',
  /agent\.ctx\.on\('agent\/request'/.test(effort),
  '未装在 agent.ctx ⇒ payload 无 agent，per-session 查找恒不命中（换档静默失效）');
ok('未使用插件级 global agent/request（payload 无 agent 会失效）',
  !/state\.listeners\['agent\/request'\]\s*=\s*addListener/.test(host),
  '仍注册插件级 agent/request ⇒ 拿不到 agent');
ok('钩子按 agent 去重（WeakSet，防重复安装）',
  /const hookInstalled = new WeakSet\(\)/.test(effort) && /hookInstalled\.has\(agent\)/.test(effort),
  '未去重 ⇒ 每次 pre-step 重复注册，waterfall 回调叠加');
ok('钩子懒安装（新会话自动覆盖）',
  /function ensure\(\) \{/.test(effort) && /installHook\(a\)/.test(effort),
  '无懒安装 ⇒ 新会话拿不到钩子');
/* 取证要求（2026-10-08 踩坑换来）：ensure 曾**全静默**——工具链路已通但 apply 从不执行时
 * 无法定位断点（实测 effortToolCalls=1 而 effortSwitches=0、effortHooks 从未赋值）。
 * 现必须留痕：调用次数 / enabled / agent 数 / 安装成功与失败数 / 异常。 */
ok('懒安装有取证留痕（防静默失败）',
  /const d = state\.m3\.effortDiag;/.test(effort) && /d\.calls \+= 1/.test(effort) &&
  /d\.installed = ok/.test(effort) && /d\.failed = failed/.test(effort),
  '懒安装无留痕 ⇒ 工具接受但不变档时无法定位');
ok('钩子安装失败有留痕（agent.ctx 不可用时）',
  /effortDiag\.hookError = \{/.test(effort),
  '安装失败静默 return false ⇒ 无法区分「没调用」与「调用了但失败」');
ok('host 侧初始化 effortDiag（报告可读到该字段）',
  /effortDiag: \{ calls: 0/.test(host),
  'host state 未初始化 effortDiag ⇒ 报告字段缺失（R3-S10 合并后必须同步初始化）');
ok('pre-step 会触发懒安装', /await ensureEffort\(\);/.test(host),
  'pre-step 未调用 ensureEffort ⇒ 钩子永不安装');
ok('新建会话也会补装（双保险）',
  /state\.listeners\['session\/created'\] = addListener\('session\/created',[\s\S]{0,400}?ensureEffort\(\)/.test(host),
  '新会话只在 pre-step 才补装 ⇒ 若首轮 pre-step 早退则钩子缺失');
/* 实测风险（2026-10-07 E2E 排查中发现）：sid 若只在**安装期**捕获一次，而本项目实测
 * session id 会轮转（压缩后 / 多会话交错）⇒ 查询不到 pending ⇒ **换档静默失效**。
 * 修复：请求时**现读** sid（优先），安装期值仅作兜底（两者取并集查找）。 */
ok('sid 在请求时现读（不只依赖安装期捕获）',
  /const sidNow = sidOf\(agent\);/.test(effort) && /const sidAtInstall = sidOf\(agent\)/.test(effort),
  'sid 仅在安装期捕获 ⇒ id 轮转后查不到 pending，换档静默失效');
ok('现读 sid 未命中时回退安装期值（并集查找）',
  /hitNow \? sidNow : \(sidAtInstall && bySid\.has\(sidAtInstall\) \? sidAtInstall : sidNow\)/.test(effort),
  '无回退 ⇒ 两种 sid 不一致时丢失待应用档位');
ok('删除/记忆用实际命中的 key（避免孤儿状态）', /dropSid\(sidKey\)/.test(effort),
  '用固定 sid 删除 ⇒ 命中另一 key 时留下孤儿状态（下次误触发）');
/* R3-S6：原先三张 Map（pending/冷却基准/已写入档）各自 delete，漏删即留孤儿 ——
 * 现合并为单对象 + 单删除点，孤儿在结构上不可能出现。 */
ok('状态合并为单一 bySid 对象（S6）',
  /const bySid = new Map\(\)/.test(effort) &&
  !/pendingEffortBySid|effortSwitchAtBySid|appliedEffortBySid/.test(stripComments(effort) + stripComments(host)),
  '状态仍分散在多张 Map ⇒ 各自 delete 会留孤儿');
ok('sid/校验/跳过计数三个小逻辑已抽单点（S3）',
  /const sidOf = \(agent, fallback = ''\)/.test(effort) && /const checkEffort = \(eff, want\) => \{/.test(effort) &&
  /const bumpSkip = \(kind\) => \{/.test(effort),
  '三个小逻辑仍内联重复 ⇒ S3 未消');
/* S5：`readEffort` 原先在早退路径**同步返回对象**、在正常路径返回 Promise ⇒ 调用方必须 await，
 * 但读代码看不出它可能是 Promise；某处漏 await 就会拿到 Promise 当对象用（`eff.ok` 恒 undefined）
 * ⇒ **静默失效**。现全路径 async + 全调用点 await。
 * ⚠️ 变异验证（去掉这条判据后「把某条 return 改成 return Promise.resolve(...)」不再被抓到）：
 *    故判据必须针对「**任何** 从非同期路径 return Promise」，而不只是 `Promise.resolve(p.value)` 一种形态。 */
const readBody = /async function read\(agent\) \{([\s\S]*?)\n  \}/.exec(effort)?.[1] ?? '';
ok('readEffort 全程 async（S5：消除同步/异步混用）',
  readBody.length > 0 && !/return\s+Promise/.test(readBody),
  '仍从非同期路径 return Promise ⇒ 漏 await 会静默拿到 Promise 当对象用');
ok('read 的全部调用点都 await（S5 的另一半）',
  (effort.match(/read\(agent\)/g) || []).length >= 3 && /await effortApi\.read\(agent\)/.test(host),
  'read 有调用点未 await ⇒ 拿到 Promise 当对象用（静默失效）');
ok('session/event 监听器只有一处（合并而非重复注册）',
  (host.match(/state\.listeners\['session\/event'\]/g) || []).length === 1,
  '注册了两处 ⇒ 后注册者覆盖 listeners 记录（压缩标记链路取证丢失）');
// 三个必备防护
ok('应用前校验档位合法性（否则 llm 抛 UNSUPPORTED_REASONING_EFFORT 中断请求）',
  /const chk = checkEffort\(eff, want\);/.test(effort),
  '未校验档位 ⇒ 非法档会中断整个请求');
ok('非法档只忽略并留痕（不硬送）',
  /bumpSkip\('invalid'\)/.test(effort) && /applied: false, error: chk\.reason/.test(effort),
  '非法档未留痕 ⇒ 无法取证为何没生效');
ok('有换档冷却（防频繁换档反复打断前缀缓存）',
  /export const DEFAULT_COOLDOWN_MS = 30_000/.test(effort) && /since < cap/.test(effort),
  '无冷却 ⇒ 模型可每轮换档，反复使缓存失效');
ok('尊重他人显式指定档位（让位，不覆盖）',
  /config\.reasoningEffort !== s\.applied && config\.reasoningEffort !== want/.test(effort),
  '未区分「自己写的档」与「他人显式指定」⇒ 与用户/subagent 选择打架或自我锁死');
/* ⚠️ 必须 prepend：官方 installModelSelection 挂在**同一** agent/request 上且在内层，
 * 它 await next() 后 delete reasoningEffort 再套回持久化 header 值 ⇒ 非最外层会被剥掉。
 * 实测缺陷（2026-10-07）：applied:true 但之后每轮注入仍是旧档 ⇒ 换档实际未生效。 */
ok('换档 hook 用 prepend（否则被官方 installModelSelection 剥掉）',
  /\}, \{ prepend: true \}\); \/\/ 结论①/.test(effort),
  '未 prepend ⇒ 官方内层会 delete 我们写入的 effort 再套回旧档（换档静默失效）');
ok('pending 持久（每轮覆盖，不一次性消费）',
  /st\.want = want;/.test(effort) && !/want = null/.test(effort),
  'pending 被一次性消费 ⇒ 只有第一轮生效，之后被内层打回旧档');
ok('换档计数只在档位真变化时自增（否则变成请求次数）',
  /const changed = config\?\.reasoningEffort !== want;/.test(effort) && /effortReasserts \+= 1/.test(effort),
  '无条件自增 ⇒ effortSwitches 失去取证意义');
ok('冷却基准只在真变化时更新（否则后续换档全被挡）',
  /if \(changed\) \{\s*\n\s*s\.switchedAt = Date\.now\(\);/.test(effort),
  '每轮刷新冷却基准 ⇒ 冷却永远处于「刚换过」，模型后续换档全被跳过');
ok('应用时删除 maxTokens（不把上个 adapter 的 cap 钉住）',
  /const out = \{ \.\.\.config, reasoningEffort: want \};\s*\n\s*delete out\.maxTokens;/.test(effort),
  '未删 maxTokens ⇒ 换档后沿用旧 adapter 的输出上限（router-laya applyRoute 同款教训）');
ok('换档异常原样放行（绝不影响请求）',
  /log\('warn', `智能思考 应用异常（吞，原样放行）/.test(effort),
  '异常未吞 ⇒ 新功能可打崩模型请求');
ok('结论清单固化在模块文件头（重构时不得当冗余删掉）',
  /十条「来之不易」/.test(effort) && /结论①/.test(effort) && /结论⑩/.test(effort),
  '模块未固化「来之不易」结论 ⇒ 下轮重构极易误删（每一条都是踩坑换来的）');

/* ═══════════ 6.13 换档工具（取代文本标记）═══════════ */
console.log('\n== 6.13 换档工具 set_reasoning_effort（取代文本标记）==');
// 用户 2026-10-08 决策：① 不保留文本标记；② 工具名 set_reasoning_effort。
// 工具方案为什么对（源码实证）：dsh-agent-loop L1152-1155 有 toolCalls ⇒ step() 返回 null
// ⇒ turnEnds 保持 null ⇒ L1005 不 break ⇒ target="next-step" ⇒ **本轮继续**；
// 每步重走 agent/request ⇒ 下一步即带新档位。零用户输入、零伪造消息。
ok('文本标记已移除（用户要求不保留）',
  !/EFFORT_MARKER_RE/.test(host + effort) && !/\[cp:effort/.test(stripComments(host + effort)),
  '仍残留 [cp:effort] 标记解析 ⇒ 与「不保留文本标记」的决定矛盾');
ok('session/event 不再解析换档标记',
  !/matchAll\(EFFORT_MARKER_RE\)/.test(host + effort),
  'session/event 仍在解析标记');
ok('工具名 = set_reasoning_effort（用户指定）',
  /export const TOOL_NAME = 'set_reasoning_effort';/.test(effort),
  '工具名不符用户指定');
ok('用官方 defineTool 定义（非自造 API）',
  /tools\.register\(defineTool\(toolSpec\(\)\)\)/.test(effort) && /name: TOOL_NAME,/.test(effort),
  '未走官方 defineTool ⇒ 注册可能被拒');
ok('工具「定义」与「执行体」分离（R3-S2：拆 133 行巨型函数）',
  /function toolSpec\(\) \{/.test(effort) && /async function runTool\(args, exec\) \{/.test(effort),
  '工具 schema 与执行逻辑仍混在一个巨型函数里');
ok('钩子「决策」与「安装」分离（R3-S2：拆 108 行巨型函数）',
  /async function applyTo\(config, agent, sidAtInstall\) \{/.test(effort) && /function installHook\(agent\) \{/.test(effort),
  '决策逻辑与安装薄壳仍混在一个巨型函数里');
ok('走官方 ctx.tools.register 注册',
  /tools\.register\(defineTool\(toolSpec\(\)\)\)/.test(effort) && /svc\('tools'\)/.test(effort),
  '未用 tools.register ⇒ 工具不生效');
ok('defineTool 走候选链加载（bare→env→resourcesPath→硬编码）',
  /async function loadDefineTool\(\)/.test(host) && /dshToolsCandidates/.test(host),
  '未走候选链 ⇒ 第三方目录下 bare import 必失败（本项目已有教训）');
ok('effortEnabled 关闭时不注册工具（完全不介入）',
  /if \(M3\.effortEnabled === true\) effortReady\.then\(\(api\) => api\?\.ensure\(\)\)/.test(host) &&
  /if \(!d\.enabled\) return false;/.test(effort),
  '关闭时仍注册 ⇒ 与「关=完全不介入」的用户定义矛盾');
ok('会话中途打开开关会补注册（懒注册）',
  /registerTool\(\);\s*\n\s*return true;/.test(effort),
  '只在加载时注册一次 ⇒ 中途打开开关后工具不可用');
// 工具必须**不抛错**（抛错会中断本轮；这里只想"告知 + 不换"）
ok('工具非法档返回结构化错误而非抛错（抛错会中断本轮）',
  /return \{ ok: false, error: `档位 "\$\{want\}" 不在当前模型的可选集内。`, options: chk\.options \};/.test(effort),
  '非法档抛错 ⇒ 中断模型本轮（应当返回错误让模型自行纠正）');
/* R3-S8：output 收敛为 4 字段。原先 ok/effort/applied/error/options/cooling/remainSec 七字段，
 * 其中 cooling + remainSec 语义重叠（且都可由 error 文案承担）⇒ 冷却剩余秒数改写入 error。 */
ok('工具 output 收敛为 4 字段（S8）',
  /additionalProperties: false/.test(effort) &&
  /ok: \{ type: 'boolean', required: true/.test(effort) &&
  !/cooling: \{ type/.test(effort) && !/remainSec: \{ type/.test(effort) &&
  !/applied: \{ type/.test(effort),
  'output schema 未收敛 ⇒ 字段语义重叠（cooling/remainSec/applied 应并入 error 文案与 ok/effort）');
ok('冷却剩余秒数写进 error 文案（S8 收敛后仍能告知模型）',
  /还需 \$\{remainSec\} 秒/.test(effort),
  '冷却被静默忽略 ⇒ 模型不知为何没生效');
ok('工具写的是持久 pending（复用 prepend 应用链）',
  /st\.want = want;/.test(effort),
  '工具未写 pending ⇒ agent/request 拿不到目标档位');
ok('工具有参数 schema（effort 必填）',
  /effort: \{[\s\S]{0,160}?required: true/.test(effort),
  '缺参数 schema ⇒ defineTool 校验失败/模型不知道传什么');
ok('工具有 output schema + render',
  /output: \{[\s\S]{0,80}?schema: \{[\s\S]{0,700}?render: \(_args, value\) => \[\{ type: 'text', text: JSON\.stringify\(value\) \}\]/.test(effort),
  '缺 output.render ⇒ 工具结果无法渲染给模型');
ok('工具执行异常被吞并返回错误（不影响会话）',
  /智能思考 工具执行异常（吞）/.test(effort),
  '异常未吞 ⇒ 可打崩工具调用');
ok('工具注册结果有取证字段（effortTool / effortToolLoader）',
  /effortTool: null/.test(host) && /effortToolLoader: null/.test(host),
  '缺取证 ⇒ 工具没生效时无法定位断点');
ok('工具调用次数有取证（effortToolCalls / lastEffortTool）',
  /effortToolCalls \+= 1/.test(effort) && /state\.m3\.lastEffortTool = \{/.test(effort) &&
  /effortToolCalls: 0/.test(host) && /lastEffortTool: null/.test(host),
  '工具调用无取证 ⇒ 无法区分「模型没调」与「调了没生效」');
ok('死字段已删除（effortMarkerHits / lastEffortMarker）',
  !/effortMarkerHits|lastEffortMarker/.test(stripComments(host) + stripComments(effort)),
  '文本标记时代的死字段仍在 ⇒ 新读者会以为标记机制还在（R3-S1）');
/* 文本标记时代的「标记必须独占一行（防散文误触发）」断言已随方案一并移除——
 * 工具方案参数结构化，**不存在**正则误判面（这正是换工具的理由之一）。
 * 历史记录见 docs/milestones.md（R1 那节仍保留该坑的描述，供后来者参考）。 */

/* ═══════════ 7. mergeConfig 读取集 ⊆ schema 键 ═══════════ */
console.log('\n== 7. mergeConfig 读取集 ⊆ schema 键 ==');
const mergeList = /const k of \[([^\]]+)\][\s\S]{0,80}?raw\[k\] = live/.exec(host)?.[1];
const mergeKeys = mergeList ? mergeList.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
ok('解析出 mergeConfig 键列表', mergeKeys.length > 0, '未匹配到 `for (const k of [...]) raw[k] = live(...)`');
for (const k of mergeKeys) {
  ok(`mergeConfig 读取 ${k} 时有 schema 定义`, schemaKeys.includes(k), `schema 缺 ${k}`);
}

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'='.repeat(52)}`);
console.log(`契约对账：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);
