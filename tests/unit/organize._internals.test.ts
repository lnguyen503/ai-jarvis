/**
 * Tests for src/organize/_internals.ts (v1.15.0 D10 extraction).
 *
 * Verifies that writeAtomically and serializeItem are correctly exported,
 * that their behavior is unchanged from the originals in storage.ts and
 * trash.ts (zero logic change), and that both storage.ts and trash.ts
 * can be imported without error (no circular import regression).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeAtomically, serializeItem } from '../../src/organize/_internals.js';
import type { OrganizeFrontMatter } from '../../src/organize/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-internals-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeAtomically
// ---------------------------------------------------------------------------

describe('writeAtomically', () => {
  it('writes content to the target path', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await writeAtomically(filePath, 'hello world');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('hello world');
  });

  it('leaves no .tmp orphan file on success', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await writeAtomically(filePath, 'content');
    const entries = await (await import('node:fs/promises')).readdir(tmpDir);
    const tmps = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmps).toHaveLength(0);
  });

  it('overwrites existing file atomically', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await writeAtomically(filePath, 'first');
    await writeAtomically(filePath, 'second');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// serializeItem
// ---------------------------------------------------------------------------

describe('serializeItem', () => {
  const baseFm: OrganizeFrontMatter = {
    id: '2026-04-25-abcd',
    type: 'task',
    status: 'active',
    title: 'My Task',
    created: '2026-04-25T00:00:00.000Z',
    due: null,
    parentId: null,
    calendarEventId: null,
    deletedAt: null,
    updated: null,
    tags: [],
  };

  it('produces canonical front-matter with standard fields', () => {
    const output = serializeItem(baseFm, '', '');
    expect(output).toContain('---');
    expect(output).toContain('id: 2026-04-25-abcd');
    expect(output).toContain('type: task');
    expect(output).toContain('status: active');
    expect(output).toContain('title: My Task');
    expect(output).toContain('created: 2026-04-25T00:00:00.000Z');
    expect(output).toContain('due: ');
    expect(output).toContain('parentId: ');
    expect(output).toContain('tags: []');
  });

  it('omits deletedAt when null (v1.11.0 R3)', () => {
    const output = serializeItem({ ...baseFm, deletedAt: null }, '', '');
    expect(output).not.toContain('deletedAt:');
  });

  it('emits deletedAt when set', () => {
    const ts = '2026-04-25T12:00:00.000Z';
    const output = serializeItem({ ...baseFm, deletedAt: ts }, '', '');
    expect(output).toContain(`deletedAt: ${ts}`);
  });

  it('omits updated when null (v1.14.3 D1)', () => {
    const output = serializeItem({ ...baseFm, updated: null }, '', '');
    expect(output).not.toContain('updated:');
  });

  it('emits updated when set', () => {
    const ts = '2026-04-25T12:00:00.000Z';
    const output = serializeItem({ ...baseFm, updated: ts }, '', '');
    expect(output).toContain(`updated: ${ts}`);
  });

  it('includes notes and progress bodies', () => {
    const output = serializeItem(baseFm, 'some notes\n', 'some progress\n');
    expect(output).toContain('## Notes\nsome notes\n');
    expect(output).toContain('## Progress\nsome progress\n');
  });

  it('emits tags array correctly when non-empty', () => {
    const output = serializeItem({ ...baseFm, tags: ['alpha', 'beta'] }, '', '');
    expect(output).toContain('tags: [alpha, beta]');
  });

  it('emits tags: [] when empty', () => {
    const output = serializeItem({ ...baseFm, tags: [] }, '', '');
    expect(output).toContain('tags: []');
  });

  it('includes the managed-by comment header', () => {
    const output = serializeItem(baseFm, '', '');
    expect(output).toContain('<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->');
  });

  it('output round-trips through serializeItem with consistent format', () => {
    // Two calls with identical args produce identical output (deterministic).
    const a = serializeItem(baseFm, 'notes\n', 'progress\n');
    const b = serializeItem(baseFm, 'notes\n', 'progress\n');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Import smoke tests — verify storage.ts and trash.ts both import without error
// ---------------------------------------------------------------------------

describe('import smoke tests', () => {
  it('storage.ts exports writeAtomically and serializeItem indirectly (via _internals)', async () => {
    // Just import storage.ts to ensure it resolves cleanly (no missing import errors).
    const storage = await import('../../src/organize/storage.js');
    expect(typeof storage.createItem).toBe('function');
    expect(typeof storage.readItem).toBe('function');
  });

  it('trash.ts imports and exports cleanly (uses _internals writeAtomically/serializeItem)', async () => {
    const trash = await import('../../src/organize/trash.js');
    expect(typeof trash.restoreItem).toBe('function');
    expect(typeof trash.listTrashedItems).toBe('function');
  });
});
