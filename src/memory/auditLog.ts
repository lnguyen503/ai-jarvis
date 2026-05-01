/**
 * AuditLogRepo — insert and list recent audit_log rows (v1.6.0).
 *
 * Tracks: tool_call | model_switch | admin_command | confirmation | compaction | agent.escalation
 * Every row has a timestamp, category, optional actor identifiers, and a JSON detail blob.
 */

import type { DbHandle } from './dbDriver.js';

export type AuditCategory =
  | 'tool_call'
  | 'model_switch'
  | 'admin_command'
  | 'confirmation'
  | 'compaction'
  | 'agent.escalation'    // v1.8.3: silent Haiku→Sonnet (loop-exhaustion) fallback events
  | 'memory.write'        // v1.8.5: per-user memory append (saved or rejected by privacy filter)
  | 'memory.delete'       // v1.8.5: per-user memory entries removed (forget_memory or /memory clear)
  | 'organize.create'     // v1.8.6: organize item created (or rejected at creation)
  | 'organize.update'     // v1.8.6: organize item updated (patch)
  | 'organize.complete'   // v1.8.6: organize item marked done
  | 'organize.progress'   // v1.8.6: progress entry appended to an item
  | 'organize.delete'     // v1.8.6: organize item soft-deleted
  | 'organize.inconsistency' // v1.8.6: cross-system orphan states (GCal/local drift)
  | 'organize.nudge'         // v1.9.0: proactive nudge lifecycle (delivered, suppressed, skipped, failed)
  | 'scheduler.create'       // v1.10.0 R7: a `schedule` tool call created a new task
  | 'scheduler.delete'       // v1.10.0 R7: /scheduled delete
  | 'scheduler.pause'        // v1.10.0 R7: /scheduled pause
  | 'scheduler.policy'       // v1.10.0 R2: system-originated policy (e.g. drop_unauthorized_owner, migration events)
  | 'scheduler.resume'       // v1.10.0 R7: /scheduled resume
  | 'organize.reconcile'     // v1.11.0 R9 — reconcile actions (fix/skip/no-op)
  | 'organize.trash.evict'   // v1.11.0 R7 — daily TTL eviction batches (non-zero only by default)
  | 'debate.complete'        // v1.12.0 — debate finished (consensus or final-verdict); full transcript in detail_json
  | 'debate.cancel'          // v1.12.0 — debate cancelled mid-run via inline button
  | 'webapp.auth_failure'    // v1.13.0 R6 — per-IP debounced audit on Web App auth failures
  | 'webapp.item_mutate'    // v1.14.2 — one row per successful PATCH/POST /complete/DELETE on an item
  | 'webapp.stale_edit'     // v1.14.2 R2-mtime — X-Captured-Mtime mismatch on mutation (non-blocking)
  | 'organize.restore'      // v1.14.3 D9 — chat-side /organize restore <id> success
  | 'webapp.item_create'    // v1.14.6 D7 — one row per successful POST /api/webapp/items create
  | 'webapp.debate_view'   // v1.16.0 D9 — read-access to debate list/detail/stream (no content in detail)
  | 'debate.persistence_error' // v1.16.0 R5 — persistenceHook callback failure forensics
  | 'webapp.scheduled_view'    // v1.17.0 — read-access to scheduled tasks (list/detail/preview)
  | 'webapp.scheduled_mutate'  // v1.17.0 — create/update/delete on scheduled tasks
  | 'webapp.memory_view'       // v1.17.0 — read-access to keyed memory entries (list/detail)
  | 'webapp.memory_mutate'     // v1.17.0 — create/update/delete on keyed memory entries
  | 'webapp.audit_view'        // v1.17.0 — read-access to audit log (list/detail)
  | 'coach.nudge'             // v1.18.0 ADR 018 D13: coach nudge logged (hash+len only in audit; body in memory)
  | 'coach.research'          // v1.18.0 ADR 018 D13: coach research result logged
  | 'coach.idea'              // v1.18.0 ADR 018 D13: coach original idea logged
  | 'coach.plan'             // v1.18.0 ADR 018 D13: coach task breakdown logged
  | 'coach.prompt_load_failed' // v1.18.0 commit 6: coach scheduled-fire skipped due to missing coachPrompt.md
  | 'coach.setup'             // v1.18.0 commit 10: coach task created/updated via webapp or chat
  | 'coach.reset_memory'      // v1.18.0 commit 10: all coach.* memory entries deleted
  // v1.19.0 ADR 019 F3 — closed-set additions (12 new categories total)
  | 'calendar.sync_success'          // v1.19.0 D4+D5: forward/reverse sync completed
  | 'calendar.sync_failure'          // v1.19.0 D4+D5: sync failed
  | 'calendar.sync_skipped'          // v1.19.0 D4 pre-spawn + R2 circuit breaker
  | 'calendar.sync_conflict'         // v1.19.0 D7: conflict resolved
  | 'calendar.sync_rejected_injection' // v1.19.0 R1 Layer(a): reverse-sync injection marker hit
  | 'calendar.sync_truncated'        // v1.19.0 R1 Layer(a): reverse-sync truncated at char cap
  | 'calendar.jarvis_created'        // v1.19.0 D8: Jarvis Organize calendar created
  | 'calendar.fail_token_expired'    // v1.19.0 R2 circuit breaker: 5 consecutive failures + DM sent
  | 'calendar.circuit_breaker_reset' // v1.19.0 R2: manual or auto-recovery circuit breaker reset
  | 'coach.fatigue'                  // v1.19.0 D13: item fatigue logged (3 ignored gentle nudges)
  | 'coach.user_override'            // v1.19.0 D3+R3: user NL override logged via coach_log_user_override
  | 'coach.calendar_cursor_reset'   // v1.19.0 D5: reverse-sync cursor reset (manual or corruption recovery)
  // v1.20.0 ADR 020 D14 + R3.b (CP1 revisions) — 6 new audit categories
  | 'coach.event_trigger.fired'      // v1.20.0 D14: spontaneous trigger fired and led to coach DM (success path)
  | 'coach.event_trigger.suppressed' // v1.20.0 D14: spontaneous trigger detected but suppressed
  | 'coach.global_quiet.engaged'     // v1.20.0 D14: user invoked /coach quiet (engage/off/auto-expiry)
  | 'coach.migration_completed'      // v1.20.0 R3.b: __coach__ → __coach_morning__ rewrite succeeded per row
  | 'coach.migration_skipped'        // v1.20.0 R3.b: __coach__ row skipped; __coach_morning__ already exists (idempotent re-run)
  | 'coach.migration_conflict'      // v1.20.0 R3.b: both __coach__ AND __coach_morning__ existed; legacy row dropped
  // v1.21.0 ADR 021 D18 (amended by R1) — bot identity + migration audit categories
  | 'bot.self_message_dropped'      // v1.21.0 R2: incoming message_id matched bot_self_messages → dropped before activation gate
  | 'bot.tool_unauthorized'         // v1.21.0 D6: GATE 1 reject — tool not in specialist allowlist (TOOL_NOT_AVAILABLE_FOR_BOT)
  | 'bot.loop_protection.engaged'   // v1.21.0 D7: loop protection triggered; message dropped after bot-authored-message detection
  | 'bot.migration_completed'       // v1.21.0 R1: per-file rename success (3 rows per full migration)
  | 'bot.migration_skipped'         // v1.21.0 D3: migration target already exists or fresh install — no rename needed
  | 'bot.migration_failed'          // v1.21.0 R1: symlink reject / WAL checkpoint fail / rename fail; detail has subject + reason
  | 'bot.migration_conflict'        // v1.21.0 D3: both legacy and new path exist; legacy left in place for operator review
  | 'bot.identity_resolved'        // v1.21.0 commit 12: BotIdentity resolved successfully at boot
  | 'bot.delegate'                 // v1.22.14: orchestrator called delegate_to_specialist; detail = {from, to, username, messageId, requestPreview}
  | 'plan.created'                 // v1.22.19: Jarvis created an Avengers plan; detail = {planId, chatId, stepCount, taskPreview}
  | 'plan.step_done'               // v1.22.19: a specialist's reply matched to a plan step + marked done; detail = {planId, stepId, botName, summaryPreview}
  | 'plan.delivered'               // v1.22.19: Jarvis synthesized + uploaded the deliverable; detail = {planId, deliverablePath, deliverableMessageId}
  | 'plan.aborted'                 // v1.22.19: plan closed via /plan close or unrecoverable error; detail = {planId, reason}
  | 'plan.delegation_incomplete'   // v1.22.42: orchestrator dropped a named specialist despite the steering note; detail = {expected, delegated, missing}
  | 'cost.claude_fallback'         // v1.22.21: Ollama provider errored → silently fell back to Claude; detail = {chatId, ollamaProvider, ollamaModel, errSnippet, throttledNotice}
  | 'group.avengers_mode';         // v1.22.1: /avengers chat|assemble on|off toggled per chat

