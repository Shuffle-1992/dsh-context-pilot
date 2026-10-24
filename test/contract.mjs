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
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
/* R19（2026-10-15 用户要求「改成『深压8%/标准16%/浅压24%』的说法」）：
 * 档位展示的唯一真相是 compact-range.mjs 的标签/百分比助手 ⇒ **测试桩必须注入真实模块**。
 * 若继续注入 `{TIER_NAMES}` 最小桩，展示面会走兜底路径（退化成英文 id + 百分比的拼接），
 * 断言测到的就是兜底而不是生产口径——那属于「测试通过但生产不一致」的虚假信心。 */
const rangeMod19 = await import(pathToFileURL(join(PLUGIN, 'compact-range.mjs')).href);
const rangeStub = () => rangeMod19;

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
ok('阈值行已删除「上限」（用户要求）', !/上限/.test(thrText),
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
  ok('R16.7b 行为级：重启后 hudPayload 恢复计数与最近切换（slot 合并落盘；R23 起显示名为「中文(id)」）',
    payload?.switchCount === 1 && payload?.lastSwitch?.to === '最高(max)' && payload?.currentLabel === '高(high)'
  /* R69（用户要求加日期）：at 必须是 YYYY-MM-DD HH:MM:SS 的完整日期时间 */
  && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(payload?.lastSwitch?.at ?? ''),
    `实际 switchCount=${JSON.stringify(payload?.switchCount)} lastSwitch=${JSON.stringify(payload?.lastSwitch)} currentLabel=${JSON.stringify(payload?.currentLabel)}`);
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
  ok('R16.10 行为级：问 B 会话说必须回 B 的统计（不借第一个 agent；R23 起档位显示名「中文(id)」）',
    hudB?.effort?.switchCount === 2 && hudB?.effort?.lastSwitch?.to === '低(low)',
    `实际 switchCount=${JSON.stringify(hudB?.effort?.switchCount)} lastSwitch=${JSON.stringify(hudB?.effort?.lastSwitch)}（应为 2 / to=低(low)）`);
  const hudA = await m5Api10.buildHudResponse('sess-A');
  ok('R16.10 行为级：问 A 会话说回 A 的统计（两会话互不串）',
    hudA?.effort?.switchCount === 1 && hudA?.effort?.lastSwitch?.to === '高(high)',
    `实际 switchCount=${JSON.stringify(hudA?.effort?.switchCount)} lastSwitch=${JSON.stringify(hudA?.effort?.lastSwitch)}（应为 1 / to=高(high)）`);
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
  ok('R16.13 行为级：跳过「**本会话**自己的压缩在飞」窗口（pre-step 的 compactRegion 无标记）',
    (() => {
      const before = acts.length;
      st13.m3.ownCompact = { 'sess-13': { at: 'now', sessionId: 'sess-13', until: Date.now() + 5000 } };
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c5' } }, sess13);
      st13.m3.ownCompact = null;
      return t === null && acts.length === before;
    })(),
    '无标记的自家压缩被当引擎压缩补记 ⇒ 重复记录');
  /* R53（自审发现 #3）：在飞标记必须**按会话**——A 会话在压时，B 会话的引擎压缩不能被吞掉。
   * 旧实现是全局单槽 ⇒ 这条**一定红**（B 被漏记）。 */
  ok('R53 行为级：**别的会话**在飞 ⇒ 本会话的引擎压缩照常补记（全局单槽会吞掉它）',
    (() => {
      const before = acts.length;
      st13.m3.ownCompact = { 'sess-other': { at: 'now', sessionId: 'sess-other', until: Date.now() + 5000 } };
      const t = m3x.noteEngineCompaction?.({ type: 'compaction/end', data: { compactionId: 'c5b' } }, sess13);
      st13.m3.ownCompact = null;
      return typeof t === 'string' && acts.length === before + 1;
    })(),
    '全局单槽 ⇒ 别的会话在飞期间本会话的引擎压缩被静默吞掉（漏记）');
  ok('R53 行为级：在飞判定按会话隔离（`isCompactionInFlight(sid)`）',
    (() => {
      st13.m3.ownCompact = { 'sess-a': { until: Date.now() + 5000 }, 'sess-b': { until: Date.now() + 5000 } };
      const iso = m3x.isCompactionInFlight('sess-a') === true
        && m3x.isCompactionInFlight('sess-b') === true
        && m3x.isCompactionInFlight('sess-c') === false
        && m3x.isCompactionInFlight() === true;      // 不传 sid ⇒ 任一在飞（旧调用点语义不变）
      st13.m3.ownCompact = null;
      return iso && m3x.isCompactionInFlight() === false;
    })(),
    '在飞判定不按会话隔离 ⇒ 多会话互相干扰（漏记/重复记录）');
  ok('R16.13 计数与取证留痕（engineCompacts / lastEngineCompact）',
    /* R53：新增的「别的会话在飞」用例也补记了一条 ⇒ 计数 3→4；最后一条是成功补记（c5b）⇒ ok === true。 */
    st13.m3.engineCompacts === 4 && typeof st13.m3.lastEngineCompact === 'object' && st13.m3.lastEngineCompact.ok === true,
    `实际：compacts=${st13.m3.engineCompacts} last=${JSON.stringify(st13.m3.lastEngineCompact)}`);
}
/* ⚠️ m3src 在本文件稍后（L677）才声明 ⇒ 这里就地取一份，避免 TDZ。 */
const m3src13 = read('m3.compact.mjs');
ok('R16.13 接线：host 把 compaction/end 转发给 m3；m3 三处自己的压缩都打「在飞标记」并导出',
  /if \(event\?\.type === 'compaction\/end'\) m3Ctl\?\.noteEngineCompaction\?\.\(event, session\);/.test(host)
    && /noteEngineCompaction/.test(m3src13)
    && /if \(src === 'context-pilot'\) return null;/.test(m3src13)
    && /if \(isCompactionInFlight\(sidE\)\) return null;/.test(m3src13)
    && (m3src13.match(/markOwnCompaction\(sid\)/g) ?? []).length >= 3
    && (m3src13.match(/clearOwnCompaction\(sid\)/g) ?? []).length >= 4
    && /isCompactionInFlight, noteEngineCompaction, noteRetainFactor, retainFactorOf, noteCompactSettle, settleDropOf, settleDropAny, noteSessionEvent, compactionLockActive, currentRouteOf \}/.test(m3src13),
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
    getRangeApi: rangeStub,
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
      && rSet?.tier === '浅压24%' && api14.peekIntent('sess-14') === null
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
    /每轮 \+50k token/.test(cardTrend14) && /约 \*\*5 轮\*\*触/.test(cardTrend14) && /粗估/.test(cardTrend14),
    '仍要求模型自己预测未来占用 ⇒ 该条件「从未成立」（评审实测）');

      /* R70 行为级（用户实测「这个趋势计算好像不太准确」）：均值样本数要标出来；
       * 刚压缩过必须**明确不给外推**（否则拿压缩前的巨量增量算轮数，会把模型带偏）。 */
      const cardSamp70 = api14.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, deltaTokens: 50000, deltaSamples: 3, turnsToLine: 5 }) ?? '';
      ok('R70 行为级：卡片标出样本轮数（近 3 轮均值粗估）',
        /近 3 轮均值粗估/.test(cardSamp70),
        '不标样本数 ⇒ 用户不知道这个外推基于几轮（单轮 vs 4 轮均值可信度差很多）');
      const cardReset70 = api14.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, resetByCompaction: true }) ?? '';
      ok('R70 行为级：刚压缩时**不给外推**，明说基线已重置',
        /刚刚压缩过/.test(cardReset70) && !/触 75% 强制线/.test(cardReset70),
        '压缩后仍给轮数外推 ⇒ 用的是压缩前的巨量增量，会误导模型现在压');
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
    && /trendHistory\.set\(sid, rec\)/.test(m2src) && /TREND_SAMPLES/.test(m2src)
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
    getRangeApi: rangeStub,
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
  /* R43（用户 2026-10-16）：「决策卡里是优先用 keepFrom 还是档位？使用时应该说清哪种模式。要求都是中文」。 */
  const mode43 = (card15.match(/• \*\*两种模式[\s\S]*?锚点未命中自动退回档位。/) ?? [''])[0];
  ok('R43 文本级：卡里写明「两种模式（二选一，**锚点优先**）」+ 按比例/按位置 + 锚点不折算 + 未命中退档位',
    /两种模式（二选一，锚点优先）/.test(card15) && /①\*\*按比例\*\*/.test(card15) && /②\*\*按位置\*\*/.test(card15)
    && /原样保留、不折算/.test(card15) && /锚点未命中自动退回档位/.test(card15)
    && /表盘 ≈ 档位名 \+ 约 3%/.test(card15),
    `实际：${mode43.slice(0, 220)}`);
  ok('R43 中文守卫：模式说明**除代码标识符外全中文**（剥掉反引号片段后不得残留拉丁字母）',
    mode43.length > 40 && !/[A-Za-z]/.test(mode43.replace(/`[^`]*`/g, '')),
    `去代码后实际：${JSON.stringify(mode43.replace(/`[^`]*`/g, ''))}`);
  ok('R16.15/R27 决策行：要求绑定**提醒通道**（卡每轮一张）且**一轮只写一次**',
    /本轮开头先落一行决策/.test(card15) && /一轮只写一次/.test(card15),
    '决策行要求与提醒通道脱钩（卡不出现却要求写）/ 或没写清"一轮只写一次" ⇒ 多步轮次里每步都贴一行');
  const cardDecl = api15.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'heavy', tierDeclared: true }) ?? '';
  const cardUnd = api15.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'standard', tierDeclared: false }) ?? '';
  ok('R16.15 卡给出**当前档位**（已登记 / 兜底两态可辨；R19 起用中文说法）',
    /当前档位：浅压24%（已登记）/.test(cardDecl) && /当前档位：标准16%（兜底/.test(cardUnd)
      && /不是档位说法/.test(cardDecl) && !/当前档位：heavy/.test(cardDecl),
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
    getRangeApi: rangeStub, pluginDir: dir,
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
    /当前档位：浅压24%（已登记；本次由\*\*落盘恢复\*\*/.test(cardRestored),
    '三态不可辨 ⇒ 用户/模型无法判断档位是否真的还在（评审实测点）');
  /* ③ 评审剩余三条 */
  const brief16 = api16.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
  ok('R16.16 brief：保留数字标注「按默认档位 标准16% 计」（不再与已登记档位矛盾）',
    /按默认档位 标准16% 计/.test(brief16),
    'brief 硬写 ×16%/160k ⇒ 声明浅压24% 后与卡片活值矛盾（评审剩项一）');
  const cardTrend16 = api16.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, deltaTokens: 50000, turnsToLine: 5 }) ?? '';
  ok('R16.16 卡片：趋势行存在时不再重复「若预计会推高」（口径统一）',
    /按上方趋势行判断/.test(cardTrend16) && !/若预计任务会推高占用/.test(cardTrend16),
    '趋势行与「若预计」并存 ⇒ 两种口径（评审剩项二）');
  ok('R16.16/R20 卡片：**两个方向都变数字**（多留的收益 + 少留的余量，不再单向劝导）',
    /两个方向（选一个）/.test(cardTrend16) && /浅压24%（留 240k）⇒ 丢 ~/.test(cardTrend16)
      && /深压8%（留 80k）⇒ 丢 ~/.test(cardTrend16)
      && /多留 ⇒ 压后高、下次压缩更早；少留 ⇒ 余量大、摘要更早/.test(cardTrend16),
    '只给多留的好处 ⇒ 卡片本身在劝模型选浅压（R20 实测偏差）');
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
    getDefineTool: () => (sp) => sp, getRangeApi: rangeStub, pluginDir: dir,
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
ok('工具门控接总开关 enabled（不是 effortEnabled）——R18 起关闭时还必须撤回注册',
  /readCfg: \(\) => \(\{ enabled: M3\.enabled === true \}\)/.test(host) &&
  /const on = enabled\(\);/.test(ct) && /if \(!on\) \{\s*retractTool\('switch-off'\);/.test(ct),
  '门控接错开关 ⇒ 压缩工具的存在性跟随智能思考开关；关闭不撤回 ⇒ 每请求白付 schema');
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
  /* R21.2：`verify` 模板改为「已登记，${沿用/档位}「…」」两态（不传 tier ⇒ 沿用）——断言随之对账。 */
  /verify: `已登记，\$\{via === 'carry' \? `档位沿用「\$\{textOf\(tier\)\}」` : `档位「\$\{textOf\(tier\)\}」`\}/.test(ct) && /「压缩自检」回执/.test(ct) && /请再调用一次 compact_context/.test(ct),
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
  && /let wanted = false;/.test(ctPreStep) && /wanted = !!intent;/.test(ctPreStep)
  /* R71（审查 F-11）：wanted 由 try 内 const 提到函数体开头（catch 要看得见它报真实 trigger），
   * 语义仍是「先判意图、再判强制线」，故同时校验两者顺序。 */
  && ctPreStep.indexOf('wanted = !!intent;') < ctPreStep.indexOf('if (!wanted && ratio < effCritical) return;')
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
  /* R72（S1）：宿主的同名**转发**也零生产调用者（唯一消费者是这条断言）⇒ 一并删掉。
   * 解耦目标达到后，宿主连"留个转发"都不需要——少一套真相，也省 4 行代码行预算（318→314）。 */
  && !/compactWithOwnRange/.test(hostNoComment) // R72（S1）：只查代码（宿主注释里还有解释性提及）
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
  /* R72（S1）：宿主同名转发已删；未就绪的降级改由 preStepCompaction 分支承担（写 why:'m3-module-missing' 回执）。 */
  && /why: 'm3-module-missing'/.test(host)
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
  /* R21：调用**多了锚点三个字段**（retainOverride/anchorSeq/anchorFailReason）⇒ 正则改为跨行容忍，
   * 但仍逐项钉住原有语义字段（measure 本体、tierName 来源）。 */
  /const out = await compactWithOwnRange\(agent, compaction, \{[\s\S]{0,320}?forced, sig, sid, window: mr\.window, measure: mr\.measure, tierName/.test(ctPreStep)
  /* R16：档位从**会话级偏好**读取（工具登记），未选 ⇒ standard 兜底（用户明确要求）。 */
  && /const tierName = tool\?\.getTier\?\.\(sid\) \?\? 'standard';/.test(ctPreStep)
  && /const forced = ratio >= effCritical;/.test(ctPreStep)
  && /compactRegion\(sel\.start, end, agent, sig\)/.test(ctOwnRange)
  /* ⚠️ 必须连**回退次数上限**一起钉死：只断言 `return official('boundary-exhausted')` 会被
   * 「去掉 MAX_WALK_BACK 判断」的回归骗过去（变异验证实测逃逸过一次）。 */
  /* R72（H2）：两处官方兜底改走 guardOfficial（未越强制线 ⇒ 收手，越线才回落），断言跟着改。 */
  && /if \(!prev \|\| walkBacks \+ 1 > api\.MAX_WALK_BACK\) return guardOfficial\('boundary-exhausted'\);/.test(ctOwnRange)
  && /return guardOfficial\('invalid-boundary'\)/.test(ctOwnRange)
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
ok('host 把 measure 本体带进自选范围（不二次测量、不猜节点）——R24/R25 起 used 走 DSH 表盘口径',
  /return \{ ok: true, used, total, surface, window, ratio, basis, projected, reported, sampled: proj\.sampled, stale, measure: m\.value \};/.test(m3src)
  && /const proj = projectedFromPressure\(pressureRec\);/.test(m3src)
  && /api\.selectRange\(\{ session: agent\.session, measurement: measure, retainTokens: budget, keepFromSeq:/.test(ctOwnRange),
  '没带 measure ⇒ 只能退化成官方路径，自选范围形同未接');
ok('保留预算按**会话档位**解析（R16：档位只改预算，不改范围算法）——R21 起锚点优先、失败退档位',
  /resolveTier\(tierName \?\? 'standard', window\)/.test(ctOwnRange)
  && /api\.resolveTier/.test(ctOwnRange) && /api\.selectRange\(\{ session: agent\.session, measurement: measure, retainTokens: budget, keepFromSeq:/.test(ctOwnRange)
  /* R21：**兜底链的源码形态**必须钉死——锚点预算可用就用它，否则原样用档位预算。 */
  && /const useAnchor = Number\.isFinite\(anchorBudget\) && anchorBudget > 0;/.test(ctOwnRange)
  /* R39：预算改为「档位预算 → 真实口径折算 → 交给范围选择」三步；锚点优先的语义不变。 */
  && /const tierBudgetHeur = scaleRetainBudget\(tierBudget, retainFactor\);/.test(ctOwnRange)
  && /const budget = useAnchor \? anchorBudget : tierBudgetHeur;/.test(ctOwnRange),
  '档位没接进预算 ⇒ Agent 选档无效（功能性回归）；锚点没做兜底 ⇒ 解析失败就无预算可用');
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
  /* R19/R20：展示面走 compact-range 的标签助手 ⇒ 必须注入真实模块（否则掉进英文兜底，
   * 断言会「通过」但测的是兜底路径——与 4 个 compact-tool 桩同类的虚假信心）。 */
  getRangeApi: rangeStub,
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
  /* R55③：本体函数改名为 `renderBriefBuiltin`（外层包了模板层），断言随之指向新名，
   * 并**新增**一条「模板层必须包在内置之后」的检查（否则模板会绕过内置分支语义）。 */
  /function renderBriefBuiltin\(\{ criticalRatio, retainRatio, retainTokens \} = \{\}\) \{/.test(ct)
  && /const renderBrief = \(args = \{\}\) => \{/.test(ct)
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
  /* R55②：deps 多了 M3（余量活读配置）⇒ 断言不再钉死整串依赖，改为「模块存在 + 收 M3」，
   * 其余三项（动态加载 / host 不重复定义）保持原样——它们才是这条断言真正要防的东西。 */
  /export function createThreshold\(\{[^}]*M3[^}]*\}\) \{/.test(threshold)
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
  /* R55②：余量从写死常量改为 `marginOf()`（活读 M3.engineCapMargin，非法值回退默认 5pp）
   * ⇒ 断言升级为「上限函数仍单一来源」+「余量确实走活读路径」，比原来更强。 */
  /const criticalCapOf = \(agent\) => Math\.max\(0, engineThreshold\(agent\) - marginOf\(\)\);/.test(threshold)
  && /const v = M3\?\.engineCapMargin;/.test(threshold)
  && /return typeof v === 'number' && Number\.isFinite\(v\) && v >= 0 && v < 0\.5 \? v : ENGINE_CAP_MARGIN;/.test(threshold),
  '未抽单一上限函数 / 余量没走活读配置 ⇒ 三处门控各写一遍必然漂移');
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
  /* R55②：余量活读 ⇒ 探针用局部 m，且**必须**把 margin 纳入"是否需要刷新"的条件
   * （否则用户改了余量、面板仍显示旧值 ⇒ 看起来像"改了没生效"）。 */
  /cap: \+Math\.max\(0, raw - m\)\.toFixed\(4\)/.test(threshold) && /margin: m,/.test(threshold)
  && /const m = marginOf\(\);/.test(threshold) && /prev\.margin !== m/.test(threshold),
  '取证只记原始值 / 余量变化不刷新探针');
ok('R66：client 提示语按**活值**算清两条线（引擎阈值−余量=上限；生效=min(你的值,上限)）',
  /引擎阈值 − 余量/.test(client) && /Math\.min\(v, capNow\)/.test(client) && /生效强制线/.test(client),
  '提示未算出最终生效值 ⇒ 用户看不出「强制压缩线」与「阈值余量」到底哪个生效（用户实测）');
ok('client 用一位小数显示上限（0.745 不能被四舍五入掉小数）',
  /Math\.round\(Number\(x\) \* 1000\) \/ 10/.test(client) && /Math\.round\((?:engineCap|capNow) \* 1000\) \/ 10/.test(client),
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
  /* R71（审查 #6 + F-10）：pullCap 已并入 pullInj —— 挂载只发**一次** getHud，且优先带 sid
   * （原先两个 effect 各发一次无 sid 调用 ⇒ 载荷拉两遍，cap 还永不命中 modelPolicies）。 */
  && /const pullInj = react\.useCallback/.test(client) && /getHud\(resolveSid\(\)\)/.test(client)
  && !/const pullCap = async/.test(client)
  /* ⚠️ 必须断言**取值表达式本身**：只查「有 pullCap / 有 setEngineCap」会被
   * 「写了函数但 `const c = null`」蒙混过关（变异实测：弱版断言未抓住）。 */
  && /const c = env && typeof env\.criticalCap === "number" && Number\.isFinite\(env\.criticalCap\) \? env\.criticalCap : null;/.test(client)
  && /NS\.engineCap = c;/.test(client) && /setEngineCap\(c\);/.test(client),
  '面板仍只读 NS.engineCap / 未真正取 criticalCap ⇒ 没开过弹窗时上限恒 null（备注「待探测」+ 保存不钳制）');
ok('面板保存路径用面板 state 钳制（不用 NS.engineCap）',
  /const cap = capNow !== null && capNow > 0 && capNow <= 1 \? capNow : null;/.test(client),
  '仍读 NS.engineCap ⇒ 没开弹窗时保存不钳制（设 0.8 就真存成 0.8）');
ok('面板计算器/回读提示同样用面板 state（三处同源）',
  /const cap = capNow !== null && capNow > 0 && capNow <= 1 \? capNow : null;/.test(client)
  && /Math\.round\((?:engineCap|capNow) \* 1000\) \/ 10/.test(client),
  '计算器或回读提示仍读 NS.engineCap ⇒ 与保存路径不同源');
/* ═══ 用户二次反馈：「设置 0.8 没有钳回 0.75」且**保存按钮是灰的** ═══
 * 根因：只做了「保存时钳制」。而用户输入 0.8 时**已存值也是 0.8** ⇒ `dirty=false`
 * ⇒ `保存` 的 disabled 条件含 `!dirty` ⇒ 按钮灰掉 ⇒ 那条钳制路径**根本走不到**。
 * ⇒ 必须在**输入时**就把值钳回上限（输入框当场显示 0.75 ⇒ dirty 变真 ⇒ 保存可用）。 */
ok('强制压缩线在**输入时**即钳到生效上限（不只是保存时）',
  /if \(field\.key === "criticalRatio" && capNow !== null\) \{/.test(client)
  && /const n = parseInput\(field, raw\);/.test(client)
  && /if \(n !== null && n > capNow\) next = String\(capNow\);/.test(client),
  '只有保存时钳制 ⇒ dirty=false 时保存按钮是灰的，钳制路径走不到（实测截图）');
ok('输入钳制不误伤输入过程（空串/半成品不改写）且上限未知时不瞎钳',
  /if \(n !== null && n > capNow\)/.test(client) && /capNow !== null\) \{/.test(client),
  '对非法输入也钳 / 未探测到上限也钳 ⇒ 边打字边被改写或钳到错值');
/* ═══ 用户三次反馈：「如果原保存值超过钳回值，应该也直接钳回保存」 ═══
 * 场景：早先存过 0.8，之后上限收紧到 0.75 ⇒ 进面板时 stored 仍 0.8，而 dirty=false
 * ⇒ 保存按钮灰的，用户**没有可行的收敛路径**。⇒ 进面板即自动钳回并落盘（只做一次）。 */
ok('已存值超上限 ⇒ 进面板自动钳回并保存（用户明确要求）',
  /const autoClamped = react\.useRef\(false\);/.test(client)
  && /await writeField\(settingsScope, field, roundRatio\(engineCap\)\);/.test(client) // R72（C3）：落盘前归一
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
  && /static getDerivedStateFromError\(/.test(client)
  && /componentDidCatch\(error\)/.test(client)
  && !/function CardBoundary\(props\)/.test(client),
  '仅 try/catch ⇒ effect / 事件回调 / 异步 setState 的异常仍会把整个插件详情页打崩（已出过一次真事故）');
/* R56d：边界"隔离"不等于"静默" —— 失败必须可见（用户三轮排查都栽在 return null 的空白上） */
ok('R56d：错误边界失败时渲染**可见诊断**（含错误消息），不再 return null',
  /getDerivedStateFromError\(error\)/.test(client)
  && /this\.state = \{ failed: false, message: "" \}/.test(client)
  && /错误：\$\{this\.state\.message\}/.test(client)
  && !/if \(this\.state\.failed\) return null;/.test(client),
  '静默 return null ⇒ 页面一片空白、用户零线索（三轮排查都卡在这里）');
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
  && /await writeField\([\s\S]{0,400}if \(!alive\) return;/.test(autoClampBlock), // R72：窗口放宽（中间多了注释块）
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
  /el\(PriceCalculator, \{ writable, saving, onApply: applyRecommendation, engineCap: capNow \}\)/.test(client),
  '渲染处没传 engineCap ⇒ 计算器拿到 undefined（虽不崩，但上限提示失效）');

/* ═══ 6.17b R56（2026-10-19）：配置卡**整卡静默消失**的第二种形态 ═══
 * 用户实测「这个界面没有看到」（截图里配置卡位置一片空白）。真因：
 *   `const pct1` 定义在 `hintFor` **函数体内部**，而 **summary 分支**（详情页那一行
 *   `智能压缩线 x% ｜ 强制压缩线 y%`）在 `hintFor` **外面**调用它 ⇒ 渲染期
 *   `ReferenceError: pct1 is not defined` ⇒ 被 `CardBoundary` 捕获 ⇒ `return null`
 *   ⇒ 页面上什么都没有，**只在控制台留一条 warn**（§6.17 的 PriceCalculator 事故同型）。
 * ⚠️ 这是本项目第三次同型事故：R54 的 F1（`lastUserText`）、F3（`alive`）、§6.17（`engineCap`）。
 * `node --check` 只查语法 ⇒ 对未定义标识符完全无效 ⇒ 这里用**缩进锚定**做结构守卫：
 * 组件级声明是 3 个 tab，函数体内的嵌套声明是 4 个 tab。 */
ok('R56：`pct1` 声明在**组件作用域**（summary 分支要用它，否则整卡消失）',
  /^\t{3}const pct1 = \(x\) =>/m.test(client),
  'pct1 不在组件作用域 ⇒ summary 分支调用即 ReferenceError ⇒ CardBoundary 吞掉 ⇒ 配置卡整张消失');
ok('R56：`pct1` 只有一处声明且不在嵌套作用域（防"缩进回去"复发）',
  !/^\t{4,}const pct1 = /m.test(client) && (client.match(/const pct1 = /g) ?? []).length === 1,
  '仍有嵌套声明 ⇒ 同名共存，使用点解析到哪个取决于作用域 ⇒ 极易复发');
ok('R56：CardBoundary 出错时**留痕**（只 return null 会让"看不到"无从排查）',
  /componentDidCatch\(error\) \{/.test(client) && /卡片渲染失败（已隔离/.test(client),
  '无痕 ⇒ 用户看到"什么都没有"且没有任何线索（本次排查耗时正因如此）');
/* ═══ 6.17c R56b（2026-10-19）：配置卡**整卡静默消失**的真根因——getSnapshot 自递归 ═══
 * 用户复测「还是没看到」⇒ R56 修的 pct1 只是**潜伏的第二个 bug**（自递归挡在它前面，走不到 pct1）。
 * 真因：scope.getSnapshot 的兜底写的是 settingsScope.getSnapshot()，而 settingsScope = scope
 * 又把它指回自己 ⇒ 命名空间未就绪时**自我递归** ⇒ 渲染期 RangeError: Maximum call stack size exceeded
 * ⇒ 被 CardBoundary 吞掉 ⇒ **配置卡从来就没渲染过**（两种 view 都崩，与历次截图一致）。
 * 行为级护栏在 test/client-render.mjs（真渲染冒烟，变异 CAUGHT 5 条）；这里是结构级双保险。 */
ok('R56b：getSnapshot 兜底必须是**独立常量** UNAVAILABLE_SCOPE（不得写 settingsScope）',
  /: UNAVAILABLE_SCOPE\.getSnapshot\(\)/.test(client) && !/current\.getSnapshot\(\) : settingsScope\.getSnapshot\(\)/.test(client),
  '兜底指回 settingsScope ⇒ 命名空间未就绪时自我递归 ⇒ RangeError ⇒ 整卡静默消失（用户实测事故）');
ok('R56b：UNAVAILABLE_SCOPE 是独立常量且 settingsScope 初始指向它',
  /const UNAVAILABLE_SCOPE = \{ getSnapshot:/.test(client) && /let settingsScope = UNAVAILABLE_SCOPE;/.test(client),
  '兜底对象必须与 settingsScope 分离，否则 settingsScope = scope 一执行就自环');

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
 * 只钉某一项存在的话，新增/删除字段都不会被发现（原版正是这个弱写法）。
 * R55：读取集从 6 项扩到 12 项 ⇒ 不再把字面量抄进断言（抄一遍就是第二份真相，正是本断言要防的），
 * 改为**解析读取集与 M3_DEFAULTS 做集合级对账**——比原来更强：新增字段忘读也会红。 */
const readSet = (() => {
  const m = /for \(const k of \[([^\]]*)\]\) \{/.exec(hostOrCore);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
})();
ok('mergeConfig 读取集与 M3_DEFAULTS 完全同源（防「面板改了不生效」与漂移）',
  readSet.length > 0 && readSet.length === hostDefaults.length && readSet.every((k) => hostDefaults.includes(k))
  && !/armedTtlMs/.test(hostNoComment),
  `读取集=${JSON.stringify(readSet)}\n       M3_DEFAULTS=${JSON.stringify(hostDefaults)}`
  + ' —— 缺项⇒面板改值不生效；多项⇒死配置');
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
    /* R30：`step !== 1` 分支里多了「反重复备注」子分支（本轮发过卡时在中步投一条短备注），
     * 早退距离开口变远 ⇒ 窗口从 900 放宽到 2600（判据本身不变：**非 step1 仍必须早退**）。 */
    return s > 0 && g > 0 && s < g && /if \(step !== 1\) \{[\s\S]{0,2600}?return \{ skip: 'not-step-1' \};/.test(m2src);
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
  ['① 当前值', /当前思考强度档位：' \+ effortLabel\(eff\.current\)/],
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
ok('effortEnabled 关闭时不注册工具（完全不介入）——R18 起还必须**撤回**已注册的',
  /if \(M3\.effortEnabled === true\) effortReady\.then\(\(api\) => api\?\.ensure\(\)\)/.test(host) &&
  /if \(!on\) \{\s*retractTool\('switch-off'\);/.test(effort) &&
  /function retractTool\(reason\) \{/.test(effort),
  '关闭时仍注册/不撤回 ⇒ 与「关=完全不介入」的用户定义矛盾（旧实现只停注入 ⇒ 每请求白付 schema）');
ok('会话中途打开开关会补注册（懒注册）',
  /registerTool\(\);\s*\n\s*return true;/.test(effort),
  '只在加载时注册一次 ⇒ 中途打开开关后工具不可用');
// 工具必须**不抛错**（抛错会中断本轮；这里只想"告知 + 不换"）
ok('工具非法档返回结构化错误而非抛错（抛错会中断本轮；R23 起错误文案与可选集都是「中文(id)」）',
  /error: `档位「\$\{effortLabel\(wantInput\)\}」不在当前模型的可选集内。`/.test(effort)
  && /options: \(chk\.options \?\? \[\]\)\.map\(effortLabel\)/.test(effort),
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
ok('R16/R22 工具结果带 tier（**中文标签**）且在 output.schema 里已声明（R15.3 同类护栏）',
  rA.tier === '标准16%' && Object.keys(ctSpec.output.schema.properties).includes('tier'),
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
ok('checkEffort 与 renderBrief 用同一判据（length 而非 isArray；两处的**显示**都走 effortLabels）',
  /Array\.isArray\(eff\.efforts\) && eff\.efforts\.length \? effortLabels\(eff\.efforts\) : null/.test(effort),
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
       * 改为可执行的补救动作；R20 起**还要求指明选哪一档**（见下一条 R20 断言）。 */
      && /立刻用 `action:'set-tier'` 声明「深压8%」或「标准16%」/.test(cardAbove),
    `未越线卡：${cardBelow.slice(0, 80)}… | 已越线卡：${cardAbove.slice(0, 80)}…`);
}
console.log('\n== 6.20 工具后自检回执 + 思考强度可切性 ==');
const m2Mod = await import(pathToFileURL(join(PLUGIN, 'm2.inject.mjs')).href);
const mkM2 = (state, measure, takeVerify, rangeApi, compactToolApi, extra) => m2Mod.createM2Injection({
  state, log: () => {}, msg: (e) => String(e?.message ?? e), pick: (...a) => a.find((x) => x != null),
  schedule: () => {}, svc: () => null,
  tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
  nfmt: (n) => String(n), summarizeBreakdown: () => null, remember: () => {},
  M3: { criticalRatio: 0.85, markerMinRatio: 0.3, effortEnabled: false },
  effEnabled: () => true, criticalCapOf: () => 0.8,
  measureRatio: measure ?? (() => ({ ok: true, used: 500000, surface: 300000, window: 1000000, ratio: 0.5, measure: {} })),
  /* R16.1：回执消费注入（生产环境是宿主的箭头包装 → m3Ctl.takeCompactVerify）。 */
  takeCompactVerify: takeVerify ?? (() => null),
  getRangeApi: () => rangeApi ?? ({ RETAIN_RATIO: 0.16 }), getCompactToolApi: () => compactToolApi ?? null, getEffortApi: () => null,
  getCreateUserMessage: () => () => ({ fake: 'user-message' }), SOURCE_KIND: 'context-pilot',
  ...(extra ?? {}),   // R35：可注入额外依赖（如 recordHudAct / publishHud 探针）
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

/* 思考强度：可选项必须**每轮可见**（原先只在会话最早的一次性教学里）；R23 起一律「中文(id)」显示 */
const suffixWithOpts = effApi.renderSuffix({ ok: true, current: 'high', efforts: ['off', 'low', 'high', 'max'] }) ?? '';
ok('每轮后缀列出**可选档位**（不只当前档 ⇒ 时刻可切）；R23 起显示名统一「中文(id)」',
  /思考强度 高\(high\)/.test(suffixWithOpts) && /可选 关闭\(off\)\/低\(low\)\/高\(high\)\/最高\(max\)/.test(suffixWithOpts)
  && /set_reasoning_effort/.test(suffixWithOpts),
  `实际：${JSON.stringify(suffixWithOpts)}`);
ok('取不到可选集时不编造（保持纯档位后缀）',
  (effApi.renderSuffix({ ok: true, current: 'high', efforts: null }) ?? '') === '思考强度 高(high)',
  '凭空写可选集 ⇒ 教错档位');
ok('R23 纯函数：未知档位**原样显示 id**（不编造中文；档位集合由模型/适配器决定）',
  effApi.effortLabel('weird-tier') === 'weird-tier' && effApi.effortLabel('max') === '最高(max)'
  && effApi.effortLabels(['low', 'max']) === '低(low)/最高(max)',
  `实际 ${effApi.effortLabel('weird-tier')} / ${effApi.effortLabels(['low', 'max'])}`);
ok('R23 纯函数：入参兼容「中文(id)」「纯中文」「原始 id」——一律回到原始 id',
  effApi.parseEffortInput('高(high)') === 'high' && effApi.parseEffortInput('高') === 'high'
  && effApi.parseEffortInput('high') === 'high'
  && effApi.parseEffortInput('关闭', ['off', 'low', 'high', 'max']) === 'off'
  && effApi.parseEffortInput('关掉啦') === '关掉啦',
  `实际 ${JSON.stringify(['高(high)', '高', 'high', '关闭', '关掉啦'].map((x) => effApi.parseEffortInput(x, ['off', 'low', 'high', 'max'])))}`
  + ' —— 显示改成中英后模型会照抄回来，不兼容就是白跑一趟');
const effBriefNow = effApi.renderBrief({ ok: true, current: 'high', efforts: ['off', 'low', 'high', 'max'] }) ?? '';
ok('思考强度教学改为「按需可多次」（删掉「1-2 次为宜」的抑制性措辞）',
  !/1-2 次/.test(effBriefNow) && /阶段变化/.test(effBriefNow) && /可以切多次/.test(effBriefNow) && /冷却/.test(effBriefNow),
  '仍未按用户目标（长任务按实际需求可多次）改写教学');
ok('M3 域在每条路径都产出执行回执（executed / no-need / not-executed）',
  /setCompactVerify\(sid, \{[\s\S]{0,300}state: result != null \? 'executed' : 'no-need'/.test(m3src)
  && /state: 'not-executed',\n\s+why: 'no-compaction-service'/.test(m3src)
  /* R49.1：错误分支用**提到 try 之外**的 `sid`（原引用 try 内 `const sid` ⇒ catch 自身抛错，见 m3 注释）。 */
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

/* ═══════════ 6.22 R17：用户手动改档必须在**本轮轮首**就告诉模型 ═══════════
 * 用户实测（2026-10-12）：「上一轮结束时思考强度是 high，我手动改成 Max 发起新一轮，
 * 模型开始读取到的好像还是 high——注入的时机不够前。应该能让模型知道用户调整了思考强度。」
 * 根因（源码 + 时序双证，详见 effort.mjs 文件头结论⑪）：
 *   ① 用户改档（UI `selectModel` / `/model` 命令，全库只有这两处会写）**只**追加
 *      `model/selection` 事件 ⇒ 落在 **modelSelection 投影的 `pending`**；
 *   ② 官方 `installModelSelection` 要到**本步骤**的 `system-prompt/assemble` → `agent/request`
 *      才把它落进请求配置；
 *   ③ 插件的注入在 `agent/pre-step` step 1 —— **排在上面两者之前** ⇒ 那一刻 `requestHeader()`
 *      仍是**上一次请求**的旧档。只读 header 的旧实现 ⇒ 轮首喂给模型一个「本轮根本不会用」的档位。
 * 断言分两层：静态（读的是 pending 而非只读 header）+ 行为（真跑 read/renderSuffix 五条路径）。 */
console.log('\n== 6.22 R17：用户手动改档 ⇒ 本轮轮首即知情 ==');
const effortR17 = read('effort.mjs');
ok('R17 静态：轮首读档必须查 modelSelection 投影的 pending（只读 header 就是旧档）',
  /svc\('sessionProjections'\)\?\.stateOf\?\.\(agent\?\.session, 'modelSelection'\)/.test(effortR17)
  && /const pending = sel && typeof sel\.pending === 'object' && sel\.pending !== null/.test(effortR17)
  && /const route = pending \?\? c;/.test(effortR17),
  '未读投影 pending ⇒ 用户刚改的档位在轮首不可见（模型只看到上一轮旧档，还据此做决策）');
ok('R17 静态：pending 未指定档（只换模型）必须有兜底 ⇒ 前缀不得消失',
  /info\.current = defEffort \?\? info\.pendingFrom;/.test(effortR17),
  'pending 无档且 adapter 默认取不到时不兜底 ⇒ current=null ⇒ 后缀整个消失（比报旧档更糟）');
ok('R17 静态：后缀必须紧跟档位值说明「用户刚改档」',
  /eff\.pendingChanged/.test(effortR17) && /用户刚把档位从/.test(effortR17),
  '只报新值 ⇒ 模型以为「一直就是这档」，错过用户「这轮要更用力／可以省点」的意图');

/* 行为级：真跑 effort 域（桩 sessionProjections/llm），覆盖 ①改档 ②无 pending ③投影缺失 ④只换模型 ⑤重复同档 */
{
  const eMod17 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  /* mi 三态：undefined=正常模型信息；null=**llm 服务不可用**；对象=自定义（用于「无 adapter 默认档」）。 */
  const MI17 = { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } };
  const mkApi17 = (projState, mi = MI17) => eMod17.createEffort({
    svc: (k) => (k === 'sessionProjections'
      ? (projState === 'absent' ? undefined : { stateOf: () => projState })
      : k === 'llm'
        ? (mi === null ? undefined : { resolveModelInfo: async () => mi })
        : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (sp) => sp,
  });
  const ag17 = (he) => ({
    id: 'r17',
    session: { id: 'r17', requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: he } }) },
  });
  const sel17 = (pe, model) => ({ provider: 'deepseek-account', model: model ?? 'deepseek-flash', ...(pe ? { reasoningEffort: pe } : {}) });

  const apiA = mkApi17({ lastUsed: sel17('high'), pending: sel17('max') });
  const effA = await apiA.read(ag17('high'));
  ok('R17 行为级：用户手动改档（header=high / pending=max）⇒ 本轮读数即 max 并标记「刚改过」',
    effA?.current === 'max' && effA?.pending === true && effA?.pendingFrom === 'high' && effA?.pendingChanged === true,
    `实际 current=${JSON.stringify(effA?.current)} pending=${JSON.stringify(effA?.pending)} pendingChanged=${JSON.stringify(effA?.pendingChanged)}`
    + ' —— 变异：改回只读 header 时这里给出 high（模型以为用户没动档）');
  const sufA = apiA.renderSuffix(effA) ?? '';
  ok('R17/R23 行为级：后缀点明「用户刚把档位从 高(high) 调到 最高(max)」并写清本步骤即生效',
    /用户刚把档位从 高\(high\) 调到 最高\(max\)/.test(sufA) && /本步骤的请求即用它/.test(sufA),
    `实际后缀：${JSON.stringify(sufA)}`);
  /* R36（2026-10-16 真机）：模型**用上了新值却写成「保持」**（照抄卡片/教学模板）⇒ 用户以为它没感知到切换。
   * 修：切档那一轮显式说"这不是保持"，并给出该怎么写。 */
  ok('R36 行为级：切档轮的后缀**显式说「这是用户改的，不是"保持"」**并给出写法',
    /这是用户改的，不是"保持"/.test(sufA) && /正文里请写「用户刚调到 最高\(max\)」/.test(sufA),
    `实际后缀：${JSON.stringify(sufA)}`);

  const apiB = mkApi17({ lastUsed: sel17('high'), pending: null });
  const effB = await apiB.read(ag17('high'));
  ok('R36 行为级：**没有**切档的轮次不出现该提示（避免每轮噪声）',
    !/不是"保持"/.test(apiB.renderSuffix(effB) ?? ''),
    `实际：${JSON.stringify(apiB.renderSuffix(effB))}`);
  ok('R17/R23 行为级：无 pending 时后缀形状稳定（R23 起档位显示「中文(id)」，其余逐字不变）',
    (apiB.renderSuffix(effB) ?? '') === '思考强度 高(high)（可选 关闭(off)/低(low)/高(high)/最高(max)，需要时先说再调用 set_reasoning_effort）',
    `实际：${JSON.stringify(apiB.renderSuffix(effB))}`);

  const apiC = mkApi17('absent');
  const effC = await apiC.read(ag17('high'));
  ok('R17 行为级：投影缺失/形状异常 ⇒ 退回 header 值（降级不炸、不掉档）',
    effC?.ok === true && effC?.current === 'high' && effC?.pending === false,
    `实际：${JSON.stringify(effC)}`);

  const apiD = mkApi17({ lastUsed: sel17('max'), pending: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } });
  const effD = await apiD.read(ag17('max'));
  ok('R17 行为级：pending 未指定档（只换模型）⇒ 用新模型 adapter 默认兜底，后缀不消失',
    effD?.current === 'high' && effD?.adapterDefault === true && typeof apiD.renderSuffix(effD) === 'string',
    `实际 read=${JSON.stringify(effD)} suffix=${JSON.stringify(apiD.renderSuffix(effD))}`);

  const apiE = mkApi17({ lastUsed: sel17('high'), pending: sel17('high') });
  const effE = await apiE.read(ag17('high'));
  ok('R17 行为级：pending 与旧值相同（重复选同档）⇒ 不加「刚改档」噪声',
    effE?.pendingChanged === false && !/用户刚把档位从/.test(apiE.renderSuffix(effE) ?? ''),
    `实际：${JSON.stringify(apiE.renderSuffix(effE))}`);

  /* 兜底那一行的**行为覆盖**（静态断言只证明写法在，不证明它真的保住了后缀）：
   * 用户选了「默认档」（pending 无 reasoningEffort）且 adapter 默认取不到时，
   * current 必须退回上一档的旧值 —— 否则 renderSuffix 返回 null、后缀整条消失。 */
  const apiF = mkApi17({ lastUsed: sel17('max'), pending: sel17(null) }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: null } });
  const effF = await apiF.read(ag17('max'));
  const sufF = apiF.renderSuffix(effF);
  ok('R17 行为级：pending 无档且**取不到 adapter 默认** ⇒ 退回旧值，后缀不得变 null',
    effF?.current === 'max' && typeof sufF === 'string' && /思考强度/.test(sufF),
    `实际 read=${JSON.stringify(effF)} suffix=${JSON.stringify(sufF)} —— 变异：去掉兜底⇒current=null⇒后缀消失（模型连档位都看不到）`);

  const apiG = mkApi17({ lastUsed: sel17('max'), pending: sel17(null) }, null);
  const effG = await apiG.read(ag17('max'));
  ok('R17 行为级：llm 服务不可用（读不到可选集）时同样不丢后缀、不报错',
    effG?.ok === true && typeof apiG.renderSuffix(effG) === 'string',
    `实际 read=${JSON.stringify(effG)} suffix=${JSON.stringify(apiG.renderSuffix(effG))}`);
}

/* ═══════════ 6.23 R18：单档模型的「零注入 + 工具静默」+ 开关联动 ═══════════
 * 用户要求（2026-10-13）：「如果所选模式没有多个档位可行，并排除 Default 这个项目，
 * 比如只有一档 High，就不往提示词内注入切换档位的相关内容，尽量少 token，
 * 并随时切换到有多个档位的模型时，又能第一时间注入。」
 * 判据 = canSwitch(eff)：去掉 default/默认 后剩余 distinct ≥ 2 才叫「可切」；
 * **未知一律不抑制**（R7 结论：取不到 ≠ 没有）。工具可见性走 agent 作用域 restrict。 */
console.log('\n== 6.23 R18：单档静默 + 工具可见性 + 开关撤回 ==');
{
  const effortR18 = read('effort.mjs');
  const gateUses = (effortR18.match(/if \(!canSwitch\(eff\)\.canSwitch\) return null;/g) ?? []).length;
  ok('R18 静态：三个文本出口全部接判据（后缀 / 教学 / 提醒）', gateUses >= 3,
    `实际命中 ${gateUses} 处 —— 少一处就会出现「工具没了、文本还在教你调用」的自相矛盾`);
  ok('R18 静态：压缩自检回执里的换档提示也接判据（最易漏的一处，在 m2 不在 effort 域）',
    /const renderCompactReceipt = \(v, allowSwitch = true\) => \{/.test(m2src)
    && /const switchHint = allowSwitch/.test(m2src)
    && /renderCompactReceipt\(takeCompactReceipt\(sidEarly\), allowSwitchTalk\)/.test(m2src)
    && /const effGate = eff \? \(effortApi\?\.canSwitch\?\.\(eff\) \?\? null\) : null;/.test(m2src),
    '回执仍在劝模型调用一个已隐藏的工具');
  ok('R18 静态：工具注册持有**可撤销句柄**，开关关闭时撤回',
    /const d = tools\.register\(defineTool\(toolSpec\(\)\)\);/.test(effortR18)
    && /function retractTool\(reason\) \{/.test(effortR18)
    && /if \(!on\) \{\s*retractTool\('switch-off'\);/.test(effortR18),
    '丢弃 register() 的 disposer ⇒ 关闭开关后工具永远留在模型清单里（每请求白付 schema）');
  ok('R18 静态：per-agent 隐藏用 agent.ctx 的 restrict + **进程级注册表** + 清扫',
    /agent\?\.ctx\?\.get\?\.\('tools'\)/.test(effortR18)
    && /Symbol\.for\('dsh-context-pilot\/effort-restrict'\)/.test(effortR18)
    && /tools\.restrict\(\{ deny: \[TOOL_NAME\] \}\)/.test(effortR18)
    && /function sweepRestricts\(why\) \{/.test(effortR18),
    '无持久句柄/清扫 ⇒ 热换后工具永久隐藏（静默能力丢失，本项目最怕的形态）');
  ok('R18 静态：拿不到回滚句柄就**不隐藏**（失败极性铁律）',
    /if \(typeof d !== 'function'\) \{[\s\S]{0,220}return false;/.test(effortR18)
    && /else hideToolFor\(agent, gate\);/.test(effortR18),
    '拿不到句柄仍隐藏 ⇒ 不可逆的能力丢失');
  ok('R18 静态：宿主 pre-step **await** 收敛（早于 assemble ⇒ 当步生效）',
    /await reconcileEffort\(payload\?\.agent\);/.test(host) && /const reconcileEffort = async \(agent\)/.test(host),
    '不 await ⇒ 工具可见性晚一步（目标③「当轮恢复」失守）');
  ok('R18 静态：宿主不再按开关早退（否则关闭时进不到模块、撤不掉工具）',
    !/if \(M3\.effortEnabled !== true\) return false;/.test(host) && !/if \(M3\.enabled !== true\) return false;/.test(host),
    '宿主早退 ⇒ R18 的撤回/清扫永远不执行');
  ok('R18 静态：pre-step 最前面补 mergeConfig（开关翻转当步生效）',
    /try \{ mergeConfig\(\); \} catch/.test(host),
    '配置合并晚于 ensure ⇒ 开关翻转第一步读到旧值');

  /* ---- 行为级：真跑模块（桩 tools/llm/agents）---- */
  const eMod18 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const MODELS = {
    'm-single': ['high'],
    'm-multi': ['off', 'low', 'high', 'max'],
    'm-default-only': ['default', 'high'],
    'm-default-plus': ['default', 'low', 'high'],
    'm-unknown': null,
  };
  const mk18 = ({ model = 'm-multi', enabled = true, calls, throwRestrict = false, agents = [], onSchedule } = {}) => {
    let on = enabled;
    const tools = {
      register: () => { calls.register += 1; return () => { calls.dispose += 1; }; },
      restrict: () => {
        if (throwRestrict) throw new Error('restrict boom');
        calls.restrict += 1;
        return () => { calls.dispose += 1; };
      },
    };
    const api = eMod18.createEffort({
      svc: (k) => (k === 'tools' ? tools
        : k === 'agents' ? { list: () => agents }
          : k === 'llm' ? { resolveModelInfo: async () => ({ reasoning: MODELS[model] === null ? undefined : { efforts: MODELS[model].map((id) => ({ id })), defaultEffort: null } }) }
            : k === 'sessionProjections' ? { stateOf: () => null } : null),
      tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e?.message ?? e) }; } },
      pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {},
      schedule: () => { if (typeof onSchedule === 'function') onSchedule(); },
      state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0, effortToolCalls: 0 } },
      readCfg: () => ({ enabled: on, cooldownMs: 30000 }), getDefineTool: () => (spec) => spec,
    });
    return { api, setEnabled: (v) => { on = v; }, tools };
  };
  const mkAgent18 = (tools, sid) => ({
    id: sid,
    session: { id: sid, requestHeader: () => ({ config: { provider: 'p', model: 'cur' } }) },
    ctx: { get: (k) => (k === 'tools' ? tools : undefined) },
  });
  const eff18 = (efforts) => ({ ok: true, current: efforts && efforts[0] ? efforts[0] : 'high', efforts, defaultEffort: null });

  /* 判据表（含「排除 Default」与「未知不抑制」两条铁律） */
  const gateApi = mk18({ calls: { register: 0, restrict: 0, dispose: 0 } }).api;
  const gateOf = (efforts) => gateApi.canSwitch(eff18(efforts));
  ok('R18 判据：只有一档（High）⇒ 无可切档', gateOf(['high']).canSwitch === false && gateOf(['high']).why === 'single',
    `实际 ${JSON.stringify(gateOf(['high']))}`);
  ok('R18 判据：排除 Default —— [default,high] 视作单档', gateOf(['default', 'high']).canSwitch === false && gateOf(['default', 'high']).real.length === 1,
    `实际 ${JSON.stringify(gateOf(['default', 'high']))}`);
  ok('R18 判据：只剩 Default ⇒ 无可切档', gateOf(['default']).canSwitch === false && gateOf(['default']).why === 'only-default',
    `实际 ${JSON.stringify(gateOf(['default']))}`);
  ok('R18 判据：排除 Default 后仍有 ≥2 档 ⇒ 可切', gateOf(['default', 'low', 'high']).canSwitch === true,
    `实际 ${JSON.stringify(gateOf(['default', 'low', 'high']))}`);
  ok('R18 判据：四档模型照常可切', gateOf(['off', 'low', 'high', 'max']).canSwitch === true, '');
  ok('R18 判据：**未知 ≠ 没有**（null / [] / 空）⇒ 一律不抑制',
    gateOf(null).canSwitch === true && gateOf([]).canSwitch === true && gateOf(undefined).canSwitch === true
    && gateOf(null).known === false,
    '取不到可选项就抑制 ⇒ 会把多档模型的能力锁死（R7 血泪结论）');

  /* 四个文本出口在两种模型下的表现 */
  const one = eff18(['high']);
  const four = eff18(['off', 'low', 'high', 'max']);
  const ag18 = mkAgent18({}, 'sid-r18');
  ok('R18 行为级：单档 ⇒ 后缀/教学/提醒**三处全静默**',
    gateApi.renderSuffix(one) === null && gateApi.renderBrief(one) === null
    && gateApi.renderNudge(one, { agent: ag18, turn: 3, userText: '帮我排查根因' }) === null,
    `suffix=${JSON.stringify(gateApi.renderSuffix(one))} brief=${JSON.stringify(gateApi.renderBrief(one))}`);
  ok('R18/R23 行为级：多档 ⇒ 三处都有内容（R23 起档位显示「中文(id)」）',
    gateApi.renderSuffix(four) === '思考强度 关闭(off)（可选 关闭(off)/低(low)/高(high)/最高(max)，需要时先说再调用 set_reasoning_effort）'
    && typeof gateApi.renderBrief(four) === 'string'
    && typeof gateApi.renderNudge(four, { agent: ag18, turn: 3, userText: '帮我排查根因' }) === 'string',
    `suffix=${JSON.stringify(gateApi.renderSuffix(four))}`);

  /* 工具可见性：隐藏 → 幂等 → 恢复 */
  const callsA = { register: 0, restrict: 0, dispose: 0 };
  const agentsA = [];
  const A = mk18({ model: 'm-single', calls: callsA, agents: agentsA });
  await A.api.ensure();
  const agA = mkAgent18(A.tools, 'sid-A');
  agentsA.push(agA);
  await A.api.reconcile(agA);
  ok('R18 行为级：单档 ⇒ 对该 agent 施加 restrict（隐藏工具）', callsA.restrict === 1,
    `restrict 调用 ${callsA.restrict} 次（应为 1）`);
  await A.api.reconcile(agA);
  ok('R18 行为级：同一路由重复收敛**不重复 restrict**（幂等，不产生 disposer 抖动）', callsA.restrict === 1,
    `restrict 调用 ${callsA.restrict} 次（应为 1）`);
  const callsB = { register: 0, restrict: 0, dispose: 0 };
  const agentsB = [];
  const B = mk18({ model: 'm-multi', calls: callsB, agents: agentsB });
  agentsB.push(agA);                       // 同一个 agent 对象（模拟「同一会话换了模型」）
  await B.api.ensure();                    // 激活期清扫：释放上个实例留下的隐藏
  ok('R18 行为级：**跨实例自愈**——新实例激活时清扫上个实例留下的限制',
    callsA.dispose >= 1 && callsA.restrict === 1,
    `dispose=${callsA.dispose}（应 ≥1，否则热换后工具永久隐藏）`);

  /* 开关关闭 ⇒ 撤回注册 + 释放限制 */
  const callsC = { register: 0, restrict: 0, dispose: 0 };
  const agentsC = [];
  let schedC = 0;
  const C = mk18({ model: 'm-single', calls: callsC, agents: agentsC, onSchedule: () => { schedC += 1; } });
  const agC = mkAgent18(C.tools, 'sid-C');
  agentsC.push(agC);
  await C.api.ensure();
  await C.api.reconcile(agC);
  const registeredBefore = C.api.toolState().registered;
  const schedBeforeOff = schedC;
  C.setEnabled(false);
  await C.api.reconcile(agC);   // 先走 reconcile 的 switch-off 分支（不依赖 ensure 的清扫）
  ok('R18 行为级：关闭开关 ⇒ 释放该 agent 的限制（关=完全不介入）', callsC.dispose >= 1,
    `dispose=${callsC.dispose}（应 ≥1：限制被解除）`);
  /* ⚠️ 计数必须**在撤回这一步前后**夹住：上一步 reconcile(off) 释放限制时也会 schedule，
   * 用更早的基准会让断言恒真（变异 M1 实测逃逸 ⇒ 那是「虚假信心」的典型形态）。 */
  const schedBeforeRetract = schedC;
  await C.api.ensure();
  ok('R18 行为级：关闭开关 ⇒ 撤回工具注册（旧实现只停注入、白付 schema）',
    registeredBefore === true && C.api.toolState().registered === false && callsC.dispose >= 2,
    `registered: ${registeredBefore} → ${C.api.toolState().registered}；dispose=${callsC.dispose}`);
  ok('R18.2 行为级：**撤回**动作自己会 schedule 落报告（关开关也能在报告里看到）',
    schedC > schedBeforeRetract,
    `撤回前后 schedule 次数：${schedBeforeRetract} → ${schedC}（相等 ⇒ 报告里看不到「工具已退出清单」）`);

  /* restrict 抛错 ⇒ 不隐藏、不崩（失败极性） */
  const callsD = { register: 0, restrict: 0, dispose: 0 };
  const agentsD = [];
  const D = mk18({ model: 'm-single', calls: callsD, throwRestrict: true, agents: agentsD });
  await D.api.ensure();
  const agD = mkAgent18(D.tools, 'sid-D');
  agentsD.push(agD);
  let threw = false;
  try { await D.api.reconcile(agD); } catch { threw = true; }
  ok('R18 行为级：restrict 抛错 ⇒ 吞掉、工具保持可见、留痕（绝不锁死能力）',
    threw === false && callsD.restrict === 0,
    `reconcile 抛错=${threw}；restrict 成功=${callsD.restrict}`);

  /* ── R18.1（用户实测反馈「小缺口」）：收敛动作必须**落报告** ──
   * 真机验证时发现：旧版只在内存里加计数，而报告只在特定 reason 才写 ⇒ 报告里看不到
   * restricts/restores，只能靠 Inspect 侧面取证。与「任何静默降级都必须留痕」同一纪律。 */
  ok('R18.1 静态：隐藏 / 释放两条路径都 schedule 落报告',
    /* ⚠️ 用「**按函数体**取文本」而不是字符窗口：首版窗口 {0,900} 会跨进下一个函数
     * （liftToolFor 里的 schedule），于是**删掉 hide 的那一处照样通过**（变异 M1 逃逸实测）。
     * 函数体边界取「下一个 2 空格缩进的 `}`」——嵌套块的 `}` 都是 4 空格以上，不会误判。 */
    (() => {
      const bodyOf = (src, name) => {
        const i = src.indexOf(`function ${name}(`);
        if (i < 0) return null;
        const j = src.indexOf('\n  }\n', i);
        return j < 0 ? src.slice(i) : src.slice(i, j);
      };
      const hideBody = bodyOf(effortR18, 'hideToolFor');
      const liftBody = bodyOf(effortR18, 'liftToolFor');
      return hideBody !== null && liftBody !== null
        && /schedule\('effort'/.test(hideBody) && /schedule\('effort'/.test(liftBody);
    })(),
    '只加内存计数 ⇒ 报告里看不到 restricts/restores（R18 真机验证吃过这个亏）');
  {
    const callsS = { register: 0, restrict: 0, dispose: 0 };
    let schedN = 0;
    const agentsS = [];
    const S = mk18({ model: 'm-single', calls: callsS, agents: agentsS, onSchedule: () => { schedN += 1; } });
    const agS = mkAgent18(S.tools, 'sid-S');
    agentsS.push(agS);
    await S.api.ensure();
    await S.api.reconcile(agS);            // 隐藏 ⇒ 应 schedule
    const afterHide = schedN;
    S.api.sweepRestricts('test');          // 释放 ⇒ 应再 schedule
    ok('R18.1 行为级：**隐藏**与**释放**各自都会 schedule（真机可直接取证）',
      afterHide >= 1 && schedN > afterHide,
      `隐藏后 schedule=${afterHide}；释放后=${schedN}`);
  }
  /* R18.2：**撤回**同样要留痕——含「拿不到 disposer」的降级分支；effort 与 compact 对称。 */
  ok('R18.2 静态：撤回路径（成功 + 降级两支）都 schedule 落报告（effort / compact 对称）',
    (() => {
      const bodyOf = (src, name) => {
        const i = src.indexOf(`function ${name}(`);
        if (i < 0) return null;
        const j = src.indexOf('\n  }\n', i);
        return j < 0 ? src.slice(i) : src.slice(i, j);
      };
      const cnt = (s) => (s ? (s.match(/schedule\(/g) ?? []).length : 0);
      return cnt(bodyOf(effortR18, 'retractTool')) >= 2 && cnt(bodyOf(ct, 'retractTool')) >= 2;
    })(),
    '关开关后报告里看不到「工具已退出模型清单」（R18 真机实测踩到）');
}

/* ═══════════ 6.24 R19：档位说法改中文（深压8% / 标准16% / 浅压24%） ═══════════
 * 用户要求（2026-10-15）：「改成『深压8%/标准16%/浅压24%』的说法。」
 * 口径：**展示一律中文**（标签 + 紧跟百分比；百分比由 TIERS 推导，**不写死**）；
 * 英文 id 退为内部/兼容值（`compact-tier.json` 与老会话里存的仍是 id ⇒ 改名零迁移），
 * 且 `tier` 参数**中英都能传**（中文走 `canonicalTier` 别名解析）。 */
console.log('\n== 6.24 R19：档位说法改中文（深压8%/标准16%/浅压24%）==');
{
  const range19 = read('compact-range.mjs');
  ok('R19 静态：中文说法由 compact-range.mjs 单一提供（标签 / 百分比 / 别名解析）',
    /export const TIER_LABELS = \{/.test(range19) && /export function tierLabel\(name\)/.test(range19)
    && /export function tierPct\(name\)/.test(range19) && /export function tierText\(name\)/.test(range19)
    && /export function canonicalTier\(input\)/.test(range19),
    '标签散落在各展示点 ⇒ 改一处漏一处');
  ok('R19 静态：展示面不再以英文为主（无 `**light**`、无 `light=深压`）',
    !/\*\*light\*\*/.test(ct) && !/light=深压/.test(ct) && !/`light` 深压/.test(ct),
    '仍以英文 id 作主展示 ⇒ 与用户要的说法不一致');
  /* R22（用户要求：行动/回执一律中文档位名）：schema 里**以中文档位名为准**，
   * 英文 id 只允许作为「兼容入参」被提及，不再作为对外返回值或展示标签。 */
  ok('R22 静态：工具 schema 以**中文档位名**为准，英文 id 仅作兼容被提及',
    /深压8%/.test(ct) && /浅压24%/.test(ct) && /用中文档位名/.test(ct) && /英文 id 仅作兼容/.test(ct)
    && !/本次登记并持续生效的压缩档位（深压8%\/标准16%\/浅压24%；内部 id/.test(ct),
    '要么丢掉可传值说明，要么仍以英文 id 作为对外返回值');
  ok('R22 静态：压缩回执的档位标签只从中文格式化器取，**任何路径都不回退英文 id**',
    /getCompactToolApi\?\.\(\)\?\.tierText\?\.\(v\.tier\)/.test(stripComments(m2src))
    && /getRangeApi\?\.\(\)\?\.tierText\?\.\(v\.tier\)/.test(stripComments(m2src))
    && !/\?\? v\.tier\b/.test(stripComments(m2src)),
    '异常路径回退 v.tier ⇒ 模型可见文本里冒出 heavy 这类 id');
  /* R22「单源守卫」：compact-tool 的静态兜底与 compact-range 的真值必须逐项相等
   * （两份真值只有在被钉死相等时才允许存在；改一处漏一处当场红）。 */
  {
    const ctMod22 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
    const rMod22 = await import(pathToFileURL(join(PLUGIN, 'compact-range.mjs')).href);
    const api22 = ctMod22.createCompactTool({
      svc: (k) => (k === 'tools' ? { register: () => {} } : null),
      tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
      pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
      state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
      getDefineTool: () => (x) => x, getRangeApi: rangeStub,
    });
    const fb = api22.TIER_DISPLAY_FALLBACK ?? {};
    const bad = rMod22.TIER_NAMES.filter((t) => fb[t]?.label !== rMod22.TIER_LABELS[t]
      || fb[t]?.pct !== Math.round(rMod22.TIERS[t] * 100));
    ok('R22 单源守卫：compact-tool 的展示兜底与 compact-range 的标签/比例**逐项相等**',
      rMod22.TIER_NAMES.every((t) => fb[t]) && bad.length === 0,
      `不一致：${JSON.stringify(bad.map((t) => `${t}: fallback=${JSON.stringify(fb[t])} 真值=${rMod22.TIER_LABELS[t]}/${Math.round(rMod22.TIERS[t] * 100)}%`))}`);
  }

  /* 行为级：真跑 compact-tool，并注入**真实 range 模块**（= 生产同款接线） */
  const ctMod19 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  let spec19 = null;
  const api19 = ctMod19.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (sp) => { spec19 = sp; return sp; }, getRangeApi: rangeStub,
  });
  api19.ensure();
  ok('R19 行为级：三档说法 = 深压8% / 标准16% / 浅压24%（由 TIERS 推导）',
    api19.tierText('light') === '深压8%' && api19.tierText('standard') === '标准16%' && api19.tierText('heavy') === '浅压24%',
    `实际 ${api19.tierText('light')} / ${api19.tierText('standard')} / ${api19.tierText('heavy')}`);
  const brief19 = api19.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? '';
  ok('R19 行为级：一次性教学用中文说法（英文只作「可传值」出现，不作展示标签）',
    /深压8%/.test(brief19) && /标准16%/.test(brief19) && /浅压24%/.test(brief19)
    && !/\*\*light\*\*/.test(brief19) && !/\*\*heavy\*\*/.test(brief19),
    '教学里仍以英文档位名作展示');
  const card19 = api19.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, deltaTokens: 50000, turnsToLine: 5, tierName: 'heavy', tierDeclared: true }) ?? '';
  ok('R19 行为级：卡片的「当前档位」与档位行都用中文说法',
    /当前档位：浅压24%（已登记）/.test(card19) && /深压8%/.test(card19) && /标准16%/.test(card19)
    && !/\*\*heavy\*\*/.test(card19) && !/当前档位：heavy/.test(card19),
    '卡片仍是英文/旧词');
  const run19 = (args) => (spec19?.execute ? spec19.execute(args, { agent: { session: { id: 'sess-r19' } } }) : Promise.resolve(null));
  const vAlias = await run19({ tier: '浅压', action: 'set-tier' });
  const vId = await run19({ tier: 'heavy', action: 'set-tier' });
  const vBad = await run19({ tier: 'nope', action: 'set-tier' });
  ok('R22 行为级：`tier` 中英都能传（含卡片上的完整写法「浅压24%」）；对外回**中文标签**',
    vAlias?.tier === '浅压24%' && /浅压24%/.test(vAlias?.verify ?? '') && vId?.tier === '浅压24%'
    && vBad?.tier === '标准16%' && /标准16%/.test(vBad?.verify ?? ''),
    `alias=${vAlias?.tier} id=${vId?.tier} bad=${vBad?.tier}`);
  ok('R22 行为级：**对外一律中文标签，内部与持久化仍是 id**（改说法不破坏老会话兼容）',
    vAlias?.tier === '浅压24%' && vId?.tier === '浅压24%' && !/[A-Za-z]/.test(String(vAlias?.tier))
    && api19.tierText('heavy') === '浅压24%' && api19.getTier('sess-r19-never') === 'standard',
    `out=${vAlias?.tier}（不得含英文字母）；内部 id 仍为 heavy/standard/light`);
}

/* ═══════════ 6.25 R20：卡片对称化 + 越线反向建议 ═══════════
 * 用户同意（2026-10-15）后实现，针对「Agent 都爱用浅压24%」的**结构性成因**：
 *   ① 卡片原先只量化**多留的好处**（「若先声明浅压24% 少丢多少」），从不说多留的代价
 *      （压后占用更高 ⇒ 更早再压一次，而每次压缩都要付摘要 LLM + 缓存重置）；
 *   ② 越线时只说「立刻声明档位」而不说选哪档 —— 顺手选浅压 ⇒ 压完仍在线上
 *      ⇒ 走「追加官方 overflow 收口」再压一次（m3 里确有这条路径）= 白多压一轮。 */
console.log('\n== 6.25 R20：卡片对称化 + 越线反向建议 ==');
{
  const cardOver20 = ctApi.renderCard({ ratio: 0.8, minRatio: 0.2, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 800000, deltaTokens: 50000 }) ?? '';
  const cardUnder20 = ctApi.renderCard({ ratio: 0.5, minRatio: 0.2, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, usedTokens: 500000, deltaTokens: 50000 }) ?? '';
  ok('R20 静态：卡片改为**双方向**数字（含压后占用与距线轮数），单方向建议已删',
    /const dirLine = /.test(ct) && /const afterOf = /.test(ct) && !/若先声明「\$\{textOf\('heavy'\)\}」（保留/.test(ct),
    '仍是单方向劝导 ⇒ 「Agent 都爱用浅压」的结构性成因没消除');
  ok('R20 行为级：两个方向都给出「丢多少 + 压后占用 + 距线轮数」',
    /两个方向（选一个）/.test(cardOver20) && /浅压24%（留 240k）⇒ 丢 ~/.test(cardOver20)
      && /深压8%（留 80k）⇒ 丢 ~/.test(cardOver20) && /压后占用 ≈/.test(cardOver20) && /距 75% ≈/.test(cardOver20)
      && /多留 ⇒ 压后高、下次压缩更早；少留 ⇒ 余量大、摘要更早/.test(cardOver20),
    `实际：${cardOver20.slice(0, 160)}…`);
  ok('R20 行为级：越线卡**指明选更深的档**并解释「压了等于没压」（白多压一轮）',
    /已越强制线/.test(cardOver20) && /声明「深压8%」或「标准16%」/.test(cardOver20)
      && /压了等于没压/.test(cardOver20) && /白多压一轮/.test(cardOver20),
    '越线仍不指明档位 ⇒ 选浅压会触发官方 overflow 收口再压一次');
  ok('R20 行为级：未越线卡不出现越线建议（随占用状态自适应仍成立）',
    /尚在强制线之下/.test(cardUnder20) && !/已越强制线/.test(cardUnder20),
    '未越线却报越线 ⇒ 会误导模型立刻声明深档');
  /* R19 收尾：卡片里**不应再出现任何英文档位 id**（含「不要调用（或改用 heavy）」这类边角）。 */
  ok('R19/R20：决策卡内不出现英文档位 id（展示面彻底中文）',
    !/\blight\b/.test(cardOver20) && !/\bstandard\b/.test(cardOver20) && !/\bheavy\b/.test(cardOver20),
    '卡片里仍有英文 id ⇒ 展示面中英混杂');
}

/* ═══════════ 6.26 R21：语义锚点保留（A/B + 降级链 text→recentUser→tier） ═══════════
 * 用户场景（2026-10-15）：「600k 里含新旧两个需求，最新需求只在最后 6% ⇒ 选深压8% 收益最大……
 * **Agent 能知道新旧 2 个需求的节点在哪么？**」
 * 结论：语义边界只有模型知道、物理节点只有插件知道 ⇒ 模型**指位置**（锚点），插件**算预算**。
 * 兜底链：`text` 锚点 → `recentUser` 锚点 → **现有三档** → 标准16%，每一跳都留痕。 */
console.log('\n== 6.26 R21：语义锚点保留（A/B + 降级链）==');
{
  const R21 = read('compact-range.mjs');
  /* 假会话：system head + 旧需求(两条) + 插件注入的用量行 + 新需求 + 近端 assistant/tool */
  const ev21 = {
    10: { type: 'system/message', data: {} },
    11: { type: 'user/message', data: { source: { kind: 'user' }, content: '旧需求A：重构 X' } },
    12: { type: 'assistant/message', data: { message: { content: 'ok' } } },
    13: { type: 'user/message', data: { source: { kind: 'user' }, content: '旧需求B：继续' } },
    14: { type: 'user/message', data: { source: { kind: 'context-pilot' }, content: 'Context usage 行' } },
    15: { type: 'user/message', data: { source: { kind: 'user' }, content: '新需求：把档位说法改中文' } },
    16: { type: 'assistant/message', data: { message: { content: '好' } } },
    17: { type: 'tool/result', data: { message: { content: 'out' } } },
  };
  const s21 = { surface: { nodes: [10, 11, 12, 13, 14, 15, 16, 17] }, eventAt: (q) => ev21[q] };
  const toks21 = { 10: 2000, 11: 100000, 12: 5000, 13: 80000, 14: 50, 15: 20000, 16: 3000, 17: 7000 };
  const m21 = { nodes: s21.surface.nodes.map((q) => ({ seq: q, tokens: toks21[q] })) };
  const textOf21 = (e) => String(e?.type === 'user/message' ? e.data?.content : e?.data?.message?.content ?? '');
  const W21 = 1_000_000;

  ok('R21 纯函数：找「第 N 条真用户消息」（**跳过插件注入的用量行**）',
    rangeMod19.recentUserSeq(s21, 1) === 15 && rangeMod19.recentUserSeq(s21, 2) === 13 && rangeMod19.recentUserSeq(s21, 9) === null,
    `实际 1→${rangeMod19.recentUserSeq(s21, 1)} 2→${rangeMod19.recentUserSeq(s21, 2)}`);
  ok('R21 纯函数：文本锚点**先比前缀**（最精确）、再退化为包含匹配，都取最近一条',
    rangeMod19.findUserSeqByText(s21, '新需求：把档位', textOf21)?.via === 'text-prefix'
    && rangeMod19.findUserSeqByText(s21, '档位说法改中文', textOf21)?.via === 'text-contains'
    && rangeMod19.findUserSeqByText(s21, '不存在的片段', textOf21) === null,
    '前缀/包含两档语义不清 ⇒ B 锚点定位会漂');
  const a21 = rangeMod19.resolveAnchorBudget({ session: s21, measurement: m21, want: { recentUser: 1 }, window: W21, textOf: textOf21 });
  const b21 = rangeMod19.resolveAnchorBudget({ session: s21, measurement: m21, want: { text: '新需求' }, window: W21, textOf: textOf21 });
  ok('R21 纯函数：A/B 两形态都能算出预算（= 锚点→末尾 token + 余量，并夹到下限 40k）',
    a21.ok === true && a21.seq === 15 && a21.tokens === 30000 && a21.budget === 40000 && a21.clamped === true
    && b21.ok === true && b21.via === 'text-prefix' && b21.budget === 40000,
    `A=${JSON.stringify(a21)} B=${JSON.stringify(b21)}`);
  const chain21 = rangeMod19.resolveAnchorBudget({ session: s21, measurement: m21, want: { text: '不存在', recentUser: 1 }, window: W21, textOf: textOf21 });
  const dead21 = rangeMod19.resolveAnchorBudget({ session: s21, measurement: m21, want: { text: '不存在', recentUser: 9 }, window: W21, textOf: textOf21 });
  ok('R21 降级链：text 失败 ⇒ **退 recentUser**（并带回 tried 痕）；两者都失败 ⇒ ok:false（调用方退三档）',
    chain21.ok === true && chain21.via === 'recent-user' && chain21.tried.includes('text:not-found')
    && dead21.ok === false && dead21.reason === 'text:not-found|recent-user:not-found',
    `chain=${JSON.stringify(chain21)} dead=${JSON.stringify(dead21)}`);
  const selSmall = rangeMod19.selectRange({ session: s21, measurement: m21, retainTokens: 5000, keepFromSeq: 15 });
  const selBig = rangeMod19.selectRange({ session: s21, measurement: m21, retainTokens: 40000, keepFromSeq: 15 });
  ok('R21 护栏：小预算时范围**被拉到锚点**（绝不越过），且 retainedTokens **按真实边界重算**',
    selSmall.ok === true && selSmall.anchorIdx === 5 && selSmall.endIdx === 4 && selSmall.retainedTokens === 30000,
    `实际 ${JSON.stringify({ a: selSmall.anchorIdx, e: selSmall.endIdx, r: selSmall.retainedTokens })}`);
  ok('R21 护栏：预算已比锚点更保守时不额外收紧（护栏是**下限**，不是硬边界）',
    selBig.ok === true && selBig.endIdx < 5 && selBig.anchorIdx === 5,
    `实际 endIdx=${selBig.endIdx} anchorIdx=${selBig.anchorIdx}`);

  /* ---- 工具侧：参数 → 会话偏好 → 落盘往返 ---- */
  const tmp21 = mkdtempSync(join(tmpdir(), 'dcp-r21-'));
  const mk21 = async (dir) => {
    const mod = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
    let sp = null;
    const api = mod.createCompactTool({
      svc: (k) => (k === 'tools' ? { register: () => {} } : null),
      tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
      pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
      state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
      getDefineTool: () => (x) => { sp = x; return x; }, getRangeApi: rangeStub, pluginDir: dir,
    });
    api.ensure();
    return { api, spec: () => sp };
  };
  const A21 = await mk21(tmp21);
  const run21 = (args) => A21.spec().execute(args, { agent: { session: { id: 'sess-r21' } } });
  const vKeep = await run21({ tier: '深压', action: 'set-tier', keepFrom: { recentUser: 2 } });
  ok('R21 工具：`keepFrom` 被登记为会话偏好，回执**说清"压缩时解析、失败退档位"**',
    A21.api.getAnchor('sess-r21')?.recentUser === 2
    && /语义锚点已登记/.test(vKeep?.verify ?? '') && /压缩时解析，失败自动退档位/.test(vKeep?.verify ?? ''),
    `anchor=${JSON.stringify(A21.api.getAnchor('sess-r21'))} verify=${(vKeep?.verify ?? '').slice(0, 80)}…`);
  const B21 = await mk21(tmp21);   // 新实例 = toggle 热换
  ok('R21 工具：锚点**随档位一起落盘**（跨 toggle/重启仍有效）',
    B21.api.getAnchor('sess-r21')?.recentUser === 2 && B21.api.getTier('sess-r21') === 'light',
    `restored anchor=${JSON.stringify(B21.api.getAnchor('sess-r21'))} tier=${B21.api.getTier('sess-r21')}`);
  const vNoKeep = await B21.spec().execute({ tier: '标准', action: 'set-tier' }, { agent: { session: { id: 'sess-r21' } } });
  ok('R21 工具：本次**不带 keepFrom ⇒ 清除**旧锚点（"忘记重申"退化为按档位 = 安全方向）',
    B21.api.getAnchor('sess-r21') === null && B21.api.getTier('sess-r21') === 'standard' && /语义锚点/.test(vNoKeep?.verify ?? '') === false,
    `anchor=${JSON.stringify(B21.api.getAnchor('sess-r21'))}`);
  const anchorBad = B21.api.normAnchor({ recentUser: 9 });
  const anchorTxt = B21.api.normAnchor({ text: '  a   b  ' });
  ok('R21 工具：锚点形状校验（越界 recentUser 视为非法；text 归一化空白并截断）',
    anchorBad.invalid === true && anchorBad.anchor === null && anchorTxt.anchor?.text === 'a b',
    `bad=${JSON.stringify(anchorBad)} txt=${JSON.stringify(anchorTxt)}`);
  rmSync(tmp21, { recursive: true, force: true });

  /* ---- 接线与回执（源码级：源码里必须存在"来源可见"这条痕） ---- */
  ok('R21 接线：压缩点**在压缩那一刻**解析锚点，并把来源/失败原因写进取证与回执',
    /resolveAnchorBudget\(\{/.test(read('m3.compact.mjs'))
    && /state\.m3\.anchorProbe = \{/.test(read('m3.compact.mjs'))
    && /retainSource: out\.retainSource \?\?/.test(read('m3.compact.mjs'))
    && /anchorFailReason: out\.anchorFailReason \?\?/.test(read('m3.compact.mjs'))
    && /保留来源：语义锚点/.test(m2src) && /锚点未命中/.test(m2src),
    '锚点结果不可见 ⇒ 静默降级（模型以为锚点生效了）');
}

/* ═══════════ 6.27 R21.1：工具 spec **结构化**自检（防「schema 被拒 ⇒ 工具静默不注册」） ═══════════
 * 真机事故（2026-10-15）：R21 新增的 `keepFrom` 是 `type:'object'` 却没写 `additionalProperties`
 * ⇒ `defineTool` 抛
 *   `unsupported JSON schema: parameters.keepFrom.additionalProperties must be explicitly true or false`
 * ⇒ **整个 `compact_context` 静默不注册**（模型看不到、调不了，而教学/卡片仍在喊"调用 compact_context"）。
 * 同型事故：R16.16 的 `required: false`（同样"静默不注册"）。
 * ⚠️ **既有断言为什么没抓住**：测试桩 `getDefineTool: (sp) => sp` **绕过了 defineTool 的 schema 校验**。
 * ⇒ 本段**直接遍历真实 spec 对象**（不依赖真 defineTool 可用），把规则显式钉住。 */
console.log('\n== 6.27 R21.1：工具 spec 结构化自检（防静默不注册）==');
{
  let specC = null;
  let specE = null;
  const ctMod27 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  const eMod27 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  ctMod27.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (sp) => { specC = sp; return sp; }, getRangeApi: rangeStub,
  }).ensure();
  eMod27.createEffort({
    svc: (k) => (k === 'tools' ? { register: () => () => {}, restrict: () => () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {} } }, readCfg: () => ({ enabled: true, cooldownMs: 30000 }),
    getDefineTool: () => (sp) => { specE = sp; return sp; },
  }).ensure();
  /** 逐条对应 defineTool 的真实报错（见 R16.16 / R21.1 两次事故）。
   * ⚠️ 千万注意顶层形态：`spec.parameters` **本身就是「参数名 → schema」的映射**（没有 `.properties`），
   * 写成「从 parameters 取 .properties」会**一个参数都遍历不到** ⇒ 断言恒真（本段首版就栽在这，
   * 变异 M1 只红了一条窄断言、结构化那条静默通过 —— 又一次"虚假信心"）。 */
  const specErrs = (spec, label) => {
    const errs = [];
    const visit = (def, path) => {
      if (def === null || typeof def !== 'object') return;
      if (def.type === 'object') {
        if (typeof def.additionalProperties !== 'boolean') errs.push(`${path}: object 缺 additionalProperties`);
        if (def.properties === undefined || typeof def.properties !== 'object') errs.push(`${path}: object 缺 properties`);
      }
      if ('required' in def && def.required !== true) errs.push(`${path}: required 必须为 true 或省略（写成 false 会被拒）`);
      for (const [k, v] of Object.entries(def.properties ?? {})) visit(v, `${path}.${k}`);
    };
    for (const [k, v] of Object.entries(spec?.parameters ?? {})) visit(v, `${label}.parameters.${k}`);
    const out = spec?.output?.schema;
    if (out?.additionalProperties !== false) errs.push(`${label}.output.schema: 必须 additionalProperties:false`);
    for (const [k, v] of Object.entries(out?.properties ?? {})) visit(v, `${label}.output.schema.${k}`);
    return errs;
  };
  const errsAll = [...specErrs(specC, 'compact_context'), ...specErrs(specE, 'set_reasoning_effort')];
  ok('R21.1 结构化自检：**两个工具**的 spec 全量通过 defineTool 的 schema 规则（桩绕不过这一层）',
    !!specC && !!specE && errsAll.length === 0,
    `违规 ${errsAll.length} 处：${JSON.stringify(errsAll).slice(0, 300)}`);
  ok('R21.1 回归：`keepFrom` 显式声明 `additionalProperties`（本次事故的直接原因）',
    specC?.parameters?.keepFrom?.additionalProperties === false
    && specC?.parameters?.keepFrom?.properties?.recentUser?.type === 'number'
    && specC?.parameters?.keepFrom?.properties?.text?.type === 'string',
    '再漏一次 = 工具整条不可用（模型调不了，教学还在喊它）');
}

/* ═══════════ 6.28 R21.2：真机发现的两处缺陷（档位沿用 / 锚点失败痕丢失） ═══════════
 * 2026-10-15 真机多轮测试（本会话 614k 上下文）发现，**都是行为级、报告字段直接可证**：
 *  ① **不传 `tier` 会重置档位**：卡片/文档都写「不传 = 沿用已登记档位（不是重置）」，但旧实现把
 *     `args.tier == null` 也交给 normTier ⇒ 返回 standard ⇒ setTier **覆盖并落盘**。
 *     真机实测：compact-tier.json 里本会话从 `heavy` 变成 `standard`（模型只传了 keepFrom）。
 *  ② **锚点失败痕丢失**：`nothing-to-compact` 那条提前 return 没带 retainSource/anchorFailReason ⇒
 *     verify 里 retainSource 靠 `?? 'tier'` 猜（值碰巧对、语义是猜的），anchorFailReason 变 null ⇒
 *     回执只剩「已执行但判定无需压缩」，**降级链断了**（本项目大忌）。 */
console.log('\n== 6.28 R21.2：档位沿用 + 锚点失败痕（真机缺陷回归）==');
{
  /* ---- ① 档位：不传 tier = 沿用（真工具 + 真落盘往返）---- */
  const tmp212 = mkdtempSync(join(tmpdir(), 'dcp-r212-'));
  const ctMod212 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  const mk212 = (dir) => {
    let sp = null;
    const api = ctMod212.createCompactTool({
      svc: (k) => (k === 'tools' ? { register: () => {} } : null),
      tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
      pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
      state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
      getDefineTool: () => (x) => { sp = x; return x; }, getRangeApi: rangeStub, pluginDir: dir,
    });
    api.ensure();
    return { api, spec: () => sp };
  };
  const X212 = mk212(tmp212);
  const run212 = (args) => X212.spec().execute(args, { agent: { session: { id: 'sess-r212' } } });
  await run212({ tier: '浅压', action: 'set-tier' });                                   // 显式登记 浅压24%
  const carried = await run212({ action: 'set-tier', keepFrom: { recentUser: 1 } });    // 不传 tier
  ok('R21.2 行为级①：**不传 tier ⇒ 沿用**已登记档位（真机实测曾被静默重置成 标准16%）',
    X212.api.getTier('sess-r212') === 'heavy' && /档位沿用/.test(String(carried?.verify ?? '')),
    `tier=${X212.api.getTier('sess-r212')}（期望 heavy）verify=${String(carried?.verify ?? '').slice(0, 70)}…`);
  const Y212 = mk212(tmp212);   // 新实例 = toggle 热换 ⇒ 从落盘读
  ok('R21.2 行为级①：沿用还要**落盘保住原档位**（真机实测落盘文件被写成 standard）',
    Y212.api.getTier('sess-r212') === 'heavy', `restored tier=${Y212.api.getTier('sess-r212')}（期望 heavy）`);
  const changed = await run212({ tier: '深压', action: 'set-tier' });
  ok('R21.2 行为级①：显式传 tier 时**照常改档**（沿用 ≠ 锁死）',
    X212.api.getTier('sess-r212') === 'light' && /档位已登记为/.test(String(changed?.verify ?? '')),
    `tier=${X212.api.getTier('sess-r212')}（期望 light）`);
  ok('R21.2 行为级①：**从未登记**且不传 tier ⇒ 标准16%（兜底语义不变）',
    X212.api.getTier('sess-r212-never') === 'standard', `tier=${X212.api.getTier('sess-r212-never')}`);
  rmSync(tmp212, { recursive: true, force: true });

  /* ---- ② 锚点失败痕：必须活过「无需压缩」与「官方兜底」两条路径，并出现在回执里 ---- */
  const m3Mod212 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const mk3212 = (selResult, officialImpl) => {
    const st = { m3: {} };
    const api = m3Mod212.createM3Compaction({
      state: st, log: () => {}, msg: (e) => String(e?.message ?? e), pick: (...a) => a.find((x) => x != null),
      tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
      nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? e?.message ?? 'err'), schedule: () => {},
      svc: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.8,
      resolveCompactionFor: () => ({ service: { compactIfNeeded: officialImpl ?? (async () => ({ shadowedTokenCount: 5 })), compactRegion: async () => ({ shadowedTokenCount: 5 }) }, via: 'stub' }),
      publishHud: () => {}, recordHudAct: () => {}, formatAct: () => 'x', clearBriefed: () => {},
      awaitRange: async () => ({
        selectRange: () => selResult, isEndBoundaryError: () => false, prevEnd: () => null, MAX_WALK_BACK: 64,
        RETAIN_RATIO: 0.16, retainBudgetTokens: () => 160000,
      }),
      getCompactTool: () => null, COMPACT_TIMEOUT_MS: 180000, SET_CAP: 200,
      markOwnCompaction: () => {}, clearOwnCompaction: () => {},
    });
    return { api, st };
  };
  const ctx212 = (extra) => ({
    forced: false, sig: 'sig-212', sid: 'sess-r212', window: 1000000,
    measure: { ok: true, nodes: [], tokens: 0 }, tierName: 'standard',
    retainOverride: null, anchorSeq: null, anchorFailReason: 'text:not-found', ...extra,
  });
  const P212 = mk3212({ ok: false, why: 'nothing-to-compact', firstIdx: 1, retainedTokens: 1234 });
  const outNoNeed = await P212.api.compactWithOwnRange({ session: { surface: { nodes: [] } } }, { service: { compactIfNeeded: async () => null } }, ctx212());
  ok('R21.2 行为级②：「无需压缩」提前 return 必须带 **retainSource + 锚点失败原因**（真机实测两者都丢）',
    outNoNeed?.source === 'none' && outNoNeed?.retainSource === 'tier' && outNoNeed?.anchorFailReason === 'text:not-found',
    `实际 ${JSON.stringify(outNoNeed)}`);
  const P212b = mk3212({ ok: false, why: 'boundary-exhausted', firstIdx: 1 });
  const outOfficial = await P212b.api.compactWithOwnRange({ session: { surface: { nodes: [] } } }, { service: { compactIfNeeded: async () => ({ shadowedTokenCount: 7 }) } }, ctx212({ retainedTokens: undefined, forced: true })); // R72（H2）：未越强制线已不再回落官方
  ok('R21.2 行为级②：**官方兜底**路径同样必须带 retainSource + 锚点失败原因',
    outOfficial?.source === 'official' && outOfficial?.retainSource === 'tier' && outOfficial?.anchorFailReason === 'text:not-found',
    `实际 ${JSON.stringify(outOfficial)}`);
  /* 端到端（m3 产物 → m2 回执）：把 m3 真实返回的字段按 preStep 的写法拼成 verify，回执必须出现降级句。 */
  const verify212 = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'no-need', tier: outNoNeed.tier ?? 'standard',
    retainBudget: outNoNeed.retainBudget, retainSource: outNoNeed.retainSource, anchorFailReason: outNoNeed.anchorFailReason,
    rangeSource: 'none', skipWhy: outNoNeed.skipWhy, ms: 0,
  };
  const m2out = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(verify212))
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R21.2 端到端：锚点未命中 + 判定无需压缩 ⇒ 回执**必须**出现「锚点未命中（text:not-found）⇒ 已按档位兜底」',
    /锚点未命中（text:not-found）⇒ 已按档位兜底/.test(m2out?.text ?? '') && /已执行但判定无需压缩/.test(m2out?.text ?? ''),
    `实际：${String(m2out?.text ?? '').slice(0, 160)}`);
}

/* ═══════════ 6.29 R22：档位说法全中文——**模型可见面英文 id 清零**（用户要求的机器化表达） ═══════════
 * 用户原话：「模式行动前，不会再说 heavy 或 standard 等英文吧？而且前面修改的中文深压8% 或 标准16% 等」。
 * 审计发现三条泄漏路径（都不是教学/卡片，而是**运行期产物**）：① 工具返回值 `{"tier":"heavy"}`；
 * ② m2 回执的 `?? v.tier` 兜底；③ m3 HUD 行的 `?? 'standard'`。另有一个隐患：`canonicalTier` 不认
 * 卡片上的完整写法「浅压24%」⇒ 模型照卡片回填会 unknown ⇒ **静默退回标准16%**。
 * 本段把「模型可见文本里不得出现英文档位 id」变成可执行断言（逐段文本扫描，不是源码正则）。 */
console.log('\n== 6.29 R22：档位说法全中文（模型可见面英文 id 清零）==');
{
  const ENG = /(^|[^A-Za-z])(light|standard|heavy)([^A-Za-z]|$)/;
  const rMod29 = await import(pathToFileURL(join(PLUGIN, 'compact-range.mjs')).href);
  ok('R22 纯函数：`canonicalTier` 接受卡片上的**完整中文写法**（「浅压24%」「深压8%」「标准16%」）',
    rMod29.canonicalTier('浅压24%').tier === 'heavy' && rMod29.canonicalTier('浅压24%').known === true
    && rMod29.canonicalTier('深压8%').tier === 'light' && rMod29.canonicalTier('标准16%').tier === 'standard',
    `实际 ${JSON.stringify(['浅压24%', '深压8%', '标准16%'].map((x) => rMod29.canonicalTier(x)))}`
    + ' —— 不认 ⇒ 模型照卡片回填会被当成 unknown，静默退回标准16%');

  const tmp29 = mkdtempSync(join(tmpdir(), 'dcp-r22-'));
  const ctMod29 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  let spec29 = null;
  const api29 = ctMod29.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (x) => { spec29 = x; return x; }, getRangeApi: rangeStub, pluginDir: tmp29,
  });
  api29.ensure();
  const run29 = (args, sid = 'sess-r22') => spec29.execute(args, { agent: { session: { id: sid } } });
  const texts = [
    ['工具 description', String(spec29.description ?? '')],
    ['参数 tier 说明', String(spec29.parameters?.tier?.description ?? '')],
    ['参数 keepFrom 说明', String(spec29.parameters?.keepFrom?.description ?? '')],
    ['一次性教学 brief', api29.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? ''],
    ['卡片·未登记', api29.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'standard', tierDeclared: false, tierState: 'none', usedTokens: 500000, deltaTokens: 50000, turnsToLine: 5 }) ?? ''],
    ['卡片·已登记+落盘恢复', api29.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'heavy', tierDeclared: true, tierState: 'restored', usedTokens: 500000, deltaTokens: 10000, turnsToLine: 20 }) ?? ''],
    ['卡片·越线', api29.renderCard({ ratio: 0.78, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'heavy', tierDeclared: true, tierState: 'declared' }) ?? ''],
  ];
  for (const [name, args] of [
    ['回执·set-tier 显式', { action: 'set-tier', tier: '浅压' }],
    ['回执·set-tier 沿用', { action: 'set-tier', keepFrom: { recentUser: 1 } }],
    ['回执·compact', { reason: 'x', keepFrom: { text: '测试文本' } }],
    ['回执·非法档位兜底', { action: 'set-tier', tier: 'nope' }],
    ['回执·非法锚点', { action: 'set-tier', tier: '深压', keepFrom: { recentUser: 9 } }],
  ]) {
    const r = await run29(args);
    texts.push([name, `${r?.verify ?? ''}｜tier=${r?.tier ?? ''}`]);
  }
  const leaks = texts.filter(([, t]) => ENG.test(t)).map(([n, t]) => `${n}→${String(t.match(ENG)?.[0]).trim()}`);
  ok('R22 行为级：**模型可见的每一段文本**（description / 两个参数说明 / brief / 三种卡片 / 五种回执）都不含英文档位 id',
    leaks.length === 0, `泄漏 ${leaks.length} 处：${JSON.stringify(leaks).slice(0, 300)}`);
  /* 兜底路径：**范围域未加载**时也要保持中文（旧 `labelOf` 兜底是 `String(t)` ⇒ 会吐 `standard16%`，
   * 这正是真机审计抓到的形态）。 */
  const api29b = ctMod29.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: { calls: 0 } } }, readCfg: () => ({ enabled: true }),
    getDefineTool: () => (x) => x, getRangeApi: () => ({}),
  });
  api29b.ensure();
  const degraded = [
    ['brief（兜底路径）', api29b.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 }) ?? ''],
    ['card（兜底路径）', api29b.renderCard({ ratio: 0.5, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000, tierName: 'heavy', tierDeclared: true, tierState: 'restored' }) ?? ''],
  ];
  const degLeaks = degraded.filter(([, t]) => ENG.test(t)).map(([n, t]) => `${n}→${String(t.match(ENG)?.[0]).trim()}`);
  ok('R22 行为级：**范围域未加载**时 brief/card 仍不含英文 id（旧兜底会吐 `standard16%` 这类混合形态）',
    degLeaks.length === 0, `泄漏 ${degLeaks.length} 处：${JSON.stringify(degLeaks).slice(0, 200)}`);
  const rTier = await run29({ action: 'set-tier', tier: '浅压' });
  ok('R22 行为级：工具返回值 `tier` 是**中文标签**（真机审计曾见 `{"tier":"heavy"}`）',
    rTier?.tier === '浅压24%' && !/[A-Za-z]/.test(String(rTier?.tier)), `实际 ${JSON.stringify(rTier?.tier)}`);
  rmSync(tmp29, { recursive: true, force: true });

  /* 回执兜底：工具域缺失时**不许回退英文 id**（旧写法 `?? v.tier` 会把 heavy 送进模型可见文本）。 */
  const vHeavy29 = { at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', tier: 'heavy', retainBudget: 240000, shadowedTokens: 1000, rangeSource: 'own', ms: 5 };
  const noApi29 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(vHeavy29))
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R22 端到端：工具域缺失时回执不出现英文 id（退而问范围域 / 都拿不到就不显示档位段）',
    /【压缩自检】/.test(noApi29?.text ?? '') && !ENG.test(noApi29?.text ?? ''),
    `实际：${String(noApi29?.text ?? '').slice(0, 140)}`);
}

/* ═══════════ 6.30 R23：锚点来源 + 思考强度**显示**全中文（用户要求） ═══════════
 * 用户原话：「如果是 keepFrom:{text:'…'} 或 keepFrom:{recentUser:N}，应该怎么显示的？思考强度的改成
 * 中英文，比如低(low)」。
 * 现状审计：① 回执把 `anchor:` 后的**内部 token**（`recent-user`/`text`）直接显示给模型；
 *          ② 思考强度的用量行后缀/一次性教学/错误文案/HUD tooltip 全是裸英文 id。
 * 本节把两件事钉住：锚点用中文描述（含 N 与文本片段）；档位显示统一「中文(id)」，且入参兼容回填。 */
console.log('\n== 6.30 R23：锚点来源与思考强度显示全中文 ==');
{
  const bare = (t) => String(t ?? '').replace(/[\u4e00-\u9fa5]+[（(][A-Za-z0-9_.-]+[)）]/g, '');   // 去掉「中文(id)」后剩下的才是裸 id
  const BARE_LEVEL = /(^|[^A-Za-z])(off|none|minimal|low|medium|mid|high|max|maximum|xhigh|ultra)([^A-Za-z]|$)/;

  /* ---- ① 锚点来源：中文描述，绝不显示内部 token ---- */
  const vAnchor = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', tier: 'heavy',
    retainBudget: 40000, retainSource: 'anchor:recent-user', anchorLabel: '从最近第 1 条你的消息起',
    shadowedTokens: 365000, rangeSource: 'own', ms: 24000,
  };
  const outAnchor = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(vAnchor))
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R23 端到端：锚点生效时回执写**中文描述**（「从最近第 1 条你的消息起」），不出现 `recent-user` 这类内部 token',
    /保留来源：语义锚点（从最近第 1 条你的消息起）/.test(outAnchor?.text ?? '')
    && !/recent-user|anchor:/.test(outAnchor?.text ?? ''),
    `实际：${String(outAnchor?.text ?? '').slice(0, 150)}`);
  const vText = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', tier: 'standard',
    retainBudget: 100000, retainSource: 'anchor:text', anchorLabel: '按文本「上下文600k 新旧两需求」定位',
    shadowedTokens: 1000, rangeSource: 'own', ms: 900,
  };
  const outText = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(vText))
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R23 端到端：`text` 锚点同样用中文描述（含被定位的文本片段）',
    /保留来源：语义锚点（按文本「[^」]+」定位）/.test(outText?.text ?? '') && !/anchor:text/.test(outText?.text ?? ''),
    `实际：${String(outText?.text ?? '').slice(0, 150)}`);
  const vOld = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', tier: 'standard',
    retainBudget: 160000, retainSource: 'anchor:recent-user', shadowedTokens: 1, rangeSource: 'own', ms: 1,
  };
  const outOld = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(vOld))
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R23 端到端：缺 `anchorLabel`（旧回执/降级）时退**中文**兜底，仍不露内部 token',
    /保留来源：语义锚点（你指定的位置）/.test(outOld?.text ?? '') && !/recent-user/.test(outOld?.text ?? ''),
    `实际：${String(outOld?.text ?? '').slice(0, 150)}`);
  ok('R23 接线：m3 产出锚点中文描述（含 recentUser 的 N 与 text 片段），并写进 verify',
    /const anchorLabelOf = \(want\) =>/.test(m3src) && /从最近第 \$\{Number\(want\.recentUser\)\} 条你的消息起/.test(m3src)
    && /按文本「\$\{String\(want\.text\)\.slice\(0, 12\)\}」定位/.test(m3src)
    && /anchorLabel: out\.retainSource/.test(m3src),
    'm3 不给中文描述 ⇒ 回执只能显示内部 token 或空');

  /* ---- ② 思考强度显示：模型可见文本里不许有裸英文档位 ---- */
  const effMod23 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  const effApi23 = effMod23.createEffort({
    svc: () => null,
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortSkips: {}, effortDiag: {}, effortSwitches: 0, effortReasserts: 0, effortHooks: 0 } },
    readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (spec) => spec,
  });
  const effState = { ok: true, current: 'high', efforts: ['off', 'low', 'high', 'max'], pending: true, pendingFrom: 'low', pendingChanged: true, provider: 'p', model: 'm' };
  const ag23 = { id: 'sid-r23', sessionId: 'sid-r23', session: { id: 'sid-r23' } };
  const texts23 = [
    ['用量行后缀', effApi23.renderSuffix(effState) ?? ''],
    ['一次性教学', effApi23.renderBrief(effState) ?? ''],
    ['换档提醒', effApi23.renderNudge(effState, { agent: ag23, turn: 3, userText: '帮我彻底排查根因' }) ?? ''],
  ];
  const leaks23 = texts23.filter(([, t]) => BARE_LEVEL.test(bare(t)))
    .map(([n, t]) => `${n}→${String(BARE_LEVEL.exec(bare(t))?.[0]).trim()}`);
  ok('R23 行为级：用量行后缀 / 一次性教学 / 换档提醒**都**只以「中文(id)」出现档位（剥掉中英混合再扫）',
    leaks23.length === 0 && /高\(high\)/.test(texts23[0][1]) && /最高\(max\)/.test(texts23[0][1]),
    `泄漏 ${leaks23.length} 处：${JSON.stringify(leaks23).slice(0, 240)}`);
  ok('R23 端到端：工具回执/错误文案也用「中文(id)」（源码接线）',
    /verify: `下一次请求起生效为 \$\{effortLabel\(want\)\}/.test(effort)
    && /error: `档位「\$\{effortLabel\(wantInput\)\}」不在当前模型的可选集内。`/.test(effort),
    '工具回执露英文 id ⇒ 模型照抄进正文（正是本次要根治的形态）');
}

