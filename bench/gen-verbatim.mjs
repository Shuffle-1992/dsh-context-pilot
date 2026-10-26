#!/usr/bin/env node
/**
 * 阶段 1b：把 `bench/seed.json`（Qwen 生成的 601k token 种子）扩展成 **双轴探针**：
 *   · 原有 12 个「要点型」埋点（kinds='factual'）—— 摘要有机会保住，考"语义回忆"
 *   · 新增 12 个「逐字型」埋点（kinds='verbatim'）—— 代码行/命令/堆栈/错误串/路径等，
 *     **摘要几乎必然改写**，只有原文仍在上下文（或模型死记）才答得出 ⇒ 真正对"保留范围"敏感
 *
 * 产物（全部确定性：无 Math.random / Date.now）：
 *   bench/seed2.md / bench/seed2.json      —— 扩展后的种子（24 个埋点，带 kind）
 *   bench/questions-verbatim.json           —— 12 道逐字题（要求原样复述）
 *   bench/answers-verbatim.json             —— 12 条标准答案（逐字串）
 * 用法：node bench/gen-verbatim.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const nl = (s) => String(s ?? '').replace(/\r\n/g, '\n');

/* ── 12 个逐字型埋点：value 必须是"摘要一定会改写"的形态 ── */
const VERBATIM = [
  { id: 'V01', depth: 5,  label: '那行范围起点的赋值语句', value: 'const keepFromIdx = nodes.length;',
    ask: '请**逐字**给出范围选择里那行「起点赋值」的代码（包含分号与空格）。' },
  { id: 'V02', depth: 10, label: '只测单条断言的命令', value: 'npm run test:contract -- --only=R16.15',
    ask: '请**逐字**给出只跑 r16.15 那条断言的完整命令（含 `--only=` 参数）。' },
  { id: 'V03', depth: 14, label: '栈里那一行', value: 'at resolveTier (plugin/compact-range.mjs:158:7)',
    ask: '请**逐字**给出栈信息里指向 resolveTier 的那一行（含文件、行、列）。' },
  { id: 'V04', depth: 20, label: '参数校验的错误串', value: 'ERR_INVALID_ARG_TYPE: "retainTokens" must be > 0',
    ask: '请**逐字**给出 `retainTokens` 参数非法时的错误串。' },
  { id: 'V05', depth: 40, label: '压测用的环境变量', value: 'DCP_EFFORT_COOLDOWN_MS=30000',
    ask: '请**逐字**给出压测时设置的那个冷却相关环境变量及其值。' },
  { id: 'V06', depth: 50, label: '文件行号引用', value: 'plugin/m3.compact.mjs:481',
    ask: '请**逐字**给出"把档位预算换成启发式预算"那一步所在的 **文件:行号**。' },
  { id: 'V07', depth: 60, label: '锚点来源的正则', value: '/^anchor:(text|recent-user):/',
    ask: '请**逐字**给出解析 `retainSource` 前缀用的那个正则字面量。' },
  { id: 'V08', depth: 70, label: '一段 JSON 的键序', value: '{"tier":"heavy","ratio":0.24,"budget":240000}',
    ask: '请**逐字**给出日志里那条档位 JSON（键顺序与标点都要一致）。' },
  { id: 'V09', depth: 83, label: '那个短提交号', value: 'a3f9c21',
    ask: '请**逐字**给出修掉该 bug 的提交短号（7 位）。' },
  { id: 'V10', depth: 88, label: '带查询串的接口路径', value: '/api/hud?sid=s-9a611857&fields=effort,usage',
    ask: '请**逐字**给出抓包时看到的那条 HUD 接口路径（含查询串）。' },
  { id: 'V11', depth: 92, label: '冷却判断那行', value: 'if (s?.switchedAt && since < cap) {',
    ask: '请**逐字**给出冷却判断的那一行代码（含可选链与花括号）。' },
  { id: 'V12', depth: 95, label: '夹取表达式', value: 'Math.min(MIN_RETAIN_TOKENS, Math.floor(window * MAX_RETAIN_RATIO))',
    ask: '请**逐字**给出预算下限夹取的那个表达式。' },
];

