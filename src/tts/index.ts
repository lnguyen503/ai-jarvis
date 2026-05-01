/**
 * TTS — OpenAI text-to-speech.
 *
 * Synthesizes text into an OGG/Opus buffer (Telegram-compatible for sendVoice).
 * Uses the same OPENAI_API_KEY as Whisper (Transcriber).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { child } from '../logger/index.js';

const log = child({ component: 'tts' });

const TTS_URL = 'https://api.openai.com/v1/audio/speech';
const TTS_TIMEOUT_MS = 30_000;
/** Telegram voice notes cap at 1 minute; keep text short. */
export const TTS_MAX_CHARS = 3000;

export interface TtsOptions {
  /** Voice preset: alloy | echo | fable | onyx | nova | shimmer. Default: nova. */
  voice?: string;
  /** Model: tts-1 (fast/cheap) or tts-1-hd (slower/better). Default: tts-1. */
  model?: string;
}

export interface TtsResult {
  /** Absolute path to a temp .ogg file. Caller is responsible for deleting it. */
  filePath: string;
  durationMs: number;
}

export interface Tts {
  synthesize(text: string, opts?: TtsOptions): Promise<TtsResult>;
}

export function initTts(): Tts {
  return {
    async synthesize(text: string, opts: TtsOptions = {}): Promise<TtsResult> {
      const apiKey = process.env['OPENAI_API_KEY'];
      if (!apiKey) throw new Error('OPENAI_API_KEY environment variable not set');

      const startMs = Date.now();
      const voice = opts.voice ?? 'nova';
      const model = opts.model ?? 'tts-1';

      const trimmed = text.slice(0, TTS_MAX_CHARS);

      const response = await fetch(TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          voice,
          input: trimmed,
          response_format: 'opus',
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI TTS error: HTTP ${response.status} — ${body.slice(0, 300)}`);
      }

      const audioBuf = Buffer.from(await response.arrayBuffer());
      const filePath = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}-${process.pid}.ogg`);
      fs.writeFileSync(filePath, audioBuf);

      const durationMs = Date.now() - startMs;
      log.info({ durationMs, bytes: audioBuf.length, voice, model }, 'TTS synthesized');
      return { filePath, durationMs };
    },
  };
}

/**
 * Per-chat voice-reply toggle. In-memory — reset on process restart.
 * Keyed by chatId (negative for groups, positive for DMs).
 */
const voiceEnabledChats = new Set<number>();

export function isVoiceEnabled(chatId: number): boolean {
  return voiceEnabledChats.has(chatId);
}

export function setVoiceEnabled(chatId: number, enabled: boolean): void {
  if (enabled) voiceEnabledChats.add(chatId);
  else voiceEnabledChats.delete(chatId);
}
