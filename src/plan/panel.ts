/**
 * Plan & Execute — progress panel renderer + edit debouncer.
 *
 * Renders the live status of a plan as message text and pushes edits via
 * MessagingAdapter.editMessageText. Telegram limits edits to ~30/min in
 * groups, so we debounce updates to ~1 per 1.5s. Slack and WhatsApp
 * implementations will need to respect their own rate limits.
 */

import type { MessagingAdapter, InlineKeyboard } from '../messaging/adapter.js';
import type { Plan, PlanTask } from './types.js';
import { child } from '../logger/index.js';

const log = child({ component: 'plan.panel' });

const MIN_EDIT_INTERVAL_MS = 1500;
const MAX_PANEL_CHARS = 3800; // Telegram cap is 4096; keep margin for safety

/** Per-million-token pricing for the Claude models /research can pick.
 *  Hardcoded — move to config if pricing churns or we add more models. */
interface ModelPricing {
  shortName: string;
  inputPerMTok: number;   // standard input AND cache_creation tokens
  outputPerMTok: number;
  cacheReadPerMTok: number; // 10% of input price by Anthropic policy
}
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': {
    shortName: 'haiku',
    inputPerMTok: 0.80,
    outputPerMTok: 4.0,
    cacheReadPerMTok: 0.08,
  },
  'claude-sonnet-4-6': {
    shortName: 'sonnet',
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.30,
  },
};
/** Pricing fallback when modelUsed is unknown. Uses Sonnet rates so we
 *  never under-quote cost. */
const PRICING_FALLBACK: ModelPricing = MODEL_PRICING['claude-sonnet-4-6']!;

/**
 * Render a plan's current state as panel text.
 * Pure function — exported for unit testing.
 */
export function renderPanel(plan: Plan): string {
  const elapsed = Math.floor((Date.now() - plan.startedAt) / 1000);
  const elapsedStr = elapsed < 60
    ? `${elapsed}s`
    : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;

  const modeTag = plan.forceProvider === 'claude' ? ' · 🧠 Claude mode' : '';
  const costLine = renderCostLine(plan);
  const header = [
    `🤖 ${plan.skill.label}: ${truncate(plan.goal, 100)}`,
    `   id: ${plan.id} · ${plan.tasks.length} tasks · ${elapsedStr} elapsed${modeTag}`,
    ...(costLine ? [`   ${costLine}`] : []),
    '',
  ].join('\n');

  const lines = plan.tasks.map(renderTaskLine);

  const footer = renderFooter(plan);

  let body = lines.join('\n');
  // If panel exceeds budget, drop task summaries and try again.
  if ((header + body + footer).length > MAX_PANEL_CHARS) {
    body = plan.tasks.map(renderTaskLineCompact).join('\n');
  }
  // Still too big? Truncate task titles aggressively.
  if ((header + body + footer).length > MAX_PANEL_CHARS) {
    body = plan.tasks
      .map((t) => `${statusIcon(t.status)} ${truncate(t.title, 60)}`)
      .join('\n');
  }

  return header + body + (footer ? '\n\n' + footer : '');
}

function renderTaskLine(task: PlanTask): string {
  const icon = statusIcon(task.status);
  const main = `${icon} ${task.index}. ${truncate(task.title, 120)}`;
  if (task.status === 'completed' && task.summary) {
    return `${main}\n   └ ${truncate(task.summary, 140)}`;
  }
  if (task.status === 'failed' && task.error) {
    return `${main}\n   └ ⚠ ${truncate(task.error, 140)}`;
  }
  return main;
}

function renderTaskLineCompact(task: PlanTask): string {
  return `${statusIcon(task.status)} ${task.index}. ${truncate(task.title, 100)}`;
}

function statusIcon(status: PlanTask['status']): string {
  switch (status) {
    case 'completed': return '✓';
    case 'running':   return '⋯';
    case 'failed':    return '✗';
    case 'pending':   return ' ';
  }
}

