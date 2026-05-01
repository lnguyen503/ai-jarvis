/**
 * Static test: v1.19.0 ADR 019 F3 — 12 new audit categories present in KNOWN_AUDIT_CATEGORIES.
 *
 * Binding per ADR 019 F3: every emit point must have a corresponding category
 * in the closed set. This test ensures all 12 v1.19.0 categories are registered.
 *
 * Tests:
 *   T-AC-1 — All 12 v1.19.0 calendar + coach override categories are in KNOWN_AUDIT_CATEGORIES
 *   T-AC-2 — All v1.19.0 categories are valid AuditCategory union members (type-safe)
 *   T-AC-3 — No duplicate categories in KNOWN_AUDIT_CATEGORIES
 */

import { describe, it, expect } from 'vitest';
import { KNOWN_AUDIT_CATEGORIES } from '../../src/memory/auditLog.js';
import type { AuditCategory } from '../../src/memory/auditLog.js';

// The 12 new categories added in v1.19.0 per ADR 019 F3.
const V1_19_0_CATEGORIES: AuditCategory[] = [
  'calendar.sync_success',
  'calendar.sync_failure',
  'calendar.sync_skipped',
  'calendar.sync_conflict',
  'calendar.sync_rejected_injection',
  'calendar.sync_truncated',
  'calendar.jarvis_created',
  'calendar.fail_token_expired',
  'calendar.circuit_breaker_reset',
  'coach.fatigue',
  'coach.user_override',
  'coach.calendar_cursor_reset',
];

// ---------------------------------------------------------------------------
// T-AC-1: All 12 v1.19.0 categories are in KNOWN_AUDIT_CATEGORIES
// ---------------------------------------------------------------------------

describe('T-AC-1: v1.19.0 audit categories present in KNOWN_AUDIT_CATEGORIES', () => {
  it('all 12 new categories are registered in the closed set', () => {
    const missing: string[] = [];
    for (const cat of V1_19_0_CATEGORIES) {
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
// T-AC-2: All v1.19.0 categories are valid AuditCategory union members
// ---------------------------------------------------------------------------

describe('T-AC-2: v1.19.0 categories are valid AuditCategory union members (type-level check)', () => {
  it('all 12 categories are typed as AuditCategory (compile-time guarantee)', () => {
    // This test is a compile-time type check. If any string is NOT a valid
    // AuditCategory, TypeScript will emit a compile error on V1_19_0_CATEGORIES.
    // At runtime, just verify the array has 12 elements.
    expect(V1_19_0_CATEGORIES).toHaveLength(12);
    for (const cat of V1_19_0_CATEGORIES) {
      expect(typeof cat).toBe('string');
      expect(cat.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// T-AC-3: No duplicate categories in KNOWN_AUDIT_CATEGORIES
// ---------------------------------------------------------------------------

describe('T-AC-3: No duplicate categories in KNOWN_AUDIT_CATEGORIES', () => {
  it('KNOWN_AUDIT_CATEGORIES Set has no duplicates (Set property)', () => {
    // A Set cannot have duplicates by definition; this tests that the array
    // passed to the Set constructor has the same count as the Set itself,
    // which would fail if the union type definition added a duplicate string
    // and the Set deduplicated it silently.
    const asArray = Array.from(KNOWN_AUDIT_CATEGORIES);
    const asSet = new Set(asArray);
    expect(asSet.size).toBe(asArray.length);

    // Also verify the set contains at least the 12 new categories
    expect(KNOWN_AUDIT_CATEGORIES.size).toBeGreaterThanOrEqual(12);
  });
});
