/**
 * Coach profile types and closed-set constants (v1.20.0 commit 1).
 *
 * Pillar 1: Multi-coach profiles — up to 4 distinct coach schedules per user.
 * Each profile maps to a sentinel description marker for the scheduled task.
 *
 * Dependency edges (binding per ADR 020 D1 + D16):
 *   profileTypes.ts → (no internal deps; pure types + helpers only)
 *   NO import from agent/, tools/, memory/, commands/, or other coach/ modules.
 *
 * Static test: tests/static/coach-profile-closed-set.test.ts asserts
 *   COACH_PROFILES.length === 4 (ADR 020 D1 binding).
 *
 * ADR 020 Decision 1 + Decision 2.
 */

// ---------------------------------------------------------------------------
// Closed set of profile names (ADR 020 D1)
// ---------------------------------------------------------------------------

/**
 * The closed set of coach profile names.
 *
 * BINDING (ADR 020 D1): exactly 4 profiles. Static test asserts length === 4.
 * Adding a 5th profile requires: update this array + add marker constant +
 * update webapp UI + update migration if back-compat needed.
 */
export const COACH_PROFILES = ['morning', 'midday', 'evening', 'weekly'] as const;

/** Union type derived from the closed set. */
export type CoachProfile = typeof COACH_PROFILES[number];

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Type guard: returns true iff `value` is a valid CoachProfile string.
 * ADR 020 D1.
 */
export function isCoachProfile(value: unknown): value is CoachProfile {
  return typeof value === 'string' && (COACH_PROFILES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parsing helpers (ADR 020 D1 — parseHHMM + parseWeeklyDay live here per D1)
// ---------------------------------------------------------------------------

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Parse a HH:MM string into hour + minute numbers.
 *
 * Returns `{ ok: true; hour: number; minute: number }` on success.
 * Returns `{ ok: false }` if the string doesn't match HH:MM format.
 *
 * ADR 020 D1 (placed here per "PICK: NEW src/coach/profileTypes.ts").
 */
export function parseHHMM(s: string): { ok: true; hour: number; minute: number } | { ok: false } {
  if (!HHMM_RE.test(s)) return { ok: false };
  const [hPart, mPart] = s.split(':');
  const hour = parseInt(hPart!, 10);
  const minute = parseInt(mPart!, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return { ok: false };
  return { ok: true, hour, minute };
}

/** Weekday name → 0-6 (Sunday=0, Monday=1, ..., Saturday=6) */
const WEEKDAY_MAP: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/**
 * Parse a weekday name (case-insensitive) to a 0-6 integer (Sunday=0).
 *
 * Returns `{ ok: true; day: 0|1|2|3|4|5|6 }` on success.
 * Returns `{ ok: false }` if the string is not a recognized weekday.
 *
 * ADR 020 D1.
 */
export function parseWeeklyDay(s: string): { ok: true; day: 0 | 1 | 2 | 3 | 4 | 5 | 6 } | { ok: false } {
  const lower = s.toLowerCase().trim();
  const day = WEEKDAY_MAP[lower];
  if (day === undefined) return { ok: false };
  return { ok: true, day: day as 0 | 1 | 2 | 3 | 4 | 5 | 6 };
}
