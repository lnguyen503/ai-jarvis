/**
 * Integration tests for calendar sync audit emission (v1.19.0 fix-loop).
 *
 * Covers Item 2 of the cross-review CRIT cluster:
 *   Each sync code path must produce exactly the expected audit row category
 *   + shape via memory.auditLog.insert(...). Previously the index.ts shims
 *   were log-only — audit viewer returned empty for ?categories=calendar.*.
 *
 * Test IDs:
 *   T-AE-1  — auditSuccess to_event   → calendar.sync_success row + shape
 *   T-AE-2  — auditSuccess from_event → calendar.sync_success row + shape
 *   T-AE-3  — auditFailure            → calendar.sync_failure row + truncated errorCode
 *   T-AE-4  — auditSkip               → calendar.sync_skipped row + reason
 *   T-AE-5  — auditRejectedInjection  → calendar.sync_rejected_injection row
 *   T-AE-6  — auditTruncated          → calendar.sync_truncated row + lengths
 *   T-AE-7  — privacy: detail JSON has NO content fields (no title/notes/value/body)
 *   T-AE-8  — listForUserPaginated by 'calendar.*' returns all 5 categories together
 *
 * Approach: instantiate buildSyncAuditShims directly with a real AuditLogRepo
 * on a fresh in-memory SQLite DB (via initMemory + makeTestConfig). This is
 * the same factory used in src/index.ts, so what we assert here is what ships.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

import { buildSyncAuditShims } from '../../src/calendar/syncAuditShims.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AuditLogRepo, AuditCategory } from '../../src/memory/auditLog.js';
import { KNOWN_AUDIT_CATEGORIES } from '../../src/memory/auditLog.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';
import { child } from '../../src/logger/index.js';

const USER_ID = 600_001;

let auditLog: AuditLogRepo;
let cfg: AppConfig;
let memoryClose: () => void;
let shims: ReturnType<typeof buildSyncAuditShims>;

beforeEach(() => {
  _resetDb();
  cfg = makeTestConfig();
  void path; // keep import used (placate unused-import in some configs)
  const memory = initMemory(cfg);
  auditLog = memory.auditLog;
  memoryClose = () => memory.close();
  shims = buildSyncAuditShims(child({ component: 'test' }), auditLog);
});

afterEach(() => {
  if (memoryClose) memoryClose();
  if (cfg) cleanupTmpRoot(cfg);
});

// ---------------------------------------------------------------------------
// T-AE-1: auditSuccess (forward / to_event)
// ---------------------------------------------------------------------------

describe('T-AE-1: auditSuccess (forward sync, to_event)', () => {
  it('inserts calendar.sync_success row with structural detail shape', () => {
    shims.auditSuccess(USER_ID, '2026-04-25-abcd', 'evt_001', 'to_event', ['title', 'due', 'notes']);

    const rows = auditLog.listByCategory('calendar.sync_success');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(USER_ID);

    const detail = JSON.parse(rows[0]!.detail_json) as Record<string, unknown>;
    expect(detail).toEqual({
      itemId: '2026-04-25-abcd',
      eventId: 'evt_001',
      direction: 'to_event',
      fields: ['title', 'due', 'notes'],
    });
  });
});

// ---------------------------------------------------------------------------
// T-AE-2: auditSuccess (reverse / from_event)
// ---------------------------------------------------------------------------

describe('T-AE-2: auditSuccess (reverse sync, from_event)', () => {
  it('inserts calendar.sync_success row with direction=from_event', () => {
    shims.auditSuccess(USER_ID, '2026-04-25-xyzw', 'evt_002', 'from_event', ['title']);

    const rows = auditLog.listByCategory('calendar.sync_success');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail_json) as { direction: string; fields: string[] };
    expect(detail.direction).toBe('from_event');
    expect(detail.fields).toEqual(['title']);
  });
});

// ---------------------------------------------------------------------------
// T-AE-3: auditFailure
// ---------------------------------------------------------------------------

describe('T-AE-3: auditFailure', () => {
  it('inserts calendar.sync_failure row with truncated errorCode', () => {
    const longError = 'X'.repeat(500); // longer than 200-char cap
    shims.auditFailure(USER_ID, 'item_a', longError);

    const rows = auditLog.listByCategory('calendar.sync_failure');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail_json) as { itemId: string; errorCode: string };
    expect(detail.itemId).toBe('item_a');
    expect(detail.errorCode.length).toBe(200);
    expect(detail.errorCode).toBe('X'.repeat(200));
  });
});

// ---------------------------------------------------------------------------
// T-AE-4: auditSkip
// ---------------------------------------------------------------------------

describe('T-AE-4: auditSkip', () => {
  it('inserts calendar.sync_skipped row with reason', () => {
    shims.auditSkip(USER_ID, 'item_b', 'no_due_date');
    shims.auditSkip(USER_ID, 'item_c', 'circuit_breaker_open');
    shims.auditSkip(USER_ID, 'item_d', 'goal_type');
    shims.auditSkip(USER_ID, 'item_e', 'status_done');
    shims.auditSkip(USER_ID, 'item_f', 'intensity_off');
    shims.auditSkip(USER_ID, 'item_g', 'soft_deleted');

    const rows = auditLog.listByCategory('calendar.sync_skipped');
    expect(rows).toHaveLength(6);

    const reasons = rows
      .map((r) => (JSON.parse(r.detail_json) as { reason: string }).reason)
      .sort();
    expect(reasons).toEqual([
      'circuit_breaker_open',
      'goal_type',
      'intensity_off',
      'no_due_date',
      'soft_deleted',
      'status_done',
    ]);
  });
});

// ---------------------------------------------------------------------------
// T-AE-5: auditRejectedInjection
// ---------------------------------------------------------------------------

describe('T-AE-5: auditRejectedInjection', () => {
  it('inserts calendar.sync_rejected_injection row with markerHit + field', () => {
    shims.auditRejectedInjection(USER_ID, 'item_x', 'evt_x', 'INJECTION_MARKER', 'summary');

    const rows = auditLog.listByCategory('calendar.sync_rejected_injection');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail_json) as Record<string, unknown>;
    expect(detail).toEqual({
      itemId: 'item_x',
      calendarEventId: 'evt_x',
      markerHit: 'INJECTION_MARKER',
      field: 'summary',
    });
  });
});

// ---------------------------------------------------------------------------
// T-AE-6: auditTruncated
// ---------------------------------------------------------------------------

describe('T-AE-6: auditTruncated', () => {
  it('inserts calendar.sync_truncated row with originalLen + truncatedLen', () => {
    shims.auditTruncated(USER_ID, 'item_y', 'evt_y', 'description', 5000, 4096);

    const rows = auditLog.listByCategory('calendar.sync_truncated');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail_json) as Record<string, unknown>;
    expect(detail).toEqual({
      itemId: 'item_y',
      calendarEventId: 'evt_y',
      field: 'description',
      originalLen: 5000,
      truncatedLen: 4096,
    });
  });
});

// ---------------------------------------------------------------------------
// T-AE-7: Privacy posture — no content fields in detail JSON
// ---------------------------------------------------------------------------

describe('T-AE-7: privacy posture — detail carries STRUCTURAL metadata only', () => {
  it('detail JSON for ALL 5 audit categories never contains "title", "notes", "value", or "body" keys', () => {
    // Trigger one row per category
    shims.auditSuccess(USER_ID, 'item_p', 'evt_p', 'to_event', ['title', 'due']);
    shims.auditFailure(USER_ID, 'item_p', 'OAUTH_TOKEN_EXPIRED');
    shims.auditSkip(USER_ID, 'item_p', 'no_due_date');
    shims.auditRejectedInjection(USER_ID, 'item_p', 'evt_p', 'INJECTION_MARKER', 'summary');
    shims.auditTruncated(USER_ID, 'item_p', 'evt_p', 'description', 5000, 4096);

    const allCalendarCategories: AuditCategory[] = [
      'calendar.sync_success',
      'calendar.sync_failure',
      'calendar.sync_skipped',
      'calendar.sync_rejected_injection',
      'calendar.sync_truncated',
    ];

    for (const cat of allCalendarCategories) {
      const rows = auditLog.listByCategory(cat);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
        // Forbidden content keys per privacy posture
        expect(detail).not.toHaveProperty('title');
        expect(detail).not.toHaveProperty('notes');
        expect(detail).not.toHaveProperty('value');
        expect(detail).not.toHaveProperty('body');
        expect(detail).not.toHaveProperty('content');
        expect(detail).not.toHaveProperty('description');
        expect(detail).not.toHaveProperty('summary');
      }
    }
  });

  it('all 5 audit categories used by the shims are in KNOWN_AUDIT_CATEGORIES (closed-set)', () => {
    const used: AuditCategory[] = [
      'calendar.sync_success',
      'calendar.sync_failure',
      'calendar.sync_skipped',
      'calendar.sync_rejected_injection',
      'calendar.sync_truncated',
    ];
    for (const cat of used) {
      expect(KNOWN_AUDIT_CATEGORIES.has(cat)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T-AE-8: Audit viewer query — listForUserPaginated returns all 5 calendar.*
// ---------------------------------------------------------------------------

describe('T-AE-8: audit viewer query (regression for empty calendar.* problem)', () => {
  it('listForUserPaginated by all 5 categories returns the full set', () => {
    shims.auditSuccess(USER_ID, 'item_a', 'evt_a', 'to_event', []);
    shims.auditFailure(USER_ID, 'item_b', 'err');
    shims.auditSkip(USER_ID, 'item_c', 'no_due_date');
    shims.auditRejectedInjection(USER_ID, 'item_d', 'evt_d', 'INJECTION_MARKER', 'summary');
    shims.auditTruncated(USER_ID, 'item_e', 'evt_e', 'description', 100, 50);

    const allCalendarCategories: AuditCategory[] = [
      'calendar.sync_success',
      'calendar.sync_failure',
      'calendar.sync_skipped',
      'calendar.sync_rejected_injection',
      'calendar.sync_truncated',
    ];

    const rows = auditLog.listForUserPaginated({
      actorUserId: USER_ID,
      categories: allCalendarCategories,
      limit: 100,
    });
    expect(rows).toHaveLength(5);
    const cats = rows.map((r) => r.category).sort();
    expect(cats).toEqual([...allCalendarCategories].sort());
  });
});
