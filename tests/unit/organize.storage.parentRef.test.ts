/**
 * Unit tests for parentExistsAndIsActiveGoal (v1.14.5 D2/R1) and
 * listTrashedItems (v1.14.5 D7) in src/organize/storage.ts.
 *
 * Covers:
 *   parentExistsAndIsActiveGoal:
 *     - Happy path: active goal → {ok: true}
 *     - Happy path: done goal → {ok: true}
 *     - Missing file → {ok: false, reason: 'NOT_FOUND'}
 *     - Malformed file → {ok: false, reason: 'NOT_FOUND'}
 *     - Type = task (not a goal) → {ok: false, reason: 'NOT_GOAL'}
 *     - Status = abandoned → {ok: false, reason: 'NOT_ACTIVE'}
 *     - R1 BLOCKING: deletedAt set in live file (mid-soft-delete window) → NOT_FOUND
 *
 *   listTrashedItems:
 *     - Empty trash dir → {items:[], total:0}
 *     - No .trash/ directory → {items:[], total:0}
 *     - Happy path: 3 items sorted by deletedAt desc
 *     - mtime fallback: item without deletedAt field sorts by mtime
 *     - Tolerant: malformed front-matter surfaced as (unreadable) entry
 *     - Pagination: offset + limit slicing
 *     - Collision-suffix files (--<unix>-<hex>.md) → baseId extracted correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parentExistsAndIsActiveGoal,
  organizeUserDir,
} from '../../src/organize/storage.js';
import { listTrashedItems } from '../../src/organize/trash.js';

const USER_ID = 42000;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-parentref-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoalMd(opts: {
  id: string;
  status: 'active' | 'done' | 'abandoned';
  deletedAt?: string;
}): string {
  const deletedAtLine = opts.deletedAt ? `deletedAt: ${opts.deletedAt}\n` : '';
  return (
    `---\n` +
    `id: ${opts.id}\n` +
    `type: goal\n` +
    `status: ${opts.status}\n` +
    `title: Test Goal\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `${deletedAtLine}` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. -->\n\n` +
    `## Notes\n\n## Progress\n`
  );
}

function makeTaskMd(id: string): string {
  return (
    `---\n` +
    `id: ${id}\n` +
    `type: task\n` +
    `status: active\n` +
    `title: Test Task\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. -->\n\n` +
    `## Notes\n\n## Progress\n`
  );
}

async function writeItemFile(itemId: string, content: string): Promise<void> {
  const userDir = organizeUserDir(USER_ID, dataDir);
  await mkdir(userDir, { recursive: true });
  await writeFile(path.join(userDir, `${itemId}.md`), content, 'utf8');
}

async function writeTrashFile(filename: string, content: string): Promise<void> {
  const trashDir = path.join(organizeUserDir(USER_ID, dataDir), '.trash');
  await mkdir(trashDir, { recursive: true });
  await writeFile(path.join(trashDir, filename), content, 'utf8');
}

function makeTrashMd(opts: {
  id: string;
  type: 'task' | 'event' | 'goal';
  status: 'active' | 'done' | 'abandoned';
  title: string;
  deletedAt?: string;
}): string {
  const deletedAtLine = opts.deletedAt ? `deletedAt: ${opts.deletedAt}\n` : '';
  return (
    `---\n` +
    `id: ${opts.id}\n` +
    `type: ${opts.type}\n` +
    `status: ${opts.status}\n` +
    `title: ${opts.title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `${deletedAtLine}` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. -->\n\n` +
    `## Notes\n\n## Progress\n`
  );
}

// ---------------------------------------------------------------------------
// parentExistsAndIsActiveGoal
// ---------------------------------------------------------------------------

describe('parentExistsAndIsActiveGoal — v1.14.5 D2/R1', () => {
  it('PER-1: active goal → {ok: true}', async () => {
    const id = '2026-04-25-a001';
    await writeItemFile(id, makeGoalMd({ id, status: 'active' }));
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, id);
    expect(result).toEqual({ ok: true });
  });

  it('PER-2: done goal → {ok: true} (done goals accepted as parents per D1)', async () => {
    const id = '2026-04-25-a002';
    await writeItemFile(id, makeGoalMd({ id, status: 'done' }));
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, id);
    expect(result).toEqual({ ok: true });
  });

  it('PER-3: missing file → {ok: false, reason: NOT_FOUND}', async () => {
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, '2026-04-25-a999');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });

  it('PER-4: malformed file (no front-matter fence) → {ok: false, reason: NOT_FOUND}', async () => {
    const id = '2026-04-25-a003';
    await writeItemFile(id, 'not a valid markdown front-matter');
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });

  it('PER-5: type = task → {ok: false, reason: NOT_GOAL}', async () => {
    const id = '2026-04-25-a004';
    await writeItemFile(id, makeTaskMd(id));
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_GOAL');
  });

  it('PER-6: abandoned goal → {ok: false, reason: NOT_ACTIVE}', async () => {
    const id = '2026-04-25-a005';
    await writeItemFile(id, makeGoalMd({ id, status: 'abandoned' }));
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_ACTIVE');
  });

  it('PER-7: R1 BLOCKING — deletedAt set in LIVE file (mid-soft-delete rewrite-before-rename window) → NOT_FOUND', async () => {
    // Simulates storage.ts:828 stamping deletedAt before storage.ts:847 renames the file.
    // The live file has deletedAt set but the file is still in the live dir.
    const id = '2026-04-25-a006';
    await writeItemFile(id, makeGoalMd({ id, status: 'active', deletedAt: '2026-04-25T12:00:00.000Z' }));
    const result = await parentExistsAndIsActiveGoal(USER_ID, dataDir, id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('NOT_FOUND');
    }
  });
});

// ---------------------------------------------------------------------------
// listTrashedItems
// ---------------------------------------------------------------------------

describe('listTrashedItems — v1.14.5 D7', () => {
  it('LT-1: no .trash/ directory → {items:[], total:0}', async () => {
    // User dir exists but no .trash/
    const userDir = organizeUserDir(USER_ID, dataDir);
    await mkdir(userDir, { recursive: true });
    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('LT-2: empty .trash/ → {items:[], total:0}', async () => {
    const trashDir = path.join(organizeUserDir(USER_ID, dataDir), '.trash');
    await mkdir(trashDir, { recursive: true });
    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('LT-3: 3 items sorted by deletedAt desc (most recent first)', async () => {
    await writeTrashFile('2026-04-23-t001.md', makeTrashMd({
      id: '2026-04-23-t001', type: 'task', status: 'active', title: 'Old task',
      deletedAt: '2026-04-23T10:00:00.000Z',
    }));
    await writeTrashFile('2026-04-25-t002.md', makeTrashMd({
      id: '2026-04-25-t002', type: 'goal', status: 'active', title: 'Recent goal',
      deletedAt: '2026-04-25T10:00:00.000Z',
    }));
    await writeTrashFile('2026-04-24-t003.md', makeTrashMd({
      id: '2026-04-24-t003', type: 'event', status: 'done', title: 'Middle event',
      deletedAt: '2026-04-24T10:00:00.000Z',
    }));

    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    // Most recent deletedAt first
    expect(result.items[0]!.id).toBe('2026-04-25-t002');
    expect(result.items[1]!.id).toBe('2026-04-24-t003');
    expect(result.items[2]!.id).toBe('2026-04-23-t001');
  });

  it('LT-4: mtime fallback — item without deletedAt field uses file mtime for sort', async () => {
    // Write items without deletedAt; the sort uses mtime which is set by writeFile
    const oldContent = makeTrashMd({ id: '2026-04-23-t010', type: 'task', status: 'active', title: 'Old no-deletedAt' });
    const newContent = makeTrashMd({ id: '2026-04-25-t011', type: 'task', status: 'active', title: 'New no-deletedAt' });

    // Write old file first, then new file — mtime on new > mtime on old
    await writeTrashFile('2026-04-23-t010.md', oldContent);
    // Small delay to ensure mtime difference (relies on filesystem resolution)
    await new Promise((r) => setTimeout(r, 50));
    await writeTrashFile('2026-04-25-t011.md', newContent);

    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.total).toBe(2);
    // Newer mtime should sort first (desc)
    expect(result.items[0]!.id).toBe('2026-04-25-t011');
    expect(result.items[1]!.id).toBe('2026-04-23-t010');
  });

  it('LT-5: tolerant of malformed file — surfaces as (unreadable) entry, not skipped', async () => {
    await writeTrashFile('2026-04-25-t020.md', makeTrashMd({
      id: '2026-04-25-t020', type: 'task', status: 'active', title: 'Good item',
      deletedAt: '2026-04-25T10:00:00.000Z',
    }));
    // Malformed: no front-matter fence
    await writeTrashFile('2026-04-24-t021.md', 'This is not valid front-matter');

    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    // Good item should appear (parse succeeded)
    const good = result.items.find((i) => i.id === '2026-04-25-t020');
    expect(good).toBeDefined();
    expect(good!.title).toBe('Good item');
    // Malformed item should appear as (unreadable), not be omitted
    const bad = result.items.find((i) => i.id === '2026-04-24-t021');
    expect(bad).toBeDefined();
    expect(bad!.title).toBe('(unreadable)');
  });

  it('LT-6: pagination — offset=1, limit=2 over 3 items returns correct slice', async () => {
    for (const [idx, iso] of [
      ['2026-04-25-t030', '2026-04-25T10:00:00.000Z'],
      ['2026-04-24-t031', '2026-04-24T10:00:00.000Z'],
      ['2026-04-23-t032', '2026-04-23T10:00:00.000Z'],
    ] as [string, string][]) {
      await writeTrashFile(`${idx}.md`, makeTrashMd({
        id: idx, type: 'task', status: 'active', title: `Item ${idx}`,
        deletedAt: iso,
      }));
    }

    const result = await listTrashedItems(USER_ID, dataDir, { limit: 2, offset: 1 });
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    // After offset=1, sorted desc: [t031, t032]
    expect(result.items[0]!.id).toBe('2026-04-24-t031');
    expect(result.items[1]!.id).toBe('2026-04-23-t032');
  });

  it('LT-7: collision-suffix file (<id>--<unix>-<hex>.md) → baseId extracted correctly', async () => {
    const baseId = '2026-04-25-t040';
    const collisionFilename = `${baseId}--1714046400000-abc123.md`;
    await writeTrashFile(collisionFilename, makeTrashMd({
      id: baseId, type: 'task', status: 'active', title: 'Collision item',
      deletedAt: '2026-04-25T10:00:00.000Z',
    }));

    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe(baseId);
    expect(result.items[0]!.title).toBe('Collision item');
    // fileBasename includes the collision suffix
    expect(result.items[0]!.fileBasename).toContain('--');
  });
});
