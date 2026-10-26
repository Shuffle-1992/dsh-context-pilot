// A1 判分脚本：确定性、幂等、只读（除自身 stdout/stderr 外不写任何文件）
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failures = [];

function locate() {
  for (const rel of ['solution/lru.mjs', 'ref/lru.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const target = locate();
if (!target) {
  failures.push('CHECK_FAIL artifact_exists: bench/tasks/A1/solution/lru.mjs not found');
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

const { LRUCache } = mod;

check('export_LRUCache_class', () => {
  assert.equal(typeof LRUCache, 'function', 'LRUCache must be exported as a class/function');
  assert.ok(new LRUCache({ capacity: 2 }) instanceof LRUCache);
});

// 可控时钟
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (d) => { t += d; },
    at: (v) => { t = v; },
  };
}

check('basic_set_get_miss', () => {
  const c = new LRUCache({ capacity: 3 });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('zzz'), undefined);
  assert.equal(c.size, 1);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('zzz'), false);
});

check('evict_one_lru_on_overflow', () => {
  const c = new LRUCache({ capacity: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.size, 2, 'size must stay at capacity');
  assert.equal(c.has('a'), false, 'oldest entry a must be evicted');
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.deepEqual(c.keys(), ['c', 'b'], 'keys() must be MRU first');
});

check('get_refreshes_recency', () => {
  const c = new LRUCache({ capacity: 2 });
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1); // a 变成最新
  c.set('c', 3);               // 应淘汰 b
  assert.deepEqual(c.keys(), ['c', 'a']);
  assert.equal(c.has('b'), false);
});

check('has_does_not_refresh_recency', () => {
  const c = new LRUCache({ capacity: 2 });
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.has('a'), true);
  c.set('c', 3); // has 不算使用，a 仍是 LRU → 淘汰 a
  assert.equal(c.has('a'), false, 'has() must not refresh recency');
  assert.deepEqual(c.keys(), ['c', 'b']);
});

check('set_existing_key_updates_and_refreshes', () => {
  const c = new LRUCache({ capacity: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 99);
  assert.equal(c.size, 2, 'update must not grow size');
  assert.equal(c.get('a'), 99);
  c.set('c', 3);
  assert.equal(c.has('b'), false, 'updated key must count as most recently used');
  assert.deepEqual(c.keys(), ['c', 'a']);
});

check('ttl_expiry_boundary', () => {
  const k = clock(1000);
  const c = new LRUCache({ capacity: 4, now: k.now });
  c.set('x', 'v', 100); // expiresAt = 1100
  k.at(1099);
  assert.equal(c.get('x'), 'v', 'not expired at now = expiresAt - 1');
  k.at(1100);
  assert.equal(c.get('x'), undefined, 'expired when now >= expiresAt');
  assert.equal(c.size, 0, 'expired entry must be purged');
});

check('ttl_filtered_by_size_and_keys_without_get', () => {
  const k = clock(0);
  const c = new LRUCache({ capacity: 4, now: k.now });
  c.set('a', 1);
  c.set('b', 2, 50);
  k.at(60);
  assert.deepEqual(c.keys(), ['a'], 'keys() must filter expired entries');
  assert.equal(c.size, 1, 'size must filter expired entries');
  assert.equal(c.has('b'), false);
});

check('no_ttl_by_default', () => {
  const k = clock(0);
  const c = new LRUCache({ capacity: 2, now: k.now });
  c.set('a', 1);
  c.set('b', 2, 0);
  k.at(10 ** 12);
  assert.equal(c.size, 2, 'ttlMs 0 / undefined means never expires');
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), 2);
});

check('reinsert_resets_expiry', () => {
  const k = clock(0);
  const c = new LRUCache({ capacity: 2, now: k.now });
  c.set('a', 1, 100);
  k.at(50);
  c.set('a', 2, 100); // expiresAt = 150
  k.at(120);
  assert.equal(c.get('a'), 2, 'set must recompute expiresAt');
  k.at(150);
  assert.equal(c.get('a'), undefined);
});

check('delete_and_clear', () => {
  const c = new LRUCache({ capacity: 3 });
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false, 'delete of missing key returns false');
  assert.deepEqual(c.keys(), ['b']);
  c.clear();
  assert.equal(c.size, 0);
  assert.deepEqual(c.keys(), []);
});

check('primitives_as_keys', () => {
  const c = new LRUCache({ capacity: 5 });
  c.set(1, 'one');
  c.set('1', 'str-one');
  c.set(null, 'nul');
  assert.equal(c.get(1), 'one');
  assert.equal(c.get('1'), 'str-one');
  assert.equal(c.get(null), 'nul');
  assert.equal(c.size, 3);
});

check('capacity_three_eviction_sequence', () => {
  const c = new LRUCache({ capacity: 3 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  c.get('a');        // order: a(MRU) c b
  c.set('d', 4);     // evict b
  assert.deepEqual(c.keys(), ['d', 'a', 'c']);
  assert.equal(c.has('b'), false);
  c.get('c');        // order: c d a
  c.set('e', 5);     // evict a
  assert.deepEqual(c.keys(), ['e', 'c', 'd']);
});

check('invalid_capacity_throws_TypeError', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, '2', null, undefined]) {
    let threw = null;
    try { new LRUCache({ capacity: bad }); } catch (e) { threw = e; }
    assert.ok(threw instanceof TypeError, `capacity=${String(bad)} must throw TypeError, got ${threw && threw.constructor.name}`);
  }
});

check('negative_ttl_throws_RangeError', () => {
  const c = new LRUCache({ capacity: 2 });
  for (const bad of [-1, -0.5, Number.POSITIVE_INFINITY]) {
    let threw = null;
    try { c.set('a', 1, bad); } catch (e) { threw = e; }
    assert.ok(threw instanceof RangeError, `ttlMs=${bad} must throw RangeError`);
  }
});

check('no_timers_allowed', () => {
  const src = fs.readFileSync(target, 'utf8');
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame|queueMicrotask/.test(src), 'timers are not allowed');
  assert.ok(!/\bawait\b/.test(src), 'must be synchronous');
});

check('only_builtin_imports', () => {
  const src = fs.readFileSync(target, 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import\s[^;]*?|export\s[^;]*?)\s*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const s of specs) assert.ok(s.startsWith('node:'), `bare/relative import specifier not allowed: ${s}`);
});

function report() {
  if (failures.length === 0) {
    console.log('A1 OK: all checks passed');
    process.exit(0);
  }
  for (const f of failures) console.log(f);
  console.log(`failures=${failures.length}`);
  process.exit(1);
}

report();
