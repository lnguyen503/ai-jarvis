/**
 * Integration tests for coach_log_user_override tool (v1.19.0 ADR 019 R3 + W1).
 *
 * Test IDs:
 *   T-R3-1  — happy path: creates override entry + audit row emitted
 *   T-R3-2  — NUL byte in fromMessage → INVALID_CHARS rejection
 *   T-R3-3  — NUL byte in expiresAtIso → INVALID_CHARS rejection
 *   T-R3-4  — fromMessage > 500 chars → FROM_MESSAGE_TOO_LONG rejection
 *   T-R3-5  — per-turn write cap (MAX_WRITES=10) → MEMORY_WRITE_CAP_EXCEEDED rejection
 *   T-R3-6  — non-coach context (no coachTurnCounters) → cap not enforced, write succeeds
 *   T-R3-7  — item not found → ITEM_NOT_FOUND rejection
 *   T-R3-8  — upsert: second call updates existing entry (no KEY_EXISTS failure)
 *   T-R3-9  — audit detail shape: only structural metadata (no raw fromMessage content)
 *   T-R3-10 — all four intents accepted: back_off, push, defer, done_signal
 *   T-R3-11 — scrub applied: output key references scrubbed fromMessage
 *   T-R3-12 — tool is registered in tools/index.ts by name 'coach_log_user_override'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createItem } from '../../src/organize/storage.js';
import { coachLogUserOverride } from '../../src/coach/coachOverrideTool.js';
import { getEntry } from '../../src/memory/userMemoryEntries.js';
import type { ToolContext } from '../../src/tools/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 999_101;

/** Captured audit calls. */
let auditRows: { category: string; detail: Record<string, unknown> }[];

/** Build a ToolContext for tool tests. */
function makeCtx(
  coachTurnCounters?: { nudges: number; writes: number },
  scrubbedAs?: (s: string) => string,
): ToolContext {
  return {
    sessionId: 1,
    chatId: 456,
    userId: USER_ID,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => makeCtx(coachTurnCounters, scrubbedAs).logger,
    } as unknown as ToolContext['logger'],
    config: {
      memory: { dbPath: path.join(dataDir, 'test.db'), maxHistoryMessages: 50 },
    } as unknown as ToolContext['config'],
    memory: {
      auditLog: {
        insert: (row: { category: string; detail: Record<string, unknown> }) => {
          auditRows.push(row);
        },
        insertReturningId: () => 0,
        listByCategoryAndActorSince: () => [],
        updateDetail: () => {},
        list: () => [],
        listByCategories: () => [],
      },
    } as unknown as ToolContext['memory'],
    safety: {
      isReadAllowed: () => true,
      isWriteAllowed: () => true,
      classifyCommand: () => ({ hardReject: false, requiresConfirmation: false }),
      scrub: scrubbedAs ?? ((s: string) => s),
      scrubRecord: (r: Record<string, unknown>) => r,
      requiresConfirmation: () => false,
      addConfirmation: () => ({ id: 'test', expiresAt: new Date() }),
      consumeConfirmation: () => null,
      getConfirmation: () => null,
      listConfirmations: () => [],
      expireConfirmations: () => {},
    } as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
    coachTurnCounters,
  };
}

// dataDir is shared across tests; each test uses a fresh beforeEach dir.
let dataDir: string;
let itemId: string; // a real organize item for resolveItemId to succeed

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-coach-override-tool-'));
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });
  await mkdir(path.join(dataDir, 'organize', String(USER_ID)), { recursive: true });

  auditRows = [];

  // Create a real organize item
  const item = await createItem(USER_ID, dataDir, {
    type: 'task',
    title: 'exercise',
    due: null,
    tags: [],
  });
  itemId = item.frontMatter.id;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T-R3-1: happy path — creates entry + audit emitted
// ---------------------------------------------------------------------------

describe('T-R3-1: happy path', () => {
  it('creates override memory entry and emits audit row', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: 'please skip exercise for now',
        expiresAtIso: expiresAt,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain(itemId);
    expect(result.output).toContain('back_off');

    // Memory entry should exist
    const key = `coach.${itemId}.userOverride`;
    const entry = await getEntry(USER_ID, dataDir, key);
    expect(entry).not.toBeNull();
    expect(entry?.body).toContain('back_off');
    expect(entry?.body).toContain(expiresAt);

    // Audit row emitted
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.category).toBe('coach.user_override');
  });
});

