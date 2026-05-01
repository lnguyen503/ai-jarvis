/**
 * /cost command handler.
 *
 * Shows cumulative token usage and estimated cost for the current session.
 * Cost estimates:
 *   - Ollama Cloud: flat $20/month plan — no per-token billing, show "flat rate"
 *   - Claude Sonnet 4.6: $3/MTok input, $15/MTok output (approximate, check Anthropic pricing)
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';

// Approximate Claude Sonnet pricing (USD per million tokens)
const CLAUDE_INPUT_PER_MTOK = 3.0;
const CLAUDE_OUTPUT_PER_MTOK = 15.0;

export interface CostCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function estimateCost(
  provider: string,
  inputTokens: number,
  outputTokens: number,
): string {
  if (provider === 'claude') {
    const cost =
      (inputTokens / 1_000_000) * CLAUDE_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * CLAUDE_OUTPUT_PER_MTOK;
    return `~$${cost.toFixed(4)} (est.)`;
  }
  // Ollama Cloud: flat plan — no per-token charge
  return 'flat-rate (Ollama Cloud plan)';
}

export async function handleCost(ctx: Context, deps: CostCommandDeps): Promise<void> {
  const { memory } = deps;

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const session = memory.sessions.getOrCreate(chatId);
  const state = memory.sessionModelState.get(session.id);

  if (!state || (state.input_tokens === 0 && state.output_tokens === 0)) {
    await ctx.reply('No token usage recorded yet for this session.');
    return;
  }

  const provider = state.provider;
  const costStr = estimateCost(provider, state.input_tokens, state.output_tokens);

  const msg =
    `<b>Session Token Usage</b>\n` +
    `Provider: <code>${provider}</code>\n` +
    `Model: <code>${state.model}</code>\n\n` +
    `Input tokens:  <code>${formatTokens(state.input_tokens)}</code>\n` +
    `Output tokens: <code>${formatTokens(state.output_tokens)}</code>\n` +
    `Total:         <code>${formatTokens(state.input_tokens + state.output_tokens)}</code>\n\n` +
    `Estimated cost: ${costStr}`;

  await ctx.reply(msg, { parse_mode: 'HTML' });
}
