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
import { readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

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

/* R16.5：插件图标声明与文件必须同在（官方插件形态：package.json "icon": "./icon.svg"）。
 * icon 缺文件时 DSH 插件列表的图标会 404/空图。 */
{
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  const iconRel = typeof pkg.icon === 'string' ? pkg.icon.replace(/^\.\//, '') : null;
  let iconOk = false;
  if (iconRel) { try { iconOk = statSync(join(PLUGIN, iconRel)).isFile(); } catch { iconOk = false; } }
  ok('插件图标：package.json 声明 icon 且文件存在（插件列表显示用）',
    iconRel === 'icon.svg' && iconOk,
    `实际 icon=${JSON.stringify(pkg.icon)}，文件存在=${iconOk} —— 缺一 ⇒ 插件列表无图标`);
}

/* ═══════════ 1. FACE_NAME 三处一致 ═══════════ */
console.log('\n== 1. FACE_NAME 一致性（wire ↔ client）==');
const wire = read('wire.host.mjs');
const client = read('client.js');
/* R11：M5 HUD 域（含 getHud 聚合响应主体）已抽 plugin/m5.hud.mjs ⇒ 相关断言改指模块。
 * ⚠️ 必须在此处（文件顶部）声明：getHud 相关断言在文件前部，晚声明会 TDZ。 */
const m5src = read('m5.hud.mjs');
/* R12：M2 注入域（用量行 / 决策卡 / 一次性说明 / 注入主体）已抽 plugin/m2.inject.mjs。 */
const m2src = read('m2.inject.mjs');
/* R13：M1 快照域（快照 / 瘦身 / 事件探针）已抽 plugin/m1.snapshot.mjs。 */
const m1src = read('m1.snapshot.mjs');

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
/* R14：core.mjs 是**宿主侧**的一部分（配置 / 状态 / 报告管线 / 工具函数）。
 * 查「宿主侧定义了 X」这类断言用 hostOrCore；查「X 不该留在 host」的解耦断言仍只查 host。 */
const coreSrc = read('core.mjs');
const hostOrCore = host + '\n' + coreSrc;
/* R3（2026-10-08）：智能思考功能域已抽成独立模块（plugin/effort.mjs），
 * 相关断言随之改指向模块——「实现住哪里」变了，「契约是什么」没变。 */
const effort = read('effort.mjs');

const fieldsKeys = [...(/const FIELDS = \[([\s\S]*?)\n\t\t\];/.exec(client)?.[1] ?? '').matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
// schema 里非 volatile 状态的 Config 键（排除 hud* 状态字段）
const schemaKeys = [...schema.matchAll(/^\s{6}(\w+):\s*z\./gm)].map((m) => m[1]).filter((k) => !k.startsWith('hud'));
const hostDefaults = [...(/const M3_DEFAULTS = \{([\s\S]*?)\n\};/.exec(hostOrCore)?.[1] ?? '').matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

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
ok('getHud 独立返回 effortEnabled（与 effort 数据分离，查 m5.hud.mjs）',
  /effortEnabled: effOn,/.test(m5src),
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
/* R16.6（2026-10-09 用户要求）：**恒为图标**——任何尺寸都不再显示文字。
 * 历史护栏保留为「防退化」：不得再出现文字 label / 宽窄两态元素（那套已整体退役）。 */
ok('chip 恒为图标态：dot/label 元素已移除，无容器查询分支（R16.6）',
  !chipBody.includes('dcp-chip-dot') && !chipBody.includes('dcp-chip-label')
    && !/@container/.test(chipBody) && chipBody.includes('dcp-chip-icon'),
  '仍渲染文字/宽窄两态 ⇒ 用户已要求「不管什么尺寸都显示为图标」');
ok('chip 盒样式整体关闭（背景/边框/扫色 overlay 不再渲染出「框」）',
  /background:transparent!important/.test(client) && /box-shadow:none!important/.test(client)
    && !/boxShadow: `inset/.test(chipBody),
  'chip 残留盒样式 ⇒ 窄态图标外面又会出现「框」（R16.5g 已实测）');
/* 判据必须与样式**同源**（都用 cooling）。缺少 `!` 锚定会让 `!cooling ? …` 这类
 * 「文案与颜色相反」的回归从子串匹配漏过去（变异实测：加锚定前该变异未被抓住）。
 * R16.6 后文案只剩 img 的 alt（tooltip 承担语义），但 cooling 判据仍须同源不得取反。 */
ok('chip 冷却判据与样式同源（cooling 不被取反）',
  /cooling \? "智能思考冷却" : "智能思考就绪"/.test(chipBody) &&
  !/!\s*cooling\s*\?/.test(chipBody),
  '判据被取反 ⇒ 冷却时显示「就绪」（与样式相反）');
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
/* chipBody 含**大段说明注释**（里面会引用错误 token 作为反例）⇒ 判颜色必须只看**声明行本身**，
 * 否则「不得出现某 token」会被注释判失败（本轮第二次栽在这点：前一次是 ctNoComment）。 */
const cOkDecl = /const C_OK = "([^"]+)"/.exec(chipBody)?.[1] ?? '';
const cWarnDecl = /const C_WARN = "([^"]+)"/.exec(chipBody)?.[1] ?? '';
ok('解析出 chip 两态颜色声明', cOkDecl.length > 0 && cWarnDecl.length > 0, '未匹配到 C_OK / C_WARN 声明');
ok('chip 两态用主题 token（冷却=warn / 就绪=发送按钮填充色）',
  /--dsw-alias-state-warn-primary/.test(cWarnDecl) && /--dsw-alias-button-info-fill/.test(cOkDecl),
  '未用主题 token ⇒ 两态颜色不跟随主题');
/* 用户要求（2026-10-08）：「智能思考就绪的绿色改成蓝色，参考输入框的发送按钮」。
 * ⚠️ 本断言经历过一次真机返工：第一版按**名字**选了 `--dsw-alias-brand-primary`，chip 渲染成**灰白**。
 *    查 asar 真值才发现 brand-primary = `--dsw-static-neutral-bluish-1000/50`（随主题反转的中性色，非蓝）；
 *    真正对的是发送按钮本体的 `.RlGAzG_primary{background:var(--dsw-alias-button-info-fill)}`。 */
ok('chip 就绪色 = 发送按钮的填充 token（不含绿 / 不含 brand-primary）',
  !/--dsw-alias-state-success-primary/.test(cOkDecl) && !/#34c759/.test(cOkDecl)
  && !/--dsw-alias-brand-primary/.test(cOkDecl),
  '就绪色不是发送按钮的 token（绿色残留，或退回了中性反转的 brand-primary）');
ok('chip 显色进度由冷却进度驱动（R16.6：显色窗 = progress × 100%）',
  /const progress = cooling \? Math\.min\(1, Math\.max\(0, \(totalMs - remainMs\) \/ totalMs\)\) : 1;/.test(chipBody) &&
  /height: `\$\{clipPct\}%`/.test(chipBody),
  '冷却进度未接到显色窗高度 ⇒ 用户要的「从下往上显色」未实现');
ok('chip 冷却结束与显色满格同一时刻（cooling=false ⇒ progress=1）',
  /: 1;/.test(chipBody) && /const cooling = until > now;/.test(chipBody),
  'progress 未在冷却结束时取 1 ⇒ 出现「样式已就绪但条没满」');
ok('chip 显色有 CSS transition 补帧（1s tick 仍平滑）',
  /transition: "height 1s linear"/.test(chipBody),
  '缺 transition ⇒ 1s tick 呈跳变而非平滑过渡');
ok('tooltip 不含每秒变化的内容（title 每秒重建 ⇒ 原生弹窗每秒闪，R16.7 实测）',
  !/还剩 \$\{coolLeft\}s/.test(chipBody) && !/coolLeft > 0\s*\?\s*`换档冷却中：还剩/.test(chipBody),
  'title 含「还剩 Xs」 ⇒ 1s tick 重建 title attribute ⇒ 悬浮弹窗每秒闪一次');
ok('R16.7 换档统计持久化：读写 effort-stats.json（toggle/重启后计数不清零）',
  /effort-stats\.json/.test(effort) && /const savedStats = loadStats\(\)/.test(effort)
    && /savedStats\[sid\]/.test(effort) && /saveStats\(\)/.test(effort),
  '内存态随 toggle 清零 ⇒ 「会话切换次数」归零（用户实测）');
/* R16.7c（用户实测「重启后仍 0 次」的另一半根因）：host 侧 hudPayload 已返回
 * lastSwitch/switchCount，但 client 的 setHostInfo 只挑了冷却三字段 ⇒ 字段到不了 tooltip。
 * 护栏：client 必须透传这两个字段。 */
ok('client 透传 lastSwitch/switchCount 到 tooltip 数据（R16.7c）',
  /lastSwitch: e && e\.lastSwitch \? e\.lastSwitch : null/.test(client)
    && /switchCount: e && Number\.isFinite\(e\.switchCount\) \? e\.switchCount : 0/.test(client),
  'hudPayload 的字段没进 hostInfo ⇒ tooltip 永远显示 0 次（宿主白算）');
/* R16.8（用户提出的时机逻辑）三源对账断言放在 ct 声明之后（文件下方）——
 * 此处只保留 m2 侧（m2src 在此已可用）。 */
ok('R16.8 时机教学（回执侧）：压缩自检回执含「压缩后换档只付一次缓存重建」',
  /这正是换档的最佳时机/.test(m2src),
  '回执缺位 ⇒ Agent 刚压缩完（缓存已重置）却不知道此刻换档最省');
/* R16.7b 行为级（用户实测「重启后仍显示 0 次」的根因变异抓取）：
 * 真 effort 域写盘 → 新实例（= 重启）→ hudPayload 必须读到恢复值。
 * hudPayload 若退回 bySid.get（不合并落盘），新实例没有会话槽位 ⇒ 返回 0（该变异曾逃逸）。 */
{
  const eMod = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const mk = (dir) => eMod.createEffort({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (spec) => spec, pluginDir: dir,
  });
  const tmpStats = mkdtempSync(join(tmpdir(), 'dcp-stats-'));
  const inst1 = mk(tmpStats);
  await inst1.ensure();
  const sidP = 'persist-sid';
  /* slot 路径（apply 消费时会走）：登记一次切换并落盘 */
  const st1 = inst1.diag ? null : null;
  inst1.setPersistForTest?.(sidP, { from: 'high', to: 'max', at: Date.now() });
  ok('R16.7b 前置：测试注入口存在（setPersistForTest）',
    typeof inst1.setPersistForTest === 'function', '缺注入口 ⇒ 无法构造「重启」场景');
  const inst2 = mk(tmpStats); // 第二个实例 = 模拟重启（fresh bySid，同一 pluginDir）
  await inst2.ensure();
  /* read() 需要 requestHeader 提供 provider/model，否则提前 return（统计恢复读不到）。 */
  const agentP = { session: { id: sidP, requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }) }, id: sidP };
  const payload = await inst2.hudPayload(agentP, sidP);
  ok('R16.7b 行为级：重启后 hudPayload 恢复计数与最近切换（slot 合并落盘）',
    payload?.switchCount === 1 && payload?.lastSwitch?.to === 'max',
    `实际 switchCount=${JSON.stringify(payload?.switchCount)} lastSwitch=${JSON.stringify(payload?.lastSwitch)}`);
  rmSync(tmpStats, { recursive: true, force: true });
}
ok('R16.10 静态：传了 sid 时不得回退到 agents[0]（跨会话串数据的根源）',
  !/\|\|\s*agents\[0\]\s*\|\|\s*null;\s*$/.test(m5src) || /agents\.find\(\(x\) => String\(pick\(x\?\.session\?\.id, x\?\.sessionId, x\?\.id\)\) === sid\) \?\? null\)/.test(m5src),
  'm5 仍 `sid && find(...) || agents[0]` ⇒ sid 匹配不到就借别的会话的 agent（tooltip 跨会话同值）');
/* R16.10 行为级（用户实测「最近切换/会话切换次数跨会话显示一样」）：
 * 真 m5 + 真 effort 域，两个 agent（A 在前、B 在后），问 B 的 hud ⇒
 * 统计必须是 B 的；问一个匹配不到 agent 的会话 ⇒ 也得是它自己的（不能借 A 的）。
 * 该 bug 的成因是 m5 回退 agents[0] + hudPayload 以 agent 的 sid 优先。 */
{
  const [m5Mod, eMod2] = await Promise.all([
    import(pathToFileURL(join(PLUGIN, 'm5.hud.mjs')).href),
    import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href),
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), 'dcp-hud-'));
  const effApi10 = eMod2.createEffort({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (spec) => spec, pluginDir: tmpDir,
  });
  await effApi10.ensure();
  const now = Date.now();
  effApi10.setPersistForTest('sess-A', { from: 'low', to: 'high', at: now - 60000 });  // A: 1 次
  effApi10.setPersistForTest('sess-B', { from: 'high', to: 'max', at: now });           // B: 1 次
  effApi10.setPersistForTest('sess-B', { from: 'max', to: 'low', at: now });            // B: 共 2 次
  const mkAgent = (id) => ({ id, session: { id, requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }) } });
  const m5Api10 = m5Mod.createM5Hud({
    state: { m5: { hud: {}, acts: [] }, m3: {} }, log: () => {}, msg: (e) => String(e), schedule: () => {}, pluginDir: tmpDir,
    svc: (k) => (k === 'agents' ? { list: () => [mkAgent('sess-A'), mkAgent('sess-B')] } : k === 'sessions' ? { list: () => [] } : null),
    pick: (...a) => a.find((x) => x != null), measureRatio: () => ({ ok: false }), criticalCapOf: () => 0.8,
    mergeConfig: () => {}, M3: { effortEnabled: true, criticalRatio: 0.75 }, getEffortApi: () => effApi10, getReportBase: () => null,
  });
  const hudB = await m5Api10.buildHudResponse('sess-B');
  ok('R16.10 行为级：问 B 会话说必须回 B 的统计（不借第一个 agent）',
    hudB?.effort?.switchCount === 2 && hudB?.effort?.lastSwitch?.to === 'low',
    `实际 switchCount=${JSON.stringify(hudB?.effort?.switchCount)} lastSwitch=${JSON.stringify(hudB?.effort?.lastSwitch)}（应为 2 / to=low）`);
  const hudA = await m5Api10.buildHudResponse('sess-A');
  ok('R16.10 行为级：问 A 会话说回 A 的统计（两会话互不串）',
    hudA?.effort?.switchCount === 1 && hudA?.effort?.lastSwitch?.to === 'high',
    `实际 switchCount=${JSON.stringify(hudA?.effort?.switchCount)} lastSwitch=${JSON.stringify(hudA?.effort?.lastSwitch)}（应为 1 / to=high）`);
  const hudX = await m5Api10.buildHudResponse('sess-不存在的会话');
  ok('R16.10 行为级：匹配不到 agent 的会话不得借第一个 agent 的统计',
    hudX?.effort?.switchCount === 0 && hudX?.effort?.lastSwitch === null,
    `实际 switchCount=${JSON.stringify(hudX?.effort?.switchCount)} lastSwitch=${JSON.stringify(hudX?.effort?.lastSwitch)}（应为 0 / null）`);
  rmSync(tmpDir, { recursive: true, force: true });
}
/* R16.12（用户反馈「Agent 换档意愿不高」）：教学改**可判定的触发表** + 每轮**有信号才提醒**。
 * 归因证据：报告里部署以来 effortToolCalls/switches 长期为 0（峰值 4/4 全是开发期自测）。 */
{
  const eMod12 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const effNow = { ok: true, current: 'high', efforts: ['off', 'low', 'high', 'max'] };
  const brief12 = eMod12.createEffort({
    svc: () => null, tryOf: (f) => ({ value: f(), error: null }), pick: (...a) => a.find((x) => x != null),
    msg: (e) => String(e), log: () => {}, schedule: () => {}, state: { m3: {} },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (sp) => sp,
  }).renderBrief(effNow) ?? '';
  ok('R16.12 教学含**可判定的触发表**（升/降/不变三类 + 显式允许不变）',
    /跨文件因果排查/.test(brief12) && /机械改动/.test(brief12) && /「不变」也是合法结论/.test(brief12),
    '仍是自指式判据（「需要更深推理时」）⇒ 等于没有触发条件（实测换档数为 0）');
  ok('R16.12 教学含**成本澄清**（只打断一次缓存 / 冷却拒绝不影响任务）',
    /只打断一次前缀缓存/.test(brief12) && /冷却拒绝\*\*不影响任务/.test(brief12),
    '只讲冷却与「唯一硬约束」读起来像劝退 ⇒ 模型倾向不动');

  const tmp12 = mkdtempSync(join(tmpdir(), 'dcp-nudge-'));
  const eApi12 = eMod12.createEffort({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: (sp) => sp, pluginDir: tmp12,
  });
  await eApi12.ensure();
  const agN = { id: 'nudge-sid', session: { id: 'nudge-sid' } };
  const n1 = eApi12.renderNudge(effNow, { agent: agN, turn: 3, userText: '帮我排查这个 bug 的根因' });
  ok('R16.12 行为级：用户要求深入 ⇒ 提示可升档',
    typeof n1 === 'string' && /升档/.test(n1), `实际：${JSON.stringify(n1)}`);
  const n2 = eApi12.renderNudge(effNow, { agent: agN, turn: 4, userText: '快点，只要改个名' });
  ok('R16.12 行为级：提醒**限量**（两次间隔 < 4 轮不再提示）', n2 === null, `实际：${JSON.stringify(n2)}`);
  const n3 = eApi12.renderNudge(effNow, { agent: agN, turn: 8, userText: '快点，只要改个名' });
  ok('R16.12 行为级：用户要求快速 ⇒ 提示可降档',
    typeof n3 === 'string' && /降档/.test(n3), `实际：${JSON.stringify(n3)}`);
  const n4 = eApi12.renderNudge(effNow, { agent: agN, turn: 20, userText: '继续' });
  ok('R16.12 行为级：本会话从未换档（≥8 轮）⇒ 提醒评估一次',
    typeof n4 === 'string' && /尚未换过档/.test(n4), `实际：${JSON.stringify(n4)}`);
  const n5 = eApi12.renderNudge(effNow, { agent: agN, turn: 21, userText: '继续' });
  ok('R16.12 行为级：无信号时**零注入**（返回 null）',
    n5 === null, `实际：${JSON.stringify(n5)}`);
  eApi12.setPersistForTest('nudge-sid', { from: 'high', to: 'max', at: Date.now() });
  const n6 = eApi12.renderNudge(effNow, { agent: agN, turn: 40, userText: '继续' });
  ok('R16.12 行为级：换过档之后不再提「尚未换过档」', n6 === null, `实际：${JSON.stringify(n6)}`);
  rmSync(tmp12, { recursive: true, force: true });
}
ok('R16.12 接线：nudge 判定在 effort 域、取用户文本在 core、注入在 m2（三端齐全）',
  /function renderNudge\(eff, ctx\)/.test(effort)
    && /renderNudge, hudPayload/.test(effort)
    && /const lastUserText = \(session/.test(coreSrc)
    && /kind !== 'user'/.test(coreSrc)
    && /getLastUserText: \(agent\) => lastUserText\(agent\?\.session\)/.test(host)
    && /effortApi\.renderNudge\(eff, \{ agent, turn, userText: getLastUserText\?\.\(agent\) \?\? '' \}\)/.test(m2src)
    && /\[baseText, effNudge, card, brief, effBrief/.test(m2src),
  '任一环缺位 ⇒ 提醒要么不触发、要么永远不出现（接线不可达 = R11 那类静默失效）');
ok('R16.12 冷却期间不提示（避免「让你切但工具必然拒绝」的无效往返）',
  /if \(s\.switchedAt && Date\.now\(\) - s\.switchedAt < cap\) return null;/.test(effort),
  '冷却中仍提示 ⇒ 工具必被拒绝，制造挫折与噪声');

/* R16.13（用户实测「另一会话中途被引擎自动压缩两次，插件里没有记录」）：
 * 插件只在**自己**的 pre-step / idle 路径写记录 ⇒ 引擎自动压缩与 `/compact` 全程绕过插件、零记录。
 * 取证：会话日志有 `compaction/start {turn:29, src:engine}`，hud-acts 里该 sid 只有旧记录。 */
{
  const m3Mod13 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const st13 = { m3: {} };
  const acts = [];
  const hud = [];
  const m3x = m3Mod13.createM3Compaction({
    state: st13, log: () => {}, msg: (e) => String(e?.message ?? e),
    pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.8,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: (patch) => hud.push(patch), recordHudAct: (sid, text) => acts.push({ sid, text }),
    formatAct: (reason) => 'hh:mm · ' + ({ 'engine-auto': '引擎自动压缩', 'engine-manual': '手动压缩（/compact）' }[reason] ?? String(reason)),
    clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 180000, SET_CAP: 200,
  });
  const sess13 = { id: 'sess-13', surface: [], eventAt: () => null };
  ok('R16.13 行为级：引擎自动压缩被补记（含「压后占用」）',
    (() => {
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c1', turn: 29 } }, sess13);
      return typeof t === 'string' && /引擎自动压缩/.test(t) && acts.length === 1 && acts[0].sid === 'sess-13' && hud.length === 1;
    })(),
    `实际：acts=${JSON.stringify(acts)} hud=${hud.length}`);
  ok('R16.13 行为级：命令压缩（/compact）标注为「手动压缩」',
    (() => {
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c2', sourceCommandId: 'cmd-abc' } }, sess13);
      return typeof t === 'string' && /手动压缩/.test(t);
    })(),
    '命令压缩与引擎自动压缩混为一谈 ⇒ 用户分不清是谁压的');
  ok('R16.13 行为级：失败的压缩同样留痕（否则「压了但失败」零记录）',
    (() => {
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c3', error: '400: x' } }, sess13);
      return typeof t === 'string' && /失败/.test(t);
    })(),
    '失败不记录 ⇒ 与用户实测症状同形（看不到任何痕迹）');
  ok('R16.13 行为级：跳过插件自己的压缩（sourceCommandId=context-pilot）',
    (() => {
      const before = acts.length;
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c4', sourceCommandId: 'context-pilot' } }, sess13);
      return t === null && acts.length === before;
    })(),
    '插件自己的压缩被重复补记 ⇒ 面板出现两条同一次压缩');
  ok('R16.13 行为级：跳过「自己的压缩在飞」窗口（pre-step 的 compactRegion 无标记）',
    (() => {
      const before = acts.length;
      st13.m3.ownCompact = { at: 'now', sessionId: 'sess-13', until: Date.now() + 5000 };
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c5' } }, sess13);
      st13.m3.ownCompact = null;
      return t === null && acts.length === before;
    })(),
    '无标记的自家压缩被当引擎压缩补记 ⇒ 重复记录');
  ok('R16.13 计数与取证留痕（engineCompacts / lastEngineCompact）',
    st13.m3.engineCompacts === 3 && typeof st13.m3.lastEngineCompact === 'object' && st13.m3.lastEngineCompact.ok === false,
    `实际：compacts=${st13.m3.engineCompacts} last=${JSON.stringify(st13.m3.lastEngineCompact)}`);
}
/* ⚠️ m3src 在本文件稍后（L677）才声明 ⇒ 这里就地取一份，避免 TDZ。 */
const m3src13 = read('m3.compact.mjs');
ok('R16.13 接线：host 把 compaction/end 转发给 m3；m3 三处自己的压缩都打「在飞标记」并导出',
  /if \(event\?\.type === 'compaction\/end'\) m3Ctl\?\.noteEngineCompaction\?\.\(event, session\);/.test(host)
    && /noteEngineCompaction/.test(m3src13)
    && /if \(src === 'context-pilot'\) return null;/.test(m3src13)
    && /if \(isCompactionInFlight\(\)\) return null;/.test(m3src13)
    && (m3src13.match(/markOwnCompaction\(sid\)/g) ?? []).length >= 3
    && (m3src13.match(/clearOwnCompaction\(\)/g) ?? []).length >= 3
    && /isCompactionInFlight, noteEngineCompaction \}/.test(m3src13),
  '任一环缺位 ⇒ 引擎压缩仍无记录，或自家压缩被重复记录');
ok('R16.13 文案：m5 为两种「非插件压缩」提供标签（不与「强制压缩」混淆）',
  /reason === 'engine-auto' \? '引擎自动压缩'/.test(m5src) && /reason === 'engine-manual' \? '手动压缩（\/compact）'/.test(m5src),
  '标签缺位 ⇒ 弹窗会显示内部枚举名或与插件自己的压缩混淆');

/* R16.14（另一会话的评审意见，7 条建议）：逐条落地并验证。
 * 最锋利的原文：「『提前登记档位』被耦合进了『立即压缩』⇒ 想先登记 heavy、暂不压做不到，
 * 于是理性选择就是别碰它」；「只有例外路径（调用）才需要理由 ⇒ 『不压』零成本零证据，沉默胜出」。 */
{
  const ctMod14 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  const acts14 = [];
  let spec14 = null;
  const api14 = ctMod14.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true, effortEnabled: true }),
    getDefineTool: () => (sp) => { spec14 = sp; return sp; },
    getRangeApi: () => ({ TIER_NAMES: ['light', 'standard', 'heavy'] }),
  });
  api14.ensure();
  const agent14 = { session: { id: 'sess-14' }, id: 'sess-14' };
  const run14 = (args) => spec14.execute(args, { agent: agent14 });
  /* ① 最高杠杆：action='set-tier' 只登记档位、**不登记压缩意图** */
  const rSet = await run14({ action: 'set-tier', tier: 'heavy', reason: '提前锁定档位' }, { agent: agent14 });
  /* ⚠️ R16.16（评审实测事故）：这条断言原先写成 `scheduled === false` —— **锁的是实现值**，
   * 而宿主按 output.schema 校验（scheduled 声明为 string）⇒ 真正的缺陷（false 被拒）逃过了断言。
   * 现改为：① 断言行为意图（不压 + 无意图）；② **另用结构校验器对着 output.schema 验类型**。 */
  ok('R16.14 行为级：action=set-tier 只登记档位（不产生压缩意图；scheduled 不填）',
    rSet?.ok === true && rSet?.action === 'set-tier'
      && rSet?.tier === 'heavy' && api14.peekIntent('sess-14') === null
      && !('scheduled' in (rSet ?? {}))
      && /本次不压缩/.test(String(rSet?.verify)),
    `实际：${JSON.stringify(rSet)} intent=${JSON.stringify(api14.peekIntent('sess-14'))}`);
  ok('R16.14 行为级：set-tier 后档位真的持久生效（hasTier/getTier 都为 heavy）',
    api14.hasTier('sess-14') === true && api14.getTier('sess-14') === 'heavy',
    '登记未生效 ⇒ 「提前锁定档位」与宣传不符');
  /* ② action 缺省仍是 compact（向后兼容） */
  const rCompact = await run14({ tier: 'light' }, { agent: agent14 });
  ok('R16.14 行为级：action 缺省 = compact（向后兼容，仍登记意图）',
    rCompact?.ok === true && rCompact?.action === 'compact' && rCompact?.scheduled === 'next-step'
      && api14.peekIntent('sess-14') !== null,
    `实际：${JSON.stringify(rCompact)}`);
  api14.takeIntent('sess-14');
  /* ③ 决策行要求（把沉默变成可检查产物） */
  const card14 = api14.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000 }) ?? '';
  ok('R16.14 决策卡：要求**先落一行决策**（含「不压」这一支）',
    /先落一行决策/.test(card14) && /压缩决策：不压/.test(card14),
    '仍只对「调用」提要求 ⇒ 沉默仍是零成本零证据（评审原话）');
  /* ④ 不作为的代价显式化（删掉「无需任何操作」这句替模型背书的话） */
  ok('R16.14 决策卡：不再出现「无需任何操作」，改为讲清系统代压的代价',
    !/无需任何操作/.test(card14) && /系统会代替你压缩/.test(card14) && /已过期的事实/.test(card14),
    '「届时无需操作」= 替模型的不作为背书（评审点名）');
  /* ⑤ 损失数字（评审建议 6） */
  ok('R16.14 决策卡：给出「现在压会丢多少近端」的数字（超预算时）',
    /保留预算 160k ⇒ 现在压会摘要掉/.test(card14),
    '没有损失数字 ⇒ 模型只能猜、倾向不动');
  const cardUnder14 = api14.renderCard({ ratio: 0.1, minRatio: 0.05, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 100000 }) ?? '';
  ok('R16.14 决策卡：未超预算时明确「近端一点都不丢」',
    /近端一点都不丢/.test(cardUnder14),
    '不说明「压了也不丢」⇒ 错失零损失压缩机会');
  /* ⑥ 趋势算术化（评审建议 2） */
  const cardTrend14 = api14.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, deltaTokens: 50000, turnsToLine: 5 }) ?? '';
  ok('R16.14 决策卡：用实测增量给出「约几轮触线」（把预测题变算术题）',
    /本轮 \+50k token/.test(cardTrend14) && /约 \*\*5 轮\*\*触/.test(cardTrend14) && /粗估/.test(cardTrend14),
    '仍要求模型自己预测未来占用 ⇒ 该条件「从未成立」（评审实测）');
  /* ⑦ set-tier 路径要在卡片与说明里都出现（否则模型不知道有这条低成本动作） */
  ok('R16.14 教学：卡片与一次性说明都教 set-tier 这条低成本动作',
    /action:'set-tier'/.test(card14) && /action:'set-tier'/.test(api14.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? ''),
    '只有卡片教/或都没教 ⇒ 「提前声明档位」在工具面上仍不可达');
  /* ⑧ 换档侧同款：档位决策行（本文件稍后才有 effApi ⇒ 这里自建一个实例） */
  const effMod14 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const eBrief14 = effMod14.createEffort({
    svc: () => null, tryOf: (f) => ({ value: f(), error: null }), pick: (...a) => a.find((x) => x != null),
    msg: (e) => String(e), log: () => {}, schedule: () => {}, state: { m3: {} },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }), getDefineTool: () => (sp) => sp,
  }).renderBrief({ ok: true, current: 'high', efforts: ['low', 'high', 'max'] }) ?? '';
  ok('R16.14 换档教学：阶段变化要留一行档位决策（含「保持」）',
    /档位决策：保持/.test(eBrief14) && /要写出来/.test(eBrief14),
    '换档侧仍只对「切换」提要求 ⇒ 与压缩侧同一个缺陷（评审：两次独立复现）');
}
const m3src14 = read('m3.compact.mjs'); // ⚠️ m3src 在本文件稍后声明 ⇒ 就地取，避免 TDZ
ok('R16.14 接线：趋势数据（增量/触线轮数）由 m2 现算并注入卡片；m3 标注「系统代压」',
  /const trendOf = \(sid, ratio, win, crit\) => \{/.test(m2src)
    && /renderPolicyCard\(r\.ratio, effCrit, r\.window, trendOf\(sid, r\.ratio, r\.window, effCrit\)\)/.test(m2src)
    && /lastUsedBySid\.set\(sid, used\)/.test(m2src)
    && /系统代压（本会话未申报档位/.test(m3src14)
    && /getCompactTool\(\)\?\.hasTier\?\.\(sidE\)/.test(m3src14),
  '任一环缺位 ⇒ 趋势是空的、或「系统代压」不显性（评审建议 2/7 落不了地）');

/* R16.15（另一会话的第二轮评审，8 条）：核心抱怨是**三重重复**——
 * 「tool description + brief + card 各写一遍档位表/先说再调用/代压代价，每请求白烧 ≈1.5–2k token，
 *  且『哪份是权威』不明」。处置：按「description=怎么调 / brief=固定事实 / card=本轮动作」分工。 */
{
  const ctMod15 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  let spec15 = null;
  const api15 = ctMod15.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (sp) => { spec15 = sp; return sp; },
    getRangeApi: () => ({ TIER_NAMES: ['light', 'standard', 'heavy'] }),
  });
  api15.ensure();
  const desc15 = spec15.description;
  const brief15 = api15.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
  const card15 = api15.renderCard({
    ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000,
    usedTokens: 500000, deltaTokens: 50000, turnsToLine: 5, tierName: 'heavy', tierDeclared: true,
  }) ?? '';
  ok('R16.15 分工：description 不再重复档位表，改为指向每轮决策卡',
    !/保留窗口 × 8%/.test(desc15) && /压缩决策卡/.test(desc15) && /action/.test(desc15),
    'description 仍写一遍档位表 ⇒ 与 brief/card 三重重复（评审实测每请求白烧 1.5–2k token）');
  ok('R16.15 分工：代压代价只在卡片（每轮），一次性说明不再重复长策略段',
    !/系统会代替你压缩/.test(brief15) && /系统会代替你压缩/.test(card15) && /以卡为准/.test(brief15),
    'brief 与 card 各写一遍策略 ⇒ 重复且权威不明');
  const total15 = desc15.length + brief15.length + card15.length;
  ok('R16.15 预算：description ≤ 500 字符（每请求下发，必须短）',
    desc15.length <= 500, `实际 ${desc15.length} 字符`);
  ok('R16.15 预算：三处教学合计 ≤ 3000 字符（去重前 ≈3900）',
    total15 <= 3000, `实际合计 ${total15}（desc ${desc15.length} + brief ${brief15.length} + card ${card15.length}）`);
  ok('R16.15 决策行：只在「本卡出现时」要求（与提醒通道对齐）',
    /本卡出现时，先落一行决策/.test(card15),
    '仍写「每轮留一行决策」⇒ 卡不出现的轮次要写却无提醒，无法执行');
  const cardDecl = api15.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'heavy', tierDeclared: true }) ?? '';
  const cardUnd = api15.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'standard', tierDeclared: false }) ?? '';
  ok('R16.15 卡给出**当前档位名**（已登记 / 兜底两态可辨）',
    /当前档位：heavy（已登记）/.test(cardDecl) && /当前档位：standard（兜底/.test(cardUnd)
      && /不是档位名/.test(cardDecl),
    '决策行要求写 tier 保持 X 而 X 无处可查 ⇒ 模型只能猜（评审建议 3）');
  ok('R16.15 措辞：明确「不传 tier = 沿用已登记档位（不是重置）」',
    /沿用已登记档位/.test(desc15) && /不是重置/.test(card15),
    '「不传参 = 维持现状（初始 standard）」易被读成重置（评审建议 4）');
}


