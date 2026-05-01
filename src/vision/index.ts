/**
 * Vision — single-shot Claude call for image understanding.
 *
 * Used when the user sends a photo to Telegram. Bypasses the ReAct agent
 * loop (no tools) — this is a one-turn "look and respond" path.
 *
 * Routes to Claude (premium) because Ollama Cloud models in this project
 * don't support image input reliably.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config/index.js';
import { createClaudeClient } from '../providers/claude.js';
import { child } from '../logger/index.js';

const log = child({ component: 'vision' });

const VISION_MAX_TOKENS = 1024;
const VISION_TIMEOUT_MS = 45_000;

export type VisionMode = 'serious' | 'funny' | 'auto';

export interface VisionParams {
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Optional caption from the user (e.g., a Telegram photo caption). */
  caption?: string;
  /** Tone hint. 'auto' lets Claude pick based on caption wording. */
  mode?: VisionMode;
}

export interface Vision {
  describe(params: VisionParams): Promise<string>;
}

const BASE_SYSTEM_PROMPT =
  'You are Jarvis, describing an image a user sent in Telegram. ' +
  'Keep replies short (2–5 sentences) and conversational. ' +
  'If the image contains code or an error message, extract the key detail clearly. ' +
  'If there is no user caption, lead with what the image is of.';

const SERIOUS_EXTRA =
  ' Be accurate and useful. No jokes.';

const FUNNY_EXTRA =
  ' Be playful and a little roasty — puns, dry humor, light sarcasm welcome. ' +
  'Never mean-spirited; never comment on a person\'s appearance in a hurtful way.';

const AUTO_EXTRA =
  ' Pick your tone from the caption: if the user seems serious ("describe", "explain", "what is"), be accurate. ' +
  'If they seem playful ("roast", "funny", "joke", "comment"), be playful. Default to accurate if unsure.';

export function initVision(cfg: AppConfig): Vision {
  // Vision is a judgment-heavy single-shot call; use ai.judgeModel (Opus
  // by default) for sharper describe/roast quality.
  const model = cfg.ai.judgeModel;
  let client: Anthropic | null = null;

  return {
    async describe(params: VisionParams): Promise<string> {
      if (!client) client = createClaudeClient(cfg);

      const mode = params.mode ?? 'auto';
      const systemPrompt =
        BASE_SYSTEM_PROMPT +
        (mode === 'serious' ? SERIOUS_EXTRA : mode === 'funny' ? FUNNY_EXTRA : AUTO_EXTRA);

      const userContent: Anthropic.MessageParam['content'] = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: params.mediaType,
            data: params.imageBase64,
          },
        },
        {
          type: 'text',
          text: params.caption?.trim() || 'What is this? Keep it brief.',
        },
      ];

      const startMs = Date.now();
      const response = await client.messages.create(
        {
          model,
          max_tokens: VISION_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        },
        { timeout: VISION_TIMEOUT_MS },
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      log.info(
        {
          durationMs: Date.now() - startMs,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          mode,
          replyLen: text.length,
        },
        'Vision describe complete',
      );

      return text || '(no response)';
    },
  };
}

/**
 * Detect tone hint from a caption. Used when /mode is not explicitly set.
 * Returns 'funny' if the caption contains playful keywords, 'serious' for
 * analytical ones, 'auto' otherwise.
 */
/**
 * Per-chat vision-reply toggle. In-memory — resets on process restart.
 * Default is ON: every photo in an authorized chat gets described. Use
 * /vision off to silence per-chat.
 */
const visionDisabledChats = new Set<number>();

export function isVisionEnabled(chatId: number): boolean {
  return !visionDisabledChats.has(chatId);
}

export function setVisionEnabled(chatId: number, enabled: boolean): void {
  if (enabled) visionDisabledChats.delete(chatId);
  else visionDisabledChats.add(chatId);
}

export function detectMode(caption: string | undefined): VisionMode {
  if (!caption) return 'auto';
  const c = caption.toLowerCase();
  if (/\b(roast|joke|funny|comedy|comment|meme|lol)\b/.test(c)) return 'funny';
  if (/\b(describe|explain|analy[sz]e|what is|identify|read|ocr|extract)\b/.test(c))
    return 'serious';
  return 'auto';
}
