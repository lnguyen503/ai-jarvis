/**
 * Integration tests: coachProfileCommands.ts (v1.20.0 commit 2).
 *
 * Tests:
 *   setup — happy paths
 *   1.  setup '08:00' (no profile) → defaults morning, cron '0 8 * * *'
 *   2.  setup midday '12:00' → cron '0 12 * * *'
 *   3.  setup evening '19:00' → cron '0 19 * * *'
 *   4.  setup weekly mon '09:00' → cron '0 9 * * 1'
 *   5.  setup weekly sun '06:00' → cron '0 6 * * 0'
 *   6.  re-run setup → updates (upsert idempotent; single task per profile per user)
 *   setup — sad paths
 *   7.  setup with no args → usage reply; no task created
 *   8.  setup 'weekly' without day → error reply
 *   9.  setup 'weekly badday 09:00' → invalid day error
 *   10. setup 'badprofile 09:00' → unknown profile error
 *   11. setup '25:00' → invalid HH:MM error
 *   12. setup too many args → too many arguments error
 *   off
 *   13. off morning → deletes morning task; reply with pause message
 *   14. off all → deletes all profiles; reply with count
 *   15. off when not active → not-active reply (no error)
 *   16. off unknown profile → error reply
 *   status
 *   17. status with no tasks → all 4 lines show 'not set'
 *   18. status with morning set → morning line shows time + ✓
 *   19. status with weekly set → weekly line shows day + time + ✓
 *   20. status with legacy __coach__ task → shows legacy line
 *   helpers
 *   21. parseHHMMToDisplay: '08:00' → '8:00am'
 *   22. parseHHMMToDisplay: '14:30' → '2:30pm'
 *   23. parseHHMMToDisplay: '00:00' → '12:00am'
 *   24. parseHHMMToDisplay: '12:00' → '12:00pm'
 *   25. buildCronFromHHMM daily + weekly variants
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import {
  handleCoachSetupWithProfile,
  handleCoachOffByProfile,
  handleCoachStatusMultiProfile,
  parseHHMMToDisplay,
  buildCronFromHHMM,
} from '../../src/commands/coachProfileCommands.js';
import type { CoachSubcommandCtx } from '../../src/commands/coachSubcommands.js';
import {
  LEGACY_COACH_MARKER,
  listCoachTasks,
  COACH_MARKER_BY_PROFILE,
} from '../../src/coach/index.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 82001;
const CHAT_ID = 82001;

function makeMockCtx() {
  const replies: string[] = [];
  const ctx = {
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return {} as ReturnType<typeof ctx.reply> extends Promise<infer T> ? T : never;
    }),
    chat: { id: CHAT_ID },
    from: { id: USER_ID },
    message: { text: '' },
  };
  return { ctx, replies };
}

let mem: MemoryApi;
let dataDir: string;

beforeEach(async () => {
  _resetDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), `jarvis-coach-profile-${Date.now()}-`));
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });

  const dbPath = path.join(dataDir, 'test.db');
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  mem = initMemory(cfg);
});

afterEach(async () => {
  mem.close();
  _resetDb();
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(overrides?: Partial<CoachSubcommandCtx>): CoachSubcommandCtx & { replies: string[] } {
  const { ctx, replies } = makeMockCtx();
  const cfg = makeTestConfig({ memory: { dbPath: path.join(dataDir, 'test.db'), maxHistoryMessages: 50 } });
  return {
    ctx: ctx as unknown as import('grammy').Context,
    userId: USER_ID,
    chatId: CHAT_ID,
    memory: mem,
    config: cfg,
    scheduler: null,
    replies,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup happy paths
// ---------------------------------------------------------------------------

describe('handleCoachSetupWithProfile — happy paths', () => {
  it('T-1: no profile arg defaults to morning, cron 0 8 * * *', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['08:00']);

    const tasks = listCoachTasks(mem, USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe(COACH_MARKER_BY_PROFILE['morning']);
    expect(tasks[0]!.cron_expression).toBe('0 8 * * *');
    expect(deps.replies[0]).toContain('Morning');
    expect(deps.replies[0]).toContain('8:00am');
  });

  it('T-2: midday profile with 12:00 → cron 0 12 * * *', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['midday', '12:00']);

    const tasks = listCoachTasks(mem, USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe(COACH_MARKER_BY_PROFILE['midday']);
    expect(tasks[0]!.cron_expression).toBe('0 12 * * *');
    expect(deps.replies[0]).toContain('Midday');
    expect(deps.replies[0]).toContain('12:00pm');
  });

  it('T-3: evening profile with 19:00 → cron 0 19 * * *', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['evening', '19:00']);

    const tasks = listCoachTasks(mem, USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe(COACH_MARKER_BY_PROFILE['evening']);
    expect(tasks[0]!.cron_expression).toBe('0 19 * * *');
    expect(deps.replies[0]).toContain('Evening');
    expect(deps.replies[0]).toContain('7:00pm');
  });

  it('T-4: weekly mon 09:00 → cron 0 9 * * 1', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['weekly', 'mon', '09:00']);

    const tasks = listCoachTasks(mem, USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe(COACH_MARKER_BY_PROFILE['weekly']);
    expect(tasks[0]!.cron_expression).toBe('0 9 * * 1');
    expect(deps.replies[0]).toContain('Weekly');
    expect(deps.replies[0]).toContain('Mon');
    expect(deps.replies[0]).toContain('9:00am');
  });

  it('T-5: weekly sun 06:00 → cron 0 6 * * 0', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['weekly', 'sun', '06:00']);

    const tasks = listCoachTasks(mem, USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.cron_expression).toBe('0 6 * * 0');
    expect(deps.replies[0]).toContain('Sun');
  });

  it('T-6: re-run setup updates existing task (upsert idempotent)', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['morning', '08:00']);
    await handleCoachSetupWithProfile(deps, ['morning', '09:30']);

    const tasks = listCoachTasks(mem, USER_ID);
    // Should still be only 1 morning task
    const morningTasks = tasks.filter(t => t.description === COACH_MARKER_BY_PROFILE['morning']);
    expect(morningTasks).toHaveLength(1);
    expect(morningTasks[0]!.cron_expression).toBe('30 9 * * *');
  });
});

// ---------------------------------------------------------------------------
// Setup sad paths
// ---------------------------------------------------------------------------

describe('handleCoachSetupWithProfile — sad paths', () => {
  it('T-7: no args → usage reply; no task created', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, []);

    expect(deps.replies[0]).toContain('Usage');
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
  });

  it('T-8: weekly with no day → error reply', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['weekly', '09:00']);

    expect(deps.replies[0]).toContain('Weekly profile requires a day');
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
  });

  it('T-9: weekly badday → invalid day error', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['weekly', 'badday', '09:00']);

    expect(deps.replies[0]).toContain('Invalid day');
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
  });

  it('T-10: unknown profile → unknown profile error', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['daily', '09:00']);

    expect(deps.replies[0]).toContain('Unknown profile');
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
  });

  it('T-11: invalid HH:MM (25:00) → invalid time error', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['25:00']);

    expect(deps.replies[0]).toContain('25:00');
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
  });

  it('T-12: too many args → error reply', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['morning', '09:00', 'extra']);

    expect(deps.replies[0]).toContain('Too many arguments');
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /coach off
// ---------------------------------------------------------------------------

describe('handleCoachOffByProfile', () => {
  it('T-13: off morning → deletes morning task', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['morning', '08:00']);
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(1);

    const offDeps = makeDeps();
    await handleCoachOffByProfile(offDeps, 'morning');

    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
    expect(offDeps.replies[0]).toContain('Morning');
    expect(offDeps.replies[0]).toContain('paused');
  });

  it('T-14: off all → deletes all profiles', async () => {
    const deps = makeDeps();
    await handleCoachSetupWithProfile(deps, ['morning', '08:00']);
    await handleCoachSetupWithProfile(deps, ['midday', '12:00']);
    expect(listCoachTasks(mem, USER_ID)).toHaveLength(2);

    const offDeps = makeDeps();
    await handleCoachOffByProfile(offDeps, 'all');

    expect(listCoachTasks(mem, USER_ID)).toHaveLength(0);
    expect(offDeps.replies[0]).toContain('2');
    expect(offDeps.replies[0]).toContain('profiles');
  });

  it('T-15: off when not active → not-active reply (idempotent)', async () => {
    const deps = makeDeps();
    await handleCoachOffByProfile(deps, 'morning');

    expect(deps.replies[0]).toContain('not active');
  });

  it('T-16: off unknown profile → error reply', async () => {
    const deps = makeDeps();
    await handleCoachOffByProfile(deps, 'unknown');

    expect(deps.replies[0]).toContain('Unknown profile');
  });
});

// ---------------------------------------------------------------------------
// /coach status
// ---------------------------------------------------------------------------

describe('handleCoachStatusMultiProfile', () => {
  it('T-17: no tasks → all 4 profiles show "not set"', async () => {
    const deps = makeDeps();
    await handleCoachStatusMultiProfile(deps);

    const reply = deps.replies[0]!;
    expect(reply).toContain('Morning: not set');
    expect(reply).toContain('Midday: not set');
    expect(reply).toContain('Evening: not set');
    expect(reply).toContain('Weekly: not set');
  });

  it('T-18: morning task set → morning shows time + ✓', async () => {
    const setupDeps = makeDeps();
    await handleCoachSetupWithProfile(setupDeps, ['morning', '08:00']);

    const deps = makeDeps();
    await handleCoachStatusMultiProfile(deps);

    const reply = deps.replies[0]!;
    expect(reply).toContain('Morning:');
    expect(reply).toContain('8:00am');
    expect(reply).toContain('✓');
    expect(reply).toContain('Midday: not set');
  });

  it('T-19: weekly task set → weekly shows day + time + ✓', async () => {
    const setupDeps = makeDeps();
    await handleCoachSetupWithProfile(setupDeps, ['weekly', 'mon', '09:00']);

    const deps = makeDeps();
    await handleCoachStatusMultiProfile(deps);

    const reply = deps.replies[0]!;
    expect(reply).toContain('Weekly:');
    expect(reply).toContain('Mon');
    expect(reply).toContain('9:00am');
    expect(reply).toContain('✓');
  });

  it('T-20: legacy __coach__ task → shows legacy line', async () => {
    // Insert a legacy task directly
    mem.scheduledTasks.insert({
      description: LEGACY_COACH_MARKER,
      cron_expression: '0 8 * * *',
      command: '/coach',
      chat_id: CHAT_ID,
      owner_user_id: USER_ID,
    });

    const deps = makeDeps();
    await handleCoachStatusMultiProfile(deps);

    const reply = deps.replies[0]!;
    expect(reply).toContain('Legacy');
    expect(reply).toContain('migrate to morning');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('parseHHMMToDisplay', () => {
  it('T-21: 08:00 → 8:00am', () => {
    expect(parseHHMMToDisplay('08:00')).toBe('8:00am');
  });

  it('T-22: 14:30 → 2:30pm', () => {
    expect(parseHHMMToDisplay('14:30')).toBe('2:30pm');
  });

  it('T-23: 00:00 → 12:00am', () => {
    expect(parseHHMMToDisplay('00:00')).toBe('12:00am');
  });

  it('T-24: 12:00 → 12:00pm', () => {
    expect(parseHHMMToDisplay('12:00')).toBe('12:00pm');
  });

  it('invalid input → null', () => {
    expect(parseHHMMToDisplay('25:00')).toBeNull();
    expect(parseHHMMToDisplay('nottime')).toBeNull();
  });
});

describe('buildCronFromHHMM', () => {
  it('T-25a: daily → MM HH * * *', () => {
    expect(buildCronFromHHMM(8, 0)).toBe('0 8 * * *');
    expect(buildCronFromHHMM(14, 30)).toBe('30 14 * * *');
  });

  it('T-25b: weekly → MM HH * * DOW', () => {
    expect(buildCronFromHHMM(9, 0, 1)).toBe('0 9 * * 1'); // Mon
    expect(buildCronFromHHMM(6, 0, 0)).toBe('0 6 * * 0'); // Sun
  });
});
