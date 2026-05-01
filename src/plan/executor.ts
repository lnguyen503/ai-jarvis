/**
 * Plan & Execute — sequential task executor.
 *
 * For each task in a plan, calls the existing agent.turn() with the task
 * framed as a user message. Lets the existing model router pick the
 * provider (Ollama by default per config). After each task transition,
 * pokes the panel updater so the live Telegram message reflects state.
 *
 * MVP guarantees:
 * - Tasks run sequentially in plan order.
 * - Single hard cap: 10-minute wall-clock for the whole plan.
 * - Single failure does not abort the plan; the executor records the
 *   failure and moves to the next task. (Synthesis tasks may end up with
 *   incomplete inputs — that is the planner's failure mode to handle.)
 * - On wall-time expiry, the in-flight task aborts and remaining tasks
 *   are marked 'failed' with error='timeout'.
 */

import { mkdir } from 'node:fs/promises';
import type { AgentApi } from '../agent/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { ModelProvider } from '../providers/types.js';
import type { Plan } from './types.js';
import { createPanelUpdater } from './panel.js';
import { synthesizeWithDebate } from './synthesizer.js';
import { child } from '../logger/index.js';

const log = child({ component: 'plan.executor' });

/** Default plan wall-clock budget — used when the skill doesn't override.
 *  Research uses this default; /build extends to 30 min via skill override. */
const DEFAULT_PLAN_WALL_TIME_MS = 15 * 60 * 1000; // 15 minutes
/** Default per-task wall-clock cap so one task can't eat the whole budget. */
const DEFAULT_PER_TASK_WALL_TIME_MS = 5 * 60 * 1000; // 5 minutes

/** Per-task tool-iteration ceiling. OSS models loop sometimes so they need
 *  a tighter circuit breaker; Claude almost never does, so we cap high —
 *  it's just a tripwire against a truly broken turn. Real protection is
 *  the wall-time cap above. */
function iterationCapFor(provider: 'claude' | 'ollama-cloud' | undefined): number {
  return provider === 'claude' ? 40 : 20;
}

export interface ExecutorParams {
  plan: Plan;
  sessionId: number;
  userId: number | undefined;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  agent: AgentApi;
  adapter: MessagingAdapter;
  /** Ollama provider for the multi-model synthesis pass. */
  ollama: ModelProvider;
  /** When set, every task's agent.turn() uses this provider (bypasses router). */
  forceProvider?: 'claude' | 'ollama-cloud';
  /** Optional model override paired with forceProvider. Used so /research
   *  --claude defaults to Haiku and --sonnet escalates. */
  forceModel?: string;
  /** External abort (e.g., from a future /cancel command). */
  abortSignal: AbortSignal;
}

/**
 * Execute every task in the plan sequentially.
 * Mutates `plan` in place: task statuses, plan.status, summaries, errors.
 * Always resolves (never throws) — terminal state is reflected in plan.status.
 */
