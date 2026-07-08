// Login throttling (todo: "Login lockout / rate limiting on auth endpoints").
// A sliding-window failure counter, clock-injected so tests never sleep.
// In-memory by design: a single-node SQLite deployment has exactly one
// process, and losing counters on restart is acceptable for this threat
// model (argon2 keeps each guess expensive regardless).

export interface ThrottleOptions {
  maxFailures?: number; // failures allowed per key per window (default 10)
  windowMs?: number; // sliding window length (default 15 minutes)
}

export class LoginThrottle {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  /** Per-key failure timestamps (ms), oldest first. */
  private readonly failures = new Map<string, number[]>();

  constructor(options: ThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? 10;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
  }

  /** Drop expired timestamps; delete the key entirely when none remain. */
  private prune(key: string, nowMs: number): number[] {
    const timestamps = this.failures.get(key);
    if (timestamps === undefined) return [];
    const live = timestamps.filter((ts) => ts + this.windowMs > nowMs);
    if (live.length === 0) {
      this.failures.delete(key); // keep memory bounded
      return live;
    }
    if (live.length !== timestamps.length) this.failures.set(key, live);
    return live;
  }

  /** Milliseconds until this key may try again; 0 means allowed now. */
  retryAfterMs(key: string, nowMs: number): number {
    const live = this.prune(key, nowMs);
    if (live.length < this.maxFailures) return 0;
    // The count drops below maxFailures once enough of the oldest failures
    // expire; the last of those governs when.
    const oldestRelevant = live[live.length - this.maxFailures]!;
    return oldestRelevant + this.windowMs - nowMs;
  }

  recordFailure(key: string, nowMs: number): void {
    const live = this.prune(key, nowMs);
    live.push(nowMs);
    this.failures.set(key, live);
  }

  /** A successful login clears the key's failure history. */
  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
