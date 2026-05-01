/**
 * Unit tests for src/organize/trash.ts (v1.14.6 Commit 1 — extraction).
 *
 * Verifies that the trash module exports all expected symbols (module-shape
 * contract), and that the core logic (findClosestTrashedIds, listTrashedItems,
 * evictExpiredTrash, restoreItem) behaves correctly after being extracted from
 * storage.ts. Tests mirror the storage-level cases that previously lived inside
 * organize.storage.test.ts and organize.storage.parentRef.test.ts.
 *
 * Scope:
 *   T-1..T-4   — module shape: all exports present
 *   T-5..T-8   — findClosestTrashedIds basic cases
 *   T-9..T-12  — listTrashedItems edge cases (empty, no dir, sorted)
 *   T-13..T-16 — evictExpiredTrash: TTL logic, no-dir safe, partial error
 *   T-17..T-20 — restoreItem: happy path, 404, cross-user isolation, updated stamped
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listTrashedItems,
  evictExpiredTrash,
  restoreItem,
  findClosestTrashedIds,
} from '../../src/organize/trash.js';
import type { TrashedItemSummary, EvictResult } from '../../src/organize/trash.js';
import { createItem, softDeleteItem, organizeUserDir } from '../../src/organize/storage.js';

let dataDir: string;
const USER_ID = 999100;
const OTHER_USER = 999200;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-trash-unit-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T-1..T-4 — Module shape: all expected exports are present and callable
// ---------------------------------------------------------------------------

describe('trash.ts — module shape (T-1..T-4)', () => {
  it('T-1: listTrashedItems is a function', () => {
    expect(typeof listTrashedItems).toBe('function');
  });

  it('T-2: evictExpiredTrash is a function', () => {
    expect(typeof evictExpiredTrash).toBe('function');
  });

  it('T-3: restoreItem is a function', () => {
    expect(typeof restoreItem).toBe('function');
  });

  it('T-4: findClosestTrashedIds is a function', () => {
    expect(typeof findClosestTrashedIds).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// T-5..T-8 — findClosestTrashedIds
// ---------------------------------------------------------------------------

describe('findClosestTrashedIds — Levenshtein search (T-5..T-8)', () => {
  async function setupTrashItems(userId: number, ids: string[]): Promise<void> {
    const trashDir = path.join(dataDir, 'organize', String(userId), '.trash');
    await mkdir(trashDir, { recursive: true });
    for (const id of ids) {
      const content =
        `---\n` +
        `id: ${id}\n` +
        `type: task\n` +
        `status: active\n` +
        `title: Item ${id}\n` +
        `created: 2026-04-25T00:00:00.000Z\n` +
        `due: \n` +
        `parentId: \n` +
        `calendarEventId: \n` +
        `tags: []\n` +
        `deletedAt: 2026-04-25T10:00:00.000Z\n` +
        `---\n\n` +
        `## Notes\n\n` +
        `## Progress\n`;
      await writeFile(path.join(trashDir, `${id}.md`), content, 'utf8');
    }
  }

  it('T-5: returns empty array when trash dir does not exist', async () => {
    const matches = await findClosestTrashedIds(USER_ID, dataDir, '2026-04-25-aaaa');
    expect(matches).toEqual([]);
  });

  it('T-6: returns empty array when trash is empty', async () => {
    const trashDir = path.join(dataDir, 'organize', String(USER_ID), '.trash');
    await mkdir(trashDir, { recursive: true });
    const matches = await findClosestTrashedIds(USER_ID, dataDir, '2026-04-25-aaaa');
    expect(matches).toEqual([]);
  });

  it('T-7: returns closest match when distance is small (1 char difference)', async () => {
    await setupTrashItems(USER_ID, ['2026-04-25-aaaa', '2026-04-25-bbbb', '2026-04-25-cccc']);
    // 'aaab' is 1 edit from 'aaaa' — distance ≤ 4 threshold
    const matches = await findClosestTrashedIds(USER_ID, dataDir, '2026-04-25-aaab');
    // Returns {id, title} objects; check id property
    const ids = matches.map((m) => m.id);
    expect(ids).toContain('2026-04-25-aaaa');
  });

  it('T-8: does not return items with large Levenshtein distance (> 4 threshold)', async () => {
    await setupTrashItems(USER_ID, ['2026-04-20-zzzz']);
    // Very different id — distance from '2026-01-01-aaaa' to '2026-04-20-zzzz' > 4
    const matches = await findClosestTrashedIds(USER_ID, dataDir, '2026-01-01-aaaa');
    const ids = matches.map((m) => m.id);
    expect(ids).not.toContain('2026-04-20-zzzz');
  });
});

// ---------------------------------------------------------------------------
// T-9..T-12 — listTrashedItems
// ---------------------------------------------------------------------------

describe('listTrashedItems — list and pagination (T-9..T-12)', () => {
  it('T-9: returns {items: [], total: 0} when no .trash directory', async () => {
    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('T-10: returns {items: [], total: 0} for empty .trash directory', async () => {
    const trashDir = path.join(dataDir, 'organize', String(USER_ID), '.trash');
    await mkdir(trashDir, { recursive: true });
    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('T-11: returns items sorted by deletedAt descending', async () => {
    // Create 2 items and soft-delete them
    const item1 = await createItem(USER_ID, dataDir, { type: 'task', title: 'Item A' });
    await new Promise((r) => setTimeout(r, 5));
    const item2 = await createItem(USER_ID, dataDir, { type: 'task', title: 'Item B' });

    await softDeleteItem(USER_ID, dataDir, item1.frontMatter.id);
    await new Promise((r) => setTimeout(r, 5));
    await softDeleteItem(USER_ID, dataDir, item2.frontMatter.id);

    const result = await listTrashedItems(USER_ID, dataDir);
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(2);
    // Most recently deleted is first
    expect(result.items[0]!.title).toBe('Item B');
    expect(result.items[1]!.title).toBe('Item A');
  });

  it('T-12: pagination — offset and limit are respected', async () => {
    // Create 3 items and trash them
    for (let i = 0; i < 3; i++) {
      const item = await createItem(USER_ID, dataDir, { type: 'task', title: `Item ${i}` });
      await new Promise((r) => setTimeout(r, 5));
      await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listTrashedItems(USER_ID, dataDir, { limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.items.length).toBe(2);

    const page2 = await listTrashedItems(USER_ID, dataDir, { limit: 2, offset: 2 });
    expect(page2.total).toBe(3);
    expect(page2.items.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-13..T-16 — evictExpiredTrash
// ---------------------------------------------------------------------------

describe('evictExpiredTrash — TTL eviction (T-13..T-16)', () => {
  it('T-13: no .trash directory → returns 0 evicted, 0 errors', async () => {
    const result: EvictResult = await evictExpiredTrash(USER_ID, dataDir, 30);
    expect(result.evicted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });

  it('T-14: empty .trash directory → returns 0 evicted', async () => {
    const trashDir = path.join(dataDir, 'organize', String(USER_ID), '.trash');
    await mkdir(trashDir, { recursive: true });
    const result = await evictExpiredTrash(USER_ID, dataDir, 30);
    expect(result.evicted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('T-15: recently deleted item (within TTL) is NOT evicted', async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'Recent' });
    await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);

    // TTL of 30 days — item just deleted, should not be evicted
    const result = await evictExpiredTrash(USER_ID, dataDir, 30);
    expect(result.evicted).toBe(0);
    expect(result.filesScanned).toBeGreaterThanOrEqual(1);
  });

  it('T-16: item with deletedAt far in past (> TTL) IS evicted', async () => {
    // Write a trash file with a deletedAt > 31 days ago
    const trashDir = path.join(dataDir, 'organize', String(USER_ID), '.trash');
    await mkdir(trashDir, { recursive: true });
    const oldDate = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
    const itemId = '2025-01-01-oldx';
    const content =
      `---\n` +
      `id: ${itemId}\n` +
      `type: task\n` +
      `status: active\n` +
      `title: Old item\n` +
      `created: 2025-01-01T00:00:00.000Z\n` +
      `due: \n` +
      `parentId: \n` +
      `calendarEventId: \n` +
      `tags: []\n` +
      `deletedAt: ${oldDate}\n` +
      `---\n\n` +
      `## Notes\n\n` +
      `## Progress\n`;
    await writeFile(path.join(trashDir, `${itemId}.md`), content, 'utf8');

    const result = await evictExpiredTrash(USER_ID, dataDir, 30);
    expect(result.evicted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(existsSync(path.join(trashDir, `${itemId}.md`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-17..T-20 — restoreItem
// ---------------------------------------------------------------------------

describe('restoreItem — restore from trash (T-17..T-20)', () => {
  it('T-17: happy path — item moves from trash to live, deletedAt stripped', async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'Will restore' });
    const itemId = item.frontMatter.id;
    await softDeleteItem(USER_ID, dataDir, itemId);

    const liveDir = organizeUserDir(USER_ID, dataDir);
    expect(existsSync(path.join(liveDir, `${itemId}.md`))).toBe(false);

    const restored = await restoreItem(USER_ID, dataDir, itemId);
    expect(restored.frontMatter.deletedAt).toBeNull();
    expect(existsSync(path.join(liveDir, `${itemId}.md`))).toBe(true);
  });

  it('T-18: restoreItem stamps a fresh updated timestamp', async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'Will restore' });
    await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);
    await new Promise((r) => setTimeout(r, 5));

    const restored = await restoreItem(USER_ID, dataDir, item.frontMatter.id);
    expect(restored.frontMatter.updated).toBeDefined();
    expect(new Date(restored.frontMatter.updated!).getTime()).not.toBeNaN();
  });

  it('T-19: 404 when item not in trash and not live', async () => {
    await expect(restoreItem(USER_ID, dataDir, '9999-99-99-xxxx')).rejects.toThrow();
  });

  it('T-20: cross-user isolation — user B cannot see user A trash', async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'task', title: 'User A item' });
    await softDeleteItem(USER_ID, dataDir, item.frontMatter.id);

    // Other user should not find it
    await expect(restoreItem(OTHER_USER, dataDir, item.frontMatter.id)).rejects.toThrow();
  });
});
