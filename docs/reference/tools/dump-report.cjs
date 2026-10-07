#!/usr/bin/env node
/**
 * dump-report.cjs —— 插件取证报告（plugin/.data/m1-report.json）统一 dump 工具。
 *
 * 合并并取代此前散落在 .data/ 与 plugin/.data/ 的多个一次性脚本
 * （dump-m55-fields / dump-hud-tail / dump-report-tail / dump-m55）。
 *
 * 用法：
 *   node docs/reference/tools/dump-report.cjs                 # 默认：概览 + 尾部 12 条
 *   node docs/reference/tools/dump-report.cjs --tail 20       # 尾部 N 条
 *   node docs/reference/tools/dump-report.cjs --kind m3-act   # 只列 reason 匹配的条目
 *   node docs/reference/tools/dump-report.cjs --full          # 尾部条目完整 JSON
 *   node docs/reference/tools/dump-report.cjs --field m3.eff  # 取最近一条的某字段
 *   node docs/reference/tools/dump-report.cjs --report <path> # 指定报告路径
 *   node docs/reference/tools/dump-report.cjs --history-acts  # 压缩历史（m3-act 摘要）
 *
 * 关键路径约定（踩过坑，勿改）：
 *   - m1/m2/m3/m5/m55 等块**在每个 history 条目上**，不在报告顶层；
 *   - 压缩动作用 `e.reason === 'm3-act'` + `e.m3.lastAct` 识别；
 *   - HUD 状态在 `e.m5.hud`，发布留痕在 `e.m5.lastPublish`。
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes('--' + name);

const DEFAULT_REPORT = path.join(__dirname, '..', '..', '..', 'plugin', '.data', 'm1-report.json');
const reportPath = path.resolve(getArg('report', DEFAULT_REPORT));

if (!fs.existsSync(reportPath)) {
  console.error('报告不存在：' + reportPath);
  console.error('（请确认插件已激活并写过报告，或用 --report 指定路径）');
  process.exit(1);
}

const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const hist = Array.isArray(rep.history) ? rep.history : [];
const tailN = Number(getArg('tail', 12));

/** 单条摘要行（HUD/压缩/注入关键字段） */
const summarize = (e) => {
  const m3 = e.m3 || {};
  const m5 = e.m5 || {};
  const m2 = e.m2 || {};
  const last = m3.lastAct;
  const sess = e.sessions?.[0]?.measure;
  return [
    String(e.at || '?').slice(11, 19),
    String(e.reason || '?').padEnd(16),
    'gen=' + (m5.hud?.gen || '?'),
    'hudLastAct=' + (m5.hud?.hudLastAct || '-'),
    'hudFace=' + (m5.hudFace || '-'),
    last ? `lastAct=${last.reason}/省${last.shadowedTokens}` : '',
    m2.injections ? `inj=${m2.injections}` : '',
    sess?.totalTokens ? `used=${sess.totalTokens}` : '',
  ].filter(Boolean).join(' | ');
};

if (has('history-acts')) {
  // 压缩历史（与 hud-acts.json 对应，但直接取自报告）
  const acts = hist.filter((e) => e.reason === 'm3-act' && e.m3?.lastAct);
  console.log(`== 报告内 m3-act 条目：${acts.length} 条（报告为 ${hist.length} 条环形缓冲，历史条目可能已被剪掉）==`);
  for (const e of acts) {
    const a = e.m3.lastAct;
    console.log(`  ${e.at} | ${String(a.sessionId).slice(0, 20)} | ${a.reason} | 省 ${a.shadowedTokens} | nodes ${a.shadowedNodes}`);
  }
  const hudPath = path.join(path.dirname(reportPath), 'hud-acts.json');
  if (fs.existsSync(hudPath)) {
    const j = JSON.parse(fs.readFileSync(hudPath, 'utf8'));
    console.log(`\n== hud-acts.json（持久化，cap 50）：${j.acts?.length ?? 0} 条 ==`);
    for (const a of (j.acts || []).slice(0, 10)) console.log(`  ${a.at} | ${String(a.sid).slice(0, 20)} | ${a.text}`);
  }
  process.exit(0);
}

if (has('field')) {
  const key = getArg('field');
  const last = hist[hist.length - 1] || {};
  const val = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), last);
  console.log(`${key} = ${JSON.stringify(val, null, 2)}`);
  process.exit(0);
}

// 默认：概览 + 尾部
console.log(`报告：${reportPath}`);
console.log(`大小：${Math.round(fs.statSync(reportPath).size / 1024)} KB | history：${hist.length} 条 | updated：${rep.updated || '?'}`);
const kindFilter = getArg('kind');
const rows = kindFilter ? hist.filter((e) => (e.reason || '').includes(kindFilter)) : hist.slice(-tailN);
console.log(`\n== ${kindFilter ? `reason 含 "${kindFilter}" 的条目（${rows.length} 条）` : `尾部 ${rows.length} 条`} ==`);
for (const e of rows) console.log('  ' + summarize(e));

if (has('full')) {
  console.log('\n== 完整 JSON（尾部条目）==');
  console.log(JSON.stringify(rows, null, 1));
}

// 取证要点速览（最近一条）
const last = hist[hist.length - 1];
if (last) {
  console.log('\n== 最近一条的取证要点 ==');
  console.log('  m3.eff        =', JSON.stringify(last.m3?.eff));
  console.log('  m3.heartbeat  =', JSON.stringify(last.m3?.heartbeat));
  console.log('  m5.hud        =', JSON.stringify(last.m5?.hud));
  console.log('  m2.skips      =', JSON.stringify(last.m2?.skips));
  console.log('  services      =', JSON.stringify(last.services));
  console.log('  m55.armed     =', JSON.stringify(last.m55?.armed));
  console.log('  m55.attempts  =', JSON.stringify((last.m55?.attempts || []).slice(-3)));
}
