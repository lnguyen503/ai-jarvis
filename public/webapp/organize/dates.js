/**
 * @file Calendar-date helpers for the organize webapp.
 * @see {@link ../../docs/adr/015-v1.15.0-kanban-calendar.md} D2 + D3
 * @see {@link ../../docs/adr/015-revisions-after-cp1.md} W2 + W3
 *
 * Calendar-date semantics rationale (W3 binding — ADR 015 D3):
 *
 * RATIONALE: organize items use `due: 'YYYY-MM-DD'` (date only, no time).
 * The calendar view treats this as a calendar date, not a timestamp:
 *   `due: '2026-04-25'` always renders on April 25, regardless of viewer timezone.
 *
 * DO NOT introduce timezone conversion. v1.8.6 storage convention is timezone-naive;
 * forcing local-time conversion would render `2026-04-25T00:00Z` as April 24 in Pacific.
 * See ADR 015 D3 for full rationale.
 *
 * A user in Pacific creating a task at 11pm with `due: '2026-04-25'` expects the task
 * to render on April 25 (the calendar date they typed), not April 24 (the date
 * `2026-04-25T00:00Z` falls on in their local timezone).
 *
 * DO NOT "fix" this by converting to UTC midnight or to local midnight — both shift
 * the date near timezone boundaries, violating user intent.
 *
 * The chat-tool /organize parser has used calendar-date semantics since v1.8.6;
 * this module honors the same contract. Round-tripping through UTC conversion at
 * any layer breaks the wire-format invariant.
 *
 * REGRESSION TEST: tests/integration/organize.calendar-date-wire-format.test.ts
 * verifies all three writers (chat command, webapp PATCH, webapp create)
 * store the identical 'YYYY-MM-DD' string for the same input.
 *
 * ES module; pure functions; no DOM; no side effects. Vitest-importable.
 * No external deps (Anti-Slop §3 boundary — no date-fns).
 */

// ------------------------------------------------------------------
// W2 binding (ADR 015-revisions-after-cp1.md W2)
// ------------------------------------------------------------------

/** Regex for validating and parsing ISO calendar-date strings. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Documentation string for the wire format. Not a runtime parser format. */
export const ISO_DATE_FORMAT = 'YYYY-MM-DD';

// ------------------------------------------------------------------
// Core helpers
// ------------------------------------------------------------------

/**
 * Parse 'YYYY-MM-DD' into a UTC Date (midnight UTC). Returns null on malformed
 * OR on values that pass the regex but fail Date.UTC range check
 * (e.g., '2026-13-45', '2026-02-30' — both rejected).
 *
 * @param {string} s
 * @returns {Date|null}
 */
export function parseISO(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(date.getTime())) return null;
  // Round-trip check — reject values Date.UTC silently normalizes
  // (e.g., month=13 wraps into next year; day=30 for Feb wraps into March)
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/**
 * Format a Date into 'YYYY-MM-DD' using UTC components.
 * Returns the exact calendar date stored in the item's `due` field.
 *
 * @param {Date} d
 * @returns {string}
 */
export function formatISO(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Add n calendar days to d (UTC). Negative n moves backward.
 * Does NOT mutate d.
 *
 * @param {Date} d
 * @param {number} n
 * @returns {Date}
 */
export function addDays(d, n) {
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + n,
  ));
}

/**
 * Add n calendar months to d (UTC).
 * Date-clamps to end of month if the resulting month has fewer days
 * (e.g., addMonths('2026-01-31', 1) → '2026-02-28').
 *
 * @param {Date} d
 * @param {number} n
 * @returns {Date}
 */
