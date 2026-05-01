/**
 * Headless Chromium launcher (singleton).
 *
 * We launch ONE Chromium process for the whole Jarvis lifetime, then spin up
 * a fresh `BrowserContext` per tool call. A context is an isolated cookie
 * jar + storage + cache — closing it after each call is the "no persistent
 * login state" guarantee. Nothing from a previous browse_url call leaks
 * into the next one.
 *
 * Browser ≠ BrowserContext:
 *   - Browser is heavy (~100ms to launch, ~300MB binary already on disk)
 *   - Context is cheap (~10ms) and throwaway
 *
 * Shutdown: registered SIGINT/SIGTERM handler closes the browser. Also
 * exposed as `shutdownBrowser()` so the process entry-point can drive it
 * deterministically.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type pino from 'pino';

export interface LauncherOptions {
  headless: boolean;
  /** UA to advertise. Default is the Chromium default — "like Google" out of the box. */
  userAgent?: string;
  logger: pino.Logger;
}

let _browser: Browser | null = null;
let _launchPromise: Promise<Browser> | null = null;
let _shutdownRegistered = false;

/**
 * Get the shared browser — launches on first call, returns the cached
 * instance on subsequent calls. Concurrent callers share the same launch
 * promise, so we never launch twice.
 */
export async function getBrowser(opts: LauncherOptions): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launchPromise) return _launchPromise;

  opts.logger.info({ headless: opts.headless }, 'Launching Chromium');
  _launchPromise = chromium
    .launch({
      headless: opts.headless,
      // No extensions, no user data dir — we want the browser blank.
      args: [
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    })
    .then((b) => {
      _browser = b;
      b.on('disconnected', () => {
        opts.logger.warn({}, 'Chromium disconnected');
        _browser = null;
        _launchPromise = null;
      });
      if (!_shutdownRegistered) {
        _shutdownRegistered = true;
        const close = (): void => {
          shutdownBrowser(opts.logger).catch(() => {
            // ignore — we're exiting anyway
          });
        };
        process.once('SIGINT', close);
        process.once('SIGTERM', close);
      }
      return b;
    })
    .catch((err) => {
      _launchPromise = null;
      throw err;
    });

  return _launchPromise;
}

/**
 * Create a fresh incognito-style context. Caller MUST close it when done —
 * wrap in try/finally. Options are the per-request knobs; everything else
 * uses Chromium defaults.
 */
export async function newContext(
  browser: Browser,
  opts: {
    userAgent?: string;
    /** If true, downloads allowed (we don't use this today). */
    acceptDownloads?: boolean;
  } = {},
): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: opts.userAgent,
    acceptDownloads: opts.acceptDownloads ?? false,
    // Explicitly decline service workers — they can outlive the context
    // and are a subtle way for persistent state to survive "close".
    serviceWorkers: 'block',
    // No location/permission grants; stay anonymous.
    permissions: [],
    // Block saving credentials the browser might silently offer to store.
    bypassCSP: false,
    javaScriptEnabled: true,
  });
}

/**
 * Close the shared browser, if any. Safe to call repeatedly.
 */
export async function shutdownBrowser(logger: pino.Logger): Promise<void> {
  const b = _browser;
  _browser = null;
  _launchPromise = null;
  if (!b) return;
  logger.info({}, 'Closing Chromium');
  try {
    await b.close();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Browser close threw — already closed?',
    );
  }
}

/** Test-only: clear launcher state. */
export function _resetLauncher(): void {
  _browser = null;
  _launchPromise = null;
}
