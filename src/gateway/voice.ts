import type { Context } from 'grammy';
import type { Transcriber } from '../transcriber/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'gateway.voice' });

/**
 * Download voice file from Telegram and transcribe via Whisper.
 * Returns the transcript text, or null on failure.
 * Caller is responsible for echoing the transcript to the user.
 */
/**
 * Upper bound on audio size we're willing to transcribe. Whisper charges
 * per second and large files can block the queue + burn budget. 20 MB is
 * ~20 minutes of voice-bitrate audio — plenty for any legitimate use.
 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export async function transcribeTelegramVoice(
  ctx: Context,
  transcriber: Transcriber,
): Promise<string | null> {
  const voice = ctx.message?.voice ?? ctx.message?.audio;
  if (!voice) return null;

  // Reject oversized audio before we even ask Telegram for the download URL.
  // voice.file_size is populated by Telegram on the incoming message.
  const fileSize = voice.file_size;
  if (typeof fileSize === 'number' && fileSize > MAX_AUDIO_BYTES) {
    log.warn(
      { fileId: voice.file_id, fileSize, maxBytes: MAX_AUDIO_BYTES },
      'Audio file exceeds max size — refusing transcription',
    );
    await ctx
      .reply(
        `Audio is too large (${Math.round(fileSize / 1024 / 1024)} MB). Max ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`,
      )
      .catch(() => {});
    return null;
  }

  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      log.warn({ fileId: voice.file_id }, 'Telegram file has no file_path');
      return null;
    }

    const botToken = ctx.api.token;
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    const result = await transcriber.transcribeVoice(fileUrl);
    log.info({ durationMs: result.durationMs, textLen: result.text.length }, 'Voice transcribed');
    return result.text;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Voice transcription failed',
    );
    return null;
  }
}
