/**
 * Auto-compaction logic (v1.4).
 *
 * When conversation context reaches a configurable fraction of the current model's
 * context window, the full history is summarised by the same model, then replaced
 * with a single synthetic system message carrying the summary.  The original rows
 * are moved to conversation_archive — no data is ever discarded.
 */

import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { Message } from '../memory/index.js';
import type { ModelProvider, UnifiedMessage } from '../providers/types.js';
import { estimateTokens, getCurrentContextLimit } from './tokenEstimator.js';
import { stripThinkTags } from '../providers/adapters.js';
import { scrub } from '../safety/scrubber.js';
import { child } from '../logger/index.js';

const log = child({ component: 'agent.compaction' });

export const DEFAULT_SUMMARIZE_PROMPT =
  'Summarize this entire conversation into a concise context summary. ' +
  'Preserve all key decisions, code snippets, file paths, file names, tool outputs, ' +
  'action items, and unresolved tasks. Keep code blocks verbatim. ' +
  'This summary will replace the full history — do not omit anything load-bearing. ' +
  'Respond with ONLY the summary, no preamble.';

export interface CompactionDecision {
  compact: boolean;
  estimated: number;
  limit: number;
}

/** Determine whether compaction is needed for the given history. */
export function shouldCompact(
  history: Message[],
  cfg: AppConfig,
  provider: string,
  model: string,
): CompactionDecision {
  if (history.length === 0) {
    return { compact: false, estimated: 0, limit: getCurrentContextLimit(cfg, provider, model) };
  }

  // Convert history to UnifiedMessages for token estimation
  const unified = historyToUnified(history);
  const estimated = estimateTokens(unified);
  const limit = getCurrentContextLimit(cfg, provider, model);
  const threshold = cfg.context.compactThreshold;

  return {
    compact: estimated >= limit * threshold,
    estimated,
    limit,
  };
}

export interface CompactSessionParams {
  sessionId: number;
  trigger: 'auto' | 'manual';
  provider: string;
  model: string;
  history: Message[];
  cfg: AppConfig;
  claudeProvider: ModelProvider;
  primaryProvider: ModelProvider;
  memory: MemoryApi;
  abortSignal: AbortSignal;
}

export interface CompactionResult {
  summary: string;
  originalTokens: number;
  compressedTokens: number;
  archiveId: number;
  firstMessageId: number;
  lastMessageId: number;
}

/**
 * Perform compaction:
 * 1. Estimate tokens.
 * 2. Call the current model (tools disabled) with a summarise prompt.
 * 3. Archive original history.
 * 4. Delete original messages from the messages table.
 * 5. Insert a synthetic system message with the summary.
 */
