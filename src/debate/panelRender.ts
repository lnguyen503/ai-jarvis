/**
 * Panel render callbacks for the /debate ProgressPanel (v1.12.0).
 *
 * Exports: renderDebateSummary, renderDebateDetail, renderDebateButtons.
 *
 * Scrub / escape contract (R11):
 *  - The scrubber (scrubber.ts / groupScrub.ts) has already run on transcript
 *    text and state.topic before this module is called.
 *  - This module is ONLY responsible for HTML-escaping via escape() before returning.
 *  - Never pass raw user or LLM text through without escape().
 *
 * R6 truncation — renderDebateDetail preserves round 1 + most-recent round,
 * elides middle with a marker when necessary.
 */

import { child } from '../logger/index.js';
import type { DebateState, Turn } from './index.js';
import type { InlineKeyboard } from '../messaging/adapter.js';
import { standardPanelButton } from '../gateway/progressPanel.js';

const log = child({ component: 'debate.panelRender' });

const DETAIL_BUDGET = 4000;
const MIDDLE_ELIDE_MARKER =
  '⋯ [N earlier rounds omitted — see /audit filter debate.complete for full transcript] ⋯';
const MARKER_RESERVATION = 100;

// ---------------------------------------------------------------------------
// HTML escape (R11)
// ---------------------------------------------------------------------------

/** Minimal HTML escape for Telegram parse_mode=HTML. */
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

/**
 * renderDebateSummary — collapsed view.
 * Returns a short HTML-safe single line.
 */
