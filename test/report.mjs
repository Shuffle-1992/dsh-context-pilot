#!/usr/bin/env node
/**
 * test/report.mjs —— 报告形状契约 + 取证工具自检。
 *
 * 为什么需要：`plugin/.data/m1-report.json` 是**唯一的重启后取证入口**，
 * 但它的形状随时可能被改动无声破坏（本项目已踩两次：
 * ① dump 脚本按报告顶层读 m3/m5，实际在 history 条目上 ⇒ 恒为 null；
 * ② dump-report-tail 仍读已删除的 keywordHits 字段）。
 *
 * 本脚本做三件事：
 *   ① 校验**代码产出的形状契约**（读 host.impl.mjs 源码，断言关键字段仍被写入）
 *   ② 若存在真实报告，校验其结构自洽（history 条目字段、profile 标记、bfOnce 依赖项）
 *   ③ 自检 dump 工具能跑通（防工具随形状变更失效）
 *
 * 用法：node test/report.mjs
 * 退出码：0 = 全通过；1 = 有失败（无报告时跳过 ②，不算失败）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');
const REPORT = join(PLUGIN, '.data', 'm1-report.json');
const HUD_ACTS = join(PLUGIN, '.data', 'hud-acts.json');
const DUMP = join(ROOT, 'docs', 'reference', 'tools', 'dump-report.cjs');

let failures = 0;
let checks = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`); }
};

const host = readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8');

/* ═══════════ ① 产出侧形状契约（源码断言）═══════════ */
console.log('\n== 1. 产出侧形状契约（host.impl.mjs 必须写入的关键字段）==');
const requiredBlocks = [
  ['m3 块含 eff（生效参数快照）', /eff:\s*\{\s*\.\.\.M3\s*\}/],
  ['m3 块含 liveEnabled（开关现值）', /liveEnabled:\s*effEnabled\(\)/],
  ['m3 块含 heartbeat（心跳取证）', /heartbeat:\s*state\.heartbeat/],
  ['m3 块含 m4Probe（schema 解析）', /m4Probe:\s*state\.m4Probe/],
  ['m3 块含 lastAct（压缩结果）', /lastAct:\s*state\.m3\.lastAct/],
  ['m3 块含 lastDecision（决策审计）', /lastDecision:\s*state\.m3\.lastDecision/],
  ['m5 块含 hud（HUD 状态）', /hud:\s*\{\s*\.\.\.\(state\.m5\.hud/],
  ['m5 块含 hudFace（face 注册状态）', /hudFace:\s*state\.m5\.hudFace/],
  ['m5 块含 lastPublish（发布留痕）', /lastPublish:\s*state\.m5\.lastPublish/],
  ['m55 块含 attempts（恢复尝试）', /attempts:\s*state\.m55\.attempts\.slice/],
  ['m55 块含 channelProbe（通道探测）', /channelProbe:\s*state\.m55\.channelProbe/],
  ['services 枚举（服务可达性）', /for \(const k of \['tokenMeter'/],
  ['m2 块含 skips（注入跳过统计）', /skips:\s*\{\s*\.\.\.state\.m2\.skips\s*\}/],
];
for (const [name, re] of requiredBlocks) ok(name, re.test(host));

/* ═══════════ ② bfOnce 依赖项（回填链不能断）═══════════ */
console.log('\n== 2. 回填链依赖（bfOnce 读取的字段必须存在）==');
const bfOnce = /const bfOnce = \(\) => \{[\s\S]*?\n    \};/.exec(host)?.[0] ?? '';
ok('解析出 bfOnce 函数', bfOnce.length > 0, '未找到 bfOnce（重命名了？回填链检查失效）');
ok('bfOnce 按 reason==="m3-act" 筛选', /reason === 'm3-act'/.test(bfOnce),
  'bfOnce 的筛选条件变了——回填会读错条目');
ok('bfOnce 读 e.m3.lastAct（条目路径，非顶层）', /e\?\.m3\?\.lastAct|e\.m3\.lastAct/.test(bfOnce),
  'bfOnce 未按「条目上的 m3」读取（历史 bug：按顶层读恒 null）');
ok('bfOnce 回填 sid（会话过滤依赖）', /sessionId/.test(bfOnce), 'bfOnce 未取 sessionId ⇒ 按会话过滤失效');

/* ═══════════ ③ 瘦身档位与关键事件保护 ═══════════ */
console.log('\n== 3. C3② 瘦身档位（关键事件必须走 full）==');
const slimMatch = /const SLIM_REASONS = new Set\(\[([\s\S]*?)\]\);/.exec(host)?.[1] ?? '';
const slimSet = new Set([...slimMatch.matchAll(/'([^']+)'/g)].map((m) => m[1]));
ok('解析出 SLIM_REASONS', slimSet.size > 0, '未找到 SLIM_REASONS（瘦身逻辑改了？）');
for (const mustFull of ['m3-act', 'm4-probe', 'activation+2s', 'boot+10s']) {
  ok(`关键事件 ${mustFull} 不在精简档`, !slimSet.has(mustFull),
    `${mustFull} 被列入 slim ⇒ 取证信息丢失（m3-act 还会破坏回填）`);
}
ok('slimSnapshot 函数存在且被 refresh 调用', /const slimSnapshot = /.test(host) && /SLIM_REASONS\.has\(reason\)/.test(host),
  'slimSnapshot 未被 refresh 使用（瘦身未生效）');

/* ═══════════ 3.5 getHud 作用域契约（防 ReferenceError 回归）═══════════ */
console.log('\n== 3.5 getHud 作用域契约（2026-10-07 真根因）==');
// 实测事故：agents 声明在 occ IIFE 内部，criticalCap 却在 IIFE 外引用它 ⇒ 每次 getHud 抛
// ReferenceError("agents is not defined") ⇒ client 永远拿不到数据、弹窗恒「暂无压缩记录」。
const getHudBody = (() => {
  const s = host.indexOf('onGetHud: (sid) =>');
  if (s < 0) return '';
  const e = host.indexOf('state.m5.hudPollReq', s);
  return e > s ? host.slice(s, e) : host.slice(s, s + 4000);
})();
ok('解析出 onGetHud 函数体', getHudBody.length > 0, '未找到 onGetHud');
ok('agents 在 onGetHud 顶层声明（不在 IIFE 内）',
  /const agents = svc\('agents'\)/.test(getHudBody),
  'agents 未在 onGetHud 顶层声明 ⇒ criticalCap 引用会抛 ReferenceError');
const occStart = getHudBody.indexOf('const occ = (()');
const occBody = occStart >= 0 ? getHudBody.slice(occStart, getHudBody.indexOf('})();', occStart)) : '';
ok('occ IIFE 内不再重复声明 agents', !/const agents\s*=/.test(occBody),
  'occ IIFE 内仍声明 agents ⇒ 外层 criticalCap 引用会 ReferenceError');
ok('criticalCap 引用的 agents 在作用域内',
  /criticalCap:[\s\S]{0,240}agents\.find/.test(getHudBody) && /const agents = svc\('agents'\)/.test(getHudBody),
  'criticalCap 引用 agents 但作用域内无声明');
ok('getHud 有常驻取证字段 hudPollReq', /state\.m5\.hudPollReq = \{/.test(host),
  '缺 hudPollReq ⇒ 下次同类问题无法从报告判断 host 是否被调用');
/* 实测缺陷（2026-10-07）：getHud 给 engineThreshold 传了 `?.session`（Session 本体），
 * 而 resolveCompactionFor 要的是 Agent（走 agent.ctx / agentPresets.serviceFor(agent,...)）
 * ⇒ 每次 5s 轮询都写 via:unresolved/fallback:true，criticalCap 恒为兜底 0.8。
 * 证据：getHud 的 engineCapProbe 时间戳与 hudPollReq 逐次吻合，而 pre-step 全部解析成功。 */
const capArg = /criticalCap:\s*engineThreshold\(([\s\S]{0,260}?)\),\n/.exec(getHudBody)?.[1] ?? '';
ok('解析出 criticalCap 的 engineThreshold 实参', capArg.length > 0, '未匹配到 criticalCap 实参');
ok('criticalCap 传 Agent 本体（不得传 .session）',
  capArg.length > 0 && !/\.session\s*\)/.test(capArg) && !/\)\?\.session/.test(capArg),
  'criticalCap 传了 Session 而非 Agent ⇒ resolveCompactionFor 返回 unresolved，cap 恒为兜底值');

/* ═══════════ ④ 真实报告结构自洽（有报告才跑）═══════════ */
console.log('\n== 4. 真实报告结构自洽 ==');
if (!existsSync(REPORT)) {
  console.log('  ⚠️ 跳过（报告不存在：' + REPORT + '）');
} else {
  const rep = JSON.parse(readFileSync(REPORT, 'utf8'));
  ok('顶层含 history 数组', Array.isArray(rep.history));
  const hist = rep.history ?? [];
  ok(`history 非空（${hist.length} 条）`, hist.length > 0);

  // 字段必须挂在条目上（本项目的历史 bug）
  const topLevelBlocks = ['m3', 'm5', 'm55', 'm2'].filter((k) => rep[k] !== undefined);
  ok('m3/m5/m55/m2 不挂在报告顶层（应在 history 条目上）', topLevelBlocks.length === 0,
    `顶层出现了 ${topLevelBlocks.join(', ')} —— dump 脚本会读错路径`);

  const last = hist[hist.length - 1] ?? {};
  ok('条目含 at（时间戳）', typeof last.at === 'string');
  ok('条目含 reason', typeof last.reason === 'string');
  ok('条目含 m3.eff（生效参数）', !!last.m3?.eff, '最近条目缺 m3.eff');
  ok('条目含 services（服务可达性）', !!last.services && typeof last.services === 'object');

  // profile 标记（C3② 引入）
  const profiled = hist.filter((e) => e.profile === 'slim' || e.profile === 'full');
  ok('存在带 profile 标记的条目（瘦身生效）', profiled.length > 0,
    '无 profile 标记 ⇒ 要么瘦身未生效，要么报告全是旧条目');
  if (profiled.length) {
    const slim = hist.filter((e) => e.profile === 'slim');
    const full = hist.filter((e) => e.profile === 'full');
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, e) => a + JSON.stringify(e).length, 0) / arr.length / 1024 * 100) / 100 : 0);
    console.log(`     档位分布：slim ${slim.length} 条（均 ${avg(slim)}KB）| full ${full.length} 条（均 ${avg(full)}KB）`);
    if (slim.length && full.length) {
      ok('slim 条目确实比 full 小', avg(slim) < avg(full), `slim=${avg(slim)}KB full=${avg(full)}KB`);
    }
    // slim 条目必须仍保留回填所需字段
    const slimLast = slim[slim.length - 1];
    if (slimLast) {
      ok('slim 条目仍含 m3（决策/压缩取证）', !!slimLast.m3);
      ok('slim 条目仍含 m2（注入取证）', !!slimLast.m2);
      ok('slim 条目丢弃 eventProbe（体积来源）', slimLast.m3?.eventProbe === undefined,
        'slim 条目仍带 eventProbe ⇒ 瘦身不彻底');
    }
  }
}

