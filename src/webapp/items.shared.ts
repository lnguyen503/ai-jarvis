/**
 * Shared helpers for the webapp items routes (v1.16.0 R7).
 *
 * v1.16.0 R7 BLOCKING: auth chain + ConflictTracker extracted to items.auth.ts
 * (Phase 2 commit -1). This file now holds only audit helpers, response helpers,
 * and the IP redactor — all non-auth shared utilities.
 *
 * Contents:
 *   - ITEM_ID_RE — authoritative item-id regex
 *   - Re-exports of ItemsRouteDeps / AuditAuthFailureFn from items.auth.ts
 *     (backward-compat: callers that import from items.shared.ts still work)
 *   - badRequest() — 400 helper
 *   - redactIp() — 3-octet IP redaction
 *   - auditItemMutate() — webapp.item_mutate audit row helper
 *   - auditItemCreate() — webapp.item_create audit row helper
 *   - cacheControlNoStore() — Cache-Control middleware factory
 *   - WebappItemMutateDetail / AuditEtagMeta — detail shapes
 *   - WebappItemCreateDetail — detail shape
 *
 * Auth symbols (authenticateRequest, ConflictTracker, conflictTracker,
 * readIfMatchHeader, readIfMatchRaw, readForceOverride) now live in
 * items.auth.ts. This file re-exports them for callers not yet updated.
 */

import { type Request, type Response, type NextFunction } from 'express';
import {
  WEBAPP_ITEM_CREATE_CATEGORY,
} from './etag-headers.js';
import { child } from '../logger/index.js';
import type { OrganizeType } from '../organize/types.js';

const log = child({ component: 'webapp.itemsShared' });

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility (R7: these live in items.auth.ts now)
// ---------------------------------------------------------------------------

export type {
  AuditAuthFailureFn,
  ItemsRouteDeps,
  AuthOk,
  AuthFail,
} from './items.auth.js';

export {
  authenticateRequest,
  ConflictTracker,
  conflictTracker,
  readIfMatchHeader,
  readIfMatchRaw,
  readForceOverride,
} from './items.auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** YYYY-MM-DD-[a-z0-9]{4} — authoritative item id format (ADR 003). */
export const ITEM_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Send a 400 Bad Request with the unified error envelope. */
export function badRequest(res: Response, message: string): void {
  res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: message });
}

// ---------------------------------------------------------------------------
// IP redaction helper (ADR 010 decision 4 / PRIVACY.md — 3-octet redaction)
// ---------------------------------------------------------------------------

/**
 * Redact an IP address for audit storage (ADR 010 decision 4 + PRIVACY.md R12).
 *
 * Policy (applied uniformly — no loopback exception, simpler invariant):
 *   - IPv4: replace last octet with 0. `192.168.1.42` → `192.168.1.0`.
 *   - IPv6: keep first 4 colon-separated segments, replace rest with `0`.
 *           `2001:db8::1` → `2001:db8::0` (collapsed form preserved).
 *   - Unknown/malformed: return as-is (no silent failure).
 *
 * Applied at every auditItemMutate call site so audit rows never store the full
 * client IP (privacy posture for multi-user deployments).
 */
export function redactIp(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: split on colon, keep first 4 segments
    const parts = ip.split(':');
    return [...parts.slice(0, 4), '0'].join(':');
  }
  // IPv4: replace last octet
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  return ip; // malformed — pass through unchanged
}

// ---------------------------------------------------------------------------
// Audit helper for mutations (W1 — stateless; lives here not server.ts)
// ---------------------------------------------------------------------------

/**
 * Detail shape for webapp.item_mutate audit rows (ADR 010 decision 4 + R12).
 * Records WHICH fields changed (closed set), NOT their values.
 *
 * v1.14.4 D10/SF-5: Optional `etag`, `forced`, and `bypassAfter412` fields added
 * for forensic visibility on conflict-override paths. Non-breaking — JSON blob shape
 * is forward-compatible; no schema migration needed.
 */
