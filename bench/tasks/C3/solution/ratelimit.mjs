// C3: token bucket rate limiter with injected clock, lazy settlement.
// Every public method settles on read; no timers, no deferred work.

export const RATE_LIMIT_ERROR = {
  INVALID_CONFIG: 'E_INVALID_CONFIG',
  INVALID_AMOUNT: 'E_INVALID_AMOUNT',
};

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalidConfig(message) {
  return makeError(RATE_LIMIT_ERROR.INVALID_CONFIG, message);
}

function invalidAmount(message) {
  return makeError(RATE_LIMIT_ERROR.INVALID_AMOUNT, message);
}

function wallClock() {
  return Date.now();
}

function readOptions(raw) {
  if (raw === undefined || raw === null) return {};
  return raw;
}

export class RateLimiter {
  constructor(options) {
    const opts = readOptions(options);
    const capacity = opts.capacity;
    const refillPerSecond = opts.refillPerSecond;
    const now = opts.now;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw invalidConfig('capacity must be an integer >= 1');
    }
    if (typeof refillPerSecond !== 'number' || !Number.isFinite(refillPerSecond)) {
      throw invalidConfig('refillPerSecond must be a finite number');
    }
    if (refillPerSecond <= 0) {
      throw invalidConfig('refillPerSecond must be greater than 0');
    }
    if (now !== undefined && typeof now !== 'function') {
      throw invalidConfig('now must be a function when provided');
    }
    this._capacity = capacity;
    this._refillPerSecond = refillPerSecond;
    this._clock = now === undefined ? wallClock : now;
    this._tokens = capacity;
    this._last = this._clock();
  }

  _settle() {
    const t = this._clock();
    const seconds = (t - this._last) / 1000;
    const grown = this._tokens + seconds * this._refillPerSecond;
    this._tokens = Math.min(this._capacity, grown);
    this._last = t;
  }

  _checkAmount(n) {
    if (!Number.isInteger(n) || n < 1 || n > this._capacity) {
      throw invalidAmount('amount must be an integer within 1..capacity');
    }
  }

  tryTake(n = 1) {
    this._checkAmount(n);
    this._settle();
    if (this._tokens >= n) {
      this._tokens -= n;
      return true;
    }
    return false;
  }

  retryAfterMs(n = 1) {
    this._checkAmount(n);
    this._settle();
    if (this._tokens >= n) return 0;
    const missing = n - this._tokens;
    const raw = (missing / this._refillPerSecond) * 1000;
    return Math.ceil(raw);
  }

  reset() {
    this._settle();
    this._tokens = this._capacity;
  }

  get available() {
    this._settle();
    return Math.floor(this._tokens);
  }
}

export function createLimiter(options) {
  return new RateLimiter(options);
}
