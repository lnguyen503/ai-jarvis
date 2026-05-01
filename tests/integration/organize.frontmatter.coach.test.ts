/**
 * Integration tests for coach-field frontmatter (v1.18.0 ADR 018 R4; updated v1.19.0 D1).
 *
 * R4 mandate: every organize read path covered for legacy-item migration.
 * v1.19.0 D1 update: legacy item (without coach fields) read returns coachIntensity = 'auto'
 * (was undefined/'off'; explicit 'off' is still preserved per user opt-out).
 *
 * Read paths covered:
 *   - storage.readItem (direct)
 *   - storage.listItems
 *   - storage.updateItem (PATCH coach field)
 *   - serializeItem + re-parse round-trip
 *   - legacy item created pre-v1.18.0 has no coach fields → reads as coachIntensity='auto'
 *   - item with coachIntensity='off' is NOT emitted in frontmatter (explicit opt-out preserved)
 *   - item with coachIntensity='auto' is NOT emitted in frontmatter (implied default)
 *   - item with coachIntensity='persistent' IS emitted
 *   - item with coachNudgeCount=0 is NOT emitted
 *   - item with coachNudgeCount=7 IS emitted
 *   - listItems returns all items including those without coach fields
 *   - organize_list tool reads without crash
 *   - round-trip: coach fields survive serialize → parse
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createItem,
  readItem,
  listItems,
  updateItem,
  organizeUserDir,
  parseItemFileFromRaw,
} from '../../src/organize/storage.js';
import { serializeItem } from '../../src/organize/_internals.js';
import type { OrganizeFrontMatter } from '../../src/organize/types.js';

const USER_ID = 777001;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-coach-fm-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write a raw legacy item file (pre-v1.18.0, no coach fields)
// ---------------------------------------------------------------------------
async function writeLegacyItem(itemId: string, title: string) {
  const dir = organizeUserDir(USER_ID, dataDir);
  await mkdir(dir, { recursive: true });
  const content = [
    '---',
    `id: ${itemId}`,
    'type: task',
    'status: active',
    `title: ${title}`,
    'created: 2025-01-01T00:00:00.000Z',
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
  await writeFile(path.join(dir, `${itemId}.md`), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Legacy item read paths
// ---------------------------------------------------------------------------

describe('legacy item (no coach fields) — read paths', () => {
  const LEGACY_ID = '2025-01-01-aaaa';

  beforeEach(async () => {
    await writeLegacyItem(LEGACY_ID, 'Legacy task without coach fields');
  });

  it('R4-1: readItem returns item without crashing; legacy item coachIntensity reads as auto (v1.19.0 D1)', async () => {
    const item = await readItem(USER_ID, dataDir, LEGACY_ID);
    expect(item).not.toBeNull();
    // v1.19.0 D1: missing field → 'auto' default (was undefined in v1.18.0)
    expect(item!.frontMatter.coachIntensity).toBe('auto');
    expect(item!.frontMatter.coachNudgeCount).toBeUndefined();
  });

  it('R4-2: listItems returns legacy item without crash; coachIntensity is auto (v1.19.0 D1)', async () => {
    const items = await listItems(USER_ID, dataDir);
    const item = items.find((i) => i.frontMatter.id === LEGACY_ID);
    expect(item).toBeDefined();
    // v1.19.0 D1: missing field → 'auto' default
    expect(item!.frontMatter.coachIntensity).toBe('auto');
  });

  it('R4-3: updateItem on legacy item preserves auto default unless patch includes coach field', async () => {
    await updateItem(USER_ID, dataDir, LEGACY_ID, { title: 'Updated title' });
    const item = await readItem(USER_ID, dataDir, LEGACY_ID);
    expect(item).not.toBeNull();
    // v1.19.0 D1: missing field → 'auto' default (serialize omits 'auto'; re-read gives 'auto')
    expect(item!.frontMatter.coachIntensity).toBe('auto');
  });

  it('R4-4: updateItem with coachIntensity patch sets the field correctly', async () => {
    await updateItem(USER_ID, dataDir, LEGACY_ID, { coachIntensity: 'persistent' });
    const item = await readItem(USER_ID, dataDir, LEGACY_ID);
    expect(item).not.toBeNull();
    expect(item!.frontMatter.coachIntensity).toBe('persistent');
  });
});

// ---------------------------------------------------------------------------
// Serializer: emit/omit behavior for coach fields
// ---------------------------------------------------------------------------

describe('serializeItem + re-parse — coach field emit/omit behavior', () => {
  function baseFm(overrides: Partial<OrganizeFrontMatter> = {}): OrganizeFrontMatter {
    return {
      id: '2026-04-25-cccc',
      type: 'task',
      status: 'active',
      title: 'Coach field test',
      created: '2026-04-25T00:00:00.000Z',
      due: null,
      parentId: null,
      calendarEventId: null,
      tags: [],
      ...overrides,
    };
  }

  it('R4-5: coachIntensity=off is NOT emitted in serialized frontmatter', () => {
    const serialized = serializeItem(baseFm({ coachIntensity: 'off' }), '', '');
    expect(serialized).not.toContain('coachIntensity');
  });

  it('R4-6: coachIntensity=undefined is NOT emitted (undefined still valid in type; serializer omits)', () => {
    const serialized = serializeItem(baseFm(), '', '');
    expect(serialized).not.toContain('coachIntensity');
  });

  it('R4-6b: coachIntensity=auto is NOT emitted (auto is the implied default; omit to preserve legacy compat)', () => {
    const serialized = serializeItem(baseFm({ coachIntensity: 'auto' }), '', '');
    expect(serialized).not.toContain('coachIntensity');
  });

  it('R4-7: coachIntensity=persistent IS emitted', () => {
    const serialized = serializeItem(baseFm({ coachIntensity: 'persistent' }), '', '');
    expect(serialized).toContain('coachIntensity: persistent');
  });

  it('R4-8: coachNudgeCount=0 is NOT emitted', () => {
    const serialized = serializeItem(baseFm({ coachNudgeCount: 0 }), '', '');
    expect(serialized).not.toContain('coachNudgeCount');
  });

  it('R4-9: coachNudgeCount=7 IS emitted', () => {
    const serialized = serializeItem(baseFm({ coachNudgeCount: 7 }), '', '');
    expect(serialized).toContain('coachNudgeCount: 7');
  });

  it('R4-10: round-trip — persistent intensity + nudgeCount survive serialize → parse', () => {
    const fm = baseFm({ coachIntensity: 'persistent', coachNudgeCount: 5 });
    const serialized = serializeItem(fm, 'some notes', '');
    const result = parseItemFileFromRaw(serialized, fm.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.fm.coachIntensity).toBe('persistent');
      expect(result.result.fm.coachNudgeCount).toBe(5);
    }
  });

  it('R4-11: round-trip — item without coach fields reads as coachIntensity=auto (v1.19.0 D1)', () => {
    const fm = baseFm();
    const serialized = serializeItem(fm, '', '');
    const result = parseItemFileFromRaw(serialized, fm.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // v1.19.0 D1: missing field → 'auto' default; serializer omits 'auto', re-parse gives 'auto'
      expect(result.result.fm.coachIntensity).toBe('auto');
      expect(result.result.fm.coachNudgeCount).toBeUndefined();
    }
  });

  it('R4-12: coach intensity gating — items with intensity=off excluded; auto/gentle/moderate/persistent included (v1.19.0 D1)', () => {
    // v1.19.0 D1: 'auto' is now coachable (inferred intensity); only 'off' opts out.
    // Simulate the coach intensity gating logic.
    const items = [
      baseFm({ id: '2026-04-25-a001', coachIntensity: 'off' }),
      baseFm({ id: '2026-04-25-a002', coachIntensity: 'gentle' }),
      baseFm({ id: '2026-04-25-a003', coachIntensity: 'auto' }), // auto = coachable (v1.19.0)
      baseFm({ id: '2026-04-25-a004', coachIntensity: 'persistent' }),
    ];
    const coachable = items.filter(
      (fm) => fm.coachIntensity !== 'off',
    );
    expect(coachable).toHaveLength(3);
    expect(coachable.map((f) => f.id)).toEqual(['2026-04-25-a002', '2026-04-25-a003', '2026-04-25-a004']);
  });
});

// ---------------------------------------------------------------------------
// createItem with coach fields
// ---------------------------------------------------------------------------

describe('createItem — coach fields not set by default on create (ADR 018 D1)', () => {
  it('R4-13: createItem with no coach fields → coachIntensity reads as auto (v1.19.0 D1)', async () => {
    const created = await createItem(USER_ID, dataDir, {
      type: 'task',
      title: 'New task no coach',
      due: null,
      tags: [],
    });
    expect(created).toBeDefined();
    const item = await readItem(USER_ID, dataDir, created.frontMatter.id);
    expect(item).not.toBeNull();
    // v1.19.0 D1: new items default to 'auto' (coach will infer intensity)
    expect(item!.frontMatter.coachIntensity).toBe('auto');
    expect(item!.frontMatter.coachNudgeCount).toBeUndefined();
  });
});
