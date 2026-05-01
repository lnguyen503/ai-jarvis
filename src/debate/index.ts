/**
 * Debate orchestrator — multi-model consensus builder (v1.12.0).
 *
 * Each round every debater sees the topic + all debaters' answers from
 * the previous round and produces an updated stance. After each round a
 * Claude judge decides whether the answers are in substantive agreement.
 * Stops early on consensus; otherwise runs up to `maxRounds`.
 *
 * v1.12.0 changes:
 *  - DebateParams now takes `panel: ProgressPanelApi<DebateState>` instead of `sendMessage`
 *  - DebateState is the authoritative per-run state, updated via panel.updateState()
 *  - Topic scrub: state.topic populated from scrub(params.topic) once at construction
 *  - Transcript scrub (R1): group chat → scrubForGroup; DM → scrub (credential-only)
 *  - Typing pulse (R7): 4s setInterval during each Ollama call
 *  - Audit emission (R5): single terminal row per debate (debate.complete / debate.cancel)
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelProvider, UnifiedMessage } from '../providers/types.js';
import { stripThinkTags } from '../providers/adapters.js';
import { child } from '../logger/index.js';
import { pickRoster, type DebaterRoster } from './pool.js';
import { scrub } from '../safety/scrubber.js';
import { scrubForGroup } from '../safety/groupScrub.js';
import { writeAllReportFormats } from '../plan/reportFormats.js';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { ProgressPanelApi } from '../gateway/progressPanel.js';

const log = child({ component: 'debate' });

/**
 * Max tokens per debater turn. Must be generous enough that reasoning
 * models (minimax-m2.x, deepseek-v3.x, qwen3) still have budget left to
 * produce a visible answer after their internal <think> blocks. 400
 * wasn't enough — minimax was burning the whole budget inside <think>
 * and returning empty visible content.
 */
const DEBATER_MAX_TOKENS = 1200;
/** Max tokens for the judge call. */
const JUDGE_MAX_TOKENS = 300;

export interface Turn {
  model: string;
  text: string;
}

/**
 * Per-debate state. Lives in the panel's state store and is updated via
 * panel.updateState() at every significant lifecycle transition.
 */
export interface DebateState {
  status:
    | 'starting'
    | 'running'
    | 'judging'
    | 'synthesizing-verdict'
    | 'consensus'
    | 'final-verdict'
    | 'cancelled';
  /** Scrubbed at construction from params.topic (credential scrub only, not path). */
  topic: string;
  /** Ollama model IDs participating in the debate. */
  roster: string[];
  /** 0 until the first round actually starts running. */
  currentRound: number;
  totalRounds: number;
  /** The model currently producing a turn; null between turns. */
  currentModel: string | null;
  /** ALL turns across ALL rounds, with text scrubbed per chat type. */
  transcript: Turn[];
  verdict: null | {
    kind: 'consensus' | 'final-arbiter';
    summary: string;
    decision?: string;
    rationale?: string;
    dissent?: string;
  };
  cancelled: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Full rotations of debaters per round. Stored so panelRender can compute accurate round boundaries. */
  exchangesPerRound: number;
}

// ---------------------------------------------------------------------------
// Persistence hook types (v1.16.0 D6 + R5)
// ---------------------------------------------------------------------------

/**
 * A single debater round event passed to the persistence hook.
 * Mirrors DebateRoundEvent in eventbus.ts — kept separate to avoid a
 * circular import (index.ts → eventbus.ts already depends on index.ts types).
 */
export interface DebateRoundHookEvent {
  roundNumber: number;
  debaterName: string;
  modelName: string;
  content: string;
  ts: string;
}

/**
 * Optional persistence hook passed to runDebate by the gateway.
 *
 * ADR 016 D6: decouples runDebate from the memory layer. Callbacks are
 * awaited in sequence; errors are caught per-callback (R5) — a failing hook
 * does NOT abort the debate. The in-memory state.transcript is the canonical
 * record; the debate.complete audit row at terminal carries the full transcript.
 *
 * Hook ordering invariant (D6): scrub turn → await onRound() (try/catch) →
 * state.transcript.push → panel.updateState. Unscrubbed text never reaches
 * the hook.
 */
export interface DebatePersistenceHook {
  onStart?: (state: DebateState) => Promise<void> | void;
  onRound?: (round: DebateRoundHookEvent) => Promise<void> | void;
  onVerdict?: (verdict: NonNullable<DebateState['verdict']>, reasoning: string | null) => Promise<void> | void;
  onAbort?: (reason: string) => Promise<void> | void;
}

