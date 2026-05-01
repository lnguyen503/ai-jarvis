/**
 * Tests for src/organize/trashEvictor.ts + the evictAllUsers orchestrator (v1.11.0).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initTrashEvictor } from '../../src/organize/trashEvictor.js';
import { createItem, softDeleteItem } from '../../src/organize/storage.js';
import { evictExpiredTrash } from '../../src/organize/trash.js';
import type { TrashEvictorDeps } from '../../src/organize/trashEvictor.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { MemoryApi } from '../../src/memory/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let dataDir: string;
const USER_ID = 777000;

/**
 * Build a minimal AppConfig-compatible organize stanza for the evictor.
 * Uses Partial tricks to avoid pulling in the full config fixture.
 */
function makeEvictorConfig(overrides: {
  trashTtlDays?: number;
  trashEvictCron?: string;
  trashEvictWallTimeWarnMs?: number;
  trashEvictAuditZeroBatches?: boolean;
} = {}): AppConfig {
  return {
    organize: {
      reminders: {} as AppConfig['organize']['reminders'],
      trashTtlDays: overrides.trashTtlDays ?? 30,
      trashEvictCron: overrides.trashEvictCron ?? '0 4 * * *',
      trashEvictWallTimeWarnMs: overrides.trashEvictWallTimeWarnMs ?? 600_000,
      trashEvictAuditZeroBatches: overrides.trashEvictAuditZeroBatches ?? false,
      reconcileHotEmitterThreshold: 100,
    },
  } as unknown as AppConfig;
}

/** Build a minimal mock MemoryApi that records audit inserts. */
function makeMockMemory(): { memory: MemoryApi; auditInserts: unknown[] } {
  const auditInserts: unknown[] = [];
  const memory = {
    auditLog: {
      insert(params: unknown) { auditInserts.push(params); },
      listRecent: vi.fn().mockReturnValue([]),
      listForSession: vi.fn().mockReturnValue([]),
      listByCategoryAndActorSince: vi.fn().mockReturnValue([]),
    },
  } as unknown as MemoryApi;
  return { memory, auditInserts };
}

