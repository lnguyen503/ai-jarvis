/**
 * Token estimator for auto-compaction (v1.4).
 *
 * Uses a simple char/4 heuristic — accurate enough for a threshold trigger.
 * Exact per-provider token counts are not needed here; the check fires before
 * the actual API call, so this serves as a conservative early-warning.
 */

import type { UnifiedMessage } from '../providers/types.js';
import type { AppConfig } from '../config/index.js';

/** Estimate token count for a list of UnifiedMessages. */
export function estimateTokens(messages: UnifiedMessage[]): number {
  let chars = 0;

  for (const msg of messages) {
    if (msg.content) {
      chars += msg.content.length;
    }
    if (msg.blocks) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_result') {
          chars += block.content.length;
        } else if (block.type === 'text') {
          chars += block.text.length;
        }
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += tc.name.length;
        chars += JSON.stringify(tc.input).length;
      }
    }
  }

  return Math.ceil(chars / 4);
}

/**
 * Look up the context window limit for the current provider+model.
 * Falls back to a conservative 32 000 tokens if not found in config.
 */
export function getCurrentContextLimit(
  config: AppConfig,
  provider: string,
  model: string,
): number {
  const providerCfg = config.ai.providers[provider as keyof typeof config.ai.providers];
  if (providerCfg?.models) {
    const limit = providerCfg.models[model];
    if (limit !== undefined) {
      const parsed = parseInt(limit, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  // Known common limits — helps when config doesn't specify.
  // v1.22.26 — corrected to real published context windows. Prior numbers
  // were conservative defaults from when only one Ollama model (glm-5.1) was
  // in use and it had a 32K guess. With the multi-model lineup all supporting
  // 128K-256K, aggressive compaction was destroying long-conversation quality
  // — better to compact rarely at higher thresholds than frequently.
  //
  // Quality note (lost-in-the-middle effect): is real but mostly hits
  // retrieval/needle-in-haystack tasks. For agent loops with bounded
  // conversation history, bigger windows beat aggressive compaction because
  // compaction itself drops or summarizes context, which degrades quality.
  const knownLimits: Record<string, number> = {
    // Claude — published Anthropic limits.
    'claude-sonnet-4-6': 200000,
    'claude-opus-4-6':   200000,
    'claude-haiku-4-5':  200000,
    // Ollama Cloud — published model card limits.
    'glm-5.1':            200000,
    'glm-5':              128000,
    'glm-4.7':            128000,
    'glm-4.6':            128000,
    'minimax-m2':         192000,
    'minimax-m2.1':       192000,
    'minimax-m2.5':       192000,
    'minimax-m2.7':       192000,
    'deepseek-v4-flash':  128000,
    'deepseek-v3.1:671b': 128000,
    'deepseek-v3.2':      128000,
    'gemma4:31b':         128000,
    'gemma3:27b':          96000,
    'gemma3:12b':          96000,
    'gemma3:4b':           96000,
    'qwen3-coder:480b':   256000,
    'qwen3-next:80b':     128000,
    'qwen3.5:397b':       128000,
    'kimi-k2.6':          256000,
    'kimi-k2.5':          128000,
    'kimi-k2:1t':         128000,
    'kimi-k2-thinking':   256000,
    'nemotron-3-super':   128000,
    'nemotron-3-nano:30b': 128000,
    'gpt-oss:120b':       128000,
    'gpt-oss:20b':        128000,
    'cogito-2.1:671b':    128000,
    'mistral-large-3:675b': 128000,
    'devstral-2:123b':    256000,
    'devstral-small-2:24b': 256000,
  };
  if (knownLimits[model] !== undefined) return knownLimits[model]!;
  return 128000; // v1.22.26 — fallback bumped from 32000 to match modern model norms
}