/**
 * DebateParams for v1.12.0.
 * `sendMessage` is removed — all output goes through panel.updateState().
 * `topic` replaces old `question`; state.topic is the scrubbed single source of truth.
 *
 * v1.16.0: Added persistenceHook (D6 + R5) for debate persistence + SSE streaming.
 */
export interface DebateParams {
  /** User-authored topic; will be credential-scrubbed once at state construction. */
  topic: string;
  /** Max rounds. Clamped to [1, 5]. */
  maxRounds: number;
  /** Full rotations of debaters per round. Clamped to [1, 4]. */
  exchangesPerRound: number;
  /** Panel API — receives state updates throughout the run. */
  panel: ProgressPanelApi<DebateState>;
  ollama: ModelProvider;
  claudeClient: Anthropic;
  /** Model used for the Claude judge + consensus synthesis. */
  judgeModel: string;
  abortSignal: AbortSignal;
  /** Chat type at the callsite (R1). Group/supergroup/channel triggers path+hostname scrub on turns. */
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  /** App config for scrubber + other config knobs. */
  config: AppConfig;
  /** MessagingAdapter for the typing pulse (R7). */
  adapter: MessagingAdapter;
  /** Chat ID for the typing pulse and audit row. */
  chatId: number;
  /** MemoryApi for audit emission (R5). */
  memory: MemoryApi;
  /** Telegram userId of the debate initiator for audit rows. */
  actorUserId: number;
  /**
   * v1.16.0 D6 + R5: Optional persistence + SSE hook provided by the gateway.
   * When absent, runDebate behaves exactly as before (Telegram-only mode).
   * On callback error: log.warn + emit debate.persistence_error audit row; debate continues.
   */
  persistenceHook?: DebatePersistenceHook;
  /**
   * v1.16.0 R5: Debate run UUID, provided by the gateway when persistenceHook is set.
   * Used to populate debateRunId in debate.persistence_error audit rows.
   * Optional — if absent, debateRunId in the audit row will be undefined.
   */
  debateRunId?: string;
}

export interface DebateResult {
  rounds: number;
  consensusReached: boolean;
  roster: DebaterRoster;
}

const SYSTEM_DEBATER = (name: string, peers: string[]) =>
  `You are "${name}", one of ${peers.length + 1} models in an ADVERSARIAL debate. ` +
  `Other debaters: ${peers.join(', ')}. ` +
  `Your job is to pressure-test ideas, not to be polite. ` +
  `When another debater has spoken, you MUST: ` +
  `(1) quote or paraphrase the specific claim you're responding to, and ` +
  `(2) either attack its weakest assumption with a concrete counter-argument, ` +
  `or defend your own position against the last attack with evidence. ` +
  `"I agree" is only acceptable when the opposing argument is genuinely airtight — ` +
  `and even then, add one refinement or edge case the prior speaker missed. ` +
  `Push back hard on vague claims, missing constraints, unstated trade-offs, ` +
  `and scale/cost/security blind spots. ` +
  `Keep each turn under ~120 words. Plain prose. No markdown tables. ` +
  `Do not restate the question. Do not pad with pleasantries. ` +
  `Do NOT emit <think>...</think> blocks, chain-of-thought, or internal ` +
  `reasoning sections — go straight to the response.`;

const SYSTEM_JUDGE =
  'You are a debate judge. Given a topic and N model answers, decide whether the answers are in substantive agreement. ' +
  'Agreement means the core recommendation is the same even if phrasing differs. ' +
  'Minor detail differences still count as agreement. ' +
  'Respond with STRICT JSON on a single line: {"consensus": true|false, "summary": "one-sentence synthesis if consensus, else short note on disagreement"}. ' +
  'No prose outside the JSON.';

const SYSTEM_FINAL_VERDICT =
  'You are an arbiter resolving a multi-model debate that did not reach consensus. ' +
  'Read the full transcript and the original topic. Pick the single best answer ' +
  'or recommendation, weigh the strongest argument from each side, and explain why ' +
  'the chosen one wins. Do not split the difference unless the topic genuinely ' +
  'has multiple correct answers — pick decisively and own it. ' +
  'Respond with STRICT JSON on a single line: ' +
  '{"decision": "the chosen recommendation in one or two sentences", ' +
  '"rationale": "why this wins over the alternatives, citing specific debater claims", ' +
  '"dissent": "one sentence noting the strongest argument you overruled, or empty string if none"}. ' +
  'No prose outside the JSON. No markdown.';

