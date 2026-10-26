const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isPlainObject(x) {
  if (x === null || typeof x !== 'object') return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

function copyValue(v) {
  if (Array.isArray(v)) return v.map(copyValue);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (PROTO_KEYS.has(k)) continue;
      out[k] = copyValue(v[k]);
    }
    return out;
  }
  if (v instanceof Date) return new Date(v.getTime());
  return v;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function mergeNode(schemaVal, rawPresent, rawVal, path, strict) {
  if (!isPlainObject(schemaVal)) return rawPresent ? copyValue(rawVal) : copyValue(schemaVal);
  if (!rawPresent) return copyValue(schemaVal);
  if (!isPlainObject(rawVal)) return copyValue(rawVal);

  for (const k of Object.keys(rawVal)) {
    if (PROTO_KEYS.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(schemaVal, k)) {
      if (strict) throw fail('E_UNKNOWN_KEY', `unknown key: ${[...path, k].join('.')}`);
    }
  }

  const out = {};
  for (const k of Object.keys(schemaVal)) {
    const present = Object.prototype.hasOwnProperty.call(rawVal, k) && !PROTO_KEYS.has(k);
    out[k] = mergeNode(schemaVal[k], present, present ? rawVal[k] : undefined, [...path, k], strict);
  }
  return out;
}

function coerceEnvValue(value) {
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (NUM_RE.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      throw fail('E_ENV_VALUE', `invalid JSON in env value: ${value}`);
    }
  }
  return value;
}

function lookupKey(node, segment) {
  for (const k of Object.keys(node)) {
    if (k.toLowerCase() === segment) return k;
  }
  return null;
}

function applyEnv(root, env, strict) {
  for (const name of Object.keys(env)) {
    if (!name.startsWith('CFG_')) continue;
    const segments = name.slice(4).split('__').map((s) => s.toLowerCase());
    let node = root;
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!isPlainObject(node) || PROTO_KEYS.has(seg)) { ok = false; break; }
      const hit = lookupKey(node, seg);
      if (hit === null) { ok = false; break; }
      if (i === segments.length - 1) {
        node[hit] = coerceEnvValue(String(env[name]));
      } else {
        node = node[hit];
      }
    }
    if (ok) continue;
    if (strict) throw fail('E_UNKNOWN_KEY', `unknown env path: ${name}`);
  }
  return root;
}

export function buildConfig({ schema, raw, env, strict = false } = {}) {
  const userRaw = raw === undefined || raw === null || !isPlainObject(raw) ? undefined : raw;
  const merged = mergeNode(schema, userRaw !== undefined, userRaw, [], Boolean(strict));
  return applyEnv(merged, env === undefined || env === null ? {} : env, Boolean(strict));
}
