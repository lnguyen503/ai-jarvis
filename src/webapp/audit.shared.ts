/**
 * Shared helpers for the webapp audit routes (v1.17.0).
 *
 * ADR 017 D5: per-resource shared module, mirrors debate.shared.ts pattern.
 *
 * Contents:
 *   - Re-export of authenticateRequest from items.auth.ts (single source of truth)
 *   - Re-export of KNOWN_AUDIT_CATEGORIES from auditLog.ts (R6 closed-set validation)
 *   - auditAuditView() — emits webapp.audit_view
 *   - AuditRouteDeps  — deps interface for audit routes
 *   - Detail JSON shapes (no field VALUES per privacy posture)
 *
 * Privacy posture: detail_json MUST NOT include audit row content (detail_json
 * values from other rows). Only structural metadata (action, auditId, count, ip).
 *
 * R6 BINDING: KNOWN_AUDIT_CATEGORIES is the closed set for ?categories= filter
 * validation. Unknown values → 400 INVALID_CATEGORY. This set is the single
 * source of truth; never inline the list in route handlers.
 */

import { child } from '../logger/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { AppConfig } from '../config/index.js';

const log = child({ component: 'webapp.auditShared' });

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  authenticateRequest,
  type ItemsRouteDeps,
  type AuditAuthFailureFn,
  type AuthOk,
  type AuthFail,
} from './items.auth.js';

/** Closed set of all known AuditCategory values (R6 binding). */
export { KNOWN_AUDIT_CATEGORIES } from '../memory/auditLog.js';
export type { AuditCategory } from '../memory/auditLog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditRouteDeps {
  config: AppConfig;
  memory: MemoryApi;
  botToken: string;
  auditAuthFailure: import('./items.auth.js').AuditAuthFailureFn;
}

/**
 * Detail shape for webapp.audit_view audit rows.
 * No field values — privacy posture: only action + structural metadata.
 */
export interface WebappAuditViewDetail {
  action: 'list' | 'detail';
  auditId?: number;
  count?: number;
  ip?: string;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Emit a webapp.audit_view audit row.
 * No content fields — read-only access. Failures logged at warn, not propagated.
 */
export function auditAuditView(
  memory: MemoryApi,
  userId: number,
  action: WebappAuditViewDetail['action'],
  auditId?: number,
  count?: number,
  ip?: string,
): void {
  const detail: WebappAuditViewDetail = { action };
  if (auditId !== undefined) detail.auditId = auditId;
  if (count !== undefined) detail.count = count;
  if (ip) detail.ip = ip;

  try {
    memory.auditLog.insert({
      category: 'webapp.audit_view',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, action },
      'Failed to insert webapp.audit_view audit row',
    );
  }
}