/* ═══════════ 6.31 R24：占用口径对齐 DSH 表盘 + 回执报「压缩后占用」 ═══════════
 * 用户真机反馈：「压缩时 DSH 确实显示 75%，压缩完成后显示 40%」——而插件当时报的是
 * `measure().totalTokens`（510k/51%）与档位名「浅压24%」，模型据此在正文里写出「回到 ~24%」。
 * DSH 源码 `ContextMeter.js#contextOccupancy`：`usedTokens = pressure.projectedTokens ?? pressure.pressureTokens`；
 * DSH 文档：`contextBreakdown`（三行）是**启发式组成**、`messageTokens` **含已被取代的提示**、
 * 且三个数都**不含** route image pricing / file-handle projection ⇒ 三套口径按设计不同（差 136K 不是丢内容）。
 * 本节钉住：① used 走 DSH 口径且标明来源；② 差异大时才附启发式 total（不刷屏）；③ 回执念出压缩后占用。 */
console.log('\n== 6.31 R24：占用口径对齐 DSH + 回执「压缩后占用」 ==');
{
  const m3Mod24 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  /* R25：口径公式**唯一一份**在 core.mjs（命名导出给测试、同时挂进 createCore 出口供宿主注入）。 */
  const coreMod25 = await import(pathToFileURL(join(PLUGIN, 'core.mjs')).href);
  const projectedFromPressure = coreMod25.projectedFromPressure;
  const contextLedgerOf = coreMod25.contextLedgerOf;
  const mkM3 = (pressure, total, surface) => m3Mod24.createM3Compaction({
    state: { m3: {} }, log: () => {}, msg: (e) => String(e?.message ?? e),
    pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    projectedFromPressure,
    svc: (k) => (k === 'tokenMeter' ? { measure: () => ({ totalTokens: total, surfaceTokens: surface }) }
      : k === 'sessionProjections' ? { stateOf: () => pressure } : null),
    M3: {}, effEnabled: () => true, criticalCapOf: () => 0.8,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: () => {}, formatAct: () => '', clearBriefed: () => {},
    awaitRange: async () => null, getCompactTool: () => null, COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
  });
  const sess24 = { id: 'sess-r24' };
  const r1 = mkM3({ contextWindow: 1000000, projectedTokens: 408000, pressureTokens: 750000 }, 510000, 248000).measureRatio(sess24);
  ok('R24 行为级：`used` 优先取 **projectedTokens**（下一请求预估）——与 DSH 表盘同口径；total/surface 留作取证',
    r1.ok && r1.used === 408000 && Math.abs(r1.ratio - 0.408) < 1e-9 && r1.basis === '下一请求预估'
    && r1.total === 510000 && r1.surface === 248000,
    `实际 ${JSON.stringify({ used: r1.used, ratio: r1.ratio, basis: r1.basis, total: r1.total })}`
    + ' —— 变异：改回 `used = totalTokens` 时这里给 510000（与用户表盘矛盾）');
  const r2 = mkM3({ contextWindow: 1000000, pressureTokens: 750000 }, 510000, 248000).measureRatio(sess24);
  ok('R24 行为级：无 surface 增量参照时退 **pressureTokens**（provider 实报）并**标明缺参照**',
    r2.used === 750000 && Math.abs(r2.ratio - 0.75) < 1e-9 && r2.basis === 'provider 实报(无增量参照)',
    `实际 ${JSON.stringify({ used: r2.used, basis: r2.basis })}`);
  /* R24.1（当晚自查出的真缺陷）：state 里**没有** projectedTokens（只有 wire.view 才有）⇒
   * 必须自算 `pressure + surface − sampled`；不自算就会退回**过期的** provider 值（真机 748,806/74.9%，
   * 而表盘当时已是 51%/40%）。本用例的三个数就是真机 session-54597a24 压缩后那一帧。 */
  const r4 = mkM3({ contextWindow: 1000000, pressureTokens: 748806, surfaceTokens: 247859, sampledSurfaceTokens: 487049 }, 510484, 245699).measureRatio(sess24);
  ok('R24.1 行为级：state 无 projectedTokens 时**自算**「provider 实报 + surface 增量」= 509,616（不是过期的 748,806）',
    r4.used === 509616 && Math.abs(r4.ratio - 0.509616) < 1e-9 && r4.basis === '下一请求预估(自算)'
    && r4.total === 510484 && r4.surface === 245699,
    `实际 ${JSON.stringify({ used: r4.used, ratio: r4.ratio, basis: r4.basis })}`
    + ' —— 变异：退回 `pressureTokens` 时这里给 748806（压缩前旧值 ⇒ 插件与表盘再次矛盾）');
  const r3 = mkM3({ contextWindow: 1000000 }, 510000, 248000).measureRatio(sess24);
  ok('R24 行为级：两条都取不到才退本地启发式，且**标明**是退化口径（不冒充 provider 数）',
    r3.used === 510000 && r3.basis === '本地启发式(退化)',
    `实际 ${JSON.stringify({ used: r3.used, basis: r3.basis })}`);

  const apiR24 = (measure) => mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, measure);
  const line24 = apiR24(() => ({ ok: true, used: 408000, total: 510000, surface: 248000, window: 1000000, ratio: 0.408, basis: '下一请求预估', measure: {} }))
    .renderUsageText(sess24);
  ok('R24 端到端：用量行用 DSH 口径 + **标明来源**；启发式 total 差异大时附上（让两个数都可解释）',
    /used 408000 \(40\.8%, 下一请求预估\)/.test(line24?.text ?? '')
    && /surface 248000/.test(line24?.text ?? '') && /heuristic total 510000/.test(line24?.text ?? ''),
    `实际：${JSON.stringify(String(line24?.text ?? '').slice(0, 200))}`);
  const line24b = apiR24(() => ({ ok: true, used: 750000, total: 751000, surface: 248000, window: 1000000, ratio: 0.75, basis: 'provider 实报', measure: {} }))
    .renderUsageText(sess24);
  ok('R24 行为级：两口径接近（<5%）时**不附**启发式 total（每轮注入不涨噪声）',
    !/heuristic total/.test(line24b?.text ?? '') && /provider 实报/.test(line24b?.text ?? ''),
    `实际：${JSON.stringify(String(line24b?.text ?? '').slice(0, 200))}`);

  /* R25：口径公式的唯一一份实现 + **单源守卫**（禁止在 m3/m1 里重写公式——R22/R23 的重复实现教训）。 */
  const P24 = { contextWindow: 1000000, pressureTokens: 748806, surfaceTokens: 247859, sampledSurfaceTokens: 487049 };
  const pf24 = projectedFromPressure(P24);
  ok('R25 纯函数：`projectedFromPressure` 自算 DSH 投影（真机三数 ⇒ 509,616）+ 降级链各自**标明来源**',
    pf24.used === 509616 && pf24.projected === 509616 && pf24.basis === '下一请求预估(自算)'
    && projectedFromPressure({ projectedTokens: 408000, pressureTokens: 748806 }).basis === '下一请求预估'
    && projectedFromPressure({ pressureTokens: 748806 }).basis === 'provider 实报(无增量参照)'
    && projectedFromPressure({ contextWindow: 1000000 }).used === null
    && projectedFromPressure(undefined).basis === '无 provider 数据',
    `实际 ${JSON.stringify([pf24.basis, projectedFromPressure({ pressureTokens: 1 }).basis, projectedFromPressure(null).basis])}`);
  const ledger24 = contextLedgerOf(P24, { totalTokens: 510484, surfaceTokens: 245699 },
    { breakdown: { systemTokens: 2161, messageTokens: 200000, toolsTokens: 58256 } });
  ok('R25 纯函数：`contextLedgerOf` 账本 = 表盘口径 + 启发式总量 + **三行分项** + 两口径之差（真机 249,199）',
    ledger24.projected === 509616 && ledger24.heuristicTotal === 510484
    && ledger24.breakdown?.system === 2161 && ledger24.breakdown?.tools === 58256 && ledger24.breakdown?.messages === 200000
    && ledger24.breakdownSum === 260417 && ledger24.gapVsBreakdown === 249199,
    `实际 ${JSON.stringify(ledger24)}`);
  ok('R25 单源守卫：公式只在 core.mjs 一份 —— m3 只调用注入的 `projectedFromPressure`，自己不再重写 `Math.max(...)`',
    /Math\.max\(0, reported \+ surface - sampled\)/.test(coreSrc)
    && !/Math\.max\(0, reported/.test(m3src)
    && /const proj = projectedFromPressure\(pressureRec\);/.test(m3src)
    && /projectedFromPressure, contextLedgerOf,/.test(coreSrc)
    && (host.match(/projectedFromPressure/g) ?? []).length >= 2
    && (host.match(/contextLedgerOf/g) ?? []).length >= 2,
    `实际 core 有公式=${/Math\.max\(0, reported \+ surface - sampled\)/.test(coreSrc)}, m3 仍自带=${/Math\.max\(0, reported/.test(m3src)}, host 注入 projected=${(host.match(/projectedFromPressure/g) ?? []).length} 次 / ledger=${(host.match(/contextLedgerOf/g) ?? []).length} 次`);
  ok('R25 接线：m1 每次快照落**占用账本**（表盘口径 vs 三行组成）⇒ 以后「差的 136K 是什么」直接从报告读',
    /if \(typeof contextLedgerOf === 'function'\) row\.contextLedger = contextLedgerOf\(pv, mv, bv\);/.test(m1src)
    && /let mv = null;/.test(m1src),
    'm1 不落账本 ⇒ 每次都要挖 asar 才能解释表盘与三行的差');

  const v24 = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', trigger: 'pressure',
    tier: 'heavy', retainBudget: 240000, retainSource: 'tier', rangeSource: 'own',
    shadowedTokens: 243337, ratioAfter: 0.408, usedAfter: 408000, ms: 27000,
  };
  const out24 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v24))
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R24 端到端：压缩回执念出**压缩后占用**（DSH 口径百分比 + 绝对值）+ **显式消歧**（档位名里的百分比不是占用）——模型不再从档位名猜「回到 24%」',
    /压缩后占用 ≈41%（408k）/.test(out24?.text ?? '')
    && /档位名里的百分比是\*\*保留预算比例、不是占用\*\*/.test(out24?.text ?? '')
    && /保留预算 ~240k/.test(out24?.text ?? '') && !/保留 ~240k/.test(out24?.text ?? ''),
    `实际：${String(out24?.text ?? '').slice(0, 260)}`);
  /* R26（用户追问「下次 75% 压完显示 40%，Agent 能准确知道是 40% 吗」）：
   * 用**真机那一帧**（压缩后 51%＝投影 509,616；档位仍是「浅压24%」）验回执不会再把两个 24 混淆。 */
  const v26 = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', trigger: 'pressure',
    tier: 'heavy', retainBudget: 240000, retainSource: 'tier', rangeSource: 'own',
    shadowedTokens: 243337, ratioAfter: 0.509616, usedAfter: 509616, ms: 69000,
  };
  const out26 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v26),
    { RETAIN_RATIO: 0.16, tierText: () => '浅压24%' })
    .buildInjection({ agent, step: 1, turn: 1 });
  ok('R26 端到端：真机帧 ⇒ 回执写「压缩后占用 ≈51%（510k）」而**不是**把「浅压24%」当占用（并说明 provider 未刷新）',
    /压缩后占用 ≈51%（510k）/.test(out26?.text ?? '')
    && /浅压24% 档/.test(out26?.text ?? '')
    && /provider 未刷新/.test(out26?.text ?? ''),
    `实际：${String(out26?.text ?? '').slice(0, 260)}`);
  ok('R24 接线：m3 在**每条路径**上取值（executed 测、no-need 用当前值）并写进 verify',
    /ratioAfter: ratioAfter != null \? ratioAfter : null,/.test(m3src) && /usedAfter,/.test(m3src)
    && /const mrA = result != null \? measureRatio\(agent\.session\) : mr;/.test(m3src)
    && /ratioAfter: ratioAfter != null \? \+\(ratioAfter \* 100\)\.toFixed\(1\) : null,/.test(m3src),
    '只在 own 分支取值 ⇒ 官方兜底/official 路径的回执没有占用读数');
}

