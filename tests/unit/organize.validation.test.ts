/**
 * Unit tests for src/organize/validation.ts (v1.14.2 + v1.14.6 extensions).
 *
 * Covers every ValidatorErrorCode + happy paths + edge cases.
 * All error codes are exercised; happy paths cover combined + partial patches.
 * Per ADR 010 decision 2 + revisions RA1: every failure asserts the exact code.
 *
 * v1.14.6 extensions:
 *   - W4 NUL-byte retrofit for validatePatchBody title
 *   - validateCreateBody: all D8 + D8.b paths
 */

import { describe, it, expect } from 'vitest';
import {
  validatePatchBody,
  validateCreateBody,
  isValidStatus,
  isValidTag,
  ISO_DATE_RE,
  TAG_RE,
  MAX_TITLE,
  MAX_TAG,
  MAX_TAGS,
  MAX_NOTES,
  MAX_PROGRESS,
} from '../../src/organize/validation.js';

// ---------------------------------------------------------------------------
// Regex constant tests (W3)
// ---------------------------------------------------------------------------

describe('named regex constants (W3)', () => {
  it('ISO_DATE_RE matches YYYY-MM-DD exactly', () => {
    expect(ISO_DATE_RE.test('2026-04-25')).toBe(true);
    expect(ISO_DATE_RE.test('2026-12-31')).toBe(true);
    expect(ISO_DATE_RE.test('2026/04/25')).toBe(false);
    expect(ISO_DATE_RE.test('2026-4-25')).toBe(false);
    expect(ISO_DATE_RE.test('26-04-25')).toBe(false);
    expect(ISO_DATE_RE.test('')).toBe(false);
  });

  it('TAG_RE rejects whitespace, comma, YAML-reserved chars', () => {
    expect(TAG_RE.test('urgent')).toBe(true);
    expect(TAG_RE.test('work-2026')).toBe(true);
    expect(TAG_RE.test('CamelCase')).toBe(true);
    expect(TAG_RE.test('has space')).toBe(false);
    expect(TAG_RE.test('has,comma')).toBe(false);
    expect(TAG_RE.test('has[bracket]')).toBe(false);
    expect(TAG_RE.test('has{brace}')).toBe(false);
    expect(TAG_RE.test('has|pipe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidStatus helper
// ---------------------------------------------------------------------------

describe('isValidStatus()', () => {
  it('accepts active, done, abandoned', () => {
    expect(isValidStatus('active')).toBe(true);
    expect(isValidStatus('done')).toBe(true);
    expect(isValidStatus('abandoned')).toBe(true);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isValidStatus('archived')).toBe(false);
    expect(isValidStatus('')).toBe(false);
    expect(isValidStatus(null)).toBe(false);
    expect(isValidStatus(1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidTag helper
// ---------------------------------------------------------------------------

describe('isValidTag()', () => {
  it('accepts valid tags', () => {
    expect(isValidTag('urgent')).toBe(true);
    expect(isValidTag('work-2026')).toBe(true);
    expect(isValidTag('a')).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(isValidTag(123)).toBe(false);
    expect(isValidTag(null)).toBe(false);
  });

  it('rejects tags that are too long', () => {
    expect(isValidTag('a'.repeat(MAX_TAG))).toBe(true);
    expect(isValidTag('a'.repeat(MAX_TAG + 1))).toBe(false);
  });

  it('rejects tags with disallowed characters', () => {
    expect(isValidTag('has space')).toBe(false);
    expect(isValidTag('has,comma')).toBe(false);
    expect(isValidTag('has[x]')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePatchBody — error cases
// ---------------------------------------------------------------------------

describe('validatePatchBody() — error cases', () => {
  // PATCH_NO_VALID_FIELDS

  it('E1: empty body {} → PATCH_NO_VALID_FIELDS', () => {
    const result = validatePatchBody({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PATCH_NO_VALID_FIELDS');
      // v1.14.3: allowed fields now include notes, progress
      expect(result.error).toContain('title, due, status, tags, notes, progress');
    }
  });

  it('E2: only truly-unknown fields {calendarEventId:"foo"} → PATCH_NO_VALID_FIELDS', () => {
    // notes and progress are now ALLOWED in v1.14.3; use a genuinely unknown field
    const result = validatePatchBody({ calendarEventId: 'foo' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('E2b: multiple unknown fields only → PATCH_NO_VALID_FIELDS', () => {
    const result = validatePatchBody({ xyz: 1, calendarEventId: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('E2c: null body → PATCH_NO_VALID_FIELDS', () => {
    const result = validatePatchBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('E2d: array body → PATCH_NO_VALID_FIELDS', () => {
    const result = validatePatchBody([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('E2e: string body → PATCH_NO_VALID_FIELDS', () => {
    const result = validatePatchBody('title');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  // PATCH_UNKNOWN_FIELDS

  it('E3: known + unknown → PATCH_UNKNOWN_FIELDS (RA2 / R15)', () => {
    // v1.14.3: calendarEventId is still unknown; parentId is still unknown
    const result = validatePatchBody({ title: 'ok', calendarEventId: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PATCH_UNKNOWN_FIELDS');
      expect(result.error).toContain('calendarEventId');
      expect(result.error).toContain('title, due, status, tags, notes, progress');
    }
  });

  it('E3b: multiple unknown fields alongside known → PATCH_UNKNOWN_FIELDS', () => {
    const result = validatePatchBody({ title: 'ok', calendarEventId: 'z', parentId: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATCH_UNKNOWN_FIELDS');
  });

  // TITLE_NOT_STRING

  it('E4: title is a number → TITLE_NOT_STRING', () => {
    const result = validatePatchBody({ title: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_NOT_STRING');
  });

  it('E4b: title is null → TITLE_NOT_STRING', () => {
    const result = validatePatchBody({ title: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_NOT_STRING');
  });

  // TITLE_REQUIRED

  it('E5: title is whitespace-only → TITLE_REQUIRED', () => {
    const result = validatePatchBody({ title: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_REQUIRED');
  });

  it('E5b: title is empty string → TITLE_REQUIRED', () => {
    const result = validatePatchBody({ title: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_REQUIRED');
  });

  it('E5c: title is tabs/newlines only → TITLE_REQUIRED', () => {
    const result = validatePatchBody({ title: '\t\n\r' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_REQUIRED');
  });

  // TITLE_TOO_LONG

  it('E6: title 501 chars → TITLE_TOO_LONG', () => {
    const result = validatePatchBody({ title: 'a'.repeat(MAX_TITLE + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_TOO_LONG');
  });

  it('E6b: title exactly MAX_TITLE chars → ok', () => {
    const result = validatePatchBody({ title: 'a'.repeat(MAX_TITLE) });
    expect(result.ok).toBe(true);
  });

  // DUE_INVALID_FORMAT

  it('E7: due with wrong separator → DUE_INVALID_FORMAT', () => {
    const result = validatePatchBody({ due: '2026/12/31' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DUE_INVALID_FORMAT');
  });

  it('E7b: due as empty string → DUE_INVALID_FORMAT', () => {
    const result = validatePatchBody({ due: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DUE_INVALID_FORMAT');
  });

  it('E7c: due as number → DUE_INVALID_FORMAT', () => {
    const result = validatePatchBody({ due: 20261231 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DUE_INVALID_FORMAT');
  });

  it('E7d: due as ISO datetime string (not just date) → DUE_INVALID_FORMAT', () => {
    const result = validatePatchBody({ due: '2026-12-31T00:00:00.000Z' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DUE_INVALID_FORMAT');
  });

  // STATUS_INVALID

  it('E8: status "archived" → STATUS_INVALID', () => {
    const result = validatePatchBody({ status: 'archived' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('STATUS_INVALID');
  });

  it('E8b: status "" → STATUS_INVALID', () => {
    const result = validatePatchBody({ status: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('STATUS_INVALID');
  });

  it('E8c: status 1 (number) → STATUS_INVALID', () => {
    const result = validatePatchBody({ status: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('STATUS_INVALID');
  });

  // TAGS_NOT_ARRAY

  it('E9: tags is a string → TAGS_NOT_ARRAY', () => {
    const result = validatePatchBody({ tags: 'not-array' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAGS_NOT_ARRAY');
  });

  it('E9b: tags is null → TAGS_NOT_ARRAY', () => {
    const result = validatePatchBody({ tags: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAGS_NOT_ARRAY');
  });

  // TAGS_TOO_MANY

  it('E10: 11 tags → TAGS_TOO_MANY', () => {
    const result = validatePatchBody({ tags: Array(MAX_TAGS + 1).fill('a') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAGS_TOO_MANY');
  });

  it('E10b: exactly MAX_TAGS tags → ok', () => {
    const result = validatePatchBody({ tags: Array(MAX_TAGS).fill('a') });
    expect(result.ok).toBe(true);
  });

  // TAG_TOO_LONG

  it('E11: tag with 41 chars → TAG_TOO_LONG', () => {
    const result = validatePatchBody({ tags: ['a'.repeat(MAX_TAG + 1)] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAG_TOO_LONG');
  });

  // TAG_INVALID_CHARS

  it('E12: tag with space → TAG_INVALID_CHARS', () => {
    const result = validatePatchBody({ tags: ['has space'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAG_INVALID_CHARS');
  });

  it('E12b: tag with comma → TAG_INVALID_CHARS', () => {
    const result = validatePatchBody({ tags: ['has,comma'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAG_INVALID_CHARS');
  });

  it('E12c: tag with square bracket → TAG_INVALID_CHARS', () => {
    const result = validatePatchBody({ tags: ['has[x]'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAG_INVALID_CHARS');
  });

  it('E12d: tag with pipe → TAG_INVALID_CHARS', () => {
    const result = validatePatchBody({ tags: ['has|pipe'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAG_INVALID_CHARS');
  });

  it('E12e: tag is non-string in array → TAG_INVALID_CHARS', () => {
    const result = validatePatchBody({ tags: [123] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAG_INVALID_CHARS');
  });
});

// ---------------------------------------------------------------------------
// validatePatchBody — happy paths
// ---------------------------------------------------------------------------

describe('validatePatchBody() — happy paths', () => {
  it('H1: {title: "New title"} → ok, patch is exactly {title: "New title"}', () => {
    const result = validatePatchBody({ title: 'New title' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({ title: 'New title' });
      // RA2 (v1.14.3): sawUnknown field dropped — no longer in ValidationResult
    }
  });

  it('H2: title with leading/trailing whitespace is trimmed', () => {
    const result = validatePatchBody({ title: '  Hello  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.title).toBe('Hello');
  });

  it('H3: {due: "2026-12-31"} → ok', () => {
    const result = validatePatchBody({ due: '2026-12-31' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.due).toBe('2026-12-31');
  });

  it('H4: {due: null} → ok (explicit clear)', () => {
    const result = validatePatchBody({ due: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.due).toBeNull();
  });

  it('H5: {due: "2026-02-30"} → ok at validator (non-real calendar date; storage is tolerant)', () => {
    const result = validatePatchBody({ due: '2026-02-30' });
    // ISO_DATE_RE matches shape; calendar correctness not enforced here
    expect(result.ok).toBe(true);
  });

  it('H6: {status: "done"} → ok', () => {
    const result = validatePatchBody({ status: 'done' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.status).toBe('done');
  });

  it('H7: {status: "active"} → ok', () => {
    const result = validatePatchBody({ status: 'active' });
    expect(result.ok).toBe(true);
  });

  it('H8: {status: "abandoned"} → ok', () => {
    const result = validatePatchBody({ status: 'abandoned' });
    expect(result.ok).toBe(true);
  });

  it('H9: {tags: ["urgent", "work-2026"]} → ok', () => {
    const result = validatePatchBody({ tags: ['urgent', 'work-2026'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.tags).toEqual(['urgent', 'work-2026']);
  });

  it('H10: {tags: []} → ok (empty array = no tags)', () => {
    const result = validatePatchBody({ tags: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.tags).toEqual([]);
  });

  it('H11: combined {title, due, status, tags} → ok with all four fields', () => {
    const result = validatePatchBody({
      title: 'Multi-field',
      due: '2026-06-15',
      status: 'done',
      tags: ['a', 'b'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({
        title: 'Multi-field',
        due: '2026-06-15',
        status: 'done',
        tags: ['a', 'b'],
      });
    }
  });

  it('H12: only due field → ok, patch has only due', () => {
    const result = validatePatchBody({ due: '2026-01-01' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.patch)).toEqual(['due']);
    }
  });

  it('H13: tags with whitespace-padded entries are trimmed', () => {
    const result = validatePatchBody({ tags: [' urgent '] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.tags).toEqual(['urgent']);
  });

  it('H14: patch object NEVER contains unknown fields (RA2 smoke check)', () => {
    const result = validatePatchBody({ title: 'Clean', status: 'done' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.patch);
      for (const k of keys) {
        // v1.14.3: notes and progress are now allowed fields
        expect(['title', 'due', 'status', 'tags', 'notes', 'progress']).toContain(k);
      }
    }
  });

  it('H15: due absent → patch has no due key (leave-alone semantics)', () => {
    const result = validatePatchBody({ title: 'No due' });
    expect(result.ok).toBe(true);
    if (result.ok) expect('due' in result.patch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePatchBody — notes (v1.14.3 D2)
// ---------------------------------------------------------------------------

describe('validatePatchBody() — notes field (v1.14.3 D2)', () => {
  it('N1: {notes: "some text"} → ok', () => {
    const result = validatePatchBody({ notes: 'some text' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.notes).toBe('some text');
  });

  it('N2: {notes: ""} → ok (empty string allowed)', () => {
    const result = validatePatchBody({ notes: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.notes).toBe('');
  });

  it('N3: notes exactly MAX_NOTES chars → ok', () => {
    const result = validatePatchBody({ notes: 'a'.repeat(MAX_NOTES) });
    expect(result.ok).toBe(true);
  });

  it('N4: notes MAX_NOTES+1 chars → NOTES_TOO_LONG', () => {
    const result = validatePatchBody({ notes: 'a'.repeat(MAX_NOTES + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTES_TOO_LONG');
  });

  it('N5: notes is a number → NOTES_NOT_STRING', () => {
    const result = validatePatchBody({ notes: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTES_NOT_STRING');
  });

  it('N6: notes is null → NOTES_NOT_STRING', () => {
    const result = validatePatchBody({ notes: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTES_NOT_STRING');
  });

  it('N7: notes absent → patch has no notes key (leave-alone semantics)', () => {
    const result = validatePatchBody({ title: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect('notes' in result.patch).toBe(false);
  });

  it('N8: combined notes + title → ok with both fields', () => {
    const result = validatePatchBody({ title: 'Hello', notes: 'world' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.title).toBe('Hello');
      expect(result.patch.notes).toBe('world');
    }
  });
});

// ---------------------------------------------------------------------------
// validatePatchBody — progress field (v1.14.3 D3)
// ---------------------------------------------------------------------------

describe('validatePatchBody() — progress field (v1.14.3 D3)', () => {
  it('P1: {progress: "- 2026-04-25: did stuff"} → ok', () => {
    const result = validatePatchBody({ progress: '- 2026-04-25: did stuff' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.progress).toBe('- 2026-04-25: did stuff');
  });

  it('P2: {progress: ""} → ok (empty string allowed)', () => {
    const result = validatePatchBody({ progress: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.progress).toBe('');
  });

  it('P3: progress exactly MAX_PROGRESS chars → ok', () => {
    const result = validatePatchBody({ progress: 'a'.repeat(MAX_PROGRESS) });
    expect(result.ok).toBe(true);
  });

  it('P4: progress MAX_PROGRESS+1 chars → PROGRESS_TOO_LONG', () => {
    const result = validatePatchBody({ progress: 'a'.repeat(MAX_PROGRESS + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROGRESS_TOO_LONG');
  });

  it('P5: progress is an array → PROGRESS_NOT_STRING', () => {
    const result = validatePatchBody({ progress: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROGRESS_NOT_STRING');
  });

  it('P6: combined notes + progress → ok with both fields', () => {
    const result = validatePatchBody({ notes: 'Note text', progress: 'Progress text' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.notes).toBe('Note text');
      expect(result.patch.progress).toBe('Progress text');
    }
  });

  it('P7: progress absent → patch has no progress key', () => {
    const result = validatePatchBody({ title: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect('progress' in result.patch).toBe(false);
  });

  it('P8: all six fields combined → ok', () => {
    const result = validatePatchBody({
      title: 'Full',
      due: '2026-06-01',
      status: 'active',
      tags: ['tag1'],
      notes: 'my notes',
      progress: 'my progress',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.title).toBe('Full');
      expect(result.patch.notes).toBe('my notes');
      expect(result.patch.progress).toBe('my progress');
    }
  });
});

// ---------------------------------------------------------------------------
// NUL byte rejection — Fix 4 (v1.14.3)
// ---------------------------------------------------------------------------

describe('validatePatchBody() — NUL byte rejection (v1.14.3 Fix 4)', () => {
  it('NUL-1: notes with embedded NUL → NOTES_INVALID_CHARS', () => {
    const result = validatePatchBody({ notes: 'hello\x00world' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOTES_INVALID_CHARS');
      expect(result.error).toMatch(/null bytes/);
    }
  });

  it('NUL-2: progress with embedded NUL → PROGRESS_INVALID_CHARS', () => {
    const result = validatePatchBody({ progress: '- step\x00injection' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROGRESS_INVALID_CHARS');
      expect(result.error).toMatch(/null bytes/);
    }
  });
});

// ---------------------------------------------------------------------------
// RA2 — sawUnknown field removed (v1.14.3)
// ---------------------------------------------------------------------------

describe('RA2 — sawUnknown field removed', () => {
  it('RA2-1: success result has no sawUnknown property', () => {
    const result = validatePatchBody({ title: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('sawUnknown' in result).toBe(false);
    }
  });

  it('RA2-2: sawUnknown is absent even when previously set to false', () => {
    const result = validatePatchBody({ notes: 'text' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Confirm no vestigial field
      expect(Object.prototype.hasOwnProperty.call(result, 'sawUnknown')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// W4 — NUL-byte retrofit for validatePatchBody title (v1.14.6)
// ---------------------------------------------------------------------------

describe('validatePatchBody() — W4 NUL-byte title retrofit (v1.14.6)', () => {
  it('W4-1: title with NUL byte → TITLE_INVALID_CHARS', () => {
    const result = validatePatchBody({ title: 'hello\x00world' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TITLE_INVALID_CHARS');
      expect(result.error).toMatch(/null bytes/);
    }
  });

  it('W4-2: title with only NUL bytes (after trim empty check would not fire first)', () => {
    // '\x00' trims to '\x00' (not whitespace), so length > 0, then NUL check fires
    const result = validatePatchBody({ title: '\x00' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Could be TITLE_INVALID_CHARS (NUL) — NUL is not whitespace so trim leaves it
      expect(['TITLE_INVALID_CHARS', 'TITLE_REQUIRED']).toContain(result.code);
    }
  });

  it('W4-3: title with NUL at start → TITLE_INVALID_CHARS', () => {
    const result = validatePatchBody({ title: '\x00valid title' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TITLE_INVALID_CHARS');
    }
  });

  it('W4-4: clean title still passes (regression: no false positive)', () => {
    const result = validatePatchBody({ title: 'Valid title with special chars: éàü' });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCreateBody — error cases (v1.14.6 D8)
// ---------------------------------------------------------------------------

describe('validateCreateBody() — error cases', () => {
  // Non-object bodies

  it('C-E1: null body → CREATE_TYPE_REQUIRED', () => {
    const result = validateCreateBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_TYPE_REQUIRED');
  });

  it('C-E2: array body → CREATE_TYPE_REQUIRED', () => {
    const result = validateCreateBody([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_TYPE_REQUIRED');
  });

  it('C-E3: string body → CREATE_TYPE_REQUIRED', () => {
    const result = validateCreateBody('task');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_TYPE_REQUIRED');
  });

  // Unknown fields

  it('C-E4: status field present → CREATE_UNKNOWN_FIELDS', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', status: 'active' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CREATE_UNKNOWN_FIELDS');
      expect(result.error).toContain('status');
    }
  });

  it('C-E5: unknown field present → CREATE_UNKNOWN_FIELDS', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', calendarEventId: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_UNKNOWN_FIELDS');
  });

  // type validation

  it('C-E6: missing type → CREATE_TYPE_REQUIRED', () => {
    const result = validateCreateBody({ title: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_TYPE_REQUIRED');
  });

  it('C-E7: type = "archived" → CREATE_TYPE_REQUIRED', () => {
    const result = validateCreateBody({ type: 'archived', title: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_TYPE_REQUIRED');
  });

  it('C-E8: type = 1 (number) → CREATE_TYPE_REQUIRED', () => {
    const result = validateCreateBody({ type: 1, title: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_TYPE_REQUIRED');
  });

  // title validation

  it('C-E9: missing title → TITLE_REQUIRED or TITLE_NOT_STRING', () => {
    const result = validateCreateBody({ type: 'task' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['TITLE_REQUIRED', 'TITLE_NOT_STRING']).toContain(result.code);
  });

  it('C-E10: title empty string → TITLE_REQUIRED', () => {
    const result = validateCreateBody({ type: 'task', title: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_REQUIRED');
  });

  it('C-E11: title whitespace-only → TITLE_REQUIRED', () => {
    const result = validateCreateBody({ type: 'task', title: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_REQUIRED');
  });

  it('C-E12: title too long → TITLE_TOO_LONG', () => {
    const result = validateCreateBody({ type: 'task', title: 'a'.repeat(MAX_TITLE + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_TOO_LONG');
  });

  it('C-E13: title with NUL byte → TITLE_INVALID_CHARS (W4)', () => {
    const result = validateCreateBody({ type: 'task', title: 'hello\x00' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TITLE_INVALID_CHARS');
  });

  // due validation

  it('C-E14: due in wrong format → DUE_INVALID_FORMAT', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', due: '2026/12/01' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DUE_INVALID_FORMAT');
  });

  it('C-E15: due as number → DUE_INVALID_FORMAT', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', due: 20261201 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DUE_INVALID_FORMAT');
  });

  // parentId with goal

  it('C-E16: type=goal with non-null parentId → CREATE_PARENT_ON_GOAL', () => {
    const result = validateCreateBody({
      type: 'goal',
      title: 'Top goal',
      parentId: '2026-04-25-aaaa',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CREATE_PARENT_ON_GOAL');
  });

  it('C-E17: parentId in bad format → PARENT_ID_INVALID_FORMAT', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', parentId: 'not-an-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PARENT_ID_INVALID_FORMAT');
  });

  // notes

  it('C-E18: notes too long → NOTES_TOO_LONG', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', notes: 'a'.repeat(MAX_NOTES + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTES_TOO_LONG');
  });

  it('C-E19: notes with NUL byte → NOTES_INVALID_CHARS', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', notes: 'abc\x00def' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTES_INVALID_CHARS');
  });

  // progress

  it('C-E20: progress too long → PROGRESS_TOO_LONG', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', progress: 'a'.repeat(MAX_PROGRESS + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROGRESS_TOO_LONG');
  });

  it('C-E21: progress with NUL byte → PROGRESS_INVALID_CHARS', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', progress: '- step\x00bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROGRESS_INVALID_CHARS');
  });

  // tags

  it('C-E22: tags not array → TAGS_NOT_ARRAY', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', tags: 'urgent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAGS_NOT_ARRAY');
  });

  it('C-E23: too many tags → TAGS_TOO_MANY', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', tags: Array(MAX_TAGS + 1).fill('a') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TAGS_TOO_MANY');
  });
});

// ---------------------------------------------------------------------------
// validateCreateBody — happy paths (v1.14.6 D8)
// ---------------------------------------------------------------------------

describe('validateCreateBody() — happy paths', () => {
  it('C-H1: minimal {type: "task", title: "My task"} → ok', () => {
    const result = validateCreateBody({ type: 'task', title: 'My task' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.type).toBe('task');
      expect(result.input.title).toBe('My task');
    }
  });

  it('C-H2: type=event → ok', () => {
    const result = validateCreateBody({ type: 'event', title: 'Meeting' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.type).toBe('event');
  });

  it('C-H3: type=goal → ok', () => {
    const result = validateCreateBody({ type: 'goal', title: 'Q4 Goal' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.type).toBe('goal');
  });

  it('C-H4: type=goal with parentId=null → ok (explicit null clear, not a non-null parent)', () => {
    const result = validateCreateBody({ type: 'goal', title: 'Goal', parentId: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.parentId).toBeNull();
  });

  it('C-H5: title trimmed correctly', () => {
    const result = validateCreateBody({ type: 'task', title: '  Padded  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.title).toBe('Padded');
  });

  it('C-H6: due=null → ok', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', due: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.due).toBeNull();
  });

  it('C-H7: due=YYYY-MM-DD → ok', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', due: '2026-12-31' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.due).toBe('2026-12-31');
  });

  it('C-H8: tags provided → stored trimmed', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', tags: [' urgent ', 'work'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.tags).toEqual(['urgent', 'work']);
  });

  it('C-H9: notes provided → stored verbatim', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', notes: 'some note text' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.notes).toBe('some note text');
  });

  it('C-H10: progress provided (D8.b) → stored verbatim', () => {
    const result = validateCreateBody({ type: 'task', title: 'hi', progress: '- 2026-04-25: started' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.progress).toBe('- 2026-04-25: started');
  });

  it('C-H11: parentId valid string → stored on non-goal', () => {
    const result = validateCreateBody({ type: 'task', title: 'Subtask', parentId: '2026-04-25-aaaa' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.parentId).toBe('2026-04-25-aaaa');
  });

  it('C-H12: all fields together → ok, all present in input', () => {
    const result = validateCreateBody({
      type: 'task',
      title: 'Full create',
      due: '2026-06-01',
      tags: ['work'],
      notes: 'note text',
      progress: '- step 1',
      parentId: '2026-04-01-goal',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.type).toBe('task');
      expect(result.input.title).toBe('Full create');
      expect(result.input.due).toBe('2026-06-01');
      expect(result.input.tags).toEqual(['work']);
      expect(result.input.notes).toBe('note text');
      expect(result.input.progress).toBe('- step 1');
      expect(result.input.parentId).toBe('2026-04-01-goal');
    }
  });

  it('C-H13: absent optional fields are absent in result (no spurious keys)', () => {
    const result = validateCreateBody({ type: 'task', title: 'Minimal' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('due' in result.input).toBe(false);
      expect('tags' in result.input).toBe(false);
      expect('notes' in result.input).toBe(false);
      expect('progress' in result.input).toBe(false);
      expect('parentId' in result.input).toBe(false);
    }
  });
});
