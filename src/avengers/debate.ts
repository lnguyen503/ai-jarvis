/**
 * Avengers debate-for-accuracy runner (v1.22.35).
 *
 * Flow when a specialist replies to a delegation in an active assemble-mode
 * plan:
 *
 *   1. Specialist's draft (already produced by their agent.turn) is captured.
 *   2. Critic (Jarvis-as-reviewer, on a different model) reviews the draft
 *      and emits a verdict: APPROVE or REVISE — <reason>.
 *   3. If APPROVE → done after 1 round (best outcome — fast + accurate).
 *   4. If REVISE → specialist is called again with the critique to revise.
 *   5. Repeat up to MAX_ROUNDS (3). Early-exit on APPROVE at any round.
 *   6. If 3 rounds end without APPROVE → outcome 'contested', use latest
 *      specialist version. Dashboard surfaces the contested state.
 *
 * Cost guard: this module ONLY uses the Ollama provider. It does NOT fall
 * back to Claude on errors. If the critic times out or errors, the round
 * is recorded as failed and we exit early with whatever we have.
 *
 * Latency reality check: 3 rounds × 2 model calls = 6 sequential model
 * invocations. Plan budget for 1-3 minutes per debate. Boss accepted this
 * tradeoff knowing the cost.
 */

import path from 'node:path';
import fs from 'node:fs';
import type pino from 'pino';
import type { ModelProvider, UnifiedMessage, UnifiedResponse } from '../providers/types.js';

const MAX_ROUNDS = 3;

export type DebateSpeaker = 'specialist' | 'critic';
export type DebateVerdict = 'approve' | 'revise';
export type DebateOutcomeKind = 'approved' | 'contested' | 'aborted';

export interface DebateRound {
  round: number;
  speaker: DebateSpeaker;
  model: string;
  text: string;
  verdict: DebateVerdict | null;
  // Reason from the critic's verdict line, e.g. "Fix the Cloudflare free-tier number…"
  verdictReason?: string;
}

export interface DebateOutcome {
  finalText: string;
  rounds: DebateRound[];
  outcome: DebateOutcomeKind;
  totalRoundsRun: number;
}

export interface RunDebateParams {
  /** The specialist's initial draft (already produced by their agent.turn). */
  initialDraft: string;
  /** The original delegation request from Jarvis to the specialist. */
  request: string;
  /** Display name of the specialist (e.g. 'Tony', 'Natasha', 'Bruce'). */
  specialistDisplayName: string;
  /** Specialist persona file path (config/personas/<bot>.md). */
  specialistPersonaPath: string;
  /** Specialist model id (e.g. 'qwen3-coder:480b'). */
  specialistModel: string;
  /** Critic persona file path. */
  criticPersonaPath: string;
  /** Critic model id (e.g. 'glm-5.1'). */
  criticModel: string;
  /** Ollama provider — debate is Ollama-only by design. */
  ollamaProvider: ModelProvider;
  /** Abort signal for the whole debate. */
  abortSignal: AbortSignal;
  /** Logger. */
  logger: pino.Logger;
  /** Optional per-round callback so callers can persist transcripts as they happen. */
  onRoundComplete?: (round: DebateRound) => void | Promise<void>;
}

/**
 * Parse the critic's verdict from their reply text. Looks for:
 *   VERDICT: APPROVE — <reason>
 *   VERDICT: REVISE  — <reason>
 *
 * Tolerant to: lowercase, extra spaces, missing dash. Returns 'revise' as
 * the default if no clear verdict line is found (errs on the side of more
 * scrutiny rather than false approval).
 */
export function parseVerdict(criticText: string): { verdict: DebateVerdict; reason: string } {
  // Look at the last 600 chars for the verdict line — critics may produce
  // long bulleted issue lists above the verdict.
  const tail = criticText.slice(-600);
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    const m = /^VERDICT\s*[:.]\s*(APPROVE|REVISE)\s*[—\-:]?\s*(.*)$/i.exec(line);
    if (m) {
      const verdict = m[1]!.toUpperCase() === 'APPROVE' ? 'approve' : 'revise';
      const reason = (m[2] ?? '').trim();
      return { verdict, reason };
    }
  }
  // No verdict line found — default to revise so we don't silently approve junk.
  return { verdict: 'revise', reason: 'No explicit verdict line found in critic response' };
}

/**
 * Read a persona file from disk. Returns the raw markdown text. Throws if
 * the file is missing — that's a config error, not a runtime issue.
 */
function readPersonaFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Persona file not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/** Strip text of any tool-use ceremony — debates are pure text exchanges. */
function extractText(response: UnifiedResponse): string {
  return (response.content ?? '').trim();
}

/**
 * Run the up-to-3-round debate. Resolves with the outcome.
 */
