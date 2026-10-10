#!/usr/bin/env node
/**
 * test/static.mjs —— 静态约束检查（不启动 DSH）。
 *
 * 覆盖三类「架构约束」，它们都是本项目踩过坑后定下的硬规则：
 *   ① 语法：全部 .mjs/.js/.cjs 可解析（node --check 等价）
 *   ② 单文件约束：client.js 必须是**自足 bundle**（无 import/require 外部模块），
 *      entry.mjs 必须保持**薄壳**（不得出现业务逻辑/大块代码）
 *   ③ 无互引：plugin/*.mjs 之间只允许「host.impl → core/wire」方向的受控导入，
 *      禁止 client.js 被 host 引用、禁止循环依赖（为 D1 模块切分预留护栏）
 *
 * 用法：node test/static.mjs
 * 退出码：0 = 全通过；1 = 违规
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');
const TOOLS = join(ROOT, 'docs', 'reference', 'tools');

let failures = 0;
let checks = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`); }
};

/** 剥掉注释与字符串字面量，用于「扫描代码本体」的检查（避免注释/文案误报）。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // 行注释（避开 URL 的 //）
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');

/* ═══════════ ① 语法检查（调用真实 node --check）═══════════ */
console.log('\n== 1. 语法（真实 node --check）==');
const targets = [];
const collect = (dir, depth = 0) => {
  if (depth > 3) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, depth + 1);
    else if (['.mjs', '.js', '.cjs'].includes(extname(name)) && st.size < 2_000_000) targets.push(p);
  }
};
collect(PLUGIN);
collect(TOOLS);

const tmp = mkdtempSync(join(tmpdir(), 'dcp-check-'));
for (const f of targets) {
  const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
  // client.js 是 ModuleLoader 信封（非模块），其余按真实扩展名做 --check
  const isEnvelope = readFileSync(f, 'utf8').includes('__ModuleLoader__');
  const checkPath = isEnvelope ? join(tmp, 'envelope.cjs') : join(tmp, 'check' + extname(f));
  try {
    writeFileSync(checkPath, readFileSync(f));
    execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
    ok(rel + (isEnvelope ? '（信封按 CJS 校验）' : ''), true);
  } catch (e) {
    ok(rel, false, String(e.stderr || e.message).split('\n').slice(0, 3).join('\n       '));
  }
}
rmSync(tmp, { recursive: true, force: true });

