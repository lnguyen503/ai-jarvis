/**
 * Unit tests for src/coach/rateLimits.ts (v1.20.0 ADR 020 D8).
 *
 * Tests cover: per-item rate limit, global daily cap, quiet mode,
 * user message debounce, coach DM cooldown, parseQuietDuration,
 * and concurrent-race behaviour.
 *
 * ~25 cases per ADR 020 commit 5 spec.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkPerItemRateLimit,
  recordPerItemFire,
  checkGlobalDailyCap,
  recordGlobalDailyFire,
  checkQuietMode,
  setQuietMode,
  clearQuietMode,
  checkUserMessageDebounce,
  recordUserMessage,
  checkCoachDMCooldown,
  recordCoachDM,
  parseQuietDuration,
  PER_ITEM_RATE_WINDOW_MS,
  GLOBAL_DAILY_CAP,
  USER_MESSAGE_DEBOUNCE_MS,
  COACH_DM_COOLDOWN_MS,
} from '../../src/coach/rateLimits.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let dataDir: string;
const USER_ID = 42;
const ITEM_ID = '2026-04-25-abcd';

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-ratelimits-'));
  dataDir = tmpDir;
});

function cleanup(): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Per-item rate limit
// ---------------------------------------------------------------------------

describe('checkPerItemRateLimit', () => {
  it('allows when no record exists', async () => {
    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(true);
    cleanup();
  });

  it('allows when last fire was > 4h ago', async () => {
    const pastIso = new Date(Date.now() - PER_ITEM_RATE_WINDOW_MS - 1000).toISOString();
    // Pre-seed the entry manually
    const { createEntry } = await import('../../src/memory/userMemoryEntries.js');
    await createEntry(USER_ID, dataDir, `coach.${ITEM_ID}.lastSpontaneousAt`, JSON.stringify({ at: pastIso }));

    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(true);
    cleanup();
  });

  it('blocks when last fire was < 4h ago', async () => {
    const recentIso = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const { createEntry } = await import('../../src/memory/userMemoryEntries.js');
    await createEntry(USER_ID, dataDir, `coach.${ITEM_ID}.lastSpontaneousAt`, JSON.stringify({ at: recentIso }));

    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(false);
    expect(result.nextAllowedIso).toBeDefined();
    cleanup();
  });

  it('nextAllowedIso is approximately 4h from last fire', async () => {
    const lastFireMs = Date.now() - 60 * 60 * 1000; // 1h ago
    const { createEntry } = await import('../../src/memory/userMemoryEntries.js');
    await createEntry(USER_ID, dataDir, `coach.${ITEM_ID}.lastSpontaneousAt`, JSON.stringify({ at: new Date(lastFireMs).toISOString() }));

    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(false);

    const expectedMs = lastFireMs + PER_ITEM_RATE_WINDOW_MS;
    const gotMs = new Date(result.nextAllowedIso!).getTime();
    expect(Math.abs(gotMs - expectedMs)).toBeLessThan(1000);
    cleanup();
  });
});

describe('recordPerItemFire', () => {
  it('records timestamp and subsequent check blocks', async () => {
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID);
    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(false);
    cleanup();
  });

  it('updates existing entry on second fire', async () => {
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID);
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID); // should not throw
    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(false);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Global daily cap
// ---------------------------------------------------------------------------

describe('checkGlobalDailyCap', () => {
  it('allows when no record exists', async () => {
    const result = await checkGlobalDailyCap(USER_ID, dataDir, '20260425');
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    cleanup();
  });

  it('allows when count < GLOBAL_DAILY_CAP', async () => {
    await recordGlobalDailyFire(USER_ID, dataDir, '20260425');
    await recordGlobalDailyFire(USER_ID, dataDir, '20260425');
    const result = await checkGlobalDailyCap(USER_ID, dataDir, '20260425');
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(2);
    cleanup();
  });

  it('blocks when count >= GLOBAL_DAILY_CAP', async () => {
    for (let i = 0; i < GLOBAL_DAILY_CAP; i++) {
      await recordGlobalDailyFire(USER_ID, dataDir, '20260425');
    }
    const result = await checkGlobalDailyCap(USER_ID, dataDir, '20260425');
    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(GLOBAL_DAILY_CAP);
    cleanup();
  });

  it('4th fire is suppressed (regression: global cap = 3)', async () => {
    for (let i = 0; i < GLOBAL_DAILY_CAP; i++) {
      await recordGlobalDailyFire(USER_ID, dataDir, '20260425');
    }
    const result = await checkGlobalDailyCap(USER_ID, dataDir, '20260425');
    expect(result.allowed).toBe(false);
    cleanup();
  });

  it('different days have independent counters', async () => {
    for (let i = 0; i < GLOBAL_DAILY_CAP; i++) {
      await recordGlobalDailyFire(USER_ID, dataDir, '20260425');
    }
    const result = await checkGlobalDailyCap(USER_ID, dataDir, '20260426');
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Quiet mode
// ---------------------------------------------------------------------------

describe('checkQuietMode', () => {
  it('not active when no record exists', async () => {
    const result = await checkQuietMode(USER_ID, dataDir);
    expect(result.active).toBe(false);
    cleanup();
  });

  it('active when untilIso is in the future', async () => {
    const futureIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await setQuietMode(USER_ID, dataDir, futureIso);
    const result = await checkQuietMode(USER_ID, dataDir);
    expect(result.active).toBe(true);
    expect(result.untilIso).toBe(futureIso);
    cleanup();
  });

  it('not active when untilIso is in the past', async () => {
    const pastIso = new Date(Date.now() - 1000).toISOString();
    await setQuietMode(USER_ID, dataDir, pastIso);
    const result = await checkQuietMode(USER_ID, dataDir);
    expect(result.active).toBe(false);
    cleanup();
  });

  it('clearQuietMode disables quiet mode', async () => {
    const futureIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await setQuietMode(USER_ID, dataDir, futureIso);
    await clearQuietMode(USER_ID, dataDir);
    const result = await checkQuietMode(USER_ID, dataDir);
    expect(result.active).toBe(false);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// parseQuietDuration
// ---------------------------------------------------------------------------

describe('parseQuietDuration', () => {
  const nowIso = '2026-04-25T12:00:00.000Z';

  it('parses "2h" correctly', () => {
    const result = parseQuietDuration('2h', nowIso);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedMs = new Date(nowIso).getTime() + 2 * 60 * 60 * 1000;
    expect(new Date(result.untilIso).getTime()).toBe(expectedMs);
  });

  it('parses "1d" correctly', () => {
    const result = parseQuietDuration('1d', nowIso);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedMs = new Date(nowIso).getTime() + 24 * 60 * 60 * 1000;
    expect(new Date(result.untilIso).getTime()).toBe(expectedMs);
  });

  it('parses "until tomorrow" to next UTC midnight', () => {
    const result = parseQuietDuration('until tomorrow', nowIso);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.untilIso).toBe('2026-04-26T00:00:00.000Z');
  });

  it('parses "until monday" to next Monday UTC', () => {
    // 2026-04-25 is a Saturday; next Monday = 2026-04-27
    const result = parseQuietDuration('until monday', nowIso);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.untilIso).toBe('2026-04-27T00:00:00.000Z');
  });

  it('rejects invalid input', () => {
    const result = parseQuietDuration('forever', nowIso);
    expect(result.ok).toBe(false);
  });

  it('rejects hours out of range', () => {
    const result = parseQuietDuration('200h', nowIso);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// User message debounce
// ---------------------------------------------------------------------------

describe('checkUserMessageDebounce', () => {
  it('allowed when no record exists', async () => {
    const result = await checkUserMessageDebounce(USER_ID, dataDir);
    expect(result.allowed).toBe(true);
    cleanup();
  });

  it('blocks when last message was < 60s ago', async () => {
    await recordUserMessage(USER_ID, dataDir);
    const result = await checkUserMessageDebounce(USER_ID, dataDir);
    expect(result.allowed).toBe(false);
    expect(result.secondsSince).toBeLessThan(USER_MESSAGE_DEBOUNCE_MS / 1000);
    cleanup();
  });

  it('allowed when last message was > 60s ago', async () => {
    const pastIso = new Date(Date.now() - USER_MESSAGE_DEBOUNCE_MS - 1000).toISOString();
    const { createEntry } = await import('../../src/memory/userMemoryEntries.js');
    await createEntry(USER_ID, dataDir, 'coach.global.lastUserMessageAt', JSON.stringify({ at: pastIso }));

    const result = await checkUserMessageDebounce(USER_ID, dataDir);
    expect(result.allowed).toBe(true);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Coach DM cooldown
// ---------------------------------------------------------------------------

describe('checkCoachDMCooldown', () => {
  it('allowed when no record exists', async () => {
    const result = await checkCoachDMCooldown(USER_ID, dataDir);
    expect(result.allowed).toBe(true);
    cleanup();
  });

  it('blocks when last DM was < 30min ago', async () => {
    await recordCoachDM(USER_ID, dataDir);
    const result = await checkCoachDMCooldown(USER_ID, dataDir);
    expect(result.allowed).toBe(false);
    cleanup();
  });

  it('allowed when last DM was > 30min ago', async () => {
    const pastIso = new Date(Date.now() - COACH_DM_COOLDOWN_MS - 1000).toISOString();
    const { createEntry } = await import('../../src/memory/userMemoryEntries.js');
    await createEntry(USER_ID, dataDir, 'coach.global.lastCoachDmAt', JSON.stringify({ at: pastIso }));

    const result = await checkCoachDMCooldown(USER_ID, dataDir);
    expect(result.allowed).toBe(true);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Concurrent race: two reads return same allowed; second write wins
// ---------------------------------------------------------------------------

describe('concurrent writes', () => {
  it('two parallel reads of different keys both return allowed (no prior write)', async () => {
    const [r1, r2] = await Promise.all([
      checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID),
      checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID),
    ]);
    // Both reads see no prior write → both allowed
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    cleanup();
  });

  it('sequential writes serialize correctly: write then check blocks', async () => {
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID);
    const result = await checkPerItemRateLimit(USER_ID, dataDir, ITEM_ID);
    expect(result.allowed).toBe(false);
    cleanup();
  });
});
