/**
 * Integration tests for restoreItem storage primitive (v1.14.3 D9 + RA1).
 *
 * Covers:
 *   - Happy path: trash → live, deletedAt stripped, updated stamped
 *   - 404 when item not in trash and not live
 *   - Cross-user isolation
 *   - Idempotent recovery: live exists + trash gone → proceeds to step 2
 *   - ITEM_ALREADY_LIVE when both live and trash exist
 *
 * R5/R12 command-layer 404 branches (QA M3, v1.14.3 Fix 2):
 *   - R-NEW1: typo'd id with similar trash items → R5 Levenshtein matches in reply
 *   - R-NEW2: id with delete audit row >30 days ago → R12 evicted-TTL reply
 *   - R-NEW3: id with delete audit row <30 days ago, file missing → R12 inconsistent reply
 *   - R-NEW4: id with no audit history and no close matches → generic 404 reply
 *   - R-NEW5: id with no audit history, file missing, but close matches → R5 reply (no R12 text)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Context } from 'grammy';
import {
  createItem,
  softDeleteItem,
  listItems,
  organizeUserDir,
} from '../../src/organize/storage.js';
import { restoreItem } from '../../src/organize/trash.js';
import { handleOrganize, type OrganizeCommandDeps } from '../../src/commands/organize.js';
import type { AuditLogRow } from '../../src/memory/auditLog.js';
import type { MemoryApi } from '../../src/memory/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

// Mock isGroupChat so handleOrganize proceeds as a private chat (not DM-blocked)
vi.mock('../../src/gateway/groupGate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway/groupGate.js')>();
  return { ...original, isGroupChat: vi.fn(() => false) };
});

let dataDir: string;
const USER_A = 888001;
const USER_B = 888002;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-restore-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('restoreItem — happy path', () => {
  it('R-1: restore moves item from trash to live, strips deletedAt, stamps updated', async () => {
    const item = await createItem(USER_A, dataDir, { type: 'task', title: 'Task to restore' });
    const itemId = item.frontMatter.id;

    await softDeleteItem(USER_A, dataDir, itemId);

    // Verify it's in trash
    const trashPath = path.join(organizeUserDir(USER_A, dataDir), '.trash', `${itemId}.md`);
    expect(existsSync(trashPath)).toBe(true);

    const livePath = path.join(organizeUserDir(USER_A, dataDir), `${itemId}.md`);
    expect(existsSync(livePath)).toBe(false);

    const restored = await restoreItem(USER_A, dataDir, itemId);

    // deletedAt stripped
    expect(restored.frontMatter.deletedAt).toBeNull();
    // updated stamped
    expect(restored.frontMatter.updated).toBeDefined();
    expect(typeof restored.frontMatter.updated).toBe('string');
    // Title preserved
    expect(restored.frontMatter.title).toBe('Task to restore');
    // File is live now
    expect(existsSync(livePath)).toBe(true);
    // File is no longer in trash
    expect(existsSync(trashPath)).toBe(false);
  });

  it('R-2: restored item appears in listItems (R7 clears deletedAt)', async () => {
    const item = await createItem(USER_A, dataDir, { type: 'goal', title: 'Restore goal' });
    const itemId = item.frontMatter.id;

    await softDeleteItem(USER_A, dataDir, itemId);
    let activeItems = await listItems(USER_A, dataDir, { status: 'active' });
    expect(activeItems.find((i) => i.frontMatter.id === itemId)).toBeUndefined();

    await restoreItem(USER_A, dataDir, itemId);
    activeItems = await listItems(USER_A, dataDir, { status: 'active' });
    expect(activeItems.find((i) => i.frontMatter.id === itemId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 404 paths
// ---------------------------------------------------------------------------

describe('restoreItem — 404 cases', () => {
  it('R-3: throws ITEM_NOT_FOUND_IN_TRASH when id not in trash and not live', async () => {
    await expect(restoreItem(USER_A, dataDir, '2026-04-01-xxxx')).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND_IN_TRASH',
    });
  });

  it('R-4: throws ITEM_NOT_FOUND_IN_TRASH for an id that was never created', async () => {
    // Ensure user dir exists first
    await createItem(USER_A, dataDir, { type: 'task', title: 'Seed' });

    await expect(restoreItem(USER_A, dataDir, '2026-01-01-nope')).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND_IN_TRASH',
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-user isolation
// ---------------------------------------------------------------------------

describe('restoreItem — cross-user isolation', () => {
  it('R-5: user B cannot restore user A\'s trashed item', async () => {
    const item = await createItem(USER_A, dataDir, { type: 'task', title: 'User A task' });
    const itemId = item.frontMatter.id;
    await softDeleteItem(USER_A, dataDir, itemId);

    // User B has no trash dir — should throw
    await expect(restoreItem(USER_B, dataDir, itemId)).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND_IN_TRASH',
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotent recovery (RA1: step-2-only path when live exists + trash gone)
// ---------------------------------------------------------------------------

describe('restoreItem — idempotent recovery', () => {
  it('R-6: when live exists and trash is gone, step-2 runs alone (strip + stamp)', async () => {
    const item = await createItem(USER_A, dataDir, { type: 'task', title: 'Partial restore' });
    const itemId = item.frontMatter.id;

    // Soft-delete to get the deletedAt-stamped file, then manually move it to live dir
    // (simulating a partial restore where rename succeeded but writeAtomically failed)
    const trashPath = path.join(organizeUserDir(USER_A, dataDir), '.trash', `${itemId}.md`);
    const livePath = path.join(organizeUserDir(USER_A, dataDir), `${itemId}.md`);
    const trashDir = path.join(organizeUserDir(USER_A, dataDir), '.trash');

    await softDeleteItem(USER_A, dataDir, itemId);
    // Ensure trash dir exists
    expect(existsSync(trashPath)).toBe(true);

    // Simulate: step 1 (rename) succeeded but step 2 failed — file is live with deletedAt set
    const { rename } = await import('node:fs/promises');
    await rename(trashPath, livePath);

    // Now live has deletedAt, trash is empty — call restoreItem (idempotent recovery path)
    const restored = await restoreItem(USER_A, dataDir, itemId);
    expect(restored.frontMatter.deletedAt).toBeNull();
    expect(restored.frontMatter.updated).toBeDefined();
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('R-7: ITEM_ALREADY_LIVE when both live and trash exist (genuine ambiguity)', async () => {
    const item = await createItem(USER_A, dataDir, { type: 'task', title: 'Ambiguous' });
    const itemId = item.frontMatter.id;
    const userDir = organizeUserDir(USER_A, dataDir);
    const trashDir = path.join(userDir, '.trash');
    const livePath = path.join(userDir, `${itemId}.md`);
    const trashPath = path.join(trashDir, `${itemId}.md`);

    // Create duplicate in trash manually
    await mkdir(trashDir, { recursive: true });
    const raw = await import('node:fs/promises').then((m) => m.readFile(livePath, 'utf8'));
    await writeFile(trashPath, raw, 'utf8');

    // Now both live and trash exist
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(trashPath)).toBe(true);

    await expect(restoreItem(USER_A, dataDir, itemId)).rejects.toMatchObject({
      code: 'ITEM_ALREADY_LIVE',
    });
  });
});

// ---------------------------------------------------------------------------
// R5 + R12 command-layer 404 branches (QA M3 — Fix 2, v1.14.3)
//
// These tests exercise handleOrganize's /organize restore <id> code path
// (commands/organize.ts handleRestoreItemNotFound) — not the storage layer.
// They use a fake Telegraf Context and stub the memory where needed.
// ---------------------------------------------------------------------------

/** Build a minimal fake Context that captures replies. */
function makeCtx(userId: number, text: string) {
  const replies: string[] = [];
  return {
    ctx: {
      chat: { type: 'private', id: userId },
      from: { id: userId },
      message: { text },
      reply: async (msg: string) => { replies.push(msg); },
    } as unknown as Context,
    replies,
  };
}