export interface AuditLogRow {
  id: number;
  ts: string;
  category: AuditCategory;
  actor_user_id: number | null;
  actor_chat_id: number | null;
  session_id: number | null;
  detail_json: string;
}

export interface InsertAuditParams {
  category: AuditCategory;
  actor_user_id?: number | null;
  actor_chat_id?: number | null;
  session_id?: number | null;
  detail: Record<string, unknown>;
}

export class AuditLogRepo {
  private readonly db: DbHandle;

  constructor(db: DbHandle) {
    this.db = db;
  }

  /** Insert a single audit_log entry. Lightweight — one INSERT per event. */
  insert(params: InsertAuditParams): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (category, actor_user_id, actor_chat_id, session_id, detail_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.category,
        params.actor_user_id ?? null,
        params.actor_chat_id ?? null,
        params.session_id ?? null,
        JSON.stringify(params.detail),
      );
  }

  /**
   * Insert an audit_log entry and return the new row's integer ID.
   * Used by the webapp.auth_failure debouncer to update suppressedCount in-place.
   */
  insertReturningId(params: InsertAuditParams): number {
    const result = this.db
      .prepare(
        `INSERT INTO audit_log (category, actor_user_id, actor_chat_id, session_id, detail_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.category,
        params.actor_user_id ?? null,
        params.actor_chat_id ?? null,
        params.session_id ?? null,
        JSON.stringify(params.detail),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Update the detail_json of an existing audit row by ID.
   * Used by the webapp.auth_failure debouncer to increment suppressedCount.
   */
  updateDetail(id: number, detail: Record<string, unknown>): void {
    this.db
      .prepare(`UPDATE audit_log SET detail_json = ? WHERE id = ?`)
      .run(JSON.stringify(detail), id);
  }

  /** Return the most recent N audit rows, newest first. */
  listRecent(n: number): AuditLogRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
         FROM audit_log
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(n) as AuditLogRow[];
  }

  /** Return the most recent N rows for a specific session, newest first. */
  listForSession(sessionId: number, n: number): AuditLogRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
         FROM audit_log
         WHERE session_id = ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(sessionId, n) as AuditLogRow[];
  }

  /**
   * Return all audit rows for a specific category, newest first.
   * Primarily used in tests to assert audit emission without time-window filtering.
   */
  listByCategory(category: AuditCategory): AuditLogRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
         FROM audit_log
         WHERE category = ?
         ORDER BY ts DESC`,
      )
      .all(category) as AuditLogRow[];
  }

  /**
   * Return audit rows filtered by category AND actor, since a cutoff ISO timestamp.
   * Newest first. No LIMIT — callers pass narrow windows (days, not months).
   * Uses idx_audit_category_actor_ts (migration 010) for O(log n) lookup.
   */
  listByCategoryAndActorSince(
    category: AuditCategory,
    actorUserId: number,
    sinceIso: string,
  ): AuditLogRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
         FROM audit_log
         WHERE category = ?
           AND actor_user_id = ?
           AND ts >= ?
         ORDER BY ts DESC`,
      )
      .all(category, actorUserId, sinceIso) as AuditLogRow[];
  }

  /**
   * Paginated list of audit rows for a specific actor user (v1.17.0 webapp.audit route).
   *
   * Implements cursor-based forward pagination (R4):
   *   - cursor = null or empty → fetch latest rows (refresh-from-top)
   *   - cursor = base64-encoded "<ts>_<id>" → fetch rows older than that position
   *
   * R6: categories array is validated against KNOWN_AUDIT_CATEGORIES before
   * calling this method. SQL uses parameterized `?` placeholders — never concatenation.
   *
   * @param actorUserId  The authenticated user's ID (per-user scoping).
   * @param categories   Validated AuditCategory values to filter by. Empty = all categories.
   * @param fromIso      Optional ISO 8601 lower-bound timestamp (inclusive).
   * @param toIso        Optional ISO 8601 upper-bound timestamp (inclusive).
   * @param cursorTs     Optional cursor timestamp (exclusive upper bound for pagination).
   * @param cursorId     Optional cursor id (tie-breaker for same-timestamp rows).
   * @param limit        Page size.
   */
  listForUserPaginated(params: {
    actorUserId: number;
    categories: AuditCategory[];
    fromIso?: string;
    toIso?: string;
    cursorTs?: string;
    cursorId?: number;
    limit: number;
  }): AuditLogRow[] {
    const { actorUserId, categories, fromIso, toIso, cursorTs, cursorId, limit } = params;

    const conditions: string[] = ['actor_user_id = ?'];
    const bindings: unknown[] = [actorUserId];

    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(', ');
      conditions.push(`category IN (${placeholders})`);
      bindings.push(...categories);
    }

    if (fromIso) {
      conditions.push('ts >= ?');
      bindings.push(fromIso);
    }

    if (toIso) {
      conditions.push('ts <= ?');
      bindings.push(toIso);
    }

    // Cursor pagination: (ts < cursorTs) OR (ts = cursorTs AND id < cursorId)
    if (cursorTs !== undefined && cursorId !== undefined) {
      conditions.push('(ts < ? OR (ts = ? AND id < ?))');
      bindings.push(cursorTs, cursorTs, cursorId);
    }

    const where = conditions.join(' AND ');
    bindings.push(limit);

    return this.db
      .prepare(
        `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
         FROM audit_log
         WHERE ${where}
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(...bindings) as AuditLogRow[];
  }

  /**
   * Get a single audit row by ID for a specific user (v1.17.0 webapp.audit detail route).
   * Cross-user isolation: returns null if row belongs to a different user.
   */
  getForUser(id: number, actorUserId: number): AuditLogRow | null {
    return (
      this.db
        .prepare(
          `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
           FROM audit_log
           WHERE id = ? AND actor_user_id = ?`,
        )
        .get(id, actorUserId) as AuditLogRow | undefined
    ) ?? null;
  }

  /**
   * Find the most recent delete audit row for a specific user + itemId.
   * Searches `webapp.item_mutate` rows where detail_json contains
   * `{"action":"delete","itemId":"<id>"}`, falling back to `organize.delete`
   * category for chat-side deletes (v1.14.3 R12 + D9).
   *
   * @returns The matching AuditLogRow or null if no record found.
   */
  findRecentDelete(userId: number, itemId: string): AuditLogRow | null {
    // Search both webapp.item_mutate (action=delete) and organize.delete (chat-side).
    // SQLite JSON functions are not available in all builds; use LIKE for portability.
    const categories: AuditCategory[] = ['webapp.item_mutate', 'organize.delete'];
    for (const category of categories) {
      const row = this.db
        .prepare(
          `SELECT id, ts, category, actor_user_id, actor_chat_id, session_id, detail_json
           FROM audit_log
           WHERE category = ?
             AND actor_user_id = ?
             AND detail_json LIKE ?
           ORDER BY ts DESC
           LIMIT 1`,
        )
        .get(category, userId, `%"itemId":"${itemId}"%`) as AuditLogRow | undefined;
      if (row) return row;
    }
    return null;
  }
}

