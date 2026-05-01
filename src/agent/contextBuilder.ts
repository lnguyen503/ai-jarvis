import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config/index.js';
import type { Message } from '../memory/index.js';

/**
 * Build the Claude messages[] from session history + new user turn.
 * Converts our internal Message format to Anthropic's MessageParam format.
 */
export function buildMessages(
  history: Message[],
  newUserText: string,
  cfg: AppConfig,
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  // Convert history rows to Claude message format
  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      if (msg.tool_name && msg.tool_input && msg.tool_use_id) {
        // Assistant turn with tool_use block
        messages.push({
          role: 'assistant',
          content: [
            ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
            {
              type: 'tool_use' as const,
              id: msg.tool_use_id,
              name: msg.tool_name,
              input: JSON.parse(msg.tool_input) as Record<string, unknown>,
            },
          ],
        });
      } else {
        // Regular assistant text
        messages.push({ role: 'assistant', content: msg.content ?? '' });
      }
    } else if (msg.role === 'tool') {
      // Tool result — must follow an assistant tool_use block
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: msg.tool_use_id ?? '',
            content: msg.tool_output ?? '',
          },
        ],
      });
    }
    // 'system' role messages are not included in the messages array — they go in system param
  }

  // Trim history to maxHistoryMessages (take the tail)
  const maxHistory = cfg.memory.maxHistoryMessages;
  const trimmedMessages =
    messages.length > maxHistory ? messages.slice(messages.length - maxHistory) : messages;

  // Heal tool_use / tool_result pairing. Two failure modes:
  //   1. Orphaned tool_result — the previous assistant's tool_use got dropped by
  //      the tail-trim (or was never persisted). Claude rejects with
  //      "unexpected tool_use_id found in tool_result blocks".
  //   2. Dangling tool_use — assistant emitted a tool_use but no matching
  //      tool_result was persisted. Claude rejects because the next user turn
  //      owes a tool_result for that id.
  const healed = healToolPairs(trimmedMessages);

  // Append the new user turn
  healed.push({ role: 'user', content: newUserText });

  return healed;
}

function healToolPairs(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Collect valid tool_use ids from the immediately-preceding assistant message (in `out`).
      const prev = out[out.length - 1];
      const prevIds = new Set<string>();
      if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
        for (const block of prev.content) {
          if (block.type === 'tool_use') prevIds.add(block.id);
        }
      }

      const keptBlocks = msg.content.filter((block) => {
        if (block.type !== 'tool_result') return true;
        return prevIds.has(block.tool_use_id);
      });

      if (keptBlocks.length === 0) continue; // drop the whole message if empty after pruning
      out.push({ role: 'user', content: keptBlocks });
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // If this is the LAST message and contains tool_use blocks, Claude will
      // expect the next user turn to carry matching tool_results. Since we
      // append a fresh user-text turn next (not tool_results), strip the
      // tool_use blocks to keep the conversation valid.
      const isLast = i === messages.length - 1;
      if (isLast) {
        const textOnly = msg.content.filter((b) => b.type !== 'tool_use');
        if (textOnly.length === 0) continue; // nothing left, drop the message
        out.push({ role: 'assistant', content: textOnly });
        continue;
      }

      // For non-last assistant messages, keep tool_use blocks only if the very
      // next message is a user turn containing a matching tool_result.
      const toolUseIds = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => b.id);
      if (toolUseIds.length === 0) {
        out.push(msg);
        continue;
      }
      const next = messages[i + 1];
      const nextResultIds = new Set<string>();
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        for (const b of next.content) {
          if (b.type === 'tool_result') nextResultIds.add(b.tool_use_id);
        }
      }
      const unmatched = toolUseIds.some((id) => !nextResultIds.has(id));
      if (!unmatched) {
        out.push(msg);
      } else {
        // Drop the tool_use blocks that won't be answered; keep text only.
        const textOnly = msg.content.filter((b) => b.type !== 'tool_use');
        if (textOnly.length === 0) continue;
        out.push({ role: 'assistant', content: textOnly });
      }
      continue;
    }

    out.push(msg);
  }

  return out;
}
