/**
 * Coach configuration schema (v1.18.0).
 *
 * Extracted from config/schema.ts per ADR 018-revisions W1 + R2 to keep
 * schema.ts under the 500 LOC soft threshold once coach config lands.
 *
 * ADR 018-revisions R6/F1 (CONVERGENT BLOCKING): dangerous tools are removed
 * from the coach allowlist by code (config default), NOT by prompt clause alone.
 * See KNOWN_ISSUES.md v1.18.0 invariant 2: "Coach allowlist enforced by code,
 * not prompt."
 *
 * ADR 018 Decision 11 + revisions D11.a (binding).
 */

import { z } from 'zod';

export const coachConfigSchema = z
  .object({
    /**
     * Master on/off for the coach feature.
     * When false, scheduler ${coach_prompt} expansion is skipped and coach
     * subcommands reply with a "coach not enabled" error.
     */
    enabled: z.boolean().default(true),

    /**
     * Tools removed from the coach turn allowlist at the dispatcher level.
     *
     * ADR 018-revisions R6/F1 (CONVERGENT BLOCKING, BINDING):
     * Models slip — prompt-clauses are documentation, not a brake. The brake
     * is code: tools the coach must never call are removed from its allowlist
     * at the dispatcher level (UNAUTHORIZED_IN_CONTEXT).
     *
     * The coach can SUGGEST completion / deletion / memory-forgetting in its DM
     * reply; the user's reply is a normal DM turn (not a coach turn) and runs
     * with the full DM surface. The user is the only path to irreversible
     * mutations.
     *
     * KNOWN_ISSUES.md v1.18.0 invariant 2 cross-reference.
     */
    disabledTools: z
      .array(z.string())
      .default([
        // Pre-existing (D11 baseline)
        'run_command',           // shell exec — wrong shape for coach
        'schedule',              // coach should not create new tasks for the user
        // NEW (R6/F1 binding — irreversible mutation tools code-gated)
        'organize_complete',     // marking items done is user-initiated only (D12 #1 — code-enforced)
        'organize_delete',       // deletion is user-initiated only (D12 #2 — code-enforced)
        'forget_memory',         // memory deletion is user-initiated only
        'calendar_delete_event', // calendar deletion is user-initiated only
        'calendar_update_event', // editing calendar events is user-initiated only
        'gmail_draft',           // even drafts can move money / make commitments — user-initiated only
      ]),
  })
  .default({});

export type CoachConfig = z.infer<typeof coachConfigSchema>;
