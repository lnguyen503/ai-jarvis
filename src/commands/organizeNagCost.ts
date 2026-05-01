/**
 * /organize nag cost [days] subcommand (v1.11.0).
 *
 * Aggregates organize.nudge audit rows for the given window (default 7 days, max 90)
 * and renders a per-model cost table. For windows <= 14 days, shows per-day breakdown
 * with ASCII bars. For > 14 days, shows summary-only.
 *
 * ADR 006 decisions 7, 8 + R4, R5.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.organize.nagCost' });

// ---------------------------------------------------------------------------
// Pricing constants
// ---------------------------------------------------------------------------

/**
 * Token cost table for the nag triage models. In USD per million tokens,
 * input/output separately. Source of truth for /organize nag cost aggregation.
 *
 * - deepseek-v4-flash — free (bundled in Ollama Cloud subscription,
 *   no per-call token cost). Represented as 0/0 so the math works without
 *   a null-check branch.
 * - claude-haiku-4-5 — Anthropic's published price card as of the ship date
 *   of v1.11.0. Update IN THIS FILE when the card moves. Do not move these
 *   to config.json — pricing is a vendor fact, not a deployment preference.
 *   Grep for the constant name if a second surface needs these; a shared
 *   src/costs.ts is warranted only when a second caller exists.
 *
 * Inputs matter more than outputs for triage (triage is short-reply-dominant);
 * we still show both so the aggregate is faithful.
 *
 * TOKEN_COSTS_USD_PER_MTOK values are `number` type (float); 4-decimal pricing
 * (e.g. $1.1500) is supported without type change (R5 W5).
 */
export const TOKEN_COSTS_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0, output: 0 },
  'claude-haiku-4-5':        { input: 1.00, output: 5.00 },
} as const;

/** ISO date (YYYY-MM-DD) at which the pricing numbers above were last verified against Anthropic's card. */
export const TOKEN_COSTS_USD_PER_MTOK_AS_OF = '2026-04-24';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrganizeCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
}

// Shape of organize.nudge detail row.
interface NudgeDetail {
  result?: string;
  model?: string | null;
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  fallbackUsed?: boolean;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parse the `days` argument. Returns the validated integer or null on error. */
function parseDaysArg(arg: string): { ok: true; days: number } | { ok: false } {
  if (arg === '') return { ok: true, days: 7 };
  const parsed = Number(arg);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) return { ok: false };
  return { ok: true, days: parsed };
}

// ---------------------------------------------------------------------------
// Date helper — local YYYY-MM-DD from ISO string
// ---------------------------------------------------------------------------

