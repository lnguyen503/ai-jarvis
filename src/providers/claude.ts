/**
 * Claude provider — wraps the existing callClaude / createClaudeClient behind ModelProvider.
 * The original src/agent/claude.ts re-exports from here for backward compatibility.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config/index.js';
import type {
  ModelProvider,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
} from './types.js';
import {
  toAnthropicMessages,
  extractAnthropicText,
  extractAnthropicToolCalls,
} from './adapters.js';
import { child } from '../logger/index.js';

const log = child({ component: 'agent.claude' });

// ---------------------------------------------------------------------------
// Raw Claude API wrappers (re-exported for backward compat in src/agent/claude.ts)
// ---------------------------------------------------------------------------

/**
 * Anthropic Claude API wrapper with retry logic.
 * Handles 429, 529, and 5xx errors with exponential backoff.
 */
export async function callClaude(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  cfg: AppConfig,
  abortSignal: AbortSignal,
): Promise<Anthropic.Message> {
  const maxRetries = 3;
  const baseDelayMs = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (abortSignal.aborted) {
      // Caller knows why (could be /stop, plan wall-time, per-task timeout,
      // /cancel, etc.) — we just report the fact of the abort.
      throw new Error('Claude API call aborted');
    }

    try {
      const response = await client.messages.create(params);
      return response;
    } catch (err: unknown) {
      const isLast = attempt === maxRetries;

      if (err instanceof Anthropic.APIError) {
        const status = err.status;

        if (status === 429) {
          const retryAfter = 'retry_after' in err
            ? (err as { retry_after?: number }).retry_after
            : undefined;
          const delay =
            retryAfter !== undefined
              ? retryAfter * 1000
              : baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;

          if (!isLast) {
            log.warn({ attempt, status, delay }, 'Claude API rate limited, retrying');
            await sleep(delay);
            continue;
          }
        }

        if (status === 529 || (err.message && err.message.includes('overloaded'))) {
          if (!isLast) {
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
            log.warn({ attempt, delay }, 'Claude API overloaded, retrying');
            await sleep(delay);
            continue;
          }
        }

        if (status !== undefined && status >= 500 && !isLast) {
          const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
          log.warn({ attempt, status, delay }, 'Claude API 5xx error, retrying');
          await sleep(delay);
          continue;
        }

        log.error({ status, message: err.message, attempt }, 'Claude API error (final)');
        throw Object.assign(new Error(`Claude API error (${status}): ${err.message}`), {
          code: 'CLAUDE_UNREACHABLE',
        });
      }

      if (!isLast) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        log.warn(
          { attempt, delay, err: err instanceof Error ? err.message : String(err) },
          'Claude API network error, retrying',
        );
        await sleep(delay);
        continue;
      }

      log.error(
        { attempt, err: err instanceof Error ? err.message : String(err) },
        'Claude API network error (final)',
      );
      throw Object.assign(
        new Error(`Claude API unreachable: ${err instanceof Error ? err.message : String(err)}`),
        { code: 'CLAUDE_UNREACHABLE' },
      );
    }
  }

  throw new Error('Claude API retry exhausted');
}

export function createClaudeClient(_cfg: AppConfig): Anthropic {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set');
  }
  return new Anthropic({ apiKey });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ClaudeProvider — ModelProvider implementation
// ---------------------------------------------------------------------------

export class ClaudeProvider implements ModelProvider {
  readonly name = 'claude';
  private _client: Anthropic | null = null;

  constructor(private readonly cfg: AppConfig) {}

  private get client(): Anthropic {
    if (!this._client) {
      this._client = createClaudeClient(this.cfg);
    }
    return this._client;
  }

