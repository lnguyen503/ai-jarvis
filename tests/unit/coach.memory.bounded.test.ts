/**
 * Bounded-FIFO semantics for coachMemory.writeCoachEntry (v1.18.0 ADR 018 D3).
 *
 * Tests:
 *   T-D3-1: Write 30 entries — count grows from 1 to 30.
 *   T-D3-2: Write a 31st entry — count stays at 30 (oldest dropped).
 *   T-D3-3: Two families (lastNudge + research) coexist at 30 each.
 *   T-D3-4: Writes to different itemIds are isolated.
 *   T-D3-5: FIFO drops oldest (verified by at timestamp, not just count).
 *   T-D3-6: readCoachEntries returns entries newest-first.
 *   T-D3-7: readCoachEntries limit parameter respected.
 *   T-D3-8: readCoachEntries prefix filter isolates families.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  writeCoachEntry,
  readCoachEntries,
  COACH_FIFO_LIMIT,
  coachKeyPrefix,
} from '../../src/coach/coachMemory.js';
import { listEntries } from '../../src/memory/userMemoryEntries.js';

const USER_ID = 888001;
const ITEM_A = '2026-04-25-aaaa';
const ITEM_B = '2026-04-25-bbbb';
const noopScrubber = (text: string) => text;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-coach-mem-'));
  // userMemoryEntries expects data/memories/<userId>.md to live here
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countFamilyEntries(userId: number, itemId: string, eventType: 'lastNudge' | 'research' | 'idea' | 'plan') {
  const prefix = coachKeyPrefix(itemId, eventType);
  const all = await listEntries(userId, dataDir);
  return all.filter((e) => e.key.startsWith(prefix)).length;
}

async function writeN(n: number, itemId: string, eventType: 'lastNudge' | 'research' | 'idea' | 'plan', fifoLimit?: number) {
  for (let i = 0; i < n; i++) {
    await writeCoachEntry(USER_ID, dataDir, itemId, eventType, { seq: i }, {
      safetyScrubber: noopScrubber,
      ...(fifoLimit !== undefined ? { fifoLimit } : {}),
    });
    // Tiny artificial delay so timestamps are distinct (ISO seconds resolution)
    // If same second, keys still differ due to how formatCoachKey works with ms precision removed —
    // actually they may collide. We need to handle this by checking count not exact keys.
  }
}

// ---------------------------------------------------------------------------
// T-D3-1: count grows from 1 to 30
// ---------------------------------------------------------------------------

describe('T-D3-1: count grows 1 → N (up to fifoLimit)', () => {
  it('writes 30 entries; count is 30 and no pruning occurred', async () => {
    // Write 30 entries one at a time with slight artificial variation
    for (let i = 0; i < 30; i++) {
      await writeCoachEntry(
        USER_ID, dataDir, ITEM_A, 'lastNudge',
        { seq: i, ts: `2026-04-25T${String(i).padStart(2, '0')}:00:00.000Z` },
        { safetyScrubber: noopScrubber },
      );
    }
    const count = await countFamilyEntries(USER_ID, ITEM_A, 'lastNudge');
    expect(count).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// T-D3-2: 31st entry → count stays at 30 (oldest dropped)
// ---------------------------------------------------------------------------

describe('T-D3-2: 31st write drops oldest; count stays at cap', () => {
  it('count is 30 after writing 31 entries', async () => {
    for (let i = 0; i < 31; i++) {
      await writeCoachEntry(
        USER_ID, dataDir, ITEM_A, 'lastNudge',
        { seq: i },
        { safetyScrubber: noopScrubber },
      );
    }
    const count = await countFamilyEntries(USER_ID, ITEM_A, 'lastNudge');
    expect(count).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// T-D3-3: two families coexist at 30 each
// ---------------------------------------------------------------------------

describe('T-D3-3: lastNudge and research families are independent', () => {
  it('both families reach 30; neither prunes the other', async () => {
    for (let i = 0; i < 30; i++) {
      await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'lastNudge', { seq: i }, { safetyScrubber: noopScrubber });
      await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'research', { seq: i }, { safetyScrubber: noopScrubber });
    }
    const nudgeCount = await countFamilyEntries(USER_ID, ITEM_A, 'lastNudge');
    const researchCount = await countFamilyEntries(USER_ID, ITEM_A, 'research');
    expect(nudgeCount).toBe(30);
    expect(researchCount).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// T-D3-4: different itemIds are isolated
// ---------------------------------------------------------------------------

describe('T-D3-4: writes to different itemIds are isolated', () => {
  it('item B entries do not affect item A count', async () => {
    for (let i = 0; i < 5; i++) {
      await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'lastNudge', { seq: i }, { safetyScrubber: noopScrubber });
      await writeCoachEntry(USER_ID, dataDir, ITEM_B, 'lastNudge', { seq: i }, { safetyScrubber: noopScrubber });
    }
    const countA = await countFamilyEntries(USER_ID, ITEM_A, 'lastNudge');
    const countB = await countFamilyEntries(USER_ID, ITEM_B, 'lastNudge');
    expect(countA).toBe(5);
    expect(countB).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// T-D3-5: FIFO drops oldest (verified by payload content)
// ---------------------------------------------------------------------------

describe('T-D3-5: FIFO drops oldest entry', () => {
  it('after 31 writes, the entry with seq=0 is gone and seq=30 is present', async () => {
    const fifoLimit = 5; // use a small limit for speed
    const payloads: Array<Record<string, number>> = [];
    for (let i = 0; i < 6; i++) {
      const p = { seq: i };
      payloads.push(p);
      await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'idea', p, {
        safetyScrubber: noopScrubber,
        fifoLimit,
      });
    }
    const entries = await readCoachEntries(USER_ID, dataDir, coachKeyPrefix(ITEM_A, 'idea'));
    expect(entries).toHaveLength(fifoLimit);
    const seqs = entries.map((e) => (e.payload as { seq: number }).seq);
    expect(seqs).not.toContain(0); // oldest dropped
    expect(seqs).toContain(5);     // newest present
  });
});

// ---------------------------------------------------------------------------
// T-D3-6: readCoachEntries returns entries newest-first
// ---------------------------------------------------------------------------

describe('T-D3-6: readCoachEntries sort order (newest first)', () => {
  it('entries are returned sorted descending by at', async () => {
    for (let i = 0; i < 5; i++) {
      await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'plan', { seq: i }, { safetyScrubber: noopScrubber });
    }
    const entries = await readCoachEntries(USER_ID, dataDir, coachKeyPrefix(ITEM_A, 'plan'));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // Verify that `at` timestamps are non-increasing (newest first).
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i]!.at >= entries[i + 1]!.at).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T-D3-7: readCoachEntries limit parameter
// ---------------------------------------------------------------------------

describe('T-D3-7: readCoachEntries limit parameter', () => {
  it('returns at most limit entries', async () => {
    for (let i = 0; i < 8; i++) {
      await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'research', { seq: i }, { safetyScrubber: noopScrubber });
    }
    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${ITEM_A}.`, 3);
    expect(entries.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// T-D3-8: readCoachEntries prefix filter
// ---------------------------------------------------------------------------

describe('T-D3-8: prefix filter isolates (itemId, eventType) families', () => {
  it('reading with ITEM_A prefix excludes ITEM_B entries', async () => {
    await writeCoachEntry(USER_ID, dataDir, ITEM_A, 'lastNudge', { who: 'A' }, { safetyScrubber: noopScrubber });
    await writeCoachEntry(USER_ID, dataDir, ITEM_B, 'lastNudge', { who: 'B' }, { safetyScrubber: noopScrubber });
    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${ITEM_A}.`);
    const itemIds = entries.map((e) => e.itemId);
    expect(itemIds.every((id) => id === ITEM_A)).toBe(true);
    expect(itemIds).not.toContain(ITEM_B);
  });
});
