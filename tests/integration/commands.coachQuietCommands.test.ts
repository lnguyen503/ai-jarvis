/**
 * Integration tests: coachQuietCommands.ts (v1.20.0 commit 3).
 *
 * Tests:
 *   /coach quiet <duration>
 *   1.  quiet 2h → activates; reply contains "scheduled coach DMs" + "still fire" (T-R4-1)
 *   2.  quiet 1d → activates; reply contains asymmetry note
 *   3.  quiet "until tomorrow" → activates; reply indicates tomorrow
 *   4.  quiet "until monday" → activates; reply indicates until monday
 *   5.  quiet "" (empty) → usage reply
 *   6.  quiet "99h" → out-of-range error
 *   7.  quiet "badvalue" → parse error
 *   /coach quiet status
 *   8.  status when not active → "not active" reply
 *   9.  status when active → shows time + asymmetry note (T-R4-2)
 *   /coach quiet off
 *   10. off when active → cleared; reply contains "Scheduled profile DMs are unchanged" (T-R4-3)
 *   11. off when not active → reply still confirms cleared
 *   audit
 *   12. quiet 2h → audit row inserted with category coach.global_quiet.engaged action=engage
 *   13. quiet off → audit row inserted with category coach.global_quiet.engaged action=off
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import {
  handleCoachQuiet,
  handleCoachQuietStatus,
  handleCoachQuietOff,
} from '../../src/commands/coachQuietCommands.js';
import type { CoachSubcommandCtx } from '../../src/commands/coachSubcommands.js';
import { checkQuietMode } from '../../src/coach/rateLimits.js';
import { resolveDataDir } from '../../src/config/dataDir.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 83001;
const CHAT_ID = 83001;

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
  dataDir = await mkdtemp(path.join(os.tmpdir(), `jarvis-coach-quiet-${Date.now()}-`));
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

function makeDeps(): CoachSubcommandCtx & { replies: string[] } {
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
  };
}

// ---------------------------------------------------------------------------
// /coach quiet <duration>
// ---------------------------------------------------------------------------

describe('handleCoachQuiet — happy paths', () => {
  it('T-1: quiet 2h activates; reply contains R4 asymmetry note', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, '2h');

    expect(deps.replies).toHaveLength(1);
    const reply = deps.replies[0]!;
    // T-R4-1 binding: these substrings MUST be present
    expect(reply).toContain('scheduled coach DMs');
    expect(reply).toContain('still fire');
    expect(reply).toContain('Quiet mode active until');
    expect(reply).toContain('remaining');

    // Verify quiet mode actually set in storage
    const result = await checkQuietMode(USER_ID, resolveDataDir(deps.config));
    expect(result.active).toBe(true);
    expect(result.untilIso).toBeTruthy();
    const untilMs = new Date(result.untilIso!).getTime();
    const expectedMs = Date.now() + 2 * 60 * 60 * 1000;
    // within 5s of expected (timing tolerance)
    expect(Math.abs(untilMs - expectedMs)).toBeLessThan(5000);
  });

  it('T-2: quiet 1d → activates; reply contains asymmetry note', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, '1d');

    const reply = deps.replies[0]!;
    expect(reply).toContain('scheduled coach DMs');
    expect(reply).toContain('still fire');

    const result = await checkQuietMode(USER_ID, resolveDataDir(deps.config));
    expect(result.active).toBe(true);
  });

  it('T-3: quiet "until tomorrow" → activates; reply formatted', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, 'until tomorrow');

    const reply = deps.replies[0]!;
    expect(reply).toContain('Quiet mode active until');
    expect(reply).toContain('scheduled coach DMs');

    const result = await checkQuietMode(USER_ID, resolveDataDir(deps.config));
    expect(result.active).toBe(true);
  });

  it('T-4: quiet "until monday" → activates', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, 'until monday');

    expect(deps.replies[0]).toContain('Quiet mode active until');

    const result = await checkQuietMode(USER_ID, resolveDataDir(deps.config));
    expect(result.active).toBe(true);
  });
});

describe('handleCoachQuiet — sad paths', () => {
  it('T-5: empty duration → usage reply', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, '');

    expect(deps.replies[0]).toContain('Usage');
    expect(deps.replies[0]).toContain('/coach quiet');
  });

  it('T-6: out-of-range 99h → error reply', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, '200h');

    expect(deps.replies[0]).toContain('168');
  });

  it('T-7: invalid value → parse error reply', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, 'badvalue');

    expect(deps.replies[0]).toContain('Couldn\'t parse');
  });
});

// ---------------------------------------------------------------------------
// /coach quiet status
// ---------------------------------------------------------------------------

describe('handleCoachQuietStatus', () => {
  it('T-8: status when not active → "not active" reply', async () => {
    const deps = makeDeps();
    await handleCoachQuietStatus(deps);

    expect(deps.replies[0]).toContain('not active');
  });

  it('T-9: status when active → shows time + asymmetry note (T-R4-2)', async () => {
    // First activate
    const setupDeps = makeDeps();
    await handleCoachQuiet(setupDeps, '3h');

    const deps = makeDeps();
    await handleCoachQuietStatus(deps);

    const reply = deps.replies[0]!;
    expect(reply).toContain('Quiet mode: active until');
    // T-R4-2 binding: asymmetry note must appear in status reply
    expect(reply).toContain('scheduled profile DMs still fire');
    expect(reply).toContain('remaining');
  });
});

// ---------------------------------------------------------------------------
// /coach quiet off
// ---------------------------------------------------------------------------

describe('handleCoachQuietOff', () => {
  it('T-10: off when active → cleared; reply contains R4 text (T-R4-3)', async () => {
    // First activate
    const setupDeps = makeDeps();
    await handleCoachQuiet(setupDeps, '2h');

    const deps = makeDeps();
    await handleCoachQuietOff(deps);

    // T-R4-3 binding: reply must contain "Scheduled profile DMs are unchanged"
    const reply = deps.replies[0]!;
    expect(reply).toContain('Scheduled profile DMs are unchanged');
    expect(reply).toContain('Quiet mode cleared');
    expect(reply).toContain('Event triggers resumed');

    // Verify quiet mode actually cleared
    const result = await checkQuietMode(USER_ID, resolveDataDir(deps.config));
    expect(result.active).toBe(false);
  });

  it('T-11: off when not active → still replies without error', async () => {
    const deps = makeDeps();
    await handleCoachQuietOff(deps);

    expect(deps.replies).toHaveLength(1);
    expect(deps.replies[0]).toContain('Quiet mode cleared');
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('audit entries', () => {
  it('T-12: quiet 2h → audit row with category coach.global_quiet.engaged action=engage', async () => {
    const deps = makeDeps();
    await handleCoachQuiet(deps, '2h');

    const rows = mem.auditLog.listRecent(10);
    const row = rows.find(r => r.category === 'coach.global_quiet.engaged');
    expect(row).toBeTruthy();
    expect(row!.actor_user_id).toBe(USER_ID);
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail['action']).toBe('engage');
    expect(detail['durationStr']).toBe('2h');
  });

  it('T-13: quiet off → audit row with category coach.global_quiet.engaged action=off', async () => {
    const deps = makeDeps();
    await handleCoachQuietOff(deps);

    const rows = mem.auditLog.listRecent(10);
    const row = rows.find(r => r.category === 'coach.global_quiet.engaged');
    expect(row).toBeTruthy();
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail['action']).toBe('off');
  });
});
