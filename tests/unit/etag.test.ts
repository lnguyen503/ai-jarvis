/**
 * Unit tests for src/organize/etag.ts (v1.14.4).
 *
 * Tests computeETag + etagsMatch per ADR 012 D1 + D7 + R5.
 * ~20 cases covering: updated: field, mtime fallback, format invariants, equality.
 */

import { describe, it, expect } from 'vitest';
import { computeETag, etagsMatch } from '../../src/organize/etag.js';
import type { OrganizeFrontMatter } from '../../src/organize/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFm(overrides: Partial<OrganizeFrontMatter> = {}): OrganizeFrontMatter {
  return {
    id: '2026-04-25-test',
    type: 'task',
    status: 'active',
    title: 'Test item',
    created: '2026-04-24T10:00:00.000Z',
    due: null,
    parentId: null,
    calendarEventId: null,
    tags: [],
    updated: null,
    ...overrides,
  };
}

const MTIME_MS = 1745481600000; // 2026-04-24T10:00:00.000Z
const MTIME_ISO = new Date(MTIME_MS).toISOString();

// ---------------------------------------------------------------------------
// computeETag — updated: field path
// ---------------------------------------------------------------------------

describe('computeETag — updated: field present', () => {
  it('ET-1: returns double-quoted ISO string from fm.updated', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag).toBe('"2026-04-25T14:30:00.000Z"');
  });

  it('ET-2: starts and ends with double-quote character', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it('ET-3: does NOT have W/ prefix (strong ETag per ADR 012 D1)', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag.startsWith('W/')).toBe(false);
  });

  it('ET-4: uses fm.updated even when fileMtimeMs differs', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, 9999999999999);
    expect(etag).toBe('"2026-04-25T14:30:00.000Z"');
  });

  it('ET-5: different updated values produce different ETags', () => {
    const fm1 = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const fm2 = makeFm({ updated: '2026-04-25T14:30:00.001Z' });
    expect(computeETag(fm1, MTIME_MS)).not.toBe(computeETag(fm2, MTIME_MS));
  });

  it('ET-6: millisecond precision preserved in ETag', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.123Z' });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag).toContain('14:30:00.123Z');
  });

  it('ET-7: inner value (without quotes) equals fm.updated', () => {
    const updated = '2026-04-25T14:30:00.000Z';
    const fm = makeFm({ updated });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag).toBe(`"${updated}"`);
  });
});

// ---------------------------------------------------------------------------
// computeETag — mtime fallback path (updated: null or undefined)
// ---------------------------------------------------------------------------

describe('computeETag — mtime fallback (updated: null or undefined)', () => {
  it('ET-8: falls back to fileMtimeMs ISO when fm.updated is null', () => {
    const fm = makeFm({ updated: null });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag).toBe(`"${MTIME_ISO}"`);
  });

  it('ET-9: falls back to fileMtimeMs ISO when fm.updated is undefined', () => {
    const fm = makeFm();
    delete (fm as Record<string, unknown>)['updated'];
    const etag = computeETag(fm, MTIME_MS);
    expect(etag).toBe(`"${MTIME_ISO}"`);
  });

  it('ET-10: fallback ETag is a valid double-quoted ISO string', () => {
    const fm = makeFm({ updated: null });
    const etag = computeETag(fm, MTIME_MS);
    expect(etag).toMatch(/^"[\d]{4}-[\d]{2}-[\d]{2}T[\d]{2}:[\d]{2}:[\d]{2}\.[\d]{3}Z"$/);
  });

  it('ET-11: different mtime values produce different fallback ETags', () => {
    const fm = makeFm({ updated: null });
    const etag1 = computeETag(fm, 1000000000000);
    const etag2 = computeETag(fm, 1000000001000);
    expect(etag1).not.toBe(etag2);
  });

  it('ET-12: mtime=0 produces the epoch ISO string', () => {
    const fm = makeFm({ updated: null });
    const etag = computeETag(fm, 0);
    expect(etag).toBe('"1970-01-01T00:00:00.000Z"');
  });
});

// ---------------------------------------------------------------------------
// computeETag — format invariants
// ---------------------------------------------------------------------------

describe('computeETag — format invariants', () => {
  it('ET-13: ETag has exactly 2 double-quote characters (open + close)', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, MTIME_MS);
    const quoteCount = (etag.match(/"/g) ?? []).length;
    expect(quoteCount).toBe(2);
  });

  it('ET-14: inner content of ETag is a valid ISO-8601 UTC string', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, MTIME_MS);
    const inner = etag.slice(1, -1); // strip quotes
    expect(() => new Date(inner)).not.toThrow();
    expect(new Date(inner).toISOString()).toBe(inner);
  });

  it('ET-15: ETag format is stable across multiple calls with same input', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag1 = computeETag(fm, MTIME_MS);
    const etag2 = computeETag(fm, MTIME_MS);
    expect(etag1).toBe(etag2);
  });
});

// ---------------------------------------------------------------------------
// etagsMatch
// ---------------------------------------------------------------------------

describe('etagsMatch', () => {
  it('ET-16: identical strings match', () => {
    expect(etagsMatch('"2026-04-25T14:30:00.000Z"', '"2026-04-25T14:30:00.000Z"')).toBe(true);
  });

  it('ET-17: different strings do not match', () => {
    expect(etagsMatch('"2026-04-25T14:30:00.000Z"', '"2026-04-25T14:30:00.001Z"')).toBe(false);
  });

  it('ET-18: quote-sensitive — unquoted value does not match quoted value', () => {
    expect(etagsMatch('2026-04-25T14:30:00.000Z', '"2026-04-25T14:30:00.000Z"')).toBe(false);
  });

  it('ET-19: trim-tolerant — leading/trailing whitespace on either value is trimmed before compare (W1 defense-in-depth)', () => {
    // etagsMatch trims both sides so a caller passing un-trimmed values still works.
    expect(etagsMatch('"2026-04-25T14:30:00.000Z" ', '"2026-04-25T14:30:00.000Z"')).toBe(true);
    expect(etagsMatch('  "2026-04-25T14:30:00.000Z"', '"2026-04-25T14:30:00.000Z"')).toBe(true);
    // Whitespace embedded inside the quoted value is NOT trimmed — still a mismatch.
    expect(etagsMatch('"2026-04-25T14:30:00.000Z "', '"2026-04-25T14:30:00.000Z"')).toBe(false);
  });

  it('ET-20: computeETag output matches itself via etagsMatch', () => {
    const fm = makeFm({ updated: '2026-04-25T14:30:00.000Z' });
    const etag = computeETag(fm, MTIME_MS);
    expect(etagsMatch(etag, etag)).toBe(true);
  });
});
