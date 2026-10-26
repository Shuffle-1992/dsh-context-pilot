// C1 判分脚本：8 条硬约束逐条独立检查；确定性、幂等、只读
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failed = [];

function locate() {
  for (const rel of ['solution/tokenize.mjs', 'ref/tokenize.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const target = locate();
const KEEP_SHA = '1917d724612a7199';
const SAMPLE_JSON = '{"chars":25,"tokens":12,"cjk":5,"latin":3}';

function fail(n, detail) {
  failed.push(`CONSTRAINT_${n}_FAIL: ${detail}`);
}

function run(args) {
  const r = spawnSync(process.execPath, [target, ...args], { cwd: DIR, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let mod = null;
if (!target) {
  for (let n = 1; n <= 8; n++) fail(n, 'bench/tasks/C1/solution/tokenize.mjs not found');
  finish();
}
try {
  mod = await import(url.pathToFileURL(target).href);
} catch (e) {
  for (let n = 1; n <= 8; n++) fail(n, `import failed: ${e.message}`);
  finish();
}

const src = fs.readFileSync(target, 'utf8');

/* 约束 1：导出面 */
{
  const missing = [];
  if (typeof mod.countTokens !== 'function') missing.push('countTokens(function)');
  if (typeof mod.stats !== 'function') missing.push('stats(function)');
  if (mod.TOKEN_VERSION !== '1') missing.push(`TOKEN_VERSION==='1' (got ${JSON.stringify(mod.TOKEN_VERSION)})`);
  if (mod.E_INVALID_INPUT !== 'E_INVALID_INPUT') missing.push(`E_INVALID_INPUT (got ${JSON.stringify(mod.E_INVALID_INPUT)})`);
  if (missing.length) fail(1, `导出面不符: ${missing.join('; ')}`);
}

/* 约束 2：非字符串入参错误码 */
{
  const bad = [42, null, undefined, {}, [], true];
  const seen = [];
  for (const fnName of ['countTokens', 'stats']) {
    const fn = mod[fnName];
    if (typeof fn !== 'function') continue;
    for (const v of bad) {
      let err = null;
      try { fn(v); } catch (e) { err = e; }
      if (!err || err.code !== 'E_INVALID_INPUT') {
        seen.push(`${fnName}(${JSON.stringify(v) ?? String(v)}) -> ${err ? `code=${JSON.stringify(err.code)}` : 'no throw'}`);
      }
    }
  }
  if (seen.length) fail(2, `必须抛 err.code==='E_INVALID_INPUT': ${seen.slice(0, 4).join(' | ')}`);
}

/* 约束 3：stats 键顺序固定 */
{
  const cases = ['', 'a-b', '你好'];
  const seen = [];
  for (const t of cases) {
    let json = null;
    try { json = JSON.stringify(mod.stats(t)); } catch (e) { seen.push(`stats(${JSON.stringify(t)}) threw ${e.message}`); continue; }
    const keys = json ? Object.keys(mod.stats(t)).join(',') : '';
    if (keys !== 'chars,tokens,cjk,latin') seen.push(`键顺序=${keys || '(none)'}`);
    if (/:\s|,\s/.test(json)) seen.push(`输出非紧凑: ${json}`);
  }
  if (seen.length) fail(3, seen.join(' | '));
}

/* 约束 4：分词口径（内联用例） */
{
  const CASES = [
    ['', { chars: 0, tokens: 0, cjk: 0, latin: 0 }],
    ['a-b', { chars: 3, tokens: 3, cjk: 0, latin: 2 }],
    ['  \t\n  x', { chars: 7, tokens: 1, cjk: 0, latin: 1 }],
    ['你好你好', { chars: 4, tokens: 4, cjk: 4, latin: 0 }],
    ['あいう', { chars: 3, tokens: 3, cjk: 3, latin: 0 }],
    ['Ω 100 v2beta3', { chars: 13, tokens: 6, cjk: 0, latin: 2 }],
    ['v2beta3', { chars: 7, tokens: 4, cjk: 0, latin: 2 }],
    ['中文 abc123!', { chars: 10, tokens: 5, cjk: 2, latin: 1 }],
    ['😀', { chars: 1, tokens: 1, cjk: 0, latin: 0 }],
  ];
  const seen = [];
  for (const [text, want] of CASES) {
    let got = null;
    try { got = mod.stats(text); } catch (e) { seen.push(`${JSON.stringify(text)} threw ${e.message}`); continue; }
    for (const k of ['chars', 'tokens', 'cjk', 'latin']) {
      if (got[k] !== want[k]) seen.push(`${JSON.stringify(text)}.${k}=${String(got[k])} 期望 ${want[k]}`);
    }
    if (typeof mod.countTokens === 'function') {
      const n = mod.countTokens(text);
      if (n !== want.tokens) seen.push(`countTokens(${JSON.stringify(text)})=${String(n)} 期望 ${want.tokens}`);
    }
  }
  if (seen.length) fail(4, `分词口径不符: ${seen.slice(0, 6).join(' | ')}`);
}

/* 约束 5：CLI --json 对 fixture/sample.txt 的输出 */
{
  const r = run(['fixture/sample.txt', '--json']);
  if (r.status !== 0) fail(5, `退出码=${r.status}（期望 0），stderr=${JSON.stringify(r.stderr.split('\n')[0])}`);
  else if (r.stdout !== `${SAMPLE_JSON}\n`) fail(5, `stdout=${JSON.stringify(r.stdout)} 期望 ${JSON.stringify(`${SAMPLE_JSON}\n`)}`);
}

/* 约束 6：CLI 错误处理 */
{
  const seen = [];
  const a = run(['fixture/nope.txt']);
  if (a.status !== 2 || !a.stderr.split('\n')[0].startsWith('E_NOENT: ')) {
    seen.push(`缺文件: exit=${a.status} stderr=${JSON.stringify(a.stderr.split('\n')[0])}（期望 exit 2 且首行 E_NOENT: 开头）`);
  }
  for (const args of [[], ['--json'], ['--dry-run']]) {
    const r = run(args);
    if (r.status !== 1 || !r.stderr.split('\n')[0].startsWith('usage:')) {
      seen.push(`无文件参数 ${JSON.stringify(args)}: exit=${r.status} stderr=${JSON.stringify(r.stderr.split('\n')[0])}（期望 exit 1 且首行 usage: 开头）`);
    }
  }
  const c = run(['--bogus', 'fixture/sample.txt']);
  if (c.status !== 1 || !c.stderr.split('\n')[0].startsWith('E_BAD_ARG')) {
    seen.push(`未知旗标: exit=${c.status} stderr=${JSON.stringify(c.stderr.split('\n')[0])}（期望 exit 1 且首行 E_BAD_ARG 开头）`);
  }
  if (seen.length) fail(6, seen.join(' | '));
}

/* 约束 7：零依赖 + 每行 ≤ 100 */
{
  const seen = [];
  if (/require\s*\(/.test(src)) seen.push('出现 require(');
  const specs = [...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const s of specs) if (!s.startsWith('node:')) seen.push(`非 node: 说明符 ${JSON.stringify(s)}`);
  const lines = src.split('\n');
  let worst = 0;
  let worstAt = 0;
  lines.forEach((l, i) => { if (l.length > worst) { worst = l.length; worstAt = i + 1; } });
  if (worst > 100) seen.push(`第 ${worstAt} 行长度 ${worst} > 100`);
  if (seen.length) fail(7, seen.join(' | '));
}

/* 约束 8：--dry-run 不写盘 + fixture/keep.json 字节不变 */
{
  const probe = path.join(DIR, 'solution', '__dryrun_probe.json');
  const before = fs.existsSync(probe);
  const r = run(['fixture/sample.txt', '--out', probe, '--dry-run']);
  const seen = [];
  if (r.status !== 0) seen.push(`退出码=${r.status}`);
  const first = r.stdout.split('\n')[0];
  if (!first.startsWith('DRY-RUN ') || !first.includes(probe)) {
    seen.push(`首行=${JSON.stringify(first)}（期望以 "DRY-RUN " 开头且包含 out 路径）`);
  }
  if (fs.existsSync(probe) && !before) seen.push(`--dry-run 仍创建了文件 ${path.relative(DIR, probe)}`);
  const keep = path.join(DIR, 'fixture', 'keep.json');
  if (!fs.existsSync(keep)) seen.push('fixture/keep.json 被删除');
  else {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(keep)).digest('hex').slice(0, 16);
    if (sha !== KEEP_SHA) seen.push(`fixture/keep.json 已被修改 (sha=${sha})`);
  }
  if (seen.length) fail(8, seen.join(' | '));
}

function finish() {
  if (failed.length === 0) {
    console.log('C1 ALL_CONSTRAINTS_PASS (8/8)');
    console.log('omissions=0');
    process.exit(0);
  }
  for (const line of failed) console.log(line);
  console.log(`omissions=${failed.length}`);
  process.exit(1);
}

finish();
