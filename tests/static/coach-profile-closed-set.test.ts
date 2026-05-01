/**
 * Static test — ADR 020 D1: COACH_PROFILES closed set.
 *
 * Binding assertions:
 *   1. COACH_PROFILES has exactly 4 members.
 *   2. Expected profiles: morning, midday, evening, weekly.
 *   3. COACH_MARKER_BY_PROFILE has entries for all 4 profiles.
 *   4. All profile markers start with '__coach_' and end with '__'.
 *   5. COACH_PROFILE_MARKERS Set has 4 members (no duplicates).
 *   6. LEGACY_COACH_MARKER === '__coach__'.
 *
 * ADR 020 D1 + D2 commit 1.
 */

import { describe, it, expect } from 'vitest';
import {
  COACH_PROFILES,
  COACH_MARKER_BY_PROFILE,
  COACH_PROFILE_MARKERS,
  LEGACY_COACH_MARKER,
} from '../../src/coach/index.js';

describe('ADR 020 D1: COACH_PROFILES closed set', () => {
  it('has exactly 4 profiles', () => {
    expect(COACH_PROFILES).toHaveLength(4);
  });

  it('contains morning, midday, evening, weekly in order', () => {
    expect(Array.from(COACH_PROFILES)).toEqual(['morning', 'midday', 'evening', 'weekly']);
  });

  it('includes morning', () => {
    expect(COACH_PROFILES).toContain('morning');
  });

  it('includes midday', () => {
    expect(COACH_PROFILES).toContain('midday');
  });

  it('includes evening', () => {
    expect(COACH_PROFILES).toContain('evening');
  });

  it('includes weekly', () => {
    expect(COACH_PROFILES).toContain('weekly');
  });
});

describe('ADR 020 D2: COACH_MARKER_BY_PROFILE marker convention', () => {
  it('has an entry for all 4 profiles', () => {
    for (const profile of COACH_PROFILES) {
      expect(COACH_MARKER_BY_PROFILE[profile]).toBeDefined();
    }
  });

  it('all markers start with __coach_', () => {
    for (const profile of COACH_PROFILES) {
      const marker = COACH_MARKER_BY_PROFILE[profile];
      expect(marker).toBeDefined();
      expect(marker!.startsWith('__coach_')).toBe(true);
    }
  });

  it('all markers end with __', () => {
    for (const profile of COACH_PROFILES) {
      const marker = COACH_MARKER_BY_PROFILE[profile];
      expect(marker!.endsWith('__')).toBe(true);
    }
  });

  it('morning marker is __coach_morning__', () => {
    expect(COACH_MARKER_BY_PROFILE.morning).toBe('__coach_morning__');
  });

  it('midday marker is __coach_midday__', () => {
    expect(COACH_MARKER_BY_PROFILE.midday).toBe('__coach_midday__');
  });

  it('evening marker is __coach_evening__', () => {
    expect(COACH_MARKER_BY_PROFILE.evening).toBe('__coach_evening__');
  });

  it('weekly marker is __coach_weekly__', () => {
    expect(COACH_MARKER_BY_PROFILE.weekly).toBe('__coach_weekly__');
  });
});

describe('ADR 020 D2: COACH_PROFILE_MARKERS set', () => {
  it('contains exactly 4 unique markers', () => {
    expect(COACH_PROFILE_MARKERS.size).toBe(4);
  });

  it('contains all profile marker values', () => {
    for (const profile of COACH_PROFILES) {
      expect(COACH_PROFILE_MARKERS.has(COACH_MARKER_BY_PROFILE[profile]!)).toBe(true);
    }
  });
});

describe('ADR 020 D2: LEGACY_COACH_MARKER', () => {
  it('equals __coach__', () => {
    expect(LEGACY_COACH_MARKER).toBe('__coach__');
  });

  it('is NOT in COACH_PROFILE_MARKERS (it is separate)', () => {
    expect(COACH_PROFILE_MARKERS.has(LEGACY_COACH_MARKER)).toBe(false);
  });
});
