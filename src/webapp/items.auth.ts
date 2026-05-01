/**
 * Webapp items auth chain + ConflictTracker (v1.16.0 R7).
 *
 * Mechanically extracted from items.shared.ts as Phase 2 commit -1.
 * Zero logic change — bug-for-bug compatible with the original code.
 *
 * Contents (single source of truth for auth invariant):
 *   - authenticateRequest() — inline HMAC+allowlist auth chain
 *   - ConflictTracker     — per-userId×per-itemId LRU for recent 412s
 *   - conflictTracker     — module-scoped singleton
 *   - readIfMatchHeader() — header parsing helper
 *   - readIfMatchRaw()    — raw If-Match for audit
 *   - readForceOverride() — X-Force-Override header reader
 *   - AuthOk / AuthFail   — result union types
 *   - ItemsRouteDeps      — shared deps interface (auth-related)
 *   - AuditAuthFailureFn  — callback type
 *
 * Downstream: items.create.ts / items.read.ts / items.mutate.ts /
 *             items.complete.ts / items.config.ts / itemsRoute.ts /
 *             debate.shared.ts all import auth symbols from HERE.
 *
 * ADR 016 R7 binding: items.shared.ts HEAD was 417 LOC; this extraction
 * moves ~170 LOC here, leaving items.shared.ts at ~250 LOC — both under
 * the §13 500-LOC threshold.
 */

import { type Request, type Response } from 'express';
import {
  IF_MATCH_HEADER,
  FORCE_OVERRIDE_HEADER,
  FORCE_OVERRIDE_VALUE,
} from './etag-headers.js';
import { child } from '../logger/index.js';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { verifyTelegramInitData } from './auth.js';

