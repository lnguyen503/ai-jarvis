/**
 * Unit tests for src/coach/itemStateMonitor.ts (v1.20.0 ADR 020 D6.a).
 *
 * Tests cover: each trigger condition (due_24h, goal_stale_14d,
 * persistent_zero_engagement_7d, new_vague_goal) + non-trigger cases
 * + interaction with rate limits (dispatch correctly called).
 *
 * ~22 cases per ADR 020 commit 7 spec.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectItemStateTrigger,
  notifyItemStateChange,
  type ItemCoachMemory,
  type ItemStateMonitorDeps,
} from '../../src/coach/itemStateMonitor.js';
import type { OrganizeItem } from '../../src/organize/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MS_24H = 24 * 60 * 60 * 1000;
const MS_14D = 14 * 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;

function makeItem(overrides: Partial<OrganizeItem['frontMatter']> = {}, notes = ''): OrganizeItem {
  const now = new Date();
  return {
    frontMatter: {
      id: '2026-04-25-test',
      type: 'task',
      status: 'active',
      title: 'Test item',
      created: now.toISOString(),
      due: null,
      parentId: null,
      calendarEventId: null,
      tags: [],
      updated: now.toISOString(),
      ...overrides,
    },
    notesBody: notes,
    progressBody: '',
    filePath: '/fake/test.md',
  };
}

function nowPlus(ms: number): Date {
  return new Date(Date.now() + ms);
}

function nowMinus(ms: number): Date {
  return new Date(Date.now() - ms);
}

// ---------------------------------------------------------------------------
// detectItemStateTrigger — condition 1: due_24h
// ---------------------------------------------------------------------------

describe('detectItemStateTrigger — due_24h', () => {
  it('triggers when due within 24h and no recent progress', () => {
    const item = makeItem({
      due: nowPlus(2 * 60 * 60 * 1000).toISOString().slice(0, 10), // 2h from now
      updated: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3d ago
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('due-in-24h-no-progress');
    expect(trigger!.reason).toBe('due_24h');
    expect(trigger!.kind).toBe('item-state');
  });

  it('does NOT trigger when due > 24h away', () => {
    const item = makeItem({
      due: nowPlus(2 * MS_24H).toISOString().slice(0, 10), // 2 days from now
      updated: new Date(Date.now() - 3 * MS_24H).toISOString(),
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).toBeNull();
  });

  it('does NOT trigger when due within 24h but progress was recent', () => {
    const item = makeItem({
      due: nowPlus(2 * 60 * 60 * 1000).toISOString().slice(0, 10),
      updated: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago (recent)
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).toBeNull();
  });

  it('does NOT trigger for done items', () => {
    const item = makeItem({
      status: 'done',
      due: nowPlus(2 * 60 * 60 * 1000).toISOString().slice(0, 10),
      updated: new Date(Date.now() - 3 * MS_24H).toISOString(),
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).toBeNull();
  });

  it('triggers when no due date history (updated is null/absent)', () => {
    const item = makeItem({
      due: nowPlus(1 * 60 * 60 * 1000).toISOString().slice(0, 10),
      updated: null,
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('due-in-24h-no-progress');
  });
});

// ---------------------------------------------------------------------------
// detectItemStateTrigger — condition 2: goal_stale_14d
// ---------------------------------------------------------------------------

describe('detectItemStateTrigger — goal_stale_14d', () => {
  // Use a title with >= 8 tokens and created > 24h ago to avoid triggering
  // vague_new_goal first (conditions are mutually exclusive, first match wins).
  const OLD_GOAL_OVERRIDES = {
    created: new Date(Date.now() - 30 * MS_24H).toISOString(),
    title: 'improve my physical fitness and build a daily exercise habit',
  };

  it('triggers for goal not updated in > 14d', () => {
    const item = makeItem({
      type: 'goal',
      ...OLD_GOAL_OVERRIDES,
      updated: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('goal-stale-14d');
  });

  it('does NOT trigger for goal updated within 14d', () => {
    const item = makeItem({
      type: 'goal',
      ...OLD_GOAL_OVERRIDES,
      updated: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).toBeNull();
  });

  it('does NOT trigger for task type even if stale', () => {
    const item = makeItem({
      type: 'task',
      updated: new Date(Date.now() - 15 * MS_24H).toISOString(),
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectItemStateTrigger — condition 3: persistent_zero_engagement_7d
// ---------------------------------------------------------------------------

describe('detectItemStateTrigger — persistent_zero_engagement_7d', () => {
  it('triggers when coachIntensity=persistent and no engagement in 7d', () => {
    const item = makeItem({ coachIntensity: 'persistent' });
    const trigger = detectItemStateTrigger(item, { lastEngagedAt: null });
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('persistent-zero-engagement-7d');
  });

  it('does NOT trigger when engagement was within 7d', () => {
    const item = makeItem({ coachIntensity: 'persistent' });
    const recentEngaged = new Date(Date.now() - 3 * MS_24H).toISOString();
    const trigger = detectItemStateTrigger(item, { lastEngagedAt: recentEngaged });
    expect(trigger).toBeNull();
  });

  it('does NOT trigger when coachIntensity is not persistent', () => {
    const item = makeItem({ coachIntensity: 'gentle' });
    const trigger = detectItemStateTrigger(item, { lastEngagedAt: null });
    expect(trigger).toBeNull();
  });

  it('triggers when lastEngagedAt is > 7d ago', () => {
    const item = makeItem({ coachIntensity: 'persistent' });
    const oldEngaged = new Date(Date.now() - 8 * MS_24H).toISOString();
    const trigger = detectItemStateTrigger(item, { lastEngagedAt: oldEngaged });
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('persistent-zero-engagement-7d');
  });
});

// ---------------------------------------------------------------------------
// detectItemStateTrigger — condition 4: new_vague_goal
// ---------------------------------------------------------------------------

describe('detectItemStateTrigger — new_vague_goal', () => {
  it('triggers for new goal with short title and no notes', () => {
    const item = makeItem({ type: 'goal', title: 'be better' }, ''); // < 8 tokens
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger).not.toBeNull();
    expect(trigger!.triggerType).toBe('new-vague-goal');
  });

  it('does NOT trigger when goal has sufficient title tokens', () => {
    const item = makeItem({
      type: 'goal',
      title: 'improve my physical fitness and build a daily exercise habit this quarter',
    });
    const trigger = detectItemStateTrigger(item, {});
    // 14+ tokens — well above 8 threshold
    expect(trigger?.triggerType).not.toBe('new-vague-goal');
  });

  it('does NOT trigger when goal has notes', () => {
    const item = makeItem({ type: 'goal', title: 'be better' }, 'Notes explaining the goal in detail\n');
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger?.triggerType).not.toBe('new-vague-goal');
  });

  it('does NOT trigger for old goal (> 24h)', () => {
    const item = makeItem({
      type: 'goal',
      title: 'be better',
      created: new Date(Date.now() - 2 * MS_24H).toISOString(),
    });
    const trigger = detectItemStateTrigger(item, {});
    expect(trigger?.triggerType).not.toBe('new-vague-goal');
  });
});

// ---------------------------------------------------------------------------
// notifyItemStateChange — callback body
// ---------------------------------------------------------------------------

describe('notifyItemStateChange', () => {
  it('calls dispatchTrigger when trigger is detected', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-item-state-'));
    const dataDir = tmpDir;
    const fired: unknown[] = [];

    const deps: ItemStateMonitorDeps = {
      dataDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async (t) => { fired.push(t); },
      readItemCoachMemory: async () => null,
    };

    // Item that should trigger due_24h
    const item = makeItem({
      due: nowPlus(2 * 60 * 60 * 1000).toISOString().slice(0, 10),
      updated: null,
    });

    await notifyItemStateChange(deps, 42, item);
    expect(fired.length).toBe(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT call dispatchTrigger when no trigger detected', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-item-state-'));
    const dataDir = tmpDir;
    const fired: unknown[] = [];

    const deps: ItemStateMonitorDeps = {
      dataDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async (t) => { fired.push(t); },
      readItemCoachMemory: async () => null,
    };

    // Regular task — no triggers
    const item = makeItem({ type: 'task' });

    await notifyItemStateChange(deps, 42, item);
    expect(fired.length).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('swallows errors from trigger dispatch (must not block storage)', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-item-state-'));
    const dataDir = tmpDir;

    const deps: ItemStateMonitorDeps = {
      dataDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async () => { throw new Error('test error'); },
      readItemCoachMemory: async () => null,
    };

    const item = makeItem({
      due: nowPlus(2 * 60 * 60 * 1000).toISOString().slice(0, 10),
      updated: null,
    });

    // Should NOT throw
    await expect(notifyItemStateChange(deps, 42, item)).resolves.toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps userId correctly (overrides placeholder 0)', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-item-state-'));
    const dataDir = tmpDir;
    const firedTriggers: Array<{ userId: number }> = [];

    const deps: ItemStateMonitorDeps = {
      dataDir,
      auditLog: { insert: () => undefined } as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
      fireSpontaneousCoachTurn: async (t) => { firedTriggers.push({ userId: t.userId }); },
      readItemCoachMemory: async () => null,
    };

    const item = makeItem({
      due: nowPlus(2 * 60 * 60 * 1000).toISOString().slice(0, 10),
      updated: null,
    });

    await notifyItemStateChange(deps, 777, item);
    expect(firedTriggers[0]?.userId).toBe(777);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
