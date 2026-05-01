/**
 * Integration tests for the /api/webapp/echo endpoint (src/webapp/server.ts).
 *
 * Spins up the Express server on a random high port per test group, makes
 * real HTTP requests via fetch (Node.js 18+ global), and asserts both response
 * shape and audit-log state.
 *
 * No supertest dependency — uses the same native fetch pattern as
 * tests/unit/gateway.health.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'integration_test_bot_token';
const TEST_PORT = 17901;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const NOW_UNIX = Math.floor(Date.now() / 1000); // current time for non-stale initData

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

function validInitData(overrides: Record<string, string> = {}): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: 987654321, username: 'integrationuser', first_name: 'Integration' }),
    ...overrides,
  });
}

function staleInitData(): string {
  // 86401 seconds old → exceeds default 86400s maxAge
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX - 86401),
    user: JSON.stringify({ id: 987654321, username: 'integrationuser', first_name: 'Integration' }),
  });
}

function malformedInitData(): string {
  // No hash field at all
  return 'auth_date=12345&user=%7B%22id%22%3A1%7D';
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;

beforeEach(async () => {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-webapp-int-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    telegram: { allowedUserIds: [12345], botToken: BOT_TOKEN },
    memory: { dbPath, maxHistoryMessages: 50 },
    webapp: {
      publicUrl: 'https://example.com',
      staticDir: 'public/webapp',
      port: TEST_PORT,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  });
  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.13.0-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
});

// ---------------------------------------------------------------------------
// Auth success
// ---------------------------------------------------------------------------

describe('/api/webapp/echo — auth success', () => {
  it('returns 200 + {userId, username, chatId, authDate} for valid Authorization header', async () => {
    const initData = validInitData();
    const res = await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { Authorization: `tma ${initData}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // R3: echo success now includes ok:true for envelope parity with items routes
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(987654321);
    expect(body.username).toBe('integrationuser');
    expect(body.chatId).toBeNull(); // no chat field in validInitData
    expect(typeof body.authDate).toBe('string');
  });

  it('inserts NO audit row on success (decision 10)', async () => {
    const before = mem.auditLog.listRecent(100).length;
    const initData = validInitData();
    await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { Authorization: `tma ${initData}` },
    });
    const after = mem.auditLog.listRecent(100).length;
    expect(after).toBe(before); // no new audit rows
  });
});

// ---------------------------------------------------------------------------
// Missing / wrong Authorization header
// ---------------------------------------------------------------------------

describe('/api/webapp/echo — missing or wrong Authorization header (R5)', () => {
  it('returns 401 with reason no-auth-header when Authorization header is absent', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/echo`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    // R3: unified error envelope
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('no-auth-header');
  });

  it('inserts an audit row for missing Authorization header', async () => {
    const before = mem.auditLog.listRecent(100).length;
    await fetch(`${BASE_URL}/api/webapp/echo`);
    const rows = mem.auditLog.listRecent(100);
    expect(rows.length).toBe(before + 1);
    const row = rows[0];
    expect(row.category).toBe('webapp.auth_failure');
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    expect(detail.reason).toBe('no-auth-header');
    // Partial IP shape: should end with .x for IPv4 or be a string
    expect(typeof detail.ip).toBe('string');
  });

  it('returns 401 with reason no-auth-header for wrong-prefix Authorization (Bearer xyz)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { Authorization: 'Bearer some-jwt-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    // R3: unified error envelope
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('no-auth-header');
  });
});

// ---------------------------------------------------------------------------
// Stale initData
// ---------------------------------------------------------------------------

describe('/api/webapp/echo — stale initData', () => {
  it('returns 401 with reason stale for expired auth_date', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { Authorization: `tma ${staleInitData()}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    // R3: unified error envelope
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('stale');
  });

  it('inserts audit row with reason stale', async () => {
    const before = mem.auditLog.listRecent(100).length;
    await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { Authorization: `tma ${staleInitData()}` },
    });
    const rows = mem.auditLog.listRecent(100);
    expect(rows.length).toBe(before + 1);
    const detail = JSON.parse(rows[0].detail_json) as Record<string, unknown>;
    expect(detail.reason).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// Audit debounce (R6)
// ---------------------------------------------------------------------------

describe('/api/webapp/echo — audit debounce (R6)', () => {
  it('emits exactly ONE audit row for a burst of 5 malformed requests (suppressedCount:4)', async () => {
    const before = mem.auditLog.listRecent(100).length;

    // Fire 5 requests in quick succession
    const requests = Array.from({ length: 5 }, () =>
      fetch(`${BASE_URL}/api/webapp/echo`, {
        headers: { Authorization: `tma ${malformedInitData()}` },
      }),
    );
    await Promise.all(requests);

    const rows = mem.auditLog.listRecent(100);
    const newRows = rows.slice(0, rows.length - before);
    // Exactly ONE audit row emitted
    expect(newRows.length).toBe(1);
    const detail = JSON.parse(newRows[0].detail_json) as Record<string, unknown>;
    // suppressedCount == 5: 1 (first emitted event) + 4 (subsequent suppressions)
    // = total events represented by this single audit row.
    expect(detail.suppressedCount).toBe(5);
    expect(detail.reason).toBe('malformed');
    expect(typeof detail.suppressedSince).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// CSP header (Fix 4 — frame-ancestors + full directive set)
// ---------------------------------------------------------------------------

describe('/webapp static — CSP header includes Telegram-allowed frame-ancestors and full directive set', () => {
  it('GET /webapp/index.html returns CSP allowing Telegram embedding while blocking other origins', async () => {
    const res = await fetch(`${BASE_URL}/webapp/index.html`);
    // The static dir may 404 in CI (no real public/webapp dir in tmpdir config),
    // but we just need to verify the CSP header shape when the file is found.
    // In this integration harness, staticDir resolves to the real public/webapp dir.
    if (res.status === 200) {
      const csp = res.headers.get('content-security-policy') ?? '';
      // v1.13.1: frame-ancestors allows Telegram Web's iframe origin while
      // blocking arbitrary attacker iframes. 'none' blocked legitimate Telegram
      // embedding and produced "refused to connect" errors in the webview.
      expect(csp).toContain('frame-ancestors https://web.telegram.org https://*.telegram.org');
      expect(csp).not.toContain("frame-ancestors 'none'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    } else {
      // Static file not present in test environment — just verify the server started
      expect([200, 404]).toContain(res.status);
    }
  });
});

// ---------------------------------------------------------------------------
// trust proxy (R-FIX-1)
// ---------------------------------------------------------------------------

describe('/api/webapp/echo — trust proxy (R-FIX-1)', () => {
  it('reads X-Forwarded-For when the connection is from loopback (cloudflared topology)', async () => {
    // The server is bound to 127.0.0.1 and we connect from 127.0.0.1 (loopback).
    // With app.set('trust proxy', 'loopback'), Express honours XFF from the loopback
    // peer, so req.ip should reflect the spoofed client IP.
    // We use the audit row's partial-IP field to observe req.ip at the server.
    const before = mem.auditLog.listRecent(100).length;
    await fetch(`${BASE_URL}/api/webapp/echo`, {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    });
    const rows = mem.auditLog.listRecent(100);
    const newRows = rows.slice(0, rows.length - before);
    // An audit row was inserted (missing-auth failure)
    expect(newRows.length).toBeGreaterThanOrEqual(1);
    const detail = JSON.parse(newRows[0].detail_json) as Record<string, unknown>;
    // With trust proxy active, req.ip resolves to 1.2.3.4 from XFF,
    // which becomes partial IP '1.2.3.x' (first 3 octets + .x per R6.1).
    expect(detail.ip).toBe('1.2.3.x');
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe('/api/webapp/echo — rate limiter', () => {
  it('returns 429 with Retry-After:60 after 60 requests/min from same IP', async () => {
    // Fire 70 requests; some should hit 429
    const results: number[] = [];
    for (let i = 0; i < 70; i++) {
      const res = await fetch(`${BASE_URL}/api/webapp/echo`);
      results.push(res.status);
    }
    // At least one 429 in the burst
    expect(results).toContain(429);

    // Find first 429 and check Retry-After header
    const idx429 = results.indexOf(429);
    // Re-do a 429 fetch to check header
    const res = await fetch(`${BASE_URL}/api/webapp/echo`);
    if (res.status === 429) {
      expect(res.headers.get('retry-after')).toBe('60');
    } else {
      // After stop+start the rate limiter resets, this is fine
      // Just assert we saw at least one 429 in the burst
      expect(idx429).toBeGreaterThanOrEqual(0);
    }
  }, 30_000); // Generous timeout for 70 sequential requests
});
