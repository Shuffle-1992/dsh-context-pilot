#!/usr/bin/env node
/**
 * 阶段 3：**证据型**探针 —— 专门测试"被摘要掉的中段证据还能不能被准确复述"。
 *
 * 与阶段 1b 的区别（关键）：
 *   · 阶段 1b 用 `【逐字记录】` 高显著标记 ⇒ 摘要器照单保留，测不出档位差异（已知缺陷）；
 *   · 本阶段的 6 条证据**不加任何标记**，以普通叙述句埋在 20%–75% 深度（远/中段），
 *     且都**不在**任务规格里出现 ⇒ 压缩后只能靠摘要或残留原文回忆。
 *
 * 产物（确定性，无随机）：
 *   bench/seed4.md / seed4.json       —— seed2 + 6 条无标记证据
 *   bench/task-evidence.md            —— 任务说明（要求逐条照抄 6 个准确值）
 *   bench/answers-evidence.json       —— 6 条标准答案 + 2 道对照
 *   bench/verify-evidence.mjs         —— 判分：答案文件必须逐条包含 6 个准确串
 *
 * 用法：node bench/gen-evidence.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* 6 条证据：value 为必须逐字出现的精确串；sentence 为埋入普通叙述的句子（无标记） */
const EVIDENCE = [
  { id: 'E1', depth: 20, label: '根因错误码', q: '复盘里认定的根因错误码是什么？',
    value: 'E_RANGE_EDGE_4417',
    sentence: '散会前他把结论随手写在便签上：根因是 E_RANGE_EDGE_4417，跟缓存没关系，别再往缓存方向查了。' },
  { id: 'E2', depth: 30, label: '修复位置', q: '修复落点（文件:行号 + 函数名）是什么？',
    value: 'plugin/compact-range.mjs:394 prevEnd()',
    sentence: '改动的落点他记成了 plugin/compact-range.mjs:394 prevEnd()，因为那个函数负责把范围末端回退一格。' },
  { id: 'E3', depth: 45, label: '压测闸值', q: '压测时把并发闸值调成了多少？',
    value: 'CONCURRENCY=6',
    sentence: '压测那轮为了稳压把闸值调成 CONCURRENCY=6，比默认值小一档，之后一直没改回来。' },
  { id: 'E4', depth: 55, label: '调参记录位置', q: '调参记录被写进了哪个文件哪一节？',
    value: 'collab/tuning.md 第 3 节',
    sentence: '那次的调参过程后来补进了 collab/tuning.md 第 3 节，和之前的几次实验放在一起。' },
  { id: 'E5', depth: 65, label: '预发布版本号', q: '那次只发给内部试用、没进主干的预发布版本号是什么？',
    value: 'v0.2.7-rc.3',
    sentence: '内部试用只发过 v0.2.7-rc.3，主干版本号一直没动，所以外面看不到这个号。' },
  { id: 'E6', depth: 75, label: '热修分支名', q: '那个热修分支叫什么？',
    value: 'hotfix/range-guard',
    sentence: '热修是从 hotfix/range-guard 这个分支出的，合回去的时候删掉了，但提交记录里还能查到。' },
];
const CONTROLS = [
  { id: 'C1', q: '历史里有没有提到过 `E_STREAM_RESET_9` 这个错误码？' },
  { id: 'C2', q: '历史里有没有用过 `CONCURRENCY=12` 这个压测闸值？' },
];

/* ── 读 seed2 ── */
const base = JSON.parse(readFileSync(join(HERE, 'seed2.json'), 'utf8'));
const messages = (base.messages ?? []).map((m) => ({ role: m.role, text: String(m.text ?? '') }));

/* 累计位置 → 宿主消息 */
const lens = messages.map((m) => m.text.length + 2);
let acc = 0;
const starts = lens.map((L) => { const s = acc; acc += L; return s; });
const total = acc - 2;
const hostOf = (pct) => {
  const want = Math.round((pct / 100) * total);
  let best = 0;
  for (let i = 0; i < starts.length; i += 1) if (starts[i] <= want) best = i; else break;
  return best;
};

/* 插入（纯叙述句，无标记） */
const inserted = [];
for (const e of EVIDENCE) {
  const idx = hostOf(e.depth);
  if (messages[idx].text.includes(e.value)) { console.error(`[fail] ${e.id} 值已存在`); process.exit(1); }
  messages[idx].text += `\n${e.sentence}`;
  inserted.push({ ...e, msgIndex: idx });
}

