// A4 判分脚本：确定性、幂等、只读（只执行被测 CLI，不写任何文件）
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failures = [];

function locate() {
  for (const rel of ['solution/wordstat.mjs', 'ref/wordstat.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const target = locate();
if (!target) {
  failures.push('CHECK_FAIL artifact_exists: bench/tasks/A4/solution/wordstat.mjs not found');
  report();
}

function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`CHECK_FAIL ${name}: ${e && e.message ? e.message.split('\n')[0] : e}`);
  }
}

const EXPECT = {
  'fixture/one.txt': { lines: 2, words: 4, bytes: 24 },
  'fixture/two.txt': { lines: 2, words: 4, bytes: 20 },
  'fixture/three.txt': { lines: 2, words: 4, bytes: 23 },
  'fixture/empty.txt': { lines: 0, words: 0, bytes: 0 },
};

function run(args) {
  const r = spawnSync(process.execPath, [target, ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const fixtureDigest = Object.keys(EXPECT).map((f) => `${f}:${fs.statSync(path.join(DIR, f)).size}`).join('|');

check('plain_output_exact_two_files', () => {
  const r = run(['fixture/one.txt', 'fixture/two.txt']);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr.trim()}`);
  const want = [
    'fixture/one.txt\tlines=2\twords=4\tbytes=24',
    'fixture/two.txt\tlines=2\twords=4\tbytes=20',
    'TOTAL\tlines=4\twords=8\tbytes=44',
  ].join('\n') + '\n';
  assert.equal(r.stdout, want);
});

check('argv_order_preserved_and_reversed', () => {
  const r = run(['fixture/two.txt', 'fixture/empty.txt', 'fixture/one.txt']);
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n');
  assert.deepEqual(lines.slice(0, 3).map((l) => l.split('\t')[0]), ['fixture/two.txt', 'fixture/empty.txt', 'fixture/one.txt']);
  assert.equal(lines[3], 'TOTAL\tlines=4\twords=8\tbytes=44');
  assert.equal(lines[4], '');
});

check('empty_file_counts_zero', () => {
  const r = run(['fixture/empty.txt']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'fixture/empty.txt\tlines=0\twords=0\tbytes=0\nTOTAL\tlines=0\twords=0\tbytes=0\n');
});

check('crlf_unicode_and_byte_count', () => {
  const a = run(['fixture/two.txt']);
  assert.equal(a.stdout.split('\n')[0], 'fixture/two.txt\tlines=2\twords=4\tbytes=20', 'CRLF must not inflate words/lines');
  const b = run(['fixture/three.txt']);
  assert.equal(b.stdout.split('\n')[0], 'fixture/three.txt\tlines=2\twords=4\tbytes=23', 'bytes must be byte length, not char length');
});

check('duplicate_paths_deduped_first_position', () => {
  const r = run(['fixture/one.txt', 'fixture/two.txt', 'fixture/one.txt']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.split('\n').slice(0, 3), [
    'fixture/one.txt\tlines=2\twords=4\tbytes=24',
    'fixture/two.txt\tlines=2\twords=4\tbytes=20',
    'TOTAL\tlines=4\twords=8\tbytes=44',
  ]);
});

check('json_mode_shape_and_values', () => {
  const r = run(['--json', 'fixture/one.txt', 'fixture/two.txt', 'fixture/three.txt', 'fixture/empty.txt']);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr.trim()}`);
  assert.ok(r.stdout.endsWith('\n') && !r.stdout.slice(0, -1).includes('\n'), '--json must print exactly one line');
  const text = r.stdout.slice(0, -1);
  for (const k of Object.keys(EXPECT)) assert.ok(text.includes(`"path":"${k}"`), `missing entry for ${k}`);
  const obj = JSON.parse(text);
  assert.deepEqual(Object.keys(obj), ['files', 'totals']);
  assert.deepEqual(Object.keys(obj.totals), ['files', 'lines', 'words', 'bytes']);
  for (const entry of obj.files) {
    assert.deepEqual(Object.keys(entry), ['path', 'lines', 'words', 'bytes']);
    const want = EXPECT[entry.path];
    assert.deepEqual({ lines: entry.lines, words: entry.words, bytes: entry.bytes }, want, `wrong stats for ${entry.path}`);
  }
  assert.deepEqual(obj.totals, { files: 4, lines: 6, words: 12, bytes: 67 });
});

check('json_key_order_is_literal', () => {
  const r = run(['fixture/one.txt', '--json']);
  const want = '{"files":[{"path":"fixture/one.txt","lines":2,"words":4,"bytes":24}],'
    + '"totals":{"files":1,"lines":2,"words":4,"bytes":24}}\n';
  assert.equal(r.stdout, want);
});

check('utf8_no_bom_and_unicode_path_echo', () => {
  for (const args of [['fixture/three.txt'], ['--json', 'fixture/three.txt'], ['fixture/ünïcøde.txt']]) {
    const r = spawnSync(process.execPath, [target, ...args], { cwd: DIR, timeout: 30000 });
    assert.equal(r.status, 0, `exit=${r.status}`);
    const out = Buffer.from(r.stdout);
    assert.ok(!(out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf), 'stdout must not start with a UTF-8 BOM');
    assert.equal(out.toString('utf8').includes('fixture/'), true, 'stdout must decode as UTF-8');
  }
  const uni = run(['fixture/ünïcøde.txt']);
  assert.equal(uni.stdout.split('\n')[0], 'fixture/ünïcøde.txt\tlines=2\twords=3\tbytes=6', 'unicode path must be echoed verbatim');
  const js = run(['--json', 'fixture/ünïcøde.txt']);
  assert.equal(JSON.parse(js.stdout).files[0].path, 'fixture/ünïcøde.txt');
});

check('missing_file_exit_2_E_NOENT', () => {
  const r = run(['fixture/nope.txt']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.split('\n')[0].startsWith('E_NOENT: '), `stderr first line was ${JSON.stringify(r.stderr.split('\n')[0])}`);
  assert.ok(r.stderr.split('\n')[0].includes('fixture/nope.txt'));
  assert.equal(r.stdout, '');
});

check('no_file_args_usage_exit_1', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.split('\n')[0].startsWith('usage:'), `stderr first line was ${JSON.stringify(r.stderr.split('\n')[0])}`);
  const r2 = run(['--json']);
  assert.equal(r2.status, 1, 'flags only still counts as no file args');
});

check('unknown_flag_exit_1_E_BAD_ARG', () => {
  const r = run(['--bogus', 'fixture/one.txt']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.split('\n')[0].startsWith('E_BAD_ARG'), `stderr first line was ${JSON.stringify(r.stderr.split('\n')[0])}`);
  assert.equal(r.stdout, '');
});

check('idempotent_and_no_writes', () => {
  const beforeDir = fs.readdirSync(DIR).sort().join('|');
  const first = run(['fixture/one.txt']);
  const second = run(['fixture/one.txt']);
  assert.equal(first.stdout, second.stdout, 'repeated runs must produce identical output');
  assert.equal(first.status, second.status);
  assert.equal(fs.readdirSync(DIR).sort().join('|'), beforeDir, 'verify run must not create files in the task dir');
  assert.equal(Object.keys(EXPECT).map((f) => `${f}:${fs.statSync(path.join(DIR, f)).size}`).join('|'), fixtureDigest, 'fixtures must stay untouched');
});

function report() {
  if (failures.length === 0) {
    console.log('A4 OK: all checks passed');
    process.exit(0);
  }
  for (const f of failures) console.log(f);
  console.log(`failures=${failures.length}`);
  process.exit(1);
}

report();
