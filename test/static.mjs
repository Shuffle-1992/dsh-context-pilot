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
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'='.repeat(52)}`);
console.log(`静态检查：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ' ✅'}`);
console.log('='.repeat(52));
process.exit(failures ? 1 : 0);