/* ═══════════ ⑤ hud-acts.json 形状 ═══════════ */
console.log('\n== 5. 压缩历史持久化（hud-acts.json）==');
if (!existsSync(HUD_ACTS)) {
  console.log('  ⚠️ 跳过（文件不存在，下次压缩时会创建）');
} else {
  const j = JSON.parse(readFileSync(HUD_ACTS, 'utf8'));
  ok('含 version 字段', typeof j.version === 'number');
  ok('含 acts 数组', Array.isArray(j.acts));
  const acts = j.acts ?? [];
  ok(`acts 条数 ≤ 50 上限（实际 ${acts.length}）`, acts.length <= 50);
  if (acts.length) {
    const a = acts[0];
    ok('条目含 sid/text/at 三字段', typeof a.sid === 'string' && typeof a.text === 'string' && typeof a.at === 'string');
    // 去重校验（recordHudAct 的防护）
    const keys = acts.map((x) => `${x.at}|${x.sid}|${x.text}`);
    ok('无完全重复条目（去重防护生效）', new Set(keys).size === keys.length,
      `发现 ${keys.length - new Set(keys).size} 条重复`);
  }
}

/* ═══════════ ⑥ dump 工具可跑通 ═══════════ */
console.log('\n== 6. dump 工具自检（--field / --history-acts）==');
if (!existsSync(REPORT)) {
  console.log('  ⚠️ 跳过（无报告）');
} else {
  for (const args of [['--field', 'm3.eff'], ['--history-acts'], ['--tail', '2']]) {
    try {
      const out = execFileSync(process.execPath, [DUMP, ...args], { encoding: 'utf8', stdio: 'pipe' });
      ok(`dump-report.cjs ${args.join(' ')}`, out.trim().length > 0, '输出为空');
    } catch (e) {
      ok(`dump-report.cjs ${args.join(' ')}`, false, String(e.stderr || e.message).split('\n')[0]);
    }
  }
}

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'='.repeat(52)}`);
console.log(`报告契约：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);