export function addMonths(d, n) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const day = d.getUTCDate();
  // Date.UTC with day > days-in-month auto-wraps; clamp to end of month instead.
  const targetFirstOfMonth = new Date(Date.UTC(y, m, 1));
  const daysInTarget = new Date(Date.UTC(
    targetFirstOfMonth.getUTCFullYear(),
    targetFirstOfMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return new Date(Date.UTC(
    targetFirstOfMonth.getUTCFullYear(),
    targetFirstOfMonth.getUTCMonth(),
    Math.min(day, daysInTarget),
  ));
}

/**
 * Return the first day of the month containing d (UTC midnight).
 *
 * @param {Date} d
 * @returns {Date}
 */
export function firstOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Return the last day of the month containing d (UTC midnight).
 *
 * @param {Date} d
 * @returns {Date}
 */
export function lastOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/**
 * Return the first day of the week containing d.
 *
 * @param {Date} d
 * @param {number} [firstDayOfWeek=1]  0 = Sunday, 1 = Monday (ISO 8601 default)
 * @returns {Date}
 */
export function weekStart(d, firstDayOfWeek = 1) {
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // How many days to subtract to reach firstDayOfWeek
  const offset = (dow - firstDayOfWeek + 7) % 7;
  return addDays(d, -offset);
}

/**
 * Return the number of days in the month containing d.
 *
 * @param {Date} d
 * @returns {number}
 */
export function daysInMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Return true if a and b represent the same calendar day in UTC.
 *
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Return today as a UTC midnight Date (uses current UTC date).
 *
 * NOTE: "today" is defined as UTC's current calendar date. For users in extreme
 * timezones (UTC-12, UTC+14), this may briefly differ from their local calendar
 * date near midnight UTC. Documented as a known quirk in KNOWN_ISSUES.md entry 3.
 *
 * @returns {Date}
 */
export function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ------------------------------------------------------------------
// Month grid helper (used by calendar-view.js month rendering)
// ------------------------------------------------------------------

/**
 * Return the month-grid for the month containing d: 6 weeks × 7 days = 42 cells.
 * Each cell is { date: Date, inMonth: boolean }.
 *
 * The grid always starts on the day given by firstDayOfWeek and always has 42 cells
 * (6 complete weeks), covering all months including those that start on the
 * last weekday before firstDayOfWeek.
 *
 * @param {Date} d               — any date in the target month
 * @param {number} [firstDayOfWeek=1]  — 0=Sun, 1=Mon
 * @returns {Array<{date: Date, inMonth: boolean}>}
 */
export function monthGrid(d, firstDayOfWeek = 1) {
  const first = firstOfMonth(d);
  const last = lastOfMonth(d);
  const gridStart = weekStart(first, firstDayOfWeek);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = addDays(gridStart, i);
    const inMonth = cellDate.getUTCMonth() === d.getUTCMonth() &&
                    cellDate.getUTCFullYear() === d.getUTCFullYear();
    cells.push({ date: cellDate, inMonth });
  }
  return cells;
}

// ------------------------------------------------------------------
// Display formatting (locale-aware)
// ------------------------------------------------------------------

/**
 * Format a month label for display ("April 2026") in the user's locale.
 * Uses Intl.DateTimeFormat for locale awareness.
 * The DATE used for formatting is the first of the month in UTC; the locale
 * string is purely for display — it does NOT affect calendar grid math.
 *
 * @param {Date} d       — any date in the target month
 * @param {string} [locale='en-US']
 * @returns {string}
 */
export function formatMonthLabel(d, locale = 'en-US') {
  // Use a date at noon UTC to avoid any DST-boundary issues in Intl (defensive)
  const display = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15, 12, 0, 0));
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(display);
  } catch {
    // Fallback for environments without Intl (unit test jsdom)
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
}

/**
 * Format a day-of-week label ("Mon", "Tue", etc.) for the column header.
 *
 * @param {number} dayIdx        — 0-based index from firstDayOfWeek
 * @param {string} [locale='en-US']
 * @param {number} [firstDayOfWeek=1]  — 0=Sun, 1=Mon
 * @returns {string}
 */
export function formatDowLabel(dayIdx, locale = 'en-US', firstDayOfWeek = 1) {
  // Map dayIdx to an actual day-of-week (0=Sun...6=Sat)
  const dow = (firstDayOfWeek + dayIdx) % 7;
  // Use a known Sunday (2026-01-04) as base; add offset
  const sunday = new Date(Date.UTC(2026, 0, 4)); // known Sunday UTC
  const d = addDays(sunday, dow);
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(d);
  } catch {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return days[dow];
  }
}

/**
 * Format a due-date label for display in the list view (e.g., "Apr 25").
 *
 * @param {string} isoDate  — 'YYYY-MM-DD' string
 * @param {string} [locale='en-US']
 * @returns {string}  — formatted string, or the original string if parse fails
 */
export function formatDueLabel(isoDate, locale = 'en-US') {
  const d = parseISO(isoDate);
  if (!d) return isoDate;
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  } catch {
    return isoDate;
  }
}

/**
 * Return a UTC noon Date for d (same calendar day, time = 12:00:00 UTC).
 *
 * Used when passing a calendar-date Date to Intl.DateTimeFormat to avoid
 * DST-boundary artefacts: some Intl implementations shift the displayed date
 * when the timestamp is near UTC midnight and the format's timeZone is 'UTC'.
 * Noon UTC is safely in the middle of the calendar day and is immune to this.
 *
 * This is the sole authorised site for UTC noon construction (CLAUDE.md
 * invariant 2: dates.js is the only source of date arithmetic).
 *
 * @param {Date} d  — any Date; only UTC year/month/day are used
 * @returns {Date}
 */
export function noonOfDayUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
}