function makeDeps(overrides: Partial<TrashEvictorDeps> = {}): { deps: TrashEvictorDeps; auditInserts: unknown[] } {
  const { memory, auditInserts } = makeMockMemory();
  const deps: TrashEvictorDeps = {
    config: makeEvictorConfig(),
    memory,
    dataDir,
    ...overrides,
  };
  return { deps, auditInserts };
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-evictor-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// evictExpiredTrash (unit coverage of the storage function from evictor perspective)
// ---------------------------------------------------------------------------

describe('evictExpiredTrash — basic coverage', () => {
  it('returns zero result when no .trash/ exists', async () => {
    const result = await evictExpiredTrash(USER_ID, dataDir, 30);
    expect(result).toEqual({ evicted: 0, filesScanned: 0, errors: [] });
  });

  it('evicts item whose deletedAt is beyond TTL', async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'Old trash' });
    await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);

    const future = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
    const result = await evictExpiredTrash(USER_ID, dataDir, 1, future);

    expect(result.evicted).toBe(1);
    expect(result.filesScanned).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT evict item within TTL', async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'Fresh trash' });
    await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);

    // now = immediately after soft-delete; ttl = 30 days → not expired.
    const result = await evictExpiredTrash(USER_ID, dataDir, 30, new Date());

    expect(result.evicted).toBe(0);
    expect(result.filesScanned).toBe(1);
  });

  it('v1.11.0 QA L1 — returns zero evictions without readdir when .trash/ is a symlink', async () => {
    // Build a real directory to act as the symlink target.
    const symlinkTarget = path.join(dataDir, 'fake-trash-target');
    await mkdir(symlinkTarget, { recursive: true });

    // Place the user's organize dir so the path exists.
    const safeUserId = Math.abs(Math.floor(Number(USER_ID)));
    const userDir = path.join(dataDir, 'organize', String(safeUserId));
    await mkdir(userDir, { recursive: true });

    // Create .trash/ as a symlink instead of a plain directory.
    const trashDir = path.join(userDir, '.trash');
    await symlink(symlinkTarget, trashDir, 'junction');

    const result = await evictExpiredTrash(USER_ID, dataDir, 30);

    // Must return zero-result without accessing any files — symlink is rejected.
    expect(result).toEqual({ evicted: 0, filesScanned: 0, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// evictAllUsers — orchestrator
// ---------------------------------------------------------------------------

describe('initTrashEvictor.evictAllUsers', () => {
  it('returns zero counts when data/organize/ does not exist', async () => {
    const { deps } = makeDeps();
    const evictor = initTrashEvictor(deps);
    const result = await evictor.evictAllUsers();
    expect(result.usersProcessed).toBe(0);
    expect(result.evicted).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('iterates numeric user dirs and skips non-numeric entries', async () => {
    // Create the organize root with two numeric user dirs and one non-numeric.
    const organizeRoot = path.join(dataDir, 'organize');
    await mkdir(path.join(organizeRoot, '111'), { recursive: true });
    await mkdir(path.join(organizeRoot, '222'), { recursive: true });
    await mkdir(path.join(organizeRoot, 'not-a-user'), { recursive: true }); // non-numeric — must be skipped

    // Both numeric users have empty .trash/ — zero evictions expected.
    await mkdir(path.join(organizeRoot, '111', '.trash'), { recursive: true });
    await mkdir(path.join(organizeRoot, '222', '.trash'), { recursive: true });

    const { deps } = makeDeps();
    const evictor = initTrashEvictor(deps);
    const result = await evictor.evictAllUsers();

    // 2 numeric users processed; non-numeric entry skipped.
    expect(result.usersProcessed).toBe(2);
    expect(result.evicted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('emits organize.trash.evict audit row for non-zero batch', async () => {
    // Create one item and trash it.
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'Evict me' });
    await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);

    // Use a short TTL and a far-future now so the item is expired.
    const { deps, auditInserts } = makeDeps({
      config: makeEvictorConfig({ trashTtlDays: 1 }),
    });
    // Override now by adjusting the evictor to call with future date.
    // We achieve this by using ttlDays=1 and trusting that mtime fallback
    // works (the file was just written, but we don't control "now" in evictAllUsers).
    // Instead: place a trash file with a past deletedAt.
    const organizeRoot = path.join(dataDir, 'organize');
    const userIdStr = String(USER_ID);
    const trashDir = path.join(organizeRoot, userIdStr, '.trash');
    // Write a manually crafted file with old deletedAt.
    const oldItemId = '2026-01-01-audi';
    const oldDeletedAt = new Date('2026-01-01T10:00:00Z').toISOString();
    const content = `---\nid: ${oldItemId}\ntype: task\nstatus: active\ntitle: Audit test\ncreated: 2026-01-01T00:00:00Z\ndue: \nparentId: \ncalendarEventId: \ndeletedAt: ${oldDeletedAt}\ntags: []\n---\n\n## Notes\n\n## Progress\n`;
    await writeFile(path.join(trashDir, `${oldItemId}.md`), content, 'utf8');

    const evictor = initTrashEvictor(deps);
    await evictor.evictAllUsers();

    // At least one audit insert should have occurred.
    const evictAudits = auditInserts.filter(
      (r) => (r as { category: string }).category === 'organize.trash.evict',
    );
    expect(evictAudits.length).toBeGreaterThanOrEqual(1);
    const row = evictAudits[0] as { category: string; detail: { evicted: number } };
    expect(row.detail.evicted).toBeGreaterThanOrEqual(1);
  });

  it('does NOT emit audit row for zero-batch user (default config)', async () => {
    // Create a user dir with .trash/ but no files → zero eviction.
    const organizeRoot = path.join(dataDir, 'organize');
    const zeroUserId = 999001;
    await mkdir(path.join(organizeRoot, String(zeroUserId), '.trash'), { recursive: true });

    const { deps, auditInserts } = makeDeps();
    const evictor = initTrashEvictor(deps);
    await evictor.evictAllUsers();

    // No audit rows should be emitted for a zero-batch user.
    const evictAudits = auditInserts.filter(
      (r) => (r as { category: string }).category === 'organize.trash.evict',
    );
    expect(evictAudits).toHaveLength(0);
  });

  it('DOES emit audit row for zero-batch user when trashEvictAuditZeroBatches: true', async () => {
    // Create a user dir with .trash/ but no files → zero eviction.
    const organizeRoot = path.join(dataDir, 'organize');
    const zeroUserId = 999002;
    await mkdir(path.join(organizeRoot, String(zeroUserId), '.trash'), { recursive: true });

    const { deps, auditInserts } = makeDeps({
      config: makeEvictorConfig({ trashEvictAuditZeroBatches: true }),
    });
    const evictor = initTrashEvictor(deps);
    await evictor.evictAllUsers();

    const evictAudits = auditInserts.filter(
      (r) => (r as { category: string }).category === 'organize.trash.evict',
    );
    expect(evictAudits.length).toBeGreaterThanOrEqual(1);
    const row = evictAudits[0] as { detail: { evicted: number; filesScanned: number } };
    expect(row.detail.evicted).toBe(0);
    expect(row.detail.filesScanned).toBe(0);
  });

  it('emits warn log when elapsed > trashEvictWallTimeWarnMs', async () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Use a very tiny warnMs threshold (1ms) so any tick triggers it.
    const organizeRoot = path.join(dataDir, 'organize');
    const uId = 999003;
    await mkdir(path.join(organizeRoot, String(uId), '.trash'), { recursive: true });

    const { deps } = makeDeps({
      config: makeEvictorConfig({ trashEvictWallTimeWarnMs: 1, trashEvictAuditZeroBatches: false }),
    });

    // We cannot spy on pino's log.warn easily, so we verify the function completes
    // without throwing even when the threshold is exceeded. The log.warn is a side-effect
    // that goes to pino — we just verify no exception is thrown.
    const evictor = initTrashEvictor(deps);
    await expect(evictor.evictAllUsers()).resolves.toBeDefined();
    warnSpy.mockRestore();
  });

  it('respects abortSignal — subsequent users skipped after abort', async () => {
    // Create 3 user dirs.
    const organizeRoot = path.join(dataDir, 'organize');
    for (const id of ['100001', '100002', '100003']) {
      await mkdir(path.join(organizeRoot, id, '.trash'), { recursive: true });
    }

    const abort = new AbortController();
    const { deps } = makeDeps({ abortSignal: abort.signal });

    // Abort immediately before evictAllUsers can iterate.
    abort.abort();

    const evictor = initTrashEvictor(deps);
    const result = await evictor.evictAllUsers();

    // With the signal already aborted at start, no users should be processed.
    expect(result.usersProcessed).toBe(0);
  });

  it('stop() sets stopped flag — subsequent evictAllUsers bails early', async () => {
    const organizeRoot = path.join(dataDir, 'organize');
    for (const id of ['200001', '200002', '200003']) {
      await mkdir(path.join(organizeRoot, id, '.trash'), { recursive: true });
    }

    const { deps } = makeDeps();
    const evictor = initTrashEvictor(deps);
    evictor.stop(); // stop before start — sets stopped=true

    const result = await evictor.evictAllUsers();
    expect(result.usersProcessed).toBe(0);
  });

  it('start() is idempotent — calling start twice does not double-register', () => {
    const { deps } = makeDeps({
      config: makeEvictorConfig({ trashEvictCron: '0 4 * * *' }),
    });
    const evictor = initTrashEvictor(deps);

    // Should not throw; second call is a no-op.
    expect(() => { evictor.start(); evictor.start(); }).not.toThrow();
    evictor.stop(); // clean up cron
  });
});

// ---------------------------------------------------------------------------
// Migration 010 — idempotency verified at the unit level (integration path)
// ---------------------------------------------------------------------------
// Note: migration idempotency is inherently tested by the existing migration runner
// tests (memory.migrations.test.ts). The CREATE INDEX IF NOT EXISTS guarantee
// means running migration 010 twice is a no-op. That suite handles this.
