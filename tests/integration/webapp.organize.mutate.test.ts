/**
 * Integration tests for PATCH/DELETE/POST /api/webapp/items mutation endpoints
 * (v1.14.2).
 *
 * Pattern mirrors webapp.organize.test.ts: real Express server on a dedicated
 * port, native fetch, no supertest. Real filesystem fixtures.
 *
 * Test numbering: M-1..M-N (separate from the 1-22 read-route tests).
 * Covers all cases mandated by ADR 010 + revisions RA1/RA2/R2/R14/R15/R18.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'mutate_int_test_token';
const TEST_PORT = 17903;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 111111;
const USER_B_ID = 222222;
const USER_C_ID = 333333;

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

function validInitDataFor(userId: number, overrides: Record<string, string> = {}): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
    ...overrides,
  });
}

function twoHourStaleInitDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX - 7200),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
}

function authHeader(userId: number): Record<string, string> {
  return { Authorization: `tma ${validInitDataFor(userId)}` };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeItemMd(opts: {
  id: string;
  type: 'task' | 'event' | 'goal';
  status: 'active' | 'done' | 'abandoned';
  title: string;
  tags?: string[];
  due?: string;
  notes?: string;
  progress?: string;
}): string {
  const tags = opts.tags && opts.tags.length > 0 ? `[${opts.tags.join(', ')}]` : '[]';
  const due = opts.due ?? '';
  const notes = opts.notes ?? '';
  const progress = opts.progress ?? '';
  return (
    `---\n` +
    `id: ${opts.id}\n` +
    `type: ${opts.type}\n` +
    `status: ${opts.status}\n` +
    `title: ${opts.title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: ${due}\n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `tags: ${tags}\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->\n\n` +
    `## Notes\n${notes}\n\n` +
    `## Progress\n${progress}\n`
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

const ITEM_ACTIVE = '2026-04-24-m001';
const ITEM_DONE = '2026-04-24-m002';
const ITEM_ABANDONED = '2026-04-24-m003';
const ITEM_WITH_NOTES = '2026-04-24-m004';

beforeEach(async () => {
  _resetDb();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mutate-int-'));
  dataDir = fs.realpathSync.native(tmpRoot);
  const dbPath = path.join(dataDir, 'jarvis.db');

  writeFixtureItems(dataDir, USER_A_ID, [
    { id: ITEM_ACTIVE, type: 'task', status: 'active', title: 'Original title', tags: ['old-tag'], due: '2026-05-01' },
    { id: ITEM_DONE, type: 'task', status: 'done', title: 'Finished task' },
    { id: ITEM_ABANDONED, type: 'task', status: 'abandoned', title: 'Abandoned task' },
    {
      id: ITEM_WITH_NOTES,
      type: 'task',
      status: 'active',
      title: 'Has notes',
      notes: 'Multi-line\nnotes body\nwith preserved newlines',
      progress: '- [2026-04-24T10:00:00.000Z] step 1',
    },
  ]);

  const cfg = {
    telegram: { allowedUserIds: [USER_A_ID, USER_B_ID], botToken: BOT_TOKEN },
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
  server = createWebappServer({ config: cfg, version: '1.14.2-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helper: PATCH request
// ---------------------------------------------------------------------------

function patch(itemId: string, body: unknown, userId = USER_A_ID, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(userId),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function del(itemId: string, userId = USER_A_ID, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    method: 'DELETE',
    headers: { ...authHeader(userId), ...headers },
  });
}

function complete(itemId: string, body: unknown, userId = USER_A_ID, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}/complete`, {
    method: 'POST',
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...authHeader(userId), ...headers }
      : { ...authHeader(userId), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// M-1: PATCH happy path — title update
// ---------------------------------------------------------------------------

describe('PATCH /api/webapp/items/:id — happy path', () => {
  it('M-1: PATCH {title} → 200, item.title updated, other fields unchanged', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'Updated title' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.item.title).toBe('Updated title');
    expect(body.item.status).toBe('active'); // unchanged
    expect(body.item.due).toBe('2026-05-01'); // unchanged
  });

  it('M-2: PATCH {due: "2026-12-31"} → 200, due updated', async () => {
    const res = await patch(ITEM_ACTIVE, { due: '2026-12-31' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item.due).toBe('2026-12-31');
  });

  it('M-3: PATCH {due: null} → 200, due cleared', async () => {
    const res = await patch(ITEM_ACTIVE, { due: null });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item.due).toBeNull();
  });

  it('M-4: PATCH {status: "done"} → 200, status updated', async () => {
    const res = await patch(ITEM_ACTIVE, { status: 'done' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item.status).toBe('done');
  });

  it('M-5: PATCH {tags: ["new-tag"]} → 200, tags replaced', async () => {
    const res = await patch(ITEM_ACTIVE, { tags: ['new-tag'] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item.tags).toEqual(['new-tag']);
  });

  it('M-6: PATCH combined {title, due, status, tags} → 200, all four updated', async () => {
    const res = await patch(ITEM_ACTIVE, {
      title: 'All fields',
      due: '2027-01-01',
      status: 'done',
      tags: ['combined'],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item.title).toBe('All fields');
    expect(body.item.due).toBe('2027-01-01');
    expect(body.item.status).toBe('done');
    expect(body.item.tags).toEqual(['combined']);
  });

  it('M-7: PATCH response includes item shape with notes + progress + fileBasename + mtimeMs', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'Shape check' });
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(typeof body.item.id).toBe('string');
    expect(typeof body.item.fileBasename).toBe('string');
    expect(typeof body.item.mtimeMs).toBe('number');
    expect(typeof body.item.notes).toBe('string');
    expect(typeof body.item.progress).toBe('string');
  });

  it('M-8: PATCH response Cache-Control is no-store', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'Cache check' });
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

// ---------------------------------------------------------------------------
// M-9: PATCH validation matrix — every error code
// ---------------------------------------------------------------------------

describe('PATCH /api/webapp/items/:id — validation (RA1)', () => {
  it('M-9a: empty body {} → 400 + PATCH_NO_VALID_FIELDS', async () => {
    const res = await patch(ITEM_ACTIVE, {});
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('M-9b: only unknown field {calendarEventId: "x"} → 400 + PATCH_NO_VALID_FIELDS', async () => {
    const res = await patch(ITEM_ACTIVE, { calendarEventId: 'x' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('M-9c: known + unknown fields → 400 + PATCH_UNKNOWN_FIELDS (R15 / RA2)', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'ok', calendarEventId: 'bad' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('PATCH_UNKNOWN_FIELDS');
  });

  it('M-9d: {title: ""} → 400 + TITLE_REQUIRED', async () => {
    const res = await patch(ITEM_ACTIVE, { title: '' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TITLE_REQUIRED');
  });

  it('M-9e: {title: " "} whitespace-only → 400 + TITLE_REQUIRED', async () => {
    const res = await patch(ITEM_ACTIVE, { title: '   ' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TITLE_REQUIRED');
  });

  it('M-9f: {title: 501 chars} → 400 + TITLE_TOO_LONG', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'a'.repeat(501) });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TITLE_TOO_LONG');
  });

  it('M-9g: {title: 42} (not a string) → 400 + TITLE_NOT_STRING', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 42 });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TITLE_NOT_STRING');
  });

  it('M-9h: {due: "2026/12/31"} → 400 + DUE_INVALID_FORMAT', async () => {
    const res = await patch(ITEM_ACTIVE, { due: '2026/12/31' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('DUE_INVALID_FORMAT');
  });

  it('M-9i: {status: "archived"} → 400 + STATUS_INVALID', async () => {
    const res = await patch(ITEM_ACTIVE, { status: 'archived' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('STATUS_INVALID');
  });

  it('M-9j: {tags: "not-array"} → 400 + TAGS_NOT_ARRAY', async () => {
    const res = await patch(ITEM_ACTIVE, { tags: 'not-array' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TAGS_NOT_ARRAY');
  });

  it('M-9k: {tags: Array(11).fill("a")} → 400 + TAGS_TOO_MANY', async () => {
    const res = await patch(ITEM_ACTIVE, { tags: Array(11).fill('a') });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TAGS_TOO_MANY');
  });

  it('M-9l: {tags: ["has space"]} → 400 + TAG_INVALID_CHARS', async () => {
    const res = await patch(ITEM_ACTIVE, { tags: ['has space'] });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TAG_INVALID_CHARS');
  });

  it('M-9m: {tags: ["a".repeat(41)]} → 400 + TAG_TOO_LONG', async () => {
    const res = await patch(ITEM_ACTIVE, { tags: ['a'.repeat(41)] });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TAG_TOO_LONG');
  });
});

// ---------------------------------------------------------------------------
// M-10: Unknown field rejection (R15 RA2 regression)
// ---------------------------------------------------------------------------

describe('PATCH — unknown field rejection (RA2 regression)', () => {
  it('M-10a: {calendarEventId: "attacker"} alone → 400 PATCH_NO_VALID_FIELDS (still unknown in v1.14.3)', async () => {
    // v1.14.3: notes and progress are NOW allowed; calendarEventId is still unknown
    const res = await patch(ITEM_WITH_NOTES, { calendarEventId: 'attacker-payload' });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('PATCH_NO_VALID_FIELDS');
  });

  it('M-10b: {calendarEventId: "x", title: "y"} → 400 + PATCH_UNKNOWN_FIELDS, disk unchanged', async () => {
    // v1.14.3: calendarEventId remains unknown; mixed with title → PATCH_UNKNOWN_FIELDS
    const res = await patch(ITEM_WITH_NOTES, { calendarEventId: 'x', title: 'y' });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('PATCH_UNKNOWN_FIELDS');
  });

  it('M-10c: {created: "..."} alone → 400 + PATCH_NO_VALID_FIELDS', async () => {
    const res = await patch(ITEM_ACTIVE, { created: '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// M-11: RA2 — notes/progress preserved on PATCH {title}
// ---------------------------------------------------------------------------

describe('PATCH — notes/progress preservation (RA2 / Test M-29)', () => {
  it('M-11: PATCH {title} → notes and progress byte-identical on disk', async () => {
    const res = await patch(ITEM_WITH_NOTES, { title: 'New title' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    // notesBody is stored with a trailing newline by storage.ts
    expect(body.item.notes).toContain('Multi-line\nnotes body\nwith preserved newlines');
    expect(body.item.progress).toContain('- [2026-04-24T10:00:00.000Z] step 1');
  });
});

// ---------------------------------------------------------------------------
// M-12: Cross-user isolation
// ---------------------------------------------------------------------------

describe('PATCH — cross-user isolation', () => {
  it('M-12: PATCH item from User A as User B → 404', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'Stolen' }, USER_B_ID);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// M-13: Path traversal
// ---------------------------------------------------------------------------

describe('PATCH — path traversal defense', () => {
  it('M-13a: :id with ../.. → 400 before filesystem touch', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/../../../etc/passwd`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(USER_A_ID) },
      body: JSON.stringify({ title: 'x' }),
    });
    // Express normalizes the path, so this will either 404 or 400
    expect([400, 404]).toContain(res.status);
  });

  it('M-13b: :id "invalid!!id" fails regex → 400', async () => {
    const res = await patch('invalid!!id', { title: 'x' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// M-14: Oversized body
// ---------------------------------------------------------------------------

describe('PATCH — oversized body', () => {
  it('M-14: body > 1KB → 413 or 400', async () => {
    const bigTitle = 'a'.repeat(2000);
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(USER_A_ID) },
      body: JSON.stringify({ title: bigTitle }),
    });
    // express.json({limit:'1kb'}) returns 413
    expect([400, 413]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// M-15: X-Captured-Mtime stale warning (R2-mtime)
// ---------------------------------------------------------------------------

describe('PATCH — X-Captured-Mtime stale warning (R2-mtime)', () => {
  it('M-15: X-Captured-Mtime is silently ignored in v1.14.4 (R2 sunset) — 200, no staleWarning', async () => {
    // D6: X-Captured-Mtime header is no longer read; staleWarning is never emitted.
    const res = await patch(ITEM_ACTIVE, { title: 'Stale save' }, USER_A_ID, {
      'X-Captured-Mtime': '0',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; staleWarning?: boolean };
    expect(body.ok).toBe(true);
    // staleWarning must NOT be present — R2-mtime sunset (D6)
    expect(body.staleWarning).toBeUndefined();

    // webapp.stale_edit audit rows must NOT be emitted
    const rows = mem.auditLog.listByCategory('webapp.stale_edit');
    expect(rows.length).toBe(0);
  });

  it('M-16: matching mtime → 200 + no staleWarning field', async () => {
    // First GET the item to obtain its real mtime
    const getRes = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      headers: authHeader(USER_A_ID),
    });
    const getBody = await getRes.json() as { item: { mtimeMs: number } };
    const realMtime = getBody.item.mtimeMs;

    const res = await patch(ITEM_ACTIVE, { title: 'Fresh save' }, USER_A_ID, {
      'X-Captured-Mtime': String(realMtime),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; staleWarning?: boolean };
    expect(body.ok).toBe(true);
    expect(body.staleWarning).toBeUndefined();
  });

  it('M-16b: no X-Captured-Mtime header → 200 + no staleWarning', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'No mtime header' });
    expect(res.status).toBe(200);
    const body = await res.json() as { staleWarning?: boolean };
    expect(body.staleWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M-17: Auth matrix for PATCH
// ---------------------------------------------------------------------------

describe('PATCH — auth matrix', () => {
  it('M-17a: no Authorization header → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { code: string; reason: string };
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('no-auth-header');
  });

  it('M-17b: stale token → 401 + reason stale', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `tma ${twoHourStaleInitDataFor(USER_A_ID)}` },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe('stale');
  });

  it('M-17c: not-allowlisted user → 403', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(USER_C_ID) },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('NOT_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// M-18: DELETE happy path
// ---------------------------------------------------------------------------

describe('DELETE /api/webapp/items/:id', () => {
  it('M-18: DELETE → 200 + {ok:true, deletedId}; file moved to .trash/', async () => {
    const res = await del(ITEM_ACTIVE);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deletedId: string };
    expect(body.ok).toBe(true);
    expect(body.deletedId).toBe(ITEM_ACTIVE);

    // Live file must be gone
    const userDir = path.join(dataDir, 'organize', String(USER_A_ID));
    expect(fs.existsSync(path.join(userDir, `${ITEM_ACTIVE}.md`))).toBe(false);

    // .trash dir must have the file
    const trashDir = path.join(userDir, '.trash');
    const trashFiles = fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : [];
    expect(trashFiles.some((f) => f.startsWith(ITEM_ACTIVE))).toBe(true);
  });

  it('M-19: DELETE idempotent → 404 on second call', async () => {
    await del(ITEM_ACTIVE);
    const res2 = await del(ITEM_ACTIVE);
    expect(res2.status).toBe(404);
  });

  it('M-20: DELETE cross-user → 404', async () => {
    const res = await del(ITEM_ACTIVE, USER_B_ID);
    expect(res.status).toBe(404);
  });

  it('M-21: DELETE auth matrix → 401/403 as expected', async () => {
    const noAuth = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, { method: 'DELETE' });
    expect(noAuth.status).toBe(401);

    const notAllowed = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      method: 'DELETE',
      headers: authHeader(USER_C_ID),
    });
    expect(notAllowed.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// M-22: POST /complete — toggle (active → done → active)
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items/:id/complete — toggle', () => {
  it('M-22: active + {done:true} → done', async () => {
    const res = await complete(ITEM_ACTIVE, { done: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.item.status).toBe('done');
  });

  it('M-23: done + {done:false} → active', async () => {
    const res = await complete(ITEM_DONE, { done: false });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('active');
  });

  it('M-24: active + {done:false} → active (no-op stays active)', async () => {
    const res = await complete(ITEM_ACTIVE, { done: false });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('active');
  });

  it('M-25: done + {done:true} → done (idempotent)', async () => {
    const res = await complete(ITEM_DONE, { done: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('done');
  });

  it('M-26: no body toggle on active → done', async () => {
    const res = await complete(ITEM_ACTIVE, undefined);
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('done');
  });

  it('M-27: no body toggle on done → active', async () => {
    const res = await complete(ITEM_DONE, undefined);
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// M-28: POST /complete — abandoned edge cases (R14)
// ---------------------------------------------------------------------------

describe('POST /complete — abandoned edge cases (R14)', () => {
  it('M-28a: abandoned + {done:true} → 200 + status done (un-abandons)', async () => {
    const res = await complete(ITEM_ABANDONED, { done: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('done');
  });

  it('M-28b: abandoned + {done:false} → 200 + status UNCHANGED (still abandoned, no-op)', async () => {
    const res = await complete(ITEM_ABANDONED, { done: false });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('abandoned');
  });

  it('M-28c: abandoned + no body → 400 + code AMBIGUOUS_TOGGLE', async () => {
    const res = await complete(ITEM_ABANDONED, undefined);
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('AMBIGUOUS_TOGGLE');
  });
});

// ---------------------------------------------------------------------------
// M-29: Audit emission — each successful mutation creates exactly one row
// ---------------------------------------------------------------------------

describe('Audit — webapp.item_mutate row emission', () => {
  it('M-29a: successful PATCH emits one webapp.item_mutate row with action=update', async () => {
    const before = mem.auditLog.listByCategory('webapp.item_mutate').length;
    await patch(ITEM_ACTIVE, { title: 'Audit test' });
    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    expect(rows.length).toBe(before + 1);
    const detail = JSON.parse(rows[0].detail_json) as { action: string; itemId: string; changedFields: string[] };
    expect(detail.action).toBe('update');
    expect(detail.itemId).toBe(ITEM_ACTIVE);
    expect(detail.changedFields).toContain('title');
  });

  it('M-29b: successful DELETE emits one row with action=delete', async () => {
    const before = mem.auditLog.listByCategory('webapp.item_mutate').length;
    await del(ITEM_ACTIVE);
    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    expect(rows.length).toBe(before + 1);
    const detail = JSON.parse(rows[0].detail_json) as { action: string; changedFields: string[] };
    expect(detail.action).toBe('delete');
    expect(detail.changedFields).toEqual([]);
  });

  it('M-29c: successful POST /complete emits row with action=complete', async () => {
    const before = mem.auditLog.listByCategory('webapp.item_mutate').length;
    await complete(ITEM_ACTIVE, { done: true });
    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    expect(rows.length).toBe(before + 1);
    const detail = JSON.parse(rows[0].detail_json) as { action: string; changedFields: string[] };
    expect(detail.action).toBe('complete');
    expect(detail.changedFields).toContain('status');
  });

  it('M-29d: failed validation (400) does NOT emit an audit row', async () => {
    const before = mem.auditLog.listByCategory('webapp.item_mutate').length;
    await patch(ITEM_ACTIVE, { calendarEventId: 'attacker' }); // PATCH_NO_VALID_FIELDS → 400
    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    expect(rows.length).toBe(before); // no new row
  });

  it('M-29e: audit detail XSS defense — changedFields never contains user content (W5)', async () => {
    const xssTitle = '<script>alert(1)</script>foo';
    await patch(ITEM_ACTIVE, { title: xssTitle });
    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const latestRow = rows[0];
    // detail_json should NOT contain the XSS payload
    expect(latestRow.detail_json).not.toContain('<script>');
    // detail_json should only contain known safe keys (v1.14.4: added etag, forced, bypassAfter412)
    const detail = JSON.parse(latestRow.detail_json) as Record<string, unknown>;
    const allowedKeys = ['action', 'itemId', 'changedFields', 'ip', 'etag', 'forced', 'bypassAfter412'];
    for (const key of Object.keys(detail)) {
      expect(allowedKeys).toContain(key);
    }
  });

  it('M-29f: audit ip field is redacted — last IPv4 octet is 0 (ADR 010 D4 / PRIVACY.md M1)', async () => {
    // The server runs on 127.0.0.1 in tests; after redactIp it becomes 127.0.0.0.
    await patch(ITEM_ACTIVE, { title: 'IP redact check' });
    const rows = mem.auditLog.listByCategory('webapp.item_mutate');
    const detail = JSON.parse(rows[0].detail_json) as { ip?: string };
    // If ip is present, it must end in .0 (last octet redacted)
    if (detail.ip !== undefined) {
      const parts = detail.ip.split('.');
      expect(parts[parts.length - 1]).toBe('0');
    }
  });
});

// ---------------------------------------------------------------------------
// M-34: POST /complete returns 500 + error envelope when storage layer throws (L5/ADR W4)
//
// Verifies the server-side 500-response shape (W4 binding: "PATCH returns HTTP
// 5xx → client rollback"). Client-side DOM rollback is asserted via source-grep
// in webapp.organize.client.test.ts; this test covers the server response contract.
// ---------------------------------------------------------------------------

describe('POST /complete — 500 response shape (ADR W4 / L5)', () => {
  it('M-34: POST /complete with corrupted item file returns 500 + {ok:false, code:INTERNAL_ERROR}', async () => {
    // Corrupt the item file so readItem throws ITEM_MALFORMED → handler returns 500
    const userDir = path.join(dataDir, 'organize', String(USER_A_ID));
    const itemFile = path.join(userDir, `${ITEM_ACTIVE}.md`);
    // Overwrite with content that has no valid YAML front-matter
    fs.writeFileSync(itemFile, 'not valid yaml front matter\n', 'utf8');

    const before = mem.auditLog.listByCategory('webapp.item_mutate').length;

    const res = await complete(ITEM_ACTIVE, { done: true });
    expect(res.status).toBe(500);

    const body = await res.json() as { ok: boolean; code: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(typeof body.error).toBe('string');

    // Audit row MUST NOT be written for a failed mutation (ADR 010 decision 9)
    const after = mem.auditLog.listByCategory('webapp.item_mutate').length;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// M-30: GET /:id response now includes mtimeMs (R2-mtime)
// ---------------------------------------------------------------------------

describe('GET /api/webapp/items/:id — mtimeMs field (R2-mtime)', () => {
  it('M-30: GET response includes numeric mtimeMs', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      headers: authHeader(USER_A_ID),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { mtimeMs: unknown } };
    expect(typeof body.item.mtimeMs).toBe('number');
    expect(body.item.mtimeMs).toBeGreaterThan(0);
  });

  it('M-30b: GET mtimeMs matches actual file mtime on disk', async () => {
    const userDir = path.join(dataDir, 'organize', String(USER_A_ID));
    const fileStat = await stat(path.join(userDir, `${ITEM_ACTIVE}.md`));

    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      headers: authHeader(USER_A_ID),
    });
    const body = await res.json() as { item: { mtimeMs: number } };
    expect(body.item.mtimeMs).toBe(fileStat.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// M-31: POST /complete auth matrix
// ---------------------------------------------------------------------------

describe('POST /complete — auth matrix', () => {
  it('M-31: no auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(401);
  });

  it('M-32: not-allowlisted user → 403', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(USER_C_ID) },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(403);
  });

  it('M-33: cross-user → 404', async () => {
    const res = await complete(ITEM_ACTIVE, { done: true }, USER_B_ID);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// M-NEW1: body-too-large → unified envelope (QA M2, v1.14.3 Fix 1)
// ---------------------------------------------------------------------------

describe('PATCH body cap — 32KB limit (v1.14.3 D4, QA M2)', () => {
  it('M-NEW1: PATCH with 33KB body → 413 with unified {ok:false, code:"BODY_TOO_LARGE"} envelope', async () => {
    // Build a body where notes alone is 33000 chars — just over the 32KB (32768 bytes) Express limit.
    // The JSON envelope adds ~20 bytes of overhead so the total serialized body is ~33 KB.
    const oversizedNotes = 'x'.repeat(33000);
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(USER_A_ID),
      },
      body: JSON.stringify({ notes: oversizedNotes }),
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { ok: boolean; code: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('BODY_TOO_LARGE');
    expect(typeof body.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// M-34..M-46: v1.14.3 — notes, progress, parentId rejection (R11)
// ---------------------------------------------------------------------------

describe('PATCH notes (v1.14.3 D2)', () => {
  it('M-34: PATCH {notes: "new note text"} → 200 with notes in response', async () => {
    const res = await patch(ITEM_ACTIVE, { notes: 'new note text' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: { notes: string } };
    expect(body.ok).toBe(true);
    expect(body.item.notes).toContain('new note text');
  });

  it('M-35: PATCH {notes: ""} → 200 (empty string allowed — clears notes)', async () => {
    const res = await patch(ITEM_WITH_NOTES, { notes: '' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: { notes: string } };
    expect(body.ok).toBe(true);
  });

  it('M-36: PATCH {notes: <10KB+1 chars>} → 400 NOTES_TOO_LONG', async () => {
    const oversized = 'a'.repeat(10241);
    const res = await patch(ITEM_ACTIVE, { notes: oversized });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOTES_TOO_LONG');
  });

  it('M-37: PATCH notes — audit row includes changedFields: ["notes"]', async () => {
    const res = await patch(ITEM_ACTIVE, { notes: 'audit test' });
    expect(res.status).toBe(200);

    const auditRows = mem.auditLog.listByCategory('webapp.item_mutate');
    const row = auditRows.find((r) => {
      const d = JSON.parse(r.detail_json) as { changedFields?: string[]; itemId?: string };
      return d.itemId === ITEM_ACTIVE && d.changedFields?.includes('notes');
    });
    expect(row).toBeDefined();
    // Privacy: detail must NOT contain the notes value
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(JSON.stringify(detail)).not.toContain('audit test');
  });

  it('M-37b: PATCH {progress: "secret content"} → audit changedFields:["progress"] does NOT contain progress value (Anti-Slop F1)', async () => {
    const res = await patch(ITEM_ACTIVE, { progress: 'secret content' });
    expect(res.status).toBe(200);

    const auditRows = mem.auditLog.listByCategory('webapp.item_mutate');
    const row = auditRows.find((r) => {
      const d = JSON.parse(r.detail_json) as { changedFields?: string[]; itemId?: string };
      return d.itemId === ITEM_ACTIVE && d.changedFields?.includes('progress');
    });
    expect(row).toBeDefined();
    // changedFields includes 'progress' (field name, not value)
    const detail = JSON.parse(row!.detail_json) as { changedFields?: string[] };
    expect(detail.changedFields).toContain('progress');
    // Privacy: the literal field value must NOT appear in the detail JSON
    expect(JSON.stringify(detail)).not.toContain('secret content');
  });

  it('M-37c: PATCH {notes: "alpha", progress: "bravo"} → audit changedFields contains both field names but NOT the values (Anti-Slop F1)', async () => {
    const res = await patch(ITEM_ACTIVE, { notes: 'alpha', progress: 'bravo' });
    expect(res.status).toBe(200);

    const auditRows = mem.auditLog.listByCategory('webapp.item_mutate');
    // Find the row that contains both 'notes' and 'progress' in changedFields
    const row = auditRows.find((r) => {
      const d = JSON.parse(r.detail_json) as { changedFields?: string[]; itemId?: string };
      return (
        d.itemId === ITEM_ACTIVE &&
        d.changedFields?.includes('notes') &&
        d.changedFields?.includes('progress')
      );
    });
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail_json) as { changedFields?: string[] };
    // Both field NAMES present in changedFields
    expect(detail.changedFields).toContain('notes');
    expect(detail.changedFields).toContain('progress');
    // Privacy: neither field VALUE appears in detail JSON
    expect(JSON.stringify(detail)).not.toContain('alpha');
    expect(JSON.stringify(detail)).not.toContain('bravo');
  });
});

describe('PATCH progress (v1.14.3 D3)', () => {
  it('M-38: PATCH {progress: "- step 1"} → 200 with progress in response', async () => {
    const res = await patch(ITEM_ACTIVE, { progress: '- step 1' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: { progress: string } };
    expect(body.ok).toBe(true);
    expect(body.item.progress).toContain('- step 1');
  });

  it('M-39: PATCH {progress: <20KB+1 chars>} → 400 PROGRESS_TOO_LONG', async () => {
    const oversized = 'a'.repeat(20481);
    const res = await patch(ITEM_ACTIVE, { progress: oversized });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('PROGRESS_TOO_LONG');
  });

  it('M-40: PATCH progress with stale X-Captured-Mtime is ignored in v1.14.4 (R2 sunset)', async () => {
    // Set up initial progress (3 lines)
    await patch(ITEM_ACTIVE, { progress: '- line1\n- line2\n- line3' });

    // Get current mtime
    const userDir = path.join(dataDir, 'organize', String(USER_A_ID));
    const fileStat = await stat(path.join(userDir, `${ITEM_ACTIVE}.md`));

    // Patch with stale mtime + 2 lines (delta = -1 from 3)
    const staleMs = fileStat.mtimeMs - 5000;
    const res = await patch(
      ITEM_ACTIVE,
      { progress: '- line1\n- line2' },
      USER_A_ID,
      { 'X-Captured-Mtime': String(staleMs) },
    );
    expect(res.status).toBe(200);
    // staleWarning is NOT emitted in v1.14.4 (R2 sunset)
    const body = await res.json() as { staleWarning?: boolean };
    expect(body.staleWarning).toBeUndefined();

    // webapp.stale_edit rows NOT emitted (D6)
    const staleRows = mem.auditLog.listByCategory('webapp.stale_edit');
    expect(staleRows.length).toBe(0);
  });
});

describe('PATCH combined notes+progress (v1.14.3 D2+D3)', () => {
  it('M-41: PATCH {notes, progress} → 200, both fields updated', async () => {
    const res = await patch(ITEM_ACTIVE, { notes: 'combined note', progress: 'combined progress' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: { notes: string; progress: string } };
    expect(body.ok).toBe(true);
    expect(body.item.notes).toContain('combined note');
    expect(body.item.progress).toContain('combined progress');
  });
});

describe('PATCH parentId acceptance — v1.14.5 (supersedes CP1 v1.14.3 R11)', () => {
  it('M-NEW-P1: PATCH {parentId: "2026-04-20-abcd"} alone → 400 PARENT_NOT_FOUND (format valid, item nonexistent)', async () => {
    const res = await patch(ITEM_ACTIVE, { parentId: '2026-04-20-abcd' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('PARENT_NOT_FOUND');
  });

  it('M-NEW-P2: PATCH {parentId: "not-an-id"} alone → 400 PARENT_ID_INVALID_FORMAT', async () => {
    const res = await patch(ITEM_ACTIVE, { parentId: 'not-an-id' });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('PARENT_ID_INVALID_FORMAT');
  });

  it('M-NEW-P3: PATCH {parentId: null} alone → 200 (null is valid; clears parent on a task)', async () => {
    const res = await patch(ITEM_ACTIVE, { parentId: null });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('M-NEW-P4: PATCH {title: "New title", parentId: "2026-04-20-abcd"} → 400 PARENT_NOT_FOUND and title unchanged', async () => {
    const res = await patch(ITEM_ACTIVE, { title: 'New title', parentId: '2026-04-20-abcd' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('PARENT_NOT_FOUND');

    // Verify title is UNCHANGED on disk (existence check fires before storage write)
    const readRes = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_ACTIVE}`, {
      headers: authHeader(USER_A_ID),
    });
    const readBody = await readRes.json() as { item: { title: string } };
    expect(readBody.item.title).toBe('Original title');
  });
});
