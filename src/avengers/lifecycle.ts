/**
 * Avengers plan lifecycle (v1.22.19).
 *
 * Coordinates the end-to-end flow:
 *
 *   createPlanAndPost     — called by gateway after Jarvis's turn delegates ≥2
 *                           specialists. Inserts plan + steps, posts TODO.
 *   markStepDoneFromReply — called by gateway when a peer-bot reply arrives in
 *                           a chat with an active plan. Matches the reply to
 *                           an open step, marks done with summary + detail,
 *                           re-renders + edits the TODO message in place. If
 *                           all specialist steps close, kicks off synthesis.
 *   synthesizeAndDeliver  — composes the HTML deliverable mechanically from
 *                           step contents (templated intro/conclusion for v1;
 *                           Jarvis-composed glue text deferred to v1.22.20),
 *                           writes to disk, uploads via bot.api.sendDocument,
 *                           transitions plan to 'delivered'.
 *
 * Per-bot isolation: this module runs ONLY in the ai-jarvis process. The
 * MemoryApi.plans repo lives in ai-jarvis's SQLite. Specialists never touch
 * it; they just reply in the chat as normal and Jarvis observes.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Api, InputFile as InputFileType } from 'grammy';
import { InputFile } from 'grammy';
import type pino from 'pino';
import type { MemoryApi, PlanRow, PlanStepRow } from '../memory/index.js';
import type { BotIdentity } from '../config/botIdentity.js';
import { renderTodoMessage, renderHtmlDeliverable, formatElapsed } from './render.js';
import { markThreadStopped, deriveThreadKey } from '../gateway/loopProtection.js';
import type { AppConfig } from '../config/index.js';
import { consumeTranscript } from './debateTransport.js';
import {
  writeGroupState,
  clearGroupState,
  type GroupStateSnapshot,
  type GroupStateStep,
} from './groupStateBridge.js';

export interface AvengersLifecycleDeps {
  memory: MemoryApi;
  botIdentity: BotIdentity;
  bot: { api: Api };
  logger: pino.Logger;
  /**
   * v1.22.27 — webapp publicUrl for opening the Operations Dashboard via
   * Telegram Web App inline button. When unset, the lifecycle falls back to
   * the in-chat TODO without a dashboard button.
   */
  config?: AppConfig;
}

export interface DelegationRecord {
  specialist: string;          // e.g. 'ai-tony'
  request: string;
  delegateMessageId: number;
}

export class AvengersPlanLifecycle {
  private readonly deps: AvengersLifecycleDeps;

  constructor(deps: AvengersLifecycleDeps) {
    this.deps = deps;
  }

