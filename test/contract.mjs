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
