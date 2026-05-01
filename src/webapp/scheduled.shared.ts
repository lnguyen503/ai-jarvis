/**
 * Shared helpers for the webapp scheduled tasks routes (v1.17.0).
 *
 * ADR 017 D5: per-resource shared module, mirrors debate.shared.ts pattern.
 *
 * Contents:
 *   - Re-export of authenticateRequest from items.auth.ts (single source of truth)
 *   - auditScheduledView()   — emits webapp.scheduled_view
 *   - auditScheduledMutate() — emits webapp.scheduled_mutate
 *   - ScheduledRouteDeps     — deps interface for scheduled routes
 *   - Detail JSON shapes (no field VALUES per privacy posture)
 *
 * Privacy posture: detail_json MUST NOT include task content (command, description,
 * cron expression values). Only structural metadata (action, taskId, count, ip).
 */

import { child } from '../logger/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { AppConfig } from '../config/index.js';
import type { SchedulerApi } from '../scheduler/index.js';

const log = child({ component: 'webapp.scheduledShared' });

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

/**
 * Deps for all /api/webapp/scheduled routes.
 *
 * Extends ItemsRouteDeps with `scheduler` so mutation routes can call
 * scheduler.reload() after a successful INSERT/UPDATE/DELETE — ADR 017 §7
 * Risk #8 + CP1 surface row 13 binding. The scheduler is late-bound (chicken-
 * and-egg: gateway builds before the scheduler); pass a { reload() } wrapper
 * that is populated in src/index.ts at step 10 — same pattern as the chat-side
 * /scheduled command. null is accepted during tests that don't need reload.
 */
export interface ScheduledRouteDeps {
  config: AppConfig;
  memory: MemoryApi;
  botToken: string;
  auditAuthFailure: import('./items.auth.js').AuditAuthFailureFn;
  scheduler: Pick<SchedulerApi, 'reload'> | null;
}

/**
 * Detail shape for webapp.scheduled_view audit rows.
 * No field values — privacy posture: only action metadata.
 */
export interface WebappScheduledViewDetail {
  action: 'list' | 'detail' | 'preview';
  taskId?: number;
  count?: number;
  ip?: string;
}

/**
 * Detail shape for webapp.scheduled_mutate audit rows.
 * No field values — privacy posture: only action + taskId.
 */
export interface WebappScheduledMutateDetail {
  action: 'create' | 'update' | 'delete';
  taskId?: number;
  ip?: string;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Emit a webapp.scheduled_view audit row.
 * No content fields — read-only access. Failures logged at warn, not propagated.
 */
export function auditScheduledView(
  memory: MemoryApi,
  userId: number,
  action: WebappScheduledViewDetail['action'],
  taskId?: number,
  count?: number,
  ip?: string,
): void {
  const detail: WebappScheduledViewDetail = { action };
  if (taskId !== undefined) detail.taskId = taskId;
  if (count !== undefined) detail.count = count;
  if (ip) detail.ip = ip;

  try {
    memory.auditLog.insert({
      category: 'webapp.scheduled_view',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, action },
      'Failed to insert webapp.scheduled_view audit row',
    );
  }
}

/**
 * Emit a webapp.scheduled_mutate audit row.
 * No content fields — only action + taskId. Failures logged at warn, not propagated.
 */
export function auditScheduledMutate(
  memory: MemoryApi,
  userId: number,
  action: WebappScheduledMutateDetail['action'],
  taskId?: number,
  ip?: string,
): void {
  const detail: WebappScheduledMutateDetail = { action };
  if (taskId !== undefined) detail.taskId = taskId;
  if (ip) detail.ip = ip;

  try {
    memory.auditLog.insert({
      category: 'webapp.scheduled_mutate',
      actor_user_id: userId,
      detail: detail as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, action },
      'Failed to insert webapp.scheduled_mutate audit row',
    );
  }
}
