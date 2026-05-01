/**
 * Unit tests for public/webapp/organize/dates.js
 *
 * Jarvis v1.15.0 — ADR 015 D2 + D3 + W2 + W3
 *
 * Tests: pure UTC date helpers; DST edge cases; W2 constants; W3 rationale presence.
 * All math is UTC-only (calendar-date semantics per ADR 015 D3).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Read the dates.js source for structural assertions (W2, W3)
const root = path.resolve(__dirname, '../..');
const datesJs = readFileSync(path.join(root, 'public/webapp/organize/dates.js'), 'utf8');

// Import the module directly for functional tests
// Note: vitest can import ES modules with the correct config
import {
  ISO_DATE_RE,
  ISO_DATE_FORMAT,
  parseISO,
  formatISO,
  addDays,
  addMonths,
  firstOfMonth,
  lastOfMonth,
  weekStart,
  daysInMonth,
  isSameDay,
  today,
  monthGrid,
  formatMonthLabel,
  formatDowLabel,
  formatDueLabel,
} from '../../public/webapp/organize/dates.js';

// ------------------------------------------------------------------
// W2 — constants (ADR 015-revisions-after-cp1.md W2)
// ------------------------------------------------------------------
describe('dates.js — W2 constants', () => {
  it('exports ISO_DATE_RE regex', () => {
    expect(ISO_DATE_RE).toBeInstanceOf(RegExp);
    expect(ISO_DATE_RE.test('2026-04-25')).toBe(true);
    expect(ISO_DATE_RE.test('2026-4-5')).toBe(false);
    expect(ISO_DATE_RE.test('20260425')).toBe(false);
  });

  it('exports ISO_DATE_FORMAT string', () => {
    expect(ISO_DATE_FORMAT).toBe('YYYY-MM-DD');
  });

  it('ISO_DATE_RE constant matches literal /^\\d{4}-\\d{2}-\\d{2}$/', () => {
    // The regex must be anchored (no partial match)
    expect(ISO_DATE_RE.test('x2026-04-25y')).toBe(false);
    expect(ISO_DATE_RE.test('2026-04-25')).toBe(true);
  });
});

// ------------------------------------------------------------------
// W3 — top-of-file JSDoc rationale block (ADR 015-revisions-after-cp1.md W3)
// ------------------------------------------------------------------
describe('dates.js — W3 top-of-file JSDoc rationale', () => {
  it('contains the DO NOT introduce timezone conversion warning', () => {
    expect(datesJs).toContain('DO NOT introduce timezone conversion');
  });

  it('references ADR 015 D3', () => {
    expect(datesJs).toContain('D3');
  });

  it('references the regression test path', () => {
    expect(datesJs).toContain('organize.calendar-date-wire-format.test.ts');
  });

  it('explains calendar-date semantics (not timestamp)', () => {
    expect(datesJs).toContain('calendar date');
    expect(datesJs).toContain('2026-04-25');
  });
});

// ------------------------------------------------------------------
// parseISO
// ------------------------------------------------------------------
describe('dates.js — parseISO', () => {
  it('parses a valid date string into a UTC midnight Date', () => {
    const d = parseISO('2026-04-25');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(3); // April = 3
    expect(d!.getUTCDate()).toBe(25);
    expect(d!.getUTCHours()).toBe(0);
  });

  it('returns null for null input', () => {
    expect(parseISO(null as any)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseISO(undefined as any)).toBeNull();
  });

  it('returns null for malformed string', () => {
    expect(parseISO('not-a-date')).toBeNull();
    expect(parseISO('2026/04/25')).toBeNull();
    expect(parseISO('2026-4-5')).toBeNull();
    expect(parseISO('')).toBeNull();
  });

  it('returns null for month overflow (2026-13-45)', () => {
    // W2 binding: round-trip check rejects silent Date.UTC normalization
    expect(parseISO('2026-13-45')).toBeNull();
  });

  it('returns null for day overflow in February (2026-02-30)', () => {
    expect(parseISO('2026-02-30')).toBeNull();
  });

  it('returns null for Feb 29 in non-leap year (2026-02-29)', () => {
    expect(parseISO('2026-02-29')).toBeNull();
  });

  it('accepts Feb 29 in leap year (2024-02-29)', () => {
    const d = parseISO('2024-02-29');
    expect(d).not.toBeNull();
    expect(d!.getUTCDate()).toBe(29);
  });

  // DST edge: 2026-03-08 US spring-forward — calendar date must be stable
  it('W3 DST edge: 2026-03-08 (US spring forward) renders as March 8 UTC (not March 7)', () => {
    const d = parseISO('2026-03-08');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(2); // March = 2
    expect(d!.getUTCDate()).toBe(8);
  });
});

// ------------------------------------------------------------------
// formatISO
// ------------------------------------------------------------------
describe('dates.js — formatISO', () => {
  it('formats a UTC Date to YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 3, 25)); // April 25
    expect(formatISO(d)).toBe('2026-04-25');
  });

  it('zero-pads month and day', () => {
    const d = new Date(Date.UTC(2026, 0, 5)); // Jan 5
    expect(formatISO(d)).toBe('2026-01-05');
  });

  it('returns empty string for invalid date', () => {
    expect(formatISO(new Date('invalid') as any)).toBe('');
  });

  it('round-trips with parseISO', () => {
    const iso = '2026-04-25';
    expect(formatISO(parseISO(iso)!)).toBe(iso);
  });
});

// ------------------------------------------------------------------
// addDays
// ------------------------------------------------------------------
describe('dates.js — addDays', () => {
  it('adds positive days', () => {
    const d = parseISO('2026-04-25')!;
    const result = addDays(d, 5);
    expect(formatISO(result)).toBe('2026-04-30');
  });

  it('adds negative days (goes back)', () => {
    const d = parseISO('2026-04-25')!;
    expect(formatISO(addDays(d, -5))).toBe('2026-04-20');
  });

  it('crosses month boundary', () => {
    const d = parseISO('2026-04-30')!;
    expect(formatISO(addDays(d, 1))).toBe('2026-05-01');
  });

  it('crosses year boundary', () => {
    const d = parseISO('2026-12-31')!;
    expect(formatISO(addDays(d, 1))).toBe('2027-01-01');
  });

  it('does not mutate the input', () => {
    const d = parseISO('2026-04-25')!;
    const original = formatISO(d);
    addDays(d, 10);
    expect(formatISO(d)).toBe(original);
  });

  // DST edge: 2026-03-07 + 1 day = 2026-03-08 (UTC; not affected by DST)
  it('DST edge: 2026-03-07 + 1 = 2026-03-08 (spring forward safe in UTC)', () => {
    const d = parseISO('2026-03-07')!;
    expect(formatISO(addDays(d, 1))).toBe('2026-03-08');
  });
});

// ------------------------------------------------------------------
// addMonths
// ------------------------------------------------------------------
describe('dates.js — addMonths', () => {
  it('adds positive months', () => {
    const d = parseISO('2026-01-15')!;
    expect(formatISO(addMonths(d, 3))).toBe('2026-04-15');
  });

  it('clamps to end of month on day overflow (Jan 31 + 1 month = Feb 28)', () => {
    const d = parseISO('2026-01-31')!;
    expect(formatISO(addMonths(d, 1))).toBe('2026-02-28');
  });

  it('subtracts months', () => {
    const d = parseISO('2026-03-15')!;
    expect(formatISO(addMonths(d, -2))).toBe('2026-01-15');
  });

  it('crosses year boundary', () => {
    const d = parseISO('2026-11-01')!;
    expect(formatISO(addMonths(d, 2))).toBe('2027-01-01');
  });
});

// ------------------------------------------------------------------
// firstOfMonth / lastOfMonth
// ------------------------------------------------------------------
describe('dates.js — firstOfMonth / lastOfMonth', () => {
  it('firstOfMonth returns the 1st', () => {
    const d = parseISO('2026-04-15')!;
    expect(formatISO(firstOfMonth(d))).toBe('2026-04-01');
  });

  it('lastOfMonth returns the last day', () => {
    const d = parseISO('2026-04-15')!;
    expect(formatISO(lastOfMonth(d))).toBe('2026-04-30');
  });

  it('lastOfMonth for February 2026 (non-leap) = 28', () => {
    const d = parseISO('2026-02-10')!;
    expect(formatISO(lastOfMonth(d))).toBe('2026-02-28');
  });

  it('lastOfMonth for February 2024 (leap) = 29', () => {
    const d = parseISO('2024-02-10')!;
    expect(formatISO(lastOfMonth(d))).toBe('2024-02-29');
  });
});

// ------------------------------------------------------------------
// weekStart
// ------------------------------------------------------------------
describe('dates.js — weekStart', () => {
  it('returns Monday for a Wednesday (firstDay=1)', () => {
    const wed = parseISO('2026-04-22')!; // Wednesday
    expect(formatISO(weekStart(wed, 1))).toBe('2026-04-20'); // Monday
  });

  it('returns Sunday for a Wednesday (firstDay=0)', () => {
    const wed = parseISO('2026-04-22')!;
    expect(formatISO(weekStart(wed, 0))).toBe('2026-04-19'); // Sunday
  });

  it('returns the same day if it is already the first day (Monday, firstDay=1)', () => {
    const mon = parseISO('2026-04-20')!;
    expect(formatISO(weekStart(mon, 1))).toBe('2026-04-20');
  });
});

// ------------------------------------------------------------------
// daysInMonth
// ------------------------------------------------------------------
describe('dates.js — daysInMonth', () => {
  it('returns 30 for April', () => {
    expect(daysInMonth(parseISO('2026-04-01')!)).toBe(30);
  });

  it('returns 31 for January', () => {
    expect(daysInMonth(parseISO('2026-01-01')!)).toBe(31);
  });

  it('returns 28 for Feb 2026', () => {
    expect(daysInMonth(parseISO('2026-02-01')!)).toBe(28);
  });

  it('returns 29 for Feb 2024 (leap year)', () => {
    expect(daysInMonth(parseISO('2024-02-01')!)).toBe(29);
  });
});

// ------------------------------------------------------------------
// isSameDay
// ------------------------------------------------------------------
describe('dates.js — isSameDay', () => {
  it('returns true for same UTC day', () => {
    const a = parseISO('2026-04-25')!;
    const b = parseISO('2026-04-25')!;
    expect(isSameDay(a, b)).toBe(true);
  });

  it('returns false for different days', () => {
    const a = parseISO('2026-04-25')!;
    const b = parseISO('2026-04-26')!;
    expect(isSameDay(a, b)).toBe(false);
  });
});

// ------------------------------------------------------------------
// today
// ------------------------------------------------------------------
describe('dates.js — today', () => {
  it('returns a Date at UTC midnight', () => {
    const t = today();
    expect(t).toBeInstanceOf(Date);
    expect(t.getUTCHours()).toBe(0);
    expect(t.getUTCMinutes()).toBe(0);
    expect(t.getUTCSeconds()).toBe(0);
  });
});

// ------------------------------------------------------------------
// monthGrid
// ------------------------------------------------------------------
describe('dates.js — monthGrid', () => {
  it('returns exactly 42 cells', () => {
    const cells = monthGrid(parseISO('2026-04-01')!, 1);
    expect(cells).toHaveLength(42);
  });

  it('cells have date and inMonth properties', () => {
    const cells = monthGrid(parseISO('2026-04-01')!, 1);
    for (const cell of cells) {
      expect(cell).toHaveProperty('date');
      expect(cell).toHaveProperty('inMonth');
      expect(cell.date).toBeInstanceOf(Date);
      expect(typeof cell.inMonth).toBe('boolean');
    }
  });

  it('marks April 2026 cells correctly (starts on Wed; firstDay=Mon)', () => {
    const cells = monthGrid(parseISO('2026-04-01')!, 1);
    // With firstDay=1 (Monday), April 1 2026 is a Wednesday.
    // Week 1 starts: Mon Mar 30, Tue Mar 31, Wed Apr 1, ...
    const cell0 = cells[0]; // Should be Mon Mar 30 (not in month)
    expect(cell0.inMonth).toBe(false);
    expect(formatISO(cell0.date)).toBe('2026-03-30');

    // April 1 should be cell index 2
    const apr1 = cells.find((c) => formatISO(c.date) === '2026-04-01');
    expect(apr1).toBeDefined();
    expect(apr1!.inMonth).toBe(true);
  });

  it('April 30 is the last inMonth cell', () => {
    const cells = monthGrid(parseISO('2026-04-01')!, 1);
    const apr30 = cells.find((c) => formatISO(c.date) === '2026-04-30');
    expect(apr30).toBeDefined();
    expect(apr30!.inMonth).toBe(true);
    // Cells after Apr 30 should be May (not in month)
    const idx = cells.indexOf(apr30!);
    if (idx < 41) {
      expect(cells[idx + 1].inMonth).toBe(false);
    }
  });

  // DST edge: month grid containing March 8 2026 (spring forward)
  it('DST edge: March 2026 grid contains March 8 correctly', () => {
    const cells = monthGrid(parseISO('2026-03-01')!, 1);
    const mar8 = cells.find((c) => formatISO(c.date) === '2026-03-08');
    expect(mar8).toBeDefined();
    expect(mar8!.inMonth).toBe(true);
    // Verify date is exactly March 8 UTC (not March 7 due to DST shift)
    expect(mar8!.date.getUTCDate()).toBe(8);
    expect(mar8!.date.getUTCMonth()).toBe(2); // March
  });
});

// ------------------------------------------------------------------
// formatMonthLabel / formatDowLabel / formatDueLabel
// ------------------------------------------------------------------
describe('dates.js — display formatters', () => {
  it('formatMonthLabel returns a non-empty string for April 2026', () => {
    const label = formatMonthLabel(parseISO('2026-04-01')!, 'en-US');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    // Should contain "April" and "2026" for en-US
    expect(label).toContain('2026');
  });

  it('formatDowLabel returns a short weekday name', () => {
    const label = formatDowLabel(0, 'en-US', 1); // day index 0 = Monday when firstDay=1
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('formatDueLabel returns a formatted string for a valid date', () => {
    const label = formatDueLabel('2026-04-25', 'en-US');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('formatDueLabel returns the original string for an invalid date', () => {
    expect(formatDueLabel('not-valid', 'en-US')).toBe('not-valid');
  });
});
