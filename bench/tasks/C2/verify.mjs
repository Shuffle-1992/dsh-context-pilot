// C2 判分脚本：8 条硬约束逐条独立检查；确定性、幂等、只读
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failed = [];

function locate() {
  for (const rel of ['solution/stable.mjs', 'ref/stable.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const KEEP_SHA = '1917d724612a7199';
function fail(n, detail) {
  failed.push(`CONSTRAINT_${n}_FAIL: ${detail}`);
}

const target = locate();
if (!target) {
  for (let n = 1; n <= 8; n++) fail(n, 'bench/tasks/C2/solution/stable.mjs not found');
  finish();
}

let mod = null;
try {
  mod = await import(url.pathToFileURL(target).href);
} catch (e) {
  for (let n = 1; n <= 8; n++) fail(n, `import failed: ${e.message}`);
  finish();
}

const src = fs.readFileSync(target, 'utf8');
const F = mod.stableStringify;
const call = (v, o) => (typeof F === 'function' ? F(v, o) : '<no stableStringify>');

function codeOf(fn) {
  try {
    fn();
    return { thrown: false };
  } catch (e) {
    return { thrown: true, code: e && e.code };
  }
}

/* 约束 1：导出面 */
{
  const missing = [];
  if (typeof F !== 'function') missing.push('stableStringify(function)');
  if (mod.STABLE_VERSION !== '2') missing.push(`STABLE_VERSION==='2' (got ${JSON.stringify(mod.STABLE_VERSION)})`);
  if (missing.length) fail(1, `导出面不符: ${missing.join('; ')}`);
}

/* 约束 2：键序 UTF-16 码元升序 */
{
  const CASES = [
    [{ b: 1, A: 2, 10: 3, 9: 4, a: 5, '#': 6, 'é': 7, z: 8 },
      '{"#":6,"10":3,"9":4,"A":2,"a":5,"b":1,"z":8,"é":7}'],
    [{ arr: [{ z: 1, a: 2 }, { b: [{ d: 1, c: 2 }] }], top: 0 },
      '{"arr":[{"a":2,"z":1},{"b":[{"c":2,"d":1}]}],"top":0}'],
    [[3, 1, 2], '[3,1,2]'],
    [['b', 'a'], '["b","a"]'],
    [{}, '{}'],
    [[], '[]'],
  ];
  const seen = [];
  for (const [input, want] of CASES) {
    let got;
    try { got = call(input); } catch (e) { seen.push(`抛出 ${e.message}`); continue; }
    if (got !== want) seen.push(`got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
  if (seen.length) fail(2, `键序/数组序不符: ${seen.join(' | ')}`);
}

/* 约束 3：indent 排版 */
{
  const CASES = [
    [{ b: [1, { d: 2, c: 3 }], a: 'x' }, 2,
      '{\n  "a": "x",\n  "b": [\n    1,\n    {\n      "c": 3,\n      "d": 2\n    }\n  ]\n}'],
    [{ a: {}, b: [] }, 4, '{\n    "a": {},\n    "b": []\n}'],
    [{ b: 1, a: [1, 2] }, 0, '{"a":[1,2],"b":1}'],
    [{ a: [{}] }, 1, '{\n "a": [\n  {}\n ]\n}'],
  ];
  const seen = [];
  for (const [input, indent, want] of CASES) {
    let got;
    try { got = call(input, { indent }); } catch (e) { seen.push(`indent=${indent} 抛出 ${e.message}`); continue; }
    if (got !== want) seen.push(`indent=${indent} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
  if (seen.length) fail(3, `排版不符: ${seen.join(' | ')}`);
}

/* 约束 4：E_CYCLE + 共享引用不误判 */
{
  const seen = [];
  const o = {};
  o.self = o;
  let r = codeOf(() => call(o));
  if (!r.thrown || r.code !== 'E_CYCLE') seen.push(`对象环: thrown=${r.thrown} code=${String(r.code)}`);

  const arr = [1];
  arr.push(arr);
  r = codeOf(() => call(arr));
  if (!r.thrown || r.code !== 'E_CYCLE') seen.push(`数组环: thrown=${r.thrown} code=${String(r.code)}`);

  const deep = { a: { b: {} } };
  deep.a.b.back = deep.a;
  r = codeOf(() => call(deep));
  if (!r.thrown || r.code !== 'E_CYCLE') seen.push(`深层环: thrown=${r.thrown} code=${String(r.code)}`);

  const shared = { k: 1 };
  r = codeOf(() => call({ a: shared, b: shared }));
  if (r.thrown) seen.push(`同一对象出现在两个分支被误判为环 (code=${String(r.code)})`);
  else if (call({ a: shared, b: shared }) !== '{"a":{"k":1},"b":{"k":1}}') seen.push('共享引用输出不正确');

  const dagArr = [shared, { n: shared }];
  r = codeOf(() => call(dagArr));
  if (r.thrown) seen.push('数组内共享引用被误判为环');
  if (seen.length) fail(4, seen.join(' | '));
}

/* 约束 5：E_NON_FINITE_NUMBER */
{
  const seen = [];
  const CASES = [
    ['顶层 NaN', NaN],
    ['对象内 Infinity', { a: Infinity }],
    ['数组内 -Infinity', [1, -Infinity]],
    ['深层 NaN', { x: { y: [NaN] } }],
  ];
  for (const [label, v] of CASES) {
    const r = codeOf(() => call(v));
    if (!r.thrown || r.code !== 'E_NON_FINITE_NUMBER') seen.push(`${label}: thrown=${r.thrown} code=${String(r.code)}`);
  }
  const ok = codeOf(() => call({ a: 0, b: -0.5, c: 1e308 }));
  if (ok.thrown) seen.push(`有限数字被误抛 (code=${String(ok.code)})`);
  if (seen.length) fail(5, seen.join(' | '));
}

/* 约束 6：值语义 */
{
  const seen = [];
  const want = [
    ['undefined 顶层', () => call(undefined), undefined, true],
    ['函数顶层', () => call(() => 1), undefined, true],
    ['对象剔除 undefined/函数键', () => call({ a: undefined, f: () => 1, b: 1 }), '{"b":1}'],
    ['数组 undefined/函数 -> null', () => call([undefined, () => 1, 1]), '[null,null,1]'],
    ['Date -> ISO', () => call(new Date(Date.UTC(2020, 0, 1))), '"2020-01-01T00:00:00.000Z"'],
    ['Date 嵌套', () => call({ at: new Date(Date.UTC(1999, 11, 31, 23, 59, 59)) }), '{"at":"1999-12-31T23:59:59.000Z"}'],
    ['BigInt 嵌套', () => call({ n: 10n }), '{"n":"10"}'],
    ['BigInt 顶层', () => call(42n), '"42"'],
    ['toJSON', () => call({ hidden: 1, toJSON() { return { ok: true }; } }), '{"ok":true}'],
    ['toJSON 在数组内', () => call([{ toJSON() { return [1, 2]; } }]), '[[1,2]]'],
    ['null 保留', () => call({ a: null, b: false, c: 0, d: '' }), '{"a":null,"b":false,"c":0,"d":""}'],
    ['布尔/数字原样', () => call([true, false, -0.5, 7]), '[true,false,-0.5,7]'],
  ];
  for (const [label, fn, w, isUndefined] of want) {
    let got;
    try { got = fn(); } catch (e) { seen.push(`${label} 抛出 ${e.message}`); continue; }
    if (isUndefined ? got !== undefined : got !== w) seen.push(`${label}: got=${JSON.stringify(got)} want=${JSON.stringify(w)}`);
  }
  const esc = 'a"b\nc\\d\te\u0001f';
  let got;
  try { got = call(esc); } catch (e) { seen.push(`字符串转义抛出 ${e.message}`); }
  if (got !== undefined && got !== JSON.stringify(esc)) seen.push(`字符串转义: got=${JSON.stringify(got)} want=${JSON.stringify(JSON.stringify(esc))}`);
  if (seen.length) fail(6, seen.join(' | '));
}

/* 约束 7：纯函数 + 确定性 + 可解析 */
{
  const seen = [];
  const input = { b: [1, { z: 1, a: { deep: [3, 2] } }], a: 'x', c: [null, 0] };
  const before = JSON.stringify(input);
  let first;
  let second;
  try {
    first = call(input, { indent: 2 });
    second = call(input, { indent: 2 });
  } catch (e) {
    seen.push(`抛出 ${e.message}`);
  }
  if (first !== undefined) {
    if (first !== second) seen.push('两次调用结果不一致');
    if (JSON.stringify(input) !== before) seen.push(`入参被修改: ${JSON.stringify(input)}`);
    try {
      JSON.parse(first);
    } catch (e) {
      seen.push(`输出无法 JSON.parse: ${e.message}`);
    }
  }
  const frozenProbe = Object.freeze({ a: Object.freeze([1, 2]) });
  try {
    call(frozenProbe);
  } catch (e) {
    seen.push(`冻结入参不应抛错: ${e.message}`);
  }
  if (seen.length) fail(7, seen.join(' | '));
}

/* 约束 8：工程约束 */
{
  const seen = [];
  if (/require\s*\(/.test(src)) seen.push('出现 require(');
  for (const m of src.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith('node:')) seen.push(`非 node: 说明符 ${JSON.stringify(m[1])}`);
  }
  let worst = 0;
  let at = 0;
  src.split('\n').forEach((l, i) => { if (l.length > worst) { worst = l.length; at = i + 1; } });
  if (worst > 100) seen.push(`第 ${at} 行长度 ${worst} > 100`);
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
    console.log('C2 ALL_CONSTRAINTS_PASS (8/8)');
    console.log('omissions=0');
    process.exit(0);
  }
  for (const line of failed) console.log(line);
  console.log(`omissions=${failed.length}`);
  process.exit(1);
}

finish();
