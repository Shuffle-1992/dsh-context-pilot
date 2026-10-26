// C4 判分脚本：8 条硬约束逐条独立检查；确定性、幂等、只读
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failed = [];
const KEEP_SHA = '1917d724612a7199';

function locate() {
  for (const rel of ['solution/csv.mjs', 'ref/csv.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fail(n, detail) {
  failed.push(`CONSTRAINT_${n}_FAIL: ${detail}`);
}

function run(args) {
  const r = spawnSync(process.execPath, [target, ...args], { cwd: DIR, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const target = locate();
if (!target) {
  for (let n = 1; n <= 8; n++) fail(n, 'bench/tasks/C4/solution/csv.mjs not found');
  finish();
}

let mod = null;
try {
  mod = await import(url.pathToFileURL(target).href);
} catch (e) {
  for (let n = 1, total = 8; n <= total; n++) fail(n, `import failed: ${e.message}`);
  finish();
}

const src = fs.readFileSync(target, 'utf8');
const { parseCSV, toCSV, parseRecords } = mod;

function codeOf(fn) {
  try {
    return { thrown: false, value: fn() };
  } catch (e) {
    return { thrown: true, code: e && e.code };
  }
}

function callParse(text) {
  const r = codeOf(() => parseCSV(text));
  if (r.thrown) return `抛出 code=${String(r.code)}`;
  return r.value;
}

function show(v) {
  return JSON.stringify(v);
}

/* 约束 1：导出面 */
{
  const seen = [];
  for (const [name, fn] of [['parseCSV', parseCSV], ['toCSV', toCSV], ['parseRecords', parseRecords]]) {
    if (typeof fn !== 'function') seen.push(`${name} 必须是函数`);
  }
  if (seen.length) fail(1, seen.join('; '));
}

/* 约束 2：解析规则 */
{
  const CASES = [
    ['a,b\nc,d', [['a', 'b'], ['c', 'd']]],
    ['"a","b"\n"c,d",e', [['a', 'b'], ['c,d', 'e']]],
    ['x,"y""z",w', [['x', 'y"z', 'w']]],
    ['"line1\nline2",b', [['line1\nline2', 'b']]],
    ['"a"\n"b"', [['a'], ['b']]],
    ['a,,b', [['a', '', 'b']]],
    ['é,日本', [['é', '日本']]],
    ['"  spaced  "', [['  spaced  ']]],
    ['a,"multi\r\nwin",b', [['a', 'multi\r\nwin', 'b']]],
    ['name,note,value\r\n"DSH","上下文,压缩",1\r\n"multi\r\nline","x",2\r\n"quoted""q",y,3\r\n', [
      ['name', 'note', 'value'],
      ['DSH', '上下文,压缩', '1'],
      ['multi\r\nline', 'x', '2'],
      ['quoted"q', 'y', '3'],
    ]],
  ];
  const seen = [];
  for (const [text, want] of CASES) {
    const got = callParse(text);
    if (typeof got === 'string') seen.push(`${show(text)} -> ${got}`);
    else if (show(got) !== show(want)) seen.push(`${show(text)} -> got=${show(got)} want=${show(want)}`);
  }
  const fixtureText = fs.readFileSync(path.join(DIR, 'fixture', 'data.csv'), 'utf8');
  const gotFixture = callParse(fixtureText);
  if (typeof gotFixture === 'string') seen.push(`fixture/data.csv -> ${gotFixture}`);
  else if (show(gotFixture) !== show(CASES[CASES.length - 1][1])) seen.push(`fixture/data.csv got=${show(gotFixture)}`);
  if (seen.length) fail(2, seen.slice(0, 4).join(' | '));
}

/* 约束 3：边界 */
{
  const seen = [];
  const bom = callParse('a,b\r\nc,d\r\n');
  if (show(bom) !== show([['a', 'b'], ['c', 'd']])) seen.push(`BOM: got=${show(bom)}`);
  const lf = callParse('a,b\nc,d');
  const crlf = callParse('a,b\r\nc,d');
  if (show(lf) !== show(crlf)) seen.push(`CRLF 与 LF 不等价: ${show(lf)} vs ${show(crlf)}`);
  for (const [text, want] of [
    ['', []],
    ['\n', [['']] ],
    ['\r\n', [[''] ]],
    ['a,b\n', [['a', 'b']]],
    ['a,b\r\n', [['a', 'b']]],
    ['solo', [['solo']]],
    ['a,b\n\n', [['a', 'b'], ['']]],
    ['"x"', [['x']]],
  ]) {
    const got = callParse(text);
    if (typeof got === 'string') seen.push(`${show(text)} -> ${got}`);
    else if (show(got) !== show(want)) seen.push(`${show(text)} -> got=${show(got)} want=${show(want)}`);
  }
  const lone = callParse('a\rb');
  if (typeof lone === 'string') seen.push(`单独 \\r 不得作为终止符: ${lone}`);
  else if (show(lone) !== show([['a\rb']])) seen.push(`单独 \\r: got=${show(lone)} want=${show([['a\rb']])}`);
  if (seen.length) fail(3, seen.slice(0, 4).join(' | '));
}

/* 约束 4：往返不变量 */
{
  const ROWS = [
    [['a', 'b'], ['c,d', 'e"f']],
    [['multi\nline', 'x'], ['', '']],
    [['tab\tfield', ' lead'], ['trail ', 'end']],
    [['é中文', '1'], ['-0.0', 'true']],
    [['a\r\nb', 'c']],
    [['normal'], ['with,comma'], ['with"quote'], [' with-space'], ['with\ttab']],
    [[',,,'], ['"""']],
  ];
  const seen = [];
  for (const rows of ROWS) {
    let text;
    const made = codeOf(() => toCSV(rows));
    if (made.thrown) {
      seen.push(`toCSV(${show(rows)}) 抛出 code=${String(made.code)}`);
      continue;
    }
    text = made.value;
    const back = callParse(text);
    if (typeof back === 'string') seen.push(`parseCSV(toCSV(${show(rows)})) -> ${back}`);
    else if (show(back) !== show(rows)) seen.push(`往返不一致: in=${show(rows)} out=${show(back)} csv=${show(text)}`);
  }
  if (seen.length) fail(4, seen.slice(0, 3).join(' | '));
}

/* 约束 5：toCSV 精确字节 + 非法输入错误码 */
{
  const seen = [];
  const CASES = [
    [[['a', 'b c', 'd,e']], 'a,b c,"d,e"\r\n'],
    [[['x"y', ' z', 'z ']], '"x""y"," z","z "\r\n'],
    [[['']], '\r\n'],
    [[['h1', 'h2'], ['a', 'b']], 'h1,h2\r\na,b\r\n'],
    [[[''], [null, undefined, 1, true]], '\r\n,,1,true\r\n'],
    [[['\n', '\r']], '"\n' + '","' + '\r"\r\n'],
    [[['', 'a,b']], ',"a,b"\r\n'],
  ];
  for (const [rows, want] of CASES) {
    const r = codeOf(() => toCSV(rows));
    if (r.thrown) seen.push(`toCSV(${show(rows)}) 抛出 code=${String(r.code)}`);
    else if (r.value !== want) seen.push(`toCSV(${show(rows)}) got=${show(r.value)} want=${show(want)}`);
  }
  const badRows = [null, {}, 'x', [['a'], 'b'], 42];
  for (const rows of badRows) {
    const r = codeOf(() => toCSV(rows));
    if (!r.thrown || r.code !== 'E_INVALID_ROW') seen.push(`非法行 ${show(rows)} -> thrown=${r.thrown} code=${String(r.code)}（期望 E_INVALID_ROW）`);
  }
  const badValues = [
    [[{}]],
    [[[]]],
    [[Symbol('s')]],
    [[() => 1]],
  ];
  for (const rows of badValues) {
    const r = codeOf(() => toCSV(rows));
    if (!r.thrown || r.code !== 'E_INVALID_VALUE') seen.push(`非法值 ${show(String(rows[0][0]))} -> thrown=${r.thrown} code=${String(r.code)}（期望 E_INVALID_VALUE）`);
  }
  if (seen.length) fail(5, seen.slice(0, 4).join(' | '));
}

/* 约束 6：错误码逐一命中 */
{
  const seen = [];
  const CASES = [
    ['E_INVALID_INPUT (parseCSV 非字符串)', () => parseCSV(42), 'E_INVALID_INPUT'],
    ['E_INVALID_INPUT (parseCSV null)', () => parseCSV(null), 'E_INVALID_INPUT'],
    ['E_UNTERMINATED_QUOTE', () => parseCSV('a,"b'), 'E_UNTERMINATED_QUOTE'],
    ['E_UNTERMINATED_QUOTE (跨行)', () => parseCSV('a,"b\nc'), 'E_UNTERMINATED_QUOTE'],
    ['E_RAGGED_ROW', () => parseRecords('a,b\n1'), 'E_RAGGED_ROW'],
    ['E_RAGGED_ROW (多列)', () => parseRecords('a,b\n1,2,3\n'), 'E_RAGGED_ROW'],
    ['E_DUPLICATE_HEADER', () => parseRecords('a,a\n1,2'), 'E_DUPLICATE_HEADER'],
    ['E_DUPLICATE_HEADER (空名重复)', () => parseRecords('"",\n1,2'), 'E_DUPLICATE_HEADER'],
  ];
  for (const [label, fn, want] of CASES) {
    const r = codeOf(fn);
    if (!r.thrown || r.code !== want) seen.push(`${label}: thrown=${r.thrown} code=${String(r.code)}（期望 ${want}）`);
  }
  if (seen.length) fail(6, seen.join(' | '));
}

/* 约束 7：parseRecords */
{
  const seen = [];
  const text = 'id,name,note\r\n1,a,\r\n2,"b,c",x\r\n';
  const r = codeOf(() => parseRecords(text));
  if (r.thrown) seen.push(`抛出 code=${String(r.code)}`);
  else {
    const want = [{ id: '1', name: 'a', note: '' }, { id: '2', name: 'b,c', note: 'x' }];
    if (show(r.value) !== show(want)) seen.push(`got=${show(r.value)} want=${show(want)}`);
    for (const rec of r.value) {
      if (Object.keys(rec).join(',') !== 'id,name,note') seen.push(`键顺序=${Object.keys(rec).join(',')}`);
    }
  }
  const headerOnly = codeOf(() => parseRecords('a,b,c\n'));
  if (headerOnly.thrown) seen.push(`仅表头不得抛错 (code=${String(headerOnly.code)})`);
  else if (show(headerOnly.value) !== show([])) seen.push(`仅表头 got=${show(headerOnly.value)}`);
  const empty = codeOf(() => parseRecords(''));
  if (empty.thrown) seen.push(`空文本不得抛错 (code=${String(empty.code)})`);
  else if (show(empty.value) !== show([])) seen.push(`空文本 got=${show(empty.value)}`);
  if (seen.length) fail(7, seen.join(' | '));
}

/* 约束 8：工程约束 + CLI --dry-run 不写盘 + keep.json 不变 */
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
  const probe = path.join(DIR, 'solution', '__dryrun_probe.csv');
  const existedBefore = fs.existsSync(probe);
  const dry = run(['fixture/data.csv', '--out', probe, '--dry-run']);
  if (dry.status !== 0) seen.push(`--dry-run 退出码=${dry.status} stderr=${show(dry.stderr.split('\n')[0])}`);
  const firstLine = dry.stdout.split('\n')[0];
  if (!firstLine.startsWith('DRY-RUN ') || !firstLine.includes(probe)) seen.push(`--dry-run 首行=${show(firstLine)}`);
  if (fs.existsSync(probe) && !existedBefore) seen.push(`--dry-run 仍创建了 ${path.relative(DIR, probe)}`);
  const plain = run(['fixture/data.csv']);
  if (plain.status !== 0 || plain.stdout !== '{"rows":4,"cols":3}\n') {
    seen.push(`CLI stdout=${show(plain.stdout)} exit=${plain.status}（期望 {"rows":4,"cols":3}\\n 且退出 0）`);
  }
  const noent = run(['fixture/nope.csv']);
  if (noent.status !== 2 || !noent.stderr.split('\n')[0].startsWith('E_NOENT: ')) seen.push(`缺文件 exit=${noent.status} stderr=${show(noent.stderr.split('\n')[0])}`);
  const usage = run([]);
  if (usage.status !== 1 || !usage.stderr.split('\n')[0].startsWith('usage:')) seen.push(`无参数 exit=${usage.status} stderr=${show(usage.stderr.split('\n')[0])}`);
  const badArg = run(['--nope', 'fixture/data.csv']);
  if (badArg.status !== 1 || !badArg.stderr.split('\n')[0].startsWith('E_BAD_ARG')) seen.push(`未知旗标 exit=${badArg.status} stderr=${show(badArg.stderr.split('\n')[0])}`);
  if (seen.length) fail(8, seen.slice(0, 5).join(' | '));
}

function finish() {
  if (failed.length === 0) {
    console.log('C4 ALL_CONSTRAINTS_PASS (8/8)');
    console.log('omissions=0');
    process.exit(0);
  }
  for (const line of failed) console.log(line);
  console.log(`omissions=${failed.length}`);
  process.exit(1);
}

finish();
