/**
 * Tavily web_search tool.
 *
 * POSTs to https://api.tavily.com/search with Authorization: Bearer <TAVILY_API_KEY>.
 * Returns a formatted list of results (title + url + snippet).
 * Uses AbortSignal + 15s timeout per the fetch+timeout pattern in ollama-cloud.ts.
 *
 * This tool is only registered when config.tavily.enabled === true.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './types.js';

const TIMEOUT_MS = 15_000;

/**
 * v1.22.41 — Hard cap on Tavily calls per agent turn.
 *
 * Triggered by an incident: a hard research prompt with multiple constraints
 * caused one specialist to fire 26 Tavily searches in two minutes BEFORE
 * producing a draft (it kept rephrasing the query when results were weak),
 * then more during 3 rounds of debate revisions. Cumulative cost was high
 * enough that Tavily emailed about it.
 *
 * 5 is generous for any single research subtask: the agent can take 1-2
 * exploratory searches + 2-3 targeted follow-ups. Beyond that, the agent
 * is iterating on a query that isn't going to find better results — better
 * to surface what it has and let the LLM synthesize.
 *
 * The cap is per ToolContext.turnWebSearchCounter (initialized fresh per
 * turn in the agent loop). Debate revisions run as fresh agent turns, so
 * each revision gets its own 5-call budget — by design, the critic forces
 * the specialist to find a real source, and revisions are bounded anyway
 * by the 3-round debate ceiling.
 */
export const MAX_WEB_SEARCHES_PER_TURN = 5;

const parameters = z.object({
  query: z.string().min(1).describe('The search query'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of results to return (default 5)'),
  searchDepth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Search depth: basic (faster) or advanced (more thorough)'),
});

type WebSearchInput = z.infer<typeof parameters>;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
  error?: string;
  answer?: string;
}

async function executeTavilySearch(input: WebSearchInput, ctx: ToolContext): Promise<ToolResult> {
  const log = ctx.logger.child({ component: 'tools.web_search' });

  // v1.22.41 — per-turn cap. Increment-and-check so a single tool-call
  // iteration that requests two searches in parallel still stops at the
  // cap (the second one sees count===MAX after the first increments).
  // Skipped when counter is undefined (legacy / test contexts).
  if (ctx.turnWebSearchCounter) {
    ctx.turnWebSearchCounter.count += 1;
    if (ctx.turnWebSearchCounter.count > MAX_WEB_SEARCHES_PER_TURN) {
      log.warn(
        { count: ctx.turnWebSearchCounter.count, cap: MAX_WEB_SEARCHES_PER_TURN, query: input.query },
        'web_search cap reached for this turn — refusing further calls',
      );
      return {
        ok: false,
        output:
          `Web-search budget exhausted for this turn (${MAX_WEB_SEARCHES_PER_TURN} calls). ` +
          `Synthesize with the results you already have, or note in your reply that you couldn't find a source rather than continuing to search.`,
        error: { code: 'WEB_SEARCH_TURN_CAP', message: 'per-turn cap exceeded' },
      };
    }
  }

  const apiKey = ctx.config.tavily.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      output: 'Tavily API key not configured. Set TAVILY_API_KEY in your environment.',
      error: { code: 'TAVILY_NO_KEY', message: 'TAVILY_API_KEY not set' },
    };
  }

  const baseUrl = ctx.config.tavily.baseUrl ?? 'https://api.tavily.com';
  const url = `${baseUrl}/search`;

  // Combine user AbortSignal + 15s timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort('timeout'), TIMEOUT_MS);

  const combined = AbortSignal.any
    ? AbortSignal.any([ctx.abortSignal, timeoutController.signal])
    : ctx.abortSignal;

  let response: Response;
  try {
    log.info({ query: input.query, maxResults: input.maxResults }, 'Tavily search start');
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: input.query,
        max_results: input.maxResults,
        search_depth: input.searchDepth,
      }),
      signal: combined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'Tavily fetch failed');
    return {
      ok: false,
      output: `Web search failed: ${message}`,
      error: { code: 'TAVILY_FETCH_ERROR', message },
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const message = `Tavily HTTP ${response.status}: ${text.slice(0, 200)}`;
    log.error({ status: response.status }, 'Tavily HTTP error');
    return {
      ok: false,
      output: `Web search failed: ${message}`,
      error: { code: 'TAVILY_HTTP_ERROR', message },
    };
  }

  let data: TavilyResponse;
  try {
    data = (await response.json()) as TavilyResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      output: `Web search returned invalid JSON: ${message}`,
      error: { code: 'TAVILY_PARSE_ERROR', message },
    };
  }

  if (data.error) {
    return {
      ok: false,
      output: `Tavily error: ${data.error}`,
      error: { code: 'TAVILY_API_ERROR', message: data.error },
    };
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    log.info({ query: input.query }, 'Tavily returned no results');
    return {
      ok: true,
      output: `No results found for: ${input.query}`,
    };
  }

  const formatted = results
    .map((r, i) => {
      const title = r.title ?? 'Untitled';
      const urlStr = r.url ?? '';
      const snippet = (r.content ?? r.snippet ?? '').slice(0, 300);
      return `${i + 1}. **${title}**\n   ${urlStr}\n   ${snippet}`;
    })
    .join('\n\n');

  const output = `Web search results for "${input.query}":\n\n${formatted}`;
  log.info({ query: input.query, resultCount: results.length }, 'Tavily search complete');

  return {
    ok: true,
    output,
    data: { query: input.query, resultCount: results.length },
  };
}

const webSearchTool: Tool<WebSearchInput> = {
  name: 'web_search',
  description:
    'Search the web using Tavily. Returns a list of relevant results with title, URL, and snippet. Use for current events, documentation, or any question requiring up-to-date information.',
  parameters,
  execute: executeTavilySearch,
};

export default webSearchTool;
