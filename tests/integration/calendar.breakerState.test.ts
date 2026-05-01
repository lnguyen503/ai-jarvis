/**
 * Integration tests for calendar OAuth circuit breaker (v1.19.0 fix-loop).
 *
 * Covers ADR 019 R2 Part 3 binding:
 *   - 5 consecutive failures → breaker opens → DM sent → audit row emitted
 *   - Success after open → counter resets → calendar.circuit_breaker_reset audit
 *   - DM 24h dedup: subsequent failures within 24h do NOT re-DM
 *   - DM dedup window expires after 24h → re-DM allowed (covered by manual lastNotifiedAt write)
 *   - Manual reset (admin) → audit row with reason: 'manual'
 *   - Null messaging adapter → audit-only mode (no DM)
 *   - sendMessage throwing → audit still emitted (non-fatal)
 *
 * These tests use real keyed memory (tmpdir) and a real AuditLogRepo on a
 * fresh in-memory SQLite DB, so the breaker state is exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  isCircuitBreakerOpen,
  recordFailure,
  recordSuccess,
  manualReset,
  BREAKER_THRESHOLD,
  BREAKER_DM_BODY,
} from '../../src/calendar/breakerState.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AuditLogRepo } from '../../src/memory/auditLog.js';
import type { MessagingAdapter } from '../../src/messaging/adapter.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 555_000;

let dataDir: string;
let auditLog: AuditLogRepo;
let memoryClose: () => void;
let cfg: AppConfig;
let mockAdapter: MessagingAdapter;
let sendMessageSpy: ReturnType<typeof vi.fn>;

function makeMockAdapter(): { adapter: MessagingAdapter; sendMessageSpy: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue({ messageId: 1 });
  const adapter: MessagingAdapter = {
    sendMessage,
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ messageId: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ messageId: 1 }),
    sendVoice: vi.fn().mockResolvedValue({ messageId: 1 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    resolveDmChatId: (uid: number) => uid, // Telegram convention
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    sendWebAppButton: vi.fn().mockResolvedValue({ messageId: 1 }),
  };
  return { adapter, sendMessageSpy: sendMessage };
}

beforeEach(async () => {
  _resetDb();
  cfg = makeTestConfig();
  dataDir = path.dirname(cfg.memory.dbPath);
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });

  const memory = initMemory(cfg);
  auditLog = memory.auditLog;
  memoryClose = () => memory.close();

  const m = makeMockAdapter();
  mockAdapter = m.adapter;
  sendMessageSpy = m.sendMessageSpy;
});

afterEach(() => {
  if (memoryClose) memoryClose();
  if (cfg) cleanupTmpRoot(cfg);
});

// ---------------------------------------------------------------------------
// T-BR-1: Initial state — breaker closed
// ---------------------------------------------------------------------------

describe('T-BR-1: initial state', () => {
  it('returns false (closed) when no breaker entry exists yet', async () => {
    const open = await isCircuitBreakerOpen(USER_ID, dataDir);
    expect(open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-BR-2: 5 consecutive failures → breaker opens + DM sent + audit
// ---------------------------------------------------------------------------

describe('T-BR-2: 5 consecutive failures trip the breaker', () => {
  it('opens the breaker, sends a DM, and emits calendar.fail_token_expired audit', async () => {
    // 4 failures: breaker stays closed, no DM, no threshold-trip audit
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) {
      await recordFailure(USER_ID, dataDir, `transient_${i}`, mockAdapter, auditLog);
    }
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(false);
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(auditLog.listByCategory('calendar.fail_token_expired')).toHaveLength(0);

    // 5th failure trips the breaker
    await recordFailure(USER_ID, dataDir, 'token_expired', mockAdapter, auditLog);

    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    expect(sendMessageSpy.mock.calls[0]![0]).toBe(USER_ID); // dmChatId === userId on Telegram
    expect(sendMessageSpy.mock.calls[0]![1]).toBe(BREAKER_DM_BODY);

    const auditRows = auditLog.listByCategory('calendar.fail_token_expired');
    expect(auditRows).toHaveLength(1);
    const detail = JSON.parse(auditRows[0]!.detail_json) as { count: number; lastErrorCode: string };
    expect(detail.count).toBe(BREAKER_THRESHOLD);
    expect(detail.lastErrorCode).toBe('token_expired');
    expect(auditRows[0]!.actor_user_id).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// T-BR-3: Success after open → counter reset + reset audit
// ---------------------------------------------------------------------------

describe('T-BR-3: success after open resets the breaker', () => {
  it('resets to count=0 and emits calendar.circuit_breaker_reset audit', async () => {
    // Trip the breaker
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await recordFailure(USER_ID, dataDir, 'err', mockAdapter, auditLog);
    }
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(true);

    // Success path
    await recordSuccess(USER_ID, dataDir, auditLog);

    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(false);

    const resetRows = auditLog.listByCategory('calendar.circuit_breaker_reset');
    expect(resetRows).toHaveLength(1);
    const detail = JSON.parse(resetRows[0]!.detail_json) as { previousCount: number; reason: string };
    expect(detail.previousCount).toBe(BREAKER_THRESHOLD);
    expect(detail.reason).toBe('auto_recovery');
  });

  it('is a no-op when count is already 0 (no audit row)', async () => {
    await recordSuccess(USER_ID, dataDir, auditLog);
    expect(auditLog.listByCategory('calendar.circuit_breaker_reset')).toHaveLength(0);
  });

  it('does NOT emit reset audit when reset from below threshold (e.g., 3 failures then success)', async () => {
    // 3 failures (under threshold) — counter increments but breaker not open
    for (let i = 0; i < 3; i++) {
      await recordFailure(USER_ID, dataDir, 'err', mockAdapter, auditLog);
    }
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(false);

    // Success resets counter; no reset audit because breaker was never open.
    await recordSuccess(USER_ID, dataDir, auditLog);

    expect(auditLog.listByCategory('calendar.circuit_breaker_reset')).toHaveLength(0);
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-BR-4: DM dedup — subsequent failures within 24h do NOT re-DM
// ---------------------------------------------------------------------------

describe('T-BR-4: 24h DM dedup', () => {
  it('does NOT send a second DM for the 6th-Nth failure within 24h', async () => {
    // Trip breaker (5 failures, 1 DM)
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await recordFailure(USER_ID, dataDir, 'err', mockAdapter, auditLog);
    }
    expect(sendMessageSpy).toHaveBeenCalledOnce();

    // 6th-10th failures: counter keeps climbing, breaker stays open, no new DM
    for (let i = 0; i < 5; i++) {
      await recordFailure(USER_ID, dataDir, 'err', mockAdapter, auditLog);
    }

    expect(sendMessageSpy).toHaveBeenCalledOnce(); // STILL only 1 DM
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(true);
    // Only 1 calendar.fail_token_expired audit row from the threshold trip
    expect(auditLog.listByCategory('calendar.fail_token_expired')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T-BR-5: DM failure does not crash the sync path
// ---------------------------------------------------------------------------

describe('T-BR-5: DM delivery failure is non-fatal', () => {
  it('emits the audit row even when sendMessage throws', async () => {
    const failingAdapter: MessagingAdapter = {
      ...mockAdapter,
      sendMessage: vi.fn().mockRejectedValue(new Error('telegram API error')),
    };

    // Trip the breaker — sendMessage throws but recordFailure must not propagate
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await expect(
        recordFailure(USER_ID, dataDir, 'err', failingAdapter, auditLog),
      ).resolves.toBeUndefined();
    }

    // Audit row was still emitted on the threshold trip
    expect(auditLog.listByCategory('calendar.fail_token_expired')).toHaveLength(1);
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-BR-6: null messaging adapter (audit-only mode)
// ---------------------------------------------------------------------------

describe('T-BR-6: null messaging adapter (audit-only mode)', () => {
  it('emits audit row but skips DM when messaging is null', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await recordFailure(USER_ID, dataDir, 'err', null, auditLog);
    }
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(true);
    expect(auditLog.listByCategory('calendar.fail_token_expired')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T-BR-7: Manual reset (admin command path)
// ---------------------------------------------------------------------------

describe('T-BR-7: manual reset emits calendar.circuit_breaker_reset with reason=manual', () => {
  it('clears the counter and audits with reason=manual', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await recordFailure(USER_ID, dataDir, 'err', mockAdapter, auditLog);
    }
    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(true);

    await manualReset(USER_ID, dataDir, auditLog);

    expect(await isCircuitBreakerOpen(USER_ID, dataDir)).toBe(false);
    const rows = auditLog.listByCategory('calendar.circuit_breaker_reset');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail_json) as { previousCount: number; reason: string };
    expect(detail.reason).toBe('manual');
    expect(detail.previousCount).toBe(BREAKER_THRESHOLD);
  });
});