/* ── 读原种子 ── */
const base = JSON.parse(readFileSync(join(HERE, 'seed.json'), 'utf8'));
const messages = (base.messages ?? []).map((m) => ({ role: m.role, text: nl(m.text) }));
const factNeedles = (base.needles ?? []).map((n) => ({ ...n, kind: 'factual' }));
if (!messages.length || !factNeedles.length) {
  console.error('[fail] seed.json 缺 messages/needles —— 先跑 node bench/gen-seed.mjs');
  process.exit(1);
}

/* ── 定位每个逐字埋点的宿主消息：按目标深度取"累计字符位置"最近的消息 ── */
const lengths = messages.map((m) => m.text.length + 2);            // +2 = 拼接用的 "\n\n"
const total = lengths.reduce((a, b) => a + b, 0);
let acc = 0;
const starts = lengths.map((L) => { const s = acc; acc += L; return s; });
const hostOf = (depthPct) => {
  const want = Math.round((depthPct / 100) * total);
  let best = 0;
  for (let i = 0; i < starts.length; i += 1) if (starts[i] <= want) best = i; else break;
  return best;
};

/* ── 插入（追加在宿主消息末尾，形如"逐字记录"句，读起来自然且唯一） ── */
const verbatimNeedles = [];
for (const v of VERBATIM) {
  const idx = hostOf(v.depth);
  if (messages[idx].text.includes(v.value)) { console.error(`[fail] ${v.id} 的值已存在于宿主消息`); process.exit(1); }
  messages[idx].text += `\n【逐字记录 · ${v.label}】${v.value}`;
  verbatimNeedles.push({ id: v.id, kind: 'verbatim', value: v.value, msgIndex: idx, depthPct: v.depth });
}

/* ── 重算全文与深度（用插入后的真实位置，保证与 probe 口径一致） ── */
const texts = messages.map((m) => m.text);
let pos = 0;
const offsets = [];
for (const t of texts) { offsets.push(pos); pos += t.length + 2; }
const fullLen = Math.max(0, pos - 2);
const depthOf = (needle) => {
  const start = offsets[needle.msgIndex] ?? 0;
  const inMsg = texts[needle.msgIndex].indexOf(needle.value);
  return Math.round((((start + (inMsg >= 0 ? inMsg : 0)) + needle.value.length / 2) / fullLen) * 10000) / 100;
};
const allNeedles = [...factNeedles, ...verbatimNeedles].map((n) => ({ ...n, depthPct: depthOf(n) }));

/* ── 唯一性自检：每个 value 在全文恰好出现 1 次 ── */
const seedText = texts.join('\n\n');
const dup = allNeedles.filter((n) => seedText.split(n.value).length - 1 !== 1);
if (dup.length) { console.error('[fail] 埋点不唯一: ' + dup.map((d) => d.id).join(',')); process.exit(1); }

/* ── 写产物 ── */
const seedOut = {
  meta: { chars: seedText.length, estimatedTokens: Math.round(seedText.length / 1.6), needles: allNeedles.length, controls: (base.meta?.controls ?? 4), base: 'seed.json + 12 verbatim' },
  messages,
  needles: allNeedles,
};
writeFileSync(join(HERE, 'seed2.md'), seedText, 'utf8');
writeFileSync(join(HERE, 'seed2.json'), JSON.stringify(seedOut, null, 2), 'utf8');
writeFileSync(join(HERE, 'questions-verbatim.json'), JSON.stringify({ questions: VERBATIM.map((v) => ({ id: v.id, ask: v.ask, needle: v.id })) }, null, 2), 'utf8');
writeFileSync(join(HERE, 'answers-verbatim.json'), JSON.stringify({ answers: Object.fromEntries(VERBATIM.map((v) => [v.id, v.value])) }, null, 2), 'utf8');

const byKind = { factual: 0, verbatim: 0 };
for (const n of allNeedles) byKind[n.kind] += 1;
console.log(`seed2.md chars = ${seedText.length} ｜ ≈${Math.round(seedText.length / 1.6)} token`);
console.log(`needles: factual=${byKind.factual}  verbatim=${byKind.verbatim}  (合计 ${allNeedles.length})`);
console.log('verbatim 深度: ' + verbatimNeedles.map((n) => `${n.id}=${n.depthPct}%`).join('  '));
console.log('written: bench/seed2.md bench/seed2.json bench/questions-verbatim.json bench/answers-verbatim.json');
console.log('OK');
