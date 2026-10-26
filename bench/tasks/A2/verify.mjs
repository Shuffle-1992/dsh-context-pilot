// A2 判分脚本：确定性、幂等、只读
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failures = [];

function locate() {
  for (const rel of ['solution/diff.mjs', 'ref/diff.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const target = locate();
if (!target) {
  failures.push('CHECK_FAIL artifact_exists: bench/tasks/A2/solution/diff.mjs not found');
  report();
}

let mod = null;
try {
  mod = await import(url.pathToFileURL(target).href);
} catch (e) {
  failures.push(`CHECK_FAIL module_imports: ${e.message}`);
  report();
}

function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`CHECK_FAIL ${name}: ${e && e.message ? e.message.split('\n')[0] : e}`);
  }
}

// 判分自身的参考实现：LCS 长度 DP（O(n*m)，用例规模很小）
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

// 确定性伪随机行序列生成
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const { diffLines, applyDiff, diffStats } = mod;

check('exports_three_functions', () => {
  for (const [name, fn] of [['diffLines', diffLines], ['applyDiff', applyDiff], ['diffStats', diffStats]]) {
    assert.equal(typeof fn, 'function', `${name} must be an exported function`);
  }
});

check('identical_text_all_equal', () => {
  const t = 'a\nb\nc';
  const ops = diffLines(t, t);
  assert.deepEqual(ops.map((o) => `${o.op}:${o.line}`), ['equal:a', 'equal:b', 'equal:c']);
});

const EXACT = [
  {
    name: 'exact_replace_middle',
    old: 'a\nb\nc',
    new: 'a\nx\nc',
    want: 'equal:a|del:b|add:x|equal:c',
  },
  {
    name: 'exact_pure_append',
    old: 'a\nb',
    new: 'a\nb\nc',
    want: 'equal:a|equal:b|add:c',
  },
  {
    name: 'exact_pure_delete',
    old: 'x\na\ny',
    new: 'a',
    want: 'del:x|equal:a|del:y',
  },
  {
    name: 'exact_shift_common_b',
    old: 'a\nb',
    new: 'b\nc',
    want: 'del:a|equal:b|add:c',
  },
  {
    name: 'exact_empty_to_content',
    old: '',
    new: 'a\nb',
    want: 'del:|add:a|add:b',
  },
  {
    name: 'exact_replace_then_keep',
    old: 'a\nb\nc\nd',
    new: 'a\nX\nc\nd\nY',
    want: 'equal:a|del:b|add:X|equal:c|equal:d|add:Y',
  },
];

for (const c of EXACT) {
  check(c.name, () => {
    const ops = diffLines(c.old, c.new);
    const got = ops.map((o) => `${o.op}:${o.line}`).join('|');
    assert.equal(got, c.want);
  });
}

check('del_before_add_at_same_hunk', () => {
  const ops = diffLines('a\nb\nc', 'a\nx\ny\nc');
  const idxDel = ops.findIndex((o) => o.op === 'del');
  const idxAdd = ops.findIndex((o) => o.op === 'add');
  assert.ok(idxDel !== -1 && idxAdd !== -1);
  assert.ok(idxDel < idxAdd, 'a replacement hunk must emit all del ops before its add ops');
});

check('trailing_newline_is_significant', () => {
  const ops = diffLines('a\n', 'a');
  assert.ok(ops.some((o) => o.op !== 'equal'), "must not treat 'a\\n' and 'a' as identical");
  assert.deepEqual(ops.map((o) => `${o.op}:${o.line}`), ['equal:a', 'del:']);
});

const PAIRS = [];
{
  const rnd = lcg(20261026);
  const alphabet = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'];
  for (let i = 0; i < 25; i++) {
    const pick = () => alphabet[Math.floor(rnd() * alphabet.length)];
    const n1 = 1 + Math.floor(rnd() * 9);
    const n2 = 1 + Math.floor(rnd() * 9);
    const l1 = Array.from({ length: n1 }, pick);
    let l2 = Array.from({ length: n2 }, pick);
    if (i % 3 === 0) l2 = l1.slice();
    if (i % 5 === 0) l2 = l1.map((s) => (rnd() > 0.5 ? s + '!' : s));
    PAIRS.push([l1.join('\n'), l2.join('\n')]);
  }
  PAIRS.push(['', '']);
  PAIRS.push(['', 'x\ny']);
  PAIRS.push(['x\ny', '']);
  PAIRS.push(['a\na\na\na', 'a\na']);
  PAIRS.push(['dup\nu\ndup\nu\ndup', 'u\ndup\nu']);
}

check('structural_invariants_all_pairs', () => {
  for (const [o, n] of PAIRS) {
    const ops = diffLines(o, n);
    const oldLines = o.split('\n');
    const newLines = n.split('\n');
    assert.deepEqual(ops.filter((x) => x.op !== 'add').map((x) => x.line), oldLines, `old side mismatch for ${JSON.stringify(o)}`);
    assert.deepEqual(ops.filter((x) => x.op !== 'del').map((x) => x.line), newLines, `new side mismatch for ${JSON.stringify(n)}`);
  }
});

check('minimal_edit_script_all_pairs', () => {
  for (const [o, n] of PAIRS) {
    const ops = diffLines(o, n);
    const oldLines = o.split('\n');
    const newLines = n.split('\n');
    const lcs = lcsLength(oldLines, newLines);
    const stat = diffStats(ops);
    const eq = ops.filter((x) => x.op === 'equal').length;
    const label = `old=${JSON.stringify(o)} new=${JSON.stringify(n)}`;
    assert.equal(eq, lcs, `equal count must equal LCS length (${label}): got ${eq} want ${lcs}`);
    assert.equal(stat.removed, oldLines.length - lcs, `removed count (${label})`);
    assert.equal(stat.added, newLines.length - lcs, `added count (${label})`);
    assert.equal(stat.equal, lcs, `diffStats.equal (${label})`);
    assert.equal(ops.length, oldLines.length + newLines.length - lcs, `op count (${label})`);
  }
});

check('apply_diff_roundtrip_all_pairs', () => {
  for (const [o, n] of PAIRS) {
    assert.equal(applyDiff(o, diffLines(o, n)), n, `roundtrip failed for old=${JSON.stringify(o)}`);
  }
});

check('diffstats_key_order_and_shape', () => {
  const s = diffStats(diffLines('a\nb', 'b\nc'));
  assert.deepEqual(Object.keys(s), ['added', 'removed', 'equal']);
  assert.deepEqual(s, { added: 1, removed: 1, equal: 1 });
});

check('deterministic_repeat', () => {
  for (const [o, n] of PAIRS.slice(0, 10)) {
    assert.deepEqual(diffLines(o, n), diffLines(o, n), 'repeated calls must be identical');
  }
});

check('type_errors', () => {
  assert.throws(() => diffLines(null, 'a'), TypeError);
  assert.throws(() => diffLines('a', 42), TypeError);
  assert.throws(() => applyDiff('a', [{ op: 'replace', line: 'x' }]), TypeError, 'unknown op must throw TypeError');
  assert.throws(() => applyDiff(['a'], []), TypeError);
});

check('builtin_imports_only', () => {
  const src = fs.readFileSync(target, 'utf8');
  const specs = [...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const s of specs) assert.ok(s.startsWith('node:'), `non-builtin import: ${s}`);
});

function report() {
  if (failures.length === 0) {
    console.log('A2 OK: all checks passed');
    process.exit(0);
  }
  for (const f of failures) console.log(f);
  console.log(`failures=${failures.length}`);
  process.exit(1);
}

report();