/* ═══════════ 6.32 R27：决策卡去噪 + 决策行作用域（用户实测「每一步都出现一次」） ═══════════
 * 用户截图：同一轮里每个步骤都出现一对 `档位决策：…` + `压缩决策：不压｜占用 ~57%｜理由…`。
 * 机制：占用 ≥ 智能压缩线（默认 30%）的**每一轮**都发卡，而卡里写着「本卡出现时，先落一行决策」
 * ⇒ 模型每轮回一行（多步轮次里就每步一行）。卡**不是能力**（工具/教学/用量行都不依赖它），
 * 只是提醒位 ⇒ 改成**稀疏**注入：本会话首次越线 / 占用涨 ≥5pp / 隔 ≥20 轮，其余轮次只留用量行。 */
console.log('\n== 6.32 R27：决策卡去噪 + 决策行作用域 ==');
{
  const ctMod27 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  const effMod27 = await import(pathToFileURL(join(PLUGIN, 'effort.mjs')).href);
  let ratioNow = 0.57;
  const seen27 = [];
  const ctStub27 = {
    tierText: (t) => ({ light: '深压8%', standard: '标准16%', heavy: '浅压24%' }[t] ?? null),
    renderCard: () => '压缩决策卡（stub：本卡出现时，先落一行决策）',
    renderBrief: () => '【插件说明】stub',
    getTier: () => 'heavy', hasTier: () => true,
  };
  const state27 = { m2: { skips: {}, injections: 0 }, m3: { policyCards: 0 } };
  const api27 = mkM2(state27,
    () => ({ ok: true, used: Math.round(ratioNow * 1000000), total: 0, surface: 0, window: 1000000, ratio: ratioNow, basis: '下一请求预估', measure: {} }),
    undefined, undefined, ctStub27);
  const cardAt27 = async (turn) => {
    const out = await api27.buildInjection({ agent, step: 1, turn });
    seen27.push({ turn, ratio: ratioNow, card: out?.card === true, hasUsage: /Context usage before this turn/.test(out?.text ?? '') });
    return out?.card === true;
  };
  const t1 = await cardAt27(1);
  const t2 = await cardAt27(2);
  const t3 = await cardAt27(3);
  ok('R27 行为级：卡**照旧每轮一张**（它是「每轮开头落一次决策」的提醒位；稀疏化被用户口径否决）',
    t1 === true && t2 === true && t3 === true && seen27.every((x) => x.hasUsage),
    `实际序列 ${JSON.stringify(seen27.map((x) => `${x.turn}:${x.card ? '发' : '不发'}`))}`);

  /* 措辞：决策行**按卡/按阶段**算，不按步骤算（用户反馈的直接来源）。 */
  let spec27 = null;
  const ct27 = ctMod27.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: (t) => { spec27 = t; } } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { compactToolDiag: {} } }, readCfg: () => ({ enabled: true }), getDefineTool: () => (s) => s,
    getRangeApi: () => ({ tierText: () => '浅压24%' }), pluginDir: null,
  });
  await ct27.ensure();
  const cardText27 = ct27.renderCard({ ratio: 0.57, minRatio: 0.3, criticalRatio: 0.75, retainRatio: 0.24, retainTokens: 240000, usedTokens: 570000, tierName: 'heavy' }) ?? '';
  const briefText27 = ct27.renderBrief({ criticalRatio: 0.75, retainRatio: 0.24, retainTokens: 240000 }) ?? '';
  const effBrief27 = effMod27.createEffort({
    svc: () => null,
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    state: { m3: { effortDiag: {}, effortSkips: {} } }, readCfg: () => ({ enabled: true, effortEnabled: true, effortCooldownMs: 30000 }),
    getDefineTool: () => (s) => s,
  }).renderBrief({ ok: true, current: 'high', efforts: ['low', 'high', 'max'] }) ?? '';
  ok('R27 文本级：卡里写明「一轮只写一次 / 中途改了决定再补一行 / 其余步骤不要重复」',
    /本轮开头先落一行决策/.test(cardText27) && /一轮只写一次/.test(cardText27)
    && /中途真的改了决定/.test(cardText27) && /其余步骤不要重复/.test(cardText27),
    `实际卡：${cardText27.slice(0, 220)}`);
  ok('R27 文本级：换档教学写明「每轮开头评估并落一行 / 中途真的换档再补一行 / 其余步骤不重复」',
    /每轮开头评估一次并落一行档位决策/.test(effBrief27) && /一轮只写一次/.test(effBrief27)
    && /中途真的换档（升\/降）时\*\*再补一行\*\*/.test(effBrief27),
    `实际教学：${effBrief27.slice(0, 200)}`);
  ok('R27 文本级：一次性说明保持「以卡为准」（卡仍每轮一张，承诺无需改口径）',
    /以卡为准/.test(briefText27) && !/卡是稀疏的/.test(briefText27),
    `实际说明：${briefText27.slice(0, 200)}`);
  /* R36（2026-10-16 真机）：用户手动切档那一轮，模型照抄「保持 X」模板 ⇒ 用户以为它没感知到切换。 */
  ok('R36 文本级：换档教学写明「用户手动改过档位的那一轮…不要写「保持 X」」',
    /用户手动改过档位的那一轮/.test(effBrief27) && /不要写「保持 X」/.test(effBrief27),
    `实际教学：${effBrief27.slice(0, 240)}`);
}