/* R16.16（第三轮评审，两条高价值发现）：
 * ① `set-tier` 返回 `scheduled:false`（boolean）与 output.schema（string）冲突 ⇒ 宿主**整条拒绝**
 *    ——「最大杠杆功能在生产上等于不可用」；且原断言锁实现值 ⇒ 虚假信心。
 * ② `tierBySid` 纯内存 ⇒ toggle 热换=新实例 ⇒ 已声明档位静默消失（文案却称「持久」）。
 * 处置：<字段按 schema 省略> + <结构校验器> + <档位落盘>。 */
{
  /** 按 output.schema 校验返回值：类型 + additionalProperties + required。
   * 这类校验器正是「实现值断言」缺的那一环（评审原文：断言锁住的是实现值，而不是宿主校验用的 schema）。 */
  const schemaErrs = (value, schema) => {
    const errs = [];
    const props = schema?.properties ?? {};
    for (const [k, def] of Object.entries(props)) {
      const v = value?.[k];
      if (v === undefined) { if (def.required === true) errs.push(`${k} 必填但缺失`); continue; }
      const want = def.type;
      const got = Array.isArray(v) ? 'array' : typeof v;
      const okType = want === 'string' ? got === 'string'
        : want === 'boolean' ? got === 'boolean'
          : want === 'number' ? got === 'number'
            : want === 'array' ? got === 'array'
              : want === 'object' ? (v !== null && got === 'object') : true;
      if (!okType) errs.push(`${k} 应为 ${want}，实际 ${got}`);
    }
    const extra = Object.keys(value ?? {}).filter((k) => !(k in props));
    if (extra.length && schema?.additionalProperties === false) errs.push('未声明字段: ' + extra.join(','));
    return errs;
  };
  const ctMod16 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  const tmp16 = mkdtempSync(join(tmpdir(), 'dcp-tier-'));
  let spec16 = null;
  const mkCt16 = (dir) => ctMod16.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (sp) => { spec16 = sp; return sp; },
    getRangeApi: () => ({ TIER_NAMES: ['light', 'standard', 'heavy'] }), pluginDir: dir,
  });
  const api16 = mkCt16(tmp16);
  api16.ensure();
  const ag16 = { session: { id: 'sess-16' }, id: 'sess-16' };
  const run16 = (args) => spec16.execute(args, { agent: ag16 });
  const rSet16 = await run16({ action: 'set-tier', tier: 'heavy' });
  const rCmp16 = await run16({ tier: 'light' });
  const rErr16 = await spec16.execute({}, { agent: null }); // 无 agent ⇒ 错误路径
  ok('R16.16 结构校验：compact_context 三条返回路径都符合 output.schema（类型/additionalProperties/required）',
    schemaErrs(rSet16, spec16.output.schema).length === 0
      && schemaErrs(rCmp16, spec16.output.schema).length === 0
      && schemaErrs(rErr16, spec16.output.schema).length === 0,
    `set-tier: ${JSON.stringify(schemaErrs(rSet16, spec16.output.schema))} | compact: ${JSON.stringify(schemaErrs(rCmp16, spec16.output.schema))} | error: ${JSON.stringify(schemaErrs(rErr16, spec16.output.schema))}`);
  /* 换档工具同款结构校验（同类缺陷可能在那边重演）。 */
  const effMod16 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  let specE16 = null;
  const effApi16 = effMod16.createEffort({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (sp) => { specE16 = sp; return sp; }, pluginDir: tmp16,
  });
  await effApi16.ensure();
  const rE16 = await specE16.execute({ effort: 'low' }, { agent: null });
  ok('R16.16 结构校验：set_reasoning_effort 的返回也符合其 output.schema',
    schemaErrs(rE16, specE16.output.schema).length === 0,
    `实际：${JSON.stringify(schemaErrs(rE16, specE16.output.schema))} value=${JSON.stringify(rE16)}`);
  /* ② 档位落盘：新实例（= toggle 热换）必须恢复已声明档位 */
  api16.setTier('sess-16', 'heavy');
  const api16b = mkCt16(tmp16); // 同 pluginDir 的新实例 = 热换
  ok('R16.16 行为级：档位跨实例（toggle 热换）仍然生效（落盘恢复）',
    api16b.getTier('sess-16') === 'heavy' && api16b.hasTier('sess-16') === true
      && api16b.tierState('sess-16') === 'restored',
    `实际 tier=${api16b.getTier('sess-16')} has=${api16b.hasTier('sess-16')} state=${api16b.tierState('sess-16')}`);
  const cardRestored = api16b.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: api16b.getTier('sess-16'), tierDeclared: true, tierState: api16b.tierState('sess-16') }) ?? '';
  ok('R16.16 卡片：热换后区分「由落盘恢复」与「本次登记/从未登记」三态',
    /当前档位：heavy（已登记；本次由\*\*落盘恢复\*\*/.test(cardRestored),
    '三态不可辨 ⇒ 用户/模型无法判断档位是否真的还在（评审实测点）');
  /* ③ 评审剩余三条 */
  const brief16 = api16.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
  ok('R16.16 brief：保留数字标注「按默认档位 standard 计」（不再与已登记档位矛盾）',
    /按默认档位 standard 计/.test(brief16),
    'brief 硬写 ×16%/160k ⇒ 声明 heavy 后与卡片活值矛盾（评审剩项一）');
  const cardTrend16 = api16.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, deltaTokens: 50000, turnsToLine: 5 }) ?? '';
  ok('R16.16 卡片：趋势行存在时不再重复「若预计会推高」（口径统一）',
    /按上方趋势行判断/.test(cardTrend16) && !/若预计任务会推高占用/.test(cardTrend16),
    '趋势行与「若预计」并存 ⇒ 两种口径（评审剩项二）');
  ok('R16.16 卡片：并列给出「先声明 heavy 能少丢多少」（把 set-tier 收益变数字）',
    /若先声明 heavy（保留 240k）：只丢 ~/.test(cardTrend16) && /少丢 ~/.test(cardTrend16),
    '只给当前档位的损失 ⇒ set-tier 的收益仍是抽象（评审剩项三）');
  rmSync(tmp16, { recursive: true, force: true });
}