const log = child({ component: 'webapp.itemsAuth' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback type for emitting a webapp.auth_failure audit row.
 *
 * Debouncing + DB insert/update live in server.ts where the AuditDebouncer
 * instance lives. This indirection keeps items routes decoupled from server
 * internals (ADR 009 R1).
 */
export type AuditAuthFailureFn = (req: Request, reason: string) => void;

export interface ItemsRouteDeps {
  config: AppConfig;
  memory: MemoryApi;
  /** Bot token supplied at construction so tests can substitute. */
  botToken: string;
  /**
   * Emit a webapp.auth_failure audit row for 401 responses.
   *
   * Debouncing is handled by the implementation (server.ts); items routes
   * just call this on each 401. NOT called for 403 (allowlist miss) — those
   * are registered-user behaviour, not forgery attempts.
   */
  auditAuthFailure: AuditAuthFailureFn;
}

export interface AuthOk {
  ok: true;
  userId: number;
}
export interface AuthFail {
  ok: false;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Inline auth chain shared by both GET and mutation handlers:
 *   1. Require "Authorization: tma <initData>" header.
 *   2. Verify HMAC + timestamp using the tighter 1h replay window (R4).
 *   3. Allowlist guard — verified userId must be in allowedUserIds (R8).
 *
 * On failure, sends the unified error response and returns {ok:false}.
 * On success, returns {ok:true, userId}.
 */
export function authenticateRequest(
  req: Request,
  res: Response,
  deps: ItemsRouteDeps,
): AuthOk | AuthFail {
  const authHeader = req.header('authorization') ?? '';
  if (!authHeader.startsWith('tma ')) {
    deps.auditAuthFailure(req, 'no-auth-header');
    res.status(401).json({
      ok: false,
      code: 'AUTH_FAILED',
      error: 'Authentication failed',
      reason: 'no-auth-header',
    });
    return { ok: false };
  }

  const initData = authHeader.slice(4); // strip 'tma '
  const verified = verifyTelegramInitData(initData, deps.botToken, {
    maxAgeSeconds: deps.config.webapp.itemsInitDataMaxAgeSeconds,
    maxFutureSkewSeconds: deps.config.webapp.initDataMaxFutureSkewSeconds,
  });

  if (!verified.ok) {
    deps.auditAuthFailure(req, verified.reason);
    res.status(401).json({
      ok: false,
      code: 'AUTH_FAILED',
      error: 'Authentication failed',
      reason: verified.reason,
    });
    return { ok: false };
  }

  const userId = verified.data.user.id;

  // Allowlist guard (R8) — defense in depth after HMAC verification
  if (!deps.config.telegram.allowedUserIds.includes(userId)) {
    log.warn({ userId, route: req.path }, 'webapp items route: user not in allowlist');
    res.status(403).json({
      ok: false,
      code: 'NOT_ALLOWED',
      error: 'User not in allowlist',
    });
    return { ok: false };
  }

  return { ok: true, userId };
}

// ---------------------------------------------------------------------------
// Conflict tracker — in-memory LRU for recent 412s (v1.14.4 R2)
// ---------------------------------------------------------------------------

/**
 * Per-userId × per-itemId LRU tracker for recent 412 Precondition Failed responses.
 *
 * Purpose: distinguish four forensic populations in the audit row (R2):
 *   1. forced: true  + bypassAfter412: true  → intentional Save Anyway after 412
 *   2. forced: true  + bypassAfter412: false → force-probe (X-Force-Override without a 412)
 *   3. forced: false + bypassAfter412: true  → header-stripped (transport dropped X-Force-Override)
 *   4. forced: false + bypassAfter412: false → naïve no-If-Match (old client / no recent conflict)
 *
 * State is lost on process restart — acceptable; the tracker is forensic, not correctness.
 * Cap: 100 entries; TTL: 5 minutes. Map is insertion-ordered (oldest-first) for O(1) LRU eviction.
 */
export class ConflictTracker {
  private readonly map = new Map<string, number>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxEntries = 100;

  /** Record that a 412 was just returned for this user+item pair. */
  noteConflict(userId: number, itemId: string): void {
    this.evictExpired();
    const key = `${userId}:${itemId}`;
    // Re-insert to update insertion order (move to "most recent").
    this.map.delete(key);
    this.map.set(key, Date.now());
    // LRU cap: evict oldest entry when over limit.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
  }

  /** True if a 412 was returned for this user+item within the TTL window. */
  hasRecentConflict(userId: number, itemId: string): boolean {
    this.evictExpired();
    const key = `${userId}:${itemId}`;
    const ts = this.map.get(key);
    return ts !== undefined && Date.now() - ts < this.ttlMs;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, ts] of this.map) {
      if (now - ts >= this.ttlMs) this.map.delete(key);
      else break; // Map is insertion-ordered; oldest first — stop at first non-expired
    }
  }
}

/** Module-scoped singleton. One per webapp process (single-instance deployment). */
export const conflictTracker = new ConflictTracker();

// ---------------------------------------------------------------------------
// If-Match / Force-Override header helpers (v1.14.4 RA1)
// ---------------------------------------------------------------------------

/**
 * Read and sanitize the If-Match request header.
 *
 * Returns the trimmed value, or null when:
 *   - Header is absent.
 *   - Header is `*` (we support only strong ETags; `*` means "any" and is treated as absent).
 *
 * No list-of-ETags parsing — we use strong ETags only (ADR 012 D3).
 */
export function readIfMatchHeader(req: Request): string | null {
  const raw = req.header(IF_MATCH_HEADER);
  if (!raw || raw.trim() === '*') return null;
  return raw.trim();
}

/**
 * Read the raw If-Match header value for audit purposes (v1.14.4 F2).
 *
 * Unlike `readIfMatchHeader`, this returns the literal wire value so audit
 * rows can distinguish "client sent `*`" from "client sent no header at all".
 *   - Header absent  → null  (audit etag: null)
 *   - Header is `*`  → `'*'` (audit etag: '*')
 *   - Header is ETag → trimmed ETag string (same as readIfMatchHeader)
 */
export function readIfMatchRaw(req: Request): string | null {
  const raw = req.header(IF_MATCH_HEADER);
  if (!raw) return null;
  return raw.trim();
}

/**
 * Read the X-Force-Override header.
 * Returns true only when the header value is exactly `'1'` (FORCE_OVERRIDE_VALUE).
 */
export function readForceOverride(req: Request): boolean {
  return req.header(FORCE_OVERRIDE_HEADER) === FORCE_OVERRIDE_VALUE;
}
