#!/usr/bin/env node
/**
 * 阶段 0：**离线保留分析**（零模型调用）。
 *
 * 目的：对同一份历史，分别按 8%/16%/24%/语义锚点 回放插件的**真实范围选择逻辑**
 * （`compact-range.resolveTier` → `m3.scaleRetainBudget` → `compact-range.selectRange`），
 * 回答“每个档位把哪些消息原样留下、哪些转成摘要”，并用 12 个带标记的关键事实（needle）量化。
 *
 * 能回答：信息损失的**上界**（哪些事实不再以原文存在）。
 * 不能回答：摘要是否仍保留了要点、模型是否因此变差（那是阶段 1 检索探针 / 阶段 2 任务 A/B）。
 *
 * 用法：
 *   node bench/retention-probe.mjs            # 读 bench/seed.json（由 gen-seed.mjs 生成）
 *   node bench/retention-probe.mjs --smoke    # 内置迷你种子，验证脚本本身
 *   node bench/retention-probe.mjs --factor=1.55   # 指定真实口径折算因子（默认 1 / 1.55 各跑一遍）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const range = await import(pathToFileURL(join(ROOT, 'plugin', 'compact-range.mjs')).href);
const m3 = await import(pathToFileURL(join(ROOT, 'plugin', 'm3.compact.mjs')).href);

const WINDOW = 1_000_000;         // 与真实会话一致（1M 窗口）
const CHARS_PER_TOKEN = 1.6;      // 中文启发式：1 token ≈ 1.6 字符（与项目口径一致）
const ARGS = process.argv.slice(2);
const SMOKE = ARGS.includes('--smoke');
const FACTORS = (() => {
  const hit = ARGS.find((a) => a.startsWith('--factor='));
  return hit ? [Number(hit.slice('--factor='.length))] : [1, 1.55];
})();

/* ───────────── 种子 ───────────── */
function smokeSeed() {
  /* 40 条消息 × ≈13000 字符 ≈ 320k token：**必须超过最大预算**（240k），
   * 否则 selectRange 会正确地返回 nothing-to-compact ⇒ 验证不到切分逻辑。
   * 12 个 needle 分布在远/中/近三段（远端 3、中段 3、近端 6）。 */
  const NEEDLE_AT = [1, 6, 12, 14, 18, 22, 28, 32, 35, 37, 38, 39];
  const padUnit = '这是一段用于验证链路的填充文本，模拟真实会话里的分析与代码讨论。';
  const messages = [];
  const needles = [];
  for (let i = 0; i < 40; i += 1) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const pad = padUnit.repeat(430); // ≈12900 字符 ≈ 8k token
    const at = NEEDLE_AT.indexOf(i);
    const value = at >= 0 ? `SMOKE-${String(at + 1).padStart(2, '0')}-KEY` : null;
    messages.push({ role, text: value ? `${pad} 关键值 ${value} 结束。` : pad });
    if (at >= 0) needles.push({ id: `K${String(at + 1).padStart(2, '0')}`, value, msgIndex: i, depthPct: Math.round(((i + 0.5) / 40) * 100) });
  }
  return { meta: { chars: 0, estimatedTokens: 0, needles: 12, controls: 0 }, messages, needles };
}

