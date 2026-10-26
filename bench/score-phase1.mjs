#!/usr/bin/env node
/**
 * 阶段 1 / 1b 判分器（确定性，不用模型打分）。
 *
 * 输入：`bench/runs/phase1-<臂>.json` 或 `bench/runs/phase1b-<臂>.json`
 *   { "arm": "8%", "answers": { "Q01": "…", "V01": "…", "C01": "不知道", ... } }
 * 对照：
 *   · `bench/answers.json`            —— 12 道「要点型」事实题（Q01–Q12）
 *   · `bench/answers-verbatim.json`   —— 12 道「逐字型」细节题（V01–V12，仅 phase1b 有）
 *   · `bench/questions.json`          —— 4 道对照题（C01–C04，期望「不知道」）
 *
 * 判据：
 *  - 要点题：归一化后**双向包含**（期望 ⊆ 答案 或 答案 ⊆ 期望）算对；后者记 `partial`。
 *  - 逐字题：归一化后**答案包含期望原文**才算对（严格；逐字题不容忍改写）。
 *  - 对照题：归一化后含 不知道/不清楚/未提及… 之一算对（抓幻觉）。
 *
 * 用法：
 *   node bench/score-phase1.mjs                 # 扫全部 phase1 与 phase1b 结果
 *   node bench/score-phase1.mjs 8 16            # 只打文件名含 "8"/"16" 的
 *   node bench/score-phase1.mjs b               # 只看 phase1b 的
 *   node bench/score-phase1.mjs --detail        # 明细
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, 'runs');
const ARGS = process.argv.slice(2);
const DETAIL = ARGS.includes('--detail');
const want = ARGS.filter((a) => !a.startsWith('--'));

const norm = (s) => String(s ?? '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[“”"'`‘’「」『』（）()【】\[\]，。、；：！？!?,.;:]/g, '')
  .toLowerCase();
const DONT_KNOW = ['不知道', '不清楚', '不确定', '未提及', '未提到', '没有提到', '没有见过', '没有发过', '没发过', '未发过', '没有', '无法确定', '没写', '不存在'];

function judgeFactual(expect, got) {
  const e = norm(expect);
  const g = norm(got);
  if (!g) return 'miss';
  if (g.includes(e)) return 'exact';
  if (e.includes(g)) return 'partial';
  return 'miss';
}
function judgeVerbatim(expect, got) {
  const e = norm(expect);
  const g = norm(got);
  return g.includes(e) ? 'exact' : 'miss';
}

function readKeys() {
  const factual = JSON.parse(readFileSync(join(HERE, 'answers.json'), 'utf8')).answers ?? {};
  const vpath = join(HERE, 'answers-verbatim.json');
  const verbatim = existsSync(vpath) ? (JSON.parse(readFileSync(vpath, 'utf8')).answers ?? {}) : {};
  const controls = JSON.parse(readFileSync(join(HERE, 'questions.json'), 'utf8')).controls ?? [];
  const qPath = join(HERE, 'questions.json');
  const controlIds = (JSON.parse(readFileSync(qPath, 'utf8')).controls ?? []).map((c) => c.id);
  return { factual, verbatim, controlIds };
}

function scoreOne(file, keys) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const ans = run.answers ?? {};
  const factRows = Object.entries(keys.factual).map(([id, expect]) => ({ id, expect, got: ans[id] ?? '(未答)', verdict: judgeFactual(expect, ans[id]) }));
  const verbRows = Object.entries(keys.verbatim).map(([id, expect]) => ({ id, expect, got: ans[id] ?? '(未答)', verdict: judgeVerbatim(expect, ans[id]) }));
  const ctlRows = keys.controlIds.map((id) => {
    const g = norm(ans[id]);
    const ok = g.length > 0 && DONT_KNOW.some((w) => g.includes(norm(w)));
    return { id, got: ans[id] ?? '(未答)', ok };
  });
  return {
    arm: run.arm ?? file.split(/phase1b?-|\.json/g).filter(Boolean)[0] ?? '?',
    file,
    factRows, verbRows, ctlRows,
    fExact: factRows.filter((r) => r.verdict === 'exact').length,
    fPartial: factRows.filter((r) => r.verdict === 'partial').length,
    fMiss: factRows.filter((r) => r.verdict === 'miss').length,
    vExact: verbRows.filter((r) => r.verdict === 'exact').length,
    cOk: ctlRows.filter((c) => c.ok).length,
  };
}

if (!existsSync(RUNS)) { console.log('[skip] 还没有 bench/runs/ 目录'); process.exit(0); }
let files = readdirSync(RUNS).filter((f) => /^phase1b?-.*\.json$/.test(f)).map((f) => join(RUNS, f));
if (want.length) files = files.filter((f) => want.some((w) => f.includes(w)));
if (!files.length) { console.log('[skip] 未找到 phase1*/phase1b* 结果'); process.exit(0); }

const keys = readKeys();
const scores = files.map((f) => scoreOne(f, keys));
console.log('| 臂 | 要点题 (exact+partial) | 逐字题 (严格) | 对照题 (防幻觉) | 文件 |');
console.log('|---|---|---|---|---|');
for (const s of scores) {
  const vAnswered = s.verbRows.filter((r) => r.got !== '(未答)').length;
  const vCell = keys.verbatim && Object.keys(keys.verbatim).length && vAnswered
    ? `${s.vExact}/${s.verbRows.length}（已答 ${vAnswered}）`
    : '—';
  console.log(`| ${s.arm} | ${s.fExact + s.fPartial}/${s.factRows.length}（${s.fExact}+${s.fPartial}） | ${vCell} | ${s.cOk}/${s.ctlRows.length} | ${s.file.split(/[\\/]/).pop()} |`);
}
if (DETAIL) {
  for (const s of scores) {
    console.log(`\n## ${s.arm} 要点题`);
    for (const r of s.factRows) console.log(`${r.verdict === 'miss' ? '✗' : (r.verdict === 'partial' ? '≈' : '✓')} ${r.id} 期望「${r.expect}」 实得「${String(r.got).slice(0, 80)}」`);
    if (s.verbRows.length) {
      console.log(`## ${s.arm} 逐字题`);
      for (const r of s.verbRows) console.log(`${r.verdict === 'exact' ? '✓' : '✗'} ${r.id} 期望「${r.expect}」 实得「${String(r.got).slice(0, 80)}」`);
    }
  }
}
console.log('\n判据：要点题=双向包含（≈ 表示只答了值）；逐字题=必须原样包含；对照题=含「不知道」类词。');
