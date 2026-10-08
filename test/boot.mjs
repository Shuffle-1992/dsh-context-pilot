#!/usr/bin/env node
/**
 * test/boot.mjs —— **宿主启动冒烟测试**（R11 新增；本项目此前的最大验证盲区）。
 *
 * ## 为什么必须有这一套
 * 2026-10-08 R11 实测教训：抽取 M5 HUD 域时，接线块的插入点算错一位，把
 * `let m5Ctl … const m5Ready = import(...)` 这一整块**插进了 `schedule()` 的函数体内部**
 * （残留的 `};` 落到了接线块之后，语法完全合法）。后果是**连锁静默失效**：
 *   - M5 模块从未加载（弹窗无数据、启动回填不跑）；
 *   - `publishHud`/`recordHudAct`/`formatAct` 对 M3 接线**不在作用域** ⇒ M3 模块加载失败
 *     ⇒ **压缩全链路静默失效**；
 *   - `node --check` 通过、423 条**源断言全部通过**（它们只查文本模式，不执行代码）。
 * ⇒ 结论：源断言无法证明「接线可达」。**必须有一个真的把 apply() 跑起来、真的调用
 *    getHud / pre-step 的测试**。这一套就是它。
 *
 * ## 它做什么
 * 用桩 ctx（`get/on/provide/effect/logger`）真跑 `apply(ctx, {}, {pluginDir, reportPath})`：
 *   ① HUD 面必须注册成功；
 *   ② **真调用 `getHud(null)` 必须 ok:true** —— 未就绪会回 `m5-module-pending`，
 *      接线被嵌进别的函数则会 ReferenceError（正是上面那个 bug 的两种形态）；
 *   ③ `getHud` 必须带回 `criticalCap`（数）+ occupancy 两字段（证阈值/占用接线可达）；
 *   ④ 四个监听器必须注册；**真调用 pre-step handler** 必须不抛且返回决策；
 *   ⑤ 有历史时，**启动回填必须真的发布过**（报告里 `m5.lastPublish.step === 'ok'`）。
 *
 * ## 副作用边界
 * 报告写到**临时目录**；`hud-acts.json` **只读不写**（临时报告无 m3-act ⇒ 合并分支不触发）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');

let failures = 0;
let checks = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n== 宿主启动冒烟（真跑 apply + 真调 getHud/pre-step）==');

const tmp = mkdtempSync(join(tmpdir(), 'dcp-boot-'));
const reportPath = join(tmp, 'm1-report.json');
const provided = new Map();
const handlers = new Map();
let effects = 0;

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get: () => null, // 所有服务都拿不到 ⇒ 走「降级」分支（这正是要验证的鲁棒性）
  on: (name, handler) => { handlers.set(name, handler); },
  provide: (name, face) => { provided.set(name, face); },
  effect: (setup) => { effects += 1; return setup?.(); },
};

let applyFn = null;
try {
  ({ apply: applyFn } = await import(pathToFileURL(join(PLUGIN, 'host.impl.mjs')).href));
} catch (e) {
  ok('host.impl.mjs 可被 import', false, String(e?.message ?? e));
}
if (typeof applyFn !== 'function') {
  console.log(`\n${'='.repeat(52)}\n宿主启动冒烟：${checks - failures}/${checks} 通过\n${'='.repeat(52)}`);
  process.exit(1);
}

let ret = null;
try {
  ret = applyFn(ctx, {}, { pluginDir: PLUGIN, reportPath });
} catch (e) {
  ok('apply() 不抛（激活绝不失败）', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
}
ok('apply() 同步返回 reportPath', !!ret && ret.reportPath === reportPath, `实际 ${JSON.stringify(ret)}`);
ok('ctx.effect 收到清理注册（卸载器形态）', effects >= 1, `effects=${effects}`);

/* 让所有 `?ts=` 模块 import 完成（每个都是一次 microtask+IO；1.5s 足够且与真实激活同量级）。 */
await sleep(1500);

/* ① HUD 面 */
const faceName = [...provided.keys()][0] ?? null;
ok('HUD 面已注册（ctx.provide）', !!faceName && typeof provided.get(faceName)?.getHud === 'function',
  `provided=${[...provided.keys()].join(',') || '（无）'}`);

/* ② getHud 真调用 —— 本套测试的核心断言 */
let resp = null;
try {
  resp = await provided.get(faceName)?.getHud?.(null);
} catch (e) {
  ok('getHud 真调用不抛（接线在作用域内）', false, String(e?.message ?? e));
}
ok('getHud 真调用返回 ok:true（证 M5 模块构造完成且接线可达）',
  resp?.ok === true,
  `实际 ${JSON.stringify(resp)} —— ok:false/error 说明接线被嵌进了别的函数或模块未构造`);
ok('getHud 返回生效上限 criticalCap（证阈值核心接线可达）',
  typeof resp?.criticalCap === 'number' && resp.criticalCap > 0 && resp.criticalCap <= 1,
  `实际 criticalCap=${JSON.stringify(resp?.criticalCap)}`);
ok('getHud 返回 occupancyRatio / occupancyWindow 两个字段（client 据此渲染距线提示）',
  resp != null && 'occupancyRatio' in resp && 'occupancyWindow' in resp,
  `实际字段 ${Object.keys(resp ?? {}).join(',')}`);
