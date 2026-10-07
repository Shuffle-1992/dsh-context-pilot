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
/* R3（2026-10-08）：智能思考功能域已抽独立模块，相关断言随之改指向模块。 */
const effort = readFileSync(join(PLUGIN, 'effort.mjs'), 'utf8');

/* ═══════════ ① 产出侧形状契约（源码断言）═══════════ */
console.log('\n== 1. 产出侧形状契约（host.impl.mjs 必须写入的关键字段）==');
const requiredBlocks = [
  ['m3 块含 eff（生效参数快照）', /eff:\s*\{\s*\.\.\.M3\s*\}/],
  ['m3 块含 liveEnabled（开关现值）', /liveEnabled:\s*effEnabled\(\)/],
  ['m3 块含 heartbeat（心跳取证）', /heartbeat:\s*state\.heartbeat/],
  ['m3 块含 m4Probe（schema 解析）', /m4Probe:\s*state\.m4Probe/],
  ['m3 块含 lastAct（压缩结果）', /lastAct:\s*state\.m3\.lastAct/],
  /* R7：`lastDecision`（决策审计）随 `agent/inbox/inserted` 审计监听器一起删除；
   * 新增 `compactIntentMiss` —— 「本 sid 无意图但表里有别的意图」的现场留痕
   * （session id 轮转 ⇒ 工具回了 scheduled 但压缩永不发生，这是唯一可诊断点）。 */
  ['m3 块含 compactIntentMiss（意图未命中的现场）', /compactIntentMiss:\s*state\.m3\.compactIntentMiss/],
  ['m5 块含 hud（HUD 状态）', /hud:\s*\{\s*\.\.\.\(state\.m5\.hud/],
  ['m5 块含 hudFace（face 注册状态）', /hudFace:\s*state\.m5\.hudFace/],
  ['m5 块含 lastPublish（发布留痕）', /lastPublish:\s*state\.m5\.lastPublish/],
  ['services 枚举（服务可达性）', /for \(const k of \['tokenMeter'/],
  ['m2 块含 skips（注入跳过统计）', /skips:\s*\{\s*\.\.\.state\.m2\.skips\s*\}/],
  /* R7：`m55` 块（armed/attempts/channelProbe）随 M5.5 收官残留整体删除 —— 旧断言在此退役。
   * 反向断言：报告里不得再出现 m55（防复活）。 */
];
for (const [name, re] of requiredBlocks) ok(name, re.test(host));
ok('报告不再含 m55 块（M5.5 恢复通道已整体退役）',
  !/state\.m55/.test(host.replace(/\/\*[\s\S]*?\*\//g, '')),
  'm55 残留 ⇒ 旧恢复通道有复活路径');

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
  // R1（2026-10-07）：签名由 `onGetHud: (sid) =>` 变为 `onGetHud: async (sid) =>`
  // （effort 需要 await resolveModelInfo）——两种形态都接受，避免为签名变更误报。
  const m = /onGetHud:\s*(?:async\s*)?\(sid\)\s*=>/.exec(host);
  if (!m) return '';
  const s = m.index;
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
ok('criticalCap 的 Agent 在作用域内解析（targetAgent 由 agents 选出）',
  /const targetAgent = [\s\S]{0,200}agents\.find/.test(getHudBody) && /criticalCap:\s*criticalCapOf\(targetAgent\)/.test(getHudBody),
  'criticalCap 未用作用域内解析出的 Agent ⇒ 可能又传 Session/未定义变量');
ok('getHud 有常驻取证字段 hudPollReq', /state\.m5\.hudPollReq = \{/.test(host),
  '缺 hudPollReq ⇒ 下次同类问题无法从报告判断 host 是否被调用');
/* 实测缺陷（2026-10-07）：getHud 给 engineThreshold 传了 `?.session`（Session 本体），
 * 而 resolveCompactionFor 要的是 Agent（走 agent.ctx / agentPresets.serviceFor(agent,...)）
 * ⇒ 每次 5s 轮询都写 via:unresolved/fallback:true，criticalCap 恒为兜底 0.8。
 * 证据：getHud 的 engineCapProbe 时间戳与 hudPollReq 逐次吻合，而 pre-step 全部解析成功。
 * ⚠️ 2026-10-08：下发点由 `engineThreshold(targetAgent)` 改为 `criticalCapOf(targetAgent)`
 *    （用户要求强制线恒低于引擎阈值 5pp，上限计算收敛到单一函数）；**传 Agent 本体的要求不变**，
 *    且现在多了一层：实参若变成 `targetAgent.session`，engineThreshold 内部就会 unresolved。 */
const capArg = /criticalCap:\s*criticalCapOf\(([^)]*)\)/.exec(getHudBody)?.[1] ?? '';
ok('解析出 criticalCap 的实参（上限函数）', capArg.length > 0, '未匹配到 criticalCap 实参');
ok('criticalCap 传 Agent 本体（不得传 .session）',
  capArg.length > 0 && !/\.session/.test(capArg),
  `criticalCap 传了 Session 而非 Agent（实参：${capArg}）⇒ resolveCompactionFor 返回 unresolved，cap 恒为兜底值`);

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

/* ═══════════ ⑥ 思考强度调查结论契约（探针已退役，结论必须留档）═══════════ */
console.log('\n== 6. 思考强度调查结论（探针退役，结论与参考实现必须留档）==');
// R3（2026-10-08）：调查期的一次性探针 r1ProbeOnce（~170 行、且自带 selectModel 写入路径）
// 已随「清理调查脚手架」退役——结论已入 docs 与 effort.mjs 文件头。
// 本段用「结论留档」断言替代原来的「探针存在」断言：结论本身必须还在，否则实施期会再踩一遍。
ok('调查期探针已退役（不留一次性脚手架）',
  !/r1ProbeOnce|state\.r1Probe|r2Probe|r3Probe/.test(host),
  '仍残留 r1ProbeOnce/state.r1Probe/snap.r*Probe ⇒ 调查脚手架未清理');
const invDocPath = join(ROOT, 'docs', 'r1-reasoning-effort-investigation.md');
const invDoc = existsSync(invDocPath) ? readFileSync(invDocPath, 'utf8') : '';
ok('调查结论已入档（docs/r1-reasoning-effort-investigation.md）', invDoc.length > 0,
  '缺少调查文档 ⇒ 结论只活在代码里，重构一次就丢');
ok('负面结论已入档（selectionFor 不在命令门面上）',
  /requestHeader/.test(invDoc) && /selectionFor/.test(invDoc),
  '文档未记录「selectionFor 不可用」⇒ 实施期会再试一遍这条死路');
ok('写档副作用已入档（selectModel 会改全局默认模型）',
  /saveSelection|全局默认/.test(invDoc),
  '未记录该副作用 ⇒ 实施期易踩（会顺带改掉新会话的默认档）');
/* 结论必须同时固化在模块文件头（10 条「来之不易」）—— 只放 docs 不够：
 * 改这个文件的人不一定先读 docs。断言几条最容易被当「冗余」删掉的。 */
ok('关键实证结论固化在 effort.mjs 文件头',
  /prepend: true/.test(effort) && /delete out\.maxTokens/.test(effort) &&
  /UNSUPPORTED_REASONING_EFFORT/.test(effort) && /id 会轮转/.test(effort),
  'effort.mjs 未固化 prepend / maxTokens / 两侧校验 / sid 轮转四条结论 ⇒ 下轮重构会误删');
ok('读档唯一可靠路径仍是 requestHeader（代码与文档一致）',
  /agent\?\.session\?\.requestHeader\?\.\(\)/.test(effort),
  'effort.mjs 未走 requestHeader 读档 ⇒ 与调查结论不符');
// 参考实现已存档（router-laya 的 agent/request 路线）
ok('router-laya 参考源码已存档', existsSync(join(ROOT, '.data', 'ref', 'router-laya-index.js')),
  '缺少 .data/ref/router-laya-index.js（参考实现证据）');

/* ═══════════ ⑦ dump 工具可跑通 ═══════════ */
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
