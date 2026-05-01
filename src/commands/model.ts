/**
 * /model command handler.
 *
 * /model          — show current routing decision + session pin (if any)
 * /model <name>   — pin session to a specific model (persists until /model auto)
 * /model auto     — clear session pin, return to keyword routing
 * /model claude   — pin to premium Claude provider
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { BotIdentity } from '../config/botIdentity.js';
import { BOT_MODEL_BY_NAME } from '../config/botIdentity.js';
import { resolveModelAlias } from '../router/model-router.js';
import { htmlEscape } from '../gateway/html.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.model' });

export interface ModelCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
  /**
   * v1.23.3 — bot identity wired in so /model can show the correct per-bot
   * model. Without this, /model on Tony would display config.ai.defaultModel
   * (minimax-m2.7) when his actual routing decision is qwen3-coder-next via
   * BOT_MODEL_BY_NAME. Optional for back-compat with legacy single-bot
   * deployments where botIdentity isn't resolved.
   */
  botIdentity?: BotIdentity;
}

export async function handleModel(ctx: Context, deps: ModelCommandDeps): Promise<void> {
  const { config, memory, botIdentity } = deps;

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const session = memory.sessions.getOrCreate(chatId);
  const text = ctx.message?.text ?? '';

  // Parse: /model [arg]
  const parts = text.trim().split(/\s+/);
  const arg = parts[1]; // undefined if no arg

  if (!arg) {
    // Show current state
    const state = memory.sessionModelState.get(session.id);
    if (state?.override_until_clear) {
      const msg =
        `<b>Model (pinned)</b>\n` +
        `Provider: <code>${htmlEscape(state.provider)}</code>\n` +
        `Model: <code>${htmlEscape(state.model)}</code>\n\n` +
        `Send <code>/model auto</code> to return to keyword routing.`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
    } else {
      // v1.23.3 — show the model that would ACTUALLY fire for this bot.
      // routeTask() (when routing.enabled=false) returns:
      //   1. Per-bot map: BOT_MODEL_BY_NAME[botIdentity.name] if set
      //   2. Otherwise config.ai.defaultModel
      // When routing.enabled=true, the keyword classifier overrides for
      // the current input — the display flags that variability.
      const perBotModel = botIdentity ? BOT_MODEL_BY_NAME[botIdentity.name] : undefined;
      const activeModel = perBotModel ?? config.ai.defaultModel;
      const activeProvider = config.ai.defaultProvider;
      const reasonLabel = perBotModel
        ? `per-bot (${botIdentity!.name})`
        : 'config default';
      const routingNote = config.ai.routing.enabled
        ? `\n<i>Note: keyword routing is enabled — this may be overridden per turn based on the message content.</i>`
        : '';
      const msg =
        `<b>Model (auto-routing)</b>\n` +
        `Active: <code>${htmlEscape(activeProvider)}/${htmlEscape(activeModel)}</code> <i>(${htmlEscape(reasonLabel)})</i>\n` +
        `Premium: <code>${htmlEscape(config.ai.premiumProvider)}/${htmlEscape(config.ai.premiumModel)}</code>` +
        `${routingNote}\n\n` +
        `Send <code>/model &lt;name&gt;</code> to pin a model.\n` +
        `Examples: <code>/model claude</code>, <code>/model qwen3-coder-next</code>, <code>/model auto</code>`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
    return;
  }

  if (arg.toLowerCase() === 'auto') {
    memory.sessionModelState.clearOverride(session.id);
    await ctx.reply('Model reset to auto-routing (keyword-based).');
    log.info({ chatId, sessionId: session.id }, '/model auto — pin cleared');
    return;
  }

  // Resolve alias
  const resolved = resolveModelAlias(arg, config);
  if (!resolved) {
    // resolveModelAlias returns null only for 'auto' — handled above
    await ctx.reply('Unknown /model argument. Use /model auto to clear the pin.');
    return;
  }

  memory.sessionModelState.setModel(session.id, resolved.provider, resolved.model, true);

  const msg =
    `<b>Model pinned</b>\n` +
    `Provider: <code>${htmlEscape(resolved.provider)}</code>\n` +
    `Model: <code>${htmlEscape(resolved.model)}</code>\n\n` +
    `Send <code>/model auto</code> to return to keyword routing.`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
  log.info(
    { chatId, sessionId: session.id, provider: resolved.provider, model: resolved.model },
    '/model pin set',
  );
}
