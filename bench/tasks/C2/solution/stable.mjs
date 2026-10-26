// C2 stable serializer: deterministic UTF-16 key order, JSON.stringify layout.

export const STABLE_VERSION = '2';

const E_CYCLE = 'E_CYCLE';
const E_NON_FINITE = 'E_NON_FINITE_NUMBER';

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function hasToJSON(v) {
  if (v === null) return false;
  const t = typeof v;
  if (t !== 'object' && t !== 'function') return false;
  return typeof v.toJSON === 'function';
}

function encodeNumber(v) {
  if (!Number.isFinite(v)) {
    throw codedError(E_NON_FINITE, `non-finite number: ${String(v)}`);
  }
  if (Object.is(v, -0)) return '0';
  return String(v);
}

function encodeArray(arr, ctx, depth) {
  const { gap } = ctx;
  const parts = [];
  for (let i = 0; i < arr.length; i++) {
    const s = encode(arr[i], ctx, depth + 1, true);
    parts.push(s === undefined ? 'null' : s);
  }
  if (parts.length === 0) return '[]';
  if (gap === '') return '[' + parts.join(',') + ']';
  const inner = gap.repeat(depth + 1);
  const outer = gap.repeat(depth);
  return '[\n' + parts.map((p) => inner + p).join(',\n') + '\n' + outer + ']';
}

function encodeObject(obj, ctx, depth) {
  const { gap } = ctx;
  const sep = gap === '' ? ':' : ': ';
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const key of keys) {
    const s = encode(obj[key], ctx, depth + 1, false);
    if (s === undefined) continue;
    parts.push(JSON.stringify(key) + sep + s);
  }
  if (parts.length === 0) return '{}';
  if (gap === '') return '{' + parts.join(',') + '}';
  const inner = gap.repeat(depth + 1);
  const outer = gap.repeat(depth);
  return '{\n' + parts.map((p) => inner + p).join(',\n') + '\n' + outer + '}';
}

function encode(v, ctx, depth, inArray) {
  let value = v;
  if (hasToJSON(value)) value = value.toJSON();
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return inArray ? 'null' : undefined;
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return encodeNumber(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    default:
      break;
  }
  if (value === null) return 'null';
  if (ctx.stack.has(value)) throw codedError(E_CYCLE, 'cycle detected');
  ctx.stack.add(value);
  try {
    return Array.isArray(value)
      ? encodeArray(value, ctx, depth)
      : encodeObject(value, ctx, depth);
  } finally {
    ctx.stack.delete(value);
  }
}

export function stableStringify(value, options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  let n = Number(opts.indent);
  if (!Number.isFinite(n) || n <= 0) n = 0;
  n = Math.min(10, Math.floor(n));
  const ctx = { gap: ' '.repeat(n), stack: new Set() };
  return encode(value, ctx, 0, false);
}
