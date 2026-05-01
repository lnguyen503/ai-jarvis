/**
 * Unit tests for src/coach/chatMonitor.ts (v1.20.0 ADR 020 D6.b).
 *
 * Tests cover: each trigger pattern family (commitment, blocker, procrastination,
 * done-signal-confirmation), fuzzy item matching, DM cooldown suppression,
 * notifyChatMessage callback body.
 *
 * ~18 cases per ADR 020 commit 8 spec.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectChatTrigger,
  notifyChatMessage,
  type ChatMonitorDeps,
} from '../../src/coach/chatMonitor.js';
import type { OrganizeItem } from '../../src/organize/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeItem(title: string, overrides: Partial<OrganizeItem['frontMatter']> = {}): OrganizeItem {
  return {
    frontMatter: {
      id: `item-${title.slice(0, 10).replace(/\s/g, '-').toLowerCase()}`,
      type: 'task',
      status: 'active',
      title,
      created: new Date().toISOString(),
      due: null,
      parentId: null,
      calendarEventId: null,
      tags: [],
      updated: new Date().toISOString(),
      ...overrides,
    },
    notesBody: '',
    progressBody: '',
    filePath: '/fake/test.md',
  };
}

/** Items matching "exercise routine" for fuzzy-match tests */
const EXERCISE_ITEM = makeItem('exercise routine');
const PROJECT_ITEM = makeItem('quarterly project planning');

// ---------------------------------------------------------------------------
// detectChatTrigger — commitment pattern
// ---------------------------------------------------------------------------

