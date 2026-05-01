/**
 * Integration tests for GET /api/webapp/identity (v1.21.0 ADR 021 Pillar 4 D13 + D15).
 *
 * Tests:
 *   1. Returns { ok: true, botName: 'ai-jarvis', scope: 'full' } for ai-jarvis identity.
 *   2. Returns { ok: true, botName: 'ai-tony', scope: 'specialist' } for ai-tony identity.
 *   3. Returns legacy ai-jarvis default when identity not wired (no identity in deps).
 *   4. Returns 401 with reason when Authorization header is missing.
 *   5. Returns 401 when initData HMAC is invalid.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { BotIdentity } from '../../src/config/botIdentity.js';
import { SPECIALIST_TOOL_ALLOWLIST, personaPathFor, dataDirFor } from '../../src/config/botIdentity.js';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'identity_test_bot_token_12345';
// Use a unique port that doesn't collide with other test suites.
// Identity tests use 17960 base; identity.webappPort is set to TEST_PORT
// so the per-bot port override in server.ts resolves to our test port.
const TEST_PORT = 17960;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const NOW_UNIX = Math.floor(Date.now() / 1000);

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

function validInitData(overrides: Record<string, string> = {}): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: 111222333, username: 'identityuser', first_name: 'Identity' }),
    ...overrides,
  });
}

/**
 * Build a BotIdentity for tests. webappPort is always set to TEST_PORT so the
 * server binds to the port our fetch calls target — not the real production port.
 */
function makeIdentity(name: 'ai-jarvis' | 'ai-tony'): BotIdentity {
  const scope = name === 'ai-jarvis' ? 'full' : 'specialist';
  const allowedTools: ReadonlySet<string> =
    scope === 'specialist' ? SPECIALIST_TOOL_ALLOWLIST : new Set<string>();
  return {
    name,
    scope,
    telegramToken: BOT_TOKEN,
    personaPath: personaPathFor(name),
    dataDir: dataDirFor(name),
    webappPort: TEST_PORT, // test port — overrides the real 7879/7889 production ports
    healthPort: TEST_PORT - 1, // not used in webapp tests; held for type completeness
    allowedTools,
    aliases: [],
  additionalReadPaths: [],
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;

function makeServer(identity: BotIdentity | null | undefined): WebappServer {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-identity-int-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    telegram: { allowedUserIds: [111222333], botToken: BOT_TOKEN },
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
  return createWebappServer({
    config: cfg,
    version: '1.21.0-test',
    memory: mem,
    identity,
  });
}

afterEach(async () => {
  if (server) await server.stop();
  if (mem) mem.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/webapp/identity — ai-jarvis identity', () => {
  it('returns { ok: true, botName: ai-jarvis, scope: full } for ai-jarvis identity', async () => {
    server = makeServer(makeIdentity('ai-jarvis'));
    await server.start();

    const res = await fetch(`${BASE_URL}/api/webapp/identity`, {
      headers: { Authorization: `tma ${validInitData()}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['botName']).toBe('ai-jarvis');
    expect(body['scope']).toBe('full');
  });
});

describe('GET /api/webapp/identity — ai-tony identity', () => {
  it('returns { ok: true, botName: ai-tony, scope: specialist } for ai-tony identity', async () => {
    server = makeServer(makeIdentity('ai-tony'));
    await server.start();

    const res = await fetch(`${BASE_URL}/api/webapp/identity`, {
      headers: { Authorization: `tma ${validInitData()}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['botName']).toBe('ai-tony');
    expect(body['scope']).toBe('specialist');
  });
});

describe('GET /api/webapp/identity — legacy (no identity in deps)', () => {
  it('returns ai-jarvis defaults when identity not wired', async () => {
    server = makeServer(null);
    await server.start();

    const res = await fetch(`${BASE_URL}/api/webapp/identity`, {
      headers: { Authorization: `tma ${validInitData()}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['botName']).toBe('ai-jarvis');
    expect(body['scope']).toBe('full');
  });
});

describe('GET /api/webapp/identity — auth failures', () => {
  it('returns 401 when Authorization header is missing', async () => {
    server = makeServer(makeIdentity('ai-jarvis'));
    await server.start();

    const res = await fetch(`${BASE_URL}/api/webapp/identity`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['code']).toBe('AUTH_FAILED');
  });

  it('returns 401 when initData HMAC is invalid', async () => {
    server = makeServer(makeIdentity('ai-jarvis'));
    await server.start();

    const res = await fetch(`${BASE_URL}/api/webapp/identity`, {
      headers: { Authorization: 'tma auth_date=12345&hash=invalid000000000' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
  });
});