/* ═══════════ 6.33 R28：非插件压缩的**失败原因**必须可见 ═══════════
 * 真机（2026-10-15 session-899bfaca）：同一会话连试 3 次 `/compact` 全失败（DSH 码 `summary`），
 * 我们记到了 3 条「手动压缩（/compact） · 失败」——但**只有「失败」两个字**：
 * 原因只存在于内存态 `lastEngineCompact.error`，面板行（用户可见 + 落盘 hud-acts.json）没有；
 * 且这条路径**不触发报告快照** ⇒ 事后无法回答"为什么压不动"。
 * 本节钉住：① DSH 失败码 → 中文短语进面板行；② 记录带原始 error + 中文 reason（随 `...state.m3` 落盘）；
 * ③ 认不出码时**截断原文照抄**（绝不编造）；④ 立刻 schedule 一次报告快照。 */
console.log('\n== 6.33 R28：非插件压缩失败原因可见 ==');
{
  const m3Mod28 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const state28 = { m3: {} };
  const acts28 = [];
  const sched28 = [];
  const api28 = m3Mod28.createM3Compaction({
    state: state28, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: (t) => sched28.push(t),
    svc: (k) => (k === 'sessionProjections'
      ? { stateOf: () => ({ contextWindow: 1000000, pressureTokens: 333154, surfaceTokens: 224103, sampledSurfaceTokens: 223399 }) }
      : k === 'tokenMeter' ? { measure: () => ({ totalTokens: 334525, surfaceTokens: 214686 }) } : null),
    projectedFromPressure: () => ({ used: 333858, projected: 333858, reported: 333154, surface: 224103, sampled: 223399, basis: '下一请求预估(自算)' }),
    M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: (sid, t) => acts28.push({ sid, t }),
    formatAct: (r) => '19:46 · ' + ({ 'engine-manual': '手动压缩（/compact）', 'engine-auto': '引擎自动压缩' }[r] ?? String(r)),
    clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => ({ hasTier: () => true, tierText: (t) => t }),
    COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
  });
  const sess28 = { id: 'session-899bfaca-47dc' };
  const tSum = api28.noteEngineCompaction({ type: 'compaction/end', data: { compactionId: 'c1', sourceCommandId: 'cmd-x', error: 'summary: no usable summary' } }, sess28);
  ok('R28 行为级：面板行把 DSH 失败码翻成中文短语（不再只有「失败」两个字），且**落盘到 hud-acts**',
    /手动压缩（\/compact）/.test(tSum ?? '') && /失败（摘要无法生成）/.test(tSum ?? '')
    && acts28.length === 1 && /摘要无法生成/.test(acts28[0].t),
    `实际面板行：${JSON.stringify(tSum)}｜acts=${JSON.stringify(acts28)}`);
  ok('R28 行为级：记录带 `ok:false` + 原始 `error` + 中文 `reason`（随 `...state.m3` 落盘，可事后回答"为什么失败"）',
    state28.m3.lastEngineCompact?.ok === false && /summary/.test(state28.m3.lastEngineCompact?.error ?? '')
    && state28.m3.lastEngineCompact?.reason === '摘要无法生成',
    `实际 ${JSON.stringify(state28.m3.lastEngineCompact)}`);
  const tUnknown = api28.noteEngineCompaction({ type: 'compaction/end', data: { compactionId: 'c2', sourceCommandId: 'cmd-y', error: 'X'.repeat(120) } }, sess28);
  ok('R28 行为级：认不出的失败码 ⇒ **截断原文照抄**（绝不编造原因），长度有界',
    /失败（X+…）/.test(tUnknown ?? '') && String(tUnknown).length < 160,
    `实际 ${JSON.stringify(tUnknown)}`);
  ok('R28 行为级：这条路径**立刻请求一次报告快照**（原来没有 schedule ⇒ 失败可能长时间不进报告）',
    sched28.includes('engine-compact'),
    `实际 schedule 调用：${JSON.stringify(sched28)}`);
}

