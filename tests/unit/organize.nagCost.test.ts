/**
 * Tests for /organize nag cost [days] subcommand (v1.11.0).
 *
 * ADR 006 decisions 7, 8 + R4, R5.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleNagCost,
  TOKEN_COSTS_USD_PER_MTOK,
  TOKEN_COSTS_USD_PER_MTOK_AS_OF,
  computeModelCost,
  type OrganizeCommandDeps,
} from '../../src/commands/organizeNagCost.js';
import type { AppConfig } from '../../src/config/index.js';
import type { MemoryApi } from '../../src/memory/index.js';
import type { AuditLogRow } from '../../src/memory/auditLog.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 99999;

function makeConfig(): AppConfig {
  return {
    organize: {
      reminders: {},
      trashTtlDays: 30,
      trashEvictCron: '0 4 * * *',
      trashEvictWallTimeWarnMs: 600_000,
      trashEvictAuditZeroBatches: false,
      reconcileHotEmitterThreshold: 100,
    },
    memory: { dbPath: './data/test.db', maxHistoryMessages: 50 },
  } as unknown as AppConfig;
}

function makeMemory(nudgeRows: AuditLogRow[] = []): { memory: MemoryApi; auditInserts: unknown[] } {
  const auditInserts: unknown[] = [];
  const memory = {
    auditLog: {
      insert(params: unknown) { auditInserts.push(params); },
      listRecent: vi.fn().mockReturnValue([]),
      listForSession: vi.fn().mockReturnValue([]),
      listByCategoryAndActorSince: vi.fn().mockImplementation(
        (category: string) => {
          if (category === 'organize.nudge') return nudgeRows;
          return [];
        },
      ),
    },
  } as unknown as MemoryApi;
  return { memory, auditInserts };
}

function makeDeps(nudgeRows: AuditLogRow[] = []): { deps: OrganizeCommandDeps; auditInserts: unknown[] } {
  const { memory, auditInserts } = makeMemory(nudgeRows);
  return { deps: { config: makeConfig(), memory }, auditInserts };
}

function makeNudgeRow(
  ts: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  result = 'ok',
  fallbackUsed = false,
): AuditLogRow {
  return {
    id: 1,
    ts,
    category: 'organize.nudge',
    actor_user_id: USER_ID,
    actor_chat_id: USER_ID,
    session_id: null,
    detail_json: JSON.stringify({ result, model, inputTokens, outputTokens, fallbackUsed }),
  };
}

// ---------------------------------------------------------------------------
// Mock ctx factory
// ---------------------------------------------------------------------------

interface MockCtx {
  chat?: { type: string; id: number };
  from?: { id: number };
  replies: string[];
  replyOptions: Array<Record<string, unknown>>;
  reply: (msg: string, opts?: Record<string, unknown>) => Promise<void>;
}

function makeCtx(userId: number = USER_ID): MockCtx {
  const ctx: MockCtx = {
    chat: { type: 'private', id: userId },
    from: { id: userId },
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
// Pricing constant tests
// ---------------------------------------------------------------------------

describe('TOKEN_COSTS_USD_PER_MTOK', () => {
  it('has deepseek-v4-flash:cloud at 0/0', () => {
    expect(TOKEN_COSTS_USD_PER_MTOK['deepseek-v4-flash:cloud']).toEqual({ input: 0, output: 0 });
  });

  it('has claude-haiku-4-5 at $1.00 input / $5.00 output per Mtok', () => {
    expect(TOKEN_COSTS_USD_PER_MTOK['claude-haiku-4-5']).toEqual({ input: 1.00, output: 5.00 });
  });

  it('TOKEN_COSTS_USD_PER_MTOK_AS_OF is a valid YYYY-MM-DD date', () => {
    expect(TOKEN_COSTS_USD_PER_MTOK_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('computeModelCost', () => {
  it('computes correct cost for haiku-4-5: 1000 input + 500 output tokens', () => {
    // 1000 input at $1/Mtok = $0.001; 500 output at $5/Mtok = $0.0025; total $0.0035
    const cost = computeModelCost('claude-haiku-4-5', 1000, 500);
    expect(cost).toBeCloseTo(0.0035, 6);
  });

  it('computes $0.001 for 1000 input tokens at $1/Mtok', () => {
    const cost = computeModelCost('claude-haiku-4-5', 1000, 0);
    expect(cost).toBeCloseTo(0.001, 6);
  });

  it('returns 0 for deepseek-v4-flash:cloud (free)', () => {
    const cost = computeModelCost('deepseek-v4-flash:cloud', 100000, 50000);
    expect(cost).toBe(0);
  });

  it('returns 0 for unknown model', () => {
    const cost = computeModelCost('unknown-model-xyz', 1000, 500);
    expect(cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleNagCost tests
// ---------------------------------------------------------------------------

describe('handleNagCost — 0 audit rows', () => {
  it('replies with "No nudges in the last N days" when no rows', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '', deps);
    expect(ctx.replies[0]).toContain('No nudges in the last 7 days');
    expect(ctx.replies[0]).toContain('nag status');
  });

  it('includes custom day count in empty-state message', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '30', deps);
    expect(ctx.replies[0]).toContain('No nudges in the last 30 days');
  });
});

describe('handleNagCost — argument validation', () => {
  it('days=91 → rejected with usage message', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '91', deps);
    expect(ctx.replies[0]).toContain('Usage: /organize nag cost');
    expect(ctx.replies[0]).toContain('1-90');
  });

  it('days=0 → rejected with usage message', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '0', deps);
    expect(ctx.replies[0]).toContain('Usage: /organize nag cost');
  });

  it('invalid non-numeric arg → rejected with usage message', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, 'abc', deps);
    expect(ctx.replies[0]).toContain('Usage: /organize nag cost');
  });

  it('days=90 → accepted', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '90', deps);
    // Empty rows → "No nudges in the last 90 days"
    expect(ctx.replies[0]).toContain('No nudges in the last 90 days');
  });

  it('days=1 → accepted', async () => {
    const { deps } = makeDeps([]);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '1', deps);
    expect(ctx.replies[0]).toContain('No nudges in the last 1 days');
  });
});

describe('handleNagCost — days=7 per-day table (DeepSeek + Haiku rows)', () => {
  it('renders per-day table with correct cost math and "Prices as of" footer', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'deepseek-v4-flash:cloud', 5000, 500, 'ok', false),
      makeNudgeRow('2026-04-23T11:00:00.000Z', 'claude-haiku-4-5', 1000, 500, 'ok', false),
      makeNudgeRow('2026-04-22T10:00:00.000Z', 'deepseek-v4-flash:cloud', 4000, 400, 'ok', false),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    // Should be a code block
    expect(reply).toContain('```');
    // Should contain deepseek and haiku
    expect(reply).toContain('deepseek-v4-flash:cloud');
    expect(reply).toContain('claude-haiku-4-5');
    // Should contain the "Prices as of" date
    expect(reply).toContain(TOKEN_COSTS_USD_PER_MTOK_AS_OF);
    // DeepSeek should be $0.0000 (free)
    expect(reply).toContain('$0.0000');
    // Haiku: 1000 input × $1/Mtok = $0.001; 500 output × $5/Mtok = $0.0025; total $0.0035
    expect(reply).toContain('$0.0035');
  });

  it('shows total nudge count in output', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'deepseek-v4-flash:cloud', 5000, 500, 'ok'),
      makeNudgeRow('2026-04-23T11:00:00.000Z', 'claude-haiku-4-5', 1000, 500, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('2 nudges'); // total
  });
});

describe('handleNagCost — days=30 summary view (> 14 days)', () => {
  it('renders summary (no per-day breakdown) with "Prices as of" line', async () => {
    const rows = [
      makeNudgeRow('2026-04-01T10:00:00.000Z', 'claude-haiku-4-5', 2000, 1000, 'ok'),
      makeNudgeRow('2026-03-20T10:00:00.000Z', 'deepseek-v4-flash:cloud', 5000, 500, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '30', deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('```');
    expect(reply).toContain('summary');
    expect(reply).toContain(TOKEN_COSTS_USD_PER_MTOK_AS_OF);
    // Should NOT have per-day date lines.
    // (Simple check: the 30-day path says "summary" in the header.)
  });
});

describe('handleNagCost — null token handling', () => {
  it('counts rows with null inputTokens as unknown; excludes from cost', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'claude-haiku-4-5', null, 500, 'ok'),
      makeNudgeRow('2026-04-23T11:00:00.000Z', 'claude-haiku-4-5', 1000, 500, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('unknown token count');
    // Cost should only reflect the row with known tokens.
    // 1000 input × $1/Mtok = $0.001; 500 output × $5/Mtok = $0.0025; total $0.0035
    expect(reply).toContain('$0.0035');
  });

  it('counts rows with null outputTokens as unknown', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'claude-haiku-4-5', 1000, null, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('unknown token count');
  });

  it('all-null tokens still shows nudge count', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'claude-haiku-4-5', null, null, 'ok'),
      makeNudgeRow('2026-04-23T11:00:00.000Z', 'claude-haiku-4-5', null, null, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('2 nudges');
    expect(reply).toContain('unknown token count');
  });
});

describe('handleNagCost — unknown model', () => {
  it('renders "usage unknown — price table missing" for unknown model', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'super-unknown-model', 1000, 500, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('usage unknown — price table missing');
  });
});

describe('handleNagCost — skipped rows (non-ok result)', () => {
  it('counts result!="ok" rows as skipped, not in cost', async () => {
    const rows = [
      makeNudgeRow('2026-04-23T10:00:00.000Z', 'claude-haiku-4-5', 1000, 500, 'failed'),
      makeNudgeRow('2026-04-23T11:00:00.000Z', 'claude-haiku-4-5', 1000, 500, 'ok'),
    ];
    const { deps } = makeDeps(rows);
    const ctx = makeCtx();
    await handleNagCost(ctx as unknown as Parameters<typeof handleNagCost>[0], USER_ID, '7', deps);
    const reply = ctx.replies[0] ?? '';
    // 1 skipped
    expect(reply).toContain('1 skipped');
    // Total nudges should be 1 (only ok rows).
    expect(reply).toContain('1 nudge');
    // Cost should only be from the ok row.
    expect(reply).toContain('$0.0035');
  });
});

describe('handleNagCost — cost arithmetic', () => {
  it('haiku: 1000 input tokens at $1/Mtok → $0.001 (4 decimals)', () => {
    const cost = computeModelCost('claude-haiku-4-5', 1000, 0);
    expect(cost.toFixed(4)).toBe('0.0010');
  });

  it('haiku: 1000000 input tokens at $1/Mtok → $1.0000', () => {
    const cost = computeModelCost('claude-haiku-4-5', 1_000_000, 0);
    expect(cost.toFixed(4)).toBe('1.0000');
  });

  it('haiku: 500 output tokens at $5/Mtok → $0.0025', () => {
    const cost = computeModelCost('claude-haiku-4-5', 0, 500);
    expect(cost.toFixed(4)).toBe('0.0025');
  });
});