ok('getHud 返回 effortEnabled 布尔（与 effort 数据分离）',
  typeof resp?.effortEnabled === 'boolean',
  `实际 ${JSON.stringify(resp?.effortEnabled)}`);
ok('getHud 未就绪时会明确报错而非静默（降级可诊断）',
  resp?.ok === true ? !/pending/.test(JSON.stringify(resp)) : true);

/* ③ 监听器 + pre-step handler 真调用 */
ok('四个监听器已注册（agent/pre-step · session/created · agent/status · session/event）',
  handlers.size >= 4, `实际 ${[...handlers.keys()].join(',') || '（无）'}`);

const preStep = handlers.get('agent/pre-step');
let decision = null;
let preStepErr = null;
try {
  const session = { id: 'boot-probe', surface: { nodes: [] }, requestHeader: () => null, eventAt: () => null };
  decision = await preStep(
    { agent: { id: 'boot-probe', session, ctx: { get: () => null } }, signal: AbortSignal.abort(), step: 1, turn: 1 },
    async () => ({ kind: 'allow', messages: [] }),
  );
} catch (e) {
  preStepErr = e;
}
ok('pre-step handler 真调用不抛（证 M3/effort/compact-tool 接线可达）',
  !preStepErr, preStepErr ? String(preStepErr?.stack ?? preStepErr).split('\n').slice(0, 3).join(' | ') : '');
ok('pre-step handler 放行原决策（signal 已 abort ⇒ 原样返回）',
  decision?.kind === 'allow', `实际 ${JSON.stringify(decision)}`);

/* ③b R12：**真跑 M2 注入路径**（非 abort + step=1）。
 * 判据用「记账痕迹」而不是返回值：模块未加载时宿主在 `if (!m2Ctl) return decision;` 直接放行、
 * **不会留下任何 m2.skips 记录**；模块加载了则 `buildInjection` 必然走到某个分支并记账
 * （本桩环境里 `svc` 全为 null、`createUserMessage` 大概率解析不出 ⇒ 落在 noFactory / measureFail）。
 * ⇒ 这一条正是「M2 接线是否可达」的运行时证据。 */
let injectionProbe = null;
try {
  injectionProbe = await preStep(
    {
      agent: { id: 'boot-probe', session: { id: 'boot-probe', surface: { nodes: [] }, requestHeader: () => null, eventAt: () => null }, ctx: { get: () => null } },
      signal: undefined,
      step: 1,
      turn: 2,
    },
    async () => ({ kind: 'allow', messages: [] }),
  );
} catch (e) {
  ok('pre-step 注入路径真调用不抛（证 M2 接线可达）', false, String(e?.message ?? e));
}
ok('pre-step 注入路径不抛且放行原决策（step=1、未 abort）',
  injectionProbe?.kind === 'allow', `实际 ${JSON.stringify(injectionProbe)}`);
/* 等 `activation+2s` 那次刷新把计数器落进报告（激活后 2s；此处已在 1.5s + 探针之后）。 */
await sleep(1000);
{
  const rep = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const last = rep?.history?.[rep.history.length - 1];
  const skips = last?.m2?.skips ?? {};
  const injected = Number(last?.m2?.injections ?? 0);
  ok('M2 注入路径真跑过并留下记账（m2.skips 有键 或 injections>0）',
    Object.keys(skips).length > 0 || injected > 0,
    `实际 skips=${JSON.stringify(skips)} injections=${injected} —— 两者皆空说明接线不可达（M2 模块未加载）`);
  ok('m2 取证字段齐全（via / registered / lastText 键存在）',
    last?.m2 != null && 'via' in last.m2 && 'registered' in last.m2 && 'lastText' in last.m2,
    `实际键 ${Object.keys(last?.m2 ?? {}).join(',')}`);
}

/* ④ 启动回填真跑过（有历史时才可判定；无历史则跳过，不算失败——避免污染别人的 checkout） */
const actsPath = join(PLUGIN, '.data', 'hud-acts.json');
let storedActs = 0;
try { storedActs = (JSON.parse(readFileSync(actsPath, 'utf8')).acts ?? []).length; } catch { storedActs = 0; }
if (storedActs > 0) {
  await sleep(900); // m5-publish 防抖 400ms + 落盘
  const rep = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const last = rep?.history?.[rep.history.length - 1];
  ok(`有历史（${storedActs} 条）时启动回填真跑过：m5.lastPublish.step === 'ok'`,
    last?.m5?.lastPublish?.step === 'ok',
    `实际 ${JSON.stringify(last?.m5?.lastPublish)} —— 接线被嵌进函数时这里是 null（R11 真 bug 的现场）`);
  ok('回填后 HUD 主行非空（弹窗不再空态）',
    !!last?.m5?.hud?.hudLastAct, `实际 ${JSON.stringify(last?.m5?.hud?.hudLastAct)}`);
} else {
  console.log('  ⚠️ 跳过启动回填断言（本机 hud-acts.json 无历史；该断言在有历史的机器上才可判定）');
}

/* ⑤ 报告真的产出（证报告管线在本进程里可达） */
ok('报告已落盘且 history 非空（激活快照管线可达）',
  existsSync(reportPath) && (JSON.parse(readFileSync(reportPath, 'utf8')).history ?? []).length > 0,
  `reportPath=${reportPath}`);

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 吞 */ }

console.log(`\n${'='.repeat(52)}`);
console.log(`宿主启动冒烟：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);