export async function executePlan(params: ExecutorParams): Promise<void> {
  const { plan, sessionId, userId, chatType, agent, adapter } = params;

  // Make sure the plan directory exists before tasks try to write to it.
  await mkdir(plan.planDir, { recursive: true });

  const updater = createPanelUpdater(adapter, plan);

  // Per-skill time budgets (skills like /build need more headroom). Falls
  // back to the executor defaults when the skill doesn't override.
  const planWallTimeMs = plan.skill.planWallTimeMs ?? DEFAULT_PLAN_WALL_TIME_MS;
  const perTaskWallTimeMs = plan.skill.perTaskWallTimeMs ?? DEFAULT_PER_TASK_WALL_TIME_MS;

  // Combine external abort with our own wall-time abort. Track the abort
  // reason so failures show the truth ("wall-time" vs "/cancel" vs
  // "per-task timeout") instead of the misleading "/stop" message.
  const wallController = new AbortController();
  let abortReason: 'wall-time' | 'external' | undefined;
  const wallTimer = setTimeout(() => {
    abortReason = abortReason ?? 'wall-time';
    wallController.abort();
  }, planWallTimeMs);
  const onExternalAbort = (): void => {
    abortReason = abortReason ?? 'external';
    wallController.abort();
  };
  params.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

  plan.status = 'running';
  updater.update();

  try {
    for (const task of plan.tasks) {
      if (wallController.signal.aborted) {
        // This task never got to run because the plan ran out of time
        // (or was cancelled). Mark it failed with an honest reason.
        task.status = 'failed';
        task.error =
          abortReason === 'wall-time'
            ? `plan wall-time hit (>${planWallTimeMs / 60_000} min) before this task ran`
            : abortReason === 'external'
              ? 'cancelled before this task ran'
              : 'aborted before this task ran';
        continue;
      }

      task.status = 'running';
      updater.update();

      const taskBrief = plan.skill.buildTaskBrief(plan, task);

      // Per-task timeout — shorter than the plan-wide cap so one task
      // can't monopolize the whole plan budget. Signals abort to the
      // in-flight agent.turn() via AbortController chaining.
      const taskController = new AbortController();
      let perTaskTimedOut = false;
      const taskTimer = setTimeout(() => {
        perTaskTimedOut = true;
        taskController.abort();
      }, perTaskWallTimeMs);
      const onPlanAbort = (): void => taskController.abort();
      wallController.signal.addEventListener('abort', onPlanAbort, { once: true });
      // Fix for HIGH (Anti-Slop, 2026-04-23): close the race window where
      // wallController fires BETWEEN the loop-head `if (aborted)` check
      // and the listener attach above. A { once: true } listener attached
      // after the event already fired never runs, so the task would have
      // continued for up to perTaskWallTimeMs past the plan wall-time.
      // Re-check and trigger immediately if abort already fired.
      if (wallController.signal.aborted) onPlanAbort();

      // Pulse the "typing…" chat action every 4s so the bot doesn't look
      // frozen between panel edits. Telegram auto-fades the indicator
      // after ~5s on its own. Fires a leading pulse immediately.
      void adapter.sendChatAction(plan.chatId, 'typing');
      const typingTimer = setInterval(() => {
        void adapter.sendChatAction(plan.chatId, 'typing');
      }, 4000);

      try {
        const result = await agent.turn({
          chatId: plan.chatId,
          sessionId,
          userText: taskBrief,
          abortSignal: taskController.signal,
          userId,
          chatType,
          maxIterationsOverride: iterationCapFor(params.forceProvider),
          // Each task runs with a clean context so it's forced to do its
          // own research rather than riff on the prior task's tool results.
          freshContext: true,
          forceProvider: params.forceProvider,
          forceModel: params.forceModel,
        });
        task.status = 'completed';
        task.summary = firstNonEmptyLine(result.replyText, 200);
        if (result.usage) {
          plan.totalUsage = {
            input_tokens: (plan.totalUsage?.input_tokens ?? 0) + result.usage.input_tokens,
            output_tokens: (plan.totalUsage?.output_tokens ?? 0) + result.usage.output_tokens,
            cache_creation_input_tokens:
              (plan.totalUsage?.cache_creation_input_tokens ?? 0) +
              (result.usage.cache_creation_input_tokens ?? 0),
            cache_read_input_tokens:
              (plan.totalUsage?.cache_read_input_tokens ?? 0) +
              (result.usage.cache_read_input_tokens ?? 0),
          };
        }
        // Record which model is actually being used so the panel can
        // pick the right pricing. Resolve from forceModel when set,
        // otherwise from the provider default.
        if (!plan.modelUsed && params.forceProvider === 'claude') {
          plan.modelUsed = params.forceModel ?? 'claude-sonnet-4-6';
        }
        log.info(
          {
            planId: plan.id,
            taskIndex: task.index,
            toolCalls: result.toolCalls,
            inputTokens: result.usage?.input_tokens,
            outputTokens: result.usage?.output_tokens,
            cacheCreated: result.usage?.cache_creation_input_tokens,
            cacheRead: result.usage?.cache_read_input_tokens,
          },
          'Task completed',
        );
      } catch (err) {
        task.status = 'failed';
        // Honest abort messages — distinguish wall-time, per-task timeout,
        // user /cancel, and real errors. Way more useful than the generic
        // "Claude API call aborted by /stop" we used to bubble up.
        const raw = err instanceof Error ? err.message : String(err);
        if (perTaskTimedOut) {
          task.error = `per-task timeout (>${perTaskWallTimeMs / 60_000} min)`;
        } else if (abortReason === 'wall-time') {
          task.error = `plan wall-time hit (>${planWallTimeMs / 60_000} min)`;
        } else if (abortReason === 'external') {
          task.error = 'cancelled';
        } else {
          task.error = raw;
        }
        log.warn(
          { planId: plan.id, taskIndex: task.index, err: task.error, abortReason },
          'Task failed',
        );
      } finally {
        clearTimeout(taskTimer);
        clearInterval(typingTimer);
        wallController.signal.removeEventListener('abort', onPlanAbort);
      }

      updater.update();
    }

    const anySucceeded = plan.tasks.some((t) => t.status === 'completed');
    const anyFailed = plan.tasks.some((t) => t.status === 'failed');

    // Run multi-model synthesis if at least one task gathered something.
    //
    // Wall-time abort → still synthesize (give the user SOMETHING —
    //   better than silent loss on a long plan).
    // External abort (user tapped /cancel) → skip synthesis (user said
    //   "stop"; spending 2-3 more minutes of Ollama is exactly what they
    //   didn't want).
    if (anySucceeded && abortReason !== 'external') {
      plan.status = 'synthesizing';
      await updater.flush();
      const partial = wallController.signal.aborted;
      if (partial) {
        log.info(
          { planId: plan.id, abortReason },
          'Running synthesis on partial results (wall-time/cancel fired)',
        );
      }

      // Keep the "typing…" pulse going through synthesis too — it runs
      // 3 Ollama drafters sequentially plus a merge, easily 2-3 minutes.
      void adapter.sendChatAction(plan.chatId, 'typing');
      const synthTypingTimer = setInterval(() => {
        void adapter.sendChatAction(plan.chatId, 'typing');
      }, 4000);

      try {
        // Fix for MEDIUM (Scalability, 2026-04-23): synthesis must ignore
        // wall-time aborts (so a plan that ran long still gets a report)
        // but MUST honor user /cancel (so tapping the Cancel button
        // actually stops the 2-3 min Ollama synthesis). We pass the
        // external signal (params.abortSignal, which /cancel flows
        // through) NOT wallController.signal (which mixes wall-time +
        // external). If external already fired, this resolves instantly
        // via the existing abort and synthesis skips.
        const synthesis = await synthesizeWithDebate({
          plan,
          ollama: params.ollama,
          abortSignal: params.abortSignal,
        });
        plan.reportPath = synthesis.reportPath;
        plan.reportPaths = synthesis.reportPaths;
        log.info(
          {
            planId: plan.id,
            successfulDrafts: synthesis.successfulDrafts,
            mergeSucceeded: synthesis.mergeSucceeded,
            reportPath: synthesis.reportPath,
          },
          'Synthesis complete',
        );

        // Auto-deliver all three report formats. Order matters:
        //   1. .docx — most likely to render properly on a phone (Word /
        //      Pages / Google Docs / iOS Files preview). Sent first so it
        //      appears at the bottom of the chat scroll = closest to the
        //      panel = easiest to tap on mobile.
        //   2. .txt — universal fallback. Any text viewer opens it.
        //   3. .md — source of truth for technical readers / LLM re-ingest.
        //
        // Each send is independent — one failure (e.g. file deleted) does
        // not skip the others. De-dupe by path: when conversion fails, all
        // three paths fall back to the .md, so we send it once.
        const deliveries: Array<{ path: string; label: string }> = [
          { path: synthesis.reportPaths.docx, label: 'docx' },
          { path: synthesis.reportPaths.txt, label: 'txt' },
          { path: synthesis.reportPaths.md, label: 'md' },
        ];
        const sentPaths = new Set<string>();
        for (const { path: filePath, label } of deliveries) {
          if (sentPaths.has(filePath)) continue;
          sentPaths.add(filePath);
          try {
            await params.adapter.sendDocument(plan.chatId, filePath, {
              caption: `📄 ${plan.skill.label} ${plan.id} report (.${label})`,
            });
          } catch (err) {
            log.warn(
              { planId: plan.id, format: label, err: err instanceof Error ? err.message : String(err) },
              'Failed to send report file',
            );
          }
        }
      } catch (err) {
        log.error(
          { planId: plan.id, err: err instanceof Error ? err.message : String(err) },
          'Synthesizer threw',
        );
      } finally {
        clearInterval(synthTypingTimer);
      }
    }

    plan.status = anyFailed && !anySucceeded ? 'failed' : 'completed';
  } finally {
    clearTimeout(wallTimer);
    params.abortSignal.removeEventListener('abort', onExternalAbort);
    await updater.flush();
  }

  log.info(
    {
      planId: plan.id,
      finalStatus: plan.status,
      taskCount: plan.tasks.length,
      elapsedMs: Date.now() - plan.startedAt,
    },
    'Plan execution finished',
  );
}

function firstNonEmptyLine(text: string, maxLen: number): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1) + '…' : trimmed;
    }
  }
  return '';
}