/* ═══════════ 6.34 R29：压缩后投影偏高要标注 + 手动压缩不得标「引擎抢先」 ═══════════
 * 真机（2026-10-15 19:54 `session-899bfaca`）：手动 `/compact` 成功后
 *   ① 记录写成「手动压缩（/compact） · **引擎抢先**：我方上次估计 33.4% ＜ 我方线 75%…」——**误报**：
 *      用户主动压的，没有"抢先"；该标注只对引擎自动压缩成立。
 *   ② 表盘 13.1%（131,440）而当前 surface 只剩 6,185（真实约 2.4%）——投影公式里旧 provider 报的
 *      "非 surface 开销"（350,476 − 225,221 = 125,255）没同步缩小 ⇒ 偏高，需标注「provider 待刷新」。 */
console.log('\n== 6.34 R29：压缩后投影标注 + 手动压缩不误报「引擎抢先」 ==');
{
  const m3Mod29 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const pfp29 = (await import(pathToFileURL(join(PLUGIN, 'core.mjs')).href)).projectedFromPressure;
  const mk29 = (pressure, measure) => m3Mod29.createM3Compaction({
    state: { m3: {} }, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: (k) => (k === 'sessionProjections' ? { stateOf: () => pressure } : k === 'tokenMeter' ? { measure: () => measure } : null),
    projectedFromPressure: pfp29,
    M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75, resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: () => {}, formatAct: () => '', clearBriefed: () => {},
    awaitRange: async () => null, getCompactTool: () => null, COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
  });
  const after29 = mk29(
    { contextWindow: 1000000, pressureTokens: 350476, surfaceTokens: 6185, sampledSurfaceTokens: 225221 },
    { totalTokens: 131633, surfaceTokens: 6234 },
  ).measureRatio({ id: 's' });
  ok('R29 行为级：大压缩后 `stale=true`（surface 比 provider 上报时缩水 >50%），数仍是表盘口径 131,440',
    after29.ok && after29.used === 131440 && after29.stale === true,
    `实际 ${JSON.stringify({ used: after29.used, stale: after29.stale, surface: after29.surface })}`);
  const normal29 = mk29(
    { contextWindow: 1000000, pressureTokens: 333154, surfaceTokens: 224103, sampledSurfaceTokens: 223399 },
    { totalTokens: 334525, surfaceTokens: 214686 },
  ).measureRatio({ id: 's' });
  ok('R29 行为级：正常（未压缩）时不标 stale（避免每轮噪声）',
    normal29.stale === false && normal29.used === 333858,
    `实际 ${JSON.stringify({ used: normal29.used, stale: normal29.stale })}`);
  const line29 = mkM2({ m2: { skips: {}, injections: 0 }, m3: {} },
    () => ({ ok: true, used: 131440, total: 131633, surface: 6234, window: 1000000, ratio: 0.13144, basis: '下一请求预估(自算)', stale: true, measure: {} }))
    .renderUsageText({ id: 's' });
  const line29b = mkM2({ m2: { skips: {}, injections: 0 }, m3: {} },
    () => ({ ok: true, used: 333858, total: 334525, surface: 224103, window: 1000000, ratio: 0.333858, basis: '下一请求预估(自算)', stale: false, measure: {} }))
    .renderUsageText({ id: 's' });
  ok('R29 端到端：用量行在 stale 时附「provider 待刷新」，正常时不附',
    /provider 待刷新/.test(line29?.text ?? '') && !/provider 待刷新/.test(line29b?.text ?? ''),
    `stale：${JSON.stringify(String(line29?.text).slice(0, 140))}｜正常：${JSON.stringify(String(line29b?.text).slice(0, 120))}`);

  /* 手动压缩不得标「引擎抢先」：ratioHist 放 33.4% 让它"本该"被判抢先，但 kind=manual ⇒ 不标。 */
  const st29 = { m3: { ratioHist: { 'sess-29': [{ at: 1, ratio: 0.334 }] } } };
  const api29 = m3Mod29.createM3Compaction({
    state: st29, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: (k) => (k === 'sessionProjections'
      ? { stateOf: () => ({ contextWindow: 1000000, pressureTokens: 350476, surfaceTokens: 6185, sampledSurfaceTokens: 225221 }) }
      : k === 'tokenMeter' ? { measure: () => ({ totalTokens: 131633, surfaceTokens: 6234 }) } : null),
    projectedFromPressure: pfp29,
    M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75, resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: () => {},
    formatAct: (r) => '19:54 · ' + ({ 'engine-manual': '手动压缩（/compact）', 'engine-auto': '引擎自动压缩' }[r] ?? String(r)),
    clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
  });
  const tManual = api29.noteEngineCompaction({ type: 'compaction/end', data: { compactionId: 'c29', sourceCommandId: 'cmd-abc' } }, { id: 'sess-29' });
  const tAuto = api29.noteEngineCompaction({ type: 'compaction/end', data: { compactionId: 'c30', turn: 47 } }, { id: 'sess-29' });
  ok('R29 行为级：**手动** `/compact` 不再标「引擎抢先」（真机误报），但**引擎自动**仍标',
    /手动压缩（\/compact）/.test(tManual ?? '') && !/引擎抢先/.test(tManual ?? '')
    && /引擎自动压缩/.test(tAuto ?? '') && /引擎抢先：我方上次估计 33\.4% ＜ 我方线 75%/.test(tAuto ?? ''),
    `手动：${JSON.stringify(tManual)}｜自动：${JSON.stringify(tAuto)}`);
}

/* ═══════════ 6.35 R31：**检测到重复才注入**反重复备注 ═══════════
 * R30 用固定节拍（step 2/5/8…）压"模型每步重复写决策行"——有效但打扰守规矩的会话（只要本轮发过卡
 * 就会收到备注）。用户要求改成「监测到反复写才注入」。
 * 检测源：会话事件（DSH 事件自带 `data.turn` / `data.step`；`assistant/message` 的 `content` 里
 * `type:'text'` 块才是正文 ⇒ **reasoning 里提到"压缩决策："不算**）。
 * 本节钉住：① 只写 1 条 ⇒ 完全不打扰；② 同轮 ≥2 条 ⇒ 认定重复并投备注；③ 投过之后退避（再写满 3 条）；
 * ④ 每轮上限 4 条；⑤ reasoning 不算；⑥ 新轮重置；⑦ 计数进 state（报告可见）；⑧ 宿主转发接线。 */
console.log('\n== 6.35 R31：检测到重复才注入 ==');
{
  const mk31 = (st) => mkM2(st, () => ({ ok: true, used: 590000, total: 0, surface: 0, window: 1000000, ratio: 0.59, basis: '下一请求预估', measure: {} }),
    undefined, undefined, {
      TOOL_NAME: 'compact_context',   // R32：动作背书判据要从 api 取工具名（不硬编码）
      tierText: () => '浅压24%', renderBrief: () => 'stub', getTier: () => 'heavy', hasTier: () => true,
      renderCard: ({ ratio: r, minRatio } = {}) => (Number.isFinite(r) && Number.isFinite(minRatio) && r < minRatio ? null : '压缩决策卡（stub）'),
    });
  const st31 = { m2: { skips: {}, injections: 0 }, m3: { policyCards: 0 } };
  const api31 = mk31(st31);
  const sess31 = { id: 'sess-31' };
  const agent31 = { session: { id: 'sess-31' }, id: 'sess-31' };
  const msg31 = (turn, step, text) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text }] } } });
  const at31 = async (step, turn) => api31.buildInjection({ agent: agent31, step, turn });

  api31.noteSessionEvent(sess31, msg31(1, 1, '压缩决策：不压｜占用 59%｜理由：空间充足。'));
  const a1 = await at31(2, 1);
  ok('R31 行为级：本轮**只写一次**决策行（守规矩）⇒ 完全不注入（用户要求的"监测到才注入"）',
    a1?.skip === 'not-step-1',
    `实际 ${JSON.stringify(a1)}`);
  api31.noteSessionEvent(sess31, msg31(1, 2, '压缩决策：不压｜占用 60%｜理由：空间充足。'));
  const a2 = await at31(3, 1);
  ok('R31 行为级：同轮累计 ≥2 条 ⇒ 认定"重复"并注入备注（落在重复之后的下一步）',
    a2?.repeatNudge === true && /本轮决策行\*\*只需写一次\*\*/.test(a2?.text ?? ''),
    `实际 ${JSON.stringify(String(a2?.text ?? '').slice(0, 60))}`);
  const a3 = await at31(4, 1);
  ok('R31 行为级：投过之后**退避**——紧接着的步骤不再重复投（避免自己变成噪声源）',
    a3?.skip === 'not-step-1',
    `实际 ${JSON.stringify(a3)}`);
  for (const s of [3, 4, 5]) api31.noteSessionEvent(sess31, msg31(1, s, '档位决策：保持 高(high)｜理由：x'));
  const a4 = await at31(6, 1);
  ok('R35 行为级：每轮上限 **1 条**（R35 从 4 降到 1：备注已证明压不住，留一个提示位即可）',
    a4?.skip === 'not-step-1',
    `实际 ${JSON.stringify(a4)}（计数已涨到 6，但本轮已投过 1 条 ⇒ 不再投）`);

  const st31b = { m2: { skips: {}, injections: 0 }, m3: { policyCards: 0 } };
  const api31b = mk31(st31b);
  api31b.noteSessionEvent(sess31, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '我在盘算：压缩决策：不压……' }] } } });
  const b1 = await api31b.buildInjection({ agent: agent31, step: 2, turn: 1 });
  ok('R31 行为级：`reasoning` 块里的「压缩决策：」**不算**重复写（只数正文 text 块）',
    b1?.skip === 'not-step-1' && !st31b.m2.decisionRepeat,
    `实际 ${JSON.stringify(b1)}｜decisionRepeat=${JSON.stringify(st31b.m2.decisionRepeat)}`);

  api31.noteSessionEvent(sess31, msg31(2, 1, '压缩决策：不压｜占用 61%｜理由：x'));
  const c1 = await at31(2, 2);
  ok('R31 行为级：**新轮重置**计数（上一轮的 6 条不会让新轮一开始就被打扰）',
    c1?.skip === 'not-step-1',
    `实际 ${JSON.stringify(c1)}｜rec=${JSON.stringify(st31.m2.decisionRepeat?.['sess-31'])}`);
  ok('R31 可观测：检测计数（本轮条数/轮次）与投递次数都进 state（报告可见，可事后核对）',
    st31.m2.decisionRepeat?.['sess-31']?.turn === 2 && st31.m2.repeatNudges === 1,
    `实际 ${JSON.stringify({ rec: st31.m2.decisionRepeat?.['sess-31'], nudges: st31.m2.repeatNudges })}（R35 起每轮上限 1 ⇒ 投递数应为 1）`);
  ok('R31 接线：宿主把 `session/event` 转发给 m2（**只读检测**，不触发任何压缩）',
    /m2Ctl\?\.noteSessionEvent\?\.\(session, event\)/.test(host) && /noteSessionEvent \}/.test(m2src),
    '不转发 ⇒ 检测恒为空、备注永不触发（静默失效）');

  /* R32（用户追问「被纠正后就不会注入了吧？」暴露的漏洞）：R27 允许「中途真的改了决定再补一行」——
   * 那种**动作背书**的决策行是合法的，不能算重复。判据：同一条消息里有没有指向压缩/换档工具的 tool-call。 */
  const st32 = { m2: { skips: {}, injections: 0 }, m3: { policyCards: 0 } };
  const api32 = mk31(st32);
  const agent32 = { session: { id: 'sess-32' }, id: 'sess-32' };
  const at32 = async (step) => api32.buildInjection({ agent: agent32, step, turn: 1 });
  const withAction = (turn, step, tool) => ({
    type: 'assistant/message',
    data: { turn, step, message: { content: [
      { type: 'text', text: '压缩决策：压｜占用 59%｜理由：换子任务。' },
      { type: 'tool-call', name: tool, arguments: '{}' },
    ] } },
  });
  api32.noteSessionEvent({ id: 'sess-32' }, withAction(1, 1, 'compact_context'));
  const d32a = await at32(2);
  ok('R32 行为级：**动作背书**的决策行不算重复（真的调了 compact_context ⇒ 合法补行，不打扰）',
    d32a?.skip === 'not-step-1' && !st32.m2.decisionRepeat,
    `实际 ${JSON.stringify(d32a)}｜rec=${JSON.stringify(st32.m2.decisionRepeat)}`);
  api32.noteSessionEvent({ id: 'sess-32' }, withAction(1, 2, 'pwsh'));
  const d32b = await at32(3);
  ok('R32 行为级：**其它** tool-call（如 pwsh）不豁免——纯文本重复仍会被计入',
    st32.m2.decisionRepeat?.['sess-32']?.count === 1 && d32b?.skip === 'not-step-1',
    `实际 rec=${JSON.stringify(st32.m2.decisionRepeat?.['sess-32'])}｜${JSON.stringify(d32b)}`);
  api32.noteSessionEvent({ id: 'sess-32' }, { type: 'assistant/message', data: { turn: 1, step: 3, message: { content: [{ type: 'text', text: '压缩决策：不压｜占用 60%｜理由：空间充足。' }] } } });
  const d32c = await at32(4);
  ok('R32 行为级：豁免之后再出现**纯文本**重复 ⇒ 仍按 ≥2 条判定并注入',
    st32.m2.decisionRepeat?.['sess-32']?.count === 2 && d32c?.repeatNudge === true,
    `实际 rec=${JSON.stringify(st32.m2.decisionRepeat?.['sess-32'])}｜nudge=${d32c?.repeatNudge}`);
}

/* ═══════════ 6.36 R35：持续重复 ⇒ 上报面板（含可复制纠正文案）；备注上限 4→1 ═══════════
 * 依据（R33 实测）：备注 4 条/轮压不住模型（它照写 18–22 条/轮），压缩清先例也无效 ⇒
 * **不再跟模型较劲**，改为**把异常上报给用户**：面板 acts 行给一句现状 + **可直接复制粘贴给 Agent 的纠正句**；
 * 备注上限降到 1（留一个提示位即可，省 token）。 */
console.log('\n== 6.36 R35：持续重复上报面板 + 可复制纠正文案 ==');
{
  const acts35 = [];
  const huds35 = [];
  const st35 = { m2: { skips: {}, injections: 0 }, m3: { policyCards: 0 } };
  const ct35 = {
    TOOL_NAME: 'compact_context', tierText: () => '浅压24%', renderBrief: () => 'stub',
    renderCard: () => '压缩决策卡（stub）', getTier: () => 'heavy', hasTier: () => true,
  };
  const api35 = mkM2(st35, () => ({ ok: true, used: 590000, total: 0, surface: 0, window: 1000000, ratio: 0.59, basis: '下一请求预估', measure: {} }),
    undefined, undefined, ct35, { recordHudAct: (sid, t) => acts35.push({ sid, t }), publishHud: (p) => huds35.push(p) });
  const sess35 = { id: 'sess-35' };
  const agent35 = { session: { id: 'sess-35' }, id: 'sess-35' };
  const msg35 = (turn, step, text) => ({ type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text }] } } });
  const at35 = (step, turn) => api35.buildInjection({ agent: agent35, step, turn });

  api35.noteSessionEvent(sess35, msg35(1, 1, '压缩决策：不压｜占用 59%｜理由：x'));
  api35.noteSessionEvent(sess35, msg35(1, 2, '压缩决策：不压｜占用 60%｜理由：x'));
  const n1 = await at35(3, 1);
  ok('R35 行为级：重复 2 条 ⇒ 只投备注、**不上报面板**（"持续重复"门槛 ≥6 条）',
    n1?.repeatNudge === true && acts35.length === 0 && !st35.m2.repeatFixText,
    `实际 nudge=${n1?.repeatNudge}｜acts=${acts35.length}｜fixText=${JSON.stringify(st35.m2.repeatFixText)}`);

  for (const s of [3, 4, 5, 6]) api35.noteSessionEvent(sess35, msg35(1, s, '档位决策：保持 高(high)｜理由：x'));
  await at35(7, 1);
  ok('R35 行为级：同轮 ≥6 条 ⇒ 上报面板一行（现状 + **可直接复制的纠正文案**）并 publishHud',
    acts35.length === 1 && /决策行重复 6 次\/轮/.test(acts35[0].t) && /可直接复制：/.test(acts35[0].t)
    && /每轮开头写一次即可/.test(acts35[0].t) && /其余步骤不要再重复/.test(acts35[0].t)
    && huds35.length === 1 && /决策行重复 6/.test(huds35[0].hudLastAct ?? '')
    && /请停止在每个步骤重复写决策行/.test(st35.m2.repeatFixText ?? ''),
    `实际 acts=${JSON.stringify(acts35)}｜hud=${JSON.stringify(huds35[0])}`);

  api35.noteSessionEvent(sess35, msg35(1, 7, '档位决策：保持 高(high)｜理由：x'));
  await at35(9, 1);
  ok('R35 行为级：同一轮**只上报一次**（不刷面板）',
    acts35.length === 1 && st35.m2.repeatReports === 1,
    `实际 acts=${acts35.length}｜repeatReports=${st35.m2.repeatReports}`);
  ok('R35 接线：宿主把 `recordHudAct` / `publishHud` 注入 m2（复用 m3 已有的 HUD 出口）',
    /recordHudAct, publishHud,/.test(host) && /recordHudAct, publishHud,/.test(m2src),
    'm2 拿不到 HUD 出口 ⇒ 上报静默失效（用户永远看不到"建议手动纠正"）');
}

/* ═══════════ 6.37 R37：压缩后的"过渡值"必须带 provider 待刷新提示 ═══════════
 * 真机（2026-10-16 14:37 `session-54597a24`）：手动 `/compact` 后面板写「压后占用 12.6%」，
 * 而 13 分钟后表盘变成 5%——因为刚压完时 `providerReported` 还是压缩前的旧实报（387,168），
 * 只按 surface 增量修正：`387168 + 8194 − 269183 = 126179 = 12.6%`；下一次请求完成后 provider
 * 实报真实值（~53.6K ⇒ 5%）。面板那行不带提示 ⇒ 用户以为数字在乱跳。 */
console.log('\n== 6.37 R37：压缩后过渡值带「provider 待刷新」提示 ==');
{
  const m3Mod37 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const pfp37 = (await import(pathToFileURL(join(PLUGIN, 'core.mjs')).href)).projectedFromPressure;
  const mk37 = (pressure) => {
    const acts = [];
    const api = m3Mod37.createM3Compaction({
      state: { m3: {} }, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
      tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
      nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
      svc: (k) => (k === 'sessionProjections' ? { stateOf: () => pressure }
        : k === 'tokenMeter' ? { measure: () => ({ totalTokens: 126435, surfaceTokens: 8194 }) } : null),
      projectedFromPressure: pfp37,
      M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75, resolveCompactionFor: () => ({ service: null, via: 'stub' }),
      publishHud: () => {}, recordHudAct: (sid, t) => acts.push({ sid, t }),
      formatAct: (r) => '14:37 · ' + ({ 'engine-manual': '手动压缩（/compact）', 'engine-auto': '引擎自动压缩' }[r] ?? String(r)),
      clearBriefed: () => {}, awaitRange: async () => null,
      getCompactTool: () => ({ hasTier: () => true, tierText: (t) => t }),
      COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
    });
    return { api, acts };
  };
  const a37 = mk37({ contextWindow: 1000000, pressureTokens: 387168, surfaceTokens: 8194, sampledSurfaceTokens: 269183 });
  const t37 = a37.api.noteEngineCompaction({ type: 'compaction/end', data: { compactionId: 'c37', sourceCommandId: 'cmd-x' } }, { id: 'sess-37' });
  ok('R37 行为级：刚压完（surface 比上报时缩水 >50%）⇒ 面板行带「provider 待刷新，下次请求后会回落」',
    /压后占用 12\.6%/.test(t37 ?? '') && /provider 待刷新，下次请求后会回落/.test(t37 ?? '')
    && /provider 待刷新/.test(a37.acts[0]?.t ?? ''),
    `实际面板行：${JSON.stringify(t37)}`);
  const b37 = mk37({ contextWindow: 1000000, pressureTokens: 333154, surfaceTokens: 224103, sampledSurfaceTokens: 223399 });
  const t37b = b37.api.noteEngineCompaction({ type: 'compaction/end', data: { compactionId: 'c38', sourceCommandId: 'cmd-y' } }, { id: 'sess-37b' });
  ok('R37 行为级：正常轮次（未压缩）不附该提示（避免每行都拖一句）',
    !/provider 待刷新/.test(t37b ?? ''),
    `实际：${JSON.stringify(t37b)}`);
}

/* ═══════════ 6.38 R38：面板行的「压后占用」后缀**单源**（三条路径共用） ═══════════
 * 起因：我们自己发起的压缩（pre-step 自选范围 / idle 扫除）面板行只写「省 XK」，**没有占用数**；
 * 而引擎/手动那条带占用却没提示（R37 已补）。用户要求把自选范围那条也升级 ⇒ 顺手抽成**单源**，
 * 避免"同一物理量三处各写一遍"（本项目多次踩坑）。 */
