/**
 * PlansRepo — Avengers plan tracking (v1.22.19).
 *
 * A plan is a multi-step task created when Jarvis (orchestrator) delegates to
 * 2+ specialists in one turn within an assemble-mode group chat. Each plan
 * tracks its progress through:
 *
 *   active        — specialists still working on at least one step
 *   synthesizing  — all specialist steps done; Jarvis is composing deliverable
 *   delivered     — HTML deliverable uploaded to the chat
 *   closed        — terminal; either delivered or aborted
 *   aborted       — user cancelled or unrecoverable error
 *
 * Per-bot isolation: plans live ONLY in ai-jarvis's data dir. Specialists
 * don't read or write the plans table; their progress is observed by
 * Jarvis's gateway watching for peer-bot replies in the chat.
 */

import type { DbHandle } from './dbDriver.js';

export type PlanStatus = 'active' | 'synthesizing' | 'delivered' | 'closed' | 'aborted';
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface PlanRow {
  id: number;
  chat_id: number;
  task: string;
  status: PlanStatus;
  todo_message_id: number | null;
  deliverable_path: string | null;
  deliverable_message_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PlanStepRow {
  id: number;
  plan_id: number;
  step_order: number;
  bot_name: string;
  request: string;
  summary: string | null;
  detail: string | null;
  status: PlanStepStatus;
  expanded: 0 | 1;
  started_at: string | null;
  completed_at: string | null;
  delegate_message_id: number | null;
  reply_message_id: number | null;
  /** v1.22.35 — debate-for-accuracy state. */
  debate_status: 'none' | 'approved' | 'contested';
  debate_rounds: number;
}

/** v1.22.35 — single turn within a debate. */
export type DebateSpeaker = 'specialist' | 'critic';
export type DebateVerdict = 'approve' | 'revise';

export interface PlanStepDebateRow {
  id: number;
  step_id: number;
  round: number;
  speaker: DebateSpeaker;
  model: string;
  text: string;
  verdict: DebateVerdict | null;
  created_at: string;
}

export interface CreatePlanParams {
  chatId: number;
  task: string;
  steps: Array<{
    botName: string;
    request: string;
    delegateMessageId?: number;
  }>;
}

export class PlansRepo {
  private readonly db: DbHandle;

  constructor(db: DbHandle) {
    this.db = db;
  }

  /**
   * Create a new plan with its initial steps. Returns the plan row + step rows.
   * Atomic: all rows inserted in one transaction.
   */
  create(params: CreatePlanParams): { plan: PlanRow; steps: PlanStepRow[] } {
    const nowIso = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO plans (chat_id, task, status, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(params.chatId, params.task, nowIso, nowIso);
      const planId = Number(result.lastInsertRowid);

      const stepInsert = this.db.prepare(
        `INSERT INTO plan_steps (plan_id, step_order, bot_name, request, status, started_at, delegate_message_id)
         VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
      );

      params.steps.forEach((s, i) => {
        stepInsert.run(planId, i + 1, s.botName, s.request, nowIso, s.delegateMessageId ?? null);
      });

      return planId;
    });

    const planId = tx();
    return {
      plan: this.getById(planId)!,
      steps: this.stepsFor(planId),
    };
  }

  getById(id: number): PlanRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, chat_id, task, status, todo_message_id, deliverable_path,
                  deliverable_message_id, created_at, updated_at, closed_at
           FROM plans WHERE id = ?`,
        )
        .get(id) as PlanRow | undefined) ?? null
    );
  }

  /**
   * Find the active plan for a chat (status in active/synthesizing). Returns
   * the most recent if multiple exist (shouldn't happen in normal flow).
   */
  findActiveForChat(chatId: number): PlanRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, chat_id, task, status, todo_message_id, deliverable_path,
                  deliverable_message_id, created_at, updated_at, closed_at
           FROM plans
           WHERE chat_id = ? AND status IN ('active', 'synthesizing')
           ORDER BY id DESC LIMIT 1`,
        )
        .get(chatId) as PlanRow | undefined) ?? null
    );
  }

  stepsFor(planId: number): PlanStepRow[] {
    return this.db
      .prepare(
        `SELECT id, plan_id, step_order, bot_name, request, summary, detail,
                status, expanded, started_at, completed_at,
                delegate_message_id, reply_message_id,
                debate_status, debate_rounds
         FROM plan_steps
         WHERE plan_id = ?
         ORDER BY step_order ASC`,
      )
      .all(planId) as PlanStepRow[];
  }

  getStepById(id: number): PlanStepRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, plan_id, step_order, bot_name, request, summary, detail,
                  status, expanded, started_at, completed_at,
                  delegate_message_id, reply_message_id,
                  debate_status, debate_rounds
           FROM plan_steps WHERE id = ?`,
        )
        .get(id) as PlanStepRow | undefined) ?? null
    );
  }

  /**
   * Find a pending/in-progress step assigned to a given bot in a plan, by
   * step order (the earliest unfulfilled step for that bot). Used when a peer
   * bot replies in the chat — the gateway calls this to map the reply to a
   * step. Returns null if no open step matches.
   */
  findOpenStepForBot(planId: number, botName: string): PlanStepRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, plan_id, step_order, bot_name, request, summary, detail,
                  status, expanded, started_at, completed_at,
                  delegate_message_id, reply_message_id,
                  debate_status, debate_rounds
           FROM plan_steps
           WHERE plan_id = ? AND bot_name = ? AND status IN ('pending', 'in_progress')
           ORDER BY step_order ASC LIMIT 1`,
        )
        .get(planId, botName) as PlanStepRow | undefined) ?? null
    );
  }

  /**
   * Set the editable TODO message id once Jarvis has posted the initial render.
   */
  setTodoMessageId(planId: number, messageId: number): void {
    this.db
      .prepare(`UPDATE plans SET todo_message_id = ?, updated_at = ? WHERE id = ?`)
      .run(messageId, new Date().toISOString(), planId);
  }

  /**
   * Mark a step done with a one-line summary and full detail.
   */
  markStepDone(stepId: number, summary: string, detail: string, replyMessageId: number | null): void {
    const nowIso = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE plan_steps
           SET status = 'done', summary = ?, detail = ?, completed_at = ?, reply_message_id = ?
           WHERE id = ?`,
        )
        .run(summary, detail, nowIso, replyMessageId, stepId);
      const step = this.getStepById(stepId);
      if (step) {
        this.db
          .prepare(`UPDATE plans SET updated_at = ? WHERE id = ?`)
          .run(nowIso, step.plan_id);
      }
    });
    tx();
  }

  /**
   * Toggle a step's expanded flag. Returns the new value.
   */
  toggleStepExpanded(stepId: number): 0 | 1 {
    const step = this.getStepById(stepId);
    if (!step) return 0;
    const next: 0 | 1 = step.expanded === 1 ? 0 : 1;
    this.db
      .prepare(`UPDATE plan_steps SET expanded = ? WHERE id = ?`)
      .run(next, stepId);
    this.db
      .prepare(`UPDATE plans SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), step.plan_id);
    return next;
  }

  /** True if every specialist step in the plan has status 'done' or 'failed'. */
  allSpecialistStepsClosed(planId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS open FROM plan_steps
         WHERE plan_id = ? AND status IN ('pending', 'in_progress')`,
      )
      .get(planId) as { open: number };
    return row.open === 0;
  }

  setStatus(planId: number, status: PlanStatus): void {
    const nowIso = new Date().toISOString();
    const closedAt: string | null =
      status === 'delivered' || status === 'closed' || status === 'aborted' ? nowIso : null;
    this.db
      .prepare(
        `UPDATE plans
         SET status = ?, updated_at = ?, closed_at = COALESCE(?, closed_at)
         WHERE id = ?`,
      )
      .run(status, nowIso, closedAt, planId);
  }

  setDeliverable(planId: number, path: string, messageId: number | null): void {
    this.db
      .prepare(
        `UPDATE plans
         SET deliverable_path = ?, deliverable_message_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(path, messageId, new Date().toISOString(), planId);
  }

  /**
   * Most recent plan for a chat regardless of status. Used by Jarvis's system
   * prompt builder to inject plan context when he's responding in a chat
   * with a recent operation, so questions like "send me the deliverable"
   * route to the existing upload instead of going off-script.
   */
  findMostRecentForChat(chatId: number): PlanRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, chat_id, task, status, todo_message_id, deliverable_path,
                  deliverable_message_id, created_at, updated_at, closed_at
           FROM plans
           WHERE chat_id = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(chatId) as PlanRow | undefined) ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // v1.22.35 — debate-for-accuracy transcripts
  // ---------------------------------------------------------------------------

  /**
   * Append a debate turn (specialist draft or critic review) to a step's
   * transcript. Returns the inserted row id.
   */
  insertDebateRound(params: {
    stepId: number;
    round: number;
    speaker: DebateSpeaker;
    model: string;
    text: string;
    verdict: DebateVerdict | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO plan_step_debates (step_id, round, speaker, model, text, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.stepId,
        params.round,
        params.speaker,
        params.model,
        params.text,
        params.verdict,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  /** All debate turns for a step, in order. */
  debateRoundsFor(stepId: number): PlanStepDebateRow[] {
    return this.db
      .prepare(
        `SELECT id, step_id, round, speaker, model, text, verdict, created_at
         FROM plan_step_debates
         WHERE step_id = ?
         ORDER BY id ASC`,
      )
      .all(stepId) as PlanStepDebateRow[];
  }

  /**
   * Mark a step's debate complete with outcome metadata. Updates the step
   * row's debate_status and debate_rounds counters.
   */
  setStepDebateOutcome(
    stepId: number,
    status: 'approved' | 'contested',
    rounds: number,
  ): void {
    this.db
      .prepare(
        `UPDATE plan_steps SET debate_status = ?, debate_rounds = ? WHERE id = ?`,
      )
      .run(status, rounds, stepId);
  }

  /** List recent plans for a chat (any status). Used by /plan list. */
  listForChat(chatId: number, limit: number = 10): PlanRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_id, task, status, todo_message_id, deliverable_path,
                deliverable_message_id, created_at, updated_at, closed_at
         FROM plans
         WHERE chat_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(chatId, limit) as PlanRow[];
  }
}