export function renderDebateSummary(state: DebateState): string {
  const topicShort = escape(state.topic.length > 80 ? state.topic.slice(0, 80) + '…' : state.topic);

  switch (state.status) {
    case 'starting':
      return `⚔️ Debate: ${topicShort} · starting...`;

    case 'running': {
      const modelPart = state.currentModel
        ? ` · ${escape(state.currentModel)} speaking...`
        : '';
      return `⚔️ Debate: ${topicShort} · Round ${state.currentRound}/${state.totalRounds}${modelPart}`;
    }

    case 'judging':
      return `⚔️ Debate: ${topicShort} · Round ${state.currentRound}/${state.totalRounds} complete · judging...`;

    case 'synthesizing-verdict':
      return `⚔️ Debate: ${topicShort} · Claude synthesizing verdict...`;

    case 'consensus':
      // v1.12.1 — full verdict is sent as a standalone message after finalize.
      // Panel summary stays compact; "verdict ↓" hints at the next message.
      return `⚔️ Debate complete · ${state.currentRound} round${state.currentRound === 1 ? '' : 's'} · 🏆 Consensus reached ↓`;

    case 'final-verdict':
      // v1.12.1 — Claude's verdict is sent as a standalone message after finalize.
      return `⚔️ Debate complete · ${state.currentRound} round${state.currentRound === 1 ? '' : 's'} · ⚖️ Claude verdict ↓`;

    case 'cancelled':
      return `⚔️ Debate cancelled (round ${state.currentRound} of ${state.totalRounds})`;

    default: {
      // Exhaustive check via never
      const _exhaustive: never = state.status;
      log.warn({ status: _exhaustive }, 'renderDebateSummary: unknown status');
      return `⚔️ Debate: ${topicShort}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict footer for detail view
// ---------------------------------------------------------------------------

function verdictFooter(
  verdict: NonNullable<DebateState['verdict']>,
): string {
  if (verdict.kind === 'consensus') {
    return `🏆 Consensus reached\n${verdict.summary}`;
  }
  // final-arbiter
  let text = `⚖️ Claude final decision\n`;
  if (verdict.decision) text += `Recommendation: ${verdict.decision}\n`;
  if (verdict.rationale) text += `Why: ${verdict.rationale}\n`;
  if (verdict.dissent) text += `Dissent noted: ${verdict.dissent}`;
  return text.trim();
}

// ---------------------------------------------------------------------------
// Turn grouping helper
// ---------------------------------------------------------------------------

/**
 * Group the flat transcript into rounds.
 * We approximate round boundaries by `turnsPerRound` = roster.length × exchangesPerRound.
 * Returns an array of round-turn arrays.
 */
export function groupTurnsByRound(
  transcript: Turn[],
  totalRounds: number,
  turnsPerRound: number,
): Turn[][] {
  if (turnsPerRound <= 0 || transcript.length === 0) return [];

  const groups: Turn[][] = [];
  let i = 0;
  while (i < transcript.length) {
    groups.push(transcript.slice(i, i + turnsPerRound));
    i += turnsPerRound;
  }

  // If we have fewer groups than totalRounds, that's fine (debate ended early).
  // Clamp so we don't exceed expected rounds.
  if (groups.length > totalRounds) {
    // Merge excess turns into last group
    const normal = groups.slice(0, totalRounds - 1);
    const overflow = groups.slice(totalRounds - 1).flat();
    return [...normal, overflow];
  }

  return groups;
}

/** Render a single turn to HTML. */
function renderTurn(turn: Turn): string {
  return `<b>${escape(turn.model)}</b>\n${escape(turn.text)}`;
}

// ---------------------------------------------------------------------------
// Detail rendering (R6 truncation)
// ---------------------------------------------------------------------------

/**
 * renderDebateDetail — expanded view.
 *
 * Preserves round 1 + most-recent completed round; elides middle on overflow.
 * Budget: 4000 chars - header - footer - MARKER_RESERVATION.
 */
export function renderDebateDetail(state: DebateState): string {
  const header = `⚔️ Debate: ${escape(state.topic)}\n`;
  const footer = state.verdict ? `\n---\n${escape(verdictFooter(state.verdict))}` : '';

  if (state.transcript.length === 0) {
    return header + `(no turns yet)` + footer;
  }

  const budget = DETAIL_BUDGET - header.length - footer.length - MARKER_RESERVATION;

  // Compute turns-per-round from roster size × exchangesPerRound stored in state.
  // exchangesPerRound is populated by runDebate at state construction (Fix 2 / Anti-Slop W1).
  const rosterLen = state.roster.length > 0 ? state.roster.length : 1;
  const exchanges = state.exchangesPerRound > 0 ? state.exchangesPerRound : 1;
  const turnsPerRound = rosterLen * exchanges;

  const groups = groupTurnsByRound(state.transcript, state.totalRounds, turnsPerRound);

  if (groups.length === 0) {
    return header + `(no turns yet)` + footer;
  }

  // Build rendered strings for each round
  const renderedGroups = groups.map((turns, idx) => {
    const roundLabel = `<b>Round ${idx + 1}</b>`;
    const turnsText = turns.map(renderTurn).join('\n\n');
    return roundLabel + '\n' + turnsText;
  });

  // If everything fits, return all
  const allText = renderedGroups.join('\n\n');
  if (allText.length <= budget) {
    return header + allText + footer;
  }

  // R6 truncation: only elide middle when there are ≥3 rounds
  if (groups.length < 3) {
    // Single or two rounds — truncate last turn in the overflow round
    return _truncateLastTurn(header, renderedGroups, budget, footer);
  }

  // Preserve round 1 and last completed round; elide middle
  const round1 = renderedGroups[0]!;
  const lastRound = renderedGroups[renderedGroups.length - 1]!;
  const middleCount = groups.length - 2;
  const marker = MIDDLE_ELIDE_MARKER.replace('N earlier rounds', `${middleCount} earlier round${middleCount === 1 ? '' : 's'}`);

  const combined = round1 + '\n\n' + marker + '\n\n' + lastRound;
  if (combined.length <= budget) {
    return header + combined + footer;
  }

  // Even round1 + lastRound exceeds budget — truncate individual turns
  // Prefer to truncate from lastRound first, then round1 if needed
  const result = _truncateToFit(round1, lastRound, marker, budget);
  return header + result + footer;
}

/**
 * Truncate the last turn in the rendered groups to fit budget.
 * Used when there are <3 rounds.
 */
function _truncateLastTurn(
  header: string,
  renderedGroups: string[],
  budget: number,
  footer: string,
): string {
  // Try dropping characters from last rendered group
  const allButLast = renderedGroups.slice(0, -1).join('\n\n');
  const lastGroup = renderedGroups[renderedGroups.length - 1]!;
  const separator = renderedGroups.length > 1 ? '\n\n' : '';
  const available = budget - allButLast.length - separator.length;

  if (available <= 3) {
    // No room for even a truncated last group — just return what fits
    const fit = (header + allButLast + footer).slice(0, DETAIL_BUDGET);
    return fit;
  }

  const truncatedLast = lastGroup.slice(0, available - 1) + '…';
  return header + (allButLast ? allButLast + separator : '') + truncatedLast + footer;
}

/**
 * Truncate individual round texts to fit budget.
 * Prefer truncating lastRound first, then round1.
 */
function _truncateToFit(
  round1: string,
  lastRound: string,
  marker: string,
  budget: number,
): string {
  const sep = '\n\n';
  const markerSection = sep + marker + sep;

  // Available for round1 + lastRound combined
  const available = budget - markerSection.length;
  if (available <= 6) {
    // Degenerate — just truncate everything
    return (round1 + markerSection + lastRound).slice(0, budget) + '…';
  }

  // Give each half of the remaining budget
  const halfBudget = Math.floor(available / 2);

  let r1 = round1;
  let rLast = lastRound;

  if (r1.length + rLast.length > available) {
    // Truncate lastRound first
    if (r1.length <= halfBudget) {
      // round1 fits; give rest to lastRound
      const lastBudget = available - r1.length;
      if (rLast.length > lastBudget) {
        rLast = rLast.slice(0, lastBudget - 1) + '…';
      }
    } else if (rLast.length <= halfBudget) {
      // lastRound fits; give rest to round1
      const r1Budget = available - rLast.length;
      if (r1.length > r1Budget) {
        r1 = r1.slice(0, r1Budget - 1) + '…';
      }
    } else {
      // Both too long — truncate both to half budget
      r1 = r1.slice(0, halfBudget - 1) + '…';
      rLast = rLast.slice(0, halfBudget - 1) + '…';
    }
  }

  return r1 + markerSection + rLast;
}

// ---------------------------------------------------------------------------
// Button rendering
// ---------------------------------------------------------------------------

/**
 * renderDebateButtons — returns the full InlineKeyboard for the panel.
 *
 * R3/R9: panelId is the FIRST param; no currying.
 * Uses standardPanelButton to emit well-formed callback_data.
 *
 * Buttons per state:
 *  - Running/judging (non-terminal), collapsed: [⌄ Expand transcript] [✕ Cancel]
 *  - Running/judging (non-terminal), expanded:  [⌃ Collapse] [✕ Cancel]
 *  - Terminal, collapsed: [⌄ Show full transcript]
 *  - Terminal, expanded:  [⌃ Collapse]
 */
export function renderDebateButtons(
  panelId: string,
  state: DebateState,
  mode: 'collapsed' | 'expanded',
  terminal: boolean,
): InlineKeyboard {
  // Suppress unused-var warning — state is kept as a parameter to allow future
  // state-dependent button logic (e.g. "retry" on error states).
  void state;

  if (terminal) {
    if (mode === 'collapsed') {
      return [[standardPanelButton(panelId, 'debate', 'expand', '⌄ Show full transcript')]];
    }
    return [[standardPanelButton(panelId, 'debate', 'collapse', '⌃ Collapse')]];
  }

  if (mode === 'collapsed') {
    return [[
      standardPanelButton(panelId, 'debate', 'expand', '⌄ Expand transcript'),
      standardPanelButton(panelId, 'debate', 'cancel', '✕ Cancel'),
    ]];
  }

  return [[
    standardPanelButton(panelId, 'debate', 'collapse', '⌃ Collapse'),
    standardPanelButton(panelId, 'debate', 'cancel', '✕ Cancel'),
  ]];
}
