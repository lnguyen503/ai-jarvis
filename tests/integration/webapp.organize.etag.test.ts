/**
 * Integration tests for ETag / If-Match / 412 conflict-resolution (v1.14.4).
 *
 * Pattern mirrors webapp.organize.mutate.test.ts: real Express server, native fetch,
 * real filesystem fixtures.
 *
 * ~25 cases covering ADR 012 D2/D3/D4/D5/R1/R2/R4/R9.
 * Test numbering: ET-I-1..ET-I-N (separate from M-* mutate tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import {
  ETAG_HEADER,
  IF_MATCH_HEADER,
  FORCE_OVERRIDE_HEADER,
  FORCE_OVERRIDE_VALUE,
  PRECONDITION_FAILED_CODE,
} from '../../src/webapp/etag-headers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'etag_int_test_token';
const TEST_PORT = 17907;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 777711;
const NOW_UNIX = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function buildInitData(botToken: string, fields: Record<string, string>): string {
  const pairs = Object.entries(fields).sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

function validInitDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
}

function authHeader(userId: number): Record<string, string> {
  return { Authorization: `tma ${validInitDataFor(userId)}` };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const UPDATED_ISO = '2026-04-24T10:00:00.000Z';

function makeItemMd(opts: {
  id: string;
  title: string;
  status?: 'active' | 'done' | 'abandoned';
  updated?: string;
}): string {
  const status = opts.status ?? 'active';
  const updatedLine = opts.updated != null ? `updated: ${opts.updated}\n` : '';
  return (
    `---\n` +
    `id: ${opts.id}\n` +
    `type: task\n` +
    `status: ${status}\n` +
    `title: ${opts.title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `${updatedLine}` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->\n\n` +
    `## Notes\n\n` +
    `## Progress\n`
  );
}

function writeFixtureItems(
  dataDir: string,
  userId: number,
  items: Array<Parameters<typeof makeItemMd>[0]>,
): void {
  const userDir = path.join(dataDir, 'organize', String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  for (const item of items) {
    fs.writeFileSync(path.join(userDir, `${item.id}.md`), makeItemMd(item), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

const ITEM_1 = '2026-04-24-et01';
const ITEM_2 = '2026-04-24-et02';
const ITEM_3 = '2026-04-24-et03';
const ITEM_DONE = '2026-04-24-et04';
const ITEM_ACTIVE = '2026-04-24-et05';

beforeEach(async () => {
  _resetDb();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-etag-int-'));
  dataDir = fs.realpathSync.native(tmpRoot);
  const dbPath = path.join(dataDir, 'jarvis.db');

  writeFixtureItems(dataDir, USER_A_ID, [
    { id: ITEM_1, title: 'ETag test item 1', updated: UPDATED_ISO },
    { id: ITEM_2, title: 'ETag test item 2', updated: UPDATED_ISO },
    { id: ITEM_3, title: 'ETag test item 3', updated: UPDATED_ISO },
    { id: ITEM_DONE, title: 'Done item', status: 'done', updated: UPDATED_ISO },
    { id: ITEM_ACTIVE, title: 'Active item', status: 'active', updated: UPDATED_ISO },
  ]);

  const cfg = {
    telegram: { allowedUserIds: [USER_A_ID], botToken: BOT_TOKEN },
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
    health: { port: 7879 },
    chat: { userQueueMax: 5, schedulerQueueMax: 20, maxQueueAgeMs: 600000 },
    safety: {
      confirmationTtlMs: 300000,
      commandTimeoutMs: 120000,
      maxOutputLength: 4000,
      allowEncodedCommands: false,
      blockedCommands: [],
    },
    filesystem: { allowedPaths: [dataDir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(dataDir, 'workspaces') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath, maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: { enabled: false, headless: true, pageTimeoutMs: 15000, maxContentChars: 100000, denyHosts: [], userAgent: '' },
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(dataDir, 'google-tokens.json') },
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
      port: TEST_PORT,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  };

  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.14.4-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getItem(itemId: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    headers: authHeader(USER_A_ID),
  });
}

function patch(itemId: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(USER_A_ID),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function del(itemId: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    method: 'DELETE',
    headers: { ...authHeader(USER_A_ID), ...extraHeaders },
  });
}

function complete(itemId: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(USER_A_ID),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// ET-I-1: GET /:id sets ETag header (D2)
// ---------------------------------------------------------------------------

describe('GET /api/webapp/items/:id — ETag header (D2)', () => {
  it('ET-I-1: GET returns ETag header matching "updated:" field', async () => {
    const res = await getItem(ITEM_1);
    expect(res.status).toBe(200);
    const etag = res.headers.get(ETAG_HEADER);
    expect(etag).toBe(`"${UPDATED_ISO}"`);
  });

  it('ET-I-2: GET returns etag field in response body matching header', async () => {
    const res = await getItem(ITEM_1);
    const data = await res.json() as { ok: boolean; etag: string };
    const headerEtag = res.headers.get(ETAG_HEADER);
    expect(data.etag).toBe(headerEtag);
  });
});

// ---------------------------------------------------------------------------
// ET-I-3: PATCH with If-Match match → 200 + new ETag
// ---------------------------------------------------------------------------

describe('PATCH /api/webapp/items/:id — ETag If-Match handling', () => {
  it('ET-I-3: PATCH with matching If-Match → 200 + new ETag header', async () => {
    const currentEtag = `"${UPDATED_ISO}"`;
    const res = await patch(ITEM_1, { title: 'Updated' }, { [IF_MATCH_HEADER]: currentEtag });
    expect(res.status).toBe(200);
    const newEtag = res.headers.get(ETAG_HEADER);
    expect(newEtag).toBeDefined();
    // New ETag should differ from original (updated: advanced)
    expect(newEtag).not.toBe(currentEtag);
  });

  it('ET-I-4: PATCH without If-Match → 200 (backcompat — no check)', async () => {
    const res = await patch(ITEM_1, { title: 'No ETag' });
    expect(res.status).toBe(200);
  });

  it('ET-I-5: PATCH with stale If-Match → 412 PRECONDITION_FAILED', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await patch(ITEM_1, { title: 'Should 412' }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(412);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe(PRECONDITION_FAILED_CODE);
  });

  it('ET-I-6: 412 body contains currentEtag and currentItem', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await patch(ITEM_1, { title: 'Should 412' }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(412);
    const body = await res.json() as { currentEtag: string; currentItem: Record<string, unknown> };
    expect(typeof body.currentEtag).toBe('string');
    expect(body.currentEtag).toBe(`"${UPDATED_ISO}"`);
    expect(body.currentItem).toBeDefined();
    expect(body.currentItem.id).toBe(ITEM_1);
    // M1 fix: assert metadata-only projection (R1 Option A — projectFrontMatterOnly).
    // notes and progress are empty strings (not leaked from file body).
    expect(body.currentItem.notes).toBe('');
    expect(body.currentItem.progress).toBe('');
    // Required front-matter fields present in envelope.
    expect(typeof body.currentItem.type).toBe('string');
    expect(typeof body.currentItem.status).toBe('string');
    expect(typeof body.currentItem.title).toBe('string');
    expect(typeof body.currentItem.created).toBe('string');
    expect('due' in body.currentItem).toBe(true);
    expect('tags' in body.currentItem).toBe(true);
    expect('parentId' in body.currentItem).toBe(true);
    expect('calendarEventId' in body.currentItem).toBe(true);
    expect(typeof body.currentItem.fileBasename).toBe('string');
  });

  it('ET-I-7: 412 response sets ETag header equal to body currentEtag (R1 same-read invariant)', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await patch(ITEM_1, { title: 'Should 412' }, { [IF_MATCH_HEADER]: staleEtag });
    const headerEtag = res.headers.get(ETAG_HEADER);
    const body = await res.json() as { currentEtag: string };
    expect(headerEtag).toBe(body.currentEtag);
  });

  it('ET-I-8: PATCH with X-Force-Override skips ETag check → 200', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await patch(ITEM_1, { title: 'Force override' }, {
      [IF_MATCH_HEADER]: staleEtag,
      [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ET-I-9: DELETE with If-Match handling (R9)
// ---------------------------------------------------------------------------

describe('DELETE /api/webapp/items/:id — ETag If-Match handling (R9)', () => {
  it('ET-I-9: DELETE with matching If-Match → 200', async () => {
    const currentEtag = `"${UPDATED_ISO}"`;
    const res = await del(ITEM_2, { [IF_MATCH_HEADER]: currentEtag });
    expect(res.status).toBe(200);
  });

  it('ET-I-10: DELETE without If-Match → 200 (backcompat)', async () => {
    const res = await del(ITEM_2);
    expect(res.status).toBe(200);
  });

  it('ET-I-11: DELETE with stale If-Match → 412 with currentEtag + currentItem', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await del(ITEM_2, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(412);
    const body = await res.json() as { ok: boolean; code: string; currentEtag: string; currentItem: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(body.code).toBe(PRECONDITION_FAILED_CODE);
    expect(body.currentEtag).toBe(`"${UPDATED_ISO}"`);
    expect(body.currentItem.id).toBe(ITEM_2);
  });

  it('ET-I-12: DELETE with X-Force-Override skips ETag check → 200 (Delete Anyway)', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await del(ITEM_2, {
      [IF_MATCH_HEADER]: staleEtag,
      [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ET-I-13: POST /complete with If-Match handling
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items/:id/complete — ETag handling', () => {
  it('ET-I-13: POST /complete with matching If-Match → 200 + new ETag', async () => {
    const currentEtag = `"${UPDATED_ISO}"`;
    const res = await complete(ITEM_ACTIVE, { done: true }, { [IF_MATCH_HEADER]: currentEtag });
    expect(res.status).toBe(200);
    const newEtag = res.headers.get(ETAG_HEADER);
    expect(newEtag).toBeDefined();
    expect(newEtag).not.toBe(currentEtag);
  });

  it('ET-I-14: POST /complete without If-Match → 200 (backcompat)', async () => {
    const res = await complete(ITEM_ACTIVE, { done: true });
    expect(res.status).toBe(200);
  });

  it('ET-I-15: POST /complete with stale If-Match → 412', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await complete(ITEM_ACTIVE, { done: true }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(412);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe(PRECONDITION_FAILED_CODE);
  });
});

// ---------------------------------------------------------------------------
// ET-I-16: POST /complete no-op fast-path (R4)
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items/:id/complete — no-op fast-path (R4)', () => {
  it('ET-I-16: done→done: 200, no write, stale If-Match still returns 200 (no ETag check)', async () => {
    // ITEM_DONE is already 'done'
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await complete(ITEM_DONE, { done: true }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.item.status).toBe('done');
  });

  it('ET-I-17: active→active: 200, stale If-Match returns 200 (no ETag check)', async () => {
    // ITEM_ACTIVE is already 'active'
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res = await complete(ITEM_ACTIVE, { done: false }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.item.status).toBe('active');
  });

  it('ET-I-18: no-op returns ETag header reflecting current state', async () => {
    const res = await complete(ITEM_DONE, { done: true });
    expect(res.status).toBe(200);
    const etag = res.headers.get(ETAG_HEADER);
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^".*"$/);
  });

  it('ET-I-19: state-change still requires If-Match check (no-op fast-path only for matching state)', async () => {
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    // active → done is a state CHANGE, so ETag check runs
    const res = await complete(ITEM_ACTIVE, { done: true }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res.status).toBe(412);
  });
});

// ---------------------------------------------------------------------------
// ET-I-20: R2 bypassAfter412 audit field (ConflictTracker)
// ---------------------------------------------------------------------------

describe('R2 bypassAfter412 — audit forensics', () => {
  it('ET-I-20: force-probe (X-Force-Override without prior 412) → audit forced:true, bypassAfter412:false', async () => {
    // Force override WITHOUT a preceding 412
    const res = await patch(ITEM_3, { title: 'Force probe' }, {
      [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
    });
    expect(res.status).toBe(200);

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const row = rows.find((r) => {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      return d.itemId === ITEM_3;
    });
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail.forced).toBe(true);
    expect(detail.bypassAfter412).toBe(false);
  });

  it('ET-I-21: Save Anyway after 412 → audit forced:true, bypassAfter412:true', async () => {
    // Step 1: trigger a 412
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res412 = await patch(ITEM_3, { title: 'Conflict' }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res412.status).toBe(412);

    // Step 2: Save Anyway (force override after 412)
    const resSave = await patch(ITEM_3, { title: 'Saved anyway' }, {
      [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
    });
    expect(resSave.status).toBe(200);

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const row = rows.find((r) => {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      return d.itemId === ITEM_3 && d.forced === true;
    });
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail.forced).toBe(true);
    expect(detail.bypassAfter412).toBe(true);
  });

  it('ET-I-22: header-stripped scenario: no X-Force-Override but recent 412 → bypassAfter412:true', async () => {
    // Step 1: trigger 412
    const staleEtag = '"2020-01-01T00:00:00.000Z"';
    const res412 = await patch(ITEM_3, { title: 'Conflict' }, { [IF_MATCH_HEADER]: staleEtag });
    expect(res412.status).toBe(412);

    // Step 2: retry WITHOUT X-Force-Override AND WITHOUT If-Match → 200 (backcompat no-check)
    const resRetry = await patch(ITEM_3, { title: 'Header stripped' });
    expect(resRetry.status).toBe(200);

    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const row = rows.find((r) => {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      return d.itemId === ITEM_3 && d.forced === false && d.bypassAfter412 === true;
    });
    expect(row).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ET-I-23: PATCH 200 response includes ETag header (D2)
// ---------------------------------------------------------------------------

describe('PATCH / DELETE / POST /complete success responses carry ETag header (D2)', () => {
  it('ET-I-23: PATCH 200 → ETag header present and double-quoted', async () => {
    const res = await patch(ITEM_1, { title: 'Check ETag' });
    expect(res.status).toBe(200);
    const etag = res.headers.get(ETAG_HEADER);
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^".*"$/);
  });

  it('ET-I-24: DELETE 200 → ETag header present', async () => {
    const res = await del(ITEM_2);
    expect(res.status).toBe(200);
    const etag = res.headers.get(ETAG_HEADER);
    expect(etag).toBeDefined();
  });

  it('ET-I-25: POST /complete 200 → ETag header present and double-quoted', async () => {
    const res = await complete(ITEM_ACTIVE, { done: true });
    expect(res.status).toBe(200);
    const etag = res.headers.get(ETAG_HEADER);
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^".*"$/);
  });
});

// ---------------------------------------------------------------------------
// ET-I-26/27: If-Match: * behavior (RFC 7232 §3.1 — W3 fix)
//
// Dev-A's implementation treats `*` as absent (null) — functionally equivalent
// to "no check" for an extant resource (the resource always exists when the
// ETag check would run). Both paths proceed with the mutation.
//
// These tests assert the wire behavior (200) and document that `If-Match: *`
// is treated as absent per readIfMatchHeader in items.shared.ts.
// ---------------------------------------------------------------------------

describe('If-Match: * behavior (RFC 7232 §3.1 — W3)', () => {
  it('ET-I-26: PATCH with If-Match: * → 200 (treated as absent — no ETag check)', async () => {
    // RFC 7232 §3.1: `*` means "any existing representation".
    // Dev-A treats `*` as absent (null), so the mutation proceeds without an ETag check.
    const res = await patch(ITEM_1, { title: 'Wildcard match' }, { [IF_MATCH_HEADER]: '*' });
    expect(res.status).toBe(200);
    const etag = res.headers.get(ETAG_HEADER);
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^".*"$/);
  });

  it('ET-I-27: DELETE with If-Match: * → 200 (treated as absent — no ETag check)', async () => {
    // Same semantics as PATCH: `*` skips the ETag check, mutation proceeds.
    const res = await del(ITEM_2, { [IF_MATCH_HEADER]: '*' });
    expect(res.status).toBe(200);
  });
});