console.log('\n== 6.38 R38：压后占用后缀单源 ==');
{
  const m3Mod38 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const f38 = m3Mod38.occupancyActSuffix;
  ok('R38 行为级：后缀带占用 + stale 提示；非 stale 不带提示；无值返回空串',
    f38(0.455, true) === ' · 压后占用 45.5%（provider 待刷新，下次请求后会回落）'
    && f38(0.126, true) === ' · 压后占用 12.6%（provider 待刷新，下次请求后会回落）'
    && f38(0.33, false) === ' · 压后占用 33.0%'
    && f38(null, true) === '' && f38(undefined) === '',
    `实际 ${JSON.stringify([f38(0.455, true), f38(0.33, false), f38(null, true)])}`);
  /* R46（用户同意）：面板行后缀也带「预计稳定后」——与回执同源（R45 样本中位数）；无样本时**不编数字**。 */
  ok('R46 行为级：给了回落样本 ⇒ 后缀写「预计稳定后 ≈10%」；没样本 ⇒ 保持原话（不编数字）；非 stale ⇒ 不加',
    f38(0.19, true, 0.10) === ' · 压后占用 19.0%（provider 待刷新，预计稳定后 ≈10%）'
    && f38(0.19, true, null) === ' · 压后占用 19.0%（provider 待刷新，下次请求后会回落）'
    && f38(0.10, false, 0.10) === ' · 压后占用 10.0%',
    `实际 ${JSON.stringify([f38(0.19, true, 0.10), f38(0.19, true, null), f38(0.10, false, 0.10)])}`);
  const uses38 = (m3src.match(/occupancyActSuffix\(/g) ?? []).length;
  /* R38 单源守卫（R46 修判据）：把**整个函数体**摘掉后再找内联模板——原判据用 200 字符窗口，
   * 函数体一变长（R46 加了注释与预计逻辑）就误报"仍有内联实现"。 */
  const body38 = (m3src.match(/export function occupancyActSuffix[\s\S]*?\n\}/) ?? [''])[0];
  const rest38 = m3src.replace(body38, '');
  ok('R38 单源守卫：三条面板路径（引擎/手动、pre-step、idle）**共用同一个后缀函数**，且没有第二份内联实现',
    uses38 >= 4 && body38.length > 100 && !/· 压后占用 \$\{/.test(rest38),
    `实际 occupancyActSuffix 出现 ${uses38} 次（1 定义 + ≥3 调用）；函数体外内联实现 ${/· 压后占用 \$\{/.test(rest38) ? '仍存在' : '已无'}`);
  /* R46 接线：三条路径都必须把**稳定后比例**传进后缀（否则只有 pre-step 一条路有预计值）。 */
  ok('R46 接线：三条面板路径都传第三参（稳定后比例），且 pre-step 用**同一局部量**（回执与面板单源）',
    /occupancyActSuffix\(ratioAfter, mr\?\.stale, settledRatioOf\(sidE, mr\)\)/.test(m3src)
    && /occupancyActSuffix\(ratioAfter, staleAfter, settledRatio\)/.test(m3src)
    && /occupancyActSuffix\(mrI\?\.ok \? mrI\.ratio : null, mrI\?\.stale, settledRatioOf\(sid, mrI\)\)/.test(m3src)
    && /const settledRatio = \(settledUsed != null/.test(m3src),
    '有路径没传 ⇒ 面板与回执的百分比不一致（用户会看到两个数）');
}

/* ═══════════ 6.39 R39：保留预算按**真实口径**折算（让档位名副其实） ═══════════
 * 用户实测：档位名（保留窗口 × 24%）按**启发式** token 算，而表盘真实值 ≈ 启发式 × 1.3–1.5
 * （6 会话实测 1.31/1.32/1.38/1.43/1.46/1.51）⇒「浅压24%」压完表盘 ~40%，而 DSH 原生 `/compact`
 * （只留 3.9K 消息）能到 5%。修：`budget / factor`（夹在 [1,2]，**只减不增**）。 */
console.log('\n== 6.39 R39：保留预算真实口径折算 ==');
{
  const m3Mod39 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  /* R50：事实账本（折算因子 / 稳定回落样本 / 压缩锁 / 路由）已搬进 session-facts.mjs。 */
  const factsMod39 = await import(pathToFileURL(join(PLUGIN, 'session-facts.mjs')).href);
  const f39 = m3Mod39.scaleRetainBudget;
  ok('R39 行为级：`scaleRetainBudget` = budget/factor，夹在 [1,2]，**只减不增**',
    f39(240000, 1) === 240000 && f39(240000, 1.4) === 171429 && f39(240000, 2) === 120000
    && f39(240000, 5) === 120000 && f39(240000, 0.5) === 240000 && f39(240000, null) === 240000
    && f39(0, 1.4) === 0,
    `实际 ${JSON.stringify([f39(240000, 1), f39(240000, 1.4), f39(240000, 2), f39(240000, 5), f39(240000, 0.5), f39(240000, null)])}`);

  /* 因子来源：**真 summarizeBreakdown + 在服务边界打桩**（`stateOf('contextBreakdown')`）。
   * ⚠️ R39.1 教训：第一版测试把 `summarizeBreakdown` 整体桩成"返回三行"⇒ 太配合，把
   * "传错对象（整个 measure）"这个真 bug 放了过去（真机：retainBudgetHeur=240000 / retainFactor=1）。 */
  const coreMod39 = await import(pathToFileURL(join(PLUGIN, 'core.mjs')).href);
  const mk39 = (state, bdValue) => m3Mod39.createM3Compaction({
    state, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: (k) => (k === 'sessionProjections' ? { stateOf: () => bdValue } : null),
    projectedFromPressure: () => ({ used: null, projected: null, reported: null, surface: null, sampled: null, basis: 'x' }),
    summarizeBreakdown: coreMod39.summarizeBreakdown,   // **真函数**
    /* R50：事实账本由宿主注入工厂（折算因子已搬进 session-facts.mjs）⇒ 测试同样注入，否则按设计退化为 factor=1。 */
    createFacts: factsMod39.createSessionFacts, pluginDir: null,
    M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75, resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: () => {}, formatAct: () => '', clearBriefed: () => {},
    awaitRange: async () => null, getCompactTool: () => null, COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
  });
  const st39 = { m3: {} };
  const api39 = mk39(st39, { breakdown: { systemTokens: 2162, messageTokens: 244360, toolsTokens: 15751 } });
  api39.noteRetainFactor('s39', { ok: true, used: 400672, stale: false }, { id: 's39' });
  const fA = api39.retainFactorOf('s39');
  api39.noteRetainFactor('s39', { ok: true, used: 455337, stale: true }, { id: 's39' });   // 过渡值 ⇒ 不得更新
  const fB = api39.retainFactorOf('s39');
  ok('R39 行为级：非 stale 实测 ⇒ 因子 = 真实/可见（400672/262273 ≈ 1.53）；**stale 不得更新**（否则预算被压过头）',
    Math.abs(fA - 1.53) < 0.01 && fB === fA && st39.m3.retainFactor?.s39?.visible === 262273,
    `实际 fA=${fA} fB=${fB} rec=${JSON.stringify(st39.m3.retainFactor?.s39)}`);
  /* R39.1 形状守卫（真机 bug 的回归）：误把 `measure` 当组成 ⇒ 只有 system 行 ⇒ 若照算会把
   * 2,162 当分母 ⇒ factor 顶到上限 2 ⇒ **压过头**。必须拒绝（不设因子）。 */
  const api39b = mk39({ m3: {} }, { nodes: [{ heuristicTokens: 2162, system: true }], totalTokens: 1 });
  ok('R39.1 形状守卫：组成**三行不齐**（tools/messages 为 null）⇒ 不设因子',
    api39b.noteRetainFactor('s39b', { ok: true, used: 400672, stale: false }, { id: 's39b' }) === null
    && api39b.retainFactorOf('s39b') === 1,
    `实际 factor=${api39b.retainFactorOf('s39b')}（若按 system=2162 当分母 ⇒ factor 顶到 2 ⇒ 压过头）`);
  const api39c = mk39({ m3: {} }, null);   // stateOf 拿不到组成
  ok('R39.1 行为级：`stateOf(contextBreakdown)` 拿不到 ⇒ 不设因子（退回 1，行为与旧版一致，不猜）',
    api39c.noteRetainFactor('s39c', { ok: true, used: 400672, stale: false }, { id: 's39c' }) === null
    && api39c.retainFactorOf('s39c') === 1,
    `实际 factor=${api39c.retainFactorOf('s39c')}`);

  const v39 = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', trigger: 'pressure',
    tier: 'heavy', retainBudget: 240000, retainFactor: 1.4, retainSource: 'tier', rangeSource: 'own',
    shadowedTokens: 150900, ratioAfter: 0.40, usedAfter: 400672, ms: 39000,
  };
  const out39 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v39),
    { RETAIN_RATIO: 0.24, tierText: () => '浅压24%' }).buildInjection({ agent, step: 1, turn: 1 });
  ok('R39 端到端：回执点明「保留预算 ~240k（真实口径 ×1.4）」（否则模型看到保留量与预算对不上会再误读）',
    /保留预算 ~240k（真实口径 ×1\.4）/.test(out39?.text ?? ''),
    `实际：${String(out39?.text ?? '').slice(0, 200)}`);

  /* R40（用户追问「keepFrom 也符合新机制吧？」）：锚点路径**不走折算**（位置承诺 ⇒ 折算会越过锚点），
   * 但口径必须标出来；且**不能误报成档位预算**（R39 第一版就是无条件报 tierBudget）。 */
  const v40 = {
    at: new Date().toISOString(), sessionId: 'selfcheck-1', state: 'executed', trigger: 'pressure',
    tier: 'heavy', retainBudget: 95000, retainFactor: 1.5, retainSource: 'anchor:recent-user',
    anchorLabel: '从最近第 1 条你的消息起', rangeSource: 'own',
    shadowedTokens: 300000, ratioAfter: 0.24, usedAfter: 240000, ms: 40000,
  };
  const out40 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v40),
    { RETAIN_RATIO: 0.24, tierText: () => '浅压24%' }).buildInjection({ agent, step: 1, turn: 1 });
  ok('R40/R41 端到端：锚点生效 ⇒ 回执报**锚点保留量 + 真实口径落点**，**不误报档位预算**',
    /锚点之后原样保留 ~95k（启发式口径；\*\*表盘 ≈ 143k\*\*（×1\.5））/.test(out40?.text ?? '')
    && !/保留预算 ~240k/.test(out40?.text ?? '')
    && /语义锚点（从最近第 1 条你的消息起）/.test(out40?.text ?? ''),
    `实际：${String(out40?.text ?? '').slice(0, 260)}`);
  /* R44（真机发现）：`recentUser:1` 的锚点段只有 1.4k 启发式，被 MIN 下限抬到 40k ⇒
   * 回执若只说"锚点之后原样保留 ~40k"，会被读成"那段有 40k" ⇒ 必须显式说明「下限保护」。 */
  const v44 = { ...v40, anchorTokens: 1431, anchorClamped: true };
  const out44 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v44),
    { RETAIN_RATIO: 0.24, tierText: () => '浅压24%' }).buildInjection({ agent, step: 1, turn: 1 });
  ok('R44 端到端：锚点预算被**下限抬起**时，回执必须说明「锚点段实际只有 ~1.4k」',
    /锚点之后原样保留 ~95k（启发式口径；\*\*下限保护\*\*：锚点段实际只有 ~1\.4k，为防丢新需求抬到 ~95k；\*\*表盘 ≈ 143k\*\*（×1\.5））/
      .test(out44?.text ?? ''),
    `实际：${String(out44?.text ?? '').slice(0, 300)}`);
  const out44b = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined,
    stubVerify({ ...v40, anchorTokens: 60000, anchorClamped: false }),
    { RETAIN_RATIO: 0.24, tierText: () => '浅压24%' }).buildInjection({ agent, step: 1, turn: 1 });
  ok('R44 反例：**没被夹取**时不得出现「下限保护」（该句必须是有条件的）',
    !/下限保护/.test(out44b?.text ?? '') && /锚点之后原样保留 ~95k/.test(out44b?.text ?? ''),
    `实际：${String(out44b?.text ?? '').slice(0, 260)}`);
  ok('R40 单源守卫：m3 自选范围回报的预算**随来源切换**（锚点报锚点、档位报档位承诺）',
    /retainBudget: useAnchor \? anchorBudget : tierBudget/.test(m3src)
    && /retainBudgetHeur: useAnchor \? anchorBudget : tierBudgetHeur/.test(m3src),
    '无条件报 tierBudget ⇒ 锚点生效时回执报的是档位承诺（R39 的回归）');
  /* R42（用户 2026-10-16 明确）：「keepFrom 不用强制符合这个计算逻辑，应准确保留之前的逻辑」。 */
  ok('R42 语义守卫：**只有档位预算经过折算，锚点预算绝不折算**（保持 R21 的位置语义）',
    /const tierBudgetHeur = scaleRetainBudget\(tierBudget, retainFactor\);/.test(m3src)
    && !/scaleRetainBudget\(anchorBudget/.test(m3src)
    && /const budget = useAnchor \? anchorBudget : tierBudgetHeur;/.test(m3src),
    '锚点被折算 ⇒ 保留边界越过锚点 ⇒ 违背「锚点之后一律原样保留」（R21 护栏）');
  ok('R39 接线：宿主把 `summarizeBreakdown`（可见组成单源）与 R50 事实账本工厂注入 m3',
    /summarizeBreakdown, createFacts: fm\?\.createSessionFacts/.test(host) && /summarizeBreakdown,/.test(m3src),
    'm3 拿不到可见组成 ⇒ 折算因子恒为 1（静默失效）');
  ok('R39 接线：pre-step **每轮刷新因子**（否则本会话首次压缩仍用 factor=1，"名副其实"要等第二次）',
    /recordRatioSample\(sid, ratio, mr\);[\s\S]{0,260}?noteRetainFactor\(sid, mr, agent\.session\);/.test(m3src),
    'pre-step 不刷新因子 ⇒ 首次压缩不折算');

  /* ═══ R45（用户实测观察 2026-10-16）：压缩刚完成的「压后占用」是 provider **未刷新**的投影值——
   * 真机：回执显示 19%，稳定后回落到 10%（差 ~9pp ≈ 90k token）。行为没问题（压缩确实生效），
   * 问题在**回执把中间值当结果**。修法：压缩时挂稳定观察，下一次非 stale 实测量出回落量（中位数），
   * 回执据此给出「稳定后预计 ≈X%」。 */
  const st45 = { m3: { settleWatch: { s45: { used: 200000 } } } };
  const api45 = mk39(st45, { breakdown: { systemTokens: 2162, messageTokens: 244360, toolsTokens: 15751 } });
  const d45a = api45.noteCompactSettle('s45', { ok: true, used: 110000, stale: false });   // 真机 192k→100k 同型
  const s45a = api45.settleDropOf('s45');
  ok('R45 行为级：非 stale 实测 ⇒ 量出回落量（200k→110k ⇒ drop=90000，样本 1 条）',
    d45a === 90000 && s45a?.drop === 90000 && s45a?.n === 1 && st45.m3.settleWatch?.s45 === undefined,
    `实际 drop=${d45a} rec=${JSON.stringify(s45a)} watch=${JSON.stringify(st45.m3.settleWatch)}`);
  const st45b = { m3: { settleWatch: { s45b: { used: 200000 } } } };
  const api45b = mk39(st45b, null);
  const d45b = api45b.noteCompactSettle('s45b', { ok: true, used: 110000, stale: true });   // stale ⇒ 假的回落
  ok('R45 行为级：**stale 实测不得记回落**（provider 旧报还扛着压缩前的大数 ⇒ 量出来是假的）',
    d45b === null && api45b.settleDropOf('s45b') === null && Number.isFinite(st45b.m3.settleWatch?.s45b?.used),
    `实际 drop=${d45b} rec=${JSON.stringify(api45b.settleDropOf('s45b'))}`);
  const v45 = { ...v39, ratioAfter: 0.19, usedAfter: 192000, settledRatio: 0.10, settledUsed: 100000, settleDropTokens: 92000 };
  const out45 = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined, stubVerify(v45),
    { RETAIN_RATIO: 0.24, tierText: () => '浅压24%' }).buildInjection({ agent, step: 1, turn: 1 });
  ok('R45 端到端：回执给**两个数**——「压缩后占用 ≈19%（192k）（provider 未刷新）⇒ 稳定后预计 ≈10%（100k）」',
    /压缩后占用 ≈19%（192k）\*\*（provider 未刷新）⇒ \*\*稳定后预计 ≈10%（100k）\*\*/.test(out45?.text ?? ''),
    `实际：${String(out45?.text ?? '').slice(0, 300)}`);
  const out45b = await mkM2({ m2: { skips: {}, injections: 0 }, m3: {} }, undefined,
    stubVerify({ ...v39, ratioAfter: 0.19, usedAfter: 192000, settledRatio: null, settledUsed: null }),
    { RETAIN_RATIO: 0.24, tierText: () => '浅压24%' }).buildInjection({ agent, step: 1, turn: 1 });
  ok('R45 反例：**没有实测样本**时如实说「暂无实测回落值」，不得凭空给「稳定后预计」',
    /本会话暂无实测回落值/.test(out45b?.text ?? '') && !/稳定后预计/.test(out45b?.text ?? ''),
    `实际：${String(out45b?.text ?? '').slice(0, 300)}`);
}

/* ═══ 6.41 R48：DSH 升级兼容守卫（升级 DSH 后先跑这一块）═══
 * 背景（2026-10-17 逐包 diff 复核 0.2.0-rc.2 → 0.2.1-rc.1）：**无破坏性改动**，但有三处契约面
 * 必须钉住，否则升级后可能"静默失效"：
 *   ① `engines.dsh` 范围——0.2.1 起兼容性优先按它判定，且判定带 `includePrerelease: true`
 *      ⇒ 范围**必须带预发布后缀**（写成 `>=0.2.0 <0.3.0` 会排除当前安装的 0.2.0-rc.2）；
 *   ② `contextBreakdown` 的**公开视图形状**——两版都是**扁平三行**（`view: state => state.breakdown`），
 *      而插件内部注释记的是更早的嵌套形状 ⇒ 必须两种都吃（否则升级后组成读不到 ⇒ 折算因子失效）；
 *   ③ 插件用到的**事件名**与**官方运行时依赖**——DSH 侧改名即静默失效，用快照守卫提前发现。 */
{
  const core48 = await import(pathToFileURL(join(PLUGIN, 'core.mjs')).href);
  const readJson48 = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const pkgRoot48 = readJson48(join(ROOT, 'package.json'));
  const pkgPlug48 = readJson48(join(PLUGIN, 'package.json'));
  /* 0.2.1 的 `dsh-app-boot#unmetRequirements`：**有 engines.dsh 就只看它**（peerDependencies 被忽略）；
   * `satisfies()` 用 `semver.satisfies(v, range, { includePrerelease: true })`。
   * 真 semver 7.8.5 实测：`>=0.2.0-rc.2 <0.3.0-0` ⇒ 0.2.0-rc.2 ✓ 0.2.1-rc.1 ✓；`>=0.2.0 <0.3.0` ⇒ 0.2.0-rc.2 ✗。 */
  ok('R48 兼容：两个清单都声明 `engines.dsh` 且范围**带预发布后缀**（否则排除 0.2.0-rc.2）',
    /^>=\d+\.\d+\.\d+-[A-Za-z0-9.]+ </.test(pkgRoot48.engines?.dsh ?? '')
    && pkgPlug48.engines?.dsh === pkgRoot48.engines?.dsh,
    `实际 root=${JSON.stringify(pkgRoot48.engines)} plugin=${JSON.stringify(pkgPlug48.engines)}`
    + '（两处必须同源：npm 安装读根清单、本地 junction 读 plugin 清单）');
  /* R48：0.2.1 的 `contextBreakdown` wire.view 返回**扁平**三行（与 0.2.0-rc.2 逐字相同）。 */
  const sb48 = core48.summarizeBreakdown;
  const flat48 = sb48({ systemTokens: 2162, toolsTokens: 15751, messageTokens: 244360 });
  const nest48 = sb48({ nodes: [{ seq: 1, heuristicTokens: 5, system: true }], breakdown: { systemTokens: 2162, toolsTokens: 15751, messageTokens: 244360 } });
  ok('R48 兼容：`summarizeBreakdown` 吃 **0.2.1 的扁平视图**（也是 0.2.0-rc.2 的实际形状）与嵌套形状',
    flat48?.system === 2162 && flat48?.tools === 15751 && flat48?.messages === 244360
    && nest48?.system === 2162 && nest48?.tools === 15751,
    `实际 flat=${JSON.stringify(flat48)} nested=${JSON.stringify(nest48)}`);
  /* R48：契约快照守卫（`docs/reference/dsh-contract.json`，升级 DSH 后用 make-contract.cjs 刷新）。
   * 双向钉住：清单里必须有它、插件源码里也必须真在用（任一侧漂移都会红）。 */
  const contract48 = readJson48(join(ROOT, 'docs/reference/dsh-contract.json'));
  /* 扫**全部**插件文件（含 wire.host.mjs / plugin-config.schema.mjs / client.js）——漏文件会让守卫误报"源码里缺失"。 */
  const src48 = readdirSync(PLUGIN).filter((f) => /\.(mjs|js)$/.test(f))
    .map((f) => readFileSync(join(PLUGIN, f), 'utf8')).join('\n');
  const sessUsed48 = ['assistant/message', 'compaction/end', 'developer/message', 'system/message', 'user/message', 'model/selection'];
  const hookUsed48 = ['agent/pre-step', 'agent/request', 'agent/status', 'session/created', 'session/event'];
  ok('R48 兼容：插件用到的**会话事件** ⊆ DSH 清单（快照 0.2.1-rc.1）且源码里确在用',
    sessUsed48.every((e) => contract48.sessionEvents.includes(e) && src48.includes(e)),
    `不在清单=${sessUsed48.filter((e) => !contract48.sessionEvents.includes(e)).join(',') || '(无)'}`
    + `；源码里缺失=${sessUsed48.filter((e) => !src48.includes(e)).join(',') || '(无)'}`);
  ok('R48 兼容：插件用到的 **hook 事件** ⊆ DSH 清单且源码里确在用',
    hookUsed48.every((e) => contract48.hookEvents.includes(e) && src48.includes(e)),
    `不在清单=${hookUsed48.filter((e) => !contract48.hookEvents.includes(e)).join(',') || '(无)'}`
    + `；源码里缺失=${hookUsed48.filter((e) => !src48.includes(e)).join(',') || '(无)'}`);
  /* R48：官方运行时依赖白名单——0.2.1 已逐包 diff 过这 4 个（`createUserMessage` / `defineTool`
   * 均"导出 + 实现逐字相同"；typert 的 `Remote` 仍导出但装饰器有改动 ⇒ 升级后需 HUD 冒烟）。 */
  const deps48 = [...new Set([...src48.matchAll(/await import\('(@deepseek-ai\/[a-z0-9-]+)'\)/g)].map((m) => m[1]))];
  const allowed48 = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol'];
  ok('R48 兼容：官方运行时依赖 ⊆ 已复核白名单（新增官方依赖必须再做一次兼容复核）',
    deps48.length >= 3 && deps48.every((d) => allowed48.includes(d)),
    `实际 ${deps48.join(', ')}（白名单 ${allowed48.length} 个）`);
  /* R48：**更正我自己的初判**——插件并不用 `Remote` 装饰器，而是用 typert 的**低层约定**：
   * `this.typertRemote = {service, serviceKey, namespace}` 绑定 + `remote-methods` 原型标记键
   * （`@deepseek-ai/dsh-typert-protocol/remote-methods`）+ `ctx.provide(FACE_NAME, face)` 兜底。
   * 而 0.2.1 的 typert diff（+230/−28）恰好动了 `bindTypertRemote` / `TypertRemoteService` /
   * marker initializer 那片区域 ⇒ **升级后必须冒烟 HUD**。 */
  const wire48 = readFileSync(join(PLUGIN, 'wire.host.mjs'), 'utf8');
  ok('R48 冒烟提醒：HUD 远端面用 typert 的 `typertRemote` 绑定 + `remote-methods` 标记（0.2.1 改过该区域）',
    /@deepseek-ai\/dsh-typert-protocol\/remote-methods/.test(wire48) && /typertRemote/.test(wire48)
    && /ctx\.provide\(/.test(readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8')),
    '升级 DSH 后先看 HUD 是否仍有数据（DSH-0.2.1-COMPAT-REVIEW.md §六-4 / §7.6）');
}

/* ═══ 6.42 R49：用 0.2.1-rc.2 的新能力做**正向优化**（锁避让 + 按模型的官方阈值）═══
 * 两项都依据**官方源码实证**（逐包 diff 复核过）：
 *  · `dsh-compaction-basic#assertCompactionInactive`：未匹配的 `compaction/start` 即持久锁 ⇒
 *    官方 `/compact` 与插件同时发起必有一方吃 `busy` ⇒ 插件应先查锁、让路（意图保留，可重试）；
 *  · `resolveTargetPolicy(config, target)`：`config.modelPolicies[]` 按 provider+model 精确匹配覆盖
 *    `thresholdRatio` ⇒ 插件只读默认值会与"当前模型"的官方阈值错位。
 * 纪律：**只用已文档化的会话事件**记账（不碰未公开的 `session.seq`）；匹配不到/无锁 ⇒ 与旧行为逐字一致。 */
{
  const thMod49 = await import(pathToFileURL(join(PLUGIN, 'threshold.mjs')).href);
  const m3Mod49 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  /* R50：事实账本由宿主注入工厂 ⇒ 测试必须同样注入（否则 m3 按设计退化为安全默认：无锁/无样本/factor=1）。 */
  const factsMod50 = await import(pathToFileURL(join(PLUGIN, 'session-facts.mjs')).href);
  const tryOf49 = (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } };
  const mkTh49 = (state, cfg) => thMod49.createThreshold({
    svc: (k) => (k === 'agentPresets' ? { serviceFor: () => ({ compactNow: () => {}, config: cfg }) } : null),
    tryOf: tryOf49, state, log: () => {},
  });

  /* --- A：modelPolicies 按当前模型覆盖阈值 --- */
  const stA = { m3: { route: { sA: { provider: 'deepseek', model: 'M-1' } } } };
  const thA = mkTh49(stA, { thresholdRatio: 0.8, modelPolicies: [{ provider: 'deepseek', model: 'M-1', thresholdRatio: 0.7 }] });
  const ethA = thA.engineThreshold({ session: { id: 'sA' } });
  ok('R49 行为级：命中 `modelPolicies` ⇒ 阈值取**该模型策略**（0.7），并留痕 `via=modelPolicies`',
    ethA === 0.7 && stA.m3.engineCapProbe?.via === 'modelPolicies'
    && stA.m3.engineCapProbe?.cap === 0.65 && stA.m3.engineCapProbe?.route?.model === 'M-1',
    `实际 eth=${ethA} probe=${JSON.stringify(stA.m3.engineCapProbe)}`);
  const stA2 = { m3: { route: { sA: { provider: 'deepseek', model: 'M-9' } } } };   // 路由不匹配
  const thA2 = mkTh49(stA2, { thresholdRatio: 0.8, modelPolicies: [{ provider: 'deepseek', model: 'M-1', thresholdRatio: 0.7 }] });
  const ethA2 = thA2.engineThreshold({ session: { id: 'sA' } });
  ok('R49 反例：**路由不匹配**（或没有路由）⇒ 用默认阈值 0.8（与旧行为逐字一致，纯增量）',
    ethA2 === 0.8 && stA2.m3.engineCapProbe?.ratio === 0.8 && stA2.m3.engineCapProbe?.route === null,
    `实际 eth=${ethA2} probe=${JSON.stringify(stA2.m3.engineCapProbe)}`);
  const stA3 = { m3: { route: { sA: { provider: 'p', model: 'm' } } } };
  const thA3 = mkTh49(stA3, { thresholdRatio: 0.8, modelPolicies: [{ provider: 'p', model: 'm' }] });   // 策略命中但没写 thresholdRatio
  const ethA3 = thA3.engineThreshold({ session: { id: 'sA' } });
  ok('R49 取证守卫：策略命中但**未覆盖 thresholdRatio** ⇒ 用默认值，且 `via` **不得**标成 modelPolicies',
    ethA3 === 0.8 && stA3.m3.engineCapProbe?.via !== 'modelPolicies',
    `实际 eth=${ethA3} via=${stA3.m3.engineCapProbe?.via}`);

  /* --- B：锁记账（行为级） --- */
  const mkM3b49 = (state) => m3Mod49.createM3Compaction({
    state, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: tryOf49, nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: () => null, projectedFromPressure: () => ({ used: null, projected: null, reported: null, surface: null, sampled: null, basis: 'x' }),
    summarizeBreakdown: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }), publishHud: () => {}, recordHudAct: () => {},
    formatAct: () => '', clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
    createFacts: factsMod50.createSessionFacts, pluginDir: null,   // R50：注入事实账本工厂
  });
  const stB = { m3: {} };
  const apiB49 = mkM3b49(stB);
  const sessB = { id: 'sB' };
  const r1 = apiB49.noteSessionEvent(sessB, { type: 'compaction/start', seq: 5, data: { turn: 3 } });
  const lockedB = apiB49.compactionLockActive('sB');
  apiB49.noteSessionEvent(sessB, { type: 'compaction/end' });
  const clearedB = apiB49.compactionLockActive('sB');
  ok('R49 行为级：`compaction/start` ⇒ 锁生效；`compaction/end` ⇒ 锁清除',
    r1 === 'lock-set' && lockedB === true && clearedB === false && stB.m3.compactLock?.sB === undefined,
    `实际 r1=${r1} locked=${lockedB} cleared=${clearedB}`);
  apiB49.noteSessionEvent(sessB, { type: 'compaction/start', seq: 6 });
  apiB49.noteSessionEvent(sessB, { type: 'session/end-seed', seq: 7 });
  ok('R49 行为级：`session/end-seed`（官方锁的"更晚 end-seed"）⇒ 也清锁',
    apiB49.compactionLockActive('sB') === false, '实际仍锁定');
  apiB49.noteSessionEvent(sessB, { type: 'model/selection', data: { provider: 'deepseek', model: 'M-2' } });
  ok('R49 行为级：`model/selection` ⇒ 记当前路由（供 threshold 匹配 modelPolicies）',
    apiB49.currentRouteOf('sB')?.provider === 'deepseek' && apiB49.currentRouteOf('sB')?.model === 'M-2',
    `实际 ${JSON.stringify(apiB49.currentRouteOf('sB'))}`);
  stB.m3.compactLock.sTTL = { at: Date.now() - 11 * 60_000 };   // 11 分钟前的陈旧锁
  ok('R49 行为级：锁带 **TTL**——陈旧锁（11 分钟）不得让插件永久让路，且顺手清理',
    apiB49.compactionLockActive('sTTL') === false && stB.m3.compactLock?.sTTL === undefined,
    `实际 active=${apiB49.compactionLockActive('sTTL')} rec=${JSON.stringify(stB.m3.compactLock?.sTTL)}`);

  /* --- B（e2e）：锁生效时 pre-step **不发起**且**不消费意图** --- */
  const calls49 = [];
  const svc49 = {
    compactNow: () => { calls49.push('compactNow'); },
    compactRegion: () => { calls49.push('compactRegion'); return {}; },
    compactIfNeeded: () => { calls49.push('compactIfNeeded'); return null; },
  };
  const tool49 = {
    peekIntent: () => ({ reason: 'test' }), takeIntent: () => { calls49.push('takeIntent'); },
    getTier: () => 'heavy', getAnchor: () => null, pending: () => [],
  };
  const mkM3e49 = (state) => m3Mod49.createM3Compaction({
    state, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: tryOf49, nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    /* ⚠️ m3 的 `measureRatio` 是**内部实现**（不吃注入的 measureRatio 桩）⇒ 必须喂它真正读的两个源：
     * `sessionProjections.stateOf(session,'contextPressure')` + 注入的 `projectedFromPressure`。 */
    svc: (k) => (k === 'tokenMeter'
      ? { measure: () => ({ totalTokens: 900000, surfaceTokens: 500000, nodes: [] }) }
      : k === 'sessionProjections'
        ? { stateOf: () => ({ contextWindow: 1000000, pressureTokens: 800000, surfaceTokens: 500000, sampledSurfaceTokens: 500000 }) }
        : (k === 'agentPresets' ? { serviceFor: () => svc49 } : null)),
    projectedFromPressure: () => ({ used: 800000, projected: 800000, reported: 800000, surface: 500000, sampled: 500000, basis: 'test' }),
    summarizeBreakdown: () => null, M3: { criticalRatio: 0.85 }, effEnabled: () => true, criticalCapOf: () => 0.75,
    resolveCompactionFor: () => ({ service: svc49, via: 'agentPresets.serviceFor' }), publishHud: () => {}, recordHudAct: () => {},
    formatAct: () => '', clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => tool49,
    COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
    engineThreshold: () => 0.8, getRangeApi: () => null,
    createFacts: factsMod50.createSessionFacts, pluginDir: null,   // R50：注入事实账本工厂
  });
  const stE49 = { m3: { preStepErrors: {} } };   // ⚠️ 真实插件在 core.mjs 里初始化 preStepErrors（错误分支会写它）
  const apiE49 = mkM3e49(stE49);
  apiE49.noteSessionEvent({ id: 'sE' }, { type: 'compaction/start', seq: 9 });
  await apiE49.preStepCompaction({ agent: { session: { id: 'sE' } }, signal: AbortSignal.timeout(2000) });
  ok('R49 端到端：锁生效 ⇒ pre-step **一次都没发起**压缩，且**不消费意图**（下一步可重试）',
    calls49.length === 0 && stE49.m3.lastLockSkip?.sessionId === 'sE' && stE49.m3.lastLockSkip?.wanted === true,
    `实际调用=${JSON.stringify(calls49)} lockSkip=${JSON.stringify(stE49.m3.lastLockSkip)}`);
  /* 对照：清锁后同一路径**必须**照常发起（防"让路变成永久不压"的回归）。
   * 桩不足时后续步骤可能抛错 ⇒ 只断言"已经越过让路点"（takeIntent + 进入压缩），不要求整条链跑通。 */
  apiE49.noteSessionEvent({ id: 'sE' }, { type: 'compaction/end' });
  try { await apiE49.preStepCompaction({ agent: { session: { id: 'sE' } }, signal: AbortSignal.timeout(2000) }); } catch { /* 桩不足，忽略 */ }
  ok('R49 对照：清锁后**照常发起**（证明让路不是"永久不压"）',
    calls49.includes('takeIntent') && (calls49.includes('compactRegion') || calls49.includes('compactIfNeeded')),
    `实际调用=${JSON.stringify(calls49)}`);

  /* --- R49.1：错误分支必须**不抛**并留下 lastPreStepError（原实现引用 try 内 `const sid` ⇒ catch 自身
   * ReferenceError ⇒ `lastPreStepError` 与"吞掉继续"全丢，异常还冒泡给 DSH）。用"取 session 就抛"的
   * payload 强制进 catch。 --- */
  const stErr49 = { m3: { preStepErrors: {} } };
  const apiErr49 = mkM3e49(stErr49);
  let threw49 = null;
  try {
    await apiErr49.preStepCompaction({ agent: { get session() { throw new Error('boom-R49.1'); } }, signal: AbortSignal.timeout(1000) });
  } catch (e) { threw49 = String(e?.message ?? e); }
  ok('R49.1 错误分支：pre-step 抛错时 catch **自己吞掉**并写下 lastPreStepError（不得再抛一次）',
    threw49 === null && (stErr49.m3.preStepErrors?.err ?? 0) >= 1
    && /boom-R49\.1/.test(String(stErr49.m3.lastPreStepError?.message ?? '')),
    `实际 threw=${threw49} errors=${JSON.stringify(stErr49.m3.preStepErrors)} last=${JSON.stringify(stErr49.m3.lastPreStepError)?.slice(0, 160)}`);
}

