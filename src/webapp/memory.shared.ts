/**
 * Shared helpers for the webapp memory routes (v1.17.0).
 *
 * ADR 017 D5: per-resource shared module, mirrors debate.shared.ts pattern.
 *
 * Contents:
 *   - Re-export of authenticateRequest from items.auth.ts (single source of truth)
 *   - auditMemoryView()   — emits webapp.memory_view
 *   - auditMemoryMutate() — emits webapp.memory_mutate
 *   - MemoryRouteDeps     — deps interface for memory routes
 *   - Detail JSON shapes (no field VALUES per privacy posture)
 *
 * Privacy posture: detail_json MUST NOT include entry content (key values,
 * memory body text). Only structural metadata (action, key name, count, ip).
 */

import { child } from '../logger/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { AppConfig } from '../config/index.js';

const log = child({ component: 'webapp.memoryShared' });

// ---------------------------------------------------------------------------
// Re-exports (single source of truth lives in items.auth.ts)
// ---------------------------------------------------------------------------

export {
  authenticateRequest,
  type ItemsRouteDeps,
  type AuditAuthFailureFn,
  type AuthOk,
  type AuthFail,
} from './items.auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryRouteDeps {
  config: AppConfig;
  memory: MemoryApi;
  botToken: string;
  auditAuthFailure: import('./items.auth.js').AuditAuthFailureFn;
  /** Absolute path to the data directory (where memories/*.md files live). */
  dataDir: string;
}

/**
 * Detail shape for webapp.memory_view audit rows.
 * No field values — privacy posture: only action + key name (no body content).
 */
export interface WebappMemoryViewDetail {
  action: 'list' | 'detail';
  key?: string;
  count?: number;
  ip?: string;
}

/**
 * Detail shape for webapp.memory_mutate audit rows.
 * No field values — privacy posture: only action + key name (no body content).
 */
export interface WebappMemoryMutateDetail {
  action: 'create' | 'update' | 'delete';
  key?: string;
  ip?: string;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Emit a webapp.memory_view audit row.
 * No content fields — read-only access. Failures logged at warn, not propagated.
 */
export function auditMemoryView(
  memory: MemoryApi,
  userId: number,
  action: WebappMemoryViewDetail['action'],
  key?: string,
  count?: number,
  ip?: string,
): void {
  const detail: WebappMemoryViewDetail = { action };
  if (key) detail.key = key;
  if (count !== undefined) detail.count = count;
  if (ip) detail.ip = ip;

  try {
    memory.auditLog.insert({
      category: 'webapp.memory_view',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, action },
      'Failed to insert webapp.memory_view audit row',
    );
  }
}

/**
 * Emit a webapp.memory_mutate audit row.
 * No content fields — only action + key name. Failures logged at warn, not propagated.
 */
export function auditMemoryMutate(
  memory: MemoryApi,
  userId: number,
  action: WebappMemoryMutateDetail['action'],
  key?: string,
  ip?: string,
): void {
  const detail: WebappMemoryMutateDetail = { action };
  if (key) detail.key = key;
  if (ip) detail.ip = ip;

  try {
    memory.auditLog.insert({
      category: 'webapp.memory_mutate',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, action },
      'Failed to insert webapp.memory_mutate audit row',
    );
  }
}
