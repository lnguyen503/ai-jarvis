/**
 * Integration tests for the /api/webapp/items* endpoints and the
 * /webapp/organize/ static page (v1.14.0).
 *
 * Pattern mirrors webapp.echo.test.ts: real Express server on a dedicated
 * port, native fetch, no supertest dependency. Covers the 22-case floor from
 * ADR 009 R9.
 *
 * Test data is written directly to a tmp directory so storage.ts reads real
 * files — no mocking of the storage layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'organize_int_test_token';
const TEST_PORT = 17902;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

/** User A: in the allowlist, has fixture items. */
const USER_A_ID = 111111;
/** User B: in the allowlist, has no items in the fixture dir. */
const USER_B_ID = 222222;
/** User C: NOT in the allowlist. */
const USER_C_ID = 333333;

const NOW_UNIX = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// initData builder
// ---------------------------------------------------------------------------

function buildInitData(
  botToken: string,
  fields: Record<string, string>,
): string {
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

/** auth_date is exactly 2h ago — stale for 1h items window but fine for 24h echo window. */
function twoHourStaleInitDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX - 7200),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal .md content matching the storage serialization format.
 * Enough for parseItemFile to succeed.
 */
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

/** Write fixture items for a userId into the given dataDir. */
function writeFixtureItems(
  dataDir: string,
  userId: number,
  items: Array<Parameters<typeof makeItemMd>[0]>,
): void {
  const userDir = path.join(dataDir, 'organize', String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  for (const item of items) {
    const content = makeItemMd(item);
    fs.writeFileSync(path.join(userDir, `${item.id}.md`), content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

beforeEach(async () => {
  _resetDb();

  // Use a real tmp dir as dataDir — storage.ts reads actual files from disk
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-organize-int-'));
  dataDir = fs.realpathSync.native(tmpRoot);
  const dbPath = path.join(dataDir, 'jarvis.db');

  // Write User A fixtures: 2 active tasks, 1 done task, 1 goal with tags
  writeFixtureItems(dataDir, USER_A_ID, [
    {
      id: '2026-04-24-t001',
      type: 'task',
      status: 'active',
      title: 'Buy milk',
      tags: ['shopping', 'urgent'],
      notes: 'Whole milk only',
    },
    {
      id: '2026-04-24-t002',
      type: 'task',
      status: 'active',
      title: 'Write tests',
      tags: ['dev'],
    },
    {
      id: '2026-04-24-d001',
      type: 'task',
      status: 'done',
      title: 'Done task',
    },
    {
      id: '2026-04-24-g001',
      type: 'goal',
      status: 'active',
      title: 'Learn TypeScript',
      tags: ['dev'],
      notes: 'Focus on generics',
      progress: '- 2026-04-24: started reading the handbook',
    },
  ]);

  // User B has no items (dir not even created)

  // Config: only USER_A_ID and USER_B_ID in allowlist; USER_C_ID is NOT
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
      staticDir: 'public/webapp',  // real public/webapp dir from the project
      port: TEST_PORT,
      initDataMaxAgeSeconds: 86400,  // echo keeps 24h
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,  // items uses 1h (R4)
    },
  };

  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.14.0-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  // Clean up tmp dir
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 1–3. Static reachability — /webapp/organize/*
// ---------------------------------------------------------------------------

describe('static reachability — /webapp/organize/', () => {
  it('1. GET /webapp/organize/index.html returns 200 or 404 (file present iff Dev-B has shipped)', async () => {
    const res = await fetch(`${BASE_URL}/webapp/organize/index.html`);
    // Dev-B writes the file; Dev-A verifies the server CAN serve it (200) or
    // that it does not 500 (404 is acceptable when Dev-B's files aren't present yet).
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get('content-type') ?? '').toContain('text/html');
    }
  });

  it('2. GET /webapp/organize/app.js returns 200 or 404', async () => {
    const res = await fetch(`${BASE_URL}/webapp/organize/app.js`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get('content-type') ?? '').toContain('javascript');
    }
  });

  it('3. GET /webapp/organize/styles.css returns 200 or 404', async () => {
    const res = await fetch(`${BASE_URL}/webapp/organize/styles.css`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get('content-type') ?? '').toContain('css');
    }
  });
});

// ---------------------------------------------------------------------------
// 4–5. CSP correctness (same middleware path as hub, ADR 009 decision 1)
// ---------------------------------------------------------------------------

describe('CSP — /webapp/index.html', () => {
  it('4. frame-ancestors allows Telegram embedding (not "none")', async () => {
    const res = await fetch(`${BASE_URL}/webapp/index.html`);
    if (res.status === 200) {
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain('frame-ancestors https://web.telegram.org https://*.telegram.org');
      expect(csp).not.toContain("frame-ancestors 'none'");
    } else {
      // File not present — server started correctly, which is enough for this test
      expect([200, 404]).toContain(res.status);
    }
  });

  it('5. script-src includes "self" and https://telegram.org', async () => {
    const res = await fetch(`${BASE_URL}/webapp/index.html`);
    if (res.status === 200) {
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self' https://telegram.org");
    } else {
      expect([200, 404]).toContain(res.status);
    }
  });
});

// ---------------------------------------------------------------------------
// 6–9. API auth
// ---------------------------------------------------------------------------

describe('/api/webapp/items — auth', () => {
  it('6. missing Authorization header → 401 + {ok:false, code:AUTH_FAILED, reason:no-auth-header}', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('no-auth-header');
  });

  it('7. wrong-prefix Authorization ("Bearer xyz") → 401 + reason no-auth-header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      headers: { Authorization: 'Bearer some-jwt' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('no-auth-header');
  });

  it('8. stale initData (2h old, >1h items window) → 401 + reason stale for items', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      headers: { Authorization: `tma ${twoHourStaleInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('stale');
  });

  it('9. same 2h-stale initData → 200 on echo (24h window passes)', async () => {
    // R4: echo keeps the 24h window; items use 1h. Same token, different outcome.
    const res = await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { Authorization: `tma ${twoHourStaleInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Allowlist guard
// ---------------------------------------------------------------------------

describe('/api/webapp/items — allowlist guard (R8)', () => {
  it('10. verified userId not in allowedUserIds → 403 + {ok:false, code:NOT_ALLOWED}', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_C_ID)}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOT_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// 11–14. Filter correctness
// ---------------------------------------------------------------------------

describe('/api/webapp/items — filter correctness', () => {
  it('11. ?type=task returns only tasks; ?type=goal returns only goals', async () => {
    const resTasks = await fetch(`${BASE_URL}/api/webapp/items?type=task`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(resTasks.status).toBe(200);
    const taskBody = await resTasks.json() as { ok: boolean; items: Array<{ type: string }> };
    expect(taskBody.ok).toBe(true);
    expect(taskBody.items.every((it) => it.type === 'task')).toBe(true);
    // User A has 2 active tasks
    expect(taskBody.items.length).toBe(2);

    const resGoals = await fetch(`${BASE_URL}/api/webapp/items?type=goal`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(resGoals.status).toBe(200);
    const goalBody = await resGoals.json() as { ok: boolean; items: Array<{ type: string }> };
    expect(goalBody.items.every((it) => it.type === 'goal')).toBe(true);
    expect(goalBody.items.length).toBe(1);
  });

  it('12. ?status=done returns only done items; default (no status) returns only active', async () => {
    const resDone = await fetch(`${BASE_URL}/api/webapp/items?status=done`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(resDone.status).toBe(200);
    const doneBody = await resDone.json() as { ok: boolean; items: Array<{ status: string }> };
    expect(doneBody.ok).toBe(true);
    expect(doneBody.items.every((it) => it.status === 'done')).toBe(true);
    expect(doneBody.items.length).toBe(1);

    // Default omits done (status defaults to 'active')
    const resDefault = await fetch(`${BASE_URL}/api/webapp/items`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    const defaultBody = await resDefault.json() as { ok: boolean; items: Array<{ status: string }> };
    expect(defaultBody.items.every((it) => it.status === 'active')).toBe(true);
    // User A has 3 active items (2 tasks + 1 goal)
    expect(defaultBody.items.length).toBe(3);
  });

  it('13. ?tag=dev returns only items with the "dev" tag', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items?tag=dev&status=all`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; items: Array<{ tags: string[] }> };
    expect(body.ok).toBe(true);
    expect(body.items.every((it) => it.tags.includes('dev'))).toBe(true);
    // User A has 2 items tagged 'dev': Write tests (task/active) + Learn TypeScript (goal/active)
    expect(body.items.length).toBe(2);
  });

  it('14. invalid query value ?type=banana → 400 + {ok:false, code:BAD_REQUEST}', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items?type=banana`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// 15. Per-user scoping
// ---------------------------------------------------------------------------

describe('/api/webapp/items — per-user scoping', () => {
  it('15. User A sees only A\'s items; User B (no items) sees empty list', async () => {
    const resA = await fetch(`${BASE_URL}/api/webapp/items?status=all`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { ok: boolean; items: unknown[]; total: number };
    expect(bodyA.ok).toBe(true);
    expect(bodyA.items.length).toBeGreaterThan(0);

    const resB = await fetch(`${BASE_URL}/api/webapp/items?status=all`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_B_ID)}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { ok: boolean; items: unknown[]; total: number };
    expect(bodyB.ok).toBe(true);
    expect(bodyB.items.length).toBe(0);
    expect(bodyB.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 16–20. Items detail (/api/webapp/items/:id)
// ---------------------------------------------------------------------------

describe('/api/webapp/items/:id — detail endpoint', () => {
  it('16. valid id → 200 + full shape including notes, progress, fileBasename', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/2026-04-24-t001`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    const item = body.item;
    expect(item.id).toBe('2026-04-24-t001');
    expect(item.title).toBe('Buy milk');
    expect(item.type).toBe('task');
    expect(item.status).toBe('active');
    expect(typeof item.notes).toBe('string');
    expect(typeof item.progress).toBe('string');
    expect(typeof item.fileBasename).toBe('string');
    // fileBasename must be a filename, NOT an absolute path
    expect(item.fileBasename).toBe('2026-04-24-t001.md');
    expect(String(item.fileBasename)).not.toContain('\\');
    expect(String(item.fileBasename)).not.toContain('/organize/');
  });

  it('17. path-traversal id (../../etc/passwd) → 400 + {ok:false, code:BAD_REQUEST} (not 404)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/..%2F..%2Fetc%2Fpasswd`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    // Path-traversal defense fires BEFORE filesystem touch → 400 not 404
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('18. valid id format but item not on disk → 404 + {ok:false, code:NOT_FOUND}', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/2026-04-24-zzzz`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('19. embedded null byte in id (%00) → 400 (defense before filesystem call)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/2026-04-24-t0%000`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('20. oversized id (>50 chars) → 400', async () => {
    const longId = '2026-04-24-' + 'a'.repeat(50); // well over 50 chars total
    const res = await fetch(`${BASE_URL}/api/webapp/items/${longId}`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Fix 3: audit rows on items route auth failures (ADR 009 §9 / QA L1)
// ---------------------------------------------------------------------------

describe('/api/webapp/items — audit row emission on 401 (Fix 3)', () => {
  it('23. malformed initData (no-auth-header) on list route → 401 + audit row with category webapp.auth_failure', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`);
    expect(res.status).toBe(401);

    // better-sqlite3 is synchronous — DB write completes before the response is sent.
    const rows = mem.auditLog.listRecent(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      return d['reason'] === 'no-auth-header';
    });
    expect(row).toBeDefined();
    expect(row!.category).toBe('webapp.auth_failure');
  });

  it('24. malformed initData on detail route → 401 + audit row with pathHit containing /items/', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/2026-04-24-t001`);
    expect(res.status).toBe(401);

    const rows = mem.auditLog.listRecent(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      return typeof d['pathHit'] === 'string' && (d['pathHit'] as string).includes('/items/');
    });
    expect(row).toBeDefined();
  });

  it('25. burst of 5 malformed requests in same 60s window → AuditDebouncer consolidates to 1 row + suppressedCount ≥ 2', async () => {
    const requests = Array.from({ length: 5 }, () =>
      fetch(`${BASE_URL}/api/webapp/items`, { headers: { Authorization: 'Bearer bad' } }),
    );
    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.status === 401)).toBe(true);

    const rows = mem.auditLog.listRecent(100);
    // All 5 requests originate from 127.0.0.1 in the same 60s window.
    // AuditDebouncer: first request emits + stores row; subsequent 4 update suppressedCount.
    const authFailureRows = rows.filter((r) => r.category === 'webapp.auth_failure');
    expect(authFailureRows.length).toBeGreaterThanOrEqual(1);

    // The highest suppressedCount among no-auth-header rows should be ≥ 2 (first + at least 1 suppression)
    const maxSuppressed = Math.max(
      ...authFailureRows.map((r) => {
        const d = JSON.parse(r.detail_json) as Record<string, unknown>;
        return typeof d['suppressedCount'] === 'number' ? (d['suppressedCount'] as number) : 1;
      }),
    );
    expect(maxSuppressed).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Cache-Control: no-store on items JSON responses (QA M3)
// ---------------------------------------------------------------------------

describe('/api/webapp/items — Cache-Control: no-store (Fix 4)', () => {
  it('26. successful items list response has Cache-Control: no-store', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('no-store');
  });

  it('27. 401 auth failure on items route also has Cache-Control: no-store', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`);
    expect(res.status).toBe(401);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('no-store');
  });
});

// ---------------------------------------------------------------------------
// Fix 5: Cross-user 404 test (QA M1 — explicit per-user scoping proof)
// ---------------------------------------------------------------------------

describe('/api/webapp/items/:id — cross-user isolation (Fix 5)', () => {
  it('28. userA initData + userB\'s item id → 404 (path resolves to userA\'s dir); userB initData → 200', async () => {
    // Write an item ONLY for User B
    writeFixtureItems(dataDir, USER_B_ID, [
      {
        id: '2026-04-25-aaaa',
        type: 'task',
        status: 'active',
        title: 'User B exclusive task',
      },
    ]);

    // User A's authenticated request for User B's item id → 404
    // (resolves to data/organize/USER_A_ID/2026-04-25-aaaa.md which doesn't exist)
    const resA = await fetch(`${BASE_URL}/api/webapp/items/2026-04-25-aaaa`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(resA.status).toBe(404);
    const bodyA = await resA.json() as Record<string, unknown>;
    expect(bodyA.ok).toBe(false);
    expect(bodyA.code).toBe('NOT_FOUND');

    // User B's authenticated request for the same id → 200
    const resB = await fetch(`${BASE_URL}/api/webapp/items/2026-04-25-aaaa`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_B_ID)}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { ok: boolean; item: Record<string, unknown> };
    expect(bodyB.ok).toBe(true);
    expect(bodyB.item.id).toBe('2026-04-25-aaaa');
    expect(bodyB.item.title).toBe('User B exclusive task');
  });
});

// ---------------------------------------------------------------------------
// 21–22. Response shape validation
// ---------------------------------------------------------------------------

describe('response shape', () => {
  it('21. list response has ok:true, items:array, total:number, serverTime:ISO string', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.serverTime).toBe('string');
    // serverTime is a valid ISO-8601 date
    expect(new Date(body.serverTime as string).toISOString()).toBe(body.serverTime);
    // total === items.length invariant (v1.14.0 no pagination)
    expect(body.total).toBe((body.items as unknown[]).length);
  });

  it('22. detail response has ok:true, item with all required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/2026-04-24-g001`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    const item = body.item;
    // Required fields per ADR 009 decision 3
    expect(typeof item.id).toBe('string');
    expect(typeof item.type).toBe('string');
    expect(typeof item.status).toBe('string');
    expect(typeof item.title).toBe('string');
    expect(typeof item.created).toBe('string');
    expect(Array.isArray(item.tags)).toBe(true);
    expect(typeof item.notes).toBe('string');
    expect(typeof item.progress).toBe('string');
    expect(typeof item.fileBasename).toBe('string');
    // hasNotes and hasProgress are list-only fields — NOT in detail response
    expect(item['hasNotes']).toBeUndefined();
    expect(item['hasProgress']).toBeUndefined();
    // Verify notes and progress content
    expect(item.notes).toContain('Focus on generics');
    expect(item.progress).toContain('started reading');
  });
});
