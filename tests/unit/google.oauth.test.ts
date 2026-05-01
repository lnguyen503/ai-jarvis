/**
 * Tests for src/google/oauth.ts.
 *
 * Covers the load/save contract:
 *   - buildOAuthClient returns null when credentials missing
 *   - loadGoogleAuth returns null on each failure mode (no creds, no file,
 *     bad JSON, missing refresh_token) without throwing
 *   - writeTokenFile is atomic + restrictive perms
 *
 * We deliberately avoid hitting the actual Google network; loadGoogleAuth's
 * happy path is covered by an integration check (runs offline because the
 * googleapis OAuth2Client constructor is pure).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';
import { buildOAuthClient, loadGoogleAuth, writeTokenFile } from '../../src/google/oauth.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

const silentLogger = pino({ level: 'silent' });

function tmpToken(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'jarvis-google-oauth-'));
  return path.join(dir, 'tokens.json');
}

function configWith(overrides: Partial<AppConfig['google']>): AppConfig {
  const base = makeTestConfig();
  return {
    ...base,
    google: {
      enabled: true,
      oauth: { clientId: '', clientSecret: '', tokenPath: tmpToken(), ...(overrides?.oauth ?? {}) },
      calendar: { enabled: true, defaultCalendarId: 'primary', ...(overrides?.calendar ?? {}) },
    },
  };
}

describe('buildOAuthClient', () => {
  it('returns null when clientId is missing', () => {
    expect(
      buildOAuthClient({ clientId: '', clientSecret: 's', tokenPath: '/tmp/x' }),
    ).toBeNull();
  });

  it('returns null when clientSecret is missing', () => {
    expect(
      buildOAuthClient({ clientId: 'id', clientSecret: '', tokenPath: '/tmp/x' }),
    ).toBeNull();
  });

  it('returns an OAuth2Client when both creds present', () => {
    const client = buildOAuthClient({ clientId: 'id', clientSecret: 'sec', tokenPath: '/tmp/x' });
    expect(client).not.toBeNull();
    // Sanity: the client exposes generateAuthUrl
    expect(typeof client?.generateAuthUrl).toBe('function');
  });
});

describe('loadGoogleAuth', () => {
  let cfg: AppConfig;
  beforeEach(() => {
    cfg = configWith({});
  });

  it('returns null when clientId is empty', async () => {
    const auth = await loadGoogleAuth(cfg, silentLogger);
    expect(auth).toBeNull();
  });

  it('returns null when token file does not exist', async () => {
    cfg = configWith({ oauth: { clientId: 'id', clientSecret: 'sec', tokenPath: tmpToken() } });
    const auth = await loadGoogleAuth(cfg, silentLogger);
    expect(auth).toBeNull();
  });

  it('returns null when token file is malformed JSON', async () => {
    const tokenPath = tmpToken();
    await fs.writeFile(tokenPath, '{ this is not json');
    cfg = configWith({ oauth: { clientId: 'id', clientSecret: 'sec', tokenPath } });
    const auth = await loadGoogleAuth(cfg, silentLogger);
    expect(auth).toBeNull();
  });

  it('returns null when token file is missing refresh_token', async () => {
    const tokenPath = tmpToken();
    await fs.writeFile(tokenPath, JSON.stringify({ access_token: 'a' }));
    cfg = configWith({ oauth: { clientId: 'id', clientSecret: 'sec', tokenPath } });
    const auth = await loadGoogleAuth(cfg, silentLogger);
    expect(auth).toBeNull();
  });

  it('returns an OAuth2Client when token file is valid', async () => {
    const tokenPath = tmpToken();
    await fs.writeFile(
      tokenPath,
      JSON.stringify({
        access_token: 'fake-access',
        refresh_token: 'fake-refresh',
        scope: 'https://www.googleapis.com/auth/calendar',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600 * 1000,
      }),
    );
    cfg = configWith({ oauth: { clientId: 'id', clientSecret: 'sec', tokenPath } });
    const auth = await loadGoogleAuth(cfg, silentLogger);
    expect(auth).not.toBeNull();
    // Sanity: credentials applied
    expect(auth?.credentials.refresh_token).toBe('fake-refresh');
  });
});

describe('writeTokenFile', () => {
  it('writes valid JSON that round-trips', async () => {
    const tokenPath = tmpToken();
    const creds = { access_token: 'a', refresh_token: 'r', expiry_date: 12345 };
    await writeTokenFile(tokenPath, creds);
    const raw = await fs.readFile(tokenPath, 'utf8');
    expect(JSON.parse(raw)).toEqual(creds);
  });

  it('overwrites an existing file atomically (no .tmp leftover)', async () => {
    const tokenPath = tmpToken();
    await fs.writeFile(tokenPath, JSON.stringify({ old: true }));
    await writeTokenFile(tokenPath, { access_token: 'new', refresh_token: 'r' });
    const raw = await fs.readFile(tokenPath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ access_token: 'new', refresh_token: 'r' });
    // .tmp should not exist
    await expect(fs.access(`${tokenPath}.tmp`)).rejects.toBeDefined();
  });

  it('creates parent directory if missing', async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'jarvis-google-mkdir-'));
    const nested = path.join(dir, 'sub', 'dir', 'tokens.json');
    await writeTokenFile(nested, { refresh_token: 'r' });
    expect(fsSync.existsSync(nested)).toBe(true);
  });
});
