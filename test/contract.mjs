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

/* ═══════════ 6.9 输入框档位 chip（conversation.input.right）═══════════ */
console.log('\n== 6.9 输入框档位 chip（位置/显示条件/文本形态）==');
// 用户要求（2026-10-07）：输入框模型左侧显示「智能思考档位:XXX」，后改为**不用冒号、用间距**。
ok('chip 注册到 conversation.input.right（模型选择器左侧）',
  /ctx\.slots\.inject\("conversation\.input\.right"/.test(client),
  '未注册到 conversation.input.right ⇒ 位置不对（源码实证该 slot 紧邻 conversation.input.model）');
ok('chip 注册 id 独立（不与官方条目撞车）', /id:\s*"context-pilot-effort"/.test(client),
  '未用自有 id ⇒ 可能替换官方条目');
ok('chip 仅在 effortEnabled 开启时显示',
  /if \(!hostInfo \|\| !effort\) return null;/.test(client),
  '缺少显示条件 ⇒ 开关关闭时仍显示');
ok('chip 不用冒号分隔（用户要求改间距）', !/智能思考档位:\$\{/.test(client) && !/`智能思考档位:/.test(client),
  '仍用「智能思考档位:XXX」冒号形态 ⇒ 用户要求改成间距');
ok('chip 用两个 span + gap 呈现（间距 6px）',
  /el\("span", \{ style: \{ opacity: "\.75" \} \}, "智能思考档位"\)/.test(client) &&
  /gap: "6px"/.test(client),
  '未拆成「标签 + 值」两个 span + 间距');
/* ⚠️ 用户明确要求「不要 5S 轮询」（2026-10-07）。档位必须走**响应式投影**：
 * `useProjection("modelSelection")`（官方 UI 同款，dsh-client-ui-conversation L17240 同形），
 * 投影由会话事件驱动（model/selection、request/header）⇒ 换档落库即重渲染，零轮询。
 * 开关状态 + 冷却走 getHud，但只在**挂载时 + 投影变化时**各一次（事件驱动，非定时器）。 */
ok('档位走响应式投影 useProjection（不是轮询）',
  /up\("modelSelection"\)/.test(client) && /props && props\.useProjection/.test(client),
  '未用 useProjection("modelSelection") ⇒ 又退化成轮询/静态值');
/* setInterval 只允许用于**冷却倒计时**（本地 1s tick，且冷却结束即停）；
 * 不得用于「定期问 host 要档位」——那正是用户要去掉的 5s 轮询。
 * 判据：定时器回调里只能有 setNow，不得出现 getHud/pullOnce。 */
const chipBody = /function EffortChip\([\s\S]*?\n\t\t\}/.exec(client)?.[0] ?? '';
ok('解析出 EffortChip 函数体', chipBody.length > 0, '未找到 EffortChip');
ok('chip 不用定时器轮询 host（用户明确要求去掉 5s 轮询）',
  !/setInterval\([^)]*(?:getHud|pullOnce)/.test(chipBody),
  'EffortChip 内用 setInterval 定期拉 host ⇒ 违反「不要 5S 轮询」');
ok('chip 的定时器仅用于冷却倒计时且冷却结束即停',
  /if \(!cooling\) return undefined;/.test(chipBody) && /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/.test(chipBody),
  '倒计时未按 cooling 条件启停 ⇒ 常驻定时器（变相轮询）');
ok('冷却显示在档位后面（用户要求）',
  /冷却 \$\{coolLeft\}s/.test(chipBody) && /coolLeft > 0\s*\n?\s*\?/.test(chipBody),
  '未在档位后显示冷却剩余秒数');
ok('冷却只在确实冷却时占位（结束后不显示）',
  /const cooling = until > now;/.test(chipBody),
  '未判断 cooling ⇒ 冷却结束后仍显示「冷却 0s」');
ok('投影 pending 优先显示（已选待生效提前可见）',
  /sel\.pending \|\| sel\.lastUsed/.test(client),
  '未优先取 pending ⇒ 换档后要等下一轮才显示');
ok('host 信息在投影变化时重问（事件驱动，非定时器）',
  /settingsScope\.subscribe\?\.\(\(\) => \{ pullOnce\(\); \}\)/.test(client) &&
  /\}, \[effort, pendingNow\]\);/.test(client),
  '未按投影变化重问 ⇒ 换档后冷却状态不更新');

/* ═══════════ 6.8 R1 智能思考字段三端对账 ═══════════ */
console.log('\n== 6.8 智能思考字段（FIELDS ↔ schema ↔ M3_DEFAULTS）==');
ok('FIELDS 含 effortEnabled', fieldsKeys.includes('effortEnabled'), '面板缺该字段');
ok('schema 含 effortEnabled', schemaKeys.includes('effortEnabled'), 'schema 缺该字段 ⇒ 面板保存被拒');
ok('M3_DEFAULTS 含 effortEnabled', hostDefaults.includes('effortEnabled'), 'host 缺该字段 ⇒ 读不到');
ok('mergeConfig 读取 effortEnabled', /for \(const k of \[[\s\S]{0,120}'effortEnabled'/.test(host),
  'mergeConfig 未读 ⇒ 面板改值不生效');
ok('effortEnabled 默认关闭（新功能默认不介入）', /effortEnabled:\s*false/.test(host),
  '默认开启 ⇒ 未确认就改变既有会话行为');

/* ═══════════ 6.10 R1 智能思考注入（门控解耦 + 教学覆盖度）═══════════ */
console.log('\n== 6.10 智能思考注入（门控必须与压缩解耦）==');
// 用户要求「全程允许」——注入与换档**不得**引用压缩的 markerMinRatio 门控。
// 现有 M2 注入三部分门控不同：用量行无门控 / 决策卡 ratio>=markerMinRatio / 一次性说明首次。
// 思考强度必须是**第四条独立通道**：门控 = effortEnabled，与占用无关。
const injectBody = (() => {
  const m = /const card = renderPolicyCard\(r\.ratio\);([\s\S]*?)return \{ \.\.\.decision, messages:/.exec(host);
  return m ? m[1] : '';
})();
ok('解析出 M2 注入主体', injectBody.length > 0, '未匹配到注入主体（改名了？）');
/* 只截取 **effort 相关**的那几行（从注释「R1 智能思考」到教学标记结束）——
 * 不能截整个注入主体：它包含 renderPolicyCard 行，而卡本身合法引用 markerMinRatio。 */
const effInject = (() => {
  const s = host.indexOf('/* R1 智能思考：**独立门控**');
  if (s < 0) return '';
  const e = host.indexOf('const fullText =', s);
  return e > s ? host.slice(s, e) : '';
})();
ok('解析出 effort 注入段', effInject.length > 0, '未找到 effort 注入段');
ok('智能思考注入用独立门控 effortEnabled（不共用 markerMinRatio）',
  /if \(M3\.effortEnabled === true\) eff = await readEffort\(agent\)/.test(effInject),
  'effort 注入未走 effortEnabled 独立门控 ⇒ 低占用时被压缩门控挡掉（用户要求全程允许）');
/* ⚠️ R2 真 bug 修复（2026-10-08 实测）：懒安装必须**早于 `step !== 1` 早退**。
 * 原实现塞在注入分支内 ⇒ 一轮里只有 step 1 能执行到；若首步就有工具调用，
 * 后续 pre-step 的 step 恒 >1 ⇒ 钩子永远装不上 ⇒ **工具接受成功却永不变档**
 * （实测：effortToolCalls=1、effortSwitches=0、effortHooks 从未赋值）。 */
ok('懒安装早于 step!==1 早退（防「工具接受但永不变档」）',
  (() => {
    const s = host.indexOf('ensureEffortHooks(); // R1：懒安装');
    const g = host.indexOf('if (step !== 1) return decision;');
    return s > 0 && g > 0 && s < g;
  })(),
  '懒安装仍在 step!==1 早退之后 ⇒ 首步即调工具时钩子永不安装');
ok('registerEffortTool 懒注册同样早于早退',
  (() => {
    const s = host.indexOf('registerEffortTool(); // R2：确保工具已注册');
    const g = host.indexOf('if (step !== 1) return decision;');
    return s > 0 && g > 0 && s < g;
  })(),
  '工具懒注册在早退之后 ⇒ 会话中途打开开关时不生效');
/* 剥注释后再查：注释里说明「与 markerMinRatio 解耦」是正常文字，代码里引用才是耦合。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('effort 注入段不引用 markerMinRatio（剥注释后）', !/markerMinRatio/.test(stripComments(effInject)),
  'effort 注入段**代码**引用了 markerMinRatio ⇒ 与压缩门控耦合');
ok('读档失败不阻断注入（try/catch 吞）',
  /catch \{ \/\* 读档失败 ⇒ 不注入/.test(host) || /if \(M3\.effortEnabled === true\) eff = await readEffort/.test(injectBody),
  '读档异常未吞 ⇒ 新功能可打崩主注入流程');
ok('思考强度教学与插件说明同时机（会话首次）',
  /effBriefedBySid\.has\(sid\) \? renderEffortBrief\(eff\)/.test(injectBody) ||
  /!effBriefedBySid\.has\(sid\)/.test(injectBody),
  '教学未按会话一次性 ⇒ 每轮重复占 token');
ok('用量行后缀拼装（每轮告知当前实际档位）',
  /effSuffix \? `\$\{r\.text\} ｜ \$\{effSuffix\}` : r\.text/.test(injectBody),
  '未拼后缀 ⇒ 模型不知道当前**实际生效**档位');
// 教学文本覆盖度 6/6（用户指出「暴露了但不会调用」——必须教）
// R2 变更：③ 由「标记语法」改为「**工具名 + 调用方式**」；⑤ 由「下一步生效」改为「本次任务内立即生效」
const effBrief = /const renderEffortBrief = \(eff\) => \{([\s\S]*?)\n  \};/.exec(host)?.[1] ?? '';
ok('解析出 renderEffortBrief', effBrief.length > 0, '未找到教学文本函数');
for (const [name, re] of [
  ['① 当前值', /当前思考强度档位：' \+ eff\.current/],
  ['② 可选档', /本模型可选 ' \+ opts/],
  ['③ 工具名+调用方式', /EFFORT_TOOL_NAME \+ '（参数 effort=<档位>）'|调用工具 '/],
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

/* ═══════════ 6.12 R1 换档执行通道（agent.ctx 作用域，非 global）═══════════ */
console.log('\n== 6.12 换档执行通道（agent/request 挂在 agent.ctx 上）==');
// 源码实证（2026-10-07）：`waterfall("agent/request", {turn,step,signal}, seed)` 的 payload
// **只有 turn/step/signal，没有 agent** ⇒ 不能用 payload 找会话（第一版实现踩了这个坑，
// 会导致 per-session 查找恒不命中、换档静默失效）。
// 官方 installModelSelection 的做法：注册在 **agent.ctx**（dsh-agent/lib/types/model-selection.js L45/L61，
// 调用方 api-session-controller L310 传 agent.ctx）。本插件同款：按 agent 懒安装 + WeakSet 去重。
ok('换档钩子装在 agent.ctx（不是插件 ctx 的 global）',
  /agent\.ctx\.on\('agent\/request'/.test(host),
  '未装在 agent.ctx ⇒ payload 无 agent，per-session 查找恒不命中（换档静默失效）');
ok('未使用插件级 global agent/request（payload 无 agent 会失效）',
  !/state\.listeners\['agent\/request'\]\s*=\s*addListener/.test(host),
  '仍注册插件级 agent/request ⇒ 拿不到 agent');
ok('钩子按 agent 去重（WeakSet，防重复安装）',
  /const effortHookInstalled = new WeakSet\(\)/.test(host) && /effortHookInstalled\.has\(agent\)/.test(host),
  '未去重 ⇒ 每次 pre-step 重复注册，waterfall 回调叠加');
ok('钩子懒安装（新会话自动覆盖）', /const ensureEffortHooks = \(\) => \{/.test(host) && /results\.push\(installEffortRequestHook\(a\)\)/.test(host),
  '无懒安装 ⇒ 新会话拿不到钩子');
/* R2 取证要求（2026-10-08）：ensureEffortHooks 曾**全静默**——工具链路已通但 apply 从不执行时
 * 无法定位断点（实测踩到：effortToolCalls=1 而 effortSwitches=0）。
 * 现必须留痕：调用次数 / enabled / agent 数 / 每个 agent 的安装结果 / 异常。 */
ok('懒安装有取证留痕（防静默失败）',
  /state\.m3\.effortEnsure/.test(host) && /lastResults/.test(host) && /lastAgents/.test(host),
  '懒安装无留痕 ⇒ 工具接受但不变档时无法定位');
ok('钩子安装失败有留痕（agent.ctx 不可用时）',
  /state\.m3\.effortHookError = \{/.test(host),
  '安装失败静默 return false ⇒ 无法区分「没调用」与「调用了但失败」');
ok('pre-step 会触发懒安装', /if \(M3\.effortEnabled === true\) \{[\s\S]{0,120}?ensureEffortHooks\(\)/.test(host),
  'pre-step 未调用 ensureEffortHooks ⇒ 钩子永不安装');
/* 实测风险（2026-10-07 E2E 排查中发现）：sid 若只在**安装期**捕获一次，而本项目实测
 * session id 会轮转（压缩后 / 多会话交错）⇒ 标记解析路径写入的 sid 与钩子查询的 sid
 * 可能不一致 ⇒ pendingEffortBySid 查不到 ⇒ **换档静默失效**。
 * 修复：请求时**现读** sid（优先），安装期值仅作兜底（两者取并集查找）。 */
ok('sid 在请求时现读（不只依赖安装期捕获）',
  /const sidNow = String\(pick\(agent\.session\?\.id/.test(host),
  'sid 仅在安装期捕获 ⇒ id 轮转后 pending 查不到，换档静默失效');
ok('现读 sid 未命中时回退安装期值（并集查找）',
  /pendingEffortBySid\.get\(sidNow\) \?\? \(sidAtInstall !== sidNow \? pendingEffortBySid\.get\(sidAtInstall\)/.test(host),
  '无回退 ⇒ 两种 sid 不一致时丢失待应用档位');
ok('删除/记忆用实际命中的 key（避免孤儿 pending）',
  /const sidKey = pendingEffortBySid\.get\(sidNow\) \? sidNow : sidAtInstall;/.test(host) &&
  /pendingEffortBySid\.delete\(sidKey\)/.test(host),
  '用固定 sid 删除 ⇒ 命中另一 key 时留下孤儿 pending（下次误触发）');
// 声明顺序（const 无提升，TDZ 会抛 ReferenceError）
for (const [name, def, use] of [
  ['installEffortRequestHook', 'const installEffortRequestHook', 'installEffortRequestHook(a)'],
  ['ensureEffortHooks', 'const ensureEffortHooks', 'ensureEffortHooks();'],
  ['registerEffortTool', 'const registerEffortTool', 'registerEffortTool();'],
]) {
  ok(`${name} 声明早于使用（防 const TDZ）`, host.indexOf(def) < host.indexOf(use),
    `${name} 声明在使用之后 ⇒ 运行时 TDZ 抛错`);
}
ok('session/event 监听器只有一处（合并而非重复注册）',
  (host.match(/state\.listeners\['session\/event'\]/g) || []).length === 1,
  '注册了两处 ⇒ 后注册者覆盖 listeners 记录（压缩标记链路取证丢失）');
// 三个必备防护
ok('应用前校验档位合法性（否则 llm 抛 UNSUPPORTED_REASONING_EFFORT 中断请求）',
  /opts && !opts\.includes\(pend\.effort\)/.test(host),
  '未校验档位 ⇒ 非法档会中断整个请求');
ok('非法档只忽略并留痕（不硬送）', /effortSkips\.invalid/.test(host) && /lastEffortApply = \{[\s\S]{0,200}?applied: false/.test(host),
  '非法档未留痕 ⇒ 无法取证为何没生效');
ok('有换档冷却（防频繁换档反复打断前缀缓存）',
  /const EFFORT_SWITCH_MIN_MS = 30_000/.test(host) && /since < EFFORT_SWITCH_MIN_MS/.test(host),
  '无冷却 ⇒ 模型可每轮换档，反复使缓存失效');
ok('尊重他人显式指定档位（让位，不覆盖）',
  /config\?\.reasoningEffort !== undefined && applied !== undefined\s*\n?\s*&& config\.reasoningEffort !== applied && config\.reasoningEffort !== pend\.effort/.test(host),
  '未区分「自己写的档」与「他人显式指定」⇒ 与用户/subagent 选择打架或自我锁死');
/* ⚠️ 必须 prepend：官方 installModelSelection 挂在**同一** agent/request 上且在内层，
 * 它 await next() 后 delete reasoningEffort 再套回持久化 header 值 ⇒ 非最外层会被剥掉。
 * 实测缺陷（2026-10-07）：applied:true 但之后每轮注入仍是旧档 ⇒ 换档实际未生效。 */
ok('换档 hook 用 prepend（否则被官方 installModelSelection 剥掉）',
  /\}, \{ prepend: true \}\); \/\/ ⚠️ 必须 prepend/.test(host),
  '未 prepend ⇒ 官方内层会 delete 我们写入的 effort 再套回旧档（换档静默失效）');
ok('pending 持久（每轮覆盖，不一次性消费）',
  /pendingEffortBySid\.set\(sid, \{ effort: want/.test(host) &&
  !/const out = \{ \.\.\.config, reasoningEffort: pend\.effort \};\s*\n\s*delete out\.maxTokens;\s*\n\s*pendingEffortBySid\.delete/.test(host),
  'pending 被一次性删除 ⇒ 只有第一轮生效，之后被内层打回旧档');
ok('换档计数只在档位真变化时自增（否则变成请求次数）',
  /const changed = config\?\.reasoningEffort !== pend\.effort;/.test(host) && /effortReasserts/.test(host),
  '无条件自增 ⇒ effortSwitches 失去取证意义');
ok('冷却基准只在真变化时更新（否则后续换档全被挡）',
  /if \(changed\) \{\s*\n\s*effortSwitchAtBySid\.set\(sidKey, Date\.now\(\)\);/.test(host),
  '每轮刷新冷却基准 ⇒ 冷却永远处于「刚换过」，模型后续换档全被跳过');
ok('应用时删除 maxTokens（不把上个 adapter 的 cap 钉住）',
  /const out = \{ \.\.\.config, reasoningEffort: pend\.effort \};\s*\n\s*delete out\.maxTokens;/.test(host),
  '未删 maxTokens ⇒ 换档后沿用旧 adapter 的输出上限（router-laya applyRoute 同款教训）');
ok('换档异常原样放行（绝不影响请求）', /catch \(e\) \{\s*\n\s*log\('warn', `R1 换档应用异常（吞，原样放行）/.test(host),
  '异常未吞 ⇒ 新功能可打崩模型请求');

/* ═══════════ 6.13 R2 换档工具（取代文本标记）═══════════ */
console.log('\n== 6.13 换档工具 set_reasoning_effort（R2，取代文本标记）==');
// 用户 2026-10-08 决策：① 不保留文本标记；② 工具名 set_reasoning_effort。
// 工具方案为什么对（源码实证）：dsh-agent-loop L1152-1155 有 toolCalls ⇒ step() 返回 null
// ⇒ turnEnds 保持 null ⇒ L1005 不 break ⇒ target="next-step" ⇒ **本轮继续**；
// 每步重走 agent/request ⇒ 下一步即带新档位。零用户输入、零伪造消息。
ok('文本标记已移除（用户要求不保留）',
  !/EFFORT_MARKER_RE/.test(host) && !/\[cp:effort/.test(stripComments(host)),
  '仍残留 [cp:effort] 标记解析 ⇒ 与「不保留文本标记」的决定矛盾');
ok('session/event 不再解析换档标记',
  !/matchAll\(EFFORT_MARKER_RE\)/.test(host),
  'session/event 仍在解析标记');
ok('工具名 = set_reasoning_effort（用户指定）',
  /const EFFORT_TOOL_NAME = 'set_reasoning_effort';/.test(host),
  '工具名不符用户指定');
ok('用官方 defineTool 定义（非自造 API）',
  /defineToolFn\(\{[\s\S]{0,200}?name: EFFORT_TOOL_NAME/.test(host),
  '未走官方 defineTool ⇒ 注册可能被拒');
ok('走官方 ctx.tools.register 注册',
  /tools\.register\(def\)/.test(host) && /svc\('tools'\)/.test(host),
  '未用 tools.register ⇒ 工具不生效');
ok('defineTool 走候选链加载（bare→env→resourcesPath→硬编码）',
  /async function loadDefineTool\(\)/.test(host) && /dshToolsCandidates/.test(host),
  '未走候选链 ⇒ 第三方目录下 bare import 必失败（本项目已有教训）');
ok('effortEnabled 关闭时不注册工具（完全不介入）',
  /if \(M3\.effortEnabled === true\) registerEffortTool\(\);/.test(host),
  '关闭时仍注册 ⇒ 与「关=完全不介入」的用户定义矛盾');
ok('会话中途打开开关会补注册（懒注册）',
  /registerEffortTool\(\); \/\/ R2：确保工具已注册/.test(host),
  '只在加载时注册一次 ⇒ 中途打开开关后工具不可用');
// 工具必须**不抛错**（抛错会中断本轮；这里只想"告知 + 不换"）
ok('工具非法档返回结构化错误而非抛错（抛错会中断本轮）',
  /return \{ ok: false, error: `档位 "\$\{want\}" 不在当前模型的可选集内。`, options: opts \};/.test(host),
  '非法档抛错 ⇒ 中断模型本轮（应当返回错误让模型自行纠正）');
ok('工具冷却中返回 remainSec（模型能知道等多久）',
  /return \{\s*\n\s*ok: false, cooling: true, remainSec/.test(host),
  '冷却仅静默忽略 ⇒ 模型不知为何没生效');
ok('工具写的是持久 pending（复用 R1 的 prepend 应用链）',
  /pendingEffortBySid\.set\(sid, \{ effort: want, at: Date\.now\(\), source: 'tool' \}\)/.test(host),
  '工具未写 pending ⇒ agent/request 拿不到目标档位');
ok('工具有参数 schema（effort 必填）',
  /effort: \{[\s\S]{0,120}?required: true/.test(host),
  '缺参数 schema ⇒ defineTool 校验失败/模型不知道传什么');
ok('工具有 output schema + render',
  /output: \{[\s\S]{0,80}?schema: \{[\s\S]{0,900}?render: \(_args, value\) => \[\{ type: 'text', text: JSON\.stringify\(value\) \}\]/.test(host),
  '缺 output.render ⇒ 工具结果无法渲染给模型');
ok('工具执行异常被吞并返回错误（不影响会话）',
  /R2 换档工具执行异常（吞）/.test(host),
  '异常未吞 ⇒ 可打崩工具调用');
ok('工具注册结果有取证字段（effortTool / effortToolLoader）',
  /effortTool: null/.test(host) && /effortToolLoader: null/.test(host),
  '缺取证 ⇒ 工具没生效时无法定位断点');
/* R1 的「标记必须独占一行（防散文误触发）」断言已随文本标记一并移除——
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