export async function runSpecialistDebate(params: RunDebateParams): Promise<DebateOutcome> {
  const {
    initialDraft,
    request,
    specialistDisplayName,
    specialistPersonaPath,
    specialistModel,
    criticPersonaPath,
    criticModel,
    ollamaProvider,
    abortSignal,
    logger,
    onRoundComplete,
  } = params;

  const log = logger.child({ component: 'avengers.debate' });
  const rounds: DebateRound[] = [];
  let currentDraft = initialDraft.trim();

  // Round 1 specialist draft (already produced — record it as the starting point).
  const round1Specialist: DebateRound = {
    round: 1,
    speaker: 'specialist',
    model: specialistModel,
    text: currentDraft,
    verdict: null,
  };
  rounds.push(round1Specialist);
  if (onRoundComplete) await onRoundComplete(round1Specialist);

  let specialistPersona = '';
  let criticPersona = '';
  try {
    specialistPersona = readPersonaFile(specialistPersonaPath);
    criticPersona = readPersonaFile(criticPersonaPath);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'debate: failed to load persona — aborting; using draft as final',
    );
    return {
      finalText: currentDraft,
      rounds,
      outcome: 'aborted',
      totalRoundsRun: 1,
    };
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (abortSignal.aborted) {
      log.warn({ round }, 'debate: aborted by signal');
      return { finalText: currentDraft, rounds, outcome: 'aborted', totalRoundsRun: round };
    }

    // Critic reviews current draft.
    const criticPrompt = buildCriticPrompt({
      request,
      draft: currentDraft,
      specialistDisplayName,
      previousRound: round,
    });

    let criticText: string;
    try {
      const criticResponse = await ollamaProvider.call({
        model: criticModel,
        system: criticPersona,
        messages: [{ role: 'user', content: criticPrompt }],
        tools: [],
        maxTokens: 2048,
        abortSignal,
      });
      criticText = extractText(criticResponse);
    } catch (err) {
      log.error(
        { round, err: err instanceof Error ? err.message : String(err) },
        'debate: critic call failed — exiting with current draft as final (no Claude fallback)',
      );
      return { finalText: currentDraft, rounds, outcome: 'aborted', totalRoundsRun: round };
    }

    const { verdict, reason } = parseVerdict(criticText);
    const criticRound: DebateRound = {
      round,
      speaker: 'critic',
      model: criticModel,
      text: criticText,
      verdict,
      verdictReason: reason,
    };
    rounds.push(criticRound);
    if (onRoundComplete) await onRoundComplete(criticRound);

    log.info(
      { round, verdict, reason: reason.slice(0, 100) },
      'debate: critic verdict',
    );

    if (verdict === 'approve') {
      return {
        finalText: currentDraft,
        rounds,
        outcome: 'approved',
        totalRoundsRun: round,
      };
    }

    if (round === MAX_ROUNDS) {
      // No approval after MAX_ROUNDS — contested. Use latest specialist version.
      log.warn({ round }, 'debate: contested — exhausted rounds without approve, using latest draft');
      return {
        finalText: currentDraft,
        rounds,
        outcome: 'contested',
        totalRoundsRun: round,
      };
    }

    // Specialist revises in light of the critique.
    const revisePrompt = buildSpecialistRevisePrompt({
      request,
      currentDraft,
      criticism: criticText,
      criticReason: reason,
    });

    let revisedText: string;
    try {
      const revisedResponse = await ollamaProvider.call({
        model: specialistModel,
        system: specialistPersona,
        messages: [{ role: 'user', content: revisePrompt }],
        tools: [],
        maxTokens: 4096,
        abortSignal,
      });
      revisedText = extractText(revisedResponse);
    } catch (err) {
      log.error(
        { round, err: err instanceof Error ? err.message : String(err) },
        'debate: specialist revision failed — exiting with current draft as final',
      );
      return { finalText: currentDraft, rounds, outcome: 'aborted', totalRoundsRun: round };
    }

    if (revisedText.length === 0) {
      log.warn({ round }, 'debate: specialist returned empty revision — keeping previous draft');
    } else {
      currentDraft = revisedText;
    }

    const specialistRevision: DebateRound = {
      round: round + 1,
      speaker: 'specialist',
      model: specialistModel,
      text: currentDraft,
      verdict: null,
    };
    rounds.push(specialistRevision);
    if (onRoundComplete) await onRoundComplete(specialistRevision);
  }

  // Should be unreachable given the early-return at MAX_ROUNDS, but TS wants it.
  return { finalText: currentDraft, rounds, outcome: 'contested', totalRoundsRun: MAX_ROUNDS };
}

function buildCriticPrompt(opts: {
  request: string;
  draft: string;
  specialistDisplayName: string;
  previousRound: number;
}): string {
  return `# Review request — round ${opts.previousRound}

## Original task delegated to ${opts.specialistDisplayName}

${opts.request}

## ${opts.specialistDisplayName}'s current draft

${opts.draft}

---

Review the draft above against the original task. Identify the most important issues (max 5). End with a single VERDICT line: APPROVE or REVISE.

If you APPROVE, the draft ships as-is. If you REVISE, ${opts.specialistDisplayName} will revise based on your critique. Don't argue style or length — focus on correctness, completeness, and scope.`;
}

function buildSpecialistRevisePrompt(opts: {
  request: string;
  currentDraft: string;
  criticism: string;
  criticReason: string;
}): string {
  return `Your draft was reviewed by Jarvis-as-critic. He requested a revision. Address his critique and produce an improved version.

## Original task

${opts.request}

## Your previous draft

${opts.currentDraft}

## Jarvis's critique

${opts.criticism}

---

Produce a revised version that addresses the critique. Keep what was already correct; change only what needs changing. Lead with the same one-line summary discipline as your original draft (a one-line headline, then a blank line, then the body in markdown).

The revised draft should be COMPLETE — not a diff or a "here's what I changed" note. Reply with the full final answer.`;
}