/* R16.17（第三轮评审的「剩余轻量项」第 1 条，唯一可执行项）：
 * 「compact-tier.json 无 TTL/无清理 ⇒ 长期累积（每个见过的会话一条）。你们已有 lastUsedBySid
 *  保留最近 64 条的先例 ⇒ 复用即可（或按 at 老化）」。
 * 采用**按 at 保留最近 64**（而非按时间老化）：档位是会话级长期偏好，久未压缩的老会话
 * 不该因为「几天没动」就丢掉已声明的档位。（另两条建议是它主动确认「设计正确、不用改」。） */
{
  const ctMod17 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  ok('R16.17 常量：档位落盘有会话数上限（TIER_SID_CAP = 64，与 lastUsedBySid 同款先例）',
    ctMod17.TIER_SID_CAP === 64, `实际 ${JSON.stringify(ctMod17.TIER_SID_CAP)}`);
  const tmp17 = mkdtempSync(join(tmpdir(), 'dcp-tiercap-'));
  const mk17 = (dir) => ctMod17.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (sp) => sp, getRangeApi: () => ({ TIER_NAMES: ['light', 'standard', 'heavy'] }), pluginDir: dir,
  });
  const api17 = mk17(tmp17);
  /* 登记 70 个会话（远超上限）——最后一次登记之后，落盘只应保留最近 64 个 */
  for (let i = 0; i < 70; i += 1) api17.setTier(`cap-sid-${String(i).padStart(3, '0')}`, i % 2 === 0 ? 'heavy' : 'light');
  const file = join(tmp17, '.data', 'compact-tier.json');
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  const keys = Object.keys(persisted.bySid ?? {});
  /* ⚠️ R16.17 静态契约：为什么不能只按 `at` 排序——
   * `at` 只有毫秒精度，同一毫秒内连续登记时「保留最新」会退化成**不确定**
   * （实测：改用 Map 位置当断链时，间歇性把旧会话留下、丢掉新会话）。
   * ⇒ 必须存在**显式单调序号**与它的降序断链；行为级测试在正常路径下覆盖不到这个抖动。 */
  const ctSrc17 = read('compact-tool.mjs');
  ok('R16.17 静态：档位裁剪用**显式单调序号**做确定性断链（不依赖 at 精度 / Map 位置）',
    /let tierSeq = 0;/.test(ctSrc17)
      && /tierSeq \+= 1;/.test(ctSrc17)
      && /Number\(b\.v\?\.seq\) \|\| 0\) - \(Number\(a\.v\?\.seq\) \|\| 0\)/.test(ctSrc17)
      && /seq: v\.seq \?\? 0/.test(ctSrc17),
    '缺单调序号/断链 ⇒ 同毫秒登记时「保留最新」不确定（间歇性丢新留旧）');
  ok('R16.17 静态：载入与写盘都带上 seq（跨重载仍可比较新旧）',
    /seq: Number\(v\.seq\) \|\| 0, restored: true/.test(ctSrc17) && /if \(Number\(v\.seq\) > tierSeq\) tierSeq = Number\(v\.seq\);/.test(ctSrc17),
    '只内存带 seq ⇒ 重载后新旧不可比，裁剪再次不确定');
  ok('R16.17 行为级：落盘被有界化（70 个会话 ⇒ 至多 64 条）',
    keys.length <= 64 && keys.length > 0,
    `实际落盘 ${keys.length} 条（应 ≤64）`);
  ok('R16.17 行为级：有界化**保留最新**（最老的两个会话被淘汰，最新的仍在）',
    !keys.includes('cap-sid-000') && !keys.includes('cap-sid-005') && keys.includes('cap-sid-069'),
    `keys[0..2]=${keys.slice(0, 3).join(',')} 末位=${keys[keys.length - 1]}`);
  /* 载入侧收敛：手工写一个超限文件，新实例载入后内存表也必须 ≤64 */
  const big = { version: 1, bySid: {} };
  for (let i = 0; i < 80; i += 1) big.bySid[`old-${String(i).padStart(3, '0')}`] = { tier: 'heavy', at: 1000 + i };
  writeFileSync(file, JSON.stringify(big));
  const api17b = mk17(tmp17);
  const kept = Array.from({ length: 80 }, (_, i) => `old-${String(i).padStart(3, '0')}`).filter((k) => api17b.hasTier(k)).length;
  ok('R16.17 行为级：载入超限文件时**内存表也收敛**到 ≤64（不会把历史全带进来）',
    kept <= 64 && kept > 0, `实际载入 ${kept} 条`);
  rmSync(tmp17, { recursive: true, force: true });
}