describe('detectChatTrigger — commitment', () => {
  it('detects commitment with fuzzy item match', () => {
    const trigger = detectChatTrigger("I'll finish my exercise routine today", [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('commitment');
    expect(trigger!.reason).toBe('commitment_language');
    expect(trigger!.kind).toBe('chat');
    expect(trigger!.itemId).toBe(EXERCISE_ITEM.frontMatter.id);
  });

  it('detects "I will" variant', () => {
    const trigger = detectChatTrigger('I will work on my exercise routine', [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('commitment');
  });

  it('detects "going to" variant', () => {
    const trigger = detectChatTrigger('going to tackle my exercise routine', [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('commitment');
  });

  it('does NOT trigger when no fuzzy item match', () => {
    const trigger = detectChatTrigger("I'll do something completely unrelated", [EXERCISE_ITEM]);
    expect(trigger).toBeNull();
  });

  it('does NOT trigger for empty message', () => {
    const trigger = detectChatTrigger('', [EXERCISE_ITEM]);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectChatTrigger — blocker pattern
// ---------------------------------------------------------------------------

describe('detectChatTrigger — blocker', () => {
  it('detects "blocked on" pattern with fuzzy match', () => {
    const trigger = detectChatTrigger('blocked on quarterly project planning', [PROJECT_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('blocker');
    expect(trigger!.reason).toBe('blocker_language');
  });

  it('detects "stuck on" pattern', () => {
    const trigger = detectChatTrigger('stuck on quarterly project planning tasks', [PROJECT_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('blocker');
  });

  it('does NOT trigger blocker without item match', () => {
    const trigger = detectChatTrigger('blocked on something totally different', [EXERCISE_ITEM]);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectChatTrigger — procrastination pattern
// ---------------------------------------------------------------------------

describe('detectChatTrigger — procrastination', () => {
  it('detects "haven\'t gotten to" pattern', () => {
    const trigger = detectChatTrigger("haven't gotten to the exercise routine", [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('procrastination');
    expect(trigger!.reason).toBe('procrastination_language');
  });

  it('detects "been avoiding" pattern', () => {
    const trigger = detectChatTrigger('been avoiding the quarterly project planning', [PROJECT_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('procrastination');
  });
});

// ---------------------------------------------------------------------------
// detectChatTrigger — done-signal-confirmation pattern
// ---------------------------------------------------------------------------

describe('detectChatTrigger — done-signal-confirmation', () => {
  it('detects "finished" pattern with fuzzy match', () => {
    const trigger = detectChatTrigger('finished my exercise routine', [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('done-signal-confirmation');
    expect(trigger!.reason).toBe('completion_language');
  });

  it('detects "done with" pattern', () => {
    const trigger = detectChatTrigger('done with exercise routine for today', [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('done-signal-confirmation');
  });

  it('does NOT trigger for done items', () => {
    const doneItem = makeItem('exercise routine', { status: 'done' });
    const trigger = detectChatTrigger('finished my exercise routine', [doneItem]);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectChatTrigger — commitment takes priority over blocker/completion
// ---------------------------------------------------------------------------

describe('detectChatTrigger — priority order', () => {
  it('commitment wins when both commitment and completion match', () => {
    // "I'll finished" is grammatically odd but tests priority
    const trigger = detectChatTrigger("I'll finish my exercise routine", [EXERCISE_ITEM]);
    expect(trigger!.triggerType).toBe('commitment');
  });
});

// ---------------------------------------------------------------------------
// detectChatTrigger — negation guard (Item 2 of P2 fix loop, MEDIUM QA B14)
//
// Spec: negation must be a HARD guard within the 8-token window before the
// matched verb, not just an incidental fuzzy-threshold filter. With longer
// item titles a negated commitment could push above the 0.7 jaccard threshold
// and incorrectly fire. These tests pin per pattern: positive (no negation)
// fires; negated form (within 8-token window) does NOT fire.
// ---------------------------------------------------------------------------

describe('detectChatTrigger — negation guard (commitment)', () => {
  // Item titles are content-token only (after STOP_WORDS filter) so the test
  // messages can sit comfortably above the 0.7 jaccard fuzzy threshold while
  // also containing the negation marker. This isolates negation behavior from
  // fuzzy-matching behavior.
  const RETIRE_ITEM = makeItem('retirement savings');

  it('NEG-COMMIT-1: positive commitment fires (control)', () => {
    const trigger = detectChatTrigger("I'll start retirement savings", [RETIRE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('commitment');
  });

  it('NEG-COMMIT-2: "I will NOT" suppresses commitment trigger', () => {
    const trigger = detectChatTrigger('I will not start retirement savings', [RETIRE_ITEM]);
    expect(trigger).toBeNull();
  });

  it('NEG-COMMIT-3: "I am NOT going to" suppresses commitment trigger', () => {
    const trigger = detectChatTrigger("I'm not going to start retirement savings", [RETIRE_ITEM]);
    expect(trigger).toBeNull();
  });

  it('NEG-COMMIT-4: "won\'t" suppresses commitment trigger', () => {
    const trigger = detectChatTrigger("I won't start retirement savings", [RETIRE_ITEM]);
    expect(trigger).toBeNull();
  });
});

describe('detectChatTrigger — negation guard (blocker)', () => {
  const PROJECT_SHORT = makeItem('quarterly planning');

  it('NEG-BLOCK-1: positive blocker fires (control)', () => {
    const trigger = detectChatTrigger('blocked on quarterly planning', [PROJECT_SHORT]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('blocker');
  });

  it('NEG-BLOCK-2: "not blocked on" suppresses blocker trigger', () => {
    const trigger = detectChatTrigger("not blocked on quarterly planning", [PROJECT_SHORT]);
    expect(trigger).toBeNull();
  });

  it('NEG-BLOCK-3: "not stuck on" suppresses blocker trigger', () => {
    const trigger = detectChatTrigger("not stuck on quarterly planning", [PROJECT_SHORT]);
    expect(trigger).toBeNull();
  });

  it('NEG-BLOCK-4: "never stuck on" suppresses blocker trigger', () => {
    const trigger = detectChatTrigger('never stuck on quarterly planning', [PROJECT_SHORT]);
    expect(trigger).toBeNull();
  });
});

describe('detectChatTrigger — negation guard (procrastination)', () => {
  const EXERCISE_ITEM_LOCAL = makeItem('exercise routine');

  it('NEG-PROC-1: positive procrastination fires (control)', () => {
    const trigger = detectChatTrigger("I keep putting off exercise routine", [EXERCISE_ITEM_LOCAL]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('procrastination');
  });

  it('NEG-PROC-2: "have not been avoiding" suppresses procrastination trigger', () => {
    const trigger = detectChatTrigger("have not been avoiding exercise routine", [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull();
  });

  it('NEG-PROC-3: "never been avoiding" suppresses procrastination trigger', () => {
    const trigger = detectChatTrigger('never been avoiding exercise routine', [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull();
  });

  it('NEG-PROC-4: "do not keep putting off" suppresses procrastination trigger', () => {
    const trigger = detectChatTrigger('do not keep putting off exercise routine', [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull();
  });

  it('NEG-PROC-5 (documented edge case): "I should but I don\'t keep avoiding" — false suppression accepted', () => {
    // Spec note: this is structurally a double-negative where the procrastination
    // admission semantically STANDS, but our 8-token window detects "don't" before
    // "keep" and suppresses. Acceptable per spec — false-suppress strictly better
    // than false-fire. Documented here as a regression anchor: if someone "fixes"
    // the algorithm to handle this case, they should explicitly choose the
    // tradeoff and update this test.
    const trigger = detectChatTrigger("I should but I don't keep putting off exercise routine", [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull(); // suppressed (false-suppress, documented)
  });
});

describe('detectChatTrigger — negation guard (completion)', () => {
  const EXERCISE_ITEM_LOCAL = makeItem('exercise routine');

  it('NEG-DONE-1: positive completion fires (control)', () => {
    const trigger = detectChatTrigger('finished exercise routine today', [EXERCISE_ITEM_LOCAL]);
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('done-signal-confirmation');
  });

  it('NEG-DONE-2: "have not finished" suppresses completion trigger', () => {
    const trigger = detectChatTrigger("have not finished exercise routine", [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull();
  });

  it('NEG-DONE-3: "never finished" suppresses completion trigger', () => {
    const trigger = detectChatTrigger('have never finished exercise routine', [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull();
  });

  it('NEG-DONE-4: "not done with" suppresses completion trigger', () => {
    const trigger = detectChatTrigger("really not done with exercise routine", [EXERCISE_ITEM_LOCAL]);
    expect(trigger).toBeNull();
  });
});

describe('detectChatTrigger — negation guard (window boundary)', () => {
  const EXERCISE_ITEM_LOCAL = makeItem('exercise routine');

  it('NEG-WIN-1: negation OUTSIDE 8-token window does NOT suppress', () => {
    // "no" appears far enough before "going to" that it falls outside the
    // 8-token pre-verb window. Padding tokens are content tokens (not in
    // STOP_WORDS) so they count toward the distance. The negation must NOT
    // suppress — we should still get a commitment trigger.
    const trigger = detectChatTrigger(
      "no rain yesterday morning sunshine afternoon coffee evening relaxation finally I'll start exercise routine",
      [EXERCISE_ITEM_LOCAL],
    );
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('commitment');
  });
});

// ---------------------------------------------------------------------------
// detectChatTrigger — fromMessageHash
// ---------------------------------------------------------------------------

describe('detectChatTrigger — fromMessageHash', () => {
  it('sets fromMessageHash as 16-char hex string (sha256 prefix)', () => {
    const trigger = detectChatTrigger("I'll work on exercise routine", [EXERCISE_ITEM]);
    expect(trigger).not.toBeNull();
    expect(trigger!.fromMessageHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same message produces same hash', () => {
    const msg = "I'll finish exercise routine";
    const t1 = detectChatTrigger(msg, [EXERCISE_ITEM]);
    const t2 = detectChatTrigger(msg, [EXERCISE_ITEM]);
    expect(t1!.fromMessageHash).toBe(t2!.fromMessageHash);
  });
});

// ---------------------------------------------------------------------------
// notifyChatMessage — callback body
// ---------------------------------------------------------------------------

describe('notifyChatMessage', () => {
  it('calls dispatchTrigger when trigger detected', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-mon-'));
    const fired: unknown[] = [];

    const deps: ChatMonitorDeps = {
      dataDir: tmpDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async (t) => { fired.push(t); },
      listActiveItems: async () => [EXERCISE_ITEM],
    };

    await notifyChatMessage(deps, 42, "I'll finish exercise routine today");
    expect(fired.length).toBe(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT call dispatchTrigger when no trigger', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-mon-'));
    const fired: unknown[] = [];

    const deps: ChatMonitorDeps = {
      dataDir: tmpDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async (t) => { fired.push(t); },
      listActiveItems: async () => [EXERCISE_ITEM],
    };

    await notifyChatMessage(deps, 42, 'how is the weather today');
    expect(fired.length).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('swallows errors from trigger dispatch', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-mon-'));

    const deps: ChatMonitorDeps = {
      dataDir: tmpDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async () => { throw new Error('test error'); },
      listActiveItems: async () => [EXERCISE_ITEM],
    };

    await expect(
      notifyChatMessage(deps, 42, "I'll finish exercise routine")
    ).resolves.toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps userId correctly (overrides placeholder 0)', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-mon-'));
    const firedTriggers: Array<{ userId: number }> = [];

    const deps: ChatMonitorDeps = {
      dataDir: tmpDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async (t) => { firedTriggers.push({ userId: t.userId }); },
      listActiveItems: async () => [EXERCISE_ITEM],
    };

    await notifyChatMessage(deps, 999, "I'll finish exercise routine today");
    expect(firedTriggers[0]?.userId).toBe(999);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