function renderFooter(plan: Plan): string {
  if (plan.status === 'synthesizing') return '📝 Synthesizing comprehensive report (multi-model)…';
  if (plan.status === 'completed') {
    // Don't render the literal string "REPORT.md" — Telegram's auto-link
    // treats ".md" as Moldova's ccTLD and creates a bogus link to
    // http://report.md/. The attached file is still named REPORT.md; we
    // just don't need to say so in the panel text.
    return plan.reportPath
      ? `✅ Plan complete · 📄 Report delivered (attached above)`
      : '✅ Plan complete';
  }
  if (plan.status === 'failed')    return '❌ Plan failed';
  if (plan.status === 'cancelled') return '⊘ Plan cancelled';
  return '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Estimated Claude cost line. Returns empty string when not in Claude mode
 *  or when no usage has been recorded yet. Exported for unit testing.
 *  Cost = (input + cache_creation) × full + cache_read × 10%-of-full + output. */
export function renderCostLine(plan: Plan): string {
  if (plan.forceProvider !== 'claude') return '';
  const u = plan.totalUsage;
  if (!u || (u.input_tokens === 0 && u.output_tokens === 0)) return '';
  const pricing = MODEL_PRICING[plan.modelUsed ?? ''] ?? PRICING_FALLBACK;
  const cacheCreated = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  // input_tokens already excludes cached portions per Anthropic's API.
  const fullPriceInput = u.input_tokens + cacheCreated;
  const costUsd =
    (fullPriceInput / 1_000_000) * pricing.inputPerMTok +
    (cacheRead / 1_000_000) * pricing.cacheReadPerMTok +
    (u.output_tokens / 1_000_000) * pricing.outputPerMTok;
  // Show cache hit % when caching produced reads — gives a sense of how
  // much we're saving.
  const totalInputAccounted = fullPriceInput + cacheRead;
  const hitPct = totalInputAccounted > 0
    ? Math.round((cacheRead / totalInputAccounted) * 100)
    : 0;
  const cacheTag = cacheRead > 0 ? ` · ${hitPct}% cached` : '';
  return `💸 ~$${costUsd.toFixed(2)} ${pricing.shortName} (${formatTokens(totalInputAccounted)} in / ${formatTokens(u.output_tokens)} out${cacheTag})`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * Build the inline keyboard attached to a plan panel.
 * Buttons change with state:
 *   - planning/running/synthesizing → [✕ Cancel]
 *   - completed with report → [📤 Send Again] [💎 Re-run w/ Sonnet]
 *   - completed without report → [💎 Re-run w/ Sonnet]
 *   - failed / cancelled → [💎 Re-run] (fresh attempt)
 *
 * The callback_data is "<action>:<plan_id>" — the gateway's
 * callback_query handler routes by prefix.
 */
export function panelButtons(plan: Plan): InlineKeyboard {
  const cancelable =
    plan.status === 'planning' ||
    plan.status === 'running' ||
    plan.status === 'synthesizing';
  if (cancelable) {
    return [[{ label: '✕ Cancel', data: `plan.cancel:${plan.id}` }]];
  }
  // Terminal states: cancel no longer makes sense; offer rerun/resend.
  const row: InlineKeyboard[number] = [];
  if (plan.reportPath && plan.status === 'completed') {
    row.push({ label: '📤 Send Again', data: `plan.resend:${plan.id}` });
  }
  // Re-run with Sonnet is meaningful when current run wasn't already Sonnet.
  const alreadySonnet = plan.modelUsed === 'claude-sonnet-4-6';
  if (!alreadySonnet) {
    row.push({ label: '💎 Re-run w/ Sonnet', data: `plan.rerun-sonnet:${plan.id}` });
  }
  return row.length > 0 ? [row] : [];
}

// ---------------------------------------------------------------------------
// Edit debouncer
// ---------------------------------------------------------------------------

export interface PanelUpdater {
  /** Request a panel re-render. Coalesces with pending updates. */
  update(): void;
  /** Force-flush any pending update immediately (use on terminal events). */
  flush(): Promise<void>;
}

/**
 * Build a panel updater bound to a specific plan + Telegram message.
 * The updater debounces rapid `update()` calls to one edit per ~1.5s,
 * always preserves the latest panel state, and dedupes identical text
 * so Telegram doesn't reject "message is not modified" edits.
 */
export function createPanelUpdater(
  adapter: MessagingAdapter,
  plan: Plan,
): PanelUpdater {
  let lastSentText: string | null = null;
  let lastEditAt = 0;
  let pendingTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const send = async (): Promise<void> => {
    const text = renderPanel(plan);
    const buttons = panelButtons(plan);
    // Button layout contributes to the edit hash so status transitions
    // (e.g., running → completed, which changes the buttons) force a push
    // even when the text body is unchanged.
    const edit = text + '|buttons:' + JSON.stringify(buttons);
    if (edit === lastSentText) return;
    try {
      await adapter.editMessageText(plan.chatId, plan.panelMessageId, text, { buttons });
      lastSentText = edit;
      lastEditAt = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not modified')) {
        log.warn({ err: msg, planId: plan.id }, 'Panel edit failed');
      }
    }
  };

  return {
    update(): void {
      if (pendingTimer) return; // already scheduled
      const wait = Math.max(0, MIN_EDIT_INTERVAL_MS - (Date.now() - lastEditAt));
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        inFlight = send();
      }, wait);
    },
    async flush(): Promise<void> {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (inFlight) await inFlight;
      await send();
    },
  };
}
