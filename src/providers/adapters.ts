/**
 * Adapters: convert between UnifiedMessage and Anthropic / OpenAI wire formats.
 * Also exports stripThinkTags() for stripping <think>...</think> blocks.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { UnifiedMessage, UnifiedToolCall } from './types.js';

// ---------------------------------------------------------------------------
// Think-tag stripping
// ---------------------------------------------------------------------------

/**
 * Strip <think>...</think> blocks (and Chinese reasoning fence variants) from text.
 * Applied to the FINAL assistant reply text before it leaves the gateway.
 * NOT applied mid-loop to tool_calls content.
 */
export function stripThinkTags(text: string): string {
  // Remove explicit <think>...</think> blocks (greedy=false, multiline)
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Strip Chinese-style fenced reasoning blocks: lines starting with 【思考】 or 【分析】 etc.
  // Only if wrapped in clear fence markers (e.g., ```think ... ```)
  result = result.replace(/```think[\s\S]*?```/gi, '');
  result = result.replace(/```reasoning[\s\S]*?```/gi, '');

  return result.trim();
}

// ---------------------------------------------------------------------------
// UnifiedMessage → Anthropic MessageParam
// ---------------------------------------------------------------------------

/**
 * Convert our UnifiedMessage[] to Anthropic.MessageParam[].
 * System messages are omitted (passed separately in the `system` param).
 */
export function toAnthropicMessages(messages: UnifiedMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled separately

    if (msg.role === 'user') {
      if (msg.blocks) {
        // Tool result blocks
        const content: Anthropic.ToolResultBlockParam[] = msg.blocks
          .filter((b) => b.type === 'tool_result')
          .map((b) => {
            const tr = b as { type: 'tool_result'; tool_call_id: string; content: string };
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.tool_call_id,
              content: tr.content,
            };
          });
        if (content.length > 0) {
          out.push({ role: 'user', content });
        }
      } else {
        out.push({ role: 'user', content: msg.content ?? '' });
      }
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: Anthropic.ContentBlock[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content } as Anthropic.TextBlock);
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        out.push({ role: 'assistant', content });
      } else {
        out.push({ role: 'assistant', content: msg.content ?? '' });
      }
    }
    // 'tool' role messages are represented as user messages with tool_result blocks
    // They should already be in UnifiedMessage form with role='user' + blocks
  }

  return out;
}

// ---------------------------------------------------------------------------
// Anthropic response → UnifiedResponse fields
// ---------------------------------------------------------------------------

/**
 * Extract tool_calls from an Anthropic response content array.
 */
export function extractAnthropicToolCalls(
  content: Anthropic.ContentBlock[],
): UnifiedToolCall[] {
  return content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    }));
}

/**
 * Extract text content from an Anthropic response.
 */
export function extractAnthropicText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// UnifiedMessage → OpenAI chat message format
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIFunctionDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Convert UnifiedMessage[] to OpenAI chat messages format.
 */
export function toOpenAIMessages(messages: UnifiedMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content ?? '' });
    } else if (msg.role === 'user') {
      if (msg.blocks) {
        // Each tool_result block becomes a separate tool message
        for (const block of msg.blocks) {
          if (block.type === 'tool_result') {
            out.push({
              role: 'tool',
              content: block.content,
              tool_call_id: block.tool_call_id,
            });
          }
        }
      } else {
        out.push({ role: 'user', content: msg.content ?? '' });
      }
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        out.push({
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: msg.content ?? '' });
      }
    } else if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        content: msg.content ?? '',
        tool_call_id: msg.tool_call_id ?? '',
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// OpenAI response → UnifiedToolCall[]
// ---------------------------------------------------------------------------

export interface OpenAIToolCallRaw {
  id: string;
  type: string;
  function?: {
    name: string;
    arguments: string;
  };
}

/**
 * Parse OpenAI-format tool_calls from a response.
 * Returns empty array if none or malformed.
 * Throws ParseError if any tool_call is present but malformed (for retry logic).
 */
export function parseOpenAIToolCalls(rawCalls: OpenAIToolCallRaw[]): UnifiedToolCall[] {
  const results: UnifiedToolCall[] = [];
  for (const tc of rawCalls) {
    if (!tc.function?.name || !tc.function?.arguments) {
      throw new Error(`Malformed tool_call: missing function name or arguments (id=${tc.id})`);
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Malformed tool_call: arguments not valid JSON (id=${tc.id}, name=${tc.function.name})`,
      );
    }
    results.push({ id: tc.id, name: tc.function.name, input });
  }
  return results;
}
