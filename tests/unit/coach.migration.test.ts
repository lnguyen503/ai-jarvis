/**
 * Unit tests: migrateLegacyCoachTasks() — coach/migration.ts (v1.20.0 commit 4).
 *
 * T-R3-1 — Migration with single legacy row → UPDATE; audit coach.migration_completed.
 * T-R3-2 — Migration with no legacy rows → no-op; no audit emitted.
 * T-R3-3 — Migration with both __coach__ AND __coach_morning__ →
 *           DELETE legacy; audit coach.migration_conflict;
 *           second migration call is now no-op.
 * T-R3-5 — Idempotency: 2nd invocation finds zero rows; emits no audit.
 * Additional: verify scheduler dispatch marker (isCoachMarker after migration).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { migrateLegacyCoachTasks } from '../../src/coach/migration.js';
import { isCoachMarker } from '../../src/coach/index.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 84001;
const CHAT_ID = 84001;

const LEGACY_MARKER = '__coach__';
const MORNING_MARKER = '__coach_morning__';

function makeLegacyTask(memory: MemoryApi) {
  return memory.scheduledTasks.insert({
    description: LEGACY_MARKER,
    cron_expression: '0 8 * * *',
    command: '/coach run',
    chat_id: CHAT_ID,
    owner_user_id: USER_ID,
  });
}

function makeMorningTask(memory: MemoryApi) {
  return memory.scheduledTasks.insert({
    description: MORNING_MARKER,
    cron_expression: '0 9 * * *',
    command: '/coach run',
    chat_id: CHAT_ID,
    owner_user_id: USER_ID,
  });
}

let mem: MemoryApi;
let dataDir: string;

beforeEach(() => {
  _resetDb();
  dataDir = mkdtempSync(path.join(os.tmpdir(), `jarvis-coach-migration-${Date.now()}-`));
  mkdirSync(path.join(dataDir, 'memories'), { recursive: true });

  const dbPath = path.join(dataDir, 'test.db');
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  mem = initMemory(cfg);
});

afterEach(() => {
  mem.close();
  _resetDb();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// T-R3-1: single legacy row → UPDATE; audit migration_completed
// ---------------------------------------------------------------------------

describe('T-R3-1: single legacy row', () => {
  it('updates description to __coach_morning__ and audits migration_completed', () => {
    const taskId = makeLegacyTask(mem);

    const result = migrateLegacyCoachTasks(mem);

    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.conflict).toBe(0);

    // Row should now have morning marker
    const task = mem.scheduledTasks.get(taskId);
    expect(task).not.toBeNull();
    expect(task!.description).toBe(MORNING_MARKER);

    // isCoachMarker should return true for the migrated description
    expect(isCoachMarker(task!.description)).toBe(true);

    // Audit row should exist
    const rows = mem.auditLog.listRecent(10);
    const auditRow = rows.find(r => r.category === 'coach.migration_completed');
    expect(auditRow).toBeTruthy();
    expect(auditRow!.actor_user_id).toBe(USER_ID);
    const detail = JSON.parse(auditRow!.detail_json) as Record<string, unknown>;
    expect(detail['taskId']).toBe(taskId);
    expect(detail['fromDescription']).toBe(LEGACY_MARKER);
    expect(detail['toDescription']).toBe(MORNING_MARKER);
    expect(detail['action']).toBe('completed');
  });

  it('cron expression is preserved after migration', () => {
    const taskId = makeLegacyTask(mem);
    migrateLegacyCoachTasks(mem);
    const task = mem.scheduledTasks.get(taskId);
    expect(task!.cron_expression).toBe('0 8 * * *');
  });
});

// ---------------------------------------------------------------------------
// T-R3-2: no legacy rows → no-op
// ---------------------------------------------------------------------------

describe('T-R3-2: no legacy rows', () => {
  it('returns zeros and emits no audit rows when no legacy tasks exist', () => {
    const result = migrateLegacyCoachTasks(mem);

    expect(result.completed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.conflict).toBe(0);

    const rows = mem.auditLog.listRecent(10);
    const migrationRows = rows.filter(r =>
      r.category === 'coach.migration_completed' ||
      r.category === 'coach.migration_skipped' ||
      r.category === 'coach.migration_conflict',
    );
    expect(migrationRows).toHaveLength(0);
  });

  it('non-legacy tasks are not affected', () => {
    const morningId = makeMorningTask(mem);
    const result = migrateLegacyCoachTasks(mem);

    expect(result.completed).toBe(0);
    // Morning task still exists and untouched
    const task = mem.scheduledTasks.get(morningId);
    expect(task!.description).toBe(MORNING_MARKER);
  });
});

// ---------------------------------------------------------------------------
// T-R3-3: both __coach__ AND __coach_morning__ → conflict resolution
// ---------------------------------------------------------------------------

describe('T-R3-3: conflict — both legacy and morning exist', () => {
  it('deletes legacy row, keeps morning row, audits migration_conflict', () => {
    const legacyId = makeLegacyTask(mem);
    const morningId = makeMorningTask(mem);

    const result = migrateLegacyCoachTasks(mem);

    expect(result.completed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.conflict).toBe(1);

    // Legacy row should be deleted
    expect(mem.scheduledTasks.get(legacyId)).toBeNull();
    // Morning row should be preserved
    expect(mem.scheduledTasks.get(morningId)).not.toBeNull();
    expect(mem.scheduledTasks.get(morningId)!.description).toBe(MORNING_MARKER);

    // Audit row
    const rows = mem.auditLog.listRecent(10);
    const auditRow = rows.find(r => r.category === 'coach.migration_conflict');
    expect(auditRow).toBeTruthy();
    expect(auditRow!.actor_user_id).toBe(USER_ID);
    const detail = JSON.parse(auditRow!.detail_json) as Record<string, unknown>;
    expect(detail['droppedTaskId']).toBe(legacyId);
    expect(detail['keptTaskId']).toBe(morningId);
    expect(detail['action']).toBe('conflict_dropped');
  });

  it('second migration call after conflict is a no-op', () => {
    makeLegacyTask(mem);
    makeMorningTask(mem);

    migrateLegacyCoachTasks(mem); // first run: resolves conflict

    // Second run: no legacy rows remain
    const result2 = migrateLegacyCoachTasks(mem);
    expect(result2.completed).toBe(0);
    expect(result2.skipped).toBe(0);
    expect(result2.conflict).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-R3-5: idempotency — second call finds no rows
// ---------------------------------------------------------------------------

describe('T-R3-5: idempotency', () => {
  it('second call after successful migration returns zeros', () => {
    makeLegacyTask(mem);

    const first = migrateLegacyCoachTasks(mem);
    expect(first.completed).toBe(1);

    const second = migrateLegacyCoachTasks(mem);
    expect(second.completed).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.conflict).toBe(0);
  });

  it('idempotent re-run emits no new audit rows', () => {
    makeLegacyTask(mem);
    migrateLegacyCoachTasks(mem);

    const rowsBefore = mem.auditLog.listRecent(100).length;
    migrateLegacyCoachTasks(mem);
    const rowsAfter = mem.auditLog.listRecent(100).length;

    expect(rowsAfter).toBe(rowsBefore); // no new audit rows
  });
});

// ---------------------------------------------------------------------------
// Multi-user: each user migrated independently
// ---------------------------------------------------------------------------

describe('multi-user migration', () => {
  it('each user migrated independently', () => {
    const USER_2 = 84002;

    mem.scheduledTasks.insert({
      description: LEGACY_MARKER,
      cron_expression: '0 8 * * *',
      command: '/coach run',
      chat_id: CHAT_ID,
      owner_user_id: USER_ID,
    });
    mem.scheduledTasks.insert({
      description: LEGACY_MARKER,
      cron_expression: '0 9 * * *',
      command: '/coach run',
      chat_id: 84002,
      owner_user_id: USER_2,
    });

    const result = migrateLegacyCoachTasks(mem);
    expect(result.completed).toBe(2);
    expect(result.conflict).toBe(0);

    const allTasks = mem.scheduledTasks.listAll();
    for (const t of allTasks) {
      expect(t.description).toBe(MORNING_MARKER);
    }
  });
});
