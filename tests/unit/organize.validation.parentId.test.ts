/**
 * Unit tests for parentId validation in src/organize/validation.ts (v1.14.5).
 *
 * Covers the new parentId field added by ADR 013 D1:
 *   - Valid format (item-id regex match) → accepted, passed through
 *   - null → accepted (explicit clear)
 *   - Invalid format (not matching regex) → PARENT_ID_INVALID_FORMAT
 *   - Non-string, non-null → PARENT_ID_INVALID_FORMAT
 *   - Absent → leave-alone semantics (not in patch)
 *   - Combined with other fields
 *
 * Note: self-reference (PARENT_ID_SELF_REFERENCE) and existence checks
 * (PARENT_NOT_FOUND, PARENT_NOT_GOAL, PARENT_NOT_ACTIVE, GOAL_CANNOT_HAVE_PARENT)
 * are route-layer concerns (D2 Option C) — tested in webapp.organize.parentId.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { validatePatchBody, PARENT_ID_RE } from '../../src/organize/validation.js';

// ---------------------------------------------------------------------------
// PARENT_ID_RE regex constant
// ---------------------------------------------------------------------------

describe('PARENT_ID_RE', () => {
  it('matches valid item id format YYYY-MM-DD-xxxx', () => {
    expect(PARENT_ID_RE.test('2026-04-25-ab1c')).toBe(true);
    expect(PARENT_ID_RE.test('2026-12-31-zzzz')).toBe(true);
    expect(PARENT_ID_RE.test('2000-01-01-0000')).toBe(true);
  });

  it('rejects wrong separator or length', () => {
    expect(PARENT_ID_RE.test('2026/04/25-ab1c')).toBe(false);
    expect(PARENT_ID_RE.test('2026-04-25-ab1')).toBe(false);   // suffix too short
    expect(PARENT_ID_RE.test('2026-04-25-ab1cc')).toBe(false); // suffix too long
    expect(PARENT_ID_RE.test('')).toBe(false);
  });

  it('rejects uppercase in suffix', () => {
    expect(PARENT_ID_RE.test('2026-04-25-AB1C')).toBe(false);
    expect(PARENT_ID_RE.test('2026-04-25-Ab1c')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePatchBody — parentId field (v1.14.5 D1)
// ---------------------------------------------------------------------------

describe('validatePatchBody() — parentId field (v1.14.5 D1)', () => {
  it('PI-1: {parentId: "2026-04-25-ab1c"} → ok, patch contains parentId', () => {
    const result = validatePatchBody({ parentId: '2026-04-25-ab1c' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.parentId).toBe('2026-04-25-ab1c');
    }
  });

  it('PI-2: {parentId: null} → ok, patch.parentId is null (explicit clear)', () => {
    const result = validatePatchBody({ parentId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.parentId).toBeNull();
    }
  });

  it('PI-3: parentId absent → patch has no parentId key (leave-alone semantics)', () => {
    const result = validatePatchBody({ title: 'No parent change' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('parentId' in result.patch).toBe(false);
    }
  });

  it('PI-4: {parentId: "bad-format"} → PARENT_ID_INVALID_FORMAT', () => {
    const result = validatePatchBody({ parentId: 'bad-format' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PARENT_ID_INVALID_FORMAT');
      expect(result.error).toMatch(/YYYY-MM-DD/);
    }
  });

  it('PI-5: {parentId: 123} (non-string, non-null) → PARENT_ID_INVALID_FORMAT', () => {
    const result = validatePatchBody({ parentId: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PARENT_ID_INVALID_FORMAT');
    }
  });

  it('PI-6: {parentId: ""} (empty string) → PARENT_ID_INVALID_FORMAT', () => {
    const result = validatePatchBody({ parentId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PARENT_ID_INVALID_FORMAT');
    }
  });

  it('PI-7: {parentId: "2026-04-25-ABCD"} (uppercase suffix) → PARENT_ID_INVALID_FORMAT', () => {
    const result = validatePatchBody({ parentId: '2026-04-25-ABCD' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PARENT_ID_INVALID_FORMAT');
    }
  });

  it('PI-8: combined {title, parentId} → ok with both fields', () => {
    const result = validatePatchBody({ title: 'New title', parentId: '2026-04-25-ab1c' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.title).toBe('New title');
      expect(result.patch.parentId).toBe('2026-04-25-ab1c');
    }
  });

  it('PI-9: {parentId: null, status: "active"} → ok with both fields', () => {
    const result = validatePatchBody({ parentId: null, status: 'active' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.parentId).toBeNull();
      expect(result.patch.status).toBe('active');
    }
  });

  it('PI-10: patch object never contains unknown fields after adding parentId (RA2 smoke check)', () => {
    const result = validatePatchBody({ parentId: '2026-04-25-ab1c' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.patch);
      for (const k of keys) {
        expect(['title', 'due', 'status', 'tags', 'notes', 'progress', 'parentId']).toContain(k);
      }
    }
  });

  it('PI-11: {parentId: "2026-04-25-ab1c", unknownField: "x"} → PATCH_UNKNOWN_FIELDS', () => {
    const result = validatePatchBody({ parentId: '2026-04-25-ab1c', unknownField: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PATCH_UNKNOWN_FIELDS');
    }
  });

  it('PI-12: {parentId: []} (array) → PARENT_ID_INVALID_FORMAT', () => {
    const result = validatePatchBody({ parentId: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PARENT_ID_INVALID_FORMAT');
    }
  });
});
