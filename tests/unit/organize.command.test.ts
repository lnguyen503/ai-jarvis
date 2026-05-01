/**
 * Unit tests for the /organize slash command handler (ARCHITECTURE.md §16.11.5).
 *
 * Pattern-matches tests/unit/commands.calendar.test.ts for ctx shape and
 * assertion style.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  handleOrganize,
  isOrganizeDisabledForUser,
  _resetOrganizeToggleForTests,
  type OrganizeCommandDeps,
} from '../../src/commands/organize.js';
import type { OrganizeCommandDeps as Deps } from '../../src/commands/organize.js';

// ---------------------------------------------------------------------------
// Mock isGroupChat so we can control DM vs group in tests.
// ---------------------------------------------------------------------------
vi.mock('../../src/gateway/groupGate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway/groupGate.js')>();
  return {
    ...original,
    isGroupChat: vi.fn(() => false), // DM by default
  };
});

import { isGroupChat } from '../../src/gateway/groupGate.js';

// ---------------------------------------------------------------------------
// Minimal ctx factory
// ---------------------------------------------------------------------------

interface MockCtx {
  chat?: { type: string; id: number };
  from?: { id: number; first_name?: string };
  message?: { text?: string };
  replies: string[];
  replyOptions: Array<Record<string, unknown>>;
  reply: (msg: string, opts?: Record<string, unknown>) => Promise<void>;
}

function makeCtx(userId: number | undefined, text: string, chatType = 'private'): MockCtx {
  const ctx: MockCtx = {
    chat: { type: chatType, id: userId ?? 0 },
    from: userId !== undefined ? { id: userId, first_name: 'Boss' } : undefined,
    message: { text },
    replies: [],
    replyOptions: [],
    reply: async (msg: string, opts?: Record<string, unknown>) => {
      ctx.replies.push(msg);
      ctx.replyOptions.push(opts ?? {});
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

async function writeItemFile(
  dataDir: string,
  userId: number,
  itemId: string,
  type: 'task' | 'event' | 'goal',
  title: string,
  status: 'active' | 'done' | 'abandoned' = 'active',
  due: string = '',
  tags: string[] = [],
  notes = '',
  progress = '',
): Promise<void> {
  const userDir = path.join(dataDir, 'organize', String(userId));
  await mkdir(userDir, { recursive: true });
  const tagsStr = tags.length > 0 ? `[${tags.join(', ')}]` : '[]';
  const content =
    `---\n` +
    `id: ${itemId}\n` +
    `type: ${type}\n` +
    `status: ${status}\n` +
    `title: ${title}\n` +
    `created: 2026-04-24T10:00:00Z\n` +
    `due: ${due}\n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `tags: ${tagsStr}\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->\n\n` +
    `## Notes\n${notes}\n\n` +
    `## Progress\n${progress}\n`;
  await writeFile(path.join(userDir, `${itemId}.md`), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const USER_A = 111222;
let tmpDir: string;
let deps: Deps;

beforeEach(async () => {
  _resetOrganizeToggleForTests();
  vi.mocked(isGroupChat).mockReturnValue(false);
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-org-cmd-'));
  deps = {
    config: {
      memory: { dbPath: path.join(tmpDir, 'jarvis.db') },
    } as unknown as OrganizeCommandDeps['config'],
  };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/organize — group chat guard', () => {
  it('responds with DM-only message in a group chat and returns without reading items', async () => {
    vi.mocked(isGroupChat).mockReturnValue(true);
    // Plant an item — it should NOT be visible in reply.
    await writeItemFile(tmpDir, USER_A, '2026-04-24-a1b2', 'task', 'Secret task');
    const ctx = makeCtx(USER_A, '/organize', 'group');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toBe('Organize is DM-only — message me privately.');
    // Confirm no item data leaked.
    expect(ctx.replies[0]).not.toContain('Secret task');
  });
});

describe('/organize — no user context', () => {
  it('replies with a no-context message and does not throw', async () => {
    const ctx = makeCtx(undefined, '/organize');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('No user context');
  });
});

describe('/organize — DM with no items', () => {
  it('shows helpful "no items yet" message', async () => {
    const ctx = makeCtx(USER_A, '/organize');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('No');
    expect(ctx.replies[0]).toContain('items');
  });
});

describe('/organize — DM with 3 items', () => {
  it('renders HTML-formatted list containing all 3 titles', async () => {
    await writeItemFile(tmpDir, USER_A, '2026-04-24-t001', 'task', 'Buy milk', 'active', '2026-05-01');
    await writeItemFile(tmpDir, USER_A, '2026-04-24-t002', 'event', 'Dentist appointment', 'active', '2026-05-10');
    await writeItemFile(tmpDir, USER_A, '2026-04-24-t003', 'goal', 'Lose 10 lbs', 'active', '2026-07-01');

    const ctx = makeCtx(USER_A, '/organize');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);

    expect(ctx.replies).toHaveLength(1);
    const reply = ctx.replies[0]!;
    expect(reply).toContain('Buy milk');
    expect(reply).toContain('Dentist appointment');
    expect(reply).toContain('Lose 10 lbs');
    // Should use HTML parse_mode (opt has parse_mode: 'HTML')
    expect(ctx.replyOptions[0]).toMatchObject({ parse_mode: 'HTML' });
  });
});

describe('/organize tasks / events / goals — type filter', () => {
  beforeEach(async () => {
    await writeItemFile(tmpDir, USER_A, '2026-04-24-task', 'task', 'Water plants', 'active', '2026-05-01');
    await writeItemFile(tmpDir, USER_A, '2026-04-24-evnt', 'event', 'Team lunch', 'active', '2026-05-02');
    await writeItemFile(tmpDir, USER_A, '2026-04-24-goal', 'goal', 'Run 5k', 'active', '2026-06-01');
  });

  it('/organize tasks shows only the task', async () => {
    const ctx = makeCtx(USER_A, '/organize tasks');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('Water plants');
    expect(ctx.replies[0]).not.toContain('Team lunch');
    expect(ctx.replies[0]).not.toContain('Run 5k');
  });

  it('/organize events shows only the event', async () => {
    const ctx = makeCtx(USER_A, '/organize events');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('Team lunch');
    expect(ctx.replies[0]).not.toContain('Water plants');
    expect(ctx.replies[0]).not.toContain('Run 5k');
  });

  it('/organize goals shows only the goal', async () => {
    const ctx = makeCtx(USER_A, '/organize goals');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('Run 5k');
    expect(ctx.replies[0]).not.toContain('Water plants');
    expect(ctx.replies[0]).not.toContain('Team lunch');
  });
});

describe('/organize all — shows active + done items', () => {
  it('shows both active and done items', async () => {
    await writeItemFile(tmpDir, USER_A, '2026-04-24-act1', 'task', 'Active task', 'active');
    await writeItemFile(tmpDir, USER_A, '2026-04-24-don1', 'task', 'Done task', 'done');

    const ctx = makeCtx(USER_A, '/organize all');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);

    expect(ctx.replies[0]).toContain('Active task');
    expect(ctx.replies[0]).toContain('Done task');
  });
});

describe('/organize <id> — show full item', () => {
  it('shows front-matter + notes + progress for a known id', async () => {
    await writeItemFile(
      tmpDir,
      USER_A,
      '2026-04-24-a1b2',
      'goal',
      'Read more books',
      'active',
      '2026-12-31',
      ['learning'],
      'Start with Atomic Habits.',
      '- 2026-04-24: Started chapter 1.',
    );

    const ctx = makeCtx(USER_A, '/organize 2026-04-24-a1b2');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);

    const reply = ctx.replies[0]!;
    expect(reply).toContain('Read more books');
    expect(reply).toContain('2026-04-24-a1b2');
    expect(reply).toContain('Start with Atomic Habits');
    expect(reply).toContain('Started chapter 1');
    expect(ctx.replyOptions[0]).toMatchObject({ parse_mode: 'HTML' });
  });

  it('replies "item not found" for an unknown id', async () => {
    const ctx = makeCtx(USER_A, '/organize 2026-01-01-zzzz');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('not found');
  });
});

describe('/organize tag <name> — tag filter', () => {
  it('shows only items matching the tag', async () => {
    await writeItemFile(tmpDir, USER_A, '2026-04-24-t01', 'task', 'Tagged task', 'active', '', ['important']);
    await writeItemFile(tmpDir, USER_A, '2026-04-24-t02', 'task', 'Other task', 'active', '', ['routine']);

    const ctx = makeCtx(USER_A, '/organize tag important');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);

    expect(ctx.replies[0]).toContain('Tagged task');
    expect(ctx.replies[0]).not.toContain('Other task');
  });

  it('shows no-items message when tag matches nothing', async () => {
    const ctx = makeCtx(USER_A, '/organize tag nonexistent');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('No');
  });
});

describe('/organize off / on — injection toggle', () => {
  it('/organize off sets the disabled state for that userId', async () => {
    expect(isOrganizeDisabledForUser(USER_A)).toBe(false);
    const ctx = makeCtx(USER_A, '/organize off');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(isOrganizeDisabledForUser(USER_A)).toBe(true);
    expect(ctx.replies[0]).toContain('OFF');
  });

  it('/organize on clears the disabled state', async () => {
    // First disable.
    const offCtx = makeCtx(USER_A, '/organize off');
    await handleOrganize(offCtx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(isOrganizeDisabledForUser(USER_A)).toBe(true);

    // Then re-enable.
    const onCtx = makeCtx(USER_A, '/organize on');
    await handleOrganize(onCtx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(isOrganizeDisabledForUser(USER_A)).toBe(false);
    expect(onCtx.replies[0]).toContain('ON');
  });

  it('toggle is per-user — disabling user A does not affect user B', async () => {
    const USER_B = 999888;
    const ctx = makeCtx(USER_A, '/organize off');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(isOrganizeDisabledForUser(USER_A)).toBe(true);
    expect(isOrganizeDisabledForUser(USER_B)).toBe(false);
  });
});

describe('/organize — unknown subcommand', () => {
  it('replies with usage hint', async () => {
    const ctx = makeCtx(USER_A, '/organize frobnicate');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('Usage');
    expect(ctx.replies[0]).toContain('/organize');
  });
});

describe('/organize tag — missing tag argument', () => {
  it('replies with usage hint when tagname is omitted', async () => {
    const ctx = makeCtx(USER_A, '/organize tag');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('Usage');
  });
});
