// A3 判分脚本：确定性、幂等、只读
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failures = [];

function locate() {
  for (const rel of ['solution/config.mjs', 'ref/config.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const target = locate();
if (!target) {
  failures.push('CHECK_FAIL artifact_exists: bench/tasks/A3/solution/config.mjs not found');
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

const { buildConfig } = mod;

function schema() {
  return {
    name: 'app',
    port: 3000,
    debug: false,
    loglevel: 'info',
    server: { host: '127.0.0.1', port: 8080, tags: ['a', 'b'], since: null, meta: { level: 1, on: true } },
  };
}

check('export_buildConfig_function', () => {
  assert.equal(typeof buildConfig, 'function');
});

check('defaults_when_no_raw_no_env', () => {
  const s = schema();
  const got = buildConfig({ schema: s });
  assert.deepEqual(got, s);
  assert.notEqual(got, s, 'must return a new object');
  assert.notEqual(got.server, s.server, 'nested objects must be new too');
});

check('raw_undefined_or_null_uses_defaults', () => {
  assert.deepEqual(buildConfig({ schema: schema(), raw: undefined }), schema());
  assert.deepEqual(buildConfig({ schema: schema(), raw: null }), schema());
});

check('deep_merge_nested_plain_objects', () => {
  const got = buildConfig({
    schema: schema(),
    raw: { port: 8123, server: { port: 9000, meta: { on: false } } },
  });
  assert.deepEqual(got, {
    name: 'app',
    port: 8123,
    debug: false,
    loglevel: 'info',
    server: { host: '127.0.0.1', port: 9000, tags: ['a', 'b'], since: null, meta: { level: 1, on: false } },
  });
});

check('arrays_and_dates_replace_wholesale', () => {
  const d = new Date(0);
  const got = buildConfig({
    schema: schema(),
    raw: { server: { tags: ['x'], since: d, meta: { level: 5, on: true, extraIgnored: 1 } } },
  });
  assert.deepEqual(got.server.tags, ['x'], 'arrays must replace, not merge');
  assert.ok(got.server.since instanceof Date);
  assert.equal(got.server.since.getTime(), 0);
});

check('unknown_key_trimmed_then_strict_throws', () => {
  const got = buildConfig({ schema: schema(), raw: { nope: 1, server: { alsoNo: 2 } } });
  assert.equal('nope' in got, false);
  assert.equal('alsoNo' in got.server, false);
  let err = null;
  try { buildConfig({ schema: schema(), raw: { nope: 1 }, strict: true }); } catch (e) { err = e; }
  assert.ok(err, 'strict must throw on unknown key');
  assert.equal(err.code, 'E_UNKNOWN_KEY');
});

check('proto_pollution_ignored_even_strict', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":"yes"},"server":{"constructor":"bad"}}');
  const got = buildConfig({ schema: schema(), raw, strict: true });
  assert.equal({}.polluted, undefined, 'Object.prototype must stay clean');
  assert.equal(got.polluted, undefined);
  assert.equal(got.server.constructor, Object, 'constructor key must be ignored');
});

check('env_coercion_all_types', () => {
  const got = buildConfig({
    schema: schema(),
    env: {
      CFG_NAME: 'demo',
      CFG_PORT: '80',
      CFG_DEBUG: 'true',
      CFG_LOGLEVEL: 'warn',
      CFG_SERVER__PORT: '12.5',
      CFG_SERVER__TAGS: '["z"]',
      CFG_SERVER__META__LEVEL: '3',
    },
  });
  assert.equal(got.name, 'demo');
  assert.equal(got.port, 80);
  assert.equal(typeof got.port, 'number');
  assert.equal(got.debug, true);
  assert.equal(typeof got.debug, 'boolean');
  assert.equal(got.loglevel, 'warn');
  assert.equal(got.server.port, 12.5);
  assert.deepEqual(got.server.tags, ['z']);
  assert.equal(got.server.meta.level, 3);
});

check('env_empty_string_becomes_null', () => {
  const got = buildConfig({ schema: schema(), env: { CFG_NAME: '', CFG_SERVER__SINCE: 'nullish' } });
  assert.equal(got.name, null, "'' must become null");
  assert.equal(got.server.since, 'nullish');
});

check('env_ignores_non_prefixed_keys', () => {
  const got = buildConfig({
    schema: schema(),
    env: { PORT: '1', PATH: '/bin', CFG_: '2', XPORT: '3', NAME: 'nope' },
  });
  assert.equal(got.port, 3000, 'keys without the CFG_ prefix must be ignored');
  assert.equal(got.name, 'app');
  assert.equal('xport' in got, false);
});

check('env_ignores_unknown_path_when_not_strict', () => {
  const got = buildConfig({ schema: schema(), env: { CFG_PORTX: '1', CFG_NOPE__X: '2', CFG_SERVER__NOPE: '3' } });
  assert.equal(got.port, 3000);
  assert.equal('portx' in got, false);
  assert.equal('nope' in got, false);
  assert.equal('nope' in got.server, false);
});

check('env_strict_unknown_path_throws', () => {
  let err = null;
  try { buildConfig({ schema: schema(), env: { CFG_SERVER__NOPE: '3' }, strict: true }); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'E_UNKNOWN_KEY');
});

check('env_invalid_json_throws', () => {
  let err = null;
  try { buildConfig({ schema: schema(), env: { CFG_SERVER__TAGS: '{oops' } }); } catch (e) { err = e; }
  assert.ok(err, 'invalid JSON value must throw');
  assert.equal(err.code, 'E_ENV_VALUE');
});

check('env_applied_in_object_keys_order', () => {
  const got = buildConfig({ schema: schema(), env: { CFG_NAME: 'first', CFG_name: 'second' } });
  assert.equal(got.name, 'second', 'later env keys mapping to the same path must win');
  const got2 = buildConfig({ schema: schema(), env: { CFG_name: 'second', CFG_NAME: 'first' } });
  assert.equal(got2.name, 'first');
});

check('key_order_follows_schema', () => {
  const s = schema();
  const got = buildConfig({ schema: s, raw: { server: { meta: { on: false }, tags: [] } } });
  assert.deepEqual(Object.keys(got), Object.keys(s));
  assert.deepEqual(Object.keys(got.server), Object.keys(s.server));
});

check('inputs_not_mutated', () => {
  const s = schema();
  const r = { port: 9999, server: { tags: ['q'], meta: { level: 7 } }, bogus: 1 };
  const e = { CFG_NAME: 'zzz', CFG_SERVER__PORT: '42' };
  const s0 = JSON.parse(JSON.stringify(s));
  const r0 = JSON.parse(JSON.stringify(r));
  const e0 = { ...e };
  buildConfig({ schema: s, raw: r, env: e, strict: false });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s0, 'schema must not be mutated');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r0, 'raw must not be mutated');
  assert.deepEqual(e, e0, 'env must not be mutated');
});

check('deterministic_repeat_calls', () => {
  const args = { schema: schema(), raw: { server: { port: 1 } }, env: { CFG_NAME: 'q' } };
  assert.deepEqual(buildConfig(args), buildConfig(args));
});

check('builtin_imports_only', () => {
  const src = fs.readFileSync(target, 'utf8');
  const specs = [...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const s of specs) assert.ok(s.startsWith('node:'), `non-builtin import: ${s}`);
});

function report() {
  if (failures.length === 0) {
    console.log('A3 OK: all checks passed');
    process.exit(0);
  }
  for (const f of failures) console.log(f);
  console.log(`failures=${failures.length}`);
  process.exit(1);
}

report();
