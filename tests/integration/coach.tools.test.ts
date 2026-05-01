/**
 * Integration tests for coach_log_* tools and coach_read_history (v1.18.0 ADR 018).
 *
 * Test categories:
 *   R6/F1-1..R6/F1-4 — dangerous tools rejected in coach context; allowlist correct
 *   R5/F3-1          — NUL-byte ban on all coach text fields (per field, parameterized)
 *   R5/F3-2          — cap enforcement: at-cap accepted, cap+1 rejected
 *   R5/F3-3          — audit detail shape: hash+len only, no raw body
 *   R3-1..R3-5       — per-coach-turn caps (nudge max 5, writes max 10; read_history uncapped)
 *   smoke            — happy-path round-trip for each of the 5 tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createItem } from '../../src/organize/storage.js';
import {
  coachLogNudge,
  coachLogResearch,
  coachLogIdea,
  coachLogPlan,
  coachReadHistory,
  MAX_NUDGE_TEXT,
  MAX_QUERY,
  MAX_RESULT_DIGEST,
  MAX_IDEA_SUMMARY,
  MAX_PLAN_SUMMARY,
  MAX_SUBTASK_COUNT,
  MAX_NUDGES_PER_TURN,
  MAX_WRITES_PER_TURN,
} from '../../src/coach/coachTools.js';
import { readCoachEntries } from '../../src/coach/coachMemory.js';
import type { ToolContext } from '../../src/tools/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 999001;

/** Minimal SafetyApi stub (no-op scrubber). */
const stubSafety = {
  isReadAllowed: () => true,
  isWriteAllowed: () => true,
  classifyCommand: () => ({ hardReject: false, requiresConfirmation: false }),
  scrub: (text: string) => text,
  scrubRecord: (data: Record<string, unknown>) => data,
  requiresConfirmation: () => false,
  addConfirmation: () => ({ id: 'test', expiresAt: new Date() }),
  consumeConfirmation: () => null,
  getConfirmation: () => null,
  listConfirmations: () => [],
  expireConfirmations: () => {},
};

let dataDir: string;
let itemId: string; // a real organize item created in beforeEach

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-coach-tools-'));
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });
  await mkdir(path.join(dataDir, 'organize', String(USER_ID)), { recursive: true });

  // Create a real organize item so resolveItemId succeeds
  const dbPath = path.join(dataDir, 'test.db');
  const item = await createItem(USER_ID, dataDir, {
    type: 'task',
    title: 'Test organize item for coach tools',
    due: null,
    tags: [],
  });
  itemId = item.frontMatter.id;
  // suppress unused warning
  void dbPath;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Build a ToolContext with the given coachTurnCounters. */
function makeCtx(
  coachTurnCounters?: { nudges: number; writes: number },
): ToolContext {
  return {
    sessionId: 1,
    chatId: 123,
    userId: USER_ID,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => makeCtx(coachTurnCounters).logger,
    } as unknown as ToolContext['logger'],
    config: {
      memory: { dbPath: path.join(dataDir, 'test.db'), maxHistoryMessages: 50 },
    } as unknown as ToolContext['config'],
    memory: {
      auditLog: {
        insert: () => {},
        insertReturningId: () => 0,
        listByCategoryAndActorSince: () => [],
        updateDetail: () => {},
        list: () => [],
        listByCategories: () => [],
      },
    } as unknown as ToolContext['memory'],
    safety: stubSafety as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
    coachTurnCounters,
  };
}

// ---------------------------------------------------------------------------
// Smoke tests: happy-path round-trip for each tool
// ---------------------------------------------------------------------------