/**
 * Apply appropriate scrub to a turn's text based on chat type (R1).
 * Group/supergroup/channel → full path+hostname+credential scrub.
 * Private → credential-only scrub.
 */
function scrubTurnText(text: string, chatType: DebateParams['chatType'], config: AppConfig): string {
  if (chatType === 'private') {
    return scrub(text);
  }
  return scrubForGroup(text, config);
}

/** Minimal HTML escape for the standalone verdict message. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Format the verdict as a standalone HTML message sent AFTER panel.finalize.
 * The verdict is the most important part of the debate; it deserves its own
 * visible space rather than being truncated to 80 chars in the panel summary
 * or buried in the expanded-transcript footer. Returns null when there's no
 * verdict (cancelled debates).
 */
function formatVerdictForStandalone(state: DebateState): string | null {
  if (!state.verdict) return null;
  const rounds = state.currentRound;
  const roundsLabel = `${rounds} round${rounds === 1 ? '' : 's'}`;

  if (state.verdict.kind === 'consensus') {
    return (
      `🏆 <b>Consensus reached</b> · ${roundsLabel}\n\n` +
      escapeHtml(state.verdict.summary)
    );
  }

  // final-arbiter
  const lines: string[] = [`⚖️ <b>Claude verdict</b> · ${roundsLabel}`, ''];
  if (state.verdict.decision) {
    lines.push(`<b>Recommendation:</b> ${escapeHtml(state.verdict.decision)}`);
  }
  if (state.verdict.rationale) {
    lines.push('');
    lines.push(`<b>Why:</b> ${escapeHtml(state.verdict.rationale)}`);
  }
  if (state.verdict.dissent) {
    lines.push('');
    lines.push(`<b>Dissent acknowledged:</b> ${escapeHtml(state.verdict.dissent)}`);
  }
  return lines.join('\n');
}

/**
 * v1.12.1 — render the full debate as a markdown document for file attachment.
 * Used when the transcript is too long to fit in the panel's 4000-char expand
 * view. Telegram has no length limit on file content, so the user gets EVERY
 * turn, every round, every debater pushing back — exactly as the audit row
 * preserves them. The audit_log row is the source of truth; this function
 * just formats it for human reading.
 */
