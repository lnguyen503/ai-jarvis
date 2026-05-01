/**
 * Reconcile handler for /organize reconcile (v1.11.0).
 *
 * Reads organize.inconsistency audit rows for the last 30 days, cross-references
 * with current disk state and existing organize.reconcile resolutions, and returns
 * a list of unresolved ReconcileItems (up to 20).
 *
 * Callback handler (rec:<action>:<itemId>) performs pre-action verification (R9)
 * before executing the fix, removes the inline keyboard, and emits an audit row.
 *
 * ADR 006 decisions 2, 4, 5, 6 + R8, R9, R11.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { loadReminderState, writeReminderState } from '../organize/reminderState.js';
import { organizeUserDir, updateItem } from '../organize/storage.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.organize.reconcile' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InconsistencyKind = 'orphan-local' | 'orphan-gcal' | 'deferred-orphan-gcal';
export type ReconcileAction = 'prune-state-entry' | 'null-calendar-event-id';

export interface ReconcileItem {
  itemId: string;
  kind: InconsistencyKind;
  proposedAction: ReconcileAction;
  calendarEventId?: string;
  originalInconsistencyTs: string;
}

export interface BuildReconcileListingResult {
  items: ReconcileItem[];
  totalCount: number;
  hotEmitter: boolean;
}

// Matches ADR 006 decision 5 audit detail shape.
interface ReconcileAuditDetail {
  action: 'prune-state-entry' | 'null-calendar-event-id' | 'skipped';
  itemId: string;
  originalInconsistencyKind: InconsistencyKind | 'unknown';
  originalInconsistencyTs: string;
  result: 'ok' | 'no-op' | 'failed';
  reason?: string;
  calendarEventId?: string | null;
}

// Shape of the organize.inconsistency audit row detail.
interface InconsistencyDetail {
  kind?: InconsistencyKind;
  itemId?: string;
  calendarEventId?: string | null;
}

// Shape of the organize.reconcile audit row detail (used when cross-referencing).
interface ReconcileDetail {
  itemId?: string;
  originalInconsistencyTs?: string;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ReconcileHandlerDeps {
  config: AppConfig;
  memory: MemoryApi;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ITEM_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;
const CALLBACK_PATTERN = /^rec:(fix|skip):\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;

function parseDetail<T>(detailJson: string): T | null {
  try {
    return JSON.parse(detailJson) as T;
  } catch {
    return null;
  }
}

function since30DaysAgo(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString();
}

/**
 * Map inconsistency kind to the proposed reconcile action.
 *   orphan-local: file on disk but no state entry → prune-state-entry
 *   orphan-gcal: calendarEventId remembered but file gone → null-calendar-event-id
 *   deferred-orphan-gcal: same root cause → null-calendar-event-id
 */
function proposedActionForKind(kind: InconsistencyKind): ReconcileAction {
  if (kind === 'orphan-local') return 'prune-state-entry';
  return 'null-calendar-event-id';
}

// ---------------------------------------------------------------------------
// buildReconcileListing
// ---------------------------------------------------------------------------

/**
 * Read the last 30 days of organize.inconsistency rows for userId. Cross-reference
 * with organize.reconcile rows to exclude already-resolved items. Cross-check
 * current disk state to exclude items whose drift is no longer present.
 *
 * Returns up to 20 items (oldest first per ADR 006 decision 2), totalCount before
 * the cap, and hotEmitter flag (>= config.organize.reconcileHotEmitterThreshold).
 */
