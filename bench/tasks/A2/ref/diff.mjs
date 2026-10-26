function assertText(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, got ${typeof value}`);
}

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function rawBacktrack(a, b) {
  const dp = lcsTable(a, b);
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ op: 'equal', line: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      ops.push({ op: 'del', line: a[i - 1] });
      i -= 1;
    } else {
      ops.push({ op: 'add', line: b[j - 1] });
      j -= 1;
    }
  }
  ops.reverse();
  return ops;
}

// 同一处替换内部：先输出全部 del，再输出全部 add（各自保持原有相对顺序）
function normalizeHunks(ops) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    for (const o of run) if (o.op === 'del') out.push(o);
    for (const o of run) if (o.op === 'add') out.push(o);
    run = [];
  };
  for (const o of ops) {
    if (o.op === 'equal') {
      flush();
      out.push(o);
    } else {
      run.push(o);
    }
  }
  flush();
  return out;
}

export function diffLines(oldText, newText) {
  assertText(oldText, 'oldText');
  assertText(newText, 'newText');
  return normalizeHunks(rawBacktrack(oldText.split('\n'), newText.split('\n')));
}

export function applyDiff(oldText, ops) {
  assertText(oldText, 'oldText');
  if (!Array.isArray(ops)) throw new TypeError('ops must be an array');
  const lines = [];
  for (const o of ops) {
    if (o === null || typeof o !== 'object') throw new TypeError('each op must be an object');
    if (o.op === 'equal' || o.op === 'add') lines.push(o.line);
    else if (o.op === 'del') continue;
    else throw new TypeError(`unknown op: ${String(o.op)}`);
  }
  return lines.join('\n');
}

export function diffStats(ops) {
  if (!Array.isArray(ops)) throw new TypeError('ops must be an array');
  let added = 0;
  let removed = 0;
  let equal = 0;
  for (const o of ops) {
    if (o.op === 'add') added += 1;
    else if (o.op === 'del') removed += 1;
    else if (o.op === 'equal') equal += 1;
    else throw new TypeError(`unknown op: ${String(o && o.op)}`);
  }
  return { added, removed, equal };
}