function isoToLocalYmd(isoTs: string): string {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

interface DayModelTally {
  nudgeCount: number;
  inputTokens: number;
  outputTokens: number;
  fallbackCount: number;
}

interface AggregateResult {
  /** (date, model) → tally */
  byDayModel: Map<string, DayModelTally>;
  /** model → tally (for summary-only view > 14 days) */
  byModel: Map<string, { nudgeCount: number; inputTokens: number; outputTokens: number; fallbackCount: number }>;
  totalNudges: number;
  totalCostUsd: number;
  skippedCount: number;
  tokensUnknownCount: number;
  unknownModels: Set<string>;
  modelsSeen: string[];
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = TOKEN_COSTS_USD_PER_MTOK[model];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function aggregateRows(rows: Array<{ ts: string; detail_json: string }>): AggregateResult {
  const byDayModel = new Map<string, DayModelTally>();
  const byModel = new Map<string, { nudgeCount: number; inputTokens: number; outputTokens: number; fallbackCount: number }>();
  let totalNudges = 0;
  let totalCostUsd = 0;
  let skippedCount = 0;
  let tokensUnknownCount = 0;
  const unknownModels = new Set<string>();
  const modelsSeen = new Set<string>();
  const warnedModels = new Set<string>();

  for (const row of rows) {
    let detail: NudgeDetail;
    try {
      detail = JSON.parse(row.detail_json) as NudgeDetail;
    } catch {
      skippedCount++;
      continue;
    }

    if (detail.result !== 'ok') {
      skippedCount++;
      continue;
    }

    const model = detail.model ?? 'unknown';
    modelsSeen.add(model);
    const localYmd = isoToLocalYmd(row.ts);
    const dayModelKey = `${localYmd}::${model}`;

    const inputTokens = detail.inputTokens ?? null;
    const outputTokens = detail.outputTokens ?? null;

    if (inputTokens === null || outputTokens === null) {
      tokensUnknownCount++;
      // Still count the nudge but don't tally cost.
      totalNudges++;

      // Update byDayModel and byModel without cost.
      const existing = byDayModel.get(dayModelKey) ?? { nudgeCount: 0, inputTokens: 0, outputTokens: 0, fallbackCount: 0 };
      existing.nudgeCount++;
      if (detail.fallbackUsed) existing.fallbackCount++;
      byDayModel.set(dayModelKey, existing);

      const modelEntry = byModel.get(model) ?? { nudgeCount: 0, inputTokens: 0, outputTokens: 0, fallbackCount: 0 };
      modelEntry.nudgeCount++;
      if (detail.fallbackUsed) modelEntry.fallbackCount++;
      byModel.set(model, modelEntry);
      continue;
    }

    // Check for unknown model (not in pricing table).
    if (!(model in TOKEN_COSTS_USD_PER_MTOK)) {
      unknownModels.add(model);
      if (!warnedModels.has(model)) {
        log.warn({ model }, 'unknown model in organize.nudge audit row; charging zero');
        warnedModels.add(model);
      }
    }

    const cost = computeCost(model, inputTokens, outputTokens);
    totalNudges++;
    totalCostUsd += cost;

    // byDayModel
    const existing = byDayModel.get(dayModelKey) ?? { nudgeCount: 0, inputTokens: 0, outputTokens: 0, fallbackCount: 0 };
    existing.nudgeCount++;
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    if (detail.fallbackUsed) existing.fallbackCount++;
    byDayModel.set(dayModelKey, existing);

    // byModel
    const modelEntry = byModel.get(model) ?? { nudgeCount: 0, inputTokens: 0, outputTokens: 0, fallbackCount: 0 };
    modelEntry.nudgeCount++;
    modelEntry.inputTokens += inputTokens;
    modelEntry.outputTokens += outputTokens;
    if (detail.fallbackUsed) modelEntry.fallbackCount++;
    byModel.set(model, modelEntry);
  }

  return {
    byDayModel,
    byModel,
    totalNudges,
    totalCostUsd,
    skippedCount,
    tokensUnknownCount,
    unknownModels,
    modelsSeen: [...modelsSeen],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function nudgeLabel(count: number): string {
  return count === 1 ? '1 nudge' : `${count} nudges`;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function renderBar(cost: number, maxCost: number): string {
  if (maxCost === 0 || cost === 0) return '';
  const width = Math.max(1, Math.round((cost / maxCost) * 20));
  return ' ' + '#'.repeat(width);
}

function renderPerDayTable(agg: AggregateResult, days: number): string {
  const lines: string[] = [];
  lines.push(`Cost of /organize nag over the last ${days} days (USD):`);

  // Compute max cost per (day,model) entry for bar scaling.
  let maxCostInWindow = 0;
  const costByKey = new Map<string, number>();
  for (const [key, tally] of agg.byDayModel) {
    const modelName = key.split('::')[1] ?? 'unknown';
    const cost = computeCost(modelName, tally.inputTokens, tally.outputTokens);
    costByKey.set(key, cost);
    if (cost > maxCostInWindow) maxCostInWindow = cost;
  }

  // Sort keys by date then model.
  const sortedKeys = [...agg.byDayModel.keys()].sort();
  for (const key of sortedKeys) {
    const tally = agg.byDayModel.get(key)!;
    const [dayPart, modelPart] = key.split('::');
    const modelName = modelPart ?? 'unknown';
    const cost = costByKey.get(key) ?? 0;
    const bar = renderBar(cost, maxCostInWindow);

    const isUnknown = agg.unknownModels.has(modelName);
    const costStr = isUnknown ? 'price unknown' : formatUsd(cost);
    const fallbackNote = tally.fallbackCount > 0 ? ` (${tally.fallbackCount} fallback${tally.fallbackCount !== 1 ? 's' : ''})` : '';

    // Pad columns for alignment.
    const datePad = (dayPart ?? 'unknown').padEnd(12);
    const modelPad = modelName.padEnd(28);
    const nudgesPad = nudgeLabel(tally.nudgeCount).padEnd(10);
    lines.push(`${datePad}${modelPad}${nudgesPad}${costStr}${fallbackNote}${bar}`);
  }

  lines.push(`${'Total:'.padEnd(42)}${nudgeLabel(agg.totalNudges).padEnd(10)}${formatUsd(agg.totalCostUsd)}`);

  if (agg.skippedCount > 0) {
    lines.push(`${agg.skippedCount} skipped (not ok — failures or suppressed).`);
  }
  if (agg.tokensUnknownCount > 0) {
    lines.push(`${agg.tokensUnknownCount} nudge${agg.tokensUnknownCount !== 1 ? 's' : ''} with unknown token counts (cost unknown for those).`);
  }
  for (const model of agg.unknownModels) {
    lines.push(`${model}: usage unknown — price table missing`);
  }
  lines.push(`Prices as of ${TOKEN_COSTS_USD_PER_MTOK_AS_OF}. Check anthropic.com/pricing for current rates; update`);
  lines.push(`TOKEN_COSTS_USD_PER_MTOK in src/commands/organizeNagCost.ts when the card moves.`);

  return '```\n' + lines.join('\n') + '\n```';
}

function renderSummary(agg: AggregateResult, days: number): string {
  const lines: string[] = [];
  lines.push(`Cost of /organize nag over the last ${days} days (USD) — summary:`);

  for (const [model, tally] of agg.byModel) {
    const cost = computeCost(model, tally.inputTokens, tally.outputTokens);
    const isUnknown = agg.unknownModels.has(model);
    const costStr = isUnknown ? 'price unknown' : formatUsd(cost);
    const fallbackNote = tally.fallbackCount > 0 ? ` (${tally.fallbackCount} fallback${tally.fallbackCount !== 1 ? 's' : ''})` : '';
    const modelPad = model.padEnd(30);
    const nudgesPad = nudgeLabel(tally.nudgeCount).padEnd(10);
    lines.push(`${modelPad}${nudgesPad}${costStr}${fallbackNote}`);

    if (isUnknown) {
      lines.push(`  (${model}: usage unknown — price table missing)`);
    }
  }

  lines.push(`${'Total:'.padEnd(40)}${nudgeLabel(agg.totalNudges).padEnd(10)}${formatUsd(agg.totalCostUsd)}`);

  if (agg.skippedCount > 0) {
    lines.push(`${agg.skippedCount} skipped (not ok — failures or suppressed).`);
  }
  if (agg.tokensUnknownCount > 0) {
    lines.push(`${agg.tokensUnknownCount} nudge${agg.tokensUnknownCount !== 1 ? 's' : ''} with unknown token counts (cost unknown for those).`);
  }
  lines.push(`Prices as of ${TOKEN_COSTS_USD_PER_MTOK_AS_OF}. Check anthropic.com/pricing for current rates; update`);
  lines.push(`TOKEN_COSTS_USD_PER_MTOK in src/commands/organizeNagCost.ts when the card moves.`);

  return '```\n' + lines.join('\n') + '\n```';
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handle /organize nag cost [days].
 *
 * @param ctx - grammY context
 * @param userId - authenticated user id
 * @param arg - the argument string after "cost" (may be empty string)
 * @param deps - config + memory
 */
export async function handleNagCost(
  ctx: Context,
  userId: number,
  arg: string,
  deps: OrganizeCommandDeps,
): Promise<void> {
  const { memory } = deps;

  const parsed = parseDaysArg(arg.trim());
  if (!parsed.ok) {
    await ctx.reply(
      'Usage: /organize nag cost [days]  (days: 1-90, default 7)',
    ).catch(() => {});
    return;
  }
  const days = parsed.days;

  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = memory.auditLog.listByCategoryAndActorSince('organize.nudge', userId, sinceIso);

  if (rows.length === 0) {
    await ctx.reply(
      `No nudges in the last ${days} days. Either nag is off for you (run /organize nag status) or the triage loop hasn't fired yet.`,
    ).catch(() => {});
    return;
  }

  const agg = aggregateRows(rows);

  const output = days <= 14
    ? renderPerDayTable(agg, days)
    : renderSummary(agg, days);

  // Optional audit emission (W13 — low stakes, read-only command).
  try {
    memory.auditLog.insert({
      category: 'admin_command',
      actor_user_id: userId,
      actor_chat_id: userId,
      session_id: null,
      detail: {
        tool: 'organize.nag.cost',
        days,
        totalCostUsd: agg.totalCostUsd,
        modelsSeen: agg.modelsSeen,
      },
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'nagCost: audit insert failed');
  }

  await ctx.reply(output, { parse_mode: undefined }).catch(() => {});
}

/**
 * Exported for testing — compute cost from raw token counts + model name.
 * Mirrors the internal computeCost function signature.
 */
export function computeModelCost(model: string, inputTokens: number, outputTokens: number): number {
  return computeCost(model, inputTokens, outputTokens);
}
