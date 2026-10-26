export class LRUCache {
  #store = new Map();
  #capacity;
  #now;

  constructor(options) {
    const { capacity, now } = options ?? {};
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError(`capacity must be an integer >= 1, got ${String(capacity)}`);
    }
    this.#capacity = capacity;
    this.#now = typeof now === 'function' ? now : () => new Date().getTime();
  }

  #isExpired(entry, t) {
    return entry.expiresAt !== null && t >= entry.expiresAt;
  }

  #live(entry) {
    return !this.#isExpired(entry, this.#now());
  }

  get(key) {
    const entry = this.#store.get(key);
    if (entry === undefined) return undefined;
    if (!this.#live(entry)) {
      this.#store.delete(key);
      return undefined;
    }
    this.#store.delete(key);
    this.#store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (ttlMs !== undefined && ttlMs !== 0) {
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
        throw new RangeError(`ttlMs must be a finite non-negative number, got ${String(ttlMs)}`);
      }
    }
    const expiresAt = ttlMs === undefined || ttlMs === 0 ? null : this.#now() + ttlMs;
    const entry = { value, expiresAt };
    if (this.#store.has(key)) this.#store.delete(key);
    this.#store.set(key, entry);
    if (this.#store.size > this.#capacity) {
      const oldest = this.#store.keys().next().value;
      this.#store.delete(oldest);
    }
    return this;
  }

  has(key) {
    const entry = this.#store.get(key);
    if (entry === undefined) return false;
    if (!this.#live(entry)) {
      this.#store.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.#store.delete(key);
  }

  clear() {
    this.#store.clear();
  }

  get size() {
    this.#sweep();
    return this.#store.size;
  }

  keys() {
    this.#sweep();
    const out = [];
    for (const key of this.#store.keys()) out.unshift(key);
    return out;
  }

  #sweep() {
    const t = this.#now();
    for (const [key, entry] of this.#store) {
      if (this.#isExpired(entry, t)) this.#store.delete(key);
    }
  }
}
