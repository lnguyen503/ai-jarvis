/**
 * Static test: v1.21.0 ADR 021 D18 — 8 new bot.* audit categories.
 *
 * Binding per ADR 021 D18 (amended by CP1 R1 + cross-review I2): every bot.*
 * emit point must have a corresponding category in the closed set
 * (KNOWN_AUDIT_CATEGORIES). This test ensures all 8 v1.21.0 bot.* categories
 * are registered and type-safe. Cross-review I2 added bot.self_message_dropped
 * (R2 self-echo drop emit point at gateway/index.ts:1006).
 *
 * Tests:
 *   T-AC21-1 — All 8 v1.21.0 bot.* categories are in KNOWN_AUDIT_CATEGORIES
 *   T-AC21-2 — All 8 categories are valid AuditCategory union members (type-safe)
 *   T-AC21-3 — No duplicate categories in KNOWN_AUDIT_CATEGORIES (closed-set discipline)
 *   T-AC21-4 — bot.tool_unauthorized is in KNOWN_AUDIT_CATEGORIES (GATE 1 audit — D6)
 *   T-AC21-5 — bot.migration_completed / skipped / failed / conflict are in set (R1)
 *   T-AC21-6 — bot.self_message_dropped is in KNOWN_AUDIT_CATEGORIES (cross-review I2)
 */

import { describe, it, expect } from 'vitest';
import { KNOWN_AUDIT_CATEGORIES } from '../../src/memory/auditLog.js';
import type { AuditCategory } from '../../src/memory/auditLog.js';

// The 8 new categories added in v1.21.0 per ADR 021 D18 (amended by CP1 R1 + cross-review I2).
const V1_21_0_BOT_CATEGORIES: AuditCategory[] = [
  'bot.self_message_dropped',
  'bot.tool_unauthorized',
  'bot.loop_protection.engaged',
  'bot.migration_completed',
  'bot.migration_skipped',
  'bot.migration_conflict',
  'bot.migration_failed',
  'bot.identity_resolved',
];

// ---------------------------------------------------------------------------
// T-AC21-1: All 7 v1.21.0 bot.* categories are in KNOWN_AUDIT_CATEGORIES
// ---------------------------------------------------------------------------

describe('T-AC21-1: v1.21.0 bot.* audit categories present in KNOWN_AUDIT_CATEGORIES', () => {
  it('all 8 new categories are registered in the closed set', () => {
    const missing: string[] = [];
    for (const cat of V1_21_0_BOT_CATEGORIES) {
      if (!KNOWN_AUDIT_CATEGORIES.has(cat)) {
        missing.push(cat);
      }
    }
    expect(
      missing,
      `Missing categories: ${missing.join(', ')}. Add them to KNOWN_AUDIT_CATEGORIES in src/memory/auditLog.ts.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-AC21-2: All 7 categories are valid AuditCategory union members (type-safe)
// ---------------------------------------------------------------------------

describe('T-AC21-2: v1.21.0 bot.* categories are valid AuditCategory union members', () => {
  it('all 8 categories are typed as AuditCategory (compile-time guarantee)', () => {
    // TypeScript compile-time check: if any string is NOT a valid AuditCategory,
    // the array assignment above will produce a TS2322 error.
    // At runtime, just verify the array length.
    expect(V1_21_0_BOT_CATEGORIES).toHaveLength(8);
    for (const cat of V1_21_0_BOT_CATEGORIES) {
      expect(typeof cat).toBe('string');
      expect(cat).toMatch(/^bot\./);
    }
  });
});

// ---------------------------------------------------------------------------
// T-AC21-3: No duplicate categories in KNOWN_AUDIT_CATEGORIES
// ---------------------------------------------------------------------------

describe('T-AC21-3: No duplicate categories in KNOWN_AUDIT_CATEGORIES (closed-set discipline)', () => {
  it('KNOWN_AUDIT_CATEGORIES has no duplicates', () => {
    const asArray = Array.from(KNOWN_AUDIT_CATEGORIES);
    const asSet = new Set(asArray);
    expect(
      asSet.size,
      'KNOWN_AUDIT_CATEGORIES has duplicate entries — each AuditCategory must appear exactly once.',
    ).toBe(asArray.length);
  });
});

// ---------------------------------------------------------------------------
// T-AC21-4: bot.tool_unauthorized present (GATE 1 audit path — D6)
// ---------------------------------------------------------------------------

describe('T-AC21-4: bot.tool_unauthorized is registered (GATE 1 audit — D6)', () => {
  it('bot.tool_unauthorized is in KNOWN_AUDIT_CATEGORIES', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('bot.tool_unauthorized')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-AC21-5: bot migration categories present (CP1 R1)
// ---------------------------------------------------------------------------

describe('T-AC21-5: bot.migration_* categories are registered (CP1 R1)', () => {
  it('bot.migration_completed is in KNOWN_AUDIT_CATEGORIES', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('bot.migration_completed')).toBe(true);
  });

  it('bot.migration_skipped is in KNOWN_AUDIT_CATEGORIES', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('bot.migration_skipped')).toBe(true);
  });

  it('bot.migration_failed is in KNOWN_AUDIT_CATEGORIES', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('bot.migration_failed')).toBe(true);
  });

  it('bot.migration_conflict is in KNOWN_AUDIT_CATEGORIES', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('bot.migration_conflict')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-AC21-6: bot.self_message_dropped present (cross-review I2)
// ---------------------------------------------------------------------------

describe('T-AC21-6: bot.self_message_dropped is registered (cross-review I2)', () => {
  it('bot.self_message_dropped is in KNOWN_AUDIT_CATEGORIES', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('bot.self_message_dropped')).toBe(true);
  });
});
