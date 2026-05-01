/**
 * Unit tests for src/coach/intensityTypes.ts (v1.19.0 D1 — added 'auto' as 5th value).
 * ADR 018 Decision 1 — closed-set membership and type guard.
 * ADR 019 Decision 1 — 'auto' as 5th value; back-compat default for legacy items.
 */

import { describe, it, expect } from 'vitest';
import { COACH_INTENSITIES, isCoachIntensity } from '../../src/coach/intensityTypes.js';

describe('COACH_INTENSITIES closed set', () => {
  it('contains exactly the five expected values (v1.19.0 D1: added auto)', () => {
    expect(Array.from(COACH_INTENSITIES)).toEqual(['off', 'gentle', 'moderate', 'persistent', 'auto']);
  });

  it('is readonly (TypeScript level; runtime check: frozen or plain tuple)', () => {
    // The 'as const' assertion makes it a readonly tuple; we verify length and members.
    expect(COACH_INTENSITIES).toHaveLength(5);
  });

  it('includes auto (v1.19.0 D1)', () => {
    expect(Array.from(COACH_INTENSITIES)).toContain('auto');
  });
});

describe('isCoachIntensity type guard', () => {
  it('returns true for each valid intensity', () => {
    expect(isCoachIntensity('off')).toBe(true);
    expect(isCoachIntensity('gentle')).toBe(true);
    expect(isCoachIntensity('moderate')).toBe(true);
    expect(isCoachIntensity('persistent')).toBe(true);
  });

  it('returns true for auto (v1.19.0 D1)', () => {
    expect(isCoachIntensity('auto')).toBe(true);
  });

  it('returns false for strings not in the set', () => {
    expect(isCoachIntensity('aggressive')).toBe(false);
    expect(isCoachIntensity('none')).toBe(false);
    expect(isCoachIntensity('')).toBe(false);
    expect(isCoachIntensity('OFF')).toBe(false); // case-sensitive
  });

  it('returns false for non-string primitives', () => {
    expect(isCoachIntensity(0)).toBe(false);
    expect(isCoachIntensity(null)).toBe(false);
    expect(isCoachIntensity(undefined)).toBe(false);
    expect(isCoachIntensity(true)).toBe(false);
  });

  it('returns false for objects', () => {
    expect(isCoachIntensity({ intensity: 'gentle' })).toBe(false);
    expect(isCoachIntensity(['gentle'])).toBe(false);
  });
});