export interface WebappItemMutateDetail {
  action: 'update' | 'complete' | 'uncomplete' | 'delete';
  itemId: string;
  changedFields: string[];
  ip?: string;
  /** v1.14.4 D10 — If-Match header value sent by the client; null if absent. */
  etag?: string | null;
  /** v1.14.4 D10 — true when X-Force-Override: 1 was sent (Save Anyway / Delete Anyway path). */
  forced?: boolean;
  /** v1.14.4 R2 — true when this mutation follows a recent 412 within TTL window. */
  bypassAfter412?: boolean;
}

/** Optional ETag-related fields for auditItemMutate (v1.14.4 D10 / R2). */
export interface AuditEtagMeta {
  etag?: string | null;
  forced?: boolean;
  bypassAfter412?: boolean;
}

// MemoryApi import needed for audit helpers
import type { MemoryApi } from '../memory/index.js';
// ItemsRouteDeps re-export above covers the type; we need the value for audit
import type { ItemsRouteDeps } from './items.auth.js';

/**
 * Emit a single `webapp.item_mutate` audit row (NOT debounced — every
 * successful mutation gets its own row, per ADR 010 decision 9 / SF-4).
 *
 * Failures are logged at warn but do NOT propagate — a failed audit insert
 * must not roll back a successful mutation from the user's perspective.
 */
export function auditItemMutate(
  memory: MemoryApi,
  userId: number,
  itemId: string,
  action: WebappItemMutateDetail['action'],
  changedFields: string[],
  ip?: string,
  etagMeta?: AuditEtagMeta,
): void {
  const detail: WebappItemMutateDetail = { action, itemId, changedFields };
  if (ip) detail.ip = ip;
  if (etagMeta !== undefined) {
    if (etagMeta.etag !== undefined) detail.etag = etagMeta.etag;
    if (etagMeta.forced !== undefined) detail.forced = etagMeta.forced;
    if (etagMeta.bypassAfter412 !== undefined) detail.bypassAfter412 = etagMeta.bypassAfter412;
  }

  try {
    memory.auditLog.insert({
      category: 'webapp.item_mutate',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, itemId, action },
      'Failed to insert webapp.item_mutate audit row',
    );
  }
}

// ---------------------------------------------------------------------------
// Audit helper for item creation (v1.14.6 D7)
// ---------------------------------------------------------------------------

/**
 * Detail shape for webapp.item_create audit rows (v1.14.6 D7).
 *
 * Records WHAT was created (type, whether it has a parent), not the field
 * values themselves — privacy posture mirrors WebappItemMutateDetail (no
 * values, only structural facts).
 */
export interface WebappItemCreateDetail {
  itemId: string;
  type: OrganizeType;
  /** True when the create request included a non-null parentId. */
  hasParent: boolean;
  /** Redacted client IP (3-octet IPv4 / 4-segment IPv6, per ADR 010 decision 4). */
  ip?: string;
}

/**
 * Emit a single `webapp.item_create` audit row (v1.14.6 D7).
 *
 * NOT debounced — every successful POST /api/webapp/items creates exactly one
 * row, matching the invariant for item_mutate (ADR 010 decision 9 / SF-4).
 *
 * Failures are logged at warn but do NOT propagate — a failed audit insert
 * must not roll back a successful creation from the user's perspective.
 */
export function auditItemCreate(
  deps: ItemsRouteDeps,
  userId: number,
  itemId: string,
  type: OrganizeType,
  hasParent: boolean,
  ip?: string,
): void {
  const detail: WebappItemCreateDetail = { itemId, type, hasParent };
  if (ip) detail.ip = ip;

  try {
    deps.memory.auditLog.insert({
      category: WEBAPP_ITEM_CREATE_CATEGORY,
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, itemId, type },
      'Failed to insert webapp.item_create audit row',
    );
  }
}

// ---------------------------------------------------------------------------
// Cache-Control middleware (v1.14.6 W6 — used by items.create.ts)
// ---------------------------------------------------------------------------

/**
 * Express middleware that sets `Cache-Control: no-store, no-cache, must-revalidate`
 * and `Pragma: no-cache` on every response passing through the mount point.
 *
 * Registered once per route prefix (see mountItemsCreateRoutes, mountItemsReadRoutes)
 * so that the header is set even before the route handler runs. Each handler also
 * sets Cache-Control explicitly as defense-in-depth (belt + suspenders).
 */
export function cacheControlNoStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}