function loadSeed() {
  if (SMOKE) return smokeSeed();
  const p = join(HERE, 'seed.json');
  if (!existsSync(p)) {
    console.error(`[skip] 未找到 ${p}（先跑 node bench/gen-seed.mjs，或加 --smoke 验证脚本）`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

/* ───────────── 构造与 compact-range 同形的 session / measurement ───────────── */
function buildFixture(seed) {
  const seqs = [];
  const events = {};
  const nodes = [];
  let seq = 100;
  for (const m of seed.messages) {
    const s = seq++;
    seqs.push(s);
    events[s] = {
      type: m.role === 'user' ? 'user/message' : 'assistant/message',
      data: {
        content: [{ type: 'text', text: String(m.text ?? '') }],
        ...(m.role === 'user' ? { source: { kind: 'user' } } : {}),
      },
    };
    nodes.push({ seq: s, tokens: Math.max(1, Math.round(String(m.text ?? '').length / CHARS_PER_TOKEN)) });
  }
  return {
    session: { id: 'bench', surface: { nodes: seqs }, eventAt: (q) => events[q] ?? null },
    measurement: { nodes },
    textOf: (ev) => (ev?.data?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join(''),
  };
}

/* ───────────── 各臂的范围选择（严格镜像 m3 执行路径） ───────────── */
function runArm({ label, fixture, retainTokens, keepFromSeq = null }) {
  const r = range.selectRange({ session: fixture.session, measurement: fixture.measurement, retainTokens, keepFromSeq });
  return { label, budget: retainTokens, result: r };
}

function needleStats(seed, arm) {
  const total = seed.messages.length;
  const keepFromIdx = arm.result?.ok ? arm.result.endIdx + 1 : total; // 保留区 = [keepFromIdx, total-1]
  const buckets = { 远端: [0, 33], 中段: [33, 67], 近端: [67, 101] };
  const out = { retained: 0, total: seed.needles.length, byBucket: {} };
  for (const [name, [lo, hi]] of Object.entries(buckets)) out.byBucket[name] = { retained: 0, total: 0 };
  for (const n of seed.needles) {
    const bucket = n.depthPct < 33 ? '远端' : (n.depthPct < 67 ? '中段' : '近端');
    const kept = Number.isInteger(n.msgIndex) && n.msgIndex >= keepFromIdx;
    out.byBucket[bucket].total += 1;
    if (kept) { out.retained += 1; out.byBucket[bucket].retained += 1; }
  }
  return out;
}

/* ───────────── 主流程 ───────────── */
const seed = loadSeed();
const fixture = buildFixture(seed);
const chars = seed.messages.reduce((a, m) => a + String(m.text ?? '').length, 0);
const estTokens = Math.round(chars / CHARS_PER_TOKEN);
console.log(`种子：${seed.messages.length} 条消息 ｜ ${chars} 字符 ｜ ≈${estTokens} token ｜ needle ${seed.needles.length} 个${SMOKE ? '（--smoke 迷你样本）' : ''}`);
console.log(`窗口 ${WINDOW} ｜ 臂 = 8% / 16% / 24% × factor ${FACTORS.join(', ')} ｜ + 语义锚点 recentUser:1`);
console.log('');

const rows = [];
for (const factor of FACTORS) {
  for (const tier of ['light', 'standard', 'heavy']) {
    const t = range.resolveTier(tier, WINDOW);
    const budget = m3.scaleRetainBudget(t.budget, factor);
    const arm = runArm({ label: `${range.tierText(tier)}（×${factor}）`, fixture, retainTokens: budget });
    rows.push({ label: arm.label, tier, budget, factor, arm });
  }
}
/* 语义锚点：预算 = 锚点→末尾 token + 余量（resolveAnchorBudget），范围护栏 = 锚点 seq */
const anchor = range.resolveAnchorBudget({ session: fixture.session, measurement: fixture.measurement, want: { recentUser: 1 }, window: WINDOW, textOf: fixture.textOf });
if (anchor?.ok) {
  rows.push({ label: '锚点 recentUser:1', tier: 'anchor', budget: anchor.budget, factor: 1, arm: runArm({ label: '锚点 recentUser:1', fixture, retainTokens: anchor.budget, keepFromSeq: anchor.seq }), anchor });
} else {
  console.log(`⚠ 锚点解析失败：${anchor?.reason ?? 'unknown'}（跳过该臂）`);
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(`| ${pad('臂', 22)} | ${pad('预算', 8)} | ${pad('保留消息', 9)} | ${pad('保留 token', 10)} | ${pad('摘要 token', 10)} | 远端 中段 近端 | 事实保留 |`);
console.log(`|${'-'.repeat(24)}|${'-'.repeat(10)}|${'-'.repeat(11)}|${'-'.repeat(12)}|${'-'.repeat(12)}|${'-'.repeat(14)}|${'-'.repeat(10)}|`);
for (const row of rows) {
  const r = row.arm.result;
  if (!r?.ok) { console.log(`| ${pad(row.label, 22)} | ${pad(row.budget, 8)} | ${pad('—', 9)} | ${pad(r?.why ?? '?', 10)} | | | |`); continue; }
  const keepFromIdx = r.endIdx + 1;
  const keptMsgs = seed.messages.length - keepFromIdx;
  const st = needleStats(seed, row.arm);
  const b = st.byBucket;
  const cell = (x) => `${x.retained}/${x.total}`;
  console.log(`| ${pad(row.label, 22)} | ${pad(row.budget, 8)} | ${pad(keptMsgs, 9)} | ${pad(r.retainedTokens, 10)} | ${pad(r.shadowTokens, 10)} | ${pad(cell(b['远端']), 5)} ${pad(cell(b['中段']), 5)} ${pad(cell(b['近端']), 5)} | ${pad(`${st.retained}/${st.total}`, 8)} |`);
}

console.log('');
console.log('解读：');
console.log('- 「保留消息」= 压缩后仍以**原文**存在的消息条数；其余进摘要（摘要内容不在本阶段可测范围）。');
console.log('- 「事实保留」= 12 个带标记事实中仍以原文存在（可被逐字检索到）的数量 ⇒ 这是信息损失的**上界**。');
console.log('- 远端事实在 8% 档通常全丢、锚点档取决于锚点位置；这解释了为什么"边界清晰时锚点更省"。');
if (SMOKE) console.log('\n[提示] 当前是 --smoke 迷你样本，仅验证链路；真实结论请跑 node bench/gen-seed.mjs 后再运行本脚本。');
