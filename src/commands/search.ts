/**
 * /search <query> command handler.
 *
 * Bypasses the agent loop — directly invokes web_search and returns results
 * as HTML-formatted Telegram message. Fast path for quick web queries.
 *
 * If tavily.enabled is false, replies with an error.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SafetyApi } from '../safety/index.js';
import type pino from 'pino';
import { htmlEscape } from '../gateway/html.js';
import webSearchTool from '../tools/web_search.js';
import { child } from '../logger/index.js';

export interface SearchCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
  safety: SafetyApi;
  logger?: pino.Logger;
}

const log = child({ component: 'commands.search' });

/**
 * Handle /search <query>.
 * Parses the query from the message text, calls web_search directly, replies with HTML.
 */
export async function handleSearch(ctx: Context, deps: SearchCommandDeps): Promise<void> {
  const { config, memory, safety } = deps;

  // Check if tavily is enabled
  if (!config.tavily?.enabled) {
    await ctx.reply(
      '⚠️ Web search is disabled. Enable Tavily in config (tavily.enabled: true) and set TAVILY_API_KEY.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Extract query from message: "/search <query>"
  const fullText = ctx.message?.text ?? '';
  const query = fullText.replace(/^\/search\s*/i, '').trim();

  if (!query) {
    await ctx.reply('Usage: <code>/search your query here</code>', { parse_mode: 'HTML' });
    return;
  }

  const chatId = ctx.chat?.id ?? 0;
  const session = memory.sessions.getOrCreate(chatId);

  log.info({ query, chatId }, '/search command invoked');

  // Show typing indicator (best-effort)
  try {
    await ctx.api.sendChatAction(chatId, 'typing');
  } catch {
    // ignore
  }

  // Create a minimal ToolContext for the web_search tool
  const toolCtx = {
    sessionId: session.id,
    chatId,
    logger: log,
    config,
    memory,
    safety,
    abortSignal: new AbortController().signal,
  };

  let result;
  try {
    result = await webSearchTool.execute({ query, maxResults: 5, searchDepth: 'basic' }, toolCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, '/search tool execution failed');
    await ctx.reply(`Search failed: ${htmlEscape(message)}`, { parse_mode: 'HTML' });
    return;
  }

  // Scrub secrets from output (belt-and-braces — web_search already scrubs internally)
  const scrubbed = safety.scrub(result.output);

  if (!result.ok) {
    await ctx.reply(`❌ ${htmlEscape(scrubbed)}`, { parse_mode: 'HTML' });
    return;
  }

  // Format as HTML — convert markdown bold **text** to <b>text</b>
  const formatted = htmlEscape(scrubbed).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  await ctx.reply(formatted, { parse_mode: 'HTML' });
}