export async function buildReconcileListing(
  userId: number,
  dataDir: string,
  memory: MemoryApi,
  config: AppConfig,
): Promise<BuildReconcileListingResult> {
  const sinceIso = since30DaysAgo();
  const hotEmitterThreshold = config.organize?.reconcileHotEmitterThreshold ?? 100;

  // Fetch audit rows.
  const inconsistencyRows = memory.auditLog.listByCategoryAndActorSince(
    'organize.inconsistency',
    userId,
    sinceIso,
  );
  const reconcileRows = memory.auditLog.listByCategoryAndActorSince(
    'organize.reconcile',
    userId,
    sinceIso,
  );

  // Build a set of (itemId + originalInconsistencyTs) pairs that are already resolved.
  const resolvedKeys = new Set<string>();
  for (const row of reconcileRows) {
    const d = parseDetail<ReconcileDetail>(row.detail_json);
    if (d?.itemId && d?.originalInconsistencyTs) {
      resolvedKeys.add(`${d.itemId}:${d.originalInconsistencyTs}`);
    }
  }

  // De-duplicate by itemId: keep the MOST RECENT unresolved row per itemId.
  // (ADR 006 decision 2: sort oldest-first for display, but we want newest
  //  row for provenance. We group first, then sort the output oldest-first.)
  const byItemId = new Map<string, {
    kind: InconsistencyKind;
    ts: string;
    calendarEventId?: string | null;
  }>();

  // inconsistencyRows is newest-first (ORDER BY ts DESC).
  // We want the NEWEST unresolved row per itemId. iterating newest-first
  // and skipping if itemId already seen gives us the newest.
  for (const row of inconsistencyRows) {
    const d = parseDetail<InconsistencyDetail>(row.detail_json);
    if (!d?.kind || !d?.itemId) continue;
    if (!ITEM_ID_PATTERN.test(d.itemId)) continue;

    const resolutionKey = `${d.itemId}:${row.ts}`;
    if (resolvedKeys.has(resolutionKey)) continue; // already resolved

    if (!byItemId.has(d.itemId)) {
      byItemId.set(d.itemId, {
        kind: d.kind,
        ts: row.ts,
        calendarEventId: d.calendarEventId ?? undefined,
      });
    }
  }

  // Cross-check disk state: only include items where the drift is still present.
  const userDir = organizeUserDir(userId, dataDir);
  const unresolvedItems: ReconcileItem[] = [];

  for (const [itemId, info] of byItemId) {
    const filePath = path.join(userDir, `${itemId}.md`);
    const fileExists = existsSync(filePath);

    if (info.kind === 'orphan-local') {
      // Drift: file exists but no state entry. Still drifted if file still exists.
      if (!fileExists) continue; // drift gone
    } else {
      // orphan-gcal / deferred-orphan-gcal: file absent but calendarEventId remembered.
      // We'd need to read the file to check calendarEventId; if file doesn't exist,
      // the drift is that the item is gone but GCal reference lingers.
      // If the file now EXISTS again (restore), skip.
      if (fileExists) continue; // file restored; drift gone
    }

    unresolvedItems.push({
      itemId,
      kind: info.kind,
      proposedAction: proposedActionForKind(info.kind),
      calendarEventId: info.calendarEventId ?? undefined,
      originalInconsistencyTs: info.ts,
    });
  }

  // Sort oldest-first for display (ADR 006 decision 2).
  unresolvedItems.sort((a, b) => a.originalInconsistencyTs.localeCompare(b.originalInconsistencyTs));

  const totalCount = unresolvedItems.length;
  const hotEmitter = totalCount >= hotEmitterThreshold;

  // Log at warn when hot-emitter threshold fires (R8 §3).
  if (hotEmitter) {
    log.warn(
      { userId, totalCount, hotEmitterThreshold },
      'organize reconcile: hot-emitter threshold reached',
    );
  }

  const items = unresolvedItems.slice(0, 20);
  return { items, totalCount, hotEmitter };
}

// ---------------------------------------------------------------------------
// handleReconcileCallback
// ---------------------------------------------------------------------------

/**
 * Handle a rec:<action>:<itemId> callback query tap.
 *
 * Per R9:
 *  1. Validate callback_data shape (regex).
 *  2. Verify an active (unresolved) inconsistency exists for itemId.
 *  3. Cross-check current disk state matches the drift.
 *  4. Execute the action (or skip).
 *  5. Emit organize.reconcile audit row.
 *  6. Remove keyboard via editMessageReplyMarkup.
 *  7. Return toast string.
 */
