/**
 * Integration tests for GET /api/webapp/config (v1.15.0 D9).
 *
 * Verifies: auth chain, allowlist guard, response shape, broadcastChannelName
 * format, no audit row written, Cache-Control header, and cross-user parity.
 *
 * Pattern mirrors webapp.echo.test.ts: real Express server on a dedicated
 * port, native fetch, no supertest. No storage layer needed (config is
 * read-only metadata).
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
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'config_int_test_token';
const TEST_BOT_USERNAME = 'testjarvis';
const TEST_PORT = 17913;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

/** User A: in the allowlist. */
const USER_A_ID = 111111;
/** User B: also in the allowlist (cross-user parity test). */
const USER_B_ID = 222222;
/** User C: NOT in the allowlist. */
const USER_C_ID = 333333;

const NOW_UNIX = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// initData builder (mirrors webapp.echo.test.ts)
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

function staleInitDataFor(userId: number): string {
  // 86401 seconds old — exceeds the items 1h window AND the echo 24h window
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX - 86401),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
}

function malformedInitData(): string {
  return 'auth_date=12345&user=%7B%22id%22%3A1%7D'; // no hash field
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;

beforeEach(async () => {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-config-int-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    telegram: { allowedUserIds: [USER_A_ID, USER_B_ID], botToken: BOT_TOKEN },
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
  server = createWebappServer({
    config: cfg,
    version: '1.15.0-test',
    memory: mem,
    getBotUsername: () => TEST_BOT_USERNAME,
  });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
});

// ---------------------------------------------------------------------------
// Auth chain — 401 paths
// ---------------------------------------------------------------------------

describe('/api/webapp/config — 401 auth failures', () => {
  it('returns 401 with reason no-auth-header when Authorization header is absent', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.reason).toBe('no-auth-header');
  });

  it('returns 401 for wrong-prefix Authorization (Bearer token)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: 'Bearer some-jwt' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
  });

  it('returns 401 for malformed initData (no hash field)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${malformedInitData()}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
  });

  it('returns 401 for stale initData (exceeded max age)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${staleInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Allowlist guard — 403 path
// ---------------------------------------------------------------------------

describe('/api/webapp/config — 403 allowlist guard', () => {
  it('returns 403 NOT_ALLOWED for a user not in the allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_C_ID)}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOT_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// 200 happy path — response shape
// ---------------------------------------------------------------------------

describe('/api/webapp/config — 200 happy path', () => {
  it('returns 200 with {ok, botUsername, broadcastChannelName}', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.botUsername).toBe(TEST_BOT_USERNAME);
    expect(body.broadcastChannelName).toBe(`organize-mutations-${TEST_BOT_USERNAME}`);
  });

  it('broadcastChannelName is exactly "organize-mutations-" + botUsername', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.broadcastChannelName).toBe(
      `organize-mutations-${body.botUsername}`,
    );
  });

  it('Cache-Control is no-store', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control');
    expect(cc).toContain('no-store');
  });
});

// ---------------------------------------------------------------------------
// No audit row written for /config GET
// ---------------------------------------------------------------------------

describe('/api/webapp/config — no audit row on success', () => {
  it('writes zero audit rows to the audit log for a successful GET /config', async () => {
    const before = mem.auditLog.listRecent(100).length;
    await fetch(`${BASE_URL}/api/webapp/config`, {
      headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
    });
    const after = mem.auditLog.listRecent(100).length;
    expect(after).toBe(before); // no new audit rows added
  });
});

// ---------------------------------------------------------------------------
// Cross-user: both allowlisted users get the same response (botUsername is global)
// ---------------------------------------------------------------------------

describe('/api/webapp/config — cross-user parity', () => {
  it('user A and user B both receive the same botUsername and broadcastChannelName', async () => {
    const [resA, resB] = await Promise.all([
      fetch(`${BASE_URL}/api/webapp/config`, {
        headers: { Authorization: `tma ${validInitDataFor(USER_A_ID)}` },
      }),
      fetch(`${BASE_URL}/api/webapp/config`, {
        headers: { Authorization: `tma ${validInitDataFor(USER_B_ID)}` },
      }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const bodyA = await resA.json() as Record<string, unknown>;
    const bodyB = await resB.json() as Record<string, unknown>;

    expect(bodyA.botUsername).toBe(bodyB.botUsername);
    expect(bodyA.broadcastChannelName).toBe(bodyB.broadcastChannelName);
    expect(bodyA.botUsername).toBe(TEST_BOT_USERNAME);
  });
});