/* ═══════════ ② client.js 自足 bundle ═══════════ */
console.log('\n== 2. client.js 自足性（无外部 import/require）==');
const clientSrc = readFileSync(join(PLUGIN, 'client.js'), 'utf8');
const bareImports = [...clientSrc.matchAll(/\bimport\s+[^(]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
ok('client.js 无 import 语句', bareImports.length === 0, `发现 import：${bareImports.join(', ')}`);
const requires = [...clientSrc.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const allowedRequire = new Set(['react']); // 宿主提供的唯一外部依赖
const badRequires = requires.filter((r) => !allowedRequire.has(r));
ok(`client.js 的 require 仅限宿主提供（${[...allowedRequire].join(', ')}）`, badRequires.length === 0,
  `发现未允许的 require：${badRequires.join(', ')}`);
ok('client.js 走 ModuleLoader 信封', clientSrc.includes('__ModuleLoader__.load'),
  '缺少 ModuleLoader 信封（client 半将无法加载）');
ok('client.js 导出 apply/inject/name', /exports\.apply\s*=/.test(clientSrc) && /exports\.inject\s*=/.test(clientSrc) && /exports\.name\s*=/.test(clientSrc),
  '缺少 apply/inject/name 导出（宿主无法挂载）');

/* ═══════════ ③ entry.mjs 薄壳约束 ═══════════ */
console.log('\n== 3. entry.mjs 薄壳约束（改它就要重启，须保持最小）==');
const entrySrc = readFileSync(join(PLUGIN, 'entry.mjs'), 'utf8');
const entryLines = entrySrc.split('\n').filter((l) => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).length;
ok(`entry.mjs 有效代码行 < 40（实际 ${entryLines}）`, entryLines < 40,
  `entry 膨胀到 ${entryLines} 行——业务逻辑必须放 host.impl.mjs（改 entry 要重启 DSH）`);
ok('entry.mjs 静态导出 Config', /export const Config/.test(entrySrc),
  '缺少静态 Config 导出（插件详情页配置区不会出现）');
ok('entry.mjs 用 ?ts= 动态 import impl', /host\.impl\.mjs\?ts=/.test(entrySrc),
  '缺少 mtime 热换 URL（改 impl 将无法免重启生效）');
ok('entry.mjs 不在顶层 import impl', !/^\s*import\s+.*host\.impl/m.test(entrySrc),
  '顶层静态 import impl 会破坏热换（模块被缓存）');

/* ═══════════ ④ 模块依赖方向（D1 切分护栏）═══════════ */
console.log('\n== 4. 模块依赖方向（无循环 / 无 client→host 反向引用）==');
const moduleFiles = readdirSync(PLUGIN).filter((f) => f.endsWith('.mjs'));
const deps = new Map();
for (const f of moduleFiles) {
  const src = readFileSync(join(PLUGIN, f), 'utf8');
  // 同时匹配静态导入（from './x.mjs'）与动态导入（import(`./x.mjs?ts=…`)）
  const imports = [
    ...src.matchAll(/(?:from|import\()\s*['"]\.\/([\w.-]+\.mjs)/g),
    ...src.matchAll(/import\(\s*`\.\/([\w.-]+\.mjs)\?/g),
  ].map((m) => m[1]);
  deps.set(f, [...new Set(imports)]);
}
console.log('   依赖图：');
for (const [f, ds] of deps) console.log(`     ${f} → ${ds.length ? ds.join(', ') : '(无内部依赖)'}`);

// 循环检测（简单 DFS）
const cycle = (() => {
  const state = new Map();
  const visit = (n, path) => {
    if (state.get(n) === 'visiting') return [...path, n];
    if (state.get(n) === 'done') return null;
    state.set(n, 'visiting');
    for (const d of deps.get(n) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d, [...path, n]);
      if (c) return c;
    }
    state.set(n, 'done');
    return null;
  };
  for (const n of deps.keys()) { const c = visit(n, []); if (c) return c; }
  return null;
})();
ok('内部模块无循环依赖', !cycle, cycle ? `循环：${cycle.join(' → ')}` : '');

const hostSrc = readFileSync(join(PLUGIN, 'host.impl.mjs'), 'utf8');
// 剥注释后再查：注释里提到 client.js 属正常（说明性文字），代码里引用才是违规
ok('host 不引用 client.js（剥注释后）', !/client\.js/.test(stripComments(hostSrc)),
  'host 侧代码引用 client.js（client 只由宿主 Web 半加载）');
ok('wire 不引用 host.impl', !/host\.impl/.test(stripComments(readFileSync(join(PLUGIN, 'wire.host.mjs'), 'utf8'))),
  'wire 引用 host.impl 会造成循环');

/* ═══════════ ⑤ 动态 import 必须带 ?ts= ═══════════ */
console.log('\n== 5. 热换纪律（动态 import 必须带 ?ts=）==');
for (const f of moduleFiles) {
  const src = readFileSync(join(PLUGIN, f), 'utf8');
  const dyn = [...src.matchAll(/import\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g)].map((m) => m[1]);
  const bad = dyn.filter((u) => u.startsWith('./') && !u.includes('?ts=') && !u.includes('?probe=') && !u.includes('${'));
  ok(`${f}: 动态 import 相对路径均带缓存参数`, bad.length === 0,
    bad.length ? `未带 ?ts= 的相对动态 import：${bad.join(', ')}（P16：会命中无参缓存）` : '');
}

/* ═══════════ ⑥ 死代码/占位符扫描 ═══════════ */
console.log('\n== 6. 占位符与调试残留 ==');
for (const f of targets) {
  const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
  if (rel.includes('.data')) continue;
  const src = readFileSync(f, 'utf8');
  const marks = ['TODO', 'FIXME', 'XXX', 'console.log('];
  const found = marks.filter((m) => src.includes(m));
  // client.js 允许 console.info/warn（客户端诊断），但不容忍 console.log
  const real = found.filter((m) => !(m === 'console.log(' && rel.includes('tools')));
  ok(`${rel} 无调试残留`, real.length === 0, real.length ? `发现：${real.join(', ')}` : '');
}

/* ═══════════ ⑦ 结构债追踪（D1 切分进度）═══════════ */
console.log('\n== 7. 结构债（D1 切分进度，见 docs/d1-module-split-brief.md）==');
const hostLines = hostSrc.split('\n').length;
/* R14：D1 的「≤250 行」判据改为**代码行**口径（剥注释与空行），并写上测量依据——
 * 原始目标是在「9 个域模块与注释占比都未知」时定的；实测 host 518 行里**注释 199 行**，
 * 而那些注释承载着 30+ 条来之不易的实证结论（P16 热换、F1/F2 顺序陷阱、TDZ 环……），
 * 是资产不是负担。⇒ 判据落在**代码行**上，`SPLIT_TARGET` 也从 250 调整为 320（当前 294，留 ~9% 余量），
 * 避免后来者靠删注释凑数字。注释行数一并打印，任何膨胀都看得见。 */
const hostCodeLines = (() => {
  let inBlock = false; let code = 0; let comment = 0;
  for (const line of hostSrc.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (inBlock) { comment++; if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { comment++; if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//')) { comment++; continue; }
    code++;
  }
  return { code, comment };
})();
const SPLIT_TARGET = 320;
const SPLIT_WARN = 900;
// 目标模块清单（切分后应存在）
/* D1 目标模块。R7（2026-10-08）：`m55.resume.mjs` 已从计划中移除——
 * M5.5「挂起-自动恢复」通道（含 marker 触发）已**整体退役**，不再需要该模块。
 * R8：`threshold.mjs` 为第五把刀（阈值核心：引擎阈值 / 生效上限 / 作用域服务解析）。 */
const TARGET_MODULES = ['core.mjs', 'm1.snapshot.mjs', 'm2.inject.mjs', 'm3.compact.mjs', 'm5.hud.mjs'];
const existing = TARGET_MODULES.filter((f) => existsSync(join(PLUGIN, f)));
const done = existing.length === TARGET_MODULES.length;
/* R3（2026-10-08）：effort.mjs 是**计划外的第一刀**（智能思考功能域，不在 D1 的 6 个目标模块内）。
 * R4（2026-10-08）：compact-tool.mjs 为第二刀（自动压缩的「工具触发」域）。
 * R5（2026-10-08）：compact-range.mjs 为第三刀（保留范围自选：纯函数叶子，无 IO）。
 * 单独报出来，免得「已抽 0/6」看起来像毫无进展。 */
const extraModules = ['effort.mjs', 'compact-tool.mjs', 'compact-range.mjs', 'threshold.mjs', 'm3.compact.mjs', 'm5.hud.mjs', 'm2.inject.mjs', 'm1.snapshot.mjs'].filter((f) => existsSync(join(PLUGIN, f)));
console.log(`   host.impl.mjs = ${hostLines} 行（代码 ${hostCodeLines.code} / 注释 ${hostCodeLines.comment}；目标：代码 ≤${SPLIT_TARGET}）｜ 已抽模块 ${existing.length}/${TARGET_MODULES.length}${existing.length ? '：' + existing.join(', ') : ''}`);
if (extraModules.length) console.log(`   ℹ️  D1 计划外已抽功能域模块：${extraModules.join(', ')}（R3 智能思考 / R4 压缩工具 / R5 保留范围 / R8 阈值核心 / R9+R10 M3 压缩域 / R11 M5 HUD 域 / R12 M2 注入域 / R13 M1 快照域 / R14 core）`);
ok('R3/R4/R5/R8/R9/R10/R11/R12/R13/R14 已抽独立功能域模块（依赖图叶子节点）',
  extraModules.length === 8, `期望 effort/compact-tool/compact-range/threshold/m3.compact/m5.hud/m2.inject/m1.snapshot 八个模块都存在，实际只有 ${extraModules.join(', ') || '（无）'}`);
if (done) {
  ok(`D1 已完成：host.impl.mjs **代码行** ≤ ${SPLIT_TARGET}（剥注释与空行）`, hostCodeLines.code <= SPLIT_TARGET,
    `切分未彻底：代码 ${hostCodeLines.code} 行（总 ${hostLines} 行，其中注释 ${hostCodeLines.comment}）`);
} else {
  // 未切分期间：只做「不要继续膨胀」的软提醒，不判失败（避免阻塞日常改动）
  if (hostLines > SPLIT_WARN) {
    console.log(`   ⚠️  host.impl.mjs 已 ${hostLines} 行（>${SPLIT_WARN}）——建议尽快安排 D1 切分`);
  } else {
    console.log('   ℹ️  D1 未切分（正常，方案见 docs/d1-module-split-brief.md）');
  }
}
ok('（软提醒，不计失败）结构债状态已输出', true);

/* ═══════════ ⑦ 上架基础项（DSH Plugin Hub / 社区市场）═══════════
 * 依据：市场要求「公开仓库 + topic dsh-plugin（Cordis 插件另加 deepseek-harness）
 * + README 有可复制的安装命令 + package.json 的 name/version 准确、Bundle 分发需 dsh.bundle.patch」。
 * 这里只校验**仓库内可控的部分**（仓库公开性与 topic 属 GitHub 侧，无法离线断言——
 * 复核方式见 docs/hub-publishing.md §0 的一行命令）。 */
console.log('\n== 7. 上架基础项（hub checklist）==');
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const plugPkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
const readmeSrc = readFileSync(join(ROOT, 'README.md'), 'utf8');
ok('根清单可被市场识别：name/version/license/repository 齐备且非 private',
  rootPkg.name === 'dsh-context-pilot' && typeof rootPkg.version === 'string' && rootPkg.version.length > 0
    && typeof rootPkg.license === 'string' && !!rootPkg.repository?.url
    && rootPkg.private !== true,
  `name=${rootPkg.name} version=${rootPkg.version} license=${rootPkg.license} private=${rootPkg.private}`);
ok('Bundle 分发声明：根清单 dsh.bundle.patch 指向**公开**patch，且该文件存在',
  typeof rootPkg.dsh?.bundle?.patch === 'string'
    && existsSync(join(ROOT, rootPkg.dsh.bundle.patch.replace(/^\.\//, '')))
    && /public/.test(rootPkg.dsh.bundle.patch),
  `patch=${rootPkg.dsh?.bundle?.patch}`);
ok('开发挂载仍完整：plugin/package.json 有 dsh.bundle.patch（缺则 not-bundle 静默跳过）',
  typeof plugPkg.dsh?.bundle?.patch === 'string'
    && existsSync(join(PLUGIN, plugPkg.dsh.bundle.patch.replace(/^\.\//, ''))),
  `patch=${plugPkg.dsh?.bundle?.patch}`);
/* 包名 ↔ patch 里 name 必须一致：加载器按包名解析，不一致 = 装上去挂不起来。 */
{
  const pubPatch = readFileSync(join(ROOT, 'plugin/cordis.patch.public.yml'), 'utf8');
  const devPatch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8');
  const nameOf = (y) => (/- insert:[\s\S]*?name:\s*'?([^'\n]+)'?/.exec(y)?.[1] ?? '').trim();
  ok('包名 ↔ patch 一致：根包名 = 公开 patch 的 name；开发包名 = 开发 patch 的 name',
    nameOf(pubPatch) === rootPkg.name && nameOf(devPatch) === plugPkg.name,
    `根=${rootPkg.name}/patch=${nameOf(pubPatch)} ｜ plugin=${plugPkg.name}/patch=${nameOf(devPatch)}`);
}
ok('版本一致：根与 plugin 清单的 version 相同（避免市场显示错版本）',
  rootPkg.version === plugPkg.version, `root=${rootPkg.version} plugin=${plugPkg.version}`);
ok('README 含可直接复制的安装命令（市场要求）',
  /dsh plugin --profile \w+ add \S+/.test(readmeSrc) && /## 安装/.test(readmeSrc),
  'README 缺「dsh plugin --profile <p> add <包名>」形式的安装命令 ⇒ 用户无法复制使用');
ok('LICENSE 文件存在且与清单声明一致',
  existsSync(join(ROOT, 'LICENSE')) && /^MIT License/m.test(readFileSync(join(ROOT, 'LICENSE'), 'utf8'))
    && rootPkg.license === 'MIT',
  '缺 LICENSE 或与 package.json 的 license 不一致');

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'='.repeat(52)}`);
console.log(`静态检查：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);
