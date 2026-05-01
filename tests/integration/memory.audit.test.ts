/**
 * Integration tests for the AuditLogRepo and audit_log migrations (v1.14.2).
 *
 * Covers:
 *   - Basic insert / listRecent
 *   - insertReturningId + updateDetail (used by webapp.auth_failure debouncer)
 *   - listByCategoryAndActorSince (uses idx_audit_category_actor_ts from 010)
 *   - listByCategory (new helper added in v1.14.2 for test assertions)
 *   - webapp.item_mutate row shape coverage (v1.14.2 new category)
 *   - webapp.stale_edit row shape coverage (v1.14.2 R2-mtime category)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

let mem: MemoryApi;
let tmpDir: string;

function makeConfig(dbPath: string) {
  return {
    telegram: { allowedUserIds: [], botToken: 'test-token' },
    ai: {
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      defaultProvider: 'claude',
      defaultModel: 'claude-sonnet-4-6',
      premiumProvider: 'claude',
      premiumModel: 'claude-sonnet-4-6',
      judgeModel: 'claude-opus-4-6',
      maxTokens: 4096,
      temperature: 0.3,
      maxToolIterations: 10,
      streamingEnabled: false,
      streamingEditIntervalMs: 150,
      streamingCursor: '▍',
      providers: { claude: {}, 'ollama-cloud': {} },
      routing: { enabled: false, fallbackToClaudeOnError: false, logRoutingDecisions: false },
    },
    whisper: { model: 'whisper-1', apiBaseUrl: 'https://api.openai.com/v1' },
    health: { port: 7878 },
    chat: { userQueueMax: 5, schedulerQueueMax: 20, maxQueueAgeMs: 600000 },
    safety: {
      confirmationTtlMs: 300000,
      commandTimeoutMs: 120000,
      maxOutputLength: 4000,
      allowEncodedCommands: false,
      blockedCommands: [],
    },
    filesystem: { allowedPaths: [tmpDir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(tmpDir, 'workspaces') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath, maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: { enabled: false, headless: true, pageTimeoutMs: 15000, maxContentChars: 100000, denyHosts: [], userAgent: '' },
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(tmpDir, 'google-tokens.json') },
      calendar: { enabled: false, defaultCalendarId: 'primary' },
      gmail: {
        enabled: false,
        maxResults: 10,
        send: { enabled: false, confirmationTtlSeconds: 300, rateLimitPerHour: 10, maxRecipientsPerSend: 20, requireReplyToThread: false },
      },
    },
    groups: {
      enabled: false,
      allowedGroupIds: [],
      adminUserIds: [],
      developerUserIds: [],
      groupRoles: {},
      rateLimitPerUser: 10,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: [],
      intentDetection: { enabled: false, provider: 'ollama-cloud', model: 'gemma4:cloud', followUpWindowSeconds: 120, confirmationTtlSeconds: 120, rateLimitPerMinute: 30, recentMessageContext: 4 },
    },
    context: { autoCompact: false, compactThreshold: 0.75, summarizePrompt: 'Summarize', notifyUser: false },
    aliases: {},
    organize: {
      reminders: {
        enabled: false,
        cronExpression: '0 8 * * *',
        minActiveItemsForOptIn: 3,
        dailyCap: 3,
        itemCooldownMinutes: 4320,
        muteAfterConsecutiveIgnores: 3,
        quietHoursLocal: [],
        triage: {
          enabled: false,
          maxItemsPerTriage: 50,
          triageProvider: 'ollama-cloud',
          triageModel: 'deepseek-v4-flash:cloud',
          fallbackProvider: 'claude',
          fallbackModel: 'claude-haiku-4-5',
          triageTimeoutMs: 120000,
          haikuFallbackMaxPerDay: 20,
          globalHaikuFallbackMaxPerDay: 500,
          tickConcurrency: 5,
          wallTimeWarnRatio: 0.75,
        },
      },
      trashTtlDays: 30,
      trashEvictCron: '0 4 * * *',
      trashEvictWallTimeWarnMs: 600000,
      trashEvictAuditZeroBatches: false,
      reconcileHotEmitterThreshold: 100,
    },
    projects: [],
    debate: { panelStateCacheMax: 50, panelStateTtlHours: 24 },
    webapp: {
      publicUrl: 'https://example.com',
      staticDir: 'public/webapp',
      port: 17900,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  };
}

beforeEach(() => {
  _resetDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-test-'));
  const dbPath = path.join(tmpDir, 'jarvis.db');
  mem = initMemory(makeConfig(dbPath));
});

afterEach(() => {
  mem.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Basic insert / listRecent
// ---------------------------------------------------------------------------

describe('AuditLogRepo — basic insert/listRecent', () => {
  it('A-1: insert + listRecent returns the row', () => {
    mem.auditLog.insert({
      category: 'tool_call',
      actor_user_id: 1,
      detail: { tool: 'test_tool' },
    });
    const rows = mem.auditLog.listRecent(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.category).toBe('tool_call');
    const detail = JSON.parse(row.detail_json) as { tool: string };
    expect(detail.tool).toBe('test_tool');
  });

  it('A-2: insertReturningId returns a numeric id', () => {
    const id = mem.auditLog.insertReturningId({
      category: 'webapp.auth_failure',
      detail: { ip: '1.2.3.x', reason: 'bad-hash', suppressedCount: 1, suppressedSince: '', pathHit: '/api/webapp/items', userAgentHash: 'abc' },
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('A-3: updateDetail modifies an existing row', () => {
    const id = mem.auditLog.insertReturningId({
      category: 'webapp.auth_failure',
      detail: { ip: '1.2.3.x', reason: 'bad-hash', suppressedCount: 1, suppressedSince: '', pathHit: '/', userAgentHash: '' },
    });
    mem.auditLog.updateDetail(id, { ip: '1.2.3.x', reason: 'bad-hash', suppressedCount: 3, suppressedSince: '', pathHit: '/', userAgentHash: '' });

    const rows = mem.auditLog.listRecent(5);
    const updated = rows.find((r) => r.id === id);
    expect(updated).toBeDefined();
    const detail = JSON.parse(updated!.detail_json) as { suppressedCount: number };
    expect(detail.suppressedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listByCategoryAndActorSince
// ---------------------------------------------------------------------------

describe('AuditLogRepo — listByCategoryAndActorSince', () => {
  it('A-4: returns only rows matching category + actor + since', () => {
    // Use SQLite datetime format (no T, no Z, no ms) to match the ts column
    // which uses datetime('now') producing 'YYYY-MM-DD HH:MM:SS'
    const now = new Date();
    const pastDate = new Date(now.getTime() - 60000);
    const since = pastDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

    mem.auditLog.insert({
      category: 'organize.create',
      actor_user_id: 42,
      detail: { itemId: 'abc' },
    });
    mem.auditLog.insert({
      category: 'organize.create',
      actor_user_id: 99, // different actor
      detail: { itemId: 'xyz' },
    });
    mem.auditLog.insert({
      category: 'organize.delete',
      actor_user_id: 42, // different category
      detail: { itemId: 'def' },
    });

    const rows = mem.auditLog.listByCategoryAndActorSince('organize.create', 42, since);
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail_json) as { itemId: string };
    expect(detail.itemId).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// listByCategory (new helper v1.14.2)
// ---------------------------------------------------------------------------

describe('AuditLogRepo — listByCategory', () => {
  it('A-5: returns all rows for a category regardless of actor', () => {
    mem.auditLog.insert({ category: 'webapp.item_mutate', actor_user_id: 1, detail: { action: 'update', itemId: 'a', changedFields: ['title'] } });
    mem.auditLog.insert({ category: 'webapp.item_mutate', actor_user_id: 2, detail: { action: 'delete', itemId: 'b', changedFields: [] } });
    mem.auditLog.insert({ category: 'tool_call', actor_user_id: 1, detail: { tool: 'other' } });

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.category === 'webapp.item_mutate')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// webapp.item_mutate row shape coverage (v1.14.2)
// ---------------------------------------------------------------------------

describe('AuditLogRepo — webapp.item_mutate row shape (v1.14.2)', () => {
  it('A-6: webapp.item_mutate row stores action + itemId + changedFields', () => {
    mem.auditLog.insert({
      category: 'webapp.item_mutate',
      actor_user_id: 111111,
      detail: {
        action: 'update',
        itemId: '2026-04-24-abcd',
        changedFields: ['title', 'due'],
        ip: '127.0.0.x',
      },
    });

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const detail = JSON.parse(rows[0].detail_json) as {
      action: string;
      itemId: string;
      changedFields: string[];
      ip?: string;
    };
    expect(detail.action).toBe('update');
    expect(detail.itemId).toBe('2026-04-24-abcd');
    expect(detail.changedFields).toEqual(['title', 'due']);
    expect(detail.ip).toBe('127.0.0.x');
  });

  it('A-7: webapp.item_mutate delete row has empty changedFields', () => {
    mem.auditLog.insert({
      category: 'webapp.item_mutate',
      actor_user_id: 111111,
      detail: { action: 'delete', itemId: '2026-04-24-efgh', changedFields: [] },
    });

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const detail = JSON.parse(rows[0].detail_json) as { action: string; changedFields: string[] };
    expect(detail.action).toBe('delete');
    expect(detail.changedFields).toHaveLength(0);
  });

  it('A-8: webapp.item_mutate complete row has action "complete" + changedFields ["status"]', () => {
    mem.auditLog.insert({
      category: 'webapp.item_mutate',
      actor_user_id: 111111,
      detail: { action: 'complete', itemId: '2026-04-24-ijkl', changedFields: ['status'] },
    });

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const detail = JSON.parse(rows[0].detail_json) as { action: string; changedFields: string[] };
    expect(detail.action).toBe('complete');
    expect(detail.changedFields).toEqual(['status']);
  });

  it('A-9: webapp.item_mutate uncomplete row has action "uncomplete" + changedFields ["status"]', () => {
    mem.auditLog.insert({
      category: 'webapp.item_mutate',
      actor_user_id: 111111,
      detail: { action: 'uncomplete', itemId: '2026-04-24-mnop', changedFields: ['status'] },
    });

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const detail = JSON.parse(rows[0].detail_json) as { action: string; changedFields: string[] };
    expect(detail.action).toBe('uncomplete');
  });
});

// ---------------------------------------------------------------------------
// webapp.stale_edit row shape coverage (v1.14.2 R2-mtime)
// ---------------------------------------------------------------------------

describe('AuditLogRepo — webapp.stale_edit row shape (v1.14.2 R2-mtime)', () => {
  it('A-10: webapp.stale_edit row stores itemId + capturedMtimeMs + currentMtimeMs + action', () => {
    mem.auditLog.insert({
      category: 'webapp.stale_edit',
      actor_user_id: 111111,
      detail: {
        itemId: '2026-04-24-qrst',
        capturedMtimeMs: 1000,
        currentMtimeMs: 2000,
        action: 'patch',
        ip: '127.0.0.x',
      },
    });

    const rows = mem.auditLog.listByCategory('webapp.stale_edit');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const detail = JSON.parse(rows[0].detail_json) as {
      itemId: string;
      capturedMtimeMs: number;
      currentMtimeMs: number;
      action: string;
    };
    expect(detail.itemId).toBe('2026-04-24-qrst');
    expect(detail.capturedMtimeMs).toBe(1000);
    expect(detail.currentMtimeMs).toBe(2000);
    expect(detail.action).toBe('patch');
  });
});