/* 重算全文与深度 */
const texts = messages.map((m) => m.text);
let pos = 0;
const offsets = [];
for (const t of texts) { offsets.push(pos); pos += t.length + 2; }
const fullLen = pos - 2;
const depthOf = (n) => {
  const start = offsets[n.msgIndex] ?? 0;
  const at = texts[n.msgIndex].indexOf(n.value);
  return Math.round((((start + (at >= 0 ? at : 0)) + n.value.length / 2) / fullLen) * 10000) / 100;
};
const full = texts.join('\n\n');
const evNeedles = inserted.map((n) => ({ id: n.id, kind: 'evidence', value: n.value, msgIndex: n.msgIndex, depthPct: depthOf(n) }));
const dup = evNeedles.filter((n) => full.split(n.value).length - 1 !== 1);
if (dup.length) { console.error('[fail] 证据串不唯一: ' + dup.map((d) => d.id).join(',')); process.exit(1); }

writeFileSync(join(HERE, 'seed4.md'), full, 'utf8');
writeFileSync(join(HERE, 'seed4.json'), JSON.stringify({
  meta: { chars: full.length, estimatedTokens: Math.round(full.length / 1.6), evidence: evNeedles.length, base: 'seed2 + 6 unmarked evidence' },
  messages,
  needles: [...(base.needles ?? []), ...evNeedles],
}, null, 2), 'utf8');

/* 任务说明 */
const task = [
  '# 任务 E1：从历史里逐字取回 6 条证据',
  '',
  '你在本会话前段读过一份很长的开发历史。现在请**只凭当前上下文**，逐条回答下面 6 个问题。',
  '',
  '**要求（硬性）**：',
  '1. 答案必须是历史里出现过的**准确字符串**（照抄，含大小写、下划线、斜杠、冒号），不要改写、不要解释；',
  '2. 记不清就写 `不知道`，**不要猜**；',
  '3. 同时回答 2 道对照题（若历史里确实没有，写 `不知道`）；',
  '4. 把结果写进 `bench/tasks/_runs/E1-evidence/answer.md`，每行格式 `E1: <答案>`。',
  '',
  ...EVIDENCE.map((e, i) => `${i + 1}. ${e.id}. ${e.q}`),
  '',
  ...CONTROLS.map((c, i) => `${EVIDENCE.length + i + 1}. ${c.id}. ${c.q}`),
  '',
  '验收命令：`node bench/verify-evidence.mjs bench/tasks/_runs/E1-evidence/answer.md`',
].join('\n');
writeFileSync(join(HERE, 'task-evidence.md'), task, 'utf8');

writeFileSync(join(HERE, 'answers-evidence.json'), JSON.stringify({
  answers: Object.fromEntries(EVIDENCE.map((e) => [e.id, e.value])),
  controls: Object.fromEntries(CONTROLS.map((c) => [c.id, '不知道'])),
}, null, 2), 'utf8');

/* 判分器 */
const verifier = `#!/usr/bin/env node
/* 阶段 3 证据判分：答案文件必须逐条**原样包含** 6 个证据串；对照题必须含否定词。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || 'bench/tasks/_runs/E1-evidence/answer.md';
const key = JSON.parse(readFileSync(join(HERE, 'answers-evidence.json'), 'utf8'));
const norm = (s) => String(s ?? '').replace(/[\\s\\u3000]+/g, '').replace(/[“”"'\\\`‘’「」『』（）()【】\\[\\]，。、；：！？!?,.;:]/g, '').toLowerCase();
let text = '';
try { text = readFileSync(file, 'utf8'); } catch { console.log('ANSWER_MISSING: ' + file); process.exit(1); }
const N = norm(text);
const DONT = ['不知道', '不清楚', '不确定', '未提及', '没有', '没提到', '无法确定'];
let fail = 0;
for (const [id, expect] of Object.entries(key.answers)) {
  const ok = N.includes(norm(expect));
  if (!ok) { fail += 1; console.log(\`EVIDENCE_\${id}_FAIL: 期望「\${expect}」\`); }
}
for (const [id] of Object.entries(key.controls)) {
  /* 对照题：答案行里该 id 后必须出现否定词（避免幻觉编造） */
  const line = String(text).split('\\n').find((l) => l.trim().startsWith(id + ':')) ?? '';
  const ok = DONT.some((w) => norm(line).includes(norm(w)));
  if (!ok) { fail += 1; console.log(\`CONTROL_\${id}_FAIL: 对照题应回答「不知道」，实得「\${line.slice(0, 60)}」\`); }
}
console.log('omissions=' + fail);
if (fail) process.exit(1);
console.log('EVIDENCE_ALL_PASS (' + Object.keys(key.answers).length + '/' + Object.keys(key.answers).length + ')');
`;
writeFileSync(join(HERE, 'verify-evidence.mjs'), verifier, 'utf8');

console.log(`seed4.md chars=${full.length} ≈${Math.round(full.length / 1.6)} token`);
console.log('证据深度: ' + evNeedles.map((n) => `${n.id}=${n.depthPct}%`).join('  '));
console.log('written: seed4.md seed4.json task-evidence.md answers-evidence.json verify-evidence.mjs');
console.log('OK');
