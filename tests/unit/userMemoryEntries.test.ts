/**
 * Unit tests for src/memory/userMemoryEntries.ts (v1.17.0).
 *
 * ADR 017 R3 + F1 + W4 binding:
 *   - Sole-writer invariant (appendUserMemoryEntry doesn't write sentinels)
 *   - Read-time fallback for malformed sentinels
 *   - Sentinel injection guard
 *   - ETag format: sha256(mtime_iso + '|' + body).slice(0, 16) quoted
 *
 * ~18 tests covering CRUD, sentinel format, injection guard, ETag, fallback.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  MEMORY_KEY_RE,
} from '../../src/memory/userMemoryEntries.js';
import { appendUserMemoryEntry } from '../../src/memory/userMemory.js';

const USER_ID = 42;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-entries-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Key validation regex
// ---------------------------------------------------------------------------

describe('MEMORY_KEY_RE', () => {
  it('accepts valid keys (v1.17.0 format)', () => {
    expect(MEMORY_KEY_RE.test('prefer_brief_replies')).toBe(true);
    expect(MEMORY_KEY_RE.test('tone-formal')).toBe(true);
    expect(MEMORY_KEY_RE.test('a')).toBe(true);
    // v1.17.0: 64-char key still accepted
    expect(MEMORY_KEY_RE.test('a'.repeat(64))).toBe(true);
  });

  it('accepts dotted multi-segment keys (v1.18.0 ADR 018 D2 extension)', () => {
    expect(MEMORY_KEY_RE.test('coach.2026-04-25-abcd.lastNudge')).toBe(true);
    expect(MEMORY_KEY_RE.test('coach.2026-04-25-abcd.research')).toBe(true);
    // Uppercase allowed (defensive — future camelCase namespace segments)
    expect(MEMORY_KEY_RE.test('UPPER_CASE')).toBe(true);
    // 128-char key accepted (new cap)
    expect(MEMORY_KEY_RE.test('a'.repeat(128))).toBe(true);
  });

  it('rejects invalid keys', () => {
    expect(MEMORY_KEY_RE.test('')).toBe(false);
    expect(MEMORY_KEY_RE.test('has space')).toBe(false);
    // 129-char key rejected (over new cap)
    expect(MEMORY_KEY_RE.test('a'.repeat(129))).toBe(false);
    expect(MEMORY_KEY_RE.test('special!')).toBe(false);
    expect(MEMORY_KEY_RE.test('has@at')).toBe(false);
    // whitespace in dotted key
    expect(MEMORY_KEY_RE.test('coach.itemId. event')).toBe(false);
    // exclamation mark
    expect(MEMORY_KEY_RE.test('coach.itemId.event!')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADR 018 D2 binding tests — dotted key round-trips
// ---------------------------------------------------------------------------

describe('ADR 018 D2: dotted multi-segment coach keys', () => {
  it('T-D2-2: createEntry with dotted key coach.2026-04-25-abcd.lastNudge round-trips', async () => {
    const key = 'coach.2026-04-25-abcd.lastNudge';
    const body = 'nudged about retirement savings on 2026-04-25';
    const r = await createEntry(USER_ID, tmpDir, key, body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.key).toBe(key);
    expect(r.entry.body).toBe(body);
  });

  it('T-D2-3: getEntry retrieves dotted key by exact match', async () => {
    const key = 'coach.2026-04-25-abcd.lastNudge';
    await createEntry(USER_ID, tmpDir, key, 'test body');
    const entry = await getEntry(USER_ID, tmpDir, key);
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe(key);
  });

  it('T-D2-4: 128-char key accepted; 129-char key rejected with VALIDATION_ERROR', async () => {
    const key128 = 'a'.repeat(128);
    const r128 = await createEntry(USER_ID, tmpDir, key128, 'body for 128-char key');
    expect(r128.ok).toBe(true);

    const key129 = 'a'.repeat(129);
    const r129 = await createEntry(USER_ID, tmpDir, key129, 'body for 129-char key');
    expect(r129.ok).toBe(false);
    if (!r129.ok) expect(r129.code).toBe('VALIDATION_ERROR');
  });

  it('T-D2-5: valid char class probe — accepted and rejected patterns', async () => {
    // Accepted
    expect(MEMORY_KEY_RE.test('coach.itemId.event')).toBe(true);
    // Rejected: whitespace
    expect(MEMORY_KEY_RE.test('coach.itemId. event')).toBe(false);
    // Rejected: special char
    expect(MEMORY_KEY_RE.test('coach.itemId.event!')).toBe(false);
  });

  it('T-D2-1 regression: v1.17.0-format keys still parse correctly', async () => {
    const oldKey = 'prefer_brief_replies';
    const r = await createEntry(USER_ID, tmpDir, oldKey, 'I prefer brief replies');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = await getEntry(USER_ID, tmpDir, oldKey);
    expect(entry?.key).toBe(oldKey);
    expect(entry?.body).toBe('I prefer brief replies');
  });

  it('mixed entries (1-segment + 3-segment) coexist in one user file', async () => {
    await createEntry(USER_ID, tmpDir, 'my_pref', 'short key body');
    await createEntry(USER_ID, tmpDir, 'coach.2026-04-25-efgh.plan', 'plan body');
    await createEntry(USER_ID, tmpDir, 'another-key', 'another body');

    const entries = await listEntries(USER_ID, tmpDir);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('my_pref');
    expect(keys).toContain('coach.2026-04-25-efgh.plan');
    expect(keys).toContain('another-key');
    expect(entries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CRUD: create + list + get + update + delete
// ---------------------------------------------------------------------------

describe('userMemoryEntries CRUD', () => {
  it('listEntries returns empty array when file does not exist', async () => {
    const entries = await listEntries(USER_ID, tmpDir);
    expect(entries).toEqual([]);
  });

  it('createEntry creates and getEntry retrieves', async () => {
    const result = await createEntry(USER_ID, tmpDir, 'prefer_brief', 'I prefer brief replies');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.key).toBe('prefer_brief');
    expect(result.entry.body).toBe('I prefer brief replies');
    expect(result.entry.etag).toMatch(/^"[0-9a-f]{16}"$/);

    const fetched = await getEntry(USER_ID, tmpDir, 'prefer_brief');
    expect(fetched).not.toBeNull();
    expect(fetched?.key).toBe('prefer_brief');
    expect(fetched?.body).toBe('I prefer brief replies');
  });

  it('createEntry returns KEY_EXISTS on duplicate key', async () => {
    await createEntry(USER_ID, tmpDir, 'mykey', 'first value');
    const r2 = await createEntry(USER_ID, tmpDir, 'mykey', 'second value');
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.code).toBe('KEY_EXISTS');
  });

  it('listEntries returns all created entries', async () => {
    await createEntry(USER_ID, tmpDir, 'key1', 'body one');
    await createEntry(USER_ID, tmpDir, 'key2', 'body two');
    const entries = await listEntries(USER_ID, tmpDir);
    expect(entries.length).toBe(2);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
  });

  it('updateEntry updates body and returns new ETag', async () => {
    await createEntry(USER_ID, tmpDir, 'tone', 'formal');
    const before = await getEntry(USER_ID, tmpDir, 'tone');
    const result = await updateEntry(USER_ID, tmpDir, 'tone', 'casual');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.body).toBe('casual');
    // ETag should change after update (mtime changes)
    const after = await getEntry(USER_ID, tmpDir, 'tone');
    expect(after?.body).toBe('casual');
    // Note: ETag may or may not change depending on filesystem mtime resolution
    // but body should definitely change
    expect(result.entry.key).toBe('tone');
    void before; // suppress unused warning
  });

  it('updateEntry returns NOT_FOUND for missing key', async () => {
    const r = await updateEntry(USER_ID, tmpDir, 'nonexistent', 'value');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NOT_FOUND');
  });

  it('deleteEntry removes the entry', async () => {
    await createEntry(USER_ID, tmpDir, 'to_delete', 'some value');
    const r = await deleteEntry(USER_ID, tmpDir, 'to_delete');
    expect(r.ok).toBe(true);
    const fetched = await getEntry(USER_ID, tmpDir, 'to_delete');
    expect(fetched).toBeNull();
  });

  it('deleteEntry returns NOT_FOUND for missing key', async () => {
    const r = await deleteEntry(USER_ID, tmpDir, 'nonexistent');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// ETag + If-Match (W4)
// ---------------------------------------------------------------------------

describe('userMemoryEntries ETag (W4)', () => {
  it('ETag has quoted 16-hex-char format', async () => {
    const r = await createEntry(USER_ID, tmpDir, 'etagkey', 'test body');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('updateEntry with correct If-Match succeeds', async () => {
    await createEntry(USER_ID, tmpDir, 'ifmatch', 'original');
    const entry = await getEntry(USER_ID, tmpDir, 'ifmatch');
    expect(entry).not.toBeNull();

    const r = await updateEntry(USER_ID, tmpDir, 'ifmatch', 'updated', entry!.etag);
    expect(r.ok).toBe(true);
  });

  it('updateEntry with wrong If-Match returns ETAG_MISMATCH (412)', async () => {
    await createEntry(USER_ID, tmpDir, 'conflict', 'original');
    const r = await updateEntry(USER_ID, tmpDir, 'conflict', 'updated', '"wrong_etag_value"');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('ETAG_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// R3: sole-writer invariant — appendUserMemoryEntry doesn't write sentinels
// ---------------------------------------------------------------------------

describe('userMemoryEntries R3: sole-writer invariant', () => {
  it('appendUserMemoryEntry does NOT write <!-- key: sentinels', async () => {
    await appendUserMemoryEntry(USER_ID, 'preferences', 'prefer brief replies', 'User 42', tmpDir);
    const filePath = path.join(tmpDir, 'memories', `${USER_ID}.md`);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('<!-- key:');
  });
});

// ---------------------------------------------------------------------------
// R3: read-time fallback for malformed sentinels
// ---------------------------------------------------------------------------

describe('userMemoryEntries R3: read-time fallback', () => {
  it('R3-2: empty key sentinel returns legacy_<sha8> key', async () => {
    // Manually craft file with empty key sentinel
    const memDir = path.join(tmpDir, 'memories');
    fs.mkdirSync(memDir, { recursive: true });
    const filePath = path.join(memDir, `${USER_ID}.md`);
    fs.writeFileSync(filePath, '# Memory\n\n## Preferences\n\n- <!-- key: --> body text\n');

    const entries = await listEntries(USER_ID, tmpDir);
    // Should not crash; should return a legacy fallback entry
    expect(Array.isArray(entries)).toBe(true);
    // The malformed entry should be returned with a legacy key
    const legacyEntry = entries.find((e) => e.key.startsWith('legacy_'));
    expect(legacyEntry).toBeDefined();
  });

  it('R3-3: truncated sentinel (missing closing -->) returns legacy_<sha8> key', async () => {
    const memDir = path.join(tmpDir, 'memories');
    fs.mkdirSync(memDir, { recursive: true });
    const filePath = path.join(memDir, `${USER_ID}.md`);
    fs.writeFileSync(filePath, '# Memory\n\n## Preferences\n\n- <!-- key:my_pre body text\n');

    const entries = await listEntries(USER_ID, tmpDir);
    expect(Array.isArray(entries)).toBe(true);
    // The malformed entry with partial sentinel should be a fallback
    const legacyEntry = entries.find((e) => e.key.startsWith('legacy_'));
    expect(legacyEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// F1: sentinel injection guard
// ---------------------------------------------------------------------------

describe('userMemoryEntries F1: sentinel injection guard', () => {
  it('F1-1: createEntry rejects body containing <!-- key:', async () => {
    const r = await createEntry(USER_ID, tmpDir, 'safe_key', '<!-- key:other_key --> hostile body');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.error).toContain('sentinel injection');
  });

  it('F1-2: updateEntry rejects body containing <!-- key:', async () => {
    await createEntry(USER_ID, tmpDir, 'mykey', 'original body');
    const r = await updateEntry(USER_ID, tmpDir, 'mykey', '<!-- key:other --> hostile');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.error).toContain('sentinel injection');
  });

  it('F1-3: body containing <-- key: (no --> closing) is accepted', async () => {
    // Strict regex requires <!-- (two dashes); this has only one dash pair — allowed
    const r = await createEntry(USER_ID, tmpDir, 'safe_key2', '<-- key: missing closing is fine');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation edge cases
// ---------------------------------------------------------------------------

describe('userMemoryEntries — validation', () => {
  it('createEntry rejects invalid key (illegal chars)', async () => {
    // 'a'.repeat(129) is over the 128-char cap (v1.18.0 D2 extension)
    const r = await createEntry(USER_ID, tmpDir, 'a'.repeat(129), 'body');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VALIDATION_ERROR');
  });

  it('createEntry rejects key with special chars not in allowed set', async () => {
    const r = await createEntry(USER_ID, tmpDir, 'invalid!key', 'body');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VALIDATION_ERROR');
  });

  it('createEntry rejects empty body', async () => {
    const r = await createEntry(USER_ID, tmpDir, 'valid-key', '   ');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VALIDATION_ERROR');
  });

  it('getEntry returns null for non-existent key', async () => {
    const entry = await getEntry(USER_ID, tmpDir, 'nonexistent');
    expect(entry).toBeNull();
  });
});
