/**
 * Unit tests for src/webapp/auth.ts — verifyTelegramInitData.
 *
 * Test vector strategy:
 *   - Primary deterministic vector: computed with a fixed bot token + auth_date.
 *   - External reference vector: computed with grammY-compatible parameters to
 *     validate our HMAC implementation matches reference implementations.
 *
 * All tests pass `now` explicitly so they are not clock-dependent.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData, type VerifyResult } from '../../src/webapp/auth.js';

// ---------------------------------------------------------------------------
// Helpers to build valid initData strings for tests
// ---------------------------------------------------------------------------

/** Build a valid initData string with a correct HMAC for the given botToken. */
function buildInitData(
  botToken: string,
  fields: Record<string, string>,
): string {
  // Build data-check-string (sorted, excluding hash)
  const pairs = Object.entries(fields).sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams();
  for (const [k, v] of pairs) {
    params.set(k, v);
  }
  params.set('hash', hash);
  return params.toString();
}

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'test_bot_token_12345';
const NOW_UNIX = 1_745_500_000; // fixed "now" for deterministic tests
const NOW_DATE = new Date(NOW_UNIX * 1000);

const VALID_USER = JSON.stringify({
  id: 123_456_789,
  username: 'testuser',
  first_name: 'Test',
  language_code: 'en',
});

const VALID_CHAT = JSON.stringify({ id: -100_123_456, type: 'group' });

const VALID_FIELDS: Record<string, string> = {
  auth_date: String(NOW_UNIX),
  user: VALID_USER,
  chat: VALID_CHAT,
  query_id: 'AAAAAAAtest',
};