// ---------------------------------------------------------------------------
// T-R3-2: NUL byte in fromMessage → rejection
// ---------------------------------------------------------------------------

describe('T-R3-2: NUL byte in fromMessage', () => {
  it('rejects fromMessage containing NUL byte', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: 'skip\x00exercise',
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FROM_MESSAGE_INVALID_CHARS');
    // No audit, no write
    expect(auditRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-R3-3: NUL byte in expiresAtIso → rejection
// ---------------------------------------------------------------------------

describe('T-R3-3: NUL byte in expiresAtIso', () => {
  it('rejects expiresAtIso containing NUL byte', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'defer',
        fromMessage: 'defer this',
        expiresAtIso: '2026-04-25T00:00:00\x00Z',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EXPIRES_AT_INVALID_CHARS');
    expect(auditRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-R3-4: fromMessage > 500 chars → FROM_MESSAGE_TOO_LONG
// ---------------------------------------------------------------------------

describe('T-R3-4: fromMessage too long', () => {
  it('rejects fromMessage exceeding 500 characters', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const longMsg = 'a'.repeat(501);
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'push',
        fromMessage: longMsg,
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FROM_MESSAGE_TOO_LONG');
    expect(auditRows).toHaveLength(0);
  });

  it('accepts fromMessage exactly at cap (500 chars)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const atCapMsg = 'b'.repeat(500);
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'push',
        fromMessage: atCapMsg,
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-R3-5: per-turn write cap enforcement
// ---------------------------------------------------------------------------

describe('T-R3-5: per-turn write cap', () => {
  it('rejects when writes counter is at MAX_WRITES_PER_TURN (10)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 10 }); // already at cap
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: 'skip exercise',
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('MEMORY_WRITE_CAP_EXCEEDED');
    expect(auditRows).toHaveLength(0);
  });

  it('increments writes counter on success', async () => {
    const counters = { nudges: 0, writes: 0 };
    const ctx = makeCtx(counters);
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: 'skip exercise',
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(counters.writes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-R3-6: non-coach context (no coachTurnCounters) — cap not enforced
// ---------------------------------------------------------------------------

describe('T-R3-6: non-coach context (chat-side call)', () => {
  it('succeeds without coachTurnCounters (chat-side /coach back-off command)', async () => {
    const ctx = makeCtx(undefined); // no counters = chat-side call
    const result = await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: 'skip exercise',
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    // Audit still emitted (tool always audits regardless of context)
    expect(auditRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T-R3-7: item not found → ITEM_NOT_FOUND
// ---------------------------------------------------------------------------

describe('T-R3-7: item not found', () => {
  it('rejects when itemId does not match any organize item', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogUserOverride.execute(
      {
        itemId: '2099-01-01-zzzzzz', // nonexistent
        intent: 'back_off',
        fromMessage: 'skip nonexistent',
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
    expect(auditRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-R3-8: upsert — second call updates existing entry (no KEY_EXISTS failure)
// ---------------------------------------------------------------------------

describe('T-R3-8: upsert semantics', () => {
  it('second call overwrites the existing override entry without error', async () => {
    const expires1 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const expires2 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const ctx1 = makeCtx({ nudges: 0, writes: 0 });
    const r1 = await coachLogUserOverride.execute(
      { itemId, intent: 'back_off', fromMessage: 'skip exercise', expiresAtIso: expires1 },
      ctx1,
    );
    expect(r1.ok).toBe(true);

    const ctx2 = makeCtx({ nudges: 0, writes: 0 });
    const r2 = await coachLogUserOverride.execute(
      { itemId, intent: 'defer', fromMessage: 'defer exercise until tomorrow', expiresAtIso: expires2 },
      ctx2,
    );
    expect(r2.ok).toBe(true);

    // Entry should reflect the second call's intent
    const key = `coach.${itemId}.userOverride`;
    const entry = await getEntry(USER_ID, dataDir, key);
    expect(entry?.body).toContain('defer');
    expect(entry?.body).toContain(expires2);
    expect(entry?.body).not.toContain('back_off');
  });
});

// ---------------------------------------------------------------------------
// T-R3-9: audit detail shape — structural metadata only, no raw fromMessage
// ---------------------------------------------------------------------------

describe('T-R3-9: audit detail shape', () => {
  it('audit detail contains only structural metadata — no raw fromMessage', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const rawMsg = 'please skip exercise for now — it has been a rough week';

    await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: rawMsg,
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(auditRows).toHaveLength(1);
    const detail = auditRows[0]!.detail;

    // Structural fields present
    expect(detail).toHaveProperty('itemId', itemId);
    expect(detail).toHaveProperty('intent', 'back_off');
    expect(detail).toHaveProperty('expiresAtIso');
    expect(detail).toHaveProperty('fromMessageLen', rawMsg.length);

    // Raw fromMessage must NOT be in the audit detail
    expect(JSON.stringify(detail)).not.toContain(rawMsg);
    // No fromMessageHash key visible in detail (per ADR 019 F3 — hash is in memory body, not audit)
    expect(detail).not.toHaveProperty('fromMessage');
  });
});

// ---------------------------------------------------------------------------
// T-R3-10: all four intents accepted
// ---------------------------------------------------------------------------

describe('T-R3-10: all intents', () => {
  const intents = ['back_off', 'push', 'defer', 'done_signal'] as const;

  for (const intent of intents) {
    it(`accepts intent "${intent}"`, async () => {
      const ctx = makeCtx({ nudges: 0, writes: 0 });
      const result = await coachLogUserOverride.execute(
        {
          itemId,
          intent,
          fromMessage: `test message for ${intent}`,
          expiresAtIso: new Date().toISOString(),
        },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain(intent);
    });
  }
});

// ---------------------------------------------------------------------------
// T-R3-11: scrub applied — fromMessage is scrubbed before hash/len recorded
// ---------------------------------------------------------------------------

describe('T-R3-11: scrub applied to fromMessage', () => {
  it('records scrubbed length in audit detail when scrubber changes content', async () => {
    // Scrubber replaces PII with "[REDACTED]"
    const scrubber = (s: string) => s.replace(/skip exercise/gi, '[REDACTED]');
    const ctx = makeCtx({ nudges: 0, writes: 0 }, scrubber);
    const rawMsg = 'skip exercise please';

    await coachLogUserOverride.execute(
      {
        itemId,
        intent: 'back_off',
        fromMessage: rawMsg,
        expiresAtIso: new Date().toISOString(),
      },
      ctx,
    );

    expect(auditRows).toHaveLength(1);
    const detail = auditRows[0]!.detail;
    // Scrubbed text is '[REDACTED] please' (17 chars + original suffix length)
    const scrubbedMsg = scrubber(rawMsg);
    expect(detail['fromMessageLen']).toBe(scrubbedMsg.length);
    // Raw length is different from scrubbed length
    expect(detail['fromMessageLen']).not.toBe(rawMsg.length);
  });
});

// ---------------------------------------------------------------------------
// T-R3-12: tool registration check
// ---------------------------------------------------------------------------

describe('T-R3-12: tool registration', () => {
  it('registerTools includes coach_log_user_override', async () => {
    const { registerTools } = await import('../../src/tools/index.js');

    const stubLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => stubLogger,
    } as unknown as Parameters<typeof registerTools>[0]['logger'];

    const stubDeps = {
      config: {
        memory: { dbPath: path.join(dataDir, 'test.db'), maxHistoryMessages: 50 },
        safety: { allowedPaths: [], maxFileSizeBytes: 0, blockedCommands: [] },
        web: { enabled: false, allowedHosts: [] },
      } as unknown as Parameters<typeof registerTools>[0]['config'],
      logger: stubLogger,
      safety: {
        isReadAllowed: () => true,
        isWriteAllowed: () => true,
        classifyCommand: () => ({ hardReject: false, requiresConfirmation: false }),
        scrub: (s: string) => s,
        scrubRecord: (r: Record<string, unknown>) => r,
        requiresConfirmation: () => false,
        addConfirmation: () => ({ id: 'test', expiresAt: new Date() }),
        consumeConfirmation: () => null,
        getConfirmation: () => null,
        listConfirmations: () => [],
        expireConfirmations: () => {},
      } as unknown as Parameters<typeof registerTools>[0]['safety'],
      memory: {
        auditLog: {
          insert: () => {},
          insertReturningId: () => 0,
          listByCategoryAndActorSince: () => [],
          updateDetail: () => {},
          list: () => [],
          listByCategories: () => [],
        },
      } as unknown as Parameters<typeof registerTools>[0]['memory'],
      schedulerApi: { reload: () => {} },
    };

    const tools = registerTools(stubDeps, []);
    const names = tools.map((t) => t.name);
    expect(names).toContain('coach_log_user_override');
  });
});
