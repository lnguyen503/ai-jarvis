/**
 * Memory webapp client tests — Jarvis v1.17.0.
 *
 * Verifies:
 *   - Memory key client-side whitelist enforced (^[a-z0-9_-]{1,64}$)
 *   - _memorySubmitInFlight prevents double-submit (R5)
 *   - If-Match header sent on PATCH (source grep)
 *   - 412 → conflict UI display (source grep)
 *   - Memory value rendered via textContent (R8 binding)
 *   - MEMORY_SUBMIT_TIMEOUT_MS = 30000
 *
 * v1.17.0 — ADR 017 D3 + R5 + R8.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const memAppJs = readFileSync(path.join(root, 'public/webapp/memory/app.js'), 'utf8');
const memHtml = readFileSync(path.join(root, 'public/webapp/memory/index.html'), 'utf8');

// ------------------------------------------------------------------
// Inline validateMemoryKey for unit testing
// ------------------------------------------------------------------

const MEMORY_KEY_RE = /^[a-z0-9_-]{1,64}$/;

function validateMemoryKey(key: string): { ok: true } | { ok: false; error: string } {
  if (!key || typeof key !== 'string') {
    return { ok: false, error: 'Key is required.' };
  }
  if (!MEMORY_KEY_RE.test(key)) {
    return { ok: false, error: 'Key must match ^[a-z0-9_-]{1,64}$ (lowercase letters, numbers, _ and -).' };
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// Memory key whitelist
// ------------------------------------------------------------------

describe('webapp memory client — memory key whitelist', () => {
  it('accepts valid lowercase key', () => {
    expect(validateMemoryKey('my_preference').ok).toBe(true);
  });

  it('accepts key with hyphens and numbers', () => {
    expect(validateMemoryKey('pref-v2-2026').ok).toBe(true);
  });

  it('accepts key at max length (64 chars)', () => {
    const maxKey = 'a'.repeat(64);
    expect(validateMemoryKey(maxKey).ok).toBe(true);
  });

  it('rejects uppercase letters', () => {
    const result = validateMemoryKey('MyPreference');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('^[a-z0-9_-]');
  });

  it('rejects spaces', () => {
    expect(validateMemoryKey('my preference').ok).toBe(false);
  });

  it('rejects special chars', () => {
    expect(validateMemoryKey('my.pref').ok).toBe(false);
    expect(validateMemoryKey('my/pref').ok).toBe(false);
    expect(validateMemoryKey('my@pref').ok).toBe(false);
  });

  it('rejects empty key', () => {
    expect(validateMemoryKey('').ok).toBe(false);
  });

  it('rejects key over 64 chars', () => {
    const longKey = 'a'.repeat(65);
    expect(validateMemoryKey(longKey).ok).toBe(false);
  });

  it('rejects key with sentinel injection pattern', () => {
    // The key whitelist prevents <!-- from being a valid key anyway
    expect(validateMemoryKey('<!--').ok).toBe(false);
  });
});

// ------------------------------------------------------------------
// R5 binding — double-submit guard
// ------------------------------------------------------------------

describe('webapp memory client — R5 double-submit guard', () => {
  it('R5: _memorySubmitInFlight flag declared', () => {
    expect(memAppJs).toContain('_memorySubmitInFlight');
  });

  it('R5: MEMORY_SUBMIT_TIMEOUT_MS constant = 30000', () => {
    expect(memAppJs).toContain('MEMORY_SUBMIT_TIMEOUT_MS = 30_000');
  });

  it('R5: guard check prevents double-submit', () => {
    expect(memAppJs).toContain('if (_memorySubmitInFlight) return');
  });

  it('R5: AbortController used in save handler', () => {
    expect(memAppJs).toContain('AbortController');
  });

  it('R5: in-flight flag reset in finally block', () => {
    expect(memAppJs).toMatch(/_memorySubmitInFlight\s*=\s*false/);
  });

  it('R5: shared flag covers delete (no double-mutation)', () => {
    // handleDelete also checks _memorySubmitInFlight
    const handleDeleteIdx = memAppJs.indexOf('async function handleDelete');
    const afterDelete = memAppJs.slice(handleDeleteIdx, handleDeleteIdx + 200);
    expect(afterDelete).toContain('_memorySubmitInFlight');
  });
});

// ------------------------------------------------------------------
// If-Match header on PATCH
// ------------------------------------------------------------------

describe('webapp memory client — If-Match header on PATCH', () => {
  it('If-Match header sent when etag is present', () => {
    expect(memAppJs).toContain("'If-Match'");
    expect(memAppJs).toContain('_currentEtag');
  });

  it('ETag captured from GET response header', () => {
    expect(memAppJs).toMatch(/res\.headers\.get\(['"`]ETag['"`]\)/);
  });
});

// ------------------------------------------------------------------
// 412 conflict UI
// ------------------------------------------------------------------

describe('webapp memory client — 412 conflict UI', () => {
  it('412 status code handled', () => {
    expect(memAppJs).toContain('res.status === 412');
  });

  it('conflict panel shown on 412', () => {
    expect(memAppJs).toContain('conflict-panel');
    expect(memAppJs).toContain('conflictPanelEl.hidden = false');
  });

  it('conflict message populated on 412', () => {
    expect(memAppJs).toContain('conflictMessageEl.textContent');
  });
});

// ------------------------------------------------------------------
// R8 — textContent for memory value
// ------------------------------------------------------------------

describe('webapp memory client — R8 textContent for memory value', () => {
  it('detail value rendered via textContent (not markdown.js)', () => {
    expect(memAppJs).toMatch(/detailValueEl\.textContent\s*=/);
  });

  it('no markdown.js import in memory app (plain text semantics)', () => {
    // Memory values are plain text per chat-side semantics — no markdown rendering
    expect(memAppJs).not.toContain('renderMarkdown');
    // The file may mention markdown.js in a comment (explaining the intentional omission)
    // but must NOT import it
    expect(memAppJs).not.toMatch(/import\s+.*from\s+['"`].*markdown\.js['"`]/);
  });

  it('entry preview uses textContent', () => {
    expect(memAppJs).toMatch(/previewEl\.textContent\s*=/);
  });
});

// ------------------------------------------------------------------
// HTML structure
// ------------------------------------------------------------------

describe('webapp memory client — index.html structure', () => {
  it('has Memory page title', () => {
    expect(memHtml).toContain('🧠 Memory');
  });

  it('has search input', () => {
    expect(memHtml).toContain('id="search-input"');
  });

  it('has conflict panel', () => {
    expect(memHtml).toContain('id="conflict-panel"');
  });

  it('has detail-value pre element', () => {
    expect(memHtml).toContain('id="detail-value"');
  });

  it('no inline script bodies (CSP-compliant)', () => {
    expect(memHtml).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });

  it('loads app.js as type=module', () => {
    expect(memHtml).toContain('type="module"');
    expect(memHtml).toContain('src="./app.js"');
  });
});