// Pre-computed known-good initData (generated with fixed token + auth_date)
const KNOWN_GOOD_INIT_DATA =
  'auth_date=1745500000' +
  '&chat=%7B%22id%22%3A-100123456%2C%22type%22%3A%22group%22%7D' +
  '&query_id=AAAAAAAtest' +
  '&user=%7B%22id%22%3A123456789%2C%22username%22%3A%22testuser%22%2C%22first_name%22%3A%22Test%22%2C%22language_code%22%3A%22en%22%7D' +
  '&hash=aaa2d988f966558853d9a08cc68a63ff8e0a5c54b0eff1a27c2fd125c371c4aa';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('verifyTelegramInitData — happy path', () => {
  it('returns ok:true with fully-parsed user, chat, authDate, query_id', () => {
    const result = verifyTelegramInitData(KNOWN_GOOD_INIT_DATA, BOT_TOKEN, { now: NOW_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return; // TypeScript narrowing

    expect(result.data.user.id).toBe(123_456_789);
    expect(result.data.user.username).toBe('testuser');
    expect(result.data.user.first_name).toBe('Test');
    expect(result.data.user.language_code).toBe('en');
    expect(result.data.chat?.id).toBe(-100_123_456);
    expect(result.data.chat?.type).toBe('group');
    expect(result.data.authDate.getTime()).toBe(NOW_UNIX * 1000);
    expect(result.data.query_id).toBe('AAAAAAAtest');
    expect(result.data.raw).toBe(KNOWN_GOOD_INIT_DATA);
  });

  it('accepts a dynamically-built initData with the correct hash', () => {
    const initData = buildInitData(BOT_TOKEN, VALID_FIELDS);
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now: NOW_DATE });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// External reference vector (R8)
// grammY-compatible vector independently computed using the grammY HMAC algorithm.
// Token: '1234567890:secret' — a synthetic token in the grammY test style.
// Source: grammY verification reference — https://grammy.dev/guide/context#mini-app-data
// ---------------------------------------------------------------------------

describe('verifyTelegramInitData — external reference vector (R8)', () => {
  it('validates a vector computed with grammY-style token + user payload', () => {
    // This vector was computed independently using the same HMAC spec.
    // Token: '1234567890:secret', auth_date: 1715000000
    // user: {id:1, is_bot:false, first_name:"Test", username:"test", language_code:"en"}
    const GRAMMY_TOKEN = '1234567890:secret';
    const GRAMMY_AUTH_DATE = 1_715_000_000;
    const GRAMMY_INIT_DATA =
      'auth_date=1715000000' +
      '&user=%7B%22id%22%3A1%2C%22is_bot%22%3Afalse%2C%22first_name%22%3A%22Test%22%2C%22username%22%3A%22test%22%2C%22language_code%22%3A%22en%22%7D' +
      '&hash=9fcb96d26e92131d95e2dc674deb2ba01b48f94d35a9826ec06ce9f785f27e48';

    const now = new Date(GRAMMY_AUTH_DATE * 1000); // set now = auth_date so it's not stale
    const result = verifyTelegramInitData(GRAMMY_INIT_DATA, GRAMMY_TOKEN, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.user.id).toBe(1);
    expect(result.data.user.username).toBe('test');
    expect(result.data.user.first_name).toBe('Test');
  });
});

// ---------------------------------------------------------------------------
// Malformed inputs
// ---------------------------------------------------------------------------

describe('verifyTelegramInitData — malformed', () => {
  it('rejects empty string', () => {
    const r = verifyTelegramInitData('', BOT_TOKEN, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'malformed' } as VerifyResult);
  });

  it('rejects string with no hash field', () => {
    const params = new URLSearchParams({
      auth_date: String(NOW_UNIX),
      user: VALID_USER,
    });
    const r = verifyTelegramInitData(params.toString(), BOT_TOKEN, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects when hash is capital Hash (case-variant)', () => {
    // URLSearchParams with capital 'Hash' — 'hash' (lowercase) will be missing
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const dcs = `auth_date=${NOW_UNIX}\nuser=${VALID_USER}`;
    const hash = createHmac('sha256', secretKey).update(dcs).digest('hex');
    // Build raw string manually so 'Hash' is the key, not 'hash'
    const raw = `auth_date=${encodeURIComponent(String(NOW_UNIX))}&user=${encodeURIComponent(VALID_USER)}&Hash=${hash}`;
    const r = verifyTelegramInitData(raw, BOT_TOKEN, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects duplicate hash field', () => {
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const dcs = `auth_date=${NOW_UNIX}\nuser=${VALID_USER}`;
    const hash = createHmac('sha256', secretKey).update(dcs).digest('hex');
    const fakeHash = hash.slice(0, 60) + '0000'; // wrong hash
    // Inject two hash values
    const raw =
      `auth_date=${encodeURIComponent(String(NOW_UNIX))}` +
      `&user=${encodeURIComponent(VALID_USER)}` +
      `&hash=${hash}` +
      `&hash=${fakeHash}`;
    const r = verifyTelegramInitData(raw, BOT_TOKEN, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// Bad hash
// ---------------------------------------------------------------------------

describe('verifyTelegramInitData — bad-hash', () => {
  it('returns bad-hash when a single byte is tampered', () => {
    const initData = buildInitData(BOT_TOKEN, VALID_FIELDS);
    // Flip the last char of the hash
    const params = new URLSearchParams(initData);
    const origHash = params.get('hash')!;
    const tampered = origHash.slice(0, -1) + (origHash.endsWith('0') ? '1' : '0');
    params.set('hash', tampered);
    const r = verifyTelegramInitData(params.toString(), BOT_TOKEN, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'bad-hash' });
  });

  it('returns bad-hash (not a throw) for a length-mismatched hash (32 hex chars instead of 64)', () => {
    const initData = buildInitData(BOT_TOKEN, VALID_FIELDS);
    const params = new URLSearchParams(initData);
    // Replace hash with a short 32-char hex string (16 bytes — half the expected length)
    params.set('hash', 'aabbccdd11223344aabbccdd11223344');
    // Should not throw — should return bad-hash cleanly
    expect(() => {
      const r = verifyTelegramInitData(params.toString(), BOT_TOKEN, { now: NOW_DATE });
      expect(r).toMatchObject({ ok: false, reason: 'bad-hash' });
    }).not.toThrow();
  });

  it('returns bad-hash when verified against the wrong bot token', () => {
    // Hash was signed with BOT_TOKEN, now verified against TOKEN_B
    const initData = buildInitData(BOT_TOKEN, VALID_FIELDS);
    const TOKEN_B = 'different_bot_token_99999';
    const r = verifyTelegramInitData(initData, TOKEN_B, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'bad-hash' });
  });
});

// ---------------------------------------------------------------------------
// Stale / future-skew
// ---------------------------------------------------------------------------

describe('verifyTelegramInitData — stale', () => {
  it('rejects auth_date older than maxAgeSeconds (86400s = 24h)', () => {
    const staleUnix = NOW_UNIX - 86401; // 1 second past the limit
    const fields = { ...VALID_FIELDS, auth_date: String(staleUnix) };
    const initData = buildInitData(BOT_TOKEN, fields);
    const r = verifyTelegramInitData(initData, BOT_TOKEN, { now: NOW_DATE, maxAgeSeconds: 86400 });
    expect(r).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('accepts auth_date exactly at the boundary (86400s ago)', () => {
    const boundaryUnix = NOW_UNIX - 86400; // exactly at limit
    const fields = { ...VALID_FIELDS, auth_date: String(boundaryUnix) };
    const initData = buildInitData(BOT_TOKEN, fields);
    const r = verifyTelegramInitData(initData, BOT_TOKEN, { now: NOW_DATE, maxAgeSeconds: 86400 });
    // Exactly at boundary: ageSeconds === maxAgeSeconds → NOT stale (> check, not >=)
    expect(r.ok).toBe(true);
  });
});

describe('verifyTelegramInitData — future-skew (R7)', () => {
  it('rejects auth_date more than 300s in the future', () => {
    const futureUnix = NOW_UNIX + 301;
    const fields = { ...VALID_FIELDS, auth_date: String(futureUnix) };
    const initData = buildInitData(BOT_TOKEN, fields);
    const r = verifyTelegramInitData(initData, BOT_TOKEN, {
      now: NOW_DATE,
      maxFutureSkewSeconds: 300,
    });
    expect(r).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('accepts auth_date 60s in the future (within 300s default skew)', () => {
    const futureUnix = NOW_UNIX + 60;
    const fields = { ...VALID_FIELDS, auth_date: String(futureUnix) };
    const initData = buildInitData(BOT_TOKEN, fields);
    const r = verifyTelegramInitData(initData, BOT_TOKEN, {
      now: NOW_DATE,
      maxFutureSkewSeconds: 300,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts auth_date exactly 300s in the future (at boundary)', () => {
    const futureUnix = NOW_UNIX + 300;
    const fields = { ...VALID_FIELDS, auth_date: String(futureUnix) };
    const initData = buildInitData(BOT_TOKEN, fields);
    const r = verifyTelegramInitData(initData, BOT_TOKEN, {
      now: NOW_DATE,
      maxFutureSkewSeconds: 300,
    });
    // Exactly at boundary: diffSeconds === maxFutureSkewSeconds → NOT rejected (> check)
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-user
// ---------------------------------------------------------------------------

describe('verifyTelegramInitData — no-user', () => {
  it('returns no-user when the user field is absent but HMAC is valid', () => {
    // Build initData WITHOUT user field — still valid HMAC
    const fields: Record<string, string> = {
      auth_date: String(NOW_UNIX),
      query_id: 'AAAAAAAtest',
    };
    const initData = buildInitData(BOT_TOKEN, fields);
    const r = verifyTelegramInitData(initData, BOT_TOKEN, { now: NOW_DATE });
    expect(r).toMatchObject({ ok: false, reason: 'no-user' });
  });
});
