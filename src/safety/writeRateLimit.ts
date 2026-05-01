/**
 * Per-session filesystem write rate limiter (v1.6.0 hardening).
 *
 * Enforces: max 10 write operations per minute per session.
 * Uses a sliding window: the window starts at the first write.
 * After the window expires, the counter resets.
 *
 * This is kept lightweight — no external dependencies, no DB writes.
 */

export interface WriteRateLimitState {
  windowStartMs: number;
  writeCount: number;
}

/** Maximum write operations allowed within the window. */
export const MAX_WRITES_PER_WINDOW = 10;
/** Window duration in milliseconds. */
export const WRITE_WINDOW_MS = 60_000; // 1 minute

const stateBySession = new Map<number, WriteRateLimitState>();

/**
 * Check whether a write is allowed for the given session, and if so, record it.
 * Returns { allowed: true } when within the rate limit.
 * Returns { allowed: false, retryAfterMs } when the limit is exceeded.
 */
export function checkAndRecordWrite(
  sessionId: number,
  nowMs?: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const now = nowMs ?? Date.now();
  const state = stateBySession.get(sessionId);

  if (!state || now - state.windowStartMs >= WRITE_WINDOW_MS) {
    // No existing state or window has expired — start a fresh window
    stateBySession.set(sessionId, { windowStartMs: now, writeCount: 1 });
    return { allowed: true };
  }

  if (state.writeCount >= MAX_WRITES_PER_WINDOW) {
    const retryAfterMs = WRITE_WINDOW_MS - (now - state.windowStartMs);
    return { allowed: false, retryAfterMs };
  }

  // Increment counter within the existing window
  state.writeCount++;
  return { allowed: true };
}

/** Reset state for a session (used in tests). */
export function resetSession(sessionId: number): void {
  stateBySession.delete(sessionId);
}

/** Clear all state (used in tests). */
export function clearAll(): void {
  stateBySession.clear();
}