export async function handleReconcileCallback(
  data: string,
  ctx: Context,
  deps: ReconcileHandlerDeps,
): Promise<{ toast: string }> {
  const { config, memory } = deps;

  // DM-only gate (ADR 006 decision 4).
  if (ctx.chat?.type !== 'private') {
    await ctx.answerCallbackQuery({ text: 'Organize is DM-only.' }).catch(() => {});
    return { toast: 'Organize is DM-only.' };
  }

  const userId = ctx.from?.id;
  if (!userId) {
    return { toast: 'No user context.' };
  }

  // Validate callback_data shape.
  if (!CALLBACK_PATTERN.test(data)) {
    log.warn({ data, userId }, 'reconcile callback: invalid data shape');
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return { toast: 'Invalid callback.' };
  }

  // Parse: rec:<action>:<itemId>
  const parts = data.split(':');
  const action = parts[1] as 'fix' | 'skip';
  // v1.11.0 W5: CALLBACK_PATTERN guarantees exactly 3 colon-delimited parts
  // (rec:<action>:<itemId>), so parts[2] is always defined — slice+join is redundant.
  const itemId = parts[2]!;

  const dataDir = path.resolve(
    config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data',
  );

  const sinceIso = since30DaysAgo();

  // Load audit rows for verification (R9).
  const inconsistencyRows = memory.auditLog.listByCategoryAndActorSince(
    'organize.inconsistency',
    userId,
    sinceIso,
  );
  const reconcileRows = memory.auditLog.listByCategoryAndActorSince(
    'organize.reconcile',
    userId,
    sinceIso,
  );

  // Build resolved keys set.
  const resolvedKeys = new Set<string>();
  for (const row of reconcileRows) {
    const d = parseDetail<ReconcileDetail>(row.detail_json);
    if (d?.itemId && d?.originalInconsistencyTs) {
      resolvedKeys.add(`${d.itemId}:${d.originalInconsistencyTs}`);
    }
  }

  // Find unresolved inconsistency rows for this itemId.
  const unresolvedForItem = inconsistencyRows.filter((row) => {
    const d = parseDetail<InconsistencyDetail>(row.detail_json);
    if (!d?.itemId || d.itemId !== itemId) return false;
    return !resolvedKeys.has(`${itemId}:${row.ts}`);
  });

  // Helper to emit audit row.
  function emitAudit(detail: ReconcileAuditDetail): void {
    try {
      memory.auditLog.insert({
        category: 'organize.reconcile',
        actor_user_id: userId!,
        actor_chat_id: userId!,
        session_id: null,
        detail: detail as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'reconcile: audit insert failed');
    }
  }

  // Helper to remove keyboard.
  async function removeKeyboard(): Promise<void> {
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  }

  // --- Pre-action: check no active inconsistency ---
  if (unresolvedForItem.length === 0) {
    log.info({ userId, itemId }, 'reconcile callback: no active inconsistency');
    emitAudit({
      action: 'skipped',
      itemId,
      originalInconsistencyKind: 'unknown',
      originalInconsistencyTs: new Date().toISOString(),
      result: 'no-op',
      reason: 'no-active-inconsistency',
    });
    await removeKeyboard();
    return { toast: 'Nothing to reconcile for this item.' };
  }

  // Use the most recent unresolved inconsistency row (inconsistencyRows is newest-first).
  const targetRow = unresolvedForItem[0]!;
  const targetDetail = parseDetail<InconsistencyDetail>(targetRow.detail_json);
  const kind: InconsistencyKind = targetDetail?.kind ?? 'orphan-local';
  const calendarEventId = targetDetail?.calendarEventId ?? null;

  // --- Pre-action: cross-check disk state ---
  const userDir = organizeUserDir(userId, dataDir);
  const filePath = path.join(userDir, `${itemId}.md`);
  const fileExists = existsSync(filePath);

  // Check if disk state still matches the drift.
  let stateAlreadyConsistent = false;
  if (kind === 'orphan-local') {
    // Drift: file exists but no state entry. If file no longer exists → consistent.
    if (!fileExists) stateAlreadyConsistent = true;
  } else {
    // orphan-gcal / deferred-orphan-gcal: file should be absent.
    // If file now exists → consistent.
    if (fileExists) stateAlreadyConsistent = true;
  }

  if (stateAlreadyConsistent) {
    log.info({ userId, itemId, kind }, 'reconcile callback: state already consistent');
    emitAudit({
      action: 'skipped',
      itemId,
      originalInconsistencyKind: kind,
      originalInconsistencyTs: targetRow.ts,
      result: 'no-op',
      reason: 'state-already-consistent',
    });
    await removeKeyboard();
    return { toast: 'Already consistent — nothing to fix.' };
  }

  // --- Skip action ---
  if (action === 'skip') {
    emitAudit({
      action: 'skipped',
      itemId,
      originalInconsistencyKind: kind,
      originalInconsistencyTs: targetRow.ts,
      result: 'no-op',
    });
    await removeKeyboard();
    return { toast: 'Skipped.' };
  }

  // --- Fix action ---
  const proposedAction = proposedActionForKind(kind);

  if (proposedAction === 'prune-state-entry') {
    // Mutate reminder state: remove state.items[itemId].
    try {
      const state = await loadReminderState(userId, dataDir);
      if (state.items[itemId] !== undefined) {
        delete state.items[itemId];
        await writeReminderState(userId, dataDir, state);
      }
      emitAudit({
        action: 'prune-state-entry',
        itemId,
        originalInconsistencyKind: kind,
        originalInconsistencyTs: targetRow.ts,
        result: 'ok',
      });
      await removeKeyboard();
      log.info({ userId, itemId }, 'reconcile: prune-state-entry ok');
      return { toast: 'Fixed — stale state entry pruned.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId, itemId, err: msg }, 'reconcile: prune-state-entry failed');
      emitAudit({
        action: 'prune-state-entry',
        itemId,
        originalInconsistencyKind: kind,
        originalInconsistencyTs: targetRow.ts,
        result: 'failed',
        reason: msg,
      });
      await removeKeyboard();
      return { toast: `Reconcile failed: ${msg}` };
    }
  } else {
    // null-calendar-event-id: null out calendarEventId on the item file.
    try {
      await updateItem(userId, dataDir, itemId, { calendarEventId: null });
      emitAudit({
        action: 'null-calendar-event-id',
        itemId,
        originalInconsistencyKind: kind,
        originalInconsistencyTs: targetRow.ts,
        result: 'ok',
        calendarEventId: calendarEventId ?? null,
      });
      await removeKeyboard();
      log.info({ userId, itemId }, 'reconcile: null-calendar-event-id ok');
      return { toast: 'Fixed — calendarEventId cleared.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId, itemId, err: msg }, 'reconcile: null-calendar-event-id failed');
      emitAudit({
        action: 'null-calendar-event-id',
        itemId,
        originalInconsistencyKind: kind,
        originalInconsistencyTs: targetRow.ts,
        result: 'failed',
        reason: msg,
        calendarEventId: calendarEventId ?? null,
      });
      await removeKeyboard();
      return { toast: `Reconcile failed: ${msg}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Message formatter for per-item reconcile messages
// ---------------------------------------------------------------------------

/**
 * Build the text for a single reconcile item message.
 * Used by the /organize reconcile subcommand to compose one message per item.
 */
export function formatReconcileItemMessage(
  item: ReconcileItem,
  index: number,
  total: number,
): string {
  const indexLabel = `Inconsistency ${index + 1} of ${total} — ${item.kind}`;
  const itemLine = `Item: ${item.itemId}`;

  let proposedLine: string;
  if (item.proposedAction === 'prune-state-entry') {
    proposedLine = 'Proposed: prune the stale state entry (no file change).';
  } else {
    const eventIdStr = item.calendarEventId
      ? ` → eventId: ${item.calendarEventId.slice(0, 12)}...`
      : '';
    proposedLine = `Proposed: null out calendarEventId on item${eventIdStr} (file remains; Calendar event preserved).`;
  }

  return `${indexLabel}\n${itemLine}\n${proposedLine}`;
}
