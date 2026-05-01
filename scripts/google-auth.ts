/**
 * One-time Google OAuth setup CLI.
 *
 * Run: `npm run google-auth`
 *
 * Steps performed:
 *   1. Read GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET from env (via dotenv)
 *      and the rest of the config from config/config.json.
 *   2. Bind a local HTTP listener on an ephemeral port.
 *   3. Build the Google consent URL with that port baked into redirect_uri,
 *      print + open it in the user's browser.
 *   4. Wait for Google to redirect back to /callback with `?code=...`.
 *   5. Exchange the code for refresh + access tokens.
 *   6. Persist them to config.google.oauth.tokenPath (default
 *      ./data/google-tokens.json) with mode 0o600.
 *
 * After this completes, restart Jarvis — calendar_list_events will pick up
 * the new credentials.
 */

import 'dotenv/config';
import http from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import { google } from 'googleapis';
import { loadConfig } from '../src/config/index.js';
import { GOOGLE_SCOPES, writeTokenFile } from '../src/google/oauth.js';

function showSetupHint(detail?: string): never {
  console.error(
    (detail ? `${detail}\n\n` : '') +
      'Google OAuth credentials are not configured.\n' +
      '\n' +
      'Setup steps:\n' +
      '  1. Go to https://console.cloud.google.com/apis/credentials\n' +
      '  2. Create OAuth client ID, type "Desktop app".\n' +
      '  3. Add the client ID + secret to your .env file (D:\\ai-jarvis\\.env):\n' +
      '       GOOGLE_OAUTH_CLIENT_ID=...\n' +
      '       GOOGLE_OAUTH_CLIENT_SECRET=...\n' +
      '  4. Re-run `npm run google-auth`.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('GOOGLE_OAUTH_CLIENT_ID') || msg.includes('GOOGLE_OAUTH_CLIENT_SECRET')) {
      showSetupHint();
    }
    throw err;
  }
  const oauthCfg = config.google.oauth;

  if (!oauthCfg.clientId || !oauthCfg.clientSecret) {
    showSetupHint();
  }

  // Bind first so we know our port; then build the OAuth client with the
  // matching redirect URI. Google's loopback flow allows any port on
  // 127.0.0.1 as long as redirect_uri matches what was sent in the consent
  // request — the registered URI in Cloud Console is just `http://127.0.0.1`
  // (no port), per their docs.
  const { server, port, codePromise } = await startLoopbackServer();

  const client = new google.auth.OAuth2({
    clientId: oauthCfg.clientId,
    clientSecret: oauthCfg.clientSecret,
    redirectUri: `http://127.0.0.1:${port}/callback`,
  });

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',     // request a refresh_token
    prompt: 'consent',          // force consent so refresh_token is always returned
    scope: GOOGLE_SCOPES,
  });

  console.log('Open this URL in your browser to authorise Jarvis:');
  console.log('');
  console.log(authUrl);
  console.log('');
  console.log(`Listening on http://127.0.0.1:${port} for the callback…`);

  // Best-effort browser open. If it fails (no DE, headless), the user can
  // still copy the URL manually.
  openInBrowser(authUrl);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      'Google did not return a refresh_token. This usually means you have ' +
        'previously authorised this client without `prompt=consent`. Revoke ' +
        'access at https://myaccount.google.com/permissions and re-run.',
    );
    process.exit(2);
  }

  await writeTokenFile(oauthCfg.tokenPath, tokens);
  console.log('');
  console.log(`Saved refresh + access tokens to ${oauthCfg.tokenPath}`);
  console.log('Restart Jarvis to enable calendar tools.');
}

/**
 * Bind an ephemeral local HTTP server, return its port and a promise that
 * resolves with the OAuth `code` query param when Google redirects to it.
 *
 * Rejects if the callback returns an `error=` instead of a code.
 */
async function startLoopbackServer(): Promise<{
  server: http.Server;
  port: number;
  codePromise: Promise<string>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1`);
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`OAuth error: ${error}. You can close this tab.`);
      rejectCode(new Error(`OAuth callback returned error: ${error}`));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing ?code parameter.');
      rejectCode(new Error('OAuth callback missing code'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorisation complete. You can close this tab and return to the terminal.');
    resolveCode(code);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind loopback server');
  }
  return { server, port: address.port, codePromise };
}

function openInBrowser(url: string): void {
  // Cross-platform: rely on `start` (Windows), `open` (macOS), or
  // `xdg-open` (Linux). All silently no-op if absent.
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Ignore errors — the URL is also printed for manual open.
  });
}

main().catch((err) => {
  console.error('Auth failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
