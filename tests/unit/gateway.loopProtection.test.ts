/**
 * Unit tests for src/gateway/loopProtection.ts (v1.21.0 D10).
 *
 * History of the cap value:
 *   - v1.21.0  → 3 (initial)
 *   - v1.21.14 → 10 (raised)
 *   - v1.22.37 → 5 (dropped — smaller models persona-drift faster)
 *
 * v1.22.45 added a `cap: number` field to checkBotToBotLoop's return value
 * so callers can see which cap engaged (with-plan vs no-plan vs sustained).
 * Tests that previously deep-equaled `{ allowed, count }` must now also
 * include `cap` (or use objectContaining).
 *
 * Covers:
 *   - cap limit: count < MAX is allowed; count === MAX is blocked
 *   - Reset on user message: counter drops to zero
 *   - threadKey derivation: <chatId>:<threadId>
 *   - threadKey without threadId: <chatId> only
 *   - TTL expiry: entry older than LOOP_COUNTER_TTL_MS is treated as zero
 *   - Independent counters per threadKey
 *   - getBotToBotCount reflects live state
 *   - checkBotToBotLoop on empty state returns allowed=true, count=0, cap=5
 *   - recordBotToBotTurn increments sequentially
 *   - recordBotToBotTurn after TTL restarts counter at 1
 *   - MAX_BOT_TO_BOT_TURNS is 5
 *   - LOOP_COUNTER_TTL_MS is 3_600_000
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkBotToBotLoop,
  recordBotToBotTurn,
  resetBotToBotCounterOnUserMessage,
  deriveThreadKey,
  getBotToBotCount,
  MAX_BOT_TO_BOT_TURNS,
  LOOP_COUNTER_TTL_MS,
  _resetAllLoopCounters,
} from '../../src/gateway/loopProtection.js';

const NOW = 1_700_000_000_000; // fixed clock for deterministic tests
const CHAT_A = -1001234567;
const CHAT_B = -1009999999;

beforeEach(() => {
  _resetAllLoopCounters();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('LP-1: MAX_BOT_TO_BOT_TURNS is 5 (v1.22.37 — dropped from 10)', () => {
    expect(MAX_BOT_TO_BOT_TURNS).toBe(5);
  });

  it('LP-2: LOOP_COUNTER_TTL_MS is 3_600_000', () => {
    expect(LOOP_COUNTER_TTL_MS).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// deriveThreadKey
// ---------------------------------------------------------------------------

describe('deriveThreadKey', () => {
  it('LP-3: with threadId produces <chatId>:<threadId>', () => {
    expect(deriveThreadKey(-100123, 456)).toBe('-100123:456');
  });

  it('LP-4: without threadId produces <chatId> only', () => {
    expect(deriveThreadKey(-100123, undefined)).toBe('-100123');
  });
});

// ---------------------------------------------------------------------------
// checkBotToBotLoop — empty / fresh state
// ---------------------------------------------------------------------------

describe('checkBotToBotLoop — empty state', () => {
  it('LP-5: fresh state returns allowed=true, count=0, cap=5', () => {
    const key = deriveThreadKey(CHAT_A, 1);
    expect(checkBotToBotLoop(key, NOW)).toEqual({ allowed: true, count: 0, cap: MAX_BOT_TO_BOT_TURNS });
  });
});

// ---------------------------------------------------------------------------
// recordBotToBotTurn + 3-turn cap
// ---------------------------------------------------------------------------

describe('recordBotToBotTurn + 3-turn cap', () => {
  it('LP-6: first turn → allowed; count becomes 1 after record', () => {
    const key = deriveThreadKey(CHAT_A, 10);
    const before = checkBotToBotLoop(key, NOW);
    expect(before.allowed).toBe(true);
    recordBotToBotTurn(key, NOW);
    expect(getBotToBotCount(key, NOW)).toBe(1);
  });

  it('LP-7: second turn → allowed; count becomes 2 after record', () => {
    const key = deriveThreadKey(CHAT_A, 11);
    recordBotToBotTurn(key, NOW);
    const check2 = checkBotToBotLoop(key, NOW);
    expect(check2.allowed).toBe(true);
    recordBotToBotTurn(key, NOW);
    expect(getBotToBotCount(key, NOW)).toBe(2);
  });

  it('LP-8: third turn → allowed; count becomes 3 after record', () => {
    const key = deriveThreadKey(CHAT_A, 12);
    recordBotToBotTurn(key, NOW);
    recordBotToBotTurn(key, NOW);
    const check3 = checkBotToBotLoop(key, NOW);
    expect(check3.allowed).toBe(true);
    recordBotToBotTurn(key, NOW);
    expect(getBotToBotCount(key, NOW)).toBe(3);
  });

  it('LP-9: turn at MAX (count=MAX_BOT_TO_BOT_TURNS) → allowed=false, loop protection engages', () => {
    const key = deriveThreadKey(CHAT_A, 13);
    for (let i = 0; i < MAX_BOT_TO_BOT_TURNS; i++) {
      recordBotToBotTurn(key, NOW);
    }
    const checkAfterCap = checkBotToBotLoop(key, NOW);
    expect(checkAfterCap.allowed).toBe(false);
    expect(checkAfterCap.count).toBe(MAX_BOT_TO_BOT_TURNS);
    expect(checkAfterCap.reason).toBe('cap');
  });
});

// ---------------------------------------------------------------------------
// resetBotToBotCounterOnUserMessage
// ---------------------------------------------------------------------------

describe('resetBotToBotCounterOnUserMessage', () => {
  it('LP-10: reset after MAX_BOT_TO_BOT_TURNS bot turns allows a fresh chain', () => {
    const key = deriveThreadKey(CHAT_A, 20);
    for (let i = 0; i < MAX_BOT_TO_BOT_TURNS; i++) {
      recordBotToBotTurn(key, NOW);
    }
    // Blocked
    expect(checkBotToBotLoop(key, NOW).allowed).toBe(false);

    // User message arrives
    resetBotToBotCounterOnUserMessage(key);

    // Counter reset — allowed again
    expect(checkBotToBotLoop(key, NOW)).toEqual({ allowed: true, count: 0, cap: MAX_BOT_TO_BOT_TURNS });
  });

  it('LP-11: reset on key with no prior turns is a no-op (no error)', () => {
    const key = deriveThreadKey(CHAT_B, 99);
    expect(() => resetBotToBotCounterOnUserMessage(key)).not.toThrow();
    expect(checkBotToBotLoop(key, NOW)).toEqual({ allowed: true, count: 0, cap: MAX_BOT_TO_BOT_TURNS });
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe('TTL expiry', () => {
  it('LP-12: counter older than TTL is treated as zero (allowed=true)', () => {
    const key = deriveThreadKey(CHAT_A, 30);
    // Record turns at NOW
    for (let i = 0; i < MAX_BOT_TO_BOT_TURNS; i++) {
      recordBotToBotTurn(key, NOW);
    }
    // Check at NOW + TTL + 1ms (expired)
    const expiredNow = NOW + LOOP_COUNTER_TTL_MS + 1;
    expect(checkBotToBotLoop(key, expiredNow)).toEqual({ allowed: true, count: 0, cap: MAX_BOT_TO_BOT_TURNS });
  });

  it('recordBotToBotTurn after TTL restarts counter at 1', () => {
    const key = deriveThreadKey(CHAT_A, 31);
    for (let i = 0; i < MAX_BOT_TO_BOT_TURNS; i++) {
      recordBotToBotTurn(key, NOW);
    }

    const expiredNow = NOW + LOOP_COUNTER_TTL_MS + 1;
    recordBotToBotTurn(key, expiredNow);
    expect(getBotToBotCount(key, expiredNow)).toBe(1);
    expect(checkBotToBotLoop(key, expiredNow).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-key isolation
// ---------------------------------------------------------------------------

describe('per-threadKey isolation', () => {
  it('LP-extra: counters are independent across different thread keys', () => {
    const keyA = deriveThreadKey(CHAT_A, 1);
    const keyB = deriveThreadKey(CHAT_B, 2);

    for (let i = 0; i < MAX_BOT_TO_BOT_TURNS; i++) {
      recordBotToBotTurn(keyA, NOW);
    }
    // A is blocked
    expect(checkBotToBotLoop(keyA, NOW).allowed).toBe(false);
    // B is independent — still allowed
    expect(checkBotToBotLoop(keyB, NOW)).toEqual({ allowed: true, count: 0, cap: MAX_BOT_TO_BOT_TURNS });
  });
});