describe('smoke: happy-path round-trip', () => {
  it('coach_log_nudge writes to memory and returns ok', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogNudge.execute(
      { itemId, intensity: 'gentle', nudgeText: 'You should tackle this retirement item.' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain(itemId);

    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${itemId}.lastNudge.`);
    expect(entries).toHaveLength(1);
    const p = entries[0]!.payload as { nudgeText: string };
    expect(p.nudgeText).toContain('retirement item');
  });

  it('coach_log_research writes to memory and returns ok', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId, query: 'retirement contributions 2026', resultDigest: 'Summary of results.', urls: ['https://example.com'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${itemId}.research.`);
    expect(entries).toHaveLength(1);
  });

  it('coach_log_idea writes to memory and returns ok', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogIdea.execute(
      { itemId, ideaSummary: 'Break this into three mini-tasks.' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${itemId}.idea.`);
    expect(entries).toHaveLength(1);
  });

  it('coach_log_plan writes to memory and returns ok', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogPlan.execute(
      { itemId, planSummary: 'Step 1: Research. Step 2: Act.', subtaskCount: 2 },
      ctx,
    );
    expect(result.ok).toBe(true);
    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${itemId}.plan.`);
    expect(entries).toHaveLength(1);
  });

  it('coach_read_history returns entries for the item', async () => {
    const writeCtx = makeCtx({ nudges: 0, writes: 0 });
    await coachLogNudge.execute({ itemId, intensity: 'moderate', nudgeText: 'Nudge 1.' }, writeCtx);
    await coachLogNudge.execute({ itemId, intensity: 'persistent', nudgeText: 'Nudge 2.' }, writeCtx);

    const readCtx = makeCtx(undefined); // no caps for read
    const result = await coachReadHistory.execute({ itemId, limit: 10 }, readCtx);
    expect(result.ok).toBe(true);
    // Output contains entries (not the "No history" empty message)
    expect(result.output).not.toContain('No coach history');
    // data.entries should have at least the 2 nudges written above
    const data = result.data as { entries: Array<{ at: string; eventType: string }> };
    expect(data.entries.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// R5/F3-1: NUL-byte rejection on each text field
// ---------------------------------------------------------------------------

describe('R5/F3-1: NUL-byte rejection on text fields', () => {
  it('coach_log_nudge rejects nudgeText with NUL byte (NUDGE_TEXT_INVALID_CHARS)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogNudge.execute(
      { itemId, intensity: 'gentle', nudgeText: 'Hello\x00World' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NUDGE_TEXT_INVALID_CHARS');
  });

  it('coach_log_research rejects query with NUL byte (QUERY_INVALID_CHARS)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId, query: 'bad\x00query', resultDigest: 'ok', urls: [] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('QUERY_INVALID_CHARS');
  });

  it('coach_log_research rejects resultDigest with NUL byte (RESULT_DIGEST_INVALID_CHARS)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId, query: 'ok query', resultDigest: 'data\x00here', urls: [] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RESULT_DIGEST_INVALID_CHARS');
  });

  it('coach_log_idea rejects ideaSummary with NUL byte (IDEA_SUMMARY_INVALID_CHARS)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogIdea.execute(
      { itemId, ideaSummary: 'good\x00idea' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('IDEA_SUMMARY_INVALID_CHARS');
  });

  it('coach_log_plan rejects planSummary with NUL byte (PLAN_SUMMARY_INVALID_CHARS)', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogPlan.execute(
      { itemId, planSummary: 'plan\x00step', subtaskCount: 1 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PLAN_SUMMARY_INVALID_CHARS');
  });
});

// ---------------------------------------------------------------------------
// R5/F3-2: Cap enforcement — at-cap accepted, cap+1 rejected
// ---------------------------------------------------------------------------

describe('R5/F3-2: per-field char cap enforcement', () => {
  it('nudgeText at exactly MAX_NUDGE_TEXT is accepted', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogNudge.execute(
      { itemId, intensity: 'gentle', nudgeText: 'a'.repeat(MAX_NUDGE_TEXT) },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('nudgeText at MAX_NUDGE_TEXT + 1 is rejected', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogNudge.execute(
      { itemId, intensity: 'gentle', nudgeText: 'a'.repeat(MAX_NUDGE_TEXT + 1) },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('query at exactly MAX_QUERY is accepted', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId, query: 'a'.repeat(MAX_QUERY), resultDigest: 'ok', urls: [] },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('resultDigest at exactly MAX_RESULT_DIGEST is accepted', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId, query: 'ok', resultDigest: 'a'.repeat(MAX_RESULT_DIGEST), urls: [] },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('ideaSummary at exactly MAX_IDEA_SUMMARY is accepted', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogIdea.execute(
      { itemId, ideaSummary: 'a'.repeat(MAX_IDEA_SUMMARY) },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('planSummary at exactly MAX_PLAN_SUMMARY is accepted', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogPlan.execute(
      { itemId, planSummary: 'a'.repeat(MAX_PLAN_SUMMARY), subtaskCount: 0 },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('subtaskCount at MAX_SUBTASK_COUNT is accepted', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogPlan.execute(
      { itemId, planSummary: 'plan', subtaskCount: MAX_SUBTASK_COUNT },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('subtaskCount at MAX_SUBTASK_COUNT + 1 is rejected', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogPlan.execute(
      { itemId, planSummary: 'plan', subtaskCount: MAX_SUBTASK_COUNT + 1 },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('urls array exceeding MAX_URLS is rejected', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId, query: 'ok', resultDigest: 'ok', urls: ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com', 'https://f.com'] },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R5/F3-3: Audit detail shape — hash+len only, no raw body
// ---------------------------------------------------------------------------

describe('R5/F3-3: audit detail shape (hash + len; no raw body)', () => {
  it('coach_log_nudge audit contains nudgeTextHash + nudgeTextLen, NOT raw nudgeText', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    ctx.memory.auditLog.insert = (params) => { inserts.push(params.detail); };

    const nudgeText = 'Check your retirement contribution deadline.';
    await coachLogNudge.execute({ itemId, intensity: 'persistent', nudgeText }, ctx);

    expect(inserts).toHaveLength(1);
    const detail = inserts[0]!;
    expect(detail).toHaveProperty('nudgeTextHash');
    expect(detail).toHaveProperty('nudgeTextLen');
    expect(detail).not.toHaveProperty('nudgeText');
    expect(detail).not.toHaveProperty('body');
    expect(detail.nudgeTextLen).toBe(nudgeText.length);
  });

  it('coach_log_research audit contains hashes + counts, NOT raw resultDigest', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    ctx.memory.auditLog.insert = (params) => { inserts.push(params.detail); };

    const resultDigest = 'Summary of 2026 retirement rules.';
    await coachLogResearch.execute({ itemId, query: 'retirement 2026', resultDigest, urls: ['https://irs.gov'] }, ctx);

    expect(inserts).toHaveLength(1);
    const detail = inserts[0]!;
    expect(detail).toHaveProperty('queryHash');
    expect(detail).toHaveProperty('resultDigestHash');
    expect(detail).toHaveProperty('resultDigestLen');
    expect(detail).not.toHaveProperty('resultDigest');
    expect(detail).not.toHaveProperty('query');
    expect(detail.resultDigestLen).toBe(resultDigest.length);
  });

  it('coach_log_idea audit contains ideaSummaryHash + ideaSummaryLen, NOT raw summary', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    ctx.memory.auditLog.insert = (params) => { inserts.push(params.detail); };

    const ideaSummary = 'Break into 3 milestones.';
    await coachLogIdea.execute({ itemId, ideaSummary }, ctx);

    expect(inserts).toHaveLength(1);
    const detail = inserts[0]!;
    expect(detail).toHaveProperty('ideaSummaryHash');
    expect(detail).toHaveProperty('ideaSummaryLen');
    expect(detail).not.toHaveProperty('ideaSummary');
    expect(detail.ideaSummaryLen).toBe(ideaSummary.length);
  });

  it('coach_log_plan audit contains planSummaryHash + subtaskCount, NOT raw summary', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    ctx.memory.auditLog.insert = (params) => { inserts.push(params.detail); };

    const planSummary = 'Step 1: Fund. Step 2: Track.';
    await coachLogPlan.execute({ itemId, planSummary, subtaskCount: 2 }, ctx);

    expect(inserts).toHaveLength(1);
    const detail = inserts[0]!;
    expect(detail).toHaveProperty('planSummaryHash');
    expect(detail).toHaveProperty('planSummaryLen');
    expect(detail).toHaveProperty('subtaskCount');
    expect(detail).not.toHaveProperty('planSummary');
    expect(detail.subtaskCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R3: Per-coach-turn caps
// ---------------------------------------------------------------------------

describe('R3-1: 5 nudges accepted, 6th rejected (NUDGE_CAP_EXCEEDED)', () => {
  it('exactly MAX_NUDGES_PER_TURN nudges succeed; next returns NUDGE_CAP_EXCEEDED', async () => {
    const counters = { nudges: 0, writes: 0 };

    for (let i = 0; i < MAX_NUDGES_PER_TURN; i++) {
      const ctx = makeCtx(counters);
      const result = await coachLogNudge.execute(
        { itemId, intensity: 'gentle', nudgeText: `Nudge ${i}` },
        ctx,
      );
      expect(result.ok, `nudge ${i} should succeed`).toBe(true);
    }
    expect(counters.nudges).toBe(MAX_NUDGES_PER_TURN);

    // 6th nudge
    const ctxOver = makeCtx(counters);
    const over = await coachLogNudge.execute(
      { itemId, intensity: 'gentle', nudgeText: 'Extra nudge' },
      ctxOver,
    );
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe('NUDGE_CAP_EXCEEDED');
  });
});

describe('R3-2: 10 mixed writes accepted, 11th rejected (MEMORY_WRITE_CAP_EXCEEDED)', () => {
  it('10 writes across tools succeed; 11th returns MEMORY_WRITE_CAP_EXCEEDED', async () => {
    const counters = { nudges: 0, writes: 0 };

    // 5 nudges
    for (let i = 0; i < MAX_NUDGES_PER_TURN; i++) {
      const ctx = makeCtx(counters);
      const result = await coachLogNudge.execute({ itemId, intensity: 'gentle', nudgeText: `N${i}` }, ctx);
      expect(result.ok, `nudge ${i}`).toBe(true);
    }

    // 3 research
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx(counters);
      const result = await coachLogResearch.execute({ itemId, query: `q${i}`, resultDigest: 'ok', urls: [] }, ctx);
      expect(result.ok, `research ${i}`).toBe(true);
    }

    // 2 ideas
    for (let i = 0; i < 2; i++) {
      const ctx = makeCtx(counters);
      const result = await coachLogIdea.execute({ itemId, ideaSummary: `idea ${i}` }, ctx);
      expect(result.ok, `idea ${i}`).toBe(true);
    }

    expect(counters.writes).toBe(MAX_WRITES_PER_TURN);

    // 11th write — any tool
    const ctxOver = makeCtx(counters);
    const over = await coachLogPlan.execute({ itemId, planSummary: 'one more', subtaskCount: 0 }, ctxOver);
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe('MEMORY_WRITE_CAP_EXCEEDED');
  });
});

describe('R3-3: coach_read_history NOT counted against write cap', () => {
  it('50 read_history calls succeed even after write cap is exhausted', async () => {
    // First exhaust the write cap
    const counters = { nudges: 0, writes: 0 };
    for (let i = 0; i < MAX_WRITES_PER_TURN; i++) {
      if (i < MAX_NUDGES_PER_TURN) {
        const ctx = makeCtx(counters);
        await coachLogNudge.execute({ itemId, intensity: 'gentle', nudgeText: `N${i}` }, ctx);
      } else {
        const ctx = makeCtx(counters);
        await coachLogResearch.execute({ itemId, query: `q${i}`, resultDigest: 'ok', urls: [] }, ctx);
      }
    }
    expect(counters.writes).toBe(MAX_WRITES_PER_TURN);

    // Now do 50 reads — all must succeed
    for (let i = 0; i < 50; i++) {
      const ctx = makeCtx(counters); // same counters (writes=10)
      const result = await coachReadHistory.execute({ itemId, limit: 5 }, ctx);
      expect(result.ok, `read ${i}`).toBe(true);
    }
  });
});

describe('R3-4: cap resets between coach turns', () => {
  it('two consecutive turns each succeed up to MAX_WRITES_PER_TURN', async () => {
    for (let turn = 0; turn < 2; turn++) {
      // Fresh counters per turn
      const counters = { nudges: 0, writes: 0 };

      for (let i = 0; i < MAX_WRITES_PER_TURN; i++) {
        const ctx = makeCtx(counters);
        const result = i < MAX_NUDGES_PER_TURN
          ? await coachLogNudge.execute({ itemId, intensity: 'gentle', nudgeText: `T${turn}N${i}` }, ctx)
          : await coachLogResearch.execute({ itemId, query: `T${turn}q${i}`, resultDigest: 'ok', urls: [] }, ctx);
        expect(result.ok, `turn ${turn} write ${i}`).toBe(true);
      }
      expect(counters.writes).toBe(MAX_WRITES_PER_TURN);
    }
  });
});

describe('R3-5: non-coach turn (coachTurnCounters undefined) has no cap', () => {
  it('11+ writes succeed when coachTurnCounters is undefined', async () => {
    // No counters → no per-turn cap
    for (let i = 0; i < MAX_WRITES_PER_TURN + 5; i++) {
      const ctx = makeCtx(undefined); // no caps
      const result = await coachLogResearch.execute({ itemId, query: `q${i}`, resultDigest: 'ok', urls: [] }, ctx);
      expect(result.ok, `write ${i} without cap`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R6/F1: ITEM_NOT_FOUND returned when itemId doesn't resolve
// ---------------------------------------------------------------------------

describe('R6/F1: resolveItemId gating', () => {
  it('coach_log_nudge returns ITEM_NOT_FOUND for unknown itemId', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogNudge.execute(
      { itemId: '2000-01-01-zzzz', intensity: 'gentle', nudgeText: 'oops' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
  });

  it('coach_log_research returns ITEM_NOT_FOUND for unknown itemId', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogResearch.execute(
      { itemId: '2000-01-01-zzzz', query: 'test', resultDigest: 'test', urls: [] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
  });

  it('coach_log_nudge returns INVALID_ITEM_ID when itemId is empty string', async () => {
    const ctx = makeCtx({ nudges: 0, writes: 0 });
    const result = await coachLogNudge.execute(
      { itemId: '', intensity: 'gentle', nudgeText: 'hi' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ITEM_ID');
  });
});

// ---------------------------------------------------------------------------
// coach_read_history validation
// ---------------------------------------------------------------------------

describe('coach_read_history validation', () => {
  it('invalid eventType returns INVALID_EVENT_TYPE', async () => {
    const ctx = makeCtx(undefined);
    const result = await coachReadHistory.execute(
      // @ts-expect-error intentionally passing invalid eventType
      { itemId, eventType: 'bogusType', limit: 5 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_EVENT_TYPE');
  });

  it('returns empty result for item with no history', async () => {
    const ctx = makeCtx(undefined);
    const result = await coachReadHistory.execute({ itemId, limit: 5 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No coach history');
  });
});
