// LoginThrottle: sliding-window failure counting, pure and clock-injected.

import { describe, it, expect } from 'vitest';
import { LoginThrottle } from '../../src/services/ratelimit.js';

const MIN = 60_000;

describe('LoginThrottle', () => {
  it('allows a fresh key', () => {
    const t = new LoginThrottle();
    expect(t.retryAfterMs('email:a@x.com', 0)).toBe(0);
  });

  it('blocks after maxFailures within the window', () => {
    const t = new LoginThrottle({ maxFailures: 3, windowMs: 15 * MIN });
    t.recordFailure('k', 0);
    t.recordFailure('k', MIN);
    expect(t.retryAfterMs('k', 2 * MIN)).toBe(0); // 2 failures: still allowed
    t.recordFailure('k', 2 * MIN);
    expect(t.retryAfterMs('k', 2 * MIN)).toBeGreaterThan(0);
  });

  it('unblocks when the oldest failure slides out of the window', () => {
    const t = new LoginThrottle({ maxFailures: 2, windowMs: 10 * MIN });
    t.recordFailure('k', 0);
    t.recordFailure('k', MIN);
    // Blocked until the failure at t=0 expires at t=10min.
    expect(t.retryAfterMs('k', 5 * MIN)).toBe(5 * MIN);
    expect(t.retryAfterMs('k', 10 * MIN)).toBe(0);
  });

  it('success clears the key', () => {
    const t = new LoginThrottle({ maxFailures: 2, windowMs: 10 * MIN });
    t.recordFailure('k', 0);
    t.recordFailure('k', MIN);
    expect(t.retryAfterMs('k', MIN)).toBeGreaterThan(0);
    t.recordSuccess('k');
    expect(t.retryAfterMs('k', MIN)).toBe(0);
  });

  it('keys are independent', () => {
    const t = new LoginThrottle({ maxFailures: 1, windowMs: 10 * MIN });
    t.recordFailure('email:a@x.com', 0);
    expect(t.retryAfterMs('email:a@x.com', 0)).toBeGreaterThan(0);
    expect(t.retryAfterMs('email:b@x.com', 0)).toBe(0);
    expect(t.retryAfterMs('ip:10.0.0.1', 0)).toBe(0);
  });

  it('defaults: 10 failures in 15 minutes', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 9; i += 1) t.recordFailure('k', i * 1000);
    expect(t.retryAfterMs('k', 10_000)).toBe(0);
    t.recordFailure('k', 10_000);
    expect(t.retryAfterMs('k', 10_000)).toBeGreaterThan(0);
    expect(t.retryAfterMs('k', 10_000 + 15 * MIN)).toBe(0);
  });
});
