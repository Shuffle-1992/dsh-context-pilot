#!/usr/bin/env node
/* 阶段 3 证据判分：答案文件必须逐条**原样包含** 6 个证据串；对照题必须含否定词。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || 'bench/tasks/_runs/E1-evidence/answer.md';
const key = JSON.parse(readFileSync(join(HERE, 'answers-evidence.json'), 'utf8'));
const norm = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').replace(/[“”"'\`‘’「」『』（）()【】\[\]，。、；：！？!?,.;:]/g, '').toLowerCase();
let text = '';
try { text = readFileSync(file, 'utf8'); } catch { console.log('ANSWER_MISSING: ' + file); process.exit(1); }
const N = norm(text);
const DONT = ['不知道', '不清楚', '不确定', '未提及', '没有', '没提到', '无法确定'];
let fail = 0;
for (const [id, expect] of Object.entries(key.answers)) {
  const ok = N.includes(norm(expect));
  /* R86：**不得打印期望值**——agent 会自己跑判分器，打印期望等于把答案告诉它（阶段 3 实测踩过）。 */
  if (!ok) { fail += 1; console.log(`EVIDENCE_${id}_FAIL: 缺失或不匹配（不显示期望值，避免自我校正）`); }
}
for (const [id] of Object.entries(key.controls)) {
  /* 对照题：答案行里该 id 后必须出现否定词（避免幻觉编造） */
  const line = String(text).split('\n').find((l) => l.trim().startsWith(id + ':')) ?? '';
  const ok = DONT.some((w) => norm(line).includes(norm(w)));
  if (!ok) { fail += 1; console.log(`CONTROL_${id}_FAIL: 对照题应回答「不知道」，实得「${line.slice(0, 60)}」`); }
}
console.log('omissions=' + fail);
if (fail) process.exit(1);
console.log('EVIDENCE_ALL_PASS (' + Object.keys(key.answers).length + '/' + Object.keys(key.answers).length + ')');
