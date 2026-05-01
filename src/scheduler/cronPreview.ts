/**
 * Cron preview iterator — roll-our-own bounded cron fire-time calculator (v1.17.0).
 *
 * ADR 017 R1 (BLOCKING): `cron-parser` REJECTED (would add a new npm dep).
 * Roll-our-own ~120-LOC pure-JS bounded iterator. ZERO external dependencies.
 * node-cron stays as the only existing cron library (used in scheduler/index.ts
 * for actual scheduling); this is a sibling-helper for the preview endpoint.
 *
 * Algorithm:
 *   1. Parse the 5-field cron expression into 5 match-Sets (bitmaps).
 *   2. Walk minute-by-minute from now+1 minute.
 *   3. Collect the first MAX_PREVIEW_RESULTS matches.
 *   4. Dual termination: stop at MAX_PREVIEW_ITERATIONS OR MAX_PREVIEW_RESULTS.
 *
 * Day-of-week: 0 = Sunday, 7 = alias for Sunday (mapped to 0).
 * Month: 1..12. DOM: 1..31.
 *
 * No-fire expressions (Feb 31, Apr 31, etc.) iterate the full year and return
 * ok:true with fireTimes:[] + a descriptive warning.
 */

import cron from 'node-cron';

// ---------------------------------------------------------------------------
// Constants (ADR 017 R2 binding)
// ---------------------------------------------------------------------------

/** Maximum iterations per preview call (1 year = 365 × 1440 minutes). */
export const MAX_PREVIEW_ITERATIONS = 525_600;

/** Maximum fire times returned per preview call. */
export const MAX_PREVIEW_RESULTS = 5;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface PreviewResult {
  ok: true;
  fireTimes: string[];  // ISO 8601 UTC; up to MAX_PREVIEW_RESULTS; empty = no fire in next year
  warning?: string;     // populated when fireTimes.length < MAX_PREVIEW_RESULTS at exhaustion
}

export interface PreviewError {
  ok: false;
  code: 'INVALID_CRON';
  error: string;        // human-readable reason
}

// ---------------------------------------------------------------------------
// Internal parse types
// ---------------------------------------------------------------------------

interface ParsedCron {
  minute: Set<number>;  // 0..59
  hour: Set<number>;    // 0..23
  dom: Set<number>;     // 1..31
  month: Set<number>;   // 1..12
  dow: Set<number>;     // 0..6 (7 → 0 alias resolved at parse time)
}

// ---------------------------------------------------------------------------
// Field parser
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field into a Set of integers.
 *
 * Supports:
 *   - `*`          → all values in [min, max]
 *   - `*\/N`       → every N steps (N > 0, N ≤ max-min+1)
 *   - `A-B`        → range [A, B] inclusive
 *   - `A-B\/N`     → range with step
 *   - `A,B,C,...`  → list of individual values or sub-expressions
 *   - Plain integer → single value
 *
 * Returns null on any validation error.
 *
 * @param field  Raw field string from the cron expression.
 * @param min    Minimum valid value (inclusive).
 * @param max    Maximum valid value (inclusive).
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  // Handle comma-separated lists by recursing on each element.
  if (field.includes(',')) {
    const result = new Set<number>();
    for (const part of field.split(',')) {
      const sub = parseField(part.trim(), min, max);
      if (sub === null) return null;
      for (const v of sub) result.add(v);
    }
    return result;
  }

  // Handle step expressions: `*/N` or `A-B/N`
  if (field.includes('/')) {
    const slashIdx = field.indexOf('/');
    const base = field.slice(0, slashIdx);
    const stepStr = field.slice(slashIdx + 1);

    // Step must be a positive integer
    if (!/^\d+$/.test(stepStr)) return null;
    const step = parseInt(stepStr, 10);
    if (step === 0) return null; // */0 is invalid (R1 binding)
    if (step < 0) return null;

    let rangeMin = min;
    let rangeMax = max;

    if (base !== '*') {
      // base must be A-B or a single number
      if (base.includes('-')) {
        const dashIdx = base.indexOf('-');
        const aStr = base.slice(0, dashIdx);
        const bStr = base.slice(dashIdx + 1);
        if (!/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) return null;
        rangeMin = parseInt(aStr, 10);
        rangeMax = parseInt(bStr, 10);
        if (rangeMin < min || rangeMax > max || rangeMin > rangeMax) return null;
      } else {
        if (!/^\d+$/.test(base)) return null;
        rangeMin = parseInt(base, 10);
        if (rangeMin < min || rangeMin > max) return null;
        rangeMax = max;
      }
    }

    const result = new Set<number>();
    for (let v = rangeMin; v <= rangeMax; v += step) result.add(v);
    return result.size > 0 ? result : null;
  }

  // Handle range: `A-B`
  if (field.includes('-')) {
    const dashIdx = field.indexOf('-');
    const aStr = field.slice(0, dashIdx);
    const bStr = field.slice(dashIdx + 1);
    if (!/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) return null;
    const a = parseInt(aStr, 10);
    const b = parseInt(bStr, 10);
    if (a < min || b > max || a > b) return null;
    const result = new Set<number>();
    for (let v = a; v <= b; v++) result.add(v);
    return result;
  }

  // Wildcard
  if (field === '*') {
    const result = new Set<number>();
    for (let v = min; v <= max; v++) result.add(v);
    return result;
  }

  // Plain integer
  if (!/^\d+$/.test(field)) return null;
  const v = parseInt(field, 10);
  if (v < min || v > max) return null;
  return new Set([v]);
}

// ---------------------------------------------------------------------------
// Expression parser
// ---------------------------------------------------------------------------

