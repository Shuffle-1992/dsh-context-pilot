export const STABLE_VERSION = '2';

function makeError(code, message) {
  const err = new TypeError(message);
  err.code = code;
  return err;
}

function pad(level, step) {
  return ' '.repeat(step * level);
}

function encode(value, level, step, stack, inArray) {
  if (value === undefined || typeof value === 'function') return inArray ? 'null' : undefined;
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'bigint') return JSON.stringify(value.toString());
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw makeError('E_NON_FINITE_NUMBER', `non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);

  if (typeof value.toJSON === 'function') {
    return encode(value.toJSON(), level, step, stack, inArray);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (stack.includes(value)) throw makeError('E_CYCLE', 'cyclic structure detected');

  stack.push(value);
  try {
    if (Array.isArray(value)) return encodeArray(value, level, step, stack);
    return encodeObject(value, level, step, stack);
  } finally {
    stack.pop();
  }
}

function encodeArray(items, level, step, stack) {
  const parts = items.map((item) => {
    const encoded = encode(item, level + 1, step, stack, true);
    return encoded === undefined ? 'null' : encoded;
  });
  return wrap(parts, '[', ']', level, step);
}

function encodeObject(value, level, step, stack) {
  const keys = Object.keys(value).sort();
  const colon = step > 0 ? ': ' : ':';
  const parts = [];
  for (const key of keys) {
    const encoded = encode(value[key], level + 1, step, stack, false);
    if (encoded === undefined) continue;
    parts.push(`${JSON.stringify(key)}${colon}${encoded}`);
  }
  return wrap(parts, '{', '}', level, step);
}

function wrap(parts, open, close, level, step) {
  if (parts.length === 0) return `${open}${close}`;
  if (step === 0) return `${open}${parts.join(',')}${close}`;
  const inner = pad(level + 1, step);
  const outer = pad(level, step);
  return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${outer}${close}`;
}

export function stableStringify(value, options = {}) {
  const raw = options && typeof options.indent === 'number' && Number.isFinite(options.indent)
    ? Math.trunc(options.indent)
    : 0;
  const step = Math.max(0, Math.min(10, raw));
  return encode(value, 0, step, [], false);
}