/**
 * Closed set of all known AuditCategory values (v1.17.0 R6).
 *
 * Used by the /api/webapp/audit route to validate the ?categories= filter
 * parameter. Any value NOT in this set is rejected with 400 INVALID_CATEGORY.
 * The set is derived from the AuditCategory union at type level; values must
 * stay in sync when new categories are added.
 */
export const KNOWN_AUDIT_CATEGORIES: ReadonlySet<AuditCategory> = new Set<AuditCategory>([
  'tool_call',
  'model_switch',
  'admin_command',
  'confirmation',
  'compaction',
  'agent.escalation',
  'memory.write',
  'memory.delete',
  'organize.create',
  'organize.update',
  'organize.complete',
  'organize.progress',
  'organize.delete',
  'organize.inconsistency',
  'organize.nudge',
  'scheduler.create',
  'scheduler.delete',
  'scheduler.pause',
  'scheduler.policy',
  'scheduler.resume',
  'organize.reconcile',
  'organize.trash.evict',
  'debate.complete',
  'debate.cancel',
  'webapp.auth_failure',
  'webapp.item_mutate',
  'webapp.stale_edit',
  'organize.restore',
  'webapp.item_create',
  'webapp.debate_view',
  'debate.persistence_error',
  'webapp.scheduled_view',
  'webapp.scheduled_mutate',
  'webapp.memory_view',
  'webapp.memory_mutate',
  'webapp.audit_view',
  // v1.18.0 ADR 018 D13 coach audit categories
  'coach.nudge',
  'coach.research',
  'coach.idea',
  'coach.plan',
  // v1.18.0 commit 6 + commit 10 coach lifecycle categories
  'coach.prompt_load_failed',
  'coach.setup',
  'coach.reset_memory',
  // v1.19.0 ADR 019 F3 — 12 new categories (calendar sync + coach overrides)
  'calendar.sync_success',
  'calendar.sync_failure',
  'calendar.sync_skipped',
  'calendar.sync_conflict',
  'calendar.sync_rejected_injection',
  'calendar.sync_truncated',
  'calendar.jarvis_created',
  'calendar.fail_token_expired',
  'calendar.circuit_breaker_reset',
  'coach.fatigue',
  'coach.user_override',
  'coach.calendar_cursor_reset',
  // v1.20.0 ADR 020 D14 + R3.b (CP1 revisions) — 6 new categories
  'coach.event_trigger.fired',
  'coach.event_trigger.suppressed',
  'coach.global_quiet.engaged',
  'coach.migration_completed',
  'coach.migration_skipped',
  'coach.migration_conflict',
  // v1.21.0 ADR 021 D18 (amended by R1) — 8 new bot identity + migration categories
  'bot.self_message_dropped',
  'bot.tool_unauthorized',
  'bot.loop_protection.engaged',
  'bot.migration_completed',
  'bot.migration_skipped',
  'bot.migration_failed',
  'bot.migration_conflict',
  'bot.identity_resolved',
  'bot.delegate',
  'plan.created',
  'plan.step_done',
  'plan.delivered',
  'plan.aborted',
  'plan.delegation_incomplete',
  'cost.claude_fallback',
  'group.avengers_mode',
]);
