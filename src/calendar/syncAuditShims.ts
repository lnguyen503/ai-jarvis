/**
 * syncAuditShims.ts — Calendar sync audit shims (v1.19.0 fix-loop).
 *
 * Single source of truth for the 5 calendar-sync audit emit functions used by
 * the SyncDeps interface in src/index.ts. Each shim:
 *   1. Logs the event for forensics (info/warn/debug per severity).
 *   2. Inserts an audit row via memory.auditLog.insert(...) using the closed-set
 *      AuditCategory values from KNOWN_AUDIT_CATEGORIES.
 *
 * Privacy posture (binding per ADR 019 F3 + v1.17.0 H gate carry-forward):
 *   Detail JSON carries STRUCTURAL metadata only — NO content fields:
 *     - itemId, eventId, calendarEventId — opaque IDs
 *     - direction, fields[] — sync direction + which fields touched
 *     - errorCode (truncated to 200 chars) — error category, no PII
 *     - reason — closed-set skip reason
 *     - markerHit, field — injection marker name + field name (not content)
 *     - originalLen, truncatedLen — character counts (not content)
 *
 * Extracting this into a separate module (vs inline in index.ts) lets the
 * audit shapes be unit-tested against a real AuditLogRepo without booting
 * the entire factory pipeline.
 *
 * Dependency edges (binding):
 *   syncAuditShims.ts → memory/auditLog (AuditLogRepo)
 *                     → logger (pino child)
 *   NO import from src/index.ts or any agent/gateway layer.
 */

import type pino from 'pino';
import type { AuditLogRepo } from '../memory/auditLog.js';
import type { SyncSkipReason } from './syncTypes.js';

/**
 * The set of 5 audit shim functions matching SyncDeps.audit* fields.
 * Each one logs + inserts an audit row.
 */
export interface SyncAuditShims {
  auditSuccess(
    userId: number,
    itemId: string,
    eventId: string,
    direction: 'to_event' | 'from_event',
    fields: string[],
  ): void;
  auditFailure(userId: number, itemId: string, errorCode: string): void;
  auditSkip(userId: number, itemId: string, reason: SyncSkipReason): void;
  auditRejectedInjection(
    userId: number,
    itemId: string,
    calendarEventId: string,
    markerHit: string,
    field: string,
  ): void;
  auditTruncated(
    userId: number,
    itemId: string,
    calendarEventId: string,
    field: string,
    originalLen: number,
    truncatedLen: number,
  ): void;
}

/**
 * Build the 5 audit shims for a sync session.
 *
 * @param log       Pino child logger (or compatible).
 * @param auditLog  AuditLogRepo for persistent audit rows.
 */
export function buildSyncAuditShims(
  log: pino.Logger,
  auditLog: AuditLogRepo,
): SyncAuditShims {
  return {
    auditSuccess(userId, itemId, eventId, direction, fields) {
      log.info({ userId, itemId, eventId, direction, fields }, 'calendar sync success');
      auditLog.insert({
        category: 'calendar.sync_success',
        actor_user_id: userId,
        detail: { itemId, eventId, direction, fields },
      });
    },

    auditFailure(userId, itemId, errorCode) {
      log.warn({ userId, itemId, errorCode }, 'calendar sync failure');
      auditLog.insert({
        category: 'calendar.sync_failure',
        actor_user_id: userId,
        detail: { itemId, errorCode: errorCode.slice(0, 200) },
      });
    },

    auditSkip(userId, itemId, reason) {
      log.debug({ userId, itemId, reason }, 'calendar sync skip');
      auditLog.insert({
        category: 'calendar.sync_skipped',
        actor_user_id: userId,
        detail: { itemId, reason },
      });
    },

    auditRejectedInjection(userId, itemId, calendarEventId, markerHit, field) {
      log.warn(
        { userId, itemId, calendarEventId, markerHit, field },
        'calendar reverse-sync: rejected injection marker',
      );
      auditLog.insert({
        category: 'calendar.sync_rejected_injection',
        actor_user_id: userId,
        detail: { itemId, calendarEventId, markerHit, field },
      });
    },

    auditTruncated(userId, itemId, calendarEventId, field, originalLen, truncatedLen) {
      log.info(
        { userId, itemId, calendarEventId, field, originalLen, truncatedLen },
        'calendar reverse-sync: field truncated',
      );
      auditLog.insert({
        category: 'calendar.sync_truncated',
        actor_user_id: userId,
        detail: { itemId, calendarEventId, field, originalLen, truncatedLen },
      });
    },
  };
}
