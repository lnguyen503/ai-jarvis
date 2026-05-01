/**
 * Ollama Cloud provider — OpenAI-compatible chat completions against
 * https://ollama.com/v1/chat/completions
 *
 * Uses fetch (no extra SDK). Implements ModelProvider interface.
 * On malformed tool-call: retries once, then throws so the router can
 * fall back to Claude.
 */

import type { ModelProvider, UnifiedMessage, UnifiedToolDef, UnifiedResponse } from './types.js';
import {
  toOpenAIMessages,
  parseOpenAIToolCalls,
  stripThinkTags,
  type OpenAIFunctionDef,
  type OpenAIToolCallRaw,
} from './adapters.js';
import { child } from '../logger/index.js';

const log = child({ component: 'providers.ollama-cloud' });

const OLLAMA_BASE_URL = 'https://ollama.com/v1/chat/completions';
/**
 * Per-call timeout for Ollama Cloud. v1.22.33 — bumped 120s → 180s. Heavy
 * specialist turns (Bruce producing multi-table cost analyses, Tony tool-
 * looping over big files) on large models like minimax-m2.7 (480B) routinely
 * exceed 120s on cold-start + completion. Falling back to Claude cost
 * premium tokens unnecessarily. 180s catches most legitimate slow-but-OK
 * runs without giving up; if the model is truly stuck, the agent loop's
 * iteration cap will still bail.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

interface OllamaChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallRaw[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OllamaCloudProvider implements ModelProvider {
  readonly name = 'ollama-cloud';

  private get apiKey(): string {
    const key = process.env['OLLAMA_API_KEY'];
    if (!key) throw new Error('OLLAMA_API_KEY environment variable not set');
    return key;
  }

  async call(params: {
    model: string;
    system: string;
    messages: UnifiedMessage[];
    tools: UnifiedToolDef[];
    maxTokens: number;
    abortSignal: AbortSignal;
  }): Promise<UnifiedResponse> {
    // Build OpenAI messages — prepend system message
    const systemMsg: UnifiedMessage = { role: 'system', content: params.system };
    const allMessages = [systemMsg, ...params.messages];
    const openAIMessages = toOpenAIMessages(allMessages);

    const toolDefs: OpenAIFunctionDef[] = params.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model: params.model,
      messages: openAIMessages,
      max_tokens: params.maxTokens,
      stream: false,
    };
    if (toolDefs.length > 0) {
      body['tools'] = toolDefs;
      body['tool_choice'] = 'auto';
    }

    // Attempt 1, then retry once on malformed tool calls
    return this._callWithRetry(body, params.abortSignal, params.model);
  }

  private async _callWithRetry(
    body: Record<string, unknown>,
    abortSignal: AbortSignal,
    model: string,
    attempt = 0,
  ): Promise<UnifiedResponse> {
    // Transient-failure retry: timeout or 5xx on the first attempt → try once
    // more. Distinct from the malformed-tool-call retry below because the
    // error surface is a thrown fetch/HTTP error, not a parse error.
    let data: OllamaChatResponse;
    try {
      data = await this._fetch(body, abortSignal);
    } catch (err) {
      const isTransient =
        isTimeout(err) ||
        (isHttpError(err) &&
          typeof (err as { status?: number }).status === 'number' &&
          (err as { status: number }).status >= 500);
      if (attempt === 0 && isTransient && !abortSignal.aborted) {
        log.warn(
          { model, err: err instanceof Error ? err.message : String(err) },
          'Ollama transient failure, retrying once',
        );
        return this._callWithRetry(body, abortSignal, model, 1);
      }
      throw err;
    }
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error('Ollama Cloud returned empty choice/message');
    }

    const rawContent = choice.message.content ?? '';
    const rawToolCalls = choice.message.tool_calls ?? [];
    const finishReason = choice.finish_reason ?? 'stop';

    // Parse tool calls — may throw on malformed JSON
    let toolCalls;
    try {
      toolCalls = rawToolCalls.length > 0 ? parseOpenAIToolCalls(rawToolCalls) : [];
    } catch (err) {
      if (attempt === 0) {
        log.warn(
          { model, err: err instanceof Error ? err.message : String(err) },
          'Malformed tool_call from Ollama, retrying once',
        );
        return this._callWithRetry(body, abortSignal, model, 1);
      }
      throw err;
    }

    const stopReason: 'end_turn' | 'tool_use' =
      finishReason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    // Strip think tags from final text (not from tool arguments)
    const content = stopReason === 'end_turn' ? stripThinkTags(rawContent) : rawContent;

    return {
      stop_reason: stopReason,
      content,
      tool_calls: toolCalls,
      usage: data.usage
        ? {
            input_tokens: data.usage.prompt_tokens ?? 0,
            output_tokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
      provider: 'ollama-cloud',
      model,
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
    const systemMsg: UnifiedMessage = { role: 'system', content: params.system };
    const allMessages = [systemMsg, ...params.messages];
    const openAIMessages = toOpenAIMessages(allMessages);

    const toolDefs: OpenAIFunctionDef[] = params.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model: params.model,
      messages: openAIMessages,
      max_tokens: params.maxTokens,
      stream: true,
    };
    if (toolDefs.length > 0) {
      body['tools'] = toolDefs;
      body['tool_choice'] = 'auto';
    }

    if (params.abortSignal.aborted) {
      throw new Error('Ollama API call aborted');
    }

    // Timeout + user abort combined, same as _fetch
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort('timeout'), DEFAULT_TIMEOUT_MS);
    const combined = AbortSignal.any
      ? AbortSignal.any([params.abortSignal, timeoutController.signal])
      : params.abortSignal;

    let response: Response;
    try {
      response = await fetch(OLLAMA_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      const text = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`Ollama Cloud HTTP ${response.status}: ${text.slice(0, 200)}`),
        { code: 'OLLAMA_HTTP_ERROR', status: response.status },
      );
    }
    if (!response.body) {
      clearTimeout(timeoutId);
      throw new Error('Ollama Cloud streaming response had no body');
    }

    // Parse SSE: `data: {json}\n\n` lines, terminated by `data: [DONE]`.
    // Accumulate content deltas; collect tool_calls (they arrive whole in
    // the last event — OpenAI-style streams don't partial-stream tool args
    // in practice when `stream:true` is requested against Ollama Cloud).
    let accumulatedContent = '';
    const rawToolCalls: OpenAIToolCallRaw[] = [];
    let finishReason = 'stop';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process whole events separated by double-newlines.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';  // keep incomplete tail

        for (const event of events) {
          const line = event.trim();
          if (line.length === 0) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let chunk: {
            choices?: Array<{
              delta?: { content?: string | null; tool_calls?: OpenAIToolCallRaw[] };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            // Tolerate the occasional malformed frame; log at debug and continue.
            log.debug({ payloadPreview: payload.slice(0, 100) }, 'Malformed SSE frame, skipping');
            continue;
          }

          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            accumulatedContent += choice.delta.content;
            try {
              params.onTextDelta(choice.delta.content);
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'onTextDelta callback threw; swallowing',
              );
            }
          }
          if (choice?.delta?.tool_calls) {
            // Tool calls may arrive as a partial list across chunks; merge
            // by index. Most Ollama Cloud streams send them whole in one
            // frame but we handle the general case.
            for (const tc of choice.delta.tool_calls) {
              const idx = (tc as { index?: number }).index ?? rawToolCalls.length;
              if (!rawToolCalls[idx]) rawToolCalls[idx] = tc;
              else {
                // Merge partial fields (function.arguments accumulates as string).
                const existing = rawToolCalls[idx];
                if (tc.function?.arguments) {
                  existing.function = existing.function ?? { name: '', arguments: '' };
                  existing.function.arguments =
                    (existing.function.arguments ?? '') + tc.function.arguments;
                }
                if (tc.function?.name) {
                  existing.function = existing.function ?? { name: '', arguments: '' };
                  existing.function.name = tc.function.name;
                }
                if (tc.id) existing.id = tc.id;
              }
            }
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    // Parse tool calls after the stream is complete
    let toolCalls;
    try {
      toolCalls = rawToolCalls.length > 0 ? parseOpenAIToolCalls(rawToolCalls) : [];
    } catch (err) {
      log.warn(
        { model: params.model, err: err instanceof Error ? err.message : String(err) },
        'Malformed tool_call from Ollama stream (no retry in stream mode)',
      );
      throw err;
    }

    const stopReason: 'end_turn' | 'tool_use' =
      finishReason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    const content = stopReason === 'end_turn'
      ? stripThinkTags(accumulatedContent)
      : accumulatedContent;

    return {
      stop_reason: stopReason,
      content,
      tool_calls: toolCalls,
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
          }
        : undefined,
      provider: 'ollama-cloud',
      model: params.model,
    };
  }

  private async _fetch(
    body: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<OllamaChatResponse> {
    // Combine user abort + timeout into one signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort('timeout'), DEFAULT_TIMEOUT_MS);

    const combined = AbortSignal.any
      ? AbortSignal.any([abortSignal, timeoutController.signal])
      : abortSignal; // fallback for older Node — timeout still fires via setTimeout

    let response: Response;
    try {
      response = await fetch(OLLAMA_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`Ollama Cloud HTTP ${response.status}: ${text.slice(0, 200)}`),
        { code: 'OLLAMA_HTTP_ERROR', status: response.status },
      );
    }

    return (await response.json()) as OllamaChatResponse;
  }
}

function isTimeout(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const message = (err as { message?: unknown }).message;
  // fetch abort surfaces as AbortError with "timeout" reason
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    (typeof message === 'string' && /timeout/i.test(message))
  );
}

function isHttpError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === 'OLLAMA_HTTP_ERROR';
}
