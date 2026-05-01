/**
 * Unit tests for src/scheduler/cronPreview.ts (v1.17.0).
 *
 * ADR 017 R1 binding: 12 test groups covering valid expressions, invalid
 * expressions, no-fire expressions, iteration cap, and DOW normalization.
 *
 * ~25 individual test cases.
 */

import { describe, it, expect } from 'vitest';
import { previewCronFireTimes, MAX_PREVIEW_ITERATIONS, MAX_PREVIEW_RESULTS } from '../../src/scheduler/cronPreview.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REF_DATE = new Date('2026-04-25T09:00:00.000Z');

function preview(expr: string, now?: Date) {
  return previewCronFireTimes(expr, now ?? REF_DATE);
}

// ---------------------------------------------------------------------------
// Test R1-1: 12 canonical expressions parse + return fire times
// ---------------------------------------------------------------------------

describe('cronPreview — valid expressions (R1-1)', () => {
  it('every-minute: * * * * *', () => {
    const result = preview('* * * * *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBe(MAX_PREVIEW_RESULTS);
    // First fire should be exactly 1 minute after ref time
    expect(result.fireTimes[0]).toBe('2026-04-25T09:01:00.000Z');
  });

  it('every 5 minutes: */5 * * * *', () => {
    const result = preview('*/5 * * * *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBe(MAX_PREVIEW_RESULTS);
    expect(result.fireTimes[0]).toBe('2026-04-25T09:05:00.000Z');
    expect(result.fireTimes[1]).toBe('2026-04-25T09:10:00.000Z');
  });

  it('daily at 9am: 0 9 * * *', () => {
    const result = preview('0 9 * * *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ref is 09:00 so next fire is tomorrow 09:00
    expect(result.fireTimes[0]).toBe('2026-04-26T09:00:00.000Z');
  });

  it('weekday: 0 9 * * 1-5', () => {
    const result = preview('0 9 * * 1-5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBeGreaterThan(0);
    // All fires should be on weekdays (Mon=1 to Fri=5)
    for (const t of result.fireTimes) {
      const day = new Date(t).getUTCDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    }
  });

  it('Mon-Wed-Fri: 0 9 * * 1,3,5', () => {
    const result = preview('0 9 * * 1,3,5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const t of result.fireTimes) {
      const day = new Date(t).getUTCDay();
      expect([1, 3, 5]).toContain(day);
    }
  });

  it('weekend: 0 9 * * 0,6', () => {
    const result = preview('0 9 * * 0,6');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const t of result.fireTimes) {
      const day = new Date(t).getUTCDay();
      expect([0, 6]).toContain(day);
    }
  });

  it('every 15 mins 9-17 weekdays: */15 9-17 * * 1-5', () => {
    const result = preview('*/15 9-17 * * 1-5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBe(MAX_PREVIEW_RESULTS);
  });

  it('1st of month midnight: 30 4 1 * *', () => {
    const result = preview('30 4 1 * *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBeGreaterThan(0);
    // All fires must be on 1st day of month at 04:30
    for (const t of result.fireTimes) {
      const d = new Date(t);
      expect(d.getUTCDate()).toBe(1);
      expect(d.getUTCHours()).toBe(4);
      expect(d.getUTCMinutes()).toBe(30);
    }
  });

  it('Jan 1st midnight: 0 0 1 1 *', () => {
    const result = preview('0 0 1 1 *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBeGreaterThan(0);
    for (const t of result.fireTimes) {
      const d = new Date(t);
      expect(d.getUTCMonth() + 1).toBe(1);
      expect(d.getUTCDate()).toBe(1);
    }
  });

  it('every Sunday midnight: 0 0 * * 0', () => {
    const result = preview('0 0 * * 0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const t of result.fireTimes) {
      expect(new Date(t).getUTCDay()).toBe(0);
    }
  });

  it('23:45 daily: 45 23 * * *', () => {
    const result = preview('45 23 * * *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBe(MAX_PREVIEW_RESULTS);
    for (const t of result.fireTimes) {
      const d = new Date(t);
      expect(d.getUTCHours()).toBe(23);
      expect(d.getUTCMinutes()).toBe(45);
    }
  });

  it('every 2h 8-18 weekdays: 0 8-18/2 * * 1-5', () => {
    const result = preview('0 8-18/2 * * 1-5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fireTimes.length).toBe(MAX_PREVIEW_RESULTS);
  });
});

// ---------------------------------------------------------------------------
// Test R1-2: */0 rejection in each field
// ---------------------------------------------------------------------------

describe('cronPreview — */0 rejection (R1-2)', () => {
  it('*/0 in minute field', () => {
    const r = preview('*/0 * * * *');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INVALID_CRON');
  });

  it('*/0 in hour field', () => {
    const r = preview('* */0 * * *');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INVALID_CRON');
  });

  it('*/0 in dom field', () => {
    const r = preview('* * */0 * *');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INVALID_CRON');
  });

  it('*/0 in month field', () => {
    const r = preview('* * * */0 *');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INVALID_CRON');
  });

  it('*/0 in dow field', () => {
    const r = preview('* * * * */0');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INVALID_CRON');
  });
});

// ---------------------------------------------------------------------------
// Test R1-3: out-of-range rejection
// ---------------------------------------------------------------------------

describe('cronPreview — out-of-range rejection (R1-3)', () => {
  it('minute 60 rejected', () => {
    const r = preview('60 * * * *');
    expect(r.ok).toBe(false);
  });

  it('hour 24 rejected', () => {
    const r = preview('* 24 * * *');
    expect(r.ok).toBe(false);
  });

  it('dom 32 rejected', () => {
    const r = preview('* * 32 * *');
    expect(r.ok).toBe(false);
  });

  it('month 13 rejected', () => {
    const r = preview('* * * 13 *');
    expect(r.ok).toBe(false);
  });

  it('dow 8 rejected', () => {
    const r = preview('* * * * 8');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test R1-4: Feb 31 non-firing
// ---------------------------------------------------------------------------

describe('cronPreview — no-fire expressions (R1-4 through R1-7)', () => {
  it('R1-4: 0 0 31 2 * (Feb 31) returns empty + warning', () => {
    const r = preview('0 0 31 2 *', new Date('2026-01-01T00:00:00.000Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fireTimes).toEqual([]);
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain('365 days');
  });

  it('R1-5: 0 0 31 4 * (Apr 31) returns empty + warning', () => {
    const r = preview('0 0 31 4 *', new Date('2026-01-01T00:00:00.000Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fireTimes).toEqual([]);
    expect(r.warning).toBeDefined();
  });

  it('R1-6: 0 0 30 2 * (Feb 30) returns empty + warning', () => {
    const r = preview('0 0 30 2 *', new Date('2026-01-01T00:00:00.000Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fireTimes).toEqual([]);
    expect(r.warning).toBeDefined();
  });

  it('R1-7: 0 0 29 2 * with now=2026-01-01 (non-leap year ahead) — documents actual behavior', () => {
    // 2026 is not a leap year, 2027 is not, 2028 IS a leap year
    // With a 1-year iteration window from 2026-01-01, the next Feb 29 is 2028-02-29
    // which is MORE than 365 days away → expect empty + warning
    const r = preview('0 0 29 2 *', new Date('2026-01-01T00:00:00.000Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Document actual behavior: may be empty (cap hit) or contain the leap-year fire
    // 2028-02-29 is 789 days from 2026-01-01, > 525_600 minutes / 1440 = 365 days
    // So it will be empty with warning (the leap year fire is outside the 365-day window)
    expect(r.fireTimes).toEqual([]);
    expect(r.warning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test R1-8: negative number rejection
// ---------------------------------------------------------------------------

describe('cronPreview — negative number rejection (R1-8)', () => {
  it('* * -1 * * rejected', () => {
    const r = preview('* * -1 * *');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test R1-9: wrong field count rejection
// ---------------------------------------------------------------------------

describe('cronPreview — field count validation (R1-9)', () => {
  it('4 fields rejected', () => {
    const r = preview('* * * *');
    expect(r.ok).toBe(false);
  });

  it('6 fields rejected', () => {
    const r = preview('* * * * * *');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test R1-10: deterministic clock
// ---------------------------------------------------------------------------

describe('cronPreview — deterministic clock (R1-10)', () => {
  it('*/5 * * * * with now=2026-04-25T09:00:00Z returns predictable times', () => {
    const r = preview('*/5 * * * *', new Date('2026-04-25T09:00:00.000Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fireTimes[0]).toBe('2026-04-25T09:05:00.000Z');
    expect(r.fireTimes[1]).toBe('2026-04-25T09:10:00.000Z');
    expect(r.fireTimes[2]).toBe('2026-04-25T09:15:00.000Z');
    expect(r.fireTimes[3]).toBe('2026-04-25T09:20:00.000Z');
    expect(r.fireTimes[4]).toBe('2026-04-25T09:25:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Test R1-11: DOW normalization
// ---------------------------------------------------------------------------

describe('cronPreview — DOW normalization (R1-11)', () => {
  it('1-5 and 1,2,3,4,5 produce identical fire-time lists', () => {
    const r1 = preview('0 9 * * 1-5');
    const r2 = preview('0 9 * * 1,2,3,4,5');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.fireTimes).toEqual(r2.fireTimes);
  });

  it('0,6 and 6,0 produce identical fire-time lists', () => {
    const r1 = preview('0 9 * * 0,6');
    const r2 = preview('0 9 * * 6,0');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.fireTimes).toEqual(r2.fireTimes);
  });

  it('dow 7 is treated as Sunday (alias for 0)', () => {
    const r7 = preview('0 9 * * 7');
    const r0 = preview('0 9 * * 0');
    expect(r7.ok).toBe(true);
    expect(r0.ok).toBe(true);
    if (!r7.ok || !r0.ok) return;
    expect(r7.fireTimes).toEqual(r0.fireTimes);
  });
});

// ---------------------------------------------------------------------------
// Test R1-12: iteration-cap warning
// ---------------------------------------------------------------------------

describe('cronPreview — iteration cap warning (R1-12)', () => {
  it('0 0 1 1 * with now=mid-year collects 1 fire and emits warning', () => {
    // From mid-year (July), Jan 1 is ~6 months away = well within 365 days
    const r = preview('0 0 1 1 *', new Date('2026-07-01T00:00:00.000Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Should have exactly 1 fire time (Jan 1 2027 at 00:00)
    expect(r.fireTimes.length).toBe(1);
    expect(r.fireTimes[0]).toBe('2027-01-01T00:00:00.000Z');
    // Warning should be present because we got < MAX_PREVIEW_RESULTS
    expect(r.warning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Constants exports
// ---------------------------------------------------------------------------

describe('cronPreview — exported constants', () => {
  it('MAX_PREVIEW_ITERATIONS = 525_600', () => {
    expect(MAX_PREVIEW_ITERATIONS).toBe(525_600);
  });

  it('MAX_PREVIEW_RESULTS = 5', () => {
    expect(MAX_PREVIEW_RESULTS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('cronPreview — edge cases', () => {
  it('unicode garbage rejected', () => {
    const r = preview('* * * * ☃');
    expect(r.ok).toBe(false);
  });

  it('oversized string rejected', () => {
    const r = preview('*'.repeat(300));
    expect(r.ok).toBe(false);
  });

  it('empty string rejected', () => {
    const r = preview('');
    expect(r.ok).toBe(false);
  });
});
