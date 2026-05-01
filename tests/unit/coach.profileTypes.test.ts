/**
 * Unit tests for src/coach/profileTypes.ts (v1.20.0 commit 1).
 *
 * Tests:
 *   - COACH_PROFILES closed set
 *   - isCoachProfile type guard
 *   - parseHHMM parser
 *   - parseWeeklyDay parser
 */

import { describe, it, expect } from 'vitest';
import {
  COACH_PROFILES,
  isCoachProfile,
  parseHHMM,
  parseWeeklyDay,
} from '../../src/coach/profileTypes.js';

// ---------------------------------------------------------------------------
// COACH_PROFILES
// ---------------------------------------------------------------------------

describe('COACH_PROFILES', () => {
  it('has exactly 4 profiles', () => {
    expect(COACH_PROFILES).toHaveLength(4);
  });

  it('contains the expected profiles', () => {
    expect(COACH_PROFILES).toContain('morning');
    expect(COACH_PROFILES).toContain('midday');
    expect(COACH_PROFILES).toContain('evening');
    expect(COACH_PROFILES).toContain('weekly');
  });
});

// ---------------------------------------------------------------------------
// isCoachProfile
// ---------------------------------------------------------------------------

describe('isCoachProfile', () => {
  it('returns true for morning', () => {
    expect(isCoachProfile('morning')).toBe(true);
  });

  it('returns true for midday', () => {
    expect(isCoachProfile('midday')).toBe(true);
  });

  it('returns true for evening', () => {
    expect(isCoachProfile('evening')).toBe(true);
  });

  it('returns true for weekly', () => {
    expect(isCoachProfile('weekly')).toBe(true);
  });

  it('returns false for unknown string', () => {
    expect(isCoachProfile('afternoon')).toBe(false);
    expect(isCoachProfile('')).toBe(false);
    expect(isCoachProfile('MORNING')).toBe(false); // case-sensitive
  });

  it('returns false for non-string values', () => {
    expect(isCoachProfile(null)).toBe(false);
    expect(isCoachProfile(undefined)).toBe(false);
    expect(isCoachProfile(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseHHMM
// ---------------------------------------------------------------------------

describe('parseHHMM', () => {
  it('parses 08:00 correctly', () => {
    const result = parseHHMM('08:00');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hour).toBe(8);
      expect(result.minute).toBe(0);
    }
  });

  it('parses 14:30 correctly', () => {
    const result = parseHHMM('14:30');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hour).toBe(14);
      expect(result.minute).toBe(30);
    }
  });

  it('parses 23:59 correctly', () => {
    const result = parseHHMM('23:59');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hour).toBe(23);
      expect(result.minute).toBe(59);
    }
  });

  it('parses 0:00 correctly (no leading zero)', () => {
    const result = parseHHMM('0:00');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hour).toBe(0);
      expect(result.minute).toBe(0);
    }
  });

  it('returns ok:false for invalid format "abc"', () => {
    expect(parseHHMM('abc').ok).toBe(false);
  });

  it('returns ok:false for 24:00 (hour out of range)', () => {
    expect(parseHHMM('24:00').ok).toBe(false);
  });

  it('returns ok:false for 08:60 (minute out of range)', () => {
    expect(parseHHMM('08:60').ok).toBe(false);
  });

  it('returns ok:false for empty string', () => {
    expect(parseHHMM('').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWeeklyDay
// ---------------------------------------------------------------------------

describe('parseWeeklyDay', () => {
  it('parses mon as 1', () => {
    const result = parseWeeklyDay('mon');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.day).toBe(1);
  });

  it('parses monday (full name) as 1', () => {
    const result = parseWeeklyDay('monday');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.day).toBe(1);
  });

  it('parses sun as 0', () => {
    const result = parseWeeklyDay('sun');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.day).toBe(0);
  });

  it('parses sat as 6', () => {
    const result = parseWeeklyDay('sat');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.day).toBe(6);
  });

  it('is case-insensitive (MON → 1)', () => {
    const result = parseWeeklyDay('MON');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.day).toBe(1);
  });

  it('returns ok:false for invalid day', () => {
    expect(parseWeeklyDay('funday').ok).toBe(false);
    expect(parseWeeklyDay('').ok).toBe(false);
  });
});
