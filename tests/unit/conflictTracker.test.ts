/**
 * Unit tests for ConflictTracker (v1.14.4 R2).
 *
 * Covers ADR 012-revisions R2-4 (TTL expiry) and R2-5 (LRU eviction).
 * Tests use a fresh ConflictTracker instance per test (not the module singleton)
 * and vitest fake timers to control Date.now() advancement.
 *
 * Test numbering: CT-1..CT-N (ConflictTracker unit tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConflictTracker } from '../../src/webapp/items.shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_1 = 111;
const ITEM_A = 'item-a';
const ITEM_B = 'item-b';

const TTL_MS = 5 * 60 * 1000; // 5 minutes — matches items.shared.ts ConflictTracker.ttlMs

// ---------------------------------------------------------------------------
// CT-1..CT-3: Basic noteConflict / hasRecentConflict
// ---------------------------------------------------------------------------

describe('ConflictTracker — basic behavior', () => {
  let tracker: ConflictTracker;

  beforeEach(() => {
    tracker = new ConflictTracker();
  });

  it('CT-1: hasRecentConflict returns false for unknown key', () => {
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(false);
  });

  it('CT-2: noteConflict followed immediately by hasRecentConflict returns true', () => {
    tracker.noteConflict(USER_1, ITEM_A);
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(true);
  });

  it('CT-3: conflict for one user does not affect another user on the same item', () => {
    tracker.noteConflict(USER_1, ITEM_A);
    expect(tracker.hasRecentConflict(USER_1 + 1, ITEM_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CT-4: R2-4 — TTL expiry
//
// ADR binding: "wait 6 minutes (or simulate via injected clock); same client
// retries with X-Force-Override:1 → audit row forced:true, bypassAfter412:false
// (TTL expired; treated as fresh force-probe)."
// ---------------------------------------------------------------------------

describe('ConflictTracker — R2-4 TTL expiry', () => {
  let tracker: ConflictTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new ConflictTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('CT-4: conflict expires after >5 minutes — hasRecentConflict returns false', () => {
    // Record a conflict at time T.
    tracker.noteConflict(USER_1, ITEM_A);
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(true);

    // Advance time by 5 minutes exactly — should still be within TTL (strict <).
    vi.advanceTimersByTime(TTL_MS);
    // At exactly 5 min, Date.now() - ts === TTL_MS, which is NOT < TTL_MS → expired.
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(false);
  });

  it('CT-5: conflict is still active just before TTL boundary', () => {
    tracker.noteConflict(USER_1, ITEM_A);

    // Advance to 1 ms before TTL — should still be fresh.
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(true);
  });

  it('CT-6: noteConflict refreshes TTL — re-noting within window resets the expiry clock', () => {
    tracker.noteConflict(USER_1, ITEM_A);

    // Advance 4 minutes (within TTL).
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(true);

    // Re-note the conflict (simulate a second 412 for the same item).
    tracker.noteConflict(USER_1, ITEM_A);

    // Advance another 4 minutes — now 8 min total from first note, but only 4 from re-note.
    vi.advanceTimersByTime(4 * 60 * 1000);
    // Should still be fresh because re-note refreshed the clock.
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(true);

    // Advance past full TTL from re-note.
    vi.advanceTimersByTime(TTL_MS);
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CT-7: R2-5 — LRU eviction
//
// ADR binding: "Trigger 412s on 101 different items by 1 user; the first 412
// should be evicted from the map." Cap is 100.
// ---------------------------------------------------------------------------

describe('ConflictTracker — R2-5 LRU eviction', () => {
  let tracker: ConflictTracker;

  beforeEach(() => {
    tracker = new ConflictTracker();
  });

  it('CT-7: 101 distinct items evicts the oldest entry', () => {
    // Note conflicts for 101 distinct items. First is ITEM_A.
    tracker.noteConflict(USER_1, ITEM_A);
    for (let i = 0; i < 100; i++) {
      tracker.noteConflict(USER_1, `bulk-item-${i}`);
    }

    // ITEM_A was the FIRST item noted (oldest insertion) — it should be evicted.
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(false);

    // The last 100 items should still be present.
    // Check the last item added.
    expect(tracker.hasRecentConflict(USER_1, 'bulk-item-99')).toBe(true);
  });

  it('CT-8: 105 distinct items evicts the 5 oldest entries', () => {
    // Note 5 "old" items first.
    for (let i = 0; i < 5; i++) {
      tracker.noteConflict(USER_1, `old-item-${i}`);
    }
    // Fill to exactly cap + 5 (total 105 distinct items including the 5 old ones).
    for (let i = 0; i < 100; i++) {
      tracker.noteConflict(USER_1, `new-item-${i}`);
    }

    // All 5 old items should be evicted.
    for (let i = 0; i < 5; i++) {
      expect(tracker.hasRecentConflict(USER_1, `old-item-${i}`), `old-item-${i} should be evicted`).toBe(false);
    }
    // The last 100 new items should all still be present.
    for (let i = 0; i < 100; i++) {
      expect(tracker.hasRecentConflict(USER_1, `new-item-${i}`), `new-item-${i} should be present`).toBe(true);
    }
  });

  it('CT-9: re-noting an existing item moves it to most-recent — protects it from eviction', () => {
    // Note ITEM_A first (oldest).
    tracker.noteConflict(USER_1, ITEM_A);

    // Fill 99 more distinct items — now at cap (100).
    for (let i = 0; i < 99; i++) {
      tracker.noteConflict(USER_1, `filler-${i}`);
    }

    // Re-note ITEM_A — moves it to most-recent insertion position.
    tracker.noteConflict(USER_1, ITEM_A);

    // Add 1 more distinct item — this triggers LRU eviction of the true oldest (filler-0).
    tracker.noteConflict(USER_1, ITEM_B);

    // ITEM_A should still be present (it was refreshed to most-recent).
    expect(tracker.hasRecentConflict(USER_1, ITEM_A)).toBe(true);

    // ITEM_B was just added — present.
    expect(tracker.hasRecentConflict(USER_1, ITEM_B)).toBe(true);

    // filler-0 is the true oldest after ITEM_A's re-insertion — it should be evicted.
    expect(tracker.hasRecentConflict(USER_1, 'filler-0')).toBe(false);
  });
});
