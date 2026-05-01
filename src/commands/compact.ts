/**
 * /compact command handler (v1.4).
 *
 * Manually trigger context compaction for the current session.
 * In group mode, admin-only.
 * Replies with a compact notice showing tokens before/after.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { ModelProvider } from '../providers/types.js';
import { compactSession } from '../agent/compaction.js';
import { htmlEscape } from '../gateway/html.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.compact' });

export interface CompactCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
  claudeProvider: ModelProvider;
  getProvider(providerName: string): ModelProvider;
}

export async function handleCompact(ctx: Context, deps: CompactCommandDeps): Promise<void> {
  const { config, memory, claudeProvider, getProvider } = deps;

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const session = memory.sessions.getOrCreate(chatId);
  const sessionId = session.id;

  // Load history
  const history = memory.messages.listRecent(sessionId, config.memory.maxHistoryMessages);

  if (history.length === 0) {
    await ctx.reply('Nothing to compact yet.').catch(() => {});
    return;
  }

  // Guard: trivially short history with recent archive → refuse
  if (history.length < 5) {
    const latest = memory.conversationArchive.latestForSession(sessionId);
    if (latest) {
      const compactedAt = new Date(latest.compacted_at + 'Z').getTime();
      const ageMs = Date.now() - compactedAt;
      if (ageMs < 60_000) {
        await ctx
          .reply('Just compacted. Wait a bit before compacting again.')
          .catch(() => {});
        return;
      }
    }
    if (history.length < 5 && !latest) {
      await ctx.reply('Nothing to compact yet.').catch(() => {});
      return;
    }
  }

  // Determine routing for the session
  const sessionState = memory.sessionModelState.get(sessionId);
  const provider = sessionState?.override_until_clear
    ? sessionState.provider
    : config.ai.defaultProvider;
  const model = sessionState?.override_until_clear
    ? sessionState.model
    : config.ai.defaultModel;

  const abortController = new AbortController();

  try {
    const result = await compactSession({
      sessionId,
      trigger: 'manual',
      provider,
      model,
      history,
      cfg: config,
      claudeProvider,
      primaryProvider: getProvider(provider),
      memory,
      abortSignal: abortController.signal,
    });

    const origK = Math.round(result.originalTokens / 1000);
    const newK = Math.round(result.compressedTokens / 1000);
    const notice =
      `ℹ️ Context compacted — ${origK}K → ${newK}K tokens (${htmlEscape(model)})`;

    log.info({ sessionId, chatId, origK, newK }, '/compact complete');
    await ctx.reply(notice, { parse_mode: 'HTML' }).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ sessionId, chatId, err: msg }, '/compact failed');
    await ctx
      .reply('Compaction failed. Please try again or use /clear to reset.')
      .catch(() => {});
  }
}
