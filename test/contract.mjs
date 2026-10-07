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

/* ═══════════ 6.8 R1 智能思考字段三端对账 ═══════════ */
console.log('\n== 6.8 智能思考字段（FIELDS ↔ schema ↔ M3_DEFAULTS）==');
ok('FIELDS 含 effortEnabled', fieldsKeys.includes('effortEnabled'), '面板缺该字段');
ok('schema 含 effortEnabled', schemaKeys.includes('effortEnabled'), 'schema 缺该字段 ⇒ 面板保存被拒');
ok('M3_DEFAULTS 含 effortEnabled', hostDefaults.includes('effortEnabled'), 'host 缺该字段 ⇒ 读不到');
ok('mergeConfig 读取 effortEnabled', /for \(const k of \[[\s\S]{0,120}'effortEnabled'/.test(host),
  'mergeConfig 未读 ⇒ 面板改值不生效');
ok('effortEnabled 默认关闭（新功能默认不介入）', /effortEnabled:\s*false/.test(host),
  '默认开启 ⇒ 未确认就改变既有会话行为');

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