function formatTranscriptForFile(state: DebateState): string {
  const lines: string[] = [];
  lines.push(`# Debate Transcript`);
  lines.push('');
  lines.push(`**Topic:** ${state.topic}`);
  lines.push('');
  lines.push(`**Debaters (${state.roster.length}):** ${state.roster.join(', ')}`);
  lines.push(`**Rounds completed:** ${state.currentRound} of ${state.totalRounds} configured`);
  lines.push(`**Exchanges per round:** ${state.exchangesPerRound}`);
  lines.push(`**Total turns:** ${state.transcript.length}`);
  if (state.endedAt) {
    const durSec = Math.round((state.endedAt - state.startedAt) / 1000);
    const durMin = Math.floor(durSec / 60);
    const durRem = durSec % 60;
    lines.push(`**Duration:** ${durMin}m ${durRem}s`);
  }
  if (state.cancelled) {
    lines.push(`**Status:** ⊘ Cancelled mid-run`);
  }
  lines.push('');

  if (state.verdict) {
    lines.push(`---`);
    lines.push('');
    if (state.verdict.kind === 'consensus') {
      lines.push(`## 🏆 Consensus reached`);
      lines.push('');
      lines.push(state.verdict.summary);
    } else {
      lines.push(`## ⚖️ Claude verdict (no consensus among debaters)`);
      lines.push('');
      if (state.verdict.decision) {
        lines.push(`**Recommendation:** ${state.verdict.decision}`);
        lines.push('');
      }
      if (state.verdict.rationale) {
        lines.push(`**Why:** ${state.verdict.rationale}`);
        lines.push('');
      }
      if (state.verdict.dissent) {
        lines.push(`**Dissent acknowledged:** ${state.verdict.dissent}`);
      }
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push('');
  lines.push(`## Full Transcript`);
  lines.push('');

  const rosterLen = state.roster.length > 0 ? state.roster.length : 1;
  const exchanges = state.exchangesPerRound > 0 ? state.exchangesPerRound : 1;
  const turnsPerRound = rosterLen * exchanges;

  let roundIdx = 1;
  for (let i = 0; i < state.transcript.length; i += turnsPerRound) {
    const roundTurns = state.transcript.slice(i, i + turnsPerRound);
    if (roundTurns.length === 0) break;
    lines.push(`### Round ${roundIdx}`);
    lines.push('');
    for (const turn of roundTurns) {
      lines.push(`**${turn.model}:**`);
      lines.push('');
      lines.push(turn.text);
      lines.push('');
    }
    roundIdx++;
  }

  return lines.join('\n');
}

/**
 * v1.12.1 — total transcript char count. Used to decide whether the file
 * attachment is needed (panel's expand view caps at ~4000 chars; below that,
 * the panel handles it without a file).
 */
function transcriptTotalChars(transcript: Turn[]): number {
  let n = 0;
  for (const t of transcript) n += t.text.length;
  return n;
}

/**
 * Wrap the debater call with a 4-second typing pulse (R7).
 * Fires one immediate sendChatAction, then every 4s while waiting.
 * Clears the interval whether the call succeeds or throws.
 */
async function callDebaterWithPulse(
  adapter: MessagingAdapter,
  chatId: number,
  args: {
    provider: ModelProvider;
    model: string;
    peers: string[];
    topic: string;
    transcript: Turn[];
    abortSignal: AbortSignal;
  },
): Promise<Turn> {
  const pulse = setInterval(() => {
    void adapter.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  try {
    void adapter.sendChatAction(chatId, 'typing').catch(() => {});
    return await callDebater(args);
  } finally {
    clearInterval(pulse);
  }
}

/**
 * Emit a debate.persistence_error audit row when a persistenceHook callback
 * throws or rejects (R5 / D6.b). Does NOT rethrow — debate continues.
 */
async function emitPersistenceErrorAudit(
  params: DebateParams,
  hookName: 'onStart' | 'onRound' | 'onVerdict' | 'onAbort',
  err: unknown,
  roundNumber?: number,
  debaterName?: string,
): Promise<void> {
  const errorMsg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  try {
    const detail: Record<string, unknown> = {
      hookName,
      error: errorMsg,
    };
    if (params.debateRunId) detail['debateRunId'] = params.debateRunId;
    if (roundNumber !== undefined) detail['roundNumber'] = roundNumber;
    if (debaterName) detail['debaterName'] = debaterName;

    params.memory.auditLog.insert({
      category: 'debate.persistence_error',
      actor_user_id: params.actorUserId,
      detail,
    });
  } catch (auditErr) {
    log.warn(
      { err: auditErr instanceof Error ? auditErr.message : String(auditErr), hookName },
      'Failed to insert debate.persistence_error audit row',
    );
  }
}

export async function runDebate(params: DebateParams): Promise<DebateResult> {
  const maxRounds = Math.max(1, Math.min(5, params.maxRounds));
  const exchangesPerRound = Math.max(1, Math.min(4, params.exchangesPerRound));

  // R8: scrub the topic once at construction (credential-only, regardless of chat type —
  // topic is user-authored and may legitimately reference paths/hostnames).
  const scrubbedTopic = scrub(params.topic);

  const roster = pickRoster(scrubbedTopic);

  // Build initial state. All downstream LLM calls read state.topic — never params.topic.
  let state: DebateState = {
    status: 'starting',
    topic: scrubbedTopic,
    roster: roster.models,
    currentRound: 0,
    totalRounds: maxRounds,
    currentModel: null,
    transcript: [],
    verdict: null,
    cancelled: false,
    startedAt: Date.now(),
    endedAt: null,
    exchangesPerRound,
  };

  params.panel.updateState(state);

  // v1.16.0 D6: persistenceHook.onStart — called before first round.
  // Per-callback try/catch (R5): error → log.warn + audit; debate continues.
  if (params.persistenceHook?.onStart) {
    try {
      await params.persistenceHook.onStart(state);
    } catch (err) {
      log.warn(
        { component: 'debate', hookName: 'onStart', err: err instanceof Error ? err.message : String(err) },
        'persistenceHook.onStart failed; debate continues',
      );
      await emitPersistenceErrorAudit(params, 'onStart', err);
    }
  }

  let consensusReached = false;
  let roundsCompleted = 0;
  // Round-robin speaker order — rotated by one slot each round.
  let speakerOrder = [...roster.models];

  try {
    // Transition to 'running' before first round
    state = { ...state, status: 'running', currentRound: 1 };
    params.panel.updateState(state);

    for (let r = 1; r <= maxRounds; r++) {
      if (params.abortSignal.aborted) break;

      state = { ...state, currentRound: r };
      params.panel.updateState(state);

      const roundStart = state.transcript.length;

      for (let e = 0; e < exchangesPerRound; e++) {
        for (const model of speakerOrder) {
          if (params.abortSignal.aborted) break;

          // Signal which model is currently speaking
          state = { ...state, currentModel: model };
          params.panel.updateState(state);

          const rawTurn = await callDebaterWithPulse(params.adapter, params.chatId, {
            provider: params.ollama,
            model,
            peers: roster.models.filter((m) => m !== model),
            topic: state.topic,
            transcript: state.transcript,
            abortSignal: params.abortSignal,
          });

          // R1: scrub turn text before appending to transcript
          const scrubbedText = scrubTurnText(rawTurn.text, params.chatType, params.config);
          const scrubbedTurn: Turn = { model: rawTurn.model, text: scrubbedText };

          // v1.16.0 D6 hook ordering: scrub → onRound (try/catch) → transcript push → panel.
          // Unscrubbed text never reaches the hook.
          if (params.persistenceHook?.onRound) {
            const roundEvent: DebateRoundHookEvent = {
              roundNumber: r,
              debaterName: rawTurn.model,
              modelName: rawTurn.model,
              content: scrubbedText,
              ts: new Date().toISOString(),
            };
            try {
              await params.persistenceHook.onRound(roundEvent);
            } catch (err) {
              log.warn(
                {
                  component: 'debate',
                  hookName: 'onRound',
                  roundNumber: r,
                  debaterName: rawTurn.model,
                  err: err instanceof Error ? err.message : String(err),
                },
                'persistenceHook.onRound failed; debate continues',
              );
              await emitPersistenceErrorAudit(params, 'onRound', err, r, rawTurn.model);
            }
          }

          const newTranscript = [...state.transcript, scrubbedTurn];
          state = { ...state, transcript: newTranscript, currentModel: null };
          params.panel.updateState(state);
        }
      }

      roundsCompleted = r;

      // Judge sees only this round's turns
      const roundTurns = state.transcript.slice(roundStart);
      if (r < maxRounds && !params.abortSignal.aborted) {
        // Signal judging phase
        state = { ...state, status: 'judging' };
        params.panel.updateState(state);

        const verdict = await judgeConsensus(
          params.claudeClient,
          params.judgeModel,
          state.topic,
          roundTurns,
          params.abortSignal,
        );

        if (verdict.consensus) {
          consensusReached = true;
          const endedAt = Date.now();
          const finalVerdict = {
            kind: 'consensus' as const,
            summary: verdict.summary,
          };
          state = {
            ...state,
            status: 'consensus',
            verdict: finalVerdict,
            endedAt,
          };

          // v1.16.0 D6: persistenceHook.onVerdict for consensus
          if (params.persistenceHook?.onVerdict) {
            try {
              await params.persistenceHook.onVerdict(finalVerdict, null);
            } catch (err) {
              log.warn(
                { component: 'debate', hookName: 'onVerdict', err: err instanceof Error ? err.message : String(err) },
                'persistenceHook.onVerdict failed; debate continues',
              );
              await emitPersistenceErrorAudit(params, 'onVerdict', err);
            }
          }

          params.panel.updateState(state);
          break;
        }

        // No consensus — transition back to running for next round
        state = { ...state, status: 'running' };
        params.panel.updateState(state);
      }

      // Rotate speaker order
      speakerOrder = [...speakerOrder.slice(1), speakerOrder[0]!];
    }

    if (!consensusReached && !params.abortSignal.aborted) {
      // No consensus after maxRounds — synthesize-verdict path
      state = { ...state, status: 'synthesizing-verdict' };
      params.panel.updateState(state);

      const verdict = await forceFinalVerdict(
        params.claudeClient,
        params.judgeModel,
        state.topic,
        state.transcript,
        params.abortSignal,
      );

      const endedAt = Date.now();
      const finalArbiterVerdict = {
        kind: 'final-arbiter' as const,
        summary: verdict.decision,
        decision: verdict.decision,
        rationale: verdict.rationale,
        dissent: verdict.dissent || undefined,
      };

      state = {
        ...state,
        status: 'final-verdict',
        verdict: finalArbiterVerdict,
        endedAt,
      };

      // v1.16.0 D6: persistenceHook.onVerdict for final-arbiter
      if (params.persistenceHook?.onVerdict) {
        try {
          await params.persistenceHook.onVerdict(finalArbiterVerdict, verdict.rationale ?? null);
        } catch (err) {
          log.warn(
            { component: 'debate', hookName: 'onVerdict', err: err instanceof Error ? err.message : String(err) },
            'persistenceHook.onVerdict failed; debate continues',
          );
          await emitPersistenceErrorAudit(params, 'onVerdict', err);
        }
      }

      params.panel.updateState(state);
    }

    // Handle abort after loop exits
    if (params.abortSignal.aborted && state.status !== 'consensus' && state.status !== 'final-verdict') {
      const endedAt = Date.now();
      state = {
        ...state,
        status: 'cancelled',
        cancelled: true,
        endedAt,
      };

      // v1.16.0 D6: persistenceHook.onAbort for user-cancelled
      if (params.persistenceHook?.onAbort) {
        try {
          await params.persistenceHook.onAbort('user-cancelled');
        } catch (err) {
          log.warn(
            { component: 'debate', hookName: 'onAbort', err: err instanceof Error ? err.message : String(err) },
            'persistenceHook.onAbort failed; debate continues',
          );
          await emitPersistenceErrorAudit(params, 'onAbort', err);
        }
      }

      params.panel.updateState(state);
    }

    // Finalize the panel and emit audit row
    await params.panel.finalize(state);
    emitAuditRow(params, state, roundsCompleted, exchangesPerRound);

    // v1.12.1 — send the verdict as its own standalone message so users see
    // Claude's full decision without having to expand the panel and without
    // 80-char summary truncation. Cancelled debates have no verdict.
    const verdictHtml = formatVerdictForStandalone(state);
    if (verdictHtml) {
      try {
        await params.adapter.sendMessage(params.chatId, verdictHtml, { parseMode: 'HTML' });
      } catch (sendErr) {
        log.warn(
          { err: sendErr instanceof Error ? sendErr.message : String(sendErr) },
          'Failed to send standalone verdict message',
        );
      }
    }

    // v1.12.1 — when the transcript is too long for the panel's 4000-char
    // expand view, send the FULL transcript as multi-format attachments so
    // the user can read every turn from every debater in every round on any
    // device. Mirrors /research's v1.8.4 multi-format pattern: .md (source),
    // .txt (universally readable, including iOS/Android file viewers that
    // don't render markdown), .docx (formatted for Word/Pages/Google Docs).
    // Threshold ~3500 chars: below that the panel's expand button is enough.
    const totalChars = transcriptTotalChars(state.transcript);
    if (state.transcript.length > 0 && totalChars > 3500) {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const mdPath = path.join(tmpdir(), `debate-transcript-${stamp}.md`);
      const cleanup: string[] = [];
      try {
        const md = formatTranscriptForFile(state);
        await writeFile(mdPath, md, 'utf8');
        const formats = await writeAllReportFormats(mdPath, md);
        cleanup.push(formats.md, formats.txt, formats.docx);

        const rounds = state.currentRound;
        const turns = state.transcript.length;
        const captionTxt =
          `📎 Full transcript (txt) — ${turns} turns over ${rounds} round${rounds === 1 ? '' : 's'}` +
          ` · readable on any phone.`;
        const captionDocx =
          `📎 Full transcript (docx) — same content, formatted for Word/Pages/Google Docs.`;
        const captionMd =
          `📎 Full transcript (md) — source format with markdown headings.`;

        // Order: .txt first (most universally readable on phones), then
        // .docx (best-formatted), then .md (source). Each send is best-effort;
        // a failure on one doesn't block the others.
        await params.adapter
          .sendDocument(params.chatId, formats.txt, { caption: captionTxt })
          .catch((e) => log.warn({ err: e instanceof Error ? e.message : String(e) }, 'txt attachment failed'));
        await params.adapter
          .sendDocument(params.chatId, formats.docx, { caption: captionDocx })
          .catch((e) => log.warn({ err: e instanceof Error ? e.message : String(e) }, 'docx attachment failed'));
        await params.adapter
          .sendDocument(params.chatId, formats.md, { caption: captionMd })
          .catch((e) => log.warn({ err: e instanceof Error ? e.message : String(e) }, 'md attachment failed'));
      } catch (sendErr) {
        log.warn(
          { err: sendErr instanceof Error ? sendErr.message : String(sendErr) },
          'Failed to generate transcript file attachments',
        );
      } finally {
        // Best-effort temp cleanup. Telegram has already buffered each file
        // server-side by the time sendDocument resolves.
        for (const p of cleanup) {
          try {
            await unlink(p);
          } catch {
            // ignore — OS will eventually GC tmpdir
          }
        }
      }
    }
  } catch (err) {
    // On unexpected error — mark cancelled, finalize, rethrow
    const endedAt = Date.now();
    state = {
      ...state,
      status: 'cancelled',
      cancelled: true,
      endedAt,
    };
    try {
      params.panel.updateState(state);
      await params.panel.finalize(state);
      emitAuditRow(params, state, roundsCompleted, exchangesPerRound);
    } catch (innerErr) {
      log.warn(
        { err: innerErr instanceof Error ? innerErr.message : String(innerErr) },
        'Failed to finalize panel on debate error',
      );
    }
    // v1.16.0 D6: persistenceHook.onAbort for unexpected error
    if (params.persistenceHook?.onAbort) {
      try {
        const reason = err instanceof Error ? err.message : String(err);
        await params.persistenceHook.onAbort(reason);
      } catch (hookErr) {
        log.warn(
          { component: 'debate', hookName: 'onAbort', err: hookErr instanceof Error ? hookErr.message : String(hookErr) },
          'persistenceHook.onAbort failed (error path); debate rethrows',
        );
        await emitPersistenceErrorAudit(params, 'onAbort', hookErr);
      }
    }
    throw err;
  }

  return {
    rounds: roundsCompleted,
    consensusReached,
    roster,
  };
}

/**
 * Emit the single terminal audit row for this debate (R5).
 * `debate.complete` for consensus/final-verdict; `debate.cancel` for cancelled.
 */
function emitAuditRow(
  params: DebateParams,
  state: DebateState,
  roundsCompleted: number,
  _exchangesPerRound: number,
): void {
  try {
    const detail: Record<string, unknown> = {
      topic: state.topic.length > 200 ? state.topic.slice(0, 200) + '…' : state.topic,
      chatType: params.chatType,
      roster: state.roster,
      rounds: roundsCompleted,
      consensusReached: state.verdict?.kind === 'consensus',
      durationMs: (state.endedAt ?? Date.now()) - state.startedAt,
      turns: state.transcript.map((t) => ({
        model: t.model,
        text: t.text.length > 8000 ? t.text.slice(0, 8000) + '…' : t.text,
      })),
      verdict: state.verdict ?? undefined,
      cancelled: state.cancelled,
    };

    params.memory.auditLog.insert({
      category: state.cancelled ? 'debate.cancel' : 'debate.complete',
      actor_user_id: params.actorUserId,
      actor_chat_id: params.chatId,
      detail,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to emit debate audit row',
    );
  }
}

async function forceFinalVerdict(
  claude: Anthropic,
  model: string,
  topic: string,
  transcript: Turn[],
  abortSignal: AbortSignal,
): Promise<{ decision: string; rationale: string; dissent: string }> {
  const userText =
    `Topic: ${topic}\n\n` +
    `Full debate transcript (oldest first):\n\n` +
    transcript.map((t) => `[${t.model}]: ${t.text}`).join('\n\n') +
    `\n\n——\nMake the final call. Strict JSON only.`;

  try {
    const res = await claude.messages.create(
      {
        model,
        max_tokens: 600,
        system: SYSTEM_FINAL_VERDICT,
        messages: [{ role: 'user', content: userText }],
      },
      { signal: abortSignal, timeout: 45_000 },
    );
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const parsed = JSON.parse(cleaned) as {
      decision?: unknown;
      rationale?: unknown;
      dissent?: unknown;
    };
    return {
      decision: typeof parsed.decision === 'string' ? parsed.decision.trim() : '(no decision returned)',
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '(no rationale returned)',
      dissent: typeof parsed.dissent === 'string' ? parsed.dissent.trim() : '',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Final-verdict call failed');
    return {
      decision: '(arbiter call failed)',
      rationale: `Could not produce a final decision: ${msg}. Review the transcript above and decide manually.`,
      dissent: '',
    };
  }
}

async function callDebater(args: {
  provider: ModelProvider;
  model: string;
  peers: string[];
  topic: string;
  transcript: Turn[];
  abortSignal: AbortSignal;
}): Promise<Turn> {
  const system = SYSTEM_DEBATER(args.model, args.peers);

  let userText: string;
  if (args.transcript.length === 0) {
    userText =
      `Topic: ${args.topic}\n\n` +
      `You speak first. State your position with a specific, concrete claim ` +
      `that later debaters can attack. No hedging.`;
  } else {
    const last = args.transcript[args.transcript.length - 1]!;
    userText =
      `Topic: ${args.topic}\n\n` +
      `Debate transcript so far (oldest first):\n` +
      args.transcript.map((t) => `[${t.model}]: ${t.text}`).join('\n\n') +
      `\n\n——\n` +
      `Your turn. The last speaker was "${last.model}". ` +
      `Start by quoting or paraphrasing their specific claim, then attack its weakest ` +
      `assumption OR defend against any attack on your own prior position. ` +
      `Don't be diplomatic — find the real flaw.`;
  }

  const messages: UnifiedMessage[] = [{ role: 'user', content: userText }];
  try {
    const res = await args.provider.call({
      model: args.model,
      system,
      messages,
      tools: [],
      maxTokens: DEBATER_MAX_TOKENS,
      abortSignal: args.abortSignal,
    });

    // Prefer the <think>-stripped text. If empty, fall back to raw tail.
    let text = stripThinkTags(res.content).trim();
    if (!text && res.content.trim()) {
      const raw = res.content.trim();
      const lastThink = raw.lastIndexOf('<think>');
      const afterThink = lastThink >= 0 ? raw.slice(lastThink + 7) : raw;
      text = afterThink.replace(/<\/?think>/gi, '').trim();
      if (text.length > 600) text = text.slice(-600);
      if (text) text = `_(reasoning-truncated; showing tail)_\n${text}`;
    }
    if (!text) {
      log.warn(
        { model: args.model, rawLen: res.content.length },
        'Debater returned empty visible content',
      );
      text = '(no visible response — model likely exhausted its budget inside <think>)';
    }
    return { model: args.model, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ model: args.model, err: msg }, 'Debater call failed');
    return { model: args.model, text: `_(error: ${msg})_` };
  }
}

async function judgeConsensus(
  claude: Anthropic,
  model: string,
  topic: string,
  turns: Turn[],
  abortSignal: AbortSignal,
): Promise<{ consensus: boolean; summary: string }> {
  const userText =
    `Topic: ${topic}\n\n` +
    `Answers:\n` +
    turns.map((t) => `— ${t.model}: ${t.text}`).join('\n\n');

  try {
    const res = await claude.messages.create(
      {
        model,
        max_tokens: JUDGE_MAX_TOKENS,
        system: SYSTEM_JUDGE,
        messages: [{ role: 'user', content: userText }],
      },
      { signal: abortSignal, timeout: 30_000 },
    );
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const parsed = JSON.parse(cleaned) as {
      consensus?: unknown;
      summary?: unknown;
    };
    return {
      consensus: parsed.consensus === true,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : '(no summary)',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Judge call failed — treating as no consensus');
    return { consensus: false, summary: `judge error: ${msg}` };
  }
}

/**
 * Per-chat debate config. In-memory — resets on process restart.
 */
interface DebateChatConfig {
  enabled: boolean;
  maxRounds: number;
  exchangesPerRound: number;
}

const debateConfigMap = new Map<number, DebateChatConfig>();

export function isDebateEnabled(chatId: number): boolean {
  return debateConfigMap.get(chatId)?.enabled === true;
}

export function getDebateRounds(chatId: number): number {
  return debateConfigMap.get(chatId)?.maxRounds ?? 2;
}

export function getDebateExchanges(chatId: number): number {
  return debateConfigMap.get(chatId)?.exchangesPerRound ?? 2;
}

export function setDebate(
  chatId: number,
  enabled: boolean,
  rounds = 2,
  exchangesPerRound = 2,
): void {
  const roundsClamped = Math.max(1, Math.min(5, Math.floor(rounds)));
  const exchangesClamped = Math.max(1, Math.min(4, Math.floor(exchangesPerRound)));
  debateConfigMap.set(chatId, {
    enabled,
    maxRounds: roundsClamped,
    exchangesPerRound: exchangesClamped,
  });
}

/**
 * Export the roster picker so the /debate command can preview which
 * models would debate a given topic without actually running it.
 */
export { pickRoster };
export type { DebaterRoster };
