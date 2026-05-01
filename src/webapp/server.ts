/**
 * Telegram Web App Express server (v1.13.0).
 *
 * Exports createWebappServer(deps) → { start, stop }.
 * Mirrors createHealthServer in src/gateway/health.ts.
 *
 * Security posture:
 *   - Binds to WEBAPP_BIND_ADDR (127.0.0.1) only — cloudflared terminates TLS in front.
 *   - Strict CSP for HTML responses.
 *   - In-memory per-IP rate limiter (60 req/min/IP).
 *   - Per-IP debounced audit rows for auth failures (1 row / 60s / IP, LRU 1000).
 *   - Authorization: tma <initData> ONLY — no query-string fallback (R5).
 *   - Port-conflict (EADDRINUSE) returns a noop shim instead of crashing (R12.2).
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SchedulerApi } from '../scheduler/index.js';
import { child } from '../logger/index.js';
import { verifyTelegramInitData } from './auth.js';
import { mountItemsRoutes, type AuditAuthFailureFn } from './itemsRoute.js';
import { mountConfigRoute } from './items.config.js';
import { mountDebatesRoutes } from './debatesRoute.js';
import { mountScheduledRoutes } from './scheduledRoute.js';
import { mountMemoryRoutes } from './memoryRoute.js';
import { mountAuditRoutes } from './auditRoute.js';
import { mountCoachRoutes } from './coachRoute.js';
import { mountAvengersRoutes } from './avengersRoute.js';
import { mountIdentityRoute } from './identityRoute.js';
import type { BotIdentity } from '../config/botIdentity.js';

const log = child({ component: 'webapp.server' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Loopback-only bind address for the Web App Express server.
 *
 * MUST stay 127.0.0.1. cloudflared (or any future production HTTPS terminator
 * such as nginx + Let's Encrypt) connects to this loopback address; the
 * outside world only ever sees the tunnel/proxy endpoint, which is the
 * place where TLS terminates and rate limiting / WAF rules apply.
 *
 * Binding 0.0.0.0 here would expose the unauthenticated /webapp/* static
 * routes (and any future /api/webapp/* routes) directly to the host's LAN
 * AND any container/VM network interface, bypassing the tunnel's CSP, rate
 * limit, and audit chokepoints.
 *
 * This invariant is part of v1.13.0's security posture; do NOT relax without
 * a corresponding ADR amendment that explicitly redesigns the threat model.
 */
const WEBAPP_BIND_ADDR = '127.0.0.1';

// ---------------------------------------------------------------------------
// Project-root resolution (R10)
// ---------------------------------------------------------------------------

// Two parents up from this file: src/webapp/server.ts → src/ → project root
// Same math applies after tsc: dist/webapp/server.js → dist/ → project root
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * Resolve staticDir relative to project root unless already absolute.
 * Prevents cwd-dependent resolution when pm2 is started from an arbitrary dir.
 */
function resolveStaticDir(configValue: string): string {
  if (path.isAbsolute(configValue)) return configValue;
  return path.resolve(PROJECT_ROOT, configValue);
}

// ---------------------------------------------------------------------------
// Rate limiter (in-memory per-IP sliding window, ~30 LOC)
// ---------------------------------------------------------------------------

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

class RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly limitPerMin: number;

  constructor(limitPerMin = 60) {
    this.limitPerMin = limitPerMin;
  }

  /** Returns true when the request should be rejected (limit exceeded). */
  check(ip: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const existing = this.buckets.get(ip);

    if (!existing || now - existing.windowStart >= windowMs) {
      this.buckets.set(ip, { windowStart: now, count: 1 });
      return false; // allow
    }

    existing.count += 1;
    if (existing.count > this.limitPerMin) {
      return true; // reject
    }
    return false; // allow
  }

  clear(): void {
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Audit debounce (per-IP, 60s window, LRU-bounded at 1000, R6)
// ---------------------------------------------------------------------------

interface DebounceEntry {
  lastAuditAt: number;
  suppressedCount: number;
  suppressedSince: number;
  /** DB row ID of the open audit row for this window — updated as suppressions accumulate. */
  auditRowId: number | null;
}

const DEBOUNCE_WINDOW_MS = 60_000;
const DEBOUNCE_MAX_ENTRIES = 1000;

/**
 * Per-IP audit debouncer (R6).
 *
 * On first request in a window: signals EMIT (caller inserts the audit row and
 * stores the row ID back via setRowId). On subsequent requests in the same
 * 60-second window: signals SUPPRESS and returns the row ID so the caller can
 * UPDATE the existing row's suppressedCount in place. This guarantees the final
 * audit row reflects the total number of suppressed events in the window.
 */
class AuditDebouncer {
  // Map insertion-order is our LRU proxy: oldest entries are first.
  private readonly map = new Map<string, DebounceEntry>();

  /**
   * Call on each auth failure.
   * Returns { emit:true } on the first request in a window (caller should insert
   * a row and then call setRowId). Returns { emit:false, rowId, suppressedCount }
   * on subsequent requests (caller should UPDATE that row's detail).
   */
  tick(
    partialIp: string,
  ):
    | { emit: true; suppressedSince: string }
    | { emit: false; rowId: number | null; suppressedCount: number; suppressedSince: string } {
    const now = Date.now();
    const existing = this.map.get(partialIp);

    if (!existing || now - existing.lastAuditAt >= DEBOUNCE_WINDOW_MS) {
      // New window — evict oldest if at LRU cap
      if (this.map.size >= DEBOUNCE_MAX_ENTRIES && !this.map.has(partialIp)) {
        const firstKey = this.map.keys().next().value;
        if (firstKey !== undefined) this.map.delete(firstKey);
      }
      this.map.set(partialIp, {
        lastAuditAt: now,
        suppressedCount: 0,
        suppressedSince: now,
        auditRowId: null,
      });
      return { emit: true, suppressedSince: new Date(now).toISOString() };
    }

    // Suppress — increment counter; keep LRU position fresh
    existing.suppressedCount += 1;
    this.map.delete(partialIp);
    this.map.set(partialIp, existing);
    return {
      emit: false,
      rowId: existing.auditRowId,
      suppressedCount: existing.suppressedCount,
      suppressedSince: new Date(existing.suppressedSince).toISOString(),
    };
  }

  /** Call after inserting the audit row to store the row ID for future updates. */
  setRowId(partialIp: string, rowId: number): void {
    const entry = this.map.get(partialIp);
    if (entry) entry.auditRowId = rowId;
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// IP helpers (R6.1: partial IP = first 3 octets for IPv4, else verbatim)
// ---------------------------------------------------------------------------

function partialIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  return ip; // IPv6 or unknown — store as-is
}

function userAgentHash(ua: string | undefined): string {
  return createHash('sha1').update(ua ?? '').digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Deps + exported interface
// ---------------------------------------------------------------------------

export interface WebappServerDeps {
  config: AppConfig;
  version: string;
  logger?: ReturnType<typeof child>;
  memory: MemoryApi;
  /**
   * v1.15.0 D9 — returns the bot's Telegram username (e.g. 'jarvis').
   *
   * Called lazily at request time so the webapp server can be constructed
   * before gateway.start() resolves the username via getMe(). The callback
   * is provided by the gateway (which caches the result in its own start()).
   *
   * Returns an empty string if getMe() has not yet resolved or failed.
   */
  getBotUsername?: () => string;
  /**
   * v1.17.0 Fix 1 (M1 + ADR 017 §7 Risk #8): scheduler for reload after webapp
   * task mutations (create / update / delete). Late-bound — the scheduler is
   * constructed AFTER the gateway in src/index.ts, so this field is optional
   * and may be null/undefined at construction time. Call setScheduler() once
   * the scheduler is ready, mirroring the chat-side setScheduler() pattern.
   *
   * Use Pick<SchedulerApi, 'reload'> to avoid coupling the whole interface.
   */
  scheduler?: Pick<SchedulerApi, 'reload'> | null;
  /**
   * v1.21.0 ADR 021 Pillar 4 — Bot identity for per-bot port resolution and
   * the /api/webapp/identity endpoint. Optional: when not provided (pre-v1.21.0
   * boot without identity wiring), config.webapp.port is used unchanged and the
   * identity route returns 'ai-jarvis' defaults.
   */
  identity?: BotIdentity | null;
}

export interface WebappServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Late-bind the scheduler for reload-after-mutate (v1.17.0 Fix 1). */
  setScheduler(s: Pick<SchedulerApi, 'reload'> | null): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebappServer(deps: WebappServerDeps): WebappServer {
  const { config, memory } = deps;
  const serverLog = deps.logger ?? log;

  // v1.21.0 Pillar 4: use identity.webappPort if provided; fall back to config
  // default (7879) for legacy single-bot deployments without identity wiring.
  const port = deps.identity?.webappPort ?? config.webapp.port;
  const staticDir = resolveStaticDir(config.webapp.staticDir);
  const maxAgeSeconds = config.webapp.initDataMaxAgeSeconds;
  const maxFutureSkewSeconds = config.webapp.initDataMaxFutureSkewSeconds;
  const botToken = config.telegram.botToken;

  // v1.17.0 Fix 1: mutable scheduler reference for late-binding. The scheduled
  // routes mutate this wrapper's .reload pointer when setScheduler() is called —
  // same pattern as schedulerApiRef in src/index.ts + gateway.setScheduler().
  const schedulerRef: { reload(): void } = {
    reload(): void { /* populated via setScheduler() after scheduler is constructed */ },
  };
  if (deps.scheduler) {
    schedulerRef.reload = () => deps.scheduler!.reload();
  }

  const rateLimiter = new RateLimiter(60);
  const debouncer = new AuditDebouncer();

  // -------------------------------------------------------------------------
  // Audit helper (R6 + Fix 3: debounced per-IP, updates suppressedCount in-place)
  //
  // Defined here — before any route registration — so it can be passed into
  // mountItemsRoutes as a dep. The echo handler also calls it directly. Both
  // surfaces share the same AuditDebouncer instance (debouncer), so a burst
  // of failures across echo + items routes deduplicates correctly into a single
  // audit row per IP per 60s window.
  // -------------------------------------------------------------------------
  function emitAuditIfDue(
    pIp: string,
    reason: string,
    req: Request,
  ): void {
    const tick = debouncer.tick(pIp);

    if (tick.emit) {
      // First request in window — insert row and store its ID
      try {
        // suppressedCount starts at 1 (this row represents the first event).
        // Subsequent events in the same 60s window increment it via updateDetail.
        // A final value of N means N total events were observed in the window.
        const rowId = memory.auditLog.insertReturningId({
          category: 'webapp.auth_failure',
          detail: {
            ip: pIp,
            reason,
            pathHit: req.path,
            userAgentHash: userAgentHash(req.headers['user-agent']),
            suppressedSince: tick.suppressedSince,
            suppressedCount: 1,
          },
        });
        debouncer.setRowId(pIp, rowId);
      } catch (err) {
        serverLog.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to insert webapp.auth_failure audit row',
        );
      }
    } else {
      // Suppressed — update the existing row's suppressedCount in place
      if (tick.rowId !== null) {
        try {
          // suppressedCount: 1 (first emit) + tick.suppressedCount (number of
          // suppressions so far) = total events represented by this audit row.
          memory.auditLog.updateDetail(tick.rowId, {
            ip: pIp,
            reason,
            pathHit: req.path,
            userAgentHash: userAgentHash(req.headers['user-agent']),
            suppressedSince: tick.suppressedSince,
            suppressedCount: tick.suppressedCount + 1,
          });
        } catch (err) {
          serverLog.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to update webapp.auth_failure audit row suppressedCount',
          );
        }
      }
    }
  }

  /** Audit-failure callback passed into mountItemsRoutes (ADR 009 Fix 3). */
  const auditAuthFailure: AuditAuthFailureFn = (req, reason) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '0.0.0.0';
    emitAuditIfDue(partialIp(ip), reason, req);
  };

  const app = express();

  // v1.13.0 R-FIX-1 — Trust the loopback proxy hop only. cloudflared (and any
  // future production HTTPS terminator) connects from 127.0.0.1 to our Express
  // server; trusting that single hop tells Express to read X-Forwarded-For for
  // the client's real IP. ONLY trust 'loopback' — NOT 'true' (which would trust
  // any X-Forwarded-For value, including a forged one from a misconfigured
  // upstream). Without this, req.ip == '127.0.0.1' for every request and per-IP
  // rate limit / audit debounce become globally shared.
  app.set('trust proxy', 'loopback');

  // -------------------------------------------------------------------------
  // Rate limiter middleware
  // -------------------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '0.0.0.0';
    if (rateLimiter.check(ip)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ ok: false, error: 'Too Many Requests' });
      return;
    }
    next();
  });

  // -------------------------------------------------------------------------
  // Static file serving: GET /webapp/*
  // -------------------------------------------------------------------------
  app.use(
    '/webapp',
    express.static(staticDir, {
      maxAge: 0,
      setHeaders(res: Response, filePath: string) {
        const isHtml = filePath.endsWith('.html');
        if (isHtml) {
          res.setHeader('Cache-Control', 'no-cache');
          // CSP per ADR 008 Decision 7 + v1.13.1 fix.
          //
          // frame-ancestors must allow Telegram clients to embed the page:
          //   - https://web.telegram.org → Telegram Web's iframe origin
          //   - https://*.telegram.org   → other Telegram-owned subdomains
          //   - native mobile/desktop Telegram clients use WebView (not a
          //     browser iframe) — frame-ancestors doesn't apply there, so
          //     the directive is purely a Telegram-Web concern.
          //
          // Setting frame-ancestors 'none' blocks legitimate Telegram embedding
          // and produces "refused to connect" errors in Telegram Web.
          // Setting frame-ancestors * removes the clickjacking defense.
          // The middle ground below allows Telegram only.
          //
          // Clickjacking surface is bounded: an attacker iframing this page
          // from outside Telegram cannot produce a valid initData (HMAC over
          // the bot's token), so they can't reach any authenticated state.
          // The page also degrades to its unauth fallback when initData is
          // empty. Belt-and-braces; the directive blocks attacker iframes.
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; " +
            "script-src 'self' https://telegram.org; " +
            "style-src 'self' 'unsafe-inline'; " +
            "connect-src 'self'; " +
            "img-src 'self' data:; " +
            "frame-ancestors https://web.telegram.org https://*.telegram.org; " +
            "base-uri 'self'; " +
            "form-action 'self'",
          );
        } else {
          // CSS, JS, images: short-lived public cache
          res.setHeader('Cache-Control', 'public, max-age=300');
        }
      },
    }),
  );

  // -------------------------------------------------------------------------
  // Echo endpoint: GET /api/webapp/echo
  // -------------------------------------------------------------------------
  app.get('/api/webapp/echo', (req: Request, res: Response) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '0.0.0.0';
    const pIp = partialIp(ip);

    // Authorization: tma <initData> only (R5 — no query-string fallback)
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('tma ')) {
      emitAuditIfDue(pIp, 'no-auth-header', req);
      res.status(401).json({
        ok: false,
        code: 'AUTH_FAILED',
        error: 'Authentication failed',
        reason: 'no-auth-header',
      });
      return;
    }

    const initData = authHeader.slice(4); // strip 'tma '

    const result = verifyTelegramInitData(initData, botToken, {
      maxAgeSeconds,
      maxFutureSkewSeconds,
    });

    if (!result.ok) {
      emitAuditIfDue(pIp, result.reason, req);
      res.status(401).json({
        ok: false,
        code: 'AUTH_FAILED',
        error: 'Authentication failed',
        reason: result.reason,
      });
      return;
    }

    const { user, chat, authDate } = result.data;
    // R3: add ok:true flag to success response for envelope parity with items routes
    res.status(200).json({
      ok: true,
      userId: user.id,
      username: user.username ?? null,
      chatId: chat?.id ?? null,
      authDate: authDate.toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // Organize items routes: GET /api/webapp/items, GET /api/webapp/items/:id
  // -------------------------------------------------------------------------
  mountItemsRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
  });

  // -------------------------------------------------------------------------
  // Debates routes: GET /api/webapp/debates, /debates/:id, /debates/:id/stream
  // (v1.16.0 D1 + D3 + D5)
  // -------------------------------------------------------------------------
  mountDebatesRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
  });

  // -------------------------------------------------------------------------
  // Scheduled tasks routes: GET|POST|PATCH|DELETE /api/webapp/scheduled (v1.17.0)
  // scheduler: schedulerRef wrapper — populated via setScheduler() at step 10 in
  // src/index.ts (same late-binding pattern as gateway.setScheduler).
  // -------------------------------------------------------------------------
  mountScheduledRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
    scheduler: schedulerRef,
  });

  // -------------------------------------------------------------------------
  // Memory entry routes: GET|POST|PATCH|DELETE /api/webapp/memory (v1.17.0)
  // dataDir: directory containing the SQLite db file (same dir as memories/)
  // -------------------------------------------------------------------------
  mountMemoryRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
    dataDir: path.dirname(config.memory.dbPath),
  });

  // -------------------------------------------------------------------------
  // Audit log routes: GET /api/webapp/audit (v1.17.0)
  // -------------------------------------------------------------------------
  mountAuditRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
  });

  // -------------------------------------------------------------------------
  // Coach routes: POST /api/webapp/coach/setup, /api/webapp/coach/reset-memory
  // (v1.18.0 ADR 018)
  //
  // scheduler: schedulerRef wrapper — populated via setScheduler() at step 10
  // in src/index.ts. Same late-binding pattern as scheduledRoute. The setup
  // endpoint calls scheduler.reload() after upsertCoachTask so the new coach
  // task fires immediately without a pm2 restart (P2 fix Item 3, Scalability
  // WARNING-1.18.0.A — same trap as v1.17.0 WARNING-1.17.0.A).
  // -------------------------------------------------------------------------
  mountCoachRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
    scheduler: schedulerRef,
  });

  // -------------------------------------------------------------------------
  // Avengers Operations Dashboard routes (v1.22.27)
  //   GET /api/webapp/avengers/plans?chatId=N
  //   GET /api/webapp/avengers/plans/:id
  //   GET /api/webapp/avengers/plans/:id/deliverable
  // -------------------------------------------------------------------------
  mountAvengersRoutes(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
  });

  // -------------------------------------------------------------------------
  // Identity route: GET /api/webapp/identity (v1.21.0 Pillar 4 D13 + D15)
  // Returns { ok, botName, scope } for the hub banner identity badge.
  // -------------------------------------------------------------------------
  mountIdentityRoute(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
    identity: deps.identity ?? null,
  });

  // -------------------------------------------------------------------------
  // Config route: GET /api/webapp/config (v1.15.0 D9)
  // Read-only metadata — no audit row. botUsername resolved lazily at request
  // time via getBotUsername() callback (safe: getMe() completes before any
  // client request can arrive since the bot's long-poll loop and the webapp
  // server both start in gateway.start() before the bot is open to traffic).
  // -------------------------------------------------------------------------
  mountConfigRoute(app, {
    config,
    memory,
    botToken,
    auditAuthFailure,
    get botUsername() {
      return deps.getBotUsername ? deps.getBotUsername() : '';
    },
  });

  // -------------------------------------------------------------------------
  // PayloadTooLargeError → unified envelope (QA M2, v1.14.3 Fix 1)
  //
  // Express's express.json({ limit }) throws a PayloadTooLargeError before the
  // route handler runs when the request body exceeds the configured limit.
  // Without this handler the error falls through to Express's default error
  // handler which emits a plain-HTML 413 — inconsistent with the rest of the
  // API's { ok, code, error } envelope posture.
  //
  // This middleware MUST be registered after all route middleware (which mount
  // their own express.json() instances inline) so that the err propagated by
  // next(err) is caught here.
  // -------------------------------------------------------------------------
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction): void => {
    if (err && err.type === 'entity.too.large') {
      res.status(413).json({
        ok: false,
        code: 'BODY_TOO_LARGE',
        error: 'Request body exceeds 32KB limit',
      });
      return;
    }
    next(err);
  });

  // -------------------------------------------------------------------------
  // 404 catchall
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Not Found' });
  });

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------
  let server: Server | null = null;
  let disabled = false;

  return {
    async start(): Promise<void> {
      if (disabled) return;
      return new Promise((resolve) => {
        server = app.listen(port, WEBAPP_BIND_ADDR, () => {
          serverLog.info(
            { port, staticDir, bindAddr: WEBAPP_BIND_ADDR },
            'Web App server listening on 127.0.0.1',
          );
          resolve();
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            serverLog.warn(
              { port, err: err.message },
              'Web App server EADDRINUSE — port already in use; webapp disabled for this process. The /webapp command will report the disabled state.',
            );
            disabled = true;
            resolve(); // do NOT reject; process continues (R12.2)
          } else {
            serverLog.error({ err: err.message, port }, 'Web App server failed to start');
            resolve(); // non-fatal — log and continue
          }
        });
      });
    },

    async stop(): Promise<void> {
      debouncer.clear();
      rateLimiter.clear();
      if (!server) return;
      return new Promise((resolve) => {
        server!.close(() => {
          serverLog.info({}, 'Web App server stopped');
          resolve();
        });
      });
    },

    /**
     * v1.17.0 Fix 1: late-bind the scheduler after it is constructed in
     * src/index.ts. Mirrors gateway.setScheduler() pattern.
     */
    setScheduler(s: Pick<SchedulerApi, 'reload'> | null): void {
      if (s) {
        schedulerRef.reload = () => s.reload();
      } else {
        schedulerRef.reload = () => { /* no-op: scheduler cleared */ };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Export disabled-state flag helper (for /webapp command to check)
// ---------------------------------------------------------------------------
// Note: the disabled state is per-instance. Dev-B's /webapp command reads it
// by checking whether the server's start() was a noop (disabled=true flag
// surfaced via the webappServer instance if needed in future).
