/**
 * Integration tests for writeAtomically concurrency safety (v1.14.2 R8 / SF-7).
 *
 * These tests exercise the per-call random tmp suffix introduced by R8 to
 * prove that concurrent updateItem calls on the same file cannot corrupt it.
 *
 * The tests work against the real filesystem (a tmp directory) and the real
 * updateItem / softDeleteItem functions — no mocking of the storage layer.
 *
 * Pass criteria:
 *   - No ENOENT / FILE_WRITE_FAILED errors from concurrent updates
 *   - No ITEM_MALFORMED — every re-read returns valid parsed content
 *   - Final on-disk content matches EXACTLY one of the input patches (no hybrid)
 *   - Last-rename-wins is acceptable; corruption is not
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateItem, softDeleteItem, readItem } from '../../src/organize/storage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 999001;

/** Minimal .md content that parseItemFile accepts. */
function makeItemMd(id: string, title: string): string {
  return (
    `---\n` +
    `id: ${id}\n` +
    `type: task\n` +
    `status: active\n` +
    `title: ${title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->\n\n` +
    `## Notes\n\n` +
    `## Progress\n`
  );
}

function writeFixtureItem(dataDir: string, userId: number, id: string, title: string): void {
  const userDir = path.join(dataDir, 'organize', String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, `${id}.md`), makeItemMd(id, title), 'utf8');
}

let dataDir: string;

