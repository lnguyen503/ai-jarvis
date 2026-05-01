/**
 * F-05: Unit tests for gateway/voice.ts
 * Mocks grammY Context api.getFile() and the Transcriber.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'grammy';
import { transcribeTelegramVoice } from '../../src/gateway/voice.js';
import type { Transcriber } from '../../src/transcriber/index.js';

function makeVoiceCtx(overrides: {
  fileId?: string;
  filePath?: string | undefined;
  failGetFile?: boolean;
  isAudio?: boolean;
} = {}): Context {
  const fileId = overrides.fileId ?? 'file-abc-123';
  const voice = !overrides.isAudio ? { file_id: fileId, duration: 5 } : undefined;
  const audio = overrides.isAudio ? { file_id: fileId, duration: 5 } : undefined;

  return {
    message: { voice, audio },
    api: {
      token: 'bot-token-test',
      getFile: overrides.failGetFile
        ? vi.fn().mockRejectedValue(new Error('Telegram API error'))
        : vi.fn().mockResolvedValue({
            file_id: fileId,
            file_path: overrides.filePath ?? 'voice/file.ogg',
          }),
    },
  } as unknown as Context;
}

function makeTranscriber(transcript = 'hello world'): Transcriber {
  return {
    transcribeVoice: vi.fn().mockResolvedValue({ text: transcript, durationMs: 500 }),
  };
}

describe('gateway/voice.ts', () => {
  it('returns null when ctx has no voice or audio', async () => {
    const ctx = { message: {} } as unknown as Context;
    const result = await transcribeTelegramVoice(ctx, makeTranscriber());
    expect(result).toBeNull();
  });

  it('returns null when ctx.message is undefined', async () => {
    const ctx = {} as unknown as Context;
    const result = await transcribeTelegramVoice(ctx, makeTranscriber());
    expect(result).toBeNull();
  });

  it('returns null when getFile returns no file_path', async () => {
    const ctx = makeVoiceCtx({ filePath: undefined });
    // Override to return no file_path
    (ctx.api.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({ file_id: 'f1', file_path: undefined });
    const result = await transcribeTelegramVoice(ctx, makeTranscriber());
    expect(result).toBeNull();
  });

  it('returns null and logs error when getFile throws', async () => {
    const ctx = makeVoiceCtx({ failGetFile: true });
    const result = await transcribeTelegramVoice(ctx, makeTranscriber());
    expect(result).toBeNull();
  });

  it('returns transcript text on success (voice message)', async () => {
    const ctx = makeVoiceCtx();
    const transcriber = makeTranscriber('play some music');
    const result = await transcribeTelegramVoice(ctx, transcriber);
    expect(result).toBe('play some music');
    expect(transcriber.transcribeVoice).toHaveBeenCalledOnce();
    // URL must include the bot token and file path
    const url = (transcriber.transcribeVoice as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toMatch(/bot-token-test/);
    expect(url).toMatch(/voice\/file\.ogg/);
  });

  it('falls back to audio when voice is absent', async () => {
    const ctx = makeVoiceCtx({ isAudio: true });
    const transcriber = makeTranscriber('audio transcript');
    const result = await transcribeTelegramVoice(ctx, transcriber);
    expect(result).toBe('audio transcript');
  });
});
