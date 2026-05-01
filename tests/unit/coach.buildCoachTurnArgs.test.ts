/**
 * Unit tests for buildCoachTurnArgs() helper (v1.20.0 commit 1, ADR 020 R1).
 *
 * T-R1-1 — no-args returns canonical shape with isSpontaneousTrigger=false.
 * T-R1-2 — spontaneous fire sets isSpontaneousTrigger=true + triggerContext.
 * Additional: verifies isCoachRun is always true, coachTurnCounters always present.
 */

import { describe, it, expect } from 'vitest';
import { buildCoachTurnArgs } from '../../src/coach/index.js';

describe('buildCoachTurnArgs (ADR 020 R1)', () => {
  it('T-R1-1: no args returns canonical scheduled-fire shape', () => {
    const result = buildCoachTurnArgs();
    expect(result.isCoachRun).toBe(true);
    expect(result.isSpontaneousTrigger).toBe(false);
    expect(result.triggerContext).toBe('');
    expect(result.coachTurnCounters).toEqual({ nudges: 0, writes: 0 });
  });

  it('T-R1-2: spontaneous trigger sets correct flags', () => {
    const result = buildCoachTurnArgs({
      isSpontaneousTrigger: true,
      triggerContext: 'Trigger source: item-state\nFocus item: abc123',
    });
    expect(result.isCoachRun).toBe(true);
    expect(result.isSpontaneousTrigger).toBe(true);
    expect(result.triggerContext).toBe('Trigger source: item-state\nFocus item: abc123');
    expect(result.coachTurnCounters).toEqual({ nudges: 0, writes: 0 });
  });

  it('isCoachRun is always true (the load-bearing flag)', () => {
    expect(buildCoachTurnArgs().isCoachRun).toBe(true);
    expect(buildCoachTurnArgs({ isSpontaneousTrigger: true }).isCoachRun).toBe(true);
    expect(buildCoachTurnArgs({ isSpontaneousTrigger: false }).isCoachRun).toBe(true);
  });

  it('coachTurnCounters always starts at zero', () => {
    const result = buildCoachTurnArgs({ isSpontaneousTrigger: true });
    expect(result.coachTurnCounters.nudges).toBe(0);
    expect(result.coachTurnCounters.writes).toBe(0);
  });

  it('empty opts object is equivalent to no args', () => {
    const noArgs = buildCoachTurnArgs();
    const emptyOpts = buildCoachTurnArgs({});
    expect(noArgs).toEqual(emptyOpts);
  });

  it('missing triggerContext defaults to empty string', () => {
    const result = buildCoachTurnArgs({ isSpontaneousTrigger: true });
    expect(result.triggerContext).toBe('');
  });
});