/* ═══ 6.43 R50：会话事实账本**解耦** + 稳定回落样本**落盘** ═══
 * 解耦：折算因子 / 稳定回落样本 / 压缩锁 / 当前模型路由 四类事实，从 `m3.compact.mjs`（决策 + 记账
 * 混在 800+ 行里）搬进叶子模块 `session-facts.mjs`，由宿主注入工厂（模块间禁止互引）。
 * 两条**强制性保证**（不是"尽量"）：
 *   ① 落盘：样本写 `.data/settle-drop.json` ⇒ 跨重启/跨 toggle 仍在；本会话无样本时给跨会话中位数并
 *      标 `scope:'global'`（回执据此写"参考其他会话"，**绝不冒充**本会话实测）。
 *   ② 缺依赖必须退化：不注入工厂 ⇒ factor=1 / 无样本 / 无锁，且**不得抛错**（最坏情况 = 旧行为）。 */
{
  const fMod50 = await import(pathToFileURL(join(PLUGIN, 'session-facts.mjs')).href);
  const m3Mod50 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const dir50 = mkdtempSync(join(tmpdir(), 'cp-facts-'));
  const mk50 = (state, dir) => fMod50.createSessionFacts({
    state, pluginDir: dir, log: () => {},
    pick: (...a) => a.find((x) => x != null),
    svc: () => null, summarizeBreakdown: () => null,
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
  });

  /* --- ① 落盘：跨"重启"（新实例、state 全新）仍在 --- */
  const f50a = mk50({ m3: {} }, dir50);
  f50a.armSettleWatch('sA', 200000, 0.19);
  const drop50 = f50a.noteCompactSettle('sA', { ok: true, used: 110000, stale: false });
  const file50 = join(dir50, '.data', 'settle-drop.json');
  const saved50 = existsSync(file50) ? JSON.parse(readFileSync(file50, 'utf8')) : null;
  ok('R50 落盘：稳定回落样本写入 `.data/settle-drop.json`（version / savedAt / bySid 形状）',
    drop50 === 90000 && saved50?.version === 1 && Array.isArray(saved50?.bySid?.sA) && saved50.bySid.sA[0].drop === 90000,
    `实际 drop=${drop50} file=${String(JSON.stringify(saved50)).slice(0, 150)}`);
  const f50b = mk50({ m3: {} }, dir50);   // 新实例 = 模拟重启/toggle
  const after50 = f50b.settleDropOf('sA');
  ok('R50 跨重启：新实例仍读到该会话样本（R45 只活在内存时缺的正是这个）',
    after50?.drop === 90000 && after50?.n === 1, `实际 ${JSON.stringify(after50)}`);

  /* --- ② 跨会话参考（明确标注来源）--- */
  const any50 = f50b.settleDropAny('sBrandNew');
  ok('R50 跨会话参考：本会话无样本 ⇒ 全局中位数 + `scope:"global"`（本会话有 ⇒ `session`）',
    any50?.scope === 'global' && any50?.drop === 90000 && f50b.settleDropAny('sA')?.scope === 'session',
    `实际 any=${JSON.stringify(any50)} own=${JSON.stringify(f50b.settleDropAny('sA'))}`);

  /* --- ③ 缺依赖必须退化（强制性保证）--- */
  const mkNoFacts50 = (state) => m3Mod50.createM3Compaction({
    state, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: () => null, projectedFromPressure: () => ({ used: null, projected: null, reported: null, surface: null, sampled: null, basis: 'x' }),
    summarizeBreakdown: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.75,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }), publishHud: () => {}, recordHudAct: () => {},
    formatAct: () => '', clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,   // 刻意**不传** createFacts
  });
  let threw50 = null; let deg = null;
  try {
    const api50 = mkNoFacts50({ m3: {} });
    api50.noteSessionEvent({ id: 'sX' }, { type: 'compaction/start', seq: 1 });
    deg = {
      lock: api50.compactionLockActive('sX'), factor: api50.retainFactorOf('sX'),
      drop: api50.settleDropOf('sX'), any: api50.settleDropAny('sX'), route: api50.currentRouteOf('sX'),
    };
  } catch (e) { threw50 = String(e?.message ?? e); }
  ok('R50 强制性保证：**不注入事实账本** ⇒ factor=1 / 无样本 / 无锁，且**不抛错**（最坏 = 旧行为）',
    threw50 === null && deg?.lock === false && deg?.factor === 1 && deg?.drop === null && deg?.any === null && deg?.route === null,
    `实际 threw=${threw50} deg=${JSON.stringify(deg)}`);

  /* --- ④ 解耦结构守卫：实现必须真的搬走（不是复制两份）--- */
  const m3src50 = readFileSync(join(PLUGIN, 'm3.compact.mjs'), 'utf8');
  const factsSrc50 = readFileSync(join(PLUGIN, 'session-facts.mjs'), 'utf8');
  ok('R50 解耦：事实**实现**已在 session-facts.mjs，m3 只剩薄委托（不得留两份实现 ⇒ 口径会漂移）',
    /COMPACT_LOCK_TTL_MS = 10 \* 60_000/.test(factsSrc50) && !/COMPACT_LOCK_TTL_MS/.test(m3src50)
    && /SETTLE_SAMPLES_CAP = 8/.test(factsSrc50) && !/SETTLE_SAMPLES_CAP/.test(m3src50)
    && /typeof createFacts === 'function'/.test(m3src50) && !/writeFileSync/.test(m3src50),
    '实现若留在 m3 ⇒ 解耦是假的');
  ok('R50 解耦：叶子模块**零互引**（只 import node 内置）+ 宿主 `?ts=` 动态加载',
    !/from '\.\//.test(factsSrc50)
    && /^import \{ [^}]*writeFileSync[^}]*\} from 'node:fs';$/m.test(factsSrc50)
    && /import\(`\.\/session-facts\.mjs\?ts=\$\{IMPL_TS\}`\)/.test(readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8')),
    '互引 ⇒ 依赖图不再是叶子；漏 ?ts= ⇒ 热换不生效（P16）');
  /* 审查发现的回归风险：账本与 m3 **必须各自加载**——塞进同一个 Promise.all 时任一失败会连带 M3 整域
   * 失效（`m3Ctl` 恒 null ⇒ 工具回 ok 但永不压缩、模型无感）。断言宿主给账本**单独的 catch** 且传 null。 */
  const host50 = readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8');
  ok('R50 强制性保证：事实账本**独立降级**（失败只退化，绝不让 M3 压缩整域失效）',
    /import\(`\.\/session-facts\.mjs\?ts=\$\{IMPL_TS\}`\)\.catch\(/.test(host50)
    && /createFacts: fm\?\.createSessionFacts/.test(host50),
    '两个 import 共用一个 catch ⇒ 账本失败连带压缩整域失效（静默降级）');
  /* --- ⑤ 强制性不变量（结构性）：让路必须在**消费意图之前**；持久化的样本必须被**消费** --- */
  const m3s50 = readFileSync(join(PLUGIN, 'm3.compact.mjs'), 'utf8');
  const m2s50 = readFileSync(join(PLUGIN, 'm2.inject.mjs'), 'utf8');
  const iLock50 = m3s50.indexOf('lockSkip(sid, ratio, wanted');
  const iTake50 = m3s50.indexOf('tool.takeIntent(sid)');
  ok('R50 强制性不变量：**让路在消费意图之前**（否则工具已回 scheduled、实际没压，且不会重试）',
    iLock50 > 0 && iTake50 > 0 && iLock50 < iTake50, `实际 lockSkip@${iLock50} takeIntent@${iTake50}`);
  ok('R50 强制性不变量：持久化的样本必须被**消费**——m3 用 settleDropAny 出数、回执按 scope 标明来源',
    /const rec = settleDropAny\(sid\)/.test(m3s50) && /const settleRec = settleDropAny\(sid\)/.test(m3s50)
    && /settleScope: settleRec\?\.scope/.test(m3s50)
    && /v\.settleScope === 'global'/.test(m2s50) && /参考其他会话/.test(m2s50),
    '只落盘不消费 ⇒ 持久化是白做的（这正是"优化"与"改动"的分界）');
  rmSync(dir50, { recursive: true, force: true });
}

/* ═══ 6.45 R52：独立审计发现 —— `official()` 闭包的 TDZ（"压了却报未执行"）═══
 * 来源：**B 路独立审计**（qoder/Qwen3.8-Flash，任务书未提示这条）在 `compactWithOwnRange` 的
 * `official()` 兜底闭包里发现：`awaitRange()` 返回 null（compact-range.mjs 加载失败）时**立刻**调
 * `official()`，而它引用的 `retainSource`/`useAnchor`/`tierInfo` 三个 const 声明在更后面 ⇒ 对象字面量
 * 求值抛 TDZ ReferenceError。更糟：`compactIfNeeded` 在 await 里**已经真的压了**，随后才抛 ⇒
 * 调用方写 `not-executed` 回执（**假阴性**）+ preStepOk/HUD 记录双丢 = 静默降级。
 * 本块 = 回归守卫（行为级 + 结构级）。 */
{
  const m3Mod52 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const calls52 = [];
  const svc52 = {
    compactNow: () => { calls52.push('compactNow'); },
    compactRegion: () => { calls52.push('compactRegion'); return {}; },
    compactIfNeeded: async () => { calls52.push('compactIfNeeded'); return { shadowedTokenCount: 123 }; },
  };
  const api52 = m3Mod52.createM3Compaction({
    state: { m3: {} }, log: () => {}, msg: (e) => String(e), pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: () => null,
    projectedFromPressure: () => ({ used: null, projected: null, reported: null, surface: null, sampled: null, basis: 'x' }),
    summarizeBreakdown: () => null, M3: { criticalRatio: 0.75 }, effEnabled: () => true, criticalCapOf: () => 0.75,
    resolveCompactionFor: () => ({ service: svc52, via: 'stub' }), publishHud: () => {}, recordHudAct: () => {},
    formatAct: () => '', clearBriefed: () => {},
    awaitRange: async () => null,   // ← 关键：模拟 compact-range.mjs 不可用（宿主 rangeReady.catch 返回 null）
    getCompactTool: () => null, COMPACT_TIMEOUT_MS: 1000, SET_CAP: 10,
  });
  let out52 = null; let err52 = null;
  try {
    out52 = await api52.compactWithOwnRange({ session: { id: 's52' } }, { service: svc52, via: 'stub' },
      /* R71（F-14）：低占用 + range 不可用 ⇒ 现在**不再**回落官方（改跳过，见 R71 行为级断言）；
       * 本用例要守的是「已越强制线时官方兜底仍可用、且不得抛 TDZ」⇒ forced 改 true。 */
      { forced: true, sig: AbortSignal.timeout(2000), sid: 's52', window: 1000000, measure: {}, tierName: 'standard',
        retainOverride: null, anchorSeq: null, anchorFailReason: 'text:not-found' });
  } catch (e) { err52 = String(e?.message ?? e); }
  ok('R52 行为级：`compact-range` 不可用 ⇒ 官方兜底**不得抛 TDZ**，且必须回报 source=official + 保留来源',
    err52 === null && out52?.source === 'official' && calls52.includes('compactIfNeeded')
    && out52?.retainSource === 'tier' && out52?.anchorFailReason === 'text:not-found',
    `实际 err=${err52} out=${JSON.stringify(out52)} calls=${JSON.stringify(calls52)}`);
  /* 结构守卫：`official()` 依赖的三项必须在它之前声明（防有人把声明再挪回去 ⇒ TDZ 复活）。 */
  const m3src52 = readFileSync(join(PLUGIN, 'm3.compact.mjs'), 'utf8');
  const iOfficial52 = m3src52.indexOf('const official = async');
  const iRetain52 = m3src52.indexOf('const retainSource = useAnchor');
  const iUseAnchor52 = m3src52.indexOf('const useAnchor = Number.isFinite(anchorBudget)');
  const iTierInfo52 = m3src52.indexOf('let tierInfo = { tier:');
  ok('R52 结构守卫：`retainSource`/`useAnchor`/`tierInfo` 必须在 `official()` **之前**声明（TDZ 前移）',
    iOfficial52 > 0 && iRetain52 > 0 && iRetain52 < iOfficial52
    && iUseAnchor52 > 0 && iUseAnchor52 < iOfficial52
    && iTierInfo52 > 0 && iTierInfo52 < iOfficial52,
    `实际 official@${iOfficial52} retainSource@${iRetain52} useAnchor@${iUseAnchor52} tierInfo@${iTierInfo52}`);
}

/* ═══ 6.46 R53（自审发现 #2）：`.data` 落盘**必须原子**（同目录 tmp + rename）═══
 * 直写目标路径会在写入中途留下半截 JSON ⇒ 并发读者（面板 / 报告工具 / 插件下次启动的
 * `loadReportBase`）读到 `Unterminated string in JSON` ⇒ 记录/报告**整份丢失**。
 * 现场证据：test/report.mjs 曾因读到半写文件真实报过这个错；R13 的"报告断档"同形。
 * 结构守卫：五个落盘点都走 `writeJsonAtomic`，且没有任何一处直接 `writeFileSync(目标路径, …)`。 */
{
  const sites46 = [
    ['core.mjs', 'reportPath'], ['m5.hud.mjs', 'hudActsPath'], ['session-facts.mjs', 'settlePath'],
    ['compact-tool.mjs', 'tierPath'], ['effort.mjs', 'statsPath'],
  ];
  const problems46 = [];
  for (const [f, target] of sites46) {
    const src = read(f);
    if (!src.includes('const writeJsonAtomic = (p, obj) => {')) problems46.push(`${f}: 缺 writeJsonAtomic`);
    if (!src.includes(`writeJsonAtomic(${target},`)) problems46.push(`${f}: ${target} 未走原子写`);
    if (src.includes(`writeFileSync(${target},`)) problems46.push(`${f}: 仍在直写 ${target}`);
  }
  ok('R53 落盘原子性：五个 `.data` 写入点全部走 `writeJsonAtomic`（同目录 tmp + rename），无直写',
    problems46.length === 0, `实际问题：${JSON.stringify(problems46)}`);
  const srcCore46 = read('core.mjs');
  ok('R53 原子写实现：先写「同目录 tmp」再 `renameSync` 覆盖（读者只见旧的或新的完整内容）',
    srcCore46.includes('${p}.${process.pid}.${Date.now().toString(36)}.tmp') && /renameSync\(tmp, p\)/.test(srcCore46),
    '实现不是 tmp+rename ⇒ 半截 JSON 仍可能出现（名字叫 atomic 但行为不是）');
}