  /**
   * Create a plan from a Jarvis turn's delegations and post the initial TODO
   * message. Idempotent guard: if an active plan already exists for the chat,
   * skip (we don't open multiple concurrent plans per chat).
   *
   * Returns the new plan id, or null if skipped.
   */
  async createPlanAndPost(opts: {
    chatId: number;
    task: string;
    delegations: DelegationRecord[];
  }): Promise<number | null> {
    const { memory, bot, logger } = this.deps;

    if (opts.delegations.length < 2) {
      return null; // single delegation = no plan
    }

    const existing = memory.plans.findActiveForChat(opts.chatId);
    if (existing) {
      logger.info(
        { chatId: opts.chatId, existingPlanId: existing.id },
        'avengers.plan: active plan already open for chat — skipping new plan',
      );
      return null;
    }

    const { plan, steps } = memory.plans.create({
      chatId: opts.chatId,
      task: opts.task,
      steps: opts.delegations.map((d) => ({
        botName: d.specialist,
        request: d.request,
        delegateMessageId: d.delegateMessageId,
      })),
    });

    // Render and post the initial TODO message. Try first WITH the Web App
    // button; if Telegram rejects the button (BUTTON_TYPE_INVALID — happens
    // when the webapp publicUrl domain isn't registered with BotFather for
    // this bot via /setdomain), retry WITHOUT the button so the TODO still
    // appears with live status updates. Without this fallback the entire
    // TODO message is lost.
    const html = renderTodoMessage(plan, steps);
    let todoMessageId: number | null = null;
    const dashboardUrl = buildDashboardUrl(this.deps.config, plan.id, opts.chatId);

    // v1.22.29 — switched from `web_app` button to `url` button. Telegram
    // rejects `web_app` buttons in supergroups (private chats only per the
    // Bot API docs). A `url` button opens the dashboard in the user's
    // external browser, which works everywhere. The dashboard's auth path
    // accepts the chatId+planId signed token in the URL when there's no
    // Telegram WebApp initData (external-browser case).
    const trySend = async (withButton: boolean): Promise<number | null> => {
      const sendOpts: Parameters<typeof bot.api.sendMessage>[2] = { parse_mode: 'HTML' };
      if (withButton && dashboardUrl) {
        sendOpts.reply_markup = {
          inline_keyboard: [[{ text: '📊 Open Operations Dashboard', url: dashboardUrl }]],
        };
      }
      const sent = await bot.api.sendMessage(opts.chatId, html, sendOpts);
      return sent.message_id;
    };

    try {
      todoMessageId = await trySend(/* withButton */ !!dashboardUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { planId: plan.id, err: msg },
        'avengers.plan: initial TODO post failed; retrying without dashboard button',
      );
      try {
        todoMessageId = await trySend(/* withButton */ false);
      } catch (fallbackErr) {
        logger.error(
          { planId: plan.id, err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
          'avengers.plan: TODO post fallback (no button) also failed',
        );
      }
    }

    if (todoMessageId !== null) {
      memory.plans.setTodoMessageId(plan.id, todoMessageId);

      // v1.22.27 — auto-pin the TODO so it stays visible at top of chat
      // even as specialist replies push other messages down. Best-effort:
      // Telegram returns 400 if the bot lacks pin-message permissions or
      // is not an admin in the group.
      // v1.22.29 — upgraded from debug to warn so we can actually see why
      // pinning is failing in production. Also log on success.
      try {
        await bot.api.pinChatMessage(opts.chatId, todoMessageId, { disable_notification: true });
        logger.info(
          { planId: plan.id, todoMessageId },
          'avengers.plan: TODO pinned',
        );
      } catch (pinErr) {
        logger.warn(
          { planId: plan.id, todoMessageId, err: pinErr instanceof Error ? pinErr.message : String(pinErr) },
          'avengers.plan: pin failed (likely missing admin or pin-message permission for this bot in this group)',
        );
      }
    }

    memory.auditLog.insert({
      category: 'plan.created',
      actor_chat_id: opts.chatId,
      detail: {
        planId: plan.id,
        chatId: opts.chatId,
        stepCount: steps.length,
        taskPreview: opts.task.slice(0, 120),
      },
    });

    logger.info(
      { planId: plan.id, chatId: opts.chatId, steps: steps.length, todoMessageId },
      'avengers.plan: created and TODO posted',
    );

    // v1.23.0 — emit group-state snapshot for specialists to read in WORK mode.
    this.emitGroupState(opts.chatId);

    return plan.id;
  }

  /**
   * v1.23.0 — write the current chat's plan state to the shared-file bridge
   * so specialists (other processes) can see it. Best-effort; failures are
   * logged but never block lifecycle events.
   */
  private emitGroupState(chatId: number): void {
    const { memory, logger } = this.deps;
    const plan = memory.plans.findActiveForChat(chatId);
    let snapshot: GroupStateSnapshot;
    if (plan === null) {
      snapshot = {
        chatId,
        activePlan: null,
        updatedAt: new Date().toISOString(),
      };
    } else {
      const stepRows = memory.plans.stepsFor(plan.id);
      const steps: GroupStateStep[] = stepRows.map((s) => ({
        bot: s.bot_name,
        request: s.request,
        status: s.status === 'in_progress' ? 'in_progress' : (s.status as GroupStateStep['status']),
        summary: s.summary,
      }));
      snapshot = {
        chatId,
        activePlan: {
          id: plan.id,
          task: plan.task,
          steps,
          createdAt: plan.created_at,
        },
        updatedAt: new Date().toISOString(),
      };
    }
    writeGroupState(snapshot, logger);
  }

  /**
   * Match a peer-bot reply to an open step in the chat's active plan and
   * mark it done. Re-renders the TODO and edits in place. If this closes the
   * last specialist step, transitions the plan to synthesizing + kicks off
   * deliverable composition.
   *
   * No-op if the chat has no active plan or no open step matches the bot.
   */
  async markStepDoneFromReply(opts: {
    chatId: number;
    senderBotName: string;       // canonical name e.g. 'ai-tony'
    replyText: string;
    replyMessageId: number | null;
  }): Promise<void> {
    const { memory, bot, logger } = this.deps;

    const plan = memory.plans.findActiveForChat(opts.chatId);
    if (!plan) return;

    const step = memory.plans.findOpenStepForBot(plan.id, opts.senderBotName);
    if (!step) return;

    // v1.22.20 — smart matching filter. The previous implementation marked the
    // FIRST peer-bot reply as the step's work, which led to "." or
    // sync-arguments closing real steps with garbage. Filter out replies that
    // don't look like substantive work:
    //   - too short (< 100 chars after trim)
    //   - sync-noise patterns ("I already did", "this one's for X", etc.)
    // When skipped, log + return; the step stays open for a later, better
    // reply from the same bot.
    if (!isSubstantiveWorkReply(opts.replyText)) {
      logger.debug(
        {
          planId: plan.id,
          stepId: step.id,
          botName: opts.senderBotName,
          replyPreview: opts.replyText.slice(0, 80),
          replyLen: opts.replyText.trim().length,
        },
        'avengers.plan: peer-bot reply is not substantive work — step stays open',
      );
      return;
    }

    const { summary, detail } = extractSummaryAndDetail(opts.replyText);
    memory.plans.markStepDone(step.id, summary, detail, opts.replyMessageId);

    memory.auditLog.insert({
      category: 'plan.step_done',
      actor_chat_id: opts.chatId,
      detail: {
        planId: plan.id,
        stepId: step.id,
        botName: opts.senderBotName,
        summaryPreview: summary.slice(0, 120),
      },
    });

    // v1.22.35 — pick up the debate transcript the specialist wrote before
    // posting. Persist rounds + outcome into Jarvis's plans DB so the
    // dashboard can render them. Best-effort: if no transcript file exists
    // (debate didn't run, or specialist's process crashed mid-debate), the
    // step still closes normally.
    const transcript = consumeTranscript(opts.chatId, opts.senderBotName, logger);
    if (transcript) {
      try {
        for (const round of transcript.rounds) {
          memory.plans.insertDebateRound({
            stepId: step.id,
            round: round.round,
            speaker: round.speaker,
            model: round.model,
            text: round.text,
            verdict: round.verdict,
          });
        }
        memory.plans.setStepDebateOutcome(
          step.id,
          transcript.outcome === 'approved' ? 'approved' : 'contested',
          transcript.totalRoundsRun,
        );
        logger.info(
          {
            planId: plan.id,
            stepId: step.id,
            botName: opts.senderBotName,
            outcome: transcript.outcome,
            rounds: transcript.totalRoundsRun,
          },
          'avengers.plan: debate transcript persisted',
        );
      } catch (err) {
        logger.warn(
          { stepId: step.id, err: err instanceof Error ? err.message : String(err) },
          'avengers.plan: failed to persist debate transcript (proceeding without)',
        );
      }
    }

    // Re-render and edit the TODO message in place.
    await this.refreshTodoMessage(plan.id);

    // v1.23.0 — refresh group-state snapshot so specialists' next WORK turns
    // see the updated step status (their peer's reply just landed).
    this.emitGroupState(opts.chatId);

    // If every specialist step is closed, kick off synthesis.
    if (memory.plans.allSpecialistStepsClosed(plan.id)) {
      logger.info(
        { planId: plan.id, chatId: opts.chatId },
        'avengers.plan: all specialist steps closed — triggering synthesis',
      );
      // Fire-and-forget; do not block the gateway turn on synthesis duration.
      void this.synthesizeAndDeliver(plan.id).catch((err) => {
        logger.error(
          { planId: plan.id, err: err instanceof Error ? err.message : String(err) },
          'avengers.plan: synthesis pipeline threw',
        );
      });
    }
  }

  /**
   * Re-render the TODO from current plan + steps and edit the Telegram
   * message in place. No-op if no todo_message_id (initial post failed).
   */
  async refreshTodoMessage(planId: number): Promise<void> {
    const { memory, bot, logger } = this.deps;
    const plan = memory.plans.getById(planId);
    if (!plan || !plan.todo_message_id) return;

    const steps = memory.plans.stepsFor(planId);
    const html = renderTodoMessage(plan, steps);

    // v1.22.27 — keep the Web App button on every edit. The button label
    // shifts to "📄 View Deliverable" once the plan is delivered.
    // v1.22.28 — same BUTTON_TYPE_INVALID fallback as the initial post:
    // retry the edit without the inline keyboard if Telegram rejects it.
    const dashboardUrl = buildDashboardUrl(this.deps.config, planId, plan.chat_id);
    const buttonLabel = plan.status === 'delivered'
      ? '📄 View Operation Dashboard'
      : '📊 Open Operations Dashboard';

    const tryEdit = async (withButton: boolean): Promise<void> => {
      const editOpts: Parameters<typeof bot.api.editMessageText>[3] = { parse_mode: 'HTML' };
      if (withButton && dashboardUrl) {
        editOpts.reply_markup = {
          inline_keyboard: [[{ text: buttonLabel, url: dashboardUrl }]],
        };
      }
      await bot.api.editMessageText(plan.chat_id, plan.todo_message_id!, html, editOpts);
    };

    try {
      await tryEdit(/* withButton */ !!dashboardUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Telegram silently fails on identical-content edits; that's not an error.
      if (msg.includes('message is not modified')) return;
      // Fallback: retry without button.
      try {
        await tryEdit(/* withButton */ false);
        return;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        if (fbMsg.includes('message is not modified')) return;
        logger.warn(
          { planId, err: fbMsg },
          'avengers.plan: TODO edit failed (proceeding without re-render)',
        );
      }
    }
  }

  /**
   * Compose the HTML deliverable from completed step contents, write it to
   * disk under the plan's directory, upload to the chat, and transition the
   * plan to 'delivered'. v1: templated intro/conclusion (mechanical, no LLM
   * round-trip). v1.22.20+ may add a Jarvis-composed synthesis turn.
   */
  async synthesizeAndDeliver(planId: number): Promise<void> {
    const { memory, botIdentity, bot, logger } = this.deps;
    const plan = memory.plans.getById(planId);
    if (!plan) return;
    if (plan.status === 'delivered' || plan.status === 'closed' || plan.status === 'aborted') {
      return; // already terminal
    }

    memory.plans.setStatus(planId, 'synthesizing');
    await this.refreshTodoMessage(planId);

    const steps = memory.plans.stepsFor(planId);
    const elapsedSec = (Date.now() - new Date(plan.created_at).getTime()) / 1000;

    const intro = composeIntro(plan, steps);
    const conclusion = composeConclusion(plan, steps, elapsedSec);

    const html = renderHtmlDeliverable({ plan, steps, intro, conclusion });
    const filename = `avengers-operation-${plan.id}.html`;
    const planDir = path.resolve(botIdentity.dataDir, 'plans', String(plan.id));
    const filePath = path.join(planDir, filename);

    try {
      await fs.mkdir(planDir, { recursive: true });
      await fs.writeFile(filePath, html, 'utf8');
    } catch (err) {
      logger.error(
        { planId, err: err instanceof Error ? err.message : String(err) },
        'avengers.plan: failed to write deliverable to disk',
      );
      memory.plans.setStatus(planId, 'aborted');
      memory.auditLog.insert({
        category: 'plan.aborted',
        actor_chat_id: plan.chat_id,
        detail: { planId, reason: 'write_failed' },
      });
      await this.refreshTodoMessage(planId);
      return;
    }

    let deliverableMessageId: number | null = null;
    try {
      const sent = await bot.api.sendDocument(
        plan.chat_id,
        new InputFile(filePath, filename) as InputFileType,
        {
          caption: `📎 Avengers Operation #${plan.id} — deliverable ready. Open in browser to view.`,
          disable_content_type_detection: false,
        },
      );
      deliverableMessageId = sent.message_id;
    } catch (err) {
      logger.error(
        { planId, err: err instanceof Error ? err.message : String(err) },
        'avengers.plan: failed to upload deliverable to chat',
      );
      memory.plans.setStatus(planId, 'aborted');
      memory.auditLog.insert({
        category: 'plan.aborted',
        actor_chat_id: plan.chat_id,
        detail: { planId, reason: 'upload_failed' },
      });
      await this.refreshTodoMessage(planId);
      return;
    }

    memory.plans.setDeliverable(planId, filePath, deliverableMessageId);
    memory.plans.setStatus(planId, 'delivered');
    memory.auditLog.insert({
      category: 'plan.delivered',
      actor_chat_id: plan.chat_id,
      detail: {
        planId,
        deliverablePath: filePath,
        deliverableMessageId,
        elapsedSec: Math.round(elapsedSec),
      },
    });
    await this.refreshTodoMessage(planId);

    // v1.22.38 — bigger, clearer stand-down so it's visible among any
    // post-delivery chatter from the smaller specialist models. Lists
    // every step + outcome so Boss sees at a glance what shipped, with the
    // file callout last (right where the file attachment renders above).
    const stepLines = steps
      .map((s) => {
        const mark = s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : '⬜';
        const display = displayName(s.bot_name);
        const summary = s.summary && s.summary.trim().length > 0 ? s.summary.slice(0, 100) : '(no summary)';
        return `${mark} <b>${display}</b> — ${summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
      })
      .join('\n');
    const standDownText =
      `🛡️ <b>Operation #${planId} complete</b> — delivered in ${formatElapsed(elapsedSec)}\n\n` +
      `${stepLines}\n\n` +
      `📄 Full deliverable: <code>${filename}</code> (attached above ↑)\n` +
      `<i>Specialists, stand down. Boss — tap the file to read the polished one-pager.</i>`;
    try {
      const sent = await bot.api.sendMessage(plan.chat_id, standDownText, { parse_mode: 'HTML' });
      logger.info(
        { planId, standDownMessageId: sent.message_id },
        'avengers.plan: stand-down message posted',
      );
    } catch (err) {
      logger.warn(
        { planId, err: err instanceof Error ? err.message : String(err) },
        'avengers.plan: stand-down message failed (non-fatal)',
      );
    }
    markThreadStopped(deriveThreadKey(plan.chat_id, undefined));

    // v1.23.0 — clear group-state so specialists see "no active plan" on
    // subsequent turns (until the next directive creates a new one).
    clearGroupState(plan.chat_id, logger);

    logger.info(
      { planId, chatId: plan.chat_id, deliverablePath: filePath, elapsedSec },
      'avengers.plan: delivered',
    );
  }

  /**
   * Operator action: close an active plan without synthesis. Used by /plan
   * close <id> and as a safety net if a plan stalls.
   */
  async abortPlan(planId: number, reason: string): Promise<void> {
    const { memory, logger } = this.deps;
    const plan = memory.plans.getById(planId);
    if (!plan) return;
    if (plan.status === 'delivered' || plan.status === 'closed' || plan.status === 'aborted') return;

    memory.plans.setStatus(planId, 'aborted');
    memory.auditLog.insert({
      category: 'plan.aborted',
      actor_chat_id: plan.chat_id,
      detail: { planId, reason },
    });
    await this.refreshTodoMessage(planId);
    // v1.23.0 — clear shared group-state on abort.
    clearGroupState(plan.chat_id, logger);
  }
}

/**
 * Extract a one-line summary + multi-line detail from a peer-bot reply.
 * Heuristic: first non-empty line = summary; remainder = detail. If the reply
 * is single-line, summary = whole text and detail = ''.
 */
function extractSummaryAndDetail(replyText: string): { summary: string; detail: string } {
  const trimmed = replyText.trim();
  if (trimmed.length === 0) return { summary: '(no reply text)', detail: '' };
  const lines = trimmed.split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty === -1) return { summary: '(no reply text)', detail: '' };
  const summary = lines[firstNonEmpty]!.trim();
  const detailLines = lines.slice(firstNonEmpty + 1).join('\n').trim();
  return {
    summary: summary.length > 200 ? summary.slice(0, 199) + '…' : summary,
    detail: detailLines.length > 0 ? detailLines : summary,
  };
}

/** Templated intro for v1 (mechanical; no LLM round-trip). */
function composeIntro(plan: PlanRow, steps: PlanStepRow[]): string {
  const rundown = steps
    .filter((s) => s.summary && s.summary.trim().length > 0)
    .map((s) => `• ${displayName(s.bot_name)} — ${s.summary}`)
    .join('\n');

  return `The Avengers tackled the following request:

"${plan.task}"

${steps.length} specialist${steps.length === 1 ? '' : 's'} contributed.${rundown.length > 0 ? '\n\nQuick rundown:\n' + rundown : ''}

Full contributions below.`;
}

/** Templated conclusion for v1. */
function composeConclusion(plan: PlanRow, steps: PlanStepRow[], elapsedSec: number): string {
  const completedCount = steps.filter((s) => s.status === 'done').length;
  return `Operation completed in ${formatElapsed(elapsedSec)}. ${completedCount} of ${steps.length} contributions delivered.`;
}

/**
 * v1.22.27 — build the Operations Dashboard URL for a plan. Returns null
 * when webapp.publicUrl isn't set (plan continues to work; just no dashboard
 * button on the TODO). Telegram's web_app.url field requires HTTPS.
 */
function buildDashboardUrl(
  config: AppConfig | undefined,
  planId: number,
  chatId: number,
): string | null {
  const publicUrl = config?.webapp?.publicUrl;
  if (!publicUrl || !publicUrl.startsWith('https://')) return null;
  const base = publicUrl.replace(/\/+$/, '');
  return `${base}/webapp/avengers/?planId=${planId}&chatId=${chatId}`;
}

function displayName(botName: string): string {
  switch (botName) {
    case 'ai-jarvis': return 'Jarvis';
    case 'ai-tony': return 'Tony';
    case 'ai-natasha': return 'Natasha';
    case 'ai-bruce': return 'Bruce';
    default: return botName;
  }
}

/**
 * v1.22.20 — heuristic: does this peer-bot reply look like substantive
 * deliverable work, vs. an acknowledgment / sync argument / status ping?
 *
 * Rules:
 *   1. Must be ≥ 100 chars after trim. Single-line acks ("Copy.", "On it.",
 *      ".", "Understood.") are filtered.
 *   2. Must NOT match obvious sync-argument patterns ("I already did",
 *      "this one's for X", "already shipped", "my piece is done").
 *   3. Must contain at least one alphabetic character (drops "..." / "—" /
 *      pure punctuation replies).
 *
 * Returns true if the reply should close a step. False keeps the step open
 * for a better follow-up reply from the same bot.
 */
const SYNC_NOISE_PATTERNS: RegExp[] = [
  /\bi['']?ve already (?:delivered|shipped|done|submitted|given)\b/i,
  /\balready (?:done|delivered|shipped|submitted|complete|ran this|gave you|did (?:both )?(?:my|the)? ?piece)\b/i,
  /\bmy (?:piece|part|step|item|section) (?:is )?(?:already )?(?:done|complete|delivered|in (?:the )?(?:thread|file))\b/i,
  /\bthis (?:one['']?s|is) for @\w+/i,
  /\bstanding by\b/i,
  /\bcleared hot\b/i,
  /\bwaiting on @\w+/i,
  // v1.22.42 — observed in plan #9 (Postgres prompt). Specialists post a
  // "I can't do this without inputs from peer X" excuse before peer X has
  // even replied. These are sync chatter, not work, but they're long enough
  // (>100 chars) to bypass the length gate. Patterns target the common shape:
  //   "Cannot calculate — neither Tony's hours nor Natasha's…"
  //   "Inputs haven't arrived yet. Ready to run the moment they post."
  //   "Understood. Producing the revised analysis now."
  //   "Still here, inputs haven't arrived yet."
  /\bcannot (?:calculate|compute|complete|proceed|finalize|estimate)\b.*\bwithout\b/i,
  /\bneither\s+(?:tony|natasha|bruce)['']?s?\b/i,
  /\binputs?\s+(?:haven['']?t|have not|hasn['']?t|has not|aren['']?t|are not|isn['']?t|is not)\s+(?:arrived|provided|posted|delivered|landed|in)\b/i,
  /\bready to (?:run|go|start)\b.*\b(?:the moment|once|when|as soon as)\b/i,
  /\bproducing (?:the )?(?:revised|next|updated) (?:analysis|draft|version|response)\b/i,
  /\b(?:still here|standing by|on standby)\b.*\b(?:waiting|inputs?|figures?|peer|tony|natasha|bruce)\b/i,
  /\b(?:tony|natasha|bruce)['']?s? (?:figures?|numbers?|hours?|inputs?|data|estimates?) (?:were|are|have been) not provided\b/i,
];

export function isSubstantiveWorkReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 100) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  for (const pat of SYNC_NOISE_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }
  return true;
}
