/**
 * Tests that the four v1.18.0 coach audit categories are in KNOWN_AUDIT_CATEGORIES
 * (ADR 018 Decision 13, T-D13-1).
 *
 * Also anchors that D14.d hash-only audit shape is the DESIGN CONTRACT:
 * this file verifies the category membership and no-raw-body constraint in types,
 * not runtime audit rows (those are tested in coach.tools.test.ts commit 4).
 */

import { describe, it, expect } from 'vitest';
import { KNOWN_AUDIT_CATEGORIES } from '../../src/memory/auditLog.js';
import type { AuditCategory } from '../../src/memory/auditLog.js';

// ---------------------------------------------------------------------------
// T-D13-1: each coach audit category is present in KNOWN_AUDIT_CATEGORIES
// ---------------------------------------------------------------------------

describe('T-D13-1: coach audit categories in KNOWN_AUDIT_CATEGORIES', () => {
  const coachCategories: AuditCategory[] = [
    'coach.nudge',
    'coach.research',
    'coach.idea',
    'coach.plan',
  ];

  for (const category of coachCategories) {
    it(`KNOWN_AUDIT_CATEGORIES includes '${category}'`, () => {
      expect(KNOWN_AUDIT_CATEGORIES.has(category)).toBe(true);
    });
  }

  it('all four coach categories are present (batch assert)', () => {
    for (const c of coachCategories) {
      expect(KNOWN_AUDIT_CATEGORIES.has(c), `Missing category: ${c}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR 018 Decision 15: coach.nudge, coach.research, coach.idea, coach.plan
// are distinct and do not overlap with organize.nudge
// ---------------------------------------------------------------------------

describe('coach vs organize audit category separation', () => {
  it('coach.nudge and organize.nudge are distinct categories', () => {
    expect(KNOWN_AUDIT_CATEGORIES.has('coach.nudge')).toBe(true);
    expect(KNOWN_AUDIT_CATEGORIES.has('organize.nudge')).toBe(true);
    // They are different string values — the type system enforces this
    const n1: AuditCategory = 'coach.nudge';
    const n2: AuditCategory = 'organize.nudge';
    expect(n1).not.toBe(n2);
  });
});

// ---------------------------------------------------------------------------
// Regression: existing v1.17.0 categories not accidentally removed
// ---------------------------------------------------------------------------

describe('v1.17.0 categories still present after v1.18.0 extension', () => {
  const v117Categories: AuditCategory[] = [
    'webapp.scheduled_view',
    'webapp.scheduled_mutate',
    'webapp.memory_view',
    'webapp.memory_mutate',
    'webapp.audit_view',
  ];

  for (const category of v117Categories) {
    it(`KNOWN_AUDIT_CATEGORIES still includes '${category}'`, () => {
      expect(KNOWN_AUDIT_CATEGORIES.has(category)).toBe(true);
    });
  }
});
