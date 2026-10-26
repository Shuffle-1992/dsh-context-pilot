#!/usr/bin/env node
/**
 * 阶段 1 判分器（确定性，不用模型打分）。
 *
 * 输入：`bench/runs/phase1-<臂>.json`，形如
 *   { "arm": "8%", "answers": { "Q01": "……", "Q02": "……", "C01": "不知道", ... } }
 * 对照：`bench/answers.json`
 *
 * 判据：
 *  - needle 题：归一化后**双向包含**即算对——
 *      · 模型答案 ⊆ 期望（例：期望 `MAX_RETRY=7`，模型答 `7`）⇒ 记 `partial`（算对但标注）；
 *      · 期望 ⊆ 模型答案（模型答完整串或带上下文）⇒ 记 `exact`（算对）。
 *    归一化会去掉空白/标点/引号并转小写；needle 值在种子全文唯一，故包含等价于检索到。
 *  - 对照题：归一化后含 不知道/不清楚/不确定/未提及/没有 之一即算对（抓幻觉）。
 *
 * 用法：
 *   node bench/score-phase1.mjs                 # 扫 bench/runs/phase1-*.json 全部打分
 *   node bench/score-phase1.mjs 8 16            # 只打文件名含 "8"/"16" 的臂
 *   node bench/score-phase1.mjs --detail        # 打印漏答/部分匹配明细
 *   node bench/score-phase1.mjs --raw           # 打印每个臂的原始答案
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, 'runs');
const ARGS = process.argv.slice(2);
const DETAIL = ARGS.includes('--detail');
const RAW = ARGS.includes('--raw');
const want = ARGS.filter((a) => !a.startsWith('--'));

const norm = (s) => String(s ?? '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[“”"'`‘’「」『』（）()【】\[\]，。、；：！？!?,.;:]/g, '')
  .toLowerCase();
const DONT_KNOW = ['不知道', '不清楚', '不确定', '未提及', '未提到', '没有提到', '没有见过', '无法确定', '没写', '不存在'];

function judge(expect, got) {
  const e = norm(expect);
  const g = norm(got);
  if (!g) return 'miss';
  if (g === e || g.includes(e)) return 'exact';
  if (e.includes(g) && g.length >= 1) return 'partial';
  return 'miss';
}

function scoreOne(file) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const ans = run.answers ?? {};
  const key = JSON.parse(readFileSync(join(HERE, 'answers.json'), 'utf8'));
  const rows = [];
  for (const [id, expect] of Object.entries(key.answers ?? {})) {
    rows.push({ id, expect, got: ans[id] ?? '(未答)', verdict: judge(expect, ans[id]) });
  }
  const controls = Object.entries(key.controls ?? {}).map(([id]) => {
    const g = norm(ans[id]);
    const ok = g.length > 0 && DONT_KNOW.some((w) => g.includes(norm(w)));
    return { id, got: ans[id] ?? '(未答)', ok };
  });
  return {
    arm: run.arm ?? (file.split('phase1-')[1] ?? '').replace(/\.json$/, '') ?? '?',
    file,
    rows,
    controls,
    exact: rows.filter((r) => r.verdict === 'exact').length,
    partial: rows.filter((r) => r.verdict === 'partial').length,
    miss: rows.filter((r) => r.verdict === 'miss').length,
    cOk: controls.filter((c) => c.ok).length,
  };
}

if (!existsSync(RUNS)) {
  console.log('[skip] 还没有 bench/runs/ 目录（阶段 1 尚未开跑）');
  process.exit(0);
}
let files = readdirSync(RUNS).filter((f) => /^phase1-.*\.json$/.test(f)).map((f) => join(RUNS, f));
if (want.length) files = files.filter((f) => want.some((w) => f.includes(w)));
if (!files.length) {
  console.log('[skip] 未找到 phase1-*.json（把每个臂的回答存成 bench/runs/phase1-<臂>.json）');
  process.exit(0);
}

const scores = files.map(scoreOne);
console.log('| 臂 | 事实题（exact+partial） | 部分匹配 | 漏答 | 对照题（防幻觉） |');
console.log('|---|---|---|---|---|');
for (const s of scores) {
  console.log(`| ${s.arm} | ${s.exact + s.partial}/${s.rows.length}（${s.exact}+${s.partial}） | ${s.partial} | ${s.miss} | ${s.cOk}/${s.controls.length} |`);
}
if (DETAIL) {
  for (const s of scores) {
    console.log(`\n## ${s.arm} 明细`);
    for (const r of s.rows) {
      const mark = r.verdict === 'exact' ? '✓' : (r.verdict === 'partial' ? '≈' : '✗');
      console.log(`${mark} ${r.id}  期望「${r.expect}」 实得「${String(r.got).slice(0, 70)}」`);
    }
  }
}
if (RAW) {
  for (const s of scores) console.log(`\n## ${s.arm} 原始答案\n${JSON.stringify(JSON.parse(readFileSync(s.file, 'utf8')).answers ?? {}, null, 2)}`);
}
console.log('\n判据：needle 题 = 双向包含（≈ 表示模型只答了值、期望含常量名）；对照题 = 含「不知道/未提及」等。');
