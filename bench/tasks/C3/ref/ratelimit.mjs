export const RATE_LIMIT_ERROR = {
  INVALID_CONFIG: 'E_INVALID_CONFIG',
  INVALID_AMOUNT: 'E_INVALID_AMOUNT',
};

function raise(code, message) {
  const err = new RangeError(message);
  err.code = code;
  return err;
}

const wallClock = () => new Date().getTime();

export class RateLimiter {
  #capacity;
  #refillPerSecond;
  #now;
  #tokens;
  #last;

  constructor(options) {
    const { capacity, refillPerSecond, now } = options ?? {};
    const CONFIG = RATE_LIMIT_ERROR.INVALID_CONFIG;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw raise(CONFIG, `capacity must be an integer >= 1, got ${String(capacity)}`);
    }
    const badRate = typeof refillPerSecond !== 'number'
      || !Number.isFinite(refillPerSecond)
      || refillPerSecond <= 0;
    if (badRate) {
      const detail = `refillPerSecond must be finite and > 0, got ${String(refillPerSecond)}`;
      throw raise(CONFIG, detail);
    }
    if (now !== undefined && typeof now !== 'function') {
      throw raise(CONFIG, 'now must be a function when provided');
    }
    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
    this.#now = now ?? wallClock;
    this.#tokens = capacity;
    this.#last = this.#now();
  }

  get capacity() {
    return this.#capacity;
  }

  #settle() {
    const t = this.#now();
    const elapsedMs = t - this.#last;
    if (elapsedMs > 0) {
      const gained = (elapsedMs / 1000) * this.#refillPerSecond;
      this.#tokens = Math.min(this.#capacity, this.#tokens + gained);
    }
    this.#last = t;
    return this.#tokens;
  }

  #amount(n, where) {
    if (!Number.isInteger(n) || n < 1 || n > this.#capacity) {
      const detail = `${where}: need integer in [1, ${this.#capacity}], got ${String(n)}`;
      throw raise(RATE_LIMIT_ERROR.INVALID_AMOUNT, detail);
    }
    return n;
  }

  tryTake(n = 1) {
    this.#amount(n, 'tryTake');
    const tokens = this.#settle();
    if (tokens < n) return false;
    this.#tokens = tokens - n;
    return true;
  }

  retryAfterMs(n = 1) {
    this.#amount(n, 'retryAfterMs');
    const tokens = this.#settle();
    if (tokens >= n) return 0;
    return Math.ceil(((n - tokens) / this.#refillPerSecond) * 1000);
  }

  get available() {
    return Math.floor(this.#settle());
  }

  reset() {
    this.#settle();
    this.#tokens = this.#capacity;
  }
}

export function createLimiter(options) {
  return new RateLimiter(options);
}