/* R16.18（用户实测：「上一轮 67% 说不压，新一轮却自动压好了」）：
 * 真机取证（session-70a55b1a turn 47）：05:13:34 turn/start → s1..s14；
 * 05:15:14.234 step/end s14 → 48ms 后 **compaction/start turn=47 src=engine** → 05:15:39 end；
 * 轮到插件 pre-step（step/start s15）已是 05:15:39.935。
 * 机制（引擎源码 resolveCompactSpec）：引擎在**每个 step 边界**按 min(窗口×80%, 预算) 判定，
 * 且该 seam 排在插件 pre-step 之前 ⇒ 只要**单步增量**把占用从「低于我方线」推到 ≥80%，我们必输。
 * 修：动态余量（用实测单步最大增量把我们的线提前）+ 记录里标注「引擎抢先」。 */
{
  const m3Src18 = read('m3.compact.mjs');
  ok('R16.18 静态：pre-step 采比例样本（动态余量的输入）且有界化',
    /const recordRatioSample = \(sid, ratio, mr\) =>/.test(m3Src18)
      && /RATIO_HIST_CAP = 12/.test(m3Src18) && /RATIO_SID_CAP = 64/.test(m3Src18)
      && /recordRatioSample\(sid, ratio, mr\);/.test(m3Src18),
    '缺比例历史 ⇒ 无法估计「一步能涨多少」，余量只能写死 5pp（引擎仍会抢先）');
  ok('R16.18 静态：动态余量 = clamp(5pp, 20pp, 单步最大增量)，并用 engineThreshold 重算线',
    /const margin = Math\.min\(0\.20, Math\.max\(0\.05, maxStep\)\);/.test(m3Src18)
      && /Math\.max\(0, eth - margin\)/.test(m3Src18)
      && /engineThreshold\(agent\)/.test(m3Src18),
    '仍写死 5pp 余量 ⇒ 单步增量大于 5pp 时引擎必然抢在我们前面');
  ok('R16.18 静态：host 向 m3 注入 engineThreshold（阈值核心同源，不抄常量）',
    /effEnabled, criticalCapOf, engineThreshold, resolveCompactionFor,/.test(host),
    'm3 拿不到引擎阈值 ⇒ 只能自己猜，违反「单一上限函数」纪律');
  /* 行为级：引擎抢先时，记录文案要带「我方上次估计 ＜ 我方线」，让原因一眼可见 */
  const m3Mod18 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const st18 = { m3: { ratioHist: { 'sess-18': [{ at: 1, ratio: 0.672 }] } } };
  const acts18 = [];
  const huds18 = [];
  const m3x18 = m3Mod18.createM3Compaction({
    state: st18, log: () => {}, msg: (e) => String(e?.message ?? e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75, engineThreshold: () => 0.8,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: (p) => huds18.push(p), recordHudAct: (sid, text) => acts18.push({ sid, text }),
    formatAct: (reason) => 'hh:mm · ' + ({ 'engine-auto': '引擎自动压缩', 'engine-manual': '手动压缩' }[reason] ?? String(reason)),
    clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 180000, SET_CAP: 200,
  });
  const sess18 = { id: 'sess-18', surface: [], eventAt: () => null };
  const t18 = m3x18.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c18', turn: 47 } }, sess18);
  ok('R16.18 行为级：引擎抢先时，记录里写明「我方上次估计 X% ＜ 我方线 Y%」',
    typeof t18 === 'string' && /引擎抢先：我方上次估计 67\.2% ＜ 我方线 75%/.test(t18),
    `实际：${JSON.stringify(t18)}`);
  ok('R16.18 行为级：该取证也进 lastEngineCompact（preempted / ourLastRatio / ourLine）',
    st18.m3.lastEngineCompact?.preempted === true && st18.m3.lastEngineCompact?.ourLastRatio === 67.2,
    `实际：${JSON.stringify(st18.m3.lastEngineCompact)}`);
}

/* R16.19（用户截图取证：新会话窗口里面板指纹显示 `sid=session-16616…` —— 拿到的是**别的会话**）：
 * R16.11 的「URL 优先」在**同一窗口内切换会话**时失效（URL 不更新），first-wins 的 fetch 捕获同样过期。
 * 权威来源已找到：插件的 chip 挂在 `conversation.input.right`（scope=session），
 * 其 standardProps **明确包含 `sessionId: SessionId`**（Slots 检视面），与 URL/请求无关。 */
{
  ok('R16.19 静态：chip 从槽位 props.sessionId 取**权威**会话 id（不靠 URL/请求猜）',
    client.includes('const sidProp = props && props.sessionId ? String(props.sessionId) : "";')
      && client.includes('NS.sidActive = sidProp;'),
    'chip 仍不读 props.sessionId ⇒ 同窗口切换会话后又会拿到别的会话（本次串会话的直因）');
  ok('R16.19 静态：resolveSid 以 sidActive 为**第一优先**（URL/fetch 降级为兜底）',
    (() => {
      const iBody = client.indexOf('const resolveSid = () => {');
      const iActive = client.indexOf('if (NS.sidActive) return String(NS.sidActive);', iBody);
      const iUrl = client.indexOf('location.href', iBody);
      return iBody >= 0 && iActive > iBody && iUrl > iActive; // 顺序：先查 sidActive，再读 URL
    })(),
    '优先级仍以 URL 打头 ⇒ 同窗口切换会话时会继续拿过期值');
  ok('R16.19 取证：指纹标注 sid 来源（slot/url/fetch），排障一眼可见',
    client.includes('const sidSource = () => {') && client.includes('src=${sidSource()}'),
    '指纹不标来源 ⇒ 下次串会话仍只能靠猜（本次正是靠指纹的 sid= 才定位到）');
}

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
/* client 也常需要在「不得出现某字符串」类断言里剥注释——本轮已两次栽在这一点上：
 * 解释性注释里引用了被禁的 token/文案，导致断言被自己的说明判失败。 */
const clientNoComment = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('getHud 按 sid 精确过滤（不再走血统链；R16.11 起空 sid 也不再返回全量）',
  /const filtered = sid \? list\.filter\(\(a\) => a\.sid === sid\) : \[\];/.test(m5src)
    && /actsTotal: list\.length,/.test(m5src),
  '过滤仍走 lineage 链 / 或空 sid 回退全量 ⇒ 面板会列出别会话的记录（用户实测「新会话只压一次却显示很多条」）');
/* R16.11（用户实测「压缩记录也串」）：三层堵漏，逐层钉死。 */
ok('R16.11 client：sid 统一解析口 resolveSid（URL 优先，其次 first-wins 兜底）',
  /const resolveSid = \(\) => \{/.test(client)
    && /location\.href/.test(client)
    && /const sidNow = resolveSid\(\);/.test(client)
    && /hudRemoteSvc\.getHud\(resolveSid\(\)\)/.test(client),
  'client 仍各自读 NS.sid ⇒ 会话身份可被别的请求抢走，按会话过滤失效');
ok('R16.11 client：fetch 捕获改 first-wins（绝不 last-wins 覆盖）+ 冲突留痕',
  /if \(!NS\.sid\) NS\.sid = m\[1\]; \/\/ first-wins/.test(client)
    && /NS\.sidConflicts = \(NS\.sidConflicts \|\| 0\) \+ 1;/.test(client)
    && !/if \(m\) NS\.sid = m\[1\];/.test(client),
  '仍是 last-wins ⇒ 任意带 sessionId 的请求都会把 NS.sid 改成别的会话');
ok('R16.11 client：轮询换代即弃缓存（sid 变了先清 hudRemote 再渲染）',
  /if \(\(NS\.hudSid \|\| ""\) !== sidNow\) \{/.test(client) && /hudRemote = null;/.test(client),
  '缺换代弃缓存 ⇒ 会话切换后仍渲染上一个会话的记录（「很多条」的直因）');
ok('血统链机制已整体退役（noteSessionId / state.m5.lineage / lastSid）',
  !/noteSessionId/.test(hostNoComment) && !/state\.m5\.lineage/.test(hostNoComment) && !/state\.m5\.lastSid/.test(hostNoComment),
  '血统链残留 ⇒ 跨会话误连可复活');
ok('hud-acts.json 不再持久化 lineage 键', !/lineage: state\.m5\.lineage/.test(host),
  '仍写 lineage ⇒ 假边继续累积');
ok('getHud 返回结构化明细 actsDetail（带 at 供完整时间渲染，查 m5.hud.mjs）',
  /actsDetail: filtered\.slice\(0, 8\)\.map\(\(a\) => \(\{ at: a\.at, text: a\.text \}\)\)/.test(m5src),
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
ok('client 删除了「带参失败退回无参全局查询」的**记录**回退',
  /* ⚠️ 只针对**弹窗记录**路径的兜底（`(!r || !r.ok) && sidNow` → 无参查询）；
   * 面板为取「生效上限」而发起的无参查询是另一回事（上限与会话无关），不能一并禁掉。 */
  !/\(!r \|\| !r\.ok\)[^;]{0,80}getHud\(""\)/.test(client),
  '仍回退无参查询 ⇒ 协议不匹配时显示全 DSH 记录');
/* wire 的**类型声明**不得再含全局兜底字段（签名里的散文可以叙述其退役，故只查声明形态）。 */
ok('wire 签名与 host 返回一致（actsDetail / 无全局兜底声明）',
  /actsDetail:\{at:string,text:string\}\[\]/.test(wire) &&
  !/actsGlobal:string\[\]/.test(wire) && !/hudLastActGlobal:string/.test(wire),
  'wire 签名仍声明全局兜底字段 ⇒ 三端漂移');
ok('m5.hudPoll 取证口径与 getHud 一致（按 sid 精确匹配，查 m1.snapshot.mjs）',
  /matched: state\.m5\.acts\.filter\(\(x\) => x\.sid === asid\)\.length,/.test(m1src),
  '取证口径仍走链 ⇒ 排查时看到的命中数与真实显示不一致');

/* ═══════════ 6.15 压缩改「工具触发」（R4：不再伪造用户消息）═══════════ */
console.log('\n== 6.15 自动压缩工具触发（替代 marker + 伪造恢复）==');
/* 用户明确要求（2026-10-08）：「自动压缩时，**不用伪造一条我的信息**重新拉起会话」。
 * 证据链与方案取舍见 docs/r4-compaction-tool-design.md；本段把该结论固化成绊线。 */
const ct = read('compact-tool.mjs');
/* R16.8（用户提出的时机逻辑）三源对账：压缩重置前缀缓存 + 换档使缓存失效 ⇒
 * 同轮顺带换档只付一次重建成本。回执侧断言在 m2src 处；此处对 compact/effort 两源。 */
ok('R16.8 时机教学（compact 侧）：决策卡与 description 都含「顺带换档只付一次缓存重建」',
  /同一条消息里顺带调用 set_reasoning_effort 换档，缓存重建只付一次/.test(ct),
  '决策卡缺位 ⇒ Agent 压缩时不知道可以同轮换档（错过缓存最优时机）');
ok('R16.8 时机教学（effort 侧）：换档工具 description 也写明该时机',
  /顺带换档是最优时机/.test(effort) && /只付一次重建成本/.test(effort),
  '换档侧缺位 ⇒ 两个工具的教学不互指，Agent 只能单边知晓');
/* R9/R10：M3 压缩域（执行核心 + 编排层）已整体搬进 plugin/m3.compact.mjs ⇒
 * 凡引用该域实现的断言一律从**模块**取切片，并额外钉「宿主不得把它抄回来」。 */
const m3src = read('m3.compact.mjs');
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
  /scheduled: 'next-step',/.test(ct),
  '未告知执行时机 ⇒ 模型会退回「停下等压缩」的旧习惯');
/* R15（用户要求「工具完成后进行检查，起码 agent 自己过一遍」）：工具只能登记，执行在下一步 ⇒
 * 结果必须带**自检契约**；否则「回 ok 但实际没执行」对模型完全不可见（2026-10-08 真机踩过）。 */
ok('压缩工具结果带自检契约（下一步会有「压缩自检」回执 + 未执行时怎么办）',
  /verify: `已登记，档位 \$\{tier\}/.test(ct) && /「压缩自检」回执/.test(ct) && /请再调用一次 compact_context/.test(ct),
  '缺自检契约 ⇒ 工具回 ok 但没执行时，模型无从察觉（真机踩过的盲区）');
/* R16：档位是会话级持续选择 ⇒ 自检契约必须把「持续生效」也教给模型。 */
ok('压缩工具自检契约说明档位**持续生效**（含强制线）',
  /该档位此后对本会话的压缩（含强制线）持续生效/.test(ct),
  '只报本次 ⇒ 模型以为每次都要重选档位');
/* R16.3：**介入时机**必须教给模型——想影响强制线，就要在越线之前选档。
 * 行为级验证放 6.20a 块（ctApi 就绪后）；这里先钉源码级最小护栏。 */
ok('压缩工具源码含「趁占用还在强制线之下时选定档位」的介入时机教学',
  /趁占用还在 \$\{crit\} 强制线之下时选定档位|趁还在强制线之下时选定档位|强制线之下时选定档位/.test(ct),
  '只教「持续生效」不教「介入时机」 ⇒ Agent 到强制线触发时才想选档，已来不及（用户问出的场景）');

const ctPreStep = /const preStepCompaction = async \(payload\) => \{([\s\S]*?)\n  \};/.exec(m3src)?.[1] ?? '';
ok('解析出 preStepCompaction 函数体', ctPreStep.length > 0, '未找到 preStepCompaction');
ok('pre-step 先装工具、再消费意图（与 R3 那个真 bug 同款护栏）',
  /await ensureCompactTool\(\);\s*\n\s*await preStepCompaction\(payload\);/.test(host),
  '懒安装排在消费之后 ⇒ 「工具接受了却没人消费意图」重演 R3 真 bug');
ok('意图门在 critical 门之前（低占用也能按模型请求压缩）',
  /* R10：意图表经 `getCompactTool()` 显式注入（不再直接闭包引用宿主的 compactToolApi）。 */
  /const tool = getCompactTool\(\);/.test(ctPreStep)
  && /const intent = tool \? tool\.peekIntent\(sid\) : null;/.test(ctPreStep)
  && /const wanted = !!intent;/.test(ctPreStep)
  && /if \(wanted\) tool\.takeIntent\(sid\);/.test(ctPreStep)
  && /if \(!wanted && ratio < effCritical\) return;/.test(ctPreStep),
  '顺序错 ⇒ 模型主动请求在低于强制线时被静默丢弃；工具也必须经注入取得');
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
/* R5（2026-10-08，E2E 之后 · 用户确认要做）：保留策略从
 * 「先试 pressure、为 null 才退 overflow」改为「**自选保留范围** → 失败/仍越线才**沿用官方** overflow 兜底」。
 * 旧断言在此**退役**（它固化的正是那条「53% 占用就把 1117 节点砍到 4 个」的路径）。
 * 自选范围本体见下方 §R5 段与 plugin/compact-range.mjs。 */
/* R9 解耦第二刀：`compactWithOwnRange` 的实现已搬进 plugin/m3.compact.mjs（宿主只留同名转发）
 * ⇒ 断言改从模块取切片（`m3src` 在文件前部已读入）；同时新增「宿主不得再自带一份实现」。 */
const ctOwnRange = /const compactWithOwnRange = async \(agent, compaction, ctx\) => \{([\s\S]*?)\n  \};/.exec(m3src)?.[1] ?? '';
ok('M3 执行核心已抽为叶子模块，且宿主不再重复实现',
  ctOwnRange.length > 0
  && /import\(`\.\/m3\.compact\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host)
  && /const compactWithOwnRange = async \(agent, compaction, ctx\) =>\n    \(m3Ctl/.test(host)
  /* 加强（R9 变异验证：首版只查 `const ratioKept = api.RETAIN_RATIO;`，一处改名就能躲过）：
   * 「范围执行」整体不得回流宿主——保留比例读取与 selectRange 调用都属于模块职责。 */
  && !/api\.RETAIN_RATIO/.test(hostNoComment)
  && !/api\.selectRange\(/.test(hostNoComment)
  && !/const compactWithOwnRange = async \(agent, compaction, ctx\) => \{\n    const \{ forced, sig, sid, window, measure \} = ctx;/.test(host),
  '宿主仍自带一份自选范围实现（比例读取/selectRange）⇒ 两套真相，本次解耦要消除的正是这个');
ok('M3 核心模块依赖全部注入（对宿主内部件零 import ⇒ 依赖图叶子）',
  !/^\s*import .*from ['"]\.\//m.test(m3src) && !/require\(/.test(m3src),
  '叶子模块 import 了宿主内部件 ⇒ 打破依赖图约束');
ok('M3 压缩域未就绪时不中断：降级为「本轮不压」并留痕',
  /const measureRatio = \(session\) => \(m3Ctl \? m3Ctl\.measureRatio\(session\) : \{ ok: false, error: 'm3-module-pending' \}\);/.test(host)
  && /skipWhy: 'm3-module-pending'/.test(host)
  && /M3 压缩域模块加载失败（吞/.test(host),
  '未做空值降级 ⇒ 激活期会 TypeError（apply 不是 async，不能 await）');
/* R10：编排层（preStepCompaction / idleSweep）也已搬走 ⇒ 宿主只许留**薄转发**。
 * 用「宿主不得再出现编排层的独有产物」判定，而不是只查函数名（改名就能躲过）。 */
ok('R10 编排层已抽：宿主不再自带 preStepCompaction / idleSweep 实现',
  /const preStepCompaction = async \(payload\) => \{\n    if \(!m3Ctl\)/.test(host)
  && /const idleSweep = \(agent\) => \{\n    if \(!m3Ctl\) return;/.test(host)
  && /getCompactTool: \(\) => compactToolApi,/.test(host)
  && /clearBriefed,/.test(m3src)
  && !/state\.m3\.lastPreStep = \{/.test(hostNoComment)
  && !/sweepInFlight/.test(hostNoComment)
  && !/M3\.sweepMinIntervalMs/.test(hostNoComment)
  && !/state\.m3\.actErrors\[code\]/.test(hostNoComment),
  '宿主仍带编排层实现/留痕 ⇒ 两套真相，且跨域回调会退化成闭包穿透（R7 审计的第二个解耦障碍回归）');
ok('R5 保留策略：自选范围优先 + 官方 overflow 兜底',
  /const out = await compactWithOwnRange\(agent, compaction, \{ forced, sig, sid, window: mr\.window, measure: mr\.measure, tierName \}\);/.test(ctPreStep)
  /* R16：档位从**会话级偏好**读取（工具登记），未选 ⇒ standard 兜底（用户明确要求）。 */
  && /const tierName = tool\?\.getTier\?\.\(sid\) \?\? 'standard';/.test(ctPreStep)
  && /const forced = ratio >= effCritical;/.test(ctPreStep)
  && /compactRegion\(sel\.start, end, agent, sig\)/.test(ctOwnRange)
  /* ⚠️ 必须连**回退次数上限**一起钉死：只断言 `return official('boundary-exhausted')` 会被
   * 「去掉 MAX_WALK_BACK 判断」的回归骗过去（变异验证实测逃逸过一次）。 */
  && /if \(!prev \|\| walkBacks \+ 1 > api\.MAX_WALK_BACK\) return official\('boundary-exhausted'\);/.test(ctOwnRange)
  && /return official\('invalid-boundary'\)/.test(ctOwnRange)
  && /compactIfNeeded\(agent, 'context-overflow', sig\)/.test(ctOwnRange),
  '自选范围未接上，或官方兜底缺失 ⇒ 要么丢掉保留预算，要么强制线不再兜底');
ok('R5 意图先消费后执行（防每个 step 反复重试）',
  (() => {
    /* 必须比**调用点**而非首次出现：R5 把 compactIfNeeded 挪进了 compactWithOwnRange，
     * 但 preStepCompaction 里仍有「强制线收口」那次调用——顺序断言继续按 preStepCompaction 内比对。 */
    const code = ctPreStep.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const t = code.indexOf('.takeIntent(sid)');
    const c = code.indexOf('.compactIfNeeded(');
    return t > -1 && c > -1 && t < c;
  })(),
  'takeIntent 晚于执行 ⇒ 失败后逐步重试，污染报告且浪费额度');
ok('意图消费全程留痕（compactIntents / lastCompactIntent）',
  /state\.m3\.compactIntents \+= 1;/.test(ctPreStep) && /state\.m3\.lastCompactIntent = \{/.test(ctPreStep),
  '消费无留痕 ⇒ 失败时无从定位（重演「工具接受成功却永不生效」）');

/* ═══════════ R5：保留范围自选（plugin/compact-range.mjs）═══════════
 * 起因是真机实测（2026-10-07，session 16616c07 turn 167，报告自动留痕）：
 *   `context-overflow` 的 retainTokens=0 ⇒ surface 从 **1117 节点 / 367,794 token**
 *   砍到 **4 节点 / 8,603 token**，而当时占用只有 53%。
 * R5 改为「自选保留预算（窗口 × 0.16）→ 失败/仍越线才沿用官方 overflow」。
 * 本段除静态接线外**真跑纯函数**（该模块无 IO ⇒ 可直接 import 断言行为）。 */
const cr = read('compact-range.mjs');
const crNoComment = cr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ENGINE_REF = join(ROOT, 'docs', 'reference', '__dsh__node_modules__@deepseek-ai__dsh-compaction-basic__lib__index.js');
const engineRef = readFileSync(ENGINE_REF, 'utf8');
const crMod = await import(pathToFileURL(join(PLUGIN, 'compact-range.mjs')).href);

ok('compact-range.mjs 按热换纪律动态加载（带 ?ts=）',
  /import\(`\.\/compact-range\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host),
  '未带 ?ts= ⇒ 改模块后不随 toggle 生效（P16 教训）');
ok('RETAIN_RATIO 与引擎 DEFAULT_RETAIN_RATIO 同源（0.16）',
  crMod.RETAIN_RATIO === 0.16 && /const DEFAULT_RETAIN_RATIO = \.16;/.test(engineRef),
  `模块常量 ${crMod.RETAIN_RATIO}，引擎默认 ${/DEFAULT_RETAIN_RATIO = ([\d.]+)/.exec(engineRef)?.[1] ?? '?'} ⇒ 保留预算口径漂移`);
ok('起点规则与引擎 systemHead 同源（走 session.eventAt，不是猜）',
  /session\?\.eventAt\?\.\(seq\)\?\.type === 'system\/message'/.test(crNoComment)
  && /const firstIdx = isSystemHead\(session, surface\[0\]\) \? 1 : 0;/.test(crNoComment)
  && /function systemHead\(session, headSeq\) \{\s*const head = session\.eventAt\(headSeq\);/.test(engineRef),
  '起点规则与引擎不一致 ⇒ 可能把 surface 节点 0 的 system/message 一起影子化');

/* ---- 行为断言（真跑模块，不是正则）---- */
const mkCase = ({ count, tokens, systemHead = false, headSeq = 1000 }) => {
  const nodes = [];
  const surface = [];
  const types = new Map();
  for (let i = 0; i < count; i += 1) {
    const seq = headSeq + i;
    surface.push(seq);
    nodes.push({ seq, tokens });
    types.set(seq, i === 0 && systemHead ? 'system/message' : 'assistant/message');
  }
  return {
    session: { surface: { nodes: surface }, eventAt: (s) => ({ type: types.get(s) ?? 'assistant/message' }) },
    measurement: { nodes },
  };
};
const c10 = mkCase({ count: 10, tokens: 100 });
const sel300 = crMod.selectRange({ ...c10, retainTokens: 300 });
ok('预算 300 / 10×100 token ⇒ 保留末 3 节点、影子前 7 节点',
  sel300.ok === true && sel300.retainedTokens === 300 && sel300.shadowTokens === 700
  && sel300.end === c10.session.surface.nodes[6] && sel300.start === c10.session.surface.nodes[0],
  `实际 ${JSON.stringify({ start: sel300.start, end: sel300.end, retained: sel300.retainedTokens, shadow: sel300.shadowTokens })}`);
const sel0 = crMod.selectRange({ ...c10, retainTokens: 0 });
ok('retainTokens=0 精确复现引擎 overflow 语义（只留最后 1 个节点）——这正是要改掉的过激行为',
  sel0.ok === true && sel0.retainedTokens === 100 && sel0.end === c10.session.surface.nodes[8],
  '与引擎 selectCompactableRange(...,0) 语义不符 ⇒ 无法用它解释线上实测的 1117→4');
const c10sys = mkCase({ count: 10, tokens: 100, systemHead: true });
const selSys = crMod.selectRange({ ...c10sys, retainTokens: 300 });
ok('surface 节点 0 是 system/message ⇒ 起点后移一位（系统消息永不进范围）',
  selSys.ok === true && selSys.start === c10sys.session.surface.nodes[1] && selSys.startIdx === 1,
  '起点未后移 ⇒ 会把系统消息影子化');
const c3 = mkCase({ count: 3, tokens: 100 });
ok('预算大于整个 surface ⇒ 判「没什么可压」而不是硬压',
  crMod.selectRange({ ...c3, retainTokens: 100000 }).why === 'nothing-to-compact',
  '预算超 surface 仍报可压 ⇒ 会压出空范围/无意义摘要');
ok('measurement 与 surface 不一致 / 无节点 ⇒ 拒绝（防按过期测量选范围）',
  crMod.selectRange({
    session: mkCase({ count: 5, tokens: 100, headSeq: 2000 }).session,
    measurement: mkCase({ count: 5, tokens: 100, headSeq: 1000 }).measurement,
    retainTokens: 100,
  }).why === 'surface-mismatch'
  && crMod.selectRange({ session: c3.session, measurement: { nodes: [] }, retainTokens: 100 }).why === 'no-nodes',
  '不校验 ⇒ 用旧测量切新 surface，范围会错位到别的消息上');
ok('prevEnd 逐个节点回退、到起点即放弃',
  crMod.prevEnd(c10.session.surface.nodes, 0, 5).end === c10.session.surface.nodes[4]
  && crMod.prevEnd(c10.session.surface.nodes, 0, 0) === null,
  '回退边界错 ⇒ 要么死循环，要么把起点也切进去');
ok('retainBudgetTokens = 窗口 × 比例；非法输入一律 0',
  crMod.retainBudgetTokens(1_000_000) === 160_000 && crMod.retainBudgetTokens(1_000_000, 0.5) === 500_000
  && crMod.retainBudgetTokens(0) === 0 && crMod.retainBudgetTokens(NaN) === 0 && crMod.retainBudgetTokens(1000, -1) === 0,
  '预算算错 ⇒ 保留比例整体偏移（窗口读不到时会变成「不保留」）');
ok('isSystemHead 对 eventAt 异常/缺失一律 false（与引擎「无系统头」同解）',
  crMod.isSystemHead({ eventAt: () => { throw new Error('boom'); } }, 1) === false
  && crMod.isSystemHead({}, 1) === false
  && crMod.isSystemHead({ eventAt: () => ({ type: 'system/message' }) }, 1) === true,
  '读类型失败即当系统头 ⇒ 起点错位一整个节点');

/* 错误分类：末端不合法 = 可回退重试；起点/找不到/无 turn = 直接官方兜底（重试无意义） */
const END_MSG = 'compactRegion: end seq 18296 is not a balanced boundary (would split a step, or the step is still open)';
const START_MSG = "compactRegion: start seq 15507 is not a balanced boundary (would split a step's tool-call/result pair)";
ok('引擎校验错误分类正确',
  crMod.isEndBoundaryError(new Error(END_MSG)) === true
  && crMod.isEndBoundaryError(new Error(START_MSG)) === false
  && crMod.isValidationError(new Error(END_MSG)) === true
  && crMod.isValidationError(new Error(START_MSG)) === true
  && crMod.isValidationError(new Error('compactRegion: end seq 9 not found in surface')) === true
  && crMod.isValidationError(new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')) === true
  && crMod.isValidationError(new Error('summarize failed')) === false
  && crMod.isValidationError(Object.assign(new Error('compaction already in progress'), { code: 'busy' })) === false,
  '分类错 ⇒ 要么无限回退，要么把真正的失败（摘要失败/busy）当边界问题吞掉');
ok('错误文案与引擎源码逐字一致（引擎改文案时这里先响）',
  engineRef.includes('is not a balanced boundary (would split a step, or the step is still open)')
  && engineRef.includes("is not a balanced boundary (would split a step's tool-call/result pair)")
  && engineRef.includes('compactRegion: end seq ${end} not found in surface')
  && engineRef.includes('no open turn — automatic compaction events must be enclosed in a turn'),
  '引擎错误文案已变 ⇒ 本模块的边界识别会静默失灵（回退重试不再发生）');

/* ---- host 接线 ---- */
ok('host 把 measure 本体带进自选范围（不二次测量、不猜节点）',
  /return \{ ok: true, used, surface, window, ratio, measure: m\.value \};/.test(m3src)
  && /api\.selectRange\(\{ session: agent\.session, measurement: measure, retainTokens: budget \}\)/.test(ctOwnRange),
  '没带 measure ⇒ 只能退化成官方路径，自选范围形同未接');
ok('保留预算按**会话档位**解析（R16：档位只改预算，不改范围算法）',
  /resolveTier\(tierName \?\? 'standard', window\)/.test(ctOwnRange)
  && /api\.resolveTier/.test(ctOwnRange) && /selectRange\(\{ session: agent\.session, measurement: measure, retainTokens: budget \}\)/.test(ctOwnRange),
  '档位没接进预算 ⇒ Agent 选档无效（功能性回归）');
ok('rangeProbe 留档位取证（请求档位/夹取/回落）',
  /tier: tierInfo\.tier,/.test(ctOwnRange) && /tierClamped: tierInfo\.clamped/.test(ctOwnRange) && /tierFallback: tierInfo\.fallback/.test(ctOwnRange),
  '选档无现场 ⇒「Agent 选了 heavy 却按 16% 压」这类问题无从还原');
ok('自选范围全程留痕（rangeProbe + rangeSource）',
  /state\.m3\.rangeProbe = \{/.test(ctOwnRange) && /rangeSource,/.test(ctPreStep) && /rangeProbe: null,/.test(hostOrCore),
  '范围算错时无现场 ⇒ 只剩「压了个奇怪的东西」这一句现象');
/* 2026-10-08 实测教训：真机出现过 `rangeProbe = {start: 20897, end: 19958}`（起点 seq > 终点 seq）。
 * 原因是**压缩检查点插在表头**（`source.kind='compact-checkpoint'`，其 seq 比所保留的旧尾部更大）
 * ⇒ **seq 在 surface 上并不单调**，只有 surface 位置能自证顺序（引擎也按位置校验，
 * 错误文案即 `start seq N (position P) is after end seq M (position Q)`）。
 * 没有位置字段时，这条记录会让人白查一轮（本次真的查了）。 */
ok('rangeProbe 同时记 surface 位置（seq 在 surface 上不单调，只有位置能自证顺序）',
  /startIdx: sel\.startIdx \?\? null,/.test(m3src) && /endIdx: sel\.endIdx \?\? null,/.test(m3src),
  '只记 seq ⇒ 检查点插入表头后必然出现「起点 seq > 终点 seq」的记录，读者会误判为 bug');
ok('强制线收口：自选范围后仍越线则追加官方 overflow（R16 泛化：**无论档位**，heavy 浅压也不能停在线上）',
  /if \(rangeSource === 'own' && result != null\) \{/.test(ctPreStep)
  && /mr2\.ratio >= effCritical/.test(ctPreStep)
  && /rangeSource = 'own\+official';/.test(ctPreStep),
  '只自选不收口 ⇒ heavy 档保留过多时强制线可能压不下去');

/* ═══════════ 6.19 「先说再调用」+「自己算范围」教学（2026-10-08 用户要求）═══════════
 * 用户要求两件事：
 *   ① 模型调用**压缩/换档**工具前，要在回复正文里**先说出来**再调用（工具调用对用户是静默的）；
 *   ② 把 R5 的「自己算范围」教给 Agent（否则它不知道压完还剩什么，只能靠猜）。
 * 本段不只查文本存在，还**真跑两个模块的渲染函数**核对活值注入与「不编数字」。 */
console.log('\n== 6.19 先说再调用 + 自己算范围教学 ==');
const ctApi = (await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href)).createCompactTool({
  svc: () => null, tryOf: () => ({ value: undefined, error: null }), pick: (...a) => a.find((x) => x != null),
  msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {}, state: { m3: {} },
  readCfg: () => ({ enabled: true }), getDefineTool: () => null,
});
const effApi = (await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href)).createEffort({
  svc: () => null, tryOf: () => ({ value: undefined, error: null }), pick: (...a) => a.find((x) => x != null),
  msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {}, state: { m3: {} },
  readCfg: () => ({ enabled: true }), getDefineTool: () => null,
});
/* 「先说，再调用」必须**分两半**钉死：显著标注 + 具体做法。
 * ⚠️ 变异验证实测教训：最初用「或」关系的单个正则，去掉标注后同段的「不具体做法」仍能匹配
 * ⇒ 断言照样通过（逃逸）。两者是**不同职责**：标注负责醒目，做法负责可执行。 */
const ANN_LABEL = /\*\*先说，再调用\*\*/;
const ANN_INSTR = /先在回复正文里用一句话说明/;
const annCtx = { ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75 };
const ctBriefTxt = ctApi.renderBrief({ criticalRatio: 0.75 }) ?? '';
const effBriefTxt = effApi.renderBrief({ ok: true, current: 'high', efforts: ['low', 'high'] }) ?? '';
const ctCardTxt = ctApi.renderCard(annCtx) ?? '';
ok('压缩一次性说明含「先说再调用」的显著标注 + 具体做法',
  ANN_LABEL.test(ctBriefTxt) && ANN_INSTR.test(ctBriefTxt),
  '未要求先说理由 ⇒ 用户只看到「调用了工具」，不知道模型为什么压');
ok('压缩决策卡含「先说再调用」的具体做法（卡片每轮出现 ⇒ 承担每轮提醒职责）',
  ANN_INSTR.test(ctCardTxt) && /说明你要压缩的理由/.test(ctCardTxt),
  '只在一次性说明里教 ⇒ 长会话后半段容易忘');
ok('换档一次性说明含「先说再调用」的显著标注 + 具体做法',
  ANN_LABEL.test(effBriefTxt) && ANN_INSTR.test(effBriefTxt),
  '未要求先说理由 ⇒ 用户不知道模型为什么换档');
ok('两个工具的 description 都要求「先说再调用」（description 每轮随请求下发 = 零额外 token 的每轮提醒）',
  /\*\*调用本工具前，先在回复正文里用一句话说明/.test(ct)
  && /\*\*调用本工具前，先在回复正文里用一句话说明/.test(effort),
  '只在一次性说明里教 ⇒ 每轮下发的提醒位被浪费');
ok('工具参数说明也要求把理由同时写进正文',
  /同一句话也要写在你的回复正文里/.test(ct) && /换档理由请同时写在回复正文里/.test(effort),
  '参数说明与正文要求脱节 ⇒ 模型可能只填参数不说理由');

/* 「自己算范围」教学：活值注入 + 拿不到活值时**不编数字** */
const cardLive = ctApi.renderCard({ ...annCtx, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
ok('决策卡把「保留多少」按**活值**写出来（16% / 160k）',
  /窗口 × 16%/.test(cardLive) && /160k token/.test(cardLive),
  `卡面未含活值 ⇒ 模型不知道压完还剩什么：${cardLive.slice(0, 140)}`);
const briefLive = ctApi.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
ok('一次性说明把「保留多少」按活值写出来，并说明「未超预算则什么都不压」',
  /窗口 × 16%/.test(briefLive) && /近端约 160k token 原样保留/.test(briefLive) && /什么都不会压/.test(briefLive),
  '未教自选范围 ⇒ 模型以为压缩=砍光，于是不敢调用');
const briefNoNum = ctApi.renderBrief({ criticalRatio: 0.75 }) ?? '';
/* R16：档位比例（8/16/24%）是 compact-range.mjs 的**模块常量**，允许写死在教学里；
 * 本条护栏只针对「当前窗口的 token 数」——那个必须按活值现算，不得编数字。 */
ok('拿不到活值时不编**当前窗口的 token 数**（档位比例是常量，允许出现）',
  !/近端约 \d+k token/.test(briefNoNum) && !/现行生效：\d+k/.test(briefNoNum) && /固定比例/.test(briefNoNum),
  '活值缺失时仍写死窗口 token 数 ⇒ 常量/窗口变化后教学自相矛盾（本项目已因此踩过坑）');
ok('「保留多少」活值传进两个教学出口（读常量 + 按当前窗口现算，查 m2.inject.mjs）',
  /const ratio = getRangeApi\(\)\?\.RETAIN_RATIO \?\? null;/.test(m2src)
  && /Math\.floor\(w \* ratio\)/.test(m2src)
  && /renderCard\(\{[\s\S]{0,300}retentionTeach\(win\)[\s\S]{0,300}\}/.test(m2src)
  && /renderBrief\(\{ criticalRatio: crit, \.\.\.retentionTeach\(win\) \}\)/.test(m2src),
  '活值没接上 ⇒ 教学与实际保留范围脱节（写死 16%/160k 会随常量与窗口漂移）');

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
  /function renderBrief\(\{ criticalRatio, retainRatio, retainTokens \} = \{\}\) \{/.test(ct)
  && /return api\.renderBrief\(\{ criticalRatio: crit, \.\.\.retentionTeach\(win\) \}\);/.test(m2src),
  '说明文本仍散在 host ⇒ 与工具名/文案两处漂移');
ok('一次性说明不再承诺「自动拉起」（已无该机制）',
  !/自动拉起|自动恢复/.test(ct) || /没有\*\*任何自动拉起动作|不需要\*\*任何「待执行」占位/.test(ct),
  '说明仍在承诺自动拉起 ⇒ 模型会等一个永远不会到来的恢复');
ok('一次性说明明确「没有自动拉起动作」这一反向澄清',
  /没有\*\*任何自动拉起动作/.test(ct),
  '未做反向澄清 ⇒ 模型可能保留旧预期（写标记等恢复）');

/* ═══════════ 6.16 强制压缩线恒低于 DSH 内置阈值 5 个百分点 ═══════════ */
console.log('\n== 6.16 强制压缩线：恒低于 DSH 内置阈值 5pp ==');
/* 用户要求（2026-10-08）：「设置的强制压缩线永远低于 DSH 内置 5%（内置 80% ⇒ 上限 75%），计算也改」。
 * （⚠️ 首版我按 0.5pp 实现，用户随即更正为 **5pp**——余量得够大才让插件线确定性先行。）
 * 理由：两线相等时谁先命中取决于各自测量时机，插件可能「什么都没做、占用却降了」⇒ HUD 记录失真。 */
/* R8 解耦第一刀：实现搬进 plugin/threshold.mjs（叶子模块），host 只留懒加载 + 三个同名转发。
 * ⇒ 下列断言改指向**模块**，并新增「host 不得再重复定义」的反向断言（防搬完又抄一份回来）。 */
const threshold = read('threshold.mjs');
ok('R8 阈值核心已抽为叶子模块，且 host 不再重复定义',
  /export function createThreshold\(\{ svc, tryOf, state, log \}\) \{/.test(threshold)
  && /import\(`\.\/threshold\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host)
  && !/const ENGINE_CAP_MARGIN = 0\.05;/.test(host)
  && !/const DEFAULT_ENGINE_THRESHOLD = 0\.8;/.test(host),
  'host 仍自带一份阈值实现/常量 ⇒ 两套真相必然漂移（正是本次解耦要消除的东西）');
ok('阈值模块依赖全部注入（对宿主内部件零 import ⇒ 依赖图叶子）',
  !/^\s*import .*from ['"]\.\//m.test(threshold) && !/require\(/.test(threshold),
  '叶子模块 import 了宿主内部件 ⇒ static.mjs 的依赖图约束会被打破（并形成环）');
ok('阈值模块按热换纪律动态加载（带 ?ts=）',
  /import\(`\.\/threshold\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host),
  '未带 ?ts= ⇒ 改模块后不随 toggle 生效（P16 教训）');
ok('阈值模块未就绪时不中断：降级为「不做上限钳制」并留痕',
  /const criticalCapOf = \(agent\) => \(thresholdCtl \? thresholdCtl\.criticalCapOf\(agent\) : NO_CAP\);/.test(host)
  && /const NO_CAP = 1;/.test(host)
  && /阈值核心模块加载失败（吞/.test(host),
  '未做空值降级 ⇒ 激活期调用会 TypeERrror/静默失效（apply 不是 async，不能 await）');
ok('阈值模块定义 5pp 余量常量', /const ENGINE_CAP_MARGIN = 0\.05;/.test(threshold),
  '缺余量常量 / 值不是 5pp（写死在多处还会改一处漏两处）');
ok('生效上限抽成单一来源 criticalCapOf（= 引擎阈值 − 余量，下限 0）',
  /const criticalCapOf = \(agent\) => Math\.max\(0, engineThreshold\(agent\) - ENGINE_CAP_MARGIN\);/.test(threshold),
  '未抽单一上限函数 ⇒ 三处门控各写一遍必然漂移');
/* R10：两条门控随编排层搬进 plugin/m3.compact.mjs ⇒ 断言改查模块；宿主只保留 getHud 下发点。 */
for (const [label, re, src] of [
  /* R16.18：pre-step 门控改为「criticalCapOf + 动态余量」的 IIFE（仍是同一上限函数来源）。 */
  ['pre-step 门控（m3.compact.mjs）', /const effCritical = \(\(\) => \{[\s\S]{0,900}criticalCapOf\(agent\)[\s\S]{0,900}engineThreshold\(agent\)[\s\S]{0,900}\}\)\(\);/, m3src],
  ['idle safety-net 门控（m3.compact.mjs）', /if \(mr\.ratio < Math\.min\(M3\.criticalRatio, criticalCapOf\(agent\)\)\) return;/, m3src],
  ['getHud 下发（m5.hud.mjs）', /criticalCap: criticalCapOf\(targetAgent\),/, m5src],
]) {
  ok(`强制线三处同源：${label}`, re.test(src), '该处未用 criticalCapOf ⇒ 与其余两处不一致');
}
ok('不再有任何一处用裸引擎阈值做门控 / 下发',
  !/Math\.min\(M3\.criticalRatio, engineThreshold\(agent\)\)/.test(host) && !/criticalCap: engineThreshold\(/.test(host),
  '仍有裸 engineThreshold ⇒ 5pp 余量被绕过');
ok('engineCapProbe 同时记原始阈值与生效上限（否则报告里看不出余量扣在哪）',
  /cap: \+Math\.max\(0, raw - ENGINE_CAP_MARGIN\)\.toFixed\(4\)/.test(threshold) && /margin: ENGINE_CAP_MARGIN,/.test(threshold),
  '取证只记原始值');
ok('client 提示语说明「DSH 内置阈值 − 5 个百分点」（未探测到时也说规则）',
  /DSH 内置阈值 − 5 个百分点/.test(client),
  '提示未说明余量规则 ⇒ 用户以为上限还是 80%');
ok('client 用一位小数显示上限（0.745 不能被四舍五入掉小数）',
  /Math\.round\(Number\(x\) \* 1000\) \/ 10/.test(client) && /Math\.round\(engineCap \* 1000\) \/ 10/.test(client),
  '用 Math.round(x*100) ⇒ 余量的实际落点不可见');
ok('弹窗阈值行显示**生效值** min(配置, 上限) 而非裸配置',
  /const critEff = critCap != null \? Math\.min\(critCfg, critCap\) : critCfg;/.test(client)
  && /强制压缩线 \$\{pct\(critEff, 0\.85\)\}/.test(client),
  '弹窗显示裸配置 ⇒ 用户看到 75% 却在实际更低处触发');
ok('弹窗「距强制线」也用生效值（否则在不会触发的线上报已达线）',
  /const crit = critEff;/.test(client),
  '距线提示仍用裸配置 ⇒ 误导');
/* R8（用户截图反馈）：状态提示原先**拼进同一个文本节点**，而弹窗宽仅 ~230px
 * ⇒ 40+ 汉字在 11px 下不可能一行放下，浏览器逐字折行成「…· 已过智」/「能压缩线（距强制线 305K）」。 */
ok('弹窗状态提示独立成行（不在窄弹窗里从中间断开）',
  /const hintLine = document\.createElement\("div"\)/.test(client)
  && /thr\.appendChild\(hintLine\)/.test(client)
  && !/thr\.textContent \+= ` · \$\{hint\}`/.test(clientNoComment),
  '提示又拼回同一串 ⇒ 弹窗会从「智能压缩线」中间逐字断开（用户截图反馈）');
ok('hudRemote 带上 criticalCap（弹窗才能算生效值）',
  /criticalCap: typeof r\.criticalCap === "number"/.test(client),
  'hudRemote 缺 criticalCap ⇒ 弹窗拿不到上限');
/* ═══ 2026-10-08 用户实测的真 bug ═══
 * 「设置 0.8，没有钳回 0.75」：生效上限原先**只由悬浮弹窗的 pullHud 写入 `NS.engineCap`**，
 * 而设置面板是**独立表面** —— 用户没开过弹窗时 `NS.engineCap` 恒为 null ⇒
 * ① 备注一直显示「待探测」② 保存时**不钳制**。另：NS 属性变化不触发重渲染，必须用 React state。 */
ok('面板**自己拉取**生效上限：真的从 getHud 的 criticalCap 取值',
  /const \[engineCap, setEngineCap\] = react\.useState/.test(client)
  && /const pullCap = async \(\) => \{/.test(client)
  /* ⚠️ 必须断言**取值表达式本身**：只查「有 pullCap / 有 setEngineCap」会被
   * 「写了函数但 `const c = null`」蒙混过关（变异实测：弱版断言未抓住）。 */
  && /const c = env && typeof env\.criticalCap === "number" && Number\.isFinite\(env\.criticalCap\) \? env\.criticalCap : null;/.test(client)
  && /NS\.engineCap = c;/.test(client) && /setEngineCap\(c\);/.test(client),
  '面板仍只读 NS.engineCap / 未真正取 criticalCap ⇒ 没开过弹窗时上限恒 null（备注「待探测」+ 保存不钳制）');
ok('面板保存路径用面板 state 钳制（不用 NS.engineCap）',
  /const cap = engineCap !== null && engineCap > 0 && engineCap <= 1 \? engineCap : null;/.test(client),
  '仍读 NS.engineCap ⇒ 没开弹窗时保存不钳制（设 0.8 就真存成 0.8）');
ok('面板计算器/回读提示同样用面板 state（三处同源）',
  /const cap = engineCap !== null && engineCap > 0 && engineCap <= 1 \? engineCap : null;/.test(client)
  && /Math\.round\(engineCap \* 1000\) \/ 10/.test(client),
  '计算器或回读提示仍读 NS.engineCap ⇒ 与保存路径不同源');
/* ═══ 用户二次反馈：「设置 0.8 没有钳回 0.75」且**保存按钮是灰的** ═══
 * 根因：只做了「保存时钳制」。而用户输入 0.8 时**已存值也是 0.8** ⇒ `dirty=false`
 * ⇒ `保存` 的 disabled 条件含 `!dirty` ⇒ 按钮灰掉 ⇒ 那条钳制路径**根本走不到**。
 * ⇒ 必须在**输入时**就把值钳回上限（输入框当场显示 0.75 ⇒ dirty 变真 ⇒ 保存可用）。 */
ok('强制压缩线在**输入时**即钳到生效上限（不只是保存时）',
  /if \(field\.key === "criticalRatio" && engineCap !== null\) \{/.test(client)
  && /const n = parseInput\(field, raw\);/.test(client)
  && /if \(n !== null && n > engineCap\) next = String\(engineCap\);/.test(client),
  '只有保存时钳制 ⇒ dirty=false 时保存按钮是灰的，钳制路径走不到（实测截图）');
ok('输入钳制不误伤输入过程（空串/半成品不改写）且上限未知时不瞎钳',
  /if \(n !== null && n > engineCap\)/.test(client) && /engineCap !== null\) \{/.test(client),
  '对非法输入也钳 / 未探测到上限也钳 ⇒ 边打字边被改写或钳到错值');
/* ═══ 用户三次反馈：「如果原保存值超过钳回值，应该也直接钳回保存」 ═══
 * 场景：早先存过 0.8，之后上限收紧到 0.75 ⇒ 进面板时 stored 仍 0.8，而 dirty=false
 * ⇒ 保存按钮灰的，用户**没有可行的收敛路径**。⇒ 进面板即自动钳回并落盘（只做一次）。 */
ok('已存值超上限 ⇒ 进面板自动钳回并保存（用户明确要求）',
  /const autoClamped = react\.useRef\(false\);/.test(client)
  && /await writeField\(settingsScope, field, engineCap\);/.test(client)
  && /if \(!Number\.isFinite\(cur\) \|\| cur <= engineCap\) return;/.test(client),
  '没有自动钳制 ⇒ 已存超限值时保存按钮是灰的，用户无法收敛（实测卡点）');
ok('自动钳制只做一次且有回读校验（失败可重试）',
  /if \(autoClamped\.current\) return;/.test(client)
  && /if \(back !== engineCap\) throw new Error/.test(client)
  && /autoClamped\.current = false; \/\/ 失败允许下次重试/.test(client),
  '无一次性守卫 ⇒ 可能反复写；无回读校验 ⇒ 写了不生效也不知道');
ok('自动钳制仅在可写 + 上限已知 + 就绪时执行',
  /if \(!ready \|\| !writable \|\| engineCap === null\) return;/.test(client),
  '未就绪/只读时也写配置 ⇒ 越权或写坏值');
/* ═══ R7 审查（D5/E1/E6）：客户端三处结构性缺陷的护栏 ═══ */
ok('CardBoundary 是**真正的** React 错误边界（不是只 try/catch 渲染期）',
  /class CardBoundary extends react\.Component/.test(client)
  && /static getDerivedStateFromError\(\)/.test(client)
  && /componentDidCatch\(error\)/.test(client)
  && !/function CardBoundary\(props\)/.test(client),
  '仅 try/catch ⇒ effect / 事件回调 / 异步 setState 的异常仍会把整个插件详情页打崩（已出过一次真事故）');
ok('弹窗「距智能压缩线」的数据源真的搬进来了（E1 修）',
  /occupancyRatio: typeof r\.occupancyRatio === "number"/.test(client)
  && /occupancyWindow: typeof r\.occupancyWindow === "number"/.test(client)
  && /const occ = num\(v\.occupancyRatio, null\)/.test(client),
  'host 算了 / wire 声明了 / client 不搬 ⇒ 该 UI 分支永不显示（三端漂移）');
/* ⚠️ 必须**计数**：块内有**两处** `if (!alive) return;`（写入后、错误分支），
 * 只断言「存在一处」时删掉任一处仍会通过（变异验证实测逃逸一次）。 */
const autoClampBlock = /const autoClamped = react\.useRef\(false\);[\s\S]*?\}, \[ready, writable, engineCap, stored\.criticalRatio\]\);/.exec(client)?.[0] ?? '';
ok('autoClamped 异步分支有 alive 守卫（写入后 + 错误分支两处）',
  (autoClampBlock.match(/if \(!alive\) return;/g) ?? []).length === 2
  && /await writeField\([\s\S]{0,200}if \(!alive\) return;/.test(autoClampBlock),
  '守卫缺失/只补一处 ⇒ 组件已卸载仍继续写配置或 setState（越权副作用）');
/* ═══ 教学必须教**生效值**（2026-10-08 实测：卡片写「占用达 80%」而实际 75%） ═══ */
ok('决策卡/一次性说明拿到的是**生效**强制线（不是配置值）',
  /const effCrit = Math\.min\(M3\.criticalRatio, criticalCapOf\(agent\)\);/.test(m2src)
  && /renderPolicyCard\(r\.ratio, effCrit, r\.window, trendOf\(sid, r\.ratio, r\.window, effCrit\)\)/.test(m2src) && /renderBrief\(effCrit, r\.window\)/.test(m2src),
  '教学仍用配置值 ⇒ 教一个不会触发的数字（与门控不同源）');
ok('两个出口都把 effCrit 落进模块参数（不是各自再读 M3.criticalRatio）',
  /* 必须数**两处**（renderPolicyCard 与 renderBrief 各一）——只匹配到一处时，
   * 另一个出口仍读配置值也照样通过（变异实测：弱版断言未抓住）。 */
  (m2src.match(/const crit = Number\.isFinite\(effCrit\) \? effCrit : M3\.criticalRatio;/g) ?? []).length === 2,
  '出口内部仍读配置值，或只改了两个出口中的一个 ⇒ 传参被忽略');
/* 用户要求（2026-10-08）：删掉「（已按上限 75% 收敛）」——显示生效值本身已经说清事实。 */
ok('弹窗阈值行不再追加「（已按上限 … 收敛）」（用户要求删除）',
  !/已按上限/.test(clientNoComment),
  '仍带收敛注释 ⇒ 用户已明确要求删除');

/* ═══════════ 6.17 组件作用域护栏（防跨组件引用面板 state） ═══════════ */
console.log('\n== 6.17 组件作用域：PriceCalculator 不得直接引用面板 state ==');
/* 真事故（2026-10-08，用户截图「面板不见了」）：把 PriceCalculator 里的 `NS.engineCap`
 * 改成面板组件的 state `engineCap`，而它是**独立的函数组件** ⇒ `ReferenceError: engineCap is not defined`
 * ⇒ React 抛错 ⇒ **整个配置卡从插件页消失**（整页只剩「包含的组件」）。
 * `node --check` **只查语法、抓不到未定义标识符**；static.mjs 的语法护栏对此完全无效。
 * ⇒ 静态护栏：抽出该组件函数体，把它引用的**面板 state 名**与它的 props 列表对账。 */
const pcSrc = (() => {
  const i = client.indexOf('function PriceCalculator');
  if (i < 0) return '';
  const j = client.indexOf('\n\t\t}', i); // 组件收尾缩进（2 tab）
  return j > i ? client.slice(i, j) : client.slice(i, i + 20000);
})();
const pcProps = /function PriceCalculator\(\{([^}]*)\}\)/.exec(client)?.[1] ?? '';
ok('解析出 PriceCalculator 源码与 props', pcSrc.length > 0 && pcProps.length > 0, '未匹配到该组件（改名了？）');
const PANEL_STATE = ['engineCap', 'draft', 'saving', 'message', 'rev', 'stored', 'ready', 'snapshot'];
const leaked = PANEL_STATE.filter((n) => new RegExp(`\\b${n}\\b`).test(pcSrc) && !new RegExp(`\\b${n}\\b`).test(pcProps));
ok('PriceCalculator 引用的面板 state 全部经 props 传入（防 ReferenceError 崩卡）',
  leaked.length === 0,
  `直接引用了面板 state：${leaked.join(', ')} ⇒ ReferenceError ⇒ 整个配置卡消失（实测事故）`);
ok('面板确实把 engineCap 传给了计算器（渲染处与签名两头都在）',
  /el\(PriceCalculator, \{ writable, saving, onApply: applyRecommendation, engineCap \}\)/.test(client),
  '渲染处没传 engineCap ⇒ 计算器拿到 undefined（虽不崩，但上限提示失效）');

/* ═══════════ 6.8 R1 智能思考字段三端对账 ═══════════ */
console.log('\n== 6.8 智能思考字段（FIELDS ↔ schema ↔ M3_DEFAULTS）==');
ok('FIELDS 含 effortEnabled', fieldsKeys.includes('effortEnabled'), '面板缺该字段');
ok('schema 含 effortEnabled', schemaKeys.includes('effortEnabled'), 'schema 缺该字段 ⇒ 面板保存被拒');
ok('M3_DEFAULTS 含 effortEnabled', hostDefaults.includes('effortEnabled'), 'host 缺该字段 ⇒ 读不到');
ok('mergeConfig 读取 effortEnabled', /for \(const k of \[[\s\S]{0,120}'effortEnabled'/.test(hostOrCore),
  'mergeConfig 未读 ⇒ 面板改值不生效');
ok('effortEnabled 默认关闭（新功能默认不介入）', /effortEnabled:\s*false/.test(hostOrCore),
  '默认开启 ⇒ 未确认就改变既有会话行为');
/* R3-S7：换档冷却可配（换档会使前缀缓存失效 ⇒ 计费敏感参数，必须能让用户按口径调）。 */
ok('FIELDS 含 effortCooldownMs（冷却可配，S7）', fieldsKeys.includes('effortCooldownMs'), '面板缺该字段 ⇒ 用户改不到冷却');
ok('schema 含 effortCooldownMs', schemaKeys.includes('effortCooldownMs'), 'schema 缺该字段 ⇒ 面板保存被拒');
ok('M3_DEFAULTS 含 effortCooldownMs', hostDefaults.includes('effortCooldownMs'), 'host 缺该字段 ⇒ 读不到');
/* R7：`armedTtlMs` 随 marker 通道退役移出读取集。断言改为**钉住完整集合**——
 * 只钉某一项存在的话，新增/删除字段都不会被发现（原版正是这个弱写法）。 */
ok('mergeConfig 读取集与 M3_DEFAULTS 完全同源（防「面板改了不生效」与漂移）',
  /for \(const k of \['enabled', 'effortEnabled', 'criticalRatio', 'markerMinRatio', 'sweepMinIntervalMs', 'effortCooldownMs'\]\) \{/.test(hostOrCore)
  && /for \(const k of \['sweepMinIntervalMs', 'effortCooldownMs'\]\)/.test(hostOrCore)
  && !/armedTtlMs/.test(hostNoComment),
  '读取集缺项 ⇒ 面板改值不生效；多出已退役项 ⇒ 死配置；应改为集合级对账');
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
  /* ⚠️ 2026-10-08：调用点由 `renderPolicyCard(r.ratio)` 变为 `renderPolicyCard(r.ratio, effCrit)`
   * （决策卡/说明必须教**生效强制线**而非配置值）⇒ 正则放宽到参数列表任意内容。
   * R12：注入主体已搬进 plugin/m2.inject.mjs 的 `buildInjection` ⇒ 从模块取切片。 */
  const m = /const card = renderPolicyCard\(r\.ratio[^;]*\);([\s\S]*?)return \{ message, text: fullText/.exec(m2src);
  return m ? m[1] : '';
})();
ok('解析出 M2 注入主体（m2.inject.mjs buildInjection）', injectBody.length > 0, '未匹配到注入主体（改名了？）');
/* 只截取 **effort 相关**的那几行（从注释「智能思考：**独立门控**」到 fullText 拼装）——
 * 不能截整个注入主体：它包含 renderPolicyCard 行，而卡本身合法引用 markerMinRatio。 */
const effInject = (() => {
  const s = m2src.indexOf('/* 智能思考：**独立门控**');
  if (s < 0) return '';
  const e = m2src.indexOf('const fullText =', s);
  return e > s ? m2src.slice(s, e) : '';
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
ok('懒安装不受 step 门控约束（先于注入调用）',
  (() => {
    const s = host.indexOf('await ensureEffort();');
    const g = host.indexOf('await m2Ctl.buildInjection(payload);');
    /* R12：`step !== 1` 早退已随注入主体搬进 m2.inject.mjs ⇒ 宿主判据改为
     * 「懒安装必须早于注入调用」，模块侧另行钉住「非 step1 不注入」。 */
    return s > 0 && g > 0 && s < g && /if \(step !== 1\) \{[\s\S]{0,900}?return \{ skip: 'not-step-1' \};/.test(m2src);
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
  /catch \{ \/\* 读档失败 ⇒ 不注入/.test(m2src),
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
  ['③ 工具名+调用方式', /TOOL_NAME \+ '（参数 effort=<档位>）/],
  /* R16.12：判据从自指式（「需要更深推理时」）改为**可核对的触发表**。 */
  ['④ 何时该用（触发表）', /什么时候该切/],
  ['⑤ 生效时机+不中断', /本次任务内立即生效|任务与上下文不中断/],
  ['⑥ 代价提醒', /只打断一次前缀缓存|冷却拒绝\*\*不影响任务/],
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
  /briefedBySid\.delete\(sid\)[\s\S]{0,120}?effBriefedBySid\.delete\(sid\)/.test(m2src),
  '只清一个 ⇒ 另一个仍永不重讲');
/* R10：两条压缩路径（pre-step / idle）已随编排层搬进 m3.compact.mjs ⇒ 调用点查模块。
 * `clearBriefed` 本体仍在宿主（属 M2 教学域），因此还要钉「模块经**显式注入**拿到它」—— */
const clearCalls = (m3src.match(/clearBriefed\(sid\)/g) || []).length;
ok(`clearBriefed 在两条压缩路径都被调用（实际 ${clearCalls} 处，查 m3.compact.mjs）`, clearCalls >= 2,
  '只在一条路径清除 ⇒ 另一条压缩路径后说明仍丢失');
ok('clearBriefed 经显式注入进 M3 模块（不再靠闭包穿透 M2 域）',
  /clearBriefed,/.test(m3src)
  && /publishHud, recordHudAct, formatAct, clearBriefed,/.test(host)
  && !/const clearBriefed = /.test(m3src),
  'M3 模块自己声明 clearBriefed / 或宿主没注入 ⇒ 依赖方向被破坏（R7 审计的第二个解耦障碍回归）');
ok('clearBriefed 声明早于模块接线（无 TDZ 风险）',
  host.indexOf('const clearBriefed = ') < host.indexOf('publishHud, recordHudAct, formatAct, clearBriefed,'),
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
  /effortDiag: \{ calls: 0/.test(hostOrCore),
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
  (effort.match(/read\(agent\)/g) || []).length >= 3 && /await effortApi\.read\(agent\)/.test(m2src),
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
  /if \(changed\) \{[\s\S]{0,200}if \(!s\.switchedAt\) s\.switchedAt = Date\.now\(\);/.test(effort),
  '每轮刷新冷却基准 ⇒ 冷却永远处于「刚换过」，模型后续换档全被跳过');
/* R15.1（用户实测反馈：「切换到 Max 时 chip 没有进入冷却状态」）——
 * 实测时序：工具接受(.696) → 插件在**下一次请求** apply(.719) → 客户端投影才变 → chip 去 getHud，
 * 而那一次轮询就夹在中间且之后再无轮询 ⇒ chip 只看到「还没起算冷却」的那一帧。
 * 修法：冷却锚点落在**接受时刻**（事件顺序上早于客户端那次轮询）。 */
ok('冷却锚点落在工具**接受**时刻（客户端那次 getHud 之前，chip 才看得到冷却）',
  /st\.switchedAt = Date\.now\(\);/.test(effort) && /工具接受：/.test(effort),
  '锚点仍在 apply 时刻 ⇒ chip 的那一次轮询永远赶在起算之前，界面永远显示「就绪」（真机实测）');
ok('客户端在投影变化后**补拉一次**（插件状态稍后才落定）',
  /const latePull = setTimeout\(\(\) => \{ if \(alive\) pullOnce\(\); \}, 2500\);/.test(client)
  && /clearTimeout\(latePull\)/.test(client),
  '只拉一次 ⇒ 状态晚于投影落定时界面永久陈旧（本次真机 bug 的另一半）');
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
  /async function loadDefineTool\(\)/.test(hostOrCore) && /dshToolsCandidates/.test(hostOrCore),
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
  /* ⚠️ 窗口从 700 放宽到 1600：R15.3 加 `applied`/`verify` 声明后，schema→render 的距离撑爆了窗口，
   * 断言就以「缺 render」的形式假失败（R7 记过同一类坑：**正则窗口宽度是断言的一部分**）。 */
  /output: \{[\s\S]{0,80}?schema: \{[\s\S]{0,1600}?render: \(_args, value\) => \[\{ type: 'text', text: JSON\.stringify\(value\) \}\]/.test(effort),
  '缺 output.render ⇒ 工具结果无法渲染给模型');
ok('工具执行异常被吞并返回错误（不影响会话）',
  /智能思考 工具执行异常（吞）/.test(effort),
  '异常未吞 ⇒ 可打崩工具调用');
ok('工具注册结果有取证字段（effortTool / effortToolLoader）',
  /effortTool: null/.test(hostOrCore) && /effortToolLoader: null/.test(hostOrCore),
  '缺取证 ⇒ 工具没生效时无法定位断点');
ok('工具调用次数有取证（effortToolCalls / lastEffortTool）',
  /effortToolCalls \+= 1/.test(effort) && /state\.m3\.lastEffortTool = \{/.test(effort) &&
  /effortToolCalls: 0/.test(hostOrCore) && /lastEffortTool: null/.test(hostOrCore),
  '工具调用无取证 ⇒ 无法区分「模型没调」与「调了没生效」');
ok('死字段已删除（effortMarkerHits / lastEffortMarker）',
  !/effortMarkerHits|lastEffortMarker/.test(stripComments(host) + stripComments(effort)),
  '文本标记时代的死字段仍在 ⇒ 新读者会以为标记机制还在（R3-S1）');
/* 文本标记时代的「标记必须独占一行（防散文误触发）」断言已随方案一并移除——
 * 工具方案参数结构化，**不存在**正则误判面（这正是换工具的理由之一）。
 * 历史记录见 docs/milestones.md（R1 那节仍保留该坑的描述，供后来者参考）。 */

/* ═══════════ 7. mergeConfig 读取集 ⊆ schema 键 ═══════════ */
console.log('\n== 7. mergeConfig 读取集 ⊆ schema 键 ==');
const mergeList = /const k of \[([^\]]+)\][\s\S]{0,80}?raw\[k\] = live/.exec(hostOrCore)?.[1];
const mergeKeys = mergeList ? mergeList.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
ok('解析出 mergeConfig 键列表', mergeKeys.length > 0, '未匹配到 `for (const k of [...]) raw[k] = live(...)`');
for (const k of mergeKeys) {
  ok(`mergeConfig 读取 ${k} 时有 schema 定义`, schemaKeys.includes(k), `schema 缺 ${k}`);
}

/* ═══════════ 6b. 默认值**值级**对账 ═══════════ */
console.log('\n== 6b. 三处默认值值级对账（原对账只比键名）==');
/* D2（审查）实证缺口：报告 §5 只比**键名集合**，于是「面板显示 / 表单校验 / 运行时兜底」
 * 三处默认值各不相同也测不出来（本项目已因「默认值与已存值不同」返工过）。
 * 这里对每个面板字段做**值级**比对；布尔按字符串比，数值按数字比（含下划线分隔）。 */
const normDefault = (s) => {
  const t = String(s).trim().replace(/^['"]|['"]$/g, '').replace(/[_\s]/g, '');
  if (t === 'true' || t === 'false') return t;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
};
const fieldsDefs = new Map();
for (const line of (/const FIELDS = \[([\s\S]*?)\n\t\t\];/.exec(client)?.[1] ?? '').split('\n')) {
  if (!/key:\s*"/.test(line)) continue;
  const k = /key:\s*"([^"]+)"/.exec(line)?.[1];
  const d = /\bdef:\s*([^,}]+)/.exec(line)?.[1];
  if (k && d !== undefined) fieldsDefs.set(k, normDefault(d));
}
const schemaDefaults = new Map();
for (const m of schema.matchAll(/^\s{6}(\w+):\s*z\.\w+\(\)\.default\(([^)]+)\)/gm)) schemaDefaults.set(m[1], normDefault(m[2]));
const hostDefValues = new Map();
for (const m of (/const M3_DEFAULTS = \{([\s\S]*?)\n\};/.exec(host)?.[1] ?? '').matchAll(/^\s{2}(\w+):\s*([^,\n]+)/gm)) {
  hostDefValues.set(m[1], normDefault(m[2].split('//')[0]));
}
ok('解析出面板字段默认值（值级对账的前提）', fieldsDefs.size >= 6, `只解析到 ${fieldsDefs.size} 项 ⇒ 对账失效`);
const drift = [];
for (const [k, v] of fieldsDefs) {
  const s = schemaDefaults.get(k);
  const h = hostDefValues.get(k);
  if (s === undefined) drift.push(`${k}: schema 无 default`);
  else if (s !== v) drift.push(`${k}: FIELDS ${v} ≠ schema ${s}`);
  if (h !== undefined && h !== v) drift.push(`${k}: FIELDS ${v} ≠ host ${h}`);
}
ok('面板 / schema / host 三处**默认值**一致',
  drift.length === 0,
  `默认值漂移 ⇒ 面板显示、表单校验、运行时兜底各说一套：${drift.join('；')}`);

/* ═══════════ 6c. R7 退役零残留（防复活） ═══════════ */
console.log('\n== 6c. R7 退役通道零残留（marker / M5.5 / 死代码）==');
/* 退役的东西**留在代码里比删掉更危险**（一行就能重新接上）。这里同时钉两类：
 *  ① 退役通道标识符（marker / M5.5 恢复 / 被删的死代码）
 *  ② 它们的**配置文件字段**（面板/schema）
 * 全部在**剥注释后**的源码上判定——文件头会把旧机制当反例写出来，不剥会误判（踩过两次）。 */
const schemaNoComment = schema.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const wireNoComment = wire.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const RETIRED = [
  ['marker 触发通道', /markerArmed|M3\.marker\b|state\.m3\.markerHits|\bhudArmed\b|\bhudPending\b/],
  ['M5.5 恢复通道', /state\.m55|m55Attempt|pendingBySid|lastUserTextBySid|resumeViaAnyChannel|maybeResumeAfterMarker/],
  ['被删死代码', /probeService|decideCompaction|state\.m3\.probe\b/],
  /* ⚠️ `d.ratio`/`d.ok` 是**局部变量**名，只在 host 的两个压缩路径里成立；
   * client 的 `d.ok` 是 HUD debug 对象字段（同名的无关东西）⇒ 必须限定文件，否则误伤。 */
  ['随退役一起死的旧局部引用', /state\.m3\.wouldCompact|state\.m3\.lastDecision/, ['host', 'client']],
  ['被删局部变量（仅 host 两个压缩路径）', /\bd\.ratio\b|\bd\.ok\b/, ['host']],
];
for (const [label, re, only] of RETIRED) {
  const hit = [['host', hostNoComment], ['client', clientNoComment], ['schema', schemaNoComment], ['wire', wireNoComment]]
    .filter(([n]) => !only || only.includes(n))
    .filter(([, src]) => re.test(src)).map(([n]) => n);
  ok(`R7 退役零残留：${label}`, hit.length === 0, `仍在 ${hit.join(' / ')} 的**代码**里（注释不算）`);
}
ok('退役的配置字段未复活（marker / armedTtlMs / hudArmed / hudPending）',
  !fieldsKeys.includes('marker') && !fieldsKeys.includes('armedTtlMs')
  && !schemaKeys.includes('marker') && !schemaKeys.includes('armedTtlMs')
  && !hostDefaults.includes('marker') && !hostDefaults.includes('armedTtlMs')
  && !/\bhudArmed\b|\bhudPending\b/.test(schemaNoComment),
  '退役字段仍在面板/schema/M3 —— 「能改能存但无效果」的假开关');
ok('保留项未被误删：markerMinRatio（决策卡门槛）仍在三处且有消费者',
  fieldsKeys.includes('markerMinRatio') && schemaKeys.includes('markerMinRatio') && hostDefaults.includes('markerMinRatio')
  && /minRatio: M3\.markerMinRatio/.test(m2src),
  'markerMinRatio 是决策卡注入门槛，与已退役的 marker 无关，不得一起删');
/* C 类审查：无界 Set → 有界化（键是 session id，随会话数无界增长）。 */
ok('随会话增长的 Set 已做有界化（不再无上限）',
  /const remember = \(set, key\) => \{/.test(hostOrCore) && /const SET_CAP = \d+;/.test(hostOrCore)
  && /remember\(briefedBySid, sid\)/.test(m2src) && /remember\(effBriefedBySid, sid\)/.test(m2src)
  && /remember\(measuredFailedOnce, key\)/.test(m2src)
  && !/(briefedBySid|effBriefedBySid|measuredFailedOnce)\.add\(/.test(m2src),
  '仍有裸 .add() ⇒ 该集合无上限（长时间运行后随会话数增长）');

/* ═══════════ 6d. 意图表行为（compact-tool 真跑） ═══════════ */
console.log('\n== 6d. 压缩意图表：TTL 清扫与跨会话诊断（真跑模块）==');
/* C1/C2（审查）实证缺陷：意图表原来**只在查询当前 sid 时**顺带删自己那一项 ⇒
 * 别的会话的过期意图永不清理（TTL 形同虚设、Map 无界增长）。R7 加了全表清扫 + `pending()` 诊断出口。 */
const mkAgent = (sid) => ({ id: sid, sessionId: sid, session: { id: sid } });
/* 真 tryOf + 捕获注册的 tool spec（`runTool` 是工具内部实现，只能经 `execute` 触达）。 */
let ctSpec = null;
const ctMod2 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
const ctFix = ctMod2.createCompactTool({
  svc: (k) => (k === 'tools' ? { register: (t) => { ctSpec = t; } } : null),
  tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
  pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
  state: { m3: { compactToolDiag: {} } }, readCfg: () => ({ enabled: true }),
  getDefineTool: () => (spec) => spec,
});
const ctRun = async (sid, reason) => (await ctFix.ensure(), ctSpec.execute({ reason }, { agent: mkAgent(sid) }));
const rA = await ctRun('sid-A', 'A 会话请求');
ok('工具登记成功（行为）', rA && rA.ok === true && rA.scheduled === 'next-step', `实际 ${JSON.stringify(rA)}`);
ok('R16 工具结果带 tier 且在 output.schema 里已声明（R15.3 同类护栏）',
  rA.tier === 'standard' && Object.keys(ctSpec.output.schema.properties).includes('tier'),
  `实际 tier=${JSON.stringify(rA?.tier)}；未声明 ⇒ 宿主按 schema 拒掉整条调用（R15.3 同款事故）`);
ok('R16 工具入参 schema 声明 tier（可选，枚举内文案），且**不在 required**（R7 教训）',
  Object.keys(ctSpec.parameters).includes('tier') && !String(ctSpec.parameters.tier).includes('required'),
  `实际 parameters keys=${JSON.stringify(Object.keys(ctSpec.parameters))}`);
/* 会话级档位偏好：登记 → 持久 → 改选；非法值落 standard；未登记默认 standard。 */
{
  const t1 = ctFix.getTier('sid-T');
  ctSpec.execute({ tier: 'heavy', reason: '要多留近端' }, { agent: mkAgent('sid-T') });
  const t2 = ctFix.getTier('sid-T');
  ctSpec.execute({ tier: '不存在的档位' }, { agent: mkAgent('sid-T') });
  const t3 = ctFix.getTier('sid-T');
  const t4 = ctFix.getTier('sid-从没登记');
  ok('R16 档位是**会话级持久选择**（未选=standard → heavy → 非法值回落 standard）',
    t1 === 'standard' && t2 === 'heavy' && t3 === 'standard' && t4 === 'standard',
    `实际 ${JSON.stringify([t1, t2, t3, t4])}`);
  ok('R16 档位按会话隔离（sid-T 的选择不影响别的会话）',
    ctFix.getTier('sid-A') === 'standard',
    '档位串会话 ⇒ 在 A 选的 heavy 会改掉 B 的强制线行为');
}
ok('未消费的意图能被 pending() 列出（跨会话诊断出口存在）',
  Array.isArray(ctFix.pending()) && ctFix.pending().some((x) => x.sid === 'sid-A'),
  'pending() 缺失/为空 ⇒ 「sid 轮转导致压缩静默不发生」将无从诊断');
ok('别的 sid 查询不会误消费（多会话并存下的隔离）',
  ctFix.peekIntent('sid-B') === null && ctFix.peekIntent('sid-A') !== null,
  '按错键查询会命中/丢失意图 ⇒ 会在错误的会话上执行压缩');
ok('消费后即不可再见（takeIntent 语义）',
  ctFix.takeIntent('sid-A') !== null && ctFix.peekIntent('sid-A') === null && !ctFix.pending().some((x) => x.sid === 'sid-A'),
  '消费语义错 ⇒ 同一意图会被反复执行');
ok('意图表有全表 TTL 清扫（不再是「只查自己才清」）',
  /function sweepExpired\(/.test(ctNoComment) && /sweepExpired\(\);\n\s+const it = bySid\.get\(key\);/.test(ct),
  '缺全表清扫 ⇒ 别的会话的过期意图永久驻留（无界增长）');

/* ═══════════ 6e. 档位校验判据一致（D1 真缺陷） ═══════════ */
console.log('\n== 6e. 空可选集不得一刀否决（D1 真缺陷）==');
/* 实证缺陷：`efforts` 缺失时上游归一成 `[]`，而 `checkEffort` 原先用 `Array.isArray` 判定
 * ⇒ 空数组为真 ⇒ 所有档位都被否决，错误文案退化成「可选 」。 */
ok('checkEffort 把**空数组**当「取不到」而非「可选集为空」（不否决）',
  /const options = Array\.isArray\(eff\?\.efforts\) && eff\.efforts\.length > 0 \? eff\.efforts : null;/.test(effort),
  '空数组被当成有效可选集 ⇒ 一刀否决全部档位（真缺陷，已修）');
ok('checkEffort 与 renderBrief 用同一判据（length 而非 isArray）',
  /Array\.isArray\(eff\.efforts\) && eff\.efforts\.length \? eff\.efforts\.join\('\/'\) : null/.test(effort),
  '两处判据不一致 ⇒ 教学说有可选档、校验却全否决');

/* ═══ R11 解耦第三刀：M5 HUD 域 ═══ */
ok('R11 M5 HUD 域已抽为叶子模块，且宿主不再重复实现',
  /import\(`\.\/m5\.hud\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host)
  && /const buildHudResponse = async \(sid\) => \(m5Ctl \?/.test(host)
  && /onGetHud: async \(sid\) => buildHudResponse\(sid\),/.test(host)
  /* 查「M5 独有产物是否回流宿主」（函数名改名即可躲过，故查实现特征）。 */
  && !/state\.m5\.hudPollReq = \{/.test(hostNoComment)
  && !/hudActsPath/.test(hostNoComment)
  && !/const formatAct = \(reason, tokens, at\) => \{/.test(hostNoComment)
  && !/bfTries/.test(hostNoComment),
  '宿主仍带 M5 实现 ⇒ 两套真相（本次解耦要消除的）');
ok('M5 模块只允许 node: 内置 import（相对 import 会成环/破坏叶子约束）',
  !/^\s*import .*\bfrom ['"]\.\//m.test(m5src) && !/require\(/.test(m5src) && /from 'node:fs'/.test(m5src),
  'M5 模块 import 了相对路径 ⇒ 依赖图约束被打破（static.mjs 的叶子清单会失效）');
ok('M5 模块未就绪时不中断：三个发布口 no-op、getHud 返回明确错误',
  /const publishHud = \(patch\) => \{ if \(m5Ctl\) m5Ctl\.publishHud\(patch\); \};/.test(host)
  && /const formatAct = \(reason, tokens, at\) => \(m5Ctl \? m5Ctl\.formatAct\(reason, tokens, at\) : ''\);/.test(host)
  && /m5-module-pending/.test(host)
  && /M5 HUD 模块加载失败（吞/.test(host),
  '未做空值降级 ⇒ 激活期会 TypeError（apply 不是 async，不能 await）');
ok('M5 模块构造即装载历史（跨重启显示不因搬模块而丢）',
  /loadStoredActs\(\);\n\n  return \{ hudReasonLabel/.test(m5src) && /state\.m5\.acts = loaded\?\.acts \?\? \[\];/.test(m5src),
  '模块不再构造即装载 ⇒ 重启后弹窗空态（原「激活即恢复」承诺丢失）');

/* ═══ R12 解耦第四刀：M2 注入域 ═══ */
ok('R12 M2 注入域已抽为叶子模块，且宿主不再重复实现',
  /import\(`\.\/m2\.inject\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host)
  && /const injected = await m2Ctl\.buildInjection\(payload\);/.test(host)
  /* 查「M2 独有产物是否回流宿主」（改名躲不过）。 */
  && !/const renderUsageText = \(session\) =>/.test(hostNoComment)
  && !/Context usage before this turn/.test(hostNoComment)
  /* ⚠️ 不能查 `const clearBriefed = (sid) => {` —— 宿主**合法**保留一个薄转发
   * （`{ if (m2Ctl) m2Ctl.clearBriefed(sid); }`，M3 需要它）。真正的判据是
   * 「宿主持有的那两张『已讲』表没了」（下一行的 briefedBySid）。 */
  && !/const briefedBySid/.test(hostNoComment)
  && !/const measuredFailedOnce/.test(hostNoComment),
  '宿主仍带 M2 实现 ⇒ 两套真相（本次解耦要消除的）');
ok('M2 模块对宿主内部件零 import（本模块连 node: 都不需要）',
  !/^\s*import .*\bfrom ['"]\.\//m.test(m2src) && !/require\(/.test(m2src),
  'M2 模块 import 了相对路径 ⇒ 依赖图约束被打破');
ok('M2 模块未就绪时不注入（放行原决策 + 留痕）',
  /if \(!m2Ctl\) return decision;/.test(host) && /M2 注入模块加载失败（吞/.test(host),
  '未做空值降级 ⇒ 激活期会 TypeError（apply 不是 async，不能 await）');
ok('clearBriefed 是薄转发到 M2 域（不再由宿主持有「已讲」表）',
  /const clearBriefed = \(sid\) => \{ if \(m2Ctl\) m2Ctl\.clearBriefed\(sid\); \};/.test(host),
  '宿主自己实现 clearBriefed ⇒ 「已讲」表分裂成两份，压缩后可能只清一半');

/* ═══ R13 解耦第五刀：M1 快照域 ═══ */
ok('R13 M1 快照域已抽为叶子模块，且宿主不再重复实现',
  /import\(`\.\/m1\.snapshot\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(host)
  /* R14：宿主的三个转发已收敛为**一次 attachSnapshot**（快照来源后置注入 core）。 */
  && /m1Ready\.then\(\(api\) => \{/.test(host)
  && /attachSnapshot\(\{ buildSnapshot: \(r\) => api\.buildSnapshot\(r\)/.test(host)
  && /recordSessionEvent\(event, session\);/.test(host)
  /* 查「M1 独有产物是否回流宿主」。 */
  && !/const eventProbe = \{/.test(hostNoComment)
  && !/const SLIM_REASONS = new Set/.test(hostNoComment)
  && !/const canMeasure = /.test(hostNoComment)
  && !/const topSessions = /.test(hostNoComment),
  '宿主仍带快照产出实现 ⇒ 两套真相（本次解耦要消除的）');
ok('M1 模块未就绪时报告不断档（最小快照 + 留痕）',
  /M1 快照模块加载失败（吞，报告降级为最小快照）/.test(hostOrCore)
  /* R14：兜底快照（最小快照 + FULL 档位）住在 core —— 它是报告管线的防御性默认值。 */
  && /let buildSnapshot = \(reason\) => \(\{ at: new Date\(\)\.toISOString\(\), reason, profile: 'full'/.test(coreSrc)
  && /let isSlimReason = \(\) => false;/.test(coreSrc),
  '未做降级 ⇒ refresh 抛错被吞 ⇒ **报告永不落盘**（R13 真事故的形态：搬走 SLIM_REASONS 却漏改 refresh 的引用）');
ok('精简档判定口径只有一处（core 从 M1 域取口径，host 不再自查）',
  /isSlimReason = api\.isSlimReason;/.test(coreSrc) // 后置注入
  && /const isSlim = \(reason\) => SLIM_REASONS\.has\(reason\);/.test(m1src)
  && !/SLIM_REASONS/.test(hostNoComment),
  '宿主/核心自己判精简档 ⇒ 与模块的口径分裂（漏改一处即静默断报告）');
ok('M1 模块只读（不写盘：落盘管线仍在宿主）',
  !/writeFileSync|mkdirSync|readFileSync/.test(m1src) && !/^\s*import .*\bfrom ['"]\.\//m.test(m1src),
  'M1 域自己写盘 ⇒ 与宿主的尾部对账/缓存基线冲突（多写入者互相覆盖）');

/* ═══ R14 解耦第六刀：core（配置 / 状态 / 报告管线 / 工具函数）═══ */
const entry = read('entry.mjs');
ok('R14 core.mjs 存在且导出 createCore（D1 目标模块清单最后一块）',
  /export function createCore\(\{ ctx, config, pluginDir, reportPath \}\) \{/.test(coreSrc),
  'core.mjs 缺 createCore ⇒ D1 的 core 目标未达成');
ok('R14 entry **预加载** core 并传给 apply（同步可用 + 与 impl 同批热换）',
  /const coreUrl = `\.\/core\.mjs\?ts=\$\{mtime\}-\$\{seq\}`;/.test(entry)
  && /Promise\.all\(\[import\(coreUrl\), import\(url\)\]\)/.test(entry)
  && /core: coreMod\.createCore\(\{ ctx, config, pluginDir: PLUGIN_DIR, reportPath \}\)/.test(entry),
  'entry 未预加载 core ⇒ 宿主拿不到它；改回动态 import 又无法满足「apply 期同步可用」');
/* R15.2（2026-10-08 真机事故）：entry 必须传 `createCore(...)` 的**返回值**，不能传模块命名空间。
 * 传命名空间时宿主解构出的 loadDefineTool/state/log … 全是 undefined ⇒ apply 当场抛 TypeError ⇒
 * **插件整天不激活**（无监听器/无面/无报告），而 UI 只显示一句「处理失败」。
 * 当时 boot 19/19 全绿，因为它**绕过了 entry**（现已补 entry 级冒烟，见 test/boot.mjs ⑦）。 */
ok('R15.2 entry 传的是 **createCore 的返回值**（不是 core 的模块命名空间）',
  /core: coreMod\.createCore\(/.test(entry) && !/core: coreMod\s*[,}]/.test(entry),
  '传命名空间 ⇒ 宿主解构全 undefined ⇒ 激活当场失败（真机事故原形）');
ok('R14 host.apply 接受 core；未注入时**降级不崩**（entry 未重启的形态）',
  /export function apply\(ctx, config, \{ pluginDir, reportPath, core \} = \{\}\) \{/.test(host)
  && /if \(!core\) \{/.test(host)
  && /degraded: 'core-missing-need-restart'/.test(host),
  '未做降级 ⇒ 尚未重启时旧 entry 不传 core ⇒ 插件整块炸掉（entry 是「改它必须重启」的薄壳）');
/* ⚠️ 这条是**用血换来的**：R14 实测两类同级缺陷都源于「名字对不上」——
 *   ① `COMPACT_TIMEOUT_MS` 的定义在 R12 搬迁中被静默丢掉（切块比预期宽），M3 域整整两版加载失败；
 *   ② `loadReportBase` 忘了从 core 解构 ⇒ 调用即 ReferenceError，被 M5 的回填 try/catch 吞掉。
 *  两者都是「跑起来才发现」，`node --check` 看不见。静态对账能在提交前拦住。 */
const coreExports = (() => {
  const i = coreSrc.lastIndexOf('  return {');
  const j = i >= 0 ? coreSrc.indexOf('\n  };', i) : -1;
  if (i < 0 || j < 0) return new Set();
  return new Set([...coreSrc.slice(i, j).matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?=,|:|\n|\})/g)].map((m) => m[1]));
})();
const hostDestructured = (() => {
  const m = /const \{([\s\S]*?)\} = core;/.exec(host);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?=,|:)/g)].map((x) => x[1]));
})();
ok('R14 宿主从 core 解构的每个名字都在 core 的出口里（防「解构了但没导出」⇒ undefined 静默）',
  hostDestructured.size >= 20 && coreExports.size >= 20 && [...hostDestructured].every((n) => coreExports.has(n)),
  `core 未导出却被解构：${[...hostDestructured].filter((n) => !coreExports.has(n)).join(', ') || '（无）'}；解构 ${hostDestructured.size} 个 / 出口 ${coreExports.size} 个`);

/* ═══════════ 6f. 压缩两条路径的**顺序**契约（F1/F5 真缺陷） ═══════════ */
console.log('\n== 6f. pre-step / idle 顺序契约 ==');
const idleBody = /const idleSweep = \(agent\) => \{([\s\S]*?)\n  \};/.exec(m3src)?.[1] ?? '';
ok('解析出 idleSweep', idleBody.length > 0, '未找到 idleSweep ⇒ 顺序契约失效');
/* F5：意图只能在**确认能执行**之后消费。原实现先 takeIntent 再 resolveCompactionFor，
 * 服务解析不到就直接 return ⇒ 意图已丢、工具却回了 scheduled ⇒ 模型以为压过了、实际没压且不重试。 */
ok('F5 意图在「确认能执行」之后才消费（不是先消费再判断）',
  ctPreStep.indexOf('const compaction = resolveCompactionFor(agent);') < ctPreStep.indexOf('takeIntent(sid)')
  && ctPreStep.indexOf('takeIntent(sid)') > -1,
  '先 takeIntent 再解析服务 ⇒ 服务不可用时意图静默丢失且无重试');
/* F1：冷却只在**成功分支**记。原实现在发车前就写 `sweeps[sid]`，一次失败即消耗 10 分钟安全网。 */
ok('F1 idle 冷却只在成功分支记录（失败不消耗 10 分钟窗口）',
  idleBody.indexOf('.then((result) => {') < idleBody.indexOf('state.m3.sweeps[sid] = Date.now();')
  && !/^[\s\S]*?state\.m3\.sweeps\[sid\] = now;/.test(idleBody),
  '冷却在发车前记录 ⇒ compactNow 失败也会压掉该会话的安全网窗口');
/* F2：`sweepInFlight.add` 必须紧贴 promise 链（add 与 .finally 之间任何同步抛错 = 永久锁）。 */
ok('F2 可能在 add 与 .finally 之间抛错的语句已前移',
  idleBody.indexOf('sweepInFlight.add(sid);') < idleBody.indexOf('.compactNow(')
  && idleBody.indexOf('log(\'info\', `M3 idle 扫除') < idleBody.indexOf('sweepInFlight.add(sid);'),
  'add 之后仍有可抛语句 ⇒ 同步异常会让该会话永久失去 idle 安全网（无日志）');

/* ═══════════ 6.20 R15：工具后自检回执 + 思考强度「时刻可切」 ═══════════
 * 用户要求（2026-10-08）：
 *   ① 「调用工具执行压缩/切换思考强度时，工具完成后进行检查…起码 agent 自己过一遍」
 *      —— 起因：真机上一次 compact_context 回了 ok/scheduled，但压缩一次都没发生（消费者模块缺失），
 *         而模型毫无察觉，连「当前档位/用量行」也一起消失了。
 *   ② 「每次发起任务…都时刻可以进行思考强度切换；长任务有必要可以增加次数，以实际需求为准」。 */
console.log('\n== 6.20 工具后自检回执 + 思考强度可切性 ==');
/* R16 前置：compact-range 的档位常量与解析（纯函数，直接行为级验证）。 */
console.log('\n== 6.20a R16 压缩档位（compact-range.mjs） ==');
{
  const crMod = await import(pathToFileURL(join(PLUGIN, 'compact-range.mjs')).href);
  ok('档位常量：light=8% / standard=16%（=RETAIN_RATIO）/ heavy=24%',
    crMod.TIERS.light === 0.08 && crMod.TIERS.standard === crMod.RETAIN_RATIO && crMod.TIERS.heavy === 0.24,
    `实际 ${JSON.stringify(crMod.TIERS)}`);
  const W = 1_000_000;
  const tL = crMod.resolveTier('light', W);
  const tS = crMod.resolveTier('standard', W);
  const tH = crMod.resolveTier('heavy', W);
  ok('三档预算按窗口折算（1M：80k / 160k / 240k，不夹取）',
    tL.budget === 80_000 && tS.budget === 160_000 && tH.budget === 240_000
      && !tL.clamped && !tS.clamped && !tH.clamped && !tL.fallback && !tS.fallback && !tH.fallback,
    `实际 ${JSON.stringify([tL, tS, tH].map((x) => x.budget))}`);
  /* 小窗口夹取：128k 窗口的 light 只有 10k ⇒ 抬到下限 40k；standard 20k 也抬到 40k。 */
  const small = 128_000;
  const cL = crMod.resolveTier('light', small);
  const cS = crMod.resolveTier('standard', small);
  ok('小窗口下夹取到下限 40k（light/standard 都抬）',
    cL.budget === 40_000 && cL.clamped === true && cS.budget === 40_000 && cS.clamped === true,
    `实际 light=${cL.budget} standard=${cS.budget}`);
  const bad = crMod.resolveTier('不存在的档位', W);
  const none = crMod.resolveTier(undefined, W);
  ok('未知档位/未选都落 standard（用户要求「未选 16% 兜底」）',
    bad.tier === 'standard' && bad.budget === 160_000 && bad.fallback === true
      && none.tier === 'standard' && none.fallback === false && none.budget === 160_000,
    `实际 bad=${JSON.stringify(bad)} none=${JSON.stringify(none)}`);
}
/* R16.3（用户问出的场景）：「趁占用还在强制线之下时选定档位」——三处出口都要教这个时机。 */
{
  const brief = ctApi.renderBrief({ criticalRatio: 0.75 }) ?? '';
  const cardBelow = ctApi.renderCard({ ratio: 0.5, minRatio: 0.2, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
  const cardAbove = ctApi.renderCard({ ratio: 0.8, minRatio: 0.2, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
  ok('一次性教学教了介入时机（趁还在强制线之下选档；越线后改档管不上当次）',
    /趁占用还在 \d+% 强制线之下时(选定档位|声明档位)/.test(brief) && /越线之后才改档，管不上正在发生的那次/.test(brief),
    `实际：${brief.slice(0, 100)}…`);
  ok('决策卡教了介入时机，且**随占用状态自适应**',
    /尚在强制线之下/.test(cardBelow) && !/本次已越线/.test(cardBelow)
      && /已越强制线/.test(cardAbove)
      /* R16.15（评审建议 5）：越线后不再只给「改档下一轮起生效」这句**无法行动**的信息，
       * 改为可执行的补救动作（立刻 set-tier 声明档位）。 */
      && /立刻用 `action:'set-tier'` 声明档位/.test(cardAbove),
    `未越线卡：${cardBelow.slice(0, 80)}… | 已越线卡：${cardAbove.slice(0, 80)}…`);
}
console.log('\n== 6.20 工具后自检回执 + 思考强度可切性 ==');
const m2Mod = await import(pathToFileURL(join(PLUGIN, 'm2.inject.mjs')).href);
const mkM2 = (state, measure, takeVerify) => m2Mod.createM2Injection({
  state, log: () => {}, msg: (e) => String(e?.message ?? e), pick: (...a) => a.find((x) => x != null),
  schedule: () => {}, svc: () => null,
  tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
  nfmt: (n) => String(n), summarizeBreakdown: () => null, remember: () => {},
  M3: { criticalRatio: 0.85, markerMinRatio: 0.3, effortEnabled: false },
  effEnabled: () => true, criticalCapOf: () => 0.8,
  measureRatio: measure ?? (() => ({ ok: true, used: 500000, surface: 300000, window: 1000000, ratio: 0.5, measure: {} })),
  /* R16.1：回执消费注入（生产环境是宿主的箭头包装 → m3Ctl.takeCompactVerify）。 */
  takeCompactVerify: takeVerify ?? (() => null),
  getRangeApi: () => ({ RETAIN_RATIO: 0.16 }), getCompactToolApi: () => null, getEffortApi: () => null,
  getCreateUserMessage: () => () => ({ fake: 'user-message' }), SOURCE_KIND: 'context-pilot',
});
const agent = { session: { id: 'selfcheck-1' }, id: 'selfcheck-1' };
/* R16.1：回执按 sid 存（M3 域 verifyBySid）⇒ 测试桩直接提供 takeCompactVerify(sid)。
 * 语义必须与 M3 一致：返回**同一对象**（按引用），消费时在它上面置 read（可变共享状态）。
 * 桩把 box 挂在返回的函数上（`.box`）供断言检查。 */
const stubVerify = (v) => {
  const fn = (sid) => {
    if (!fn.box || sid !== 'selfcheck-1') return null;
    if (fn.box.read) return null;
    fn.box.read = true;
    return fn.box;
  };
  fn.box = v ? { ...v, read: false } : null;
  return fn;
};

for (const [st, must] of [
  ['executed', /【压缩自检】.*已执行.*省 ~64\.6K token/],
  ['no-need', /【压缩自检】.*已执行但判定无需压缩/],
  ['not-executed', /【压缩自检】[\s\S]*未执行[\s\S]*再调用一次[\s\S]*compact_context/],
]) {
  const v = { at: new Date().toISOString(), sessionId: 'selfcheck-1', state: st, shadowedTokens: 64640, retainBudget: 160000, tier: 'standard', rangeSource: 'own', ms: 2400, skipWhy: 'nothing-to-compact', why: 'no-compaction-service' };
  const state = { m2: { skips: {}, injections: 0 }, m3: {} };
  const take = stubVerify(v);
  const api = mkM2(state, undefined, take);
  const out = await api.buildInjection({ agent, step: 1, turn: 1 });
  ok(`自检回执按状态注入（${st}）`, must.test(out?.text ?? ''), `实际：${String(out?.text ?? '').slice(0, 120)}`);
  /* R16.1：读到即置 read（一次性语义落在 M3 域的 verifyBySid 上）。 */
  ok(`自检回执是一次性的（${st} 不重复刷屏）`, take.box.read === true, '消费后未置 read ⇒ 回执每轮重复刷屏');
}
{
  /* 最坏情况：量测失败（= M3 域挂掉，正是真机踩过的形态）——仍然要把「未执行」送到模型眼前。 */
  const v = { at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'not-executed', why: 'm3-module-missing' };
  const state = { m2: { skips: {}, injections: 0 }, m3: {} };
  const api = mkM2(state, () => ({ ok: false, error: 'm3-module-pending' }), stubVerify(v));
  const out = await api.buildInjection({ agent, step: 1, turn: 1 });
  ok('量测失败时**只注入自检回执**（压缩没执行这件事不得静默）',
    out?.receiptOnly === true && /【压缩自检】.*未执行.*压缩域模块未加载/.test(out?.text ?? ''),
    `实际：${JSON.stringify(out)?.slice(0, 160)}`);
  ok('该路径不计入 skips.measureFail（它不是「跳过」，而是「换了内容注入」）',
    state.m2.skips.measureFail === undefined, `实际 ${JSON.stringify(state.m2.skips)}`);
}
/* R15.4：待读回执**不等到下一轮**——非首步也要注入（回路当轮闭合）。 */
{
  const v = { at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', shadowedTokens: 1000, retainBudget: 80000, tier: 'light', rangeSource: 'own', ms: 10 };
  const mid = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v)).buildInjection({ agent, step: 3, turn: 2 });
  ok('非首步也能注入待读的压缩自检回执（R15.4：回执不等到下一轮才可见）',
    mid?.midStep === true && /【压缩自检】.*已执行/.test(mid?.text ?? ''),
    `实际：${JSON.stringify(mid)?.slice(0, 140)}`);
  const none = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, () => null).buildInjection({ agent, step: 3, turn: 2 });
  ok('非首步且无回执时仍然跳过（「每轮只注一次」不被破坏）',
    none?.skip === 'not-step-1', `实际：${JSON.stringify(none)}`);
}
/* R16.1：回执按 sid 隔离——A 的回执不会被 B 读走，B 也读不到 A 的。 */
{
  const vA = { at: new Date().toISOString(), sessionId: 'sid-A', state: 'executed', shadowedTokens: 5000, rangeSource: 'own', ms: 10 };
  const vB = { at: new Date().toISOString(), sessionId: 'sid-B', state: 'executed', shadowedTokens: 9000, rangeSource: 'own', ms: 20 };
  const bySidV = { 'sid-A': { ...vA, read: false }, 'sid-B': { ...vB, read: false } };
  const take = (sid) => bySidV[sid] ?? null;
  const api = mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, take);
  const outA = await api.buildInjection({ agent: { session: { id: 'sid-A' }, id: 'sid-A' }, step: 1, turn: 1 });
  const outB = await api.buildInjection({ agent: { session: { id: 'sid-B' }, id: 'sid-B' }, step: 1, turn: 1 });
  ok('R16.1 多会话并发压缩：各自的回执各自可见（A 省 5K / B 省 9K，互不覆盖）',
    /省 ~5\.0K/.test(outA?.text ?? '') && /省 ~9\.0K/.test(outB?.text ?? ''),
    `A：${String(outA?.text ?? '').slice(0, 90)} | B：${String(outB?.text ?? '').slice(0, 90)}`);
}

/* 思考强度：可选项必须**每轮可见**（原先只在会话最早的一次性教学里） */
const suffixWithOpts = effApi.renderSuffix({ ok: true, current: 'high', efforts: ['off', 'low', 'high', 'max'] }) ?? '';
ok('每轮后缀列出**可选档位**（不只当前档 ⇒ 时刻可切）',
  /思考强度 high/.test(suffixWithOpts) && /可选 off\/low\/high\/max/.test(suffixWithOpts) && /set_reasoning_effort/.test(suffixWithOpts),
  `实际：${JSON.stringify(suffixWithOpts)}`);
ok('取不到可选集时不编造（保持纯档位后缀）',
  (effApi.renderSuffix({ ok: true, current: 'high', efforts: null }) ?? '') === '思考强度 high',
  '凭空写可选集 ⇒ 教错档位');
const effBriefNow = effApi.renderBrief({ ok: true, current: 'high', efforts: ['off', 'low', 'high', 'max'] }) ?? '';
ok('思考强度教学改为「按需可多次」（删掉「1-2 次为宜」的抑制性措辞）',
  !/1-2 次/.test(effBriefNow) && /阶段变化/.test(effBriefNow) && /可以切多次/.test(effBriefNow) && /冷却/.test(effBriefNow),
  '仍未按用户目标（长任务按实际需求可多次）改写教学');
ok('M3 域在每条路径都产出执行回执（executed / no-need / not-executed）',
  /setCompactVerify\(sid, \{[\s\S]{0,300}state: result != null \? 'executed' : 'no-need'/.test(m3src)
  && /state: 'not-executed',\n\s+why: 'no-compaction-service'/.test(m3src)
  && /setCompactVerify\(sid, \{ at: new Date\(\)\.toISOString\(\), sessionId: sid, state: 'not-executed', why: code/.test(m3src),
  '缺任一条路径的回执 ⇒ 那种情形下模型看不到「未执行」（正是真机静默失效的形态）');
ok('R16.1 回执按 sid 存取（并发压缩互不覆盖）+ 全局镜像保留',
  /const setCompactVerify = \(sid, v\) =>/.test(m3src)
  && /state\.m3\.verifyBySid = state\.m3\.verifyBySid \?\? \{\};/.test(m3src)
  && /state\.m3\.lastCompactVerify = v;/.test(m3src)
  && /const takeCompactVerify = \(sid\) =>/.test(m3src)
  && /v\.read = true;/.test(m3src),
  '全局单槽会被后完成的会话覆盖 ⇒ 另一会话的 Agent 看不到自己的回执（R16.1 修的正是这个）');
/* R16.1 行为级：真跑 M3 域的 setCompactVerify/takeCompactVerify，验证「按 sid 隔离 + 有界化」。 */
{
  const m3Mod = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const st = { m3: {} };
  const m3 = m3Mod.createM3Compaction({
    state: st, log: () => {}, msg: (e) => String(e?.message ?? e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? e?.message ?? 'err'), schedule: () => {},
    svc: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.8,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: () => {}, formatAct: () => 'x', clearBriefed: () => {},
    awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 180000, SET_CAP: 200,
  });
  m3.setCompactVerify?.('A', { state: 'executed', shadowedTokens: 111, at: 't1' });
  m3.setCompactVerify?.('B', { state: 'executed', shadowedTokens: 222, at: 't2' });
  const a1 = m3.takeCompactVerify?.('A');
  const b1 = m3.takeCompactVerify?.('B');
  ok('R16.1 行为级：两会话各自的回执各自可见（A 111 / B 222，互不覆盖）',
    a1?.shadowedTokens === 111 && b1?.shadowedTokens === 222,
    `实际 A=${JSON.stringify(a1)} B=${JSON.stringify(b1)}`);
  const a2 = m3.takeCompactVerify?.('A');
  ok('R16.1 行为级：读到即置 read（A 第二次取为 null）', a1 && a2 === null, `实际 ${JSON.stringify(a2)}`);
  ok('R16.1 行为级：全局镜像 lastCompactVerify 保留（HUD/报告口径不变）',
    st.m3.lastCompactVerify?.shadowedTokens === 222, `实际 ${JSON.stringify(st.m3.lastCompactVerify)}`);
}
ok('宿主为「消费者模块缺失」补回执（仅当确有意图时，避免健康路径噪声）',
  /if \(compactToolApi\?\.peekIntent\?\.\(sid\)\)/.test(host)
  && /why: 'm3-module-missing'/.test(host),
  '消费者模块缺失时不留痕 ⇒ 又回到「工具回 ok 但没人说没执行」的真机形态');
ok('思考强度工具结果带回读与自检指引（applied + verify）',  /applied: 'next-request',/.test(effort) && /applied: 'already',/.test(effort)
  && /下一步的用量行后缀会显示当前实际档位/.test(effort),
  '工具只回 {ok,effort} ⇒ 模型无法自检是否真的生效（与压缩那个盲区同源）');

/* R15.1（用户实测反馈：切到 Max 后 chip 没进冷却）——**行为级**复现 + 回归：
 * 时序是「工具接受 → 下一次请求才 apply → 客户端投影才变 → chip 才 getHud」，
 * 而那次 getHud 恰好夹在中间 ⇒ 必须**在 apply 之前**就能看到冷却。 */
{
  let effSpec = null;
  const effMod2 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const api2 = effMod2.createEffort({
    svc: (k) => (k === 'tools' ? { register: (t) => { effSpec = t; } } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (spec) => spec,
  });
  const ag = { id: 'cd-probe', sessionId: 'cd-probe', session: { id: 'cd-probe', requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }) } };
  await api2.ensure();
  const before = await api2.hudPayload(ag, 'cd-probe');
  const res = await effSpec.execute({ effort: 'max' }, { agent: ag });
  const after = await api2.hudPayload(ag, 'cd-probe');
  ok('换档工具接受后**立刻**（尚未 apply）就能在 hudPayload 里看到冷却',
    res?.ok === true && after?.cooldownUntil > Date.now() && after.cooldownUntil - Date.now() <= 30000,
    `实际 res=${JSON.stringify(res)} cooldownUntil=${JSON.stringify(after?.cooldownUntil)}（before=${JSON.stringify(before?.cooldownUntil)}）`
    + ' —— 锚点若在 apply 时刻，客户端那一次 getHud 就永远赶在起算之前（真机 chip 一直显示「就绪」）');
  ok('未换档时 hudPayload 不报冷却（不能常亮）', (before?.cooldownUntil ?? 0) === 0, `实际 ${JSON.stringify(before?.cooldownUntil)}`);
}

/* ═══════════ 6.21 R15.3：工具返回字段必须已在 output.schema 里声明 ═══════════
 * 真机事故（2026-10-08）：宿主**按 `output.schema` 校验工具返回值**，而两个工具都声明了
 * `additionalProperties: false` ⇒ R15 给返回值加的 `applied` / `verify` 没同步声明，
 * 于是**整条工具调用失败**：
 *   Error: tool "set_reasoning_effort" returned invalid output: "value.applied" is not a declared property
 *   Error: tool "compact_context" returned invalid output: "value.verify" is not a declared property
 * ⇒ 这里做**行为级**对账：真的跑工具各条分支，把返回的 key 与该 spec 声明的 properties 求差集。 */
console.log('\n== 6.21 工具返回值 ⊆ output.schema 声明 ==');
const declaredKeys = (spec) => new Set(Object.keys(spec?.output?.schema?.properties ?? {}));
const undeclared = (spec, value) => [...Object.keys(value ?? {})].filter((k) => !declaredKeys(spec).has(k));

/* 压缩工具：登记成功 + 失败两条分支 */
console.log('  压缩工具 declared =', [...declaredKeys(ctSpec)].join(','));
const ctOkRes = await ctRun('sid-SCHEMA', 'schema 对账');
const ctBad = await ctSpec.execute({}, { agent: { id: 'no-sid', sessionId: '', session: {} } });
ok('compact_context 返回值 ⊆ output.schema（成功分支）', undeclared(ctSpec, ctOkRes).length === 0,
  `未声明字段：${undeclared(ctSpec, ctOkRes).join(', ')} ⇒ 宿主的返回值校验会拒掉整条调用（真机事故）`);
ok('compact_context 返回值 ⊆ output.schema（失败分支）',
  undeclared(ctSpec, ctBad).length === 0 || ctBad?.ok !== false,
  `未声明字段：${undeclared(ctSpec, ctBad).join(', ')}（返回值 ${JSON.stringify(ctBad)}）`);

/* 换档工具：接受 / 幂等 / 非法档位 / 冷却 四条分支 */
{
  let eSpec = null;
  const eMod = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const eApi = eMod.createEffort({
    svc: (k) => (k === 'tools' ? { register: (t) => { eSpec = t; } } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (spec) => spec,
  });
  await eApi.ensure();
  const ag2 = { id: 'sch-1', sessionId: 'sch-1', session: { id: 'sch-1', requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }) } };
  console.log('  换档工具 declared =', [...declaredKeys(eSpec)].join(','));
  const rAccept = await eSpec.execute({ effort: 'max' }, { agent: ag2 });
  ok('set_reasoning_effort 返回值 ⊆ output.schema（接受分支：applied/verify 必须已声明）',
    undeclared(eSpec, rAccept).length === 0,
    `未声明字段：${undeclared(eSpec, rAccept).join(', ')} ⇒ 真机上整条换档调用失败（2026-10-08 实测）`);
  const rSame = await eSpec.execute({ effort: 'max' }, { agent: ag2 });
  ok('set_reasoning_effort 返回值 ⊆ output.schema（幂等分支）', undeclared(eSpec, rSame).length === 0,
    `未声明字段：${undeclared(eSpec, rSame).join(', ')}`);
  const rBad = await eSpec.execute({ effort: '不存在的档位' }, { agent: ag2 });
  ok('set_reasoning_effort 返回值 ⊆ output.schema（非法档位分支）',
    undeclared(eSpec, rBad).length === 0 && rBad?.ok === false,
    `未声明字段：${undeclared(eSpec, rBad).join(', ')}（返回值 ${JSON.stringify(rBad)}）`);
  /* ⚠️ 单独钉「错误信息非空」：内部字段名与声明字段名不一致时，工具会返回 `error: undefined`——
   * 上面那条断言照样通过（键存在且已声明），错误信息却静默丢了（R15.3 变异脚本抓到的逃逸）。 */
  ok('非法档位的错误信息**非空**（内部 reason→声明 error 的映射没断）',
    typeof rBad?.error === 'string' && rBad.error.length > 0,
    `实际 error=${JSON.stringify(rBad?.error)} —— 内部字段改名会让这里变成 undefined`);
  const rCd = await eSpec.execute({ effort: 'low' }, { agent: ag2 });
  ok('set_reasoning_effort 返回值 ⊆ output.schema（冷却分支）', undeclared(eSpec, rCd).length === 0,
    `未声明字段：${undeclared(eSpec, rCd).join(', ')}（返回值 ${JSON.stringify(rCd)}）`);
}

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'='.repeat(52)}`);
console.log(`契约对账：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);
