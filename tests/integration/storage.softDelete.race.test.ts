/**
 * R7 race-window test (CP1 v1.14.3 HIGH).
 *
 * softDeleteItem has a two-stage write path:
 *   1. writeAtomically(srcPath, rewriteContent) — stamps deletedAt in the LIVE dir
 *   2. rename(srcPath, destPath) — moves to .trash/
 *
 * Between steps 1 and 2, a concurrent listItems call could see a live item
 * with deletedAt set. R7 adds a `if (fm.deletedAt != null) continue` guard
 * to listItems to filter these out.
 *
 * This test verifies R7's behavior by synthesizing the inconsistent state
 * directly: write a live file with deletedAt set, then assert listItems
 * does NOT return it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listItems, organizeUserDir } from '../../src/organize/storage.js';

let dataDir: string;
const USER_ID = 777001;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-softdelete-race-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('R7 race-window filter — listItems', () => {
  it('SD-NEW1: item with deletedAt set in LIVE dir is NOT returned by listItems', async () => {
    // Synthesize the two-stage window state: a live file with deletedAt stamped.
    // This replicates what softDeleteItem's writeAtomically step produces before
    // the subsequent rename moves it to .trash/.
    const userDir = organizeUserDir(USER_ID, dataDir);
    await mkdir(userDir, { recursive: true });

    const deletedAtTs = new Date().toISOString();
    const updatedTs = new Date().toISOString();

    const staleContent = [
      '---',
      'id: 2026-04-25-race',
      'type: task',
      'status: active',
      'title: Race window task',
      'created: 2026-04-25T10:00:00.000Z',
      'due: ',
      'parentId: ',
      'calendarEventId: ',
      `deletedAt: ${deletedAtTs}`,  // <- deletedAt set in LIVE dir (window state)
      `updated: ${updatedTs}`,
      'tags: []',
      '---',
      '',
      '<!-- Managed by Jarvis /organize. -->',
      '',
      '## Notes',
      '',
      '## Progress',
      '',
    ].join('\n');

    await writeFile(path.join(userDir, '2026-04-25-race.md'), staleContent, 'utf8');

    // R7: listItems MUST NOT return this item
    const items = await listItems(USER_ID, dataDir);
    const found = items.find((i) => i.frontMatter.id === '2026-04-25-race');
    expect(found).toBeUndefined();
  });

  it('SD-NEW2: normal item without deletedAt IS returned by listItems', async () => {
    // Sanity check: confirm the filter only blocks deletedAt-set items
    const userDir = organizeUserDir(USER_ID, dataDir);
    await mkdir(userDir, { recursive: true });

    const normalContent = [
      '---',
      'id: 2026-04-25-norm',
      'type: task',
      'status: active',
      'title: Normal task',
      'created: 2026-04-25T10:00:00.000Z',
      'due: ',
      'parentId: ',
      'calendarEventId: ',
      'tags: []',
      '---',
      '',
      '<!-- Managed by Jarvis /organize. -->',
      '',
      '## Notes',
      '',
      '## Progress',
      '',
    ].join('\n');

    await writeFile(path.join(userDir, '2026-04-25-norm.md'), normalContent, 'utf8');

    const items = await listItems(USER_ID, dataDir);
    const found = items.find((i) => i.frontMatter.id === '2026-04-25-norm');
    expect(found).toBeDefined();
    expect(found!.frontMatter.title).toBe('Normal task');
  });
});
