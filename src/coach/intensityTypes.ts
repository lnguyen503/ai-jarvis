/**
 * Coach intensity type definitions (v1.19.0).
 *
 * ADR 018 Decision 1: per-item coach intensity dial with four levels.
 * ADR 019 Decision 1: 'auto' added as the 5th value (v1.19.0 D1).
 *   'auto' = infer intensity from item shape at prompt-processing time.
 *   Inference rules live in coachPrompt.md "Auto-intensity inference" section.
 * Used by organize frontmatter, validators, coach memory tools, and the coach prompt.
 */

export const COACH_INTENSITIES = ['off', 'gentle', 'moderate', 'persistent', 'auto'] as const;
export type CoachIntensity = typeof COACH_INTENSITIES[number];

/**
 * Type guard: returns true when value is a valid CoachIntensity.
 * Used by the coach validator and the frontmatter parser.
 */
export function isCoachIntensity(value: unknown): value is CoachIntensity {
  return typeof value === 'string' && (COACH_INTENSITIES as readonly string[]).includes(value);
}
