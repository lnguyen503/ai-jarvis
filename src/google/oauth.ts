/**
 * Google OAuth2 client wrapper.
 *
 * Loads client credentials from config (resolved from env), reads/writes the
 * refresh token to disk, and registers a token-refresh handler so the
 * persisted file stays current when googleapis auto-refreshes the access
 * token.
 *
 * Usage:
 *   const auth = await loadGoogleAuth(config, logger);
 *   if (!auth) { ...not configured / not authorised yet... }
 *   const calendar = google.calendar({ version: 'v3', auth });
 *
 * The auth CLI (`scripts/google-auth.ts`) is the only writer of the token
 * file under normal use; this module re-writes it on background refresh so
 * the next process restart picks up the rotated token.
 */

import fs from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import type { OAuth2Client, Credentials } from 'google-auth-library';
import type pino from 'pino';
import type { AppConfig, GoogleOAuthConfig } from '../config/schema.js';

/**
 * Scopes Jarvis requests.
 *
 *   - calendar / calendar.events — read + write calendar events
 *   - gmail.readonly              — search + read inbox (v1.7.12)
 *   - gmail.compose               — create drafts AND send them (v1.7.15)
 *                                   Intentionally NOT gmail.modify — we never
 *                                   want to grant delete / label / batch
 *                                   modify to this token. gmail.compose is
 *                                   the narrowest scope that covers our
 *                                   "stage a draft then send on explicit
 *                                   user approval" flow.
 *
 * Adding a scope here means existing users must re-run `npm run google-auth`
 * to re-consent; Google will not silently upgrade a saved refresh token.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

/**
 * Build a fresh OAuth2 client from config. Used by both the auth CLI (to
 * generate the consent URL) and `loadGoogleAuth` (to attach saved creds).
 *
 * Returns null when client_id or client_secret is missing — callers must
 * surface a clear "not configured" message rather than crashing.
 */
export function buildOAuthClient(oauthCfg: GoogleOAuthConfig): OAuth2Client | null {
  if (!oauthCfg.clientId || !oauthCfg.clientSecret) return null;
  return new google.auth.OAuth2({
    clientId: oauthCfg.clientId,
    clientSecret: oauthCfg.clientSecret,
    // Loopback redirect: the auth CLI binds an ephemeral local HTTP server
    // and substitutes the actual port at runtime. Production OAuth desktop
    // clients support http://127.0.0.1 with any port.
    redirectUri: 'http://127.0.0.1:0/callback',
  });
}

/**
 * Load an OAuth2 client with saved credentials, ready to call Google APIs.
 *
 * Returns null when:
 *   - clientId/clientSecret missing in config (not set up yet)
 *   - token file missing (auth CLI hasn't been run yet)
 *   - token file unreadable or malformed
 *
 * The token file is created by `scripts/google-auth.ts` after the user
 * completes the browser consent flow. This function never starts a flow; it
 * only loads what's already there.
 */
export async function loadGoogleAuth(
  config: AppConfig,
  logger: pino.Logger,
): Promise<OAuth2Client | null> {
  const log = logger.child({ component: 'google.oauth' });
  const oauthCfg = config.google.oauth;

  const client = buildOAuthClient(oauthCfg);
  if (!client) {
    log.debug({}, 'Google OAuth client not configured (missing clientId/clientSecret)');
    return null;
  }

  const tokenPath = path.resolve(oauthCfg.tokenPath);
  let raw: string;
  try {
    raw = await fs.readFile(tokenPath, 'utf8');
  } catch (err) {
    log.info(
      { tokenPath, err: (err as NodeJS.ErrnoException).code ?? String(err) },
      'Google token file not found — run `npm run google-auth` first',
    );
    return null;
  }

  let creds: Credentials;
  try {
    creds = JSON.parse(raw) as Credentials;
  } catch (err) {
    log.error(
      { tokenPath, err: err instanceof Error ? err.message : String(err) },
      'Google token file is not valid JSON',
    );
    return null;
  }

  if (!creds.refresh_token) {
    log.error(
      { tokenPath },
      'Google token file is missing refresh_token — re-run `npm run google-auth`',
    );
    return null;
  }

  client.setCredentials(creds);

  // googleapis auto-refreshes access tokens; persist the rotated creds so
  // future process restarts don't have to re-refresh on first call.
  client.on('tokens', (rotated) => {
    void persistRotatedTokens(tokenPath, creds, rotated, log);
  });

  log.info({ tokenPath }, 'Google OAuth credentials loaded');
  return client;
}

async function persistRotatedTokens(
  tokenPath: string,
  existing: Credentials,
  rotated: Credentials,
  log: pino.Logger,
): Promise<void> {
  // googleapis emits 'tokens' with only the rotated fields; merge to keep
  // the long-lived refresh_token (which it doesn't re-emit on refresh).
  const merged: Credentials = {
    ...existing,
    ...rotated,
    refresh_token: rotated.refresh_token ?? existing.refresh_token,
  };
  try {
    await writeTokenFile(tokenPath, merged);
    log.debug({}, 'Google tokens persisted after refresh');
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to persist rotated Google tokens — refresh will retry next call',
    );
  }
}

/**
 * Atomically write the token file with restrictive perms.
 * Used by the auth CLI on initial setup and on background refresh.
 */
export async function writeTokenFile(tokenPath: string, creds: Credentials): Promise<void> {
  const resolved = path.resolve(tokenPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await fs.rename(tmp, resolved);
}