/**
 * Parse a 5-field cron expression into bitmaps.
 *
 * Returns null with a reason string on any validation failure.
 * Validates each field range strictly per ADR 017 R1 binding.
 */
function parseCronExpr(expr: string): { parsed: ParsedCron } | { error: string } {
  if (typeof expr !== 'string') return { error: 'Expression must be a string' };

  // Reject oversized strings (defense against O(n) attacks)
  if (expr.length > 256) return { error: 'Expression too long (max 256 chars)' };

  // Reject non-ASCII (unicode garbage)
  if (!/^[\x20-\x7e]+$/.test(expr)) return { error: 'Expression contains non-ASCII characters' };

  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { error: `Expected 5 fields, got ${fields.length}` };
  }

  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];

  // Validate individual fields with their ranges
  const minute = parseField(minuteF, 0, 59);
  if (minute === null) return { error: 'Minute field out of range (0..59) or invalid syntax' };

  const hour = parseField(hourF, 0, 23);
  if (hour === null) return { error: 'Hour field out of range (0..23) or invalid syntax' };

  const dom = parseField(domF, 1, 31);
  if (dom === null) return { error: 'Day-of-month field out of range (1..31) or invalid syntax' };

  const month = parseField(monthF, 1, 12);
  if (month === null) return { error: 'Month field out of range (1..12) or invalid syntax' };

  // DOW: 0..7 where 7 is alias for Sunday (0)
  const dowRaw = parseField(dowF, 0, 7);
  if (dowRaw === null) return { error: 'Day-of-week field out of range (0..7) or invalid syntax' };

  // Normalize 7 → 0 (Sunday alias)
  const dow = new Set<number>();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);

  // Additional rejection: explicit */0 in any field is already handled by parseField
  // returning null for step=0. But double-check for "0" step in raw strings as an
  // extra safety net:
  if (/\/0(?:\s|$)/.test(expr)) {
    return { error: 'Step values cannot be zero (*/0 not allowed)' };
  }

  return { parsed: { minute, hour, dom, month, dow } };
}

// ---------------------------------------------------------------------------
// Days-in-month helper (for no-fire expression detection context)
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  // month is 1-based
  return new Date(year, month, 0).getDate();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute the next up to MAX_PREVIEW_RESULTS fire times for a cron expression.
 *
 * Walks minute-by-minute from `now + 1 minute` for up to MAX_PREVIEW_ITERATIONS
 * iterations (1 year). Returns an array of ISO 8601 UTC strings.
 *
 * Dual termination (ADR 017 R2):
 *   - stops when fireTimes.length >= MAX_PREVIEW_RESULTS, OR
 *   - stops when iterations >= MAX_PREVIEW_ITERATIONS
 *
 * No-fire expressions (Feb 31, Apr 31, etc.) exhaust the iterator and return
 * ok:true with fireTimes:[] + a warning string.
 *
 * @param expr   5-field cron expression string.
 * @param now    Optional reference time (defaults to Date.now()). Used for deterministic tests.
 */
export function previewCronFireTimes(expr: string, now?: Date): PreviewResult | PreviewError {
  // 1. node-cron syntax check (fast pre-filter)
  if (!cron.validate(expr)) {
    return {
      ok: false,
      code: 'INVALID_CRON',
      error: `Invalid cron expression: ${expr}`,
    };
  }

  // 2. Our strict parser (catches */0, extra/missing fields, negatives, unicode)
  const parseResult = parseCronExpr(expr);
  if ('error' in parseResult) {
    return {
      ok: false,
      code: 'INVALID_CRON',
      error: parseResult.error,
    };
  }

  const { parsed } = parseResult;

  // 3. Walk minute-by-minute from now + 1 minute
  const baseMs = now ? now.getTime() : Date.now();
  // Start at the next whole minute after now
  const startMs = (Math.floor(baseMs / 60_000) + 1) * 60_000;

  const fireTimes: string[] = [];
  let iterations = 0;

  while (iterations < MAX_PREVIEW_ITERATIONS && fireTimes.length < MAX_PREVIEW_RESULTS) {
    const cur = new Date(startMs + iterations * 60_000);

    const curMinute = cur.getUTCMinutes();
    const curHour = cur.getUTCHours();
    const curDom = cur.getUTCDate();
    const curMonth = cur.getUTCMonth() + 1; // 1-based
    const curDow = cur.getUTCDay();         // 0 = Sunday

    // Check dom upper bound for this month (skip impossible dates)
    const maxDays = daysInMonth(cur.getUTCFullYear(), curMonth);
    // O(1) Set.has() lookup — was O(N) [...parsed.dom].some(); equivalent result (Fix 6 / F3 closure).
    const domMatch = parsed.dom.size > 0 && curDom <= maxDays && parsed.dom.has(curDom);

    if (
      parsed.minute.has(curMinute) &&
      parsed.hour.has(curHour) &&
      domMatch &&
      parsed.month.has(curMonth) &&
      parsed.dow.has(curDow)
    ) {
      fireTimes.push(cur.toISOString());
    }

    iterations++;
  }

  // 4. Determine result + warning
  if (fireTimes.length === 0) {
    return {
      ok: true,
      fireTimes: [],
      warning:
        "This expression doesn't fire in the next 365 days — check the day-of-month + month combination.",
    };
  }

  if (iterations >= MAX_PREVIEW_ITERATIONS && fireTimes.length < MAX_PREVIEW_RESULTS) {
    return {
      ok: true,
      fireTimes,
      warning: `Iteration cap reached after collecting ${fireTimes.length} fire time(s) in 365 days.`,
    };
  }

  return { ok: true, fireTimes };
}
