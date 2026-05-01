/**
 * Write rate limit tests: max 10 writes per 60s per session.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkAndRecordWrite,
  resetSession,
  clearAll,
  MAX_WRITES_PER_WINDOW,
  WRITE_WINDOW_MS,
} from '../../src/safety/writeRateLimit.js';

describe('safety.writeRateLimit', () => {
  beforeEach(() => {
    clearAll();
  });

  it('allows first write for a session', () => {
    const result = checkAndRecordWrite(1);
    expect(result.allowed).toBe(true);
  });

  it(`allows up to ${MAX_WRITES_PER_WINDOW} writes per window`, () => {
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      const r = checkAndRecordWrite(1);
      expect(r.allowed).toBe(true);
    }
  });

  it(`rejects the ${MAX_WRITES_PER_WINDOW + 1}th write in the window`, () => {
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      checkAndRecordWrite(1);
    }
    const r = checkAndRecordWrite(1);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(r.retryAfterMs).toBeLessThanOrEqual(WRITE_WINDOW_MS);
    }
  });

  it('uses separate windows for different sessions', () => {
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      checkAndRecordWrite(1);
    }
    // Session 2 should have its own window
    const r = checkAndRecordWrite(2);
    expect(r.allowed).toBe(true);
  });

  it('resets counter after window expires', () => {
    const now = Date.now();
    // Fill the window
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      checkAndRecordWrite(1, now);
    }
    // Simulated time: window has expired
    const r = checkAndRecordWrite(1, now + WRITE_WINDOW_MS + 1);
    expect(r.allowed).toBe(true);
  });

  it('resetSession clears state for a single session', () => {
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      checkAndRecordWrite(1);
    }
    resetSession(1);
    // Should be allowed again
    const r = checkAndRecordWrite(1);
    expect(r.allowed).toBe(true);
  });

  it('does not affect other sessions on resetSession', () => {
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      checkAndRecordWrite(1);
    }
    for (let i = 0; i < MAX_WRITES_PER_WINDOW; i++) {
      checkAndRecordWrite(2);
    }
    resetSession(1);
    // Session 2 should still be exhausted
    const r2 = checkAndRecordWrite(2);
    expect(r2.allowed).toBe(false);
    // Session 1 should be fresh
    const r1 = checkAndRecordWrite(1);
    expect(r1.allowed).toBe(true);
  });
});