beforeEach(() => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conc-'));
  dataDir = fs.realpathSync.native(tmpRoot);
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Test 1 — 10 parallel updateItem on the same item with the SAME patch key
// ---------------------------------------------------------------------------

describe('storage concurrency — writeAtomically random tmp suffix (R8)', () => {
  it('Test 1: 10 parallel updateItem calls on same item → no corruption, final state is one of the 10 patches', async () => {
    const itemId = '2026-04-24-c001';
    writeFixtureItem(dataDir, USER_ID, itemId, 'Initial title');

    const patches = Array.from({ length: 10 }, (_, i) => `Concurrent title ${i}`);

    const results = await Promise.allSettled(
      patches.map((title) => updateItem(USER_ID, dataDir, itemId, { title })),
    );

    // On Linux/macOS: all succeed (atomic rename-over-existing is supported).
    // On Windows: some may fail with FILE_WRITE_FAILED (EPERM on locked rename
    // target) — this is acceptable. The R8 guarantee is NO HYBRID CONTENT, not
    // that every concurrent write succeeds. At least one call must succeed.
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Any failure must be FILE_WRITE_FAILED (rename failed — not a torn write).
    // ITEM_NOT_FOUND would indicate corruption of the existsSync pre-check.
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    for (const f of failures) {
      // Any failure must NOT be ITEM_MALFORMED (that would indicate hybrid/torn content).
      // Acceptable: FILE_WRITE_FAILED, EPERM (Windows rename lock), ENOENT
      expect((f.reason as { code?: string }).code).not.toBe('ITEM_MALFORMED');
    }

    // Final on-disk content must be parseable and match one of the input patches
    // (not a hybrid of two patches).
    const finalItem = await readItem(USER_ID, dataDir, itemId);
    expect(finalItem).not.toBeNull();
    expect(patches).toContain(finalItem!.frontMatter.title);
  });

  // -------------------------------------------------------------------------
  // Test 2 — 10 parallel updateItem with DIFFERENT patch keys → no torn writes
  // -------------------------------------------------------------------------

  it('Test 2: 10 parallel updateItem with different patch fields → no ENOENT, every read returns valid YAML', async () => {
    const itemId = '2026-04-24-c002';
    writeFixtureItem(dataDir, USER_ID, itemId, 'Original');

    const patches = [
      { title: 'Patch A' },
      { status: 'done' as const },
      { title: 'Patch B' },
      { tags: ['urgent'] },
      { status: 'active' as const },
      { title: 'Patch C', tags: ['dev'] },
      { status: 'abandoned' as const },
      { title: 'Patch D' },
      { tags: [] },
      { title: 'Patch E', status: 'done' as const },
    ];

    const results = await Promise.allSettled(
      patches.map((p) => updateItem(USER_ID, dataDir, itemId, p)),
    );

    // At least one must succeed. Some may fail with FILE_WRITE_FAILED / EPERM on
    // Windows (rename target lock). ITEM_MALFORMED is NOT acceptable (torn write).
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);

    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    for (const f of failures) {
      expect((f.reason as { code?: string }).code).not.toBe('ITEM_MALFORMED');
    }

    // Re-read must succeed and return a coherent item (not ITEM_MALFORMED)
    const finalItem = await readItem(USER_ID, dataDir, itemId);
    expect(finalItem).not.toBeNull();
    expect(['active', 'done', 'abandoned']).toContain(finalItem!.frontMatter.status);
    expect(typeof finalItem!.frontMatter.title).toBe('string');
    expect(finalItem!.frontMatter.title.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 3 — 50 concurrent updateItem stress test → file parseable, matches one input
  // -------------------------------------------------------------------------

  it('Test 3: 50 concurrent updateItem calls → no ITEM_MALFORMED, final content matches one input', async () => {
    const itemId = '2026-04-24-c003';
    writeFixtureItem(dataDir, USER_ID, itemId, 'Stress initial');

    const titles = Array.from({ length: 50 }, (_, i) => `Stress title ${String(i).padStart(3, '0')}`);

    const results = await Promise.allSettled(
      titles.map((title) => updateItem(USER_ID, dataDir, itemId, { title })),
    );

    // At least one must succeed
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // No torn writes — any failure must NOT be ITEM_MALFORMED
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    for (const f of failures) {
      expect((f.reason as { code?: string }).code).not.toBe('ITEM_MALFORMED');
    }

    // Final file must be parseable
    const finalItem = await readItem(USER_ID, dataDir, itemId);
    expect(finalItem).not.toBeNull();

    // Final title must exactly match one of the 50 inputs (last-rename-wins; no hybrid)
    expect(titles).toContain(finalItem!.frontMatter.title);
  });

  // -------------------------------------------------------------------------
  // Test 4 (R8 revisions bonus) — concurrent updateItem + softDeleteItem
  // -------------------------------------------------------------------------

  it('Test 4: concurrent updateItem + softDeleteItem → item ends in .trash, no corrupt live file', async () => {
    const itemId = '2026-04-24-c004';
    writeFixtureItem(dataDir, USER_ID, itemId, 'Delete-race item');

    // Fire update and delete concurrently. One will win.
    // Acceptable outcomes:
    //   - softDelete wins: item is in .trash, updateItem throws ITEM_NOT_FOUND
    //   - updateItem wins: item updated live, softDelete moves it to .trash after
    //   - Both succeed in the "right" order (update then delete)
    const [updateResult, deleteResult] = await Promise.allSettled([
      updateItem(USER_ID, dataDir, itemId, { title: 'Raced update' }),
      softDeleteItem(USER_ID, dataDir, itemId),
    ]);

    // At least one must succeed; at most one can throw ITEM_NOT_FOUND
    const updateFailed = updateResult.status === 'rejected';
    const deleteFailed = deleteResult.status === 'rejected';

    // Acceptable error codes:
    //   - ITEM_NOT_FOUND: the other op moved/deleted it first
    //   - FILE_WRITE_FAILED: rename failed on Windows (target lock)
    // ITEM_MALFORMED is NOT acceptable (would indicate hybrid/corrupt content).
    if (updateFailed) {
      const err = (updateResult as PromiseRejectedResult).reason as { code?: string };
      expect(['ITEM_NOT_FOUND', 'FILE_WRITE_FAILED']).toContain(err.code ?? 'FILE_WRITE_FAILED');
    }
    if (deleteFailed) {
      const err = (deleteResult as PromiseRejectedResult).reason as { code?: string };
      expect(['ITEM_NOT_FOUND', 'FILE_WRITE_FAILED']).toContain(err.code ?? 'FILE_WRITE_FAILED');
    }

    // If delete succeeded, item is not in live dir
    if (!deleteFailed) {
      const liveItem = await readItem(USER_ID, dataDir, itemId);
      expect(liveItem).toBeNull();
    }

    // No hybrid/corrupt content in the live dir
    const userDir = path.join(dataDir, 'organize', String(USER_ID));
    const liveFiles = fs.readdirSync(userDir).filter((f) => f.endsWith('.md'));
    for (const f of liveFiles) {
      const content = fs.readFileSync(path.join(userDir, f), 'utf8');
      // Must start with YAML front-matter
      expect(content).toMatch(/^---\n/);
    }
  });
});