export async function compactSession(params: CompactSessionParams): Promise<CompactionResult> {
  const { sessionId, trigger, provider, model, history, cfg, claudeProvider, primaryProvider, memory, abortSignal } = params;

  const unified = historyToUnified(history);
  const originalTokens = estimateTokens(unified);

  // Heal tool pairs before sending to summarise (reuse logic from contextBuilder)
  const healedUnified = healUnifiedToolPairs(unified);

  // Build the summarise prompt as a trailing user message
  const summarizePrompt = cfg.context.summarizePrompt;
  const messagesForSummarize: UnifiedMessage[] = [
    ...healedUnified,
    { role: 'user', content: summarizePrompt },
  ];

  log.info({ sessionId, provider, model, trigger, originalTokens }, 'Compacting session');

  // Call provider with empty tools (text-only output)
  let response;
  try {
    response = await primaryProvider.call({
      model,
      system: 'You are a conversation summariser. Output ONLY the summary.',
      messages: messagesForSummarize,
      tools: [],
      maxTokens: cfg.ai.maxTokens,
      abortSignal,
    });
  } catch (primaryErr) {
    // Fallback to Claude once if primary is not Claude
    if (provider !== 'claude') {
      log.warn(
        { sessionId, provider, err: primaryErr instanceof Error ? primaryErr.message : String(primaryErr) },
        'Primary provider failed during compaction — falling back to Claude',
      );
      try {
        response = await claudeProvider.call({
          model: cfg.ai.premiumModel,
          system: 'You are a conversation summariser. Output ONLY the summary.',
          messages: messagesForSummarize,
          tools: [],
          maxTokens: cfg.ai.maxTokens,
          abortSignal,
        });
      } catch (claudeErr) {
        throw new Error(
          `Compaction failed on both primary (${provider}) and Claude fallback. ` +
            `Original: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}. ` +
            `Fallback: ${claudeErr instanceof Error ? claudeErr.message : String(claudeErr)}`,
        );
      }
    } else {
      throw primaryErr;
    }
  }

  const summary = stripThinkTags(response.content);

  // Scrub and archive the full original history before modifying the DB
  const scrubbedHistoryJson = scrubHistoryJson(history);

  const compressedTokens = estimateTokens([{ role: 'user', content: summary }]);

  // Compute message-id range for archive tagging (backward compat: treat id=0/null as 0)
  const ids = history.map((m) => m.id ?? 0);
  const firstMessageId = ids.length > 0 ? Math.min(...ids) : 0;
  const lastMessageId = ids.length > 0 ? Math.max(...ids) : 0;

  // Archive — store id range for recall_archive tool
  const archiveId = memory.conversationArchive.insert({
    session_id: sessionId,
    trigger,
    provider,
    model,
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    original_message_count: history.length,
    full_history_json: scrubbedHistoryJson,
    summary_text: summary,
    first_message_id: firstMessageId,
    last_message_id: lastMessageId,
  });

  // Delete original messages for this session
  memory.messages.deleteForSession(sessionId);

  // Insert synthetic summary as a system message, tagged with range + archive id
  const summaryHeader =
    `[Prior conversation summary · messages ${firstMessageId}-${lastMessageId} · archive #${archiveId}]\n` +
    `If the user references something not in this summary, call the \`recall_archive\` tool with a search query and archive_id=${archiveId} to retrieve the full original context from SQLite.\n\n`;
  memory.messages.insert({
    session_id: sessionId,
    role: 'system',
    content: summaryHeader + summary,
  });

  log.info(
    { sessionId, trigger, originalTokens, compressedTokens, archiveId, firstMessageId, lastMessageId },
    'Compaction complete',
  );

  return { summary, originalTokens, compressedTokens, archiveId, firstMessageId, lastMessageId };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert Message[] (DB rows) to UnifiedMessage[] for token estimation. */
function historyToUnified(history: Message[]): UnifiedMessage[] {
  const out: UnifiedMessage[] = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      if (msg.tool_name && msg.tool_input && msg.tool_use_id) {
        out.push({
          role: 'assistant',
          content: msg.content ?? undefined,
          tool_calls: [
            {
              id: msg.tool_use_id,
              name: msg.tool_name,
              input: safeParseJson(msg.tool_input),
            },
          ],
        });
      } else {
        out.push({ role: 'assistant', content: msg.content ?? '' });
      }
    } else if (msg.role === 'tool') {
      out.push({
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            tool_call_id: msg.tool_use_id ?? '',
            content: msg.tool_output ?? '',
          },
        ],
      });
    } else if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content ?? '' });
    }
  }
  return out;
}

/** Heal orphaned tool_use / tool_result pairs in a UnifiedMessage array. */
function healUnifiedToolPairs(messages: UnifiedMessage[]): UnifiedMessage[] {
  const out: UnifiedMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'user' && msg.blocks) {
      // Keep only tool_result blocks that match the preceding assistant's tool_calls
      const prev = out[out.length - 1];
      const prevIds = new Set<string>();
      if (prev?.role === 'assistant' && prev.tool_calls) {
        for (const tc of prev.tool_calls) prevIds.add(tc.id);
      }
      const keptBlocks = msg.blocks.filter(
        (b) => b.type !== 'tool_result' || prevIds.has(b.tool_call_id),
      );
      if (keptBlocks.length === 0) continue;
      out.push({ ...msg, blocks: keptBlocks });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const isLast = i === messages.length - 1;
      if (isLast) {
        // Strip dangling tool_calls from the last message
        const withoutCalls = { ...msg, tool_calls: undefined };
        if (!withoutCalls.content) continue;
        out.push(withoutCalls);
        continue;
      }
      // Check next message has matching tool_results
      const next = messages[i + 1];
      const nextResultIds = new Set<string>();
      if (next?.role === 'user' && next.blocks) {
        for (const b of next.blocks) {
          if (b.type === 'tool_result') nextResultIds.add(b.tool_call_id);
        }
      }
      const unmatched = msg.tool_calls.some((tc) => !nextResultIds.has(tc.id));
      if (!unmatched) {
        out.push(msg);
      } else {
        // Keep text only
        if (!msg.content) continue;
        out.push({ role: 'assistant', content: msg.content });
      }
      continue;
    }

    out.push(msg);
  }

  return out;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Scrub each message field before archiving. */
function scrubHistoryJson(history: Message[]): string {
  const scrubbed = history.map((m) => ({
    ...m,
    content: m.content ? scrub(m.content) : m.content,
    tool_input: m.tool_input ? scrub(m.tool_input) : m.tool_input,
    tool_output: m.tool_output ? scrub(m.tool_output) : m.tool_output,
  }));
  return JSON.stringify(scrubbed);
}

