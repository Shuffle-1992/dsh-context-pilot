// C3 判分脚本：7 条硬约束逐条独立检查；确定性、幂等、只读
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const failed = [];
const KEEP_SHA = '1917d724612a7199';

function locate() {
  for (const rel of ['solution/ratelimit.mjs', 'ref/ratelimit.mjs']) {
    const p = path.join(DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fail(n, detail) {
  failed.push(`CONSTRAINT_${n}_FAIL: ${detail}`);
}

const target = locate();
if (!target) {
  for (let n = 1; n <= 7; n++) fail(n, 'bench/tasks/C3/solution/ratelimit.mjs not found');
  finish();
}

let mod = null;
try {
  mod = await import(url.pathToFileURL(target).href);
} catch (e) {
  for (let n = 1; n <= 7; n++) fail(n, `import failed: ${e.message}`);
  finish();
}

const src = fs.readFileSync(target, 'utf8');
const { RateLimiter, createLimiter, RATE_LIMIT_ERROR } = mod;

function codeOf(fn) {
  try {
    fn();
    return { thrown: false };
  } catch (e) {
    return { thrown: true, code: e && e.code };
  }
}

function clockAt(start = 0) {
  const state = { t: start, calls: 0 };
  state.now = () => {
    state.calls += 1;
    return state.t;
  };
  state.at = (v) => { state.t = v; };
  return state;
}

function make(capacity = 3, refillPerSecond = 2, clk = clockAt(0)) {
  const lim = new RateLimiter({ capacity, refillPerSecond, now: clk.now });
  return { lim, clk };
}

/* 约束 1：导出面 */
{
  const seen = [];
  if (typeof RateLimiter !== 'function') seen.push('RateLimiter(class)');
  if (typeof createLimiter !== 'function') seen.push('createLimiter(function)');
  if (!RATE_LIMIT_ERROR || RATE_LIMIT_ERROR.INVALID_CONFIG !== 'E_INVALID_CONFIG') {
    seen.push(`RATE_LIMIT_ERROR.INVALID_CONFIG=${JSON.stringify(RATE_LIMIT_ERROR && RATE_LIMIT_ERROR.INVALID_CONFIG)}`);
  }
  if (!RATE_LIMIT_ERROR || RATE_LIMIT_ERROR.INVALID_AMOUNT !== 'E_INVALID_AMOUNT') {
    seen.push(`RATE_LIMIT_ERROR.INVALID_AMOUNT=${JSON.stringify(RATE_LIMIT_ERROR && RATE_LIMIT_ERROR.INVALID_AMOUNT)}`);
  }
  if (seen.length) fail(1, `导出面不符: ${seen.join('; ')}`);
}

/* 约束 2：非法配置 -> E_INVALID_CONFIG */
{
  const seen = [];
  const good = { capacity: 5, refillPerSecond: 1 };
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '2', null, undefined]) {
    const r = codeOf(() => new RateLimiter({ ...good, capacity: bad }));
    if (!r.thrown || r.code !== 'E_INVALID_CONFIG') seen.push(`capacity=${JSON.stringify(bad)} -> thrown=${r.thrown} code=${String(r.code)}`);
  }
  for (const bad of [0, -1, -0.5, Number.NaN, Infinity, 'x', null, undefined]) {
    const r = codeOf(() => new RateLimiter({ ...good, refillPerSecond: bad }));
    if (!r.thrown || r.code !== 'E_INVALID_CONFIG') seen.push(`refillPerSecond=${JSON.stringify(bad)} -> thrown=${r.thrown} code=${String(r.code)}`);
  }
  for (const bad of ['x', 123, {}, true]) {
    const r = codeOf(() => new RateLimiter({ ...good, now: bad }));
    if (!r.thrown || r.code !== 'E_INVALID_CONFIG') seen.push(`now=${JSON.stringify(bad)} -> thrown=${r.thrown} code=${String(r.code)}`);
  }
  const ok = codeOf(() => new RateLimiter({ capacity: 1, refillPerSecond: 0.5 }));
  if (ok.thrown) seen.push(`合法配置被误抛 (code=${String(ok.code)})`);
  const empty = codeOf(() => new RateLimiter());
  if (!empty.thrown || empty.code !== 'E_INVALID_CONFIG') seen.push('无参构造必须 E_INVALID_CONFIG');
  if (seen.length) fail(2, seen.slice(0, 5).join(' | '));
}

/* 约束 3：非法额度 -> E_INVALID_AMOUNT */
{
  const seen = [];
  for (const bad of [0, -1, -3, 2.5, 4, '2', Number.NaN, Infinity]) {
    const { lim } = make(3, 1);
    let r = codeOf(() => lim.tryTake(bad));
    if (!r.thrown || r.code !== 'E_INVALID_AMOUNT') seen.push(`tryTake(${JSON.stringify(bad)}) -> thrown=${r.thrown} code=${String(r.code)}`);
    const { lim: lim2 } = make(3, 1);
    r = codeOf(() => lim2.retryAfterMs(bad));
    if (!r.thrown || r.code !== 'E_INVALID_AMOUNT') seen.push(`retryAfterMs(${JSON.stringify(bad)}) -> thrown=${r.thrown} code=${String(r.code)}`);
  }
  const { lim } = make(3, 1);
  const r = codeOf(() => lim.tryTake());
  if (r.thrown) seen.push(`tryTake() 缺省 1 必须合法 (code=${String(r.code)})`);
  if (seen.length) fail(3, seen.slice(0, 5).join(' | '));
}

/* 约束 4：惰性结算 + 只用注入时钟 */
{
  const seen = [];
  if (/setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|await/.test(src)) {
    seen.push('源码出现定时器/await');
  }
  if (/Date\.parse|process\.hrtime/.test(src)) seen.push('源码使用其它墙钟 API（应只用注入时钟）');
  const clk = clockAt(0);
  let lim;
  try {
    lim = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clk.now });
  } catch (e) {
    seen.push(`构造抛错: ${e.message}`);
    fail(4, seen.join(' | '));
  }
  if (lim) {
    const afterCtor = clk.calls;
    if (afterCtor < 1) seen.push('构造函数必须读取一次注入时钟');
    clk.at(50000);
    if (clk.calls !== afterCtor) seen.push('未调用任何方法时不得读取时钟（必须惰性）');
    const before = clk.calls;
    const v = lim.available;
    if (clk.calls <= before) seen.push('available 必须结算（未读取注入时钟）');
    if (v !== 2) seen.push(`钳制后 available=${v} 期望 2`);
    const l2 = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clockAt(0).now });
    const took = l2.tryTake(2);
    if (took !== true) seen.push('满桶 tryTake(2) 应为 true');
    if (l2.available !== 0) seen.push('扣减后 available 应为 0');
  }
  if (seen.length) fail(4, seen.join(' | '));
}

