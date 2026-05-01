/**
 * Coach intensity validators (v1.18.0).
 *
 * Extracted from organize/validation.ts per ADR 018-revisions W1 to keep
 * validation.ts under the 500 LOC soft threshold once coach fields land.
 *
 * ADR 018 Decision 1: per-item coach intensity validation.
 */

import { COACH_INTENSITIES, isCoachIntensity } from '../coach/intensityTypes.js';
import type { CoachIntensity } from '../coach/intensityTypes.js';

// ---------------------------------------------------------------------------
// Error codes (added to the shared ValidatorErrorCode union in validation.ts)
// ---------------------------------------------------------------------------

/**
 * Error code for invalid coachIntensity value (not in closed set).
 * Added to ValidatorErrorCode in validation.ts per ADR 018.
 */
export const COACH_INTENSITY_INVALID = 'COACH_INTENSITY_INVALID' as const;

/**
 * Error code for invalid coachNudgeCount (not a non-negative integer).
 * Added to ValidatorErrorCode in validation.ts per ADR 018.
 */
export const COACH_NUDGE_COUNT_INVALID = 'COACH_NUDGE_COUNT_INVALID' as const;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export type CoachValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/**
 * Validate a coachIntensity value.
 * Accepts: 'off' | 'gentle' | 'moderate' | 'persistent' | 'auto' (closed set, v1.19.0 D1).
 * Rejects anything else with COACH_INTENSITY_INVALID.
 */
export function validateCoachIntensity(
  value: unknown,
): CoachValidationResult<CoachIntensity> {
  if (!isCoachIntensity(value)) {
    return {
      ok: false,
      code: COACH_INTENSITY_INVALID,
      message: `Field "coachIntensity" must be one of: ${COACH_INTENSITIES.join(', ')}. Got: ${JSON.stringify(value)}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Validate a coachNudgeCount value.
 * Accepts: non-negative integer (0 or positive integer).
 * Rejects floats, strings, negative numbers with COACH_NUDGE_COUNT_INVALID.
 */
export function validateCoachNudgeCount(
  value: unknown,
): CoachValidationResult<number> {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return {
      ok: false,
      code: COACH_NUDGE_COUNT_INVALID,
      message: `Field "coachNudgeCount" must be a non-negative integer. Got: ${JSON.stringify(value)}.`,
    };
  }
  return { ok: true, value };
}
