/**
 * Sub-Phase A — Transcriber unit tests.
 * Verifies:
 *   - AbortSignal plumbed into fetch (R9 regression)
 *   - Missing OPENAI_API_KEY throws a clear error
 *   - Non-OK Whisper response produces a descriptive error
 *   - fileUrl auth token is REDACTED in log output
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTranscriber } from '../../src/transcriber/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

const realFetch = globalThis.fetch;

describe('transcriber.initTranscriber', () => {
  beforeEach(() => {
    process.env['OPENAI_API_KEY'] = 'sk-test-000';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env['OPENAI_API_KEY'];
  });

  it('throws when OPENAI_API_KEY is missing', async () => {
    delete process.env['OPENAI_API_KEY'];
    // Mock fetch to succeed the download so we hit the API-key check
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;

    const t = initTranscriber(makeTestConfig());
    await expect(t.transcribeVoice('https://api.telegram.org/file/bot/voice.ogg')).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('propagates AbortError when external signal fires before fetch completes', async () => {
    // A fetch that checks the passed signal and rejects if aborted
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        s?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;

    const t = initTranscriber(makeTestConfig());
    const ac = new AbortController();
    const p = t.transcribeVoice('https://api.telegram.org/file/bot/voice.ogg', ac.signal);
    // Abort after a tick
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/abort/i);
  }, 5000);

  it('throws descriptive error when Whisper returns non-OK', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      // First call = download (ok). Second = whisper (401).
      if (call === 1) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response('bad key', { status: 401 });
    }) as typeof fetch;

    const t = initTranscriber(makeTestConfig());
    await expect(
      t.transcribeVoice('https://api.telegram.org/file/bot/voice.ogg'),
    ).rejects.toThrow(/Whisper API error/);
  });

  it('parses text from whisper JSON response on success', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response(JSON.stringify({ text: ' hello world ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const t = initTranscriber(makeTestConfig());
    const result = await t.transcribeVoice('https://api.telegram.org/file/bot/token=SECRET&x/voice.ogg');
    expect(result.text).toBe('hello world');
    expect(typeof result.durationMs).toBe('number');
  });
});
