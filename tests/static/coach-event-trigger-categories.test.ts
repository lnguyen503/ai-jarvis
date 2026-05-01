/**
 * Static test — ADR 020 D14: coach event-trigger audit categories
 * are present in KNOWN_AUDIT_CATEGORIES.
 *
 * Parametric: asserts each of the 3 new categories (commit 6 adds these).
 * Binding: any category emitted by triggerFiring.ts MUST be in the closed set.
 *
 * ADR 020 Decision 14 + CP1 revisions R3.
 */

import { describe, it, expect } from 'vitest';
import { KNOWN_AUDIT_CATEGORIES } from '../../src/memory/auditLog.js';
import type { AuditCategory } from '../../src/memory/auditLog.js';

const EVENT_TRIGGER_CATEGORIES: AuditCategory[] = [
  'coach.event_trigger.fired',
  'coach.event_trigger.suppressed',
  'coach.global_quiet.engaged',
  // v1.20.0 R3.b migration categories
  'coach.migration_completed',
  'coach.migration_skipped',
  'coach.migration_conflict',
];

describe('ADR 020 D14: event-trigger audit categories in KNOWN_AUDIT_CATEGORIES', () => {
  it.each(EVENT_TRIGGER_CATEGORIES)(
    'KNOWN_AUDIT_CATEGORIES contains "%s"',
    (category) => {
      expect(KNOWN_AUDIT_CATEGORIES.has(category)).toBe(true);
    },
  );

  it('TRIGGER_REASONS closed set has 10 entries', async () => {
    const { TRIGGER_REASONS } = await import('../../src/coach/triggerFiring.js');
    expect(TRIGGER_REASONS.length).toBe(10);
  });

  it('buildTriggerReason maps all 10 triggerTypes to a TriggerReason', async () => {
    const { buildTriggerReason, TRIGGER_REASONS } = await import('../../src/coach/triggerFiring.js');
    const allTypes = [
      'due-in-24h-no-progress',
      'goal-stale-14d',
      'persistent-zero-engagement-7d',
      'new-vague-goal',
      'commitment',
      'blocker',
      'procrastination',
      'done-signal-confirmation',
      'recurring-meeting-detected',
      'standalone-meaningful-event',
    ] as const;

    for (const t of allTypes) {
      const reason = buildTriggerReason(t);
      expect(TRIGGER_REASONS).toContain(reason);
    }
  });
});