/** Build a minimal OrganizeCommandDeps with optional findRecentDelete stub. */
function makeDeps(
  options: {
    findRecentDeleteResult?: AuditLogRow | null;
  } = {},
): OrganizeCommandDeps {
  const cfg = makeTestConfig();
  // Override dbPath so resolveDataDir() returns the shared test dataDir.
  // resolveDataDir() uses path.dirname(memory.dbPath), so putting the db file
  // in dataDir makes the organize user dirs resolve correctly.
  cfg.memory.dbPath = path.join(dataDir, 'test.db');

  const deps: OrganizeCommandDeps = {
    config: cfg,
  };

  if (options.findRecentDeleteResult !== undefined) {
    deps.memory = {
      auditLog: {
        findRecentDelete: vi.fn(() => options.findRecentDeleteResult),
      },
    } as unknown as MemoryApi;
  }

  return deps;
}

describe('/organize restore — R5 closest-match 404 paths (QA M3)', () => {
  it('R-NEW1: typo\'d id with 3 similar trash items → reply includes Levenshtein-matched ids with titles', async () => {
    // Create 3 items and soft-delete them to populate trash
    const item1 = await createItem(USER_A, dataDir, { type: 'task', title: 'Alpha task' });
    const item2 = await createItem(USER_A, dataDir, { type: 'task', title: 'Beta task' });
    const item3 = await createItem(USER_A, dataDir, { type: 'task', title: 'Gamma task' });
    await softDeleteItem(USER_A, dataDir, item1.frontMatter.id);
    await softDeleteItem(USER_A, dataDir, item2.frontMatter.id);
    await softDeleteItem(USER_A, dataDir, item3.frontMatter.id);

    // Use the first item's id with a 1-char typo (swap last char) — distance ≤ 4
    const realId = item1.frontMatter.id;
    const typoId = realId.slice(0, -1) + (realId.endsWith('a') ? 'z' : 'a');

    const { ctx, replies } = makeCtx(USER_A, `/organize restore ${typoId}`);
    await handleOrganize(ctx, makeDeps());

    expect(replies.length).toBeGreaterThan(0);
    // R5 match reply includes the real id in a "closest matches" block
    expect(replies[0]).toMatch(/closest matches/i);
    expect(replies[0]).toContain(realId);
  });

  it('R-NEW5: id with no audit history, no trash file, but close matches exist → R5 reply (no R12 evicted text)', async () => {
    // Create and delete one item — provides a Levenshtein target
    const item = await createItem(USER_A, dataDir, { type: 'task', title: 'Close match task' });
    await softDeleteItem(USER_A, dataDir, item.frontMatter.id);

    const realId = item.frontMatter.id;
    const typoId = realId.slice(0, -1) + (realId.endsWith('a') ? 'z' : 'a');

    // No memory stub — findRecentDelete can't be called without memory
    const { ctx, replies } = makeCtx(USER_A, `/organize restore ${typoId}`);
    await handleOrganize(ctx, makeDeps());

    expect(replies.length).toBeGreaterThan(0);
    // Should be R5 reply (closest matches) — NOT the R12 evicted text
    expect(replies[0]).toMatch(/closest matches/i);
    expect(replies[0]).not.toMatch(/evicted/i);
  });

  it('R-NEW4: id with no audit history, no trash file, NO close matches → generic 404 reply', async () => {
    // Completely made-up id with no trash files
    const { ctx, replies } = makeCtx(USER_A, '/organize restore 2020-01-01-xxxx');
    await handleOrganize(ctx, makeDeps());

    expect(replies.length).toBeGreaterThan(0);
    // Generic bad-id reply — "couldn't find any record"
    expect(replies[0]).toMatch(/Couldn't find|typo/i);
    expect(replies[0]).not.toMatch(/closest matches/i);
    expect(replies[0]).not.toMatch(/evicted/i);
  });
});

describe('/organize restore — R12 audit-log 404 paths (QA M3)', () => {
  it('R-NEW2: id with prior delete audit row >30 days ago → R12 evicted-TTL reply', async () => {
    const targetId = '2026-01-01-evct';

    // Stub findRecentDelete to return a row with ts >30 days ago
    const oldTs = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const fakeRow: AuditLogRow = {
      id: 1,
      ts: oldTs,
      category: 'webapp.item_mutate',
      actor_user_id: USER_A,
      actor_chat_id: null,
      session_id: null,
      detail_json: JSON.stringify({ action: 'delete', itemId: targetId }),
    };

    const { ctx, replies } = makeCtx(USER_A, `/organize restore ${targetId}`);
    await handleOrganize(ctx, makeDeps({ findRecentDeleteResult: fakeRow }));

    expect(replies.length).toBeGreaterThan(0);
    // R12 evicted branch text
    expect(replies[0]).toMatch(/deleted on /i);
    expect(replies[0]).toMatch(/evicted/i);
  });

  it('R-NEW3: id with prior delete audit row <30 days ago, file missing from trash → R12 inconsistent reply', async () => {
    const targetId = '2026-01-01-incn';

    // Stub findRecentDelete to return a row with ts <30 days ago
    const recentTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const fakeRow: AuditLogRow = {
      id: 2,
      ts: recentTs,
      category: 'webapp.item_mutate',
      actor_user_id: USER_A,
      actor_chat_id: null,
      session_id: null,
      detail_json: JSON.stringify({ action: 'delete', itemId: targetId }),
    };

    const { ctx, replies } = makeCtx(USER_A, `/organize restore ${targetId}`);
    await handleOrganize(ctx, makeDeps({ findRecentDeleteResult: fakeRow }));

    expect(replies.length).toBeGreaterThan(0);
    // R12 inconsistent branch: "should still be in trash but file missing"
    expect(replies[0]).toMatch(/deleted on /i);
    expect(replies[0]).not.toMatch(/evicted/i);
  });
});
