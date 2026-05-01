/**
 * Integration tests for src/coach/triggerFiring.ts (v1.20.0 ADR 020 D7).
 *
 * Tests cover: all rate-limit branches (suppress/fire), audit shape,
 * delayMs respected, post-delay quiet-mode re-check.
 *
 * ~20 cases per ADR 020 commit 6 spec.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dispatchTrigger,
  buildTriggerReason,
  TRIGGER_REASONS,
  type TriggerRecord,
  type TriggerFireDeps,
} from '../../src/coach/triggerFiring.js';
import {
  recordPerItemFire,
  recordGlobalDailyFire,
  setQuietMode,
  recordUserMessage,
  recordCoachDM,
  GLOBAL_DAILY_CAP,
} from '../../src/coach/rateLimits.js';

// ---------------------------------------------------------------------------
// Mock AuditLogRepo
// ---------------------------------------------------------------------------

interface AuditCall {
  category: string;
  detail: Record<string, unknown>;
}

function makeAuditMock(): { insert: (p: { category: string; actor_user_id?: number | null; detail: Record<string, unknown> }) => void; calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  return {
    calls,
    insert(p) {
      calls.push({ category: p.category, detail: p.detail });
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let dataDir: string;
const USER_ID = 99;
const ITEM_ID = '2026-04-25-test';

function makeTrigger(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    userId: USER_ID,
    itemId: ITEM_ID,
    kind: 'item-state',
    triggerType: 'due-in-24h-no-progress',
    reason: buildTriggerReason('due-in-24h-no-progress'),
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-triggerfiring-'));
  dataDir = tmpDir;
  vi.useFakeTimers();
});

function cleanup(): void {
  vi.useRealTimers();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeDeps(fireFn?: () => Promise<void>): TriggerFireDeps & { auditMock: ReturnType<typeof makeAuditMock> } {
  const auditMock = makeAuditMock();
  return {
    dataDir,
    auditLog: auditMock as unknown as import('../../src/memory/auditLog.js').AuditLogRepo,
    fireSpontaneousCoachTurn: fireFn ?? (async () => undefined),
    auditMock,
  };
}

// ---------------------------------------------------------------------------
// TRIGGER_REASONS closed set
// ---------------------------------------------------------------------------

describe('TRIGGER_REASONS closed set', () => {
  it('has exactly 10 entries', () => {
    expect(TRIGGER_REASONS.length).toBe(10);
  });

  it('buildTriggerReason returns a value from TRIGGER_REASONS', () => {
    const reason = buildTriggerReason('commitment');
    expect(TRIGGER_REASONS).toContain(reason);
    expect(reason).toBe('commitment_language');
  });
});

// ---------------------------------------------------------------------------
// dispatchTrigger — happy path
// ---------------------------------------------------------------------------

describe('dispatchTrigger — fire path', () => {
  it('fires when no rate limits are active', async () => {
    const deps = makeDeps();
    vi.useRealTimers();
    const result = await dispatchTrigger(deps, makeTrigger());
    expect(result.fired).toBe(true);
    cleanup();
  });

  it('emits coach.event_trigger.fired audit on success', async () => {
    const deps = makeDeps();
    vi.useRealTimers();
    await dispatchTrigger(deps, makeTrigger());
    const firedAudit = deps.auditMock.calls.find((c) => c.category === 'coach.event_trigger.fired');
    expect(firedAudit).toBeDefined();
    expect(firedAudit!.detail.itemId).toBe(ITEM_ID);
    expect(firedAudit!.detail.kind).toBe('item-state');
    cleanup();
  });

  it('fired audit never includes user content', async () => {
    const deps = makeDeps();
    vi.useRealTimers();
    const trigger = makeTrigger({ triggerContext: 'some structural metadata' });
    await dispatchTrigger(deps, trigger);
    const firedAudit = deps.auditMock.calls.find((c) => c.category === 'coach.event_trigger.fired');
    // triggerContext must NOT appear in audit detail
    expect(JSON.stringify(firedAudit!.detail)).not.toContain('some structural metadata');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// dispatchTrigger — suppression paths
// ---------------------------------------------------------------------------

describe('dispatchTrigger — per-item rate limit suppression', () => {
  it('suppresses when item was fired < 4h ago', async () => {
    vi.useRealTimers();
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID);
    const deps = makeDeps();
    const result = await dispatchTrigger(deps, makeTrigger());
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('PER_ITEM_BACKOFF');
    cleanup();
  });

  it('emits suppressed audit with suppressionReason=PER_ITEM_BACKOFF', async () => {
    vi.useRealTimers();
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID);
    const deps = makeDeps();
    await dispatchTrigger(deps, makeTrigger());
    const suppAudit = deps.auditMock.calls.find((c) => c.category === 'coach.event_trigger.suppressed');
    expect(suppAudit).toBeDefined();
    expect(suppAudit!.detail.suppressionReason).toBe('PER_ITEM_BACKOFF');
    cleanup();
  });
});

describe('dispatchTrigger — global daily cap suppression', () => {
  it('suppresses after global daily cap reached', async () => {
    vi.useRealTimers();
    const dayIso = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let i = 0; i < GLOBAL_DAILY_CAP; i++) {
      await recordGlobalDailyFire(USER_ID, dataDir, dayIso);
    }
    const deps = makeDeps();
    const result = await dispatchTrigger(deps, makeTrigger());
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('GLOBAL_DAILY_CAP');
    cleanup();
  });
});

describe('dispatchTrigger — quiet mode suppression', () => {
  it('suppresses when quiet mode is active', async () => {
    vi.useRealTimers();
    const futureIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await setQuietMode(USER_ID, dataDir, futureIso);
    const deps = makeDeps();
    const result = await dispatchTrigger(deps, makeTrigger());
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('QUIET_ACTIVE');
    cleanup();
  });
});

describe('dispatchTrigger — user message debounce suppression', () => {
  it('suppresses when last user message < 60s ago', async () => {
    vi.useRealTimers();
    await recordUserMessage(USER_ID, dataDir);
    const deps = makeDeps();
    const result = await dispatchTrigger(deps, makeTrigger());
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('USER_MESSAGE_DEBOUNCE');
    cleanup();
  });
});

describe('dispatchTrigger — coach DM cooldown suppression', () => {
  it('suppresses when last coach DM < 30min ago', async () => {
    vi.useRealTimers();
    await recordCoachDM(USER_ID, dataDir);
    const deps = makeDeps();
    const result = await dispatchTrigger(deps, makeTrigger());
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('COACH_DM_COOLDOWN');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// dispatchTrigger — delayMs respected (R5)
// ---------------------------------------------------------------------------

describe('dispatchTrigger — delayMs option (R5)', () => {
  it('fires after delay when delayMs is provided', async () => {
    let fired = false;
    const deps = makeDeps(async () => { fired = true; });
    // Use real timers for this test
    vi.useRealTimers();
    const promise = dispatchTrigger(deps, makeTrigger(), { delayMs: 50 });
    // Wait for it
    await promise;
    expect(fired).toBe(true);
    cleanup();
  });

  it('quiet mode invoked during delay window suppresses trigger (R5)', async () => {
    vi.useRealTimers();
    // Dispatch with a delay
    const deps = makeDeps();
    const dispatchPromise = dispatchTrigger(deps, makeTrigger(), { delayMs: 100 });

    // Set quiet mode DURING the delay window
    const futureIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await setQuietMode(USER_ID, dataDir, futureIso);

    const result = await dispatchPromise;
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('QUIET_ACTIVE');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// suppressed audit shape
// ---------------------------------------------------------------------------

describe('suppressed audit shape', () => {
  it('suppressed audit has required structural fields (no user content)', async () => {
    vi.useRealTimers();
    await recordPerItemFire(USER_ID, dataDir, ITEM_ID);
    const deps = makeDeps();
    const trigger = makeTrigger({ kind: 'chat', triggerType: 'commitment', reason: 'commitment_language', fromMessageHash: 'deadbeef' });
    await dispatchTrigger(deps, trigger);

    const suppAudit = deps.auditMock.calls.find((c) => c.category === 'coach.event_trigger.suppressed');
    expect(suppAudit).toBeDefined();
    // Must have structural fields
    expect(suppAudit!.detail.kind).toBe('chat');
    expect(suppAudit!.detail.triggerType).toBe('commitment');
    expect(suppAudit!.detail.reason).toBe('commitment_language');
    expect(suppAudit!.detail.suppressionReason).toBe('PER_ITEM_BACKOFF');
    // fromMessageHash is allowed (hash, not message body)
    // title/notes/message MUST NOT be present
    const detailStr = JSON.stringify(suppAudit!.detail);
    expect(detailStr).not.toContain('title');
    expect(detailStr).not.toContain('notes');
    cleanup();
  });
});