/* 约束 5：固定操作序列的精确数值行为 */
{
  const seen = [];
  const clk = clockAt(0);
  const lim = new RateLimiter({ capacity: 3, refillPerSecond: 2, now: clk.now });
  const steps = [
    [0, () => lim.available, 3],
    [0, () => lim.tryTake(3), true],
    [0, () => lim.available, 0],
    [0, () => lim.retryAfterMs(1), 500],
    [250, () => lim.available, 0],
    [250, () => lim.tryTake(1), false],
    [250, () => lim.retryAfterMs(1), 250],
    [500, () => lim.tryTake(1), true],
    [500, () => lim.available, 0],
    [750, () => lim.available, 0],
    [750, () => lim.tryTake(1), false],
    [2500, () => lim.available, 3],
    [2500, () => lim.retryAfterMs(3), 0],
    [2500, () => lim.tryTake(3), true],
    [2500, () => lim.available, 0],
    [2500, () => lim.retryAfterMs(1), 500],
  ];
  for (const [t, fn, want] of steps) {
    clk.at(t);
    let got;
    try {
      got = fn();
    } catch (e) {
      seen.push(`t=${t} 抛错 ${e.message}`);
      continue;
    }
    if (got !== want) seen.push(`t=${t} 期望 ${want} 实得 ${got}`);
  }
  // tryTake 失败不得扣减
  const clk2 = clockAt(0);
  const lim2 = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clk2.now });
  lim2.tryTake(1);
  clk2.at(400);
  if (lim2.tryTake(1) !== false) seen.push('余额不足时 tryTake 必须返回 false');
  if (lim2.available !== 0) seen.push('失败的 tryTake 不得扣减令牌（available 应为 0）');
  if (Number.isInteger(lim2.retryAfterMs(1)) !== true) seen.push('retryAfterMs 必须返回整数');
  if (seen.length) fail(5, seen.slice(0, 6).join(' | '));
}

/* 约束 6：reset 行为 + createLimiter 等价 */
{
  const seen = [];
  const script = (build) => {
    const clk = clockAt(0);
    const lim = build(clk);
    const log = [];
    log.push(lim.available);
    log.push(lim.tryTake(2));
    log.push(lim.available);
    clk.at(1000);
    log.push(lim.available);
    lim.reset();
    log.push(lim.available);
    log.push(lim.tryTake(2));
    log.push(lim.available);
    return log;
  };
  const classLog = script((clk) => new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clk.now }));
  const want = [2, true, 0, 1, 2, true, 0];
  if (classLog.join(',') !== want.join(',')) seen.push(`reset 序列 got=${classLog.join(',')} want=${want.join(',')}`);
  const factoryLog = script((clk) => createLimiter({ capacity: 2, refillPerSecond: 1, now: clk.now }));
  if (factoryLog.join(',') !== classLog.join(',')) seen.push(`createLimiter 行为不一致 got=${factoryLog.join(',')}`);
  const inst = createLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 });
  if (!(inst instanceof RateLimiter)) seen.push('createLimiter 必须返回 RateLimiter 实例');
  if (seen.length) fail(6, seen.join(' | '));
}

/* 约束 7：工程约束 */
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
  if (seen.length) fail(7, seen.join(' | '));
}

function finish() {
  if (failed.length === 0) {
    console.log('C3 ALL_CONSTRAINTS_PASS (7/7)');
    console.log('omissions=0');
    process.exit(0);
  }
  for (const line of failed) console.log(line);
  console.log(`omissions=${failed.length}`);
  process.exit(1);
}

finish();
