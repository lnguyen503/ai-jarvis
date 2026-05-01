/**
 * Unit tests for src/organize/coachValidation.ts (v1.18.0).
 * ADR 018 Decision 1 — coach intensity + nudge count validators.
 */

import { describe, it, expect } from 'vitest';
import {
  validateCoachIntensity,
  validateCoachNudgeCount,
  COACH_INTENSITY_INVALID,
  COACH_NUDGE_COUNT_INVALID,
} from '../../src/organize/coachValidation.js';

describe('validateCoachIntensity', () => {
  describe('happy path — valid intensities', () => {
    it('accepts "off"', () => {
      const r = validateCoachIntensity('off');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('off');
    });

    it('accepts "gentle"', () => {
      const r = validateCoachIntensity('gentle');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('gentle');
    });

    it('accepts "moderate"', () => {
      const r = validateCoachIntensity('moderate');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('moderate');
    });

    it('accepts "persistent"', () => {
      const r = validateCoachIntensity('persistent');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('persistent');
    });
  });

  describe('sad path — invalid values', () => {
    it('rejects unknown string with COACH_INTENSITY_INVALID', () => {
      const r = validateCoachIntensity('aggressive');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(COACH_INTENSITY_INVALID);
        expect(r.message).toContain('coachIntensity');
      }
    });

    it('rejects empty string', () => {
      const r = validateCoachIntensity('');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(COACH_INTENSITY_INVALID);
    });

    it('rejects null', () => {
      const r = validateCoachIntensity(null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(COACH_INTENSITY_INVALID);
    });

    it('rejects number', () => {
      const r = validateCoachIntensity(2);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(COACH_INTENSITY_INVALID);
    });

    it('rejects uppercase "OFF" (case-sensitive)', () => {
      const r = validateCoachIntensity('OFF');
      expect(r.ok).toBe(false);
    });
  });
});

describe('validateCoachNudgeCount', () => {
  describe('happy path — valid counts', () => {
    it('accepts 0', () => {
      const r = validateCoachNudgeCount(0);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(0);
    });

    it('accepts positive integer', () => {
      const r = validateCoachNudgeCount(42);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(42);
    });

    it('accepts large integer', () => {
      const r = validateCoachNudgeCount(1000);
      expect(r.ok).toBe(true);
    });
  });

  describe('sad path — invalid values', () => {
    it('rejects negative integer with COACH_NUDGE_COUNT_INVALID', () => {
      const r = validateCoachNudgeCount(-1);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(COACH_NUDGE_COUNT_INVALID);
        expect(r.message).toContain('coachNudgeCount');
      }
    });

    it('rejects float', () => {
      const r = validateCoachNudgeCount(1.5);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(COACH_NUDGE_COUNT_INVALID);
    });

    it('rejects string', () => {
      const r = validateCoachNudgeCount('5');
      expect(r.ok).toBe(false);
    });

    it('rejects null', () => {
      const r = validateCoachNudgeCount(null);
      expect(r.ok).toBe(false);
    });

    it('rejects undefined', () => {
      const r = validateCoachNudgeCount(undefined);
      expect(r.ok).toBe(false);
    });
  });
});
