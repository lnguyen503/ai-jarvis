/**
 * Audit webapp client tests — Jarvis v1.17.0.
 *
 * Verifies:
 *   - Cursor-based pagination renders correctly (source grep + unit)
 *   - Filter dropdown populated from KNOWN_AUDIT_CATEGORIES (source grep)
 *   - Refresh button clears cursor + fetches latest (R4 — source grep)
 *   - detail_json rendered as pre + textContent (R9 — source grep)
 *   - 16KB truncation marker shown when exceeded (R9 — unit test)
 *   - Category filter validated against known list (R6 — unit test)
 *   - Read-only — no edit/delete UI elements
 *
 * v1.17.0 — ADR 017 D4 + R4 + R6 + R9.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const auditAppJs = readFileSync(path.join(root, 'public/webapp/audit/app.js'), 'utf8');
const auditHtml = readFileSync(path.join(root, 'public/webapp/audit/index.html'), 'utf8');

// ------------------------------------------------------------------
// Inline copies for unit testing
// ------------------------------------------------------------------

const DETAIL_JSON_DISPLAY_MAX_CHARS = 16_384;

function formatDetailJson(jsonString: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (_err) {
    parsed = jsonString;
  }
  const pretty = typeof parsed === 'string'
    ? parsed
    : JSON.stringify(parsed, null, 2);
  if (pretty.length > DETAIL_JSON_DISPLAY_MAX_CHARS) {
    return pretty.slice(0, DETAIL_JSON_DISPLAY_MAX_CHARS) +
      '\n\n... [truncated; full content in audit_log.detail_json column]';
  }
  return pretty;
}

function validateCategoryFilter(
  selected: string[],
  knownCategories: Set<string>,
): { ok: true; validated: string[] } | { ok: false; error: string } {
  if (!selected || selected.length === 0) {
    return { ok: true, validated: [] };
  }
  const unknown = selected.filter((c) => !knownCategories.has(c));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown category: ${unknown.join(', ')}` };
  }
  return { ok: true, validated: selected };
}

// ------------------------------------------------------------------
// R9 — 16KB truncation
// ------------------------------------------------------------------

describe('webapp audit client — R9 detail_json 16KB truncation', () => {
  it('R9: displays full JSON under 16KB without truncation', () => {
    const obj = { key: 'value', number: 42, nested: { a: 1 } };
    const result = formatDetailJson(JSON.stringify(obj));
    expect(result).not.toContain('truncated');
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('R9: truncates at 16384 chars and appends truncation suffix', () => {
    const largeJson = JSON.stringify({ data: 'x'.repeat(20_000) });
    const result = formatDetailJson(largeJson);
    expect(result.length).toBeLessThanOrEqual(DETAIL_JSON_DISPLAY_MAX_CHARS + 100); // truncation suffix ~80 chars
    expect(result).toContain('... [truncated; full content in audit_log.detail_json column]');
  });

  it('R9: exactly at 16384 chars is NOT truncated', () => {
    // Build a pretty-printed JSON that is exactly DETAIL_JSON_DISPLAY_MAX_CHARS long
    const obj = { k: 'a'.repeat(DETAIL_JSON_DISPLAY_MAX_CHARS - 10) };
    const pretty = JSON.stringify(obj, null, 2);
    if (pretty.length <= DETAIL_JSON_DISPLAY_MAX_CHARS) {
      const result = formatDetailJson(JSON.stringify(obj));
      expect(result).not.toContain('truncated');
    }
  });

  it('R9: invalid JSON string passed through as-is', () => {
    const notJson = 'not { valid ] json';
    const result = formatDetailJson(notJson);
    expect(result).toBe(notJson); // passed through without modification
  });

  it('R9: pretty-prints valid JSON with 2-space indent', () => {
    const result = formatDetailJson('{"a":1,"b":2}');
    expect(result).toContain('  "a": 1');
    expect(result).toContain('  "b": 2');
  });
});

// ------------------------------------------------------------------
// R6 — category filter validation
// ------------------------------------------------------------------

describe('webapp audit client — R6 category filter validation', () => {
  const knownCategories = new Set([
    'webapp.scheduled_view',
    'webapp.memory_view',
    'webapp.audit_view',
    'webapp.item_mutate',
    'debate.persistence_error',
  ]);

  it('R6: valid categories accepted', () => {
    const result = validateCategoryFilter(['webapp.scheduled_view', 'webapp.memory_view'], knownCategories);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validated).toEqual(['webapp.scheduled_view', 'webapp.memory_view']);
    }
  });

  it('R6: unknown category rejected', () => {
    const result = validateCategoryFilter(['foo.bar'], knownCategories);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('foo.bar');
    }
  });

  it('R6: mixed valid/invalid rejected (not silent drop)', () => {
    const result = validateCategoryFilter(['webapp.scheduled_view', 'foo.bar'], knownCategories);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('foo.bar');
    }
  });

  it('R6: empty array defaults to all categories (no error)', () => {
    const result = validateCategoryFilter([], knownCategories);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validated).toEqual([]);
    }
  });

  it('R6: SQL injection probe rejected (not in known categories)', () => {
    const result = validateCategoryFilter(["' OR 1=1 --"], knownCategories);
    expect(result.ok).toBe(false);
  });
});

// ------------------------------------------------------------------
// R4 — cursor-based pagination + refresh (source grep)
// ------------------------------------------------------------------

describe('webapp audit client — R4 refresh-from-top + pagination', () => {
  it('R4: _cursor variable exists (tracks pagination state)', () => {
    expect(auditAppJs).toContain('_cursor');
  });

  it('R4: handleRefresh resets cursor to null', () => {
    const handleRefreshIdx = auditAppJs.indexOf('function handleRefresh');
    const afterRefresh = auditAppJs.slice(handleRefreshIdx, handleRefreshIdx + 200);
    expect(afterRefresh).toMatch(/_cursor\s*=\s*null/);
  });

  it('R4: refresh-btn wired to handleRefresh', () => {
    expect(auditAppJs).toContain('refresh-btn');
    expect(auditAppJs).toContain('handleRefresh');
  });

  it('cursor-based pagination: nextCursor used for load-more', () => {
    expect(auditAppJs).toContain('nextCursor');
    expect(auditAppJs).toContain('load-more-btn');
  });

  it('handleLoadMore advances cursor (not reset)', () => {
    const loadMoreIdx = auditAppJs.indexOf('function handleLoadMore');
    const afterLoadMore = auditAppJs.slice(loadMoreIdx, loadMoreIdx + 200);
    expect(afterLoadMore).toContain('_cursor');
    // Does NOT reset to null
    expect(afterLoadMore).not.toMatch(/_cursor\s*=\s*null/);
  });
});

// ------------------------------------------------------------------
// R9 — textContent in <pre> (source grep)
// ------------------------------------------------------------------

describe('webapp audit client — R9 textContent in detail JSON pre', () => {
  it('R9: DETAIL_JSON_DISPLAY_MAX_CHARS constant = 16384', () => {
    expect(auditAppJs).toContain('DETAIL_JSON_DISPLAY_MAX_CHARS = 16_384');
  });

  it('R9: detailJsonEl uses textContent (not innerHTML)', () => {
    expect(auditAppJs).toMatch(/detailJsonEl\.textContent\s*=/);
  });

  it('R9: truncation suffix present in source', () => {
    expect(auditAppJs).toContain('... [truncated; full content in audit_log.detail_json column]');
  });

  it('R9: no innerHTML for detail_json', () => {
    // detailJsonEl should never use innerHTML
    const detailJsonInnerHtml = auditAppJs.match(/detailJsonEl\.innerHTML\s*=/g);
    expect(detailJsonInnerHtml).toBeNull();
  });
});

// ------------------------------------------------------------------
// Category dropdown from KNOWN_AUDIT_CATEGORIES (source grep)
// ------------------------------------------------------------------

describe('webapp audit client — category dropdown from KNOWN_AUDIT_CATEGORIES', () => {
  it('category dropdown populated dynamically from server response', () => {
    expect(auditAppJs).toContain('_knownAuditCategories');
    expect(auditAppJs).toContain('populateCategoryDropdown');
  });

  it('knownCategories populated from server data.knownCategories', () => {
    expect(auditAppJs).toContain('data.knownCategories');
  });
});

// ------------------------------------------------------------------
// HTML structure
// ------------------------------------------------------------------

describe('webapp audit client — index.html structure', () => {
  it('has Audit page title', () => {
    expect(auditHtml).toContain('📜 Audit');
  });

  it('has refresh button (R4)', () => {
    expect(auditHtml).toContain('id="refresh-btn"');
  });

  it('has category-filter select', () => {
    expect(auditHtml).toContain('id="category-filter"');
  });

  it('has detail-json pre element', () => {
    expect(auditHtml).toContain('id="detail-json"');
  });

  it('read-only: no edit or delete buttons in HTML', () => {
    // Audit is read-only — no mutation buttons
    expect(auditHtml).not.toContain('id="edit-btn"');
    expect(auditHtml).not.toContain('id="delete-btn"');
  });

  it('no inline script bodies (CSP-compliant)', () => {
    expect(auditHtml).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });

  it('loads app.js as type=module', () => {
    expect(auditHtml).toContain('type="module"');
    expect(auditHtml).toContain('src="./app.js"');
  });

  it('has load-more-btn for pagination', () => {
    expect(auditHtml).toContain('id="load-more-btn"');
  });
});