/* ═══ 6.47 R54（独立审计 B 路 · qoder/Qwen3.8-Flash）：四条真缺陷的回归守卫 ═══
 * F1 `lastUserText` 未解构 → 每次调用 ReferenceError（被 m2 的空 catch 吞掉 = 静默降级）
 * F2 `pending` 未定义 → 卸载清理**第一行**就抛 ⇒ 后面所有 disposer 全不执行（监听器/定时器泄漏）
 * F3 client `alive` 引用作用域外的变量 → autoClamp 路径 ReferenceError + 未捕获 rejection
 * F4 回执只写全局镜像、读取端只读 per-sid ⇒ 模型永远看不到「未执行」
 * 说明：F2 的**行为级**守卫在 boot.mjs（真调卸载器）；F3 的**行为级**守卫是
 * contract 既有的「autoClamped 异步分支有 alive 守卫」两条；本块做结构守卫，防有人改回去。 */
{
  const host54 = read('host.impl.mjs');
  const core54 = read('core.mjs');
  const client54 = read('client.js');
  const problems54 = [];
  /* F1：宿主必须解构 core 导出的 lastUserText（否则是自由标识符 ⇒ 调用即 ReferenceError）。
   * ⚠️ 必须先**剥掉注释**再比对：解构块上方那段注释里也写着 lastUserText，否则守卫会被自己的注释骗过
   * （首版就是这么 MISSED 的 —— 变异 M1 实测抓不住）。 */
  const destr54 = ((host54.match(/const \{\n([\s\S]{0,1500}?)\} = core;/) ?? [])[1] ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  if (!destr54.includes('lastUserText')) problems54.push('F1: 宿主 core 解构缺 lastUserText（仅注释里有不算）');
  if (!/lastUserText,/.test(core54)) problems54.push('F1: core 未导出 lastUserText');
  /* F2：防抖表必须由 core 清，宿主不得再引用未定义的 pending。 */
  if (!/const clearSchedules = \(\) =>/.test(core54)) problems54.push('F2: core 缺 clearSchedules');
  if (/for \(const t of pending\.values\(\)\)/.test(host54)) problems54.push('F2: 宿主仍引用未定义的 pending');
  if (!/clearSchedules\?\.\(\)/.test(host54)) problems54.push('F2: 宿主清理块未调 clearSchedules');
  /* F3：autoClamp effect 必须声明自己的 alive（不得借用上一个 effect 的）。 */
  if (!/const autoClamped = react\.useRef\(false\);[\s\S]{0,800}?let alive = true;/.test(client54)) {
    problems54.push('F3: autoClamp effect 未声明自己的 alive');
  }
  /* F4：回执必须同时写 per-sid 槽（读取端只读它）。 */
  if (/state\.m3\.lastCompactVerify = \{/.test(host54)) problems54.push('F4: 宿主仍只写全局镜像（绕过 verifyBySid）');
  if (!/\[sid\]: rec \}/.test(host54)) problems54.push('F4: 宿主未写 per-sid 槽');
  ok('R54 独立审计四条修复的结构守卫（F1 解构 / F2 clearSchedules / F3 作用域 / F4 回执同源）',
    problems54.length === 0, `实际问题：${JSON.stringify(problems54)}`);
}

/* ═══ 6.48 R55（2026-10-19 用户要求）：注入内容可视化 + 参数可配 + 文案模板 ═══
 * 用户原话：「能否将决策卡内容和提示词内容，还有相关注入的上下文线暴露到插件面板中，方便进行设置。」
 * 三条都要：① 面板只读展示注入原文；② 参数补进配置区；③ 文案模板可编辑。
 * 本块既有结构守卫，也有**行为级**断言（真跑模板层与比例切换）——结构断言单独存在时，
 * 「看起来在查、其实抓不住」的风险很高（R54 的 F1 守卫就被自己的注释骗过一次）。 */
{
  console.log('\n== 6.48 R55 注入可视化 / 参数可配 / 文案模板 ==');
  /* ① 注入原文留档 + 下发 + 渲染 */
  ok('R55①：m2 把本轮注入的逐段原文留档（含「量测失败仅回执」路径）',
    (m2src.match(/state\.m2\.lastInjection = \{/g) ?? []).length >= 2
    && /usageText: r\.text/.test(m2src) && /receiptText,/.test(m2src),
    '未留档 / 只留主路径 ⇒ 回执-only 那轮面板会显示上一轮的旧内容（比看不到更坏）');
  ok('R55①：m5 把注入原文 + 生效配置快照下发到 HUD 面',
    /injected: state\.m2\?\.lastInjection \?\? null,/.test(m5src) && /config: \(\(\) => \{/.test(m5src)
    && /engineCapProbe: state\.m3\?\.engineCapProbe \?\? null,/.test(m5src),
    'HUD 未下发 ⇒ 面板拿不到（用户无法逐字核对插件到底注入了什么）');
  ok('R65：面板不再渲染「本轮注入」整段（用户要求撤掉），改由三个模板行提供查看/复制内置文案',
  !/className: "dcp-inj"/.test(client) && !/injSec/.test(client) && !/injBlock/.test(client)
  && /"查看内置文案"/.test(client) && /"复制内置文案"/.test(client),
  '注入区仍在渲染 ⇒ 与内置文案重复、面板太乱（用户实测「太乱了」）；或模板行缺少查看/复制按钮');
  /* ② 参数可配：阈值余量（活读）+ 三档比例（整组校验 + 顺序约束） */
  ok('R55②：阈值余量活读配置（写死常量已退为默认值）',
    /const marginOf = \(\) => \{/.test(threshold) && /const v = M3\?\.engineCapMargin;/.test(threshold)
    && /engineThreshold\(agent\) - marginOf\(\)/.test(threshold),
    '仍写死常量 ⇒ 面板改值不生效（本项目已有「面板改了不生效」的教训）');
  ok('R55②：档位比例可配，且整组校验含顺序约束（深压 < 标准 < 浅压）',
    /export function setTierRatios\(next\) \{/.test(cr)
    && /if \(!\(light < standard && standard < heavy\)\) return false;/.test(cr)
    && /if \(!ok\(light\) \|\| !ok\(standard\) \|\| !ok\(heavy\)\) return false;/.test(cr),
    '比例不可配 / 无顺序约束 ⇒ 可配出「深压 > 浅压」的名不副实档位');
  ok('R55②：三档默认值仍是 8% / 16% / 24%（与既有行为逐字一致）',
    /retainRatioLight: 0\.08,/.test(hostOrCore) && /retainRatioStandard: 0\.16,/.test(hostOrCore)
    && /retainRatioHeavy: 0\.24,/.test(hostOrCore),
    '默认值不是 8/16/24 ⇒ 升级即改变既有会话的压缩行为');
  /* ③ 文案模板：护栏（缺 {tool} 回退 + 留痕）与「包在内置之后」 */
  ok('R55③：模板护栏 —— 缺必需占位符 {tool} 时回退内置并留痕（绝不注入半截）',
    /if \(!raw\.includes\('\{tool\}'\)\) \{/.test(ct) && /state\.m3\.tplFallback = \{/.test(ct)
    && /which, why: 'missing-\{tool\}'/.test(ct),
    '无护栏 ⇒ 用户写坏模板会把教学协议教坏（模型不知道调哪个工具）');
  ok('R55③：模板层包在内置**之后**（两个出口都要，null 语义不被破坏）',
    /* ⚠️ 必须逐个出口检查：只断言「文件里某处出现过 b == null ? b :」会被另一个出口蒙混过关
     * （首版就是这么 MISSED 的——变异 M5 把 renderCard 那个出口改成 false ? b : 仍全绿）。 */
    (() => {
      const w = [...ct.matchAll(/const b = render(Brief|Card)Builtin\(args\);[\s\S]{0,60}?return (b == null \? b :|false \? b :)/g)];
      return w.length === 2 && w.every((m) => m[2] === 'b == null ? b :');
    })(),
    '模板绕过内置 ⇒ renderCard 的「ratio < minRatio ⇒ null」会被破坏（凭空造出一张卡）');
  /* ③ 行为级：真跑模板层（有效模板生效 / 缺 {tool} 回退 / 未配置零侵入） */
  {
    const mod = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
    const mkApi = (M3x, stx) => mod.createCompactTool({
      svc: () => null,
      tryOf: (f) => { try { return { value: f() }; } catch (e) { return { error: String(e?.message ?? e) }; } },
      pick: (...v) => v.find((x) => x != null),
      msg: (e) => String(e?.message ?? e),
      log: () => {},
      schedule: () => {},
      state: stx,
      M3: M3x,
      readCfg: () => ({ enabled: true }),
      getDefineTool: () => null,
      getRangeApi: () => rangeMod19,
      pluginDir: null,
    });
    const st1 = { m3: {} };
    const M3a = { tplCard: '卡片：占用 {ratio}，工具 {tool}，档位 {tiers}', tplBrief: '这个模板故意不写必需占位符' };
    const api = mkApi(M3a, st1);
    const cardTxt = api.renderCard({ ratio: 0.62, minRatio: 0.2, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 });
    ok('R55③ 行为：有效模板被套用，{ratio}/{tool}/{tiers} 都被替换',
      typeof cardTxt === 'string' && cardTxt.startsWith('卡片：占用 62%')
      && cardTxt.includes('compact_context') && cardTxt.includes('深压'),
      `实际=${String(cardTxt).slice(0, 90)}`);
    const briefTxt = api.renderBrief({ criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 });
    ok('R55③ 行为：缺 {tool} 的模板回退内置 + 留痕计数（面板可见）',
      typeof briefTxt === 'string' && briefTxt.includes('context-pilot 插件说明')
      && st1.m3.tplFallback?.why === 'missing-{tool}' && st1.m3.tplFallbacks === 1,
      `实际=${String(briefTxt).slice(0, 50)}… fallback=${JSON.stringify(st1.m3.tplFallback)}`);
    const st2 = { m3: {} };
    const api2 = mkApi({ tplCard: '', tplBrief: '' }, st2);
    const builtinCard = api2.renderCard({ ratio: 0.62, minRatio: 0.2, criticalRatio: 0.75, retainRatio: 0.16, retainTokens: 160000 });
    ok('R55③ 行为：未配置模板时输出与内置一致（模板层零侵入）',
      typeof builtinCard === 'string' && builtinCard.includes('compact_context') && !builtinCard.startsWith('卡片：'),
      `实际=${String(builtinCard).slice(0, 60)}`);
    /* ⚠️ 这条是「模板不能凌驾于内置判定」的**行为级**守卫：占用未达门槛时内置返回 null，
     * 模板层必须原样放行 null——否则会凭空造出一张卡（决策卡门槛失效）。 */
    const noCard = api.renderCard({ ratio: 0.1, minRatio: 0.2, criticalRatio: 0.75 });
    ok('R55③ 行为：占用未达门槛时模板也不能造卡（null 原样放行）',
      noCard === null, `实际=${JSON.stringify(noCard).slice(0, 70)}`);
  }
  /* ② 行为级：比例可配 → 展示随之改变；非法值整组拒绝；测试自身还原（不留副作用） */
  {
    const applied = rangeMod19.setTierRatios({ light: 0.05, standard: 0.1, heavy: 0.2 });
    ok('R55② 行为：setTierRatios 生效后展示同步改变（无写死百分比漂移）',
      applied === true && rangeMod19.tierText('standard') === '标准10%' && rangeMod19.tierPct('heavy') === 20,
      `applied=${applied} standard=${rangeMod19.tierText('standard')}`);
    ok('R55② 行为：非法比例整组拒绝（顺序反了 / 越界都拒）',
      rangeMod19.setTierRatios({ light: 0.3, standard: 0.16, heavy: 0.24 }) === false
      && rangeMod19.setTierRatios({ light: 0.08, standard: 1.2, heavy: 0.24 }) === false
      && rangeMod19.tierText('standard') === '标准10%',
      `拒绝后仍应保持上次生效值，实际=${rangeMod19.tierText('standard')}`);
    rangeMod19.setTierRatios({ light: 0.08, standard: 0.16, heavy: 0.24 });
    ok('R55② 行为：还原默认后回到 8/16/24（测试不留全局副作用）',
      rangeMod19.tierText('light') === '深压8%' && rangeMod19.tierText('standard') === '标准16%'
      && rangeMod19.tierText('heavy') === '浅压24%',
      `${rangeMod19.tierText('light')}/${rangeMod19.tierText('standard')}/${rangeMod19.tierText('heavy')}`);
  }
}

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'='.repeat(52)}`);
/* ═══ R57（2026-10-19 用户要求「内置文案改成一个按钮，点击查看」）：host 必须落档内置原文 ═══
 * client 半拿不到渲染器 ⇒ 内置原文只能由 host 落档、随 HUD 的 injected 一起下发；
 * 若在 client 复制一份必然漂移。落档点是 compact-tool 的两个渲染包装器（模板在此应用之前拿到内置原文）。 */
const ctSrc57 = readFileSync(join(PLUGIN, 'compact-tool.mjs'), 'utf8');
const m2Src57 = readFileSync(join(PLUGIN, 'm2.inject.mjs'), 'utf8');
ok('R57：compact-tool 落档内置原文（state.m3.lastBuiltin.brief/card）',
  /const keepBuiltin = \(which, b\)/.test(ctSrc57) && /keepBuiltin\('brief', b\)/.test(ctSrc57) && /keepBuiltin\('card', b\)/.test(ctSrc57),
  '未落档 ⇒ 面板「查看内置文案」按钮无内容可显示');
ok('R57：m2 把内置原文随 injected 下发（builtinBrief/builtinCard，**两处** lastInjection 都要带）',
  (m2Src57.match(/builtinBrief: state\.m3\?\.lastBuiltin\?\.brief \?\? null/g) ?? []).length === 2,
  '只带一处 ⇒ 回执轮（仅量测失败那条路径）面板没有内置文案可看');

/* ═══ R57b（2026-10-19 用户实测「模板框里默认写个 0，应该为空白才对」）═══
 * 根因：toUi 一律 `Number(base)`，而 `Number("") === 0` ⇒ 空模板显示成 0；
 * 同源第二个 bug：parseInput 对 tpl 落到数值分支 ⇒ 清空即 null ⇒ 保存被拒「输入不合法」
 * ⇒ 「留空 = 用内置文案」这条路走不通。两处都要把文本类字段当字符串。 */
ok('R57b：toUi 对文本类字段（text/tpl）原样返回，不做数值归一（Number("")===0 老坑）',
  /if \(field\.type === "text" \|\| field\.type === "tpl"\) \{[\s\S]{0,140}?String\(base\)/.test(client),
  '文本字段走 Number(base) ⇒ 空模板显示成 0（用户实测：模板框里默认写个 0）');
ok('R57b：parseInput 把 tpl 当字符串（否则清空模板被拒，无法恢复「留空 = 内置文案」）',
  /if \(field\.type === "text" \|\| field\.type === "tpl"\) return typeof raw === "string" \? raw : null;/.test(client),
  'tpl 落到数值分支 ⇒ 清空即 null ⇒ 保存被拒 ⇒ 模板无法清回留空');
/* ═══ R60（2026-10-19 用户要求「还缺一个思考强度教学的输入框」+「圈红的按钮点击显示」）═══
 * 「思考强度教学」原文由 **effort 域**产出（m2 调 effortApi.renderBrief）⇒ compact-tool 拿不到原文，
 * 只能提供**通用套壳** renderTemplated；规则与 brief/card 一致（必须含 {tool}，缺则回退并留痕）。 */
ok('R60：compact-tool 导出 renderTemplated（给"别的域产出的文案"套模板）',
  /renderCard, renderTemplated, diag/.test(ctSrc57) && /const renderTemplated = \(which, text, extraVars = \{\}\)/.test(ctSrc57),
  '没有通用套壳 ⇒ 思考强度教学无法套模板（原文不在本域）');
ok('R60：m2 对思考强度教学套模板，且 {tool} 覆盖为 set_reasoning_effort',
  /renderTemplated\?\.\('tplEffBrief', effBriefBuiltin,/.test(m2Src57) && /tool: effortApi\?\.TOOL_NAME \?\? 'set_reasoning_effort'/.test(m2Src57),
  '未套模板或工具名错 ⇒ 模板里的 {tool} 会指向压缩工具，模型调错工具');
ok('R60：三个模板的内置原文都随 injected 下发（含 builtinEffBrief，两处 lastInjection）',
  (m2Src57.match(/builtinEffBrief/g) ?? []).length >= 2,
  '只带一处 ⇒ 回执轮面板「查看内置文案」为空');
ok('R60/R62：面板内置文案覆盖**三个**模板，且缺注入时回落到 HUD 的 config.builtins',
  /field\.key === "tplCard" \? \(inj\?\.builtinCard \?\? cfg\?\.builtins\?\.card\)/.test(client)
  && /inj\?\.builtinEffBrief \?\? cfg\?\.builtins\?\.effBrief/.test(client),
  '只映射两个 / 无 config.builtins 回落 ⇒ 未注入时三个「查看内置文案」全是空的（用户实测）');
/* ═══ R62（2026-10-19 用户实测三条）：① 板块要放进卡片 ② 两个按钮点了没反应 ③ 内置文案点开是空的 ═══
 * 根因同源：`inj` 为 null（host 侧本轮还没注入记录）⇒ 折叠无内容可展、内置文案也没数据。
 * ⇒ 内置文案改为 host **随时可读**：compact-tool 在 ensure() 期按当前配置预渲染一份，m5 随 config 下发。 */
const m5Src62 = readFileSync(join(PLUGIN, 'm5.hud.mjs'), 'utf8');
ok('R62：compact-tool 在 ensure() 期**预渲染**内置文案（首轮注入前面板也能看）',
  /keepBuiltin\('brief', renderBriefBuiltin\(\{ criticalRatio: M3\?\.criticalRatio/.test(ctSrc57)
  /* R72（C1）：原先传 ratio:null ⇒ renderCardBuiltin 首行守卫直接返回 null ⇒ 决策卡内置文案**恒空**。
   * 现传演示值（越过 markerMinRatio 才渲染得出卡片），断言改为「ratio 非 null + demo 标记」。 */
  && /keepBuiltin\('card', renderCardBuiltin\(\{/.test(ctSrc57)
  && /ratio: Math\.min\(0\.9, \(Number\(M3\?\.markerMinRatio\) \|\| 0\.3\) \+ 0\.08\)/.test(ctSrc57)
  && /demo: true,/.test(ctSrc57),
  '只在渲染时落档 ⇒ 首个注入之前「查看内置文案」永远是空的（用户实测）');
ok('R62：HUD 的 config 载荷带 builtins（含 effort 域的 effBrief）',
  /builtins: \{ \.\.\.\(state\.m3\?\.lastBuiltin \?\? \{\}\), effBrief: state\.m2\?\.lastEffBriefBuiltin \?\? null \}/.test(m5Src62),
  'config 不带 builtins ⇒ 面板只能等注入，点开就是空的');
ok('R62：m2 长期留档 effBrief 内置原文（effort 域产出，别的域拿不到）',
  /state\.m2\.lastEffBriefBuiltin = effBriefBuiltin;/.test(m2Src57),
  '不落档 ⇒ 思考强度教学的内置文案只能等注入那一次');
/* ═══ R67（2026-10-19 用户要求）：上限随「阈值余量」实时重算 + 强制压缩线联动钳制 ═══
 * 用户：「我应该设置 0.1，应该自动钳回 0.7」。旧实现 engineCap 只在挂载时拉一次 ⇒ 改余量不重算上限。 */
ok('R67：上限按活值重算（引擎阈值 − 当前草稿余量），并联动把强制压缩线钳下来',
  /const engineThresholdNow = engineCap === null \? null : engineCap \+ marginSaved;/.test(client)
  && /const capNow = engineThresholdNow === null \? null : Math\.max\(0, roundRatio\(engineThresholdNow - marginDraft\)\);/.test(client)
  && /cur <= capNow\) return d;/.test(client),
  '上限不随余量重算 / 草稿不联动钳制 ⇒ 改余量后强制压缩线不动（用户实测）');
ok('R67：输入钳制与保存钳制都用 capNow（不是挂载时的旧上限）',
  /if \(field\.key === "criticalRatio" && capNow !== null\)/.test(client)
  && /const cap = capNow !== null && capNow > 0 && capNow <= 1 \? capNow : null;/.test(client),
  '仍用 engineCap ⇒ 改了余量后保存仍按旧上限钳');
ok('R68：上限做浮点归一（4 位小数），否则输入框会显示 0.7000000000000001（用户实测）',
  /const roundRatio = \(x\) => Math\.round\(Number\(x\) \* 1e4\) \/ 1e4;/.test(client)
  && /Math\.max\(0, roundRatio\(engineThresholdNow - marginDraft\)\)/.test(client),
  '直接相减 ⇒ 0.75+0.05−0.1 的浮点误差被写进输入框（用户截图 0.7000000000000001）');
/* ═══ R69（2026-10-21 用户要求「把最近换档的时间加上日期显示」）═══
 * 原实现 toLocaleTimeString ⇒ 只有时:分:秒；lastSwitch 会落盘，跨天/跨重启后分不清是哪天。 */
const effortSrc69 = readFileSync(join(PLUGIN, 'effort.mjs'), 'utf8');
ok('R69：最近换档时间带**日期**（YYYY-MM-DD HH:MM:SS），不再只有时分秒',
  /const fmtSwitchAt = \(ms\) => \{/.test(effortSrc69)
  && /return \`\$\{d\.getFullYear\(\)\}-\$\{p\(d\.getMonth\(\) \+ 1\)\}-\$\{p\(d\.getDate\(\)\)\}/.test(effortSrc69)
  && !/toLocaleTimeString\('zh-CN'/.test(effortSrc69),
  '仍只有时:分:秒 ⇒ 跨天/跨重启后分不清是哪天（lastSwitch 是落盘数据）');
ok('R69：不依赖 locale 拼时间（自补零）——不同 locale 的 toLocaleString 分隔符会打乱 tooltip',
  /const p = \(n\) => String\(n\)\.padStart\(2, '0'\);/.test(effortSrc69),
  '依赖 toLocaleString ⇒ 换 locale 后格式漂移');
/* ═══ R70（2026-10-21 用户实测「这个趋势计算好像不太准确」）═══
 * 旧实现：只看上一轮单轮增量 + 压缩后基线不重置 + 两处轮数取整不一致（ceil vs floor）。
 * 新实现：最近 N 轮均值 / 骤降即重置基线 / 统一 Math.round(≥1)。 */
ok('R70：趋势取**最近 N 轮均值**（TREND_SAMPLES），不再用单轮增量外推',
  /const TREND_SAMPLES = 4;/.test(m2src) && /rec\.deltas\.reduce\(\(a, b\) => a \+ b, 0\) \/ samples/.test(m2src),
  '仍用单轮增量 ⇒ 一轮贴图/大 diff 就能把「还有几轮」算成 1 轮（用户实测不准）');
ok('R70：检测到上下文**骤降**即重置基线（压缩后不拿旧增量外推）',
  /const resetByCompaction = prev != null/.test(m2src) && /rec\.deltas = \[\]/.test(m2src)
  && /resetByCompaction/.test(m2src),
  '压缩后基线不重置 ⇒ 增量为负、趋势行消失或算出离谱值');
const ct70 = readFileSync(join(PLUGIN, 'compact-tool.mjs'), 'utf8');
ok('R70：刚压缩时卡片**明确说明**基线已重置（不给外推）',
  /刚刚压缩过（上下文骤降）⇒ 基线已重置/.test(ct70) && /resetByCompaction === true/.test(ct70),
  '压缩后仍给一个外推轮数 ⇒ 用的是压缩前的巨量增量，误导决策');
ok('R70：两处轮数**同口径取整**（turnsToLine 与「两个方向」里的 turns 都用 Math.round 且 ≥1）',
  /Math\.max\(1, Math\.round\(\(\(crit - ratio\) \* win\) \/ deltaTokens\)\)/.test(m2src)
  && /Math\.max\(1, Math\.round\(leftTokens \/ delta\)\)/.test(ct70),
  'ceil/floor 混用 ⇒ 同一张卡出现 18 与 37 两个互相矛盾的数字（用户实测）');
/* ═══ R71（GLM-5.3-Flash 两份独立审查 + 逐条验伪；本轮采纳 13 项）═══
 * 说明：派发时指定的 GLM-5.3 被 runner 静默替换为 GLM-5.3-Flash（免费额度只授予 Flash），
 * 故两份报告实际同模型不同思考强度；每条发现都由 Lead 回到源码逐条验真后才落地。 */
const core71 = readFileSync(join(PLUGIN, 'core.mjs'), 'utf8');
ok('R71 报告热路径：writeReport 用 stat 指纹门控，指纹一致才跳过全量 parse',
  /writtenFingerprint = statFingerprint\(\)/.test(core71)
  && /if \(writtenFingerprint != null && statFingerprint\(\) === writtenFingerprint\) \{/.test(core71)
  && /const st = statSync\(reportPath\);/.test(core71),
  '仍每次 JSON.parse 整份 MB 级报告 ⇒ 活跃期每秒一次全量解析（审查 F-01/#2）');
ok('R71 死导出：messageTextLength 已删（定义与出口都不得残留）',
  !/messageTextLength/.test(core71), '死导出残留 ⇒ 后人以为有人用（审查 F-05）');
const m2r71 = readFileSync(join(PLUGIN, 'm2.inject.mjs'), 'utf8');
ok('R71 回执送达：中步路径先判 createUserMessage（noFactory 守卫），不再裸调用',
  /const midFactory = getCreateUserMessage\(\);/.test(m2r71)
  && /if \(!midFactory\) \{/.test(m2r71)
  && /state\.m2\.skips\.noFactory = \(state\.m2\.skips\.noFactory \?\? 0\) \+ 1;/.test(m2r71)
  && !/const msgMid = getCreateUserMessage\(\)\(?:\{/.test(m2r71),
  '工厂未就绪时 TypeError 被吞 ⇒ 一次性回执取出即丢、永不送达（审查 F-02/#3）');
ok('R71 有界化：m2.nudged 有 64 键上限（与同文件 decisionRepeat 同款）',
  /if \(nudgeKeys\.length > 64 && !\(sid in bySid\)\) delete bySid\[nudgeKeys\[0\]\];/.test(m2r71),
  '无界 Map ⇒ 长跑多会话缓慢增长（审查 F-09/#5）');
const effr71 = readFileSync(join(PLUGIN, 'effort.mjs'), 'utf8');
ok('R71 有界化：effort.bySid 有 EFFORT_SID_CAP 且淘汰最旧',
  /const EFFORT_SID_CAP = 200;/.test(effr71) && /if \(bySid\.size > EFFORT_SID_CAP\)/.test(effr71),
  '无界 Map（审查 F-08/#4）');
const m3r71 = readFileSync(join(PLUGIN, 'm3.compact.mjs'), 'utf8');
ok('R71 回执原因真实：wanted 提到 try 外，catch 按真实触发报 trigger',
  /let wanted = false;/.test(m3r71) && new RegExp("trigger: wanted \\? 'context-overflow' : 'pressure'").test(m3r71),
  '失败回执硬写 pressure ⇒ 模型主动请求时原因失真（审查 F-11）');
const sf71 = readFileSync(join(PLUGIN, 'session-facts.mjs'), 'utf8');
ok('R71 中位：偶数样本取两中值平均（不再取上中位）',
  /return a\.length % 2 \? a\[mid\] : \(a\[mid - 1\] \+ a\[mid\]\) \/ 2;/.test(sf71),
  '上中位使回落量系统性偏大 ⇒ 稳定后占用偏低（审查 #9）');
ok('R71 面板：挂载只拉一次 getHud 且带 sid（不再两次无 sid）',
  /getHud\(resolveSid\(\)\)/.test(client) && !/const pullCap = async/.test(client)
  && !/await hudRemoteSvc\.getHud\(""\)/.test(client),
  '两次挂载 RPC + cap 永不命中 modelPolicies（审查 #6/F-10）');
ok('R71 口径漂移收敛：不再宣传已退役的压缩标记通道，死样式 .dcp-inj* 已删',
  !/压缩标记通道/.test(client) && !/\.dcp-inj\{/.test(client) && !/\.dcp-inj-h\{/.test(client),
  '用户会照旧文案等一个不存在的机制（审查 #1/F-07）+ 死样式（Lead 独立发现）');
const hi71 = readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8');
ok('R71 host.impl：删掉死解构 TAG/HISTORY_CAP（原仅出现在解构与注释里）',
  !/HEARTBEAT_MS, TAG,/.test(hi71) && !/COMPACT_TIMEOUT_MS, HISTORY_CAP,/.test(hi71),
  '死解构（审查 F-04）；注意：删注释不省代码行预算，此项收益在可读性不在预算');
/* ═══ R71（F-14 修复：派发审查提出、Lead 深挖后落地）═══
 * 依据：R5 真机实测 official(context-overflow) 的 retainTokens=0，在**仅 53% 占用**时把 surface 从
 * 367,794 砍到 8,603（nodeCount 1117 → 4，-97.7%）。所以「range 模块未就绪」绝不能无条件回落该通道。 */
{
  const m3ModF14 = await import(pathToFileURL(join(PLUGIN, 'm3.compact.mjs')).href);
  const stF14 = { m3: {} };
  let officialCalls = 0;
  const m3F14 = m3ModF14.createM3Compaction({
    state: stF14, log: () => {}, msg: (e) => String(e?.message ?? e),
    pick: (...a) => a.find((x) => x != null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    nfmt: (n) => String(n), errCodeOf: (e) => String(e?.code ?? 'err'), schedule: () => {},
    svc: () => null, M3: {}, effEnabled: () => true, criticalCapOf: () => 0.8,
    resolveCompactionFor: () => ({ service: null, via: 'stub' }),
    publishHud: () => {}, recordHudAct: () => {}, formatAct: () => '',
    clearBriefed: () => {}, awaitRange: async () => null, getCompactTool: () => null,
    COMPACT_TIMEOUT_MS: 1000, SET_CAP: 200,
  });
  const svcF14 = { service: { compactIfNeeded: async () => { officialCalls += 1; return { shadowedTokenCount: 999999 }; } }, via: 'test' };
  const ctxF14 = (forced) => ({ forced, sig: 'sig-f14', sid: 'sid-f14', window: 1000000, measure: {}, tierName: 'standard' });
  const lowF14 = await m3F14.compactWithOwnRange({ session: {} }, svcF14, ctxF14(false));
  ok('R71 行为级（F-14）：range 模块未就绪 + 未越强制线 ⇒ 不回落官方 overflow、不压',
    lowF14.source === 'none' && lowF14.skipWhy === 'range-module-pending'
    && lowF14.result === null && officialCalls === 0 && (stF14.m3.rangePendingSkips ?? 0) === 1,
    `实际 ${JSON.stringify({ source: lowF14.source, skipWhy: lowF14.skipWhy, result: lowF14.result, officialCalls, skips: stF14.m3.rangePendingSkips })}`);
  const hiF14 = await m3F14.compactWithOwnRange({ session: {} }, svcF14, ctxF14(true));
  ok('R71 行为级（F-14）：已越强制线 ⇒ 仍回落官方（安全网必须保留）',
    hiF14.source === 'official' && officialCalls === 1,
    `实际 ${JSON.stringify({ source: hiF14.source, officialCalls })}`);
}
const m3src71 = readFileSync(join(PLUGIN, 'm3.compact.mjs'), 'utf8');
ok('R71 源码级（F-14）：调用方守卫在**消费意图之前**，且内层也有二道防线',
  m3src71.indexOf('if (!rangeReady) {') > 0
  && m3src71.indexOf('if (!rangeReady) {') < m3src71.indexOf('tool.takeIntent(sid)')
  && (m3src71.match(/range-module-pending/g) ?? []).length >= 2
  /* R71：**两条路径都要计数**（调用方守卫 + 内层二道防线）——只数一处会让另一处的事故无从取证。 */
  && (m3src71.match(/state\.m3\.rangePendingSkips =/g) ?? []).length >= 2, // 数**赋值点**（同一行里标识符会出现两次，数标识符会被蒙混）
  '守卫在 takeIntent 之后 ⇒ 意图已白吃、模型以为排上了；只有一处 ⇒ 别的入口仍会清场');
/* ═══ R72（真 GLM-5.3 审查：7 条 P1 + 若干 P2；每条先回源码验伪再落地）═══
 * 背景：上一轮派发时 runner 把 GLM-5.3 静默替换成 Flash（只看单一 q.model 判定权益），
 * 修成「按授予集合判定」后真 GLM-5.3 跑通（modelId 实测 GLM-5.3、providerError=null）。 */
{
  const ctModR72 = await import(pathToFileURL(join(PLUGIN, 'compact-tool.mjs')).href);
  let specR72 = null;
  const stR72 = { m3: { compactToolDiag: { calls: 0 } } };
  const apiR72 = ctModR72.createCompactTool({
    svc: (k) => (k === 'tools' ? { register: () => {} } : null),
    tryOf: (f) => { try { return { value: f(), error: null }; } catch (e) { return { value: undefined, error: String(e) }; } },
    pick: (...a) => a.find((x) => x != null), msg: (e) => String(e?.message ?? e), log: () => {}, schedule: () => {},
    /* 必须**真的配一个模板**：applyTpl 在模板为空时返回 null ⇒ 回退内置原文（不经过占位符替换）。
     * ⚠️ 模板来自**注入的 M3**（宿主 mergeConfig 的活值），不是 readCfg —— 我第一次就传错了位置。 */
    M3: { tplEffBrief: '内置：先想到 {tool}；档位 {tiers}；当前 {current}' },
    state: stR72, readCfg: () => ({ enabled: true, effortEnabled: true }),
    getDefineTool: () => (sp) => { specR72 = sp; return sp; },
    getRangeApi: rangeStub,
  });
  apiR72.ensure();
  const agentR72 = { session: { id: 'sess-r72' }, id: 'sess-r72' };
  const runR72 = (args) => specR72.execute(args, { agent: agentR72 });

  /* H4：`{tool}` 必须被 extraVars 覆盖成**本域**工具名（否则思考强度教学教模型去调压缩工具） */
  const outH4 = apiR72.renderTemplated('tplEffBrief',
    '内置：先想到 {tool}；档位 {tiers}；当前 {current}', { tool: 'set_reasoning_effort', current: 'high', tiers: 'low/high/max' });
  ok('R72 行为级（H4）：思考强度教学模板的 {tool} 解析成换档工具，绝不能是 compact_context',
    typeof outH4 === 'string' && outH4.includes('set_reasoning_effort') && !outH4.includes('compact_context')
    && outH4.includes('high') && outH4.includes('low/high/max'),
    `实际 ${JSON.stringify(outH4)}`);

  /* H5：action 打错字必须**可见失败**，不能静默落成真压缩 */
  const rH5 = await runR72({ action: 'set_tier', tier: 'heavy' });
  ok('R72 行为级（H5）：action 写错（set_tier）⇒ 明确报错，且不登记压缩意图',
    rH5?.ok === false && /action 只能是 compact 或 set-tier/.test(String(rH5?.error)) && apiR72.peekIntent('sess-r72') === null,
    `实际 ${JSON.stringify(rH5)}`);
  const rH5ok = await runR72({ action: 'set-tier', tier: 'light' });
  ok('R72 反向（H5）：合法 action 不被误伤（set-tier 仍只登记档位）',
    rH5ok?.ok === true && rH5ok?.action === 'set-tier', `实际 ${JSON.stringify(rH5ok)}`);

  /* C1：ensure() 期预渲染的**决策卡**内置文案必须非空（此前 ratio:null ⇒ 恒 null） */
  ok('R72 行为级（C1）：ensure() 后决策卡内置文案非空（此前「查看内置文案」对卡片恒为空）',
    typeof stR72.m3.lastBuiltin?.card === 'string' && stR72.m3.lastBuiltin.card.length > 100
    && typeof stR72.m3.lastBuiltin?.brief === 'string' && stR72.m3.lastBuiltin.brief.length > 100,
    `card=${(stR72.m3.lastBuiltin?.card ?? '').length} brief=${(stR72.m3.lastBuiltin?.brief ?? '').length}`);
}

/* H1：`lastUserText` 必须读 `surface.nodes`（DSH 的 Session.surface 是 SurfaceManager，不是数组） */
const coreSrc72 = readFileSync(join(PLUGIN, 'core.mjs'), 'utf8');
ok('R72（H1）：lastUserText 读 surface.nodes，且兼容"数组形态"',
  /Array\.isArray\(session\?\.surface\) \? session\.surface : session\?\.surface\?\.nodes/.test(coreSrc72),
  '只写 session?.surface ⇒ Array.isArray 恒 false ⇒ 恒返回空串 ⇒ 换档提醒两个触发从未生效');

/* H2：其余 official 兜底入口同样只在**越强制线**时才允许走 retainTokens=0 通道 */
const m3Src72 = readFileSync(join(PLUGIN, 'm3.compact.mjs'), 'utf8');
ok('R72（H2）：guardOfficial 收口其余官方兜底（surface-mismatch/boundary-exhausted/invalid-boundary）',
  /const guardOfficial = async \(why\) => \{/.test(m3Src72)
  && /if \(forced\) return official\(why\);/.test(m3Src72)
  && /return guardOfficial\(sel\.why\);/.test(m3Src72)
  && /return guardOfficial\('boundary-exhausted'\);/.test(m3Src72)
  && /return guardOfficial\('invalid-boundary'\);/.test(m3Src72),
  'F-14 只堵了 no-range-module ⇒ 其余入口在低占用时仍会把近端砍光（R5 实测 1117 节点→4）');

/* H3：中步回执必须**先判工厂再取回执**（顺序反了 = 取出即标 read ⇒ 永远丢） */
const m2Src72 = readFileSync(join(PLUGIN, 'm2.inject.mjs'), 'utf8');
ok('R72（H3）：中步回执的工厂判定在 takeCompactReceipt **之前**',
  m2Src72.indexOf('const midFactory = getCreateUserMessage();') > 0
  && m2Src72.indexOf('const midFactory = getCreateUserMessage();') < m2Src72.indexOf('takeCompactReceipt(sidEarly)'),
  '顺序反了 ⇒ 回执被取出并标 read=true 后才 skip ⇒ 回执永久丢失（R71 修复不完整）');

/* H6 / C2 / C3 / C9 / C10：client 侧四处修正 */
ok('R72（H6）：面板不再指向不存在的「刷新页面」按钮',
  !/刷新页面/.test(client) && /重新打开本面板后重试/.test(client),
  '用户按提示找不到控件；R65 撤注入区时按钮被连带删除而文案残留');
ok('R72（C2）：预设按钮用 data-active（React 不支持 dataset prop）',
  /"data-active": active === p\.id \? "1" : "0"/.test(client) && !/dataset: \{ active/.test(client),
  'dataset prop 不落成 DOM 属性 ⇒ CSS 选中态永不命中');
ok('R72（C3）：自动钳回落盘前归一（否则浮点尾差写进配置并产生幽灵 dirty）',
  /await writeField\(settingsScope, field, roundRatio\(engineCap\)\)/.test(client),
  'R68 只归一了显示用的 capNow，落盘仍是原始浮点');
ok('R72（C9）：窗口缺失时不渲染 NaN 距离',
  /const occWin = num\(v\.occupancyWindow, null\);/.test(client) && /occWin \* \(crit - occ\)/.test(client),
  'host 允许 ratio 有值而 window 为 null ⇒ 会显示「距智能压缩线 NaN」');
ok('R72（C10）：清空「阈值余量」输入框不得把空串当 0',
  /if \(typeof raw === "string" && raw\.trim\(\) === ""\) return marginSaved;/.test(client),
  'Number("") === 0 会通过范围校验 ⇒ 草稿期上限瞬时变成引擎阈值全额');
ok('R72（S1/H7）：宿主死委托已删，行预算注释与实测一致',
  !/compactWithOwnRange/.test(readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
  && /314，余量仅 6 行/.test(readFileSync(join('test', 'static.mjs'), 'utf8')),
  '死委托占预算；注释写 294 会误导后来者');
console.log(`契约对账：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);

