/**
 * Shared helpers for the webapp debates routes (v1.16.0).
 *
 * ADR 016 D10 + R7: authenticateRequest imported from ./items.auth.ts
 * (single source of truth — post-R7 split). Not duplicated here.
 *
 * Contents:
 *   - Re-export of authenticateRequest from items.auth.ts
 *   - auditDebateView()            — emits webapp.debate_view
 *   - auditDebatePersistenceError() — emits debate.persistence_error (R5)
 *   - WebappDebateViewDetail       — detail shape
 *   - DebatePersistenceErrorDetail — detail shape
 *   - DebatesRouteDeps             — deps interface for debate routes
 */

import { child } from '../logger/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { AppConfig } from '../config/index.js';

const log = child({ component: 'webapp.debateShared' });

// ---------------------------------------------------------------------------
// Re-exports (R7: single source of truth lives in items.auth.ts)
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

export interface DebatesRouteDeps {
  config: AppConfig;
  memory: MemoryApi;
  botToken: string;
  auditAuthFailure: import('./items.auth.js').AuditAuthFailureFn;
}

/**
 * Detail shape for webapp.debate_view audit rows.
 * No content in detail_json — privacy posture mirrors webapp.item_create.
 *
 * 'stream_close' removed in v1.16.0 fix loop (QA M1): the server never emits
 * a stream_close audit row — SSE connections close silently (no per-disconnect
 * audit spam per ADR 016 D9). Removing the dead union member keeps the type
 * honest.
 */
export interface WebappDebateViewDetail {
  action: 'list' | 'detail' | 'stream_open';
  debateRunId?: string;
  count?: number;
  ip?: string;
}

/**
 * Detail shape for debate.persistence_error audit rows (R5).
 */
export interface DebatePersistenceErrorDetail {
  debateRunId: string;
  hookName: 'onStart' | 'onRound' | 'onVerdict' | 'onAbort';
  error: string;
  roundNumber?: number;
  debaterName?: string;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Emit a webapp.debate_view audit row.
 *
 * No content — read access only. Failures are logged at warn but do NOT
 * propagate.
 */
export function auditDebateView(
  memory: MemoryApi,
  userId: number,
  action: WebappDebateViewDetail['action'],
  debateRunId?: string,
  count?: number,
  ip?: string,
): void {
  const detail: WebappDebateViewDetail = { action };
  if (debateRunId) detail.debateRunId = debateRunId;
  if (count !== undefined) detail.count = count;
  if (ip) detail.ip = ip;

  try {
    memory.auditLog.insert({
      category: 'webapp.debate_view',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, action },
      'Failed to insert webapp.debate_view audit row',
    );
  }
}

/**
 * Emit a debate.persistence_error audit row (R5).
 *
 * Called from runDebate's per-callback try/catch wrappers when a
 * persistenceHook callback throws or rejects. Does NOT propagate.
 */
export function auditDebatePersistenceError(
  memory: MemoryApi,
  userId: number,
  debateRunId: string,
  hookName: DebatePersistenceErrorDetail['hookName'],
  error: Error | string,
  roundNumber?: number,
  debaterName?: string,
): void {
  const errorMsg = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  const detail: DebatePersistenceErrorDetail = { debateRunId, hookName, error: errorMsg };
  if (roundNumber !== undefined) detail.roundNumber = roundNumber;
  if (debaterName) detail.debaterName = debaterName;

  try {
    memory.auditLog.insert({
      category: 'debate.persistence_error',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), debateRunId, hookName },
      'Failed to insert debate.persistence_error audit row',
    );
  }
}