  async call(params: {
    model: string;
    system: string;
    messages: UnifiedMessage[];
    tools: UnifiedToolDef[];
    maxTokens: number;
    abortSignal: AbortSignal;
  }): Promise<UnifiedResponse> {
    const anthropicMessages = toAnthropicMessages(params.messages);

    // Prompt caching (v1.8.3): mark the system prompt + tool defs as
    // cacheable. Anthropic caches everything up to and including the
    // last block annotated with cache_control. With one cache_control
    // on the LAST tool, the system prompt + ALL tools share one cache
    // breakpoint. Cached input tokens cost 10% of normal — agent loops
    // with many iterations of the same context (e.g. /research) see
    // input cost drop ~80-90%. 5-min TTL on the ephemeral cache is
    // plenty for a single agent.turn() and usually for whole plans.
    //
    // Skip caching when system + tools are too small to be worth the
    // bookkeeping (Anthropic's minimum cacheable size is 1024 tokens
    // for Sonnet, 2048 for Opus, and Haiku doesn't enforce a min).
    const claudeTools: Anthropic.Tool[] = params.tools.map((t, i) => {
      const tool: Anthropic.Tool = {
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      };
      // Mark the LAST tool as the cache breakpoint — this caches the
      // system prompt + every tool definition above it.
      if (i === params.tools.length - 1) {
        (tool as Anthropic.Tool & { cache_control?: { type: 'ephemeral' } }).cache_control = {
          type: 'ephemeral',
        };
      }
      return tool;
    });

    // System prompt as a cacheable text block. Anthropic accepts either a
    // plain string or an array of TextBlocks; the array form is required
    // for cache_control.
    //
    // When there are tools, the tool-level breakpoint already covers the
    // system prompt (Anthropic caches everything up to and including the
    // last cache_control marker). When there are NO tools (e.g. the /plan
    // planner call), no tool carries the marker, so the system wouldn't
    // cache at all. Mark the system block in that case so one-shot
    // planner calls still get the 10× price break on repeat.
    //
    // Fix for MEDIUM (Anti-Slop, 2026-04-23 review): planner call was
    // missing caching entirely because its tools array is empty.
    const systemBlock: Anthropic.TextBlockParam = { type: 'text', text: params.system };
    if (params.tools.length === 0) {
      (systemBlock as Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } }).cache_control = {
        type: 'ephemeral',
      };
    }
    const systemBlocks: Array<Anthropic.TextBlockParam> = [systemBlock];

    const response = await callClaude(
      this.client,
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: systemBlocks,
        messages: anthropicMessages,
        tools: claudeTools.length > 0 ? claudeTools : undefined,
      },
      this.cfg,
      params.abortSignal,
    );

    const textContent = extractAnthropicText(response.content);
    const toolCalls = extractAnthropicToolCalls(response.content);
    const stopReason: 'end_turn' | 'tool_use' =
      response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn';

    return {
      stop_reason: stopReason,
      content: textContent,
      tool_calls: toolCalls,
      usage: response.usage
        ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_creation_input_tokens:
              (response.usage as { cache_creation_input_tokens?: number })
                .cache_creation_input_tokens,
            cache_read_input_tokens:
              (response.usage as { cache_read_input_tokens?: number })
                .cache_read_input_tokens,
          }
        : undefined,
      provider: 'claude',
      model: params.model,
    };
  }

  async streamText(params: {
    model: string;
    system: string;
    messages: UnifiedMessage[];
    tools: UnifiedToolDef[];
    maxTokens: number;
    abortSignal: AbortSignal;
    onTextDelta: (chunk: string) => void;
  }): Promise<UnifiedResponse> {
    const anthropicMessages = toAnthropicMessages(params.messages);

    // Mirror call()'s cache_control posture exactly — the streaming API
    // supports prompt caching the same way.
    const claudeTools: Anthropic.Tool[] = params.tools.map((t, i) => {
      const tool: Anthropic.Tool = {
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      };
      if (i === params.tools.length - 1) {
        (tool as Anthropic.Tool & { cache_control?: { type: 'ephemeral' } }).cache_control = {
          type: 'ephemeral',
        };
      }
      return tool;
    });

    const systemBlock: Anthropic.TextBlockParam = { type: 'text', text: params.system };
    if (params.tools.length === 0) {
      (systemBlock as Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } }).cache_control = {
        type: 'ephemeral',
      };
    }
    const systemBlocks: Array<Anthropic.TextBlockParam> = [systemBlock];

    if (params.abortSignal.aborted) {
      throw new Error('Claude API call aborted');
    }

    // Anthropic SDK's .stream() returns a MessageStream that's both an
    // async iterator of events AND provides a .finalMessage() helper to
    // collect the full result. We use the `text` event for delta emission
    // (fired per content-block-delta of type text_delta) and the final
    // message for tool_calls + usage + stop_reason.
    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens,
      system: systemBlocks,
      messages: anthropicMessages,
      tools: claudeTools.length > 0 ? claudeTools : undefined,
    });

    // Hook the text event. The SDK emits {text: string} per delta. We
    // swallow any throws from the caller's onTextDelta so a buggy
    // gateway edit never breaks the stream.
    stream.on('text', (textDelta: string) => {
      try {
        params.onTextDelta(textDelta);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'onTextDelta callback threw; swallowing',
        );
      }
    });

    // Propagate aborts — SDK's stream accepts signal via `.on('abort')` or
    // we can just abort the stream manually when the user signal fires.
    const abortHandler = (): void => {
      stream.abort();
    };
    params.abortSignal.addEventListener('abort', abortHandler);

    let finalMessage: Anthropic.Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (err) {
      if (params.abortSignal.aborted) {
        throw new Error('Claude API call aborted');
      }
      if (err instanceof Anthropic.APIError) {
        throw Object.assign(
          new Error(`Claude API error (${err.status}): ${err.message}`),
          { code: 'CLAUDE_UNREACHABLE' },
        );
      }
      throw Object.assign(
        new Error(`Claude API unreachable: ${err instanceof Error ? err.message : String(err)}`),
        { code: 'CLAUDE_UNREACHABLE' },
      );
    } finally {
      params.abortSignal.removeEventListener('abort', abortHandler);
    }

    const textContent = extractAnthropicText(finalMessage.content);
    const toolCalls = extractAnthropicToolCalls(finalMessage.content);
    const stopReason: 'end_turn' | 'tool_use' =
      finalMessage.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn';

    return {
      stop_reason: stopReason,
      content: textContent,
      tool_calls: toolCalls,
      usage: finalMessage.usage
        ? {
            input_tokens: finalMessage.usage.input_tokens,
            output_tokens: finalMessage.usage.output_tokens,
            cache_creation_input_tokens:
              (finalMessage.usage as { cache_creation_input_tokens?: number })
                .cache_creation_input_tokens,
            cache_read_input_tokens:
              (finalMessage.usage as { cache_read_input_tokens?: number })
                .cache_read_input_tokens,
          }
        : undefined,
      provider: 'claude',
      model: params.model,
    };
  }
}
